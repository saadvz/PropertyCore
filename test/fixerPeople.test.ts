import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixerDeskFor, resetFixerDesks } from "../src/fixer-core/desk";
import { readFixer } from "../src/fixer-core/store";
import { peopleFor, resetPeople } from "../src/hub/people";
import { hubFor, resetHubs } from "../src/hub/hub";

/** Saved pros are role "pro" in people.json. Only 555 numbers and made-up pros. */

const NOW = new Date("2026-11-08T15:00:00.000Z");
const A = "prp_aaaaaaaaaa";
const B = "prp_bbbbbbbbbb";
const HOST = "+15555550100";
const JOE = "+15555550142";

const dirs: string[] = [];
afterEach(() => {
  resetFixerDesks();
  resetHubs();
  resetPeople();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(propertyId = A, account = mkdtempSync(join(tmpdir(), "fixer-people-"))) {
  dirs.push(account);
  const root = mkdtempSync(join(tmpdir(), "fixer-prop-"));
  dirs.push(root);
  hubFor(root, { now: () => NOW }).saveProperty({ address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" });
  const people = () => peopleFor(account, { now: () => NOW });
  people().savePropertyPeople(propertyId, HOST, []);
  const desk = fixerDeskFor(root, { now: () => NOW, propertyId, people });
  return { account, root, desk, people: people() };
}

const joe = { name: "Joe's Plumbing", trades: ["plumbing" as const], reach: { phone: JOE } };
const roles = (people: ReturnType<typeof setup>["people"], phone: string, propertyId = A) => people.rolesOn(phone, propertyId);

describe("pros in people.json", () => {
  it("lists a saved pro with a phone as role pro, with their name", () => {
    const { desk, people } = setup();
    return desk.savePro(joe).then(() => {
      expect(roles(people, JOE)).toEqual(["pro"]);
      expect(people.person(JOE)!.name).toBe("Joe's Plumbing");
    });
  });

  it("does not list a draft, or a pro with no phone", async () => {
    const { desk, people } = setup();
    await desk.savePro({ ...joe, draft: true });
    await desk.savePro({ name: "Ana Electric", trades: ["electrical"], reach: { email: "ana@example.com" } });
    expect(people.person(JOE)).toBeUndefined();
    expect(people.everyone()).toEqual([]);
  });

  it("lists a draft once the host confirms it", async () => {
    const { desk, people } = setup();
    const id = (await desk.savePro({ ...joe, draft: true })).structured!.proId as string;
    expect(roles(people, JOE)).toEqual([]);
    await desk.savePro({ confirm: [id] });
    expect(roles(people, JOE)).toEqual(["pro"]);
  });

  it("removes the role when the pro is removed, and keeps the other pros", async () => {
    const { desk, people } = setup();
    const id = (await desk.savePro(joe)).structured!.proId as string;
    await desk.savePro({ name: "Sam Handyman", trades: ["handyman"], reach: { phone: "+15555550143" } });
    await desk.removePro({ id });
    expect(roles(people, JOE)).toEqual([]);
    expect(roles(people, "+15555550143")).toEqual(["pro"]);
  });

  it("moves the role when a pro's phone changes", async () => {
    const { desk, people } = setup();
    const id = (await desk.savePro(joe)).structured!.proId as string;
    await desk.savePro({ ...joe, id, reach: { phone: "+15555550177" } });
    expect(roles(people, JOE)).toEqual([]);
    expect(roles(people, "+15555550177")).toEqual(["pro"]);
  });

  it("keeps id and addedAt when edited by id", async () => {
    const { root, desk } = setup();
    const id = (await desk.savePro(joe)).structured!.proId as string;
    const before = readFixer(root).pros[0]!;
    await desk.savePro({ ...joe, id, name: "Joe's Plumbing & Heating", trades: ["plumbing", "hvac"] });
    const [after] = readFixer(root).pros;
    expect(readFixer(root).pros).toHaveLength(1);
    expect(after).toMatchObject({ id, addedAt: before.addedAt, name: "Joe's Plumbing & Heating", trades: ["plumbing", "hvac"] });
  });

  it("does not take the property's cleaner role away, and the cleaner's save does not take the pro role", async () => {
    const { desk, people } = setup();
    people.savePropertyPeople(A, HOST, [{ phone: JOE, role: "cleaner", name: "Joe" }]);
    await desk.savePro(joe);
    expect(roles(people, JOE).sort()).toEqual(["cleaner", "pro"]);
    people.savePropertyPeople(A, HOST, []);
    expect(roles(people, JOE)).toEqual(["pro"]);
  });

  it("refuses the host's own number", async () => {
    const { desk } = setup();
    const reply = await desk.savePro({ ...joe, reach: { phone: HOST } });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("host's own");
  });

  it("needs shared: true for a number already on another property", async () => {
    const first = setup(A);
    await first.desk.savePro(joe);
    const second = setup(B, first.account);
    const refused = await second.desk.savePro(joe);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("shared: true");
    expect(roles(second.people, JOE, B)).toEqual([]);
    expect((await second.desk.savePro({ ...joe, shared: true })).isError).toBe(false);
    expect(roles(second.people, JOE, B)).toEqual(["pro"]);
    expect(roles(second.people, JOE, A)).toEqual(["pro"]);
  });

  it("works without a people list (a standalone desk)", async () => {
    const root = mkdtempSync(join(tmpdir(), "fixer-alone-"));
    dirs.push(root);
    const desk = fixerDeskFor(root, { now: () => NOW });
    expect((await desk.savePro(joe)).isError).toBe(false);
  });
});
