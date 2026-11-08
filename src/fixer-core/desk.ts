import { createHash } from "node:crypto";
import { join } from "node:path";
import { localDateOf } from "../core/timezone";
import { copyPhotos, messagePhotoId, photoCount } from "../cleaner-core/photos";
import { askNext } from "../hub/ask";
import { addCalendarDays } from "../hub/calendar";
import { joinSplitDigits } from "../hub/digits";
import type { GoogleEventList } from "../hub/sources";
import { refuseCards } from "../hub/cards";
import { hubFor, type Hub } from "../hub/hub";
import type { People } from "../hub/people";
import { ConfirmationBook } from "../operator/confirmations";
import { nextDates, scheduleProblem, type Schedule } from "../supply-core/schedule";
import { supplyAskOn } from "../supply-core/store";
import { bookingFingerprint, bookingHolds, contactAllowed, defaultAccess, liveBooking } from "./gate";
import { activateProblems, fixerSetupAsk, proGaps } from "./setupAsk";
import { bookingQuestion, cancelQuestion, cleaningOrderQuestion, hostGoQuestion, pickQuestion, raisedPrice, rotationQuestion } from "./texts";
import { latestYmd, overlapsStay, visitWindows, type VisitWindow } from "./window";
import { TRADES, isTrade, letterToken, newId, readFixer, tokenHash, writeFixer, type Booking, type Candidate, type Contact, type FixerFile, type Job, type Pro, type ProReach, type Trade, type Upkeep } from "./store";

/**
 * Fixer Core's desk: every tool's behaviour over one property's `fixer.json`. One call at a time.
 * It never sees a card detail and never pays anyone; the agent (Grok or Muse) finds and calls the pros.
 */

export interface FixerReply {
  text: string;
  structured?: Record<string, unknown>;
  isError: boolean;
}

export interface FixerDeps {
  now(): Date;
  propertyId?: string;
  /** The account's people list, where saved pros are kept as role "pro". */
  people?(): People | undefined;
  /** True while Cleaner Core runs on the property. */
  cleaningOn?(): boolean;
  /** Cleaner Core's cleaning for a checkout date. */
  cleanings?(checkoutYmd: string): Promise<{ doneAt?: string; cleared: boolean } | undefined>;
  env?(): NodeJS.ProcessEnv;
  publicBase?(): string | undefined;
  send?(to: string, body: string): Promise<boolean>;
  textsAllowed?(): Promise<boolean>;
  business?(): Promise<string | undefined>;
  notifyHost?(id: string, text: string): Promise<void>;
  photoKey?(): Buffer | undefined;
}

