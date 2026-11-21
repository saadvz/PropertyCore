/**
 * Reads an Airbnb reservation email: confirmed, changed or cancelled. The host's agent hands over the
 * email as it arrived (sender, subject, plain-text body), the way it hands over Google Calendar events,
 * and this reads the dates, times, guest count and confirmation code. Pure: no network, no files.
 * See docs/superpowers/specs/2026-11-14-airbnb-booking-emails-design.md.
 */

import type { BookingPlatform } from "./bookingSources";

export interface BookingEmailInput {
  /** The From header, like `Airbnb <automated@airbnb.com>`. */
  from: string;
  subject: string;
  /** The plain-text body. */
  body: string;
  /** The Message-ID header, for dedupe. */
  messageId?: string;
  /** When the email arrived, as an ISO instant. */
  receivedAt?: string;
  /** The email's Authentication-Results header(s), topmost first, exactly as received (#263). Read only with the account's booking platforms on, and never kept. */
  authentication?: string;
}

export interface BookingEmailDay {
  /** Local date, YYYY-MM-DD. */
  date: string;
  /** Local time, HH:MM (24-hour). Absent when the email gives none, like "Flexible". */
  time?: string;
}

export interface GuestCount {
  adults: number;
  children: number;
  infants: number;
  /** Adults plus children, as Airbnb counts guests. Infants are kept on their own. */
  total: number;
  /** Pets on the booking, only when it lists any. The no-pet rule needs it (#239). */
  pets?: number;
}

export interface ParsedBookingEmail {
  kind: "confirmed" | "changed" | "cancelled";
  /** Which platform's email it was (#263). Absent means Airbnb, as every email before #263 was. */
  platform?: BookingPlatform;
  /** The name the host gave an Other platform, for the host's notes. */
  platformName?: string;
  /** Airbnb's HM code, like HMABC12345, or another platform's reference. Empty when an Other email gave none. */
  confirmationCode: string;
  /** The listing's title as the email shows it. */
  listing?: string;
  checkIn?: BookingEmailDay;
  checkout?: BookingEmailDay;
  guests?: GuestCount;
}

export type ParseRefusal = "not-airbnb" | "not-a-reservation" | "no-code" | "no-dates";

export type ParseResult = { ok: true; parsed: ParsedBookingEmail } | { ok: false; reason: ParseRefusal };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?";
const DATE_RE = new RegExp(`(?:\\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\.?,?\\s+)?\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, "gi");
// The end day can't run into a clock time: "canceled on Nov 14, 2026 - 10:32 AM" is not a stay.
const RANGE_RE = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\s*(?:–|—|-|to)\\s*(?:${MONTH}\\s+)?(\\d{1,2})(?![\\d:])(?:,?\\s+(\\d{4}))?`, "gi");
const DAY_START = new RegExp(`^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\.?,?\\s+)?${MONTH}\\s+\\d`, "i");
/** A line that is only a time, like "3:00 PM" or "After 3:00 PM". */
const ONLY_TIME = /^(?:(?:after|before|by|from|until)\s+)?(?:\d{1,2}(?::\d{2})?\s*[ap]\.?\s?m\.?|noon|midnight)\s*$/i;
const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\b\.?|\b(noon|midnight)\b/gi;
const CODE_RE = /\bHM[A-Z0-9]{8}\b/;
const CHECK_IN_LABEL = /^check[- ]?in\b/i;
const CHECKOUT_LABEL = /^check[- ]?out\b/i;
const GUESTS_LABEL = /^guests?\b/i;
const BOTH_LABELS = /^check[- ]?in\s+check[- ]?out\s*$/i;
const STOP_LABEL = /^(check[- ]?in|check[- ]?out|guests?|confirmation code|reservation code|view itinerary|guest paid|you earn|payout)\b/i;
const ROOM_TYPE = /^(entire\b|private room\b|shared room\b|hotel room\b|room in\b)/i;
/** A line that talks about a way in. Digit runs on it, or on the line after it, are door codes. */
const ACCESS_WORDS =
  /\b(code|codes|pin|pins|passcode|password|combo|combination|lock|lockbox|keypad|key\s?pad|door|gate|garage|opener|entry|entrance|enter|access|alarm|keyless|smart\s?lock)\b|\bpin(?=\d)/i;
/** Three or more digits, alone or split by single spaces, dots or dashes, like 3156, 31 56 or 3-1-5-6. */
const ACCESS_DIGITS = /\d(?:[\s.-]?\d){2,}/g;
export const CODE_REMOVED = "[code removed]";

