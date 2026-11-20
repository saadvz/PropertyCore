import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { GrokRoutineWebhookSink, repairsUpdateEvent, testEvent } from "../alerts/operatorEvents";
import { routineValuesRefused } from "../alerts/routineCheck";
import type { CleanerAssistant } from "../cleaner-core/assistant";
import { currentCaller, withCaller } from "../cleaner-core/callerContext";
import { OperatorEventOutbox } from "../alerts/outbox";
import { FileRuntimeStore } from "../storage/runtimeStore";
import { localDateOf } from "../core/timezone";
import { isDone, isYes } from "../cleaner-core/core";
import { isInjuryReport } from "../cleaner-core/injury";
import { cleanerPhotoFetch, copyPhotos, downloadPhotos, MAX_JOB_PHOTOS, messagePhotoId, photoCount, photoLinks, prunePhotos, storePhoto, type InboundMedia } from "../cleaner-core/photos";
import { isPlainLanguageStop, keywordOf } from "../intent";
import { askNext } from "../hub/ask";
import { addCalendarDays, zonedInstant } from "../hub/calendar";
import { joinSplitDigits } from "../hub/digits";
import type { GoogleEventList } from "../hub/sources";
import { refuseCards } from "../hub/cards";
import type { AccessRefusal as DoorRefusal, DoorAccess, WantedCode } from "../hub/doorAccess";
import { hubFor, propertyDetailsProblem, type Hub } from "../hub/hub";
import type { Stay } from "../hub/store";
import type { People } from "../hub/people";
import { sameHash, uploadHash } from "../hub/uploadCode";
import { ConfirmationBook } from "../operator/confirmations";
import { nextDates, scheduleProblem, type Schedule } from "../supply-core/schedule";
import { supplyAskOn } from "../supply-core/store";
import { accessCheck, type AccessRefusal, bookingFingerprint, bookingHolds, type BookingHold, contactAllowed, costNews, defaultAccess, liveBooking, raisedPriceHeld } from "./gate";
import { holdsOtherRole, priceCents } from "./proLine";
import { activateProblems, fixerSetupAsk, proGaps } from "./setupAsk";
import { BLOCK_ON_CALENDAR_NEXT, blockCalendarNext, crewHoursOf, blockCollisionNews, blockOpenNews, BLOCK_HOST_ACCESS, CREW_HOST_ACCESS, crewScheduleQuestion, crewScheduleSentence, crewSpanRefusal, guestWithdrewNews, removeRepairBlockQuestion, repairBlockQuestion, URGENT_AGREED, URGENT_ASK_GUEST, urgentRefusal, urgentStayChangedNews } from "./texts";
import { codeOkNews, codeOkQuestion, codeOkReminder, extendAskNews, extendedNews, noExtendNews, bookingQuestion, firstName, cancelQuestion, propertyQuestion, CODE_CHANGE_NEXT, dollars, codeRefusedNote, codeText, codeTextNews, codeTextUnsureNote, costNewsText, cleaningOrderQuestion, extendQuestion, hostGoQuestion, lateBeforeCheckInNews, noPhotosNews, pickQuestion, preferredQuestion, PRO_DONE_ACK, PRO_HURT, PRO_HURT_CALL, proHurtNews, proTextFailed, proInvite, proTextNews, proVoicemailNews, quotesQuestion, shortDollars, raisedPrice, raisedPriceNews, revealNews, rotationQuestion, streetOf, rescheduleQuestion, codeTextOffNote, removeBookedPro, removeContactedPro, STAY_OVER_NEXT, stayOverBookingNews, STAYS_UNREAD, STAYS_UNREAD_BOOK, VISIT_ENDED, VISIT_LINK_NEXT, VISIT_NOT_STARTED, VISIT_PAGE_OFF, VISIT_REVOKED, visitOverNews, visitTextPath } from "./texts";
import { insideWindow, latestYmd, nextCheckIn, overlapsStay, visitWindows, type VisitWindow } from "./window";
import { doorFor, repairBlockProblem, repairBlockStatus, staysForCrew } from "./repairBlock";
import { crewScheduleProblem, crewWindowAt, crewWindows, type CrewSchedule, type CrewWindow } from "./crewDays";
import { MAX_VENDOR_HOURS, parseVendorTime } from "./vendorTime";
import { appendServiceNotice, cleanNoticeText, MAX_NOTICE_BODY, noticeDates, noticeHash, readServiceNotices, senderAddress, type ServiceNoticeInput } from "./serviceNotices";
import { scheduleWords, vendorCalledOffNews, vendorTakenNews, vendorTimeTaken, vendorTooManyQuestion, standingOffQuestion, standingQuestion, vendorConfirmed, vendorConfirmedNews, vendorHeldQuestion, vendorMoved, vendorMovedNews, vendorNoAnswerNews, vendorNoDayNews, vendorProposal, visitWhen, VENDOR_ASKING_HOST } from "./texts";
import { visitRecordsOn } from "../cleaner-core/flag";
import { buildVisits } from "../visits/derive";
import { fixerDue } from "../visits/due";
import { crewVisit, repairVisit, type WindowEvent } from "../visits/events";
import { messageEventId, visitLogFor, type VisitLog } from "../visits/store";
import { stayKey, urgentAccessCheck, urgentStay, urgentTimeline, urgentVisitHolds, type GuestAnswer, type UrgentHold, type UrgentRefusal } from "./urgentVisit";
import { MAX_HOST_STEPS, MAX_REPAIR_BLOCKS, TRADES, isTrade, letterToken, newId, readFixer, tokenHash, writeFixer, type SavedBlock, type Booking, type HostStep, type Candidate, type Contact, type FileNews, type FixerFile, type Job, type Pro, type ProReach, type Trade, type Upkeep, type StandingYes } from "./store";

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
  /** The account's text line, in +1 form: the number a pro is given to reach the host back, by text. */
  lineNumber?(): string | undefined;
  /** The account's alerts routine for its primary chat, read on each delivery and never kept here. */
  routine?(): { url: string; key: string } | undefined;
  /** The account's primary chat, which gets the alerts. */
  assistant?(): CleanerAssistant | undefined;
  /** Tests stub the routine's webhook. */
  alertFetch?: NonNullable<ConstructorParameters<typeof GrokRoutineWebhookSink>[1]>["fetch"];
}

/** Why the visit page (or the tick) got no code. */
export type RevealRefusal = AccessRefusal | DoorRefusal | "no-job" | "off" | "damaged" | "waiting-for-host";

/** The visit page's answer. Never passed to a tool reply, a log line or a file. */
export type RevealResult = { ok: true; code: string; lockLocation?: string; doors?: { door: string; code: string }[] } | { ok: false; reason: RevealRefusal };

/** The alerts routine's one-time upload link, under the property's path. */
export const FIXER_ALERT_UPLOAD_PREFIX = "/fixer-core/alert-routine/";
const ALERT_UPLOAD_MINUTES = 10;
const ALERT_UPLOAD_NEXT =
  'From your own cloud computer, POST JSON {"url": "<webhook address>", "token": "<webhook key>"} to uploadUrl with Content-Type: application/json, using the values from the host\'s secure cards. Never put them in chat or in a tool argument. Then call get_fixer_state.';

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
const MINUTE_MS = 60_000;
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
  checkInBufferMinutes?: number;
  cleaningMinutes?: number;
  askCleaner?: boolean;
  /** Setup: the host's pro list is final. */
  prosDone?: true;
  /** Setup: the host has no more upkeep to add. */
  upkeepDone?: true;
  /** Setup: the host said Not now to alerts. */
  alertsSkipped?: true;
  /** The host's agent passes vendors' completed-service emails (#237). */
  serviceNotices?: boolean;
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
  /** The host's standing yes for a routine vendor (#237), or null to withdraw it. Always two calls. */
  standing?: { proId?: string; from?: string; until?: string; access?: "code" | "host"; usualCents?: number } | null;
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
  /** The host's cost line for this repair, 100 to 500_000. Only on the host's own job. */
  costLineCents?: number;
  /** The host chose to get quotes first. Only on the host's own job. */
  quotesFirst?: true;
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
  /** The host's cost line for this repair, 100 to 500_000, given with their go. */
  costLineCents?: number;
  /** The host chose to get quotes first, with their go. */
  quotesFirst?: true;
  confirmation?: string;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const COST_LINE_RANGE = "A cost line has to be from $1 to $5,000.";
const QUOTES_FIRST_REFUSAL =
  "This repair is getting quotes first. Record what they quoted with outcome quoted, put any time they offered in the note, and tell them you'll call back.";
/** The most of a voicemail's transcript that is kept. */
const VOICEMAIL_MAX = 600;
/** Beside the line's number on contact_pro: what to tell a pro who asks how to reach the host. */
const CALLBACK_NEXT =
  "If they ask for a number to reach the host, give them callbackNumber and say they can leave a text or a voicemail there. Never give the host's own phone. Their texts and voicemails to it reach you as news on this job.";
const URGENCIES = ["now", "soon", "by-date", "flexible"] as const;
/** A job is still going until it is done or cancelled; these states are before any contact. */
const NOT_BOOKED = new Set<Job["state"]>(["requested", "shortlisted", "contacted"]);

/** What a booking was checked against, as its fingerprint. */
/** Keeps one of the host's approvals on the job for the hours log (#238), the oldest dropped past the cap. */
function noteHostStep(job: Job, step: HostStep): void {
  const steps = [...(job.hostSteps ?? []), step];
  job.hostSteps = steps.slice(-MAX_HOST_STEPS);
}

function fingerprintOf(b: { proId: string; from: string; until: string; estimateCents?: number; access: "code" | "host" }, order?: "before" | "after"): string {
  return bookingFingerprint({ proId: b.proId, from: b.from, until: b.until, ...(b.estimateCents !== undefined ? { estimateCents: b.estimateCents } : {}), access: b.access, ...(order ? { cleaningOrder: order } : {}) });
}

/** The record couldn't be read: the desk answers with a plain refusal and leaves the file alone. */
class DamagedRecord extends Error {}

const ok = (structured: Record<string, unknown>): FixerReply => ({ text: JSON.stringify(structured), structured, isError: false });
const fail = (text: string): FixerReply => ({ text, isError: true });

