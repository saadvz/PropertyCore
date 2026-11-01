import { openPin, pinKeyFor, sealPin, type PinSeal } from "./pinSeal";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isPlainLanguageStop, keywordOf } from "../intent";
import { normalize, stripFiller } from "../intent/normalize";
import { spokenTimes } from "../core/spokenTime";
import { parsePhone } from "../core/phone";
import { smsStopAck } from "../visitor/smsConsent";
import { writeFileAtomic } from "../storage/atomicWrite";
import { addCalendarDays, formatWhen, interpretFeed, zonedInstant, type FeedBlock, type Turnover } from "./calendar";
import { isInjuryReport } from "./injury";
import { isScratchTestNumber } from "./scratch";
import { applyOnboardingAnswer, beginOnboarding, type OnboardingPreview, type OnboardingSession } from "./onboarding";
import {
  BOOKING_SOURCE_KINDS,
  normalizeSnapshots,
  readNotionFixture,
  type BookingSource,
  type BookingSourceKind,
  type JobProvenance,
  type NormalizedSources,
  type SourceConflict,
  type SourceSnapshot,
} from "./sources";
import { fingerprintOf, freshnessOf, GUESTY_POLL_MS, staleAfterMs, type SourceRecord } from "./freshness";
import { containsCodeToken, redactLine, redactPhone } from "./redact";
import { waitingForYesNote, withoutStopAsk, addressCleaner, asOptedInCleaner, checklistBody, cleanerNextStep, cleanerOptOutHold, doorCodeBody, groupDoorCodeBody, groupIntroBody, groupInviteBody, groupUnconfirmedLine, groupRefusedLine, groupOfferBody, namedAsk, hostDoneLine, hostStartReply, hostStopReply, injuryHoldLine, isPrivateCodeLine, jobHoldLine, offerBody, offerForOthers, optedOutCodeLine, ownerOptOutHoldNote, PHOTO_FIRST, privateCodeLine, reminderBody, resumeNote, usualTimesAsk, arrivalReminderBody, hostNoteOf, withHostNote, type CleanerStep, type OptedInCleaner } from "./cleanerTexts";
import { codeRoute, GroupNotConfirmed, type GroupSeat } from "./groupThread";
import { GROK_HELPER } from "./assistant";
import { codeHandlingText, HEALTH_NOTE, isReviewKind, reviewAlert, reviewId, type AuditEvent, type ReviewDetail, type ReviewItem, type ReviewKind } from "./review";
import { mirrorStore, restoreTenantSlice, snapshotStore } from "./sqliteStore";
import { isOtherScratchTenantPhone, SCRATCH_TENANTS } from "./tenants";

export type TextKind =
  | "host-checkout"
  | "host-checkin"
  | "offer"
  /** The first text in the group, once two people have joined. */
  | "intro"
  | "corrected"
  | "cancel-update"
  | "reminder"
  | "confirm"
  | "declined"
  | "stop"
  | "help"
  | "start"
  | "emergency"
  | "opt-in"
  | "pin"
  | "pin-notice"
  | "pin-failed"
  | "pin-held"
  | "started"
  | "done"
  | "next"
  | "held"
  | "review"
  | "resume"
  /** The host's own message, sent only after the host approved its exact text. */
  | "host-message"
  /** The host's saved checklist, to the cleaner after the private code. */
  | "checklist";

export interface CleanerText {
  to: string;
  body: string;
  kind: TextKind;
  /** Set when the text is a group thread or a mirrored copy. A private text omits it. */
  channel?: "group" | "mirror";
  /** Phones in a group thread. Omitted on a private text. */
  audience?: string[];
}

export type JobStatus =
  | "discovered"
  | "awaiting_checkin"
  | "host_confirmed"
  | "offered"
  | "confirmed"
  | "awaiting_departure"
  | "cleared"
  | "in_progress"
  | "done"
  | "declined"
  | "canceled";

export interface JobView {
  id: string;
  departingUid: string;
  arrivingUid: string | null;
  status: JobStatus;
  live: boolean;
  textsBlocked: boolean;
  checkoutDate: string;
  nextCheckInDate: string | null;
  sameDay: boolean;
  checkoutTime: string | null;
  nextCheckInTime: string | null;
  checkoutAt: string | null;
  nextCheckInAt: string | null;
  version: number;
  hostCheckoutVersion: number;
  hostCheckInVersion: number;
  asking: "checkout" | "checkin" | null;
  /** The cleaner's arrival time Grok saved, like 11:30 AM. Absent until one is saved. */
  arrivalTime?: string;
  /** When the cleaning started (START or the cleaner's first message after the code), as an instant. */
  startedAt?: string;
  /** When the cleaner's DONE was taken, as an instant. */
  doneAt?: string;
  /** Photos the cleaner sent during the cleaning, counted when they arrive. */
  photos?: number;
  /** Of those, the photos downloaded and kept, which get_job_photos can link to. */
  photosSaved?: number;
  /** The cleaner's notes during the cleaning, redacted. */
  notes?: string[];
  /** The checklist items the cleaner was sent. */
  checklist?: string[];
}

export interface OutboxView {
  id: string;
  to: string;
  body: string;
  kind: TextKind;
  status: "sent" | "failed" | "canceled" | "uncertain" | "unsent";
  jobId?: string;
  /** Posted to the group, not texted one-to-one. */
  group?: true;
}

export interface Counters {
  sent: number;
  failed: number;
  uncertain: number;
  canceled: number;
  injury: number;
  stop: number;
  help: number;
  polls: number;
  pollFails: number;
  pollDurationMs: number;
}

export interface HealthReport {
  ok: true;
  sends: false;
  note: string;
  openReviews: number;
  staleSources: number;
  counters: Counters;
  codeHandling: string;
}

export class HaltError extends Error {
  constructor(readonly point: "after-accept" | "before-pin") {
    super(`Halted at ${point}`);
    this.name = "HaltError";
  }
}

export interface PollResult {
  polled: boolean;
  reason: "disabled" | "scratch-only" | "not-consented" | "read" | "wrong-tenant" | "permission-denied";
  sent: CleanerText[];
  jobs: JobView[];
  blocks: FeedBlock[];
}

export interface SourceFreshness {
  kind: BookingSourceKind;
  fetchedAt: string | null;
  stale: boolean;
}

/** A saved source: its id and, for a calendar link, a hash of the link it reads. Never the link. */
export interface SourceClaim {
  id: string;
  origin?: string;
}

export interface SyncState {
  reason: PollResult["reason"];
  conversation: "closed" | "open";
  /** Source ids the engine holds a snapshot for, in dedupe order. */
  sources: string[];
  conflicts: SourceConflict[];
  fallback?: string;
  freshness?: SourceFreshness[];
  provenance?: JobProvenance[];
}

export interface MessagingView {
  requested: "cleaner-only" | "group";
  actual: "cleaner-only" | "native" | "mirrored";
  excluded: string[];
  note?: string;
}

export interface SetupView {
  activated: boolean;
  step: string;
  tenantId: string;
  address: string;
  prompt: string;
  prompts: string[];
  sealed: boolean;
}

export interface SetupResult {
  handled: boolean;
  reason: ReceiveReason | "onboarding";
  sent: CleanerText[];
  setup: SetupView;
}

export type ReceiveReason =
  | "disabled"
  | "duplicate"
  | "help"
  | "emergency"
  | "stop"
  | "start"
  | "scheduled"
  | "declined"
  | "ignored"
  | "scratch-only"
  | "host-time"
  | "departure"
  | "opted-in"
  | "done"
  | "wrong-tenant"
  | "review"
  | "held"
  | "stood-down"
  | "retry";

/** What Cleaner Core did with an inbound text, for Grok to read beside the message. */
export type MessageHandled = "opted-in" | "confirmed" | "declined" | "done" | "stop" | "start" | "injury" | "code-held" | "none" | "sent";

export interface ReceiveResult {
  handled: boolean;
  reason: ReceiveReason;
  sent: CleanerText[];
  /** Set only when `grokReadsMessages` is on. */
  outcome?: MessageHandled;
}

export interface ReminderResult {
  sent: CleanerText[];
  failed: string[];
}

export interface CleanerSink {
  send(text: CleanerText): void | Promise<void>;
}

export interface ReminderTrigger {
  id: string;
  kind: "morning-of" | "days-before-checkout";
  localTime: string;
  days?: number;
  /** Trigger ids whose reminder, once sent for the same checkout, counts as this one. */
  replaces?: string[];
}

/**
 * When a job's first offer may go to the cleaner. It only ever holds the offer: the offer still
 * waits for the host's confirmed times, the opt-in, and every other gate.
 */
export type OfferTrigger =
  | { kind: "when-confirmed" }
  | { kind: "days-after-check-in"; days: number; localTime: string }
  | { kind: "days-before-checkout"; days: number; localTime: string };

export interface CleanerCoreOptions {
  enabled: boolean;
  property: { id: string; address: string; timeZone: string; defaultCheckout?: string; defaultCheckIn?: string };
  /** Host who confirms times and receives the schedule text. */
  ownerPhone: string;
  /** Approved cleaner. The door code is a private text to this number, and only after opt-in and departure. */
  cleaner: { phone: string; approved: boolean };
  /** Standing door code. Absent means this engine never texts one. */
  pin?: string;
  /** Where the lock is, named in the private door-code text. Never a code. */
  lockLocation?: string;
  /** Name in the cleaner opt-in text. */
  hostName?: string;
  /** Numbers that share a group thread. They never receive the door code. */
  groupPhones?: string[];
  /** Landlord already approved texting this owner. A phone number alone is not consent. */
  consented?: boolean;
  sink: CleanerSink;
  now?: () => Date;
  triggers?: ReminderTrigger[];
  /**
   * When set, the first offer waits for this trigger and for the end of quiet hours, and
   * runReminders sends it once it is due. Unset keeps the offer right after the times are confirmed.
   */
  offerTrigger?: OfferTrigger;
  /** The reminder names the checkout and asks the cleaner for an arrival time. */
  reminderAsksArrival?: boolean;
  /**
   * The property's name in the new-booking question. When set, the question names the stay and
   * offers the usual checkout and check-in times. Set it only when both usual times are saved.
   */
  usualTimesName?: string;
  /** When set, jobs and the outbox reload after a process restart. */
  dataDir?: string;
  /** Scratch tenant id. Other Scratch tenants' phones are ignored and never texted. */
  tenantId?: string;
  /** Host asked for a group. The engine decides native, mirrored, or cleaner-only. */
  messaging?: {
    requested: "cleaner-only" | "group";
    capable: boolean;
    participants: { phone: string; role: "owner" | "manager" | "observer" | "cleaner"; approved?: boolean }[];
  };
  /**
   * Local quiet window. Overnight windows wrap. Reminders wait. The door code does not.
   * null means none, and a window stored by an earlier run is ignored. Unset keeps a stored window.
   */
  quietHours?: { from: string; until: string } | null;
  /** This tenant was created by onboarding and must not see Lane or Court phones. */
  isolate?: boolean;
  /** Set when publishing an onboarded tenant. */
  origin?: "onboarding";
  /** Milliseconds after the last successful fetch before the turn is STALE_SOURCE. Default is three missed hourly polls. */
  staleAfterMs?: number;
  /** Record a fetch time on Guesty Lite polls that do not carry one. */
  watchFreshness?: boolean;
  /** Mirror the redacted store into SQLite and allow backup. */
  sqlite?: boolean;
  /** Crash point. after-accept leaves an offer uncertain. before-pin saves clearance and does not send the code. */
  halt?: "after-accept" | "before-pin";
  /** When set, a poll older than one Guesty Lite interval writes a scheduled snapshot here. */
  backupDir?: string;
  /** Live texts go only to these numbers, or to the numbers this check passes. Scratch fixtures leave this unset and keep the 555 lock. */
  allowlist?: readonly string[] | ((phone: string) => boolean);
  /** When this returns true, the sink is not called and nothing is recorded as sent. */
  holdSends?: () => boolean;
  /** Hold the cleaner opt-in and the offer until the host has confirmed both times. */
  deferCleanerTexts?: boolean;
  /** Opt-in sentence. Unset keeps the Scratch scheduler sentence. */
  optInBody?: string;
  /** STOP sentence. Unset keeps the shared acknowledgement. */
  stopReply?: string;
  /** A cleaner STOP also texts the host that the job is on hold. */
  noteHostOnStop?: boolean;
  /** Used only when this tenant has no saved consent yet. A stored choice wins. */
  cleanerConsent?: "pending" | "in" | "out";
  /** Host already texted STOP before this store existed. A saved choice wins. */
  ownerOptedOut?: boolean;
  /** Live chat keeps the seal outside this store. Scratch fixtures seal here. */
  sealPinAtRest?: boolean;
  /** Host sentence after the private text is accepted. Unset keeps the fixture sentence. */
  pinSentBody?: string;
  /** Host sentence when the private text fails. Unset keeps the fixture sentence. */
  pinFailedBody?: string;
  /**
   * Grok reads every inbound text. A cleaner text that is not a keyword (YES, NO, DONE, STOP,
   * START, HELP) gets no generic guide reply, and receive reports what it did as `outcome`.
   * Unset keeps the guide reply for the Scratch CLI and the smoke runs.
   */
  grokReadsMessages?: boolean;
  /** Who a host text tells them to talk to. Unset is "your Grok Bot"; a Claude deployment passes "Claude". */
  helperName?: string;
  /** The host's checklist, sent to the cleaner once per job right after the private code. */
  checklist?: { name: string; items: string[] };
  /** DONE waits until the cleaner has sent a photo. */
  photosRequired?: boolean;
  /** The cleaner's other texts during the cleaning are kept as job notes. */
  supplyNotes?: boolean;
  /**
   * The host's other instructions, added to the end of the door code text, so the cleaner reads them
   * as the cleaning starts. LiveDesk sets it only when instructions are saved, so the Scratch CLI and
   * smoke engines keep their door code copy.
   */
  cleaningNote?: string;
  /** The host reads the thread with the cleaner, by the name the group calls them. Absent keeps one-to-one texts. */
  groupChat?: {
    hostName: string;
    cleanerName: string;
    extra?: { phone: string; name: string }[];
    /** Where the door code goes when the group holds anyone besides the landlord and the cleaner. */
    doorCodeTo?: "group" | "cleaner";
  };
}

export interface InboundText {
  id: string;
  from: string;
  text: string;
  channel?: "group";
  media?: number;
  photos?: number;
}

export interface CleanerCore {
  pollFeed(ical: string, options?: { conversation?: "closed" | "open" }): Promise<PollResult>;
  readSource(source: BookingSource, options?: { conversation?: "closed" | "open" }): Promise<PollResult & SyncState>;
  /**
   * Several sources as one read. Every snapshot is applied together, so no source looks like it
   * removed another's stays. When any one is refused, none is applied.
   */
  readSources(sources: readonly BookingSource[], options?: { conversation?: "closed" | "open" }): Promise<PollResult & SyncState>;
  /**
   * `media` is how many attachments an MMS carried, and `photos` how many of them were saved for the
   * cleaning in progress. During a cleaning every attachment counts as a photo the cleaner sent, even
   * one that couldn't be downloaded. A text with media never gets the generic guide reply.
   */
  receive(input: InboundText): Promise<ReceiveResult>;
  /** The cleaning in progress an MMS from `from` would add photos to. Undefined when there is none or the text was seen. */
  photoJobFor(input: { id: string; from: string }): string | undefined;
  confirmHostTimes(input: { checkout: string; checkIn: string }): Promise<CleanerText[]>;
  /**
   * The host's checkout and next check-in, in minutes after midnight, on the first open turnover.
   * Grok passes them from chat. The cleaner's next text goes out as it would after a host text.
   */
  setHostTimes(input: { checkout: number; checkIn: number; keepCheckIn?: boolean }): Promise<CleanerText[]>;
  /** confirmOpenTimes with minutes after midnight. Group setups only. */
  setOpenTimes(input: { checkout: number; checkIn: number }): Promise<{ timed: number; sent: CleanerText[] }>;
  /** The host told Grok the guests have left. The door code goes out under the same rules as before. */
  hostDeparture(id: string): Promise<ReceiveResult>;
  /** The host told Grok to send an uncertain offer or reminder once more. */
  hostRetry(id: string): Promise<ReceiveResult>;
  /**
   * The host told Grok to pause the cleaning. No offer, reminder, or door code goes out until the host
   * resumes it. The cleaner gets one short hold line. A second pause sends nothing.
   */
  hostHold(id: string): Promise<ReceiveResult>;
  /** Jobs that keep the number on cleaning: offered, confirmed, waiting on departure, cleared, or under way. */
  liveJobs(): { id: string; checkoutDate: string; status: JobStatus }[];
  /** The texts standing down would send: one canceled update per job someone was already told about. */
  standDownTexts(): { jobId: string; to: "cleaner" | "host"; body: string }[];
  /** Calls off every offered or confirmed job the host's stand-down covers, and sends each canceled update once. */
  hostStandDown(id: string): Promise<ReceiveResult>;
  /**
   * Times every open turnover the host hasn't timed yet with the same checkout and check-in, in a
   * group setup. Turnovers that already have a host time keep it. Offers still go one at a time.
   */
  confirmOpenTimes(input: { checkout: string; checkIn: string }): Promise<{ timed: number; sent: CleanerText[] }>;
  resumeJob(): Promise<CleanerText | null>;
  groupPinSettled(): boolean;
  jobOnHold(): boolean;
  runReminders(): Promise<ReminderResult>;
  jobs(): JobView[];
  outbox(): OutboxView[];
  transcript(): string[];
  blocks(): FeedBlock[];
  lastSync(): SyncState;
  beginOnboarding(): SetupView;
  attachPreview(kind: "guesty-lite" | "notion", body: string): void;
  /**
   * The saved sources, in dedupe order. Each one keeps the held snapshot read from the same link
   * (by origin), even when its name or place changed. A held snapshot no saved source claims is
   * forgotten, so its stays leave the next read. Returns the ids it holds a snapshot for. Sends nothing.
   */
  keepSources(saved: readonly SourceClaim[]): string[];
  /** Upcoming open jobs the next read would call off if only these sources were saved. Changes nothing. */
  wouldCancel(saved: readonly SourceClaim[]): { checkoutDate: string }[];
  answerOnboarding(input: { id: string; from: string; text: string }): Promise<SetupResult>;
  setupView(): SetupView | undefined;
  messagingView(): MessagingView | undefined;
  markReady(): void;
  /** Sends the cleaner opt-in, then any text that was waiting on the host's times. */
  releaseCleanerTexts(): Promise<CleanerText[]>;
  /**
   * One Scratch turnover from a checkout clock and the next check-in clock.
   * Does not read a calendar. A second call does not add a job or send an offer.
   * A past checkout does not release the door code.
   */
  addTestTurn(input: { checkout: string; checkIn: string }): Promise<{ created: boolean; reason?: "exists" | "times" | "refused" }>;
  cleanerHasOptedOut(): boolean;
  fileReview(kind: ReviewKind): Promise<ReceiveResult>;
  replay(): Promise<{ sent: CleanerText[] }>;
  backup(dest: string): void;
  restore(backupPath: string): void;
  health(): HealthReport;
  reviews(): ReviewItem[];
  auditTrail(): AuditEvent[];
  sourceHealth(): SourceRecord[];
  revealPin(role: "cleaner" | "observer" | "owner" | "manager"): string | undefined;
  stampFetchedAt(iso: string): void;
  /** Marks an accepted door-code text undelivered so the next departure can send it again. Sends nothing. */
  markPinUndelivered(): void;
  /** One record of whether this door-code text was accepted, delivered, or failed. */
  reportPin(id: string, status: string): Promise<void>;
  /** True when the current door-code text was accepted and has not failed. */
  pinAccepted(): boolean;
  /** The word read_outbox should show for this door-code text. */
  pinShownStatus(id: string): "sent" | "delivered" | "failed" | "undelivered" | undefined;
  /** True once after a failure, then clear. */
  pullPinFailure(): boolean;
  hostNotes(): string[];
  /** The same notes with the id each one is kept under, so a caller can tell which it has already shown. */
  hostNoteEntries(): { id: string; body: string }[];
  keepHostNote(id: string, body: string): void;
  /** The new-booking question that offers the usual times, when usualTimesName is set and the stay's check-in is known. */
  newBookingAsk(jobId: string): string | undefined;
  holdNotice(): string | undefined;
  notePrivateCodeDelivered(): void;
  /** Keeps a door code in memory after a later tool call opens the seal. Does not write it. */
  rememberPin(pin: string): void;
  /** Saves the cleaner's arrival time on the open job's checkout day. False when no job is open. Sends nothing. */
  saveArrival(minutes: number): boolean;
  /**
   * True when the host's own message can go now to `to`: "group" for the group thread, or the phone
   * of the cleaner or a saved group contact. The person must have opted in and be on the allowlist.
   */
  canSendHostMessage(to: string): boolean;
  /**
   * Sends the host's own approved message through the one send point, as kind host-message. Quiet
   * hours don't hold it, because the host chose to send it now. Null when a rule held it or it failed.
   */
  sendHostMessage(input: { to: string; body: string }): Promise<CleanerText | null>;
  /** How many host messages went out after `since`. */
  hostMessagesSince(since: Date): number;
  /** The phones in the group thread now, sorted. Empty without group chat. */
  groupMembers(): string[];
}

