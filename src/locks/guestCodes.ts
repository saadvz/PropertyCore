import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rebuildBookings, readBookingEmails, type EmailBooking } from "../hub/bookingEmails";
import { zonedInstant } from "../hub/calendar";
import { readHubFile } from "../hub/store";
import type { WantedCode } from "../hub/grants";
import { lateCheckoutFor, readGuestMessages } from "../guest-messages/store";
import { writeFileAtomic } from "../storage/atomicWrite";
import type { CodeWindow } from "./adapter";

/**
 * Guest codes (#262): one code for each stay in the property's booking-email log, one for each stay
 * on the calendar that no booking email covers (#280 19, like a Guesty Lite iCal), and one for each
 * lease the host entered, on the connected locks through the hub's `guest` grants. This file works out
 * which codes the property wants now and keeps `guest-codes.json`: the host's choice, each booking's
 * yes under ask, the leases, page-link hashes, and which notes went. It never holds a code.
 */

export const GUEST_CODES_FILE = "guest-codes.json";
/** A stay's code goes on the lock this many days before check-in (at once for a booking made inside it). */
export const MAKE_AHEAD_DAYS = 7;
const DAY_MS = 24 * 3600_000;
export const DEFAULT_CHECK_IN = "16:00";
export const DEFAULT_CHECKOUT = "11:00";

/** How guest codes work on this property: the host's choice. Unset is off. */
export type GuestCodeMode = "automatic" | "ask" | "off";

/** A single-use page link: the sha256 of its token, never the token or the link. */
export interface GuestLink {
  hash: string;
  expiresAt: string;
  sentAt: string;
  usedAt?: string;
}

/** What Property Core keeps about one booking's code, by confirmation code. No code, no guest name. */
export interface StayCodeState {
  /** Under ask: when the host was asked, and when they said yes. */
  askedAt?: string;
  yesAt?: string;
  /** The stay's dates when the host was last told, so a removal can name them. */
  checkIn?: string;
  checkout?: string;
  /** The window the host was last told about, so a move is told once. */
  toldWindow?: CodeWindow;
  link?: GuestLink;
  /** The cancellation was told. */
  removedTold?: boolean;
  /** The urgent "not on the lock yet" note was told. */
  urgentTold?: boolean;
}

/** A lease the host entered. The tenant's phone is kept for their texts; never a code. */
export interface Lease {
  id: string;
  name: string;
  phone: string;
  /** Local dates, YYYY-MM-DD. */
  start: string;
  moveOut: string;
  addedAt: string;
  invitedAt?: string;
  yesAt?: string;
  stoppedAt?: string;
  removedAt?: string;
  link?: GuestLink;
}

export interface GuestCodesFile {
  schemaVersion: 1;
  mode?: GuestCodeMode;
  modeAt?: string;
  stays: Record<string, StayCodeState>;
  leases: Lease[];
}

export function emptyGuestCodes(): GuestCodesFile {
  return { schemaVersion: 1, stays: {}, leases: [] };
}

export function readGuestCodes(root: string): GuestCodesFile {
  const path = join(root, GUEST_CODES_FILE);
  if (!existsSync(path)) return emptyGuestCodes();
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<GuestCodesFile>;
  const mode = raw.mode === "automatic" || raw.mode === "ask" || raw.mode === "off" ? raw.mode : undefined;
  return {
    schemaVersion: 1,
    ...(mode ? { mode } : {}),
    ...(raw.modeAt ? { modeAt: raw.modeAt } : {}),
    stays: raw.stays && typeof raw.stays === "object" ? raw.stays : {},
    leases: Array.isArray(raw.leases) ? raw.leases : [],
  };
}

export function writeGuestCodes(root: string, file: GuestCodesFile): void {
  writeFileAtomic(join(root, GUEST_CODES_FILE), `${JSON.stringify(file)}\n`);
}

/**
 * True when a booking still needs the host's yes before it moves anything. A booking from a platform
 * without its own reader (#263) waiting on that yes is already left out of rebuildBookings, so none
 * reaches here; this stays as a second hook.
 */
