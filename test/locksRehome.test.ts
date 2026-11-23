import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { holdsCodeToken } from "../src/hub/digits";
import { hubFor, resetHubs } from "../src/hub/hub";
import type { LockDevice } from "../src/locks/adapter";
import { FakeLockAdapter } from "../src/locks/fake";
import { applyLockEvent } from "../src/locks/inbound";
import { setLockAdapter } from "../src/locks/registry";
import { matchDoors } from "../src/locks/rehome";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { deskFeatures } from "./featureEnv";

/**
 * Codes after a reconnect (#280 item 22): when the doors come back under new ids, every live code moves to the new
 * door with the same digits, so nobody needs a new one. Only the fake lock adapter, 555 numbers, runtime codes.
 */

const NOW = new Date("2026-12-01T12:00:00Z");
const WINDOW = { from: "2026-12-01T16:00:00.000Z", until: "2026-12-02T05:00:00.000Z" };
const SERVER = randomBytes(32).toString("base64");
const ON = { ...deskFeatures("locks"), CLEANER_CORE_PIN_KEY: SERVER };
const roots: string[] = [];

afterEach(() => {
  resetHubs();
  setLockAdapter(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "lock-rehome-"));
  roots.push(root);
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  const device = fake.addDevice("acct-1", { id: "dev-front", name: "Front door" });
  const hub = hubFor(root, { now: () => NOW });
  const door = hub.doorAccess(() => ON);
  door.useSleep(async () => undefined);
  door.saveLocks({ ...emptyLocks(), customerKey: "acct-1", devices: [storedDevice(device)], doors: [device.id], activeAt: NOW.toISOString() });
  return { root, fake, door };
}

const lock = (id: string, name: string): LockDevice => ({ id, accountId: "acct-acct-1", name, kind: "lock", online: true });
const stored = (id: string, name: string) => storedDevice(lock(id, name));

async function issueAll(door: ReturnType<typeof setup>["door"]) {
  await door.syncGrants("cleaning", [{ jobId: "job-1", person: "+15555550101", window: WINDOW, label: "Maria" }]);
  await door.syncGrants("repair", [{ jobId: "fix-1", person: "+15555550102", window: WINDOW, label: "Ace" }]);
  await door.syncGrants("standing", [{ jobId: "st-1", person: "+15555550103", window: { from: NOW.toISOString(), until: "2046-12-01T00:00:00.000Z" }, label: "Sam", who: { role: "shared" } }]);
  await door.syncGrants("guest", [{ jobId: "stay:HMTEST1", person: "guest:HMTEST1", window: WINDOW, label: "the guest", who: { role: "guest" } }]);
}

describe("matching saved doors to the account's locks", () => {
  it("moves a door whose id is gone to the one lock with the same name", () => {
    expect(matchDoors([stored("dev-front", "Front door")], [lock("dev-9", "front  DOOR")])).toEqual({ moves: { "dev-front": "dev-9" }, missing: [] });
  });

  it("two locks with the same name are never guessed", () => {
    expect(matchDoors([stored("dev-front", "Front door")], [lock("dev-8", "Front door"), lock("dev-9", "Front door")])).toEqual({ moves: {}, missing: ["dev-front"] });
  });

  it("leaves a door that's still there, and calls one with no match missing", () => {
    expect(matchDoors([stored("dev-front", "Front door"), stored("dev-side", "Side gate")], [lock("dev-front", "Front door"), lock("dev-7", "Garage")])).toEqual({ moves: {}, missing: ["dev-side"] });
  });
});

