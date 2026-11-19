import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cameraCounts, entryEventsFrom, type VisitEvent } from "../src/visits/events";
import { resetVisitLogCache, VISIT_EVENTS_DIR, VisitLog } from "../src/visits/store";

/** #237: the append-only visit log. Made-up property, 555 numbers and made-up codes only. */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  resetVisitLogCache();
});

function log(now = new Date("2027-01-04T15:00:00.000Z")) {
  const root = mkdtempSync(join(tmpdir(), "visit-log-"));
  roots.push(root);
  return { root, log: new VisitLog(root, () => now) };
}

const unlock = (id: string, at: string, codeName?: string): VisitEvent => ({ type: "lock", id, at, device: "Front door", action: "unlock", side: "outside", ...(codeName ? { codeName } : {}) });
const allText = (root: string) =>
  readdirSync(join(root, VISIT_EVENTS_DIR))
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => readFileSync(join(root, VISIT_EVENTS_DIR, name), "utf8"))
    .join("");

describe("the visit log", () => {
  it("appends each event once, by id, and never rewrites a line", () => {
    const { root, log: visits } = log();
    expect(visits.append(unlock("lk-1", "2027-01-04T16:00:00.000Z", "Cleaner"))).toBe(true);
    const before = allText(root);
    expect(visits.append(unlock("lk-1", "2027-01-04T16:00:00.000Z", "Cleaner"))).toBe(false);
    expect(visits.append(unlock("lk-2", "2027-01-04T18:00:00.000Z"))).toBe(true);
    const after = allText(root);
    expect(after.startsWith(before)).toBe(true);
    expect(visits.read().map((event) => event.id)).toEqual(["lk-1", "lk-2"]);
    // A new reader (a restart) sees the same lines and still refuses the duplicate.
    resetVisitLogCache();
    const again = new VisitLog(root);
    expect(again.read().map((event) => event.id)).toEqual(["lk-1", "lk-2"]);
    expect(again.append(unlock("lk-1", "2027-01-04T16:00:00.000Z"))).toBe(false);
  });

  it("writes one file per month, private to the service", () => {
    const { root, log: visits } = log(new Date("2027-01-31T23:00:00.000Z"));
    visits.append(unlock("lk-1", "2027-01-31T22:00:00.000Z"));
    const file = join(root, VISIT_EVENTS_DIR, "2027-01.jsonl");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const feb = new VisitLog(root, () => new Date("2027-02-01T09:00:00.000Z"));
    feb.append(unlock("lk-2", "2027-02-01T08:00:00.000Z"));
    expect(readdirSync(join(root, VISIT_EVENTS_DIR)).filter((n) => n.endsWith(".jsonl")).sort()).toEqual(["2027-01.jsonl", "2027-02.jsonl"]);
    expect(feb.read().map((event) => event.id)).toEqual(["lk-1", "lk-2"]);
  });

  it("skips and counts a line that won't parse, and never repairs it", () => {
    const { root, log: visits } = log();
    visits.append(unlock("lk-1", "2027-01-04T16:00:00.000Z"));
    appendFileSync(join(root, VISIT_EVENTS_DIR, "2027-01.jsonl"), "{not json\n");
    visits.append(unlock("lk-2", "2027-01-04T17:00:00.000Z"));
    expect(visits.read().map((event) => event.id)).toEqual(["lk-1", "lk-2"]);
    expect(visits.health()).toMatchObject({ lines: 2, skipped: 1, lastLockAt: "2027-01-04T17:00:00.000Z" });
    expect(allText(root)).toContain("{not json");
  });

  it("holds no digit run, no phone and no door code, and a door-code text has no body", () => {
    const { root, log: visits } = log();
    visits.append(
      { type: "message", id: "m-1", at: "2027-01-04T16:00:00.000Z", direction: "in", role: "cleaner", personKey: visits.personKey("+15555550101"), visit: "cleaning:j1", label: "other", body: "here, code 6 3 5 9 works, call 555-555-0101" },
    );
    visits.append({ type: "message", id: "m-2", at: "2027-01-04T16:01:00.000Z", direction: "out", role: "cleaner", visit: "cleaning:j1", label: "door-code", body: "The door code is 6359." });
    visits.append({ type: "message", id: "m-3", at: "2027-01-04T16:02:00.000Z", direction: "out", role: "host", label: "visit-note", body: "Code word is TULIP" }, (text) => text.replace(/TULIP/g, "[code]"));
    visits.append(unlock("lk-1", "2027-01-04T16:03:00.000Z", "Code 6359"));
    const text = allText(root);
    expect(text).not.toContain("6359");
    expect(text).not.toContain("6 3 5 9");
    expect(text).not.toContain("555-555-0101");
    expect(text).not.toContain("+1555");
    expect(text).not.toContain("TULIP");
    expect(text).not.toContain("door code is");
    const doorCode = visits.read().find((event) => event.id === "m-2");
    expect(doorCode).toMatchObject({ label: "door-code" });
    expect(doorCode).not.toHaveProperty("body");
  });

  it("keys a person by a salted hash that differs between properties", () => {
    const a = log().log;
    const b = log().log;
    expect(a.personKey("+15555550101")).toMatch(/^[a-f0-9]{16}$/);
    expect(a.personKey("+15555550101")).toBe(a.personKey("+15555550101"));
    expect(a.personKey("+15555550101")).not.toBe(b.personKey("+15555550101"));
  });

  it("keeps a camera event for the camera adapter (#239), with the provider's device id as given", () => {
    const { log: visits } = log();
    const camera = { type: "camera" as const, id: "ring-71920", at: "2027-01-04T16:00:00.000Z", kind: "motion" as const, deviceId: "589240117", provider: "ring" as const, device: "Front porch", label: "person" };
    expect(visits.append(camera)).toBe(true);
    expect(visits.append(camera)).toBe(false);
    expect(visits.append({ ...camera, id: "x1", kind: "wave" as "motion" })).toBe(false);
    expect(visits.append({ ...camera, id: "x2", provider: "nest" as "ring" })).toBe(false);
    expect(visits.append({ ...camera, id: "x3", deviceId: "../etc" })).toBe(false);
    expect(visits.append({ type: "camera", id: "ring-71921", at: "2027-01-04T17:00:00.000Z", kind: "offline", deviceId: "589240117", provider: "ring", device: "Front porch" })).toBe(true);
    expect(visits.read()).toEqual([
      { ...camera, loggedAt: "2027-01-04T15:00:00.000Z" },
      { type: "camera", id: "ring-71921", at: "2027-01-04T17:00:00.000Z", kind: "offline", deviceId: "589240117", provider: "ring", device: "Front porch", loggedAt: "2027-01-04T15:00:00.000Z" },
    ]);
  });

  it("keeps counts on their own lines, and the last one written for an event wins", () => {
    const { log: visits } = log();
    const count = (counter: string, people: number) => ({ type: "camera-count" as const, id: `count:ring-71920:${counter}`, at: "2027-01-04T16:00:00.000Z", event: "ring-71920", counter, people, vehicles: 0, animals: 0 });
    expect(visits.append({ ...count("vision-v1", 1), confidence: "low" })).toBe(true);
    expect(visits.append(count("vision-v2", 2))).toBe(true);
    expect(visits.append({ ...count("vision-v3", 1), people: -1 })).toBe(false);
    expect(visits.append({ ...count("Vision V3", 1), id: "count:x" })).toBe(false);
    expect(cameraCounts(visits.read()).get("ring-71920")).toMatchObject({ counter: "vision-v2", people: 2 });
  });

  it("keeps a pinned clip's span and its file under evidence, never a path outside it", () => {
    const { log: visits } = log();
    const pin = { type: "camera-pin" as const, id: "pin-1", at: "2027-01-04T18:00:00.000Z", event: "ring-71920", deviceId: "589240117", from: "2027-01-04T16:00:00.000Z", until: "2027-01-04T16:01:00.000Z", file: "camera/2027-01-04-front-porch.mp4" };
    expect(visits.append(pin)).toBe(true);
    for (const file of ["/etc/passwd", "../outside.mp4", "camera/../../x.mp4", "camera//x.mp4", "a\\b.mp4"]) expect(visits.append({ ...pin, id: `pin-${file}`, file })).toBe(false);
    expect(visits.append({ ...pin, id: "pin-back", until: "2027-01-04T15:00:00.000Z" })).toBe(false);
    expect(visits.read()).toEqual([{ ...pin, loggedAt: "2027-01-04T15:00:00.000Z" }]);
  });

  it("keeps a lock's status for the lock connection (#180), with no code digits", () => {
    const { log: visits } = log();
    expect(visits.append({ type: "lock-status", id: "st-1", at: "2027-01-04T16:00:00.000Z", kind: "battery", device: "Front door", battery: 18 })).toBe(true);
    expect(visits.append({ type: "lock-status", id: "st-2", at: "2027-01-04T16:05:00.000Z", kind: "code-failed", device: "Front door", codeName: "Cleaning 6359" })).toBe(true);
    expect(visits.append({ type: "lock-status", id: "st-3", at: "2027-01-04T16:06:00.000Z", kind: "jammed" as "battery", device: "Front door" })).toBe(false);
    expect(visits.append({ type: "lock-status", id: "st-4", at: "2027-01-04T16:07:00.000Z", kind: "battery", device: "Front door", battery: 140 })).toBe(false);
    expect(visits.read().map((event) => (event.type === "lock-status" ? [event.kind, event.codeName ?? event.battery] : []))).toEqual([
      ["battery", 18],
      ["code-failed", "Cleaning [redacted]"],
    ]);
  });

  it("is written whatever flag is on: each writer checks its own", () => {
    // The store has no flag of its own. Cleaner Core and Fixer Core check VISIT_RECORDS before they write; the lock
    // adapter checks #180's flag, and the camera adapter CAMERAS.
    const { log: visits } = log();
    expect(visits.append(unlock("lk-1", "2027-01-04T16:00:00.000Z"))).toBe(true);
  });

  it("refuses an event it can't check, and writes nothing", () => {
    const { log: visits } = log();
    expect(visits.append({ type: "lock", id: "x", at: "soon", device: "Front door", action: "unlock" })).toBe(false);
    expect(visits.append({ type: "lock", id: "x", at: "2027-01-04T16:00:00.000Z", device: "Front door", action: "open" as "unlock" })).toBe(false);
    expect(visits.append({ type: "visit-window", id: "w", at: "2027-01-04T16:00:00.000Z", visit: "cleaning:j1", kind: "cleaning", from: "2027-01-04T16:00:00.000Z", until: "2027-01-04T15:00:00.000Z", expectedAt: "2027-01-04T16:00:00.000Z", sameDay: false, who: { role: "cleaner", name: "Maria" } })).toBe(false);
    expect(visits.read()).toEqual([]);
  });

  it("saves whose a lock code is by the lock's name, without digits", () => {
    const { log: visits } = log();
    visits.nameCode("Cleaner", { role: "cleaner" });
    visits.nameCode("Ace 2291", { role: "pro", proId: "p-1" });
    expect(visits.codeNames()).toEqual({ Cleaner: { role: "cleaner" }, "Ace [redacted]": { role: "pro", proId: "p-1" } });
    visits.nameCode("cleaner", null);
    expect(visits.codeNames()).toEqual({ "Ace [redacted]": { role: "pro", proId: "p-1" } });
  });
});

describe("entry events for remote oversight", () => {
  it("gives #240 each unlock, named by the code's person", () => {
    const events: VisitEvent[] = [
      unlock("lk-2", "2027-01-04T18:00:00.000Z", "Ace"),
      unlock("lk-1", "2027-01-04T16:00:00.000Z", "Cleaner"),
      { type: "lock", id: "lk-3", at: "2027-01-04T19:00:00.000Z", device: "Front door", action: "lock", side: "outside" },
      unlock("lk-4", "2027-01-04T20:00:00.000Z"),
    ];
    const entries = entryEventsFrom(events, { cleaner: { role: "cleaner" }, ace: { role: "pro", proId: "p-1" } }, { cleaner: "Maria", pros: { "p-1": "Ace Plumbing" } });
    expect(entries).toEqual([
      { id: "lk-1", at: "2027-01-04T16:00:00.000Z", device: "Front door", person: "Maria" },
      { id: "lk-2", at: "2027-01-04T18:00:00.000Z", device: "Front door", person: "Ace Plumbing" },
      { id: "lk-4", at: "2027-01-04T20:00:00.000Z", device: "Front door" },
    ]);
  });
});
