import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHostedApps } from "./cleanerOauthHarness";
import { CLEANER, LANE, sharedAccount, type SharedAccount } from "./sharedHarness";
import { afterEach, describe, expect, it } from "vitest";
import { copyPhotos, MAX_JOB_PHOTOS, photoCount, storePhotos } from "../src/cleaner-core/photos";
import { fixerCoreOn } from "../src/cleaner-core/flag";
import { peopleFor, resetPeople } from "../src/hub/people";

/** Pros in the account people list (Fixer Core, Decision 10). Only 555 numbers. */

const HOST = "+15555550100";
const JOE = "+15555550111";
const ANA = "+15555550112";
const A = "prp_aaaaaaaaaa";
const B = "prp_bbbbbbbbbb";
const now = () => new Date("2026-11-08T12:00:00.000Z");
const roots: string[] = [];
let open: SharedAccount | undefined;
const account = () => {
  const root = mkdtempSync(join(tmpdir(), "pros-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  open?.m.close();
  open = undefined;
  closeHostedApps();
  resetPeople();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pros in people.json", () => {
  it("Cleaner Core's save keeps every pro", () => {
    const people = peopleFor(account(), { now });
    people.saveRolePeople(A, "pro", [{ phone: JOE, name: "Joe" }]);
    people.savePropertyPeople(A, HOST, [{ phone: ANA, role: "cleaner" }]);
    expect(people.roleOn(JOE, A)).toBe("pro");
    expect(people.person(JOE)?.name).toBe("Joe");
    expect(people.roleOn(ANA, A)).toBe("cleaner");
    people.savePropertyPeople(A, HOST, []);
    expect(people.roleOn(JOE, A)).toBe("pro");
    expect(people.roleOn(ANA, A)).toBeUndefined();
  });

  it("a person can be cleaner and pro on one property", () => {
    const people = peopleFor(account(), { now });
    people.savePropertyPeople(A, HOST, [{ phone: JOE, role: "cleaner" }]);
    people.saveRolePeople(A, "pro", [{ phone: JOE }]);
    expect(people.rolesOn(JOE, A)).toEqual(["cleaner", "pro"]);
    expect(people.roleOn(JOE, A)).toBe("cleaner");
    expect(people.propertiesOf(JOE)).toEqual([A]);
    people.savePropertyPeople(A, HOST, [{ phone: JOE, role: "co-host" }]);
    expect(people.rolesOn(JOE, A)).toEqual(["co-host", "pro"]);
    people.savePropertyPeople(A, HOST, []);
    expect(people.rolesOn(JOE, A)).toEqual(["pro"]);
  });

  it("saveRolePeople with an empty list removes only the pro entry", () => {
    const people = peopleFor(account(), { now });
    people.savePropertyPeople(A, HOST, [{ phone: JOE, role: "cleaner" }]);
    people.saveRolePeople(A, "pro", [{ phone: JOE }, { phone: ANA }]);
    people.saveRolePeople(A, "pro", []);
    expect(people.rolesOn(JOE, A)).toEqual(["cleaner"]);
    expect(people.rolesOn(ANA, A)).toEqual([]);
  });

  it("STOP on a pro covers every property they are a pro on", () => {
    const people = peopleFor(account(), { now });
    people.saveRolePeople(A, "pro", [{ phone: JOE }]);
    people.saveRolePeople(B, "pro", [{ phone: JOE }]);
    expect(people.stop(JOE)?.properties).toEqual([A, B]);
  });

  it("STOP, YES and START list a property once for a cleaner who is also a pro there", () => {
    const people = peopleFor(account(), { now });
    people.savePropertyPeople(A, HOST, [{ phone: JOE, role: "cleaner" }]);
    people.saveRolePeople(A, "pro", [{ phone: JOE }]);
    expect(people.stop(JOE)?.properties).toEqual([A]);
    expect(people.start(JOE)?.properties).toEqual([A]);
    expect(people.optIn(JOE, A)?.properties).toEqual([A]);
  });

  it("a pro who is only a pro is not on the line's properties", () => {
    const people = peopleFor(account(), { now });
    people.saveRolePeople(A, "pro", [{ phone: JOE }]);
    expect(people.propertiesOf(JOE)).toEqual([]);
    expect(people.roleOn(JOE, A)).toBe("pro");
  });
});

describe("copyPhotos and the flag", () => {
  const jpg = (n: number) => ({ bytes: Buffer.from([n]), ext: "jpg" });

  it("copies in order after what is there, up to the cap", () => {
    const root = account();
    storePhotos(root, "from", [jpg(1), jpg(2), jpg(3)]);
    storePhotos(root, "to", [jpg(9)]);
    expect(copyPhotos(root, "from", "to")).toBe(3);
    expect(photoCount(root, "to")).toBe(4);
    storePhotos(root, "big", Array.from({ length: 8 }, (_, i) => jpg(i)));
    expect(copyPhotos(root, "from", "big")).toBe(2);
    expect(photoCount(root, "big")).toBe(MAX_JOB_PHOTOS);
    expect(copyPhotos(root, "none", "to")).toBe(0);
  });

  it("fixerCoreOn follows FIXER_CORE", () => {
    expect(fixerCoreOn({})).toBe(false);
    expect(fixerCoreOn({ FIXER_CORE: "1" })).toBe(true);
    expect(fixerCoreOn({ FIXER_CORE: " TRUE " })).toBe(true);
    expect(fixerCoreOn({ FIXER_CORE: "0" })).toBe(false);
  });
});

describe("the setup draft", () => {
  it("leaves out a person who is only a pro, and a pro's pro entry from one who is also a cleaner", { timeout: 180_000 }, async () => {
    open = await sharedAccount();
    const s = open;
    await s.liveProperty("Scratch Lane", LANE, { cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
    const court = await s.add("Scratch Court");
    await s.tool("set_flows", { property: court, cleaning: true });
    const lane = s.peopleFile()!.people.find((p) => p.phone === CLEANER)!.where[0]!.propertyId;
    const people = peopleFor(s.accountRoot(), { now });
    people.saveRolePeople(lane, "pro", [{ phone: JOE, name: "Joe" }, { phone: CLEANER }]);
    const known = (await s.tool("get_state", { property: court, choice: "cleaners" })).structured?.draft as { knownPeople?: { name?: string; on: { role: string }[] }[] };
    expect(known.knownPeople?.map((p) => p.name)).toEqual(["Ana"]);
    expect(known.knownPeople?.[0]?.on).toEqual([expect.objectContaining({ role: "cleaner" })]);
  });
});
