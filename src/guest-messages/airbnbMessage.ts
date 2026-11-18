import { fromAirbnb, parseAirbnbEmail, readDateRange, redactBookingEmail, type BookingEmailInput } from "../hub/airbnbEmail";

/**
 * Reads an Airbnb guest-message email (#242): the guest's words, their first name, and the listing,
 * dates and confirmation code the email names. The host's agent hands over the email as it arrived, as
 * it does for booking emails. Pure: no network, no files. Door codes are taken out before anything is
 * read. See docs/superpowers/specs/2026-11-17-guest-messages-design.md.
 */

export interface ParsedGuestMessage {
  /** A message on a booking, or an inquiry before one. */
  kind: "message" | "inquiry";
  /** The guest's first name as the email shows it. */
  guest?: string;
  /** The guest's words, door codes removed. */
  text: string;
  listing?: string;
  /** YYYY-MM-DD, from the subject's range. */
  checkIn?: string;
  checkout?: string;
  confirmationCode?: string;
}

export type MessageRefusal = "not-airbnb" | "booking-email" | "not-a-message" | "no-message";

export type MessageParse = { ok: true; parsed: ParsedGuestMessage } | { ok: false; reason: MessageRefusal };

export const MAX_MESSAGE = 2000;

const CODE_RE = /\bHM[A-Z0-9]{8}\b/;
const MESSAGE_SUBJECT = /^re:\s*reservation at\b|\bmessage from\b/i;
const INQUIRY_SUBJECT = /^(re:\s*)?inquiry at\b/i;
/** Airbnb's own lines after the guest's words. */
const FOOTER = /^(reply|respond to\b|confirmation code\b|reservation code\b|https?:\/\/|airbnb, inc\b|unsubscribe\b|view (itinerary|message)\b|get the app\b)/i;
/** A line under the guest's name that says who they are on the booking. */
const ROLE = /^(booker|guest|co-?traveler|co-?guest)$/i;
/** A name line: 1 to 4 words, letters and .'- only. */
const NAME = /^[\p{L}][\p{L}.'-]*(?:\s+[\p{L}][\p{L}.'-]*){0,3}$/u;

export function parseAirbnbMessage(email: BookingEmailInput, now: Date): MessageParse {
  if (!fromAirbnb(email.from)) return { ok: false, reason: "not-airbnb" };
  if (parseAirbnbEmail(email, now).ok) return { ok: false, reason: "booking-email" };
  const subject = email.subject.trim();
  const kind = INQUIRY_SUBJECT.test(subject) ? "inquiry" : MESSAGE_SUBJECT.test(subject) ? "message" : undefined;
  if (!kind) return { ok: false, reason: "not-a-message" };
  const received = email.receivedAt && !Number.isNaN(Date.parse(email.receivedAt)) ? new Date(email.receivedAt) : now;
  const body = redactBookingEmail(email.body);
  const { guest, text } = wordsOf(body.replace(/\r\n?/g, "\n").split("\n"));
  if (!text) return { ok: false, reason: "no-message" };
  const listing = /\bat\s+(.+?)\s+for\s+/i.exec(subject)?.[1]?.trim();
  const range = readDateRange(subject, received);
  // Read from the raw text: redaction can eat a code's digits when it sits on the line with "code".
  const code = CODE_RE.exec(email.body)?.[0] ?? CODE_RE.exec(subject)?.[0];
  return {
    ok: true,
    parsed: {
      kind,
      ...(guest ? { guest } : {}),
      text,
      ...(listing ? { listing } : {}),
      ...(range.checkIn && range.checkout ? { checkIn: range.checkIn.date, checkout: range.checkout.date } : {}),
      ...(code ? { confirmationCode: code } : {}),
    },
  };
}

/** The guest's first name (from the first line, when it reads as a name) and their words, up to Airbnb's footer. */
function wordsOf(raw: string[]): { guest?: string; text: string } {
  const lines = raw.map((line) => line.trimEnd());
  let at = lines.findIndex((line) => line.trim());
  if (at < 0) return { text: "" };
  let guest: string | undefined;
  const first = lines[at]!.trim();
  if (NAME.test(first) && !FOOTER.test(first)) {
    guest = first.split(/\s+/)[0];
    at += 1;
    while (at < lines.length && (!lines[at]!.trim() || ROLE.test(lines[at]!.trim()))) at += 1;
  }
  const words: string[] = [];
  for (let i = at; i < lines.length; i++) {
    if (FOOTER.test(lines[i]!.trim())) break;
    words.push(lines[i]!);
  }
  const text = words.join("\n").trim().replace(/\n{3,}/g, "\n\n").slice(0, MAX_MESSAGE).trim();
  return { ...(guest ? { guest } : {}), text };
}
