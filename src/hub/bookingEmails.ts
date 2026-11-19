import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BookingEmailInput, GuestCount, ParsedBookingEmail } from "./airbnbEmail";

/**
 * Every Airbnb reservation email a property took, as received (with door codes taken out), one JSON
 * line each, append-only. The times and guest counts are rebuilt from this log, never kept anywhere
 * else, so they can always be rebuilt from the emails themselves.
 */

export const BOOKING_EMAILS_FILE = "booking-emails.jsonl";

/**
 * What came of an email. `applied`: its times went on the cleanings, or its cancellation was already
 * on the calendar. `pending`: its stay isn't on the calendar yet. `asked`: a cancellation the calendar
 * still shows, waiting on the host. `called-off`: the host said yes to that. `superseded`: Airbnb sent a
 * later email about the same booking. The rest changed nothing.
 */
export type BookingEmailOutcome = "applied" | "pending" | "asked" | "called-off" | "mismatch" | "disagrees" | "refused" | "duplicate" | "superseded";

export interface BookingEmailRecord {
  /** When Property Core took it. */
  at: string;
  receivedAt: string;
  messageId?: string;
  from: string;
  subject: string;
  /** The body as received, with door codes taken out. Not kept for an email that couldn't be read. */
  body?: string;
  /** A hash of the body as received (door codes taken out), so a second copy is known without keeping the body. */
  bodyHash?: string;
  parsed?: ParsedBookingEmail;
  /** Why it couldn't be read, when it couldn't. */
  refused?: string;
  outcome: BookingEmailOutcome;
}

/** The latest of one booking, by confirmation code, as the emails tell it. */
export interface EmailBooking {
  confirmationCode: string;
  listing?: string;
  checkIn: string;
  checkout: string;
  checkInTime?: string;
  checkoutTime?: string;
  /** Adults plus children. */
  guests?: number;
  guestBreakdown?: GuestCount;
  cancelled: boolean;
  /** When the latest email about it was taken. */
  lastAt: string;
}

/** One stay as the emails tell it. The calendar still decides which nights are booked. */
export interface EmailStay {
  checkIn: string;
  checkout: string;
  checkInTime?: string;
  checkoutTime?: string;
  guests?: number;
  /** Infants on the booking, when it lists any. Not in `guests`, but a camera sees them. */
  infants?: number;
  /** Pets on the booking, when it lists any. */
  pets?: number;
  confirmationCode: string;
}

/** The outcomes that tell the booking's latest. An `asked` cancellation waits on the host, so it doesn't. */
export const COUNTED: ReadonlySet<BookingEmailOutcome> = new Set(["applied", "pending", "called-off"]);

export function bookingEmailsPath(root: string): string {
  return join(root, BOOKING_EMAILS_FILE);
}

export function readBookingEmails(root: string): BookingEmailRecord[] {
  const path = bookingEmailsPath(root);
  if (!existsSync(path)) return [];
  const out: BookingEmailRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as BookingEmailRecord);
    } catch {
      // A line cut short by a crash mid-write is skipped; every whole line before and after it still counts.
    }
  }
  return out;
}