const START_ACK = "You're opted back in. Reply YES if you still want this turnover. Reply STOP to opt out.";
const DECLINED = "Okay, that turnover is not scheduled.";
const HOST_INJURY = "If someone is hurt, call 911 now.";
const CLEANER_HURT = "If someone is hurt, call 911 now. I've let the host know.";
const CLEANER_HURT_MISSED = "If someone is hurt, call 911 now. I couldn't reach the host, so please call them too.";
export const SAFETY = new Set<TextKind>(["stop", "start", "emergency"]);

/**
 * Joins digits split by spaces, dots, dashes, underscores, or slashes, so "8 0 8 8", "80-88", and
 * "8.0.8.8" read as 8088. A host message is checked for the door code in this form too.
 */
export function joinSplitDigits(text: string): string {
  return text.replace(/(\d)[\s.\-_/\u2010-\u2015]+(?=\d)/g, "$1");
}

/** Every run of 4 or more digits, even split by spaces, dots, dashes, underscores, or slashes, as [redacted]. */
export function redactDigitRuns(text: string): string {
  return text.replace(/\d(?:[\s.\-_/\u2010-\u2015]*\d){3,}/g, "[redacted]");
}

const JOB_TEXTS = new Set<TextKind>(["offer", "corrected", "confirm", "reminder", "cancel-update", "declined", "started", "done", "checklist"]);
/** Job notes kept during a cleaning, newest last, and the length of each. */
const MAX_NOTES = 5;
const MAX_NOTE = 200;
/** Job texts that go into the group while it has two or more people in it. */
export const GROUP_ROUTED: ReadonlySet<TextKind> = new Set<TextKind>([
  "offer",
  "corrected",
  "cancel-update",
  "reminder",
  "confirm",
  "declined",
  "started",
  "done",
  "next",
  "checklist",
  "held",
  "emergency",
  "host-message",
]);

const HOST_DIRECT = new Set<TextKind>(["host-checkout", "host-checkin", "pin-failed", "pin-held", "resume"]);
const GROUP_PREFIX = "Group text: ";
const MIRROR_PREFIX = "Copy of the group text: ";
const DEFAULT_TRIGGERS: ReminderTrigger[] = [{ id: "morning-of", kind: "morning-of", localTime: "08:00" }];
const TEST_TURN_ID = "scratch-test-turn";
const TEST_TURN_NEXT = "scratch-test-next";

/**
 * Usage:
 *   const core = openCleanerCore({ enabled: cleanerCoreEnabled(env), property, ownerPhone, cleaner, consented: true, sink, now, dataDir });
 *   await core.pollFeed(icalText);
 *   await core.receive({ id, from: ownerPhone, text: "YES" });
 * With a pin, the opted-in cleaner receives the offer, the scheduled confirmation, and the reminder.
 * That cleaner's YES confirms the job. The host's YES confirms times, not the offer.
 *   await core.runReminders();
 * Flag off returns reason "disabled" and sends nothing. With no pin, no door code is sent.
 * With a pin, the approved cleaner must opt in and the host must confirm departure first.
 */
export function openCleanerCore(options: CleanerCoreOptions): CleanerCore {
  return new Engine(options);
}

interface Announced {
  checkoutDate: string;
  checkoutMinutes: number;
  nextCheckInDate: string | null;
  checkInMinutes: number | null;
}

/** A job in one of these keeps the number on cleaning. */
const LIVE_STATUSES = new Set<JobStatus>(["offered", "confirmed", "awaiting_departure", "cleared", "in_progress"]);
/** What a stand-down calls off. A cleared or started cleaning is never called off: the stand-down waits for it. */
const STAND_DOWN_STATUSES = new Set<JobStatus>(["offered", "confirmed", "awaiting_departure"]);

interface Job {
  id: string;
  departingUid: string;
  arrivingUid: string | null;
  /** Check-in date of the departing stay. Absent on a job saved before it was kept. */
  checkInDate?: string;
  checkoutDate: string;
  nextCheckInDate: string | null;
  sameDay: boolean;
  version: number;
  sourceSequence: number;
  contentHash: string;
  canceled: boolean;
  declined: boolean;
  announced: Announced | null;
  started: boolean;
  done: boolean;
  /** Every source UID this booking was read under while the job was live. Absent means only its id. */
  aliases?: string[];
  /** The cleaner's arrival instant on the checkout day, saved by Grok. */
  arrivalAt?: string;
  /** When the cleaning started: START, or the cleaner's first other message after the code. */
  startedAt?: string;
  /** When DONE was taken. */
  doneAt?: string;
  /**
   * Photos the cleaner sent during the cleaning, counted when they arrive, so a failed download
   * never keeps DONE waiting.
   */
  photos?: number;
  /** Of those, the photos downloaded and kept. */
  photosSaved?: number;
  /** The cleaner's notes during the cleaning, redacted, at most 5. */
  notes?: string[];
  /** The checklist items sent to the cleaner. */
  checklist?: string[];
}

interface Clearance {
  jobId: string;
  checkoutDate: string;
  minutes: number;
  hostVersion: number;
}

interface HostFact {
  jobId: string;
  field: "checkout" | "checkin";
  version: number;
  minutes: number;
}

interface Tombstone {
  uid: string;
  version: number;
  contentHash: string;
}

interface ActionLease {
  version: number;
  actor: string;
  source: string;
  reason: string;
  at: string;
  state: "open" | "committed" | "uncertain" | "expired" | "revoked";
}

interface OutboxItem {
  id: string;
  to: string;
  body: string;
  kind: TextKind;
  status: "sent" | "failed" | "canceled" | "uncertain" | "unsent";
  jobId?: string;
  /** Posted to the group, not texted one-to-one. */
  group?: true;
  lease?: ActionLease;
}

interface Stored {
  schemaVersion: 1;
  tenantId?: string;
  jobs: Job[];
  hostFacts: HostFact[];
  tombstones: Tombstone[];
  outbox: OutboxItem[];
  inboundIds: string[];
  transcript: string[];
  optedOut: boolean;
  injurySent: string[];
  blocks: FeedBlock[];
  cleanerConsent?: "pending" | "in" | "out";
  clearances?: Clearance[];
  pinSeal?: PinSeal;
  onboarding?: OnboardingSession;
  origin?: "onboarding";
  activated?: boolean;
  quietFrom?: string;
  quietUntil?: string;
  isolate?: boolean;
  participantConsent?: { phone: string; consent: "pending" | "in" | "out" }[];
  sourceRecords?: SourceRecord[];
  /** The last snapshot of each source, by source id. Booking dates and UIDs only. */
  snapshots?: Record<string, SourceSnapshot>;
  reviews?: ReviewItem[];
  audit?: AuditEvent[];
  counters?: Counters;
  hostGroup?: "pending" | "in" | "out";
  problemHold?: boolean;
  ownerOptedOut?: boolean;
  holdCause?: "cleaner" | "owner" | "injury";
  pinFailurePending?: boolean;
  pinPhase?: { id: string; phase: "accepted" | "delivered" | "failed" | "undelivered" }[];
  groupPinTerminal?: boolean;
  lastIntro?: string;
  hostNotes?: { id: string; body: string }[];
}

/** One file can hold several tenants. A single-tenant file stays the flat step D shape. */
interface StoreFile {
  schemaVersion: 1;
  tenantId?: string;
  tenants?: Record<string, Stored>;
  jobs?: Job[];
  hostFacts?: HostFact[];
  tombstones?: Tombstone[];
  outbox?: OutboxItem[];
  inboundIds?: string[];
  transcript?: string[];
  optedOut?: boolean;
  injurySent?: string[];
  blocks?: FeedBlock[];
  cleanerConsent?: "pending" | "in" | "out";
  clearances?: Clearance[];
  pinSeal?: PinSeal;
  pin?: unknown;
  onboarding?: OnboardingSession;
  origin?: "onboarding";
  activated?: boolean;
  quietFrom?: string;
  quietUntil?: string;
  isolate?: boolean;
  participantConsent?: { phone: string; consent: "pending" | "in" | "out" }[];
  sourceRecords?: SourceRecord[];
  snapshots?: Record<string, SourceSnapshot>;
  reviews?: ReviewItem[];
  audit?: AuditEvent[];
  counters?: Counters;
}

interface Draft {
  id: string;
  jobId?: string;
  to: string;
  body: string;
  kind: TextKind;
  channel?: "group" | "mirror";
  audience?: string[];
  afterSend?: () => void;
}

class Engine implements CleanerCore {
  private readonly enabled: boolean;
  private readonly owner: string | undefined;
  private readonly cleanerPhone: string | undefined;
  private pin: string | undefined;
  private readonly hostName: string;
  private readonly groupPhones: string[];
  private cleanerConsent: "pending" | "in" | "out" = "pending";
  private clearances: Clearance[] = [];
  private readonly triggers: ReminderTrigger[];
  private readonly defaultCheckout: number;
  private readonly defaultCheckIn: number;
  private jobsState: Job[] = [];
  private hostFacts: HostFact[] = [];
  private tombstones: Tombstone[] = [];
  private outboxState: OutboxItem[] = [];
  private inboundIds: string[] = [];
  private transcriptState: string[] = [];
  private optedOut = false;
  private everConsented: boolean;
  private injurySent: string[] = [];
  private blockState: FeedBlock[] = [];
  private readonly now: () => Date;
  private readonly file: string | undefined;
  private readonly tenantId: string;
  /** The last snapshot of each source, by source id. Saved, so a restart keeps every source. */
  private readonly latest = new Map<string, SourceSnapshot>();
  private sourceOrder: string[] = [];
  private conflictState: SourceConflict[] = [];
  private provenanceState: JobProvenance[] = [];
  private fallbackText: string | undefined;
  private readonly messaging: CleanerCoreOptions["messaging"];
  private quiet: { from: string; until: string } | undefined;
  private isolate: boolean;
  private origin: "onboarding" | undefined;
  private activated = false;
  private participantConsent = new Map<string, "pending" | "in" | "out">();
  private readonly groupChat: CleanerCoreOptions["groupChat"];
  private hostGroup: "pending" | "in" | "out" = "pending";
  private hostGroupSaved = false;
  private problemHold = false;
  private ownerOptedOut = false;
  private holdCause: "cleaner" | "owner" | "injury" | undefined;
  private pinFailurePending = false;
  private pinPhase = new Map<string, "accepted" | "delivered" | "failed" | "undelivered">();
  private groupPinTerminal = false;
  /** The members (sorted, comma-joined) of the last group that was introduced. A different membership gets a fresh intro. */
  private lastIntro: string | undefined;
  private hostNoteState: { id: string; body: string }[] = [];
  private session: OnboardingSession | undefined;
  private previewFeeds: { kind: "guesty-lite" | "notion"; body: string }[] = [];
  private syncState: SyncState = { reason: "read", conversation: "open", sources: [], conflicts: [] };
  private readonly thresholdMs: number;
  private readonly watchFreshness: boolean;
  private readonly sqlite: boolean;
  private readonly halt: CleanerCoreOptions["halt"];
  private readonly backupDir: string | undefined;
  private deferCleaner: boolean;
  private hadStoredConsent = false;
  private storeLoaded = false;
  private readonly inflight = new Set<string>();
  private pendingIntros: CleanerText[] = [];
  /** Inbound ids being handled that carried media. They never get the generic guide reply. */
  private readonly withMedia = new Set<string>();
  private sourceRecords: SourceRecord[] = [];
  private reviewItems: ReviewItem[] = [];
  private auditLog: AuditEvent[] = [];
  private counters: Counters = emptyCounters();
  private nextFetchedAt: string | undefined;
  private lastBackupAt = 0;

  constructor(private readonly options: CleanerCoreOptions) {
    this.enabled = options.enabled;
    this.owner = parsePhone(options.ownerPhone);
    this.cleanerPhone = parsePhone(options.cleaner.phone);
    const pin = options.pin?.trim();
    this.pin = pin && /^\d{4,8}$/.test(pin) ? pin : undefined;
    this.hostName = options.hostName?.trim() || "Scratch";
    this.groupPhones = (options.groupPhones ?? []).flatMap((phone) => {
      const parsed = parsePhone(phone);
      return parsed ? [parsed] : [];
    });
    this.triggers = options.triggers ?? DEFAULT_TRIGGERS;
    this.defaultCheckout = minutesOf(options.property.defaultCheckout ?? "11:00");
    this.defaultCheckIn = minutesOf(options.property.defaultCheckIn ?? "16:00");
    this.everConsented = options.consented === true;
    this.now = options.now ?? (() => new Date());
    this.file = options.dataDir ? join(options.dataDir, "cleaner-core.json") : undefined;
    this.tenantId = options.tenantId?.trim() || options.property.id;
    this.messaging = options.messaging;
    this.quiet = options.quietHours ?? undefined;
    this.isolate = options.isolate === true;
    this.origin = options.origin;
    this.thresholdMs = staleAfterMs(process.env, options.staleAfterMs);
    this.watchFreshness = options.watchFreshness === true;
    this.sqlite = options.sqlite === true;
    this.halt = options.halt;
    this.backupDir = options.backupDir;
    this.deferCleaner = options.deferCleanerTexts === true;
    this.groupChat = options.groupChat;
    for (const person of options.messaging?.participants ?? []) this.participantConsent.set(parsePhone(person.phone) ?? person.phone, "pending");
    for (const extra of options.groupChat?.extra ?? []) {
      const phone = parsePhone(extra.phone);
      if (phone) this.participantConsent.set(phone, "pending");
    }
    this.load();
    if (!this.hadStoredConsent && options.cleanerConsent) this.cleanerConsent = options.cleanerConsent;
    if (!this.storeLoaded && options.ownerOptedOut) this.ownerOptedOut = true;
    this.seatHost();
  }

  async pollFeed(ical: string, options?: { conversation?: "closed" | "open" }): Promise<PollResult> {
    const conversation = options?.conversation ?? "open";
    const blocked = this.syncBlocked(conversation);
    if (blocked) return blocked;
    const feed = interpretFeed(ical);
    return this.applySnapshots(
      [this.stamp({ kind: "guesty-lite", sourceId: "guesty-lite", tenantId: this.tenantId, turnovers: feed.turnovers, blocks: feed.blocks })],
      conversation,
    );
  }

  readSource(source: BookingSource, options?: { conversation?: "closed" | "open" }): Promise<PollResult & SyncState> {
    return this.readSources([source], options);
  }

  async readSources(sources: readonly BookingSource[], options?: { conversation?: "closed" | "open" }): Promise<PollResult & SyncState> {
    const conversation = options?.conversation ?? "open";
    const blocked = this.syncBlocked(conversation);
    if (blocked) return this.withSync(blocked);
    const snapshots: SourceSnapshot[] = [];
    for (const source of sources) {
      const snapshot = await source.read();
      if (snapshot.kind !== source.kind) throw new Error("Booking source kind does not match the read.");
      const refused = this.refuseSnapshot(snapshot, conversation);
      if (refused) return refused;
      snapshots.push(this.stamp(snapshot));
    }
    return this.withSync(await this.applySnapshots(snapshots, conversation));
  }

  private refuseSnapshot(snapshot: SourceSnapshot, conversation: "closed" | "open"): (PollResult & SyncState) | undefined {
    const permission = snapshot.permission ?? "granted";
    if (permission !== "granted") {
      if (snapshot.tenantId !== "" && snapshot.tenantId !== this.tenantId) {
        this.syncState = { reason: "wrong-tenant", conversation, sources: this.sourceNames(), conflicts: this.conflictState };
        return this.withSync({ polled: false, reason: "wrong-tenant", sent: [], jobs: this.jobs(), blocks: this.blocks() });
      }
      this.fallbackText = snapshot.fallback;
      this.counters.pollFails += 1;
      this.syncState = { reason: "permission-denied", conversation, sources: this.sourceNames(), conflicts: this.conflictState };
      return this.withSync({ polled: false, reason: "permission-denied", sent: [], jobs: this.jobs(), blocks: this.blocks() });
    }
    if (snapshot.tenantId !== this.tenantId) {
      this.syncState = { reason: "wrong-tenant", conversation, sources: this.sourceNames(), conflicts: this.conflictState };
      return this.withSync({ polled: false, reason: "wrong-tenant", sent: [], jobs: this.jobs(), blocks: this.blocks() });
    }
    return undefined;
  }

  async receive(input: InboundText): Promise<ReceiveResult> {
    if (!this.enabled) return { handled: false, reason: "disabled", sent: [] };
    const from = parsePhone(input.from);
    if (!from || !this.numberAllowed(from)) return { handled: true, reason: "scratch-only", sent: [] };
    if (this.inboundIds.includes(input.id) || this.inflight.has(input.id)) return { handled: true, reason: "duplicate", sent: [] };
    this.inflight.add(input.id);
    if ((input.media ?? 0) > 0) this.withMedia.add(input.id);
    this.pendingIntros = [];
    try {
      const { label, ...claimed } = await this.receiveClaimed(input, from);
      const intros = this.takeIntros().filter((intro) => !claimed.sent.includes(intro));
      const result = intros.length > 0 ? { ...claimed, sent: [...intros, ...claimed.sent] } : claimed;
      return this.options.grokReadsMessages ? { ...result, outcome: label ?? outcomeOf(result) } : result;
    } finally {
      this.inflight.delete(input.id);
      this.withMedia.delete(input.id);
    }
  }

  async hostDeparture(id: string): Promise<ReceiveResult> {
    return this.hostAction(id, "guests have left", () => (this.pin ? this.clearDeparture(id) : Promise.resolve(this.markIgnored(id))));
  }

  async hostHold(id: string): Promise<ReceiveResult> {
    return this.hostAction(id, "pause the cleaning", async () => {
      this.inboundIds.push(id);
      if (this.problemHold) {
        this.save();
        return { handled: true, reason: "duplicate", sent: [] };
      }
      this.problemHold = true;
      const to = this.cleanerRecord()?.phone;
      const note = to ? await this.emit({ id: `host-hold:${id}`, to, kind: "held", body: jobHoldLine(this.options.property.address) }) : null;
      this.save();
      return { handled: true, reason: "held", sent: note ? [note] : [] };
    });
  }

  liveJobs(): { id: string; checkoutDate: string; status: JobStatus }[] {
    return this.ordered()
      .map((job) => ({ id: job.id, checkoutDate: job.checkoutDate, status: this.derive(job) }))
      .filter((job) => LIVE_STATUSES.has(job.status));
  }

  standDownTexts(): { jobId: string; to: "cleaner" | "host"; body: string }[] {
    if (!this.owner) return [];
    const to = this.cleanerRecord() ? "cleaner" : "host";
    return this.ordered()
      .filter((job) => STAND_DOWN_STATUSES.has(this.derive(job)) && this.toldOwner(job.id))
      .map((job) => ({ jobId: job.id, to, body: this.canceledBody(job) }));
  }

  async hostStandDown(id: string): Promise<ReceiveResult> {
    return this.hostAction(id, "stand down the cleaning service", async () => {
      this.inboundIds.push(id);
      const called: Job[] = [];
      // The same call-off as a stay leaving the calendar: no reminder, door code, or offer follows.
      for (const job of this.jobsState) {
        if (!STAND_DOWN_STATUSES.has(this.derive(job))) continue;
        job.canceled = true;
        job.version += 1;
        this.tombstones.push({ uid: job.id, version: job.version, contentHash: job.contentHash });
        this.dropClearance(job.id);
        this.cancelUnsentPin(job.id);
        this.cancelPendingReminders(job.id);
        called.push(job);
      }
      const sent: CleanerText[] = [];
      for (const job of called) {
        const draft = this.noticeFor(job);
        const text = draft ? await this.emit(draft) : null;
        if (text) sent.push(text);
      }
      this.save();
      return { handled: true, reason: "stood-down", sent };
    });
  }

  private canceledBody(job: Job): string {
    const when = formatWhen(zonedInstant(job.checkoutDate, "12:00", this.options.property.timeZone), this.options.property.timeZone);
    return `Update: the cleaning at ${this.options.property.address} on ${when.day} is canceled, so no need to come. Reply STOP to opt out.`;
  }

  async hostRetry(id: string): Promise<ReceiveResult> {
    return this.hostAction(id, "retry", () => this.retryUncertain(id));
  }

  /** A host decision Grok passes on from chat. It is recorded in the transcript but never read as a text. */
  private async hostAction(id: string, what: string, act: () => Promise<ReceiveResult>): Promise<ReceiveResult> {
    if (!this.enabled) return { handled: false, reason: "disabled", sent: [] };
    if (!this.owner) return { handled: true, reason: "ignored", sent: [] };
    if (this.inboundIds.includes(id) || this.inflight.has(id)) return { handled: true, reason: "duplicate", sent: [] };
    this.inflight.add(id);
    try {
      this.transcriptState.push(`${this.owner} (via Grok): ${what}`);
      return await act();
    } finally {
      this.inflight.delete(id);
    }
  }

