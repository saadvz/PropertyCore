import { describe, expect, it } from "vitest";
import type { Stay } from "../src/hub/store.js";
import { insideWindow, latestYmd, overlapsStay, visitWindows, type WindowInput } from "../src/fixer-core/window.js";

const base: WindowInput = {
  stays: [],
  timeZone: "UTC",
  checkInBufferMinutes: 60,
  cleaningMinutes: 180,
  cleanings: new Map(),
  now: new Date("2026-12-01T00:00:00Z"),
  lastYmd: "2026-12-10",
};
const stay = (checkIn: string, checkout: string, kind: Stay["kind"] = "stay"): Stay => ({ checkIn, checkout, kind });
const run = (patch: Partial<WindowInput>) => visitWindows({ ...base, ...patch });

describe("visitWindows", () => {
  it("is open from now to the end of lastYmd with no stay", () => {
    expect(run({ lastYmd: "2026-12-03" })).toEqual([{ from: "2026-12-01T00:00:00.000Z", until: "2026-12-04T00:00:00.000Z" }]);
  });

  it("treats stays from two calendars (overlapping, adjacent) as one occupied stretch", () => {
    const stays = [stay("2026-12-02", "2026-12-04"), stay("2026-12-03", "2026-12-05")];
    const windows = run({ stays, lastYmd: "2026-12-06" });
    expect(windows).toEqual([
      { from: "2026-12-01T00:00:00.000Z", until: "2026-12-02T15:00:00.000Z" },
      { from: "2026-12-05T11:00:00.000Z", until: "2026-12-07T00:00:00.000Z" },
    ]);
  });

  it("counts a block as occupied", () => {
    const windows = run({ stays: [stay("2026-12-02", "2026-12-03", "block")], lastYmd: "2026-12-04" });
    expect(windows.map((w) => [w.from, w.until])).toEqual([
      ["2026-12-01T00:00:00.000Z", "2026-12-02T15:00:00.000Z"],
      ["2026-12-03T11:00:00.000Z", "2026-12-05T00:00:00.000Z"],
    ]);
  });

  it("ends a window 60 minutes before a 16:00 check-in", () => {
    const first = run({ stays: [stay("2026-12-03", "2026-12-05")] })[0]!;
    expect(first.until).toBe("2026-12-03T15:00:00.000Z");
  });

  it("gives a same-day turnover 11:00 to 15:00", () => {
    const windows = run({ stays: [stay("2026-12-01", "2026-12-03"), stay("2026-12-03", "2026-12-06")], lastYmd: "2026-12-04", now: new Date("2026-12-03T00:00:00Z") });
    expect(windows).toEqual([{ from: "2026-12-03T11:00:00.000Z", until: "2026-12-03T15:00:00.000Z" }]);
  });

  const turnover = [stay("2026-12-01", "2026-12-03"), stay("2026-12-03", "2026-12-06")];
  const run3 = (patch: Partial<WindowInput>) => run({ now: new Date("2026-12-03T00:00:00Z"), ...patch });

  it("starts after cleaning at DONE when known", () => {
    const windows = run3({
      stays: turnover,
      lastYmd: "2026-12-04",
      cleaningOrder: "after",
      cleanings: new Map([["2026-12-03", { doneAt: "2026-12-03T12:30:00.000Z" }]]),
    });
    expect(windows).toEqual([
      {
        from: "2026-12-03T12:30:00.000Z",
        until: "2026-12-03T15:00:00.000Z",
        checkoutYmd: "2026-12-03",
        cleaning: { order: "after", doneKnown: true },
      },
    ]);
  });

  it("starts after cleaning at checkout + cleaningMinutes when DONE is unknown", () => {
    const w = run3({ stays: turnover, lastYmd: "2026-12-04", cleaningOrder: "after", cleanings: new Map([["2026-12-03", {}]]) })[0]!;
    expect(w.from).toBe("2026-12-03T14:00:00.000Z");
    expect(w.cleaning).toEqual({ order: "after", doneKnown: false });
  });

  it("ends before cleaning at checkout + cleaningMinutes", () => {
    const stays = [stay("2026-12-01", "2026-12-03")];
    const w = run3({ stays, lastYmd: "2026-12-04", cleaningOrder: "before", cleanings: new Map([["2026-12-03", {}]]) })[0]!;
    expect(w).toMatchObject({ from: "2026-12-03T11:00:00.000Z", until: "2026-12-03T14:00:00.000Z", checkoutYmd: "2026-12-03" });
  });

  it("keeps the whole gap when cleaning has no order, and leaves cleaning out with no entry", () => {
    const withEntry = run3({ stays: turnover, lastYmd: "2026-12-04", cleanings: new Map([["2026-12-03", {}]]) });
    expect(withEntry[0]).toMatchObject({ from: "2026-12-03T11:00:00.000Z", until: "2026-12-03T15:00:00.000Z" });
    const without = run3({ stays: turnover, lastYmd: "2026-12-04", cleaningOrder: "after" });
    expect(without[0]).toEqual({ from: "2026-12-03T11:00:00.000Z", until: "2026-12-03T15:00:00.000Z" });
  });

  it("follows the zone through the November DST change", () => {
    const windows = run({
      stays: [stay("2026-10-29", "2026-10-31"), stay("2026-11-01", "2026-11-02"), stay("2026-11-02", "2026-11-04")],
      timeZone: "America/New_York",
      now: new Date("2026-10-30T00:00:00Z"),
      lastYmd: "2026-11-03",
    });
    // Oct 31 11:00 EDT is 15:00Z; Nov 1 check-in 16:00 EST minus 60 is 15:00 EST = 20:00Z.
    expect(windows[0]).toEqual({ from: "2026-10-31T15:00:00.000Z", until: "2026-11-01T20:00:00.000Z" });
    // Nov 2 11:00 EST is 16:00Z, an hour later than the EDT equivalent.
    expect(windows[1]).toEqual({ from: "2026-11-02T16:00:00.000Z", until: "2026-11-02T20:00:00.000Z" });
  });

  it("ends at the end of lastYmd's local day", () => {
    const w = run3({ timeZone: "America/New_York", now: new Date("2026-11-01T00:00:00Z"), lastYmd: "2026-11-01" })[0]!;
    // Nov 1 ends at local midnight Nov 2 EST = 05:00Z.
    expect(w.until).toBe("2026-11-02T05:00:00.000Z");
  });

  it("clips from to now when now is mid-window, and drops windows already over", () => {
    const stays = [stay("2026-12-01", "2026-12-03"), stay("2026-12-03", "2026-12-06")];
    const mid = run({ stays, lastYmd: "2026-12-04", now: new Date("2026-12-03T12:15:00Z") });
    expect(mid[0]).toEqual({ from: "2026-12-03T12:15:00.000Z", until: "2026-12-03T15:00:00.000Z" });
    const late = run({ stays, lastYmd: "2026-12-04", now: new Date("2026-12-03T16:00:00Z") });
    expect(late).toEqual([]);
  });
});

