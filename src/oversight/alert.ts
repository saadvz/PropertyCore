import { formatClockTime, formatVisitorClock } from "../core/timezone";
import type { VisitResult } from "./check";

/**
 * The day's alert text (#240): one message, every newly missed visit in it, in the property's time zone. Plain
 * words, no door code, and no guessed pronouns. Sending it is #250's.
 */

const clock = (hhmm: string) => formatClockTime(hhmm).replace(":00", "");

function sentences(visit: VisitResult, timeZone: string): string {
  const when = visit.from && visit.to ? `between ${clock(visit.from)} and ${clock(visit.to)}` : "today";
  const why = visit.note ? ` (${visit.note})` : "";
  const parts = [`${visit.who} was expected ${when}${why}.`, `No one came in by ${formatVisitorClock(new Date(visit.flagAt), timeZone)}.`];
  for (const other of visit.others) parts.push(`The door was opened at ${formatVisitorClock(new Date(other.at), timeZone)} by ${other.person}.`);
  return parts.join(" ");
}

export function alertText(label: string, missed: VisitResult[], timeZone: string): string {
  return `Today at ${label}: ${missed.map((visit) => sentences(visit, timeZone)).join(" ")}`;
}
