import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dayEvidence, entryNamesFrom, standingNames } from "../src/oversight/evidence";
import type { CodeNames, VisitEvent } from "../src/visits/events";

/** #240: the same-day check's evidence from the visit log. Made-up lines, made-up code names, no real lock or camera. */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const unlock = (id: string, at: string, codeName?: string): VisitEvent => ({ type: "lock", id, at, device: "Front door", action: "unlock", side: "outside", ...(codeName ? { codeName } : {}) });
const status = (id: string, at: string, kind: "offline" | "online", device = "Front door"): VisitEvent => ({ type: "lock-status", id, at, kind, device });
const connection = (id: string, at: string, connected: boolean): VisitEvent => ({ type: "lock-connection", id, at, connected });
const camera = (id: string, at: string, kind: "motion" | "ding" | "offline", label?: string): VisitEvent => ({ type: "camera", id, at, kind, deviceId: "cam-1", provider: "ring", device: "Front porch", ...(label ? { label } : {}) });
const count = (event: string, at: string, people: number, counter = "vision-v1"): VisitEvent => ({ type: "camera-count", id: `count:${event}:${counter}`, at, event, counter, people, vehicles: 0, animals: 0 });

const CODES: CodeNames = { "Cleaning aaaa": { role: "cleaner" }, "Standing bbbb": { role: "shared" }, "Guest cccc": { role: "guest" } };
const ON = { codeNames: CODES, names: {}, locks: true, cameras: true };

describe("dayEvidence", () => {
  it("maps unlocks to entries by role", () => {
    const events = [unlock("u-1", "2026-11-19T18:00:00.000Z", "Standing bbbb"), unlock("u-2", "2026-11-19T19:00:00.000Z", "Guest cccc"), unlock("u-3", "2026-11-19T20:00:00.000Z")];
    const evidence = dayEvidence(events, { ...ON, names: { codes: { "standing bbbb": "Mike Doyle" } } });
    expect(evidence.lock).toBe(true);
    expect(evidence.entries.map((e) => [e.id, e.person ?? e.party ?? "unnamed"])).toEqual([
      ["u-1", "Mike Doyle"],
      ["u-2", "guest"],
      ["u-3", "unnamed"],
    ]);
  });

  it("gives no lock evidence on a property not on connected locks", () => {
    const events = [unlock("u-1", "2026-11-19T18:00:00.000Z", "Cleaning aaaa"), status("s-1", "2026-11-19T17:00:00.000Z", "offline")];
    const evidence = dayEvidence(events, { ...ON, locks: false });
    expect(evidence).toMatchObject({ lock: false, entries: [], quiet: [] });
  });

  it("opens a quiet span at offline and closes it at the same device's online", () => {
    const events = [
      status("s-1", "2026-11-19T17:00:00.000Z", "offline"),
      status("s-2", "2026-11-19T17:30:00.000Z", "online", "Back door"),
      status("s-3", "2026-11-19T18:00:00.000Z", "online"),
      status("s-4", "2026-11-19T21:00:00.000Z", "offline", "Back door"),
    ];
    expect(dayEvidence(events, ON).quiet).toEqual([
      { from: "2026-11-19T17:00:00.000Z", until: "2026-11-19T18:00:00.000Z", device: "Front door", why: "offline" },
      { from: "2026-11-19T21:00:00.000Z", device: "Back door", why: "offline" },
    ]);
  });

  it("a second offline before online keeps the first span's start", () => {
    const events = [status("s-1", "2026-11-19T17:00:00.000Z", "offline"), status("s-2", "2026-11-19T17:20:00.000Z", "offline"), status("s-3", "2026-11-19T18:00:00.000Z", "online")];
    expect(dayEvidence(events, ON).quiet).toEqual([{ from: "2026-11-19T17:00:00.000Z", until: "2026-11-19T18:00:00.000Z", device: "Front door", why: "offline" }]);
  });

  it("a disconnected lock account is a quiet span for every door until it's connected again", () => {
    const events = [connection("c-0", "2026-11-01T12:00:00.000Z", true), connection("c-1", "2026-11-19T16:00:00.000Z", false), connection("c-2", "2026-11-19T19:00:00.000Z", true), connection("c-3", "2026-11-19T22:00:00.000Z", false)];
    expect(dayEvidence(events, ON).quiet).toEqual([
      { from: "2026-11-19T16:00:00.000Z", until: "2026-11-19T19:00:00.000Z", why: "disconnected" },
      { from: "2026-11-19T22:00:00.000Z", why: "disconnected" },
    ]);
  });

  it("reads lines in time order, whatever order they were written", () => {
    const events = [status("s-2", "2026-11-19T18:00:00.000Z", "online"), status("s-1", "2026-11-19T17:00:00.000Z", "offline")];
    expect(dayEvidence(events, ON).quiet).toEqual([{ from: "2026-11-19T17:00:00.000Z", until: "2026-11-19T18:00:00.000Z", device: "Front door", why: "offline" }]);
  });

  it("only the property's doors open quiet spans: a thermostat going offline is not a lock (review)", () => {
    const events = [status("s-1", "2026-11-19T17:00:00.000Z", "offline", "Hall thermostat"), status("s-2", "2026-11-19T17:10:00.000Z", "offline")];
    expect(dayEvidence(events, { ...ON, doors: ["Front door"] }).quiet).toEqual([{ from: "2026-11-19T17:10:00.000Z", device: "Front door", why: "offline" }]);
  });

  it("a door's lock or unlock line ends its quiet span: it reported (review)", () => {
    const events = [status("s-1", "2026-11-05T17:40:00.000Z", "offline"), unlock("u-1", "2026-11-06T15:00:00.000Z")];
    expect(dayEvidence(events, ON).quiet).toEqual([{ from: "2026-11-05T17:40:00.000Z", until: "2026-11-06T15:00:00.000Z", device: "Front door", why: "offline" }]);
  });

  it("the host's own switch lines are on-periods, not quiet spans; the lock partner's disconnect stays quiet (review)", () => {
    const events = [
      { type: "lock-connection" as const, id: "pc-locks:on:2026-11-19T19:00:00.000Z", at: "2026-11-19T19:00:00.000Z", connected: true },
      { type: "lock-connection" as const, id: "pc-locks:off:2026-11-21T19:00:00.000Z", at: "2026-11-21T19:00:00.000Z", connected: false },
      { type: "lock-connection" as const, id: "pc-locks:on:2026-11-23T19:00:00.000Z", at: "2026-11-23T19:00:00.000Z", connected: true },
      connection("seam-1", "2026-11-20T12:00:00.000Z", false),
      connection("seam-2", "2026-11-20T13:00:00.000Z", true),
    ];
    const evidence = dayEvidence(events, ON);
    expect(evidence.switched).toEqual([{ from: "2026-11-19T19:00:00.000Z", until: "2026-11-21T19:00:00.000Z" }, { from: "2026-11-23T19:00:00.000Z" }]);
    expect(evidence.quiet).toEqual([{ from: "2026-11-20T12:00:00.000Z", until: "2026-11-20T13:00:00.000Z", why: "disconnected" }]);
  });

  it("no switch lines: no on-periods, so the property's current state stands", () => {
    expect(dayEvidence([], ON).switched).toBeUndefined();
  });

  it("a person seen is our count when there is one, else Ring's human label, or a doorbell press", () => {
    const events = [
      camera("m-1", "2026-11-19T18:00:00.000Z", "motion", "human"),
      count("m-1", "2026-11-19T18:00:00.000Z", 0),
      camera("m-2", "2026-11-19T18:10:00.000Z", "motion", "other_motion"),
      count("m-2", "2026-11-19T18:10:00.000Z", 2),
      camera("m-3", "2026-11-19T18:20:00.000Z", "motion", "Human"),
      camera("m-4", "2026-11-19T18:30:00.000Z", "motion", "vehicle"),
      camera("d-1", "2026-11-19T18:40:00.000Z", "ding"),
      camera("o-1", "2026-11-19T18:50:00.000Z", "offline"),
    ];
    expect(dayEvidence(events, ON).sightings).toEqual([
      { at: "2026-11-19T18:10:00.000Z", device: "Front porch" },
      { at: "2026-11-19T18:20:00.000Z", device: "Front porch" },
      { at: "2026-11-19T18:40:00.000Z", device: "Front porch" },
    ]);
  });

  it("the last count line written for an event wins", () => {
    const events = [camera("m-1", "2026-11-19T18:00:00.000Z", "motion", "human"), count("m-1", "2026-11-19T18:00:00.000Z", 1), count("m-1", "2026-11-19T18:00:00.000Z", 0, "vision-v2")];
    expect(dayEvidence(events, ON).sightings).toEqual([]);
  });

  it("reads no camera lines with cameras off", () => {
    const events = [camera("d-1", "2026-11-19T18:40:00.000Z", "ding")];
    expect(dayEvidence(events, { ...ON, cameras: false }).sightings).toEqual([]);
  });
});

