import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { zonedInstant } from "../src/hub/calendar";
import { oversightDeskFor } from "../src/oversight/desk";
import type { EntryEvent } from "../src/oversight/events";
import { OVERSIGHT_FILE, readOversight, writeOversight } from "../src/oversight/store";
import type { ExpectedVisit } from "../src/oversight/visits";

/** #240: one property's desk saves, lists and cancels expected visits, and runs one day. Made-up property only. */

const NY = "America/New_York";
const NOW = new Date("2026-11-17T15:00:00.000Z");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const invite = (name: string) => readFileSync(join(__dirname, "fixtures", "oversight", `${name}.ics`), "utf8");

function property(opts: { timeZone?: string | null; now?: () => Date } = {}) {
  const root = mkdtempSync(join(tmpdir(), "oversight-desk-"));
  roots.push(root);
  const timeZone = opts.timeZone === null ? {} : { timeZone: opts.timeZone ?? NY };
  writeFileSync(join(root, "hub.json"), JSON.stringify({ schemaVersion: 1, property: { nickname: "Lake House", ...timeZone }, calendars: [], stays: [] }));
  let clock = NOW;
  const desk = oversightDeskFor(root, { now: opts.now ?? (() => clock) });
  return { root, desk, setNow: (date: Date) => (clock = date) };
}

const MIKE = { who: "Mike Doyle", date: "2026-11-19", from: "13:00", to: "17:00", note: "walk-through" };

