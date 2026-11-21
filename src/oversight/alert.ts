import { formatClockTime, formatVisitorClock, localDateOf, timeOnDay } from "../core/timezone";
import type { VisitResult } from "./check";

/**
 * The day's alert text (#240): one message, every newly missed or can't-tell visit in it, in the property's time zone. Plain
 * words, no door code, and no guessed pronouns. The host-alert clock (src/hosted/hostAlerts.ts, #250) sends it.
 */

const clock = (hhmm: string) => formatClockTime(hhmm).replace(":00", "");

const at = (iso: string, timeZone: string) => formatVisitorClock(new Date(iso), timeZone);

const pad = (n: number) => String(n).padStart(2, "0");

/** The time, with its day when it isn't the visit's own day. */
function onDay(iso: string, date: string, timeZone: string): string {
  const d = localDateOf(new Date(iso), timeZone);
  return `${d.year}-${pad(d.month)}-${pad(d.day)}` === date ? at(iso, timeZone) : timeOnDay(new Date(iso), timeZone);
}

function quietSentence(visit: VisitResult, timeZone: string): string {
  const spans = (visit.quiet ?? []).map((span) => {
    const from = onDay(span.from, visit.date, timeZone);
    if (span.until) {
      const when = `from ${from} to ${onDay(span.until, visit.date, timeZone)}`;
      return span.device ? `The ${span.device} lock was offline ${when}` : `The locks here weren't connected ${when}`;
    }
    return span.device ? `The ${span.device} lock has been offline since ${from}` : `The locks here haven't been connected since ${from}`;
  });
  return `${spans.join(", and ")}, so I can't tell whether anyone came in.`;
}

function sentences(visit: VisitResult, timeZone: string): string {
  const when = visit.from && visit.to ? `between ${clock(visit.from)} and ${clock(visit.to)}` : "today";
  const why = visit.note ? ` (${visit.note})` : "";
  const parts = [`${visit.who} was expected ${when}${why}.`];
  parts.push(visit.why === "lock-quiet" ? quietSentence(visit, timeZone) : `No one came in by ${at(visit.flagAt, timeZone)}.`);
  for (const seen of visit.sightings) parts.push(`The ${seen.device} camera saw someone at ${at(seen.at, timeZone)}.`);
  for (const other of visit.others) {
    const by = other.party === "host" ? "with your own code" : other.party === "guest" ? "with a guest's code" : `by ${other.person}`;
    parts.push(`The door was opened at ${at(other.at, timeZone)} ${by}.`);
  }
  return parts.join(" ");
}

export function alertText(label: string, flagged: VisitResult[], timeZone: string): string {
  return `Today at ${label}: ${flagged.map((visit) => sentences(visit, timeZone)).join(" ")}`;
}
