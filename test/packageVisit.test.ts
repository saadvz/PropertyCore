import { afterEach, describe, expect, it } from "vitest";
import { peopleFor, resetPeople } from "../src/hub/people";
import { CODE_WAITING, packageDeskFor, resetPackageDesks } from "../src/package-arrivals/desk";
import { readPackages, supplyKey } from "../src/package-arrivals/store";
import { cleanupFolders, order, propertyFolder, PROPERTY_ID, writeOrders } from "./packageFixture";

/** #241: the host picks a saved, opted-in person to bring a delivered package in. 555 numbers only. */

afterEach(() => {
  resetPackageDesks();
  resetPeople();
  cleanupFolders();
});

const HOST = "+15555550100";
const ANA = "+15555550111";
const RAY = "+15555550122";
const OLLIE = "+15555550133";
const NEW = "+15555550144";
const at = (local: string, day = "17") => new Date(`2026-11-${day}T${local}:00.000-05:00`);
const s = (reply: { structured?: Record<string, unknown> }) => reply.structured as Record<string, any>;

function setup(opts: { hours?: number; underAccount?: boolean; orders?: Parameters<typeof writeOrders>[1] } = {}) {
  const { root, accountRoot } = propertyFolder({ underAccount: opts.underAccount ?? true });
  writeOrders(root, opts.orders ?? [order("ord_a", { expectedBy: "2026-11-17" })]);
  let clock = at("10:00");
  const now = () => clock;
  const people = peopleFor(accountRoot, { now });
  people.savePropertyPeople(PROPERTY_ID, HOST, [
    { phone: ANA, role: "cleaner", name: "Ana" },
    { phone: RAY, role: "co-host", name: "Ray" },
    { phone: OLLIE, role: "observer", name: "Ollie" },
    { phone: NEW, role: "assistant", name: "Nia" },
  ]);
  for (const phone of [ANA, RAY, OLLIE]) people.optIn(phone, PROPERTY_ID);
  const desk = packageDeskFor(root, { now });
  if (opts.hours !== undefined) desk.saveSettings({ bringInHours: opts.hours });
  return { root, desk, people, setNow: (next: Date) => (clock = next) };
}

