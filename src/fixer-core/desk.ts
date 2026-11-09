import { createHash } from "node:crypto";
import { join } from "node:path";
import { localDateOf } from "../core/timezone";
import { isDone, isYes } from "../cleaner-core/core";
import { isInjuryReport } from "../cleaner-core/injury";
import { cleanerPhotoFetch, copyPhotos, downloadPhotos, MAX_JOB_PHOTOS, messagePhotoId, photoCount, photoLinks, prunePhotos, storePhoto, type InboundMedia } from "../cleaner-core/photos";
import { isPlainLanguageStop, keywordOf } from "../intent";
import { askNext } from "../hub/ask";
import { addCalendarDays } from "../hub/calendar";
import { joinSplitDigits } from "../hub/digits";
import type { GoogleEventList } from "../hub/sources";
import { refuseCards } from "../hub/cards";
import type { AccessRefusal as DoorRefusal } from "../hub/doorAccess";
import { hubFor, propertyDetailsProblem, type Hub } from "../hub/hub";
import type { Stay } from "../hub/store";
import type { People } from "../hub/people";
import { sameHash } from "../hub/uploadCode";
import { ConfirmationBook } from "../operator/confirmations";
import { nextDates, scheduleProblem, type Schedule } from "../supply-core/schedule";
import { supplyAskOn } from "../supply-core/store";
import { accessCheck, type AccessRefusal, bookingFingerprint, bookingHolds, type BookingHold, contactAllowed, costNews, defaultAccess, liveBooking, raisedPriceHeld } from "./gate";
import { holdsOtherRole, priceCents } from "./proLine";
import { activateProblems, fixerSetupAsk, proGaps } from "./setupAsk";
import { bookingQuestion, cancelQuestion, propertyQuestion, CODE_CHANGE_NEXT, dollars, codeRefusedNote, codeText, codeTextNews, codeTextUnsureNote, costNewsText, cleaningOrderQuestion, extendQuestion, hostGoQuestion, lateBeforeCheckInNews, noPhotosNews, pickQuestion, preferredQuestion, PRO_DONE_ACK, PRO_HURT, PRO_HURT_CALL, proHurtNews, proTextFailed, proInvite, proTextNews, raisedPrice, raisedPriceNews, revealNews, rotationQuestion, streetOf, rescheduleQuestion, codeTextOffNote, removeBookedPro, removeContactedPro, STAY_OVER_NEXT, stayOverBookingNews, STAYS_UNREAD, STAYS_UNREAD_BOOK, VISIT_ENDED, VISIT_LINK_NEXT, VISIT_NOT_STARTED, VISIT_PAGE_OFF, VISIT_REVOKED, visitOverNews, visitTextPath } from "./texts";
import { latestYmd, nextCheckIn, overlapsStay, visitWindows, type VisitWindow } from "./window";
import { TRADES, isTrade, letterToken, newId, readFixer, tokenHash, writeFixer, type Booking, type Candidate, type Contact, type FileNews, type FixerFile, type Job, type Pro, type ProReach, type Trade, type Upkeep } from "./store";

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
  /** A note for the host, with a wake. True once it was taken (Cleaner Core runs here); otherwise it may go nowhere. */
  notifyHost?(id: string, text: string): Promise<boolean | void>;
  photoKey?(): Buffer | undefined;
}

/** Why the visit page (or the tick) got no code. */
export type RevealRefusal = AccessRefusal | DoorRefusal | "no-job" | "off" | "damaged";

/** The visit page's answer. Never passed to a tool reply, a log line or a file. */
export type RevealResult = { ok: true; code: string; lockLocation?: string } | { ok: false; reason: RevealRefusal };

/** The visit page's path before its token. The page itself is in `visitPage.ts`. */
export const FIXER_VISIT_PREFIX = "/fixer-core/visit/";
/** Requests a visit link answers in an hour. */
export const VISIT_HITS_PER_HOUR = 30;
/** A visit token: `letterToken()`'s 64 letters a to p. */
const VISIT_TOKEN = /^[a-p]{64}$/;
/** The door code, and the page's photos, done and price, open this long before the visit. */
const DOOR_LEAD_MS = 30 * 60_000;
/** The page shows the address from this long before the visit. */
const ADDRESS_LEAD_MS = 24 * 60 * 60_000;
/** With no done, the page still takes photos, done and a price this long after the visit's end. */
const PAGE_AFTER_MS = 24 * 60 * 60_000;

/** What the visit page shows for a live link. Never the code, the lock location or the token. */
export interface VisitView {
  jobId: string;
  proName: string;
  what: string;
  from: string;
  /** The visit's end, with any extension. */
  until: string;
  timeZone: string;
  access: "code" | "host";
  /** "during" from 30 minutes before the visit; "after" once its end has passed with no done. */
  phase: "before" | "during" | "after";
  /** Only from 24 hours before the visit. */
  address?: string;
  estimateCents?: number;
  raised?: { cents: number; waiting: boolean };
  /** Photos the pro has added. */
  photos: number;
}

/** A line for the host, sent once the record holding its news is saved. */
interface HostNote {
  id: string;
  text: string;
}

export const MAX_PROS = 60;
export const MAX_UPKEEP = 30;
export const MAX_CANDIDATES = 8;
const UNCONFIRMED_MS = 2 * 60 * 60_000;
export const GOOGLE_EVENTS_NEEDED = "Google Calendar is saved for this property: read its events and call approve_booking again with them as googleEvents.";
const PAST_SPAN = "That time has already started, so it can't be booked. Ask the pro for a time still to come.";
const FOLLOW_UP_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
/** Told notes with no job are kept this long. */
const NEWS_KEPT_MS = 30 * 24 * HOUR_MS;
const COST_BYS = ["pro", "agent", "host"] as const;
const HOWS: readonly Contact["how"][] = ["call", "email", "form", "booking-page", "text", "network"];
const OUTCOMES: readonly NonNullable<Contact["outcome"]>[] = ["booked", "quoted", "no-answer", "declined", "waiting"];
export const CARD_REFUSAL = "That looks like a card number. Fixer Core never takes card details: keep them in your Vault.";
const APPROVAL_STALE = "That approval has expired or doesn't match this change. Ask the host again.";
const NO_JOB = "There's no job with that id. Call get_fixer_state for the list.";
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

/** What a booking was checked against, as its fingerprint. */
function fingerprintOf(b: { proId: string; from: string; until: string; estimateCents?: number; access: "code" | "host" }, order?: "before" | "after"): string {
  return bookingFingerprint({ proId: b.proId, from: b.from, until: b.until, ...(b.estimateCents !== undefined ? { estimateCents: b.estimateCents } : {}), access: b.access, ...(order ? { cleaningOrder: order } : {}) });
}

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

/** The pros the door code was shown or texted to on any visit of this job. A rebook keeps the list. */
function shownTo(job: Job): string[] {
  const ids = [...(job.codeShownTo ?? [])];
  const booking = job.booking;
  if (booking?.revealedAt?.length && !ids.includes(booking.proId)) ids.push(booking.proId);
  return ids;
}

const codeWasShown = (job: Job): boolean => shownTo(job).length > 0;

/** Notes that the booked pro was given the code. */
function markShown(job: Job): void {
  const proId = job.booking?.proId;
  if (proId && !(job.codeShownTo ??= []).includes(proId)) job.codeShownTo.push(proId);
}