const isInt = (n: unknown, min: number, max: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;

/** The most times a vendor's own texts move one visit; after that the host decides (#237). */
const MAX_VENDOR_MOVES = 3;

/** A routine vendor's visit proposed under a standing yes and not yet confirmed by the vendor (#237). */
function vendorWaiting(job: Job): boolean {
  return Boolean(job.booking?.vendor && !job.booking.vendor.confirmedAt);
}
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

/** An urgent visit's refusal as the visit page's reasons. */
function urgentReason(reason: UrgentRefusal): AccessRefusal {
  if (reason === "before-visit" || reason === "after-visit" || reason === "no-phone") return reason;
  if (reason === "no-host-yes") return "no-yes";
  if (reason === "door-lock") return "host-access";
  if (reason === "no-guest-ok" || reason === "guest-declined" || reason === "guest-ok-other-stay" || reason === "guest-ok-other-window") return "guest-not-agreed";
  return "overlaps-stay";
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
    // The routine's address and key are read on every delivery, never saved here.
    this.alerts = new OperatorEventOutbox(
      new FileRuntimeStore(join(root, "fixer-alerts")),
      () => new GrokRoutineWebhookSink({ url: () => deps.routine?.()?.url, key: () => deps.routine?.()?.key }, deps.alertFetch ? { fetch: deps.alertFetch } : {}),
      { now: () => deps.now().getTime() },
    );
  }

  private readonly alerts: OperatorEventOutbox;

  /** True when the account has an alerts routine this desk can wake. */
  routineConnected(): boolean {
    const routine = this.deps.routine?.();
    return Boolean(routine?.url && routine.key);
  }

  /** True once a wake-up reached the account's alerts routine: lock problems then reach the host in chat. */
  alertsWorking(): boolean {
    return this.routineConnected() && this.alerts.records().some((record) => record.status === "delivered");
  }

  /** Delivers any wake-up that is due, such as one the routine refused before. The clock tick calls it. */
  async drainAlerts(): Promise<void> {
    if (!this.alerts.records().some((record) => record.status === "pending")) return;
    await this.alerts.drain();
  }

  /** One wake-up for the routine: a pending one already covers every note since. Then it calls check_fixes. */
  private wake(): void {
    if (!this.routineConnected()) return;
    const waiting = this.alerts.records().some((record) => record.event.eventType === "repairs.update" && record.status === "pending");
    if (!waiting) this.alerts.enqueue(repairsUpdateEvent(this.deps.now()));
    void this.alerts.drain().catch(() => undefined);
  }

  /** Runs calls one at a time, so two tools never write the record at once. */
  protected serial<T>(work: () => Promise<T> | T): Promise<T> {
    const step = async () => {
      const value = await work();
      await this.syncLocks();
      return value;
    };
    const run = this.chain.then(step, step);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The last lock sync: what Fixer wanted, and when. Only in memory. */
  private lockSync: { signature: string; at: number } | undefined;

  /** The property's connected-lock settings, or undefined when it isn't on connected locks. */
  private lockSettings(): { pros: "ask" | "automatic"; extend: "ask" | "automatic" } | undefined {
    try {
      const door = this.door();
      if (!door.connected()) return undefined;
      const locks = door.locks();
      return { pros: locks.release.pros, extend: locks.extend };
    } catch {
      return undefined;
    }
  }

  /** True when this visit's code waits for the host's OK: connected locks, pros' codes on ask, no OK yet. */
  private codeWaits(job: Job): boolean {
    return this.lockSettings()?.pros === "ask" && !job.booking?.codeYes;
  }

  /**
   * On connected locks, each clock pass: under ask, the host's OK is asked for when the pro's window
   * opens, and they're reminded once when the visit starts. Fifteen minutes before the pro's code
   * stops, if they haven't said done, the host is asked for more time or (automatic) the visit gets
   * 30 more minutes, never into the next check-in or the time kept free before it. Each extension
   * moves the pro's code by the lock sync. An urgent visit is never extended on its own.
   */
  private lockPass(file: FixerFile, job: Job, notes: HostNote[]): void {
    const settings = this.lockSettings();
    const booking = job.booking;
    if (!settings || !booking?.hostYes || booking.access !== "code" || job.done) return;
    const now = this.deps.now().getTime();
    const zone = this.timeZone();
    const proName = this.bookedName(file, job);
    const lead = booking.urgentStay ? 0 : 30 * MINUTE_MS;
    if (settings.pros === "ask" && !booking.codeYes) {
      if (now >= Date.parse(booking.from) - lead && !booking.codeAskedAt) {
        booking.codeAskedAt = new Date(now).toISOString();
        notes.push(this.news(job, "code-ok", codeOkNews({ proName, from: booking.from, timeZone: zone }), `fixer:${job.id}:${visitTag(booking)}:code-ok`));
      }
      if (now >= Date.parse(booking.from) && !booking.codeRemindedAt) {
        booking.codeRemindedAt = new Date(now).toISOString();
        notes.push(this.fileNews(file, { kind: "code-ok-reminder", jobId: job.id, text: codeOkReminder({ proName }), urgent: true }, `fixer:${job.id}:${visitTag(booking)}:code-ok-reminder`));
      }
    }
    // A crew is never extended: its code follows its workday windows (#243).
    if (job.crew) return;
    const end = this.endOf(booking);
    if (now < end - 15 * MINUTE_MS || now >= end) return;
    const endIso = new Date(end).toISOString();
    if (booking.extendNoted?.includes(endIso)) return;
    (booking.extendNoted ??= []).push(endIso);
    if (settings.extend === "ask" || booking.urgentStay) {
      notes.push(this.news(job, "extend-ask", extendAskNews({ proName, until: endIso, timeZone: zone }), `fixer:${job.id}:extend-ask:${endIso}`));
      return;
    }
    const until = new Date(end + 30 * MINUTE_MS).toISOString();
    const stays = this.crewStays(file).filter((stay) => stayKey(stay) !== booking.urgentStay);
    if (overlapsStay({ from: booking.from, until }, stays, this.occupyInput(file))) {
      notes.push(this.news(job, "extend-blocked", noExtendNews({ proName, until: endIso, timeZone: zone }), `fixer:${job.id}:extend-blocked:${endIso}`));
      return;
    }
    // An automatic extension keeps the visit link: the pro is still inside and taps done on it.
    booking.extendedUntil = until;
    notes.push(this.news(job, "extended", extendedNews({ proName, until, timeZone: zone }), `fixer:${job.id}:extended:${until}`));
  }

  /**
   * The host's OK to give the pro their code for this visit, on connected locks with pros' codes on
   * ask. Two calls: the question and a code, then the code after the host's yes. The code then shows
   * at the pro's "I'm at the door", or goes by text on the next clock pass. Never returns a code.
   */
  approveCode(input: { jobId?: string; confirmation?: string }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const off = this.inactive(file);
      if (off) return off;
      const job = this.jobOf(file, input.jobId);
      const booking = job?.booking;
      if (!job || !booking?.hostYes || !liveBooking(job)) return fail("Only a booked visit's code can be okayed.");
      if (!this.codeWaits(job)) return ok({ jobId: job.id, waiting: false, next: "This visit's code doesn't wait for the host's OK." });
      const proName = this.bookedName(file, job);
      const gate = this.confirm("fixer-code-ok", job.id, tokenHash(JSON.stringify([booking.fingerprint, "code-ok"])), input.confirmation, codeOkQuestion({ proName, from: booking.from, timeZone: this.timeZone() }));
      if (gate !== "go") return gate;
      booking.codeYes = { at: this.deps.now().toISOString() };
      this.write(file);
      return ok({ jobId: job.id, okayed: true, next: `${proName} gets their code at the door on the visit page, or by text if they text on the line.` });
    });
  }

  /**
   * On connected locks, the codes Fixer wants now: the booked pro's own, for each live visit with the
   * host's yes and access by code, from Fixer's access window (30 minutes early, none for an urgent
   * visit) to its end or extension. A crew booked with a code gets one, moved from workday to workday. Fixer off:
   * none, so all go.
   */
  private wantedCodes(file: FixerFile): WantedCode[] {
    if (!file.settings.activatedAt || file.offAt) return [];
    const wanted: WantedCode[] = [];
    for (const job of file.jobs) {
      const booking = job.booking;
      if (!booking || !liveBooking(job) || !booking.hostYes || booking.access !== "code" || vendorWaiting(job)) continue;
      const phone = this.reachOfId(file, job, booking.proId).phone;
      if (!phone) continue;
      if (job.crew) {
        // A crew's one code (#243): the workday window open now, else the next one; moved to the next day after each.
        const day = this.crewDay(file, job.crew);
        if (day) wanted.push({ jobId: job.id, person: phone, window: { from: day.from, until: day.until }, label: firstName(this.bookedName(file, job)), who: { role: "pro", proId: booking.proId } });
        continue;
      }
      const lead = booking.urgentStay ? 0 : 30 * 60_000;
      const from = new Date(Date.parse(booking.from) - lead).toISOString();
      const until = new Date(Date.parse(booking.extendedUntil ?? booking.until)).toISOString();
      wanted.push({ jobId: job.id, person: phone, window: { from, until }, label: firstName(this.bookedName(file, job)), who: { role: "pro", proId: booking.proId } });
    }
    return wanted;
  }

  /**
   * Issues, moves and revokes the pros' codes to match the record, after each step on connected locks.
   * Skipped when nothing changed in the last ten minutes. A note (a code that couldn't be made) goes
   * to the host once per visit. A failure leaves it for the next step.
   */
  private async syncLocks(): Promise<void> {
    let door: DoorAccess;
    let file: FixerFile;
    try {
      door = this.door();
      if (!door.connected()) return;
      file = this.read();
    } catch {
      return;
    }
    const wanted = this.wantedCodes(file);
    const signature = JSON.stringify(wanted);
    if (this.lockSync?.signature === signature && this.deps.now().getTime() - this.lockSync.at < 10 * 60_000) return;
    try {
      const notes = await door.syncGrants("repair", wanted);
      this.lockSync = { signature, at: this.deps.now().getTime() };
      const told: HostNote[] = [];
      for (const note of notes) {
        const job = file.jobs.find((item) => item.id === note.jobId);
        if (!job || job.news.some((item) => item.kind === "lock" && item.text === note.text)) continue;
        told.push(this.news(job, "lock", note.text, `fixer:${job.id}:${note.id}`));
      }
      if (told.length > 0) {
        this.write(file);
        await this.tell(told);
      }
    } catch {
      this.lockSync = undefined;
    }
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
    const cleaningOn = this.deps.cleaningOn?.() ?? false;
    return fixerSetupAsk(file, this.hub(), cleaningOn, supplyAskOn(this.root), this.alertsWanted(cleaningOn));
  }

  /** A Grok Bot can be woken; with Cleaner Core on, its own setup connects the routine. */
  private alertsWanted(cleaningOn: boolean): boolean {
    return !cleaningOn && this.deps.assistant?.() === "grok" && !this.routineConnected();
  }

  /**
   * save_repair_alerts: a one-time link for the alerts routine's address and key, posted from the agent's
   * own computer. Only the code's sha256, its expiry and the chat that made it are kept.
   */
  issueAlertUpload(): Promise<FixerReply> {
    return this.guarded({}, () => {
      const file = this.read();
      if (this.deps.cleaningOn?.()) return fail("Cleaner Core runs at this property: connect alerts with its save_alert_routine.");
      // Only a Grok Bot's routine can be woken; Muse's hourly task reads the news itself.
      if ((currentCaller()?.assistant ?? this.deps.assistant?.()) !== "grok") return fail("Repair alerts are for Grok Bot. Your hourly Fixer Core task already reads the news.");
      const base = this.deps.publicBase?.();
      if (!base) return fail("Upload links aren't available on this service yet.");
      const code = randomBytes(32).toString("base64url");
      const by = currentCaller();
      file.alertUpload = { hash: uploadHash(code), expiresAt: new Date(this.deps.now().getTime() + ALERT_UPLOAD_MINUTES * 60_000).toISOString(), ...(by ? { by } : {}) };
      this.write(file);
      return ok({ uploadUrl: `${base}${FIXER_ALERT_UPLOAD_PREFIX}${code}`, expiresInMinutes: ALERT_UPLOAD_MINUTES, next: ALERT_UPLOAD_NEXT });
    });
  }

  /**
   * Saves the routine's address and key posted to the link, through `save` (the secret store, as the chat
   * that made the link), and queues a test wake-up. Only a save uses the link up. Nothing posted is repeated.
   */
  uploadAlerts(code: string, body: Record<string, unknown>, save: (values: { CLEANER_CORE_ROUTINE_URL: string; CLEANER_CORE_ROUTINE_KEY: string }) => void): Promise<{ status: 200 | 400 | 404; body: Record<string, unknown>; by?: string }> {
    return this.serial(async () => {
      const file = this.read();
      const pending = file.alertUpload;
      if (!pending || !sameHash(uploadHash(code), pending.hash) || this.deps.now().getTime() >= Date.parse(pending.expiresAt)) return { status: 404 as const, body: { ok: false, error: "This upload link isn't valid anymore. Call save_repair_alerts for a new one." } };
      const url = typeof body.url === "string" ? body.url.trim() : "";
      const given = typeof body.token === "string" ? body.token : typeof body.key === "string" ? body.key : "";
      const token = given.trim();
      if (routineValuesRefused(url, token) || this.opensDoor(token)) return { status: 400 as const, body: { ok: false, error: "Send the routine's https webhook address as url and its key as token." } };
      const finish = () => save({ CLEANER_CORE_ROUTINE_URL: url, CLEANER_CORE_ROUTINE_KEY: token });
      if (pending.by) withCaller(pending.by, finish);
      else finish();
      delete file.alertUpload;
      file.setup.alertsDone = true;
      this.write(file);
      this.alerts.enqueue(testEvent(this.deps.now()));
      void this.alerts.drain().catch(() => undefined);
      return { status: 200 as const, body: { ok: true, message: "Alerts are connected." }, ...(pending.by?.connectionId ? { by: pending.by.connectionId } : {}) };
    });
  }

  /** True when the key, read as a base64 or base64url key, opens the saved door code. */
  private opensDoor(token: string): boolean {
    const door = this.door();
    if (!door.saved()) return false;
    for (const encoding of ["base64", "base64url"] as const) {
      const key = Buffer.from(token, encoding);
      if (key.length === 32 && door.opensWith(key)) return true;
    }
    return false;
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
          openJobs: file.jobs.filter(isOpen).map((job) => ({ jobId: job.id, trade: job.trade, what: job.what, state: job.state, ...(job.costLineCents !== undefined ? { costLineCents: job.costLineCents } : {}), ...(job.crew ? { crew: job.crew } : {}), ...(job.guest?.answers.length ? { guestAnswer: job.guest.answers.at(-1)!.answer } : {}) })),
          costLog: this.costLog(file),
          ...this.blockSummary(file),
          checkInBufferMinutes: file.settings.checkInBufferMinutes,
          cleaningMinutes: file.settings.cleaningMinutes,
          askCleaner: file.settings.askCleaner,
          ...(file.settings.serviceNotices ? { serviceNotices: true } : {}),
        },
      });
    });
  }

  saveSettings(input: SettingsInput): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const s = file.settings;
      if (input.checkInBufferMinutes !== undefined && !isInt(input.checkInBufferMinutes, 0, 240)) return fail("The check-in buffer has to be from 0 to 240 minutes.");
      if (input.cleaningMinutes !== undefined && !isInt(input.cleaningMinutes, 30, 480)) return fail("The cleaning length has to be from 30 to 480 minutes.");
      if (input.askCleaner !== undefined && typeof input.askCleaner !== "boolean") return fail("Asking the cleaner is yes or no.");
      if (input.serviceNotices !== undefined && typeof input.serviceNotices !== "boolean") return fail("Service notices are yes or no.");
      if (input.prosDone && file.pros.some((pro) => pro.status === "draft")) return fail("Confirm or remove the drafted pros first.");
      const gate = this.approved(file, "fixer-settings", "settings", input, "Save these settings?");
      if (gate !== "go") return gate;
      if (input.checkInBufferMinutes !== undefined) s.checkInBufferMinutes = input.checkInBufferMinutes;
      if (input.cleaningMinutes !== undefined) s.cleaningMinutes = input.cleaningMinutes;
      if (input.askCleaner !== undefined) {
        s.askCleaner = input.askCleaner;
        file.setup.cleanerAsked = true;
      }
      if (input.serviceNotices !== undefined) s.serviceNotices = input.serviceNotices;
      if (input.prosDone) file.setup.prosDone = true;
      if (input.upkeepDone) file.setup.upkeepDone = true;
      if (input.alertsSkipped) file.setup.alertsSkipped = true;
      this.write(file);
      return ok({ saved: true, ...(this.askFor(file) ? { next: "Call get_fixer_state for the next step." } : {}) });
    });
  }

  /**
   * The saved pros that have a phone, and a found candidate with a phone while their booking is live or
   * they were contacted on a job still open, kept in the account's people list as role "pro" for this
   * property (Decision 10). So a pro given the line as the number to reach the host back can text it.
   */
  private syncPros(file: FixerFile): void {
    const people = this.deps.people?.();
    if (!people || !this.deps.propertyId) return;
    const wanted = file.pros.filter((pro) => pro.status === "saved" && pro.reach.phone).map((pro) => ({ phone: pro.reach.phone!, name: pro.name }));
    const add = (candidate: Candidate | undefined) => {
      const phone = candidate?.reach.phone;
      if (phone && !wanted.some((entry) => entry.phone === phone)) wanted.push({ phone, name: candidate.name });
    };
    for (const job of file.jobs) {
      if (job.booking?.hostYes && liveBooking(job)) add(job.candidates.find((c) => c.id === job.booking!.proId));
      if (!isOpen(job)) continue;
      for (const contact of job.contacts) if (!contact.cancelled) add(job.candidates.find((c) => c.id === contact.to));
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
      let standing: Omit<StandingYes, "yesAt"> | null | undefined;
      if (input.standing !== undefined) {
        const checked = this.standingOf(file, input.standing, input.what.trim(), existing);
        if (typeof checked === "string") return fail(checked);
        standing = checked;
      }
      // A standing yes, or taking one back, is always the host's two-call yes, even before Activate.
      const gate =
        standing !== undefined
          ? this.confirm("fixer-upkeep-standing", existing?.id ?? "new", tokenHash(JSON.stringify({ ...input, confirmation: undefined })), input.confirmation, standing ? standingQuestion({ what: input.what.trim(), proName: this.proNameOf(file, standing.proId), schedule: scheduleWords(input.schedule!), from: standing.from, until: standing.until, access: standing.access, ...(standing.usualCents !== undefined ? { usualCents: standing.usualCents } : {}) }) : standingOffQuestion({ what: input.what.trim(), proName: this.proNameOf(file, existing?.standing?.proId) }))
          : this.approved(file, "fixer-upkeep", existing?.id ?? "new", input, `Save upkeep: ${input.what.trim()}?`);
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
      if (standing) {
        item.standing = { ...standing, yesAt: this.deps.now().toISOString() };
        item.proId = standing.proId;
      } else if (standing === null || (item.standing && (item.proId !== item.standing.proId || JSON.stringify(existing?.schedule) !== JSON.stringify(item.schedule)))) {
        // The standing yes was for this pro on this schedule: a change to either needs a new one.
        delete item.standing;
      }
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

  private proNameOf(file: FixerFile, proId: string | undefined): string {
    return file.pros.find((pro) => pro.id === proId)?.name ?? "the pro";
  }

  /**
   * A standing yes as asked (#237), checked: visit records on, a saved pro with a phone who texts on the line, and
   * usual hours "HH:MM" to "HH:MM" the same day, at most 4 hours. Null takes one back. A string is the refusal.
   */
  private standingOf(file: FixerFile, raw: NonNullable<UpkeepInput["standing"]> | null, what: string, existing: Upkeep | undefined): Omit<StandingYes, "yesAt"> | null | string {
    if (raw === null) return existing?.standing ? null : "That upkeep item has no standing yes to take back.";
    const env = this.deps.env?.();
    if (!env || !visitRecordsOn(env)) return "Routine vendor visits aren't on for this service yet. Save the upkeep without standing, and you'll be asked each time.";
    if (!what) return "Say what it is.";
    const pro = file.pros.find((entry) => entry.id === raw.proId && entry.status === "saved");
    if (!pro) return "Pick a pro from your saved list for the standing yes.";
    if (!pro.reach.phone || !pro.prefersText) return `${pro.name} doesn't text on the line, so their visits can't be confirmed by text. Save the upkeep without standing, and you'll be asked each time.`;
    const hm = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (typeof raw.from !== "string" || typeof raw.until !== "string" || !hm.test(raw.from) || !hm.test(raw.until)) return "Give the usual hours as HH:MM, like 09:00 and 11:00.";
    const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const span = minutes(raw.until) - minutes(raw.from);
    if (span <= 0) return "The usual hours have to end later the same day.";
    if (span > MAX_VENDOR_HOURS * 60) return `The usual hours can be at most ${MAX_VENDOR_HOURS} hours.`;
    const access = raw.access ?? "code";
    if (access !== "code" && access !== "host") return "Access is code or host.";
    if (raw.usualCents !== undefined && !isInt(raw.usualCents, 100, 500_000)) return "The usual price has to be from $1 to $5,000.";
    return { proId: pro.id, from: raw.from, until: raw.until, access, ...(raw.usualCents !== undefined ? { usualCents: raw.usualCents } : {}) };
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
      if (input.costLineCents !== undefined && !isInt(input.costLineCents, 100, 500_000)) return fail(COST_LINE_RANGE);
      if (input.costLineCents !== undefined && input.source !== "host") return fail("Only the host sets a cost line. For a cleaner's or upkeep job, pass it to approve_job with the host's go.");
      if (input.quotesFirst !== undefined && input.quotesFirst !== true) return fail("quotesFirst is only ever true.");
      if (input.quotesFirst && input.source !== "host") return fail("Only the host chooses quotes first. For a cleaner's or upkeep job, pass it to approve_job with the host's go.");
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
      if (input.costLineCents !== undefined) job.costLineCents = input.costLineCents;
      if (input.quotesFirst) job.quotesFirst = true;
      if (input.source === "host") {
        job.hostGo = { at: now };
        noteHostStep(job, { kind: "approve-repair", at: now });
      }
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
      if (input.costLineCents !== undefined && !isInt(input.costLineCents, 100, 500_000)) return fail(COST_LINE_RANGE);
      if (input.no) {
        job.state = "cancelled";
        job.cancelledAt = this.deps.now().toISOString();
        job.cancelReason = "host-said-no";
        this.write(file);
        return ok({ cancelled: true, jobId: job.id });
      }
      // The code is bound to the job. The cost line only adds a hold, so the host can give it after the question.
      const gate = this.approved(file, "fixer-job-go", job.id, { jobId: job.id, ...(input.confirmation !== undefined ? { confirmation: input.confirmation } : {}) } as ApproveJobInput, this.goQuestion(file, job));
      if (gate !== "go") return gate;
      job.hostGo = { at: this.deps.now().toISOString() };
      noteHostStep(job, { kind: "approve-repair", at: job.hostGo.at });
      if (input.costLineCents !== undefined) job.costLineCents = input.costLineCents;
      if (input.quotesFirst === true) job.quotesFirst = true;
      this.write(file);
      return ok({ approved: true, jobId: job.id, next: "Call check_fixes for who to contact." });
    });
  }

  /** The times a pro can visit for this job, between the stays, with the cleaning applied. None while the stays are unknown. */
  async windowsFor(job: Job, skipStay?: string): Promise<VisitWindow[]> {
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
      // An urgent visit's own guest stay, when asked to leave it out: what's left says whether the time is otherwise open.
      stays: this.crewStays(file).filter((stay) => !skipStay || stayKey(stay) !== skipStay),
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
      this.syncPros(file);
      const line = how === "text" ? undefined : this.deps.lineNumber?.();
      return ok({
        contactToken: contact.token,
        reach,
        ...(line ? { callbackNumber: line, callbackNext: CALLBACK_NEXT } : {}),
        ...(job.quotesFirst ? { quotesFirst: true } : {}),
        next: job.quotesFirst
          ? "This repair is quotes-only: ask for a price, not a time, and don't agree a time. Then call record_contact with this token, outcome quoted and quoteCents, and any time they offered in the note."
          : "Reach them, then call record_contact with this token and what they said.",
      });
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
      if (outcome === "booked" && job.quotesFirst) return fail(QUOTES_FIRST_REFUSAL);
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
      // The pro the host picked from the quotes fell through: back to quotes-only, and the host hears the rest.
      const pick = job.quotePick;
      if (pick && contact.to === pick.proId && contact.at > pick.at && (outcome === "declined" || outcome === "no-answer")) {
        job.quotesFirst = true;
        delete job.quotePick;
        delete job.quotesToldAt;
      }
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

  /** The stays to count as busy: calendar blocks are cut down to the parts outside saved repair blocks (#243). */
  private crewStays(file: FixerFile): Stay[] {
    return staysForCrew(this.hub().stays() ?? [], file.repairBlocks ?? []);
  }

  private door() {
    return this.hub().doorAccess(this.deps.env ?? (() => process.env));
  }

  private codeSaved(): boolean {
    return this.door().saved();
  }

  /** The gate holds for a span, with the windows they were checked against. */
  private async holdsFor(file: FixerFile, job: Job, span: { from: string; until: string }, estimateCents: number | undefined, order?: "before" | "after"): Promise<{ holds: BookingHold[]; windows: VisitWindow[] }> {
    if (job.crew) {
      // A crew books its saved schedule: it overlaps when a stay touches any workday's window.
      const overlaps = this.crewPlan(file, job.crew).conflicts.length > 0;
      const holds = bookingHolds({ span, windows: [span], overlaps, ...(job.costLineCents !== undefined ? { costLineCents: job.costLineCents } : {}), ...(estimateCents !== undefined ? { estimateCents } : {}) });
      return { holds, windows: [] };
    }
    const windows = await this.windowsFor({ ...job, ...(order ? { cleaningOrder: order } : {}) });
    const overlaps = overlapsStay(span, this.crewStays(file), this.occupyInput(file));
    let holds = bookingHolds({ span, windows, overlaps, ...(job.costLineCents !== undefined ? { costLineCents: job.costLineCents } : {}), ...(estimateCents !== undefined ? { estimateCents } : {}) });
    // An urgent visit is outside the windows because of the stay it's during. It's held for being outside only when
    // the time would be outside with that stay left out too (past the days looked at, or in a turnover clean).
    const stay = overlaps && job.urgency === "now" ? this.stayKeyOf(file, span) : undefined;
    if (stay && holds.includes("outside-window") && insideWindow(span, await this.windowsFor({ ...job, ...(order ? { cleaningOrder: order } : {}) }, stay))) holds = holds.filter((hold) => hold !== "outside-window");
    return { holds, windows };
  }

  /** The question for a booking, with the holds the host's yes would accept. */
  private questionFor(job: Job, proName: string, b: { from: string; until: string; estimateCents?: number }, access: "code" | "host", holds: readonly BookingHold[], urgent = false): string {
    // An urgent visit the guest agreed to is during a stay by design: its overlap hold becomes one sentence.
    const shown = urgent ? holds.filter((hold) => hold !== "overlaps-stay") : holds;
    return bookingQuestion({ proName, from: b.from, until: b.until, timeZone: this.timeZone(), ...(b.estimateCents !== undefined ? { estimateCents: b.estimateCents } : {}), access, holds: shown, ...(job.costLineCents !== undefined ? { costLineCents: job.costLineCents } : {}), ...(urgent ? { extra: URGENT_AGREED } : job.crew ? { extra: crewScheduleSentence(job.crew) } : {}) });
  }

  /** True when the span touches a block on the booking calendar, inside a repair block or not. */
  private inCalendarBlock(file: FixerFile, span: { from: string; until: string }): boolean {
    return overlapsStay(span, (this.hub().stays() ?? []).filter((stay) => stay.kind === "block"), this.occupyInput(file));
  }

  /**
   * Why an urgent visit over a guest stay can't be booked yet, the host's yes aside (#243). Undefined for a job that
   * isn't urgent (urgency now) or is a crew job: those are never booked over a stay.
   */
  private urgentHolds(file: FixerFile, job: Job, span: { from: string; until: string }): UrgentHold[] | undefined {
    if (job.urgency !== "now" || job.crew) return undefined;
    const guest = job.guest?.answers.at(-1);
    return urgentVisitHolds({ window: span, stays: this.crewStays(file), times: this.occupyInput(file), ...(guest ? { guest } : {}), hostYes: { at: this.deps.now().toISOString() } });
  }

  /** The key of the guest stay a span falls in, or undefined. */
  private stayKeyOf(file: FixerFile, span: { from: string; until: string }): string | undefined {
    const stay = urgentStay(span, this.crewStays(file), this.occupyInput(file));
    return stay ? stayKey(stay) : undefined;
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
    if (job.crew) {
      const plan = this.crewPlan(file, job.crew);
      if (!plan.span || plan.span.from !== span.from || plan.span.until !== span.until) return fail(plan.span ? crewSpanRefusal(plan.span) : "No workday of the crew's schedule is left. Save a new schedule first.");
    }
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
    const access = job.crew || this.inCalendarBlock(file, span) ? "host" : defaultAccess(job, { reach: this.reachOfId(file, job, contact.to) }, this.codeSaved());
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
    const urgent = holds.includes("overlaps-stay") ? this.urgentHolds(file, job, span) : undefined;
    if (urgent?.length === 0) {
      reply.question = this.questionFor(job, name, booking, access, holds, true);
      reply.next = "Ask the host this question, then call approve_booking.";
    } else if (urgent) {
      reply.next = urgentRefusal(urgent[0]!, { proName: name });
    } else if (holds.includes("overlaps-stay")) {
      reply.next = `That time overlaps a guest stay, so it can't be booked. Tell the host, and ask ${name} for another time.`;
    } else {
      reply.question = this.questionFor(job, name, booking, access, holds);
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
      let access = input.access ?? target.access;
      // A crew gets a code only on connected locks (#243): one code for the booked pro, live in each workday's window.
      if (access === "code" && job.crew && !this.lockSettings()) return fail(CREW_HOST_ACCESS);
      if (job.crew) {
        const plan = this.crewPlan(file, job.crew);
        if (!plan.span || plan.span.from !== target.from || plan.span.until !== target.until) return fail(plan.span ? crewSpanRefusal(plan.span) : "No workday of the crew's schedule is left. Save a new schedule first.");
      }
      if (access === "code" && defaultAccess(job, { reach: this.reachOfId(file, job, target.proId) }, this.codeSaved()) !== "code") return fail("The door code can't go to this pro: there's no saved code, no phone for them, or the job is on the coded lock. Let them in yourself instead.");
      const order = input.cleaningOrder ?? target.cleaningOrder ?? job.cleaningOrder;
      // The stays and windows are read again now, so a yes after they changed is refused.
      if ((this.readsCalendars() || this.staysUnknown()) && this.hub().google() && !googleEvents) return fail(GOOGLE_EVENTS_NEEDED);
      await this.refreshCalendars(googleEvents);
      if (this.staysUnknown()) return fail(STAYS_UNREAD_BOOK);
      const span = { from: target.from, until: target.until };
      if (Date.parse(span.from) <= this.deps.now().getTime()) return fail(PAST_SPAN);
      if (access === "code" && this.inCalendarBlock(file, span)) {
        if (input.access === "code") return fail(BLOCK_HOST_ACCESS);
        access = "host";
      }
      const { holds, windows } = await this.holdsFor(file, job, span, target.estimateCents, order);
      const urgent = holds.includes("overlaps-stay") ? this.urgentHolds(file, job, span) : undefined;
      if (urgent && urgent.length > 0) return fail(urgentRefusal(urgent[0]!, { proName: name }));
      if (holds.includes("overlaps-stay") && !urgent) return fail(`That time overlaps a guest stay, so nothing is booked. Ask ${name} for another time.`);
      const urgentKey = urgent ? this.stayKeyOf(file, span) : undefined;
      const checkoutDay = localYmd(new Date(span.from), this.timeZone());
      if (!order && windows.some((w) => w.cleaning && w.checkoutYmd === checkoutDay)) return ok({ question: cleaningOrderQuestion({ proName: name }), next: "Ask the host, then call approve_booking again with cleaningOrder set to before or after." });
      const question = this.questionFor(job, name, target, access, holds, Boolean(urgentKey));
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
        ...(urgentKey ? { urgentStay: urgentKey } : {}),
      };
      job.booking = booked;
      noteHostStep(job, { kind: "approve-booking", at: booked.hostYes!.at, proId: booked.proId });
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
    if (!booking || !liveBooking(job) || !revised || revised.hostYes || !raisedPriceHeld(job.costLineCents, booking.estimateCents, revised.cents)) return fail("There's no raised price waiting for the host's yes.");
    const name = this.nameOf(file, job, booking.proId) ?? "The pro";
    const question = raisedPrice({ proName: name, newCents: revised.cents, ...(booking.estimateCents !== undefined ? { oldCents: booking.estimateCents } : {}) });
    const gate = this.confirm("fixer-revised", job.id, tokenHash(JSON.stringify([booking.fingerprint, revised.cents])), input.confirmation, question);
    if (gate !== "go") return gate;
    revised.hostYes = { at: this.deps.now().toISOString() };
    noteHostStep(job, { kind: "approve-price", at: revised.hostYes.at, proId: booking.proId, cents: revised.cents });
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
      if (live?.hostYes && liveBooking(job) && this.staysOver(file, live, job).length > 0) {
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
      const next = this.upkeepNext(file, item, tz);
      if (!next || today < next.leadStart) continue;
      due.push({ upkeepId: item.id, trade: item.trade, what: item.what, nextDate: next.nextDate, ...(item.proId ? { proId: item.proId } : {}) });
    }
    return due;
  }

  /**
   * An upkeep item's next date and the day its lead time opens, or undefined while a job for it is open or one was
   * already made for this date (even a cancelled one: the date was dealt with).
   */
  private upkeepNext(file: FixerFile, item: Upkeep, tz: string): { nextDate: string; leadStart: string } | undefined {
    const jobs = file.jobs.filter((job) => job.sourceRef === item.id);
    if (jobs.some(isOpen)) return undefined;
    const start = localYmd(new Date(item.lastDoneAt ?? item.savedAt), tz);
    let nextDate = nextDates(item.schedule, start, start, 1)[0];
    // A date whose job was cancelled was dealt with: the one after it comes due in turn.
    for (let guard = 0; nextDate && guard < 12; guard++) {
      const leadStart = addCalendarDays(nextDate, -item.leadDays);
      if (!jobs.some((job) => localYmd(new Date(job.createdAt), tz) >= leadStart)) return { nextDate, leadStart };
      nextDate = nextDates(item.schedule, start, addCalendarDays(nextDate, 1), 1)[0];
    }
    return undefined;
  }

  /** The next saved pro to contact for each job the host said go to, the best ranked one not yet tried. */
  private contactNext(file: FixerFile): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const job of file.jobs) {
      if (!isOpen(job) || !job.hostGo || !NOT_BOOKED.has(job.state) || liveBooking(job)) continue;
      if (job.contacts.some((contact) => !contact.cancelled && (contact.outcome === undefined || contact.outcome === "waiting"))) continue;
      // The pro the host picked from the quotes comes first, until they are contacted again.
      const pick = job.quotePick;
      if (pick && !job.contacts.some((c) => c.to === pick.proId && c.at > pick.at)) {
        const name = this.nameOf(file, job, pick.proId);
        if (name && contactAllowed(job, pick.proId, file.pros).ok) {
          out.push({ jobId: job.id, proId: pick.proId, name, reach: this.reachOfId(file, job, pick.proId) });
          continue;
        }
        // The picked pro can't be contacted any more (removed, say): back to quotes-only, so the host hears the rest.
        job.quotesFirst = true;
        delete job.quotePick;
        delete job.quotesToldAt;
        continue;
      }
      const next = this.topPro(file, job.trade, job.contacts.map((contact) => contact.to));
      if (!next || !contactAllowed(job, next.pro.id, file.pros).ok) continue;
      out.push({ jobId: job.id, proId: next.pro.id, name: next.pro.name, reach: next.pro.reach, rank: next.rank, ...(job.quotesFirst ? { quotesFirst: true } : {}) });
    }
    return out;
  }

  /**
   * pick_quote: the host's pick from a quotes-only job's quotes, in two calls, with an optional cost line.
   * The code is bound to the job, the pro and the line. It ends quotes-only, and check_fixes names the pro to book.
   */
  pickQuote(input: { jobId?: string; proId?: string; costLineCents?: number; confirmation?: string }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const off = this.inactive(file);
      if (off) return off;
      const job = this.jobOf(file, input.jobId);
      if (!job) return fail("There's no job with that id. Call get_fixer_state for the list.");
      if (!isOpen(job) || !job.quotesFirst) return fail("That repair isn't getting quotes first.");
      const live = job.contacts.filter((c) => !c.cancelled);
      if (live.some((c) => c.outcome === undefined || c.outcome === "waiting")) return fail("Not every pro has answered yet. Record what each one said first.");
      // The pro's latest answer has to be a quote: an older quote they took back doesn't count.
      const latest = typeof input.proId === "string" ? live.filter((c) => c.to === input.proId).at(-1) : undefined;
      if (!latest || latest.outcome !== "quoted" || !latest.quote) return fail("Pick a pro who gave a quote on this repair.");
      if (input.costLineCents !== undefined && !isInt(input.costLineCents, 100, 500_000)) return fail(COST_LINE_RANGE);
      const name = this.nameOf(file, job, latest.to) ?? "That pro";
      const line = input.costLineCents !== undefined ? ` with a ${shortDollars(input.costLineCents)} cost line` : "";
      // Bound to the quote too: a new price means a new question.
      const gate = this.approved(file, "fixer-pick-quote", job.id, { ...input, quoteCents: latest.quote.cents } as typeof input, `Book ${name} at ${shortDollars(latest.quote.cents)} for ${job.what}${line}?`);
      if (gate !== "go") return gate;
      delete job.quotesFirst;
      delete job.quotesToldAt;
      if (input.costLineCents !== undefined) job.costLineCents = input.costLineCents;
      job.quotePick = { proId: latest.to, at: this.deps.now().toISOString() };
      noteHostStep(job, { kind: "pick-quote", at: job.quotePick.at, proId: latest.to });
      this.write(file);
      return ok({ picked: true, jobId: job.id, next: `Call check_fixes: contactNext names ${name} to book.` });
    });
  }

  /**
   * Quotes-only jobs whose contacted pros all answered (quoted, declined or no answer), each listed once:
   * again only after a newer contact. Listing one marks it told.
   */
  private quotesReady(file: FixerFile): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    const answered = new Set(["quoted", "declined", "no-answer"]);
    for (const job of file.jobs) {
      if (!isOpen(job) || !job.quotesFirst) continue;
      const contacts = job.contacts.filter((c) => !c.cancelled);
      if (contacts.length === 0 || !contacts.every((c) => c.outcome !== undefined && answered.has(c.outcome))) continue;
      // The round isn't over while an approved pro hasn't been asked yet: one summary at its end.
      if (this.nextPro(file, job)) continue;
      if (job.quotesToldAt && !contacts.some((c) => (c.outcomeAt ?? c.at) > job.quotesToldAt!)) continue;
      // Each pro once, by their latest contact.
      const latest = new Map(contacts.map((c) => [c.to, c]));
      // A pro who can't be contacted any more (removed, say) isn't offered.
      const quotes = [...latest.values()].filter((c) => c.outcome === "quoted" && c.quote && this.nameOf(file, job, c.to) !== undefined && contactAllowed(job, c.to, file.pros).ok).map((c) => ({ proId: c.to, name: this.nameOf(file, job, c.to) ?? "A pro", cents: c.quote!.cents, ...(c.quote!.note ? { note: c.quote!.note } : {}) }));
      out.push({ jobId: job.id, quotes, question: quotesQuestion({ what: job.what, quotes }) });
      job.quotesToldAt = this.deps.now().toISOString();
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
      this.blockPass(file, notes);
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
        quotesReady: this.quotesReady(file),
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

  /** The crew's workday window open now, or else the next one, around the current stays. No early lead (#243). */
  private crewDay(file: FixerFile, crew: CrewSchedule): CrewWindow | undefined {
    const now = this.deps.now();
    const { windows } = this.crewPlan(file, crew);
    return crewWindowAt(windows, now, 0) ?? windows.find((w) => Date.parse(w.from) > now.getTime());
  }

  /** A crew schedule's windows against the stays, and the span a booking must cover: first window's start to last window's end. */
  private crewPlan(file: FixerFile, crew: CrewSchedule): ReturnType<typeof crewWindows> & { span?: { from: string; until: string } } {
    const plan = crewWindows(crew, { ...this.occupyInput(file), stays: this.crewStays(file) });
    // The span runs over the schedule's whole days, so a clipped day still counts as a conflict, never a shorter span.
    const full = crewWindows(crew, { ...this.occupyInput(file), stays: [] }).windows;
    return { ...plan, ...(full.length > 0 ? { span: { from: full[0]!.from, until: full[full.length - 1]!.until } } : {}) };
  }

  /** save_crew_schedule (#243): a crew's workdays and hours on a job, with the host's yes, before it is booked. */
  saveCrewSchedule(input: Partial<CrewSchedule> & { jobId?: string; confirmation?: string }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const off = this.inactive(file);
      if (off) return off;
      const job = this.jobOf(file, input.jobId);
      if (!job || !isOpen(job)) return fail("There's no open job with that id. Call get_fixer_state for the list.");
      if (liveBooking(job)) return fail("This job is already booked. Reschedule it first to change the crew's schedule.");
      if (job.booking && !job.booking.hostYes) return fail("A booking is waiting for the host's yes on this job. Settle it, or ask the pro again with reschedule_job, before changing the crew's schedule.");
      const crew: CrewSchedule = { firstDay: input.firstDay ?? "", lastDay: input.lastDay ?? "", workdays: input.workdays ?? [], start: input.start ?? "", end: input.end ?? "", ...(input.skipDays ? { skipDays: input.skipDays } : {}) };
      const problem = crewScheduleProblem(crew, this.today());
      if (problem) return fail(problem);
      const plan = this.crewPlan(file, crew);
      if (!plan.span) return fail("None of those days is a workday. Check the days and the workdays.");
      const days = new Set(crewWindows(crew, { ...this.occupyInput(file), stays: [] }).windows.map((w) => w.day)).size;
      const gate = this.confirm("fixer-crew", job.id, tokenHash(JSON.stringify(crew)), input.confirmation, crewScheduleQuestion({ ...crew, windows: days }));
      if (gate !== "go") return gate;
      job.crew = crew;
      this.write(file);
      const full = crewWindows(crew, { ...this.occupyInput(file), stays: [] }).windows;
      return ok({
        saved: true,
        jobId: job.id,
        workdays: days,
        first: full[0],
        last: full[full.length - 1],
        span: plan.span,
        conflicts: plan.conflicts,
        next: plan.conflicts.length > 0 ? "A guest stay touches some workdays, so the crew can't be booked yet. Tell the host which days, and save a schedule that avoids them." : `Book the crew for the whole schedule: record_contact with booked from ${plan.span.from} until ${plan.span.until}. The host lets the crew in until crew codes exist.`,
      });
    });
  }

  /**
   * The code for an urgent visit during a stay (#243): the usual checks, then only inside the visit itself (no
   * early lead, the guest is inside), only while the guest's last answer is a yes that holds the whole visit.
   */
  private urgentAccess(file: FixerFile, job: Job, booking: Booking, overlaps: boolean, turnover: { checkoutDay: boolean; cleared: boolean }): ReturnType<typeof accessCheck> {
    const now = this.deps.now();
    const pro = { reach: this.reachOfId(file, job, booking.proId) };
    const base = accessCheck({ job, pro, now, ...turnover, overlapsStay: overlaps, staysUnread: this.staysUnknown() });
    if (!base.ok && base.reason !== "before-visit") return base;
    // Once the guest said no after the host's yes, the code stays off for this visit, whatever they say later.
    if (job.guest?.answers.some((answer) => answer.answer === "no" && booking.hostYes && answer.at >= booking.hostYes.at)) return { ok: false, reason: "guest-not-agreed" };
    const guest = job.guest?.answers.at(-1);
    const window = { from: booking.from, until: new Date(this.endOf(booking)).toISOString() };
    const check = urgentAccessCheck({ window, stays: this.crewStays(file), times: this.occupyInput(file), ...(guest ? { guest } : {}), ...(booking.hostYes ? { hostYes: booking.hostYes } : {}), now, ...(pro.reach.phone ? { proPhone: pro.reach.phone } : {}), ...(job.doorLock ? { doorLock: true } : {}) });
    if (check.ok) return check;
    return { ok: false, reason: urgentReason(check.reason) };
  }

  /**
   * record_guest_answer (#243): that the guest was asked about a visit during their stay, or what they answered.
   * It approves nothing. A yes on a pending booking gives the host's question; a no on a booked visit stops its code.
   */
  recordGuestAnswer(input: { jobId?: string; answer?: "asked" | "yes" | "no"; from?: string; until?: string; via?: GuestAnswer["via"] }): Promise<FixerReply> {
    return this.guarded(input, async () => {
      const file = this.read();
      const off = this.inactive(file);
      if (off) return off;
      const job = this.jobOf(file, input.jobId);
      if (!job || !isOpen(job)) return fail("There's no open job with that id. Call get_fixer_state for the list.");
      if (job.urgency !== "now" || job.crew) return fail("Only an urgent job (urgency now) can have a visit during a guest's stay.");
      if (!["asked", "yes", "no"].includes(input.answer as string)) return fail("Say asked, yes or no.");
      if (!["text", "platform", "host"].includes(input.via as string)) return fail("Say how the guest answered: text, platform, or host when the host passed it on.");
      const at = this.deps.now().toISOString();
      const record = (job.guest ??= { asked: [], answers: [] });
      if (input.answer === "asked") {
        record.asked.push(at);
        this.write(file);
        return ok({ recorded: true, jobId: job.id, next: "When the guest answers, call record_guest_answer with yes (and the time they agreed to) or no." });
      }
      const booking = job.booking;
      const span = booking ? { from: booking.from, until: new Date(this.endOf(booking)).toISOString() } : undefined;
      if (input.answer === "no") {
        const key = booking?.urgentStay ?? (span && this.stayKeyOf(file, span)) ?? "";
        record.answers.push({ stay: key, answer: "no", at, via: input.via! });
        const notes: HostNote[] = [];
        let rotationAsk: { jobId: string; question: string } | undefined;
        if (booking?.urgentStay && liveBooking(job)) {
          const proName = this.bookedName(file, job);
          const codeSeen = (booking.revealedAt?.length ?? 0) > 0;
          notes.push(this.fileNews(file, { kind: "guest-withdrew", jobId: job.id, text: guestWithdrewNews({ proName, codeSeen }), urgent: true }, `fixer:${job.id}:${visitTag(booking)}:guest-withdrew:${record.answers.length}`));
          if (codeSeen) rotationAsk = this.askRotation(file, job, { open: true });
        }
        this.write(file);
        await this.tell(notes);
        return ok({ recorded: true, jobId: job.id, ...(rotationAsk ? { rotationAsk } : {}), next: notes.length > 0 ? `Tell ${this.bookedName(file, job)} not to come. Ask the host: reschedule_job or cancel_job?` : "Tell the host the guest said no, and ask the pro for a time after checkout." });
      }
      const from = input.from;
      const until = input.until;
      if (typeof from !== "string" || typeof until !== "string" || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(until)) || Date.parse(until) <= Date.parse(from)) return fail("A yes needs the time the guest agreed to, as from and until.");
      const window = { from: new Date(from).toISOString(), until: new Date(until).toISOString() };
      const key = this.stayKeyOf(file, window);
      if (!key) return fail("That time isn't during a guest stay. Book a visit outside a stay the normal way.");
      record.answers.push({ stay: key, answer: "yes", window, at, via: input.via! });
      this.write(file);
      const reply: Record<string, unknown> = { recorded: true, jobId: job.id };
      if (booking && !booking.hostYes && span) {
        const name = this.nameOf(file, job, booking.proId) ?? "The pro";
        const holds = this.urgentHolds(file, job, span) ?? [];
        if (holds.length === 0) {
          const { holds: gate } = await this.holdsFor(file, job, span, booking.estimateCents);
          reply.question = this.questionFor(job, name, booking, booking.access, gate, true);
          reply.next = "Ask the host this question, then call approve_booking.";
        } else {
          reply.next = urgentRefusal(holds[0]!, { proName: name });
        }
      }
      return ok(reply);
    });
  }

  /** urgent_timeline (#243): what happened, oldest first, for the platform. Names and times only. */
  urgentTimeline(input: { jobId?: string }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const job = this.jobOf(file, input.jobId);
      if (!job) return fail(NO_JOB);
      const booking = job.booking;
      const timeline = urgentTimeline({
        timeZone: this.timeZone(),
        reportedAt: job.createdAt,
        what: job.what,
        proName: this.bookedName(file, job),
        guestAskedAt: job.guest?.asked ?? [],
        guestAnswers: job.guest?.answers ?? [],
        ...(booking?.hostYes ? { hostYesAt: booking.hostYes.at } : {}),
        codeShownAt: booking?.revealedAt ?? [],
        ...(job.done ? { done: { at: job.done.at, ...(job.done.note ? { note: job.done.note } : {}) } } : {}),
        photos: job.photos.map((photo) => ({ at: photo.at, from: photo.from })),
      });
      return ok({ jobId: job.id, timeline });
    });
  }

  /** The saved blocks with what the last calendar read says, and who the door is for now. Nothing when none is saved. */
  private blockSummary(file: FixerFile): { repairBlocks?: Record<string, unknown>[]; doorNow?: string } {
    const blocks = file.repairBlocks ?? [];
    if (blocks.length === 0) return {};
    const stays = this.hub().stays() ?? [];
    return {
      repairBlocks: blocks.map((block) => ({ blockId: block.id, firstDay: block.firstDay, lastDay: block.lastDay, jobIds: block.jobIds, ...repairBlockStatus(block, stays) })),
      doorNow: doorFor(this.deps.now(), blocks, stays, this.occupyInput(file)),
    };
  }

  /**
   * save_repair_block: days closed for repairs, always with the host's yes (#243). Pros can be booked inside them.
   * Fixer Core can't write to the booking calendar yet, so while a night is still open the agent tells the host to close it.
   */
  saveRepairBlock(input: { firstDay?: string; lastDay?: string; jobIds?: string[]; confirmation?: string }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const off = this.inactive(file);
      if (off) return off;
      const days = { firstDay: input.firstDay ?? "", lastDay: input.lastDay ?? "" };
      const problem = repairBlockProblem(days, this.today());
      if (problem) return fail(problem);
      const jobIds = input.jobIds ?? [];
      if (!Array.isArray(jobIds) || jobIds.length > 10 || !jobIds.every((id) => file.jobs.some((job) => job.id === id && isOpen(job)))) return fail("Each job has to be an open job. Call get_fixer_state for the list.");
      const blocks = file.repairBlocks ?? [];
      if (blocks.length >= MAX_REPAIR_BLOCKS) return fail(`Up to ${MAX_REPAIR_BLOCKS} repair blocks can be saved. Remove an old one first.`);
      const gate = this.confirm("fixer-block", `${days.firstDay}|${days.lastDay}`, tokenHash(JSON.stringify([days.firstDay, days.lastDay, [...jobIds].sort()])), input.confirmation, repairBlockQuestion(days));
      if (gate !== "go") return gate;
      const block: SavedBlock = { id: newId("blk_", 8), ...days, jobIds: [...new Set(jobIds)], savedAt: this.deps.now().toISOString() };
      file.repairBlocks = [...blocks, block];
      this.write(file);
      const status = repairBlockStatus(block, this.hub().stays() ?? []);
      return ok({ saved: true, blockId: block.id, ...status, next: status.onCalendar ? BLOCK_ON_CALENDAR_NEXT : blockCalendarNext(status) });
    });
  }

  /** remove_repair_block: the host's yes in two calls. */
  removeRepairBlock(input: { blockId?: string; confirmation?: string }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const block = (file.repairBlocks ?? []).find((entry) => entry.id === input.blockId);
      if (!block) return fail("There's no repair block with that id. Call get_fixer_state for the list.");
      const gate = this.confirm("fixer-block-remove", block.id, block.id, input.confirmation, removeRepairBlockQuestion(block));
      if (gate !== "go") return gate;
      file.repairBlocks = (file.repairBlocks ?? []).filter((entry) => entry.id !== block.id);
      this.write(file);
      return ok({ removed: true, blockId: block.id, next: "Tell the host the days are open again. Reopen them on the booking calendar only if they want guests then." });
    });
  }

  /** check_fixes: once per block and set of open nights, and once per guest stay inside it (urgent). Only blocks not yet over. */
  private blockPass(file: FixerFile, notes: HostNote[]): void {
    const stays = this.hub().stays();
    if (!stays) return;
    const today = this.today();
    for (const block of file.repairBlocks ?? []) {
      if (block.lastDay < today) continue;
      const status = repairBlockStatus(block, stays);
      const told = (block.told ??= []);
      const openKey = `open:${status.openNights.join(",")}`;
      if (status.openNights.length > 0 && !told.includes(openKey)) {
        told.push(openKey);
        notes.push(this.fileNews(file, { kind: "repair-block-open", text: blockOpenNews({ ...block, openNights: status.openNights }) }, `fixer:${block.id}:${openKey}`));
      }
      for (const stay of status.collisions) {
        const key = `stay:${stay.checkIn}|${stay.checkout}`;
        if (told.includes(key)) continue;
        told.push(key);
        notes.push(this.fileNews(file, { kind: "repair-block-collision", text: blockCollisionNews({ ...block, checkIn: stay.checkIn, checkout: stay.checkout }), urgent: true }, `fixer:${block.id}:${key}`));
      }
    }
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

  /**
   * A note for the host from the property's connected lock (a code that didn't program, a low
   * battery), on a property where Cleaner Core is off: kept in check_fixes' news and told like any
   * Fixer note, once per id. Never holds a code.
   */
  noteForHost(id: string, text: string, jobId?: string): Promise<boolean> {
    return this.serial(async () => {
      const file = this.read();
      const told = (file.news ?? []).some((item) => item.kind === "lock" && item.text === text) || file.jobs.some((job) => job.news.some((item) => item.kind === "lock" && item.text === text));
      if (told) return true;
      const job = jobId ? file.jobs.find((item) => item.id === jobId) : undefined;
      const note = job ? this.news(job, "lock", text, `fixer:${job.id}:${id}`) : this.fileNews(file, { kind: "lock", text, ...(jobId ? { jobId } : {}) } as Omit<FileNews, "at" | "toldAt">, `fixer:${id}`);
      this.write(file);
      return this.tell([note]);
    });
  }

  /** Sends the host notes. A note that fails to go is still in check_fixes' news. */
  private async tell(notes: readonly HostNote[]): Promise<boolean> {
    // Without Cleaner Core here, nothing takes the note: it waits in check_fixes' news, and the routine is woken.
    if (notes.length > 0 && this.deps.cleaningOn?.() !== true) this.wake();
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
    // A crew (#243): only inside a workday's window, and the turnover check is that day's.
    const crewToday = job.crew && booking?.access === "code" ? crewWindowAt(this.crewPlan(file, job.crew).windows, this.deps.now(), 0) : undefined;
    const ymd = crewToday ? crewToday.day : booking ? localYmd(new Date(booking.from), this.timeZone()) : this.today();
    // An urgent visit's own stay checking out that morning is the guest who agreed to it, not a turnover to wait on.
    const checkoutDay = (this.hub().stays() ?? []).some((stay) => stay.checkout === ymd && stayKey(stay) !== booking?.urgentStay);
    let cleared = file.clearedYmd === ymd;
    if (checkoutDay && !cleared && this.deps.cleanings) cleared = (await this.deps.cleanings(ymd))?.cleared === true;
    // A calendar block can be a real booking labelled "Not available": the code never goes inside one.
    const overlaps = booking ? this.staysOver(file, booking, job).length > 0 || this.inCalendarBlock(file, { from: booking.from, until: new Date(this.endOf(booking)).toISOString() }) : false;
    if (booking?.urgentStay) return this.urgentAccess(file, job, booking, overlaps, { checkoutDay, cleared });
    const check = accessCheck({ job, pro: booking ? { reach: this.reachOfId(file, job, booking.proId) } : undefined, now: this.deps.now(), checkoutDay, cleared, overlapsStay: overlaps, staysUnread: this.staysUnknown() });
    if (!job.crew || booking?.access !== "code" || !check.ok) return check;
    // Off connected locks (switched off since the booking), a crew never gets the host's saved code: the host lets them in.
    if (!this.lockSettings()) return { ok: false, reason: "host-access" };
    if (!crewToday) return { ok: false, reason: "outside-crew-hours" };
    return { ok: true, window: { from: crewToday.from, until: crewToday.until } };
  }

  /** The saved stays that overlap this visit, with its extension and the check-in buffer. */
  private staysOver(file: FixerFile, booking: Booking, job?: Job): Stay[] {
    // A crew works only its windows: a stay between workdays doesn't overlap the crew.
    const crew = job?.crew;
    if (crew) return this.crewStays(file).filter((stay) => crewWindows(crew, { ...this.occupyInput(file), stays: [stay] }).conflicts.length > 0);
    const span = { from: booking.from, until: new Date(this.endOf(booking)).toISOString() };
    const input = this.occupyInput(file);
    // An urgent visit's own stay is the guest's okay, not an overlap.
    return this.crewStays(file).filter((stay) => stayKey(stay) !== booking.urgentStay && overlapsStay(span, [stay], input));
  }

  /** Each booked visit a stay now overlaps: one host note per visit and stay, bound to the visit. */
  private overlapPass(file: FixerFile, notes: HostNote[]): void {
    for (const job of file.jobs) {
      const booking = job.booking;
      if (!booking?.hostYes || !liveBooking(job)) continue;
      for (const stay of this.staysOver(file, booking, job)) {
        const key = `${stay.checkIn}|${stay.checkout}`;
        if (booking.stayNoted?.includes(key)) continue;
        (booking.stayNoted ??= []).push(key);
        const text = stayOverBookingNews({ proName: this.bookedName(file, job), from: booking.from, timeZone: this.timeZone() });
        notes.push(this.news(job, "stay-over-booking", text, `fixer:${job.id}:${visitTag(booking)}:stay-over-booking:${key}`));
      }
      this.urgentStayChanged(file, job, booking, notes);
    }
  }

  /** An urgent visit whose guest stay changed or left the calendar: the code is off for it, and the host hears why once, urgently. */
  private urgentStayChanged(file: FixerFile, job: Job, booking: Booking, notes: HostNote[]): void {
    const key = booking.urgentStay;
    if (!key || this.staysUnknown() || this.endOf(booking) <= this.deps.now().getTime()) return;
    if (this.crewStays(file).some((stay) => stay.kind === "stay" && stayKey(stay) === key)) return;
    const noted = `changed:${key}`;
    if (booking.stayNoted?.includes(noted)) return;
    (booking.stayNoted ??= []).push(noted);
    const text = urgentStayChangedNews({ proName: this.bookedName(file, job), from: booking.from, timeZone: this.timeZone() });
    notes.push(this.fileNews(file, { kind: "urgent-stay-changed", jobId: job.id, text, urgent: true }, `fixer:${job.id}:${visitTag(booking)}:urgent-stay-changed`));
  }

  /**
   * Asks the hub for the code, for the pro's phone, this job and this window. On connected locks it's
   * the pro's own code for this visit; the hub's notes (a backup code, the saved code) go to the host.
   * A refusal gives the host one note for the job, and nothing else.
   */
  private async openCode(file: FixerFile, job: Job, window: { from: string; until: string }, notes: HostNote[]): Promise<{ ok: true; code: string; lockLocation?: string; doors?: { door: string; code: string }[] } | { ok: false; reason: DoorRefusal }> {
    const phone = this.reachOfId(file, job, job.booking!.proId).phone!;
    const grant = await this.door().request({ person: phone, window, purpose: "repair", jobId: job.id, label: firstName(this.bookedName(file, job)) });
    for (const note of grant.notes ?? []) {
      if (!job.news.some((item) => item.kind === "lock" && item.text === note.text)) notes.push(this.news(job, "lock", note.text, `fixer:${job.id}:${note.id}`));
    }
    if (grant.ok && /^\d{4,8}$/.test(grant.code) && (grant.doors ?? []).every((door) => /^\d{4,8}$/.test(door.code))) {
      return { ok: true, code: grant.code, ...(grant.lockLocation ? { lockLocation: grant.lockLocation } : {}), ...(grant.doors ? { doors: grant.doors } : {}) };
    }
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
      // On connected locks with pros' codes on ask, the page shows "waiting for the host" until their OK.
      if (this.codeWaits(job)) return { ok: false, reason: "waiting-for-host" };
      const notes: HostNote[] = [];
      const opened = await this.openCode(file, job, check.window, notes);
      if (opened.ok) {
        const at = this.deps.now().toISOString();
        const revealed = (job.booking.revealedAt ??= []);
        revealed.push(at);
        markShown(job);
        this.visitLog()?.append({ type: "visit-page", id: `page:${job.id}:at-door:${at}`, at, visit: repairVisit(job.id), step: "at-door" });
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
    // A pro given a visit link uses the page for this visit, even after an extend or a revoke, so the code never goes two ways.
    if (booking.access !== "code" || booking.visitToken || booking.linkGivenAt || booking.visitRevokedAt) return;
    // The host was told the code won't go by text for this visit: texts turning on later doesn't change that.
    if (job.codeNoteAt) return;
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
    if (this.codeWaits(job)) return;
    job.codeTextAt = at;
    this.write(file);
    const opened = await this.openCode(file, job, check.window, notes);
    if (!opened.ok) return;
    (booking.revealedAt ??= []).push(at);
    markShown(job);
    this.write(file);
    const street = streetOf(this.hub().property().address ?? "");
    let sent = false;
    try {
      sent = (await this.deps.send!(phone, codeText({ proName, street, code: opened.code, ...(opened.lockLocation ? { lockLocation: opened.lockLocation } : {}), ...(opened.doors ? { doors: opened.doors } : {}), ...(job.crew ? { crewHours: crewHoursOf(job.crew) } : {}) }))) === true;
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
        // A routine vendor's visit nobody confirmed never starts: no code, no late news (#237).
        if (vendorWaiting(job)) {
          if (!file.offAt) this.vendorWaitPass(file, job, notes);
          continue;
        }
        if (job.state === "booked" && now >= Date.parse(booking.from)) job.state = "in-progress";
        if (!file.offAt) this.lockPass(file, job, notes);
        if (!file.offAt) await this.codeTextPass(file, job, notes);
        this.delayPass(file, job, notes);
      }
      if (!file.offAt) this.visitPass(file, notes);
      if (!file.offAt) await this.vendorPass(file, notes);
      // A done job's photos go 30 days after done, a cancelled job's 30 days after the cancel.
      prunePhotos(this.root, file.jobs.flatMap((job) => {
        const closedAt = job.done?.at ?? (job.state === "cancelled" ? job.cancelledAt : undefined);
        return closedAt ? [{ id: `fixer:${job.id}`, doneAt: closedAt }] : [];
      }), this.deps.now());
      if (JSON.stringify(file) !== before) this.write(file);
      await this.tell(notes);
    });
  }

  /** The property's visit log (#237), only while VISIT_RECORDS is on. */
  private visitLog(): VisitLog | undefined {
    const env = this.deps.env?.();
    return env && visitRecordsOn(env) ? visitLogFor(this.root, () => this.deps.now()) : undefined;
  }

  /** The last window written per visit, read once from the log. */
  private visitSigs?: Map<string, string>;

  /**
   * Visit records' pass (#237): writes each booked visit's window (one per workday for a crew) when it's set or
   * moved, and a cancel when it's called off; then, with a connected lock, one news line each for a pro or crew not
   * in by the start plus 30 minutes, and for a pro's code used outside their visit. Pros are never texted about it.
   * A failure here never stops the clock pass.
   */
  private visitPass(file: FixerFile, notes: HostNote[]): void {
    const log = this.visitLog();
    if (!log) return;
    try {
      if (!this.visitSigs) {
        this.visitSigs = new Map();
        for (const event of log.read()) {
          if (event.type === "visit-window") this.visitSigs.set(event.visit, visitSig(event));
          else if (event.type === "visit-cancelled") this.visitSigs.set(event.visit, "cancelled");
        }
      }
      const at = this.deps.now().toISOString();
      const live = new Set<string>();
      for (const job of file.jobs) {
        const booking = job.booking;
        if (!booking?.hostYes || !liveBooking(job) || vendorWaiting(job)) continue;
        const who = { role: "pro" as const, name: this.bookedName(file, job), proId: booking.proId };
        const windows: Omit<WindowEvent, "id" | "at">[] = job.crew
          ? crewWindows(job.crew, { ...this.occupyInput(file), stays: this.crewStays(file) }).windows.map((w) => ({ type: "visit-window", visit: crewVisit(job.id, w.day), kind: "crew-day", from: w.from, until: w.until, expectedAt: w.from, sameDay: false, who }))
          : [{ type: "visit-window", visit: repairVisit(job.id), kind: "repair", from: booking.from, until: booking.extendedUntil ?? booking.until, expectedAt: booking.from, sameDay: false, who }];
        for (const window of windows) {
          live.add(window.visit);
          const sig = visitSig(window);
          if (this.visitSigs.get(window.visit) === sig) continue;
          if (log.append({ ...window, id: `window:${window.visit}:${at}`, at })) this.visitSigs.set(window.visit, sig);
        }
      }
      // A visit whose job was cancelled or moved off a day is called off in the log.
      for (const [visit, sig] of this.visitSigs) {
        if (sig === "cancelled" || live.has(visit) || !(visit.startsWith("repair:") || visit.startsWith("crew:"))) continue;
        const job = file.jobs.find((entry) => entry.id === visit.split(":")[1]);
        if (job?.state === "done") continue;
        if (log.append({ type: "visit-cancelled", id: `cancel:${visit}:${at}`, at, visit })) this.visitSigs.set(visit, "cancelled");
      }
      const derived = buildVisits(log.read(), { timeZone: this.timeZone(), codeNames: log.codeNames(), now: this.deps.now() });
      const proName = (proId: string | undefined) => file.pros.find((pro) => pro.id === proId)?.name ?? "A pro";
      for (const item of fixerDue(derived, { now: this.deps.now(), timeZone: this.timeZone(), proName })) {
        const job = item.jobId ? file.jobs.find((entry) => entry.id === item.jobId) : undefined;
        if (job) {
          if (job.news.some((news) => news.kind === item.kind)) continue;
          notes.push(this.news(job, item.kind, item.text, `fixer:${job.id}:${item.kind}`));
        } else if (!(file.news ?? []).some((news) => news.kind === item.kind)) {
          notes.push(this.fileNews(file, { kind: item.kind, text: item.text }, `fixer:${item.kind}`));
        }
      }
    } catch {
      // The log is a record, not a gate.
    }
  }

  /** How many days past the due date a routine vendor's usual hours are looked for (#237). */
  private static readonly VENDOR_DAYS = 7;

  /**
   * Routine vendor visits (#237), on the clock pass with visit records on: for each upkeep item with a standing yes
   * whose lead time has opened, the vendor's usual hours on the first day from the due date that fits between stays
   * (up to 7 days later) become a booked visit under that yes, and the vendor is texted the proposal once. No code is
   * made until they confirm. When no day fits, the host hears once and the item is left to today's upkeep flow.
   */
  private async vendorPass(file: FixerFile, notes: HostNote[]): Promise<void> {
    const env = this.deps.env?.();
    if (!env || !visitRecordsOn(env) || this.staysUnknown()) return;
    const people = this.deps.people?.();
    const here = this.deps.propertyId;
    if (!people || !here) return;
    const tz = this.timeZone();
    const today = this.today();
    const now = this.deps.now();
    for (const item of file.upkeep) {
      const standing = item.standing;
      if (!standing) continue;
      const next = this.upkeepNext(file, item, tz);
      if (!next || today < next.leadStart) continue;
      const pro = file.pros.find((entry) => entry.id === standing.proId && entry.status === "saved");
      const phone = pro?.reach.phone;
      if (!pro || !phone || !pro.prefersText) continue;
      if (!people.optedIn(phone) || people.stopped(phone) || !people.rolesOn(phone, here).includes("pro") || holdsOtherRole(people, phone)) continue;
      if ((await this.deps.textsAllowed?.()) !== true) continue;
      const lastDay = addCalendarDays(next.nextDate, FixerDesk.VENDOR_DAYS);
      const draft: Job = { id: newId("job_", 10), trade: item.trade, what: item.what, source: "upkeep", sourceRef: item.id, photos: [], urgency: "by-date", byDate: lastDay, state: "booked", candidates: [], picked: [], contacts: [], news: [], createdAt: now.toISOString(), standingYes: { upkeepId: item.id, at: standing.yesAt } };
      let span: { from: string; until: string } | undefined;
      for (let ymd = next.nextDate; ymd <= lastDay && !span; ymd = addCalendarDays(ymd, 1)) {
        const candidate = { from: zonedInstant(ymd, standing.from, tz), until: zonedInstant(ymd, standing.until, tz) };
        if (Date.parse(candidate.from) <= now.getTime()) continue;
        const { holds } = await this.holdsFor(file, draft, candidate, standing.usualCents);
        if (holds.every((hold) => hold === "cost" || hold === "no-estimate")) span = candidate;
      }
      if (!span) {
        const kind = `vendor-no-day:${item.id}:${next.nextDate}`;
        if (!(file.news ?? []).some((entry) => entry.kind === kind)) notes.push(this.fileNews(file, { kind, text: vendorNoDayNews({ what: item.what, proName: pro.name }) }, `fixer:${kind}`));
        continue;
      }
      const at = now.toISOString();
      draft.hostGo = { at: standing.yesAt };
      draft.booking = {
        proId: pro.id,
        ...span,
        ...(standing.usualCents !== undefined ? { estimateCents: standing.usualCents } : {}),
        access: standing.access,
        hostYes: { at: standing.yesAt },
        fingerprint: bookingFingerprint({ proId: pro.id, ...span, ...(standing.usualCents !== undefined ? { estimateCents: standing.usualCents } : {}), access: standing.access }),
        vendor: { upkeepId: item.id, proposedAt: at },
      };
      file.jobs.push(draft);
      // Saved before the send, so a restart never proposes twice.
      this.write(file);
      const body = vendorProposal({ proName: pro.name, what: item.what, street: streetOf(this.hub().property().address ?? ""), when: visitWhen(span.from, span.until, tz) });
      let sent = false;
      try {
        sent = (await this.deps.send?.(phone, body)) === true;
      } catch {
        // Unknown: never sent again. The no-answer note tells the host.
      }
      if (sent) {
        draft.booking.vendor!.proposalSent = true;
        this.logVendorText(draft, "out", "window-proposed", body, phone);
      }
      this.write(file);
    }
  }

  /** The vendor's own routine visit a text is about: proposed and waiting, or confirmed and not over. The earliest first. */
  private vendorJobOf(file: FixerFile, proId: string): Job | undefined {
    const env = this.deps.env?.();
    if (!env || !visitRecordsOn(env)) return undefined;
    const now = this.deps.now().getTime();
    return file.jobs
      .filter((job) => job.booking?.vendor && job.booking.proId === proId && job.booking.hostYes && liveBooking(job) && !job.done && now < this.endOf(job.booking))
      .sort((a, b) => Date.parse(a.booking!.from) - Date.parse(b.booking!.from))[0];
  }

  /**
   * A routine vendor's text about their visit (#237). YES confirms a proposed visit. A time the parser reads moves it
   * when it fits between stays (at most 3 times by text), and is held for the host when it doesn't. On a proposed
   * visit, anything else is news on the job. True when it was handled here; false leaves it to the usual pro path
   * (DONE, a price, news) once the visit is confirmed.
   */
  private async vendorReply(file: FixerFile, job: Job, phone: string, text: string, sourceId: string): Promise<boolean> {
    const booking = job.booking!;
    const vendor = booking.vendor!;
    const waiting = !vendor.confirmedAt;
    const proName = this.bookedName(file, job);
    const tz = this.timeZone();
    const notes: HostNote[] = [];
    const reply = (body: string, label: string) => this.textVendor(file, job, body, label, sourceId);
    const span = isDone(text) ? undefined : parseVendorTime(text, { anchor: booking.from, timeZone: tz, now: this.deps.now() });
    const sameTime = span !== undefined && span.from === booking.from && span.until === booking.until;
    if (isYes(text) || sameTime) {
      if (!waiting) return sameTime;
      this.logVendorText(job, "in", "confirm", text, phone, sourceId);
      this.confirmVendor(booking);
      const when = visitWhen(booking.from, booking.until, tz);
      notes.push(this.news(job, "vendor-confirmed", vendorConfirmedNews({ proName, what: job.what, when }), `fixer:${job.id}:vendor-confirmed`));
      this.write(file);
      await this.tell(notes);
      await reply(vendorConfirmed({ when, access: booking.access }), "confirmed");
      return true;
    }
    if (span) {
      this.logVendorText(job, "in", "move", text, phone, sourceId);
      const moved = await this.moveVendor(file, job, span, "vendor", notes);
      this.write(file);
      await this.tell(notes);
      const when = visitWhen(booking.from, booking.until, tz);
      if (moved === "moved") await reply(vendorMoved({ when, access: booking.access }), "move-echo");
      else if (moved === "held") await reply(VENDOR_ASKING_HOST, "move-held");
      else if (moved === "taken") await reply(vendorTimeTaken({ street: streetOf(this.hub().property().address ?? "") }), "move-taken");
      return true;
    }
    if (!waiting) return false;
    // Anything else on a proposed visit (a no, a question) is the host's to read, with digit runs taken out.
    this.logVendorText(job, "in", "other", text, phone, sourceId);
    if (!text) return true;
    notes.push(this.news(job, "pro-text", proTextNews({ proName, text: redactDigits(text).slice(0, 300).trim() }), `fixer:${job.id}:pro-text:${sourceId}`));
    this.write(file);
    await this.tell(notes);
    return true;
  }

  /** Texts a routine vendor about their visit, on the consent-checked path, and logs it once sent. */
  private async textVendor(file: FixerFile, job: Job, body: string, label: string, sourceId: string): Promise<void> {
    const phone = this.reachOfId(file, job, job.booking!.proId).phone;
    const people = this.deps.people?.();
    if (!phone || !people?.optedIn(phone) || people.stopped(phone) || (await this.deps.textsAllowed?.()) !== true) return;
    let sent = false;
    try {
      sent = (await this.deps.send?.(phone, body)) === true;
    } catch {
      // Unknown: not sent again.
    }
    if (sent) this.logVendorText(job, "out", label, body, phone, `${sourceId}:${label}`);
  }

  /**
   * The agent enters a routine vendor's new time, from the vendor's own words (#237). A time that fits moves the
   * visit at once; one outside the open times takes the host's two-call yes; a stay over it is always refused. The
   * vendor is texted what was set. Never returns a code.
   */
  moveVendorVisit(input: { jobId?: string; from?: string; until?: string; confirmation?: string }): Promise<FixerReply> {
    return this.guarded(input, async () => {
      const file = this.read();
      const off = this.inactive(file);
      if (off) return off;
      const job = this.jobOf(file, input.jobId);
      const booking = job?.booking;
      if (!job || !booking?.vendor || !booking.hostYes || !liveBooking(job) || job.done) return fail("That isn't a routine vendor's visit that's still to come. Use reschedule_job for other visits.");
      const from = Date.parse(input.from ?? "");
      const until = Date.parse(input.until ?? "");
      if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from) return fail("Give from and until as ISO times, until after from.");
      if (until - from > MAX_VENDOR_HOURS * HOUR_MS) return fail(`A routine visit can be at most ${MAX_VENDOR_HOURS} hours.`);
      if (from <= this.deps.now().getTime()) return fail("That time has already started.");
      const span = { from: new Date(from).toISOString(), until: new Date(until).toISOString() };
      const { holds } = await this.holdsFor(file, job, span, booking.estimateCents);
      if (holds.includes("overlaps-stay")) return fail("That time is over a stay, so it can't be booked. Ask the vendor for another time.");
      const proName = this.bookedName(file, job);
      const when = visitWhen(span.from, span.until, this.timeZone());
      let by: "agent" | "host" = "agent";
      if (holds.includes("outside-window")) {
        const gate = this.confirm("fixer-vendor-move", job.id, tokenHash(JSON.stringify([span, booking.fingerprint])), input.confirmation, vendorHeldQuestion({ proName, what: job.what, when }));
        if (gate !== "go") return gate;
        by = "host";
      }
      const notes: HostNote[] = [];
      const result = await this.moveVendor(file, job, span, by, notes);
      this.write(file);
      // The host's own yes needs no line back to them; the agent's entry does.
      await this.tell(by === "host" ? [] : notes);
      if (result !== "held") await this.textVendor(file, job, vendorMoved({ when, access: booking.access }), "move-echo", `move:${job.id}:${span.from}`);
      return ok({ moved: true, jobId: job.id, from: booking.from, until: booking.until, next: `${proName} was texted the new time.` });
    });
  }

  /** The vendor confirmed: from here their code may exist, and the standing yes is the host's OK for it (#237). */
  private confirmVendor(booking: Booking): void {
    const at = this.deps.now().toISOString();
    booking.vendor!.confirmedAt ??= at;
    if (booking.access === "code") booking.codeYes ??= { at };
  }

  /**
   * Moves a routine vendor's visit in place when the new time passes the booking gate (a cost hold aside: the
   * standing yes covers the usual price), so the lock sync moves their code rather than making a new one. A time
   * that doesn't fit, or a fourth move by text, is held for the host. A stay over the time is never moved into.
   */
  private async moveVendor(file: FixerFile, job: Job, span: { from: string; until: string }, by: "vendor" | "agent" | "host", notes: HostNote[]): Promise<"moved" | "held" | "taken" | "same"> {
    const booking = job.booking!;
    const vendor = booking.vendor!;
    if (span.from === booking.from && span.until === booking.until) {
      if (!vendor.confirmedAt) this.confirmVendor(booking);
      return "same";
    }
    const { holds } = await this.holdsFor(file, job, span, booking.estimateCents);
    const fits = holds.every((hold) => hold === "cost" || hold === "no-estimate") && Date.parse(span.from) > this.deps.now().getTime();
    const vendorMoves = (vendor.moves ?? []).filter((move) => move.by === "vendor").length;
    const tooMany = by === "vendor" && vendorMoves >= MAX_VENDOR_MOVES;
    const proName = this.bookedName(file, job);
    const when = visitWhen(span.from, span.until, this.timeZone());
    if (by === "vendor" && holds.includes("overlaps-stay")) {
      // Never bookable, so never the host's question: the vendor is asked for another time, and the host told.
      notes.push(this.news(job, `vendor-taken:${span.from}`, vendorTakenNews({ proName, when }), `fixer:${job.id}:vendor-taken:${span.from}`));
      return "taken";
    }
    if (by === "vendor" && (!fits || tooMany)) {
      vendor.held = { ...span, at: this.deps.now().toISOString() };
      const question = tooMany && fits ? vendorTooManyQuestion({ proName, what: job.what, when, moves: vendorMoves }) : vendorHeldQuestion({ proName, what: job.what, when });
      notes.push(this.news(job, `vendor-held:${span.from}`, question, `fixer:${job.id}:vendor-held:${span.from}`));
      return "held";
    }
    const at = this.deps.now().toISOString();
    booking.from = span.from;
    booking.until = span.until;
    delete booking.extendedUntil;
    delete booking.extendNoted;
    // A visit link is a key for the old time: a move ends it, as a rebook does.
    delete booking.visitToken;
    booking.fingerprint = bookingFingerprint({ proId: booking.proId, from: span.from, until: span.until, ...(booking.estimateCents !== undefined ? { estimateCents: booking.estimateCents } : {}), access: booking.access });
    (vendor.moves ??= []).push({ at, ...span, by });
    // The host's own yes to a new time is theirs in the hours log, like a reschedule.
    if (by === "host") (job.reschedules ??= []).push({ at, reason: "the vendor's new time" });
    delete vendor.held;
    this.confirmVendor(booking);
    if (job.state === "in-progress" && Date.parse(span.from) > Date.parse(at)) job.state = "booked";
    notes.push(this.news(job, `vendor-moved:${span.from}`, vendorMovedNews({ proName, what: job.what, when }), `fixer:${job.id}:vendor-moved:${span.from}`));
    return "moved";
  }

  /** One message line in the visit log about a vendor's visit, when visit records are on. */
  private logVendorText(job: Job, direction: "in" | "out", label: string, body: string, phone: string, sourceId?: string): void {
    const log = this.visitLog();
    if (!log) return;
    const at = this.deps.now().toISOString();
    try {
      log.append({ type: "message", id: messageEventId(direction, sourceId ?? `vendor:${job.id}:${label}:${at}`), at, direction, role: "pro", personKey: log.personKey(phone), visit: repairVisit(job.id), label, body });
    } catch {
      // The log is a record, not a gate.
    }
  }

  /** A proposed visit the vendor hasn't confirmed: one note when 48 hours are left, or at once if fewer were. */
  private vendorWaitPass(file: FixerFile, job: Job, notes: HostNote[]): void {
    const booking = job.booking!;
    const vendor = booking.vendor!;
    const now = this.deps.now().getTime();
    if (now >= this.endOf(booking)) {
      // Never confirmed by its end: called off, so the upkeep's next date can come due.
      job.state = "cancelled";
      job.cancelledAt = new Date(now).toISOString();
      job.cancelReason = "The vendor never confirmed.";
      notes.push(this.news(job, "vendor-called-off", vendorCalledOffNews({ proName: this.bookedName(file, job), what: job.what, when: visitWhen(booking.from, booking.until, this.timeZone()) }), `fixer:${job.id}:vendor-called-off`));
      return;
    }
    if (vendor.noAnswerAt) return;
    const from = Date.parse(booking.from);
    const proposed = Date.parse(vendor.proposedAt);
    // Ask by 48 hours before, but give the vendor at least a day when the proposal went later than that.
    const askAt = Math.max(from - 48 * HOUR_MS, Math.min(proposed + 24 * HOUR_MS, from));
    if (now < askAt) return;
    vendor.noAnswerAt = new Date(now).toISOString();
    notes.push(this.news(job, "vendor-no-answer", vendorNoAnswerNews({ proName: this.bookedName(file, job), what: job.what, when: visitWhen(booking.from, booking.until, this.timeZone()) }), `fixer:${job.id}:vendor-no-answer`));
  }

  /**
   * A vendor's completed-service email, as the host's agent received it (#237): kept append-only with every code the
   * property knows and every digit run taken out, matched to the visit by the job given, else by the sender's address
   * and the service date, and linked in the visit log. Evidence only: it never sets a time. Off until the host turns
   * service notices on. The reply never repeats the body.
   */
  saveServiceNotice(input: { jobId?: string; email?: Partial<ServiceNoticeInput> }): Promise<FixerReply> {
    return this.guarded(input, () => {
      const file = this.read();
      const off = this.inactive(file);
      if (off) return off;
      const log = this.visitLog();
      if (!log || !file.settings.serviceNotices) return fail("Service notices aren't on for this property. The host turns them on with save_fixer_settings.");
      const email = input.email;
      if (!email || typeof email.from !== "string" || typeof email.subject !== "string" || typeof email.body !== "string" || !email.body.trim()) return fail("Pass the email as received: from, subject and body.");
      if (email.body.length > MAX_NOTICE_BODY || email.subject.length > 500 || email.from.length > 300) return fail("That email is too long to keep.");
      const now = this.deps.now();
      const receivedAt = email.receivedAt && Number.isFinite(Date.parse(email.receivedAt)) ? new Date(email.receivedAt).toISOString() : now.toISOString();
      let codes: string[] = [];
      try {
        codes = this.door().codesForChecksAll();
      } catch {
        // No key: digit runs still go.
      }
      const body = cleanNoticeText(email.body, codes);
      const subject = cleanNoticeText(email.subject, codes);
      const from = cleanNoticeText(email.from, codes).slice(0, 300);
      const messageId = typeof email.messageId === "string" && email.messageId.length <= 300 ? cleanNoticeText(email.messageId, codes) : undefined;
      const hash = noticeHash(body);
      const kept = readServiceNotices(this.root);
      const base = { at: now.toISOString(), receivedAt, ...(messageId ? { messageId } : {}), from, subject, bodyHash: hash };
      if (kept.some((record) => record.outcome !== "duplicate" && ((messageId && record.messageId === messageId) || record.bodyHash === hash))) {
        appendServiceNotice(this.root, { ...base, outcome: "duplicate" });
        return ok({ saved: false, duplicate: true });
      }
      const tz = this.timeZone();
      const dates = noticeDates(`${email.subject}\n${email.body}`, receivedAt, tz);
      const job = this.noticeJob(file, input.jobId, senderAddress(email.from), dates, receivedAt);
      if (input.jobId && !job) return fail("There's no visit with that job id.");
      const visitDay = job?.booking ? localYmd(new Date(job.booking.from), tz) : undefined;
      const serviceDate = dates.find((date) => visitDay && Math.abs(Date.parse(date) - Date.parse(visitDay)) <= 86_400_000) ?? dates[0];
      appendServiceNotice(this.root, { ...base, body, ...(job ? { jobId: job.id } : {}), ...(serviceDate ? { serviceDate } : {}), outcome: job ? "matched" : "unmatched" });
      if (job) log.append({ type: "service-notice", id: `notice:${hash}`, at: receivedAt, visit: job.crew ? crewVisit(job.id, visitDay!) : repairVisit(job.id), notice: hash, ...(serviceDate ? { serviceDate } : {}) });
      return ok({ saved: true, matched: Boolean(job), ...(job ? { jobId: job.id } : {}), ...(serviceDate ? { serviceDate } : {}), ...(job ? {} : { next: "It's kept, but no visit matched it. Pass jobId if you know which visit it was." }) });
    });
  }

  /** The visit a notice is about: the job given; else a visit by the pro with the sender's address, on or a day either side of a date it names; else that pro's visit done in the 3 days before it arrived. */
  private noticeJob(file: FixerFile, jobId: string | undefined, sender: string, dates: readonly string[], receivedAt: string): Job | undefined {
    if (jobId) return file.jobs.find((job) => job.id === jobId && job.booking);
    const pros = file.pros.filter((pro) => pro.status === "saved" && pro.reach.email && pro.reach.email.toLowerCase() === sender);
    if (pros.length === 0) return undefined;
    const tz = this.timeZone();
    const visits = file.jobs.filter((job) => job.booking && pros.some((pro) => pro.id === job.booking!.proId) && job.state !== "cancelled");
    const near = (date: string, job: Job) => Math.abs(Date.parse(date) - Date.parse(localYmd(new Date(job.booking!.from), tz))) <= 86_400_000;
    const byDate = visits.filter((job) => dates.some((date) => near(date, job)));
    if (byDate.length > 0) return byDate.sort((a, b) => Date.parse(b.booking!.from) - Date.parse(a.booking!.from))[0];
    const got = Date.parse(receivedAt);
    return visits
      .filter((job) => job.done && Date.parse(job.done.at) <= got && got - Date.parse(job.done.at) <= 3 * 86_400_000)
      .sort((a, b) => Date.parse(b.done!.at) - Date.parse(a.done!.at))[0];
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
    if (revised && (revised.hostYes || !raisedPriceHeld(job.costLineCents, booking.estimateCents, revised.cents))) return revised.cents;
    return booking?.estimateCents;
  }

  /** Logs the amount. Over the cost line, or more than 20% over what was expected, the host is told once. */
  private logCost(file: FixerFile, job: Job, cents: number, by: "pro" | "agent" | "host", note: string | undefined, notes: HostNote[]): void {
    job.cost = { cents, by, at: this.deps.now().toISOString(), ...(note ? { note } : {}) };
    if (by === "host") noteHostStep(job, { kind: "record-cost", at: job.cost.at, cents });
    const line = job.costLineCents;
    const estimateCents = this.expectedCents(file, job);
    if (job.news.some((item) => item.kind === "cost-over") || !costNews(line, estimateCents, cents)) return;
    notes.push(this.news(job, "cost-over", costNewsText({ proName: this.bookedName(file, job), cents, ...(estimateCents !== undefined ? { estimateCents } : {}), ...(line !== undefined ? { costLineCents: line } : {}) })));
  }

  /** A live job becomes done. The questions after the visit start here: the preferred list first. */
  protected finishJob(file: FixerFile, job: Job, by: NonNullable<Job["done"]>["by"], note: string | undefined, notes: HostNote[]): void {
    const at = this.deps.now().toISOString();
    job.state = "done";
    job.done = { at, by, ...(note ? { note } : {}) };
    if (by === "host") noteHostStep(job, { kind: "confirm-repair", at });
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
    if (!booking || !liveBooking(job) || !revised || revised.hostYes || !raisedPriceHeld(job.costLineCents, booking.estimateCents, revised.cents)) return undefined;
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
    if (raisedPriceHeld(job.costLineCents, old, cents)) {
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
      if (overlapsStay({ from: booking.from, until }, this.crewStays(file).filter((stay) => stayKey(stay) !== booking.urgentStay), this.occupyInput(file))) {
        return fail(`That runs into the next check-in, or the ${file.settings.checkInBufferMinutes} minutes kept free before it. Pick an earlier time.`);
      }
      if (booking.urgentStay) {
        const limit = urgentVisitHolds({ window: { from: booking.from, until }, stays: this.crewStays(file), times: this.occupyInput(file), hostYes: booking.hostYes }).find((hold) => hold === "spans-checkout" || hold === "too-long");
        if (limit) return fail(urgentRefusal(limit, { proName: this.bookedName(file, job) }));
      }
      const proName = this.bookedName(file, job);
      const gate = this.confirm("fixer-extend", job.id, tokenHash(JSON.stringify([booking.fingerprint, until])), input.confirmation, extendQuestion({ proName, until, timeZone: this.timeZone() }));
      if (gate !== "go") return gate;
      booking.extendedUntil = until;
      // The old visit link ends, a revoked one too; visit_link gives a new one.
      delete booking.visitToken;
      delete booking.visitRevokedAt;
      this.write(file);
      return ok({ extended: true, jobId: job.id, until, tellPro: { name: proName, reach: this.reachOfId(file, job, booking.proId) }, next: `Tell ${proName} the new end. If they use the visit page, their old link has ended: call visit_link for a new one.${booking.urgentStay ? " The door code stops at the time the guest agreed to: ask the guest for the extra time and call record_guest_answer with yes." : ""}` });
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
    // and the host just saved has a new pro id, so the booking's id counts as that pro too (only when
    // the booking's id is a candidate's, never another saved pro's).
    const preferred = (proId: string) => {
      const candidate = proId === job.booking?.proId && !file.pros.some((entry) => entry.id === proId);
      const saved = proId === pro?.id || (pro && candidate) ? pro : file.pros.find((entry) => entry.id === proId);
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
      booking.linkGivenAt ??= this.deps.now().toISOString();
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
      ...(raised ? { raised: { cents: raised.cents, waiting: !raised.hostYes && raisedPriceHeld(job.costLineCents, booking.estimateCents, raised.cents) } } : {}),
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
      const doneAt = job.done!.at;
      this.visitLog()?.append({ type: "visit-page", id: `page:${job.id}:done:${doneAt}`, at: doneAt, visit: repairVisit(job.id), step: "done" });
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
      // A pro found for a job and contacted on it: the job they were asked about, the latest contact first.
      const asked = read ? this.contactedJob(read, input.from) : undefined;
      const proName = pro?.name ?? asked?.name ?? "A pro";
      who = proName;
      if (injury) return this.injury(read, input.from, proName, id);
      const file = read!;
      const keyword = keywordOf(text);
      if (keyword === "stop" || isPlainLanguageStop(text)) return people.relay(people.stop(input.from));
      if (keyword === "help") return;
      if (keyword === "start") return people.relay(people.start(input.from));
      // A routine vendor's YES or new time for their own proposed or upcoming visit (#237), from their own opted-in phone.
      const vendorJob = pro && !this.inactive(file) && people.optedIn(input.from) && !people.stopped(input.from) ? this.vendorJobOf(file, pro.id) : undefined;
      if (vendorJob && (await this.vendorReply(file, vendorJob, input.from, text, id))) return;
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
      if (target) {
        const log = this.visitLog();
        log?.append({
          type: "message",
          id: messageEventId("in", id),
          at: this.deps.now().toISOString(),
          direction: "in",
          role: "pro",
          personKey: log.personKey(input.from),
          visit: repairVisit(target.id),
          label: isDone(text) && agreed ? "done" : "other",
          body: text,
        });
      }
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
      const about = target ?? asked?.job;
      if (about) {
        const fresh = this.read();
        const job = fresh.jobs.find((entry) => entry.id === about.id);
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
   * A pro's voicemail, from Twilio's transcript. It is news for the host and nothing else: no keyword in it
   * opts anyone in or out, finishes a visit, or raises a price. An injury makes it urgent. A recording
   * seen before is ignored.
   */
  proVoicemail(input: { id: string; from: string; text: string; status: "completed" | "failed"; seconds?: number }): Promise<void> {
    return this.serial(async () => {
      const people = this.deps.people?.();
      const here = this.deps.propertyId;
      if (!people || !here || !input.from || !input.id) return;
      if (!people.rolesOn(input.from, here).includes("pro") || holdsOtherRole(people, input.from)) return;
      const file = this.read();
      if (file.seenInbound?.includes(input.id)) return;
      file.seenInbound = [...(file.seenInbound ?? []), input.id].slice(-200);
      const pro = file.pros.find((entry) => entry.status === "saved" && entry.reach.phone === input.from);
      const asked = this.contactedJob(file, input.from);
      const proName = pro?.name ?? asked?.name ?? "A pro";
      const now = this.deps.now().getTime();
      const visit = pro && !this.inactive(file) ? file.jobs.find((job) => job.booking?.proId === pro.id && job.booking.hostYes && liveBooking(job) && (job.state === "in-progress" || now >= Date.parse(job.booking.from))) : undefined;
      const job = visit ?? asked?.job;
      const words = redactDigits(input.text).trim().slice(0, VOICEMAIL_MAX);
      const short = input.seconds !== undefined && input.seconds < 2;
      const text = proVoicemailNews({ proName, ...(input.status === "failed" ? { failed: true } : {}), ...(words && !short ? { text: words } : {}) });
      const id = `fixer:pro-voicemail:${input.id}`;
      const urgent = input.status === "completed" && isInjuryReport(input.text);
      const note = urgent || !job ? this.fileNews(file, { kind: "pro-voicemail", text, ...(job ? { jobId: job.id } : {}), ...(urgent ? { urgent: true } : {}) }, id) : this.news(job, "pro-voicemail", text, id);
      this.write(file);
      await this.tell([note]);
    });
  }

  /** The open job a phone was contacted on, latest first, with the name it was saved under there. */
  private contactedJob(file: FixerFile, phone: string): { job: Job; name: string } | undefined {
    let best: { job: Job; name: string; at: string } | undefined;
    for (const job of file.jobs) {
      if (!isOpen(job)) continue;
      for (const contact of job.contacts) {
        if (contact.cancelled || this.reachOfId(file, job, contact.to).phone !== phone) continue;
        if (!best || contact.at > best.at) best = { job, name: this.nameOf(file, job, contact.to) ?? "A pro", at: contact.at };
      }
    }
    return best && { job: best.job, name: best.name };
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

/** What a visit window says, so the same window isn't written twice. */
function visitSig(window: Pick<WindowEvent, "from" | "until" | "expectedAt" | "who">): string {
  return JSON.stringify([window.from, window.until, window.expectedAt, window.who.name, window.who.proId ?? null]);
}
