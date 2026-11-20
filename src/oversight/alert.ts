import { formatClockTime, formatVisitorClock } from "../core/timezone";
import type { VisitResult } from "./check";

/**
 * The day's alert text (#240): one message, every newly missed or can't-tell visit in it, in the property's time zone. Plain
 * words, no door code, and no guessed pronouns. Sending it is #250's.
 */

const clock = (hhmm: string) => formatClockTime(hhmm).replace(":00", "");

const at = (iso: string, timeZone: string) => formatVisitorClock(new Date(iso), timeZone);

function quietSentence(visit: VisitResult, timeZone: string): string {
  const spans = (visit.quiet ?? []).map((span) => {
    const when = span.until ? `from ${at(span.from, timeZone)} to ${at(span.until, timeZone)}` : `since ${at(span.from, timeZone)}`;
    return span.device ? `The ${span.device} lock couldn't report ${when}` : `The lock connection was off ${when}`;
  });
  return `${spans.join(", and ")}, so I can't tell if anyone came in.`;
}

function sentences(visit: VisitResult, timeZone: string): string {
  const when = visit.from && visit.to ? `between ${clock(visit.from)} and ${clock(visit.to)}` : "today";
  const why = visit.note ? ` (${visit.note})` : "";
  const parts = [`${visit.who} was expected ${when}${why}.`];
  parts.push(visit.why === "lock-quiet" ? quietSentence(visit, timeZone) : `No one came in by ${at(visit.flagAt, timeZone)}.`);
  for (const seen of visit.sightings) parts.push(`The ${seen.device} camera saw someone at ${at(seen.at, timeZone)}.`);
  for (const other of visit.others) {
    const by = other.party === "host" ? "with the host's code" : other.party === "guest" ? "with a guest's code" : `by ${other.person}`;
    parts.push(`The door was opened at ${at(other.at, timeZone)} ${by}.`);
  }
  return parts.join(" ");
}

export function alertText(label: string, flagged: VisitResult[], timeZone: string): string {
  return `Today at ${label}: ${flagged.map((visit) => sentences(visit, timeZone)).join(" ")}`;
}
