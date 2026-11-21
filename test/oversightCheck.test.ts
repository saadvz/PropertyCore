import { describe, expect, it } from "vitest";
import { zonedInstant } from "../src/hub/calendar";
import { checkDay } from "../src/oversight/check";
import type { EntryEvent } from "../src/oversight/events";
import type { ExpectedVisit } from "../src/oversight/visits";

/** #240: one day's expected visits against that day's entry events, flagged the same day. Sample events only. */

const NY = "America/New_York";
const DATE = "2026-11-19";
const LABEL = "Lake House";
const at = (hm: string, date = DATE, zone = NY) => zonedInstant(date, hm, zone);
const now = (hm: string, date = DATE, zone = NY) => new Date(at(hm, date, zone));

const MIKE: ExpectedVisit = { id: "v-00000001", who: "Mike Doyle", date: DATE, from: "13:00", to: "17:00", note: "walk-through", source: "text", savedAt: "2026-11-17T15:00:00.000Z" };
const ALL_DAY: ExpectedVisit = { id: "v-00000002", who: "Mike Doyle", date: DATE, source: "text", savedAt: "2026-11-17T15:00:00.000Z" };

let n = 0;
const entry = (hm: string, person?: string, date = DATE, zone = NY): EntryEvent => ({ id: `e-${++n}`, at: at(hm, date, zone), device: "Front door", ...(person ? { person } : {}), method: "keypad" });

const run = (visits: ExpectedVisit[], entries: EntryEvent[], when: Date, timeZone = NY) => checkDay({ label: LABEL, visits, entries, date: DATE, timeZone, now: when });