describe("names for entries", () => {
  it("takes the cleaner's and each pro's name from their latest window line", () => {
    const window = (id: string, at: string, who: { role: "cleaner" | "pro"; name: string; proId?: string }): VisitEvent => ({
      type: "visit-window",
      id,
      at,
      visit: `x:${id}`,
      kind: who.role === "cleaner" ? "cleaning" : "repair",
      from: "2026-11-19T15:00:00.000Z",
      until: "2026-11-19T20:00:00.000Z",
      expectedAt: "2026-11-19T15:00:00.000Z",
      sameDay: false,
      who,
    });
    const events = [
      window("w-2", "2026-11-18T10:00:00.000Z", { role: "cleaner", name: "Maria" }),
      window("w-1", "2026-11-10T10:00:00.000Z", { role: "cleaner", name: "Rosa" }),
      window("w-3", "2026-11-18T11:00:00.000Z", { role: "pro", name: "Ace Plumbing", proId: "p-1" }),
    ];
    expect(entryNamesFrom(events, { "standing bbbb": "Mike Doyle" })).toEqual({ cleaner: "Maria", pros: { "p-1": "Ace Plumbing" }, codes: { "standing bbbb": "Mike Doyle" } });
  });

  it("reads standing code names from door-grants.json, never anything else of a grant", () => {
    const root = mkdtempSync(join(tmpdir(), "oversight-evidence-"));
    roots.push(root);
    const grant = (flow: string, codeName: string, label?: string) => ({ id: "x", flow, jobId: "std_x", person: "+15555550123", ...(label ? { label } : {}), codeName, window: {}, devices: [], seal: { iv: "a", tag: "b", data: "c" } });
    writeFileSync(
      join(root, "door-grants.json"),
      JSON.stringify({ schemaVersion: 1, grants: [grant("standing", "Standing bbbb", "Mike Doyle"), grant("cleaning", "Cleaning aaaa", "Maria"), grant("standing", "Standing dddd", "Unit 5555 key"), grant("standing", "Standing eeee")] }),
    );
    expect(standingNames(root)).toEqual({ "standing bbbb": "Mike Doyle" });
  });

  it("an unreadable or missing door-grants.json is no names", () => {
    const root = mkdtempSync(join(tmpdir(), "oversight-evidence-"));
    roots.push(root);
    expect(standingNames(root)).toEqual({});
    writeFileSync(join(root, "door-grants.json"), "{nope");
    expect(standingNames(root)).toEqual({});
  });
});
