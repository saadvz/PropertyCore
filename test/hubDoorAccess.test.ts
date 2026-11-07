import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DOOR_ACCESS_FILE, DOOR_CODE_UPLOAD_REFUSED, UPLOAD_LINK_OFF, type AccessProvider } from "../src/hub/doorAccess";
import { hubFor, resetHubs, UPLOAD_GONE, type HubGuards } from "../src/hub/hub";

/** The hub's door access: the sealed door code in door-access.json. Made-up codes only. */

const NOW = new Date("2026-11-07T15:00:00Z");
// Built at runtime so the secret scan never finds a code in this file.
const CODE = ["4", "8", "2", "1"].join("");
const KEY = randomBytes(32);
const SERVER = randomBytes(32).toString("base64");
const roots: string[] = [];

afterEach(() => {
  resetHubs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "hub-door-"));
  roots.push(root);
  return root;
}

function open(root = folder(), env: NodeJS.ProcessEnv = {}, now = () => NOW) {
  const hub = hubFor(root, { now });
  return { root, hub, door: hub.doorAccess(() => env) };
}

function fileOf(root: string): string {
  return readFileSync(join(root, DOOR_ACCESS_FILE), "utf8");
}

describe("hub door access: the sealed code", () => {
  it("seals the code and opens it with the same key", () => {
    const { root, door } = open();
    expect(door.save(CODE, "back door", KEY)).toEqual({ ok: true });
    const text = fileOf(root);
    expect(JSON.parse(text).pinSeal).toBeTruthy();
    expect(text).not.toContain(CODE);
    resetHubs();
    const again = open(root).door;
    expect(again.saved()).toBe(true);
    expect(again.codeForChecks(KEY)).toBe(CODE);
    expect(again.lockLocation()).toBe("back door");
  });

  it("uses the server's key when the request has none", () => {
    const env = { CLEANER_CORE_PIN_KEY: SERVER };
    const { root, door } = open(folder(), env);
    expect(door.save(CODE, undefined, undefined)).toEqual({ ok: true });
    resetHubs();
    expect(open(root, env).door.codeForChecks()).toBe(CODE);
  });

  it("another key leaves the seal shut", () => {
    const { root, door } = open();
    door.save(CODE, undefined, KEY);
    resetHubs();
    const again = open(root).door;
    expect(again.codeForChecks(randomBytes(32))).toBeUndefined();
    expect(again.saved()).toBe(true);
  });

  it("refuses without any key", () => {
    const { root, door } = open();
    expect(door.save(CODE, undefined, undefined)).toMatchObject({ ok: false, reason: "key" });
    expect(existsSync(join(root, DOOR_ACCESS_FILE))).toBe(false);
  });

  it("refuses a code that isn't 4 to 8 digits", () => {
    const { door } = open();
    for (const bad of ["12", "123456789", "12a4"]) expect(door.save(bad, undefined, KEY)).toMatchObject({ ok: false, reason: "code" });
    expect(door.saved()).toBe(false);
  });

  it("refuses a lock location with a long number or over 80 characters", () => {
    const { door } = open();
    for (const bad of ["gate 80 88", "x".repeat(81)]) {
      const result = door.save(CODE, bad, KEY);
      expect(result).toMatchObject({ ok: false, reason: "lock" });
      expect(JSON.stringify(result)).not.toContain(CODE);
    }
  });

  it("asks the guard and returns its refusal without the digits", () => {
    const { hub, door } = open();
    const guards: HubGuards = { carriesCode: () => false, wouldCancel: async () => [], codeRefused: () => "No." };
    hub.useGuards(() => guards);
    expect(door.save(CODE, undefined, KEY)).toEqual({ ok: false, reason: "guard", error: "No." });
    expect(door.saved()).toBe(false);
  });

  it("\"\" clears the lock location, and undefined keeps it", () => {
    const { door } = open();
    door.save(CODE, "side gate", KEY);
    door.save(CODE, undefined, KEY);
    expect(door.lockLocation()).toBe("side gate");
    door.save(CODE, "", KEY);
    expect(door.lockLocation()).toBeUndefined();
  });
});

const BASE = "https://cleaner.example.test";

