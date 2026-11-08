import { tokenHash, type Job, type Pro } from "./store.js";
import { insideWindow, type VisitWindow } from "./window.js";

/**
 * Fixer Core's go or hold, decided by code rather than by the assistant. Pure: the desk builds the
 * context from its record and saves the answer.
 */

const MINUTE_MS = 60_000;

/** One live booking per job: it counts while the job is booked or under way. */
export function liveBooking(job: Job): boolean {
  return job.state === "booked" || job.state === "in-progress";
}

/** May this pro or candidate be contacted? A pick is the host's approval; a draft never is. */
export function contactAllowed(
  job: Job,
  to: string,
  pros: readonly Pro[],
): { ok: true } | { ok: false; reason: "no-go" | "not-approved" | "unknown" } {
  const pro = pros.find((p) => p.id === to);
  if (pro?.status === "draft") return { ok: false, reason: "not-approved" };
  if (job.picked.includes(to)) return { ok: true };
  if (pro) {
    if (pro.preferredFor.some((p) => p.trade === job.trade)) {
      return job.hostGo ? { ok: true } : { ok: false, reason: "no-go" };
    }
    return { ok: false, reason: "not-approved" };
  }
  if (job.candidates.some((c) => c.id === to)) return { ok: false, reason: "not-approved" };
  return { ok: false, reason: "unknown" };
}

export type BookingHold = "outside-window" | "overlaps-stay" | "cost" | "no-estimate";

/** Why a booking needs the host first, in a fixed order. A cost hold needs a cost line. */
export function bookingHolds(input: {
  span: { from: string; until: string };
  windows: readonly VisitWindow[];
  overlaps: boolean;
  costLineCents?: number;
  estimateCents?: number;
}): BookingHold[] {
  const holds: BookingHold[] = [];
  if (!insideWindow(input.span, input.windows)) holds.push("outside-window");
  if (input.overlaps) holds.push("overlaps-stay");
  if (input.costLineCents !== undefined) {
    if (input.estimateCents === undefined) holds.push("no-estimate");
    else if (input.estimateCents > input.costLineCents) holds.push("cost");
  }
  return holds;
}

/** A hash of exactly what was checked, so a replay is not a second booking. */
export function bookingFingerprint(b: {
  proId: string;
  from: string;
  until: string;
  estimateCents?: number;
  access: "code" | "host";
  cleaningOrder?: string;
}): string {
  return tokenHash(JSON.stringify([b.proId, b.from, b.until, b.estimateCents ?? null, b.access, b.cleaningOrder ?? null]));
}

/** The door code goes to the pro only if the job isn't on the coded lock and a phone and saved code exist. */
export function defaultAccess(job: Job, pro: { reach: { phone?: string } } | undefined, codeSaved: boolean): "code" | "host" {
  if (job.doorLock || !pro?.reach.phone || !codeSaved) return "host";
  return "code";
}

export type AccessRefusal = "not-booked" | "no-yes" | "host-access" | "no-phone" | "before-visit" | "after-visit" | "guests-not-left";

/** May the visit page show the door code now? The window runs from 30 minutes before the visit. */
export function accessCheck(input: {
  job: Job;
  /** The booked pro or candidate: only its phone is read. */
  pro: Pick<Pro, "reach"> | undefined;
  now: Date;
  checkoutDay: boolean;
  cleared: boolean;
}): { ok: true; window: { from: string; until: string } } | { ok: false; reason: AccessRefusal } {
  const { job, pro, now } = input;
  const booking = job.booking;
  if (!booking || !liveBooking(job)) return { ok: false, reason: "not-booked" };
  if (!booking.hostYes) return { ok: false, reason: "no-yes" };
  if (booking.access === "host") return { ok: false, reason: "host-access" };
  if (!pro?.reach.phone) return { ok: false, reason: "no-phone" };
  const from = Date.parse(booking.from) - 30 * MINUTE_MS;
  const until = Date.parse(booking.extendedUntil ?? booking.until);
  if (now.getTime() < from) return { ok: false, reason: "before-visit" };
  if (now.getTime() >= until) return { ok: false, reason: "after-visit" };
  if (input.checkoutDay && !input.cleared) return { ok: false, reason: "guests-not-left" };
  return { ok: true, window: { from: new Date(from).toISOString(), until: new Date(until).toISOString() } };
}

/** Over 120% of the estimate, in whole cents. */
function overEstimate(estimateCents: number | undefined, cents: number): boolean {
  return estimateCents !== undefined && cents * 100 > estimateCents * 120;
}

/** A revised price the host must approve again: only when a cost line is set. */
export function raisedPriceHeld(costLineCents: number | undefined, estimateCents: number | undefined, cents: number): boolean {
  if (costLineCents === undefined) return false;
  return cents > costLineCents || overEstimate(estimateCents, cents);
}

/** A price worth telling the host about, line or not. */
export function costNews(costLineCents: number | undefined, estimateCents: number | undefined, cents: number): boolean {
  return (costLineCents !== undefined && cents > costLineCents) || overEstimate(estimateCents, cents);
}