export function needsHostYes(_booking: EmailBooking): boolean {
  return false;
}

export interface WantedInput {
  now: Date;
  timeZone: string;
  /** The property's usual times, "HH:MM". */
  checkInTime?: string;
  checkoutTime?: string;
  needsHostYes?: (booking: EmailBooking) => boolean;
}

/** One upcoming stay that can carry a guest code, whatever the host's choice. */
export interface GuestStay {
  /**
   * The booking's key in the booking-email log: Airbnb's confirmation code, or another platform's
   * prefixed with it, like vrbo:HA-1A2B3C, or direct:2026-12-12:2026-12-15 when its email gave no
   * reference (#263). Unique across platforms, so it names the stay's code, its state and its notes.
   */
  key: string;
  checkIn: string;
  checkout: string;
  window: CodeWindow;
  label: string;
  /** True once check-in is within 7 days, so its code is due. */
  due: boolean;
  /** Where the stay came from: a booking email, or only the calendar (keyed cal:<check-in>:<checkout>). */
  source: "email" | "calendar";
}

/** A calendar-only stay's key: its dates, since the calendar gives no reference. */
export const calendarKey = (checkIn: string, checkout: string): string => `cal:${checkIn}:${checkout}`;

const overlaps = (a: { checkIn: string; checkout: string }, b: { checkIn: string; checkout: string }): boolean => a.checkIn < b.checkout && b.checkIn < a.checkout;

