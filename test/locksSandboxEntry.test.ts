import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SeamLockAdapter, type KeypadEntryResult } from "../src/locks/seam";
import { entryCandidates, safeLine, sandboxEntry, type SandboxKeypad } from "../src/locks/sandboxEntry";
import { main } from "../src/locks/sandboxEntryCli";

/**
 * The operator's sandbox keypad entry (#303): the adapter's sandbox-only calls on a stub fetch, and the
 * command on a made-up property folder with a fake keypad. Nothing here reaches the lock partner. Codes
 * are made up and built at runtime; every test checks that no line says one.
 */

const NOW = new Date("2026-11-28T16:30:00.000Z");
const KEY = `seam_test_${randomBytes(8).toString("hex")}`;
// Built at runtime so the secret scan never finds a code in this file.
const CODE = ["4", "7", "1", "9", "3", "8"].join("");
const OTHER = ["5", "2", "6", "0", "8", "1"].join("");

type Call = { path: string; body: Record<string, unknown> };

function stub(answers: Record<string, { status?: number; body: unknown } | { status?: number; body: unknown }[]>) {
  const calls: Call[] = [];
  const adapter = new SeamLockAdapter({
    apiKey: KEY,
    now: () => NOW,
    sleep: async () => undefined,
    fetch: async (url, init) => {
      const path = url.replace("https://connect.getseam.com", "");
      calls.push({ path, body: JSON.parse(init.body) as Record<string, unknown> });
      const listed = answers[path];
      const answer = Array.isArray(listed) ? (listed.length > 1 ? listed.shift()! : listed[0]!) : listed;
      if (!answer) return { status: 404, json: async () => ({ error: { type: "not_found" } }) };
      return { status: answer.status ?? 200, json: async () => answer.body };
    },
  });
  return { adapter, calls };
}

const SANDBOX = { "/workspaces/get": { body: { workspace: { workspace_id: "ws_1", is_sandbox: true } } } };

