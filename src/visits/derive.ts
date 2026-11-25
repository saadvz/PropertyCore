import { localDateOf } from "../core/timezone";
import { zonedInstant } from "../hub/calendar";
import { codePerson, type CodeNames, type LockEvent, type VisitEvent, type VisitKind, type VisitWho, type WindowEvent } from "./events";

/**
 * Visit records (#237), derived from the raw log by a pure function. Records are never saved: the same lines always
 * give the same records, and a rule change is a new derivation, not a rewrite. `RULES` names this derivation.
 */

export const RULES = 1;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** An unlock this long before a visit's window still counts as its arrival. */
export const EARLY_MS = HOUR;
/** A late arrival: after the expected time plus this. */
export const LATE_GRACE_MS = 30 * MINUTE;
export const SAME_DAY_LATE_GRACE_MS = 15 * MINUTE;
/** The time left before the next check-in, beyond the clean itself, when it's at risk. */
export const AT_RISK_BUFFER_MS = 30 * MINUTE;
/** A clean's length until five have been measured at the property. */
export const DEFAULT_CLEAN_MINUTES = 180;
export const MEASURED_CLEANS = 5;
/** Arrival-day readiness: checked this long before the next check-in. */
export const READY_LEAD_MS = 2 * HOUR;
export const SAME_DAY_READY_LEAD_MS = HOUR;
/** A lock from outside this long before DONE, to this long after, is the departure. */
export const LOCK_BEFORE_DONE_MS = 15 * MINUTE;
export const LOCK_AFTER_DONE_MS = HOUR;
/** Lock events this recent count as a connected lock, when no connection event says otherwise. */
export const LOCK_RECENT_MS = 7 * 24 * HOUR;

export type ArrivalSource = "lock" | "lock-unnamed" | "cleaner-text" | "pro-text" | "visit-page";
export type DepartureSource = "done-text" | "done-page" | "done-pro-text" | "lock" | "camera";

export interface Arrival {
  at: string;
  source: ArrivalSource;
  eventId: string;
}

export interface Departure {
  at: string;
  source: DepartureSource;
  eventId: string;
  /** The DONE it came from, when it came from one. */
  doneAt?: string;
  /** "matched": a lock from outside close to DONE; "none": no lock near it; "no-lock": no lock at the property. */
  lockCheck: "matched" | "none" | "no-lock";
}

export type VisitFlag =
  | { kind: "late"; at: string }
  | { kind: "at-risk"; at: string }
  | { kind: "no-show"; at: string }
  | { kind: "no-done"; at: string }
  | { kind: "not-ready"; at: string; why: NotReadyReason[] };

export type NotReadyReason = "not-done" | "visit-over-check-in" | "not-locked";

export interface VisitRecord {
  id: string;
  kind: VisitKind;
  who: VisitWho;
  window: { from: string; until: string; expectedAt: string; sameDay: boolean; checkIn?: string };
  lock: boolean;
  arrival?: Arrival;
  departure?: Departure;
  minutes?: number;
  flags: VisitFlag[];
  /** Completed-service notices kept for this visit (#237), by hash. Evidence only: they never set a time. */
  notices?: string[];
  /** When it's late (expected plus the grace), at risk, and checked for readiness. */
  times: { lateAt: string; atRiskAt?: string; readyAt?: string };
  rules: number;
}

/** An unlock with a named code whose person had no window open then. */
export interface Stray {
  eventId: string;
  at: string;
  device: string;
  who: { role: "cleaner" } | { role: "pro"; proId: string };
}

export interface Derived {
  visits: VisitRecord[];
  strays: Stray[];
  /** The clean length used for the at-risk time, in minutes. */
  cleanMinutes: number;
}

export interface DeriveContext {
  timeZone: string;
  codeNames: CodeNames;
  now: Date;
}

const ms = (iso: string) => Date.parse(iso);
const iso = (n: number) => new Date(n).toISOString();

/** The latest window per visit, in the order written, leaving out a visit whose last word was a cancel. */
function liveWindows(events: readonly VisitEvent[]): WindowEvent[] {
  const latest = new Map<string, WindowEvent | null>();
  for (const event of events) {
    if (event.type === "visit-window") latest.set(event.visit, event);
    else if (event.type === "visit-cancelled") latest.set(event.visit, null);
  }
  return [...latest.values()].filter((w): w is WindowEvent => w !== null);
}

/** Local midnight at the start of the instant's day. */
function dayStart(at: string, timeZone: string): number {
  const d = localDateOf(new Date(at), timeZone);
  const ymd = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  return ms(zonedInstant(ymd, "00:00", timeZone));
}

/** True when the property's lock was connected for this window. The hours log's lock check (#238) uses it too. */
export function lockConnected(events: readonly VisitEvent[], until: number): boolean {
  let said: boolean | undefined;
  let saidAt = -Infinity;
  for (const event of events) {
    if (event.type !== "lock-connection") continue;
    const at = ms(event.at);
    if (at <= until && at >= saidAt) {
      said = event.connected;
      saidAt = at;
    }
  }
  if (said !== undefined) return said;
  return events.some((event) => event.type === "lock" && ms(event.at) <= until + 24 * HOUR && ms(event.at) >= until - LOCK_RECENT_MS);
}

