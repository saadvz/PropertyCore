import { addCalendarDays, zonedInstant } from "../hub/calendar";
import { alertText } from "./alert";
import type { QuietSpan, Sighting, SwitchedOn } from "./evidence";
import type { EntryEvent } from "./events";
import { whoMatches, type ExpectedVisit } from "./visits";

/**
 * The same-day check (#240): one day's expected visits at a property against that day's entry events. A visit with
 * no entry is flagged the same day: 1 hour after its window, or at 8 PM for an all-day visit. A property with no
 * connected lock can't tell, and isn't flagged; a lock that couldn't report during the window is "can't tell", told
 * like a miss but never as one. A camera sighting is support only: it never makes a visit "came". It texts nobody:
 * it returns the result and the alert text, and sending is #250's.
 */

export interface VisitResult {
  id: string;
  who: string;
  date: string;
  from?: string;
  to?: string;
  note?: string;
  outcome: "came" | "waiting" | "missed" | "unknown";
  /** Why it can't tell: no connected lock, or a lock that couldn't report during the window. */
  why?: "no-lock" | "lock-quiet";
  /** With "lock-quiet": the spans that overlap the counting window. */
  quiet?: QuietSpan[];
  /** When a visit with no entry is flagged, ISO. */
  flagAt: string;
  entry?: { at: string; device: string; person?: string; unnamed?: true };
  /** The entry came after the flag time, still that day. */
  late?: true;
  /** A run before this one already flagged it, so it isn't in this alert. */
  alreadyFlagged?: true;
  /** Entries in the counting window by someone else: a named person, or the host's or a guest's code. */
  others: { at: string; person?: string; party?: "host" | "guest" }[];
  /** People seen on a camera in the counting window. Support only. */
  sightings: Sighting[];
}

export type DayResult =
  | { status: "none"; reason: string }
  | { status: "ok"; visits: VisitResult[] }
  | { status: "flags"; visits: VisitResult[]; missed: VisitResult[]; unsure: VisitResult[]; alert?: string };

/** What the check reads besides the visits. `lock` defaults to true, so sample entries alone still check. */
export interface DayEvidence {
  entries: EntryEvent[];
  lock?: boolean;
  /** The host's switch to connected locks over time. A window with none of it is no lock; a part of a window outside it is quiet. */
  switched?: SwitchedOn[];
  quiet?: QuietSpan[];
  sightings?: Sighting[];
}

/** The parts of [start, end] outside every on-stretch, as quiet spans. Undefined when no part is inside one. */
function switchGaps(switched: readonly SwitchedOn[], start: number, end: number): QuietSpan[] | undefined {
  const on = switched
    .map((s) => [Math.max(ms(s.from), start), Math.min(s.until === undefined ? Infinity : ms(s.until), end)] as const)
    .filter(([a, b]) => a < b)
    .sort((x, y) => x[0] - y[0]);
  if (!on.length) return undefined;
  const gaps: QuietSpan[] = [];
  let cursor = start;
  for (const [a, b] of on) {
    if (a > cursor) gaps.push({ from: new Date(cursor).toISOString(), until: new Date(a).toISOString(), why: "disconnected" });
    cursor = Math.max(cursor, b);
  }
  if (cursor < end) gaps.push({ from: new Date(cursor).toISOString(), why: "disconnected" });
  return gaps;
}

export const EARLY_MS = 30 * 60_000;
export const LATE_MS = 60 * 60_000;
export const ALL_DAY_FLAG = "20:00";

const ms = (iso: string) => new Date(iso).getTime();