  photoJobFor(input: { id: string; from: string }): string | undefined {
    const from = parsePhone(input.from);
    if (!this.enabled || !from || from !== this.cleanerPhone || this.cleanerConsent !== "in") return undefined;
    if (this.inboundIds.includes(input.id) || this.inflight.has(input.id)) return undefined;
    return this.progressJob()?.id;
  }

  /** `label`, when set, is what Grok reads beside the message instead of the label from the reason. */
  private async receiveClaimed(input: InboundText, from: string): Promise<ReceiveResult & { label?: MessageHandled }> {
    this.transcriptState.push(`${from}: ${this.redactInbound(input.text.trim())}`);
    if (this.foreignPhone(from)) {
      this.inboundIds.push(input.id);
      this.save();
      return { handled: true, reason: "wrong-tenant", sent: [] };
    }
    const progress = from === this.cleanerPhone && this.cleanerConsent === "in" ? this.progressJob() : undefined;
    if (progress) this.noteProgress(progress, input);

    const keyword = keywordOf(input.text);
    const grouped = Boolean(this.groupChat && input.channel === "group");
    if (isInjuryReport(input.text)) return this.safety(input.id, () => this.emergency(from, input.id));
    if (keyword === "stop" || isPlainLanguageStop(input.text)) return this.safety(input.id, () => this.stop(from, input.id));
    if (keyword === "start") return this.safety(input.id, () => this.start(from, input.id));
    // Grok reads every other group message and tells the host. Only the host decides to pause a cleaning.
    if (grouped && from === this.owner) {
      const ignored = this.markIgnored(input.id);
      this.save();
      return ignored;
    }
    if (from === this.owner && stripFiller(normalize(input.text)) === "booked on airbnb") {
      const alert = await this.openReview("airbnb-exception", input.id, true);
      this.inboundIds.push(input.id);
      this.save();
      return { handled: true, reason: "review", sent: alert ? [alert] : [] };
    }
    if (this.looksLikeCode(input.text)) {
      const alert = await this.openReview("possible-code-exposure", input.id, true);
      if (this.codeOnly(input.text)) {
        this.inboundIds.push(input.id);
        this.save();
        return { handled: true, reason: "review", sent: alert ? [alert] : [], label: "code-held" };
      }
    }
    if (from === this.owner && stripFiller(normalize(input.text)) === "retry") return this.retryUncertain(input.id);
    if (this.pin && from === this.cleanerPhone && isYes(input.text) && this.awaitingOptIn()) return this.optInCleaner(input.id);
    if (from && isYes(input.text) && this.participantConsent.get(from) === "pending" && this.delivery(`opt-in:${from}`) === "sent") {
      return this.optInParticipant(from, input.id);
    }
    if (this.owner && from === this.owner && isYes(input.text) && this.hostInviteOpen()) return this.optInHost(input.id);
    if (this.pin && from === this.cleanerPhone && isDone(input.text)) return this.finish(from, input.id);
    if (this.pin && from === this.owner && isDeparture(input.text) && !grouped) return this.clearDeparture(input.id);
    const moved = await this.moveCheckout(input.id, from, input.text);
    if (moved) return moved;
    if (this.optedOut || !this.everConsented) return this.markIgnored(input.id);

    const result = await this.answer(input.id, from, input.text);
    this.save();
    return result;
  }

  async runReminders(): Promise<ReminderResult> {
    if (!this.enabled || this.optedOut || this.problemHold || !this.scratchReady()) return { sent: [], failed: [] };
    this.pendingIntros = [];
    const sent: CleanerText[] = await this.settleUncertain();
    const failed: string[] = [];
    // An offer held by the offer trigger or quiet hours goes out on the first check after it is due.
    if (this.options.offerTrigger) sent.push(...(await this.drainOne()));
    if (!this.inQuietHours()) for (const job of this.ordered()) {
      if (!this.canRemind(job)) continue;
      const fact = this.latestFact(job.id, "checkout");
      if (!fact) continue;
      for (const trigger of this.triggers) {
        if (!this.triggerDue(trigger, job.checkoutDate)) continue;
        const id = `reminder:${job.id}:${trigger.id}:${job.checkoutDate}:${fact.version}:${fact.minutes}`;
        this.cancelOtherReminders(job.id, trigger.id, id);
        const existing = this.delivery(id);
        if (existing === "sent" || existing === "canceled") continue;
        const replaced = (trigger.replaces ?? []).some((other) => this.delivery(`reminder:${job.id}:${other}:${job.checkoutDate}:${fact.version}:${fact.minutes}`) === "sent");
        if (replaced) continue;
        const when = this.clock(job.checkoutDate, fact.minutes);
        const addressed = addressCleaner(this.cleanerRecord(), {
          kind: "reminder",
          body: this.options.reminderAsksArrival
            ? arrivalReminderBody(this.options.property.address, when)
            : reminderBody(this.options.property.address, when, Boolean(this.pin)),
        });
        if (!addressed) continue;
        const text = await this.emit({
          id,
          jobId: job.id,
          to: addressed.to,
          kind: "reminder",
          body: addressed.body,
        });
        if (text) sent.push(text);
        else if (this.delivery(id) === "failed") failed.push(id);
      }
    }
    if (this.pin) {
      for (const job of this.ordered()) {
        const key = this.pinKey(job);
        if (!key || this.delivery(key) === "sent" || this.delivery(key) === "canceled" || this.groupPinTerminal) continue;
        for (const text of await this.deliverPin(job)) sent.push(text);
      }
    }
    this.save();
    return { sent: [...this.takeIntros(), ...sent], failed };
  }

  jobs(): JobView[] {
    return this.ordered().map((job) => this.view(job));
  }

  outbox(): OutboxView[] {
    return this.outboxState.map((item) => ({
      id: item.id,
      to: item.to,
      body: item.body,
      kind: item.kind,
      status: item.status,
      ...(item.jobId ? { jobId: item.jobId } : {}),
      ...(item.group ? { group: true as const } : {}),
    }));
  }

  transcript(): string[] {
    return [...this.transcriptState];
  }

  blocks(): FeedBlock[] {
    return this.blockState.map((block) => ({ ...block }));
  }

  lastSync(): SyncState {
    const freshness = this.freshnessView();
    const sync: SyncState = {
      reason: this.syncState.reason,
      conversation: this.syncState.conversation,
      sources: [...this.syncState.sources],
      conflicts: this.syncState.conflicts.map((conflict) => ({ ...conflict })),
    };
    if (this.fallbackText) sync.fallback = this.fallbackText;
    if (freshness.length > 0) sync.freshness = freshness;
    if (this.latest.has("notion") && this.provenanceState.length > 0) {
      sync.provenance = this.provenanceState.map((item) => ({ jobId: item.jobId, sources: item.sources.map((source) => ({ ...source })) }));
    }
    return sync;
  }

  beginOnboarding(): SetupView {
    if (!this.session) {
      const begun = beginOnboarding();
      this.session = begun.session;
      this.transcriptState.push(begun.prompt);
      this.isolate = true;
      this.save();
    }
    return this.setupViewOrThrow();
  }

  attachPreview(kind: "guesty-lite" | "notion", body: string): void {
    this.previewFeeds.push({ kind, body });
  }

  keepSources(saved: readonly SourceClaim[]): string[] {
    this.sourceOrder = saved.map((source) => source.id);
    const next = this.claimSnapshots(saved);
    const changed = next.size !== this.latest.size || [...next].some(([id, snapshot]) => this.latest.get(id) !== snapshot);
    if (changed) {
      const dropped = [...this.latest.keys()].filter((id) => !next.has(id));
      this.latest.clear();
      for (const [id, snapshot] of next) this.latest.set(id, snapshot);
      this.sourceRecords = this.sourceRecords.filter((record) => !dropped.includes(record.kind));
      this.save();
    }
    return this.sourceNames();
  }

  wouldCancel(saved: readonly SourceClaim[]): { checkoutDate: string }[] {
    const now = normalizeSnapshots(this.orderedSnapshots());
    const next = normalizeSnapshots(this.orderedSnapshots(this.claimSnapshots(saved), saved.map((source) => source.id)));
    return this.jobsState
      .filter((job) => !job.canceled && !job.done && !job.started && !this.pinDelivered(job) && !this.beforeToday(job.checkoutDate))
      .filter((job) => listsJob(now, job) && !listsJob(next, job))
      .map((job) => ({ checkoutDate: job.checkoutDate }))
      .sort((a, b) => a.checkoutDate.localeCompare(b.checkoutDate));
  }

  /** Each saved source keeps its own held snapshot when it reads the same link, or else the one read from that link. */
  private claimSnapshots(saved: readonly SourceClaim[]): Map<string, SourceSnapshot> {
    const next = new Map<string, SourceSnapshot>();
    for (const source of saved) {
      const own = this.latest.get(source.id);
      const claimed =
        source.origin === undefined
          ? own
          : own?.origin === source.origin
            ? own
            : [...this.latest.values()].find((snapshot) => snapshot.origin === source.origin);
      if (!claimed) continue;
      next.set(source.id, claimed.sourceId === source.id ? claimed : { ...claimed, sourceId: source.id });
    }
    return next;
  }

  async answerOnboarding(input: { id: string; from: string; text: string }): Promise<SetupResult> {
    if (!this.session) this.beginOnboarding();
    const session = this.session;
    if (!session) return { handled: false, reason: "ignored", sent: [], setup: this.setupViewOrThrow() };
    const from = parsePhone(input.from);
    if (!from || !isScratchTestNumber(from)) return { handled: true, reason: "scratch-only", sent: [], setup: this.setupViewOrThrow() };
    if (this.foreignPhone(from)) return { handled: true, reason: "wrong-tenant", sent: [], setup: this.setupViewOrThrow() };
    if (session.inboundIds.includes(input.id)) return { handled: true, reason: "duplicate", sent: [], setup: this.setupViewOrThrow() };
    const effect = applyOnboardingAnswer(session, { id: input.id, from, text: input.text }, this.onboardingPreview());
    if (effect.pin) this.pin = effect.pin;
    this.session = effect.session;
    this.transcriptState.push(this.redact(`${from}: ${input.text.trim()}`));
    if (effect.prompt !== this.transcriptState[this.transcriptState.length - 1]) this.transcriptState.push(effect.prompt);
    const sent: CleanerText[] = [];
    for (const invite of effect.optIn) {
      const text = await this.emit({ id: `opt-in:${invite.phone}`, to: invite.phone, kind: "opt-in", body: invite.body });
      if (text) sent.push(text);
    }
    if (effect.publish && effect.session.published) this.publishSetup();
    this.save();
    return { handled: true, reason: "onboarding", sent, setup: this.setupViewOrThrow() };
  }

  setupView(): SetupView | undefined {
    if (!this.session) return undefined;
    return this.setupViewOrThrow();
  }

  messagingView(): MessagingView | undefined {
    if (!this.messaging) return undefined;
    const actual = this.messagingMode();
    const excluded = this.excludedPhones();
    const note = messagingNote(this.messaging.requested, actual, this.messaging.capable, excluded);
    return {
      requested: this.messaging.requested,
      actual,
      excluded,
      ...(note ? { note } : {}),
    };
  }

  markReady(): void {
    this.origin = "onboarding";
    this.activated = true;
    this.isolate = true;
    this.cleanerConsent = "in";
    this.everConsented = true;
    this.save();
  }

  async releaseCleanerTexts(): Promise<CleanerText[]> {
    this.deferCleaner = false;
    const sent: CleanerText[] = [];
    const optIn = await this.sendOptIn();
    if (optIn) sent.push(optIn);
    for (const invite of await this.sendGroupInvites()) sent.push(invite);
    if (!this.optedOut) sent.push(...(await this.drainOne()));
    this.save();
    return sent;
  }

  async addTestTurn(input: { checkout: string; checkIn: string }): Promise<{ created: boolean; reason?: "exists" | "times" | "refused" }> {
    const checkout = clockMinutes(input.checkout);
    const checkIn = clockMinutes(input.checkIn);
    if (checkout === undefined || checkIn === undefined) return { created: false, reason: "times" };
    if (!this.scratchReady()) return { created: false, reason: "refused" };
    if (this.jobsState.some((job) => job.id === TEST_TURN_ID || !job.canceled)) return { created: false, reason: "exists" };
    const checkoutDate = localDate(this.now(), this.options.property.timeZone);
    const nextCheckInDate = checkIn > checkout ? checkoutDate : addCalendarDays(checkoutDate, 1);
    this.reconcile([
      {
        id: TEST_TURN_ID,
        departingUid: TEST_TURN_ID,
        arrivingUid: TEST_TURN_NEXT,
        checkInDate: addCalendarDays(checkoutDate, -1),
        checkoutDate,
        nextCheckInDate,
        sameDay: nextCheckInDate === checkoutDate,
        sequence: 1,
        contentHash: `${checkoutDate}|${nextCheckInDate}|${TEST_TURN_NEXT}`,
      },
    ]);
    this.addFact(TEST_TURN_ID, "checkout", checkout);
    this.addFact(TEST_TURN_ID, "checkin", checkIn);
    this.deferCleaner = false;
    if (this.groupChat && !this.ownerOptedOut && this.hostGroup !== "out") {
      this.hostGroup = "in";
      this.hostGroupSaved = true;
    }
    await this.sendHostOptIn();
    await this.sendOptIn();
    this.save();
    return { created: true };
  }

  cleanerHasOptedOut(): boolean {
    return this.cleanerConsent === "out";
  }

  async confirmHostTimes(input: { checkout: string; checkIn: string }): Promise<CleanerText[]> {
    if (!this.groupChat) return [];
    const checkout = clockMinutes(input.checkout);
    const checkIn = clockMinutes(input.checkIn);
    if (checkout === undefined || checkIn === undefined) return [];
    return this.setHostTimes({ checkout, checkIn });
  }

  async setHostTimes(input: { checkout: number; checkIn: number; keepCheckIn?: boolean }): Promise<CleanerText[]> {
    if (!this.enabled || !this.everConsented) return [];
    const job = this.ordered().find((item) => !item.canceled && !item.declined && !item.done && !item.started);
    if (!job) return [];
    this.addFact(job.id, "checkout", input.checkout);
    if (job.nextCheckInDate && !(input.keepCheckIn && this.latestFact(job.id, "checkin"))) this.addFact(job.id, "checkin", input.checkIn);
    const sent = this.optedOut || this.problemHold ? [] : await this.drainOne();
    this.save();
    return sent;
  }

  async confirmOpenTimes(input: { checkout: string; checkIn: string }): Promise<{ timed: number; sent: CleanerText[] }> {
    if (!this.groupChat) return { timed: 0, sent: [] };
    const checkout = clockMinutes(input.checkout);
    const checkIn = clockMinutes(input.checkIn);
    if (checkout === undefined || checkIn === undefined) return { timed: 0, sent: [] };
    return this.setOpenTimes({ checkout, checkIn });
  }

  async setOpenTimes(input: { checkout: number; checkIn: number }): Promise<{ timed: number; sent: CleanerText[] }> {
    if (!this.groupChat) return { timed: 0, sent: [] };
    const { checkout, checkIn } = input;
    let timed = 0;
    for (const job of this.ordered()) {
      if (job.canceled || job.declined || job.done || job.started || this.latestFact(job.id, "checkout")) continue;
      this.addFact(job.id, "checkout", checkout);
      if (job.nextCheckInDate) this.addFact(job.id, "checkin", checkIn);
      timed += 1;
    }
    const sent = timed === 0 || this.optedOut || this.problemHold ? [] : await this.drainOne();
    this.save();
    return { timed, sent };
  }

  holdNotice(): string | undefined {
    const address = this.options.property.address;
    if (this.holdCause === "cleaner") return cleanerOptOutHold(address, this.helper());
    if (this.holdCause === "owner") return ownerOptOutHoldNote(address, this.helper());
    if (this.holdCause === "injury") return injuryHoldLine(address, this.helper());
    if (this.cleanerConsent === "out") return cleanerOptOutHold(address, this.helper());
    return undefined;
  }

  async resumeJob(): Promise<CleanerText | null> {
    const held = this.problemHold;
    this.problemHold = false;
    this.holdCause = undefined;
    if (!this.groupChat && !held) return null;
    const text = await this.emit({
      id: `resume:${this.options.property.id}`,
      to: this.owner ?? "",
      kind: "resume",
      body: resumeNote(this.options.property.address),
    });
    this.save();
    return text;
  }

  groupPinSettled(): boolean {
    return this.groupPinTerminal;
  }

  jobOnHold(): boolean {
    return this.problemHold;
  }

  private setupViewOrThrow(): SetupView {
    const session = this.session;
    if (!session) throw new Error("Onboarding has not started.");
    return {
      activated: session.activated,
      step: session.step,
      tenantId: session.tenantId,
      address: session.address,
      prompt: session.prompts[session.prompts.length - 1] ?? "",
      prompts: [...session.prompts],
      sealed: session.sealed,
    };
  }

  private onboardingPreview(): OnboardingPreview {
    const snapshots: SourceSnapshot[] = [];
    for (const feed of this.previewFeeds) {
      if (feed.kind === "notion") {
        snapshots.push(readNotionFixture(feed.body));
        continue;
      }
      const read = interpretFeed(feed.body);
      snapshots.push({ kind: "guesty-lite", sourceId: "guesty-lite", tenantId: this.session?.tenantId || this.tenantId, turnovers: read.turnovers, blocks: read.blocks });
    }
    const normalized = normalizeSnapshots(snapshots);
    const stale = snapshots.some((snapshot) => this.isStale(snapshot.fetchedAt));
    const labels = [...new Set(snapshots.map((snapshot) => (snapshot.kind === "notion" ? "Notion" : "Guesty Lite")))];
    return {
      stays: normalized.feed.turnovers.length,
      blocks: normalized.feed.blocks.length,
      stale,
      conflicts: normalized.conflicts.length,
      sourceLabel: labels.length > 0 ? labels.join(" and ") : "No source",
    };
  }

  private publishSetup(): void {
    const session = this.session;
    if (!session || !this.pin || !this.file) return;
    const cleaner = session.people.find((person) => person.role === "cleaner");
    if (!cleaner) return;
    const published = openCleanerCore({
      enabled: this.enabled,
      tenantId: session.tenantId,
      property: {
        id: `prop_${session.tenantId}`,
        address: session.address,
        timeZone: session.timeZone,
        defaultCheckout: session.checkout,
        defaultCheckIn: session.checkIn,
      },
      ownerPhone: session.hostPhone,
      cleaner: { phone: cleaner.phone, approved: true },
      pin: this.pin,
      hostName: session.nickname,
      consented: true,
      sink: { send() {} },
      now: this.now,
      dataDir: dirname(this.file),
      origin: "onboarding",
      isolate: true,
      quietHours: { from: session.quietFrom, until: session.quietUntil },
    });
    published.markReady();
  }

  private async sendParticipantOptIns(): Promise<CleanerText[]> {
    if (this.messaging?.requested !== "group") return [];
    const sent: CleanerText[] = [];
    for (const person of this.messaging.participants) {
      const phone = parsePhone(person.phone);
      if (!phone || phone === this.owner || phone === this.cleanerPhone || person.approved === false) continue;
      if (this.groupPhones.includes(phone) || this.participantConsent.get(phone) !== "pending") continue;
      const text = await this.emit({
        id: `opt-in:${phone}`,
        to: phone,
        kind: "opt-in",
        body: `Hi, this is ${this.hostName}'s cleaning scheduler for ${this.options.property.address}. Reply YES to get cleaning texts, or STOP to opt out.`,
      });
      if (text) sent.push(text);
    }
    return sent;
  }

  private async sendGroupInvites(): Promise<CleanerText[]> {
    if (!this.groupChat || !this.owner || !this.cleanerPhone) return [];
    const sent: CleanerText[] = [];
    for (const extra of this.groupChat.extra ?? []) {
      const phone = parsePhone(extra.phone);
      if (!phone || this.participantConsent.get(phone) !== "pending") continue;
      const text = await this.emit({
        id: `opt-in:${phone}`,
        to: phone,
        kind: "opt-in",
        body: groupInviteBody(this.groupChat.hostName, this.options.property.address),
      });
      if (text) sent.push(text);
    }
    return sent;
  }

  private async optInParticipant(from: string, id: string): Promise<ReceiveResult> {
    this.participantConsent.set(from, "in");
    this.inboundIds.push(id);
    const sent = await this.drainOne();
    this.save();
    return { handled: true, reason: "opted-in", sent };
  }

  private audience(): { phone: string; role: "owner" | "manager" | "observer" | "cleaner"; consent: "pending" | "in" | "out" }[] {
    const people: { phone: string; role: "owner" | "manager" | "observer" | "cleaner"; consent: "pending" | "in" | "out" }[] = [];
    if (this.owner) people.push({ phone: this.owner, role: "owner", consent: this.everConsented && !this.optedOut ? "in" : "out" });
    if (this.cleanerPhone) people.push({ phone: this.cleanerPhone, role: "cleaner", consent: this.cleanerConsent });
    for (const person of this.messaging?.participants ?? []) {
      const phone = parsePhone(person.phone);
      if (!phone || phone === this.owner || phone === this.cleanerPhone) continue;
      people.push({ phone, role: person.role, consent: this.participantConsent.get(phone) ?? "pending" });
    }
    return people;
  }