describe("the expected visits desk", () => {
  it("adds a visit from a text and lists it", () => {
    const { desk, root } = property();
    const added = desk.addVisit(MIKE);
    expect(added.isError).toBe(false);
    expect(added.structured).toMatchObject({ saved: true, visit: { ...MIKE, source: "text" } });
    const id = (added.structured?.visit as ExpectedVisit).id;
    expect(id).toMatch(/^v-[0-9a-f]{8}$/);
    expect(readOversight(root).visits[0]).toMatchObject({ id, savedAt: NOW.toISOString() });
    const listed = desk.listVisits();
    expect((listed.structured?.open as ExpectedVisit[]).map((v) => v.id)).toEqual([id]);
  });

  it("refuses a bad visit with a plain reason", () => {
    const { desk, root } = property();
    const reply = desk.addVisit({ ...MIKE, date: "2026-11-16" });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("today or later");
    expect(readOversight(root).visits).toEqual([]);
  });

  it("saving the same visit again returns the existing one", () => {
    const { desk, root } = property();
    const first = desk.addVisit(MIKE);
    const again = desk.addVisit({ ...MIKE, who: "mike doyle" });
    expect(again.structured).toMatchObject({ saved: false, duplicate: true });
    expect((again.structured?.visit as ExpectedVisit).id).toBe((first.structured?.visit as ExpectedVisit).id);
    expect(readOversight(root).visits).toHaveLength(1);
  });

  it("an invite is read back first and saved with confirm", () => {
    const { desk, root } = property();
    const read = desk.addVisit({ invite: invite("timed-tzid") });
    expect(read.isError).toBe(false);
    expect(read.structured).toMatchObject({ saved: false, visit: { who: "Mike Doyle", date: "2026-11-19", from: "13:00", to: "17:00" } });
    expect(readOversight(root).visits).toEqual([]);
    const saved = desk.addVisit({ invite: invite("timed-tzid"), confirm: true });
    expect(saved.structured).toMatchObject({ saved: true, visit: { source: "invite", note: "Walk-through" } });
    expect(readOversight(root).visits).toHaveLength(1);
  });

  it("an invite with no organizer needs who", () => {
    const { desk } = property();
    const reply = desk.addVisit({ invite: invite("floating"), confirm: true });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("who");
    expect(desk.addVisit({ invite: invite("floating"), who: "Mike", confirm: true }).structured).toMatchObject({ saved: true, visit: { who: "Mike", from: "09:00" } });
  });

  it("says when an invite's title was left out", () => {
    const { desk } = property();
    const reply = desk.addVisit({ invite: invite("code-title"), confirm: true });
    expect(reply.structured).toMatchObject({ saved: true, titleLeftOut: true });
    expect(reply.text).not.toContain("6150");
  });

  it("refuses an invite with details", () => {
    const { desk } = property();
    expect(desk.addVisit({ invite: invite("timed-tzid"), date: "2026-11-19" }).isError).toBe(true);
  });

  it("passes an invite's refusal along", () => {
    const { desk } = property();
    const reply = desk.addVisit({ invite: invite("repeating"), confirm: true });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("repeat");
  });

  it("refuses without a time zone", () => {
    const { desk } = property({ timeZone: null });
    const reply = desk.addVisit(MIKE);
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("time zone");
  });

  it("refuses past the open limit", () => {
    const { desk, root } = property();
    const visits: ExpectedVisit[] = Array.from({ length: 50 }, (_, i) => ({ id: `v-${String(i).padStart(8, "0")}`, who: `Crew ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? "b" : ""}`, date: "2026-11-20", source: "text", savedAt: NOW.toISOString() }));
    writeOversight(root, { visits });
    const reply = desk.addVisit(MIKE);
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("50");
  });

  it("cancels a visit", () => {
    const { desk, root } = property();
    const id = (desk.addVisit(MIKE).structured?.visit as ExpectedVisit).id;
    const cancelled = desk.cancelVisit({ id });
    expect(cancelled.isError).toBe(false);
    expect(readOversight(root).visits[0]?.cancelledAt).toBe(NOW.toISOString());
    expect(desk.listVisits().structured?.open).toEqual([]);
    expect(desk.cancelVisit({ id: "v-ffffffff" }).isError).toBe(true);
  });

  it("lists the last week's visits as recent", () => {
    const { desk, root } = property();
    const old: ExpectedVisit = { id: "v-00000009", who: "Sam Ortiz", date: "2026-11-14", source: "text", savedAt: "2026-11-13T15:00:00.000Z", flaggedAt: "2026-11-15T01:00:00.000Z" };
    const ancient: ExpectedVisit = { ...old, id: "v-00000008", date: "2026-11-01" };
    writeOversight(root, { visits: [old, ancient] });
    const listed = desk.listVisits().structured;
    expect((listed?.recent as ExpectedVisit[]).map((v) => v.id)).toEqual([old.id]);
  });

  it("refuses an unreadable record and leaves it", () => {
    const { desk, root } = property();
    writeFileSync(join(root, OVERSIGHT_FILE), "{nope");
    expect(desk.addVisit(MIKE).isError).toBe(true);
    expect(desk.listVisits().isError).toBe(true);
    expect(desk.cancelVisit({ id: "v-00000001" }).isError).toBe(true);
    const day = desk.runDay("2026-11-19", [], "Lake House");
    expect(day.status).toBe("none");
    if (day.status === "none") expect(day.reason).toContain(OVERSIGHT_FILE);
    expect(readFileSync(join(root, OVERSIGHT_FILE), "utf8")).toBe("{nope");
  });

  it("refuses an invite read-back while the record is broken", () => {
    const { desk, root } = property();
    writeFileSync(join(root, OVERSIGHT_FILE), "not json");
    expect(desk.addVisit({ invite: invite("timed-tzid") }).isError).toBe(true);
  });

  it("a malformed visit gives a plain refusal everywhere, not a crash", () => {
    const { desk, root } = property();
    writeFileSync(join(root, OVERSIGHT_FILE), JSON.stringify({ visits: [null] }));
    expect(desk.addVisit(MIKE).isError).toBe(true);
    expect(desk.listVisits().isError).toBe(true);
    expect(desk.cancelVisit({ id: "v-00000001" }).isError).toBe(true);
    expect(desk.runDay("2026-11-19", [], "Lake House").status).toBe("none");
    expect(readFileSync(join(root, OVERSIGHT_FILE), "utf8")).toBe(JSON.stringify({ visits: [null] }));
  });

  it("runDay counts a sample entry", () => {
    const { desk, setNow } = property();
    desk.addVisit(MIKE);
    setNow(new Date(zonedInstant("2026-11-19", "18:30", NY)));
    const entries: EntryEvent[] = [{ id: "e-1", at: zonedInstant("2026-11-19", "14:10", NY), device: "Front door", person: "Mike Doyle" }];
    expect(desk.runDay("2026-11-19", entries, "Lake House")).toMatchObject({ status: "ok", visits: [{ outcome: "came" }] });
  });

  it("runDay records flaggedAt once", () => {
    const { desk, root, setNow } = property();
    desk.addVisit(MIKE);
    const flagTime = new Date(zonedInstant("2026-11-19", "18:30", NY));
    setNow(flagTime);
    const day = desk.runDay("2026-11-19", [], "Lake House");
    expect(day).toMatchObject({ status: "flags", alert: expect.stringContaining("Mike Doyle was expected") });
    expect(readOversight(root).visits[0]?.flaggedAt).toBe(flagTime.toISOString());
  });

  it("a second run leaves already flagged visits out of the alert", () => {
    const { desk, root, setNow } = property();
    desk.addVisit(MIKE);
    const first = new Date(zonedInstant("2026-11-19", "18:30", NY));
    setNow(first);
    desk.runDay("2026-11-19", [], "Lake House");
    setNow(new Date(zonedInstant("2026-11-19", "19:30", NY)));
    const again = desk.runDay("2026-11-19", [], "Lake House");
    expect(again.status).toBe("flags");
    if (again.status === "flags") expect(again.alert).toBeUndefined();
    expect(readOversight(root).visits[0]?.flaggedAt).toBe(first.toISOString());
  });
});
