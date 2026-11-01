import type { TourWindow } from "../config/tourCoreConfig";
import { WEEKDAYS, type Weekday } from "./timezone";

/**
 * Touring hours can differ by day (weekdays 9-5, weekends 9-8). A property
 * file stores them as `windows`; older files hold one window in
 * `days`/`start`/`end`. Everything that asks "when can people tour on this
 * day?" goes through here, so both shapes read the same way.
 */
type HoursLike = { days: readonly Weekday[]; start: string; end: string; windows?: readonly TourWindow[] };

/** Monday first, the order hosts say days in. */
const SPOKEN_ORDER: readonly Weekday[] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

function sortDays(days: readonly Weekday[]): Weekday[] {
  return WEEKDAYS.filter((day) => days.includes(day));
}

function firstSpokenDay(days: readonly Weekday[]): number {
  const found = SPOKEN_ORDER.findIndex((day) => days.includes(day));
  return found < 0 ? SPOKEN_ORDER.length : found;
}

/** Each window with its days, earliest day (Monday first) first. A file with no `windows` is one window. */
export function tourWindows(hours: HoursLike): TourWindow[] {
  const list = hours.windows?.length ? hours.windows : [{ days: hours.days, start: hours.start, end: hours.end }];
  return list.map((w) => ({ days: sortDays(w.days), start: w.start, end: w.end })).sort((a, b) => firstSpokenDay(a.days) - firstSpokenDay(b.days));
}

/** The hours on one weekday, or undefined when that day has no tours. */
export function windowOn(hours: HoursLike, day: Weekday): { start: string; end: string } | undefined {
  const found = tourWindows(hours).find((w) => w.days.includes(day));
  return found ? { start: found.start, end: found.end } : undefined;
}

/**
 * Tidy windows and write them back in the stored shape: days listed once,
 * empty windows dropped, windows with the same hours joined. One window is
 * stored the old way (no `windows`), so a property with one set of hours
 * looks exactly like it always did.
 */
export function withTourWindows<T extends HoursLike>(hours: T, windows: readonly TourWindow[]): T {
  const joined: TourWindow[] = [];
  const taken = new Set<Weekday>();
  for (const w of windows) {
    const days = sortDays(w.days).filter((day) => !taken.has(day));
    if (!days.length) continue;
    days.forEach((day) => taken.add(day));
    const same = joined.find((j) => j.start === w.start && j.end === w.end);
    if (same) same.days = sortDays([...same.days, ...days]);
    else joined.push({ days, start: w.start, end: w.end });
  }
  joined.sort((a, b) => firstSpokenDay(a.days) - firstSpokenDay(b.days));
  const next = { ...hours } as T;
  delete next.windows;
  if (joined.length === 0) return { ...next, days: [] };
  const first = joined[0]!;
  if (joined.length === 1) return { ...next, days: first.days, start: first.start, end: first.end };
  return { ...next, days: sortDays(joined.flatMap((w) => w.days)), start: first.start, end: first.end, windows: joined };
}

/** Adds or changes the hours for some days. Days not named keep the hours they had. */
export function mergeTourWindow<T extends HoursLike>(hours: T, window: TourWindow): T {
  const kept = tourWindows(hours).map((w) => ({ ...w, days: w.days.filter((day) => !window.days.includes(day)) }));
  return withTourWindows(hours, [window, ...kept]);
}