/** A short tag for one booked visit, so its host notes have ids no other visit of the job shares. */
function visitTag(booking: Booking | undefined): string {
  return booking ? tokenHash(`${booking.fingerprint}|${booking.hostYes?.at ?? ""}`).slice(0, 8) : "none";
}

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
  /** Requests to each visit link in its current hour, by token hash. In memory: a restart counts from zero. */
  private readonly visitHits = new Map<string, { start: number; count: number }>();
  /** Links a lookup found live, by token hash, until the link ends. In memory: after a restart, the first lookup fills it again. */
  private readonly liveLinks = new Map<string, number>();

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

  /**
   * The saved pros that have a phone, and a found candidate with a phone while their booking is live,
   * kept in the account's people list as role "pro" for this property (Decision 10).
   */
  private syncPros(file: FixerFile): void {
    const people = this.deps.people?.();
    if (!people || !this.deps.propertyId) return;
    const wanted = file.pros.filter((pro) => pro.status === "saved" && pro.reach.phone).map((pro) => ({ phone: pro.reach.phone!, name: pro.name }));
    for (const job of file.jobs) {
      if (!job.booking?.hostYes || !liveBooking(job)) continue;
      const candidate = job.candidates.find((c) => c.id === job.booking!.proId);
      const phone = candidate?.reach.phone;
      if (phone && !wanted.some((entry) => entry.phone === phone)) wanted.push({ phone, name: candidate.name });
    }
    people.saveRolePeople(this.deps.propertyId, "pro", wanted);
  }

  /**
   * The text invite, once per phone: only a saved pro who prefers text, with a phone, after the host is confirmed,
   * and only if `claimInvite` allows it. A pro who also holds another role here is reached by the visit page only.
   * The mark is saved before the send, so a failed send is not retried.
   */
  private async inviteIfAsked(file: FixerFile, pro: Pro): Promise<void> {
    const phone = pro.reach.phone;
    const people = this.deps.people?.();
    const here = this.deps.propertyId;
    if (pro.status !== "saved" || !pro.prefersText || !phone || pro.invitedPhones?.includes(phone) || !people || !here || !this.deps.send) return;
    if (holdsOtherRole(people, phone)) return;
    try {
      if ((await this.deps.textsAllowed?.()) !== true) return;
      const business = await this.deps.business?.();
      if (!business || !people.claimInvite(phone, here)) return;
      (pro.invitedPhones ??= []).push(phone);
      this.write(file);
      await this.deps.send(phone, proInvite({ proName: pro.name, business, street: streetOf(this.hub().property().address ?? "") }));
    } catch {
      // The invite is best effort; the host can still call or email the pro.
    }
  }

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
    return this.guarded(input, async () => {
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
      // Only a saved pro answers the preferred question; a draft is the agent's, not the host's.
      const rotationAsk = job && pro.status === "saved" ? this.answerPreferred(file, job, "yes", pro) : undefined;
      this.write(file);
      if (pro.status === "saved") {
        this.syncPros(file);
        await this.inviteIfAsked(file, pro);
      }
      return ok({ saved: true, proId: pro.id, status: pro.status, ...(rotationAsk ? { rotationAsk: [rotationAsk] } : {}), ...(file.settings.activatedAt ? {} : { next: "Ask whether there's anyone else they call." }) });
    });
  }

  /** The host's yes to drafted pros: each one becomes saved. */
  private async confirmPros(file: FixerFile, input: ProInput): Promise<FixerReply> {
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
    for (const pro of drafts as Pro[]) await this.inviteIfAsked(file, pro);
    return ok({ saved: true, confirmed: (drafts as Pro[]).map((pro) => pro.id) });
  }

  removePro(input: { id?: string; confirmation?: string }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const pro = file.pros.find((entry) => entry.id === input.id);
      if (!pro) return fail("There's no pro with that id. Call get_fixer_state for the list.");
      const open = file.jobs.filter(isOpen);
      if (open.some((job) => job.booking?.proId === pro.id)) return fail(removeBookedPro({ proName: pro.name }));
      if (open.some((job) => job.contacts.some((c) => c.to === pro.id && !c.cancelled && (c.outcome === undefined || c.outcome === "waiting" || c.outcome === "booked")))) return fail(removeContactedPro({ proName: pro.name }));
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
      const problems = activateProblems(this.hub(), file);
      if (problems.length > 0) return fail(problems.join(" "));
      file.settings.activatedAt = this.deps.now().toISOString();
      delete file.offAt;
      this.write(file);
      return ok({ active: true, line: this.line(file) });
    });
  }

  /** The property's address, time zone and name, saved in its hub and shared with the other flows. Activate needs them; after it, a change takes the host's yes. */
  saveProperty(input: { address?: string; timeZone?: string; name?: string; confirmation?: string }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const problem = propertyDetailsProblem(input);
      if (problem) return fail(problem);
      const file = this.read();
      const details = { address: input.address!, timeZone: input.timeZone!, ...(input.name !== undefined ? { name: input.name } : {}) };
      const gate = this.approved(file, "fixer-property", "property", input, propertyQuestion({ address: details.address.trim() }));
      if (gate !== "go") return gate;
      const saved = this.hub().saveDetails(details);
      if (!saved.ok) return fail(saved.error);
      return ok({ saved: true, ...(this.askFor(file) ? { next: "Call get_fixer_state for the next step." } : {}) });
    });
  }

  /**
   * The property's booking calendars, in its hub and shared with the other flows: a one-time upload
   * link for one calendar, google: true for Google Calendar, or done: true when that's all. The host's
   * "there is no booking calendar" stays in fixer.json, so the other flows still ask for theirs.
   */
  saveSources(input: { uploadLink?: { name?: string }; google?: true; done?: true }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const hub = this.hub();
      if (input.done && !input.uploadLink && !input.google && hub.calendars().length === 0 && !hub.google()) {
        file.setup.noCalendar = true;
        this.write(file);
        return ok({ calendars: [], noCalendar: true, ...(this.askFor(file) ? { next: "Call get_fixer_state for the next step." } : {}) });
      }
      const saved = hub.saveSources(input, this.deps.publicBase?.());
      if (!saved.ok) return fail(saved.error);
      if ("upload" in saved) {
        return ok({
          uploadUrl: saved.upload.uploadUrl,
          expiresInMinutes: saved.upload.expiresInMinutes,
          next: 'From your own cloud computer, POST JSON {"url": "<calendar link>"} to uploadUrl with Content-Type: application/json, or open uploadUrl in your own browser and hand it to the host to paste the link there. Never put the link or uploadUrl in chat. Then call get_fixer_state.',
        });
      }
      return ok({ calendars: saved.calendars });
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

  /** The times a pro can visit for this job, between the stays, with the cleaning applied. None while the stays are unknown. */
  async windowsFor(job: Job): Promise<VisitWindow[]> {
    const file = this.read();
    if (this.staysUnknown()) return [];
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
      // The pro whose yes is pending took it back (or went quiet): the pending booking goes.
      if (job.booking && !job.booking.hostYes && job.booking.proId === contact.to) delete job.booking;
      delete contact.booked;
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

  private door() {
    return this.hub().doorAccess(this.deps.env ?? (() => process.env));
  }

  private codeSaved(): boolean {
    return this.door().saved();
  }

  /** The gate holds for a span, with the windows they were checked against. */
  private async holdsFor(file: FixerFile, job: Job, span: { from: string; until: string }, estimateCents: number | undefined, order?: "before" | "after"): Promise<{ holds: BookingHold[]; windows: VisitWindow[] }> {
    const windows = await this.windowsFor({ ...job, ...(order ? { cleaningOrder: order } : {}) });
    const overlaps = overlapsStay(span, this.hub().stays() ?? [], this.occupyInput(file));
    const holds = bookingHolds({ span, windows, overlaps, ...(file.settings.costLineCents !== undefined ? { costLineCents: file.settings.costLineCents } : {}), ...(estimateCents !== undefined ? { estimateCents } : {}) });
    return { holds, windows };
  }

  /** The question for a booking, with the holds the host's yes would accept. */
  private questionFor(file: FixerFile, proName: string, b: { from: string; until: string; estimateCents?: number }, access: "code" | "host", holds: readonly BookingHold[]): string {
    return bookingQuestion({ proName, from: b.from, until: b.until, timeZone: this.timeZone(), ...(b.estimateCents !== undefined ? { estimateCents: b.estimateCents } : {}), access, holds, ...(file.settings.costLineCents !== undefined ? { costLineCents: file.settings.costLineCents } : {}) });
  }

  /** The pending booking a pro's "booked" gives: held for the host if it breaks a gate, kept on the contact if another is already pending. */
  private async recordBooked(file: FixerFile, job: Job, contact: Contact, name: string, input: { from?: string; until?: string; estimateCents?: number }): Promise<FixerReply> {
    if (liveBooking(job)) return fail("This job already has a booking. Cancel it first.");
    const from = input.from;
    const until = input.until;
    if (typeof from !== "string" || typeof until !== "string" || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(until))) return fail("A booked visit needs a from and until time.");
    if (Date.parse(until) <= Date.parse(from)) return fail("The visit has to end after it starts.");
    if (Date.parse(from) <= this.deps.now().getTime()) return fail(PAST_SPAN);
    if (this.staysUnknown()) return fail(STAYS_UNREAD_BOOK);
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
    const { holds } = await this.holdsFor(file, job, span, input.estimateCents);
    const access = defaultAccess(job, { reach: this.reachOfId(file, job, contact.to) }, this.codeSaved());
    const booking: Booking = {
      proId: contact.to,
      ...span,
      ...(input.estimateCents !== undefined ? { estimateCents: input.estimateCents } : {}),
      access,
      ...(holds.length > 0 ? { heldFor: holds } : {}),
      fingerprint: "",
    };
    booking.fingerprint = fingerprintOf(booking, job.cleaningOrder);
    job.booking = booking;
    this.write(file);
    const reply: Record<string, unknown> = { jobId: job.id, outcome: "booked", access, ...(holds.length > 0 ? { heldFor: holds } : {}) };
    if (holds.includes("overlaps-stay")) {
      reply.next = `That time overlaps a guest stay, so it can't be booked. Tell the host, and ask ${name} for another time.`;
    } else {
      reply.question = this.questionFor(file, name, booking, access, holds);
      reply.next = "Ask the host this question, then call approve_booking.";
    }
    return ok(reply);
  }

  /** True when this desk reads the calendars itself: neither Cleaner Core nor Supply Core does, and one is saved. */
  private readsCalendars(): boolean {
    const hub = this.hub();
    return !this.deps.cleaningOn?.() && !supplyAskOn(this.root) && (hub.calendars().length > 0 || Boolean(hub.google()));
  }

  /**
   * True while calendars are saved but no clean read has given the stays (a hub.json from before stays
   * were kept, or a read that never ran). The stays are unknown, not empty: no window, booking or yes.
   */
  private staysUnknown(): boolean {
    const hub = this.hub();
    return hub.stays() === undefined && (hub.calendars().length > 0 || Boolean(hub.google()));
  }

  /** Reads the calendars again, unless Cleaner Core or Supply Core already does. While the stays are unknown, it reads them anyway. */
  private async refreshCalendars(googleEvents?: GoogleEventList): Promise<void> {
    const hub = this.hub();
    if (this.readsCalendars() || this.staysUnknown()) {
      await hub.readCalendars({ ...(googleEvents ? { googleEvents } : {}), tenantId: "fixer" });
    }
  }

  /** The host's yes to a booking (two calls, the second with the code), or to a raised price with `revised`. */
  approveBooking(input: { jobId?: string; access?: "code" | "host"; cleaningOrder?: "before" | "after"; revised?: true; proId?: string; googleEvents?: GoogleEventList; confirmation?: string }): Promise<FixerReply> {
    // Event text can hold long booking numbers. Only their dates are read, so they skip the card check.
    const { googleEvents, ...rest } = input;
    return this.guarded(rest, async () => {
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
      if ((this.readsCalendars() || this.staysUnknown()) && this.hub().google() && !googleEvents) return fail(GOOGLE_EVENTS_NEEDED);
      await this.refreshCalendars(googleEvents);
      if (this.staysUnknown()) return fail(STAYS_UNREAD_BOOK);
      const span = { from: target.from, until: target.until };
      if (Date.parse(span.from) <= this.deps.now().getTime()) return fail(PAST_SPAN);
      const { holds, windows } = await this.holdsFor(file, job, span, target.estimateCents, order);
      if (holds.includes("overlaps-stay")) return fail(`That time overlaps a guest stay, so nothing is booked. Ask ${name} for another time.`);
      const checkoutDay = localYmd(new Date(span.from), this.timeZone());
      if (!order && windows.some((w) => w.cleaning && w.checkoutYmd === checkoutDay)) return ok({ question: cleaningOrderQuestion({ proName: name }), next: "Ask the host, then call approve_booking again with cleaningOrder set to before or after." });
      const question = this.questionFor(file, name, target, access, holds);
      const bound = tokenHash(JSON.stringify([target.fingerprint, access, order ?? null, [...holds].sort()]));
      const gate = this.confirm("fixer-book", job.id, bound, input.confirmation, question);
      if (gate !== "go") return gate;
      // A new booking object, so a rebook never keeps the old visit link.
      const displaced = job.booking && !job.booking.hostYes && job.booking.proId !== target.proId ? { name: this.nameOf(file, job, job.booking.proId) ?? "The pro", reach: this.reachOfId(file, job, job.booking.proId) } : undefined;
      const booked: Booking = {
        proId: target.proId,
        from: span.from,
        until: span.until,
        ...(target.estimateCents !== undefined ? { estimateCents: target.estimateCents } : {}),
        access,
        hostYes: { at: this.deps.now().toISOString() },
        ...(order ? { cleaningOrder: order } : {}),
        fingerprint: fingerprintOf(target, order),
      };
      job.booking = booked;
      if (order) job.cleaningOrder = order;
      job.state = "booked";
      this.write(file);
      this.syncPros(file);
      return ok({ booked: true, jobId: job.id, proId: booked.proId, from: booked.from, until: booked.until, access, ...(displaced ? { tellPro: displaced } : {}), next: access === "host" ? "Tell the pro the time. The host will let them in." : "Tell the pro the time." });
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
      const alt = { proId, from, until, ...(estimateCents !== undefined ? { estimateCents } : {}), access };
      return { ...alt, fingerprint: fingerprintOf(alt, job.cleaningOrder) };
    }
    return pending ?? "There's no booking waiting for the host's yes on this job.";
  }

  /** The host's yes to a raised price a pro gave after the visit was booked. */
  private approveRevised(file: FixerFile, job: Job, input: { confirmation?: string }): FixerReply {
    const booking = job.booking;
    const revised = booking?.revisedQuote;
    if (!booking || !liveBooking(job) || !revised || revised.hostYes || !raisedPriceHeld(file.settings.costLineCents, booking.estimateCents, revised.cents)) return fail("There's no raised price waiting for the host's yes.");
    const name = this.nameOf(file, job, booking.proId) ?? "The pro";
    const question = raisedPrice({ proName: name, newCents: revised.cents, ...(booking.estimateCents !== undefined ? { oldCents: booking.estimateCents } : {}) });
    const gate = this.confirm("fixer-revised", job.id, tokenHash(JSON.stringify([booking.fingerprint, revised.cents])), input.confirmation, question);
    if (gate !== "go") return gate;
    revised.hostYes = { at: this.deps.now().toISOString() };
    this.write(file);
    return ok({ approved: true, jobId: job.id, revised: true, tellPro: { name, reach: this.reachOfId(file, job, booking.proId) }, next: `Tell ${name} to go ahead.` });
  }

  /** Cancels one job for good: ends the visit link, asks about changing the code if it was shown, and says who to tell. */
  private cancelCore(file: FixerFile, job: Job, reason: string): { tellPro?: { name: string; reach: ProReach }; rotationAsk?: { jobId: string; question: string } } {
    const live = liveBooking(job) && job.booking;
    const proName = job.booking ? this.nameOf(file, job, job.booking.proId) ?? "The pro" : "The pro";
    const tellPro = live && job.booking ? { name: proName, reach: this.reachOfId(file, job, job.booking.proId) } : undefined;
    const at = this.deps.now().toISOString();
    job.state = "cancelled";
    job.cancelledAt = at;
    job.cancelReason = reason;
    for (const contact of job.contacts) if (contact.outcome === undefined || contact.outcome === "waiting") contact.cancelled = true;
    if (job.booking) delete job.booking.visitToken;
    const rotationAsk = this.askRotation(file, job, { open: true });
    return { ...(tellPro ? { tellPro } : {}), ...(rotationAsk ? { rotationAsk } : {}) };
  }

  /** The host's cancel (two calls when a booking is live) and who to tell. */
  cancelJob(input: { jobId?: string; reason?: string; confirmation?: string }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const job = this.jobOf(file, input.jobId);
      if (!job) return fail("There's no job with that id. Call get_fixer_state for the list.");
      if (!isOpen(job)) return fail("That job is already closed.");
      if (input.reason !== undefined && !isText(input.reason, 200)) return fail("Keep the reason under 200 characters.");
      if (liveBooking(job) && job.booking && file.settings.activatedAt) {
        // Bound to this booking as it stands, so a yes given before a rebook or an extend doesn't cancel the new one.
        const gate = this.confirm("fixer-cancel", job.id, this.bookingBound(job.booking, input.reason), input.confirmation, cancelQuestion({ proName: this.nameOf(file, job, job.booking.proId) ?? "the pro" }));
        if (gate !== "go") return gate;
      }
      const { tellPro, rotationAsk } = this.cancelCore(file, job, input.reason ? redactDigits(input.reason).trim() : "Cancelled");
      this.write(file);
      this.syncPros(file);
      return ok({ cancelled: true, jobId: job.id, ...(tellPro ? { tellPro, next: `Tell ${tellPro.name} the visit is cancelled.` } : {}), ...(rotationAsk ? { rotationAsk: [rotationAsk] } : {}) });
    });
  }

  /**
   * The host moves a booked visit to a new time (two calls): the job goes back to contacted, the old
   * booking and its visit link end, and the new visit gets its own code text. After a reveal, the host
   * gets the rotation question, as on a cancel.
   */
  rescheduleJob(input: { jobId?: string; reason?: string; confirmation?: string }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const off = this.inactive(file);
      if (off) return off;
      const job = this.jobOf(file, input.jobId);
      if (!job) return fail(NO_JOB);
      const booking = job.booking;
      if (!booking?.hostYes || !liveBooking(job)) return fail("Only a booked visit can be moved to a new time.");
      if (input.reason !== undefined && !isText(input.reason, 200)) return fail("Keep the reason under 200 characters.");
      const proName = this.bookedName(file, job);
      const gate = this.confirm("fixer-reschedule", job.id, this.bookingBound(booking, input.reason), input.confirmation, rescheduleQuestion({ proName }));
      if (gate !== "go") return gate;
      const now = this.deps.now();
      const at = now.toISOString();
      const tellPro = { name: proName, reach: this.reachOfId(file, job, booking.proId) };
      // Who saw the code moves to the job, since the booking goes.
      const seen = shownTo(job);
      if (seen.length > 0) job.codeShownTo = seen;
      const rotationAsk = this.askRotation(file, job, { open: true });
      (job.reschedules ??= []).push({ at, ...(input.reason ? { reason: redactDigits(input.reason).trim() } : {}) });
      // The old booking goes with its visit link; the next visit's code text is its own.
      delete job.booking;
      delete job.codeTextAt;
      delete job.codeTextSent;
      delete job.codeNoteAt;
      job.state = "contacted";
      // Every "booked" offer was for the old plan: each one waits for a new time on its own token.
      let contactToken: string | undefined;
      for (const contact of job.contacts) {
        if (contact.cancelled || contact.outcome !== "booked") continue;
        delete contact.booked;
        contact.outcome = "waiting";
        contact.outcomeAt = at;
        contact.followUpAt = new Date(now.getTime() + FOLLOW_UP_MS).toISOString();
        if (contact.to === booking.proId) contactToken = contact.token;
      }
      this.write(file);
      this.syncPros(file);
      return ok({ rescheduled: true, jobId: job.id, state: job.state, tellPro, ...(contactToken ? { contactToken } : {}), ...(rotationAsk ? { rotationAsk: [rotationAsk] } : {}), next: `Tell ${proName} this time is off. Ask them for a new time and record_contact with booked on contactToken, or ask the host about another pro.` });
    });
  }

  /** What a cancel or reschedule yes is bound to: the booking as it stands (times, pro, extension) and the reason. */
  private bookingBound(booking: Booking, reason: string | undefined): string {
    return tokenHash(JSON.stringify([booking.fingerprint, booking.hostYes?.at ?? null, booking.extendedUntil ?? null, reason ?? null]));
  }

  /**
   * The rotation question for the pros who saw the code. An open one stays as it is (returned when
   * `open`); otherwise a fresh one names the first pro who saw the code and hasn't been asked about.
   * `skip` leaves out a pro, like one the host keeps on the preferred list.
   */
  private askRotation(file: FixerFile, job: Job, opts: { open: boolean; skip?: (proId: string) => boolean }): { jobId: string; question: string } | undefined {
    const current = job.rotationAsked;
    const nameFor = (proId: string | undefined) => (proId && this.nameOf(file, job, proId)) || "The pro";
    if (current && !current.answer) return opts.open ? { jobId: job.id, question: rotationQuestion({ proName: nameFor(current.proId ?? job.booking?.proId) }) } : undefined;
    // An older record asked about the booked pro without naming them.
    const legacy = current?.proId ?? job.booking?.proId;
    const asked = job.rotationAskedFor ?? (current && legacy ? [legacy] : []);
    const fresh = shownTo(job).find((proId) => !asked.includes(proId) && !opts.skip?.(proId));
    if (!fresh) return undefined;
    job.rotationAsked = { at: this.deps.now().toISOString(), proId: fresh };
    job.rotationAskedFor = [...asked, fresh];
    return { jobId: job.id, question: rotationQuestion({ proName: nameFor(fresh) }) };
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

  /** Bookings waiting on the host: held by a gate, or with other pros' yes to choose from. */
  private heldList(file: FixerFile): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const job of file.jobs) {
      const held = this.heldRevised(file, job);
      if (held) out.push({ jobId: job.id, revised: held });
      const live = job.booking;
      if (live?.hostYes && liveBooking(job) && this.staysOver(file, live).length > 0) {
        out.push({ jobId: job.id, proId: live.proId, name: this.bookedName(file, job), from: live.from, until: new Date(this.endOf(live)).toISOString(), overlapsStay: true, next: STAY_OVER_NEXT });
      }
      if (!isOpen(job) || liveBooking(job)) continue;
      const booking = job.booking && !job.booking.hostYes ? job.booking : undefined;
      const others = job.contacts
        .filter((c) => !c.cancelled && c.outcome === "booked" && c.booked && c.to !== booking?.proId)
        .map((c) => ({ proId: c.to, name: this.nameOf(file, job, c.to) ?? "The pro", ...c.booked! }));
      if (!booking?.heldFor && others.length === 0) continue;
      out.push({
        jobId: job.id,
        ...(booking ? { proId: booking.proId, name: this.nameOf(file, job, booking.proId) ?? "The pro", from: booking.from, until: booking.until, ...(booking.estimateCents !== undefined ? { estimateCents: booking.estimateCents } : {}), ...(booking.heldFor ? { heldFor: booking.heldFor } : {}) } : {}),
        ...(others.length > 0 ? { others } : {}),
      });
    }
    return out;
  }

  /** Jobs whose door code was opened by a pro and then cancelled: the host is asked whether to change it. */
  private rotationList(file: FixerFile): Record<string, unknown>[] {
    return file.jobs
      .filter((job) => job.rotationAsked && !job.rotationAsked.answer && (job.rotationAsked.proId ?? job.booking))
      .map((job) => ({ jobId: job.id, question: rotationQuestion({ proName: this.nameOf(file, job, job.rotationAsked!.proId ?? job.booking!.proId) ?? "The pro" }) }));
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
      // Cleaner Core or Supply Core read the calendars when they run; otherwise (or while the stays are unknown) this check does.
      await this.refreshCalendars(input.googleEvents);
      const unread = this.staysUnknown();
      const windows: Record<string, VisitWindow[]> = {};
      for (const job of file.jobs) {
        if (isOpen(job) && job.hostGo && !liveBooking(job)) windows[job.id] = await this.windowsFor(job);
      }
      // A stay read since a visit was booked: the host hears of it once, and it is held below.
      const notes: HostNote[] = [];
      this.overlapPass(file, notes);
      const now = this.deps.now();
      const at = now.toISOString();
      const news: { jobId?: string; kind: string; at: string; text?: string; urgent?: true }[] = [];
      for (const item of file.news ?? []) {
        if (item.toldAt || !item.urgent) continue;
        news.push({ ...(item.jobId ? { jobId: item.jobId } : {}), kind: item.kind, at: item.at, text: item.text, urgent: true });
        item.toldAt = at;
      }
      for (const job of file.jobs) {
        for (const item of job.news) {
          if (item.toldAt) continue;
          news.push({ jobId: job.id, kind: item.kind, at: item.at, ...(item.text ? { text: item.text } : {}) });
          item.toldAt = at;
        }
      }
      for (const item of file.news ?? []) {
        if (item.toldAt) continue;
        news.push({ ...(item.jobId ? { jobId: item.jobId } : {}), kind: item.kind, at: item.at, text: item.text });
        item.toldAt = at;
      }
      // Told notes with no job are kept 30 days, then dropped.
      if (file.news) file.news = file.news.filter((item) => !item.toldAt || now.getTime() - Date.parse(item.toldAt) < NEWS_KEPT_MS);
      // The whole reply is built before the news is marked told and saved.
      const body = {
        needsGo: file.jobs.filter((job) => isOpen(job) && !job.hostGo && job.state === "requested").map((job) => ({ jobId: job.id, question: this.goQuestion(file, job) })),
        upkeepDue: this.upkeepDue(file),
        contactNext: this.contactNext(file),
        windows,
        ...(unread ? { windowsNext: STAYS_UNREAD } : {}),
        unconfirmed: swept.unconfirmed,
        followUps: swept.followUps,
        held: this.heldList(file),
        delays: this.delayList(file),
        preferredAsk: this.preferredList(file),
        rotationAsk: this.rotationList(file),
        news,
      };
      this.write(file);
      await this.tell(notes);
      return ok(body);
    });
  }

  /** The booked pro's or candidate's name. */
  private bookedName(file: FixerFile, job: Job): string {
    return (job.booking && this.nameOf(file, job, job.booking.proId)) ?? "The pro";
  }

  /** When the visit ends: the extension, else the booked end, in epoch ms. */
  private endOf(booking: Booking): number {
    return Date.parse(booking.extendedUntil ?? booking.until);
  }

  /** Adds one news item for the host and gives back the note to send once the record is saved. Never a code. */
  private news(job: Job, kind: string, text: string, id = `fixer:${job.id}:${kind}`): HostNote {
    job.news.push({ kind, at: this.deps.now().toISOString(), text });
    return { id, text };
  }

  /** Adds one note with no job's news to the record (check_fixes passes it on) and gives back the note to send once it is saved. */
  private fileNews(file: FixerFile, item: Omit<FileNews, "at" | "toldAt">, id: string): HostNote {
    (file.news ??= []).push({ ...item, at: this.deps.now().toISOString() });
    return { id, text: item.text };
  }

  /** Sends the host notes. A note that fails to go is still in check_fixes' news. */
  private async tell(notes: readonly HostNote[]): Promise<boolean> {
    let taken = notes.length > 0;
    for (const note of notes) {
      try {
        if ((await this.deps.notifyHost?.(note.id, note.text)) !== true) taken = false;
      } catch {
        // The news item stays untold, so check_fixes passes it on.
        taken = false;
      }
    }
    return taken;
  }

  /**
   * May the code go out for this visit now? Never while a stay read since the booking overlaps it. On
   * a day a stay checks out, the guests must have left: the host's guests_left for that date, or
   * Cleaner Core's clearance.
   */
  private async accessFor(file: FixerFile, job: Job): Promise<ReturnType<typeof accessCheck>> {
    const booking = job.booking;
    const ymd = booking ? localYmd(new Date(booking.from), this.timeZone()) : this.today();
    const checkoutDay = (this.hub().stays() ?? []).some((stay) => stay.checkout === ymd);
    let cleared = file.clearedYmd === ymd;
    if (checkoutDay && !cleared && this.deps.cleanings) cleared = (await this.deps.cleanings(ymd))?.cleared === true;
    const overlaps = booking ? this.staysOver(file, booking).length > 0 : false;
    return accessCheck({ job, pro: booking ? { reach: this.reachOfId(file, job, booking.proId) } : undefined, now: this.deps.now(), checkoutDay, cleared, overlapsStay: overlaps });
  }

  /** The saved stays that overlap this visit, with its extension and the check-in buffer. */
  private staysOver(file: FixerFile, booking: Booking): Stay[] {
    const span = { from: booking.from, until: new Date(this.endOf(booking)).toISOString() };
    const input = this.occupyInput(file);
    return (this.hub().stays() ?? []).filter((stay) => overlapsStay(span, [stay], input));
  }

  /** Each booked visit a stay now overlaps: one host note per visit and stay, bound to the visit. */
  private overlapPass(file: FixerFile, notes: HostNote[]): void {
    for (const job of file.jobs) {
      const booking = job.booking;
      if (!booking?.hostYes || !liveBooking(job)) continue;
      for (const stay of this.staysOver(file, booking)) {
        const key = `${stay.checkIn}|${stay.checkout}`;
        if (booking.stayNoted?.includes(key)) continue;
        (booking.stayNoted ??= []).push(key);
        const text = stayOverBookingNews({ proName: this.bookedName(file, job), from: booking.from, timeZone: this.timeZone() });
        notes.push(this.news(job, "stay-over-booking", text, `fixer:${job.id}:${visitTag(booking)}:stay-over-booking:${key}`));
      }
    }
  }

  /** Asks the hub for the code, for the pro's phone and this window. A refusal gives the host one note for the job, and nothing else. */
  private openCode(file: FixerFile, job: Job, window: { from: string; until: string }, notes: HostNote[]): { ok: true; code: string; lockLocation?: string } | { ok: false; reason: DoorRefusal } {
    const phone = this.reachOfId(file, job, job.booking!.proId).phone!;
    const grant = this.door().request({ person: phone, window, purpose: "repair" });
    if (grant.ok && /^\d{4,8}$/.test(grant.code)) return { ok: true, code: grant.code, ...(grant.lockLocation ? { lockLocation: grant.lockLocation } : {}) };
    if (!job.codeNoteAt) {
      job.codeNoteAt = this.deps.now().toISOString();
      notes.push(this.news(job, "code-refused", codeRefusedNote({ proName: this.bookedName(file, job) }), `fixer:${job.id}:${visitTag(job.booking)}:code-refused`));
    }
    return { ok: false, reason: grant.ok ? "sealed" : grant.reason };
  }

  /**
   * The visit page's "I'm at the door": the gate, then the hub. Each reveal is logged and told to the
   * host. Only the visit page calls this, never a tool; the code it returns goes on that page alone.
   * With `visitHash`, the page's link must still be this job's live one when the call runs.
   */
  revealCode(jobId: string, visitHash?: string): Promise<RevealResult> {
    return this.serial(async (): Promise<RevealResult> => {
      let file: FixerFile;
      try {
        file = this.read();
      } catch (error) {
        if (error instanceof DamagedRecord) return { ok: false, reason: "damaged" };
        throw error;
      }
      const job = this.jobOf(file, jobId);
      if (!job?.booking) return { ok: false, reason: "no-job" };
      if (visitHash !== undefined && this.liveVisit(file, visitHash)?.id !== job.id) return { ok: false, reason: "no-job" };
      if (!file.settings.activatedAt || file.offAt) return { ok: false, reason: "off" };
      const check = await this.accessFor(file, job);
      if (!check.ok) return check;
      const notes: HostNote[] = [];
      const opened = this.openCode(file, job, check.window, notes);
      if (opened.ok) {
        const at = this.deps.now().toISOString();
        const revealed = (job.booking.revealedAt ??= []);
        revealed.push(at);
        markShown(job);
        notes.push(this.news(job, "revealed", revealNews({ proName: this.bookedName(file, job), at, timeZone: this.timeZone() }), `fixer:${job.id}:${visitTag(job.booking)}:revealed:${revealed.length}`));
      }
      this.write(file);
      await this.tell(notes);
      return opened;
    });
  }

  /**
   * The pro's phone when they are on the text path: a saved pro who prefers text, said YES, and hasn't
   * stopped. A pro who holds another role here (the cleaner who is also the handyman) is reached by
   * the visit page only, so their texts stay with that role.
   */
  private textPathPhone(file: FixerFile, job: Job): string | undefined {
    const pro = file.pros.find((entry) => entry.id === job.booking?.proId && entry.status === "saved");
    const phone = pro?.reach.phone;
    const people = this.deps.people?.();
    const here = this.deps.propertyId;
    if (!pro?.prefersText || !phone || !people || !here || !this.deps.send) return undefined;
    if (holdsOtherRole(people, phone)) return undefined;
    return people.optedIn(phone) && !people.stopped(phone) ? phone : undefined;
  }

  /** The pro's phone when the code may go by text: on the text path, and texts can go out from this property now. */
  private async textPhone(file: FixerFile, job: Job): Promise<string | undefined> {
    const phone = this.textPathPhone(file, job);
    if (!phone) return undefined;
    try {
      return (await this.deps.textsAllowed?.()) === true ? phone : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The code text, at most once per job. The mark is saved before the hub is asked, so a restart
   * between the mark and the send never sends a second text: the host gets one note instead.
   */
  private async codeTextPass(file: FixerFile, job: Job, notes: HostNote[]): Promise<void> {
    const booking = job.booking!;
    const proName = this.bookedName(file, job);
    const at = this.deps.now().toISOString();
    if (job.codeTextAt) {
      if (!job.codeTextSent && !job.codeNoteAt) {
        job.codeNoteAt = at;
        notes.push(this.news(job, "code-text-unsure", codeTextUnsureNote({ proName }), `fixer:${job.id}:${visitTag(booking)}:code-text-unsure`));
      }
      return;
    }
    // A pro with a visit link uses the page for this visit, so the code never goes two ways.
    if (booking.access !== "code" || booking.visitToken) return;
    const phone = await this.textPhone(file, job);
    if (!phone) {
      // On the text path, but texts can't go out here (Fixer only, or the host isn't confirmed): one note, and visit_link opens.
      if (this.textPathPhone(file, job) && !job.codeNoteAt && (await this.accessFor(file, job)).ok) {
        job.codeNoteAt = at;
        notes.push(this.news(job, "code-text-off", codeTextOffNote({ proName }), `fixer:${job.id}:${visitTag(booking)}:code-text-off`));
      }
      return;
    }
    const check = await this.accessFor(file, job);
    if (!check.ok) return;
    job.codeTextAt = at;
    this.write(file);
    const opened = this.openCode(file, job, check.window, notes);
    if (!opened.ok) return;
    (booking.revealedAt ??= []).push(at);
    markShown(job);
    this.write(file);
    const street = streetOf(this.hub().property().address ?? "");
    let sent = false;
    try {
      sent = (await this.deps.send!(phone, codeText({ proName, street, code: opened.code, ...(opened.lockLocation ? { lockLocation: opened.lockLocation } : {}) }))) === true;
    } catch {
      // Whether it went is unknown, so it is never sent again.
    }
    if (sent) {
      job.codeTextSent = true;
      notes.push(this.news(job, "code-texted", codeTextNews({ proName, at, timeZone: this.timeZone() }), `fixer:${job.id}:${visitTag(booking)}:code-texted`));
    } else {
      job.codeNoteAt = at;
      notes.push(this.news(job, "code-text-unsure", codeTextUnsureNote({ proName }), `fixer:${job.id}:${visitTag(booking)}:code-text-unsure`));
    }
    this.write(file);
  }

  /** The next check-in when it comes within an hour of the visit's end. */
  private checkInNear(booking: Booking): string | undefined {
    const property = this.hub().property();
    const at = nextCheckIn(Date.parse(booking.from), this.hub().stays() ?? [], { timeZone: this.timeZone(), ...(property.checkInTime ? { checkInTime: property.checkInTime } : {}) });
    return at !== undefined && at - this.endOf(booking) <= HOUR_MS ? new Date(at).toISOString() : undefined;
  }

  /** The visit's end passed with no done: the host is told once per end (an extension gives a new end). */
  private delayPass(file: FixerFile, job: Job, notes: HostNote[]): void {
    const booking = job.booking!;
    const end = this.endOf(booking);
    if (this.deps.now().getTime() < end) return;
    if (job.news.some((item) => (item.kind === "visit-over" || item.kind === "late-check-in") && Date.parse(item.at) >= end)) return;
    const proName = this.bookedName(file, job);
    const until = new Date(end).toISOString();
    const checkIn = this.checkInNear(booking);
    const timeZone = this.timeZone();
    notes.push(
      checkIn
        ? this.news(job, "late-check-in", lateBeforeCheckInNews({ proName, until, checkIn, timeZone }), `fixer:${job.id}:late-check-in:${end}`)
        : this.news(job, "visit-over", visitOverNews({ proName, until, timeZone }), `fixer:${job.id}:visit-over:${end}`),
    );
  }

  /**
   * The clock pass: the host hears of a stay now over a booked visit, a booked visit goes in progress
   * at its start, the code text goes out once, the host hears of a visit that ended with no done, and
   * a done or cancelled job's photos go 30 days after.
   */
  tick(): Promise<void> {
    return this.serial(async () => {
      let file: FixerFile;
      try {
        file = this.read();
      } catch (error) {
        if (error instanceof DamagedRecord) return;
        throw error;
      }
      if (!file.settings.activatedAt) return;
      const before = JSON.stringify(file);
      const notes: HostNote[] = [];
      const now = this.deps.now().getTime();
      // A stay read since a visit was booked (by any flow): the host hears of it before the code would go.
      if (!file.offAt) this.overlapPass(file, notes);
      for (const job of file.jobs) {
        const booking = job.booking;
        if (!booking?.hostYes || !liveBooking(job)) continue;
        if (job.state === "booked" && now >= Date.parse(booking.from)) job.state = "in-progress";
        if (!file.offAt) await this.codeTextPass(file, job, notes);
        this.delayPass(file, job, notes);
      }
      // A done job's photos go 30 days after done, a cancelled job's 30 days after the cancel.
      prunePhotos(this.root, file.jobs.flatMap((job) => {
        const closedAt = job.done?.at ?? (job.state === "cancelled" ? job.cancelledAt : undefined);
        return closedAt ? [{ id: `fixer:${job.id}`, doneAt: closedAt }] : [];
      }), this.deps.now());
      if (JSON.stringify(file) !== before) this.write(file);
      await this.tell(notes);
    });
  }

  /** The host says the guests have left: today counts as cleared for every job's checkout-day check, even one opened later today. */
  guestsLeft(input: { confirmed?: true }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const off = this.inactive(file);
      if (off) return off;
      if (input.confirmed !== true) return fail("Ask the host whether the guests have left, then call again with confirmed: true.");
      const today = this.today();
      file.clearedYmd = today;
      this.write(file);
      return ok({ cleared: today, next: "A repair visit today can get the door code now." });
    });
  }

  /** What the host expects to pay: a raised price they approved or only needed to hear of, else the estimate. */
  private expectedCents(file: FixerFile, job: Job): number | undefined {
    const booking = job.booking;
    const revised = booking?.revisedQuote;
    if (revised && (revised.hostYes || !raisedPriceHeld(file.settings.costLineCents, booking.estimateCents, revised.cents))) return revised.cents;
    return booking?.estimateCents;
  }

  /** Logs the amount. Over the cost line, or more than 20% over what was expected, the host is told once. */
  private logCost(file: FixerFile, job: Job, cents: number, by: "pro" | "agent" | "host", note: string | undefined, notes: HostNote[]): void {
    job.cost = { cents, by, at: this.deps.now().toISOString(), ...(note ? { note } : {}) };
    const line = file.settings.costLineCents;
    const estimateCents = this.expectedCents(file, job);
    if (job.news.some((item) => item.kind === "cost-over") || !costNews(line, estimateCents, cents)) return;
    notes.push(this.news(job, "cost-over", costNewsText({ proName: this.bookedName(file, job), cents, ...(estimateCents !== undefined ? { estimateCents } : {}), ...(line !== undefined ? { costLineCents: line } : {}) })));
  }

  /** A live job becomes done. The questions after the visit start here: the preferred list first. */
  protected finishJob(file: FixerFile, job: Job, by: NonNullable<Job["done"]>["by"], note: string | undefined, notes: HostNote[]): void {
    const at = this.deps.now().toISOString();
    job.state = "done";
    job.done = { at, by, ...(note ? { note } : {}) };
    const pro = file.pros.find((entry) => entry.id === job.booking?.proId && entry.status === "saved");
    if (pro) pro.lastJobAt = at;
    const item = job.source === "upkeep" ? file.upkeep.find((entry) => entry.id === job.sourceRef) : undefined;
    if (item) item.lastDoneAt = at;
    if (!pro?.preferredFor.some((entry) => entry.trade === job.trade)) job.preferredAsked = { at };
    if (!job.photos.some((photo) => photo.from === "pro")) notes.push(this.news(job, "no-photos", noPhotosNews({ proName: this.bookedName(file, job) })));
  }

  /** The agent's or host's word that the pro finished, with the amount when known. */
  recordDone(input: { jobId?: string; note?: string; by?: "agent" | "host"; cents?: number }): Promise<FixerReply> {
    return this.guarded(input, async () => {
      const file = this.read();
      const off = this.inactive(file);
      if (off) return off;
      const job = this.jobOf(file, input.jobId);
      if (!job) return fail(NO_JOB);
      if (!job.booking?.hostYes || !liveBooking(job)) return fail("Only a booked visit can be marked done.");
      if (input.by !== undefined && input.by !== "agent" && input.by !== "host") return fail("Done is from the agent or the host.");
      if (input.note !== undefined && !isText(input.note, 300)) return fail("Keep the note under 300 characters.");
      if (input.cents !== undefined && !isInt(input.cents, 0, 2_000_000)) return fail("An amount is 0 to 2,000,000 cents.");
      const by = input.by ?? "agent";
      const notes: HostNote[] = [];
      this.finishJob(file, job, by, input.note ? redactDigits(input.note).trim() : undefined, notes);
      if (input.cents !== undefined) this.logCost(file, job, input.cents, by, undefined, notes);
      this.write(file);
      this.syncPros(file);
      await this.tell(notes);
      const preferredAsk = this.preferredList(file).filter((ask) => ask.jobId === job.id);
      return ok({ done: true, jobId: job.id, ...(preferredAsk.length > 0 ? { preferredAsk } : {}) });
    });
  }

  /** The amount charged, from the pro, the agent or the host. There's no payment step. */
  recordCost(input: { jobId?: string; cents?: number; by?: "pro" | "agent" | "host"; note?: string }): Promise<FixerReply> {
    return this.guarded(input, async () => {
      const file = this.read();
      const off = this.inactive(file);
      if (off) return off;
      const job = this.jobOf(file, input.jobId);
      if (!job) return fail(NO_JOB);
      if (!job.booking?.hostYes || !(liveBooking(job) || job.state === "done")) return fail("A cost goes on a booked or finished job.");
      if (!isInt(input.cents, 0, 2_000_000)) return fail("An amount is 0 to 2,000,000 cents.");
      if (!COST_BYS.includes(input.by as never)) return fail("Say who gave the amount: pro, agent or host.");
      if (input.note !== undefined && !isText(input.note, 300)) return fail("Keep the note under 300 characters.");
      const notes: HostNote[] = [];
      this.logCost(file, job, input.cents, input.by!, input.note ? redactDigits(input.note).trim() : undefined, notes);
      this.write(file);
      await this.tell(notes);
      return ok({ logged: true, jobId: job.id, cents: input.cents });
    });
  }

  /** A raised price the host must say yes to, as approve_booking's revised question, or undefined. */
  private heldRevised(file: FixerFile, job: Job): { cents: number; question: string } | undefined {
    const booking = job.booking;
    const revised = booking?.revisedQuote;
    if (!booking || !liveBooking(job) || !revised || revised.hostYes || !raisedPriceHeld(file.settings.costLineCents, booking.estimateCents, revised.cents)) return undefined;
    return { cents: revised.cents, question: raisedPrice({ proName: this.bookedName(file, job), newCents: revised.cents, ...(booking.estimateCents !== undefined ? { oldCents: booking.estimateCents } : {}) }) };
  }

  /**
   * The pro says the work costs more than the estimate. Over the cost line or 20% it waits for the host's yes; otherwise it's news.
   * From the visit page, `visitHash` must still be this job's live link, inside the visit.
   */
  raisePrice(jobId: string, cents: number, by: "pro" | "agent" | "host", visitHash?: string): Promise<FixerReply> {
    return this.guarded({ jobId, cents, by }, () => this.raisePriceUnlocked(jobId, cents, by, visitHash));
  }

  private async raisePriceUnlocked(jobId: string, cents: number, by: "pro" | "agent" | "host", visitHash?: string): Promise<FixerReply> {
    const file = this.read();
    const off = this.inactive(file);
    if (off) return off;
    if (visitHash !== undefined) {
      const page = this.pageJob(file, visitHash);
      if ("isError" in page) return page;
      if (page.id !== jobId) return fail(VISIT_ENDED);
    }
    const job = this.jobOf(file, jobId);
    const booking = job?.booking;
    if (!job || !booking?.hostYes || !liveBooking(job)) return fail("Only a booked visit can have a raised price.");
    if (!isInt(cents, 0, 2_000_000)) return fail("A price is 0 to 2,000,000 cents.");
    if (!COST_BYS.includes(by)) return fail("Say who raised it: pro, agent or host.");
    const old = booking.estimateCents;
    if (old !== undefined && cents <= old) return fail(`That isn't more than the ${dollars(old)} estimate. Log what was charged with record_cost when the work is done.`);
    const at = this.deps.now().toISOString();
    booking.revisedQuote = { cents, at, by };
    const proName = this.bookedName(file, job);
    const prices = { proName, newCents: cents, ...(old !== undefined ? { oldCents: old } : {}) };
    if (raisedPriceHeld(file.settings.costLineCents, old, cents)) {
      const question = raisedPrice(prices);
      const note = this.fileNews(file, { kind: "raised-price-held", text: question, jobId: job.id }, `fixer:${job.id}:raised:${at}`);
      this.write(file);
      await this.tell([note]);
      return ok({ held: true, jobId: job.id, question, next: `Tell ${proName} to wait for the host's answer. Ask the host this question, then call approve_booking with revised: true.` });
    }
    const note = this.news(job, "raised-price", raisedPriceNews(prices), `fixer:${job.id}:raised:${at}`);
    this.write(file);
    await this.tell([note]);
    return ok({ held: false, jobId: job.id, next: `${proName} can go ahead. The host is told.` });
  }

  /** More time for a visit (two calls, bound to the job and the new end), never into the next check-in's buffer. The visit link changes. */
  extendVisit(input: { jobId?: string; until?: string; confirmation?: string }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const off = this.inactive(file);
      if (off) return off;
      const job = this.jobOf(file, input.jobId);
      const booking = job?.booking;
      if (!job || !booking?.hostYes || !liveBooking(job)) return fail("Only a booked visit can be given more time.");
      if (typeof input.until !== "string" || Number.isNaN(Date.parse(input.until))) return fail("Say until when, as a date and time.");
      const until = new Date(input.until).toISOString();
      if (Date.parse(until) <= Math.max(this.endOf(booking), this.deps.now().getTime())) return fail("That isn't later than the visit's end now.");
      if (overlapsStay({ from: booking.from, until }, this.hub().stays() ?? [], this.occupyInput(file))) {
        return fail(`That runs into the next check-in, or the ${file.settings.checkInBufferMinutes} minutes kept free before it. Pick an earlier time.`);
      }
      const proName = this.bookedName(file, job);
      const gate = this.confirm("fixer-extend", job.id, tokenHash(JSON.stringify([booking.fingerprint, until])), input.confirmation, extendQuestion({ proName, until, timeZone: this.timeZone() }));
      if (gate !== "go") return gate;
      booking.extendedUntil = until;
      // The old visit link ends, a revoked one too; visit_link gives a new one.
      delete booking.visitToken;
      delete booking.visitRevokedAt;
      this.write(file);
      return ok({ extended: true, jobId: job.id, until, tellPro: { name: proName, reach: this.reachOfId(file, job, booking.proId) }, next: `Tell ${proName} the new end. If they use the visit page, their old link has ended: call visit_link for a new one.` });
    });
  }

  /**
   * The host's answer to the preferred question. If the code was shown or texted and the pro still
   * isn't preferred for the trade, the rotation question comes next (Decision 6).
   */
  private answerPreferred(file: FixerFile, job: Job, answer: "yes" | "no", pro?: Pro): { jobId: string; question: string } | undefined {
    const at = this.deps.now().toISOString();
    job.preferredAsked = { at: job.preferredAsked?.at ?? at, answer };
    // A pro the host keeps on the preferred list gets no rotation question. A candidate the job booked
    // and the host just saved has a new pro id, so the booking's id counts as that pro too.
    const preferred = (proId: string) => {
      const saved = proId === pro?.id || (pro && proId === job.booking?.proId) ? pro : file.pros.find((entry) => entry.id === proId);
      return saved?.status === "saved" && saved.preferredFor.some((entry) => entry.trade === job.trade);
    };
    return this.askRotation(file, job, { open: false, skip: preferred });
  }

  /** Done jobs whose pro isn't preferred for the trade, waiting on the host's answer. */
  private preferredList(file: FixerFile): { jobId: string; question: string }[] {
    return file.jobs
      .filter((job) => job.state === "done" && job.preferredAsked && !job.preferredAsked.answer)
      .map((job) => ({ jobId: job.id, question: preferredQuestion({ proName: this.bookedName(file, job), trade: job.trade }) }));
  }

  /** Live visits past their end with no done. */
  private delayList(file: FixerFile): Record<string, unknown>[] {
    const now = this.deps.now().getTime();
    return file.jobs
      .filter((job) => job.booking?.hostYes && liveBooking(job) && now >= this.endOf(job.booking))
      .map((job) => {
        const booking = job.booking!;
        const checkIn = this.checkInNear(booking);
        return {
          jobId: job.id,
          proId: booking.proId,
          name: this.bookedName(file, job),
          endedAt: new Date(this.endOf(booking)).toISOString(),
          ...(checkIn ? { checkInAt: checkIn } : {}),
          next: "Ask the host: is it done (record_done), does the pro need more time (extend_visit), a new time, or a cancel?",
        };
      });
  }

  /** The host says no to the preferred question or the rotation question. */
  skipQuestion(input: { jobId?: string; question?: "preferred" | "rotate" }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const off = this.inactive(file);
      if (off) return off;
      const job = this.jobOf(file, input.jobId);
      if (!job) return fail(NO_JOB);
      if (input.question === "preferred") {
        if (!job.preferredAsked || job.preferredAsked.answer) return fail("That question isn't open for this job.");
        const pro = file.pros.find((entry) => entry.id === job.booking?.proId);
        const rotationAsk = this.answerPreferred(file, job, "no", pro);
        this.write(file);
        return ok({ skipped: "preferred", jobId: job.id, ...(rotationAsk ? { rotationAsk: [rotationAsk] } : {}) });
      }
      if (input.question === "rotate") {
        if (!job.rotationAsked || job.rotationAsked.answer) return fail("That question isn't open for this job.");
        job.rotationAsked.answer = "no";
        this.write(file);
        return ok({ skipped: "rotate", jobId: job.id });
      }
      return fail("Say which question: preferred or rotate.");
    });
  }

  /** The host's yes to changing the code: the hub's one-time upload link, for the host alone. The new code is never in chat. */
  changeDoorCode(input: { jobId?: string }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const off = this.inactive(file);
      if (off) return off;
      const job = this.jobOf(file, input.jobId);
      if (!job) return fail(NO_JOB);
      if (!job.rotationAsked) return fail("Changing the code is asked after a visit where the pro got it.");
      const link = this.door().issueUpload(undefined, undefined, this.deps.publicBase?.());
      if (!link.ok) return fail(link.error);
      job.rotationAsked.answer = "yes";
      this.write(file);
      return ok({ uploadUrl: link.uploadUrl, expiresInMinutes: link.expiresInMinutes, next: CODE_CHANGE_NEXT });
    });
  }

  /**
   * A new door code was saved through the property's upload link. The pros who saw the old one need
   * no question about it any more: an open rotation question is settled as changed, a "yes" waiting
   * for the new code is marked done, and those pros aren't asked about the old code again.
   */
  doorCodeChanged(): Promise<void> {
    return this.serial(async () => {
      const file = this.read();
      const at = this.deps.now().toISOString();
      let changed = false;
      for (const job of file.jobs) {
        const asked = job.rotationAsked;
        if (asked && !asked.changedAt && asked.answer !== "no") {
          job.rotationAsked = { ...asked, answer: "yes", changedAt: at };
          changed = true;
        }
        const before = job.rotationAskedFor ?? [];
        const all = [...new Set([...before, ...shownTo(job)])];
        if (all.length > before.length) {
          job.rotationAskedFor = all;
          changed = true;
        }
      }
      if (changed) this.write(file);
    });
  }

  /** Links to the job's photos, each good for an hour. */
  jobPhotos(jobId: string): Promise<FixerReply> {
    return this.guarded({ jobId }, () => {
      const file = this.read();
      const job = this.jobOf(file, jobId);
      if (!job) return fail(NO_JOB);
      const base = this.deps.publicBase?.();
      const key = this.deps.photoKey?.();
      if (!base || !key) return fail("Photo links need the server's public address and photo key.");
      return ok({ jobId: job.id, photos: photoLinks(this.root, `fixer:${job.id}`, base, key, this.deps.now()) });
    });
  }

  /** The visit page link for a booked job, after the host's yes. Given once: only its hash is kept. */
  visitLink(input: { jobId?: string }): Promise<FixerReply> {
    return this.guarded(input, async () => {
      const file = this.read();
      const off = this.inactive(file);
      if (off) return off;
      const job = this.jobOf(file, input.jobId);
      if (!job) return fail(NO_JOB);
      const booking = job.booking;
      if (!booking?.hostYes || !liveBooking(job)) return fail("A visit link is only for a booked visit, after the host's yes.");
      if (this.deps.now().getTime() >= this.endOf(booking)) return fail("That visit has already ended.");
      if (booking.visitRevokedAt) return fail(VISIT_REVOKED);
      if (booking.visitToken) return fail("The visit link was already given, and it is shown only once. A new time or more time for the visit gives a new one.");
      // Access follows how the pro talks: a pro on the code text path has no page, unless that text failed.
      if ((await this.textPhone(file, job)) && !job.codeNoteAt) return fail(visitTextPath({ proName: this.bookedName(file, job) }));
      const base = this.deps.publicBase?.()?.replace(/\/+$/, "");
      if (!base) return fail("The visit link needs the server's public address.");
      const token = letterToken();
      booking.visitToken = tokenHash(token);
      this.write(file);
      return ok({ jobId: job.id, url: `${base}${FIXER_VISIT_PREFIX}${token}`, next: VISIT_LINK_NEXT });
    });
  }

  /** Ends a visit link on the host's word. It stays ended: only a rebook or an extend gives a new one. */
  revokeVisit(input: { jobId?: string }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const job = this.jobOf(file, input.jobId);
      if (!job) return fail(NO_JOB);
      if (!job.booking?.visitToken) return fail("That job has no visit link to end.");
      delete job.booking.visitToken;
      job.booking.visitRevokedAt = this.deps.now().toISOString();
      this.write(file);
      return ok({ revoked: true, jobId: job.id, next: "The link has ended. Tell the host the pro needs another way in, or a new time." });
    });
  }

  /** The record for the visit page, or undefined when it can't be read: the page answers that as ended. */
  private readForPage(): FixerFile | undefined {
    try {
      return this.read();
    } catch (error) {
      if (error instanceof DamagedRecord) return undefined;
      throw error;
    }
  }

  /** The job holding this visit token hash, in any state. Compared in constant time. */
  private jobByVisitHash(file: FixerFile, hash: string): Job | undefined {
    return file.jobs.find((job) => job.booking?.visitToken !== undefined && sameHash(job.booking.visitToken, hash));
  }

  /** The job a visit link opens: booked with the host's yes, not done or cancelled, up to 24 hours after its end. */
  private liveVisit(file: FixerFile, hash: string): Job | undefined {
    const job = this.jobByVisitHash(file, hash);
    const booking = job?.booking;
    if (!job || !booking?.hostYes || !liveBooking(job)) return undefined;
    return this.deps.now().getTime() < this.endOf(booking) + PAGE_AFTER_MS ? job : undefined;
  }

  /** A page action's job: the live visit, from 30 minutes before it. Else the page's refusal; `ended` marks a 404. */
  private pageJob(file: FixerFile, hash: string): Job | FixerReply {
    const job = this.liveVisit(file, hash);
    if (!job) return { text: VISIT_ENDED, structured: { ended: true }, isError: true };
    if (this.deps.now().getTime() < Date.parse(job.booking!.from) - DOOR_LEAD_MS) return fail(VISIT_NOT_STARTED);
    return job;
  }

  /**
   * Counts one request to a visit link: 30 an hour per link (a fixed window from its first request),
   * then "limited". A token no job holds isn't counted, so made-up tokens can't fill the memory.
   */
  visitHit(token: string): "unknown" | "ok" | "limited" {
    if (!VISIT_TOKEN.test(token)) return "unknown";
    const hash = tokenHash(token);
    const now = this.deps.now().getTime();
    for (const [key, entry] of this.visitHits) if (now - entry.start >= HOUR_MS || now < entry.start) this.visitHits.delete(key);
    for (const [key, end] of this.liveLinks) if (now >= end) this.liveLinks.delete(key);
    let entry = this.visitHits.get(hash);
    if (!entry) {
      // A link already found live needs no read until it ends; any other is looked up, and remembered when live.
      if (!this.liveLinks.has(hash)) {
        const file = this.readForPage();
        if (!file || !this.jobByVisitHash(file, hash)) return "unknown";
        const live = this.liveVisit(file, hash);
        if (live) this.liveLinks.set(hash, this.endOf(live.booking!) + PAGE_AFTER_MS);
      }
      entry = { start: now, count: 0 };
      this.visitHits.set(hash, entry);
    }
    entry.count += 1;
    return entry.count > VISIT_HITS_PER_HOUR ? "limited" : "ok";
  }

  /**
   * True when counting this token would read fixer.json: it is well formed, not a link already found
   * live (kept until the link ends), and not counted in its current hour. The route limits these lookups.
   */
  visitNeedsLookup(token: string): boolean {
    if (!VISIT_TOKEN.test(token)) return false;
    const hash = tokenHash(token);
    const now = this.deps.now().getTime();
    const end = this.liveLinks.get(hash);
    if (end !== undefined && now < end) return false;
    const entry = this.visitHits.get(hash);
    return !entry || now - entry.start >= HOUR_MS || now < entry.start;
  }

  /** The live visit a page token opens, as the page shows it, or undefined (unknown, revoked, done, cancelled or ended). */
  visitByToken(token: string): VisitView | undefined {
    if (!VISIT_TOKEN.test(token)) return undefined;
    const file = this.readForPage();
    const job = file ? this.liveVisit(file, tokenHash(token)) : undefined;
    const booking = job?.booking;
    if (!file || !job || !booking) return undefined;
    const now = this.deps.now().getTime();
    const from = Date.parse(booking.from);
    const address = this.hub().property().address;
    const raised = booking.revisedQuote;
    return {
      jobId: job.id,
      proName: this.bookedName(file, job),
      what: job.what,
      from: booking.from,
      until: new Date(this.endOf(booking)).toISOString(),
      timeZone: this.timeZone(),
      access: booking.access,
      phase: now < from - DOOR_LEAD_MS ? "before" : now < this.endOf(booking) ? "during" : "after",
      ...(address && now >= from - ADDRESS_LEAD_MS ? { address } : {}),
      ...(booking.estimateCents !== undefined ? { estimateCents: booking.estimateCents } : {}),
      ...(raised ? { raised: { cents: raised.cents, waiting: !raised.hostYes && raisedPriceHeld(file.settings.costLineCents, booking.estimateCents, raised.cents) } } : {}),
      photos: job.photos.filter((photo) => photo.from === "pro").length,
    };
  }

  /** The pro's done from the visit page, with the amount when given. The page checked the input's shape. */
  pageDone(token: string, input: { cents?: number; note?: string }): Promise<FixerReply> {
    return this.guarded(input, async () => {
      const file = this.read();
      if (this.inactive(file)) return fail(VISIT_PAGE_OFF);
      const job = this.pageJob(file, tokenHash(token));
      if ("isError" in job) return job;
      if (input.cents !== undefined && !isInt(input.cents, 0, 2_000_000)) return fail("An amount is $0 to $20,000.");
      if (input.note !== undefined && !isText(input.note, 300)) return fail("Keep the note under 300 characters.");
      const notes: HostNote[] = [];
      this.finishJob(file, job, "pro-page", input.note ? redactDigits(input.note).trim() : undefined, notes);
      if (input.cents !== undefined) this.logCost(file, job, input.cents, "pro", undefined, notes);
      this.write(file);
      this.syncPros(file);
      await this.tell(notes);
      return ok({ done: true, jobId: job.id });
    });
  }

  /**
   * A text from a pro on the shared line. STOP, START, YES and an injury report come first. DONE finishes their own
   * visit (with any photos), a price raises their own job's price, and anything else is news for the host with digit
   * runs removed. It never approves, books or changes anything else, and nothing it sends names another property.
   */
  async proInbound(input: { id: string; from: string; text: string; media?: readonly InboundMedia[] }): Promise<void> {
    let who = "A pro";
    const id = input.id || newId("msg_", 10);
    await this.serial(async () => {
      const people = this.deps.people?.();
      const here = this.deps.propertyId;
      if (!people || !here || !input.from) return;
      if (!people.rolesOn(input.from, here).includes("pro") || holdsOtherRole(people, input.from)) return;
      const text = input.text.trim();
      const injury = isInjuryReport(text);
      let read: FixerFile | undefined;
      try {
        read = this.read();
      } catch (error) {
        // An injury is still answered when the record can't be read.
        if (!(error instanceof DamagedRecord) || !injury) throw error;
      }
      if (read) {
        // A replayed webhook is ignored: the last 200 handled ids are kept.
        if (read.seenInbound?.includes(id)) return;
        read.seenInbound = [...(read.seenInbound ?? []), id].slice(-200);
        this.write(read);
      }
      const pro = read?.pros.find((entry) => entry.status === "saved" && entry.reach.phone === input.from);
      const proName = pro?.name ?? "A pro";
      who = proName;
      if (injury) return this.injury(read, input.from, proName, id);
      const file = read!;
      const keyword = keywordOf(text);
      if (keyword === "stop" || isPlainLanguageStop(text)) return people.relay(people.stop(input.from));
      if (keyword === "help") return;
      if (keyword === "start") return people.relay(people.start(input.from));
      if (isYes(text)) return people.relay(people.optIn(input.from, here));
      const now = this.deps.now().getTime();
      const mine = pro && !this.inactive(file) ? file.jobs.filter((job) => job.booking?.proId === pro.id && job.booking.hostYes && liveBooking(job)) : [];
      const started = mine.filter((job) => job.state === "in-progress" || (job.state === "booked" && now >= Date.parse(job.booking!.from)));
      const live = mine.find((job) => job.state === "in-progress");
      const target = live ?? started[0];
      // Photos on any text from a pro at a visit that has started are kept for that job.
      if (target && input.media && input.media.length > 0) {
        await this.photosFromText(target, input.media);
        this.write(file);
      }
      // DONE and a price count only from a pro who said YES and has not stopped.
      const agreed = people.optedIn(input.from) && !people.stopped(input.from);
      if (isDone(text) && started.length > 0 && agreed) {
        const notes: HostNote[] = [];
        this.finishJob(file, target!, "pro-text", undefined, notes);
        this.write(file);
        await this.tell(notes);
        if ((await this.deps.textsAllowed?.()) === true) await this.deps.send?.(input.from, PRO_DONE_ACK).catch(() => undefined);
        return;
      }
      const cents = priceCents(text);
      if (cents !== undefined && live && agreed && cents <= 2_000_000) {
        const reply = await this.raisePriceNow(live.id, cents);
        if (!reply.isError) return;
      }
      if (!text) return;
      const news = proTextNews({ proName, text: redactDigits(text).slice(0, 300).trim() });
      if (target) {
        const fresh = this.read();
        const job = fresh.jobs.find((entry) => entry.id === target.id);
        if (job) {
          const note = this.news(job, "pro-text", news, `fixer:${job.id}:pro-text:${id}`);
          this.write(fresh);
          await this.tell([note]);
          return;
        }
      }
      // No visit to hang it on: kept for check_fixes, as on a Fixer-only property no note reaches the host by itself.
      const fresh = this.read();
      const note = this.fileNews(fresh, { kind: "pro-text", text: news }, `fixer:pro-text:${id}`);
      this.write(fresh);
      await this.tell([note]);
    }).catch(() => this.tell([{ id: `fixer:pro-text-failed:${id}`, text: proTextFailed({ proName: who }) }]));
  }

  /**
   * A pro's text that someone is hurt: the host's note is kept for check_fixes first (urgent) and sent,
   * then the pro is told to call 911, with "I've let the host know" only when the note was kept or sent.
   */
  private async injury(file: FixerFile | undefined, from: string, proName: string, id: string): Promise<void> {
    const text = proHurtNews({ proName, street: streetOf(this.hub().property().address ?? "") });
    const note = { id: `fixer:pro-hurt:${id}`, text };
    let kept = false;
    if (file) {
      try {
        this.fileNews(file, { kind: "pro-hurt", text, urgent: true }, note.id);
        this.write(file);
        kept = true;
      } catch {
        // The note is still sent below.
      }
    }
    // A kept note lets the 911 line go first; otherwise the reply waits to know whether the host was reached.
    const sent = kept ? undefined : await this.tell([note]);
    try {
      await this.deps.send?.(from, kept || sent ? PRO_HURT : PRO_HURT_CALL);
    } catch {
      // The host's note still goes.
    }
    if (kept) await this.tell([note]);
  }

  /** raisePrice for a text, already inside the desk's one-at-a-time turn. */
  private raisePriceNow(jobId: string, cents: number): Promise<FixerReply> {
    return this.raisePriceUnlocked(jobId, cents, "pro");
  }

  /** The photos on a DONE text, kept as the job's pro photos while there is room (10 of theirs). */
  private async photosFromText(job: Job, media: readonly InboundMedia[] | undefined): Promise<void> {
    if (!media || media.length === 0) return;
    const photos = await downloadPhotos(media, cleanerPhotoFetch(), this.deps.env?.() ?? process.env);
    const key = `fixer:${job.id}`;
    for (const photo of photos) {
      if (job.photos.filter((entry) => entry.from === "pro").length >= MAX_JOB_PHOTOS) break;
      if (!storePhoto(this.root, key, photo, 2 * MAX_JOB_PHOTOS)) break;
      job.photos.push({ id: String(photoCount(this.root, key)), from: "pro", at: this.deps.now().toISOString() });
    }
  }

  /** One photo from the visit page, already stripped of its location data, kept as the job's next number. */
  pagePhoto(token: string, photo: { bytes: Buffer; ext: string }): Promise<FixerReply> {
    return this.guarded({}, () => {
      const file = this.read();
      if (this.inactive(file)) return fail(VISIT_PAGE_OFF);
      const job = this.pageJob(file, tokenHash(token));
      if ("isError" in job) return job;
      const key = `fixer:${job.id}`;
      // Only the pro's own photos count toward their 10; the cleaner's report may hold 10 more.
      const full = `This visit already has ${MAX_JOB_PHOTOS} photos.`;
      if (job.photos.filter((entry) => entry.from === "pro").length >= MAX_JOB_PHOTOS) return fail(full);
      if (!storePhoto(this.root, key, photo, 2 * MAX_JOB_PHOTOS)) return fail(full);
      job.photos.push({ id: String(photoCount(this.root, key)), from: "pro", at: this.deps.now().toISOString() });
      this.write(file);
      return ok({ saved: true, photos: job.photos.filter((entry) => entry.from === "pro").length });
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

  /**
   * Turned off: no new work. The pros still being contacted (no answer yet, waiting, or a time not yet
   * booked) are listed to tell, and their contacts close, unless `frozen` (an admin's forced off leaves
   * everything as it was). With `cancel`, every job still going is cancelled too, and the pros with a
   * live booking are listed to tell.
   */
  turnOff(cancel: boolean, frozen = false): Promise<FixerReply> {
    return this.guarded({}, () => {
      const file = this.read();
      file.offAt = this.deps.now().toISOString();
      const tellPro: { name: string; reach: ProReach }[] = [];
      const told = new Set<string>();
      const tell = (job: Job, proId: string) => {
        if (told.has(proId)) return;
        told.add(proId);
        tellPro.push({ name: this.nameOf(file, job, proId) ?? "The pro", reach: this.reachOfId(file, job, proId) });
      };
      const rotationAsk: { jobId: string; question: string }[] = [];
      for (const job of file.jobs.filter(isOpen)) {
        const booked = job.booking?.hostYes && liveBooking(job) ? job.booking.proId : undefined;
        const pending = frozen ? [] : job.contacts.filter((c) => !c.cancelled && c.to !== booked && (c.outcome === undefined || c.outcome === "waiting" || c.outcome === "booked"));
        if (cancel) {
          const done = this.cancelCore(file, job, "Repairs turned off");
          if (done.tellPro && booked) tell(job, booked);
          if (done.rotationAsk) rotationAsk.push(done.rotationAsk);
        }
        for (const contact of pending) {
          contact.cancelled = true;
          tell(job, contact.to);
        }
        // A time a pro offered that waits on the host goes with their contact.
        if (!frozen && job.booking && !job.booking.hostYes) delete job.booking;
      }
      this.write(file);
      this.syncPros(file);
      return ok({ off: true, ...(cancel ? { tellPro, rotationAsk } : tellPro.length > 0 ? { tellPro } : {}) });
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
