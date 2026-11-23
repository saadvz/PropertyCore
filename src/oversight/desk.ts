import { join } from "node:path";
import { formatDay, localDateOf } from "../core/timezone";
import { normalizePhone } from "../locks/desk";
import { ConfirmationBook } from "../operator/confirmations";
import { addCalendarDays } from "../hub/calendar";
import { readHubFile } from "../hub/store";
import { visitLogFor } from "../visits/store";
import { checkDay, type DayEvidence, type DayResult, type VisitResult } from "./check";
import { dayEvidence, entryNamesFrom, standingNames } from "./evidence";
import { visitFromInvite } from "./invite";
import { OversightFileError, readOversight, writeOversight, type OversightFile } from "./store";
import { cleanVisit, isDate, MAX_OPEN_VISITS, newVisitId, sameVisit, visitProblem, type ExpectedVisit, type VisitInput, type Visitor } from "./visits";

/**
 * Expected visits for one property (#240): save one from what the host says or a calendar invite, list and cancel
 * them, and run one day against the property's visit log: its unlocks, when a lock couldn't report, and people seen
 * on a camera. It texts nobody: the result goes back to the caller, and the host-alert clock (src/hosted/hostAlerts.ts, #250) sends it.
 */

export interface OversightReply {
  text: string;
  structured?: Record<string, unknown>;
  isError: boolean;
}

export interface OversightDeps {
  now: () => Date;
  /** The account has connected locks on with a lock connection, so the property's lock lines can be read. Off by default. */
  locks?: () => boolean;
  /** The property is switched to connected locks now. Used only for a log with no switch lines of the host's. Defaults to `locks`. */
  lockedNow?: () => boolean;
  /** The property's door locks, by name as the log writes them. Only these can be a lock that couldn't report. */
  doors?: () => readonly string[];
  /** The account has cameras on, so camera sightings can be read. Off by default. */
  cameras?: () => boolean;
  /** Visit codes can be made here (#280 17): the account's locks on and the property on connected locks. Off by default. */
  codes?: () => boolean;
  /** The host's confirmed mobile, so it's never saved as a visitor. */
  hostPhone?: () => string | undefined;
  /** This phone replied STOP to the account's line. */
  stopped?: (phone: string) => boolean;
  /** This phone is already a person on the property who said YES (a cleaner, co-host, assistant or pro): no new invite. */
  optedInHere?: (phone: string) => boolean;
  /** Where a visit's code is on the locks now (on-lock, programming, failed, none-during-stay), from the lock side. */
  codeStatus?: (visit: ExpectedVisit) => string | undefined;
}

/** What a visit's code looks like to the agent: its state and the phone's last four, never the phone or a code. */
export type VisitCodeState = "none" | "opted-out" | "waiting-for-yes" | "texted" | "not-sent" | "making" | string;

const RECENT_DAYS = 7;
const APPROVAL_MS = 10 * 60_000;
const APPROVAL_STALE = "That approval has expired or doesn't match. Ask the host again.";
const NOTHING_SENT = "Nothing is sent to anyone from here.";
/** Code states where a visit's door code was made, so a cancel takes it off the lock. */
const CODE_MADE: ReadonlySet<VisitCodeState> = new Set(["texted", "not-sent", "on-lock", "failed", "programming"]);

const ok = (structured: Record<string, unknown>): OversightReply => ({ text: JSON.stringify(structured), structured, isError: false });
const fail = (text: string): OversightReply => ({ text, isError: true });
const pad = (n: number) => String(n).padStart(2, "0");

const byWhen = (a: ExpectedVisit, b: ExpectedVisit) => a.date.localeCompare(b.date) || (a.from ?? "").localeCompare(b.from ?? "") || a.who.localeCompare(b.who);

/** "12 to 5 PM", "9 AM to 12:30 PM": the read-back's times. */
function spokenWindow(from: string, to: string): string {
  const part = (clock: string) => {
    const [h, m] = clock.split(":").map(Number) as [number, number];
    const hour = h % 12 === 0 ? 12 : h % 12;
    return { text: m ? `${hour}:${String(m).padStart(2, "0")}` : String(hour), half: h < 12 ? "AM" : "PM" };
  };
  const a = part(from);
  const b = part(to);
  return a.half === b.half ? `${a.text} to ${b.text} ${b.half}` : `${a.text} ${a.half} to ${b.text} ${b.half}`;
}

/** The visit with its phone taken out: the phone's last four only. */
function shownVisit(visit: ExpectedVisit, code?: VisitCodeState): Record<string, unknown> {
  const { phone, code: _text, ...rest } = visit;
  return { ...rest, ...(phone ? { phoneLast4: phone.slice(-4) } : {}), ...(code ? { code } : {}) };
}

export class OversightDesk {
  private readonly approvals: ConfirmationBook;

  constructor(
    private readonly root: string,
    private readonly deps: OversightDeps,
  ) {
    this.approvals = new ConfirmationBook(APPROVAL_MS, () => this.deps.now().getTime(), { file: join(root, "oversight-approvals.json") });
  }