/** A calendar key's dates, or undefined for any other key. */
function calendarDates(key: string): { checkIn: string; checkout: string } | undefined {
  const match = /^cal:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(key);
  return match ? { checkIn: match[1]!, checkout: match[2]! } : undefined;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayMonth(ymd: string): { day: number; month: string } {
  const [, month, day] = ymd.split("-").map(Number);
  return { day: day!, month: MONTHS[month! - 1]! };
}

/** How notes name a stay: by its dates, never by the guest. */
export function stayDates(checkIn: string, checkout: string): string {
  const a = dayMonth(checkIn);
  const b = dayMonth(checkout);
  return a.month === b.month ? `${a.day}–${b.day} ${b.month}` : `${a.day} ${a.month}–${b.day} ${b.month}`;
}

export function stayLabel(checkIn: string, checkout: string): string {
  return `the guest on ${stayDates(checkIn, checkout)}`;
}

/** A stay's job, by its booking key: `stay:HM…` for Airbnb, as before #263; `stay:vrbo:…` and the like for other platforms. */
export const stayJob = (key: string): string => `stay:${key}`;
export const leaseJob = (id: string): string => `lease:${id}`;

/**
 * Every stay that can carry a code, oldest check-in first: each booking in the email log that isn't
 * cancelled, and each calendar stay (never a block) no live booking email overlaps, on the property's
 * usual times. An email for a calendar stay whose code was already made, asked about or said yes to
 * keeps the calendar key, so the same code, link and notes carry on with the email's times; so does a
 * calendar stay whose dates changed.
 */
export function guestStays(root: string, input: WantedInput): GuestStay[] {
  const late = readGuestMessages(root);
  const out: GuestStay[] = [];
  const holds = input.needsHostYes ?? needsHostYes;
  const started = Object.entries(readGuestCodes(root).stays)
    .filter(([, state]) => state.toldWindow || state.yesAt || state.askedAt)
    .flatMap(([key]) => {
      const dates = calendarDates(key);
      return dates ? [{ key, ...dates }] : [];
    });
  const add = (key: string, source: GuestStay["source"], stay: { checkIn: string; checkout: string; checkInTime?: string; checkoutTime?: string }): void => {
    const checkInTime = stay.checkInTime ?? input.checkInTime ?? DEFAULT_CHECK_IN;
    const checkoutTime = lateCheckoutFor(late, stay.checkout) ?? stay.checkoutTime ?? input.checkoutTime ?? DEFAULT_CHECKOUT;
    let window: CodeWindow;
    try {
      window = { from: zonedInstant(stay.checkIn, checkInTime, input.timeZone), until: zonedInstant(stay.checkout, checkoutTime, input.timeZone) };
    } catch {
      return;
    }
    if (Date.parse(window.until) <= input.now.getTime() || Date.parse(window.from) >= Date.parse(window.until)) return;
    if (out.some((item) => item.key === key)) return;
    out.push({
      key,
      checkIn: stay.checkIn,
      checkout: stay.checkout,
      window,
      label: stayLabel(stay.checkIn, stay.checkout),
      due: Date.parse(window.from) - input.now.getTime() <= MAKE_AHEAD_DAYS * DAY_MS,
      source,
    });
  };
  const emails: { checkIn: string; checkout: string }[] = [];
  for (const [key, booking] of rebuildBookings(readBookingEmails(root))) {
    if (booking.cancelled || holds(booking)) continue;
    emails.push(booking);
    const carried = started.find((item) => overlaps(item, booking));
    add(carried?.key ?? key, "email", booking);
  }
  const calendar = (readHubFile(root)?.stays ?? []).filter((stay) => stay.kind === "stay" && !emails.some((email) => overlaps(email, stay)));
  const listedKeys = new Set(calendar.map((stay) => calendarKey(stay.checkIn, stay.checkout)));
  const claimed = new Set(out.map((item) => item.key));
  for (const stay of calendar) {
    const own = calendarKey(stay.checkIn, stay.checkout);
    // A calendar stay whose dates changed (an extension, an early checkout) keeps the code its old dates were given,
    // so the guest's code and the host's link carry on.
    const moved = started.find((item) => !listedKeys.has(item.key) && !claimed.has(item.key) && overlaps(item, stay));
    const use = started.some((item) => item.key === own) ? own : (moved?.key ?? own);
    claimed.add(use);
    add(use, "calendar", stay);
  }
  return out.sort((a, b) => Date.parse(a.window.from) - Date.parse(b.window.from));
}

/** A lease's window: its start at midnight to the end of move-out day, local. */
export function leaseWindow(lease: Pick<Lease, "start" | "moveOut">, timeZone: string): CodeWindow {
  return { from: zonedInstant(lease.start, "00:00", timeZone), until: zonedInstant(lease.moveOut, "23:59", timeZone) };
}

/** Leases still running: not removed or stopped, move-out day not over. */
export function liveLeases(file: GuestCodesFile, input: Pick<WantedInput, "now" | "timeZone">): Lease[] {
  return file.leases.filter((lease) => {
    if (lease.removedAt || lease.stoppedAt) return false;
    try {
      return Date.parse(leaseWindow(lease, input.timeZone).until) > input.now.getTime();
    } catch {
      return false;
    }
  });
}

/**
 * The guest codes the property wants on its locks now. Stays follow the host's choice: automatic,
 * every due stay; ask, only those the host said yes to; unset or off, none. A lease wants its code
 * from the tenant's YES, whatever the choice: each lease is its own host yes.
 */
export function wantedGuestCodes(root: string, file: GuestCodesFile, input: WantedInput): WantedCode[] {
  const wanted: WantedCode[] = [];
  if (file.mode === "automatic" || file.mode === "ask") {
    for (const stay of guestStays(root, input)) {
      if (!stay.due) continue;
      if (file.mode === "ask" && !file.stays[stay.key]?.yesAt) continue;
      wanted.push({ jobId: stayJob(stay.key), person: `guest:${stay.key}`, window: stay.window, label: stay.label, who: { role: "guest" } });
    }
  }
  for (const lease of liveLeases(file, input)) {
    if (!lease.yesAt) continue;
    wanted.push({ jobId: leaseJob(lease.id), person: lease.phone, window: leaseWindow(lease, input.timeZone), label: lease.name, who: { role: "guest" } });
  }
  return wanted;
}