  private messagingMode(): "cleaner-only" | "native" | "mirrored" {
    if (!this.messaging || this.messaging.requested !== "group") return "cleaner-only";
    const people = this.audience();
    const pending = people.some((person) => person.consent === "pending");
    if (!pending && this.messaging.capable && people.some((person) => person.consent === "in")) return "native";
    return "mirrored";
  }

  private excludedPhones(): string[] {
    const skipped = this.audience().filter((person) => person.consent !== "in").map((person) => person.phone);
    return [...new Set([...skipped, ...this.groupPhones])];
  }

  private participantRole(phone: string): "owner" | "manager" | "observer" | "cleaner" | undefined {
    return this.audience().find((person) => person.phone === phone)?.role;
  }

  private isExtraParticipant(phone: string): boolean {
    const role = this.participantRole(phone);
    return role === "observer" || role === "manager";
  }

  private foreignPhone(phone: string): boolean {
    if (phone === this.owner || phone === this.cleanerPhone) return false;
    if (isOtherScratchTenantPhone(this.tenantId, phone)) return true;
    if (!this.isolate) return false;
    return SCRATCH_TENANTS.some((tenant) => phone === tenant.ownerPhone || phone === tenant.cleanerPhone || phone === tenant.unapprovedPhone);
  }

  private freshnessView(): SourceFreshness[] {
    const rows: SourceFreshness[] = [];
    for (const snapshot of this.latest.values()) {
      if (snapshot.kind !== "notion") continue;
      const fetchedAt = snapshot.fetchedAt ?? null;
      rows.push({ kind: snapshot.kind, fetchedAt, stale: this.isStale(fetchedAt ?? undefined) });
    }
    return rows;
  }

  private isStale(fetchedAt: string | undefined): boolean {
    if (!fetchedAt) return true;
    const readAt = Date.parse(fetchedAt);
    if (Number.isNaN(readAt)) return true;
    return this.now().getTime() - readAt > this.thresholdMs;
  }

  private inQuietHours(): boolean {
    if (!this.quiet) return false;
    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone: this.options.property.timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(this.now());
    const match = /^(\d{2}):(\d{2})$/.exec(local);
    if (!match?.[1] || !match[2]) return false;
    const nowMinutes = Number(match[1]) * 60 + Number(match[2]);
    const from = minutesOf(this.quiet.from);
    const until = minutesOf(this.quiet.until);
    if (from === until) return false;
    if (from < until) return nowMinutes >= from && nowMinutes < until;
    return nowMinutes >= from || nowMinutes < until;
  }

  private syncBlocked(conversation: "closed" | "open"): PollResult | undefined {
    if (!this.enabled) return this.noteSync({ polled: false, reason: "disabled", sent: [], jobs: [], blocks: [] }, conversation);
    if (!this.scratchReady()) return this.noteSync({ polled: false, reason: "scratch-only", sent: [], jobs: this.jobs(), blocks: [] }, conversation);
    if (!this.everConsented) return this.noteSync({ polled: false, reason: "not-consented", sent: [], jobs: [], blocks: [] }, conversation);
    return undefined;
  }

  private noteSync(result: PollResult, conversation: "closed" | "open"): PollResult {
    this.syncState = { reason: result.reason, conversation, sources: this.sourceNames(), conflicts: this.conflictState };
    return result;
  }

  private async applySnapshots(snapshots: readonly SourceSnapshot[], conversation: "closed" | "open"): Promise<PollResult> {
    const started = Date.now();
    for (const snapshot of snapshots) {
      this.latest.set(snapshot.sourceId, snapshot);
      this.rememberSource(snapshot, "ok");
    }
    const freshness = snapshots.map((snapshot) => freshnessOf(snapshot.fetchedAt, this.now().getTime(), this.thresholdMs));
    if (freshness.length > 0 && freshness.every((status) => status === "fresh")) this.resolveKind("stale-source");
    const normalized = normalizeSnapshots(this.orderedSnapshots());
    this.conflictState = normalized.conflicts;
    this.provenanceState = normalized.provenance;
    this.fallbackText = undefined;
    this.blockState = normalized.feed.blocks;
    const preserveHostClock = this.watchFreshness && freshness.includes("stale");
    const kept = this.keepJobIds(normalized.feed.turnovers, normalized.provenance);
    this.reconcile(kept.turnovers, preserveHostClock, kept.moved);
    this.learnAliases(kept.uids);
    const settled = await this.settleUncertain();
    const sent = this.optedOut || this.problemHold ? [] : await this.drainOne();
    sent.unshift(...settled);
    this.counters.polls += 1;
    this.counters.pollDurationMs += Math.max(0, Date.now() - started);
    this.maybeScheduledBackup();
      if (!this.optedOut && !this.problemHold) {
      const optIn = await this.sendOptIn();
      if (optIn) sent.push(optIn);
      for (const extra of await this.sendParticipantOptIns()) sent.push(extra);
      for (const invite of await this.sendGroupInvites()) sent.push(invite);
    }
    this.save();
    const result: PollResult = { polled: true, reason: "read", sent, jobs: this.jobs(), blocks: this.blocks() };
    this.syncState = { reason: "read", conversation, sources: this.sourceNames(), conflicts: this.conflictState };
    return result;
  }

  private sourceNames(): string[] {
    return this.orderedSnapshots().map((snapshot) => snapshot.sourceId);
  }

  /** Guesty Lite, then the saved calendar links in saved order, then Google, then Notion. */
  private orderedSnapshots(held: ReadonlyMap<string, SourceSnapshot> = this.latest, order: readonly string[] = this.sourceOrder): SourceSnapshot[] {
    const rank = (snapshot: SourceSnapshot) => BOOKING_SOURCE_KINDS.indexOf(snapshot.kind);
    const place = (snapshot: SourceSnapshot) => {
      const index = order.indexOf(snapshot.sourceId);
      return index === -1 ? order.length : index;
    };
    return [...held.values()]
      .map((snapshot, index) => ({ snapshot, index }))
      .sort((a, b) => rank(a.snapshot) - rank(b.snapshot) || place(a.snapshot) - place(b.snapshot) || a.index - b.index)
      .map((item) => item.snapshot);
  }

  private withSync(result: PollResult): PollResult & SyncState {
    return { ...result, ...this.lastSync() };
  }

  private async answer(id: string, from: string, text: string): Promise<ReceiveResult> {
    const job = this.conversationJob();
    if (!job) return this.quietOrGuide(from, id, text);
    const status = this.derive(job);
    const minutes = clockMinutes(text);
    if (this.groupChat && from === this.owner && (status === "discovered" || status === "awaiting_checkin" || status === "offered")) {
      return this.markIgnored(id);
    }
    if (status === "discovered" || status === "awaiting_checkin") {
      if (from !== this.owner) return this.quietOrGuide(from, id, text);
      const chosen = isYes(text) ? (status === "discovered" ? this.defaultCheckout : this.defaultCheckIn) : minutes;
      if (chosen === undefined) return this.markIgnored(id);
      this.addFact(job.id, status === "discovered" ? "checkout" : "checkin", chosen);
      this.inboundIds.push(id);
      const sent = await this.drainOne();
      return { handled: true, reason: "host-time", sent };
    }
    if (status === "offered") {
      if (from === this.owner && minutes !== undefined) {
        this.addFact(job.id, "checkout", minutes);
        this.inboundIds.push(id);
        const sent = await this.drainOne();
        return { handled: true, reason: "host-time", sent };
      }
      const confirmer = this.cleanerRecord()?.phone;
      if (!confirmer || from !== confirmer) return this.quietOrGuide(from, id, text);
      if (isYes(text)) {
        if (this.stale(job)) return this.quietOrGuide(from, id, text);
        const sent = await this.confirm(job);
        if (sent.length === 0 && !this.confirmSent(job)) return { handled: true, reason: "ignored", sent: [] };
        this.inboundIds.push(id);
        return { handled: true, reason: "scheduled", sent };
      }
      if (isNo(text)) {
        job.declined = true;
        this.inboundIds.push(id);
        return this.reply(confirmer, DECLINED, "declined", "declined", id, job.id);
      }
    }
    return this.quietOrGuide(from, id, text);
  }

  private async confirm(job: Job): Promise<CleanerText[]> {
    if (this.problemHold) return [];
    const checkout = this.latestFact(job.id, "checkout");
    const to = this.cleanerRecord()?.phone;
    if (!checkout || !to) return [];
    const when = this.clock(job.checkoutDate, checkout.minutes);
    const id = `confirm:${job.id}:${job.checkoutDate}:${checkout.minutes}:${job.nextCheckInDate ?? ""}`;
    const text = await this.emit({
      id,
      jobId: job.id,
      to,
      kind: "confirm",
      body: `Cleaning is scheduled for ${when.day} at ${when.time} at ${this.options.property.address}.`,
    });
    return text ? [text] : [];
  }

  /** The property's opted-in cleaner. No record means cleaner texts stay unsent. */
  private cleanerRecord(): OptedInCleaner | undefined {
    return asOptedInCleaner({
      phone: this.cleanerPhone,
      approved: this.options.cleaner.approved,
      consent: this.cleanerConsent,
    });
  }

  private awaitingOptIn(): boolean {
    return Boolean(this.cleanerPhone && this.cleanerConsent === "pending" && this.delivery(`opt-in:${this.cleanerPhone}`) === "sent");
  }

  private async sendOptIn(): Promise<CleanerText | null> {
    if (this.deferCleaner) return null;
    if (!this.pin || !this.options.cleaner.approved || !this.cleanerPhone || this.cleanerConsent !== "pending") return null;
    const id = `opt-in:${this.cleanerPhone}`;
    if (this.delivery(id) === "sent") return null;
    return this.emit({
      id,
      to: this.cleanerPhone,
      kind: "opt-in",
      body: this.cleanerOptInBody(),
    });
  }

  private hostInviteOpen(): boolean {
    if (!this.owner || this.hostGroup !== "pending" || this.ownerOptedOut) return false;
    return this.delivery(`opt-in:${this.owner}`) === "sent";
  }

  private async optInHost(id: string): Promise<ReceiveResult> {
    this.hostGroup = "in";
    this.hostGroupSaved = true;
    this.ownerOptedOut = false;
    this.inboundIds.push(id);
    this.save();
    return { handled: true, reason: "opted-in", sent: [] };
  }

  private async sendHostOptIn(): Promise<CleanerText | null> {
    if (this.groupChat) return null;
    if (!this.owner || this.ownerOptedOut) return null;
    const id = `opt-in:${this.owner}`;
    if (this.delivery(id) === "sent") return null;
    const body = `Hi, this is ${this.hostName} at ${this.options.property.address}. Reply YES to get cleaning texts, or STOP to opt out.`;
    return this.emit({ id, to: this.owner, kind: "opt-in", body });
  }

  private cleanerOptInBody(): string {
    if (this.groupChat && this.cleanerPhone) {
      return groupInviteBody(this.groupChat.hostName, this.options.property.address);
    }
    return this.options.optInBody ?? `Hi, this is ${this.hostName}'s cleaning scheduler for ${this.options.property.address}. Reply YES to get cleaning texts, or STOP to opt out.`;
  }

  private async optInCleaner(id: string): Promise<ReceiveResult> {
    if (!this.cleanerPhone || this.delivery(`opt-in:${this.cleanerPhone}`) !== "sent" || this.cleanerConsent !== "pending") {
      return this.markIgnored(id);
    }
    this.cleanerConsent = "in";
    this.inboundIds.push(id);
    const sent = await this.drainOne();
    this.save();
    return { handled: true, reason: "opted-in", sent };
  }

  private async finish(from: string, id: string): Promise<ReceiveResult & { label?: MessageHandled }> {
    if (this.cleanerConsent !== "in") return this.markIgnored(id);
    if (this.problemHold) return this.guide(from, id);
    const job = this.progressJob();
    if (!job) {
      for (const finished of this.ordered()) {
        if (finished.done && this.pinDelivered(finished)) await this.tellHostDone(finished);
      }
      return this.guide(from, id);
    }
    if (this.options.photosRequired && (job.photos ?? 0) === 0) {
      // The cleaning stays open until a photo arrives.
      const asked = await this.reply(from, PHOTO_FIRST, "next", "ignored", id, job.id);
      if ((asked.sent.length > 0 || this.delivery(`next:${id}`) === "sent") && !this.inboundIds.includes(id)) this.inboundIds.push(id);
      this.save();
      return { ...asked, label: "none" };
    }
    const result = await this.reply(from, "Thanks, cleaning marked done.", "done", "done", id, job.id);
    const acked = result.sent.length > 0 || this.delivery(`done:${id}`) === "sent";
    if (acked) {
      job.started = true;
      job.done = true;
      job.doneAt = this.now().toISOString();
      if (!this.inboundIds.includes(id)) this.inboundIds.push(id);
      await this.tellHostDone(job);
    }
    this.save();
    // The job is done only once the cleaner's acknowledgement went out.
    return acked ? result : { ...result, label: "none" };
  }

  /** The cleaning in progress: the code went to the cleaner and it isn't done, called off, or declined. */
  private progressJob(): Job | undefined {
    return this.ordered().find((item) => !item.done && !item.canceled && !item.declined && this.pinDelivered(item));
  }

  /**
   * Records a cleaner text during the cleaning: its saved photos, the start time on the first photo
   * or other message, and, with supply notes on, that message as a redacted note. A keyword (YES, NO,
   * DONE, STOP, START, HELP) or an injury report is not a message here and changes nothing.
   */
  private noteProgress(job: Job, input: InboundText): void {
    const text = input.text.trim();
    const words = text.length > 0 && !isCleanerKeyword(text) && !isInjuryReport(text) && !isPlainLanguageStop(text);
    let changed = false;
    // Every attachment counts as sent, so a failed download (no Twilio login, too big, too slow, an
    // unlisted type) never traps the cleaner at the photo rule. Saved ones are counted apart.
    if ((input.media ?? 0) > 0) {
      job.photos = (job.photos ?? 0) + (input.media ?? 0);
      changed = true;
    }
    if ((input.photos ?? 0) > 0) {
      job.photosSaved = (job.photosSaved ?? 0) + (input.photos ?? 0);
      changed = true;
    }
    if (!job.startedAt && (words || (input.media ?? 0) > 0)) {
      job.startedAt = this.now().toISOString();
      changed = true;
    }
    if (this.options.supplyNotes && words) {
      job.notes = [...(job.notes ?? []), this.noteText(text)].slice(-MAX_NOTES);
      changed = true;
    }
    if (changed) this.save();
  }

  /** A job note: the door code and every run of 4 or more digits, even split by spaces or dashes, redacted. */
  private noteText(text: string): string {
    const redacted = redactDigitRuns(this.redact(text));
    return redacted.trim().slice(0, MAX_NOTE);
  }

  private cleanerStep(): CleanerStep {
    if (this.problemHold) return "on-hold";
    const delivered = this.ordered().find((item) => !item.canceled && !item.declined && this.pinDelivered(item));
    if (delivered?.done) return "already-done";
    if (delivered) return "in-progress";
    const open = this.ordered().find((item) => !item.done && !item.canceled && !item.declined);
    if (!open) return "already-done";
    const status = this.derive(open);
    if (status === "offered") return "needs-yes";
    if (status === "confirmed" || status === "awaiting_departure") return "waiting-for-guests";
    return "waiting-for-code";
  }

  private async guide(from: string, id: string): Promise<ReceiveResult> {
    const result = await this.reply(from, cleanerNextStep(this.cleanerStep()), "next", "ignored", id);
    if (result.sent.length > 0 || this.delivery(`next:${id}`) === "sent") {
      if (!this.inboundIds.includes(id)) this.inboundIds.push(id);
    }
    this.save();
    return result;
  }

  private async quietOrGuide(from: string, id: string, text: string): Promise<ReceiveResult> {
    if (from === this.cleanerPhone && this.cleanerConsent === "in" && keywordOf(text) !== "help") {
      // A photo, with or without words, never gets the guide. Grok reads it as a message.
      if (this.withMedia.has(id) && !isCleanerKeyword(text)) return this.markIgnored(id);
      // Grok reads a text that isn't a keyword and decides what happens next. Only the cleaner can
      // take an offer or finish a cleaning, so the guide to YES or DONE still goes in those steps.
      if (this.options.grokReadsMessages && !isCleanerKeyword(text)) {
        const step = this.cleanerStep();
        if (step !== "needs-yes" && step !== "in-progress") return this.markIgnored(id);
      }
      return this.guide(from, id);
    }
    return this.markIgnored(id);
  }

  private async tellHostDone(job: Job): Promise<void> {
    if (!this.owner) return;
    const draft: Draft = {
      id: `done-host:${job.id}`,
      jobId: job.id,
      to: this.owner,
      kind: "done",
      body: hostDoneLine(this.options.property.address),
    };
    // The landlord's done line goes into the group too. It stays one-to-one when the group can't be made.
    if (this.routesToGroup(draft) && (await this.emitRouted(draft)) !== undefined) return;
    await this.emitOne(draft);
  }

  private async clearDeparture(id: string): Promise<ReceiveResult> {
    // The next confirmed job, or else the last started or finished one, so a failed code text can still be resent.
    const job = this.codeJob();
    if (!job || this.stale(job) || !this.confirmSent(job)) return this.markIgnored(id);
    this.recordClearance(job);
    this.inboundIds.push(id);
    this.save();
    if (this.halt === "before-pin") throw new HaltError("before-pin");
    const sent = await this.deliverPin(job);
    this.save();
    return { handled: true, reason: "departure", sent };
  }

  private async moveCheckout(id: string, from: string, text: string): Promise<ReceiveResult | undefined> {
    if (this.groupChat) return undefined;
    if (!this.pin || from !== this.owner) return undefined;
    const job = this.releaseJob();
    const minutes = clockMinutes(text);
    const checkout = job ? this.latestFact(job.id, "checkout") : undefined;
    if (!job || minutes === undefined || !checkout || minutes <= checkout.minutes) return undefined;
    this.addFact(job.id, "checkout", minutes);
    job.started = false;
    job.done = false;
    this.dropClearance(job.id);
    this.cancelUnsentPin(job.id);
    this.inboundIds.push(id);
    const sent = await this.drainOne();
    this.save();
    return { handled: true, reason: "host-time", sent };
  }

  private async deliverPin(job: Job): Promise<CleanerText[]> {
    if (!this.pin || !this.cleanerPhone || this.optedOut || this.stale(job) || job.canceled || job.declined) return [];
    const key = this.pinKey(job);
    if (!key) return [];
    const sent: CleanerText[] = [];
    if (!this.options.cleaner.approved || this.cleanerConsent !== "in") {
      if (this.cleanerConsent === "out" && this.options.cleaner.approved && this.owner && !this.groupPhones.includes(this.owner)) {
        const held = await this.emit({
          id: `pin-held:${key}`,
          jobId: job.id,
          to: this.owner,
          kind: "pin-held",
          body: optedOutCodeLine(),
        });
        if (held) sent.push(held);
      }
      this.dropClearance(job.id);
      return sent;
    }
    if (this.delivery(key) !== "sent" && this.sourceFeedStale()) {
      const alert = await this.alertStale();
      return alert ? [alert] : [];
    }
    if (this.problemHold || this.groupPinTerminal) return sent;
    if (this.delivery(key) !== "sent" && this.pin) {
      const pin = this.pin;
      const route = this.groupChat ? codeRoute(this.groupSeats()) : "private";
      if (route === "held") return sent;
      // The host's note rides on the door code, so the cleaner reads it as the cleaning starts.
      const body = withHostNote(doorCodeBody(this.options.property.address, pin, this.options.lockLocation?.trim() || undefined), this.options.cleaningNote);
      const addressed = addressCleaner(this.cleanerRecord(), { kind: "pin", body });
      if (!addressed) return sent;
      let text: CleanerText | null = null;
      let grouped = false;
      if (this.pinChannel() === "group") {
        await this.ensureIntro();
        const audience = this.groupAudience();
        text = await this.emitOne({
          id: key,
          jobId: job.id,
          to: addressed.to,
          kind: "pin",
          body: withHostNote(groupDoorCodeBody(this.options.property.address, pin, this.groupChat!.cleanerName, this.options.lockLocation?.trim() || undefined), this.options.cleaningNote),
          channel: "group",
          audience,
        });
        // Only a group that was never confirmed falls back, to the cleaner alone. A failed or uncertain post goes to review.
        grouped = text !== null || this.delivery(key) !== undefined || Boolean(this.options.holdSends?.());
      }
      if (!grouped) {
        text = await this.emit({
          id: key,
          jobId: job.id,
          to: addressed.to,
          kind: "pin",
          body: addressed.body,
        });
      }
      if (text) sent.push(text);
      if (this.delivery(key) === "sent") sent.push(...(await this.sendChecklist(job)));
    }
    if (this.groupChat && this.groupPinTerminal && this.delivery(key) !== "sent") return sent;
    if (this.delivery(key) === "failed" && this.owner && !this.groupPhones.includes(this.owner)) {
      const failed = await this.emit({
        id: `pin-failed:${key}`,
        jobId: job.id,
        to: this.owner,
        kind: "pin-failed",
        body: this.options.pinFailedBody ?? "The door code didn't reach the cleaner. We'll try again in a few minutes.",
      });
      if (failed) sent.push(failed);
    }
    if (this.delivery(key) === "sent" && this.owner && !this.groupPhones.includes(this.owner)) {
      const notice = await this.emit({
        id: `pin-notice:${key}`,
        jobId: job.id,
        to: this.owner,
        kind: "pin-notice",
        body: this.options.pinSentBody ?? "Door code sent to the cleaner.",
      });
      if (notice) sent.push(notice);
    }
    return sent;
  }

