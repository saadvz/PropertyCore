import { describe, expect, it } from "vitest";
import type { Stay } from "../src/hub/store.js";
import { doorFor, nightsOf, repairBlockProblem, repairBlockStatus, staysForCrew } from "../src/fixer-core/repairBlock.js";
import { visitWindows, type OccupyInput } from "../src/fixer-core/window.js";

const stay = (checkIn: string, checkout: string, kind: Stay["kind"] = "stay"): Stay => ({ checkIn, checkout, kind });
const repair = { firstDay: "2026-12-05", lastDay: "2026-12-09" };
const times: OccupyInput = { timeZone: "UTC", checkInBufferMinutes: 60 };
const TODAY = "2026-12-01";

describe("repairBlockProblem", () => {
  it("accepts a block from today on", () => {
    expect(repairBlockProblem(repair, TODAY)).toBeUndefined();
  });

  it("refuses a date that isn't a real day", () => {
    expect(repairBlockProblem({ firstDay: "2026-13-01", lastDay: "2026-13-02" }, TODAY)).toBeDefined();
    expect(repairBlockProblem({ firstDay: "2026-02-30", lastDay: "2026-03-02" }, "2026-01-01")).toBeDefined();
  });

  it("refuses a block that starts before today", () => {
    expect(repairBlockProblem({ firstDay: "2026-11-30", lastDay: "2026-12-03" }, TODAY)).toBeDefined();
  });

  it("refuses a last day before the first", () => {
    expect(repairBlockProblem({ firstDay: "2026-12-09", lastDay: "2026-12-05" }, TODAY)).toBeDefined();
  });

  it("takes up to 92 days and no more", () => {
    expect(repairBlockProblem({ firstDay: "2026-12-01", lastDay: "2027-03-02" }, TODAY)).toBeUndefined();
    expect(repairBlockProblem({ firstDay: "2026-12-01", lastDay: "2027-03-03" }, TODAY)).toBeDefined();
  });
});

describe("repairBlockStatus", () => {
  it("lists every night as open when the calendar has nothing", () => {
    expect(nightsOf(repair)).toEqual(["2026-12-05", "2026-12-06", "2026-12-07", "2026-12-08", "2026-12-09"]);
    expect(repairBlockStatus(repair, [])).toEqual({ onCalendar: false, openNights: nightsOf(repair), collisions: [] });
  });

  it("is on the calendar when a calendar block closes every night", () => {
    expect(repairBlockStatus(repair, [stay("2026-12-05", "2026-12-10", "block")])).toEqual({ onCalendar: true, openNights: [], collisions: [] });
  });

  it("counts blocks from two calendars together", () => {
    const stays = [stay("2026-12-05", "2026-12-07", "block"), stay("2026-12-07", "2026-12-10", "block")];
    expect(repairBlockStatus(repair, stays).onCalendar).toBe(true);
  });

  it("names the nights a partial block leaves open", () => {
    expect(repairBlockStatus(repair, [stay("2026-12-05", "2026-12-08", "block")])).toMatchObject({ onCalendar: false, openNights: ["2026-12-08", "2026-12-09"] });
  });

  it("lists a guest stay holding one of its nights as a collision, and doesn't count it as closing the night", () => {
    const guest = stay("2026-12-08", "2026-12-12");
    const status = repairBlockStatus(repair, [stay("2026-12-05", "2026-12-08", "block"), guest]);
    expect(status.collisions).toEqual([guest]);
    expect(status.openNights).toEqual(["2026-12-08", "2026-12-09"]);
  });

  it("doesn't count a stay leaving on the first day or arriving after the last as a collision", () => {
    const stays = [stay("2026-12-01", "2026-12-05"), stay("2026-12-10", "2026-12-12")];
    expect(repairBlockStatus(repair, stays).collisions).toEqual([]);
  });
});

describe("staysForCrew", () => {
  it("drops the calendar block that is the repair block", () => {
    expect(staysForCrew([stay("2026-12-05", "2026-12-10", "block")], [repair])).toEqual([]);
  });

  it("keeps the parts of a wider block outside the repair block", () => {
    expect(staysForCrew([stay("2026-12-03", "2026-12-12", "block")], [repair])).toEqual([stay("2026-12-03", "2026-12-05", "block"), stay("2026-12-10", "2026-12-12", "block")]);
  });

  it("leaves guest stays and unrelated blocks as they are", () => {
    const stays = [stay("2026-12-08", "2026-12-12"), stay("2026-12-20", "2026-12-22", "block")];
    expect(staysForCrew(stays, [repair])).toEqual(stays);
  });

  it("lets visitWindows find time inside the repair block", () => {
    const base = { stays: [], timeZone: "UTC", checkInBufferMinutes: 60, cleaningMinutes: 180, cleanings: new Map(), now: new Date("2026-12-01T00:00:00Z"), lastYmd: "2026-12-09" };
    const calendar = [stay("2026-12-05", "2026-12-10", "block")];
    expect(visitWindows({ ...base, stays: staysForCrew(calendar, [repair]) })).toEqual([{ from: "2026-12-01T00:00:00.000Z", until: "2026-12-10T00:00:00.000Z" }]);
    expect(visitWindows({ ...base, stays: calendar })[0]!.until).toBe("2026-12-05T15:00:00.000Z");
  });
});

describe("doorFor", () => {
  const onCalendar = [stay("2026-12-05", "2026-12-10", "block")];

  it("is the crew's on a repair day once the block is on the calendar", () => {
    expect(doorFor(new Date("2026-12-06T12:00:00Z"), [repair], onCalendar, times)).toBe("crew");
  });

  it("is no one's on a repair day while the block isn't on the calendar", () => {
    expect(doorFor(new Date("2026-12-06T12:00:00Z"), [repair], [], times)).toBe("none");
  });

  it("stays the guests' when a guest stay sits inside the block", () => {
    const stays = [...onCalendar, stay("2026-12-06", "2026-12-07")];
    expect(doorFor(new Date("2026-12-06T18:00:00Z"), [repair], stays, times)).toBe("guests");
  });

  it("is the guests' during a stay and no one's otherwise", () => {
    const stays = [...onCalendar, stay("2026-12-14", "2026-12-16")];
    expect(doorFor(new Date("2026-12-15T12:00:00Z"), [repair], stays, times)).toBe("guests");
    expect(doorFor(new Date("2026-12-12T12:00:00Z"), [repair], stays, times)).toBe("none");
  });
});
