import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activitySentence, doorActivity } from "../src/visits/activity";
import { visitDeskFor } from "../src/visits/desk";
import type { CodeNames, VisitEvent } from "../src/visits/events";
import { resetVisitLogCache, VisitLog } from "../src/visits/store";
import { VISIT_TOOLS } from "../src/visits/tools";

/**
 * Who came in (#280 item 20): every unlock and lock at the property's doors, with whose code it was or how the door
 * was opened without one. Read-only, made-up property, no digits or phones in any reply.
 */

const NY = "America/New_York";
const NOW = new Date("2026-11-22T15:00:00.000Z");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  resetVisitLogCache();
});

const unlock = (id: string, at: string, extra: Partial<Extract<VisitEvent, { type: "lock" }>> = {}): VisitEvent => ({ type: "lock", id, at, device: "Front door", action: "unlock", ...extra });
const CODES: CodeNames = { "Cleaning abcdefgh": { role: "cleaner" }, "Standing hjkmnpqr": { role: "host" }, "Guest stuvwxyz": { role: "guest" } };
const DAY = { from: Date.parse("2026-11-22T05:00:00.000Z"), until: Date.parse("2026-11-23T05:00:00.000Z") };

describe("door activity", () => {
  it("says an unlock without a code, and how", () => {
    const [entry] = doorActivity([unlock("e1", "2026-11-22T06:13:00.000Z", { method: "remote" })], {}, {}, DAY);
    expect(entry).toMatchObject({ door: "Front door", action: "unlock", withCode: false, how: "from the app" });
    expect(activitySentence(entry!, NY)).toBe("The Front door was unlocked at 1:13 AM, without a code (from the app).");
  });

  it("names how the door was opened for each of the partner's ways", () => {
    const how = (method: string) => doorActivity([unlock("e", "2026-11-22T14:00:00.000Z", { method })], {}, {}, DAY)[0]!.how;
    expect(how("mobile_key")).toBe("from the app");
    expect(how("manual")).toBe("by hand or with a key");
    expect(how("automatic")).toBe("on its own");
    expect(how("card")).toBe("with a card");
    expect(how("unknown")).toBeUndefined();
    expect(activitySentence(doorActivity([unlock("e", "2026-11-22T14:00:00.000Z", { method: "unknown" })], {}, {}, DAY)[0]!, NY)).toBe("The Front door was unlocked at 9 AM, without a code.");
  });

  it("names whose code it was", () => {
    const events = [
      unlock("a", "2026-11-22T14:02:00.000Z", { method: "keycode", side: "outside", codeName: "Cleaning abcdefgh" }),
      unlock("b", "2026-11-22T15:00:00.000Z", { method: "keycode", codeName: "Standing hjkmnpqr" }),
      unlock("c", "2026-11-22T16:00:00.000Z", { method: "keycode", codeName: "Guest stuvwxyz" }),
    ];
    const sentences = doorActivity(events, CODES, { cleaner: "Maria" }, DAY).map((entry) => activitySentence(entry, NY));
    expect(sentences).toEqual([
      "The Front door was unlocked at 9:02 AM with Maria's code.",
      "The Front door was unlocked at 10 AM with your own code.",
      "The Front door was unlocked at 11 AM with the guest's code.",
    ]);
  });

  it("a keypad code Property Core didn't make", () => {
    const [entry] = doorActivity([unlock("e1", "2026-11-22T14:00:00.000Z", { method: "keycode", codeName: "Bob" })], CODES, {}, DAY);
    expect(entry!.withCode).toBe("unknown-code");
    expect(activitySentence(entry!, NY)).toBe("The Front door was unlocked at 9 AM with a code that isn't one of Property Core's.");
  });

  it("lists locks too, oldest first, only inside the days asked", () => {
    const events: VisitEvent[] = [
      { type: "lock", id: "l2", at: "2026-11-22T14:30:00.000Z", device: "Front door", action: "lock", side: "outside" },
      unlock("u1", "2026-11-22T14:00:00.000Z", { method: "manual" }),
      unlock("old", "2026-11-21T14:00:00.000Z", { method: "manual" }),
      { type: "lock-status", id: "s1", at: "2026-11-22T14:10:00.000Z", kind: "battery", device: "Front door" },
    ];
    const entries = doorActivity(events, {}, {}, DAY);
    expect(entries.map((entry) => entry.at)).toEqual(["2026-11-22T14:00:00.000Z", "2026-11-22T14:30:00.000Z"]);
    expect(activitySentence(entries[1]!, NY)).toBe("The Front door was locked at 9:30 AM.");
  });
});

function property() {
  const root = mkdtempSync(join(tmpdir(), "door-activity-"));
  roots.push(root);
  writeFileSync(join(root, "hub.json"), JSON.stringify({ schemaVersion: 1, property: { nickname: "Lake House", timeZone: NY }, calendars: [], stays: [] }));
  const log = new VisitLog(root, () => NOW);
  return { root, log, desk: visitDeskFor(root, { now: () => NOW }) };
}

describe("the door_activity tool", () => {
  it("lists today by default, in the property's time zone, and sends nothing", () => {
    const { desk, log } = property();
    log.append(unlock("e1", "2026-11-22T06:13:00.000Z", { method: "remote" }));
    log.append(unlock("e0", "2026-11-21T20:00:00.000Z", { method: "remote" }));
    const reply = desk.doorActivity({});
    expect(reply.isError).toBe(false);
    expect(reply.structured).toMatchObject({ sends: false, sentences: ["The Front door was unlocked at 1:13 AM, without a code (from the app)."] });
    expect(String(reply.structured?.next)).toContain("1:13 AM");
  });

  it("says plainly when nobody came in", () => {
    const { desk } = property();
    expect(desk.doorActivity({}).structured).toMatchObject({ entries: [], next: "No door at the property was unlocked or locked between 22 Nov and 22 Nov." });
  });

  it("reads at most 7 days", () => {
    const { desk } = property();
    expect(desk.doorActivity({ from: "2026-11-01", to: "2026-11-22" }).isError).toBe(true);
    expect(desk.doorActivity({ from: "2026-11-16", to: "2026-11-22" }).isError).toBe(false);
  });

  it("holds no phone and no code digits", () => {
    const { desk, log } = property();
    log.append(unlock("e1", "2026-11-22T14:00:00.000Z", { method: "keycode", codeName: "Cleaning abcdefgh" }));
    const text = desk.doorActivity({}).text;
    expect(/\d{4,}/.test(text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "").replace(/\d{4}-\d{2}-\d{2}/g, ""))).toBe(false);
  });

  it("is listed as a read-only tool, and visit_health points to it", () => {
    const tool = VISIT_TOOLS.find((item) => item.name === "door_activity");
    expect(tool).toBeDefined();
    expect(String(tool!.description)).toContain("Read-only");
    expect(String(VISIT_TOOLS.find((item) => item.name === "visit_health")!.description)).toContain("door_activity");
    const { desk } = property();
    expect(String(desk.health().structured?.next)).toContain("door_activity");
  });
});
