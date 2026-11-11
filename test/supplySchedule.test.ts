import { describe, expect, it } from "vitest";
import { deadlineFor, dueOn, nextDates, scheduleProblem } from "../src/supply-core/schedule";

describe("scheduleProblem", () => {
  it("accepts the documented bounds", () => {
    expect(scheduleProblem({ kind: "every", days: 1 }, "2026-11-04")).toBeUndefined();
    expect(scheduleProblem({ kind: "every", days: 365 }, "2026-11-04")).toBeUndefined();
    expect(scheduleProblem({ kind: "every", monthlyOn: 28 }, "2026-11-04")).toBeUndefined();
    expect(scheduleProblem({ kind: "bookings", stays: 50 }, "2026-11-04")).toBeUndefined();
    expect(scheduleProblem({ kind: "custom", rrule: "FREQ=MONTHLY;BYDAY=1MO;BYMONTH=5,6,7,8,9", said: "first Monday, May to September" }, "2026-11-04")).toBeUndefined();
  });

  it("refuses out-of-range values and unsupported rules", () => {
    expect(scheduleProblem({ kind: "every", days: 0 }, "2026-11-04")).toBeDefined();
    expect(scheduleProblem({ kind: "every", monthlyOn: 29 }, "2026-11-04")).toBeDefined();
    expect(scheduleProblem({ kind: "bookings", stays: 51 }, "2026-11-04")).toBeDefined();
    expect(scheduleProblem({ kind: "custom", rrule: "FREQ=HOURLY", said: "hourly" }, "2026-11-04")).toBeDefined();
    expect(scheduleProblem({ kind: "custom", rrule: "FREQ=DAILY;BYHOUR=9", said: "9am" }, "2026-11-04")).toBeDefined();
    expect(scheduleProblem({ kind: "custom", rrule: "FREQ=WEEKLY;UNTIL=20200101", said: "ended" }, "2026-11-04")).toBeDefined();
  });
});

