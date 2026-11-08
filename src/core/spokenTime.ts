/**
 * A clock time a person named in a message. The hour is 1–12. Meridiem and
 * day are set only when the words said them. Nothing here decides whether
 * that time is bookable.
 */

import { isBeyondBookingHorizon } from "./schedule";
import type { LocalDate, Weekday } from "./timezone";

export interface SpokenTime {
  hour: number;
  minute: number;
  meridiem?: "AM" | "PM";
  day?: "today" | "tomorrow";
  weekday?: Weekday;
  /** "next Monday" means the following one, not today if today is Monday. */
  nextWeek?: boolean;
  /** Concrete calendar date when the visitor named one next to the clock ("oct 6 at 12 pm"). */
  date?: LocalDate;
}

const CLOCK =
  /(?:^|\s)(?:(at|around|about|for|by)\s+)?(?<!\d)(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm|a m|p m|o'?clock))?(?!\d)(?=\s|$)/g;

/** Every distinct clock time in already-normalized text. "1" alone is not a time; "3:15" and "at 3" are. */
export function spokenTimes(normalized: string, today?: LocalDate): SpokenTime[] {
  const day = /\b(?:tomorrow|tmrw|tmr)\b/.test(normalized) ? "tomorrow" : /\btoday\b/.test(normalized) ? "today" : undefined;
  const found: SpokenTime[] = [];
  for (const match of normalized.matchAll(CLOCK)) {
    const lead = match[1];
    const hour = Number(match[2]);
    const minutes = match[3];
    const suffix = match[4];
    if (!minutes && !suffix && !lead) continue;
    if (hour < 1 || hour > 12) continue;
    const minute = minutes ? Number(minutes) : 0;
    if (minute > 59) continue;
    const meridiem = suffix && !suffix.startsWith("o") ? (suffix.startsWith("a") ? "AM" : "PM") : undefined;
    const asked = dayReference(normalized, today);
    const named = asked && asked !== "menu" ? asked : undefined;
    const fromWord = !named?.weekday && !named?.date && !day ? weekdayOfText(normalized) : undefined;
    const weekday = named?.weekday ?? fromWord?.day;
    const nextWeek = named?.nextWeek || fromWord?.next || undefined;
    const key = `${hour}:${minute}:${meridiem ?? ""}:${day ?? ""}:${weekday ?? ""}:${named?.date ? `${named.date.year}-${named.date.month}-${named.date.day}` : ""}`;
    if (found.some((item) => `${item.hour}:${item.minute}:${item.meridiem ?? ""}:${item.day ?? ""}:${item.weekday ?? ""}:${item.date ? `${item.date.year}-${item.date.month}-${item.date.day}` : ""}` === key)) continue;
    found.push({
      hour,
      minute,
      ...(meridiem ? { meridiem } : {}),
      ...(day ? { day } : {}),
      ...(weekday ? { weekday } : {}),
      ...(nextWeek ? { nextWeek: true } : {}),
      ...(named?.date ? { date: named.date } : {}),
    });
  }
  return found;
}

/** A change of time with no clock ("I need a later time"). */
export function vagueTimeRequest(normalized: string): boolean {
  return /\b(later time|another time|different time|need a later|something later|come later|later today|move it later|a later one)\b/.test(normalized);
}

export const WEEKDAY_WORD: Readonly<Record<string, Weekday>> = {
  monday: "MON",
  mon: "MON",
  tuesday: "TUE",
  tues: "TUE",
  tue: "TUE",
  wednesday: "WED",
  wed: "WED",
  thursday: "THU",
  thurs: "THU",
  thur: "THU",
  thu: "THU",
  friday: "FRI",
  fri: "FRI",
  saturday: "SAT",
  sat: "SAT",
  sunday: "SUN",
  sun: "SUN",
};

/** Longer names first so "monday" wins over "mon" and "thursday" wins over "thu". */
const WEEKDAY_NAMES = "monday|tuesday|wednesday|thursday|friday|saturday|sunday|thurs|thur|tues|mon|tue|wed|thu|fri|sat|sun";

export interface DayReference {
  weekday?: Weekday;
  relative?: "today" | "tomorrow" | "weekend";
  nextWeek?: boolean;
  /** Concrete property-local calendar date, when the visitor named one. */
  date?: LocalDate;
  /** They asked for a day, but the date could not be resolved ("the 45th"). */
  unclear?: boolean;
}

/**
 * A day the visitor named, or a general availability ask, in already-normalized
 * text. `today` is the property-local date so a year-less calendar date
 * ("Dec 1") becomes the next occurrence on or after today. A this-year date
 * that has already passed is kept as that past date when next year would be
 * beyond the booking horizon — so the visitor hears it already passed, not
 * that it is too far ahead.
 */
export function dayReference(normalized: string, today?: LocalDate): DayReference | "menu" | undefined {
  if (/\b(this )?weekend\b/.test(normalized)) return { relative: "weekend" };
  if (/\b(?:tomorrow|tmrw|tmr)\b/.test(normalized)) return { relative: "tomorrow", ...weekdayFields(normalized) };
  if (/\btoday\b/.test(normalized)) return { relative: "today", ...weekdayFields(normalized) };
  const calendar = calendarDateOf(normalized, today);
  if (calendar) return calendar;
  const weekday = weekdayOfText(normalized);
  if (weekday) {
    const scheduling =
      /\b(what about|how about|anything|available|availability|what times|which times|do you have|can i come|could i come|can i tour|can we tour|can i visit|can we visit|can i do|could i do|can we do|could we do|can i make|could i make|can we make|instead|move it|move to|change to|change it|reschedule)\b/.test(
        normalized,
      ) ||
      /\bwould\b.+\bwork\b/.test(normalized) ||
      normalized.split(" ").length <= 4;
    if (!scheduling) return undefined;
    return { weekday: weekday.day, ...(weekday.next ? { nextWeek: true } : {}) };
  }
  if (unclearDateAttempt(normalized)) return { unclear: true };
  if (
    /\b(what availability|any availability|which days|what days|when are you available|when can i (come|tour|visit)|can i come|could i come|can we come|could we come|can i tour|can i visit|availability do you have)\b/.test(
      normalized,
    )
  ) {
    return "menu";
  }
  return undefined;
}

export const MONTH_NUMBER: Readonly<Record<string, number>> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const MONTH_WORD = Object.keys(MONTH_NUMBER)
  .sort((a, b) => b.length - a.length)
  .join("|");
const DAY_TOKEN = String.raw`(?:3[01]|[12]\d|0?[1-9])(?:st|nd|rd|th)?`;
const MONTH_TOKEN = `(?:${MONTH_WORD})`;
const YEAR_TOKEN = String.raw`(?:\d{4}|\d{2})`;
const WEEKDAY_TOKEN = WEEKDAY_NAMES;

const MONTH_THEN_DAY = new RegExp(`\\b(?:(${WEEKDAY_TOKEN})\\s+)?(${MONTH_TOKEN})\\s+(${DAY_TOKEN})(?:\\s+(${YEAR_TOKEN}))?\\b`);
const DAY_THEN_MONTH = new RegExp(`\\b(?:(${WEEKDAY_TOKEN})\\s+)?(${DAY_TOKEN})\\s+(${MONTH_TOKEN})(?:\\s+(${YEAR_TOKEN}))?\\b`);
const NUMERIC_DATE = new RegExp(`\\b(?:(${WEEKDAY_TOKEN})\\s+)?(1[0-2]|0?[1-9])\\s+(${DAY_TOKEN})(?:\\s+(${YEAR_TOKEN}))?\\b`);
const NUMERIC_ONLY = new RegExp(`^(1[0-2]|0?[1-9])\\s+(${DAY_TOKEN})(?:\\s+(${YEAR_TOKEN}))?$`);
const NUMERIC_SCHEDULING =
  /\b(what about|how about|anything|available|availability|what times|which times|do you have|can i come|could i come|can i do|could i do|can we do|could we do|can i make|could i make|instead|come|tour|visit|book|on|would)\b/;

function calendarDateOf(normalized: string, today?: LocalDate): DayReference | undefined {
  const named = MONTH_THEN_DAY.exec(normalized) ?? DAY_THEN_MONTH.exec(normalized);
  if (named) {
    const weekdayWord = named[1];
    const monthFirst = MONTH_NUMBER[named[2]!] !== undefined;
    const month = monthFirst ? MONTH_NUMBER[named[2]!]! : MONTH_NUMBER[named[3]!]!;
    const day = parseDay(monthFirst ? named[3]! : named[2]!);
    const yearToken = named[4];
    const date = resolveCalendarDate(today, month, day, yearToken);
    if (!date) return { unclear: true };
    return { date, ...(weekdayWord ? { weekday: WEEKDAY_WORD[weekdayWord] } : {}) };
  }

  const numeric = NUMERIC_DATE.exec(normalized);
  if (!numeric) return undefined;
  const onlyDate = NUMERIC_ONLY.test(normalized);
  if (!onlyDate && !NUMERIC_SCHEDULING.test(normalized)) return undefined;
  const weekdayWord = numeric[1];
  const month = Number(numeric[2]);
  const day = parseDay(numeric[3]!);
  const date = resolveCalendarDate(today, month, day, numeric[4]);
  if (!date) return { unclear: true };
  return { date, ...(weekdayWord ? { weekday: WEEKDAY_WORD[weekdayWord] } : {}) };
}

const UNCLEAR_DATE =
  /\b(sometime|next month|this month|end of (the )?month|later this month|early next month|in a few (days|weeks)|in a month)\b|\bthe (?:3[2-9]|[4-9]\d|\d{3,})(?:st|nd|rd|th)?\b/;
const BOOKING_ASK =
  /\b(can i come|could i come|can we come|could we come|can i tour|can i visit|can we tour|can we visit|when can i (come|tour|visit))\b/;

function unclearDateAttempt(normalized: string): boolean {
  if (UNCLEAR_DATE.test(normalized)) return true;
  if (new RegExp(`\\b(?:in|this|next)\\s+(${MONTH_WORD})\\b`).test(normalized)) return true;
  return BOOKING_ASK.test(normalized) && new RegExp(`\\b(?!may\\b)(${MONTH_WORD})\\b`).test(normalized);
}

function parseDay(token: string): number {
  return Number(token.replace(/(?:st|nd|rd|th)$/, ""));
}

function parseYear(token: string): number {
  return token.length === 2 ? 2000 + Number(token) : Number(token);
}

function resolveCalendarDate(today: LocalDate | undefined, month: number, day: number, yearToken?: string): LocalDate | undefined {
  if (yearToken) {
    const year = parseYear(yearToken);
    return isValidYmd(year, month, day) ? { year, month, day } : undefined;
  }
  if (!today) return undefined;
  return nextOnOrAfter(today, month, day);
}

function nextOnOrAfter(today: LocalDate, month: number, day: number): LocalDate | undefined {
  const thisYear = isValidYmd(today.year, month, day) ? { year: today.year, month, day } : undefined;
  const nextYear = isValidYmd(today.year + 1, month, day) ? { year: today.year + 1, month, day } : undefined;
  if (thisYear && !isBefore(thisYear, today)) return thisYear;
  if (nextYear && !isBeyondBookingHorizon(today, nextYear)) return nextYear;
  return thisYear ?? nextYear;
}

/** True when the text names a tour day (calendar date, weekday, today/tomorrow), not a bare yes. */
export function namesTourDay(normalized: string, today?: LocalDate): boolean {
  const asked = dayReference(normalized, today);
  return !!asked && asked !== "menu";
}

function isBefore(a: LocalDate, b: LocalDate): boolean {
  return a.year < b.year || (a.year === b.year && a.month < b.month) || (a.year === b.year && a.month === b.month && a.day < b.day);
}

function isValidYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const t = new Date(Date.UTC(year, month - 1, day));
  return t.getUTCFullYear() === year && t.getUTCMonth() === month - 1 && t.getUTCDate() === day;
}

function weekdayFields(normalized: string): Pick<DayReference, "weekday" | "nextWeek"> {
  const weekday = weekdayOfText(normalized);
  return weekday ? { weekday: weekday.day, ...(weekday.next ? { nextWeek: true } : {}) } : {};
}

function weekdayOfText(normalized: string): { day: Weekday; next: boolean } | undefined {
  const match = normalized.match(new RegExp(`\\b(next\\s+)?(${WEEKDAY_NAMES})\\b`));
  if (!match) return undefined;
  return { day: WEEKDAY_WORD[match[2]!]!, next: !!match[1] };
}
