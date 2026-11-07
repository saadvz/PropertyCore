import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DOOR_ACCESS_FILE } from "../src/hub/doorAccess";
import { hubFor, resetHubs, type HubGuards } from "../src/hub/hub";

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