describe("nextDates", () => {
  it("gives the next 3 dates of a custom rule", () => {
    expect(nextDates({ kind: "custom", rrule: "FREQ=MONTHLY;BYDAY=1MO;BYMONTH=5,6,7,8,9", said: "" }, "2026-11-04", "2026-11-04", 3)).toEqual([
      "2027-05-03",
      "2027-06-07",
      "2027-07-05",
    ]);
  });

  it("handles INTERVAL, BYMONTHDAY, BYSETPOS and COUNT", () => {
    expect(nextDates({ kind: "custom", rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", said: "" }, "2026-11-03", "2026-11-03", 3)).toEqual(["2026-11-17", "2026-12-01", "2026-12-15"]);
    expect(nextDates({ kind: "custom", rrule: "FREQ=MONTHLY;BYMONTHDAY=15", said: "" }, "2026-11-04", "2026-11-04", 2)).toEqual(["2026-11-15", "2026-12-15"]);
    expect(nextDates({ kind: "custom", rrule: "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", said: "last weekday" }, "2026-11-04", "2026-11-04", 2)).toEqual(["2026-11-30", "2026-12-31"]);
    expect(nextDates({ kind: "custom", rrule: "FREQ=DAILY;COUNT=2", said: "" }, "2026-11-04", "2026-11-04", 5)).toEqual(["2026-11-05"]);
  });

  it("gives every-N-days dates from the start", () => {
    expect(nextDates({ kind: "every", days: 21 }, "2026-11-04", "2026-11-04", 2)).toEqual(["2026-11-25", "2026-12-16"]);
  });

  it("gives the checkout on which each bookings count is reached", () => {
    const checkouts = ["2026-11-02", "2026-11-06", "2026-11-09", "2026-11-12", "2026-11-20"];
    expect(nextDates({ kind: "bookings", stays: 2 }, "2026-11-01", "2026-11-04", 3, checkouts)).toEqual(["2026-11-09", "2026-11-20"]);
    expect(nextDates({ kind: "bookings", stays: 2 }, "2026-11-01", "2026-11-04", 3)).toEqual([]);
  });
});

describe("dueOn", () => {
  const base = { startYmd: "2026-11-01", todayYmd: "2026-11-04", checkouts: [] as string[], lowReported: false };

  it("an every-N-days item never ordered first comes due N days after its start, not on Activate", () => {
    expect(dueOn({ ...base, schedule: { kind: "every", days: 21 } }).due).toBe(false);
    expect(dueOn({ ...base, todayYmd: "2026-11-21", schedule: { kind: "every", days: 21 } }).due).toBe(false);
    expect(dueOn({ ...base, todayYmd: "2026-11-22", schedule: { kind: "every", days: 21 } })).toMatchObject({ due: true, why: "schedule", occurrenceYmd: "2026-11-22" });
  });

  it("an only-when-low item is due only on a report, and has no dates", () => {
    expect(dueOn({ ...base, todayYmd: "2030-01-01", schedule: { kind: "reports" } }).due).toBe(false);
    expect(dueOn({ ...base, schedule: { kind: "reports" }, lowReported: true })).toMatchObject({ due: true, why: "report" });
    expect(scheduleProblem({ kind: "reports" }, "2026-11-04")).toBeUndefined();
    expect(nextDates({ kind: "reports" }, "2026-11-04", "2026-11-04", 3)).toEqual([]);
  });

  it("is due again N days after the last order, not before", () => {
    expect(dueOn({ ...base, schedule: { kind: "every", days: 21 }, anchorYmd: "2026-10-15" }).due).toBe(false);
    expect(dueOn({ ...base, schedule: { kind: "every", days: 21 }, anchorYmd: "2026-10-14" }).due).toBe(true);
  });

  it("is due on the month day, or the first run after it, once", () => {
    expect(dueOn({ ...base, schedule: { kind: "every", monthlyOn: 3 } })).toMatchObject({ due: true, occurrenceYmd: "2026-11-03" });
    expect(dueOn({ ...base, schedule: { kind: "every", monthlyOn: 3 }, anchorYmd: "2026-11-03" }).due).toBe(false);
    expect(dueOn({ ...base, schedule: { kind: "every", monthlyOn: 5 } }).due).toBe(false);
  });

  it("is due on a custom rule's date, once", () => {
    const rule = { kind: "custom" as const, rrule: "FREQ=WEEKLY;BYDAY=TU", said: "Tuesdays" };
    expect(dueOn({ ...base, schedule: rule })).toMatchObject({ due: true, occurrenceYmd: "2026-11-03" });
    expect(dueOn({ ...base, schedule: rule, anchorYmd: "2026-11-03" }).due).toBe(false);
  });

  it("counts checkouts after the anchor for bookings", () => {
    const checkouts = ["2026-10-20", "2026-10-28", "2026-11-02", "2026-11-04", "2026-11-09"];
    expect(dueOn({ ...base, schedule: { kind: "bookings", stays: 3 }, anchorYmd: "2026-10-25", checkouts }).due).toBe(true);
    expect(dueOn({ ...base, schedule: { kind: "bookings", stays: 4 }, anchorYmd: "2026-10-25", checkouts }).due).toBe(false);
  });

  it("is due now on a low report, whatever the schedule", () => {
    expect(dueOn({ ...base, schedule: { kind: "every", days: 365 }, anchorYmd: "2026-11-03", lowReported: true })).toMatchObject({ due: true, why: "report" });
  });
});

describe("deadlineFor", () => {
  it("is the day before the next cleaning with Cleaner Core", () => {
    expect(deadlineFor({ todayYmd: "2026-11-04", bufferDays: 3, nextCleaningYmd: "2026-11-09" })).toBe("2026-11-08");
  });

  it("is the cleaning day itself when the cleaning is today or tomorrow", () => {
    expect(deadlineFor({ todayYmd: "2026-11-04", bufferDays: 3, nextCleaningYmd: "2026-11-05" })).toBe("2026-11-05");
    expect(deadlineFor({ todayYmd: "2026-11-04", bufferDays: 3, nextCleaningYmd: "2026-11-04" })).toBe("2026-11-04");
  });

  it("is the occurrence (never before today) plus the buffer otherwise", () => {
    expect(deadlineFor({ todayYmd: "2026-11-04", bufferDays: 3, occurrenceYmd: "2026-11-01" })).toBe("2026-11-07");
    expect(deadlineFor({ todayYmd: "2026-11-04", bufferDays: 3, occurrenceYmd: "2026-11-06" })).toBe("2026-11-09");
    expect(deadlineFor({ todayYmd: "2026-11-04", bufferDays: 0 })).toBe("2026-11-04");
  });
});

describe("long-running schedules", () => {
  it("monthly and custom schedules still come due years after Activate", () => {
    const base = { startYmd: "2026-11-01", checkouts: [] as string[], lowReported: false };
    expect(dueOn({ ...base, todayYmd: "2030-06-05", anchorYmd: "2030-05-05", schedule: { kind: "every", monthlyOn: 5 } })).toMatchObject({ due: true, occurrenceYmd: "2030-06-05" });
    expect(dueOn({ ...base, todayYmd: "2030-06-03", anchorYmd: "2030-05-27", schedule: { kind: "custom", rrule: "FREQ=WEEKLY;BYDAY=MO", said: "Mondays" } })).toMatchObject({ due: true, occurrenceYmd: "2030-06-03" });
    expect(nextDates({ kind: "every", monthlyOn: 5 }, "2026-11-01", "2031-01-01", 1)).toEqual(["2031-01-05"]);
  });

  it("a COUNT still counts from the start", () => {
    expect(nextDates({ kind: "custom", rrule: "FREQ=DAILY;COUNT=3", said: "" }, "2026-11-04", "2026-11-05", 5)).toEqual(["2026-11-06"]);
  });
});