describe("the same-day check", () => {
  it("came", () => {
    const result = run([MIKE], [entry("14:10", "Mike Doyle")], now("18:01"));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.visits[0]).toMatchObject({ outcome: "came", entry: { person: "Mike Doyle", device: "Front door" } });
    expect(result.visits[0]?.late).toBeUndefined();
  });

  it("waiting before the flag time", () => {
    const result = run([MIKE], [], now("17:30"));
    expect(result).toMatchObject({ status: "ok", visits: [{ outcome: "waiting", flagAt: at("18:00") }] });
  });

  it("missed after the flag time", () => {
    const result = run([MIKE], [], now("18:01"));
    expect(result.status).toBe("flags");
    if (result.status !== "flags") return;
    expect(result.missed.map((v) => v.id)).toEqual([MIKE.id]);
    expect(result.alert).toBe("Today at Lake House: Mike Doyle was expected between 1 PM and 5 PM (walk-through). No one came in by 6 PM.");
  });

  it("counts 30 minutes early and 1 hour late", () => {
    expect(run([MIKE], [entry("12:30", "Mike Doyle")], now("18:01")).status).toBe("ok");
    expect(run([MIKE], [entry("18:00", "Mike Doyle")], now("18:01")).status).toBe("ok");
    expect(run([MIKE], [entry("12:29", "Mike Doyle")], now("18:01")).status).toBe("flags");
  });

  it("all-day visits flag at 8 PM", () => {
    expect(run([ALL_DAY], [], now("19:59"))).toMatchObject({ status: "ok", visits: [{ outcome: "waiting" }] });
    const late = run([ALL_DAY], [], now("20:01"));
    expect(late).toMatchObject({ status: "flags", alert: "Today at Lake House: Mike Doyle was expected today. No one came in by 8 PM." });
  });

  it("an unnamed entry counts and is marked", () => {
    const result = run([MIKE], [entry("14:00")], now("18:01"));
    expect(result).toMatchObject({ status: "ok", visits: [{ outcome: "came", entry: { unnamed: true } }] });
  });

  it("someone else's entry doesn't count and is named in the alert", () => {
    const result = run([MIKE], [entry("14:10", "Sam Ortiz")], now("18:01"));
    expect(result.status).toBe("flags");
    if (result.status !== "flags") return;
    expect(result.missed[0]?.others).toEqual([{ at: at("14:10"), person: "Sam Ortiz" }]);
    expect(result.alert).toMatch(/ The door was opened at 2:10 PM by Sam Ortiz\.$/);
  });

  it("a late arrival before midnight turns missed into came late", () => {
    expect(run([MIKE], [entry("21:00", "Mike Doyle")], now("21:30"))).toMatchObject({ status: "ok", visits: [{ outcome: "came", late: true }] });
    expect(run([MIKE], [entry("00:05", "Mike Doyle", "2026-11-20")], new Date(at("00:10", "2026-11-20"))).status).toBe("flags");
  });

  it("an entry before the counting window doesn't count, even early that day", () => {
    expect(run([MIKE], [entry("08:00", "Mike Doyle")], now("18:01")).status).toBe("flags");
  });

  it("cancelled visits and other days aren't checked", () => {
    expect(run([{ ...MIKE, cancelledAt: "2026-11-18T12:00:00.000Z" }], [], now("18:01")).status).toBe("none");
    expect(run([{ ...MIKE, date: "2026-11-20" }], [], now("18:01")).status).toBe("none");
  });

  it("already flagged visits stay out of the alert", () => {
    const flagged = { ...MIKE, flaggedAt: at("18:05") };
    const once = run([flagged], [], now("19:00"));
    expect(once.status).toBe("flags");
    if (once.status !== "flags") return;
    expect(once.missed[0]?.alreadyFlagged).toBe(true);
    expect(once.alert).toBeUndefined();
    const both = run([flagged, { ...ALL_DAY, id: "v-00000003", who: "Sam Ortiz" }], [], now("20:30"));
    expect(both.status).toBe("flags");
    if (both.status !== "flags") return;
    expect(both.missed).toHaveLength(2);
    expect(both.alert).toBe("Today at Lake House: Sam Ortiz was expected today. No one came in by 8 PM.");
  });

  it("matches names ignoring case and spacing", () => {
    expect(run([MIKE], [entry("14:00", "mike  doyle")], now("18:01")).status).toBe("ok");
  });

  it("reads the day in the property's zone", () => {
    const LA = "America/Los_Angeles";
    const pacific: EntryEvent = { id: "e-la", at: "2026-11-19T22:10:00.000Z", device: "Front door", person: "Mike Doyle" };
    expect(run([MIKE], [pacific], now("18:01", DATE, LA), LA)).toMatchObject({ status: "ok", visits: [{ outcome: "came", flagAt: at("18:00", DATE, LA) }] });
    // 9:30 PM Pacific is still the 19th there, but already the 20th in New York.
    const evening: EntryEvent = { ...pacific, id: "e-la-2", at: "2026-11-20T05:30:00.000Z" };
    expect(run([MIKE], [evening], now("22:00", DATE, LA), LA)).toMatchObject({ status: "ok", visits: [{ outcome: "came", late: true }] });
    expect(run([MIKE], [evening], now("22:00", DATE, LA), NY).status).toBe("flags");
  });

  it("a window ending near midnight flags by 23:59", () => {
    const result = run([{ ...MIKE, from: "22:30", to: "23:30" }], [], now("12:00"));
    expect(result).toMatchObject({ status: "ok", visits: [{ outcome: "waiting", flagAt: at("23:59") }] });
  });

  it("lists every missed visit in one alert, earliest first", () => {
    const morning = { ...MIKE, id: "v-00000004", who: "Sam Ortiz", from: "09:00", to: "10:00", note: undefined };
    const result = run([MIKE, morning], [], now("18:30"));
    expect(result).toMatchObject({
      status: "flags",
      alert: "Today at Lake House: Sam Ortiz was expected between 9 AM and 10 AM. No one came in by 11 AM. Mike Doyle was expected between 1 PM and 5 PM (walk-through). No one came in by 6 PM.",
    });
  });
});