describe("the lock partner's sandbox keypad entry", () => {
  it("says a workspace is a sandbox only when the partner says so", async () => {
    expect(await stub(SANDBOX).adapter.isSandbox()).toBe(true);
    expect(await stub({ "/workspaces/get": { body: { workspace: { is_sandbox: false } } } }).adapter.isSandbox()).toBe(false);
    expect(await stub({ "/workspaces/get": { body: { workspace: {} } } }).adapter.isSandbox()).toBe(false);
    expect(await stub({ "/workspaces/get": { status: 401, body: { error: { type: "unauthorized" } } } }).adapter.isSandbox()).toBe(false);
  });

  it("refuses outside a sandbox before reading or sending any code", async () => {
    const { adapter, calls } = stub({ "/workspaces/get": { body: { workspace: { is_sandbox: false } } } });
    expect(await adapter.simulateKeypadEntry({ deviceId: "d1", codeId: "ac1" })).toEqual({ status: "refused", reason: "not-sandbox" });
    expect(calls.map((call) => call.path)).toEqual(["/workspaces/get"]);
  });

  it("types the code it reads from the partner, waits out a pending attempt, and never returns the code", async () => {
    const { adapter, calls } = stub({
      ...SANDBOX,
      "/access_codes/get": { body: { access_code: { access_code_id: "ac1", device_id: "d1", code: CODE, status: "set" } } },
      "/locks/simulate/keypad_code_entry": { body: { action_attempt: { action_attempt_id: "aa1", status: "pending", error: null } } },
      "/action_attempts/get": [{ body: { action_attempt: { action_attempt_id: "aa1", status: "pending" } } }, { body: { action_attempt: { action_attempt_id: "aa1", status: "success", error: null } } }],
    });
    const result = await adapter.simulateKeypadEntry({ deviceId: "d1", codeId: "ac1" });
    expect(result).toEqual({ status: "success" });
    expect(JSON.stringify(result)).not.toContain(CODE);
    const entry = calls.find((call) => call.path === "/locks/simulate/keypad_code_entry")!;
    expect(entry.body).toEqual({ device_id: "d1", code: CODE });
    expect(calls.filter((call) => call.path === "/action_attempts/get")).toHaveLength(2);
  });

  it("enters nothing when the code isn't on that device or has no value", async () => {
    const elsewhere = stub({ ...SANDBOX, "/access_codes/get": { body: { access_code: { access_code_id: "ac1", device_id: "d2", code: CODE } } } });
    expect(await elsewhere.adapter.simulateKeypadEntry({ deviceId: "d1", codeId: "ac1" })).toEqual({ status: "refused", reason: "not-on-device" });
    expect(elsewhere.calls.some((call) => call.path === "/locks/simulate/keypad_code_entry")).toBe(false);
    const empty = stub({ ...SANDBOX, "/access_codes/get": { body: { access_code: { access_code_id: "ac1", device_id: "d1" } } } });
    expect(await empty.adapter.simulateKeypadEntry({ deviceId: "d1", codeId: "ac1" })).toEqual({ status: "refused", reason: "no-code" });
  });

  it("locks a door left unlocked before typing, since the sandbox answers 400 on an unlocked door", async () => {
    const { adapter, calls } = stub({
      ...SANDBOX,
      "/access_codes/get": { body: { access_code: { access_code_id: "ac1", device_id: "d1", code: CODE, status: "set" } } },
      "/devices/get": { body: { device: { device_id: "d1", properties: { locked: false } } } },
      "/locks/lock_door": { body: { action_attempt: { action_attempt_id: "lk1", status: "pending" } } },
      "/action_attempts/get": { body: { action_attempt: { action_attempt_id: "lk1", status: "success" } } },
      "/locks/simulate/keypad_code_entry": { body: { action_attempt: { action_attempt_id: "aa1", status: "success" } } },
    });
    expect(await adapter.simulateKeypadEntry({ deviceId: "d1", codeId: "ac1" })).toEqual({ status: "success", lockedFirst: true });
    expect(calls.map((call) => call.path)).toEqual(["/workspaces/get", "/access_codes/get", "/devices/get", "/locks/lock_door", "/action_attempts/get", "/locks/simulate/keypad_code_entry"]);
    expect(calls.find((call) => call.path === "/locks/lock_door")!.body).toEqual({ device_id: "d1" });
  });

  it("leaves a locked door alone, and a door whose state it can't read", async () => {
    const locked = stub({
      ...SANDBOX,
      "/access_codes/get": { body: { access_code: { access_code_id: "ac1", device_id: "d1", code: CODE } } },
      "/devices/get": { body: { device: { device_id: "d1", properties: { locked: true } } } },
      "/locks/simulate/keypad_code_entry": { body: { action_attempt: { action_attempt_id: "aa1", status: "success" } } },
    });
    expect(await locked.adapter.simulateKeypadEntry({ deviceId: "d1", codeId: "ac1" })).toEqual({ status: "success" });
    expect(locked.calls.some((call) => call.path === "/locks/lock_door")).toBe(false);
    const unreadable = stub({
      ...SANDBOX,
      "/access_codes/get": { body: { access_code: { access_code_id: "ac1", device_id: "d1", code: CODE } } },
      "/devices/get": { status: 500, body: { error: { type: "internal" } } },
      "/locks/simulate/keypad_code_entry": { body: { action_attempt: { action_attempt_id: "aa1", status: "success" } } },
    });
    expect(await unreadable.adapter.simulateKeypadEntry({ deviceId: "d1", codeId: "ac1" })).toEqual({ status: "success" });
    expect(unreadable.calls.some((call) => call.path === "/locks/lock_door")).toBe(false);
  });

  it("types nothing when the unlocked door won't lock", async () => {
    const { adapter, calls } = stub({
      ...SANDBOX,
      "/access_codes/get": { body: { access_code: { access_code_id: "ac1", device_id: "d1", code: CODE } } },
      "/devices/get": { body: { device: { device_id: "d1", properties: { locked: false } } } },
      "/locks/lock_door": { status: 400, body: { error: { type: "invalid_input", message: "nope" } } },
    });
    expect(await adapter.simulateKeypadEntry({ deviceId: "d1", codeId: "ac1" })).toEqual({ status: "refused", reason: "would-not-lock", httpStatus: 400 });
    expect(calls.some((call) => call.path === "/locks/simulate/keypad_code_entry")).toBe(false);
  });

  it("gives back the status and type of an entry the partner turns down, not an exception", async () => {
    const { adapter } = stub({
      ...SANDBOX,
      "/access_codes/get": { body: { access_code: { access_code_id: "ac1", device_id: "d1", code: CODE } } },
      "/devices/get": { body: { device: { device_id: "d1", properties: { locked: true } } } },
      "/locks/simulate/keypad_code_entry": { status: 400, body: { error: { type: "invalid_input", message: `bad ${CODE}` } } },
    });
    const result = await adapter.simulateKeypadEntry({ deviceId: "d1", codeId: "ac1" });
    expect(result).toEqual({ status: "rejected", httpStatus: 400, errorType: "invalid_input" });
    expect(JSON.stringify(result)).not.toContain(CODE);
  });

  it("gives back the partner's error type, never its message", async () => {
    const { adapter } = stub({
      ...SANDBOX,
      "/access_codes/get": { body: { access_code: { access_code_id: "ac1", device_id: "d1", code: CODE } } },
      "/locks/simulate/keypad_code_entry": { body: { action_attempt: { action_attempt_id: "aa1", status: "error", error: { type: "device_not_supported", message: `bad code ${CODE}` } } } },
    });
    const result = await adapter.simulateKeypadEntry({ deviceId: "d1", codeId: "ac1" });
    expect(result).toEqual({ status: "error", errorType: "device_not_supported" });
  });
});

