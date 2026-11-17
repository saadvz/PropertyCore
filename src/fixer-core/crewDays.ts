import { WEEKDAYS, weekdayOf, type Weekday } from "../core/timezone.js";
import { addCalendarDays, zonedInstant } from "../hub/calendar.js";
import type { Stay } from "../hub/store.js";
import { daysBetween, isDay, MAX_BLOCK_DAYS } from "./repairBlock.js";
import { busyTimes, type OccupyInput } from "./window.js";

/**
 * A crew's workdays and hours on a multi-day job (#243), as one window per workday. Pure. A window never touches a
 * guest stay; the caller passes `staysForCrew(...)` so the repair block's own calendar block doesn't count.
 */

export interface CrewSchedule {
  firstDay: string;
  /** Inclusive. */
  lastDay: string;
  workdays: Weekday[];
  /** 24-hour local "HH:MM"; start is before end, so no overnight shifts. */
  start: string;
  end: string;
  /** Days off inside the range, like a holiday. */
  skipDays?: string[];
}

export interface CrewWindow {
  day: string;
  from: string;
  until: string;
}

export interface CrewConflict {
  day: string;
  why: "clipped" | "dropped";
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const MINUTE_MS = 60_000;

/** Why this crew schedule can't be saved, or undefined when it can. */
export function crewScheduleProblem(schedule: CrewSchedule, todayYmd: string): string | undefined {
  const { firstDay, lastDay, workdays, start, end, skipDays } = schedule;
  if (!isDay(firstDay) || !isDay(lastDay)) return "Give the first and last day as dates, like 2026-12-07.";
  if (firstDay < todayYmd) return "A crew schedule can't start before today.";
  if (lastDay < firstDay) return "The last day can't be before the first.";
  if (addCalendarDays(firstDay, MAX_BLOCK_DAYS - 1) < lastDay) return `A crew schedule can be at most ${MAX_BLOCK_DAYS} days.`;
  if (!Array.isArray(workdays) || workdays.length === 0) return "Give at least one workday, like MON.";
  if (!workdays.every((d) => (WEEKDAYS as readonly string[]).includes(d))) return "Give workdays as MON, TUE, WED, THU, FRI, SAT or SUN.";
  if (!CLOCK.test(start) || !CLOCK.test(end)) return "Give the crew's hours as 24-hour times, like 08:00 to 17:00.";
  if (start >= end) return "The crew's hours must start before they end, on the same day.";
  if (skipDays !== undefined && !(Array.isArray(skipDays) && skipDays.every((d) => isDay(d) && d >= firstDay && d <= lastDay))) return "Each day off must be a date inside the schedule.";
  return undefined;
}

/** One window per workday, cut around guest stays, with the days a stay changed. */
export function crewWindows(schedule: CrewSchedule, input: OccupyInput & { stays: readonly Stay[] }): { windows: CrewWindow[]; conflicts: CrewConflict[] } {
  const busy = busyTimes(input.stays, input);
  const skip = new Set(schedule.skipDays ?? []);
  const windows: CrewWindow[] = [];
  const conflicts: CrewConflict[] = [];
  for (const day of daysBetween(schedule.firstDay, schedule.lastDay)) {
    const [year, month, date] = day.split("-").map(Number) as [number, number, number];
    if (skip.has(day) || !schedule.workdays.includes(weekdayOf({ year, month, day: date }))) continue;
    const from = Date.parse(zonedInstant(day, schedule.start, input.timeZone));
    const until = Date.parse(zonedInstant(day, schedule.end, input.timeZone));
    let pieces = [{ from, until }];
    for (const b of busy) {
      pieces = pieces.flatMap((p) => {
        if (b.end <= p.from || b.start >= p.until) return [p];
        return [
          { from: p.from, until: b.start },
          { from: b.end, until: p.until },
        ].filter((q) => q.until > q.from);
      });
    }
    const changed = pieces.length !== 1 || pieces[0]!.from !== from || pieces[0]!.until !== until;
    if (changed) conflicts.push({ day, why: pieces.length === 0 ? "dropped" : "clipped" });
    for (const p of pieces) windows.push({ day, from: new Date(p.from).toISOString(), until: new Date(p.until).toISOString() });
  }
  return { windows, conflicts };
}

/** The window open now, from `earlyMinutes` before its start until its end. */
export function crewWindowAt(windows: readonly CrewWindow[], now: Date, earlyMinutes = 30): CrewWindow | undefined {
  const t = now.getTime();
  return windows.find((w) => Date.parse(w.from) - earlyMinutes * MINUTE_MS <= t && t < Date.parse(w.until));
}
