import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LockWebhookEvent } from "../src/locks/adapter";
import { LOCK_ECHO_MS, lockLines, recordLockEvent } from "../src/locks/eventLog";
import { resetVisitLogCache } from "../src/visits/store";

/**
 * A second report of one turn of the lock (#303, 25 Nov live run): the lock partner sends a lock done from its console
 * as two `lock.locked` events with different ids, a fraction of a second apart. The visit log keeps one line. Made-up
 * ids and names; nothing here reaches the lock partner.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetVisitLogCache();
});

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "lock-echoes-"));
  dirs.push(root);
  return root;
}

const T = Date.parse("2026-11-25T23:46:12.000Z");
const at = (ms: number) => new Date(T + ms).toISOString();
const now = () => new Date(T + 60_000);
const event = (id: string, kind: "lock" | "unlock", ms: number, extra: Partial<LockWebhookEvent> = {}): LockWebhookEvent => ({ id, kind, partnerType: `lock.${kind}ed`, at: at(ms), deviceId: "d1", ...extra });
const record = (root: string, e: LockWebhookEvent, deviceName = "FRONT DOOR") => recordLockEvent(root, e, { deviceName, now });
const kept = (root: string) => lockLines(root, new Date(T - 3_600_000)).map((line) => `${line.action}@${Date.parse(line.at) - T}`);

describe("a second report of the same lock or unlock", () => {
  it("keeps one line for a console lock sent twice under two ids, in either order", () => {
    const root = folder();
    expect(record(root, event("ev-a", "lock", 0))).toBe("new");
    expect(record(root, event("ev-b", "lock", 400, { method: "remote" }))).toBe("echo");
    expect(kept(root)).toEqual(["lock@0"]);
    const late = folder();
    expect(record(late, event("ev-b", "lock", 400))).toBe("new");
    expect(record(late, event("ev-a", "lock", 0))).toBe("echo");
    expect(kept(late)).toEqual(["lock@400"]);
  });

  it("still says a resent event is a duplicate, by its id", () => {
    const root = folder();
    record(root, event("ev-a", "lock", 0));
    expect(record(root, event("ev-a", "lock", 0))).toBe("duplicate");
  });

  it("keeps both when they're further apart than the echo window", () => {
    const root = folder();
    record(root, event("ev-a", "lock", 0));
    expect(record(root, event("ev-b", "lock", LOCK_ECHO_MS + 1))).toBe("new");
    expect(kept(root)).toHaveLength(2);
  });

  it("keeps both when the door did something else between them", () => {
    const root = folder();
    record(root, event("ev-a", "lock", 0));
    record(root, event("ev-u", "unlock", 200, { method: "keycode", side: "outside", codeName: "Standing abc" }));
    expect(record(root, event("ev-b", "lock", 400))).toBe("new");
    expect(kept(root)).toEqual(["lock@0", "unlock@200", "lock@400"]);
  });

  it("keeps a lock and an unlock apart, and two doors apart", () => {
    const root = folder();
    record(root, event("ev-a", "lock", 0));
    expect(record(root, event("ev-u", "unlock", 300))).toBe("new");
    expect(record(root, event("ev-b", "lock", 0, { deviceId: "d2" }), "BACK DOOR")).toBe("new");
    expect(kept(root)).toHaveLength(3);
  });

  it("folds an unlock only with the same code the same way, so a second person's entry is never lost", () => {
    const root = folder();
    record(root, event("ev-1", "unlock", 0, { method: "keycode", side: "outside", codeName: "Cleaning abc" }));
    expect(record(root, event("ev-2", "unlock", 400, { method: "keycode", side: "outside", codeName: "Cleaning abc" }))).toBe("echo");
    expect(record(root, event("ev-3", "unlock", 500, { method: "keycode", side: "outside", codeName: "Repair def" }))).toBe("new");
    expect(record(root, event("ev-4", "unlock", 600, { method: "remote" }))).toBe("new");
    expect(kept(root)).toEqual(["unlock@0", "unlock@500", "unlock@600"]);
  });
});