/** True when the sender's address is Airbnb's own: airbnb.com or a subdomain of it. */
export function fromAirbnb(from: string): boolean {
  const text = from.trim();
  // The address is the last <...> at the end of the header. A display name can say anything, "<automated@airbnb.com>" included.
  const angled = [...text.matchAll(/<([^<>]*)>/g)];
  if (angled.length && !text.endsWith(">")) return false;
  const address = (angled.length ? angled.at(-1)![1]! : text).trim().toLowerCase();
  if (!/^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+$/.test(address)) return false;
  const domain = address.split("@")[1]!;
  return domain === "airbnb.com" || domain.endsWith(".airbnb.com");
}

export function parseAirbnbEmail(email: BookingEmailInput, now: Date): ParseResult {
  if (!fromAirbnb(email.from)) return { ok: false, reason: "not-airbnb" };
  const kind = kindOf(email.subject);
  if (!kind) return { ok: false, reason: "not-a-reservation" };
  const text = `${email.body}`.replace(/\r\n?/g, "\n");
  const code = CODE_RE.exec(text)?.[0] ?? CODE_RE.exec(email.subject)?.[0];
  if (!code) return { ok: false, reason: "no-code" };
  const received = email.receivedAt && !Number.isNaN(Date.parse(email.receivedAt)) ? new Date(email.receivedAt) : now;
  const raw = text.split("\n");
  const lines = raw.map((line) => line.trim());
  let { checkIn, checkout } = readDays(raw, lines, received);
  if ((!checkIn || !checkout) && kind === "cancelled") ({ checkIn, checkout } = readDateRange(text, received));
  if ((!checkIn || !checkout) && kind !== "cancelled") return { ok: false, reason: "no-dates" };
  if (checkIn && checkout && checkout.date <= checkIn.date) {
    // A stay over New Year with no year printed: the checkout is in the next year.
    const later = addYear(checkout.date);
    if (later > checkIn.date) checkout = { ...checkout, date: later };
    else if (kind !== "cancelled") return { ok: false, reason: "no-dates" };
    else checkIn = checkout = undefined;
  }
  const listing = listingOf(lines);
  const guests = guestsOf(lines);
  return {
    ok: true,
    parsed: {
      kind,
      confirmationCode: code,
      ...(listing ? { listing } : {}),
      ...(checkIn && checkout ? { checkIn, checkout } : {}),
      ...(guests ? { guests } : {}),
    },
  };
}

/**
 * Takes out what could be a door code before an email is stored or read: a run of 3 or more digits
 * (also split, like 31 56) on a line about a code, PIN, lock, keypad, door, gate, garage, entry or
 * alarm, a digits-only line right after one, and any line the door-code guard says carries the saved
 * code. The HM confirmation code has letters, so it stays.
 */