  /** The saved checklist, privately to the cleaner, once per job, right after the door code went. */
  private async sendChecklist(job: Job): Promise<CleanerText[]> {
    const checklist = this.options.checklist;
    const to = this.cleanerRecord()?.phone;
    if (!checklist || checklist.items.length === 0 || !to) return [];
    const id = `checklist:${job.id}`;
    if (this.delivery(id) === "sent") return [];
    const items = [...checklist.items];
    const text = await this.emit({
      id,
      jobId: job.id,
      to,
      kind: "checklist",
      body: checklistBody(checklist.name, items),
      afterSend: () => {
        job.checklist = items;
      },
    });
    return text ? [text] : [];
  }

  /**
   * A stay read under another source's UID keeps the job it already has, so the host's times and the
   * cleaner's YES stay and nobody gets a cancel and a new offer. That happens when calendars are
   * reordered or a duplicate calendar is removed. A job matches only the same booking: one of the
   * merged stay's source UIDs is one the job was already read under (its aliases). A different booking
   * on the same day is a new job, because a calendar date never confirms a time. A called-off job is
   * never taken over.
   */
  private keepJobIds(turnovers: Turnover[], provenance: JobProvenance[]): { turnovers: Turnover[]; moved: Set<string>; uids: Map<string, string[]> } {
    const uidsOf = (turnover: Turnover) => provenance.find((item) => item.jobId === turnover.id)?.sources.map((source) => source.uid) ?? [turnover.id];
    const owner = new Map<string, Job>();
    for (const job of this.jobsState) {
      if (job.canceled) continue;
      for (const uid of aliasesOf(job)) if (!owner.has(uid)) owner.set(uid, job);
    }
    const ids = new Set(turnovers.map((turnover) => turnover.id));
    const claimed = new Set(this.jobsState.filter((job) => ids.has(job.id)).map((job) => job.id));
    const rename = new Map<string, string>();
    for (const turnover of turnovers) {
      if (claimed.has(turnover.id)) continue;
      const match = uidsOf(turnover)
        .map((uid) => owner.get(uid))
        .find((job): job is Job => job !== undefined && !claimed.has(job.id));
      if (!match) continue;
      claimed.add(match.id);
      rename.set(turnover.id, match.id);
    }
    const uids = new Map(turnovers.map((turnover) => [rename.get(turnover.id) ?? turnover.id, uidsOf(turnover)] as const));
    if (rename.size === 0) return { turnovers, moved: new Set(), uids };
    const mapped = turnovers.map((turnover) => {
      const id = rename.get(turnover.id) ?? turnover.id;
      const arrivingUid = turnover.arrivingUid === null ? null : (rename.get(turnover.arrivingUid) ?? turnover.arrivingUid);
      return {
        ...turnover,
        id,
        departingUid: id === turnover.id ? turnover.departingUid : id,
        arrivingUid,
        contentHash: `${turnover.checkoutDate}|${turnover.nextCheckInDate ?? ""}|${arrivingUid ?? ""}`,
      };
    });
    return { turnovers: mapped, moved: new Set(rename.values()), uids };
  }

  /** A live job learns every source UID its booking was just read under. */
  private learnAliases(uids: Map<string, string[]>): void {
    for (const job of this.jobsState) {
      const seen = uids.get(job.id);
      if (!seen || job.canceled) continue;
      job.aliases = [...new Set([...aliasesOf(job), ...seen])];
    }
  }

  private reconcile(turnovers: Turnover[], preserveHostClock = false, moved: ReadonlySet<string> = new Set()): void {
    const seen = new Set<string>();
    for (const turnover of turnovers) {
      seen.add(turnover.id);
      const tomb = this.tombstones.find((item) => item.uid === turnover.id);
      const existing = this.jobsState.find((job) => job.id === turnover.id);
      if (!existing) {
        if (tomb && turnover.contentHash === tomb.contentHash) continue;
        this.jobsState.push({
          id: turnover.id,
          departingUid: turnover.departingUid,
          arrivingUid: turnover.arrivingUid,
          ...(turnover.checkInDate ? { checkInDate: turnover.checkInDate } : {}),
          checkoutDate: turnover.checkoutDate,
          nextCheckInDate: turnover.nextCheckInDate,
          sameDay: turnover.sameDay,
          version: (tomb?.version ?? 0) + 1,
          sourceSequence: turnover.sequence,
          contentHash: turnover.contentHash,
          canceled: false,
          declined: false,
          announced: null,
          started: false,
          done: false,
        });
        continue;
      }
      if (existing.canceled && turnover.contentHash === existing.contentHash) continue;
      // Sequence numbers from different sources don't compare, so a stay taken over from another UID skips this.
      if (!moved.has(existing.id) && turnover.sequence < existing.sourceSequence) continue;
      // The stay's check-in is not part of the content hash, so it is kept up to date here.
      if (turnover.checkInDate) existing.checkInDate = turnover.checkInDate;
      if (preserveHostClock && this.latestFact(existing.id, "checkout")) {
        existing.sourceSequence = Math.max(existing.sourceSequence, turnover.sequence);
        continue;
      }
      if (turnover.contentHash === existing.contentHash && !existing.canceled) {
        existing.sourceSequence = Math.max(existing.sourceSequence, turnover.sequence);
        continue;
      }
      const checkoutDateChanged = existing.checkoutDate !== turnover.checkoutDate;
      const checkInDateChanged = existing.nextCheckInDate !== turnover.nextCheckInDate;
      existing.arrivingUid = turnover.arrivingUid;
      existing.checkoutDate = turnover.checkoutDate;
      existing.nextCheckInDate = turnover.nextCheckInDate;
      existing.sameDay = turnover.sameDay;
      existing.contentHash = turnover.contentHash;
      existing.sourceSequence = turnover.sequence;
      existing.version += 1;
      existing.canceled = false;
      if (checkoutDateChanged) {
        this.clearHostTime(existing.id, "checkout");
        this.dropClearance(existing.id);
        existing.started = false;
        existing.done = false;
        this.cancelUnsentPin(existing.id);
      }
      if (checkInDateChanged) this.clearHostTime(existing.id, "checkin");
      this.cancelPendingReminders(existing.id);
    }
    for (const job of this.jobsState) {
      if (seen.has(job.id) || job.canceled) continue;
      // A calendar read covers a window of days. A job that is under way, finished, or past
      // simply left that window, so it is kept as it is and nobody is told it was called off.
      if (job.done || job.started || this.pinDelivered(job) || this.beforeToday(job.checkoutDate)) continue;
      job.canceled = true;
      job.version += 1;
      this.tombstones.push({ uid: job.id, version: job.version, contentHash: job.contentHash });
      this.dropClearance(job.id);
      this.cancelUnsentPin(job.id);
      this.cancelPendingReminders(job.id);
    }
  }

  private async drainOne(): Promise<CleanerText[]> {
    if (this.optedOut || this.problemHold) return [];
    const intro = await this.ensureIntro();
    if (intro) this.pendingIntros = this.pendingIntros.filter((item) => item !== intro);
    const rest = await this.drainJobs();
    return intro ? [intro, ...rest] : rest;
  }

  private async drainJobs(): Promise<CleanerText[]> {
    for (const job of this.ordered()) {
      if (job.declined) continue;
      if (job.canceled) {
        const draft = this.noticeFor(job);
        if (!draft) continue;
        const text = await this.emit(draft);
        return text ? [text] : [];
      }
      const status = this.derive(job);
      if (status === "confirmed" || status === "awaiting_departure" || status === "cleared" || status === "in_progress" || status === "done") continue;
      const draft = this.noticeFor(job);
      if (!draft) return [];
      if ((draft.kind === "offer" || draft.kind === "corrected" || draft.kind === "held") && this.sourceFeedStale()) {
        const alert = await this.alertStale();
        return alert ? [alert] : [];
      }
      const text = await this.emit(draft);
      return text ? [text] : [];
    }
    return [];
  }

  private noticeFor(job: Job): Draft | null {
    if (!this.owner) return null;
    if (job.canceled) {
      if (!this.toldOwner(job.id)) return null;
      const id = `cancel:${job.id}:v${job.version}`;
      if (this.delivery(id) === "sent") return null;
      return { id, jobId: job.id, to: this.owner, kind: "cancel-update", body: this.canceledBody(job) };
    }
    if (job.declined) return null;
    const checkout = this.latestFact(job.id, "checkout");
    const checkin = this.latestFact(job.id, "checkin");
    if (!checkout) {
      if (this.groupChat) return null;
      const id = `host-checkout:${job.id}:${job.checkoutDate}:${this.defaultCheckout}`;
      if (this.delivery(id) === "sent") return null;
      const when = this.clock(job.checkoutDate, this.defaultCheckout);
      return {
        id,
        jobId: job.id,
        to: this.owner,
        kind: "host-checkout",
        body: this.newBookingAsk(job.id) ?? `Is checkout at ${this.options.property.address} on ${when.day} still ${when.time}? Reply YES or send the new time.`,
      };
    }
    if (job.nextCheckInDate && !checkin) {
      if (this.groupChat) return null;
      const id = `host-checkin:${job.id}:${job.nextCheckInDate}:${this.defaultCheckIn}`;
      if (this.delivery(id) === "sent") return null;
      const when = this.clock(job.nextCheckInDate, this.defaultCheckIn);
      return {
        id,
        jobId: job.id,
        to: this.owner,
        kind: "host-checkin",
        body: `Is check-in at ${this.options.property.address} on ${when.day} still ${when.time}? Reply YES or send the new time.`,
      };
    }
    if (!job.announced) {
      if (this.deferCleaner) return null;
      if (!this.offerDue(job)) return null;
      const checkMinutes = checkin?.minutes ?? null;
      const checkoutWhen = this.clock(job.checkoutDate, checkout.minutes);
      const nextWhen = job.nextCheckInDate ? this.clock(job.nextCheckInDate, checkMinutes ?? this.defaultCheckIn) : null;
      const addressed = addressCleaner(this.cleanerRecord(), {
        kind: "offer",
        body: offerBody(this.options.property.address, checkoutWhen, nextWhen, job.sameDay),
      });
      if (!addressed) {
        if (!this.owner) return null;
        const holdId = `hold:${job.id}:${job.checkoutDate}`;
        if (this.delivery(holdId) === "sent") return null;
        return {
          id: holdId,
          jobId: job.id,
          to: this.owner,
          kind: "held",
          body: waitingForYesNote(this.options.property.address),
        };
      }
      const id = `offer:${job.id}:${job.checkoutDate}:${checkout.minutes}:${job.nextCheckInDate ?? ""}:${checkMinutes ?? ""}`;
      if (this.delivery(id) === "sent") return null;
      return {
        id,
        jobId: job.id,
        to: addressed.to,
        kind: "offer",
        body: addressed.body,
        afterSend: () => {
          job.announced = this.currentAnnouncement(job);
        },
      };
    }
    if (this.checkoutDrift(job)) {
      const to = this.cleanerRecord()?.phone;
      if (!to) return null;
      const when = this.clock(job.checkoutDate, checkout.minutes);
      const id = `corrected:${job.id}:${job.checkoutDate}:${checkout.minutes}:${job.nextCheckInDate ?? ""}`;
      if (this.delivery(id) === "sent") return null;
      return {
        id,
        jobId: job.id,
        to,
        kind: "corrected",
        body: `Update: checkout at ${this.options.property.address} moved to ${when.day} at ${when.time}. Reply YES to keep the cleaning, or STOP to opt out.`,
        afterSend: () => {
          job.announced = this.currentAnnouncement(job);
        },
      };
    }
    if (job.announced && this.stale(job)) job.announced = this.currentAnnouncement(job);
    return null;
  }

  /** Offer, reminder, and door-code texts are re-addressed here. No cleaner record means they are not sent. */
  private async emit(draft: Draft): Promise<CleanerText | null> {
    // A group that couldn't be confirmed sends one-to-one instead, with no host copy and no second group try.
    let fellBack = false;
    if (!draft.channel && this.routesToGroup(draft)) {
      let routed = draft;
      if (draft.kind === "offer" || draft.kind === "reminder") {
        const addressed = addressCleaner(this.cleanerRecord(), { kind: draft.kind, body: draft.body });
        if (!addressed) return null;
        routed = { ...draft, to: addressed.to, body: addressed.body };
      } else if (draft.kind === "cancel-update" && this.cleanerPhone) {
        routed = { ...draft, to: this.cleanerPhone };
      }
      const grouped = await this.emitRouted(routed);
      if (grouped !== undefined) return grouped;
      fellBack = true;
    }
    if ((draft.kind === "offer" || draft.kind === "reminder" || draft.kind === "pin") && !draft.channel) {
      const addressed = addressCleaner(this.cleanerRecord(), { kind: draft.kind, body: draft.body });
      if (!addressed) return null;
      const text = await this.emitOne({
        id: draft.id,
        ...(draft.jobId ? { jobId: draft.jobId } : {}),
        to: addressed.to,
        body: addressed.body,
        kind: draft.kind,
        ...(draft.afterSend ? { afterSend: draft.afterSend } : {}),
      });
      if (this.delivery(draft.id) !== "sent") return null;
      if (draft.kind === "offer" && !fellBack) await this.copyOffer({ ...draft, body: addressed.body }, addressed.to);
      return text;
    }
    if (draft.kind === "cancel-update") {
      const cleaner = this.cleanerRecord();
      if (!cleaner) return this.emitOne(draft);
      return this.emitOne({
        id: draft.id,
        ...(draft.jobId ? { jobId: draft.jobId } : {}),
        to: cleaner.phone,
        body: draft.body,
        kind: draft.kind,
      });
    }
    if (draft.channel || !JOB_TEXTS.has(draft.kind)) return this.emitOne(draft);
    const cleaner = this.cleanerRecord();
    if (!cleaner) return null;
    return this.emitOne({
      id: draft.id,
      ...(draft.jobId ? { jobId: draft.jobId } : {}),
      to: cleaner.phone,
      body: draft.body,
      kind: draft.kind,
      ...(draft.afterSend ? { afterSend: draft.afterSend } : {}),
    });
  }

  private seatHost(): void {
    if (!this.groupChat || !this.owner) return;
    if (this.ownerOptedOut || this.optedOut) {
      this.hostGroup = "out";
      return;
    }
    if (this.hostGroup === "out" || this.hostGroup === "in") return;
    if (this.hostGroupSaved) return;
    if (this.everConsented) this.hostGroup = "in";
  }

  /** The group exists for job texts once the cleaner and one more person are in it. */
  private groupRouted(): boolean {
    if (!this.groupChat || !this.cleanerPhone) return false;
    const audience = this.groupAudience();
    return audience.length >= 2 && audience.includes(this.cleanerPhone);
  }

  /**
   * Where the door code goes now. The group when it holds only the landlord and the approved cleaner,
   * or when it holds anyone else and the landlord chose the group. Otherwise the cleaner alone.
   */
  private pinChannel(): "group" | "private" {
    if (!this.groupChat || !this.groupRouted() || !this.cleanerPhone || !this.options.cleaner.approved || this.cleanerConsent !== "in") return "private";
    const audience = this.groupAudience();
    const onlyLandlordAndCleaner = Boolean(this.owner) && audience.length === 2 && audience.includes(this.owner!) && audience.includes(this.cleanerPhone);
    if (onlyLandlordAndCleaner) return "group";
    return this.groupChat.doorCodeTo === "group" ? "group" : "private";
  }

  private routesToGroup(draft: Draft): boolean {
    if (!GROUP_ROUTED.has(draft.kind) || !this.groupRouted()) return false;
    if (this.owner && draft.to === this.owner) {
      // The cancellation is for the cleaner, so it goes to the group whoever it is addressed to.
      if (draft.kind === "cancel-update") return true;
      // The landlord's own line only goes there when the landlord is in the group.
      return (draft.kind === "done" || draft.kind === "emergency") && this.groupAudience().includes(this.owner);
    }
    return true;
  }

  private seatName(phone: string): string | undefined {
    return this.groupSeats().find((seat) => seat.phone === phone)?.name;
  }

  /** The same line already posted to the group for this job, under another id. */
  private groupDuplicate(draft: Draft, id: string, body: string): boolean {
    if (draft.kind !== "done" || !draft.jobId) return false;
    const seen = this.redact(body);
    return this.outboxState.some(
      (item) => item.id !== id && item.id.endsWith(":group") && item.status === "sent" && item.kind === draft.kind && item.jobId === draft.jobId && item.body === seen,
    );
  }

  /**
   * Posts a job text once into the group, asking the cleaner by name, with no one-to-one copy.
   * Undefined when the group couldn't be confirmed, so the one-to-one text goes instead.
   * A failed or uncertain post goes to review and is never sent one-to-one as well.
   */
  private async emitRouted(draft: Draft): Promise<CleanerText | null | undefined> {
    if (!this.groupChat) return undefined;
    const id = `${draft.id}:group`;
    // A text already sent one-to-one (an older store, an earlier fallback) is never posted again.
    if (this.delivery(draft.id) === "sent" || this.delivery(id) === "sent") return null;
    await this.ensureIntro();
    const audience = this.groupAudience();
    const name = this.seatName(draft.to);
    // The landlord's approved words are posted exactly as approved.
    const own = draft.kind === "offer" ? groupOfferBody(this.groupChat.cleanerName, draft.body) : name && draft.kind !== "host-message" ? namedAsk(name, draft.body) : draft.body;
    // Only the intro says how to leave the group. Later texts drop the STOP ask, and STOP still works.
    const body = draft.kind === "host-message" ? own : withoutStopAsk(own);
    if (this.groupDuplicate(draft, id, body)) return null;
    // A group text with the code in split digits is held, not sent, and not sent one-to-one either.
    if (this.pin && draft.kind !== "pin" && joinSplitDigits(body).includes(this.pin)) {
      await this.openReview("possible-code-exposure", id, true);
      return null;
    }
    const text = await this.emitOne({
      id,
      ...(draft.jobId ? { jobId: draft.jobId } : {}),
      to: this.cleanerPhone ?? audience[0] ?? draft.to,
      body,
      kind: draft.kind,
      channel: "group",
      audience,
      ...(draft.afterSend ? { afterSend: draft.afterSend } : {}),
    });
    const status = this.delivery(id);
    if (status === "sent") {
      if (draft.kind === "offer" && this.messagingMode() !== "cleaner-only") await this.copyOffer(draft, draft.to);
      // The landlord's own line still reaches Grok through get_state, beside the group post.
      if (this.owner && draft.to === this.owner) this.keepHostNote(`host:${draft.kind}:${draft.body}`, draft.body);
      return text;
    }
    // A failed or uncertain post goes to review. Only a group that was never confirmed falls back.
    return status === undefined && !this.options.holdSends?.() ? undefined : null;
  }

  private async copyOffer(draft: Draft, actor: string): Promise<void> {
    const mode = this.messagingMode();
    if (mode === "cleaner-only") {
      if (this.groupChat && this.owner && this.hostGroup === "in" && this.owner !== actor) {
        await this.emitGroup(`${draft.id}:host`, offerForOthers(draft.body), "offer", draft.jobId);
      }
      return;
    }
    const channel = mode === "native" ? "group" : "mirror";
    const body = offerForOthers(draft.body);
    for (const person of this.audience()) {
      if (person.phone === actor || person.consent !== "in" || this.groupPhones.includes(person.phone)) continue;
      await this.emitOne({
        id: `${draft.id}:${channel}:${person.phone}`,
        ...(draft.jobId ? { jobId: draft.jobId } : {}),
        to: person.phone,
        kind: "offer",
        channel,
        body: withChannelPrefix(body, channel),
      });
    }
  }

  private hostDirect(draft: Draft): Draft {
    if (!HOST_DIRECT.has(draft.kind)) return draft;
    return {
      id: draft.id,
      ...(draft.jobId ? { jobId: draft.jobId } : {}),
      to: this.owner ?? draft.to,
      body: draft.body,
      kind: draft.kind,
      ...(draft.afterSend ? { afterSend: draft.afterSend } : {}),
    };
  }

  private noteUnsentHost(draft: Draft): CleanerText | null {
    if (draft.channel === "group" || !draft.body) return null;
    if (draft.kind === "pin" || draft.kind === "pin-notice" || draft.kind === "pin-failed") return null;
    if (this.pin && draft.body.includes(this.pin)) return null;
    const forHost = (this.owner && draft.to === this.owner) || (!this.owner && HOST_DIRECT.has(draft.kind));
    if (!forHost) return null;
    if (this.outboxState.find((item) => item.id === draft.id)?.status !== "sent") this.upsert(draft, "unsent");
    this.keepHostNote(`host:${draft.kind}:${draft.body}`, draft.body);
    return { to: draft.to, body: draft.body, kind: draft.kind };
  }