describe("plan_bring_in", () => {
  it("plans the visit with the opted-in cleaner and says the code is waiting", () => {
    const { root, desk } = setup({ hours: 4 });
    const before = s(desk.planBringIn({ orderId: "ord_a", person: ANA }));
    expect(before).toMatchObject({ orderId: "ord_a", name: "Ana", code: "waiting" });
    expect(before.by).toBeUndefined();
    expect(before.next).toBe(CODE_WAITING);
    expect(readPackages(root).arrivals[supplyKey("ord_a")]!.visit).toEqual({ person: ANA, name: "Ana", role: "cleaner", plannedAt: at("10:00").toISOString(), hours: 4 });
    desk.markSeen({ orderId: "ord_a", how: "host", at: at("09:30").toISOString() });
    const out = s(desk.check());
    expect(out.toBringIn).toEqual([]);
    expect(out.visits).toEqual([{ orderId: "ord_a", name: "Ana", by: at("13:30").toISOString() }]);
  });

  it("refuses someone not on the property, not opted in, stopped, or only an observer", () => {
    const { desk, people } = setup({ hours: 4 });
    expect(desk.planBringIn({ orderId: "ord_a", person: "+15555550199" }).text).toMatch(/isn't saved for this property/);
    expect(desk.planBringIn({ orderId: "ord_a", person: NEW }).text).toMatch(/hasn't said YES/);
    expect(desk.planBringIn({ orderId: "ord_a", person: OLLIE }).text).toMatch(/cleaner, a co-host or an assistant/);
    people.stop(RAY);
    expect(desk.planBringIn({ orderId: "ord_a", person: RAY }).text).toMatch(/STOP/);
    expect(desk.planBringIn({ orderId: "ord_a", person: HOST }).isError).toBe(true);
  });

  it("asks who when no one is named and no default is saved, and uses the default when one is", () => {
    const { desk } = setup({ hours: 4 });
    expect(desk.planBringIn({ orderId: "ord_a" }).text).toMatch(/who should bring it in/i);
    expect(desk.saveSettings({ person: RAY }).isError).toBe(false);
    expect(s(desk.planBringIn({ orderId: "ord_a" }))).toMatchObject({ name: "Ray" });
  });

  it("won't save a default person who can't be picked, and null clears it", () => {
    const { root, desk } = setup({ hours: 4 });
    expect(desk.saveSettings({ person: NEW }).isError).toBe(true);
    desk.saveSettings({ person: ANA });
    desk.saveSettings({ person: null });
    expect(readPackages(root).settings.person).toBeUndefined();
  });

  it("plans the default person's visit as soon as the drop is seen", () => {
    const { desk } = setup({ hours: 2 });
    desk.saveSettings({ person: ANA });
    const seen = s(desk.markSeen({ orderId: "ord_a", how: "host" }));
    expect(seen.visit).toMatchObject({ name: "Ana", by: at("12:00").toISOString(), code: "waiting" });
    expect(s(desk.check()).visits.map((v: any) => v.orderId)).toEqual(["ord_a"]);
  });

  it("doesn't plan a default person who said STOP since, and lists the package to bring in", () => {
    const { desk, people } = setup({ hours: 2 });
    desk.saveSettings({ person: ANA });
    people.stop(ANA);
    expect(s(desk.markSeen({ orderId: "ord_a", how: "host" })).visit).toBeUndefined();
    const out = s(desk.check());
    expect(out.visits).toEqual([]);
    expect(out.toBringIn.map((d: any) => d.orderId)).toEqual(["ord_a"]);
  });

  it("asks for the host's hours before planning", () => {
    const { desk } = setup();
    expect(desk.planBringIn({ orderId: "ord_a", person: ANA }).text).toMatch(/how many hours/i);
  });

  it("refuses when the property has no shared people list", () => {
    const { desk } = setup({ hours: 4, underAccount: false });
    expect(desk.planBringIn({ orderId: "ord_a", person: ANA }).text).toMatch(/no shared people list/i);
  });

  it("flags a visit past its deadline once", () => {
    const { desk, setNow } = setup({ hours: 2 });
    desk.markSeen({ orderId: "ord_a", how: "host", at: at("09:00").toISOString() });
    desk.planBringIn({ orderId: "ord_a", person: ANA });
    setNow(at("10:59"));
    expect(s(desk.check()).bringInLate).toEqual([]);
    setNow(at("11:00"));
    expect(s(desk.check()).bringInLate.map((v: any) => v.orderId)).toEqual(["ord_a"]);
    const again = s(desk.check());
    expect(again.bringInLate).toEqual([]);
    expect(again.visits.map((v: any) => v.orderId)).toEqual(["ord_a"]);
  });
});

describe("a visit planned ahead", () => {
  it("still flags the package when nothing saw it by end of day", () => {
    const { desk, setNow } = setup({ hours: 2 });
    desk.planBringIn({ orderId: "ord_a", person: ANA });
    setNow(at("21:00"));
    const out = s(desk.check());
    expect(out.notSeen.map((d: any) => d.orderId)).toEqual(["ord_a"]);
    expect(out.visits).toEqual([{ orderId: "ord_a", name: "Ana" }]);
  });
});

describe("an open visit on an older order", () => {
  it("stays listed and can be closed after the order's window", () => {
    const { desk, setNow } = setup({ hours: 2 });
    desk.markSeen({ orderId: "ord_a", how: "host", at: at("09:00").toISOString() });
    desk.planBringIn({ orderId: "ord_a", person: ANA });
    setNow(new Date("2026-12-30T15:00:00.000Z"));
    expect(s(desk.check()).visits.map((v: any) => v.orderId)).toEqual(["ord_a"]);
    expect(desk.markBroughtIn({ orderId: "ord_a" }).isError).toBe(false);
  });
});

describe("mark_brought_in", () => {
  it("refuses before the package is seen, and without a visit", () => {
    const { desk } = setup({ hours: 4 });
    expect(desk.markBroughtIn({ orderId: "ord_a" }).text).toMatch(/hasn't been seen/);
    desk.markSeen({ orderId: "ord_a", how: "host", at: at("09:00").toISOString() });
    expect(desk.markBroughtIn({ orderId: "ord_a" }).text).toMatch(/plan_bring_in/);
  });

  it("refuses a start after the end, a start before the drop, and a time in the future", () => {
    const { desk } = setup({ hours: 4 });
    desk.markSeen({ orderId: "ord_a", how: "host", at: at("09:00").toISOString() });
    desk.planBringIn({ orderId: "ord_a", person: ANA });
    expect(desk.markBroughtIn({ orderId: "ord_a", at: at("09:40").toISOString(), startedAt: at("09:45").toISOString() }).isError).toBe(true);
    expect(desk.markBroughtIn({ orderId: "ord_a", at: at("09:40").toISOString(), startedAt: at("08:45").toISOString() }).isError).toBe(true);
    expect(desk.markBroughtIn({ orderId: "ord_a", at: at("11:00").toISOString() }).isError).toBe(true);
  });

  it("closes the visit and keeps the times", () => {
    const { root, desk } = setup({ hours: 4 });
    desk.markSeen({ orderId: "ord_a", how: "host", at: at("09:00").toISOString() });
    desk.planBringIn({ orderId: "ord_a", person: ANA });
    const reply = s(desk.markBroughtIn({ orderId: "ord_a", at: at("09:50").toISOString(), startedAt: at("09:40").toISOString(), note: "Two boxes, put in the hall closet." }));
    expect(reply).toMatchObject({ orderId: "ord_a", name: "Ana", minutes: 10, onTime: true });
    expect(readPackages(root).arrivals[supplyKey("ord_a")]!.broughtIn).toEqual({ at: at("09:50").toISOString(), startedAt: at("09:40").toISOString(), note: "Two boxes, put in the hall closet." });
    const out = s(desk.check());
    expect([...out.visits, ...out.toBringIn]).toEqual([]);
  });
});