export function redactBookingEmail(body: string, carriesCode?: (text: string) => boolean): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let afterAccess = false;
  return lines
    .map((line) => {
      const access = ACCESS_WORDS.test(line);
      let out = line;
      // "Gate code is below" with the digits, however short or spaced, on the next line.
      if (afterAccess && /^\s*[\d\s#*.-]*\d[\d\s#*.-]*$/.test(line)) out = out.replace(/\d[\d\s#*.-]*/, CODE_REMOVED);
      if (access || carriesCode?.(out)) out = out.replace(ACCESS_DIGITS, CODE_REMOVED);
      // Whatever the guard still sees (a code written another way, say) loses every digit on the line.
      if (carriesCode?.(out)) out = out.replace(/\d/g, "•");
      if (line.trim()) afterAccess = access;
      return out;
    })
    .join("\n");
}

/** A listing title compared without case, spacing or punctuation. */
export function normalizeListing(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function kindOf(subject: string): ParsedBookingEmail["kind"] | undefined {
  const text = subject.trim().toLowerCase();
  // A reply or a forward is a conversation about a booking, not Airbnb's own notice of one.
  if (/^(re|fw|fwd)\s*:/.test(text)) return undefined;
  // A request (to change or cancel) isn't the booking changing until Airbnb says it was accepted.
  if (/\brequest(ed|s)?\b/.test(text) && !/\b(accepted|approved)\b/.test(text)) return undefined;
  if (/\bcancel(l)?ed\b|\bcancellation\b/.test(text)) return "cancelled";
  if (/\b(altered|alteration|changed|updated)\b/.test(text)) return "changed";
  if (/\b(reservation|booking)\b.*\bconfirmed\b|\bconfirmed\b.*\b(reservation|booking)\b|\bnew booking\b/.test(text)) return "confirmed";
  return undefined;
}

function readDays(raw: string[], lines: string[], received: Date): { checkIn?: BookingEmailDay; checkout?: BookingEmailDay } {
  const both = lines.findIndex((line) => BOTH_LABELS.test(line));
  if (both >= 0) {
    const columns = readColumns(raw, lines, both, received);
    if (columns) return columns;
  }
  const inAt = lines.findIndex((line) => labelRest(line, CHECK_IN_LABEL) !== undefined);
  const outAt = lines.findIndex((line) => labelRest(line, CHECKOUT_LABEL) !== undefined);
  const checkIn = inAt >= 0 ? dayAfterLabel(lines, inAt, labelRest(lines[inAt]!, CHECK_IN_LABEL)!, received) : undefined;
  const checkout = outAt >= 0 ? dayAfterLabel(lines, outAt, labelRest(lines[outAt]!, CHECKOUT_LABEL)!, received) : undefined;
  return { ...(checkIn ? { checkIn } : {}), ...(checkout ? { checkout } : {}) };
}

/**
 * "Check-in      Checkout" with the dates and times under each. A value starting at or past the
 * Checkout header's column is checkout's, so "Flexible      11:00 AM" gives checkout 11:00 and check-in none.
 */
function readColumns(raw: string[], lines: string[], at: number, received: Date): { checkIn: BookingEmailDay; checkout: BookingEmailDay } | undefined {
  const header = raw[at]!;
  const split = Math.max(1, (/check[- ]?out/i.exec(header)?.index ?? 1) - 2);
  const rows = following(lines, at, 2).map((i) => raw[i]!);
  const side = (index: number) => (index >= split ? "out" : "in");
  const dates = { in: [] as string[], out: [] as string[] };
  const times = { in: [] as string[], out: [] as string[] };
  for (const row of rows) {
    for (const match of row.matchAll(DATE_RE)) {
      const date = ymd(match[1]!, match[2]!, match[3], received);
      if (date) dates[side(match.index!)].push(date);
    }
    for (const { time, index } of timesAt(row)) times[side(index)].push(time);
  }
  if (dates.in.length === 1 && dates.out.length === 1) return { checkIn: day(dates.in[0]!, times.in[0]), checkout: day(dates.out[0]!, times.out[0]) };
  // Not laid out in columns after all: take them in order.
  const block = rows.join("\n");
  const inOrder = datesIn(block, received);
  const timed = timesIn(block);
  if (inOrder.length >= 2) return { checkIn: day(inOrder[0]!, timed[0]), checkout: day(inOrder[1]!, timed[1]) };
  return undefined;
}

/** What follows a label on its line, when the line is the label itself: nothing, or a date. "Check-in is easy" isn't one. */
function labelRest(line: string, label: RegExp): string | undefined {
  const match = label.exec(line);
  if (!match) return undefined;
  const rest = line.slice(match[0].length).replace(/^[\s:·-]+/, "");
  if (rest === "") return rest;
  if (label === GUESTS_LABEL) return /^\d/.test(rest) ? rest : undefined;
  return DAY_START.test(rest) ? rest : undefined;
}

/** The indexes of the next non-empty lines after a label, up to `count`, stopping at the next label. */
function following(lines: string[], at: number, count: number): number[] {
  const out: number[] = [];
  for (let i = at + 1; i < lines.length && out.length < count; i++) {
    const line = lines[i]!;
    if (!line) continue;
    if (STOP_LABEL.test(line)) break;
    out.push(i);
  }
  return out;
}

/** The date on the label's line or the line after it. Its time is on the date's line, or on the next line when that line is only a time. */
function dayAfterLabel(lines: string[], at: number, rest: string, received: Date): BookingEmailDay | undefined {
  const next = following(lines, at, 2).map((i) => lines[i]!);
  const dateLine = rest || next.shift();
  if (!dateLine) return undefined;
  const date = datesIn(dateLine, received)[0];
  if (!date) return undefined;
  const after = next[0];
  return day(date, timesIn(dateLine)[0] ?? (after && ONLY_TIME.test(after) ? timesIn(after)[0] : undefined));
}

/** The rest of a label's line and the next two non-empty lines, stopping at the next label. */
function blockAfter(lines: string[], at: number, rest: string): string {
  const out = [rest.replace(/^[\s:·-]+/, "")];
  let taken = 0;
  for (let i = at + 1; i < lines.length && taken < 2; i++) {
    const line = lines[i]!;
    if (!line) continue;
    if (STOP_LABEL.test(line)) break;
    out.push(line);
    taken += 1;
  }
  return out.join("\n");
}

function day(date: string, time: string | undefined): BookingEmailDay {
  return { date, ...(time ? { time } : {}) };
}

function datesIn(text: string, received: Date): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(DATE_RE)) {
    const date = ymd(match[1]!, match[2]!, match[3], received);
    if (date) out.push(date);
  }
  return out;
}

