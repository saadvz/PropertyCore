import { afterEach, describe, expect, it } from "vitest";
import { packageDeskFor, resetPackageDesks } from "../src/package-arrivals/desk";
import { readPackages, supplyKey } from "../src/package-arrivals/store";
import { cleanupFolders, order, propertyFolder, writeOrders } from "./packageFixture";

/** #241: expected deliveries come from Supply Core's orders; one not seen by end of day is flagged once. */

afterEach(() => {
  resetPackageDesks();
  cleanupFolders();
});

/** 2026-11-17 in New York is UTC-5. */
const at = (local: string) => new Date(`2026-11-17T${local}:00.000-05:00`);

function setup(orders: Parameters<typeof writeOrders>[1], now = at("10:00")) {
  const { root } = propertyFolder();
  writeOrders(root, orders);
  let clock = now;
  const desk = packageDeskFor(root, { now: () => clock });
  return { root, desk, setNow: (next: Date) => (clock = next) };
}

const s = (reply: { structured?: Record<string, unknown> }) => reply.structured as Record<string, any>;

describe("check_packages", () => {
  it("lists a placed order expected tomorrow as expected, not flagged", () => {
    const { desk } = setup([order("ord_tomorrow", { expectedBy: "2026-11-18" })]);
    const out = s(desk.check());
    expect(out.expected.map((d: any) => d.orderId)).toEqual(["ord_tomorrow"]);
    expect(out.expected[0]).toMatchObject({ store: "Example Mart", items: ["Paper towels x2"], expectedBy: "2026-11-18" });
    expect(out.notSeen).toEqual([]);
  });

  it("flags a package expected today only from 9 PM local, and only once", () => {
    const { desk, setNow } = setup([order("ord_today", { expectedBy: "2026-11-17" })], at("20:59"));
    expect(s(desk.check()).notSeen).toEqual([]);
    setNow(at("21:00"));
    expect(s(desk.check()).notSeen.map((d: any) => d.orderId)).toEqual(["ord_today"]);
    const again = s(desk.check());
    expect(again.notSeen).toEqual([]);
    expect(again.waiting.map((d: any) => d.orderId)).toEqual(["ord_today"]);
  });

  it("counts Supply Core's delivered mark as seen by tracking", () => {
    const { desk } = setup([order("ord_done", { expectedBy: "2026-11-16", status: "delivered", deliveredAt: "2026-11-16T18:00:00.000Z" })]);
    const out = s(desk.check());
    expect(out.notSeen).toEqual([]);
    expect(out.toBringIn[0]).toMatchObject({ orderId: "ord_done", seen: { at: "2026-11-16T18:00:00.000Z", how: "tracking" } });
  });

  it("never flags an order with no expected date", () => {
    const { desk, setNow } = setup([order("ord_nodate")]);
    setNow(new Date("2026-12-10T12:00:00.000Z"));
    const out = s(desk.check());
    expect(out.notSeen).toEqual([]);
    expect(out.expected.map((d: any) => d.orderId)).toEqual(["ord_nodate"]);
  });

  it("stops listing an order more than 30 days past its expected date", () => {
    const { desk, setNow } = setup([order("ord_old", { expectedBy: "2026-11-16" })]);
    setNow(new Date("2026-12-17T15:00:00.000Z"));
    const out = s(desk.check());
    expect([...out.expected, ...out.notSeen, ...out.waiting, ...out.toBringIn]).toEqual([]);
  });

  it("leaves out unconfirmed orders", () => {
    const { desk } = setup([order("ord_maybe", { status: "unconfirmed", expectedBy: "2026-11-10" })]);
    const out = s(desk.check());
    expect([...out.expected, ...out.notSeen, ...out.waiting]).toEqual([]);
  });

  it("asks for the host's bring-in hours until they're saved", () => {
    const { desk } = setup([]);
    expect(s(desk.check()).ask).toMatch(/how many hours/i);
    expect(desk.saveSettings({ bringInHours: 0 }).isError).toBe(true);
    expect(desk.saveSettings({ bringInHours: 73 }).isError).toBe(true);
    expect(desk.saveSettings({ bringInHours: 2.5 }).isError).toBe(true);
    expect(desk.saveSettings({ bringInHours: 4 }).isError).toBe(false);
    expect(s(desk.check()).ask).toBeUndefined();
  });

  it("refuses when the property's time zone isn't saved", () => {
    const { root } = propertyFolder({ timeZone: null });
    writeOrders(root, []);
    expect(packageDeskFor(root, { now: () => at("10:00") }).check().isError).toBe(true);
  });
});

describe("the 30-day window", () => {
  it("counts from the expected date, so a backorder expected weeks later is still listed", () => {
    const { desk, setNow } = setup([order("ord_back", { at: "2026-10-10T14:00:00.000Z", expectedBy: "2026-11-25" })]);
    setNow(new Date("2026-11-24T15:00:00.000Z"));
    expect(s(desk.check()).expected.map((d: any) => d.orderId)).toEqual(["ord_back"]);
  });

  it("still takes writes for an older order", () => {
    const { desk } = setup([order("ord_old", { at: "2026-09-01T14:00:00.000Z", expectedBy: "2026-09-04" })]);
    expect(desk.markSeen({ orderId: "ord_old", how: "host" }).isError).toBe(false);
  });
});

describe("mark_package_seen", () => {
  it("keeps the host's earlier time when tracking marks it later", () => {
    const { root, desk } = setup([order("ord_a", { expectedBy: "2026-11-17" })]);
    expect(desk.markSeen({ orderId: "ord_a", how: "host", at: at("09:00").toISOString() }).isError).toBe(false);
    writeOrders(root, [order("ord_a", { expectedBy: "2026-11-17", status: "delivered", deliveredAt: at("09:45").toISOString() })]);
    expect(s(desk.check()).toBringIn[0].seen).toEqual({ at: at("09:00").toISOString(), how: "host" });
  });

  it("lets a camera sighting replace a carrier or host one", () => {
    const { root, desk } = setup([order("ord_a", { expectedBy: "2026-11-17" })]);
    desk.markSeen({ orderId: "ord_a", how: "host", at: at("09:00").toISOString() });
    desk.markSeen({ orderId: "ord_a", how: "camera", at: at("09:30").toISOString() });
    expect(readPackages(root).arrivals[supplyKey("ord_a")]!.seen).toEqual({ at: at("09:30").toISOString(), how: "camera" });
  });

  it("uses now when no time is given", () => {
    const { root, desk } = setup([order("ord_a")]);
    desk.markSeen({ orderId: "ord_a", how: "host" });
    expect(readPackages(root).arrivals[supplyKey("ord_a")]!.seen).toEqual({ at: at("10:00").toISOString(), how: "host" });
  });

  it("refuses an unknown order, a time in the future, and an unknown signal", () => {
    const { desk } = setup([order("ord_a")]);
    expect(desk.markSeen({ orderId: "ord_nope", how: "host" }).isError).toBe(true);
    expect(desk.markSeen({ orderId: "ord_a", how: "host", at: at("11:00").toISOString() }).isError).toBe(true);
    expect(desk.markSeen({ orderId: "ord_a", how: "guess" }).isError).toBe(true);
    expect(desk.markSeen({ orderId: "ord_a", how: "host", at: "yesterday" }).isError).toBe(true);
  });
});
