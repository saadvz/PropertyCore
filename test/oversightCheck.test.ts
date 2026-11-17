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