function timesIn(text: string): string[] {
  return timesAt(text).map((item) => item.time);
}

function timesAt(text: string): { time: string; index: number }[] {
  const out: { time: string; index: number }[] = [];
  for (const match of text.matchAll(TIME_RE)) {
    if (match[4]) {
      out.push({ time: match[4].toLowerCase() === "noon" ? "12:00" : "00:00", index: match.index! });
      continue;
    }
    const hour = Number(match[1]);
    const minute = Number(match[2] ?? "0");
    if (hour < 1 || hour > 12 || minute > 59) continue;
    const pm = match[3]!.toLowerCase() === "p";
    const h24 = (hour % 12) + (pm ? 12 : 0);
    out.push({ time: `${String(h24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, index: match.index! });
  }
  return out;
}

/** A cancellation's stay, like "Oct 18 – 22, 2026": the first range that reads as a stay of a year or less. */
export function readDateRange(text: string, received: Date): { checkIn?: BookingEmailDay; checkout?: BookingEmailDay } {
  for (const match of text.matchAll(RANGE_RE)) {
    const endYear = match[6];
    const startMonth = MONTHS.indexOf(match[1]!.slice(0, 3).toLowerCase());
    const endMonth = match[4] ? MONTHS.indexOf(match[4].slice(0, 3).toLowerCase()) : startMonth;
    // "Dec 28 – Jan 2, 2027": the year printed at the end is the checkout's.
    const startYear = match[3] ?? (endYear && startMonth > endMonth ? String(Number(endYear) - 1) : endYear);
    const checkIn = ymd(match[1]!, match[2]!, startYear, received);
    let checkout = ymd(match[4] ?? match[1]!, match[5]!, endYear ?? match[3], received);
    if (!checkIn || !checkout) continue;
    if (checkout <= checkIn) checkout = addYear(checkout);
    const nights = (Date.parse(checkout) - Date.parse(checkIn)) / 86_400_000;
    if (nights >= 1 && nights <= 365) return { checkIn: { date: checkIn }, checkout: { date: checkout } };
  }
  return {};
}

/** A month and day, with the year printed or else the earliest year that isn't more than a month before the email. */
function ymd(monthText: string, dayText: string, yearText: string | undefined, received: Date): string | undefined {
  const month = MONTHS.indexOf(monthText.slice(0, 3).toLowerCase());
  const dayOfMonth = Number(dayText);
  if (month < 0 || dayOfMonth < 1 || dayOfMonth > 31) return undefined;
  const years = yearText ? [Number(yearText)] : [-1, 0, 1].map((offset) => received.getUTCFullYear() + offset);
  const earliest = received.getTime() - 31 * 24 * 60 * 60 * 1000;
  for (const year of years) {
    const date = new Date(Date.UTC(year, month, dayOfMonth));
    if (date.getUTCMonth() !== month) continue;
    // A notice about a stay that started up to a month ago keeps that date; anything earlier is the next year's.
    if (!yearText && date.getTime() < earliest) continue;
    return date.toISOString().slice(0, 10);
  }
  return undefined;
}

function addYear(date: string): string {
  return `${Number(date.slice(0, 4)) + 1}${date.slice(4)}`;
}

function listingOf(lines: string[]): string | undefined {
  const at = lines.findIndex((line) => ROOM_TYPE.test(line));
  if (at <= 0) return undefined;
  for (let i = at - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line) continue;
    return line.length <= 200 ? line : undefined;
  }
  return undefined;
}

function guestsOf(lines: string[]): GuestCount | undefined {
  const at = lines.findIndex((line) => labelRest(line, GUESTS_LABEL) !== undefined);
  const block = at >= 0 ? blockAfter(lines, at, labelRest(lines[at]!, GUESTS_LABEL)!) : "";
  if (!block) return undefined;
  const count = (re: RegExp) => Number(re.exec(block)?.[1] ?? "0");
  const adults = count(/(\d+)\s+adults?\b/i);
  const children = count(/(\d+)\s+(?:child|children|kids?)\b/i);
  const infants = count(/(\d+)\s+(?:infants?|babies|baby)\b/i);
  const pets = count(/(\d+)\s+(?:pets?|dogs?|cats?)\b/i);
  const withPets = pets > 0 ? { pets } : {};
  if (adults || children || infants) return { adults, children, infants, total: adults + children, ...withPets };
  const guests = /(\d+)\s+guests?\b/i.exec(block);
  if (!guests) return undefined;
  const total = Number(guests[1]);
  return { adults: total, children: 0, infants: 0, total, ...withPets };
}
