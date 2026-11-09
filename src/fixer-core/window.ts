import { addCalendarDays, zonedInstant } from "../hub/calendar.js";
import type { Stay } from "../hub/store.js";
import type { Job } from "./store.js";

const DEFAULT_CHECKOUT = "11:00";
const DEFAULT_CHECK_IN = "16:00";
const MINUTE_MS = 60_000;

export interface WindowInput {
  stays: readonly Stay[];
  timeZone: string;
  checkoutTime?: string;
  checkInTime?: string;
  checkInBufferMinutes: number;
  cleaningMinutes: number;
  /** Keyed by checkout local date (YYYY-MM-DD). */
  cleanings: ReadonlyMap<string, { doneAt?: string }>;
  cleaningOrder?: "before" | "after";
  now: Date;
  lastYmd: string;
}

/** A time a pro can visit, as ISO instants. */
export interface VisitWindow {
  from: string;
  until: string;
  checkoutYmd?: string;
  cleaning?: { order?: "before" | "after"; doneKnown: boolean };
}

type OccupyInput = Pick<WindowInput, "timeZone" | "checkoutTime" | "checkInTime" | "checkInBufferMinutes">;

interface Occupied {
  start: number;
  end: number;
  /** Checkout local date of the stay that ends last in this stretch. */
  checkoutYmd: string;
}

/** The local date of an instant in a time zone. */
function localYmd(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** The latest day to look for a window: the job's date, else 14 days (now, soon) or 30 (flexible). */
export function latestYmd(job: Pick<Job, "urgency" | "byDate">, todayYmd: string): string {
  if (job.urgency === "by-date" && job.byDate) return job.byDate;
  return addCalendarDays(todayYmd, job.urgency === "flexible" ? 30 : 14);
}

/** Each stay or block as busy time: from check-in minus the buffer until checkout. */
function occupiedOf(stays: readonly Stay[], input: OccupyInput): Occupied[] {
  const checkout = input.checkoutTime ?? DEFAULT_CHECKOUT;
  const checkIn = input.checkInTime ?? DEFAULT_CHECK_IN;
  return stays.map((stay) => ({
    start: Date.parse(zonedInstant(stay.checkIn, checkIn, input.timeZone)) - input.checkInBufferMinutes * MINUTE_MS,
    end: Date.parse(zonedInstant(stay.checkout, checkout, input.timeZone)),
    checkoutYmd: stay.checkout,
  }));
}

/** Busy time with overlapping and touching entries joined, in order. */
function mergeOccupied(list: Occupied[]): Occupied[] {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const merged: Occupied[] = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && item.start <= last.end) {
      if (item.end > last.end) {
        last.end = item.end;
        last.checkoutYmd = item.checkoutYmd;
      }
    } else {
      merged.push({ ...item });
    }
  }
  return merged;
}

/** The free stretches between stays, from today through lastYmd, with cleaning applied. */
export function visitWindows(input: WindowInput): VisitWindow[] {
  const rangeStart = Math.max(
    Date.parse(zonedInstant(localYmd(input.now, input.timeZone), "00:00", input.timeZone)),
    input.now.getTime(),
  );
  const rangeEnd = Date.parse(zonedInstant(addCalendarDays(input.lastYmd, 1), "00:00", input.timeZone));
  const busy = mergeOccupied(occupiedOf(input.stays, input));
  const windows: VisitWindow[] = [];
  let cursor = rangeStart;
  let cleaningDate: string | undefined;
  let checkoutAt = rangeStart;
  let gapStart = rangeStart;
  const close = (gapEnd: number) => {
    const window = buildWindow(input, gapStart, gapEnd, checkoutAt, cleaningDate);
    if (window) windows.push(window);
  };
  for (const item of busy) {
    if (item.end <= cursor) {
      checkoutAt = item.end;
      cleaningDate = item.checkoutYmd;
      continue;
    }
    if (item.start >= rangeEnd) break;
    if (item.start > cursor) close(item.start);
    cursor = item.end;
    gapStart = item.end;
    checkoutAt = item.end;
    cleaningDate = item.checkoutYmd;
  }
  if (cursor < rangeEnd) close(rangeEnd);
  return windows;
}

/** One gap as a window, shaped by the cleaning that follows the checkout it starts at. */
function buildWindow(input: WindowInput, gapStart: number, gapEnd: number, checkoutAt: number, checkoutYmd?: string): VisitWindow | undefined {
  const lowest = Math.max(gapStart, input.now.getTime());
  const entry = checkoutYmd ? input.cleanings.get(checkoutYmd) : undefined;
  if (!checkoutYmd || !entry) return clipped(lowest, gapEnd);
  const cleanedBy = checkoutAt + input.cleaningMinutes * MINUTE_MS;
  const doneAt = entry.doneAt ? Date.parse(entry.doneAt) : NaN;
  const doneKnown = Number.isFinite(doneAt);
  let from = lowest;
  let until = gapEnd;
  if (input.cleaningOrder === "after") from = Math.max(lowest, doneKnown ? doneAt : cleanedBy);
  if (input.cleaningOrder === "before") until = Math.min(cleanedBy, gapEnd);
  const base = clipped(from, until);
  if (!base) return undefined;
  return { ...base, checkoutYmd, cleaning: { order: input.cleaningOrder, doneKnown } };
}

function clipped(from: number, until: number): VisitWindow | undefined {
  if (until <= from) return undefined;
  return { from: new Date(from).toISOString(), until: new Date(until).toISOString() };
}

/** True when the span sits fully inside one window. */
export function insideWindow(span: { from: string; until: string }, windows: readonly VisitWindow[]): boolean {
  const from = Date.parse(span.from);
  const until = Date.parse(span.until);
  return windows.some((w) => Date.parse(w.from) <= from && until <= Date.parse(w.until));
}

/** True when the span touches any stay or block, in local check-in and checkout times. */
export function overlapsStay(span: { from: string; until: string }, stays: readonly Stay[], input: OccupyInput): boolean {
  const from = Date.parse(span.from);
  const until = Date.parse(span.until);
  return occupiedOf(stays, input).some((o) => from < o.end && until > o.start);
}

/** The first check-in after an instant, as epoch ms, or undefined when no stay starts later. */
export function nextCheckIn(after: number, stays: readonly Stay[], input: Pick<WindowInput, "timeZone" | "checkInTime">): number | undefined {
  const time = input.checkInTime ?? DEFAULT_CHECK_IN;
  const starts = stays.map((stay) => Date.parse(zonedInstant(stay.checkIn, time, input.timeZone))).filter((at) => at > after);
  return starts.length > 0 ? Math.min(...starts) : undefined;
}
