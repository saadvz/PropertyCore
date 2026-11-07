import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accountOf, forgetPeople, PEOPLE_FILE, peopleFor, resetPeople, streetOf, type PersonChange } from "../src/hub/people";

/** The account people list (saadvz/TourCore#190). Only 555 numbers. */

const HOST = "+15555550100";
const C = "+15555550101";
const D = "+15555550102";
const A = "prp_aaaaaaaaaa";
const B = "prp_bbbbbbbbbb";
const now = () => new Date("2026-11-07T12:00:00.000Z");

const account = () => mkdtempSync(join(tmpdir(), "people-"));
afterEach(() => resetPeople());

describe("accountOf and streetOf", () => {
  it("finds the account folder and property id from a property folder", () => {
    expect(accountOf("/d/tenants/tnt_x/properties/prp_abcdefghij")).toEqual({ accountRoot: "/d/tenants/tnt_x", propertyId: "prp_abcdefghij" });
  });

  it("is undefined for any other folder", () => {
    expect(accountOf("/tmp/cleaner-replies-1")).toBeUndefined();
    expect(accountOf("/d/tenants/tnt_x/properties/not-a-property")).toBeUndefined();
    expect(accountOf("/d/tenants/tnt_x/other/prp_abcdefghij")).toBeUndefined();
  });

  it("streetOf keeps the text before the first comma", () => {
    expect(streetOf("12 Scratch Lane, Teaneck, NJ 07666")).toBe("12 Scratch Lane");
    expect(streetOf("9 Annex")).toBe("9 Annex");
  });
});

describe("People", () => {
  it("assigns a person to several properties with a role on each, and keeps the landlord out", () => {
    const people = peopleFor(account(), { now });
    people.savePropertyPeople(A, HOST, [{ phone: C, role: "cleaner", name: "Ana" }]);
    people.savePropertyPeople(B, HOST, [{ phone: C, role: "observer" }]);
    expect(people.propertiesOf(C)).toEqual([A, B]);
    expect(people.roleOn(C, B)).toBe("observer");
    expect(people.roleOn(C, A)).toBe("cleaner");
    expect(people.person(C)?.name).toBe("Ana");
    expect(people.hostOf(A)).toBe(HOST);
    expect(people.person(HOST)).toBeUndefined();
  });

  it("saving a property without someone drops that property but keeps the entry and its STOP", () => {
    const people = peopleFor(account(), { now });
    people.savePropertyPeople(A, HOST, [{ phone: C, role: "cleaner" }]);
    people.stop(C);
    people.savePropertyPeople(A, HOST, [{ phone: D, role: "cleaner" }]);
    expect(people.propertiesOf(C)).toEqual([]);
    expect(people.person(C)).toBeDefined();
    expect(people.stopped(C)).toBe(true);
  });

  it("opts in once for every property", () => {
    const people = peopleFor(account(), { now });
    people.savePropertyPeople(A, HOST, [{ phone: C, role: "cleaner" }]);
    people.savePropertyPeople(B, HOST, [{ phone: C, role: "cleaner" }]);
    expect(people.optIn(C, A)).toEqual({ phone: C, kind: "opted-in", from: A, properties: [A, B] });
    expect(people.optedIn(C)).toBe(true);
    expect(people.optIn(C, B)).toBeUndefined();
  });

  it("stop and start flip once each", () => {
    const people = peopleFor(account(), { now });
    people.savePropertyPeople(A, HOST, [{ phone: C, role: "cleaner" }]);
    expect(people.stop(C)).toEqual({ phone: C, kind: "stopped", properties: [A] });
    expect(people.stopped(C)).toBe(true);
    expect(people.stop(C)).toBeUndefined();
    expect(people.start(C)).toEqual({ phone: C, kind: "started", properties: [A] });
    expect(people.stopped(C)).toBe(false);
    expect(people.start(C)).toBeUndefined();
  });

  it("a STOP from a phone on no property is kept", () => {
    const people = peopleFor(account(), { now });
    expect(people.stop(D)).toEqual({ phone: D, kind: "stopped", properties: [] });
    expect(people.stopped(D)).toBe(true);
  });

  it("an invite out from one property holds the others, until the YES or until that property drops them", () => {
    const people = peopleFor(account(), { now });
    people.savePropertyPeople(A, HOST, [{ phone: C, role: "cleaner" }]);
    people.savePropertyPeople(B, HOST, [{ phone: C, role: "cleaner" }]);
    people.markInvited(C, A);
    expect(people.invitedElsewhere(C, B)).toBe(true);
    expect(people.invitedElsewhere(C, A)).toBe(false);
    people.savePropertyPeople(A, HOST, []);
    expect(people.invitedElsewhere(C, B)).toBe(false);
    people.savePropertyPeople(A, HOST, [{ phone: C, role: "cleaner" }]);
    people.markInvited(C, A);
    people.optIn(C, A);
    expect(people.invitedElsewhere(C, B)).toBe(false);
  });

  it("relays each change to the registered listener, and nothing for undefined", async () => {
    const people = peopleFor(account(), { now });
    people.savePropertyPeople(A, HOST, [{ phone: C, role: "cleaner" }]);
    const seen: PersonChange[] = [];
    people.onChange(async (change) => void seen.push(change));
    await people.relay(people.stop(C));
    await people.relay(people.stop(C));
    expect(seen).toEqual([{ phone: C, kind: "stopped", properties: [A] }]);
  });

  it("moves the old records in once", () => {
    const root = account();
    const people = peopleFor(root, { now });
    expect(people.moved()).toBe(false);
    const sources = [
      { propertyId: A, host: HOST, people: [{ phone: C, role: "cleaner" as const, name: "Ana" }], stopped: [D], optedIn: [C], optedOut: [] },
      { propertyId: B, host: HOST, people: [{ phone: D, role: "co-host" as const }], stopped: [], optedIn: [], optedOut: [D] },
    ];
    people.move(sources);
    expect(people.moved()).toBe(true);
    expect(people.optedIn(C)).toBe(true);
    expect(people.person(C)?.optedIn?.propertyId).toBe(A);
    expect(people.stopped(D)).toBe(true);
    expect(people.propertiesOf(D)).toEqual([B]);
    expect(people.hostOf(B)).toBe(HOST);
    const file = JSON.parse(readFileSync(join(root, PEOPLE_FILE), "utf8")) as { movedAt?: string };
    expect(file.movedAt).toBe(now().toISOString());
    people.move([{ propertyId: A, host: HOST, people: [], stopped: [C], optedIn: [], optedOut: [] }]);
    expect(people.stopped(C)).toBe(false);
  });

  it("reads the same state back from people.json", () => {
    const root = account();
    const people = peopleFor(root, { now });
    people.savePropertyPeople(A, HOST, [{ phone: C, role: "cleaner" }]);
    people.optIn(C, A);
    expect(existsSync(join(root, PEOPLE_FILE))).toBe(true);
    forgetPeople(root);
    const again = peopleFor(root, { now });
    expect(again).not.toBe(people);
    expect(again.optedIn(C)).toBe(true);
    expect(again.propertiesOf(C)).toEqual([A]);
    expect(again.hostOf(A)).toBe(HOST);
  });
});
