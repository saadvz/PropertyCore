/**
 * The Other path (#263): for a booking email from any platform but Airbnb, the agent reads the fields
 * and Property Core checks their shape. Nobody has verified the agent's reading, so a booking that
 * passes here still waits on the host's yes before it moves anything. Pure.
 * See docs/superpowers/specs/2026-11-20-booking-platforms-design.md.
 */

import type { BookingEmailInput, GuestCount, ParsedBookingEmail } from "./airbnbEmail";
import type { BookingSource } from "./bookingSources";

export interface ExtractedBooking {
  kind: "confirmed" | "changed" | "cancelled";
  /** The platform's confirmation code, as the email shows it. */
  reference?: string;
  listing?: string;
  checkIn: { date: string; time?: string };
  checkout: { date: string; time?: string };
  guests?: { adults?: number; children?: number; infants?: number; pets?: number; total?: number };
}

export type OtherCheck = { ok: true; parsed: ParsedBookingEmail } | { ok: false; reason: "bad-fields" | "door-code"; field: string; message: string };

export const MAX_NIGHTS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;
const KINDS = new Set(["confirmed", "changed", "cancelled"]);

/** Checks the agent's fields against the email. Pass the email with door codes already taken out. */
export function checkOtherEmail(email: Pick<BookingEmailInput, "subject" | "body">, extracted: unknown, source: BookingSource, now: Date, carriesCode: (text: string) => boolean): OtherCheck {
  const bad = (field: string, message: string): OtherCheck => ({ ok: false, reason: "bad-fields", field, message });
  if (!extracted || typeof extracted !== "object") return bad("extracted", "Pass extracted: the kind, check-in and checkout you read in the email.");
  const x = extracted as Partial<ExtractedBooking>;
  for (const text of [x.reference, x.listing, x.checkIn?.date, x.checkIn?.time, x.checkout?.date, x.checkout?.time]) {
    if (typeof text === "string" && carriesCode(text)) return { ok: false, reason: "door-code", field: "extracted", message: "Those fields look like they carry the door code, so nothing changed." };
  }
  if (typeof x.kind !== "string" || !KINDS.has(x.kind)) return bad("kind", "kind is confirmed, changed or cancelled.");
  const checkIn = day(x.checkIn);
  if (!checkIn) return bad("checkIn", "checkIn is { date: YYYY-MM-DD, time?: HH:MM }, a real date.");
  const checkout = day(x.checkout);
  if (!checkout) return bad("checkout", "checkout is { date: YYYY-MM-DD, time?: HH:MM }, a real date.");
  const nights = (Date.parse(`${checkout.date}T00:00:00Z`) - Date.parse(`${checkIn.date}T00:00:00Z`)) / DAY_MS;
  if (nights < 1) return bad("checkout", "Checkout has to be after check-in.");
  if (nights > MAX_NIGHTS) return bad("checkout", `That's more than ${MAX_NIGHTS} nights. Check the dates.`);
  const twoYears = new Date(now);
  twoYears.setUTCFullYear(twoYears.getUTCFullYear() + 2);
  if (Date.parse(`${checkIn.date}T00:00:00Z`) > twoYears.getTime()) return bad("checkIn", "That check-in is more than 2 years away. Check the dates.");
  let reference = "";
  if (x.reference !== undefined && x.reference !== "") {
    if (typeof x.reference !== "string" || !REFERENCE.test(x.reference)) return bad("reference", "reference is the confirmation code only: letters, digits and dashes, up to 40.");
    if (!`${email.subject}\n${email.body}`.toLowerCase().includes(x.reference.toLowerCase())) return bad("reference", "That reference isn't in the email. Pass it exactly as the email shows it.");
    reference = x.reference;
  }
  let guests: GuestCount | undefined;
  if (x.guests !== undefined) {
    const g = x.guests;
    const count = (value: unknown) => (value === undefined ? 0 : Number.isInteger(value) && (value as number) >= 0 ? (value as number) : NaN);
    const adults = count(g?.adults);
    const children = count(g?.children);
    const infants = count(g?.infants);
    const pets = count(g?.pets);
    const total = g?.total !== undefined ? count(g.total) : adults + children;
    if ([adults, children, infants, pets, total].some(Number.isNaN) || total < 1 || total > 50) return bad("guests", "guests is between 1 and 50, as whole numbers.");
    guests = { adults: g?.adults !== undefined ? adults : total - children, children, infants, total, ...(pets > 0 ? { pets } : {}) };
  }
  let listing: string | undefined;
  if (x.listing !== undefined) {
    if (typeof x.listing !== "string" || x.listing.length > 200) return bad("listing", "listing is the listing's title, up to 200 characters.");
    listing = x.listing.trim() || undefined;
  }
  return {
    ok: true,
    parsed: {
      kind: x.kind as ExtractedBooking["kind"],
      platform: source.platform,
      confirmationCode: reference,
      ...(listing ? { listing } : {}),
      checkIn,
      checkout,
      ...(guests ? { guests } : {}),
    },
  };
}

function day(value: unknown): { date: string; time?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { date, time } = value as { date?: unknown; time?: unknown };
  if (typeof date !== "string" || !DATE.test(date)) return undefined;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return undefined;
  if (time === undefined || time === "") return { date };
  if (typeof time !== "string" || !TIME.test(time)) return undefined;
  return { date, time };
}
