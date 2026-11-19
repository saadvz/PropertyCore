import { localDateOf } from "../core/timezone";
import type { Derived } from "./derive";
import { jobOfVisit } from "./events";
import { atRiskText, cleanerStrayText, crewNoArrivalText, lateAskText, noShowText, notReadyText, proNoArrivalText, proStrayText } from "./wording";

/**
 * What's due now from visit records (#237), pure. Cleaner Core sends its items through its own consent-checked send
 * path, each under its id, so each goes once; Fixer Core adds its items as news, once each. Only a visit with a
 * connected lock ever gives an item: a property without one keeps today's behavior.
 */

const HOUR = 3_600_000;
/** A no-show is told until this long after the window, so a restart days later doesn't bring up an old one. */
const NO_SHOW_TELL_MS = 12 * HOUR;
/** A stray entry is told for this long after it. */
const STRAY_TELL_MS = 24 * HOUR;

export interface CleaningDue {
  /** The outbox id: the same item always has the same id. */
  id: string;
  to: "cleaner" | "host";
  kind: "late-ask" | "at-risk" | "no-show" | "not-ready" | "stray";
  jobId?: string;
  body: string;
}

const ms = (iso: string) => Date.parse(iso);
const localDay = (at: string, timeZone: string) => {
  const d = localDateOf(new Date(at), timeZone);
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
};

/** Cleaner Core's due items. `sent(id)` says whether an earlier item already went. */
export function cleaningDue(derived: Derived, input: { now: Date; timeZone: string; address: string; cleanerName?: string; sent: (id: string) => boolean }): CleaningDue[] {
  const now = input.now.getTime();
  const { timeZone, address, cleanerName } = input;
  const out: CleaningDue[] = [];
  for (const visit of derived.visits) {
    if (visit.kind !== "cleaning" || !visit.lock) continue;
    const jobId = jobOfVisit(visit.id);
    const until = ms(visit.window.until);
    const checkIn = visit.window.checkIn ? ms(visit.window.checkIn) : undefined;
    const waiting = !visit.arrival && !visit.departure;
    if (waiting && now >= ms(visit.times.lateAt) && now < until) {
      out.push({ id: `late-ask:${jobId}`, to: "cleaner", kind: "late-ask", jobId, body: lateAskText({ ...(cleanerName ? { cleanerName } : {}), address }) });
    }
    const atRiskAt = visit.times.atRiskAt ? ms(visit.times.atRiskAt) : undefined;
    if (waiting && atRiskAt !== undefined && checkIn !== undefined && now >= atRiskAt && now < Math.min(checkIn, until)) {
      out.push({ id: `at-risk:${jobId}`, to: "host", kind: "at-risk", jobId, body: atRiskText({ ...(cleanerName ? { cleanerName } : {}), address, checkIn: visit.window.checkIn!, timeZone }) });
    }
    if (waiting && now >= until && now < until + NO_SHOW_TELL_MS && !input.sent(`at-risk:${jobId}`)) {
      out.push({ id: `no-show:${jobId}`, to: "host", kind: "no-show", jobId, body: noShowText({ ...(cleanerName ? { cleanerName } : {}), address, until: visit.window.until, timeZone }) });
    }
    const notReady = visit.flags.find((flag) => flag.kind === "not-ready");
    if (notReady && notReady.kind === "not-ready" && checkIn !== undefined && now < checkIn) {
      out.push({ id: `not-ready:${jobId}`, to: "host", kind: "not-ready", jobId, body: notReadyText({ address, checkIn: visit.window.checkIn!, timeZone, why: notReady.why }) });
    }
  }
  const days = new Set<string>();
  for (const stray of derived.strays) {
    if (stray.who.role !== "cleaner" || now < ms(stray.at) || now >= ms(stray.at) + STRAY_TELL_MS) continue;
    const day = localDay(stray.at, timeZone);
    if (days.has(day)) continue;
    days.add(day);
    out.push({ id: `stray:cleaner:${day}`, to: "host", kind: "stray", body: cleanerStrayText({ address, device: stray.device, at: stray.at, timeZone }) });
  }
  return out;
}

export interface FixerDue {
  /** The news kind, once per job (or per day for a crew). */
  kind: string;
  jobId?: string;
  text: string;
}

/** Fixer Core's due news items. Pros are never texted about lateness: only the host hears. */
export function fixerDue(derived: Derived, input: { now: Date; timeZone: string; proName: (proId: string | undefined) => string }): FixerDue[] {
  const now = input.now.getTime();
  const out: FixerDue[] = [];
  for (const visit of derived.visits) {
    if (visit.kind === "cleaning" || !visit.lock) continue;
    if (visit.arrival || visit.departure) continue;
    if (now < ms(visit.times.lateAt) || now >= ms(visit.window.until)) continue;
    const jobId = jobOfVisit(visit.id);
    const proName = input.proName(visit.who.proId);
    if (visit.kind === "repair") out.push({ kind: "visit-no-arrival", jobId, text: proNoArrivalText({ proName, from: visit.window.from, timeZone: input.timeZone }) });
    else out.push({ kind: `crew-no-arrival:${visit.id.split(":")[2]}`, jobId, text: crewNoArrivalText({ proName, from: visit.window.from, timeZone: input.timeZone }) });
  }
  const days = new Set<string>();
  for (const stray of derived.strays) {
    if (stray.who.role !== "pro" || now < ms(stray.at) || now >= ms(stray.at) + STRAY_TELL_MS) continue;
    const day = localDay(stray.at, input.timeZone);
    const key = `${stray.who.proId}:${day}`;
    if (days.has(key)) continue;
    days.add(key);
    out.push({ kind: `visit-stray:${key}`, text: proStrayText({ proName: input.proName(stray.who.proId), device: stray.device, at: stray.at, timeZone: input.timeZone }) });
  }
  return out;
}
