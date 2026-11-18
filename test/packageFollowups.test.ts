import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { factsFrom, readRecords } from "../src/hours-log/sources";
import { peopleFor, resetPeople } from "../src/hub/people";
import { packageDeskFor, resetPackageDesks } from "../src/package-arrivals/desk";
import { readPackages, supplyKey, writePackages } from "../src/package-arrivals/store";
import { cleanupFolders, order, propertyFolder, PROPERTY_ID, writeOrders } from "./packageFixture";

/** #241 review follow-ups: the minor notes deferred from the first pass. 555 numbers only. */

afterEach(() => {
  resetPackageDesks();
  resetPeople();
  cleanupFolders();
});

const HOST = "+15555550100";
const ANA = "+15555550111";
const RAY = "+15555550122";
const at = (local: string) => new Date(`2026-11-17T${local}:00.000-05:00`);
const s = (reply: { structured?: Record<string, unknown> }) => reply.structured as Record<string, any>;

function setup(opts: { hours?: number; timeZone?: string | null } = {}) {
  const { root, accountRoot } = propertyFolder({ timeZone: opts.timeZone });
  writeOrders(root, [order("ord_a", { expectedBy: "2026-11-16" })]);
  let clock = at("10:00");
  const now = () => clock;
  const people = peopleFor(accountRoot, { now });
  people.savePropertyPeople(PROPERTY_ID, HOST, [
    { phone: ANA, role: "cleaner", name: "Ana" },
    { phone: RAY, role: "co-host", name: "Ray" },
  ]);
  for (const phone of [ANA, RAY]) people.optIn(phone, PROPERTY_ID);
  const desk = packageDeskFor(root, { now });
  if (opts.hours !== undefined) desk.saveSettings({ bringInHours: opts.hours });
  return { root, desk, people, setNow: (next: Date) => (clock = next) };
}

describe("a default person who can't bring it in", () => {
  it("says so when the drop is seen, naming them", () => {
    const { desk, people } = setup({ hours: 2 });
    desk.saveSettings({ person: ANA });
    people.stop(ANA);
    const seen = s(desk.markSeen({ orderId: "ord_a", how: "host" }));
    expect(seen.visit).toBeUndefined();
    expect(seen.defaultSkipped).toMatchObject({ name: "Ana" });
    expect(seen.defaultSkipped.problem).toMatch(/STOP/);
    expect(seen.next).toMatch(/Ana/);
  });

  it("is named in check_packages, with why", () => {
    const { desk, people } = setup({ hours: 2 });
    desk.saveSettings({ person: ANA });
    expect(s(desk.check()).defaultPerson).toEqual({ name: "Ana" });
    people.stop(ANA);
    const out = s(desk.check());
    expect(out.defaultPerson.name).toBe("Ana");
    expect(out.defaultPerson.problem).toMatch(/STOP/);
  });

  it("flags a visit whose person said STOP after it was planned", () => {
    const { desk, people } = setup({ hours: 2 });
    desk.markSeen({ orderId: "ord_a", how: "host", at: at("09:00").toISOString() });
    desk.planBringIn({ orderId: "ord_a", person: RAY });
    people.stop(RAY);
    const out = s(desk.check());
    expect(out.visits[0]).toMatchObject({ orderId: "ord_a", name: "Ray" });
    expect(out.visits[0].problem).toMatch(/STOP/);
    expect(out.next).toMatch(/someone else/i);
  });
});

describe("a property with no shared people list", () => {
  it("says what's missing instead of asking to save people it can't save", () => {
    const { root } = propertyFolder({ underAccount: false });
    writeOrders(root, [order("ord_a")]);
    const desk = packageDeskFor(root, { now: () => at("10:00") });
    desk.saveSettings({ bringInHours: 2 });
    const text = desk.planBringIn({ orderId: "ord_a", person: ANA }).text;
    expect(text).toMatch(/no shared people list/i);
    expect(text).not.toMatch(/^Save the people/);
  });
});