describe("re-homing live codes", () => {
  it("moves every live code to the new door with the same digits", async () => {
    const { door, fake } = setup();
    await issueAll(door);
    const before = fake.liveCodes("dev-front").map((code) => code.code).sort();
    expect(before.length).toBe(4);
    fake.replaceDevice("dev-front", "dev-9");
    const result = await door.rehome(await fake.devices({ customerKey: "acct-1" }));
    expect(result.moved).toEqual(["dev-9"]);
    expect(result.missing).toEqual([]);
    expect(fake.liveCodes("dev-9").map((code) => code.code).sort()).toEqual(before);
    expect(door.locks().doors).toEqual(["dev-9"]);
    expect(door.connected()).toBe(true);
    expect(result.notes.map((note) => note.text)).toEqual([
      "Your locks came back after the reconnect. Everyone's codes were put back on the Front door, so nobody needs a new one. Codes named Standing from before may still be on the lock: remove those in the lock's own app.",
    ]);
  });

  it("nobody is texted and no note or file holds a code", async () => {
    const { door, fake, root } = setup();
    await issueAll(door);
    const codes = fake.liveCodes("dev-front").map((code) => code.code);
    fake.replaceDevice("dev-front", "dev-9");
    const result = await door.rehome(await fake.devices({ customerKey: "acct-1" }));
    const files = readdirSync(root).filter((name) => name.endsWith(".json")).map((name) => readFileSync(join(root, name), "utf8"));
    for (const code of codes) {
      expect(holdsCodeToken(JSON.stringify(result), code)).toBe(false);
      for (const file of files) expect(holdsCodeToken(file, code)).toBe(false);
    }
  });

  it("a door with no single match falls back to the saved door code and asks the host to pick", async () => {
    const { door, fake } = setup();
    await issueAll(door);
    fake.replaceDevice("dev-front", "dev-8");
    fake.addDevice("acct-1", { id: "dev-9", name: "Front door" });
    const result = await door.rehome(await fake.devices({ customerKey: "acct-1" }));
    expect(result.missing).toEqual(["dev-front"]);
    expect(door.connected()).toBe(false);
    expect(result.notes).toEqual([{ id: "lock:rehome-missing:dev-front", urgent: true, text: "After the reconnect I can't tell which lock in your lock account is the Front door. Until you pick the doors again, visits use your saved door code." }]);
    expect(fake.liveCodes("dev-8")).toEqual([]);
  });

  it("a door that refuses the old digits is kept for a backup code", async () => {
    const { door, fake } = setup();
    await issueAll(door);
    fake.replaceDevice("dev-front", "dev-9");
    fake.refuseValues("dev-9", 1);
    await door.rehome(await fake.devices({ customerKey: "acct-1" }));
    const statuses = door.grants().statuses().filter((grant) => !grant.revoked).flatMap((grant) => grant.doors.map((item) => item.status));
    expect(statuses.filter((status) => status === "failed").length).toBe(1);
    expect(statuses.filter((status) => status === "set").length).toBe(3);
  });

  it("doesn't say everyone's codes went back when the lock took none of them", async () => {
    const { door, fake } = setup();
    await issueAll(door);
    fake.replaceDevice("dev-front", "dev-9");
    fake.refuseValues("dev-9", 4);
    const result = await door.rehome(await fake.devices({ customerKey: "acct-1" }));
    expect(result.notes.map((note) => note.text)).toEqual([
      "Your locks came back after the reconnect, but the Front door didn't take back the codes from before, so those visits get a backup code or your saved door code instead. Codes named Standing from before may still be on the lock: remove those in the lock's own app.",
    ]);
  });

  it("says how many codes the lock didn't take back when it took some", async () => {
    const { door, fake } = setup();
    await issueAll(door);
    fake.replaceDevice("dev-front", "dev-9");
    fake.refuseValues("dev-9", 1);
    const result = await door.rehome(await fake.devices({ customerKey: "acct-1" }));
    expect(result.notes.map((note) => note.text)).toEqual([
      "Your locks came back after the reconnect. Codes from before were put back on the Front door, except 1 the lock didn't take, which gets a backup code or your saved door code instead. Codes named Standing from before may still be on the lock: remove those in the lock's own app.",
    ]);
  });

  it("leaves a code whose window is over where it was", async () => {
    let clock = NOW;
    const root = mkdtempSync(join(tmpdir(), "lock-rehome-"));
    roots.push(root);
    const fake = new FakeLockAdapter();
    setLockAdapter(fake);
    const device = fake.addDevice("acct-1", { id: "dev-front", name: "Front door" });
    const door = hubFor(root, { now: () => clock }).doorAccess(() => ON);
    door.useSleep(async () => undefined);
    door.saveLocks({ ...emptyLocks(), customerKey: "acct-1", devices: [storedDevice(device)], doors: [device.id], activeAt: NOW.toISOString() });
    await door.syncGrants("cleaning", [{ jobId: "job-1", person: "+15555550101", window: WINDOW, label: "Maria" }]);
    clock = new Date(Date.parse(WINDOW.until) + 60 * 60_000);
    fake.replaceDevice("dev-front", "dev-9");
    const result = await door.rehome(await fake.devices({ customerKey: "acct-1" }));
    expect(fake.liveCodes("dev-9")).toEqual([]);
    expect(result.notes.map((note) => note.text)).toEqual(["Your locks came back after the reconnect."]);
  });

  it("does nothing when every saved door is still there", async () => {
    const { door, fake } = setup();
    await issueAll(door);
    const result = await door.rehome(await fake.devices({ customerKey: "acct-1" }));
    expect(result).toEqual({ moved: [], missing: [], notes: [] });
  });
});