// A made-up property folder: two doors, and one code each for the cleaner, a pro, a vendor, a visitor, the host and a guest.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function grant(id: string, flow: string, jobId: string, codeName: string, window: { from: string; until: string }, devices: { deviceId: string; codeId?: string; status: string }[], extra: Record<string, unknown> = {}) {
  return { id, flow, jobId, person: "+15555550100", codeName, window, devices, seal: { iv: "x", data: "x", tag: "x" }, createdAt: "2026-11-20T12:00:00.000Z", ...extra };
}

const TODAY = { from: "2026-11-28T15:00:00.000Z", until: "2026-11-28T19:00:00.000Z" };
const LATER = { from: "2026-12-03T17:00:00.000Z", until: "2026-12-03T22:00:00.000Z" };

function propertyFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "sandbox-entry-"));
  dirs.push(root);
  writeFileSync(
    join(root, "door-locks.json"),
    JSON.stringify({ schemaVersion: 1, customerKey: "tnt_test", devices: [{ id: "d1", accountId: "ca1", name: "Front door", kind: "lock", online: true }, { id: "d2", accountId: "ca1", name: "Back door", kind: "lock", online: true }], doors: ["d1", "d2"], release: { cleaners: "ask", pros: "ask" } }),
  );
  writeFileSync(
    join(root, "door-grants.json"),
    JSON.stringify({
      schemaVersion: 1,
      grants: [
        grant("gcl", "cleaning", "jobclean", "Cleaning abcdefgh", TODAY, [{ deviceId: "d1", codeId: "ac-clean", status: "set" }], { label: "Maria" }),
        grant("gpr", "repair", "jobfix", "Repair bcdefghj", TODAY, [{ deviceId: "d1", codeId: "ac-pro", status: "set" }, { deviceId: "d2", codeId: "ac-pro-2", status: "set" }], { label: "Sam" }),
        grant("gvn", "repair", "jobpest", "Repair cdefghjk", LATER, [{ deviceId: "d1", codeId: "ac-vendor", status: "scheduled" }], { label: "Pat" }),
        grant("gvi", "visit", "visitone", "Visit defghjkm", TODAY, [{ deviceId: "d1", codeId: "ac-visit", status: "set" }], { label: "Test Visitor" }),
        grant("gst", "standing", "hostself", "Standing efghjkmn", { from: "2026-11-01T00:00:00.000Z", until: "2046-11-01T00:00:00.000Z" }, [{ deviceId: "d1", codeId: "ac-host", status: "set" }]),
        grant("ggu", "guest", "stay:HM", "Guest fghjkmnp", TODAY, [{ deviceId: "d1", codeId: "ac-guest", status: "set" }]),
        grant("gold", "cleaning", "jobold", "Cleaning ghjkmnpq", TODAY, [{ deviceId: "d1", codeId: "ac-old", status: "removed" }], { revokedAt: "2026-11-21T00:00:00.000Z" }),
      ],
    }),
  );
  writeFileSync(join(root, "visit-codes.json"), JSON.stringify({ codes: { "Standing efghjkmn": { role: "host" }, "Cleaning abcdefgh": { role: "cleaner" } } }));
  writeFileSync(join(root, "fixer.json"), JSON.stringify({ jobs: [{ id: "jobfix", booking: { proId: "p1" } }, { id: "jobpest", booking: { proId: "p2", vendor: { confirmedAt: "2026-11-24T00:00:00.000Z" } } }] }));
  writeFileSync(join(root, "hub.json"), JSON.stringify({ property: { address: "1 Test Lane", timeZone: "America/New_York" } }));
  return root;
}

