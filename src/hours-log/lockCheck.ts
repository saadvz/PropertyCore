import { zonedParts } from "../core/timezone";
import { zonedInstant } from "../hub/calendar";
import { EARLY_MS, LOCK_AFTER_DONE_MS, lockConnected } from "../visits/derive";
import { codePerson, type LockEvent } from "../visits/events";
import { redactDigitRuns } from "../visits/store";
import type { RowFact } from "./fact";
import type { PropertyRecords } from "./sources";

/**
 * The month checked against the lock events (#238), both ways: every entry at the door is covered by a row
 * of the right person, or is a guest's or visitor's; and every on-site visit, while the lock was connected,
 * has an entry near it. A gap is a line for the host. Nothing here adds, removes or changes a row, so a
 * confirmed month's fingerprint never moves with it. No code digits: only the lock's name for a code, and
 * that with any digit run redacted.
 */

/** Whose an entry was, by the code used. "none": no code (the app, an auto-unlock). "unnamed": a code nobody saved. */
export type EntryWho = "cleaner" | "pro" | "host" | "package" | "shared" | "unnamed" | "none";

/** An entry no row covers. Local date and time at the property. */
export interface LockGap {
  eventId: string;
  date: string;
  time: string;
  device: string;
  who: EntryWho;
}

export type LockCheck =
  | { status: "no-lock" }
  | {
      status: "checked";
      /** Unlocks from outside in the month. */
      entries: number;
      /** Of those, the ones a row, or a guest stay, covers. */
      covered: number;
      /** Of those, a guest's or a visitor's own code: not work. */
      notWork: number;
      uncovered: LockGap[];
      /** On-site visit rows in the month, at a time the lock was connected, with no entry near them. Row ids. */
      visitsWithoutEntry: string[];
    };

/** The property's usual times, when none are saved. */
const DEFAULT_CHECK_IN = "16:00";
const DEFAULT_CHECKOUT = "11:00";

const pad = (n: number) => String(n).padStart(2, "0");