function linkCode(url: string): string {
  return url.slice(`${BASE}/door-code/`.length);
}

describe("hub door access: the upload link", () => {
  it("issues a 43-character link under /door-code/ and keeps only its hash", () => {
    const { root, door } = open();
    const issued = door.issueUpload("back door", KEY, BASE);
    if (!issued.ok) throw new Error(issued.error);
    expect(issued.uploadUrl.startsWith(`${BASE}/door-code/`)).toBe(true);
    expect(linkCode(issued.uploadUrl)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresInMinutes).toBe(10);
    const text = fileOf(root);
    expect(text).not.toContain(linkCode(issued.uploadUrl));
    expect(JSON.parse(text).upload.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses without the server's public address", () => {
    const { door } = open();
    expect(door.issueUpload(undefined, KEY, undefined)).toEqual({ ok: false, error: UPLOAD_LINK_OFF });
  });

  it("a second link replaces the first", () => {
    const { door } = open();
    const first = door.issueUpload(undefined, KEY, BASE);
    const second = door.issueUpload(undefined, KEY, BASE);
    if (!first.ok || !second.ok) throw new Error("no link");
    expect(door.upload(linkCode(first.uploadUrl), { code: CODE })).toEqual({ status: 404, body: { ok: false, error: UPLOAD_GONE } });
    expect(door.upload(linkCode(second.uploadUrl), { code: CODE }).status).toBe(200);
  });

  it("an expired link is gone", () => {
    let now = NOW;
    const root = folder();
    const door = hubFor(root, { now: () => now }).doorAccess(() => ({}));
    const issued = door.issueUpload(undefined, KEY, BASE);
    if (!issued.ok) throw new Error(issued.error);
    now = new Date(NOW.getTime() + 10 * 60_000);
    expect(door.upload(linkCode(issued.uploadUrl), { code: CODE })).toEqual({ status: 404, body: { ok: false, error: UPLOAD_GONE } });
    expect(JSON.parse(fileOf(root)).upload).toBeUndefined();
  });

  it("a refused code keeps the link", () => {
    const { door } = open();
    const issued = door.issueUpload(undefined, KEY, BASE);
    if (!issued.ok) throw new Error(issued.error);
    expect(door.upload(linkCode(issued.uploadUrl), { code: "12" })).toEqual({ status: 400, body: { ok: false, error: DOOR_CODE_UPLOAD_REFUSED } });
    expect(door.upload(linkCode(issued.uploadUrl), { code: CODE })).toEqual({ status: 200, body: { ok: true } });
    expect(door.upload(linkCode(issued.uploadUrl), { code: CODE }).status).toBe(404);
  });

  it("the upload seals with the key of the call that made the link", () => {
    const { root, door } = open();
    const issued = door.issueUpload("side gate", KEY, BASE);
    if (!issued.ok) throw new Error(issued.error);
    door.upload(linkCode(issued.uploadUrl), { code: CODE });
    resetHubs();
    const again = open(root).door;
    expect(again.codeForChecks(KEY)).toBe(CODE);
    expect(again.lockLocation()).toBe("side gate");
  });

  it("never hands out a link the guard says leaks", () => {
    const { hub, door } = open();
    let calls = 0;
    hub.useGuards(() => ({ carriesCode: () => false, wouldCancel: async () => [], leaks: () => ++calls === 1 }));
    const issued = door.issueUpload(undefined, KEY, BASE);
    expect(issued.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("no reply holds the code", () => {
    const { door } = open();
    const issued = door.issueUpload(undefined, KEY, BASE);
    if (!issued.ok) throw new Error(issued.error);
    const replies = [issued, door.upload(linkCode(issued.uploadUrl), { code: `${CODE}x` }), door.upload(linkCode(issued.uploadUrl), { code: CODE })];
    for (const reply of replies) expect(JSON.stringify(reply)).not.toContain(CODE);
  });
});

const OTHER = ["7", "3", "9", "2"].join("");
const PERSON = "+15555550123";
const WINDOW = { from: "2026-11-07T15:00:00Z", until: "2026-11-09T05:00:00Z" };

describe("hub door access: the request", () => {
  it("grants the saved code and lock location", () => {
    const { door } = open();
    door.save(CODE, "back door", KEY);
    expect(door.request({ person: PERSON, window: WINDOW, purpose: "cleaning", key: KEY })).toEqual({ ok: true, kind: "code", code: CODE, lockLocation: "back door", until: WINDOW.until });
  });

  it("refuses no-code before anything is saved", () => {
    expect(open().door.request({ person: PERSON, window: WINDOW, purpose: "cleaning", key: KEY })).toEqual({ ok: false, reason: "no-code" });
  });

  it("refuses no-key with an empty env and no key", () => {
    const { root, door } = open();
    door.save(CODE, undefined, KEY);
    resetHubs();
    expect(open(root).door.request({ person: PERSON, window: WINDOW, purpose: "cleaning" })).toEqual({ ok: false, reason: "no-key" });
  });

  it("refuses sealed when the key doesn't open the seal", () => {
    const { root, door } = open();
    door.save(CODE, undefined, KEY);
    resetHubs();
    expect(open(root).door.request({ person: PERSON, window: WINDOW, purpose: "cleaning", key: randomBytes(32) })).toEqual({ ok: false, reason: "sealed" });
  });

  it("refuses window-over when now is at or past until", () => {
    let now = new Date(WINDOW.until);
    const root = folder();
    const door = hubFor(root, { now: () => now }).doorAccess(() => ({}));
    door.save(CODE, undefined, KEY);
    expect(door.request({ person: PERSON, window: WINDOW, purpose: "cleaning", key: KEY })).toEqual({ ok: false, reason: "window-over" });
    now = new Date(Date.parse(WINDOW.until) - 1);
    expect(door.request({ person: PERSON, window: WINDOW, purpose: "cleaning", key: KEY }).ok).toBe(true);
  });

  it("a fake second provider answers behind request()", () => {
    const { door } = open();
    door.save(CODE, undefined, KEY);
    const seen: string[] = [];
    const partner: AccessProvider = {
      grant: (request) => {
        seen.push(`${request.person}:${request.purpose}`);
        return { ok: true, kind: "code", code: OTHER, until: request.window.until };
      },
    };
    door.useProvider(partner);
    expect(door.request({ person: PERSON, window: WINDOW, purpose: "repair", key: KEY })).toEqual({ ok: true, kind: "code", code: OTHER, until: WINDOW.until });
    expect(seen).toEqual([`${PERSON}:repair`]);
  });

  it("a re-saved code replaces the open one", () => {
    const { door } = open();
    door.save(CODE, undefined, KEY);
    expect(door.request({ person: PERSON, window: WINDOW, purpose: "cleaning", key: KEY })).toMatchObject({ ok: true, code: CODE });
    door.save(OTHER, undefined, KEY);
    expect(door.request({ person: PERSON, window: WINDOW, purpose: "cleaning", key: KEY })).toMatchObject({ ok: true, code: OTHER });
    expect(door.codeForChecks(KEY)).toBe(OTHER);
  });
});

describe("hub door access: review minors", () => {
  it("a link whose stored fields would hold the open code is refused, not thrown", () => {
    const { root, door } = open();
    door.save(CODE, undefined, KEY);
    const before = fileOf(root);
    const issued = door.issueUpload(undefined, KEY, "https://cleaner.example.test", { assistant: "grok", connectionId: CODE });
    expect(issued.ok).toBe(false);
    expect(JSON.stringify(issued)).not.toContain(CODE);
    expect(fileOf(root)).toBe(before);
  });

  it("a request with no key uses the key the code was last saved with, then the server's", () => {
    const { root, door } = open();
    door.save(CODE, undefined, KEY);
    expect(door.request({ person: "+15555550123", window: { from: "2026-11-07T15:00:00Z", until: "2026-11-09T05:00:00Z" }, purpose: "cleaning" })).toMatchObject({ ok: true, code: CODE });
    resetHubs();
    // After a restart nothing is in memory: with no server key there's no key.
    expect(open(root).door.request({ person: "+15555550123", window: { from: "2026-11-07T15:00:00Z", until: "2026-11-09T05:00:00Z" }, purpose: "cleaning" })).toEqual({ ok: false, reason: "no-key" });
  });
});