describe("the reconnect's first sync", () => {
  it("account-synced runs the re-home and tells the host once", async () => {
    const { door, fake } = setup();
    await issueAll(door);
    const before = fake.liveCodes("dev-front").map((code) => code.code).sort();
    fake.replaceDevice("dev-front", "dev-9");
    const synced = { id: "ev-sync", kind: "account-synced" as const, partnerType: "connected_account.completed_first_sync_after_reconnection", at: NOW.toISOString(), accountId: "acct-acct-1", customerKey: "acct-1" };
    const result = await applyLockEvent(door, fake, synced, NOW);
    expect(result.notes.length).toBe(1);
    expect(fake.liveCodes("dev-9").map((code) => code.code).sort()).toEqual(before);
    expect((await applyLockEvent(door, fake, synced, NOW)).notes).toEqual([]);
  });
});

describe("codes left on doors that are no longer saved (23 Nov Grok run)", () => {
  /** The doors were picked again before re-homing existed: the saved door has a new id, and the codes still name the old one. */
  function pickedAgainBeforeRehome() {
    const made = setup();
    const { door, fake } = made;
    return {
      ...made,
      pickAgain: () => {
        fake.replaceDevice("dev-front", "dev-9");
        const front = lock("dev-9", "Front door");
        door.saveLocks({ ...door.locks(), devices: [storedDevice(front)], doors: [front.id] });
      },
    };
  }

  it("the next sync puts each live code on the saved door, with the same digits", async () => {
    const { door, fake, pickAgain } = pickedAgainBeforeRehome();
    await issueAll(door);
    const before = fake.liveCodes("dev-front").map((code) => code.code).sort();
    pickAgain();
    expect(fake.liveCodes("dev-9")).toEqual([]);
    await issueAll(door);
    expect(fake.liveCodes("dev-9").map((code) => code.code).sort()).toEqual(before);
    const live = door.grants().statuses().filter((grant) => !grant.revoked);
    expect(live.length).toBe(4);
    for (const grant of live) expect(grant.doors.map((item) => item.door)).toEqual(["Front door"]);
  });

  it("get_locks stops calling a code set while it is only on a door that's gone", async () => {
    const { door, pickAgain } = pickedAgainBeforeRehome();
    await issueAll(door);
    pickAgain();
    const standing = door.grants().live("standing", "st-1");
    expect(standing?.doors).toEqual([{ door: "a door", status: "set" }]);
    await door.syncGrants("standing", [{ jobId: "st-1", person: "+15555550103", window: { from: NOW.toISOString(), until: "2046-12-01T00:00:00.000Z" }, label: "Sam", who: { role: "shared" } }]);
    expect(door.grants().live("standing", "st-1")?.doors).toEqual([{ door: "Front door", status: "set" }]);
  });

  it("leaves a code alone while its door is still saved", async () => {
    const { door, fake } = setup();
    await issueAll(door);
    const before = fake.liveCodes("dev-front").map((code) => code.codeId).sort();
    await issueAll(door);
    expect(fake.liveCodes("dev-front").map((code) => code.codeId).sort()).toEqual(before);
  });
});