function local(at: string, timeZone: string): { date: string; time: string } {
  const p = zonedParts(new Date(at), timeZone);
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

const ms = (iso: string) => Date.parse(iso);

/** True when the fact's span, an hour either side, takes in the instant: an early arrival, or a lock after DONE. */
const near = (fact: RowFact, t: number) => ms(fact.at) - EARLY_MS <= t && t <= ms(fact.until ?? fact.at) + LOCK_AFTER_DONE_MS;

/** Logs whose on-site rows need an entry at the lock: the cleaner's, a pro's, a helper's. */
const visitLog = (fact: RowFact) => fact.log === "cleaner" || fact.log.startsWith("pro:") || fact.log.startsWith("helper:");

export interface LockCheckInput {
  records: PropertyRecords;
  month: string;
  timeZone: string;
  /** Every month's facts, merged as the rows are, so a row across a month's edge still covers its entry. */
  facts: readonly RowFact[];
  idOf: (fact: RowFact) => string;
}

export function checkLocks({ records, month, timeZone, facts, idOf }: LockCheckInput): { check: LockCheck; needs: string[] } {
  const events = records.lockLog?.events ?? [];
  const codeNames = records.lockLog?.codeNames ?? {};
  const inMonth = (at: string) => local(at, timeZone).date.startsWith(`${month}-`);
  const entries = events
    .filter((event): event is LockEvent => event.type === "lock" && event.action === "unlock" && event.side !== "inside" && inMonth(event.at))
    .sort((a, b) => ms(a.at) - ms(b.at) || a.id.localeCompare(b.id));
  const onSite = facts.filter((fact) => fact.onSite && fact.log !== "property-core");
  const stays = guestStays(records, timeZone);
  const needs: string[] = [];

  let covered = 0;
  let notWork = 0;
  const uncovered: LockGap[] = [];
  for (const entry of entries) {
    const t = ms(entry.at);
    const person = codePerson(codeNames, entry.codeName);
    if (person?.role === "guest" || person?.role === "visitor") {
      notWork++;
      continue;
    }
    const who: EntryWho = person ? person.role : entry.codeName ? "unnamed" : "none";
    const rowOk = onSite.some((fact) => {
      if (!near(fact, t)) return false;
      if (person?.role === "cleaner") return fact.log === "cleaner";
      if (person?.role === "pro") return fact.log === `pro:${person.proId}`;
      if (person?.role === "host") return fact.log === "owner";
      if (person?.role === "package") return fact.kind === "bring-in";
      return true;
    });
    // A code no one person owns, or no code, while guests are staying is the guests' coming and going.
    const stayOk = !rowOk && (who === "shared" || who === "unnamed" || who === "none") && stays.some(([from, until]) => from <= t && t <= until);
    if (rowOk || stayOk) {
      covered++;
      continue;
    }
    const at = local(entry.at, timeZone);
    uncovered.push({ eventId: entry.id, date: at.date, time: at.time, device: entry.device, who });
    const opened = whoText(records, entry, person);
    const cover = who === "shared" || who === "unnamed" || who === "none" ? "no row in the log or guest stay covers that time" : "no row in the log covers that time";
    needs.push(`${at.date} ${at.time}, ${entry.device}: ${opened}, and ${cover}. Ask the host what it was.`);
  }

  const unlocks = events.filter((event): event is LockEvent => event.type === "lock" && event.action === "unlock" && event.side !== "inside");
  const visitsWithoutEntry: string[] = [];
  let checkedVisits = 0;
  for (const fact of onSite) {
    if (!visitLog(fact) || (fact.timing !== "measured" && fact.timing !== "scheduled") || !inMonth(fact.at)) continue;
    if (!lockConnected(events, ms(fact.at))) continue;
    checkedVisits++;
    const from = ms(fact.at) - EARLY_MS;
    const until = ms(fact.until ?? fact.at);
    if (unlocks.some((u) => ms(u.at) >= from && ms(u.at) <= until)) continue;
    visitsWithoutEntry.push(idOf(fact));
    needs.push(`${local(fact.at, timeZone).date}, ${fact.task}${fact.participant ? ` (${fact.participant})` : ""}: no one opened the door at the lock during it. Ask the host how they got in.`);
  }

  if (entries.length === 0 && checkedVisits === 0) return { check: { status: "no-lock" }, needs: [] };
  return { check: { status: "checked", entries: entries.length, covered, notWork, uncovered, visitsWithoutEntry }, needs };
}

/** Each guest stay as instants: check-in day at the usual check-in time to checkout day at the usual checkout time. */
function guestStays(records: PropertyRecords, timeZone: string): [number, number][] {
  const checkIn = records.usualTimes?.checkIn ?? DEFAULT_CHECK_IN;
  const checkout = records.usualTimes?.checkout ?? DEFAULT_CHECKOUT;
  const out: [number, number][] = [];
  for (const stay of records.stays) {
    if (stay.kind !== "stay") continue;
    try {
      out.push([ms(zonedInstant(stay.checkIn, checkIn, timeZone)), ms(zonedInstant(stay.checkout, checkout, timeZone))]);
    } catch {
      // A stay with a date the calendar couldn't read covers nothing.
    }
  }
  return out;
}

/** Who opened the door, in words for the host. */
function whoText(records: PropertyRecords, entry: LockEvent, person: ReturnType<typeof codePerson>): string {
  switch (person?.role) {
    case "cleaner":
      return `${records.cleanerName ?? "the cleaner"}'s code opened it`;
    case "pro": {
      const name = records.fixer?.pros.find((pro) => pro.id === person.proId)?.name;
      return `${name ?? "a pro"}'s code opened it`;
    }
    case "host":
      return "the host's standing code opened it";
    case "package":
      return "the package code opened it";
    case "shared":
      return "a shared code opened it";
    default:
      return entry.codeName ? `a code no one saved ("${redactDigitRuns(entry.codeName)}") opened it` : `it was opened without a code${entry.method ? ` (${entry.method})` : ""}`;
  }
}
