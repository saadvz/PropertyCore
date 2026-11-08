import { addCalendarDays } from "../hub/calendar";

/**
 * When a Supply Core item is due, and the date it has to arrive by. Pure functions over local
 * `YYYY-MM-DD` dates; the caller turns instants into the property's local dates first.
 */

export type Schedule =
  | { kind: "every"; days: number }
  | { kind: "every"; monthlyOn: number }
  | { kind: "bookings"; stays: number }
  | { kind: "custom"; rrule: string; said: string };

const LOOKAHEAD_YEARS = 3;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const FREQS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;
type Freq = (typeof FREQS)[number];

interface Rule {
  freq: Freq;
  interval: number;
  byday: { day: number; nth?: number }[];
  bymonthday: number[];
  bymonth: number[];
  bysetpos: number[];
  count?: number;
  until?: string;
}

function parts(ymd: string): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

function weekday(ymd: string): number {
  const { y, m, d } = parts(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function ymdOf(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

function ints(value: string, min: number, max: number): number[] | undefined {
  const out = value.split(",").map((part) => (/^-?\d+$/.test(part) ? Number(part) : NaN));
  return out.every((n) => Number.isInteger(n) && n !== 0 && Math.abs(n) >= min && Math.abs(n) <= max) ? out : undefined;
}

/** The supported RRULE subset, or a plain-language reason it isn't supported. */
function parseRule(text: string): Rule | string {
  const fields = new Map<string, string>();
  for (const part of text.trim().replace(/^RRULE:/i, "").split(";")) {
    if (!part) continue;
    const [key, value] = part.split("=");
    if (!key || value === undefined || fields.has(key.toUpperCase())) return "That rule isn't one I can read.";
    fields.set(key.toUpperCase(), value.toUpperCase());
  }
  const freq = fields.get("FREQ");
  if (!freq || !(FREQS as readonly string[]).includes(freq)) return "The rule needs a daily, weekly, monthly, or yearly frequency.";
  const rule: Rule = { freq: freq as Freq, interval: 1, byday: [], bymonthday: [], bymonth: [], bysetpos: [] };
  for (const [key, value] of fields) {
    if (key === "FREQ") continue;
    if (key === "INTERVAL") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 365) return "The interval has to be a whole number from 1 to 365.";
      rule.interval = n;
    } else if (key === "BYDAY") {
      for (const item of value.split(",")) {
        const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(item);
        if (!match) return "I can't read that day of the week.";
        const nth = match[1] ? Number(match[1]) : undefined;
        if (nth !== undefined && (nth === 0 || Math.abs(nth) > 5 || (rule.freq !== "MONTHLY" && rule.freq !== "YEARLY"))) return "A numbered weekday works only on a monthly or yearly rule.";
        rule.byday.push({ day: WEEKDAYS.indexOf(match[2] as (typeof WEEKDAYS)[number]), ...(nth !== undefined ? { nth } : {}) });
      }
    } else if (key === "BYMONTHDAY") {
      const days = ints(value, 1, 31);
      if (!days || days.some((n) => n < 0)) return "The day of the month has to be from 1 to 31.";
      rule.bymonthday = days;
    } else if (key === "BYMONTH") {
      const months = ints(value, 1, 12);
      if (!months || months.some((n) => n < 0)) return "The month has to be from 1 to 12.";
      rule.bymonth = months;
    } else if (key === "BYSETPOS") {
      const pos = ints(value, 1, 366);
      if (!pos) return "I can't read that position.";
      rule.bysetpos = pos;
    } else if (key === "COUNT") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) return "The count has to be a whole number.";
      rule.count = n;
    } else if (key === "UNTIL") {
      const match = /^(\d{4})(\d{2})(\d{2})/.exec(value);
      if (!match) return "The end date has to look like 20270101.";
      rule.until = `${match[1]}-${match[2]}-${match[3]}`;
    } else {
      return "That rule uses something I can't schedule. Supply Core schedules whole days only.";
    }
  }
  if (rule.count !== undefined && rule.until !== undefined) return "Use a count or an end date, not both.";
  return rule;
}