export const MAX_PROS = 60;
export const MAX_UPKEEP = 30;
export const MAX_CANDIDATES = 8;
const UNCONFIRMED_MS = 2 * 60 * 60_000;
const FOLLOW_UP_MS = 24 * 60 * 60_000;
const HOWS: readonly Contact["how"][] = ["call", "email", "form", "booking-page", "text", "network"];
const OUTCOMES: readonly NonNullable<Contact["outcome"]>[] = ["booked", "quoted", "no-answer", "declined", "waiting"];
export const CARD_REFUSAL = "That looks like a card number. Fixer Core never takes card details: keep them in your Vault.";
const APPROVAL_STALE = "That approval has expired or doesn't match this change. Ask the host again.";
const DAMAGED = "Fixer Core's record (fixer.json) couldn't be read, so nothing was changed. Ask for help restoring it.";
const E164 = /^\+[1-9]\d{9,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HTTPS = /^https:\/\/[^\s/]+\.[^\s]+$/;

export interface ReachInput {
  phone?: string;
  email?: string;
  website?: string;
  bookingUrl?: string;
}

export interface SettingsInput {
  /** A number from 100 to 500_000, or null for no line. */
  costLineCents?: number | null;
  checkInBufferMinutes?: number;
  cleaningMinutes?: number;
  askCleaner?: boolean;
  /** Setup: the host's pro list is final. */
  prosDone?: true;
  /** Setup: the host has no more upkeep to add. */
  upkeepDone?: true;
  confirmation?: string;
}

export interface ProInput {
  id?: string;
  name?: string;
  trades?: Trade[];
  preferredFor?: { trade: Trade; rank: number }[];
  reach?: ReachInput;
  prefersText?: boolean;
  draft?: true;
  /** Draft ids the host confirmed. */
  confirm?: string[];
  /** A done job the pro came from. */
  jobId?: string;
  /** The host's yes that a number already on another property helps here too. */
  shared?: true;
  confirmation?: string;
}

export interface UpkeepInput {
  id?: string;
  trade?: Trade;
  what?: string;
  schedule?: Schedule;
  leadDays?: number;
  proId?: string;
  confirmation?: string;
}

export interface JobInput {
  trade?: Trade;
  what?: string;
  urgency?: Job["urgency"];
  byDate?: string;
  source?: Job["source"];
  sourceRef?: string;
  /** The cleaner's texts whose photos belong to the job. */
  photoMessageIds?: string[];
  cleanerName?: string;
  doorLock?: true;
}

export interface CandidateInput {
  name?: string;
  trade?: Trade;
  source?: string;
  rating?: number;
  reviewCount?: number;
  licensed?: "yes" | "no" | "unknown";
  backgroundChecked?: "yes" | "no" | "unknown";
  costRange?: { lowCents: number; highCents: number };
  priceText?: string;
  earliestAt?: string;
  reach?: ReachInput & { networkRef?: string };
}

export interface ApproveJobInput {
  jobId?: string;
  no?: true;
  confirmation?: string;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const URGENCIES = ["now", "soon", "by-date", "flexible"] as const;
/** A job is still going until it is done or cancelled; these states are before any contact. */
const NOT_BOOKED = new Set<Job["state"]>(["requested", "shortlisted", "contacted"]);

/** The record couldn't be read: the desk answers with a plain refusal and leaves the file alone. */
class DamagedRecord extends Error {}

const ok = (structured: Record<string, unknown>): FixerReply => ({ text: JSON.stringify(structured), structured, isError: false });
const fail = (text: string): FixerReply => ({ text, isError: true });

const isInt = (n: unknown, min: number, max: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
const isText = (s: unknown, max: number): s is string => typeof s === "string" && s.trim().length > 0 && s.length <= max;

/** An instant's local `YYYY-MM-DD` in a time zone. */
function localYmd(at: Date, timeZone: string): string {
  const { year, month, day } = localDateOf(at, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Jobs still going: not done and not cancelled. */
const isOpen = (job: Job): boolean => job.state !== "done" && job.state !== "cancelled";

/** Digit runs of 4 or more (after split digits are joined) become a note, so a door code or account number never lands in a job. */
export function redactDigits(text: string): string {
  return joinSplitDigits(text).replace(/\d{4,}/g, "[number removed]");
}

/** The cleaned-up reach, or the plain reason it is refused. */
function reachOf(raw: ReachInput | undefined): ProReach | string {
  const reach: ProReach = {};
  if (raw === undefined) return reach;
  if (!raw || typeof raw !== "object") return "Reach is the pro's phone, email, website or booking link.";
  if (raw.phone !== undefined) {
    if (typeof raw.phone !== "string" || !E164.test(raw.phone)) return "A phone number has to be in international form, like +15555550142.";
    reach.phone = raw.phone;
  }
  if (raw.email !== undefined) {
    if (typeof raw.email !== "string" || raw.email.length > 120 || !EMAIL.test(raw.email)) return "That email address doesn't look right.";
    reach.email = raw.email;
  }
  for (const key of ["website", "bookingUrl"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > 300 || !HTTPS.test(value)) return `The ${key === "website" ? "website" : "booking link"} has to be an https link.`;
    reach[key] = value;
  }
  return reach;
}

/** Renumbers each of this pro's trades 1, 2, 3 … ; on a tie the pro just saved goes first. */
function renumber(file: FixerFile, trades: readonly Trade[], first?: Pro): void {
  for (const trade of trades) {
    const ranked = file.pros
      .filter((pro) => pro.preferredFor.some((entry) => entry.trade === trade))
      .sort((a, b) => {
        const rank = (pro: Pro) => pro.preferredFor.find((entry) => entry.trade === trade)!.rank;
        return rank(a) - rank(b) || Number(b === first) - Number(a === first) || a.addedAt.localeCompare(b.addedAt);
      });
    ranked.forEach((pro, index) => {
      pro.preferredFor.find((entry) => entry.trade === trade)!.rank = index + 1;
    });
  }
}

export class FixerDesk {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly approvals: ConfirmationBook;

  constructor(
    readonly root: string,
    readonly deps: FixerDeps,
  ) {
    // Kept in the property's folder, so a host's yes still counts after a restart.
    this.approvals = new ConfirmationBook(10 * 60_000, () => deps.now().getTime(), { file: join(root, "fixer-approvals.json") });
    // The hub moves any old property and calendar fields out of the older files before this desk reads anything.
    this.hub();
  }

  /** Runs calls one at a time, so two tools never write the record at once. */
  protected serial<T>(work: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Every call starts here: card-like input is refused before anything is read or saved, and a damaged record is told plainly. */
  protected guarded(args: unknown, work: () => Promise<FixerReply> | FixerReply): Promise<FixerReply> {
    if (refuseCards(args)) return Promise.resolve(fail(CARD_REFUSAL));
    return this.serial(async () => {
      try {
        return await work();
      } catch (error) {
        if (error instanceof DamagedRecord) return fail(DAMAGED);
        throw error;
      }
    });
  }

  /** The record. A file that won't parse is never reset: the call is refused and the file stays as it is. */
  protected read(): FixerFile {
    try {
      return readFixer(this.root);
    } catch {
      throw new DamagedRecord();
    }
  }

  protected write(file: FixerFile): void {
    writeFixer(this.root, file);
  }

  protected hub(): Hub {
    return hubFor(this.root, { now: () => this.deps.now() });
  }

  protected timeZone(): string {
    return this.hub().property().timeZone ?? "UTC";
  }

  protected today(): string {
    return localYmd(this.deps.now(), this.timeZone());
  }

  /**
   * After Activate a change waits for the host's yes: the first call returns the question and a code
   * bound to that exact change, and only the second call, with the code, saves it.
   */
  protected approved(file: FixerFile, action: string, target: string, input: { confirmation?: string }, question: string): FixerReply | "go" {
    if (!file.settings.activatedAt) return "go";
    const { confirmation, ...rest } = input;
    const fingerprint = createHash("sha256").update(JSON.stringify(rest)).digest("hex");
    return this.confirm(action, target, fingerprint, confirmation, question);
  }

  /** The host's yes, bound to one change: without a code, the question and a new code; with one, "go" once it redeems. */
  protected confirm(action: string, target: string, fingerprint: string, code: string | undefined, question: string): FixerReply | "go" {
    if (!code) return ok({ question, confirmation: this.approvals.issue(action, target, fingerprint, question) });
    try {
      this.approvals.redeem(code, action, target, fingerprint);
    } catch {
      return fail(APPROVAL_STALE);
    }
    return "go";
  }

  private askFor(file: FixerFile) {
    return fixerSetupAsk(file, this.hub(), this.deps.cleaningOn?.() ?? false, supplyAskOn(this.root));
  }

  /** One line for the host: on, the pro count and the open jobs. */
  protected line(file: FixerFile): string {
    const pros = file.pros.filter((pro) => pro.status === "saved").length;
    const open = file.jobs.filter(isOpen).length;
    return `Repairs: on, ${pros} ${pros === 1 ? "pro" : "pros"}, ${open} ${open === 1 ? "job" : "jobs"} open.`;
  }

  /** The cost log: what finished jobs cost this month and this year, by trade. */
  private costLog(file: FixerFile): Record<string, unknown> {
    const tz = this.timeZone();
    const today = this.today();
    const total = (prefix: string) => {
      const byTrade: Record<string, number> = {};
      let cents = 0;
      for (const job of file.jobs) {
        if (!job.cost || !localYmd(new Date(job.cost.at), tz).startsWith(prefix)) continue;
        byTrade[job.trade] = (byTrade[job.trade] ?? 0) + job.cost.cents;
        cents += job.cost.cents;
      }
      return { totalCents: cents, byTrade };
    };
    return { month: total(today.slice(0, 7)), year: total(today.slice(0, 4)) };
  }

  state(): Promise<FixerReply> {
    return this.guarded({}, () => {
      const file = this.read();
      const ask = this.askFor(file);
      const saved = file.pros.filter((pro) => pro.status === "saved");
      if (ask) {
        return ok({ ask, next: askNext(ask.tool), pros: saved.map((pro) => pro.name), upkeep: file.upkeep.map((item) => item.what) });
      }
      const rankIn = (pro: Pro, trade: Trade) => pro.preferredFor.find((entry) => entry.trade === trade)?.rank ?? 999;
      const pros: Record<string, unknown[]> = {};
      for (const trade of TRADES) {
        const here = saved.filter((pro) => pro.trades.includes(trade)).sort((a, b) => rankIn(a, trade) - rankIn(b, trade));
        if (here.length > 0) pros[trade] = here.map((pro) => ({ proId: pro.id, name: pro.name, ...(pro.preferredFor.some((entry) => entry.trade === trade) ? { rank: rankIn(pro, trade) } : {}) }));
      }
      const drafts = file.pros.filter((pro) => pro.status === "draft").map((pro) => ({ proId: pro.id, name: pro.name, needsYou: proGaps(pro) }));
      return ok({
        line: file.offAt ? "Repairs: off." : this.line(file),
        summary: {
          pros,
          ...(drafts.length > 0 ? { drafts } : {}),
          upkeep: file.upkeep.map((item) => ({ upkeepId: item.id, trade: item.trade, what: item.what, schedule: item.schedule, leadDays: item.leadDays, ...(item.proId ? { proId: item.proId } : {}) })),
          openJobs: file.jobs.filter(isOpen).map((job) => ({ jobId: job.id, trade: job.trade, what: job.what, state: job.state })),
          costLog: this.costLog(file),
          ...(file.settings.costLineCents !== undefined ? { costLineCents: file.settings.costLineCents } : {}),
          checkInBufferMinutes: file.settings.checkInBufferMinutes,
          cleaningMinutes: file.settings.cleaningMinutes,
          askCleaner: file.settings.askCleaner,
        },
      });
    });
  }

  saveSettings(input: SettingsInput): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const s = file.settings;
      if (input.costLineCents !== undefined && input.costLineCents !== null && !isInt(input.costLineCents, 100, 500_000)) return fail("A cost line has to be from $1 to $5,000.");
      if (input.checkInBufferMinutes !== undefined && !isInt(input.checkInBufferMinutes, 0, 240)) return fail("The check-in buffer has to be from 0 to 240 minutes.");
      if (input.cleaningMinutes !== undefined && !isInt(input.cleaningMinutes, 30, 480)) return fail("The cleaning length has to be from 30 to 480 minutes.");
      if (input.askCleaner !== undefined && typeof input.askCleaner !== "boolean") return fail("Asking the cleaner is yes or no.");
      if (input.prosDone && file.pros.some((pro) => pro.status === "draft")) return fail("Confirm or remove the drafted pros first.");
      const gate = this.approved(file, "fixer-settings", "settings", input, "Save these settings?");
      if (gate !== "go") return gate;
      if (input.costLineCents === null) delete s.costLineCents;
      else if (input.costLineCents !== undefined) s.costLineCents = input.costLineCents;
      if (input.costLineCents !== undefined) file.setup.costAsked = true;
      if (input.checkInBufferMinutes !== undefined) s.checkInBufferMinutes = input.checkInBufferMinutes;
      if (input.cleaningMinutes !== undefined) s.cleaningMinutes = input.cleaningMinutes;
      if (input.askCleaner !== undefined) {
        s.askCleaner = input.askCleaner;
        file.setup.cleanerAsked = true;
      }
      if (input.prosDone) file.setup.prosDone = true;
      if (input.upkeepDone) file.setup.upkeepDone = true;
      this.write(file);
      return ok({ saved: true, ...(this.askFor(file) ? { next: "Call get_fixer_state for the next step." } : {}) });
    });
  }

  /** The saved pros that have a phone, kept in the account's people list as role "pro" for this property. */
  private syncPros(file: FixerFile): void {
    const people = this.deps.people?.();
    if (!people || !this.deps.propertyId) return;
    const wanted = file.pros.filter((pro) => pro.status === "saved" && pro.reach.phone).map((pro) => ({ phone: pro.reach.phone!, name: pro.name }));
    people.saveRolePeople(this.deps.propertyId, "pro", wanted);
  }

  /** Task 10 sends the pro their invite once. Until then this does nothing. */
  private inviteIfAsked(_pro: Pro): void {}

  /** Refuses a number that is the host's, or already on another of the account's properties without the host's yes. */
  private phoneProblem(pro: Pro, shared: boolean | undefined): string | undefined {
    const phone = pro.reach.phone;
    const people = this.deps.people?.();
    const here = this.deps.propertyId;
    if (!phone || !people || !here) return undefined;
    if (people.hostOf(here) === phone) return "That number is the host's own. A pro needs a different phone.";
    const elsewhere = people.person(phone)?.where.some((w) => w.propertyId !== here);
    if (elsewhere && !shared) return "That number is already on another of your properties. Ask the host whether the same person helps here too, then save again with shared: true.";
    return undefined;
  }

  savePro(input: ProInput): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      if (input.confirm !== undefined) return this.confirmPros(file, input);
      const existing = input.id ? file.pros.find((pro) => pro.id === input.id) : undefined;
      if (input.id && !existing) return fail("There's no pro with that id. Call get_fixer_state for the list.");
      if (!existing && file.pros.length >= MAX_PROS) return fail(`The list holds up to ${MAX_PROS} pros.`);
      if (!isText(input.name, 80)) return fail("The pro needs a name under 80 characters.");
      const trades = Array.isArray(input.trades) ? [...new Set(input.trades)] : [];
      if (trades.length === 0 || !trades.every(isTrade)) return fail(`Pick one or more trades: ${TRADES.join(", ")}.`);
      const preferredFor = input.preferredFor ?? [];
      if (!Array.isArray(preferredFor) || preferredFor.some((entry) => !entry || !trades.includes(entry.trade) || !isInt(entry.rank, 1, MAX_PROS))) return fail("A preferred rank has to be a whole number for one of the pro's trades.");
      if (new Set(preferredFor.map((entry) => entry.trade)).size !== preferredFor.length) return fail("Give each trade one rank.");
      const reach = reachOf(input.reach);
      if (typeof reach === "string") return fail(reach);
      if (input.prefersText !== undefined && typeof input.prefersText !== "boolean") return fail("Prefers text is yes or no.");
      if (input.draft && existing?.status === "saved") return fail("A saved pro can't go back to a draft. Change them directly or remove them.");
      if (!input.draft && Object.keys(reach).length === 0) return fail("Save a way to reach them: a phone, email, website or booking link.");
      if (reach.phone && file.pros.some((pro) => pro.id !== existing?.id && pro.reach.phone === reach.phone)) return fail("That phone number is already on another of your pros.");
      let job: Job | undefined;
      if (input.jobId !== undefined) {
        job = file.jobs.find((entry) => entry.id === input.jobId);
        if (!job || job.state !== "done") return fail("Only a finished job can add its pro to your list.");
      }
      const now = this.deps.now().toISOString();
      const pro: Pro = {
        ...(existing ?? {}),
        id: existing?.id ?? newId("pro_", 10),
        name: input.name.trim(),
        trades,
        preferredFor: preferredFor.map((entry) => ({ trade: entry.trade, rank: entry.rank })),
        reach,
        status: input.draft ? "draft" : "saved",
        source: existing?.source ?? (input.draft ? "drafted" : job ? "job" : "host"),
        addedAt: existing?.addedAt ?? now,
      };
      if (input.prefersText) pro.prefersText = true;
      else delete pro.prefersText;
      if (pro.status === "saved") {
        const problem = this.phoneProblem(pro, input.shared);
        if (problem) return fail(problem);
        const gate = this.approved(file, "fixer-pro", existing?.id ?? "new", input, existing ? `Save the changes to ${pro.name}?` : `Add ${pro.name} to your pros for ${trades.join(", ")}?`);
        if (gate !== "go") return gate;
      }
      if (existing) file.pros[file.pros.indexOf(existing)] = pro;
      else file.pros.push(pro);
      renumber(file, trades, pro);
      if (existing) renumber(file, existing.trades.filter((trade) => !trades.includes(trade)));
      this.write(file);
      if (pro.status === "saved") {
        this.syncPros(file);
        if (existing?.status !== "saved") this.inviteIfAsked(pro);
      }
      return ok({ saved: true, proId: pro.id, status: pro.status, ...(file.settings.activatedAt ? {} : { next: "Ask whether there's anyone else they call." }) });
    });
  }

  /** The host's yes to drafted pros: each one becomes saved. */
  private confirmPros(file: FixerFile, input: ProInput): FixerReply {
    const ids = input.confirm;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string")) return fail("Pass the ids of the drafted pros the host confirmed.");
    if (input.name !== undefined || input.trades !== undefined || input.reach !== undefined) return fail("Confirm drafts in one call, and change a pro in another.");
    const drafts = [...new Set(ids)].map((id) => file.pros.find((pro) => pro.id === id && pro.status === "draft"));
    if (drafts.some((pro) => !pro)) return fail("Only drafted pros can be confirmed. Call get_fixer_state for the list.");
    for (const pro of drafts as Pro[]) {
      const gaps = proGaps(pro);
      if (gaps.length > 0) return fail(`${pro.name} still needs ${gaps.join(" and ")} before the host can confirm.`);
      const problem = this.phoneProblem(pro, input.shared);
      if (problem) return fail(`${pro.name}: ${problem}`);
    }
    const names = (drafts as Pro[]).map((pro) => pro.name).join(", ");
    // The code is bound to what each draft says now, so an edit after the host's yes needs a new question.
    const contents = (drafts as Pro[]).map(({ id, name, trades, preferredFor, reach, prefersText }) => ({ id, name, trades, preferredFor, reach, prefersText: prefersText ?? false }));
    const gate = this.approved(file, "fixer-pro", "confirm", { ...input, drafts: contents } as ProInput, `Save ${names} to your pros?`);
    if (gate !== "go") return gate;
    for (const pro of drafts as Pro[]) pro.status = "saved";
    this.write(file);
    this.syncPros(file);
    for (const pro of drafts as Pro[]) this.inviteIfAsked(pro);
    return ok({ saved: true, confirmed: (drafts as Pro[]).map((pro) => pro.id) });
  }

  removePro(input: { id?: string; confirmation?: string }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const pro = file.pros.find((entry) => entry.id === input.id);
      if (!pro) return fail("There's no pro with that id. Call get_fixer_state for the list.");
      const gate = this.approved(file, "fixer-pro-remove", pro.id, input, `Remove ${pro.name} from your pros?`);
      if (gate !== "go") return gate;
      file.pros = file.pros.filter((entry) => entry !== pro);
      for (const item of file.upkeep) if (item.proId === pro.id) delete item.proId;
      renumber(file, pro.trades);
      this.write(file);
      this.syncPros(file);
      return ok({ removed: pro.name });
    });
  }

  /** Why a schedule can't be used for upkeep, or undefined. Only every and custom: repairs don't run on stays. */
  private upkeepScheduleProblem(schedule: Schedule | undefined): string | undefined {
    if (!schedule || typeof schedule !== "object") return "Pass the schedule.";
    if (schedule.kind !== "every" && schedule.kind !== "custom") return "Upkeep runs every so many days, on a day of the month, or on another rule. It can't go by bookings.";
    return scheduleProblem(schedule, this.today());
  }

  saveUpkeep(input: UpkeepInput): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const existing = input.id ? file.upkeep.find((item) => item.id === input.id) : undefined;
      if (input.id && !existing) return fail("There's no upkeep item with that id. Call get_fixer_state for the list.");
      if (!existing && file.upkeep.length >= MAX_UPKEEP) return fail(`The list holds up to ${MAX_UPKEEP} upkeep items.`);
      if (!isTrade(input.trade)) return fail(`Pick a trade: ${TRADES.join(", ")}.`);
      if (!isText(input.what, 119)) return fail("Say what it is, in under 120 characters.");
      const leadDays = input.leadDays ?? 14;
      if (!isInt(leadDays, 0, 60)) return fail("The lead time has to be from 0 to 60 days.");
      const problem = this.upkeepScheduleProblem(input.schedule);
      if (problem) return fail(problem);
      if (input.proId !== undefined && !file.pros.some((pro) => pro.id === input.proId && pro.status === "saved")) return fail("That pro isn't on your saved list.");
      const gate = this.approved(file, "fixer-upkeep", existing?.id ?? "new", input, `Save upkeep: ${input.what.trim()}?`);
      if (gate !== "go") return gate;
      const item: Upkeep = {
        ...(existing ?? {}),
        id: existing?.id ?? newId("upk_", 8),
        trade: input.trade,
        what: input.what.trim(),
        schedule: input.schedule!,
        leadDays,
        savedAt: existing?.savedAt ?? this.deps.now().toISOString(),
      };
      if (input.proId) item.proId = input.proId;
      else delete item.proId;
      if (existing) file.upkeep[file.upkeep.indexOf(existing)] = item;
      else file.upkeep.push(item);
      this.write(file);
      const today = this.today();
      return ok({ saved: true, upkeepId: item.id, nextDates: nextDates(item.schedule, today, today, 3) });
    });
  }

  removeUpkeep(input: { id?: string; confirmation?: string }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const item = file.upkeep.find((entry) => entry.id === input.id);
      if (!item) return fail("There's no upkeep item with that id. Call get_fixer_state for the list.");
      const gate = this.approved(file, "fixer-upkeep-remove", item.id, input, `Remove ${item.what} from your upkeep?`);
      if (gate !== "go") return gate;
      file.upkeep = file.upkeep.filter((entry) => entry !== item);
      this.write(file);
      return ok({ removed: item.what });
    });
  }

  previewSchedule(input: { schedule?: Schedule }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const problem = this.upkeepScheduleProblem(input.schedule);
      if (problem) return fail(problem);
      // The preview doesn't use the record; it's read so a damaged fixer.json fails this call too.
      this.read();
      const today = this.today();
      return ok({ nextDates: nextDates(input.schedule!, today, today, 3) });
    });
  }

  activate(): Promise<FixerReply> {
    return this.guarded({}, () => {
      const file = this.read();
      if (file.settings.activatedAt) return ok({ active: true, line: this.line(file) });
      const problems = activateProblems(this.hub());
      if (problems.length > 0) return fail(problems.join(" "));
      file.settings.activatedAt = this.deps.now().toISOString();
      delete file.offAt;
      this.write(file);
      return ok({ active: true, line: this.line(file) });
    });
  }

  /** The host's one-line summary, or the setup line while setup is open. */
  summaryLine(): string {
    let file: FixerFile;
    try {
      file = this.read();
    } catch (error) {
      if (error instanceof DamagedRecord) return "Repairs: record unreadable.";
      throw error;
    }
    if (file.offAt) return "Repairs: off.";
    return file.settings.activatedAt ? this.line(file) : "Repairs: setup not finished.";
  }

  /** The saved pro the host ranks first for a trade, if any. */
  private topPro(file: FixerFile, trade: Trade, skip: readonly string[] = []): { pro: Pro; rank: number } | undefined {
    const ranked = file.pros
      .filter((pro) => pro.status === "saved" && !skip.includes(pro.id))
      .flatMap((pro) => pro.preferredFor.filter((entry) => entry.trade === trade).map((entry) => ({ pro, rank: entry.rank })))
      .sort((a, b) => a.rank - b.rank);
    return ranked[0];
  }

  /** The host's go question for a job still waiting on it. */
  private goQuestion(file: FixerFile, job: Job): string {
    const top = this.topPro(file, job.trade);
    return hostGoQuestion({ what: job.what, ...(job.source === "cleaner" && job.photos.length > 0 ? { cleanerName: job.cleanerName ?? "your cleaner" } : {}), ...(top ? { proName: top.pro.name } : {}) });
  }

  /** Starts a repair job: the host's own starts at once, the cleaner's and upkeep's wait for the host's go. */
  openJob(input: JobInput): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      if (!file.settings.activatedAt || file.offAt) return fail("Repairs aren't active yet. Call get_fixer_state.");
      if (!isTrade(input.trade)) return fail(`Pick a trade: ${TRADES.join(", ")}.`);
      if (!isText(input.what, 299)) return fail("Say what needs fixing, in under 300 characters.");
      if (!URGENCIES.includes(input.urgency as never)) return fail("Say how soon: now, soon, by-date or flexible.");
      if (input.source !== "host" && input.source !== "cleaner" && input.source !== "upkeep") return fail("Say where it came from: host, cleaner or upkeep.");
      if ((input.urgency === "by-date") !== (input.byDate !== undefined)) return fail("A by-date job needs a date, and only a by-date job has one.");
      if (input.byDate !== undefined && (typeof input.byDate !== "string" || !YMD.test(input.byDate) || input.byDate < this.today())) return fail("The date has to be YYYY-MM-DD, today or later.");
      if (input.sourceRef !== undefined && !isText(input.sourceRef, 80)) return fail("That source reference is too long.");
      if (input.cleanerName !== undefined && !isText(input.cleanerName, 80)) return fail("The cleaner's name is too long.");
      if (input.doorLock !== undefined && input.doorLock !== true) return fail("doorLock is only ever true.");
      const photoIds = input.photoMessageIds ?? [];
      if (!Array.isArray(photoIds) || photoIds.length > 10 || !photoIds.every((id) => isText(id, 120))) return fail("Pass up to 10 message ids for the photos.");
      if (photoIds.length > 0 && input.source !== "cleaner") return fail("Only a cleaner's report carries photos.");
      if (input.source === "upkeep") {
        if (!input.sourceRef || !file.upkeep.some((item) => item.id === input.sourceRef)) return fail("An upkeep job names an upkeep item. Call get_fixer_state for the list.");
        if (file.jobs.some((job) => isOpen(job) && job.sourceRef === input.sourceRef)) return fail("That upkeep item already has a job open.");
      }
      const what = redactDigits(input.what).trim();
      // Redaction can make the text longer, so the bound applies to what is saved.
      if (what.length > 299) return fail("Say what needs fixing, in under 300 characters.");
      const now = this.deps.now().toISOString();
      const job: Job = {
        id: newId("job_", 10),
        trade: input.trade,
        what,
        source: input.source,
        photos: [],
        urgency: input.urgency!,
        state: "requested",
        candidates: [],
        picked: [],
        contacts: [],
        news: [],
        createdAt: now,
      };
      if (input.byDate) job.byDate = input.byDate;
      if (input.sourceRef) job.sourceRef = input.sourceRef;
      if (input.cleanerName) job.cleanerName = input.cleanerName.trim();
      if (input.doorLock) job.doorLock = true;
      if (input.source === "host") job.hostGo = { at: now };
      const key = `fixer:${job.id}`;
      for (const id of photoIds) {
        const before = photoCount(this.root, key);
        const copied = copyPhotos(this.root, messagePhotoId(id), key);
        for (let n = before + 1; n <= before + copied; n++) job.photos.push({ id: String(n), from: "cleaner", at: now });
      }
      file.jobs.push(job);
      this.write(file);
      return ok({ jobId: job.id, state: job.state, ...(job.hostGo ? { next: "Call check_fixes for who to contact." } : { question: this.goQuestion(file, job), next: "Ask the host this question, then call approve_job." }) });
    });
  }

  /** The host's go (two calls, the second with the code) or no (cancels) for a job waiting on them. */
  approveJob(input: ApproveJobInput): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const job = file.jobs.find((entry) => entry.id === input.jobId);
      if (!job) return fail("There's no job with that id. Call get_fixer_state for the list.");
      if (!isOpen(job) || job.hostGo || !NOT_BOOKED.has(job.state)) return fail("That job isn't waiting for a go.");
      if (input.no !== undefined && input.no !== true) return fail("no is only ever true.");
      if (input.no) {
        job.state = "cancelled";
        job.cancelledAt = this.deps.now().toISOString();
        job.cancelReason = "host-said-no";
        this.write(file);
        return ok({ cancelled: true, jobId: job.id });
      }
      const gate = this.approved(file, "fixer-job-go", job.id, input, this.goQuestion(file, job));
      if (gate !== "go") return gate;
      job.hostGo = { at: this.deps.now().toISOString() };
      this.write(file);
      return ok({ approved: true, jobId: job.id, next: "Call check_fixes for who to contact." });
    });
  }

  /** The times a pro can visit for this job, between the stays, with the cleaning applied. */
  async windowsFor(job: Job): Promise<VisitWindow[]> {
    const file = this.read();
    const hub = this.hub();
    const property = hub.property();
    const timeZone = this.timeZone();
    const today = this.today();
    const stays = hub.stays() ?? [];
    const cleanings = new Map<string, { doneAt?: string }>();
    if (this.deps.cleanings) {
      for (const day of new Set(stays.map((stay) => stay.checkout))) {
        const entry = await this.deps.cleanings(day);
        if (entry) cleanings.set(day, entry.doneAt ? { doneAt: entry.doneAt } : {});
      }
    }
    return visitWindows({
      stays,
      timeZone,
      ...(property.checkoutTime ? { checkoutTime: property.checkoutTime } : {}),
      ...(property.checkInTime ? { checkInTime: property.checkInTime } : {}),
      checkInBufferMinutes: file.settings.checkInBufferMinutes,
      cleaningMinutes: file.settings.cleaningMinutes,
      cleanings,
      ...(job.cleaningOrder ? { cleaningOrder: job.cleaningOrder } : {}),
      now: this.deps.now(),
      lastYmd: latestYmd(job, today),
    });
  }

  /** Why repairs can't take new work, or undefined. */
  private inactive(file: FixerFile): FixerReply | undefined {
    return !file.settings.activatedAt || file.offAt ? fail("Repairs aren't active yet. Call get_fixer_state.") : undefined;
  }

  private jobOf(file: FixerFile, id: unknown): Job | undefined {
    return typeof id === "string" ? file.jobs.find((entry) => entry.id === id) : undefined;
  }

  /** A saved pro's or a candidate's name on this job. */
  private nameOf(file: FixerFile, job: Job, id: string): string | undefined {
    return file.pros.find((pro) => pro.id === id)?.name ?? job.candidates.find((c) => c.id === id)?.name;
  }

  private reachOfId(file: FixerFile, job: Job, id: string): ProReach {
    return file.pros.find((pro) => pro.id === id)?.reach ?? job.candidates.find((c) => c.id === id)?.reach ?? {};
  }

  /** The next pick not yet tried, else the best ranked pro not yet tried. */
  private nextPro(file: FixerFile, job: Job): { proId: string; name: string; rank?: number } | undefined {
    const tried = job.contacts.filter((c) => !c.cancelled).map((c) => c.to);
    for (const id of job.picked) {
      const name = this.nameOf(file, job, id);
      if (name && !tried.includes(id) && contactAllowed(job, id, file.pros).ok) return { proId: id, name };
    }
    const top = this.topPro(file, job.trade, tried);
    return top && contactAllowed(job, top.pro.id, file.pros).ok ? { proId: top.pro.id, name: top.pro.name, rank: top.rank } : undefined;
  }

  /** The candidate as saved, or the plain reason it is refused. */
  private candidateOf(raw: CandidateInput, job: Job): Candidate | string {
    if (!raw || typeof raw !== "object") return "Each candidate needs a name, a trade and a way to reach them.";
    if (!isText(raw.name, 80)) return "Each candidate needs a name.";
    if (raw.trade !== undefined && !isTrade(raw.trade)) return `Pick a trade: ${TRADES.join(", ")}.`;
    if (raw.source !== undefined && !isText(raw.source, 60)) return "A source is a short name, like search or a network.";
    if (raw.priceText !== undefined && !isText(raw.priceText, 59)) return "The price text has to be under 60 characters.";
    if (raw.rating !== undefined && !(typeof raw.rating === "number" && raw.rating >= 0 && raw.rating <= 5)) return "A rating is from 0 to 5.";
    if (raw.reviewCount !== undefined && !isInt(raw.reviewCount, 0, 1_000_000)) return "The review count has to be a whole number.";
    if (raw.licensed !== undefined && !["yes", "no", "unknown"].includes(raw.licensed)) return "Licensed is yes, no or unknown.";
    if (raw.backgroundChecked !== undefined && !["yes", "no", "unknown"].includes(raw.backgroundChecked)) return "Background checked is yes, no or unknown.";
    if (raw.earliestAt !== undefined && (typeof raw.earliestAt !== "string" || Number.isNaN(Date.parse(raw.earliestAt)))) return "The earliest time has to be a date and time.";
    const range = raw.costRange;
    if (range !== undefined && !(range && isInt(range.lowCents, 0, 2_000_000) && isInt(range.highCents, 0, 2_000_000) && range.lowCents <= range.highCents)) return "A cost range is low and high cents, 0 to 2,000,000.";
    const reach = reachOf(raw.reach);
    if (typeof reach === "string") return reach;
    const networkRef = raw.reach?.networkRef;
    if (networkRef !== undefined && !isText(networkRef, 120)) return "The network reference is too long.";
    if (Object.keys(reach).length === 0 && networkRef === undefined) return "Each candidate needs a phone, email, link or network reference.";
    return {
      id: newId("cand_", 8),
      name: raw.name.trim(),
      trade: raw.trade ?? job.trade,
      source: raw.source?.trim() ?? "search",
      ...(raw.rating !== undefined ? { rating: raw.rating } : {}),
      ...(raw.reviewCount !== undefined ? { reviewCount: raw.reviewCount } : {}),
      licensed: raw.licensed ?? "unknown",
      ...(raw.backgroundChecked ? { backgroundChecked: raw.backgroundChecked } : {}),
      ...(range ? { costRange: { lowCents: range.lowCents, highCents: range.highCents } } : {}),
      ...(raw.priceText ? { priceText: raw.priceText.trim() } : {}),
      ...(raw.earliestAt ? { earliestAt: new Date(raw.earliestAt).toISOString() } : {}),
      reach: { ...reach, ...(networkRef ? { networkRef } : {}) },
    };
  }

  /** The pros the agent found, kept on the job (up to 8) for the host to pick from. */
  addCandidates(input: { jobId?: string; candidates?: CandidateInput[]; options?: true }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const off = this.inactive(file);
      if (off) return off;
      const job = this.jobOf(file, input.jobId);
      if (!job) return fail("There's no job with that id. Call get_fixer_state for the list.");
      if (!isOpen(job) || liveBooking(job) || job.state === "booked") return fail("That job is already booked or closed.");
      if (!job.hostGo) return fail("The host hasn't said go for this job yet.");
      if (input.options !== undefined && input.options !== true) return fail("options is only ever true.");
      if (job.state === "contacted" && !input.options) return fail("Someone is already being contacted. Only add options when the host asks for them.");
      if (!Array.isArray(input.candidates) || input.candidates.length === 0) return fail("Pass the pros you found.");
      const added: Candidate[] = [];
      for (const raw of input.candidates) {
        const made = this.candidateOf(raw, job);
        if (typeof made === "string") return fail(made);
        const same = [...job.candidates, ...added].find((c) => c.name.toLowerCase() === made.name.toLowerCase() && c.trade === made.trade);
        if (!same) added.push(made);
      }
      if (job.candidates.length + added.length > MAX_CANDIDATES) return fail(`A job keeps up to ${MAX_CANDIDATES} candidates.`);
      job.candidates.push(...added);
      if (job.state === "requested" || job.state === "contacted") job.state = "shortlisted";
      this.write(file);
      return ok({ jobId: job.id, state: job.state, candidates: job.candidates.map((c) => ({ candidateId: c.id, name: c.name, trade: c.trade, source: c.source })), next: "Show the host the list and ask who to call, then call pick_pros." });
    });
  }

  /** The host's pick, in order (two calls, the second with the code). */
  pickPros(input: { jobId?: string; ids?: string[]; confirmation?: string }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const off = this.inactive(file);
      if (off) return off;
      const job = this.jobOf(file, input.jobId);
      if (!job) return fail("There's no job with that id. Call get_fixer_state for the list.");
      if (!isOpen(job) || !NOT_BOOKED.has(job.state)) return fail("That job isn't open for picking.");
      if (!job.hostGo) return fail("The host hasn't said go for this job yet.");
      const ids = input.ids;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_CANDIDATES || !ids.every((id) => typeof id === "string")) return fail(`Pick 1 to ${MAX_CANDIDATES} pros by id.`);
      if (new Set(ids).size !== ids.length) return fail("Each pro can be picked once.");
      // A pick is the host's approval to call, so it only takes a candidate here or a saved pro.
      const names: string[] = [];
      for (const id of ids) {
        const saved = file.pros.find((pro) => pro.id === id && pro.status === "saved");
        const name = saved?.name ?? job.candidates.find((c) => c.id === id)?.name;
        if (!name) return fail("Pick only from this job's candidates or the host's saved pros. Call get_fixer_state for the list.");
        names.push(name);
      }
      const gate = this.approved(file, "fixer-pick", job.id, input, pickQuestion({ names }));
      if (gate !== "go") return gate;
      job.picked = [...ids];
      this.write(file);
      return ok({ picked: true, jobId: job.id, next: "Call contact_pro for the first one." });
    });
  }

  /** A refusal the agent must pass to the host. */
  private refuseHost(text: string): FixerReply {
    return { text, structured: { tellHost: true }, isError: true };
  }

  /** Starts a contact with a picked or preferred pro and gives back the token that records what they said. */
  contactPro(input: { jobId?: string; to?: string; how?: Contact["how"] }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const off = this.inactive(file);
      if (off) return off;
      const job = this.jobOf(file, input.jobId);
      if (!job) return fail("There's no job with that id. Call get_fixer_state for the list.");
      if (!isOpen(job) || !NOT_BOOKED.has(job.state)) return fail("That job isn't open for contacting anyone.");
      if (typeof input.to !== "string" || !HOWS.includes(input.how as never)) return fail(`Say who to contact and how: ${HOWS.join(", ")}.`);
      const allowed = contactAllowed(job, input.to, file.pros);
      const name = this.nameOf(file, job, input.to);
      if (!allowed.ok) {
        if (allowed.reason === "no-go") return this.refuseHost("The host hasn't said go for this job yet, so I can't contact anyone.");
        if (allowed.reason === "unknown") return this.refuseHost("That isn't a pro saved here or a candidate on this job.");
        return this.refuseHost(`${name ?? "That pro"} isn't someone the host picked. Ask the host to pick them first.`);
      }
      const reach = this.reachOfId(file, job, input.to);
      const how = input.how!;
      if ((how === "call" || how === "text") && !reach.phone) return fail(`${name} has no phone number saved.`);
      if (how === "email" && !reach.email) return fail(`${name} has no email address saved.`);
      if (how === "text") {
        const people = this.deps.people?.();
        if (!people || !people.optedIn(reach.phone!) || people.stopped(reach.phone!)) return this.refuseHost(`${name} hasn't agreed to texts here, so I won't text them. Call or email instead.`);
      }
      if (job.contacts.some((c) => !c.cancelled && c.to === input.to && c.outcome === undefined)) return fail(`Record what ${name} said first, with record_contact.`);
      const contact: Contact = { id: newId("con_", 8), to: input.to, how, token: letterToken(), at: this.deps.now().toISOString() };
      job.contacts.push(contact);
      if (job.state === "requested" || job.state === "shortlisted") job.state = "contacted";
      this.write(file);
      return ok({ contactToken: contact.token, reach, next: "Reach them, then call record_contact with this token and what they said." });
    });
  }

  /** Is this contact still waiting on its pro? A cancelled contact or one on a closed job isn't. */
  private liveContact(job: Job, contact: Contact): boolean {
    return isOpen(job) && !contact.cancelled;
  }

  /** What a pro said: booked, quoted, no answer, declined or waiting. */
  recordContact(input: { contactToken?: string; outcome?: NonNullable<Contact["outcome"]>; from?: string; until?: string; estimateCents?: number; quoteCents?: number; note?: string; followUpAt?: string }): Promise<FixerReply> {
    return this.guarded(input, async () => {
      const file = this.read();
      const off = this.inactive(file);
      if (off) return off;
      const token = input.contactToken;
      const job = typeof token === "string" && token ? file.jobs.find((j) => j.contacts.some((c) => c.token === token)) : undefined;
      const contact = job?.contacts.find((c) => c.token === token);
      if (!job || !contact || !this.liveContact(job, contact)) return fail("That contact isn't live. Start one with contact_pro.");
      const outcome = input.outcome;
      if (!OUTCOMES.includes(outcome as never)) return fail(`Say what happened: ${OUTCOMES.join(", ")}.`);
      if (outcome !== "booked" && (input.from !== undefined || input.until !== undefined || input.estimateCents !== undefined)) return fail("A time and estimate go with a booked outcome.");
      if (outcome !== "quoted" && input.quoteCents !== undefined) return fail("A quote goes with a quoted outcome.");
      if (input.note !== undefined && !isText(input.note, 300)) return fail("Keep the note under 300 characters.");
      if (input.estimateCents !== undefined && !isInt(input.estimateCents, 0, 2_000_000)) return fail("An estimate is 0 to 2,000,000 cents.");
      if (input.followUpAt !== undefined && (typeof input.followUpAt !== "string" || Number.isNaN(Date.parse(input.followUpAt)))) return fail("The follow-up time has to be a date and time.");
      const now = this.deps.now();
      const at = now.toISOString();
      const name = this.nameOf(file, job, contact.to) ?? "The pro";
      if (outcome === "booked") return this.recordBooked(file, job, contact, name, input);
      if (liveBooking(job)) return fail("This job already has a booking.");
      if (outcome === "quoted") {
        if (!isInt(input.quoteCents, 0, 2_000_000)) return fail("A quote is 0 to 2,000,000 cents.");
        contact.quote = { cents: input.quoteCents, ...(input.note ? { note: redactDigits(input.note).trim() } : {}) };
      }
      contact.outcome = outcome;
      contact.outcomeAt = at;
      delete contact.unconfirmedAt;
      if (outcome === "waiting") contact.followUpAt = input.followUpAt ? new Date(input.followUpAt).toISOString() : new Date(now.getTime() + FOLLOW_UP_MS).toISOString();
      else delete contact.followUpAt;
      const reply: Record<string, unknown> = { jobId: job.id, outcome };
      if (outcome === "declined" || outcome === "no-answer") {
        const next = this.nextPro(file, job);
        if (next) {
          reply.next = { proId: next.proId, name: next.name, ...(next.rank !== undefined ? { rank: next.rank } : {}), then: "Ask the host whether to call them, then contact_pro." };
        } else if (!this.stillOpen(job)) {
          job.state = job.candidates.length > 0 ? "shortlisted" : "requested";
          reply.state = job.state;
          reply.next = job.state === "shortlisted" ? "No one is left to call. Ask the host to pick someone else from the list or find more options." : "No one is left to call. Find more pros and add_candidates.";
        }
      }
      this.write(file);
      return ok(reply);
    });
  }

  /** True while some contact on the job still has a chance: no outcome, waiting, quoted or booked. */
  private stillOpen(job: Job): boolean {
    return job.contacts.some((c) => !c.cancelled && (c.outcome === undefined || c.outcome === "waiting" || c.outcome === "quoted" || c.outcome === "booked"));
  }

  private occupyInput(file: FixerFile) {
    const property = this.hub().property();
    return {
      timeZone: this.timeZone(),
      ...(property.checkoutTime ? { checkoutTime: property.checkoutTime } : {}),
      ...(property.checkInTime ? { checkInTime: property.checkInTime } : {}),
      checkInBufferMinutes: file.settings.checkInBufferMinutes,
    };
  }

  private codeSaved(): boolean {
    return this.hub().doorAccess(this.deps.env ?? (() => process.env)).saved();
  }

  /** The pending booking a pro's "booked" gives: held for the host if it breaks a gate, kept on the contact if another is already pending. */
  private async recordBooked(file: FixerFile, job: Job, contact: Contact, name: string, input: { from?: string; until?: string; estimateCents?: number }): Promise<FixerReply> {
    if (liveBooking(job)) return fail("This job already has a booking. Cancel it first.");
    const from = input.from;
    const until = input.until;
    if (typeof from !== "string" || typeof until !== "string" || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(until))) return fail("A booked visit needs a from and until time.");
    if (Date.parse(until) <= Date.parse(from)) return fail("The visit has to end after it starts.");
    const span = { from: new Date(from).toISOString(), until: new Date(until).toISOString() };
    const at = this.deps.now().toISOString();
    contact.outcome = "booked";
    contact.outcomeAt = at;
    delete contact.unconfirmedAt;
    delete contact.followUpAt;
    contact.booked = { ...span, ...(input.estimateCents !== undefined ? { estimateCents: input.estimateCents } : {}) };
    const pending = job.booking && !job.booking.hostYes ? job.booking : undefined;
    if (pending && pending.proId !== contact.to) {
      this.write(file);
      return ok({ jobId: job.id, outcome: "booked", heldForHost: true, next: `${name} is another yes while ${this.nameOf(file, job, pending.proId) ?? "another pro"} is waiting on the host. Check check_fixes for the host to choose.` });
    }
    const windows = await this.windowsFor(job);
    const overlaps = overlapsStay(span, this.hub().stays() ?? [], this.occupyInput(file));
    const holds = bookingHolds({ span, windows, overlaps, ...(file.settings.costLineCents !== undefined ? { costLineCents: file.settings.costLineCents } : {}), ...(input.estimateCents !== undefined ? { estimateCents: input.estimateCents } : {}) });
    const access = defaultAccess(job, { reach: this.reachOfId(file, job, contact.to) }, this.codeSaved());
    const booking: Booking = {
      proId: contact.to,
      ...span,
      ...(input.estimateCents !== undefined ? { estimateCents: input.estimateCents } : {}),
      access,
      ...(holds.length > 0 ? { heldFor: holds } : {}),
      fingerprint: bookingFingerprint({ proId: contact.to, ...span, ...(input.estimateCents !== undefined ? { estimateCents: input.estimateCents } : {}), access, ...(job.cleaningOrder ? { cleaningOrder: job.cleaningOrder } : {}) }),
    };
    job.booking = booking;
    this.write(file);
    const blocked = holds.filter((h) => h === "outside-window" || h === "overlaps-stay");
    const reply: Record<string, unknown> = { jobId: job.id, outcome: "booked", access, ...(holds.length > 0 ? { heldFor: holds } : {}) };
    if (blocked.length > 0) {
      reply.next = `That time doesn't fit between guests (${blocked.join(", ")}). Tell the host, and ask ${name} for another time.`;
    } else {
      reply.question = bookingQuestion({ proName: name, ...span, timeZone: this.timeZone(), ...(input.estimateCents !== undefined ? { estimateCents: input.estimateCents } : {}), access });
      reply.next = "Ask the host this question, then call approve_booking.";
    }
    return ok(reply);
  }

  /** Reads the calendars again, unless Cleaner Core or Supply Core already does. */
  private async refreshCalendars(googleEvents?: GoogleEventList): Promise<void> {
    const hub = this.hub();
    if (!this.deps.cleaningOn?.() && !supplyAskOn(this.root) && (hub.calendars().length > 0 || hub.google())) {
      await hub.readCalendars({ ...(googleEvents ? { googleEvents } : {}), tenantId: "fixer" });
    }
  }

  /** The host's yes to a booking (two calls, the second with the code), or to a raised price with `revised`. */
  approveBooking(input: { jobId?: string; access?: "code" | "host"; cleaningOrder?: "before" | "after"; revised?: true; proId?: string; confirmation?: string }): Promise<FixerReply> {
    return this.guarded(input, async () => {
      const file = this.read();
      const off = this.inactive(file);
      if (off) return off;
      const job = this.jobOf(file, input.jobId);
      if (!job || !isOpen(job)) return fail("There's no open job with that id. Call get_fixer_state for the list.");
      if (input.access !== undefined && input.access !== "code" && input.access !== "host") return fail("Access is code or host.");
      if (input.cleaningOrder !== undefined && input.cleaningOrder !== "before" && input.cleaningOrder !== "after") return fail("The cleaning order is before or after.");
      if (input.revised !== undefined && input.revised !== true) return fail("revised is only ever true.");
      if (input.revised) return this.approveRevised(file, job, input);
      if (liveBooking(job)) return fail("This job already has a booking.");
      const target = this.bookingTarget(file, job, input.proId);
      if (typeof target === "string") return fail(target);
      const name = this.nameOf(file, job, target.proId) ?? "The pro";
      const access = input.access ?? target.access;
      if (access === "code" && defaultAccess(job, { reach: this.reachOfId(file, job, target.proId) }, this.codeSaved()) !== "code") return fail("The door code can't go to this pro: there's no saved code, no phone for them, or the job is on the coded lock. Let them in yourself instead.");
      const order = input.cleaningOrder ?? target.cleaningOrder ?? job.cleaningOrder;
      // The stays and windows are read again now, so a yes after they changed is refused.
      await this.refreshCalendars();
      const span = { from: target.from, until: target.until };
      const windows = await this.windowsFor({ ...job, ...(order ? { cleaningOrder: order } : {}) });
      const overlaps = overlapsStay(span, this.hub().stays() ?? [], this.occupyInput(file));
      const holds = bookingHolds({ span, windows, overlaps, ...(file.settings.costLineCents !== undefined ? { costLineCents: file.settings.costLineCents } : {}), ...(target.estimateCents !== undefined ? { estimateCents: target.estimateCents } : {}) });
      if (holds.includes("overlaps-stay")) return fail(`That time now overlaps a guest stay, so nothing is booked. Ask ${name} for another time.`);
      if (holds.includes("outside-window")) return fail(`That time is no longer open between guests, so nothing is booked. Ask ${name} for another time.`);
      const window = windows.find((w) => Date.parse(w.from) <= Date.parse(span.from) && Date.parse(span.until) <= Date.parse(w.until));
      if (window?.cleaning && !order) return ok({ question: cleaningOrderQuestion({ proName: name }), next: "Ask the host, then call approve_booking again with cleaningOrder set to before or after." });
      const question = bookingQuestion({ proName: name, ...span, timeZone: this.timeZone(), ...(target.estimateCents !== undefined ? { estimateCents: target.estimateCents } : {}), access });
      const bound = tokenHash(JSON.stringify([target.fingerprint, access, order ?? null]));
      const gate = this.confirm("fixer-book", job.id, bound, input.confirmation, question);
      if (gate !== "go") return gate;
      const booked: Booking = {
        proId: target.proId,
        ...span,
        ...(target.estimateCents !== undefined ? { estimateCents: target.estimateCents } : {}),
        access,
        hostYes: { at: this.deps.now().toISOString() },
        ...(order ? { cleaningOrder: order } : {}),
        fingerprint: bookingFingerprint({ proId: target.proId, ...span, ...(target.estimateCents !== undefined ? { estimateCents: target.estimateCents } : {}), access, ...(order ? { cleaningOrder: order } : {}) }),
      };
      job.booking = booked;
      if (order) job.cleaningOrder = order;
      job.state = "booked";
      this.write(file);
      return ok({ booked: true, jobId: job.id, proId: booked.proId, from: booked.from, until: booked.until, access, next: access === "host" ? "Tell the pro the time. The host will let them in." : "Tell the pro the time." });
    });
  }

  /** The booking the host is answering: the pending one, or a held yes from another pro the host chose. */
  private bookingTarget(file: FixerFile, job: Job, proId: string | undefined): Booking | string {
    const pending = job.booking && !job.booking.hostYes ? job.booking : undefined;
    if (proId !== undefined && proId !== pending?.proId) {
      const held = job.contacts.find((c) => !c.cancelled && c.to === proId && c.outcome === "booked" && c.booked);
      if (!held?.booked) return "That pro hasn't offered a booking on this job.";
      const access = defaultAccess(job, { reach: this.reachOfId(file, job, proId) }, this.codeSaved());
      const { from, until, estimateCents } = held.booked;
      return { proId, from, until, ...(estimateCents !== undefined ? { estimateCents } : {}), access, fingerprint: bookingFingerprint({ proId, from, until, ...(estimateCents !== undefined ? { estimateCents } : {}), access, ...(job.cleaningOrder ? { cleaningOrder: job.cleaningOrder } : {}) }) };
    }
    return pending ?? "There's no booking waiting for the host's yes on this job.";
  }

  /** The host's yes to a raised price a pro gave after the visit was booked. */
  private approveRevised(file: FixerFile, job: Job, input: { confirmation?: string }): FixerReply {
    const booking = job.booking;
    const revised = booking?.revisedQuote;
    if (!booking || !liveBooking(job) || !revised || revised.hostYes) return fail("There's no raised price waiting for the host's yes.");
    const name = this.nameOf(file, job, booking.proId) ?? "The pro";
    const question = raisedPrice({ proName: name, newCents: revised.cents, oldCents: booking.estimateCents ?? 0 });
    const gate = this.confirm("fixer-revised", job.id, tokenHash(JSON.stringify([booking.fingerprint, revised.cents])), input.confirmation, question);
    if (gate !== "go") return gate;
    revised.hostYes = { at: this.deps.now().toISOString() };
    this.write(file);
    return ok({ approved: true, jobId: job.id, revised: true });
  }

  /** Cancels one job for good: ends the visit link, asks about changing the code if it was shown, and says who to tell. */
  private cancelCore(file: FixerFile, job: Job, reason: string): { name: string; reach: ProReach } | undefined {
    const live = liveBooking(job) && job.booking;
    const tell = live ? { name: this.nameOf(file, job, live.proId) ?? "The pro", reach: this.reachOfId(file, job, live.proId) } : undefined;
    const at = this.deps.now().toISOString();
    job.state = "cancelled";
    job.cancelledAt = at;
    job.cancelReason = reason;
    for (const contact of job.contacts) if (contact.outcome === undefined || contact.outcome === "waiting") contact.cancelled = true;
    if (job.booking) {
      delete job.booking.visitToken;
      if (job.booking.revealedAt && job.booking.revealedAt.length > 0) job.rotationAsked = { at };
    }
    return tell;
  }

  /** The host's cancel (two calls when a booking is live) and who to tell. */
  cancelJob(input: { jobId?: string; reason?: string; confirmation?: string }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const job = this.jobOf(file, input.jobId);
      if (!job) return fail("There's no job with that id. Call get_fixer_state for the list.");
      if (!isOpen(job)) return fail("That job is already closed.");
      if (input.reason !== undefined && !isText(input.reason, 200)) return fail("Keep the reason under 200 characters.");
      if (liveBooking(job) && job.booking) {
        const gate = this.approved(file, "fixer-cancel", job.id, input, cancelQuestion({ proName: this.nameOf(file, job, job.booking.proId) ?? "the pro" }));
        if (gate !== "go") return gate;
      }
      const tellPro = this.cancelCore(file, job, input.reason ? redactDigits(input.reason).trim() : "Cancelled");
      this.write(file);
      return ok({ cancelled: true, jobId: job.id, ...(tellPro ? { tellPro, next: `Tell ${tellPro.name} the visit is cancelled.` } : {}) });
    });
  }

  /** Contacts with no outcome after 2 hours (told once) and waiting ones past their follow-up time. */
  private sweep(file: FixerFile): { unconfirmed: Record<string, unknown>[]; followUps: Record<string, unknown>[] } {
    const now = this.deps.now().getTime();
    const at = new Date(now).toISOString();
    const unconfirmed: Record<string, unknown>[] = [];
    const followUps: Record<string, unknown>[] = [];
    for (const job of file.jobs) {
      if (!isOpen(job) || liveBooking(job)) continue;
      for (const contact of job.contacts) {
        if (contact.cancelled) continue;
        const name = this.nameOf(file, job, contact.to) ?? "The pro";
        if (contact.outcome === undefined && !contact.unconfirmedAt && now - Date.parse(contact.at) >= UNCONFIRMED_MS) {
          contact.unconfirmedAt = at;
          unconfirmed.push({ jobId: job.id, contactToken: contact.token, proId: contact.to, name, since: contact.at });
        }
        if (contact.outcome === "waiting" && contact.followUpAt && Date.parse(contact.followUpAt) <= now) {
          const next = this.nextPro(file, job);
          followUps.push({ jobId: job.id, contactToken: contact.token, proId: contact.to, name, ...(next ? { next } : {}) });
        }
      }
    }
    return { unconfirmed, followUps };
  }

  /** Bookings waiting on the host: held by a gate, or with another pro's yes to choose from. */
  private heldList(file: FixerFile): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const job of file.jobs) {
      const booking = job.booking;
      if (!isOpen(job) || !booking || booking.hostYes) continue;
      const others = job.contacts
        .filter((c) => !c.cancelled && c.outcome === "booked" && c.booked && c.to !== booking.proId)
        .map((c) => ({ proId: c.to, name: this.nameOf(file, job, c.to) ?? "The pro", ...c.booked! }));
      if (!booking.heldFor && others.length === 0) continue;
      out.push({ jobId: job.id, proId: booking.proId, name: this.nameOf(file, job, booking.proId) ?? "The pro", from: booking.from, until: booking.until, ...(booking.estimateCents !== undefined ? { estimateCents: booking.estimateCents } : {}), ...(booking.heldFor ? { heldFor: booking.heldFor } : {}), ...(others.length > 0 ? { others } : {}) });
    }
    return out;
  }

  /** Jobs whose door code was opened by a pro and then cancelled: the host is asked whether to change it. */
  private rotationList(file: FixerFile): Record<string, unknown>[] {
    return file.jobs
      .filter((job) => job.rotationAsked && !job.rotationAsked.answer && job.booking)
      .map((job) => ({ jobId: job.id, question: rotationQuestion({ proName: this.nameOf(file, job, job.booking!.proId) ?? "The pro" }) }));
  }

  /** Upkeep items whose date is within `leadDays` and that have no job open or already started for that date. */
  private upkeepDue(file: FixerFile): Record<string, unknown>[] {
    const today = this.today();
    const tz = this.timeZone();
    const due: Record<string, unknown>[] = [];
    for (const item of file.upkeep) {
      const jobs = file.jobs.filter((job) => job.sourceRef === item.id);
      if (jobs.some(isOpen)) continue;
      const start = localYmd(new Date(item.lastDoneAt ?? item.savedAt), tz);
      const nextDate = nextDates(item.schedule, start, start, 1)[0];
      if (!nextDate) continue;
      const leadStart = addCalendarDays(nextDate, -item.leadDays);
      if (today < leadStart) continue;
      // A job already made for this date (even a cancelled one) means the date was dealt with.
      if (jobs.some((job) => localYmd(new Date(job.createdAt), tz) >= leadStart)) continue;
      due.push({ upkeepId: item.id, trade: item.trade, what: item.what, nextDate, ...(item.proId ? { proId: item.proId } : {}) });
    }
    return due;
  }

  /** The next saved pro to contact for each job the host said go to, the best ranked one not yet tried. */
  private contactNext(file: FixerFile): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const job of file.jobs) {
      if (!isOpen(job) || !job.hostGo || !NOT_BOOKED.has(job.state) || liveBooking(job)) continue;
      if (job.contacts.some((contact) => !contact.cancelled && (contact.outcome === undefined || contact.outcome === "waiting"))) continue;
      const next = this.topPro(file, job.trade, job.contacts.map((contact) => contact.to));
      if (!next || !contactAllowed(job, next.pro.id, file.pros).ok) continue;
      out.push({ jobId: job.id, proId: next.pro.id, name: next.pro.name, reach: next.pro.reach, rank: next.rank });
    }
    return out;
  }

  /** The morning pass: what needs the host's go, what upkeep is due, who to contact next, and when pros can visit. */
  checkFixes(input: { googleEvents?: GoogleEventList }): Promise<FixerReply> {
    // Event text can hold long booking numbers. Only their dates are read, so they skip the card check.
    const { googleEvents: _events, ...rest } = input;
    return this.guarded(rest, async () => {
      const file = this.read();
      if (!file.settings.activatedAt || file.offAt) return fail("Repairs aren't active yet. Call get_fixer_state.");
      const swept = this.sweep(file);
      // Cleaner Core or Supply Core read the calendars when they run; otherwise this check does.
      await this.refreshCalendars(input.googleEvents);
      const windows: Record<string, VisitWindow[]> = {};
      for (const job of file.jobs) {
        if (isOpen(job) && job.hostGo && !liveBooking(job)) windows[job.id] = await this.windowsFor(job);
      }
      const at = this.deps.now().toISOString();
      const news: { jobId: string; kind: string; at: string }[] = [];
      for (const job of file.jobs) {
        for (const item of job.news) {
          if (item.toldAt) continue;
          news.push({ jobId: job.id, kind: item.kind, at: item.at });
          item.toldAt = at;
        }
      }
      // The whole reply is built before the news is marked told and saved.
      const body = {
        needsGo: file.jobs.filter((job) => isOpen(job) && !job.hostGo && job.state === "requested").map((job) => ({ jobId: job.id, question: this.goQuestion(file, job) })),
        upkeepDue: this.upkeepDue(file),
        contactNext: this.contactNext(file),
        windows,
        unconfirmed: swept.unconfirmed,
        followUps: swept.followUps,
        held: this.heldList(file),
        delays: [],
        preferredAsk: [],
        rotationAsk: this.rotationList(file),
        news,
      };
      this.write(file);
      return ok(body);
    });
  }

  /** Turned back on: setup and the lists are as they were. */
  turnOn(): Promise<FixerReply> {
    return this.guarded({}, () => {
      const file = this.read();
      if (file.offAt) {
        delete file.offAt;
        this.write(file);
      }
      return ok({ on: true });
    });
  }

  /** Turned off: no new work. With `cancel`, every job still going is cancelled too, and the pros with a live booking are listed to tell. */
  turnOff(cancel: boolean): Promise<FixerReply> {
    return this.guarded({}, () => {
      const file = this.read();
      file.offAt = this.deps.now().toISOString();
      const tellPro: { name: string; reach: ProReach }[] = [];
      if (cancel) {
        for (const job of file.jobs.filter(isOpen)) {
          const tell = this.cancelCore(file, job, "Repairs turned off");
          if (tell) tellPro.push(tell);
        }
      }
      this.write(file);
      return ok({ off: true, ...(cancel ? { tellPro } : {}) });
    });
  }
}

const desks = new Map<string, FixerDesk>();

/** One desk per property folder, so calls for the same property run one at a time. */
export function fixerDeskFor(root: string, deps: FixerDeps): FixerDesk {
  const existing = desks.get(root);
  if (existing) return existing;
  const desk = new FixerDesk(root, deps);
  desks.set(root, desk);
  return desk;
}

/** Forgets every desk, as a restart would. Tests use it. */
export function resetFixerDesks(): void {
  desks.clear();
}
