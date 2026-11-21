import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hubFor, resetHubs } from "../src/hub/hub";
import { FakeLockAdapter } from "../src/locks/fake";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { visitLogFor } from "../src/visits/store";
import { deskFeatures } from "./featureEnv";

/**
 * The bring-in flow in the hub's grants (#241): a package helper's own code beside cleaning, repair, standing
 * and guest. Only the fake lock adapter, 555 numbers, and codes made at runtime.
 */

const NOW = new Date("2026-11-17T15:00:00Z");
const WINDOW = { from: "2026-11-17T15:00:00.000Z", until: "2026-11-17T19:00:00.000Z" };
const SAVED = ["4", "8", "2", "1"].join("");
const ANA = "+15555550111";
const ON = { ...deskFeatures("locks"), CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64") };
const roots: string[] = [];

afterEach(() => {
  resetHubs();
  setLockAdapter(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "bring-in-grants-"));
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

const bringIn = { jobId: "supply:ord_a", person: ANA, window: WINDOW, label: "Ana" };

describe("a bring-in flow in the grants", () => {
  it("puts one Package code on the lock for the bring-in window, named as a package helper's", async () => {
    const { root, fake, door } = setup();
    expect(await door.syncGrants("bring-in", [bringIn])).toEqual([]);
    const live = fake.liveCodes("dev-front");
    expect(live).toHaveLength(1);
    expect(live[0]!.window).toEqual(WINDOW);
    expect(live[0]!.name).toMatch(/^Package [a-z]+$/);
    expect(live[0]!.name).not.toMatch(/\d/);
    // Named, so "someone else came in" and the visit records count it as Property Core's, and not as the cleaner's.
    expect(visitLogFor(root, () => NOW).codeNames()[live[0]!.name]).toEqual({ role: "package" });
  });

  it("leaves the other flows' codes alone, and they leave the bring-in code alone", async () => {
    const { fake, door } = setup();
    await door.syncGrants("bring-in", [bringIn]);
    await door.syncGrants("cleaning", []);
    await door.syncGrants("repair", []);
    await door.syncGrants("guest", []);
    expect(fake.liveCodes("dev-front")).toHaveLength(1);
    await door.syncGrants("bring-in", []);
    expect(fake.liveCodes("dev-front")).toHaveLength(0);
  });

  it("revokes the old person's code and makes a new one when the host picks someone else", async () => {
    const { fake, door } = setup();
    await door.syncGrants("bring-in", [bringIn]);
    const first = fake.liveCodes("dev-front")[0]!.code;
    await door.syncGrants("bring-in", [{ ...bringIn, person: "+15555550122", label: "Ray" }]);
    const live = fake.liveCodes("dev-front");
    expect(live).toHaveLength(1);
    expect(live[0]!.code).not.toBe(first);
  });

  it("releases the person's own code, falling back to a backup code and then the host's saved code", async () => {
    const { fake, door } = setup();
    await door.syncGrants("bring-in", [bringIn]);
    const code = fake.liveCodes("dev-front")[0]!.code;
    expect(await door.request({ person: ANA, window: WINDOW, purpose: "bring-in", jobId: bringIn.jobId, label: "Ana" })).toMatchObject({ ok: true, code });
    expect(await door.request({ person: "+15555550122", window: WINDOW, purpose: "bring-in", jobId: bringIn.jobId })).not.toMatchObject({ code });

    await door.syncGrants("bring-in", []);
    fake.failCodes("dev-front");
    fake.setBackups("dev-front", 0);
    await door.syncGrants("bring-in", [bringIn]);
    const fell = await door.request({ person: ANA, window: WINDOW, purpose: "bring-in", jobId: bringIn.jobId, label: "Ana" });
    expect(fell).toMatchObject({ ok: true, code: SAVED });
    expect(JSON.stringify((fell as { notes?: unknown }).notes)).toMatch(/Ana/);
  });

  it("holds the bring-in code in the leak checks, and no file but the sealed grants holds it", async () => {
    const { root, fake, door } = setup();
    await door.syncGrants("bring-in", [bringIn]);
    const code = fake.liveCodes("dev-front")[0]!.code;
    expect(door.codesForChecksAll()).toContain(code);
    for (const name of readdirSync(root)) {
      if (name === "door-access.json") continue;
      expect(readFileSync(join(root, name), "utf8")).not.toContain(code);
    }
  });
});
