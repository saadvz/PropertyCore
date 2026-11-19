import type { NotReadyReason } from "./derive";

/**
 * Visit records' texts and notes (#237). Plain words, in the property's time zone. None of them holds a door code or
 * a phone number, and none says "ready" or "door code": Cleaner Core refuses a text that does.
 */

/** "4 PM" or "4:30 PM" in the property's time zone. */
export function clockText(at: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(at));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const period = (parts.find((p) => p.type === "dayPeriod")?.value ?? "").toUpperCase();
  return `${hour}${minute === "00" ? "" : `:${minute}`} ${period}`.trim();
}

const firstName = (name: string | undefined) => name?.trim().split(/\s+/)[0];

/** To the cleaner, once, when they haven't come in by the expected time plus the grace. */
export function lateAskText(input: { cleanerName?: string; address: string }): string {
  const name = firstName(input.cleanerName);
  return `${name ? `Hi ${name}, c` : "C"}hecking in on today's clean at ${input.address}. Are you on your way?`;
}

/** To the host, once, when the next check-in is at risk. */
export function atRiskText(input: { cleanerName?: string; address: string; checkIn: string; timeZone: string }): string {
  return `${input.cleanerName?.trim() || "The cleaner"} hasn't arrived at ${input.address}. The next guests check in at ${clockText(input.checkIn, input.timeZone)}.`;
}

/** To the host, once, when no one came in by the window's end and no at-risk note went. */
export function noShowText(input: { cleanerName?: string; address: string; until: string; timeZone: string }): string {
  return `No one came in for the clean at ${input.address} by ${clockText(input.until, input.timeZone)}. ${input.cleanerName?.trim() || "The cleaner"} hasn't checked in.`;
}

const REASONS: Record<NotReadyReason, string> = {
  "not-done": "the cleaning isn't marked done",
  "visit-over-check-in": "a repair visit runs into check-in",
  "not-locked": "the door wasn't locked from outside after the cleaning",
};

/** To the host, once, when arrival-day readiness fails. */
export function notReadyText(input: { address: string; checkIn: string; timeZone: string; why: readonly NotReadyReason[] }): string {
  const reasons = input.why.map((why) => REASONS[why]);
  const list = reasons.length <= 1 ? (reasons[0] ?? "") : `${reasons.slice(0, -1).join(", ")} and ${reasons.at(-1)}`;
  return `Before the ${clockText(input.checkIn, input.timeZone)} check-in at ${input.address}: ${list}.`;
}

/** To the host, once a day, when the cleaner's code opened the door outside any cleaning. */
export function cleanerStrayText(input: { address: string; device: string; at: string; timeZone: string }): string {
  return `The cleaner's code opened the ${input.device.toLowerCase()} at ${input.address} at ${clockText(input.at, input.timeZone)}, outside any cleaning.`;
}

/** Fixer Core news: a pro who hasn't come in by the start plus the grace. */
export function proNoArrivalText(input: { proName: string; from: string; timeZone: string }): string {
  return `${input.proName} hasn't arrived for the visit that started at ${clockText(input.from, input.timeZone)}.`;
}

/** Fixer Core news: a crew day with no one in by the start plus the grace. */
export function crewNoArrivalText(input: { proName: string; from: string; timeZone: string }): string {
  return `No one from ${input.proName}'s crew has come in today. Work was set to start at ${clockText(input.from, input.timeZone)}.`;
}

/** Fixer Core news: a pro's code opened the door outside their visit. */
export function proStrayText(input: { proName: string; device: string; at: string; timeZone: string }): string {
  return `${input.proName}'s code opened the ${input.device.toLowerCase()} at ${clockText(input.at, input.timeZone)}, outside their visit.`;
}