class FakeKeypad implements SandboxKeypad {
  readonly entered: { deviceId: string; codeId: string }[] = [];
  constructor(
    private readonly sandbox = true,
    private readonly answer: KeypadEntryResult = { status: "success" },
  ) {}
  async isSandbox() {
    return this.sandbox;
  }
  async simulateKeypadEntry(input: { deviceId: string; codeId: string }) {
    this.entered.push(input);
    return this.answer;
  }
}

const noDigits = (lines: string[]) => {
  for (const line of lines) {
    expect(line).not.toContain(CODE);
    expect(line).not.toContain(OTHER);
    expect(line).not.toMatch(/\d{4,}/);
  }
};

describe("the sandbox entry command", () => {
  it("finds each person's code by whose it is: vendor and pro apart, the host's standing code by its saved name", () => {
    const root = propertyFolder();
    expect(entryCandidates(root, "cleaner").map((c) => c.jobId)).toEqual(["jobclean"]);
    expect(entryCandidates(root, "pro").map((c) => c.jobId)).toEqual(["jobfix"]);
    expect(entryCandidates(root, "vendor").map((c) => c.jobId)).toEqual(["jobpest"]);
    expect(entryCandidates(root, "visitor").map((c) => c.jobId)).toEqual(["visitone"]);
    expect(entryCandidates(root, "host").map((c) => c.jobId)).toEqual(["hostself"]);
    expect(entryCandidates(root, "guest").map((c) => c.jobId)).toEqual(["stay:HM"]);
    expect(entryCandidates(root, "shared")).toEqual([]);
  });

  it("enters the cleaner's code on its door and says whose it was and when, with no digits", async () => {
    const keypad = new FakeKeypad();
    const outcome = await sandboxEntry({ root: propertyFolder(), who: "cleaner", keypad, now: () => NOW, timeZone: "America/New_York" });
    expect(outcome.exitCode).toBe(0);
    expect(keypad.entered).toEqual([{ deviceId: "d1", codeId: "ac-clean" }]);
    expect(outcome.lines).toEqual(["Entered the cleaner's code (Maria) on the Front door keypad at Nov 28, 11:30 AM EST."]);
    noDigits(outcome.lines);
  });

  it("refuses a workspace that isn't a sandbox and enters nothing", async () => {
    const keypad = new FakeKeypad(false);
    const outcome = await sandboxEntry({ root: propertyFolder(), who: "cleaner", keypad, now: () => NOW });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.lines[0]).toMatch(/^Refused/);
    expect(keypad.entered).toEqual([]);
  });

  it("asks for the door when the code is on two, and takes --door", async () => {
    const root = propertyFolder();
    const asked = await sandboxEntry({ root, who: "pro", keypad: new FakeKeypad(), now: () => NOW });
    expect(asked.exitCode).toBe(2);
    expect(asked.lines[0]).toContain("Front door, Back door");
    const keypad = new FakeKeypad();
    const done = await sandboxEntry({ root, who: "pro", door: "back door", keypad, now: () => NOW });
    expect(done.exitCode).toBe(0);
    expect(keypad.entered).toEqual([{ deviceId: "d2", codeId: "ac-pro-2" }]);
  });

  it("enters a code outside its window when asked, and says so", async () => {
    const keypad = new FakeKeypad();
    const outcome = await sandboxEntry({ root: propertyFolder(), who: "vendor", keypad, now: () => NOW, timeZone: "America/New_York" });
    expect(outcome.exitCode).toBe(0);
    expect(keypad.entered).toEqual([{ deviceId: "d1", codeId: "ac-vendor" }]);
    expect(outcome.lines[0]).toContain("That was outside its window (Dec 3, 12:00 PM EST to Dec 3, 5:00 PM EST).");
    noDigits(outcome.lines);
  });

  it("lists the choices without digits when the person has several codes and none is open now", async () => {
    const root = propertyFolder();
    const file = join(root, "door-grants.json");
    const two = {
      schemaVersion: 1,
      grants: [
        grant("ga", "cleaning", "joba", "Cleaning hjkmnpqr", LATER, [{ deviceId: "d1", codeId: "ac-a", status: "scheduled" }], { label: "Maria" }),
        grant("gb", "cleaning", "jobb", "Cleaning jkmnpqrs", { from: "2026-12-10T17:00:00.000Z", until: "2026-12-10T21:00:00.000Z" }, [{ deviceId: "d1", codeId: "ac-b", status: "scheduled" }], { label: "Maria", createdAt: "2026-11-21T12:00:00.000Z" }),
      ],
    };
    writeFileSync(file, JSON.stringify(two));
    const keypad = new FakeKeypad();
    const asked = await sandboxEntry({ root, who: "cleaner", keypad, now: () => NOW, timeZone: "America/New_York" });
    expect(asked.exitCode).toBe(2);
    expect(asked.lines).toHaveLength(3);
    expect(keypad.entered).toEqual([]);
    noDigits(asked.lines);
    const picked = await sandboxEntry({ root, who: "cleaner", pick: "2", keypad, now: () => NOW });
    expect(picked.exitCode).toBe(0);
    expect(keypad.entered).toEqual([{ deviceId: "d1", codeId: "ac-a" }]);
  });

  it("on an error from the partner, says to check door activity, since the unlock can still arrive", async () => {
    const keypad = new FakeKeypad(true, { status: "error", errorType: "UnknownError" });
    const outcome = await sandboxEntry({ root: propertyFolder(), who: "host", keypad, now: () => NOW, timeZone: "America/New_York" });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.lines).toEqual(["The lock partner reported an error entering the host's code on the Front door keypad at Nov 28, 11:30 AM EST (UnknownError), but the unlock can still arrive. Check door activity before you try again."]);
    noDigits(outcome.lines);
  });

  it("says when the door was found unlocked and locked first", async () => {
    const keypad = new FakeKeypad(true, { status: "success", lockedFirst: true });
    const outcome = await sandboxEntry({ root: propertyFolder(), who: "host", keypad, now: () => NOW, timeZone: "America/New_York" });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.lines).toEqual(["The Front door was unlocked, so it was locked first. That lock shows in door activity too.", "Entered the host's code on the Front door keypad at Nov 28, 11:30 AM EST."]);
    noDigits(outcome.lines);
  });

  it("explains a bare 400 in plain words: the door is already unlocked, lock it from the console", async () => {
    const keypad = new FakeKeypad(true, { status: "rejected", httpStatus: 400 });
    const outcome = await sandboxEntry({ root: propertyFolder(), who: "host", keypad, now: () => NOW, timeZone: "America/New_York" });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.lines).toEqual([
      "The lock partner turned down the host's code on the Front door keypad (it answered 400). Nothing was entered. The sandbox answers 400 when the door is already unlocked, and each entry leaves it unlocked. Lock the Front door from the Seam console, then run this again.",
    ]);
    const after = await sandboxEntry({ root: propertyFolder(), who: "host", keypad: new FakeKeypad(true, { status: "rejected", httpStatus: 400, errorType: "invalid_input", lockedFirst: true }), now: () => NOW });
    expect(after.lines.at(-1)).toContain("isn't it");
    noDigits([...outcome.lines, ...after.lines]);
  });

  it("says the unlocked door wouldn't lock, and that nothing was entered", async () => {
    const keypad = new FakeKeypad(true, { status: "refused", reason: "would-not-lock", httpStatus: 400 });
    const outcome = await sandboxEntry({ root: propertyFolder(), who: "host", keypad, now: () => NOW });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.lines).toEqual(["The Front door is unlocked, and the lock partner wouldn't lock it (it answered 400). The sandbox turns down a keypad entry on an unlocked door, so nothing was entered. Lock it from the Seam console, then run this again."]);
  });

  it("says when nobody of that kind has a code, and skips revoked ones", async () => {
    const root = propertyFolder();
    writeFileSync(join(root, "door-grants.json"), JSON.stringify({ schemaVersion: 1, grants: [] }));
    const outcome = await sandboxEntry({ root, who: "cleaner", keypad: new FakeKeypad(), now: () => NOW });
    expect(outcome).toEqual({ exitCode: 1, lines: ["No code on this property's locks is the cleaner's right now."] });
  });

  it("never prints a line with four digits in a row", () => {
    expect(safeLine(`partner said ${CODE}`)).not.toContain(CODE);
    expect(safeLine("Entered at Nov 28, 11:30 AM EST.")).toBe("Entered at Nov 28, 11:30 AM EST.");
  });
});