/** Adds one line. Lines are never rewritten or removed. */
export function appendBookingEmail(root: string, record: BookingEmailRecord): void {
  mkdirSync(root, { recursive: true });
  appendFileSync(bookingEmailsPath(root), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** The record's body hash, from the field or the body it kept. */
export function recordBodyHash(record: Pick<BookingEmailRecord, "body" | "bodyHash">): string {
  return record.bodyHash ?? bodyHash(record.body ?? "");
}

/** True when this record is the same email: the same message id, or the same sender, subject and body. */
export function sameEmail(record: BookingEmailRecord, email: Pick<BookingEmailInput, "from" | "subject" | "messageId">, hash: string): boolean {
  return Boolean(email.messageId && record.messageId === email.messageId) || (record.from === email.from && record.subject === email.subject && recordBodyHash(record) === hash);
}

/** True when this email was already taken: the same message id, or the same sender, subject and body. */
export function isDuplicate(records: readonly BookingEmailRecord[], email: Pick<BookingEmailInput, "from" | "subject" | "body" | "messageId">, body = email.body): boolean {
  const hash = bodyHash(body);
  return records.some((item) => sameEmail(item, email, hash));
}

/** The log in the order Airbnb sent the emails; emails sent at the same moment stay in the order they were taken. */
export function bySent(records: readonly BookingEmailRecord[]): BookingEmailRecord[] {
  return records
    .map((record, index) => ({ record, index, sent: Date.parse(record.receivedAt) || 0 }))
    .sort((a, b) => a.sent - b.sent || a.index - b.index)
    .map((item) => item.record);
}

/**
 * The latest of each booking: a confirmation or change sets the dates, times and guests (a side
 * the email gives no time for keeps the last one), and a cancellation marks it cancelled. Emails go
 * in the order Airbnb sent them. Emails that changed nothing (refused, mismatched, disagreeing,
 * duplicate, superseded) and a cancellation still waiting on the host don't count.
 */
export function rebuildBookings(records: readonly BookingEmailRecord[]): Map<string, EmailBooking> {
  const out = new Map<string, EmailBooking>();
  for (const item of bySent(records)) {
    const parsed = item.parsed;
    if (!parsed || !COUNTED.has(item.outcome)) continue;
    const code = parsed.confirmationCode;
    const last = out.get(code);
    if (parsed.kind === "cancelled") {
      const checkIn = parsed.checkIn?.date ?? last?.checkIn;
      const checkout = parsed.checkout?.date ?? last?.checkout;
      if (!checkIn || !checkout) continue;
      out.set(code, { ...(last ?? { confirmationCode: code }), checkIn, checkout, cancelled: true, lastAt: item.at } as EmailBooking);
      continue;
    }
    if (!parsed.checkIn || !parsed.checkout) continue;
    const sameDates = last && last.checkIn === parsed.checkIn.date && last.checkout === parsed.checkout.date;
    const checkInTime = parsed.checkIn.time ?? (sameDates ? last.checkInTime : undefined);
    const checkoutTime = parsed.checkout.time ?? (sameDates ? last.checkoutTime : undefined);
    const listing = parsed.listing ?? last?.listing;
    out.set(code, {
      confirmationCode: code,
      ...(listing ? { listing } : {}),
      checkIn: parsed.checkIn.date,
      checkout: parsed.checkout.date,
      ...(checkInTime ? { checkInTime } : {}),
      ...(checkoutTime ? { checkoutTime } : {}),
      ...(parsed.guests ? { guests: parsed.guests.total, guestBreakdown: parsed.guests } : last?.guests !== undefined ? { guests: last.guests, ...(last.guestBreakdown ? { guestBreakdown: last.guestBreakdown } : {}) } : {}),
      cancelled: false,
      lastAt: item.at,
    });
  }
  return out;
}

/** The stay covering the night of `date` (YYYY-MM-DD): check-in night counts, checkout night doesn't. */
export function stayForNight(root: string, date: string): EmailStay | undefined {
  for (const booking of rebuildBookings(readBookingEmails(root)).values()) {
    if (booking.cancelled || booking.checkIn > date || date >= booking.checkout) continue;
    return {
      checkIn: booking.checkIn,
      checkout: booking.checkout,
      ...(booking.checkInTime ? { checkInTime: booking.checkInTime } : {}),
      ...(booking.checkoutTime ? { checkoutTime: booking.checkoutTime } : {}),
      ...(booking.guests !== undefined ? { guests: booking.guests } : {}),
      ...(booking.guestBreakdown && booking.guestBreakdown.infants > 0 ? { infants: booking.guestBreakdown.infants } : {}),
      ...(booking.guestBreakdown?.pets ? { pets: booking.guestBreakdown.pets } : {}),
      confirmationCode: booking.confirmationCode,
    };
  }
  return undefined;
}
