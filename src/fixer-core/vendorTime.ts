import { zonedParts } from "../core/timezone";
import { addCalendarDays, zonedInstant } from "../hub/calendar";

/**
 * A routine vendor's new time in their own words (#237): a day and a time range, nothing more. The day is a
 * weekday (the next one on or after the proposed day), a month and day, an m/d, "today" or "tomorrow", or left out
 * (the proposed day). A bare hour 1 to 6 reads as PM and 7 to 11 as AM; an am/pm on one end carries to the other
 * when that keeps the order. Anything else, two ranges, a backwards range or one over 4 hours, is not read: the
 * text goes to the host's agent instead. Vendors are always texted back what was read, so a wrong read is seen.
 */

export const MAX_VENDOR_HOURS = 4;

const WEEKDAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

const ymdOf = (iso: string, timeZone: string): string => {
  const p = zonedParts(new Date(iso), timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};

const weekdayOfYmd = (ymd: string): number => new Date(`${ymd}T12:00:00Z`).getUTCDay();

function validYmd(year: number, month: number, day: number): string | undefined {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return undefined;
  return d.toISOString().slice(0, 10);
}

/** A date with no year: this year's, or next year's when that's already more than a month past. */
function withYear(month: number, day: number, anchorYmd: string): string | undefined {
  const year = Number(anchorYmd.slice(0, 4));
  const here = validYmd(year, month, day);
  if (here && here >= addCalendarDays(anchorYmd, -31)) return here;
  return validYmd(year + 1, month, day);
}

interface Clock {
  hour: number;
  minute: number;
  meridiem?: "am" | "pm";
}

function to24(clock: Clock, meridiem: "am" | "pm" | undefined): number | undefined {
  const { hour } = clock;
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    return (hour % 12) + (meridiem === "pm" ? 12 : 0);
  }
  if (hour >= 13 && hour <= 23) return hour;
  if (hour === 12) return 12;
  if (hour >= 1 && hour <= 6) return hour + 12;
  if (hour >= 7 && hour <= 11) return hour;
  return undefined;
}

const CLOCK = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|a|p)?`;
const RANGE = new RegExp(String.raw`(?<![\d/:])${CLOCK}\s*(?:-|–|to|until|till)\s*${CLOCK}(?![\d/:])`, "gi");

function clockOf(hour: string | undefined, minute: string | undefined, m: string | undefined): Clock | undefined {
  const h = Number(hour);
  const min = minute ? Number(minute) : 0;
  if (!Number.isInteger(h) || min > 59) return undefined;
  const meridiem = m ? (m.toLowerCase().startsWith("a") ? "am" : "pm") : undefined;
  return { hour: h, minute: min, ...(meridiem ? { meridiem } : {}) };
}

/** The day the text names, against the proposed day. Undefined when it names two days or one that doesn't exist. */
function dayOf(text: string, anchorYmd: string): string | undefined | null {
  const days = new Set<string>();
  let bad = false;
  for (const m of text.matchAll(/\b(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday|rsday)?\b/gi)) {
    const want = WEEKDAYS[m[1]!.toLowerCase()]!;
    const gap = (want - weekdayOfYmd(anchorYmd) + 7) % 7;
    days.add(addCalendarDays(anchorYmd, gap));
  }
  for (const m of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi)) {
    const ymd = withYear(MONTHS[m[1]!.toLowerCase()]!, Number(m[2]), anchorYmd);
    if (ymd) days.add(ymd);
    else bad = true;
  }
  for (const m of text.matchAll(/(?<![\d:])(\d{1,2})\/(\d{1,2})(?![\d/:])/g)) {
    const ymd = withYear(Number(m[1]), Number(m[2]), anchorYmd);
    if (ymd) days.add(ymd);
    else bad = true;
  }
  if (/\btoday\b/i.test(text)) days.add(anchorYmd);
  if (/\btomorrow\b/i.test(text)) days.add(addCalendarDays(anchorYmd, 1));
  if (bad || days.size > 1) return null;
  return [...days][0];
}

/**
 * The time a vendor's text names, as ISO instants, or undefined. `anchor` is the proposed visit's start: its day is
 * the one meant when the text names none, and a weekday means the next one on or after it.
 */
export function parseVendorTime(text: string, context: { anchor: string; timeZone: string }): { from: string; until: string } | undefined {
  const anchorYmd = ymdOf(context.anchor, context.timeZone);
  // m/d dates are read before ranges are looked for, so "1/19 9-11" isn't read as a range starting at 19.
  const withoutDates = text.replace(/(?<![\d:])\d{1,2}\/\d{1,2}(?![\d/:])/g, " ");
  const ranges = [...withoutDates.matchAll(RANGE)];
  if (ranges.length !== 1) return undefined;
  const r = ranges[0]!;
  const start = clockOf(r[1], r[2], r[3]);
  const end = clockOf(r[4], r[5], r[6]);
  if (!start || !end) return undefined;
  // One am/pm carries to the other side when that keeps the order; else each side reads on its own.
  let startHour = to24(start, start.meridiem ?? end.meridiem);
  let endHour = to24(end, end.meridiem ?? start.meridiem);
  if (startHour === undefined || endHour === undefined || startHour * 60 + start.minute >= endHour * 60 + end.minute) {
    startHour = to24(start, start.meridiem);
    endHour = to24(end, end.meridiem);
  }
  if (startHour === undefined || endHour === undefined) return undefined;
  const startMin = startHour * 60 + start.minute;
  const endMin = endHour * 60 + end.minute;
  if (endMin <= startMin || endMin - startMin > MAX_VENDOR_HOURS * 60) return undefined;
  const day = dayOf(text, anchorYmd);
  if (day === null) return undefined;
  const ymd = day ?? anchorYmd;
  const hm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return { from: zonedInstant(ymd, hm(startMin), context.timeZone), until: zonedInstant(ymd, hm(endMin), context.timeZone) };
}