describe("npm run locks:sandbox-entry", () => {
  function dataFolder(): string {
    const data = mkdtempSync(join(tmpdir(), "sandbox-entry-data-"));
    dirs.push(data);
    const property = { id: "prp_testtesttt", label: "Adelie Test", flows: { cleaning: { on: true }, supplies: { on: false }, fixer: { on: true } } };
    writeFileSync(join(data, "tenants.json"), JSON.stringify({ schemaVersion: 3, tenants: [{ id: "tnt_testtesttt", properties: [property], invites: [] }] }));
    const root = join(data, "tenants", "tnt_testtesttt", "properties", property.id);
    mkdirSync(root, { recursive: true });
    const source = propertyFolder();
    for (const name of ["door-locks.json", "door-grants.json", "visit-codes.json", "fixer.json", "hub.json"]) copyFileSync(join(source, name), join(root, name));
    return data;
  }

  it("finds the property by name and enters the visitor's code, printing no digits", async () => {
    const data = dataFolder();
    const lines: string[] = [];
    const keypad = new FakeKeypad();
    const code = await main(["--property", "adelie test", "--who", "visitor", "--data", data], {}, keypad, (line) => lines.push(line), () => NOW);
    expect(code).toBe(0);
    expect(keypad.entered).toEqual([{ deviceId: "d1", codeId: "ac-visit" }]);
    expect(lines).toEqual(["Entered the visitor's code (Test Visitor) on the Front door keypad at Nov 28, 11:30 AM EST."]);
    noDigits(lines);
  });

  it("needs the key, a known person and a property", async () => {
    const lines: string[] = [];
    expect(await main(["--property", "x", "--who", "cleaner"], {}, undefined, (line) => lines.push(line))).toBe(1);
    expect(await main(["--property", "x", "--who", "landlord"], {}, new FakeKeypad(), (line) => lines.push(line))).toBe(2);
    expect(await main(["--property", "nowhere", "--who", "cleaner", "--data", dataFolder()], {}, new FakeKeypad(), (line) => lines.push(line))).toBe(2);
    noDigits(lines);
  });
});