describe("the helper's log key", () => {
  it("is salted per property, so it isn't a plain hash of the phone", () => {
    const { root, desk } = setup({ hours: 2 });
    desk.markSeen({ orderId: "ord_a", how: "host", at: at("09:00").toISOString() });
    desk.planBringIn({ orderId: "ord_a", person: RAY });
    desk.markBroughtIn({ orderId: "ord_a", at: at("09:30").toISOString(), startedAt: at("09:20").toISOString() });
    const salt = readPackages(root).salt;
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    const bring = factsFrom(readRecords(root)).find((fact) => fact.kind === "bring-in")!;
    expect(bring.log).toMatch(/^helper:[0-9a-f]{10}$/);
    expect(bring.log).not.toBe(`helper:${createHash("sha256").update(RAY).digest("hex").slice(0, 10)}`);
    const other = { ...readPackages(root), salt: "0".repeat(32) };
    writePackages(root, other);
    expect(factsFrom(readRecords(root)).find((fact) => fact.kind === "bring-in")!.log).not.toBe(bring.log);
  });

  it("keeps one log per person across deliveries", () => {
    const { root, desk } = setup({ hours: 2 });
    writeOrders(root, [order("ord_a", { expectedBy: "2026-11-16" }), order("ord_b", { expectedBy: "2026-11-16" })]);
    for (const id of ["ord_a", "ord_b"]) {
      desk.markSeen({ orderId: id, how: "host", at: at("09:00").toISOString() });
      desk.planBringIn({ orderId: id, person: RAY });
      desk.markBroughtIn({ orderId: id, at: at("09:30").toISOString(), startedAt: at("09:20").toISOString() });
    }
    const logs = factsFrom(readRecords(root)).filter((fact) => fact.kind === "bring-in").map((fact) => fact.log);
    expect(new Set(logs).size).toBe(1);
  });
});

describe("mark_brought_in twice", () => {
  it("refuses a second time unless the host is correcting it", () => {
    const { root, desk } = setup({ hours: 2 });
    desk.markSeen({ orderId: "ord_a", how: "host", at: at("09:00").toISOString() });
    desk.planBringIn({ orderId: "ord_a", person: ANA });
    expect(desk.markBroughtIn({ orderId: "ord_a", at: at("09:30").toISOString() }).isError).toBe(false);
    const again = desk.markBroughtIn({ orderId: "ord_a", at: at("09:45").toISOString() });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already marked inside/);
    expect(readPackages(root).arrivals[supplyKey("ord_a")]!.broughtIn!.at).toBe(at("09:30").toISOString());
    expect(desk.markBroughtIn({ orderId: "ord_a", at: at("09:45").toISOString(), replace: true }).isError).toBe(false);
    expect(readPackages(root).arrivals[supplyKey("ord_a")]!.broughtIn!.at).toBe(at("09:45").toISOString());
  });
});

describe("a sighting's time", () => {
  it("can't be before the order was placed", () => {
    const { desk } = setup();
    expect(desk.markSeen({ orderId: "ord_a", how: "camera", at: "2026-11-14T12:00:00.000Z" }).text).toMatch(/before the order was placed/);
  });

  it("can't be after the package was marked inside", () => {
    const { desk } = setup({ hours: 2 });
    desk.markSeen({ orderId: "ord_a", how: "host", at: at("09:00").toISOString() });
    desk.planBringIn({ orderId: "ord_a", person: ANA });
    desk.markBroughtIn({ orderId: "ord_a", at: at("09:30").toISOString() });
    expect(desk.markSeen({ orderId: "ord_a", how: "camera", at: at("09:40").toISOString() }).text).toMatch(/after the package was marked inside/);
  });
});

describe("a visit's deadline", () => {
  it("keeps the hours it was planned with when the host changes them", () => {
    const { desk } = setup({ hours: 2 });
    desk.markSeen({ orderId: "ord_a", how: "host", at: at("09:00").toISOString() });
    desk.planBringIn({ orderId: "ord_a", person: ANA });
    desk.saveSettings({ bringInHours: 6 });
    expect(s(desk.check()).visits[0].by).toBe(at("11:00").toISOString());
  });
});

describe("the note", () => {
  it("says an empty note is empty", () => {
    const { desk } = setup({ hours: 2 });
    desk.markSeen({ orderId: "ord_a", how: "host", at: at("09:00").toISOString() });
    desk.planBringIn({ orderId: "ord_a", person: ANA });
    const reply = desk.markBroughtIn({ orderId: "ord_a", note: "   " });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/empty/);
  });
});

describe("a broken supply.json", () => {
  it("is a plain refusal, not a crash", () => {
    const { root, desk } = setup();
    writeFileSync(join(root, "supply.json"), "{not json");
    const reply = desk.check();
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/Supply Core/);
    writeFileSync(join(root, "supply.json"), "null");
    expect(desk.markSeen({ orderId: "ord_a", how: "host" }).isError).toBe(true);
  });
});

describe("a property with no time zone", () => {
  it("still lists deliveries, and only the end-of-day flag waits", () => {
    const { desk } = setup({ timeZone: null, hours: 2 });
    const reply = desk.check();
    expect(reply.isError).toBe(false);
    const out = s(reply);
    expect(out.expected.map((d: any) => d.orderId)).toEqual(["ord_a"]);
    expect(out.notSeen).toEqual([]);
    expect(out.timeZone).toMatch(/time zone/);
  });
});