/** The days of one period: a day, a Monday-to-Sunday week, a month, or a year. */
function periodDays(rule: Rule, startYmd: string, index: number): string[] {
  const { y, m } = parts(startYmd);
  if (rule.freq === "DAILY") return [addCalendarDays(startYmd, index)];
  if (rule.freq === "WEEKLY") {
    const monday = addCalendarDays(startYmd, -((weekday(startYmd) + 6) % 7) + 7 * index);
    return Array.from({ length: 7 }, (_, i) => addCalendarDays(monday, i));
  }
  if (rule.freq === "MONTHLY") {
    const first = new Date(Date.UTC(y, m - 1 + index, 1));
    const yy = first.getUTCFullYear();
    const mm = first.getUTCMonth() + 1;
    return Array.from({ length: daysInMonth(yy, mm) }, (_, i) => ymdOf(yy, mm, i + 1));
  }
  const year = y + index;
  const out: string[] = [];
  for (let mm = 1; mm <= 12; mm++) for (let dd = 1; dd <= daysInMonth(year, mm); dd++) out.push(ymdOf(year, mm, dd));
  return out;
}

/** True when the date's weekday is the nth (or nth-from-last) of its month or year. */
function nthMatches(ymd: string, nth: number, withinYear: boolean): boolean {
  const { y, m, d } = parts(ymd);
  if (withinYear) {
    const dayOfYear = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86_400_000);
    const total = (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)) / 86_400_000;
    return nth > 0 ? Math.floor(dayOfYear / 7) + 1 === nth : Math.floor((total - 1 - dayOfYear) / 7) + 1 === -nth;
  }
  return nth > 0 ? Math.floor((d - 1) / 7) + 1 === nth : Math.floor((daysInMonth(y, m) - d) / 7) + 1 === -nth;
}

function passes(rule: Rule, ymd: string, startYmd: string): boolean {
  const { m, d } = parts(ymd);
  const start = parts(startYmd);
  if (rule.bymonth.length > 0 && !rule.bymonth.includes(m)) return false;
  if (rule.bymonthday.length > 0 && !rule.bymonthday.includes(d)) return false;
  if (rule.byday.length > 0) {
    const day = weekday(ymd);
    const withinYear = rule.freq === "YEARLY" && rule.bymonth.length === 0;
    if (!rule.byday.some((b) => b.day === day && (b.nth === undefined || nthMatches(ymd, b.nth, withinYear)))) return false;
  }
  const dayGiven = rule.byday.length > 0 || rule.bymonthday.length > 0;
  if (!dayGiven) {
    if (rule.freq === "WEEKLY" && weekday(ymd) !== weekday(startYmd)) return false;
    if (rule.freq === "MONTHLY" && d !== start.d) return false;
    if (rule.freq === "YEARLY" && (d !== start.d || (rule.bymonth.length === 0 && m !== start.m))) return false;
  }
  return true;
}

/** Every occurrence of a rule from its start, in order, up to `endYmd`. The start counts when it matches. */
function* occurrences(rule: Rule, startYmd: string, endYmd: string): Generator<string> {
  const end = endYmd;
  let produced = 0;
  for (let index = 0; ; index += rule.interval) {
    const days = periodDays(rule, startYmd, index);
    if (days[0]! > end) return;
    let candidates = days.filter((day) => day >= startYmd && passes(rule, day, startYmd));
    if (rule.bysetpos.length > 0) {
      const picked = rule.bysetpos.map((pos) => (pos > 0 ? candidates[pos - 1] : candidates[candidates.length + pos])).filter((day): day is string => Boolean(day));
      candidates = [...new Set(picked)].sort();
    }
    for (const day of candidates) {
      if (rule.until && day > rule.until) return;
      if (day > end) return;
      yield day;
      produced += 1;
      if (rule.count !== undefined && produced >= rule.count) return;
    }
  }
}

/** The day of each month from `fromYmd`'s month, on or after `fromYmd`, up to `endYmd`. */
function* monthly(day: number, fromYmd: string, endYmd: string): Generator<string> {
  const { y, m } = parts(fromYmd);
  for (let i = 0; ; i++) {
    const first = new Date(Date.UTC(y, m - 1 + i, 1));
    const date = ymdOf(first.getUTCFullYear(), first.getUTCMonth() + 1, day);
    if (date > endYmd) return;
    if (date >= fromYmd) yield date;
  }
}

function* everyDays(days: number, startYmd: string, endYmd: string): Generator<string> {
  for (let k = 1; ; k++) {
    const date = addCalendarDays(startYmd, k * days);
    if (date > endYmd) return;
    yield date;
  }
}

/** The lookahead: three years past a date. */
const horizon = (ymd: string) => addCalendarDays(ymd, 366 * LOOKAHEAD_YEARS);

