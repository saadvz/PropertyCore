import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hubFor, resetHubs } from "../src/hub/hub";
import { FakeLockAdapter } from "../src/locks/fake";
import { DOOR_GRANTS_FILE, KEEP_AFTER_MS } from "../src/hub/grants";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { deskFeatures } from "./featureEnv";

/**
 * Per-visit codes in the hub (#180): issued ahead, moved, revoked, released with fallbacks. Only the
 * fake lock adapter, 555 numbers, and codes made at runtime.
 */

const NOW = new Date("2026-12-01T12:00:00Z");
const WINDOW = { from: "2026-12-01T16:00:00.000Z", until: "2026-12-02T05:00:00.000Z" };
const LATER = { from: "2026-12-01T18:00:00.000Z", until: "2026-12-02T05:00:00.000Z" };
const CLEANER = "+15555550101";
const OTHER = "+15555550102";
// Built at runtime so the secret scan never finds a code in this file.
const SAVED = ["4", "8", "2", "1"].join("");
const SERVER = randomBytes(32).toString("base64");
const ON = { ...deskFeatures("locks"), CLEANER_CORE_PIN_KEY: SERVER };
const roots: string[] = [];

afterEach(() => {
  resetHubs();
  setLockAdapter(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(options: { env?: NodeJS.ProcessEnv; doors?: number; active?: boolean; mixed?: boolean; saved?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lock-grants-"));
  roots.push(root);
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  const devices = [fake.addDevice("acct-1", { id: "dev-front", name: "Front door" })];
  if ((options.doors ?? 1) > 1) devices.push(fake.addDevice("acct-1", { id: "dev-side", name: "Side gate" }));
  let now = NOW;
  const hub = hubFor(root, { now: () => now });
  const env = options.env ?? ON;
  const door = hub.doorAccess(() => env);
  door.useSleep(async () => undefined);
  if (options.saved) door.save(SAVED, "back door", undefined);
  door.saveLocks({
    ...emptyLocks(),
    customerKey: "acct-1",
    devices: devices.map((device) => storedDevice(device)),
    doors: [...devices.map((device) => device.id), ...(options.mixed ? ["lockbox"] : [])],
    ...(options.active === false ? {} : { activeAt: NOW.toISOString() }),
  });
  return { root, fake, door, setNow: (at: Date) => (now = at) };
}

const want = (jobId: string, person = CLEANER, window = WINDOW) => ({ jobId, person, window, label: "Maria" });

describe("no connected lock: today's saved code, unchanged", () => {
  it("with the account's locks switch off, a job's request gets the saved code and nothing reaches the lock", async () => {
    const { door, fake } = setup({ env: { CLEANER_CORE_PIN_KEY: SERVER }, saved: true });
    expect(door.connected()).toBe(false);
    expect(await door.syncGrants("cleaning", [want("job-1")])).toEqual([]);
    expect(await door.request({ person: CLEANER, window: WINDOW, purpose: "cleaning", jobId: "job-1" })).toEqual({ ok: true, kind: "code", code: SAVED, lockLocation: "back door", until: WINDOW.until });
    expect(fake.calls).toEqual([]);
  });

  it("a property not switched on, or with a door that isn't connected, keeps the saved code", async () => {
    for (const options of [{ active: false }, { mixed: true }]) {
      const { door, fake } = setup({ ...options, saved: true });
      expect(door.connected()).toBe(false);
      expect(await door.request({ person: CLEANER, window: WINDOW, purpose: "cleaning", jobId: "job-1" })).toMatchObject({ ok: true, code: SAVED });
      expect(fake.calls).toEqual([]);
      resetHubs();
    }
  });

  it("with no lock adapter on the service, nothing is connected", () => {
    const { door } = setup();
    setLockAdapter(undefined);
    expect(door.connected()).toBe(false);
  });
});

describe("issuing ahead", () => {
  it("puts one sealed code per person and job on every door, for the window", async () => {
    const { root, door, fake } = setup({ doors: 2 });
    expect(await door.syncGrants("cleaning", [want("job-1")])).toEqual([]);
    const front = fake.liveCodes("dev-front");
    const side = fake.liveCodes("dev-side");
    expect(front.length).toBe(1);
    expect(side[0]!.code).toBe(front[0]!.code);
    expect(front[0]!.window).toEqual(WINDOW);
    expect(front[0]!.name).toMatch(/^Cleaning [a-z]+$/);
    const text = readFileSync(join(root, DOOR_GRANTS_FILE), "utf8");
    expect(text).not.toContain(front[0]!.code);
    expect(text).not.toContain(SERVER);
    expect(door.grants().live("cleaning", "job-1")?.doors).toEqual([
      { door: "Front door", status: "set" },
      { door: "Side gate", status: "set" },
    ]);
  });

  it("issues once: a second sync with the same wish changes nothing", async () => {
    const { door, fake } = setup();
    await door.syncGrants("cleaning", [want("job-1")]);
    await door.syncGrants("cleaning", [want("job-1")]);
    expect(fake.calls.filter((call) => call.op === "createCode").length).toBe(1);
  });

  it("moves the code when the window moves, and revokes it when the job is gone", async () => {
    const { door, fake } = setup();
    await door.syncGrants("cleaning", [want("job-1")]);
    await door.syncGrants("cleaning", [want("job-1", CLEANER, LATER)]);
    expect(fake.liveCodes("dev-front")[0]!.window).toEqual(LATER);
    await door.syncGrants("cleaning", []);
    expect(fake.liveCodes("dev-front")).toEqual([]);
    expect(door.grants().live("cleaning", "job-1")).toBeUndefined();
  });

  it("revokes the old person's code and makes a new one when someone else takes the job", async () => {
    const { door, fake } = setup();
    await door.syncGrants("cleaning", [want("job-1")]);
    const first = fake.liveCodes("dev-front")[0]!.code;
    await door.syncGrants("cleaning", [want("job-1", OTHER)]);
    const live = fake.liveCodes("dev-front");
    expect(live.length).toBe(1);
    expect(live[0]!.code).not.toBe(first);
  });

  it("leaves another flow's codes alone", async () => {
    const { door, fake } = setup();
    await door.syncGrants("repair", [want("fix-1", OTHER)]);
    await door.syncGrants("cleaning", []);
    expect(fake.liveCodes("dev-front").length).toBe(1);
  });

  it("skips a window that's already over", async () => {
    const { door, fake } = setup();
    await door.syncGrants("cleaning", [want("job-1", CLEANER, { from: "2026-11-30T16:00:00.000Z", until: "2026-12-01T05:00:00.000Z" })]);
    expect(fake.calls.filter((call) => call.op === "createCode")).toEqual([]);
  });

  it("seals with the account's server key, made if missing, whatever key the saved code used", async () => {
    const saved: Record<string, string> = {};
    const env: NodeJS.ProcessEnv = { ...deskFeatures("locks") };
    const { door } = setup({ env });
    door.useSecretSaver((values) => {
      Object.assign(saved, values);
      Object.assign(env, values);
    });
    await door.syncGrants("cleaning", [want("job-1")]);
    expect(saved.CLEANER_CORE_PIN_KEY).toBeTruthy();
    expect(door.grants().live("cleaning", "job-1")).toBeDefined();
  });

  it("tells the host once when no code could be made, and tries again next time", async () => {
    const { door, fake } = setup();
    fake.refuseValues("dev-front", 99);
    const notes = await door.syncGrants("cleaning", [want("job-1")]);
    expect(notes).toEqual([{ id: "lock:issue-failed:cleaning:job-1", jobId: "job-1", text: expect.stringContaining("Maria") }]);
    fake.refuseValues("dev-front", 0);
    expect(await door.syncGrants("cleaning", [want("job-1")])).toEqual([]);
    expect(fake.liveCodes("dev-front").length).toBe(1);
  });

  it("retries a door that didn't answer with the same code", async () => {
    const { door, fake } = setup({ doors: 2 });
    fake.breakOn("dev-side", "createCode");
    await door.syncGrants("cleaning", [want("job-1")]);
    expect(fake.liveCodes("dev-side")).toEqual([]);
    await door.syncGrants("cleaning", [want("job-1")]);
    expect(fake.liveCodes("dev-side")[0]!.code).toBe(fake.liveCodes("dev-front")[0]!.code);
  });
});

describe("release", () => {
  const ask = (jobId = "job-1", person = CLEANER, window = WINDOW) => ({ person, window, purpose: "cleaning" as const, jobId, label: "Maria" });

  it("hands over the code already on the lock", async () => {
    const { door, fake } = setup({ saved: true });
    await door.syncGrants("cleaning", [want("job-1")]);
    const grant = await door.request(ask());
    expect(grant).toEqual({ ok: true, kind: "code", code: fake.liveCodes("dev-front")[0]!.code, until: WINDOW.until });
    expect(grant.ok && grant.code).not.toBe(SAVED);
  });

  it("issues at release when nothing was issued ahead", async () => {
    const { door, fake } = setup();
    const grant = await door.request(ask());
    expect(grant.ok && grant.code).toBe(fake.liveCodes("dev-front")[0]!.code);
  });

  it("never gives one person's code to another", async () => {
    const { door, fake } = setup();
    await door.syncGrants("cleaning", [want("job-1")]);
    const mine = fake.liveCodes("dev-front")[0]!.code;
    const other = await door.request(ask("job-1", OTHER));
    expect(other.ok && other.code).not.toBe(mine);
  });

  it("waits while a code is still programming, then hands it over once set", async () => {
    const { door, fake } = setup();
    fake.programSlowly("dev-front");
    await door.syncGrants("cleaning", [want("job-1")]);
    let waits = 0;
    door.useSleep(async () => {
      waits += 1;
      if (waits === 2) fake.settle("dev-front", "set");
    });
    const grant = await door.request(ask());
    expect(waits).toBe(2);
    expect(grant).toMatchObject({ ok: true, code: fake.liveCodes("dev-front").find((code) => !code.backup)!.code });
    expect(grant.ok && grant.notes).toBeUndefined();
  });

  it("gives up waiting after two minutes and uses a backup code, telling the host", async () => {
    const { door, fake } = setup();
    fake.programSlowly("dev-front");
    await door.syncGrants("cleaning", [want("job-1")]);
    let waits = 0;
    door.useSleep(async () => {
      waits += 1;
    });
    const grant = await door.request(ask());
    expect(waits).toBe(8);
    const backup = fake.liveCodes("dev-front").find((code) => code.backup)!;
    expect(grant).toMatchObject({ ok: true, code: backup.code, notes: [{ text: "The Front door couldn't save Maria's code, so Maria got a backup code for it.", urgent: true }] });
    expect(JSON.stringify(grant.ok && grant.notes)).not.toContain(backup.code);
  });

  it("names codes by door when one of several doors fell back, and keeps the same backup for a second release", async () => {
    const { door, fake } = setup({ doors: 2 });
    fake.failCodes("dev-side");
    await door.syncGrants("cleaning", [want("job-1")]);
    const first = await door.request(ask());
    const main = fake.liveCodes("dev-front")[0]!.code;
    const backup = fake.liveCodes("dev-side").find((code) => code.backup)!.code;
    expect(first).toMatchObject({ ok: true, code: main, doors: [{ door: "Front door", code: main }, { door: "Side gate", code: backup }] });
    const again = await door.request(ask());
    expect(again).toMatchObject({ ok: true, doors: [{ door: "Front door", code: main }, { door: "Side gate", code: backup }] });
    expect(fake.calls.filter((call) => call.op === "backupCode").length).toBe(1);
  });

  it("falls back to the host's saved code when a door has no backup, and tells the host", async () => {
    const { door, fake } = setup({ saved: true });
    fake.failCodes("dev-front");
    fake.setBackups("dev-front", 0);
    await door.syncGrants("cleaning", [want("job-1")]);
    const grant = await door.request(ask());
    expect(grant).toMatchObject({ ok: true, code: SAVED, lockLocation: "back door" });
    expect(grant.ok && grant.notes?.map((note) => note.text)).toEqual(["The Front door couldn't save Maria's code and has no backup codes left.", "The lock couldn't save Maria's own code, so Maria got your saved door code."]);
  });

  it("doesn't repeat a failed code the lock's event already told the host about (one note per failed code)", async () => {
    const { root, door, fake } = setup();
    fake.failCodes("dev-front");
    await door.syncGrants("cleaning", [want("job-1")]);
    const stored = JSON.parse(readFileSync(join(root, DOOR_GRANTS_FILE), "utf8")) as { grants: { devices: { codeId?: string }[] }[] };
    const codeId = stored.grants[0]!.devices[0]!.codeId!;
    expect(await door.grants().backupNow(codeId)).toBe(true);
    const backup = fake.liveCodes("dev-front").find((code) => code.backup)!;
    const grant = await door.request(ask());
    expect(grant).toMatchObject({ ok: true, code: backup.code });
    expect(grant.ok && (grant.notes ?? [])).toEqual([]);
  });

  it("with no backup and no saved code, the release note tells the host to let them in", async () => {
    const { door, fake } = setup();
    fake.failCodes("dev-front");
    fake.setBackups("dev-front", 0);
    await door.syncGrants("cleaning", [want("job-1")]);
    const grant = await door.request(ask());
    expect(grant).toMatchObject({ ok: false, reason: "lock-failed" });
    expect(!grant.ok && grant.notes?.map((note) => note.text)).toEqual(["The Front door couldn't save Maria's code and has no backup codes left. You'll need to let them in."]);
  });

  it("refuses lock-failed with no backup and no saved code", async () => {
    const { door, fake } = setup();
    fake.failCodes("dev-front");
    fake.setBackups("dev-front", 0);
    await door.syncGrants("cleaning", [want("job-1")]);
    expect(await door.request(ask())).toMatchObject({ ok: false, reason: "lock-failed" });
  });

  it("refuses window-over after the window, without touching the lock", async () => {
    const { door, fake, setNow } = setup();
    setNow(new Date(WINDOW.until));
    expect(await door.request(ask())).toEqual({ ok: false, reason: "window-over" });
    expect(fake.calls).toEqual([]);
  });

  it("moves the code to the window the flow asks with", async () => {
    const { door, fake } = setup();
    await door.syncGrants("cleaning", [want("job-1")]);
    await door.request(ask("job-1", CLEANER, LATER));
    expect(fake.liveCodes("dev-front")[0]!.window).toEqual(LATER);
  });
});

describe("leak checks over every live code", () => {
  it("guards the saved code, each grant's code and its backup, until a day after the window", async () => {
    const { door, fake, setNow } = setup({ saved: true, doors: 2 });
    fake.failCodes("dev-side");
    await door.syncGrants("cleaning", [want("job-1")]);
    await door.request({ person: CLEANER, window: WINDOW, purpose: "cleaning", jobId: "job-1" });
    const codes = door.codesForChecksAll();
    expect(codes).toContain(SAVED);
    expect(codes).toContain(fake.liveCodes("dev-front")[0]!.code);
    expect(codes).toContain(fake.liveCodes("dev-side").find((code) => code.backup)!.code);
    setNow(new Date(Date.parse(WINDOW.until) + KEEP_AFTER_MS - 1));
    expect(door.codesForChecksAll().length).toBe(3);
    setNow(new Date(Date.parse(WINDOW.until) + KEEP_AFTER_MS));
    expect(door.codesForChecksAll()).toEqual([SAVED]);
  });

  it("keeps a revoked code in the checks, since it may already have been sent", async () => {
    const { door, fake } = setup();
    await door.syncGrants("cleaning", [want("job-1")]);
    const code = fake.liveCodes("dev-front")[0]!.code;
    await door.syncGrants("cleaning", []);
    expect(door.codesForChecksAll()).toContain(code);
  });

  it("with no grants file, the checks are the saved code alone", () => {
    const { root, door } = setup({ saved: true });
    expect(existsSync(join(root, DOOR_GRANTS_FILE))).toBe(false);
    expect(door.codesForChecksAll()).toEqual([SAVED]);
  });
});