describe("latestYmd", () => {
  it("uses byDate, else 14 days for now and soon, 30 for flexible", () => {
    expect(latestYmd({ urgency: "by-date", byDate: "2026-12-20" }, "2026-12-01")).toBe("2026-12-20");
    expect(latestYmd({ urgency: "now" }, "2026-12-01")).toBe("2026-12-15");
    expect(latestYmd({ urgency: "soon" }, "2026-12-01")).toBe("2026-12-15");
    expect(latestYmd({ urgency: "flexible" }, "2026-12-01")).toBe("2026-12-31");
    expect(latestYmd({ urgency: "by-date" }, "2026-12-01")).toBe("2026-12-15");
  });
});

describe("insideWindow and overlapsStay", () => {
  const windows = [{ from: "2026-12-03T11:00:00.000Z", until: "2026-12-03T15:00:00.000Z" }];
  it("needs the span fully inside one window", () => {
    expect(insideWindow({ from: "2026-12-03T12:00:00.000Z", until: "2026-12-03T14:00:00.000Z" }, windows)).toBe(true);
    expect(insideWindow({ from: "2026-12-03T14:00:00.000Z", until: "2026-12-03T15:30:00.000Z" }, windows)).toBe(false);
  });
  it("sees stays and blocks, with the buffer", () => {
    const stays = [stay("2026-12-03", "2026-12-05", "block")];
    const input = { timeZone: "UTC", checkInBufferMinutes: 60 };
    expect(overlapsStay({ from: "2026-12-03T14:00:00.000Z", until: "2026-12-03T14:59:00.000Z" }, stays, input)).toBe(false);
    expect(overlapsStay({ from: "2026-12-03T14:00:00.000Z", until: "2026-12-03T15:30:00.000Z" }, stays, input)).toBe(true);
    expect(overlapsStay({ from: "2026-12-05T11:00:00.000Z", until: "2026-12-05T12:00:00.000Z" }, stays, input)).toBe(false);
  });
});
