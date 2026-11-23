import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hubFor, resetHubs } from "../src/hub/hub";
import { FakeLockAdapter } from "../src/locks/fake";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { deskFeatures } from "./featureEnv";

/**
 * A code waiting for its window was kept as removed (23 Nov Grok retest): get_locks told the host the Nov 28 cleaning
 * code wasn't on the lock, while the lock partner had it scheduled on the Front door. The next sync asks again.
 * Only the fake lock adapter, 555 numbers, runtime codes.
 */

const NOW = new Date("2026-12-01T12:00:00Z");
const WINDOW = { from: "2026-12-05T15:00:00.000Z", until: "2026-12-06T05:00:00.000Z" };
const ON = { ...deskFeatures("locks"), CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64") };
const WANT = [{ jobId: "job-1", person: "+15555550101", window: WINDOW, label: "Maria" }];
const roots: string[] = [];

afterEach(() => {
  resetHubs();
  setLockAdapter(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "lock-scheduled-"));
  roots.push(root);
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  const device = fake.addDevice("acct-1", { id: "dev-front", name: "Front door" });
  const door = hubFor(root, { now: () => NOW }).doorAccess(() => ON);
  door.useSleep(async () => undefined);
  door.saveLocks({ ...emptyLocks(), customerKey: "acct-1", devices: [storedDevice(device)], doors: [device.id], activeAt: NOW.toISOString() });
  return { fake, door };
}

describe("a code kept as removed while it is still on the lock partner", () => {
  it("the next sync asks again and keeps what the partner says", async () => {
    const { fake, door } = setup();
    await door.syncGrants("cleaning", WANT);
    const [code] = fake.liveCodes("dev-front");
    door.grants().markDevice(code!.codeId, "removed");
    expect(door.grants().live("cleaning", "job-1")?.doors).toEqual([{ door: "Front door", status: "removed" }]);
    await door.syncGrants("cleaning", WANT);
    expect(door.grants().live("cleaning", "job-1")?.doors).toEqual([{ door: "Front door", status: "set" }]);
    expect(fake.liveCodes("dev-front")).toHaveLength(1);
  });

  it("leaves a code that is really gone as removed, and makes no second one", async () => {
    const { fake, door } = setup();
    await door.syncGrants("cleaning", WANT);
    const [code] = fake.liveCodes("dev-front");
    await fake.removeCode({ deviceId: "dev-front", codeId: code!.codeId });
    door.grants().markDevice(code!.codeId, "removed");
    await door.syncGrants("cleaning", WANT);
    expect(door.grants().live("cleaning", "job-1")?.doors).toEqual([{ door: "Front door", status: "removed" }]);
    expect(fake.liveCodes("dev-front")).toHaveLength(0);
  });
});
