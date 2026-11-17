import { addCalendarDays, zonedInstant } from "../hub/calendar";
import { alertText } from "./alert";
import type { EntryEvent } from "./events";
import { whoMatches, type ExpectedVisit } from "./visits";

/**
 * The same-day check (#240): one day's expected visits at a property against that day's entry events. A visit with
 * no entry is flagged the same day: 1 hour after its window, or at 8 PM for an all-day visit. It texts nobody: it
 * returns the result and the alert text, and sending is #250's.
 */

export interface VisitResult {
  id: string;
  who: string;
  date: string;
  from?: string;
  to?: string;
  note?: string;
  outcome: "came" | "waiting" | "missed";
  /** When a visit with no entry is flagged, ISO. */
  flagAt: string;
  entry?: { at: string; device: string; person?: string; unnamed?: true };
  /** The entry came after the flag time, still that day. */
  late?: true;
  /** A run before this one already flagged it, so it isn't in this alert. */
  alreadyFlagged?: true;
  /** Entries in the counting window by someone else. */
  others: { at: string; person: string }[];
}

export type DayResult =
  | { status: "none"; reason: string }
  | { status: "ok"; visits: VisitResult[] }
  | { status: "flags"; visits: VisitResult[]; missed: VisitResult[]; alert?: string };

export const EARLY_MS = 30 * 60_000;
export const LATE_MS = 60 * 60_000;
export const ALL_DAY_FLAG = "20:00";

const ms = (iso: string) => new Date(iso).getTime();

function judge(visit: ExpectedVisit, entries: EntryEvent[], timeZone: string, now: Date): VisitResult {
  const dayStart = ms(zonedInstant(visit.date, "00:00", timeZone));
  const dayEnd = ms(zonedInstant(addCalendarDays(visit.date, 1), "00:00", timeZone));
  const lastMinute = ms(zonedInstant(visit.date, "23:59", timeZone));
  const timed = visit.from !== undefined && visit.to !== undefined;
  const start = timed ? ms(zonedInstant(visit.date, visit.from!, timeZone)) - EARLY_MS : dayStart;
  const windowEnd = timed ? Math.min(ms(zonedInstant(visit.date, visit.to!, timeZone)) + LATE_MS, dayEnd - 1) : dayEnd - 1;
  const flagAt = timed ? Math.min(ms(zonedInstant(visit.date, visit.to!, timeZone)) + LATE_MS, lastMinute) : ms(zonedInstant(visit.date, ALL_DAY_FLAG, timeZone));

  const sorted = [...entries].filter((e) => Number.isFinite(ms(e.at))).sort((a, b) => ms(a.at) - ms(b.at));
  const named = (e: EntryEvent) => typeof e.person === "string" && e.person.trim() !== "";
  const counts = (e: EntryEvent) => !named(e) || whoMatches(visit.who, e.person!);
  const match = sorted.find((e) => ms(e.at) >= start && ms(e.at) < dayEnd && counts(e));
  const others = sorted.filter((e) => ms(e.at) >= start && ms(e.at) <= windowEnd && named(e) && !counts(e)).map((e) => ({ at: e.at, person: e.person!.trim() }));

  const base = {
    id: visit.id,
    who: visit.who,
    date: visit.date,
    ...(timed ? { from: visit.from, to: visit.to } : {}),
    ...(visit.note ? { note: visit.note } : {}),
    flagAt: new Date(flagAt).toISOString(),
    others,
  };
  if (match) {
    const entry = { at: match.at, device: match.device, ...(named(match) ? { person: match.person!.trim() } : { unnamed: true as const }) };
    return { ...base, outcome: "came", entry, ...(ms(match.at) > flagAt ? { late: true as const } : {}) };
  }
  if (now.getTime() < flagAt) return { ...base, outcome: "waiting" };
  return { ...base, outcome: "missed", ...(visit.flaggedAt ? { alreadyFlagged: true as const } : {}) };
}

export function checkDay(input: { label: string; visits: ExpectedVisit[]; entries: EntryEvent[]; date: string; timeZone: string; now: Date }): DayResult {
  const today = input.visits.filter((visit) => visit.date === input.date && !visit.cancelledAt);
  if (!today.length) return { status: "none", reason: "No visits are expected that day." };
  const visits = today
    .map((visit) => judge(visit, input.entries, input.timeZone, input.now))
    .sort((a, b) => (a.from ?? "").localeCompare(b.from ?? "") || a.who.localeCompare(b.who));
  const missed = visits.filter((visit) => visit.outcome === "missed");
  if (!missed.length) return { status: "ok", visits };
  const fresh = missed.filter((visit) => !visit.alreadyFlagged);
  return { status: "flags", visits, missed, ...(fresh.length ? { alert: alertText(input.label, fresh, input.timeZone) } : {}) };
}