  keepHostNote(id: string, body: string): void {
    if (!id || !body || this.hostNoteState.some((note) => note.id === id)) return;
    if (this.pin && body.includes(this.pin)) return;
    this.hostNoteState.push({ id, body });
    this.save();
  }

  hostNotes(): string[] {
    return this.hostNoteState.map((note) => note.body);
  }

  newBookingAsk(jobId: string): string | undefined {
    const name = this.options.usualTimesName;
    const job = this.jobsState.find((item) => item.id === jobId);
    if (!name || !job?.checkInDate) return undefined;
    const zone = this.options.property.timeZone;
    const day = (ymd: string) => formatWhen(zonedInstant(ymd, "12:00", zone), zone).day;
    return usualTimesAsk(name, day(job.checkInDate), day(job.checkoutDate), clockLabel(this.defaultCheckout), clockLabel(this.defaultCheckIn));
  }

  hostNoteEntries(): { id: string; body: string }[] {
    return this.hostNoteState.map((note) => ({ id: note.id, body: note.body }));
  }

  notePrivateCodeDelivered(): void {
    if (!this.groupChat || !this.owner) return;
    const job = this.codeJob();
    const key = job ? this.pinKey(job) : undefined;
    if (!key || this.delivery(key) !== "sent") return;
    // A code posted to the group was not delivered privately.
    if (this.outboxState.find((item) => item.id === key)?.group) return;
    this.keepHostNote(`pin-private:${key}`, privateCodeLine(this.groupChat.cleanerName));
  }

  private ownerStillGetsDone(draft: Draft): boolean {
    return draft.kind === "done" && Boolean(this.owner) && draft.to === this.owner;
  }

  private ownerDeclined(draft: Draft): boolean {
    if (!this.owner || draft.to !== this.owner || SAFETY.has(draft.kind) || this.ownerStillGetsDone(draft)) return false;
    if (this.groupChat && this.hostGroup === "out") return true;
    return this.ownerOptedOut;
  }

  private async emitOne(draft: Draft): Promise<CleanerText | null> {
    draft = this.hostDirect(draft);
    if (this.options.holdSends?.()) return null;
    if ((draft.kind === "offer" || draft.kind === "reminder" || draft.kind === "pin") && !draft.channel) {
      const addressed = addressCleaner(this.cleanerRecord(), { kind: draft.kind, body: draft.body });
      if (!addressed || draft.to !== addressed.to) return null;
    }
    if (!this.owner && HOST_DIRECT.has(draft.kind)) return this.noteUnsentHost(draft);
    if (!this.numberAllowed(draft.to)) {
      if (this.options.allowlist) return null;
      throw new Error("Cleaner Core only texts Scratch test numbers.");
    }
    // The host's own words (an approved message, the checklist, or the note on an offer) may say
    // "ready" or "door code". They never mark a job ready, and Cleaner Core's own words are still checked.
    const ownWords = this.ownWords(draft);
    if (/\bready\b/i.test(ownWords)) throw new Error("A calendar time cannot mark the job ready.");
    if (this.groupChat && draft.channel === "group") {
      const allowed = new Set(this.groupAudience());
      const audience = draft.audience ?? [];
      if (audience.length === 0 || audience.some((phone) => !allowed.has(phone))) return null;
    }
    if (this.ownerDeclined(draft)) return this.noteUnsentHost(draft);
    if (this.groupChat && draft.to === this.cleanerPhone && this.cleanerConsent === "out" && !SAFETY.has(draft.kind)) return null;
    if (draft.kind === "pin") {
      if (draft.channel === "group") {
        // The group is checked on every send, against who is in it right now.
        const now = this.groupAudience();
        const audience = draft.audience ?? [];
        const same = audience.length === now.length && audience.every((phone) => now.includes(phone));
        if (this.pinChannel() !== "group" || !same || !this.cleanerPhone || !audience.includes(this.cleanerPhone) || draft.to !== this.cleanerPhone) {
          throw new Error("The door code only goes to the approved cleaner.");
        }
      } else if (this.participantRole(draft.to) === "observer" || this.groupPhones.includes(draft.to)) {
        throw new Error("The door code only goes to the approved cleaner.");
      }
      if (!this.pin || !this.options.cleaner.approved || draft.to !== this.cleanerPhone) {
        throw new Error("The door code only goes to the approved cleaner.");
      }
    } else if (this.pin && draft.body.includes(this.pin)) {
      throw new Error("The door code leaked into a schedule text.");
    } else if (this.pin && draft.channel === "group" && joinSplitDigits(draft.body).includes(this.pin)) {
      // A group text that holds the code in split digits is held back, not sent, and goes to review.
      return this.openReview("possible-code-exposure", draft.id, true);
    } else if (draft.kind === "host-message" && this.pin && joinSplitDigits(draft.body).includes(this.pin)) {
      throw new Error("The door code leaked into a host message.");
    } else if (!this.pin && /\bdoor code\b/i.test(ownWords) && draft.kind !== "opt-in" && draft.kind !== "review") {
      throw new Error("Step C does not send a door code.");
    }
    if (this.optedOut && !SAFETY.has(draft.kind) && !this.ownerStillGetsDone(draft)) return draft.to === this.owner ? this.noteUnsentHost(draft) : null;
    if (this.participantConsent.get(draft.to) === "out" && !SAFETY.has(draft.kind) && !this.ownerStillGetsDone(draft)) {
      return draft.to === this.owner ? this.noteUnsentHost(draft) : null;
    }
    const existing = this.outboxState.find((item) => item.id === draft.id);
    if (existing?.status === "sent" || existing?.status === "canceled") return null;
    if (existing?.lease?.state === "revoked" || existing?.lease?.state === "expired") return null;
    if (existing?.status === "uncertain") return this.openReview("uncertain-sms", draft.id, true);
    const text: CleanerText = {
      to: draft.to,
      body: draft.body,
      kind: draft.kind,
      ...(draft.channel ? { channel: draft.channel } : {}),
      ...(draft.audience ? { audience: [...draft.audience] } : {}),
    };
    this.upsert(draft, "uncertain");
    this.save();
    try {
      await this.options.sink.send(text);
    } catch (err) {
      if (err instanceof HaltError) throw err;
      if (err instanceof GroupNotConfirmed && draft.channel === "group") {
        this.dropUncertain(draft.id);
        this.save();
        // Said once per number and code, whatever was being sent: the group can't start until it changes.
        if (err.refused) {
          const { phone, code } = err.refused;
          this.keepHostNote(`group-refused:${this.options.property.id}:${phone}:${code ?? ""}`, groupRefusedLine({ phone, ...(code !== undefined ? { code } : {}) }));
        }
        if (draft.kind !== "pin" && draft.kind !== "intro" && !isPrivateCodeLine(draft.body)) {
          this.keepHostNote(`group-unconfirmed:${this.options.property.id}:${draft.kind}`, groupUnconfirmedLine(draft.kind));
        }
        return null;
      }
      this.upsert(draft, "failed");
      this.counters.failed += 1;
      await this.openReview("failed-sms", draft.id, false);
      this.logSend(draft.kind, "failed", draft.to);
      this.save();
      return null;
    }
    if (this.halt === "after-accept" && draft.kind === "offer") {
      this.counters.uncertain += 1;
      this.logSend(draft.kind, "uncertain", draft.to);
      throw new HaltError("after-accept");
    }
    this.upsert(draft, "sent");
    if (draft.kind === "pin") this.pinPhase.set(draft.id, "accepted");
    this.counters.sent += 1;
    if (draft.kind === "stop") this.counters.stop += 1;
    if (draft.kind === "emergency") this.counters.injury += 1;
    this.transcriptState.push(this.redact(draft.body));
    draft.afterSend?.();
    this.logSend(draft.kind, "sent", draft.to);
    this.save();
    return text;
  }

  /** The part of a text Cleaner Core wrote itself. The host's own words are left out. */
  private ownWords(draft: Draft): string {
    if (draft.kind === "host-message" || draft.kind === "checklist") return "";
    if (draft.kind !== "offer") return draft.body;
    const note = hostNoteOf(draft.body);
    return draft.body.slice(0, draft.body.length - note.length);
  }

  private upsert(draft: Draft, status: "sent" | "failed" | "uncertain" | "canceled" | "unsent"): void {
    const next: OutboxItem = {
      id: draft.id,
      to: draft.to,
      body: this.redact(draft.body),
      kind: draft.kind,
      status,
      ...(draft.jobId ? { jobId: draft.jobId } : {}),
      ...(draft.channel === "group" ? { group: true as const } : {}),
      lease: {
        version: 1,
        actor: "engine",
        source: draft.kind,
        reason: status,
        at: this.now().toISOString(),
        state: status === "sent" ? "committed" : status === "uncertain" ? "uncertain" : status === "canceled" ? "revoked" : "open",
      },
    };
    const index = this.outboxState.findIndex((item) => item.id === draft.id);
    if (index >= 0) this.outboxState[index] = next;
    else this.outboxState.push(next);
  }

  private async safety(id: string, run: () => Promise<ReceiveResult & { seen?: boolean }>): Promise<ReceiveResult> {
    const result = await run();
    if (result.seen) this.inboundIds.push(id);
    const { seen: _seen, ...publicResult } = result;
    this.save();
    return publicResult;
  }

  private async emergency(from: string, inboundId: string): Promise<ReceiveResult & { seen?: boolean }> {
    this.problemHold = true;
    if (!this.holdCause) this.holdCause = "injury";
    const job = this.conversationJob() ?? this.ordered()[0];
    const key = `${from}|${job?.id ?? "none"}|${job?.version ?? 0}`;
    if (this.injurySent.includes(key)) return { handled: true, reason: "emergency", sent: [], seen: true };
    return this.alertHostOfInjury(from, inboundId, key, job?.id);
  }

  private injuryAlert(from: string): string {
    const address = this.options.property.address;
    const role = this.participantRole(from);
    if (from === this.cleanerPhone || role === "cleaner") {
      return `The cleaner at ${address} says someone is hurt. They've been told to call 911.`;
    }
    if (role === "observer") return `An observer at ${address} says someone is hurt. They've been told to call 911.`;
    if (role === "manager") return `A manager at ${address} says someone is hurt. They've been told to call 911.`;
    return `Someone at ${address} says someone is hurt. They've been told to call 911.`;
  }

  private async alertHostOfInjury(from: string, inboundId: string, key: string, jobId?: string): Promise<ReceiveResult & { seen?: boolean }> {
    const reporterIsHost = Boolean(this.owner && from === this.owner);
    const hostId = `emergency-host:${key}`;
    const host = !reporterIsHost && this.owner
      ? await this.emit({
          id: hostId,
          ...(jobId ? { jobId } : {}),
          to: this.owner,
          kind: "emergency",
          body: this.injuryAlert(from),
        })
      : null;
    // The hold line tells the landlord to restart the job through Grok, so it stays one-to-one.
    const hold = !reporterIsHost && this.owner
      ? await this.emitOne({
          id: `injury-hold:${key}`,
          ...(jobId ? { jobId } : {}),
          to: this.owner,
          kind: "emergency",
          body: injuryHoldLine(this.options.property.address, this.helper()),
        })
      : null;
    const hostReached = !reporterIsHost && this.delivery(hostId) === "sent";
    const ack = await this.emit({
      id: `emergency:${inboundId}`,
      ...(jobId ? { jobId } : {}),
      to: from,
      kind: "emergency",
      body: reporterIsHost ? HOST_INJURY : hostReached ? CLEANER_HURT : CLEANER_HURT_MISSED,
    });
    if (ack) this.injurySent.push(key);
    return { handled: true, reason: "emergency", sent: [...(host ? [host] : []), ...(hold ? [hold] : []), ...(ack ? [ack] : [])], seen: Boolean(ack) };
  }

  private async stopMember(from: string, inboundId: string): Promise<ReceiveResult & { seen?: boolean }> {
    const ack = this.options.stopReply ?? smsStopAck();
    if (from === this.owner && (this.ownerOptedOut || this.hostGroup === "out")) {
      return { handled: true, reason: "stop", sent: [], seen: true };
    }
    if (from === this.cleanerPhone && this.cleanerConsent === "out") {
      return { handled: true, reason: "stop", sent: [], seen: true };
    }
    if (from !== this.owner && from !== this.cleanerPhone && this.participantConsent.get(from) === "out") {
      return { handled: true, reason: "stop", sent: [], seen: true };
    }
    if (from === this.owner) {
      this.hostGroup = "out";
      this.ownerOptedOut = true;
      this.problemHold = true;
      this.rememberOwnerHold();
    }
    if (from === this.cleanerPhone) {
      this.cleanerConsent = "out";
      this.problemHold = true;
      this.holdCause = "cleaner";
    }
    this.participantConsent.set(from, "out");
    const replyBody = from === this.owner ? hostStopReply(this.options.property.address, this.problemHold) : ack;
    const result = await this.reply(from, replyBody, "stop", "stop", inboundId);
    const note: CleanerText[] = [];
    if (from === this.cleanerPhone && this.owner && from !== this.owner) {
      const held = await this.emit({
        id: `stop-host:${inboundId}`,
        to: this.owner,
        kind: "held",
        body: cleanerOptOutHold(this.options.property.address, this.helper()),
      });
      if (held) note.push(held);
    }
    return { handled: true, reason: "stop", sent: [...result.sent, ...note], seen: this.replySeen("stop", inboundId, result.sent.length) };
  }

  private groupSeats(): GroupSeat[] {
    const seats: GroupSeat[] = [];
    if (this.owner && this.groupChat) {
      seats.push({
        phone: this.owner,
        name: this.groupChat.hostName,
        role: "host",
        approved: true,
        consent: this.hostGroup,
      });
    }
    if (this.cleanerPhone && this.groupChat) {
      seats.push({
        phone: this.cleanerPhone,
        name: this.groupChat.cleanerName,
        role: "cleaner",
        approved: this.options.cleaner.approved,
        consent: this.cleanerConsent,
      });
    }
    for (const extra of this.groupChat?.extra ?? []) {
      const phone = parsePhone(extra.phone);
      if (!phone) continue;
      seats.push({
        phone,
        name: extra.name,
        role: "other",
        approved: false,
        consent: this.participantConsent.get(phone) ?? "pending",
      });
    }
    return seats;
  }

  private groupAudience(): string[] {
    return this.groupSeats().filter((seat) => seat.consent === "in").map((seat) => seat.phone);
  }

  /** The intro for the people in the group now. None until the cleaner and one more person are in. */
  private introId(): { id: string; members: string; seats: GroupSeat[] } | undefined {
    if (!this.groupChat) return undefined;
    const seats = this.groupSeats().filter((seat) => seat.consent === "in");
    // The group starts once the cleaner has joined the host or a contact. Contacts alone don't start it.
    if (seats.length < 2 || !seats.some((seat) => seat.phone === this.cleanerPhone)) return undefined;
    const members = seats.map((seat) => seat.phone).sort().join(",");
    // A membership introduced before (a member left, then came back) gets a new id, so its intro is posted again.
    const base = `intro:${members}`;
    let id = base;
    for (let n = 2; this.delivery(id) !== undefined; n += 1) id = `${base}:${n}`;
    return { id, members, seats };
  }

  /**
   * Posts an intro whenever the people in the group differ from the last group that got one, as soon as
   * two people in the group have said yes. Only engine steps call it. Opening the engine never does.
   * A failed or uncertain intro goes to review and is not posted again for that membership, and it never
   * holds back the group's other texts.
   */
  private async ensureIntro(): Promise<CleanerText | null> {
    const intro = this.introId();
    if (!intro || !this.groupChat || this.lastIntro === intro.members) return null;
    const audience = intro.seats.map((seat) => seat.phone);
    const to = audience.find((phone) => phone === this.cleanerPhone) ?? audience[0];
    if (!to) return null;
    const text = await this.emit({
      id: intro.id,
      to,
      body: groupIntroBody(intro.seats.map((seat) => seat.name), this.groupChat.hostName, this.options.property.address),
      kind: "intro",
      channel: "group",
      audience,
    });
    // Once an attempt is on record (sent, failed or waiting), this membership is introduced.
    if (this.delivery(intro.id) !== undefined) this.lastIntro = intro.members;
    if (text) this.pendingIntros.push(text);
    return text;
  }

  /** An intro posted during a step is listed first among that step's texts. */
  private takeIntros(): CleanerText[] {
    const taken = this.pendingIntros;
    this.pendingIntros = [];
    return taken;
  }

  private async emitGroup(id: string, body: string, kind: TextKind, jobId?: string): Promise<CleanerText | null> {
    if (kind !== "intro") await this.ensureIntro();
    const audience = this.groupAudience();
    const to = audience.find((phone) => phone === this.cleanerPhone) ?? audience[0];
    if (!to) return null;
    return this.emit({
      id,
      ...(jobId ? { jobId } : {}),
      to,
      body,
      kind,
      channel: "group",
      audience,
    });
  }

  private async stop(from: string, inboundId: string): Promise<ReceiveResult & { seen?: boolean }> {
    if (this.groupChat) return this.stopMember(from, inboundId);
    const ack = this.options.stopReply ?? smsStopAck();
    if (this.isExtraParticipant(from)) {
      if (this.participantConsent.get(from) === "out") return { handled: true, reason: "stop", sent: [], seen: true };
      this.participantConsent.set(from, "out");
      const result = await this.reply(from, ack, "stop", "stop", inboundId);
      return { ...result, seen: this.replySeen("stop", inboundId, result.sent.length) };
    }
    if (from === this.cleanerPhone && this.cleanerConsent === "out") {
      return { handled: true, reason: "stop", sent: [], seen: true };
    }
    if (from === this.owner && this.ownerOptedOut) {
      return { handled: true, reason: "stop", sent: [], seen: true };
    }
    if (this.pin && from === this.cleanerPhone) {
      this.cleanerConsent = "out";
      this.problemHold = true;
      this.holdCause = "cleaner";
      const result = await this.reply(from, ack, "stop", "stop", inboundId);
      const note = await this.hostStopNote(from, inboundId);
      return { handled: true, reason: "stop", sent: [...result.sent, ...note], seen: this.replySeen("stop", inboundId, result.sent.length) };
    }
    if (from === this.owner) {
      this.ownerOptedOut = true;
      if (this.pin) this.problemHold = true;
      else this.optedOut = true;
      this.rememberOwnerHold();
      const result = await this.reply(from, hostStopReply(this.options.property.address, this.problemHold), "stop", "stop", inboundId);
      return { ...result, seen: this.replySeen("stop", inboundId, result.sent.length) };
    }
    this.optedOut = true;
    this.cancelPendingReminders();
    const result = await this.reply(from, ack, "stop", "stop", inboundId);
    return { ...result, seen: this.replySeen("stop", inboundId, result.sent.length) };
  }

  private replySeen(kind: string, inboundId: string, sentNow: number): boolean {
    return sentNow > 0 || this.delivery(`${kind}:${inboundId}`) === "sent";
  }

  private rememberOwnerHold(): void {
    if (this.holdCause !== "cleaner") this.holdCause = "owner";
    this.keepHostNote(`owner-hold:${this.options.property.id}`, ownerOptOutHoldNote(this.options.property.address, this.helper()));
  }

  private async hostStopNote(from: string, inboundId: string): Promise<CleanerText[]> {
    if (!this.options.noteHostOnStop || !this.owner || from === this.owner) return [];
    const text = await this.emit({
      id: `stop-host:${inboundId}`,
      to: this.owner,
      kind: "held",
      body: cleanerOptOutHold(this.options.property.address, this.helper()),
    });
    return text ? [text] : [];
  }

  private async start(from: string, inboundId: string): Promise<ReceiveResult & { seen?: boolean }> {
    if (from === this.owner) {
      if (this.delivery(`start:${inboundId}`) === "sent") return { handled: true, reason: "start", sent: [], seen: true };
      const stillOut = this.ownerOptedOut || (this.groupChat && this.hostGroup === "out") || (!this.pin && this.optedOut);
      if (!stillOut) return { handled: true, reason: "start", sent: [], seen: true };
      this.ownerOptedOut = false;
      if (!this.pin) this.optedOut = false;
      if (this.groupChat && this.hostGroup === "out") this.hostGroup = "in";
      const result = await this.reply(from, hostStartReply(this.options.property.address, this.problemHold, this.helper()), "start", "start", inboundId);
      return { ...result, seen: this.replySeen("start", inboundId, result.sent.length) };
    }
    if (this.problemHold && this.pin && from === this.cleanerPhone) {
      if (this.cleanerConsent === "out" && !this.groupChat) {
        this.cleanerConsent = "in";
        const result = await this.reply(from, START_ACK, "start", "start", inboundId);
        return { ...result, seen: this.replySeen("start", inboundId, result.sent.length) };
      }
      if (this.cleanerConsent === "in") {
        const result = await this.guide(from, inboundId);
        return { ...result, seen: this.replySeen("next", inboundId, result.sent.length) };
      }
      return { handled: true, reason: "ignored", sent: [], seen: true };
    }
    if (this.delivery(`start:${inboundId}`) === "sent") {
      if (this.pin && from === this.cleanerPhone && this.cleanerConsent === "out") this.cleanerConsent = "in";
      return { handled: true, reason: "start", sent: [], seen: true };
    }
    if (this.pin && from === this.cleanerPhone) {
      if (this.groupChat && this.cleanerConsent === "out") {
        return { handled: true, reason: "ignored", sent: [], seen: true };
      }
      if (this.cleanerConsent === "out") {
        this.cleanerConsent = "in";
        const result = await this.reply(from, START_ACK, "start", "start", inboundId);
        return { ...result, seen: this.replySeen("start", inboundId, result.sent.length) };
      }
      const job = this.ordered().find((item) => this.pinDelivered(item) && !item.started && !item.done);
      if (this.cleanerConsent !== "in" || !job) {
        if (this.cleanerConsent === "in") {
          const result = await this.guide(from, inboundId);
          return { ...result, seen: this.replySeen("next", inboundId, result.sent.length) };
        }
        return { handled: true, reason: "ignored", sent: [], seen: true };
      }
      const result = await this.reply(from, "Got it, cleaning started.", "started", "start", inboundId, job.id);
      if (result.sent.length > 0) {
        job.started = true;
        job.startedAt ??= this.now().toISOString();
      }
      return { ...result, seen: result.sent.length > 0 };
    }
    if (!this.everConsented) return { handled: true, reason: "ignored", sent: [], seen: true };
    this.optedOut = false;
    const result = await this.reply(from, START_ACK, "start", "start", inboundId);
    return { ...result, seen: this.replySeen("start", inboundId, result.sent.length) };
  }