/** A plain-language refusal, or undefined when the schedule is valid. `todayYmd` is the property's local date. */
export function scheduleProblem(schedule: Schedule, todayYmd: string): string | undefined {
  if (schedule.kind === "every" && "days" in schedule) {
    return Number.isInteger(schedule.days) && schedule.days >= 1 && schedule.days <= 365 ? undefined : "Every so many days has to be from 1 to 365.";
  }
  if (schedule.kind === "every") {
    return Number.isInteger(schedule.monthlyOn) && schedule.monthlyOn >= 1 && schedule.monthlyOn <= 28 ? undefined : "The day of the month has to be from 1 to 28.";
  }
  if (schedule.kind === "bookings") {
    return Number.isInteger(schedule.stays) && schedule.stays >= 1 && schedule.stays <= 50 ? undefined : "Every so many stays has to be from 1 to 50.";
  }
  const rule = parseRule(schedule.rrule);
  if (typeof rule === "string") return rule;
  for (const day of occurrences(rule, todayYmd, horizon(todayYmd))) if (day > todayYmd) return undefined;
  return "That rule never comes up again.";
}

/** The next `count` dates strictly after `afterYmd`. Bookings use the checkouts on which each count is reached. */
export function nextDates(schedule: Schedule, startYmd: string, afterYmd: string, count: number, checkouts: readonly string[] = []): string[] {
  const out: string[] = [];
  if (schedule.kind === "bookings") {
    const later = [...checkouts].filter((day) => day > afterYmd).sort();
    for (let i = schedule.stays - 1; i < later.length && out.length < count; i += schedule.stays) out.push(later[i]!);
    return out;
  }
  for (const day of dates(schedule, startYmd, afterYmd, horizon(afterYmd > startYmd ? afterYmd : startYmd))) {
    if (day > afterYmd) out.push(day);
    if (out.length >= count) break;
  }
  return out;
}

/**
 * A schedule's dates from `startYmd` up to `endYmd`. `fromYmd` lets a monthly schedule skip the
 * months before it; a custom rule always runs from its start, so COUNT and INTERVAL stay right.
 */
function dates(schedule: Exclude<Schedule, { kind: "bookings" }>, startYmd: string, fromYmd: string, endYmd: string): Iterable<string> {
  if (schedule.kind === "custom") {
    const rule = parseRule(schedule.rrule);
    return typeof rule === "string" ? [] : occurrences(rule, startYmd, endYmd);
  }
  if ("days" in schedule) return everyDays(schedule.days, startYmd, endYmd);
  return monthly(schedule.monthlyOn, fromYmd > startYmd ? fromYmd : startYmd, endYmd);
}

export interface DueInput {
  schedule: Schedule;
  /** The later of the last order and the last skip. */
  anchorYmd?: string;
  /** The item's save date or Activate, whichever is later. */
  startYmd: string;
  todayYmd: string;
  checkouts: readonly string[];
  lowReported: boolean;
}

export function dueOn(input: DueInput): { due: boolean; why?: "schedule" | "report"; occurrenceYmd?: string } {
  if (input.lowReported) return { due: true, why: "report" };
  const { schedule, anchorYmd, startYmd, todayYmd } = input;
  if (schedule.kind === "every" && "days" in schedule) {
    if (!anchorYmd) return { due: true, why: "schedule", occurrenceYmd: todayYmd };
    const next = addCalendarDays(anchorYmd, schedule.days);
    return next <= todayYmd ? { due: true, why: "schedule", occurrenceYmd: next } : { due: false };
  }
  if (schedule.kind === "bookings") {
    const after = anchorYmd ?? addCalendarDays(startYmd, -1);
    const stays = input.checkouts.filter((day) => day > after && day <= todayYmd).length;
    return stays >= schedule.stays ? { due: true, why: "schedule", occurrenceYmd: todayYmd } : { due: false };
  }
  const after = anchorYmd ?? addCalendarDays(startYmd, -1);
  let latest: string | undefined;
  for (const day of dates(schedule, startYmd, after, todayYmd)) {
    if (day > todayYmd) break;
    if (day > after) latest = day;
  }
  return latest ? { due: true, why: "schedule", occurrenceYmd: latest } : { due: false };
}

/** The date an order has to arrive by. */
export function deadlineFor(input: { todayYmd: string; occurrenceYmd?: string; bufferDays: number; nextCleaningYmd?: string }): string {
  const { todayYmd, nextCleaningYmd } = input;
  if (nextCleaningYmd) {
    return nextCleaningYmd <= addCalendarDays(todayYmd, 1) ? (nextCleaningYmd < todayYmd ? todayYmd : nextCleaningYmd) : addCalendarDays(nextCleaningYmd, -1);
  }
  const from = input.occurrenceYmd && input.occurrenceYmd > todayYmd ? input.occurrenceYmd : todayYmd;
  return addCalendarDays(from, input.bufferDays);
}
