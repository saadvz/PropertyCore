import { localDateOf } from "../core/timezone";
import { addCalendarDays } from "../hub/calendar";
import { readHubFile } from "../hub/store";
import { checkDay, type DayResult } from "./check";
import type { EntryEvent } from "./events";
import { visitFromInvite } from "./invite";
import { OversightFileError, readOversight, writeOversight, type OversightFile } from "./store";
import { cleanVisit, isDate, MAX_OPEN_VISITS, newVisitId, sameVisit, visitProblem, type ExpectedVisit, type VisitInput } from "./visits";

/**
 * Expected visits for one property (#240): save one from the manager's text or a calendar invite, list and cancel
 * them, and run one day against given entry events. It texts nobody: the result goes back to the caller, and
 * sending is #250's.
 */

export interface OversightReply {
  text: string;
  structured?: Record<string, unknown>;
  isError: boolean;
}

export interface OversightDeps {
  now: () => Date;
}

const RECENT_DAYS = 7;
const NOTHING_SENT = "Nothing is sent to anyone from here.";

const ok = (structured: Record<string, unknown>): OversightReply => ({ text: JSON.stringify(structured), structured, isError: false });
const fail = (text: string): OversightReply => ({ text, isError: true });
const pad = (n: number) => String(n).padStart(2, "0");

const byWhen = (a: ExpectedVisit, b: ExpectedVisit) => a.date.localeCompare(b.date) || (a.from ?? "").localeCompare(b.from ?? "") || a.who.localeCompare(b.who);

export class OversightDesk {
  constructor(
    private readonly root: string,
    private readonly deps: OversightDeps,
  ) {}

  /** A broken oversight.json is a plain refusal, and nothing is written over it. */
  private guarded(run: () => OversightReply): OversightReply {
    try {
      return run();
    } catch (error) {
      if (error instanceof OversightFileError) return fail(error.message);
      throw error;
    }
  }

  private timeZone(): string | undefined {
    try {
      return readHubFile(this.root)?.property.timeZone || undefined;
    } catch {
      return undefined;
    }
  }

  private today(timeZone: string): string {
    const d = localDateOf(this.deps.now(), timeZone);
    return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
  }

  /**
   * Saves one expected visit: `who`, `date`, `from`/`to` and `note` from the manager's text, or `invite` (the
   * invite's text). An invite is read back without saving until `confirm` is true.
   */
  addVisit(input: { who?: unknown; date?: unknown; from?: unknown; to?: unknown; note?: unknown; invite?: unknown; confirm?: unknown }): OversightReply {
    return this.guarded(() => {
      // A broken record refuses before anything is read back, so the host never agrees to a visit that can't be saved.
      const file = readOversight(this.root);
      const timeZone = this.timeZone();
      if (!timeZone) return fail("The property has no time zone yet, so its days can't be told apart. Set the property's time zone first.");
      const today = this.today(timeZone);
      let candidate: Record<string, unknown>;
      let source: ExpectedVisit["source"] = "text";
      let titleLeftOut = false;
      if (input.invite !== undefined) {
        if (typeof input.invite !== "string" || !input.invite.trim()) return fail("Give the invite's text, or the visit's details.");
        if (input.date !== undefined || input.from !== undefined || input.to !== undefined || input.note !== undefined) return fail("Give the invite or the visit's details, not both. who can go with an invite.");
        const read = visitFromInvite(input.invite, timeZone);
        if (!read.ok) return fail(read.reason);
        const who = input.who ?? read.visit.who;
        if (who === undefined) return fail("The invite doesn't say who's coming. Ask the host, then give who with the invite.");
        candidate = { ...read.visit, who };
        source = "invite";
        titleLeftOut = read.titleLeftOut === true;
      } else {
        candidate = { who: input.who, date: input.date, from: input.from, to: input.to, note: input.note };
        for (const key of Object.keys(candidate)) if (candidate[key] === undefined) delete candidate[key];
      }
      const problem = visitProblem(candidate, today);
      if (problem) return fail(problem);
      const visit = cleanVisit(candidate as unknown as VisitInput);
      const leftOut = titleLeftOut ? { titleLeftOut: true } : {};
      const leftOutNote = titleLeftOut ? " The invite's title may hold a code, so it was left out." : "";
      if (source === "invite" && input.confirm !== true) {
        return ok({ saved: false, visit: { ...visit, source }, ...leftOut, next: `Read this visit back to the host. Save it only after they agree, by calling again with confirm: true.${leftOutNote}` });
      }
      const existing = file.visits.find((v) => !v.cancelledAt && sameVisit(v, visit));
      if (existing) return ok({ saved: false, duplicate: true, visit: existing, next: "That visit is already saved." });
      const open = file.visits.filter((v) => !v.cancelledAt && v.date >= today).length;
      if (open >= MAX_OPEN_VISITS) return fail(`There are already ${MAX_OPEN_VISITS} expected visits ahead. Cancel some before adding more.`);
      const saved: ExpectedVisit = { id: newVisitId(), ...visit, source, savedAt: this.deps.now().toISOString() };
      writeOversight(this.root, { ...file, visits: [...file.visits, saved] });
      return ok({ saved: true, visit: saved, ...leftOut, next: `Saved. If no one comes in, it's flagged the same day. ${NOTHING_SENT}${leftOutNote}` });
    });
  }