describe("the same-day check on real evidence (#240)", () => {
  const quiet = (from: string, until?: string, door: string | null = "Front door", device = door ?? undefined) => ({ from: at(from), ...(until ? { until: at(until) } : {}), ...(device ? { device } : {}), why: device ? ("offline" as const) : ("disconnected" as const) });
  const seen = (hm: string) => ({ at: at(hm), device: "Front porch" });
  const runWith = (visits: ExpectedVisit[], when: Date, evidence: { entries?: EntryEvent[]; lock?: boolean; quiet?: ReturnType<typeof quiet>[]; sightings?: ReturnType<typeof seen>[] }) =>
    checkDay({ label: LABEL, visits, entries: evidence.entries ?? [], ...(evidence.lock !== undefined ? { lock: evidence.lock } : {}), ...(evidence.quiet ? { quiet: evidence.quiet } : {}), ...(evidence.sightings ? { sightings: evidence.sightings } : {}), date: DATE, timeZone: NY, now: when });

  it("a host's or guest's code never counts as the visit, and the alert names it", () => {
    const entries: EntryEvent[] = [
      { id: "h-1", at: at("14:10"), device: "Front door", party: "host" },
      { id: "g-1", at: at("15:20"), device: "Front door", party: "guest" },
    ];
    const result = runWith([MIKE], now("18:01"), { entries });
    expect(result.status).toBe("flags");
    if (result.status !== "flags") return;
    expect(result.missed[0]?.others).toEqual([
      { at: at("14:10"), party: "host" },
      { at: at("15:20"), party: "guest" },
    ]);
    expect(result.alert).toContain("The door was opened at 2:10 PM with your own code.");
    expect(result.alert).toContain("The door was opened at 3:20 PM with a guest's code.");
  });

  it("no connected lock: can't tell, never missed, and no alert", () => {
    const result = runWith([MIKE], now("18:01"), { lock: false });
    expect(result).toMatchObject({ status: "ok", visits: [{ outcome: "unknown", why: "no-lock" }] });
    expect("alert" in result).toBe(false);
  });

  it("no connected lock and still early: can't tell, not waiting", () => {
    expect(runWith([MIKE], now("12:00"), { lock: false })).toMatchObject({ status: "ok", visits: [{ outcome: "unknown", why: "no-lock" }] });
  });

  it("a lock offline during the window: can't tell, in the alert, not a miss", () => {
    const result = runWith([MIKE], now("18:01"), { quiet: [quiet("12:40", "15:00")] });
    expect(result.status).toBe("flags");
    if (result.status !== "flags") return;
    expect(result.missed).toEqual([]);
    expect(result.unsure).toHaveLength(1);
    expect(result.unsure[0]).toMatchObject({ outcome: "unknown", why: "lock-quiet", quiet: [{ from: at("12:40"), until: at("15:00"), device: "Front door" }] });
    expect(result.alert).toBe("Today at Lake House: Mike Doyle was expected between 1 PM and 5 PM (walk-through). The Front door lock was offline from 12:40 PM to 3 PM, so I can't tell whether anyone came in.");
  });

  it("a quiet span still open reads 'since', and a disconnected account names the connection", () => {
    const offline = runWith([MIKE], now("18:01"), { quiet: [quiet("16:30")] });
    if (offline.status !== "flags") throw new Error("expected flags");
    expect(offline.alert).toContain("The Front door lock has been offline since 4:30 PM");
    const off = runWith([MIKE], now("18:01"), { quiet: [quiet("11:00", "14:00", null)] });
    if (off.status !== "flags") throw new Error("expected flags");
    expect(off.alert).toContain("The locks here weren't connected from 11 AM to 2 PM");
    const stillOff = runWith([MIKE], now("18:01"), { quiet: [quiet("16:30", undefined, null)] });
    if (stillOff.status !== "flags") throw new Error("expected flags");
    expect(stillOff.alert).toContain("The locks here haven't been connected since 4:30 PM, so I can't tell whether anyone came in.");
  });

  it("a quiet span outside the counting window doesn't matter", () => {
    const result = runWith([MIKE], now("18:01"), { quiet: [quiet("09:00", "12:29"), quiet("18:01")] });
    expect(result).toMatchObject({ status: "flags", missed: [{ outcome: "missed" }], unsure: [] });
  });

  it("a quiet span touching the counting window's edge counts", () => {
    expect(runWith([MIKE], now("18:01"), { quiet: [quiet("09:00", "12:30")] })).toMatchObject({ status: "flags", unsure: [{ why: "lock-quiet" }] });
  });

  it("an entry wins over a quiet lock", () => {
    const result = runWith([MIKE], now("18:01"), { entries: [entry("14:10", "Mike Doyle")], quiet: [quiet("12:40", "15:00")] });
    expect(result).toMatchObject({ status: "ok", visits: [{ outcome: "came" }] });
  });

  it("before the flag time a quiet lock is still waiting", () => {
    expect(runWith([MIKE], now("17:00"), { quiet: [quiet("12:40")] })).toMatchObject({ status: "ok", visits: [{ outcome: "waiting" }] });
  });

  it("an already flagged quiet visit is left out of the alert", () => {
    const result = runWith([{ ...MIKE, flaggedAt: at("18:01") }], now("19:00"), { quiet: [quiet("12:40")] });
    expect(result).toMatchObject({ status: "flags", unsure: [{ alreadyFlagged: true }] });
    if (result.status === "flags") expect(result.alert).toBeUndefined();
  });

  it("a camera sighting supports an entry but never makes a visit came on its own", () => {
    const came = runWith([MIKE], now("18:01"), { entries: [entry("14:10", "Mike Doyle")], sightings: [seen("14:08"), seen("19:00")] });
    expect(came).toMatchObject({ status: "ok", visits: [{ outcome: "came", sightings: [{ at: at("14:08"), device: "Front porch" }] }] });
    const missed = runWith([MIKE], now("18:01"), { sightings: [seen("14:08")] });
    expect(missed).toMatchObject({ status: "flags", missed: [{ outcome: "missed", sightings: [{ at: at("14:08") }] }] });
    if (missed.status === "flags") expect(missed.alert).toBe("Today at Lake House: Mike Doyle was expected between 1 PM and 5 PM (walk-through). No one came in by 6 PM. The Front porch camera saw someone at 2:08 PM.");
  });

  it("a sighting with a quiet lock is in the alert too", () => {
    const result = runWith([MIKE], now("18:01"), { quiet: [quiet("12:40")], sightings: [seen("14:08")] });
    if (result.status !== "flags") throw new Error("expected flags");
    expect(result.alert).toContain("so I can't tell whether anyone came in. The Front porch camera saw someone at 2:08 PM.");
  });

  it("sightings outside the counting window are left off", () => {
    expect(runWith([MIKE], now("18:01"), { sightings: [seen("12:29"), seen("18:01")] })).toMatchObject({ status: "flags", missed: [{ sightings: [] }] });
  });

  describe("the host's switch to connected locks, per window (review)", () => {
    const runSwitched = (switched: { from: string; until?: string }[], when = now("18:01")) => checkDay({ label: LABEL, visits: [MIKE], entries: [], switched, date: DATE, timeZone: NY, now: when });

    it("a window entirely before the switch is no lock, with no alert", () => {
      expect(runSwitched([{ from: at("19:00") }])).toMatchObject({ status: "ok", visits: [{ outcome: "unknown", why: "no-lock" }] });
    });

    it("a window entirely after a switch-off is no lock", () => {
      expect(runSwitched([{ from: at("08:00", "2026-11-10"), until: at("09:00") }])).toMatchObject({ status: "ok", visits: [{ outcome: "unknown", why: "no-lock" }] });
    });

    it("a window the switch-on falls inside is can't tell for the part before it", () => {
      const result = runSwitched([{ from: at("14:00") }]);
      expect(result).toMatchObject({ status: "flags", unsure: [{ why: "lock-quiet", quiet: [{ from: at("12:30"), until: at("14:00"), why: "disconnected" }] }] });
      if (result.status === "flags") expect(result.alert).toContain("The locks here weren't connected from 12:30 PM to 2 PM");
    });

    it("a window fully inside an on-period is checked as usual", () => {
      expect(runSwitched([{ from: at("08:00", "2026-11-10") }])).toMatchObject({ status: "flags", missed: [{ outcome: "missed" }] });
    });
  });

  it("a quiet span from an earlier day gives its day in the alert (review)", () => {
    const result = checkDay({ label: LABEL, visits: [MIKE], entries: [], quiet: [{ from: at("12:40", "2026-11-17"), device: "Front door", why: "offline" }], date: DATE, timeZone: NY, now: now("18:01") });
    if (result.status !== "flags") throw new Error("expected flags");
    expect(result.alert).toContain("The Front door lock has been offline since 12:40 PM on Tuesday, Nov 17,");
  });
});
