import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FixerFile } from "../src/fixer-core/store";
import { cleanerRows, fixerRows, readRecords, type PropertyRecords } from "../src/hours-log/sources";
import { buildVisits, type VisitRecord } from "../src/visits/derive";
import type { VisitEvent } from "../src/visits/events";
import { resetVisitLogCache, VisitLog } from "../src/visits/store";

/** #237 into the hours log (#238): measured visit times replace scheduled ones only when a record has both ends. Made-up data. */

const NY = "America/New_York";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  resetVisitLogCache();
});

const connected: VisitEvent = { type: "lock-connection", id: "conn", at: "2026-12-01T00:00:00.000Z", connected: true };
const window = (visit: string, kind: "cleaning" | "repair", from: string, until: string, who: VisitRecord["who"]): VisitEvent => ({ type: "visit-window", id: `w-${visit}`, at: from, visit, kind, from, until, expectedAt: from, sameDay: false, who });
const unlock = (id: string, at: string, codeName: string): VisitEvent => ({ type: "lock", id, at, device: "Front door", action: "unlock", side: "outside", codeName });
const lockOut = (id: string, at: string): VisitEvent => ({ type: "lock", id, at, device: "Front door", action: "lock", side: "outside" });

const visitsFrom = (events: VisitEvent[]) =>
  buildVisits(events, { timeZone: NY, codeNames: { Cleaner: { role: "cleaner" }, Joe: { role: "pro", proId: "p1" } }, now: new Date("2027-01-10T00:00:00.000Z") }).visits;

const base = (extra: Partial<PropertyRecords> = {}): PropertyRecords => ({
  stays: [],
  cleanerName: "Maria Lopez",
  cleaningJobs: [{ id: "j1", checkoutDate: "2027-01-04", done: true, startedAt: "2027-01-04T16:30:00.000Z", doneAt: "2027-01-04T18:40:00.000Z" }],
  hostTimes: [],
  pay: {},
  ...extra,
});

const fixer = (): FixerFile =>
  ({
    pros: [{ id: "p1", name: "Joe's Plumbing" }],
    jobs: [
      {
        id: "r1",
        trade: "plumbing",
        what: "Sink leaks",
        state: "done",
        booking: { proId: "p1", from: "2027-01-06T15:00:00.000Z", until: "2027-01-06T17:00:00.000Z", access: "code", fingerprint: "x" },
        done: { at: "2027-01-06T16:20:00.000Z", by: "pro-page" },
        news: [],
      },
    ],
  }) as unknown as FixerFile;

describe("the hours log reads visit records", () => {
  it("names the day a moved cleaning moved to (move_cleaning, finding #8)", () => {
    const moved = base({ cleaningJobs: [{ id: "j1", checkoutDate: "2027-01-03", cleanOn: { date: "2027-01-04", minutes: 660 }, done: true, startedAt: "2027-01-04T16:30:00.000Z", doneAt: "2027-01-04T18:40:00.000Z" }] });
    const [row] = cleanerRows(moved);
    expect(row).toMatchObject({ at: "2027-01-04T16:30:00.000Z", task: "Turnover cleaning after the 2027-01-03 checkout, moved to 2027-01-04" });
  });

  it("keeps a cleaning's START-to-DONE row when there's no visit record", () => {
    const [row] = cleanerRows(base());
    expect(row).toMatchObject({ at: "2027-01-04T16:30:00.000Z", until: "2027-01-04T18:40:00.000Z", timing: "measured", reference: "Cleaner Core job j1" });
  });

  it("uses the lock's arrival and the lock after DONE for a cleaning, with how in the reference", () => {
    const visits = visitsFrom([
      connected,
      window("cleaning:j1", "cleaning", "2027-01-04T16:00:00.000Z", "2027-01-04T21:00:00.000Z", { role: "cleaner", name: "Maria Lopez" }),
      unlock("u1", "2027-01-04T16:05:00.000Z", "Cleaner"),
      { type: "message", id: "d1", at: "2027-01-04T18:40:00.000Z", direction: "in", role: "cleaner", visit: "cleaning:j1", label: "done" },
      lockOut("l1", "2027-01-04T18:44:00.000Z"),
    ]);
    const [row] = cleanerRows(base({ visits }));
    expect(row).toMatchObject({
      at: "2027-01-04T16:05:00.000Z",
      until: "2027-01-04T18:44:00.000Z",
      timing: "measured",
      reference: "Cleaner Core job j1, arrival from lock, departure from done-text, checked against the lock",
    });
    expect(row).not.toHaveProperty("needs");
  });

  it("keeps the cleaning row from texts when the property has no lock", () => {
    const visits = visitsFrom([
      window("cleaning:j1", "cleaning", "2027-01-04T16:00:00.000Z", "2027-01-04T21:00:00.000Z", { role: "cleaner", name: "Maria Lopez" }),
      { type: "message", id: "s1", at: "2027-01-04T16:30:00.000Z", direction: "in", role: "cleaner", visit: "cleaning:j1", label: "start" },
      { type: "message", id: "d1", at: "2027-01-04T18:40:00.000Z", direction: "in", role: "cleaner", visit: "cleaning:j1", label: "done" },
    ]);
    expect(cleanerRows(base({ visits }))).toEqual(cleanerRows(base()));
  });

  it("switches a Fixer visit from scheduled to measured when the record has both ends", () => {
    expect(fixerRows(base({ fixer: fixer() })).find((row) => row.kind === "repair-visit")).toMatchObject({ at: "2027-01-06T15:00:00.000Z", until: "2027-01-06T16:20:00.000Z", timing: "scheduled" });
    const visits = visitsFrom([
      connected,
      window("repair:r1", "repair", "2027-01-06T15:00:00.000Z", "2027-01-06T17:00:00.000Z", { role: "pro", name: "Joe's Plumbing", proId: "p1" }),
      unlock("u1", "2027-01-06T15:10:00.000Z", "Joe"),
      { type: "visit-page", id: "p1", at: "2027-01-06T16:20:00.000Z", visit: "repair:r1", step: "done" },
    ]);
    expect(fixerRows(base({ fixer: fixer(), visits })).find((row) => row.kind === "repair-visit")).toMatchObject({
      at: "2027-01-06T15:10:00.000Z",
      until: "2027-01-06T16:20:00.000Z",
      timing: "measured",
      reference: "Fixer Core job r1, arrival from lock, departure from done-page",
    });
  });

  it("reads the visit log from the property's folder only when it exists", () => {
    const root = mkdtempSync(join(tmpdir(), "visit-hours-"));
    roots.push(root);
    writeFileSync(join(root, "hub.json"), JSON.stringify({ schemaVersion: 1, property: { nickname: "Scratch Lane", timeZone: NY }, calendars: [], stays: [] }));
    expect(readRecords(root)).not.toHaveProperty("visits");
    new VisitLog(root).append(window("cleaning:j1", "cleaning", "2027-01-04T16:00:00.000Z", "2027-01-04T21:00:00.000Z", { role: "cleaner", name: "Maria Lopez" }));
    expect(readRecords(root).visits?.map((visit) => visit.id)).toEqual(["cleaning:j1"]);
  });
});