/** The range an unlock counts as this visit's arrival: a cleaner may come any time that day, a pro from an hour early. */
function arrivalRange(window: WindowEvent, timeZone: string): [number, number] {
  const start = window.kind === "cleaning" ? Math.min(dayStart(window.from, timeZone), ms(window.from) - EARLY_MS) : ms(window.from) - EARLY_MS;
  return [start, ms(window.until)];
}

function isOwnCode(window: WindowEvent, lock: LockEvent, codeNames: CodeNames): boolean {
  const person = codePerson(codeNames, lock.codeName);
  if (!person) return false;
  if (window.who.role === "cleaner") return person.role === "cleaner";
  return person.role === "pro" && person.proId === window.who.proId;
}

/** A code no one person owns: unnamed, not saved, or saved as shared. A guest's or the host's own code never counts. */
function isUnnamed(lock: LockEvent, codeNames: CodeNames): boolean {
  const person = codePerson(codeNames, lock.codeName);
  return !person || person.role === "shared";
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Every visit's record, and every stray entry, from the raw log. Pure. */
export function buildVisits(events: readonly VisitEvent[], context: DeriveContext): Derived {
  const { timeZone, codeNames } = context;
  const now = context.now.getTime();
  const windows = liveWindows(events).sort((a, b) => ms(a.from) - ms(b.from) || a.visit.localeCompare(b.visit));
  const locks = events.filter((event): event is LockEvent => event.type === "lock").sort((a, b) => ms(a.at) - ms(b.at) || a.id.localeCompare(b.id));
  const unlocks = locks.filter((lock) => lock.action === "unlock");
  const outsideLocks = locks.filter((lock) => lock.action === "lock" && lock.side !== "inside");
  const openAt = (t: number) => windows.filter((w) => ms(w.from) - EARLY_MS <= t && t <= ms(w.until));

  const visits: VisitRecord[] = [];
  const measuredCleans: number[] = [];
  let cleanMinutes = DEFAULT_CLEAN_MINUTES;
  for (const window of windows) {
    const from = ms(window.from);
    const until = ms(window.until);
    const lock = lockConnected(events, until);
    const [rangeStart, rangeEnd] = arrivalRange(window, timeZone);

    // Arrival: the person's own code first; else an unnamed or shared code when only this visit was open; else
    // their own words or the visit page.
    let arrival: Arrival | undefined;
    if (lock) {
      const own = unlocks.find((u) => ms(u.at) >= rangeStart && ms(u.at) <= rangeEnd && isOwnCode(window, u, codeNames));
      if (own) arrival = { at: own.at, source: "lock", eventId: own.id };
      else {
        const unnamed = unlocks.find((u) => {
          const t = ms(u.at);
          if (t < from - EARLY_MS || t > until || !isUnnamed(u, codeNames)) return false;
          const open = openAt(t);
          return open.length === 1 && open[0]!.visit === window.visit;
        });
        if (unnamed) arrival = { at: unnamed.at, source: "lock-unnamed", eventId: unnamed.id };
      }
    }

    // DONE: the cleaner's text, the pro's page or text.
    let done: { at: string; source: DepartureSource; eventId: string } | undefined;
    for (const event of events) {
      if (done) break;
      if (event.type === "message" && event.direction === "in" && event.visit === window.visit && event.label === "done") {
        done = { at: event.at, source: event.role === "pro" ? "done-pro-text" : "done-text", eventId: event.id };
      } else if (event.type === "visit-page" && event.visit === window.visit && event.step === "done") {
        done = { at: event.at, source: "done-page", eventId: event.id };
      }
    }

    if (!arrival) {
      const words = events.find(
        (event) =>
          (event.type === "message" && event.direction === "in" && event.visit === window.visit && event.role === window.who.role && event.label !== "done") ||
          (event.type === "visit-page" && event.visit === window.visit && event.step === "at-door"),
      );
      if (words) arrival = { at: words.at, source: words.type === "visit-page" ? "visit-page" : words.type === "message" && words.role === "pro" ? "pro-text" : "cleaner-text", eventId: words.id };
    }

    let departure: Departure | undefined;
    if (done) {
      const doneAt = ms(done.at);
      const near = lock ? outsideLocks.find((l) => ms(l.at) >= doneAt - LOCK_BEFORE_DONE_MS && ms(l.at) <= doneAt + LOCK_AFTER_DONE_MS) : undefined;
      departure = near
        ? { at: near.at, source: done.source, eventId: near.id, doneAt: done.at, lockCheck: "matched" }
        : { at: done.at, source: done.source, eventId: done.eventId, doneAt: done.at, lockCheck: lock ? "none" : "no-lock" };
    } else if (window.kind === "crew-day" && lock) {
      const last = [...outsideLocks].reverse().find((l) => ms(l.at) >= from && ms(l.at) <= until + LOCK_AFTER_DONE_MS);
      if (last) departure = { at: last.at, source: "lock", eventId: last.id, lockCheck: "matched" };
    }

    const minutes = arrival && departure && ms(departure.at) > ms(arrival.at) ? Math.round((ms(departure.at) - ms(arrival.at)) / MINUTE) : undefined;

    const grace = window.sameDay ? SAME_DAY_LATE_GRACE_MS : LATE_GRACE_MS;
    const lateAt = ms(window.expectedAt) + grace;
    if (window.kind === "cleaning") cleanMinutes = measuredCleans.length >= MEASURED_CLEANS ? median(measuredCleans.slice(-MEASURED_CLEANS)) : DEFAULT_CLEAN_MINUTES;
    const checkIn = window.checkIn ? ms(window.checkIn) : undefined;
    const atRiskAt = window.kind === "cleaning" && checkIn !== undefined ? checkIn - cleanMinutes * MINUTE - AT_RISK_BUFFER_MS : undefined;
    const readyAt = window.kind === "cleaning" && checkIn !== undefined ? checkIn - (window.sameDay ? SAME_DAY_READY_LEAD_MS : READY_LEAD_MS) : undefined;

    // Flags only with a lock: a property without one keeps today's behavior.
    const flags: VisitFlag[] = [];
    if (lock) {
      const arrivedAt = arrival ? ms(arrival.at) : undefined;
      if (arrivedAt !== undefined ? arrivedAt > lateAt : now >= lateAt) flags.push({ kind: "late", at: iso(arrivedAt !== undefined ? arrivedAt : lateAt) });
      if (atRiskAt !== undefined && (arrivedAt !== undefined ? arrivedAt > atRiskAt : now >= atRiskAt)) flags.push({ kind: "at-risk", at: iso(atRiskAt) });
      if (arrivedAt === undefined && !done && now >= until) flags.push({ kind: "no-show", at: iso(until) });
      if (arrivedAt !== undefined && !done && window.kind !== "crew-day" && now >= until) flags.push({ kind: "no-done", at: iso(until) });
      if (readyAt !== undefined && checkIn !== undefined && now >= readyAt) {
        const why: NotReadyReason[] = [];
        const doneBy = done && ms(done.at) <= readyAt;
        if (!doneBy) why.push("not-done");
        if (windows.some((w) => w.kind !== "cleaning" && ms(w.from) < checkIn && ms(w.until) > checkIn)) why.push("visit-over-check-in");
        if (doneBy) {
          // Nobody left inside: the last unlock after DONE is followed by a lock from outside.
          const lastIn = [...unlocks].reverse().find((u) => ms(u.at) > ms(done!.at) && ms(u.at) <= readyAt && !isGuest(u, codeNames));
          if (lastIn && !outsideLocks.some((l) => ms(l.at) > ms(lastIn.at) && ms(l.at) <= readyAt)) why.push("not-locked");
        }
        if (why.length > 0) flags.push({ kind: "not-ready", at: iso(readyAt), why });
      }
    }

    if (window.kind === "cleaning" && minutes !== undefined && arrival?.source === "lock") measuredCleans.push(minutes);
    const notices = events.filter((event) => event.type === "service-notice" && event.visit === window.visit).map((event) => (event as { notice: string }).notice);

    visits.push({
      id: window.visit,
      kind: window.kind,
      who: window.who,
      window: { from: window.from, until: window.until, expectedAt: window.expectedAt, sameDay: window.sameDay, ...(window.checkIn ? { checkIn: window.checkIn } : {}) },
      lock,
      ...(arrival ? { arrival } : {}),
      ...(departure ? { departure } : {}),
      ...(minutes !== undefined ? { minutes } : {}),
      flags,
      ...(notices.length > 0 ? { notices } : {}),
      times: { lateAt: iso(lateAt), ...(atRiskAt !== undefined ? { atRiskAt: iso(atRiskAt) } : {}), ...(readyAt !== undefined ? { readyAt: iso(readyAt) } : {}) },
      rules: RULES,
    });
  }

  // Strays: a named code's unlock with no window of theirs open, an hour either side (a cleaner's whole day counts).
  const strays: Stray[] = [];
  for (const unlock of unlocks) {
    if (!lockConnected(events, ms(unlock.at))) continue;
    const person = codePerson(codeNames, unlock.codeName);
    if (person?.role !== "cleaner" && person?.role !== "pro") continue;
    const t = ms(unlock.at);
    const theirs = windows.filter((w) => (person.role === "cleaner" ? w.who.role === "cleaner" : w.who.role === "pro" && w.who.proId === person.proId));
    const inside = theirs.some((w) => {
      const [start] = arrivalRange(w, timeZone);
      return t >= start && t <= ms(w.until) + EARLY_MS;
    });
    if (!inside) strays.push({ eventId: unlock.id, at: unlock.at, device: unlock.device, who: person.role === "cleaner" ? { role: "cleaner" } : { role: "pro", proId: person.proId } });
  }

  return { visits, strays, cleanMinutes: measuredCleans.length >= MEASURED_CLEANS ? median(measuredCleans.slice(-MEASURED_CLEANS)) : DEFAULT_CLEAN_MINUTES };
}

function isGuest(lock: LockEvent, codeNames: CodeNames): boolean {
  return codePerson(codeNames, lock.codeName)?.role === "guest";
}