  /** A visitor's code state for list_expected_visits. */
  private codeState(file: OversightFile, visit: ExpectedVisit): VisitCodeState {
    if (!visit.phone) return "none";
    const visitor = file.visitors?.find((item) => item.phone === visit.phone);
    if (visitor?.stoppedAt || this.deps.stopped?.(visit.phone)) return "opted-out";
    if (!visitor?.yesAt && !this.deps.optedInHere?.(visit.phone)) return "waiting-for-yes";
    if (visit.code?.sent) return "texted";
    if (visit.code?.notSent) return "not-sent";
    return this.deps.codeStatus?.(visit) ?? "making";
  }

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
   * Saves one expected visit: `who`, `date`, `from`/`to` and `note` from what the host says, or `invite` (the
   * invite's text). An invite is read back without saving until `confirm` is true.
   */
  addVisit(input: { who?: unknown; date?: unknown; from?: unknown; to?: unknown; note?: unknown; invite?: unknown; confirm?: unknown; phone?: unknown; confirmation?: unknown }): OversightReply {
    return this.guarded(() => {
      // A broken record refuses before anything is read back, so the host never agrees to a visit that can't be saved.
      const file = readOversight(this.root);
      const timeZone = this.timeZone();
      if (!timeZone) return fail("The property has no time zone yet, so its days can't be told apart. Set the property's time zone first.");
      const today = this.today(timeZone);
      // A phone gives the visitor their own door code (#280 17), with the host's yes to the read-back.
      let phone: string | undefined;
      if (input.phone !== undefined && !(typeof input.phone === "string" && input.phone.trim() === "")) {
        if (this.deps.codes?.() !== true) return fail("Door codes for visitors need connected locks here. Save the visit without a phone, and it's still checked.");
        phone = typeof input.phone === "string" ? normalizePhone(input.phone) : undefined;
        if (!phone) return fail("That isn't a mobile number I can use. Ask for it with its country code, like +1 555 555 0142.");
        if (phone === this.deps.hostPhone?.()) return fail("That's your own number. Ask for a standing code with add_standing_code instead.");
        const known = file.visitors?.find((item) => item.phone === phone);
        if (known?.stoppedAt || this.deps.stopped?.(phone)) return fail("That number opted out of texts from this line (they replied STOP), so it can't get a code. Save the visit without a phone, and it's still checked.");
      }
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
      if (phone) {
        const known = file.visitors?.find((item) => item.phone === phone);
        const yes = Boolean(known?.yesAt) || this.deps.optedInHere?.(phone) === true;
        const when = visit.from !== undefined && visit.to !== undefined ? spokenWindow(visit.from, visit.to) : "all day";
        const question = `${visit.who}, ${formatDay(new Date(`${visit.date}T12:00:00Z`), "UTC")}, ${when}, with their own door code?${yes ? "" : " They get one text asking them to reply YES first."}`;
        const fingerprint = JSON.stringify([visit.who, visit.date, visit.from ?? "", visit.to ?? "", visit.note ?? "", phone]);
        const code = typeof input.confirmation === "string" && input.confirmation ? input.confirmation : undefined;
        if (!code) {
          return ok({ saved: false, visit: { ...visit, source, phoneLast4: phone.slice(-4) }, ...leftOut, question, confirmation: this.approvals.issue("visit-code", "oversight", fingerprint, question), next: `Ask the host: "${question}" Call again with the confirmation code only after their yes.${leftOutNote}` });
        }
        try {
          this.approvals.redeem(code, "visit-code", "oversight", fingerprint);
        } catch {
          return fail(APPROVAL_STALE);
        }
      } else if (source === "invite" && input.confirm !== true) {
        return ok({ saved: false, visit: { ...visit, source }, ...leftOut, next: `Read this visit back to the host. Save it only after they agree, by calling again with confirm: true.${leftOutNote}` });
      }
      const existing = file.visits.find((v) => !v.cancelledAt && sameVisit(v, visit) && (v.phone ?? "") === (phone ?? ""));
      if (existing) return ok({ saved: false, duplicate: true, visit: shownVisit(existing), next: "That visit is already saved." });
      const open = file.visits.filter((v) => !v.cancelledAt && v.date >= today).length;
      if (open >= MAX_OPEN_VISITS) return fail(`There are already ${MAX_OPEN_VISITS} expected visits ahead. Cancel some before adding more.`);
      const at = this.deps.now().toISOString();
      const saved: ExpectedVisit = { id: newVisitId(), ...visit, source, savedAt: at, ...(phone ? { phone } : {}) };
      let visitors = file.visitors;
      if (phone) {
        const known = visitors?.find((item) => item.phone === phone);
        const visitor: Visitor = known ? { ...known, name: visit.who } : { phone, name: visit.who, addedAt: at };
        visitors = [...(visitors ?? []).filter((item) => item.phone !== phone), visitor];
      }
      writeOversight(this.root, { ...file, visits: [...file.visits, saved], ...(visitors ? { visitors } : {}) });
      const codeNext = phone
        ? ` ${visit.who} gets their own door code by text 30 minutes before the visit${file.visitors?.find((item) => item.phone === phone)?.yesAt || this.deps.optedInHere?.(phone) ? "" : ", once they reply YES to the one text asking them"}.`
        : "";
      return ok({ saved: true, visit: shownVisit(saved, phone ? this.codeState({ ...file, ...(visitors ? { visitors } : {}) }, saved) : undefined), ...leftOut, next: `Saved. If no one comes in, it's flagged the same day.${codeNext}${phone ? "" : ` ${NOTHING_SENT}`}${leftOutNote}` });
    });
  }

  /** The day's evidence from the property's visit log. Read only; nothing is written. */
  private evidence(): DayEvidence {
    const locks = this.deps.locks?.() === true;
    const cameras = this.deps.cameras?.() === true;
    if (!locks && !cameras) return { entries: [], lock: false };
    const log = visitLogFor(this.root, this.deps.now);
    const events = log.read();
    const doors = this.deps.doors?.();
    const found = dayEvidence(events, { codeNames: log.codeNames(), names: entryNamesFrom(events, locks ? standingNames(this.root) : {}), locks, cameras, ...(doors ? { doors } : {}) });
    // The host's switch lines decide each window; with none in the log, the property's state now stands for every day.
    const lock = found.lock && (found.switched !== undefined || (this.deps.lockedNow?.() ?? true));
    return { entries: found.entries, lock, ...(found.switched ? { switched: found.switched } : {}), quiet: found.quiet, sightings: found.sightings };
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
      // Each checked day's results, read only: listing never records a flag, so it can't swallow one not yet sent.
      const days = [...new Set([...recent.map((v) => v.date), today])].sort();
      const evidence = days.length ? this.evidence() : { entries: [] };
      const now = this.deps.now();
      const results: VisitResult[] = days.flatMap((date) => {
        const day = checkDay({ label: "", visits: file.visits, date, timeZone, now, ...evidence });
        return day.status === "none" ? [] : day.visits;
      });
      const shown = (list: ExpectedVisit[]) => list.map((v) => shownVisit(v, this.codeState(file, v)));
      return ok({ today, open: shown(open), recent: shown(recent), results, next: open.length ? NOTHING_SENT : `No visits are expected ahead. ${NOTHING_SENT}` });
    });
  }

  /** Cancels one visit by id, after the host says so. It's kept for the record and never checked. */
  cancelVisit(input: { id?: unknown }): OversightReply {
    return this.guarded(() => {
      if (typeof input.id !== "string" || !input.id) return fail("Give the visit's id from list_expected_visits.");
      const file = readOversight(this.root);
      const visit = file.visits.find((v) => v.id === input.id);
      if (!visit) return fail("There's no expected visit with that id. List the visits to find it.");
      if (visit.cancelledAt) return ok({ cancelled: true, visit: shownVisit(visit), next: "That visit was already cancelled." });
      // Read before the cancel: only a code that was made comes off the lock (23 Nov Grok run).
      const made = visit.phone ? CODE_MADE.has(this.codeState(file, visit)) : false;
      const cancelled = { ...visit, cancelledAt: this.deps.now().toISOString() };
      writeOversight(this.root, { ...file, visits: file.visits.map((v) => (v.id === visit.id ? cancelled : v)) });
      const code = made ? ` ${visit.who}'s door code for it comes off the lock.` : visit.phone ? ` No door code was made for it, so none comes off the lock. ${NOTHING_SENT}` : ` ${NOTHING_SENT}`;
      return ok({ cancelled: true, visit: shownVisit(cancelled), next: `Cancelled. It won't be checked.${code}` });
    });
  }

  /**
   * One day at the property against its visit log. Records when each visit is first found missed, or first found
   * can't-tell because its lock couldn't report, so a later run of the same day leaves it out of the alert. Sends
   * nothing.
   */
  runDay(date: string, label: string): DayResult {
    const checked = this.checkedDay(date, label);
    if (!("file" in checked)) return checked;
    const { file, result, now } = checked;
    if (result.status === "flags") {
      const fresh = new Set([...result.missed, ...result.unsure].filter((v) => !v.alreadyFlagged).map((v) => v.id));
      if (fresh.size) writeOversight(this.root, { ...file, visits: file.visits.map((v) => (fresh.has(v.id) ? { ...v, flaggedAt: now.toISOString() } : v)) });
    }
    return result;
  }

  /**
   * The same day's result without recording anything (#250): what runDay would return now. The host-alert clock
   * keeps the alert first and calls runDay after, so a restart in between can't lose it.
   */
  peekDay(date: string, label: string): DayResult {
    const checked = this.checkedDay(date, label);
    return "file" in checked ? checked.result : checked;
  }

  private checkedDay(date: string, label: string): DayResult | { file: OversightFile; result: DayResult; now: Date } {
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
    return { file, result: checkDay({ label, visits: file.visits, date, timeZone, now, ...this.evidence() }), now };
  }
}

export function oversightDeskFor(root: string, deps: OversightDeps): OversightDesk {
  return new OversightDesk(root, deps);
}
