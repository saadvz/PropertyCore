import { dateFormat } from "../core/timezone";

export interface FeedBlock {
  uid: string;
  summary: string;
}

export interface Turnover {
  id: string;
  departingUid: string;
  arrivingUid: string | null;
  /** Check-in date of the departing stay. Used to recognize the same booking in another source. */
  checkInDate: string;
  checkoutDate: string;
  nextCheckInDate: string | null;
  sameDay: boolean;
  sequence: number;
  contentHash: string;
}

export interface FeedRead {
  turnovers: Turnover[];
  blocks: FeedBlock[];
}

/**
 * Guesty Lite publishes stays and blocks as all-day iCal dates.
 * A clock on an event is ignored. DTEND's date is the checkout date.
 * A block is not a departure and is not the next arrival.
 */
export function interpretFeed(ical: string): FeedRead {
  const text = unfold(ical);
  const events: ParsedEvent[] = [];
  for (const match of text.matchAll(/BEGIN:VEVENT\n([\s\S]*?)END:VEVENT/g)) {
    const body = match[1] ?? "";
    const parsed = parseEvent(body);
    if (parsed) events.push(parsed);
  }
  const blocks = events.filter((event) => event.kind === "block").map((event) => ({ uid: event.uid, summary: event.summary }));
  const stays = events.filter((event) => event.kind === "stay").sort(byCheckout);
  const turnovers: Turnover[] = stays.map((stay) => {
    const next = stays
      .filter((other) => other.uid !== stay.uid && other.checkInDate >= stay.checkOutDate)
      .sort(byCheckIn)[0];
    const nextCheckInDate = next?.checkInDate ?? null;
    const arrivingUid = next?.uid ?? null;
    return {
      id: stay.uid,
      departingUid: stay.uid,
      arrivingUid,
      checkInDate: stay.checkInDate,
      checkoutDate: stay.checkOutDate,
      nextCheckInDate,
      sameDay: nextCheckInDate === stay.checkOutDate,
      sequence: stay.sequence,
      contentHash: `${stay.checkOutDate}|${nextCheckInDate ?? ""}|${arrivingUid ?? ""}`,
    };
  });
  return { turnovers, blocks };
}

export function zonedInstant(ymd: string, hm: string, timeZone: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const [hour, minute] = hm.split(":").map(Number);
  if (!year || !month || !day || hour === undefined || minute === undefined) throw new Error("Bad local time");
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const refined = zoneOffsetMs(new Date(guess - zoneOffsetMs(new Date(guess), timeZone)), timeZone);
  return new Date(guess - refined).toISOString();
}

export function formatWhen(iso: string, timeZone: string): { day: string; time: string } {
  const date = new Date(iso);
  return {
    day: dateFormat({ timeZone, weekday: "long", month: "short", day: "numeric" }).format(date),
    time: dateFormat({ timeZone, hour: "numeric", minute: "2-digit" }).format(date),
  };
}

export function addCalendarDays(ymd: string, days: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  if (!year || !month || !day) throw new Error("Bad calendar date");
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

interface ParsedEvent {
  uid: string;
  kind: "stay" | "block";
  summary: string;
  checkInDate: string;
  checkOutDate: string;
  sequence: number;
}

function parseEvent(body: string): ParsedEvent | undefined {
  const status = prop(body, "STATUS")?.value.toUpperCase();
  if (status === "CANCELLED") return undefined;
  const uid = prop(body, "UID")?.value;
  const start = prop(body, "DTSTART");
  const end = prop(body, "DTEND");
  if (!uid || !start || !end) return undefined;
  const checkInDate = calendarDate(start);
  const checkOutDate = calendarDate(end);
  if (!checkInDate || !checkOutDate || checkOutDate <= checkInDate) return undefined;
  const summary = prop(body, "SUMMARY")?.value ?? "";
  const description = prop(body, "DESCRIPTION")?.value ?? "";
  const sequence = Number(prop(body, "SEQUENCE")?.value ?? "0");
  return {
    uid,
    kind: isCalendarBlock(summary, description) ? "block" : "stay",
    summary,
    checkInDate,
    checkOutDate,
    sequence: Number.isFinite(sequence) ? sequence : 0,
  };
}

/** A block is not a stay and not a departure. Shared by Guesty Lite and Google Calendar. */
export function isCalendarBlock(summary: string, description: string): boolean {
  return /\b(blocked|block|not available|unavailable|owner block)\b/i.test(`${summary}\n${description}`);
}

function calendarDate(field: { params: string; value: string }): string | undefined {
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(field.value);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
  const timed = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(field.value);
  if (!timed) return undefined;
  if (timed[7] === "Z") {
    const instant = new Date(Date.UTC(Number(timed[1]), Number(timed[2]) - 1, Number(timed[3]), Number(timed[4]), Number(timed[5]), Number(timed[6])));
    const tzid = /TZID=([^;]+)/.exec(field.params)?.[1] ?? "America/New_York";
    return new Intl.DateTimeFormat("en-CA", { timeZone: tzid, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
  }
  return `${timed[1]}-${timed[2]}-${timed[3]}`;
}

function prop(block: string, name: string): { params: string; value: string } | undefined {
  for (const line of block.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const left = line.slice(0, idx);
    const [key, ...params] = left.split(";");
    if (key?.toUpperCase() === name) return { params: params.join(";"), value: line.slice(idx + 1).trim() };
  }
  return undefined;
}

function unfold(ical: string): string {
  return ical.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
}

function byCheckout(a: ParsedEvent, b: ParsedEvent): number {
  return a.checkOutDate.localeCompare(b.checkOutDate) || a.uid.localeCompare(b.uid);
}

function byCheckIn(a: ParsedEvent, b: ParsedEvent): number {
  return a.checkInDate.localeCompare(b.checkInDate) || a.uid.localeCompare(b.uid);
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const fmt = dateFormat({
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of fmt.formatToParts(instant)) parts[part.type] = part.value;
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asUtc - instant.getTime();
}
