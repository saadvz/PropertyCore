import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hubFor, resetHubs } from "../src/hub/hub";
import { FakeLockAdapter } from "../src/locks/fake";
import { applyLockEvent } from "../src/locks/inbound";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { visitLogFor } from "../src/visits/store";
import { deskFeatures } from "./featureEnv";

/**
 * Guest codes in the hub's grants (#262): a guest flow beside cleaning, repair and standing. Only the
 * fake lock adapter, made-up confirmation codes, and codes made at runtime.
 */

const NOW = new Date("2026-12-10T12:00:00Z");
const STAY = { from: "2026-12-12T20:00:00.000Z", until: "2026-12-15T16:00:00.000Z" };
const SAVED = ["4", "8", "2", "1"].join("");
const ON = { ...deskFeatures("locks"), CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64") };
const roots: string[] = [];

afterEach(() => {
  resetHubs();
  setLockAdapter(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "guest-grants-"));
  roots.push(root);
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  const front = fake.addDevice("acct-1", { id: "dev-front", name: "Front door" });
  const hub = hubFor(root, { now: () => NOW });
  const door = hub.doorAccess(() => ON);
  door.useSleep(async () => undefined);
  door.save(SAVED, "back door", undefined);
  door.saveLocks({ ...emptyLocks(), customerKey: "acct-1", devices: [storedDevice(front)], doors: [front.id], activeAt: NOW.toISOString() });
  return { root, fake, door };
}

const guest = { jobId: "stay:HMSCRATCHAA", person: "guest:HMSCRATCHAA", window: STAY, label: "the guest on 12–15 Dec", who: { role: "guest" as const } };

describe("a guest flow in the grants", () => {
  it("puts one code on the lock for the stay's window, named as the guest's", async () => {
    const { root, fake, door } = setup();
    expect(await door.syncGrants("guest", [guest])).toEqual([]);
    const live = fake.liveCodes("dev-front");
    expect(live).toHaveLength(1);
    expect(live[0]!.window).toEqual(STAY);
    expect(live[0]!.name).toMatch(/^Guest [a-z]+$/);
    expect(visitLogFor(root, () => NOW).codeNames()[live[0]!.name]).toEqual({ role: "guest" });
    expect(door.grants().live("guest", guest.jobId)).toMatchObject({ flow: "guest", window: STAY, revoked: false });
  });

  it("leaves the other flows' codes alone, and they leave the guest's alone", async () => {
    const { fake, door } = setup();
    await door.syncGrants("guest", [guest]);
    await door.syncGrants("cleaning", []);
    await door.syncGrants("standing", []);
    expect(fake.liveCodes("dev-front")).toHaveLength(1);
    await door.syncGrants("guest", []);
    expect(fake.liveCodes("dev-front")).toHaveLength(0);
  });

  it("releases the guest's own code, and never falls back to the host's saved code", async () => {
    const { fake, door } = setup();
    await door.syncGrants("guest", [guest]);
    const code = fake.liveCodes("dev-front")[0]!.code;
    expect(await door.request({ person: guest.person, window: STAY, purpose: "guest", jobId: guest.jobId })).toMatchObject({ ok: true, code });

    const other = { ...guest, jobId: "stay:HMSCRATCHBB", person: "guest:HMSCRATCHBB" };
    fake.failCodes("dev-front");
    fake.setBackups("dev-front", 0);
    await door.syncGrants("guest", [guest, other]);
    const refused = await door.request({ person: other.person, window: STAY, purpose: "guest", jobId: other.jobId });
    expect(refused).toMatchObject({ ok: false, reason: "lock-failed" });
    expect(JSON.stringify(refused)).not.toContain(SAVED);
  });

  it("holds the guest code in the leak checks", async () => {
    const { fake, door } = setup();
    await door.syncGrants("guest", [guest]);
    expect(door.codesForChecksAll()).toContain(fake.liveCodes("dev-front")[0]!.code);
  });

  it("a guest code the lock refused, with no backup, never points the host to the saved code", async () => {
    const { fake, door } = setup();
    fake.setBackups("dev-front", 0);
    await door.syncGrants("guest", [guest]);
    const codeId = fake.liveCodes("dev-front")[0]!.codeId;
    const result = await applyLockEvent(door, fake, { id: "evt-1", kind: "code-failed", partnerType: "access_code.failed_to_set_on_device", at: NOW.toISOString(), deviceId: "dev-front", codeId }, NOW);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]!.text).toContain("the guest on 12–15 Dec");
    expect(result.notes[0]!.text).not.toMatch(/saved|your own door code/);
  });
});