  private async reply(to: string, body: string, kind: TextKind, reason: ReceiveReason, inboundId: string, jobId?: string): Promise<ReceiveResult> {
    const text = await this.emit({ id: `${kind}:${inboundId}`, to, body, kind, ...(jobId ? { jobId } : {}) });
    return { handled: true, reason, sent: text ? [text] : [] };
  }

  private markIgnored(id: string): ReceiveResult {
    this.inboundIds.push(id);
    return { handled: true, reason: "ignored", sent: [] };
  }

  private conversationJob(): Job | undefined {
    return this.ordered().find((job) => {
      const status = this.derive(job);
      return status === "discovered" || status === "awaiting_checkin" || status === "host_confirmed" || status === "offered";
    });
  }

  private derive(job: Job): JobStatus {
    if (job.canceled) return "canceled";
    if (job.declined) return "declined";
    // A started or finished cleaning keeps that status when a later booking changes its next check-in.
    // Moving its checkout clears both flags, so a moved job is timed and offered again.
    if (job.done) return "done";
    if (job.started) return "in_progress";
    const checkout = this.latestFact(job.id, "checkout");
    const checkin = this.latestFact(job.id, "checkin");
    if (!checkout) return "discovered";
    if (job.nextCheckInDate && !checkin) return "awaiting_checkin";
    if (!job.announced) return "host_confirmed";
    if (this.confirmSent(job) && !this.stale(job)) {
      if (job.done) return "done";
      if (job.started) return "in_progress";
      if (this.pinDelivered(job)) return "cleared";
      if (this.pin && this.checkoutReached(job)) return "awaiting_departure";
      return "confirmed";
    }
    return "offered";
  }

  private view(job: Job): JobView {
    const status = this.derive(job);
    const checkout = this.latestFact(job.id, "checkout");
    const checkin = this.latestFact(job.id, "checkin");
    const live = !job.canceled && !job.declined;
    const checkoutClock = checkout ? this.clock(job.checkoutDate, checkout.minutes) : null;
    const checkinClock = checkin && job.nextCheckInDate ? this.clock(job.nextCheckInDate, checkin.minutes) : null;
    return {
      id: job.id,
      departingUid: job.departingUid,
      arrivingUid: job.arrivingUid,
      status,
      live,
      textsBlocked: !live || this.optedOut || this.problemHold,
      checkoutDate: job.checkoutDate,
      nextCheckInDate: job.nextCheckInDate,
      sameDay: job.sameDay,
      checkoutTime: checkoutClock?.time ?? null,
      nextCheckInTime: checkinClock?.time ?? null,
      checkoutAt: checkout ? zonedInstant(job.checkoutDate, hm(checkout.minutes), this.options.property.timeZone) : null,
      nextCheckInAt: checkin && job.nextCheckInDate ? zonedInstant(job.nextCheckInDate, hm(checkin.minutes), this.options.property.timeZone) : null,
      version: job.version,
      hostCheckoutVersion: checkout?.version ?? 0,
      hostCheckInVersion: checkin?.version ?? 0,
      asking: status === "discovered" && this.delivery(`host-checkout:${job.id}:${job.checkoutDate}:${this.defaultCheckout}`) === "sent" ? "checkout" : status === "awaiting_checkin" ? "checkin" : null,
      ...(job.arrivalAt ? { arrivalTime: formatWhen(job.arrivalAt, this.options.property.timeZone).time } : {}),
      ...(job.startedAt ? { startedAt: job.startedAt } : {}),
      ...(job.doneAt ? { doneAt: job.doneAt } : {}),
      ...(job.photos ? { photos: job.photos } : {}),
      ...(job.photosSaved ? { photosSaved: job.photosSaved } : {}),
      ...(job.notes ? { notes: [...job.notes] } : {}),
      ...(job.checklist ? { checklist: [...job.checklist] } : {}),
    };
  }

  private checkoutDrift(job: Job): boolean {
    const checkout = this.latestFact(job.id, "checkout");
    if (!job.announced || !checkout) return false;
    return job.announced.checkoutDate !== job.checkoutDate || job.announced.checkoutMinutes !== checkout.minutes;
  }

  private clearHostTime(jobId: string, field: "checkout" | "checkin"): void {
    this.hostFacts = this.hostFacts.filter((fact) => fact.jobId !== jobId || fact.field !== field);
  }

  private stale(job: Job): boolean {
    if (!job.announced) return false;
    const current = this.currentAnnouncement(job);
    if (!current) return false;
    return JSON.stringify(current) !== JSON.stringify(job.announced);
  }

  private currentAnnouncement(job: Job): Announced | null {
    const checkout = this.latestFact(job.id, "checkout");
    if (!checkout) return null;
    const checkin = this.latestFact(job.id, "checkin");
    return {
      checkoutDate: job.checkoutDate,
      checkoutMinutes: checkout.minutes,
      nextCheckInDate: job.nextCheckInDate,
      checkInMinutes: job.nextCheckInDate ? (checkin?.minutes ?? null) : null,
    };
  }

  private confirmSent(job: Job): boolean {
    const checkout = this.latestFact(job.id, "checkout");
    if (!checkout) return false;
    return this.delivery(`confirm:${job.id}:${job.checkoutDate}:${checkout.minutes}:${job.nextCheckInDate ?? ""}`) === "sent";
  }

  private canRemind(job: Job): boolean {
    const status = this.derive(job);
    if (this.stale(job)) return false;
    if (this.pin) return status === "confirmed" || status === "awaiting_departure";
    return status === "offered" || status === "confirmed";
  }

  /**
   * True when the offer trigger lets a job's first offer go now. A timed offer goes on the trigger
   * day, but no later than the day before checkout. With days-after-check-in, a job with no known
   * check-in is not held.
   */
  private offerDue(job: Job): boolean {
    const trigger = this.options.offerTrigger;
    if (!trigger) return true;
    if (this.inQuietHours()) return false;
    if (trigger.kind === "when-confirmed") return true;
    if (trigger.kind === "days-after-check-in" && !job.checkInDate) return true;
    const wanted = trigger.kind === "days-before-checkout" ? addCalendarDays(job.checkoutDate, -trigger.days) : addCalendarDays(job.checkInDate!, trigger.days);
    const latest = addCalendarDays(job.checkoutDate, -1);
    const day = wanted < latest ? wanted : latest;
    return this.now().getTime() >= Date.parse(zonedInstant(day, trigger.localTime, this.options.property.timeZone));
  }

  private triggerDue(trigger: ReminderTrigger, checkoutDate: string): boolean {
    const day = trigger.kind === "days-before-checkout" ? addCalendarDays(checkoutDate, -(trigger.days ?? 0)) : checkoutDate;
    return this.now().getTime() >= Date.parse(zonedInstant(day, trigger.localTime, this.options.property.timeZone));
  }

  private latestFact(jobId: string, field: "checkout" | "checkin"): HostFact | undefined {
    return this.hostFacts.filter((fact) => fact.jobId === jobId && fact.field === field).sort((a, b) => a.version - b.version).at(-1);
  }

  private addFact(jobId: string, field: "checkout" | "checkin", minutes: number): void {
    const latest = this.latestFact(jobId, field);
    if (latest?.minutes === minutes) return;
    this.hostFacts.push({ jobId, field, version: (latest?.version ?? 0) + 1, minutes });
    this.cancelPendingReminders(jobId);
  }

  private toldOwner(jobId: string): boolean {
    return this.outboxState.some((item) => item.jobId === jobId && item.status === "sent" && item.kind !== "cancel-update");
  }

  /** A text posted into the group is kept under `{id}:group`, and counts as the delivery of `id`. */
  private delivery(id: string): OutboxItem["status"] | undefined {
    const status = (key: string) => this.outboxState.find((item) => item.id === key)?.status;
    return status(id) ?? status(`${id}:group`);
  }

  private dropUncertain(id: string): void {
    const index = this.outboxState.findIndex((item) => item.id === id && item.status === "uncertain");
    if (index >= 0) this.outboxState.splice(index, 1);
  }

  private cancelPendingReminders(jobId?: string): void {
    for (const item of this.outboxState) {
      if (item.kind !== "reminder" || item.status === "sent") continue;
      if (jobId && item.jobId !== jobId) continue;
      item.status = "canceled";
    }
  }

  private cancelOtherReminders(jobId: string, triggerId: string, keepId: string): void {
    for (const item of this.outboxState) {
      if (item.kind !== "reminder" || item.jobId !== jobId || item.status === "sent" || item.id === keepId || item.id === `${keepId}:group`) continue;
      if (item.id.startsWith(`reminder:${jobId}:${triggerId}:`)) item.status = "canceled";
    }
  }

  private ordered(): Job[] {
    return [...this.jobsState].sort((a, b) => a.checkoutDate.localeCompare(b.checkoutDate) || a.id.localeCompare(b.id));
  }

  private clock(ymd: string, minutes: number): { day: string; time: string } {
    return formatWhen(zonedInstant(ymd, hm(minutes), this.options.property.timeZone), this.options.property.timeZone);
  }

  private scratchReady(): boolean {
    if (!this.owner || !this.cleanerPhone) return false;
    if (this.options.allowlist) return this.numberAllowed(this.owner) && this.numberAllowed(this.cleanerPhone);
    return isScratchTestNumber(this.owner) && isScratchTestNumber(this.cleanerPhone);
  }

  private numberAllowed(phone: string): boolean {
    const parsed = parsePhone(phone) ?? phone;
    const allowlist = this.options.allowlist;
    if (typeof allowlist === "function") return allowlist(parsed);
    if (allowlist) return allowlist.some((item) => (parsePhone(item) ?? item) === parsed);
    return isScratchTestNumber(parsed);
  }

  /** The confirmed job the host's departure or a later checkout time is about. A started or finished cleaning is never moved or released again. */
  private releaseJob(): Job | undefined {
    return this.ordered().find((job) => {
      if (job.done || job.started) return false;
      const status = this.derive(job);
      return status === "confirmed" || status === "awaiting_departure" || status === "cleared";
    });
  }

  /** The job whose door-code text is the latest: the one waiting for release, or else the last cleaning that started. */
  private codeJob(): Job | undefined {
    return this.releaseJob() ?? this.ordered().filter((job) => !job.canceled && !job.declined && (job.done || job.started)).at(-1);
  }

  private pinKey(job: Job): string | undefined {
    const checkout = this.latestFact(job.id, "checkout");
    const clearance = [...this.clearances].reverse().find((item) => item.jobId === job.id);
    if (!checkout || !clearance) return undefined;
    if (clearance.checkoutDate !== job.checkoutDate || clearance.minutes !== checkout.minutes || clearance.hostVersion !== checkout.version) return undefined;
    return `pin:${job.id}:${job.checkoutDate}:${checkout.minutes}:${checkout.version}`;
  }

  private pinDelivered(job: Job): boolean {
    const key = this.pinKey(job);
    return Boolean(key && this.delivery(key) === "sent");
  }

  markPinUndelivered(): void {
    let changed = false;
    for (const item of this.outboxState) {
      if (item.kind !== "pin" || item.status !== "sent") continue;
      item.status = "failed";
      if (item.lease) item.lease.state = "open";
      this.pinPhase.set(item.id, "failed");
      changed = true;
    }
    if (changed) {
      this.pinFailurePending = true;
      this.save();
    }
  }

  async reportPin(id: string, status: string): Promise<void> {
    const item = this.outboxState.find((row) => row.id === id && row.kind === "pin");
    if (!item) return;
    const phase = this.pinPhase.get(id) ?? (item.status === "failed" ? "failed" : item.status === "sent" ? "accepted" : undefined);
    const normalized = status.toLowerCase();
    if (normalized === "sent" || normalized === "") return;
    if (normalized === "delivered") {
      if (phase === "failed" || phase === "undelivered" || phase === "delivered") return;
      this.pinPhase.set(id, "delivered");
      this.save();
      this.notePrivateCodeDelivered();
      return;
    }
    if (normalized !== "failed" && normalized !== "undelivered") return;
    if (phase === "failed" || phase === "undelivered") return;
    const failedPhase = normalized === "undelivered" ? "undelivered" : "failed";
    this.pinPhase.set(id, failedPhase);
    item.status = "failed";
    if (item.lease) item.lease.state = "open";
    this.pinFailurePending = true;
    this.save();
    if (!this.owner) return;
    const priorFailures = this.outboxState.filter((row) => row.kind === "pin-failed" && (row.id === `pin-failed:${id}` || row.id.startsWith(`pin-failed:${id}:`))).length;
    await this.emit({
      id: priorFailures === 0 ? `pin-failed:${id}` : `pin-failed:${id}:${priorFailures}`,
      ...(item.jobId ? { jobId: item.jobId } : {}),
      to: this.owner,
      kind: "pin-failed",
      body: this.options.pinFailedBody ?? "The door code didn't reach the cleaner. We'll try again in a few minutes.",
    });
    this.save();
  }

  pinAccepted(): boolean {
    const job = this.codeJob();
    const key = job ? this.pinKey(job) : undefined;
    if (!key) return false;
    const phase = this.pinPhase.get(key);
    if (phase === "failed" || phase === "undelivered") return false;
    if (phase === "accepted" || phase === "delivered") return true;
    return this.delivery(key) === "sent";
  }

  pinShownStatus(id: string): "sent" | "delivered" | "failed" | "undelivered" | undefined {
    const phase = this.pinPhase.get(id);
    if (phase === "delivered" || phase === "failed" || phase === "undelivered") return phase;
    if (phase === "accepted") return "sent";
    return undefined;
  }

  pullPinFailure(): boolean {
    if (!this.pinFailurePending) return false;
    this.pinFailurePending = false;
    this.save();
    return true;
  }

  rememberPin(pin: string): void {
    if (!this.pin) this.pin = pin;
  }

  saveArrival(minutes: number): boolean {
    const job = this.ordered().find((item) => !item.canceled && !item.declined && !item.done);
    if (!job) return false;
    job.arrivalAt = zonedInstant(job.checkoutDate, hm(minutes), this.options.property.timeZone);
    this.save();
    return true;
  }

  canSendHostMessage(to: string): boolean {
    if (!this.enabled || this.optedOut || this.options.holdSends?.()) return false;
    if (to === "group") {
      if (!this.groupChat || !this.cleanerPhone) return false;
      const audience = this.groupAudience();
      return audience.includes(this.cleanerPhone) && audience.every((phone) => this.numberAllowed(phone));
    }
    const phone = parsePhone(to);
    if (!phone || phone === this.owner || !this.numberAllowed(phone)) return false;
    if (phone === this.cleanerPhone) return this.cleanerConsent === "in";
    const known = [...(this.groupChat?.extra ?? []), ...(this.messaging?.participants ?? [])].some((person) => parsePhone(person.phone) === phone);
    return known && this.participantConsent.get(phone) === "in";
  }

  async sendHostMessage(input: { to: string; body: string }): Promise<CleanerText | null> {
    const body = input.body.trim();
    if (!body || !this.canSendHostMessage(input.to)) return null;
    const id = `host-message:${randomUUID()}`;
    if (input.to === "group") {
      // The intro goes first, so it never trails a host message.
      await this.ensureIntro();
      const audience = this.groupAudience();
      const to = audience.find((phone) => phone === this.cleanerPhone) ?? audience[0];
      if (!to) return null;
      return this.emit({ id, to, body, kind: "host-message", channel: "group", audience });
    }
    const to = parsePhone(input.to);
    if (!to) return null;
    return this.emit({ id, to, body, kind: "host-message" });
  }

  groupMembers(): string[] {
    return this.groupChat ? [...this.groupAudience()].sort() : [];
  }

  hostMessagesSince(since: Date): number {
    const after = since.getTime();
    return this.outboxState.filter((item) => item.kind === "host-message" && item.status === "sent" && item.lease && Date.parse(item.lease.at) > after).length;
  }

  private recordClearance(job: Job): void {
    const checkout = this.latestFact(job.id, "checkout");
    if (!checkout) return;
    const current = [...this.clearances].reverse().find((item) => item.jobId === job.id);
    if (current && current.checkoutDate === job.checkoutDate && current.minutes === checkout.minutes && current.hostVersion === checkout.version) return;
    this.clearances.push({ jobId: job.id, checkoutDate: job.checkoutDate, minutes: checkout.minutes, hostVersion: checkout.version });
  }

  private dropClearance(jobId: string): void {
    this.clearances = this.clearances.filter((item) => item.jobId !== jobId);
  }

  private cancelUnsentPin(jobId: string): void {
    for (const item of this.outboxState) {
      if (item.jobId !== jobId || item.status === "sent") continue;
      if (item.kind === "pin" || item.kind === "pin-failed" || item.kind === "pin-notice" || item.kind === "pin-held") item.status = "canceled";
    }
  }

  /** True when `ymd` is an earlier day than today in the property's time zone. */
  private beforeToday(ymd: string): boolean {
    return this.now().getTime() >= Date.parse(zonedInstant(addCalendarDays(ymd, 1), "00:00", this.options.property.timeZone));
  }

  private checkoutReached(job: Job): boolean {
    const checkout = this.latestFact(job.id, "checkout");
    if (!checkout) return false;
    return this.now().getTime() >= Date.parse(zonedInstant(job.checkoutDate, hm(checkout.minutes), this.options.property.timeZone));
  }

  private redact(body: string): string {
    if (!this.pin || !body.includes(this.pin)) return body;
    return body.split(this.pin).join("[redacted]");
  }

  private pinKeyMaterial(): Buffer {
    return pinKeyFor(this.options.property.id);
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    this.storeLoaded = true;
    const parsed = JSON.parse(readFileSync(this.file, "utf8")) as StoreFile;
    if (parsed.schemaVersion !== 1) throw new Error("Cleaner Core store is not version 1.");
    const mine = sliceForTenant(parsed, this.tenantId);
    if (!mine) return;
    const record = JSON.parse(JSON.stringify(mine)) as Stored & { pin?: unknown };
    delete record.pin;
    this.jobsState = record.jobs.map((job) => {
      const { checkInDate, ...rest } = job;
      return { ...rest, ...(typeof checkInDate === "string" ? { checkInDate } : {}), started: job.started === true, done: job.done === true };
    });
    this.hostFacts = record.hostFacts;
    this.tombstones = record.tombstones;
    this.outboxState = record.outbox;
    this.inboundIds = record.inboundIds;
    this.hadStoredConsent = record.cleanerConsent === "pending" || record.cleanerConsent === "in" || record.cleanerConsent === "out";
    this.transcriptState = record.transcript;
    this.optedOut = record.optedOut;
    this.injurySent = record.injurySent;
    this.blockState = record.blocks;
    this.cleanerConsent = record.cleanerConsent ?? "pending";
    this.clearances = record.clearances ?? [];
    this.session = record.onboarding;
    if (record.origin === "onboarding") this.origin = "onboarding";
    if (record.activated === true) this.activated = true;
    if (record.isolate === true) this.isolate = true;
    // Quiet hours passed in by the caller (a window, or null for none) are the saved setting. A stored window counts only when none are passed.
    if (record.quietFrom && record.quietUntil && this.options.quietHours === undefined) this.quiet = { from: record.quietFrom, until: record.quietUntil };
    for (const person of record.participantConsent ?? []) this.participantConsent.set(person.phone, person.consent);
    if (this.origin === "onboarding" && !this.activated) this.everConsented = false;
    this.sourceRecords = record.sourceRecords ?? [];
    this.latest.clear();
    for (const snapshot of Object.values(record.snapshots ?? {})) {
      if (isSnapshot(snapshot)) this.latest.set(snapshot.sourceId, snapshot);
    }
    this.reviewItems = record.reviews ?? [];
    this.auditLog = record.audit ?? [];
    this.counters = { ...emptyCounters(), ...record.counters };
    if (record.hostGroup === "pending" || record.hostGroup === "in" || record.hostGroup === "out") {
      this.hostGroup = record.hostGroup;
      this.hostGroupSaved = true;
    }
    if (record.problemHold === true) this.problemHold = true;
    if (record.ownerOptedOut === true) this.ownerOptedOut = true;
    if (record.holdCause === "cleaner" || record.holdCause === "owner" || record.holdCause === "injury") this.holdCause = record.holdCause;
    if (record.pinFailurePending === true) this.pinFailurePending = true;
    for (const pin of record.pinPhase ?? []) {
      if (pin.phase === "accepted" || pin.phase === "delivered" || pin.phase === "failed" || pin.phase === "undelivered") {
        this.pinPhase.set(pin.id, pin.phase);
      }
    }
    if (record.groupPinTerminal === true) this.groupPinTerminal = true;
    if (typeof record.lastIntro === "string") this.lastIntro = record.lastIntro;
    else {
      // A store from before this field: the last intro row names the last introduced membership.
      const last = [...(record.outbox ?? [])].reverse().find((item) => item.kind === "intro" && item.id.startsWith("intro:"));
      if (last) this.lastIntro = last.id.slice("intro:".length).split(":")[0];
    }
    this.hostNoteState = (record.hostNotes ?? []).filter((note) => typeof note?.id === "string" && typeof note?.body === "string");
    if (this.options.sealPinAtRest !== false && !this.pin && record.pinSeal) {
      try {
        this.pin = openPin(record.pinSeal, this.pinKeyMaterial());
      } catch {
        this.pin = undefined;
      }
    }
  }