  /** Visits from today on, and the last week's with their flags and cancellations. */
  listVisits(): OversightReply {
    return this.guarded(() => {
      const timeZone = this.timeZone();
      if (!timeZone) return fail("The property has no time zone yet, so its days can't be told apart. Set the property's time zone first.");
      const today = this.today(timeZone);
      const since = addCalendarDays(today, -RECENT_DAYS);
      const file = readOversight(this.root);
      const open = file.visits.filter((v) => !v.cancelledAt && v.date >= today).sort(byWhen);
      const recent = file.visits.filter((v) => v.date < today && v.date >= since).sort(byWhen);
      return ok({ today, open, recent, next: open.length ? NOTHING_SENT : `No visits are expected ahead. ${NOTHING_SENT}` });
    });
  }

  /** Cancels one visit by id, after the host says so. It's kept for the record and never checked. */
  cancelVisit(input: { id?: unknown }): OversightReply {
    return this.guarded(() => {
      if (typeof input.id !== "string" || !input.id) return fail("Give the visit's id from list_expected_visits.");
      const file = readOversight(this.root);
      const visit = file.visits.find((v) => v.id === input.id);
      if (!visit) return fail("There's no expected visit with that id. List the visits to find it.");
      if (visit.cancelledAt) return ok({ cancelled: true, visit, next: "That visit was already cancelled." });
      const cancelled = { ...visit, cancelledAt: this.deps.now().toISOString() };
      writeOversight(this.root, { ...file, visits: file.visits.map((v) => (v.id === visit.id ? cancelled : v)) });
      return ok({ cancelled: true, visit: cancelled, next: `Cancelled. It won't be checked. ${NOTHING_SENT}` });
    });
  }

  /**
   * One day at the property against the given entry events. Records when each visit is first found missed, so a
   * later run of the same day leaves it out of the alert. Sends nothing.
   */
  runDay(date: string, entries: EntryEvent[], label: string): DayResult {
    if (!isDate(date)) return { status: "none", reason: "Give the day as YYYY-MM-DD." };
    let file: OversightFile;
    try {
      file = readOversight(this.root);
    } catch (error) {
      if (error instanceof OversightFileError) return { status: "none", reason: error.message };
      throw error;
    }
    const timeZone = this.timeZone();
    if (!timeZone) return { status: "none", reason: "The property has no time zone, so its days can't be told apart." };
    const now = this.deps.now();
    const result = checkDay({ label, visits: file.visits, entries, date, timeZone, now });
    if (result.status === "flags") {
      const fresh = new Set(result.missed.filter((v) => !v.alreadyFlagged).map((v) => v.id));
      if (fresh.size) writeOversight(this.root, { ...file, visits: file.visits.map((v) => (fresh.has(v.id) ? { ...v, flaggedAt: now.toISOString() } : v)) });
    }
    return result;
  }
}

export function oversightDeskFor(root: string, deps: OversightDeps): OversightDesk {
  return new OversightDesk(root, deps);
}
