import { describe, expect, it } from "vitest";
import type { Stay } from "../src/hub/store.js";
import { crewScheduleProblem, crewWindowAt, crewWindows, type CrewSchedule } from "../src/fixer-core/crewDays.js";

const stay = (checkIn: string, checkout: string, kind: Stay["kind"] = "stay"): Stay => ({ checkIn, checkout, kind });
const week: CrewSchedule = { firstDay: "2026-12-07", lastDay: "2026-12-13", workdays: ["MON", "TUE", "WED", "THU", "FRI"], start: "08:00", end: "17:00" };
const utc = { timeZone: "UTC", checkInBufferMinutes: 60, stays: [] as Stay[] };
const TODAY = "2026-12-01";

describe("crewScheduleProblem", () => {
  it("accepts a weekday schedule", () => {
    expect(crewScheduleProblem(week, TODAY)).toBeUndefined();
  });

  it.each([
    ["no workdays", { workdays: [] }],
    ["an overnight shift", { start: "17:00", end: "08:00" }],
    ["a time without two hour digits", { start: "8:00" }],
    ["the same start and end", { start: "08:00", end: "08:00" }],
    ["a skip day outside the range", { skipDays: ["2026-12-20"] }],
    ["93 days", { firstDay: "2026-12-01", lastDay: "2027-03-03" }],
    ["a first day before today", { firstDay: "2026-11-30" }],
    ["a day that isn't a weekday name", { workdays: ["MONDAY"] }],
  ])("refuses %s", (_name, patch) => {
    expect(crewScheduleProblem({ ...week, ...patch } as CrewSchedule, TODAY)).toBeDefined();
  });
});

describe("crewWindows", () => {
  it("gives one window per workday", () => {
    const { windows, conflicts } = crewWindows(week, utc);
    expect(windows.map((w) => w.day)).toEqual(["2026-12-07", "2026-12-08", "2026-12-09", "2026-12-10", "2026-12-11"]);
    expect(windows[0]).toEqual({ day: "2026-12-07", from: "2026-12-07T08:00:00.000Z", until: "2026-12-07T17:00:00.000Z" });
    expect(conflicts).toEqual([]);
  });

  it("leaves out skip days", () => {
    expect(crewWindows({ ...week, skipDays: ["2026-12-09"] }, utc).windows.map((w) => w.day)).not.toContain("2026-12-09");
  });

  it("keeps local hours across a clock change", () => {
    const schedule: CrewSchedule = { firstDay: "2027-03-12", lastDay: "2027-03-15", workdays: ["MON", "FRI"], start: "08:00", end: "17:00" };
    const { windows } = crewWindows(schedule, { ...utc, timeZone: "America/New_York" });
    expect(windows.map((w) => w.from)).toEqual(["2027-03-12T13:00:00.000Z", "2027-03-15T12:00:00.000Z"]);
  });

  it("starts a day at checkout when a stay leaves that morning", () => {
    const { windows, conflicts } = crewWindows(week, { ...utc, stays: [stay("2026-12-05", "2026-12-08")] });
    expect(windows.find((w) => w.day === "2026-12-08")).toEqual({ day: "2026-12-08", from: "2026-12-08T11:00:00.000Z", until: "2026-12-08T17:00:00.000Z" });
    expect(conflicts).toEqual([
      { day: "2026-12-07", why: "dropped" },
      { day: "2026-12-08", why: "clipped" },
    ]);
  });

  it("ends a day an hour before a 16:00 check-in", () => {
    const { windows } = crewWindows(week, { ...utc, stays: [stay("2026-12-10", "2026-12-14")] });
    expect(windows.find((w) => w.day === "2026-12-10")).toEqual({ day: "2026-12-10", from: "2026-12-10T08:00:00.000Z", until: "2026-12-10T15:00:00.000Z" });
  });

  it("drops a day a guest holds and clips the days it starts and ends", () => {
    const { windows, conflicts } = crewWindows(week, { ...utc, stays: [stay("2026-12-08", "2026-12-10")] });
    expect(windows.filter((w) => ["2026-12-08", "2026-12-09", "2026-12-10"].includes(w.day))).toEqual([
      { day: "2026-12-08", from: "2026-12-08T08:00:00.000Z", until: "2026-12-08T15:00:00.000Z" },
      { day: "2026-12-10", from: "2026-12-10T11:00:00.000Z", until: "2026-12-10T17:00:00.000Z" },
    ]);
    expect(conflicts).toEqual([
      { day: "2026-12-08", why: "clipped" },
      { day: "2026-12-09", why: "dropped" },
      { day: "2026-12-10", why: "clipped" },
    ]);
  });
});

describe("crewWindowAt", () => {
  const { windows } = crewWindows(week, utc);
  const at = (iso: string, early?: number) => crewWindowAt(windows, new Date(iso), early);

  it("opens 30 minutes before the start and closes at the end", () => {
    expect(at("2026-12-07T07:29:59Z")).toBeUndefined();
    expect(at("2026-12-07T07:30:00Z")).toEqual(windows[0]);
    expect(at("2026-12-07T16:59:59Z")).toEqual(windows[0]);
    expect(at("2026-12-07T17:00:00Z")).toBeUndefined();
  });

  it("takes a different lead", () => {
    expect(at("2026-12-07T07:59:00Z", 0)).toBeUndefined();
    expect(at("2026-12-07T08:00:00Z", 0)).toEqual(windows[0]);
  });
});