function judge(visit: ExpectedVisit, evidence: DayEvidence, timeZone: string, now: Date): VisitResult {
  const { entries } = evidence;
  const dayStart = ms(zonedInstant(visit.date, "00:00", timeZone));
  const dayEnd = ms(zonedInstant(addCalendarDays(visit.date, 1), "00:00", timeZone));
  const lastMinute = ms(zonedInstant(visit.date, "23:59", timeZone));
  const timed = visit.from !== undefined && visit.to !== undefined;
  const start = timed ? ms(zonedInstant(visit.date, visit.from!, timeZone)) - EARLY_MS : dayStart;
  const windowEnd = timed ? Math.min(ms(zonedInstant(visit.date, visit.to!, timeZone)) + LATE_MS, dayEnd - 1) : dayEnd - 1;
  const flagAt = timed ? Math.min(ms(zonedInstant(visit.date, visit.to!, timeZone)) + LATE_MS, lastMinute) : ms(zonedInstant(visit.date, ALL_DAY_FLAG, timeZone));

  const sorted = [...entries].filter((e) => Number.isFinite(ms(e.at))).sort((a, b) => ms(a.at) - ms(b.at));
  const named = (e: EntryEvent) => typeof e.person === "string" && e.person.trim() !== "";
  const counts = (e: EntryEvent) => !e.party && (!named(e) || whoMatches(visit.who, e.person!));
  const inWindow = (iso: string) => ms(iso) >= start && ms(iso) <= windowEnd;
  const match = sorted.find((e) => ms(e.at) >= start && ms(e.at) < dayEnd && counts(e));
  const others = sorted
    .filter((e) => inWindow(e.at) && (named(e) || e.party) && !counts(e))
    .map((e) => (e.party ? { at: e.at, party: e.party } : { at: e.at, person: e.person!.trim() }));
  const sightings = (evidence.sightings ?? []).filter((s) => inWindow(s.at)).sort((a, b) => ms(a.at) - ms(b.at));
  const gaps = evidence.switched ? switchGaps(evidence.switched, start, windowEnd) : [];
  const quiet = [...(evidence.quiet ?? []).filter((q) => ms(q.from) <= windowEnd && (q.until === undefined || ms(q.until) >= start)), ...(gaps ?? [])].sort((a, b) => ms(a.from) - ms(b.from));

  const base = {
    id: visit.id,
    who: visit.who,
    date: visit.date,
    ...(timed ? { from: visit.from, to: visit.to } : {}),
    ...(visit.note ? { note: visit.note } : {}),
    flagAt: new Date(flagAt).toISOString(),
    others,
    sightings,
  };
  if (match) {
    const entry = { at: match.at, device: match.device, ...(named(match) ? { person: match.person!.trim() } : { unnamed: true as const }) };
    return { ...base, outcome: "came", entry, ...(ms(match.at) > flagAt ? { late: true as const } : {}) };
  }
  if (evidence.lock === false || gaps === undefined) return { ...base, outcome: "unknown", why: "no-lock" };
  if (now.getTime() < flagAt) return { ...base, outcome: "waiting" };
  const flagged = visit.flaggedAt ? { alreadyFlagged: true as const } : {};
  if (quiet.length) return { ...base, outcome: "unknown", why: "lock-quiet", quiet, ...flagged };
  return { ...base, outcome: "missed", ...flagged };
}

export function checkDay(input: { label: string; visits: ExpectedVisit[]; date: string; timeZone: string; now: Date } & DayEvidence): DayResult {
  const today = input.visits.filter((visit) => visit.date === input.date && !visit.cancelledAt);
  if (!today.length) return { status: "none", reason: "No visits are expected that day." };
  const visits = today
    .map((visit) => judge(visit, input, input.timeZone, input.now))
    .sort((a, b) => (a.from ?? "").localeCompare(b.from ?? "") || a.who.localeCompare(b.who));
  const missed = visits.filter((visit) => visit.outcome === "missed");
  const unsure = visits.filter((visit) => visit.why === "lock-quiet");
  if (!missed.length && !unsure.length) return { status: "ok", visits };
  const fresh = visits.filter((visit) => (visit.outcome === "missed" || visit.why === "lock-quiet") && !visit.alreadyFlagged);
  return { status: "flags", visits, missed, unsure, ...(fresh.length ? { alert: alertText(input.label, fresh, input.timeZone) } : {}) };
}