  private save(): void {
    if (!this.file) return;
    const mine: Stored = {
      schemaVersion: 1,
      tenantId: this.tenantId,
      jobs: this.jobsState,
      hostFacts: this.hostFacts,
      tombstones: this.tombstones,
      outbox: this.outboxState,
      inboundIds: this.inboundIds,
      transcript: this.transcriptState,
      optedOut: this.optedOut,
      injurySent: this.injurySent,
      blocks: this.blockState,
      cleanerConsent: this.cleanerConsent,
      clearances: this.clearances,
      ...(this.session ? { onboarding: this.session } : {}),
      ...(this.origin ? { origin: this.origin } : {}),
      ...(this.activated ? { activated: true } : {}),
      ...(this.isolate ? { isolate: true } : {}),
      ...(this.quiet ? { quietFrom: this.quiet.from, quietUntil: this.quiet.until } : {}),
      ...(this.participantConsent.size > 0
        ? { participantConsent: [...this.participantConsent].map(([phone, consent]) => ({ phone, consent })) }
        : {}),
      ...(this.options.sealPinAtRest !== false && this.pin ? { pinSeal: sealPin(this.pin, this.pinKeyMaterial()) } : {}),
      ...(this.sourceRecords.length > 0 ? { sourceRecords: this.sourceRecords } : {}),
      ...(this.latest.size > 0 ? { snapshots: Object.fromEntries(this.latest) } : {}),
      ...(this.reviewItems.length > 0 ? { reviews: this.reviewItems } : {}),
      ...(this.auditLog.length > 0 ? { audit: this.auditLog } : {}),
      counters: this.counters,
      ...(this.groupChat ? { hostGroup: this.hostGroup, groupPinTerminal: this.groupPinTerminal, ...(this.lastIntro ? { lastIntro: this.lastIntro } : {}) } : {}),
      ...(this.problemHold ? { problemHold: true } : {}),
      ...(this.ownerOptedOut ? { ownerOptedOut: true } : {}),
      ...(this.holdCause ? { holdCause: this.holdCause } : {}),
      ...(this.pinFailurePending ? { pinFailurePending: true } : {}),
      ...(this.pinPhase.size > 0 ? { pinPhase: [...this.pinPhase].map(([id, phase]) => ({ id, phase })) } : {}),
      ...(this.hostNoteState.length > 0 ? { hostNotes: this.hostNoteState } : {}),
    };
    const existing = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as StoreFile) : undefined;
    if (existing && existing.schemaVersion !== 1) throw new Error("Cleaner Core store is not version 1.");
    const json = JSON.stringify(mergeTenantSlice(existing, this.tenantId, mine));
    // The code as its own token. An id that only holds the digits (a SID, a UUID, a booking UID) is fine.
    if (this.pin && containsCodeToken(json, this.pin)) throw new Error("The door code cannot be stored in plaintext.");
    writeFileAtomic(this.file, `${json}\n`);
    if (this.sqlite) mirrorStore(this.databasePath(), json);
  }

  async fileReview(kind: ReviewKind): Promise<ReceiveResult> {
    if (!this.enabled) return { handled: false, reason: "disabled", sent: [] };
    const alert = await this.openReview(kind, "host", true);
    return { handled: true, reason: "review", sent: alert ? [alert] : [] };
  }

  async replay(): Promise<{ sent: CleanerText[] }> {
    if (!this.enabled) return { sent: [] };
    const sent = await this.settleUncertain();
    for (const id of [...this.inboundIds]) {
      if (!this.owner) break;
      const result = await this.receive({ id, from: this.owner, text: "YES" });
      sent.push(...result.sent);
    }
    for (const item of [...this.outboxState]) {
      if (item.status !== "sent" && item.status !== "canceled") continue;
      if (item.lease?.state === "revoked" || item.lease?.state === "expired") continue;
      const text = await this.emit({
        id: item.id,
        to: item.to,
        kind: item.kind,
        body: item.body,
        ...(item.jobId ? { jobId: item.jobId } : {}),
      });
      if (text) sent.push(text);
    }
    this.audit("engine", "replay", 1, "replay");
    this.save();
    return { sent };
  }

  backup(dest: string): void {
    if (!this.file) throw new Error("Backup needs a data directory.");
    this.save();
    const json = readFileSync(this.file, "utf8");
    if (this.pin && containsCodeToken(json, this.pin)) throw new Error("The door code cannot be stored in plaintext.");
    mirrorStore(this.databasePath(), json);
    snapshotStore(this.databasePath(), dest);
    this.audit("engine", "backup", 1, "backup");
    this.lastBackupAt = this.now().getTime();
    this.save();
  }

  restore(backupPath: string): void {
    if (!this.file) throw new Error("Restore needs a data directory.");
    restoreTenantSlice(this.file, backupPath, this.tenantId);
    this.load();
    this.audit("engine", "restore", 1, "restore");
    this.save();
  }

  health(): HealthReport {
    return {
      ok: true,
      sends: false,
      note: HEALTH_NOTE,
      openReviews: this.reviewItems.filter((item) => item.status === "open").length,
      staleSources: this.sourceRecords.filter((record) => freshnessOf(record.fetchedAt, this.now().getTime(), this.thresholdMs) === "stale").length,
      counters: { ...this.counters },
      codeHandling: codeHandlingText(this.options.property.address),
    };
  }

  reviews(): ReviewItem[] {
    return this.reviewItems.map((item) => ({ ...item }));
  }

  auditTrail(): AuditEvent[] {
    return this.auditLog.map((item) => ({ ...item }));
  }

  sourceHealth(): SourceRecord[] {
    return this.sourceRecords.map((record) => ({
      ...record,
      freshness: freshnessOf(record.fetchedAt, this.now().getTime(), this.thresholdMs),
    }));
  }

  revealPin(role: "cleaner" | "observer" | "owner" | "manager"): string | undefined {
    if (role !== "cleaner" || !this.options.cleaner.approved) return undefined;
    return this.pin;
  }

  stampFetchedAt(iso: string): void {
    this.nextFetchedAt = iso;
  }

  private databasePath(): string {
    if (!this.file) throw new Error("Backup needs a data directory.");
    return join(dirname(this.file), "cleaner-core.db");
  }

  private stamp(snapshot: SourceSnapshot): SourceSnapshot {
    const fetchedAt = this.nextFetchedAt ?? snapshot.fetchedAt ?? (this.watchFreshness ? this.now().toISOString() : undefined);
    this.nextFetchedAt = undefined;
    return fetchedAt ? { ...snapshot, fetchedAt } : snapshot;
  }

  private rememberSource(snapshot: SourceSnapshot, interpretation: SourceRecord["interpretation"]): void {
    const parts = [
      ...snapshot.turnovers.map((turnover) => `${turnover.id}|${turnover.contentHash}|${turnover.sequence}`),
      ...snapshot.blocks.map((block) => `block|${block.uid}|${block.summary}`),
    ];
    const record: SourceRecord = {
      kind: snapshot.sourceId,
      fetchedAt: snapshot.fetchedAt ?? null,
      fingerprint: fingerprintOf(parts),
      freshness: freshnessOf(snapshot.fetchedAt, this.now().getTime(), this.thresholdMs),
      interpretation,
    };
    this.sourceRecords = [...this.sourceRecords.filter((item) => item.kind !== snapshot.sourceId), record];
  }

  private sourceFeedStale(): boolean {
    if (!this.watchFreshness) return false;
    return this.sourceRecords.some((record) => freshnessOf(record.fetchedAt, this.now().getTime(), this.thresholdMs) === "stale");
  }

  private async alertStale(): Promise<CleanerText | null> {
    const stale = this.sourceRecords.find((record) => freshnessOf(record.fetchedAt, this.now().getTime(), this.thresholdMs) === "stale");
    return this.openReview("stale-source", `${stale?.kind ?? "feed"}:${stale?.fetchedAt ?? "none"}`, true);
  }

  private resolveKind(kind: ReviewKind): void {
    for (const item of this.reviewItems) {
      if (item.kind !== kind || item.status !== "open") continue;
      item.status = "resolved";
      item.version += 1;
      this.audit("engine", "review", item.version, `clear ${kind}`);
    }
  }

  private async settleUncertain(): Promise<CleanerText[]> {
    const sent: CleanerText[] = [];
    for (const item of this.outboxState) {
      if (item.status !== "uncertain") continue;
      if (item.lease?.state === "revoked" || item.lease?.state === "expired") continue;
      const alert = await this.openReview("uncertain-sms", item.id, true);
      if (alert) sent.push(alert);
    }
    return sent;
  }

  private async retryUncertain(inboundId: string): Promise<ReceiveResult> {
    const item = this.outboxState.find((row) => row.status === "uncertain" && (row.kind === "offer" || row.kind === "reminder"));
    const retryId = item ? `retry:${item.id}` : "";
    if (!item || this.delivery(retryId) === "sent") {
      this.inboundIds.push(inboundId);
      this.save();
      return { handled: true, reason: item ? "duplicate" : "ignored", sent: [] };
    }
    const kind = item.kind === "reminder" ? "reminder" : "offer";
    const addressed = addressCleaner(this.cleanerRecord(), { kind, body: item.body });
    if (!addressed) {
      this.inboundIds.push(inboundId);
      this.save();
      return { handled: true, reason: "ignored", sent: [] };
    }
    const text = await this.emitOne({
      id: retryId,
      ...(item.jobId ? { jobId: item.jobId } : {}),
      to: addressed.to,
      kind,
      body: addressed.body,
    });
    if (text) {
      item.status = "sent";
      if (item.lease) item.lease.state = "committed";
      if (kind === "offer" && item.jobId) {
        const job = this.jobsState.find((row) => row.id === item.jobId);
        if (job && !job.announced) job.announced = this.currentAnnouncement(job);
      }
    }
    this.inboundIds.push(inboundId);
    this.save();
    return { handled: true, reason: "retry", sent: text ? [text] : [] };
  }

  /** Who a host text tells them to talk to. */
  private helper(): string {
    return this.options.helperName ?? GROK_HELPER;
  }

  private reviewDetail(kind: ReviewKind, subject: string): ReviewDetail {
    if (kind !== "uncertain-sms" && kind !== "missed-reminder") return {};
    const item = this.outboxState.find((row) => row.id === subject);
    const job = (item?.jobId ? this.jobsState.find((row) => row.id === item.jobId) : undefined) ?? this.ordered()[0];
    const minutes = job ? (this.latestFact(job.id, "checkout")?.minutes ?? this.defaultCheckout) : this.defaultCheckout;
    const day = job
      ? this.clock(job.checkoutDate, minutes).day
      : formatWhen(this.now().toISOString(), this.options.property.timeZone).day;
    const about = kind === "missed-reminder" || item?.kind === "reminder" ? "reminder" : "offer";
    return { day, about };
  }

  private async openReview(kind: ReviewKind, subject: string, notify: boolean): Promise<CleanerText | null> {
    const id = reviewId(kind, subject);
    if (this.reviewItems.some((item) => item.id === id)) return null;
    const at = this.now().toISOString();
    this.reviewItems.push({ id, kind, subject, status: "open", at, version: 1 });
    this.audit("engine", "review", 1, `open ${kind}`);
    if (!notify || !this.owner || !this.enabled) {
      this.save();
      return null;
    }
    return this.emit({
      id,
      to: this.owner,
      kind: "review",
      body: reviewAlert(kind, this.options.property.address, this.reviewDetail(kind, subject), this.helper()),
    });
  }

  private audit(actor: string, source: string, version: number, reason: string): void {
    this.auditLog.push({ actor, source, version, reason, at: this.now().toISOString(), action: reason });
  }

  private maybeScheduledBackup(): void {
    if (!this.sqlite || !this.backupDir || !this.file) return;
    const due = this.now().getTime() - this.lastBackupAt >= GUESTY_POLL_MS;
    if (!due && this.lastBackupAt !== 0) return;
    mkdirSync(this.backupDir, { recursive: true });
    this.backup(join(this.backupDir, "scheduled.db"));
  }

  private logSend(kind: TextKind, outcome: string, to: string): void {
    if (!this.file || (!this.sqlite && !this.watchFreshness)) return;
    const line = JSON.stringify({
      at: this.now().toISOString(),
      tenant: this.tenantId,
      kind,
      outcome,
      to: redactPhone(to),
    });
    const secrets = this.pin ? [this.pin] : [];
    appendFileSync(join(dirname(this.file), "cleaner-core.log"), `${redactLine(line, secrets)}\n`);
  }

  private redactInbound(text: string): string {
    return this.redact(text).replace(/door code\D*\d{4,8}/gi, "door code [redacted]");
  }

  private looksLikeCode(text: string): boolean {
    if (this.pin && text.includes(this.pin)) return true;
    return /door code\D*\d{4,8}/i.test(text);
  }

  private codeOnly(text: string): boolean {
    const stripped = this.redactInbound(text).replace(/\[redacted\]/g, "").replace(/door code/gi, "").replace(/[^a-z0-9]+/gi, "");
    return stripped.length === 0;
  }
}

function emptyCounters(): Counters {
  return { sent: 0, failed: 0, uncertain: 0, canceled: 0, injury: 0, stop: 0, help: 0, polls: 0, pollFails: 0, pollDurationMs: 0 };
}

function minutesOf(hmText: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(hmText);
  if (!match) throw new Error("Bad local time");
  return Number(match[1]) * 60 + Number(match[2]);
}

function hm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Minutes after midnight as "10:30 AM", with a plain space. */
function clockLabel(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

function clockMinutes(text: string): number | undefined {
  const time = spokenTimes(normalize(text))[0];
  if (!time?.meridiem) return undefined;
  let hour = time.hour % 12;
  if (time.meridiem === "PM") hour += 12;
  return hour * 60 + time.minute;
}

function isYes(text: string): boolean {
  return /^(yes|yep|yeah|y|ok|okay|sure)( please)?$/.test(stripFiller(normalize(text)));
}

function isNo(text: string): boolean {
  return /^(no|nope|nah)$/.test(stripFiller(normalize(text)));
}

/** A cleaner reply Cleaner Core answers itself. Anything else is left to Grok when it reads the messages. */
function isCleanerKeyword(text: string): boolean {
  return keywordOf(text) !== undefined || isYes(text) || isNo(text) || isDone(text);
}

/** The label Grok reads beside a message: what Cleaner Core did with it. */
function outcomeOf(result: ReceiveResult): MessageHandled {
  switch (result.reason) {
    case "opted-in":
      return "opted-in";
    case "scheduled":
      return "confirmed";
    case "declined":
      return "declined";
    case "done":
      return "done";
    case "stop":
      return "stop";
    case "start":
      return "start";
    case "emergency":
      return "injury";
    default:
      return "none";
  }
}

function isDone(text: string): boolean {
  return stripFiller(normalize(text)) === "done";
}

function isDeparture(text: string): boolean {
  const phrase = stripFiller(normalize(text)).replace(/^the\s+/, "");
  return phrase === "guests have left" || phrase === "guests left" || phrase === "they have left" || phrase === "they left" || phrase === "departed" || phrase === "left";
}

function isStoredSlice(value: unknown): value is Stored {
  if (!value || typeof value !== "object") return false;
  const record = value as Stored;
  return record.schemaVersion === 1 && Array.isArray(record.jobs) && Array.isArray(record.outbox);
}

function sliceOwnedBy(slice: Stored, tenantId: string): boolean {
  if (typeof slice.tenantId === "string" && slice.tenantId !== "" && slice.tenantId !== tenantId) return false;
  const known = SCRATCH_TENANTS.find((tenant) => tenant.id === tenantId);
  if (!known) return slice.tenantId === tenantId;
  const phones = slice.outbox.map((item) => item.to);
  if (phones.length === 0) return true;
  const other = phones.some((phone) => isOtherScratchTenantPhone(tenantId, phone));
  const own = phones.some((phone) => phone === known.ownerPhone || phone === known.cleanerPhone || phone === known.unapprovedPhone);
  return !(other && !own);
}

function foreignTenantId(slice: Stored): string {
  if (typeof slice.tenantId === "string" && slice.tenantId !== "") return slice.tenantId;
  const phones = new Set(slice.outbox.map((item) => item.to));
  const match = SCRATCH_TENANTS.find((tenant) => [tenant.ownerPhone, tenant.cleanerPhone, tenant.unapprovedPhone].some((phone) => phones.has(phone)));
  return match?.id ?? "scratch-lane";
}

function aliasesOf(job: Job): string[] {
  return job.aliases && job.aliases.includes(job.id) ? job.aliases : [job.id, ...(job.aliases ?? [])];
}

/** The read lists this job's booking: a stay or a merged source UID is one the job was read under. */
function listsJob(normalized: NormalizedSources, job: Job): boolean {
  const known = new Set(aliasesOf(job));
  if (normalized.feed.turnovers.some((turnover) => known.has(turnover.id))) return true;
  return normalized.provenance.some((item) => item.sources.some((source) => known.has(source.uid)));
}

/** A saved snapshot is used only when it has the shape the engine wrote. */
function isSnapshot(value: unknown): value is SourceSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<SourceSnapshot>;
  return (
    typeof snapshot.sourceId === "string" &&
    snapshot.sourceId !== "" &&
    typeof snapshot.kind === "string" &&
    (BOOKING_SOURCE_KINDS as readonly string[]).includes(snapshot.kind) &&
    typeof snapshot.tenantId === "string" &&
    Array.isArray(snapshot.turnovers) &&
    Array.isArray(snapshot.blocks)
  );
}

function sliceForTenant(file: StoreFile, tenantId: string): Stored | undefined {
  if (file.tenants && typeof file.tenants === "object") {
    const slice = file.tenants[tenantId];
    return isStoredSlice(slice) ? slice : undefined;
  }
  if (typeof file.tenantId === "string" && file.tenantId !== tenantId) return undefined;
  if (!isStoredSlice(file)) return undefined;
  if (!sliceOwnedBy(file, tenantId)) return undefined;
  return file;
}

function otherSlices(file: StoreFile | undefined, tenantId: string): Record<string, Stored> {
  if (!file || file.schemaVersion !== 1) return {};
  if (file.tenants && typeof file.tenants === "object") {
    const rest: Record<string, Stored> = {};
    for (const [key, value] of Object.entries(file.tenants)) {
      if (key === tenantId || !isStoredSlice(value)) continue;
      rest[key] = value;
    }
    return rest;
  }
  if (!isStoredSlice(file)) return {};
  if (sliceOwnedBy(file, tenantId)) return {};
  const key = foreignTenantId(file);
  if (key === tenantId) return {};
  return { [key]: { ...file, tenantId: key } };
}

function mergeTenantSlice(existing: StoreFile | undefined, tenantId: string, mine: Stored): StoreFile {
  const others = otherSlices(existing, tenantId);
  if (Object.keys(others).length === 0) return mine;
  return { schemaVersion: 1, tenants: { ...others, [tenantId]: { ...mine, tenantId } } };
}

function withChannelPrefix(body: string, channel: "group" | "mirror"): string {
  const prefix = channel === "group" ? GROUP_PREFIX : MIRROR_PREFIX;
  return body.startsWith(prefix) ? body : `${prefix}${body}`;
}

function messagingNote(requested: "cleaner-only" | "group", actual: "cleaner-only" | "native" | "mirrored", capable: boolean, excluded: string[]): string | undefined {
  if (requested !== "group") return undefined;
  if (actual === "native") return "This is a group text.";
  if (!capable) return "Group texting isn't available on this number, so I mirrored the cleaner texts instead of starting a group.";
  if (excluded.length === 1) return `I left ${excluded[0]} out because that number has not opted in.`;
  if (excluded.length > 1) return `I left ${excluded.join(", ")} out because those numbers have not opted in.`;
  return "Group texting isn't available on this number, so I mirrored the cleaner texts instead of starting a group.";
}
