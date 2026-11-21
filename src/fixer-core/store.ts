import type { CleanerAssistant } from "../cleaner-core/assistant";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../storage/atomicWrite";
import type { Schedule } from "../supply-core/schedule";
import type { CrewSchedule } from "./crewDays";
import type { RepairBlock } from "./repairBlock";
import type { GuestAnswer } from "./urgentVisit";

/**
 * Fixer Core's record: one `fixer.json` in the property's folder, beside `supply.json`. It holds the settings, the pros, the
 * upkeep list and the repair jobs. Never a card detail, and never the door code (that stays in `door-access.json`).
 */

export const FIXER_FILE = "fixer.json";

export const TRADES = ["plumbing", "hvac", "electrical", "handyman", "gutters", "pest-control", "appliance", "locksmith"] as const;
export type Trade = (typeof TRADES)[number];

export function isTrade(value: unknown): value is Trade {
  return typeof value === "string" && (TRADES as readonly string[]).includes(value);
}

export interface ProReach {
  phone?: string;
  email?: string;
  website?: string;
  bookingUrl?: string;
}

export interface Pro {
  id: string;
  name: string;
  trades: Trade[];
  /** 1 is called first for that trade. */
  preferredFor: { trade: Trade; rank: number }[];
  reach: ProReach;
  prefersText?: true;
  /** A draft isn't approved until the host confirms. */
  status: "draft" | "saved";
  source: "host" | "drafted" | "job";
  addedAt: string;
  lastJobAt?: string;
  /** Every phone the text invite went to, so each number is invited once. */
  invitedPhones?: string[];
}

export interface Upkeep {
  id: string;
  trade: Trade;
  what: string;
  schedule: Schedule;
  leadDays: number;
  savedAt: string;
  proId?: string;
  lastDoneAt?: string;
  /**
   * The host's standing yes for a routine vendor (#237): each visit is proposed to this pro by text at their usual
   * local hours, and they confirm or move it, with no host question. Withdrawn by saving the item with none.
   */
  standing?: StandingYes;
}

export interface StandingYes {
  /** A saved pro with a phone who texts on the line. */
  proId: string;
  /** Usual local hours, "HH:MM", the same day, at most 4 hours apart. */
  from: string;
  until: string;
  access: "code" | "host";
  /** The usual price: a higher one waits for the host. */
  usualCents?: number;
  /** The host's two-call yes. */
  yesAt: string;
}

/** A routine vendor's visit, proposed by text under a standing yes (#237). */
export interface VendorVisit {
  /** The upkeep item. */
  upkeepId: string;
  /** Saved before the proposal text is sent, so a restart never sends it twice. */
  proposedAt: string;
  /** Set once the proposal text went. */
  proposalSent?: true;
  /** The vendor's YES or a new time that fit: their code exists only from here. */
  confirmedAt?: string;
  /** Each time the vendor's text (or the agent, with their word) moved the visit. */
  moves?: { at: string; from: string; until: string; by: "vendor" | "agent" | "host" }[];
  /** A time from the vendor that didn't fit, waiting for the host. */
  held?: { from: string; until: string; at: string };
  /** The one "no answer" note. */
  noAnswerAt?: string;
}

/** A photo in the photo store, under the key `fixer:<jobId>`. */
export interface PhotoRef {
  id: string;
  from: "cleaner" | "pro";
  at: string;
}

export interface Candidate {
  id: string;
  name: string;
  trade: Trade;
  /** "search", or a network's name. */
  source: string;
  rating?: number;
  reviewCount?: number;
  licensed: "yes" | "no" | "unknown";
  backgroundChecked?: "yes" | "no" | "unknown";
  costRange?: { lowCents: number; highCents: number };
  /** The source's own words, like "$95/hr", under 60 characters. */
  priceText?: string;
  earliestAt?: string;
  reach: ProReach & { networkRef?: string };
}

export interface Contact {
  id: string;
  /** A pro or candidate id. */
  to: string;
  how: "call" | "email" | "form" | "booking-page" | "text" | "network";
  /** Letters only. */
  token: string;
  at: string;
  outcome?: "booked" | "quoted" | "no-answer" | "declined" | "waiting";
  outcomeAt?: string;
  followUpAt?: string;
  quote?: { cents: number; note?: string };
  /** What a "booked" outcome said, kept on the contact so a second one can wait for the host's choice. */
  booked?: { from: string; until: string; estimateCents?: number };
  /** When the "no outcome after 2 hours" note was made, so it is told once. */
  unconfirmedAt?: string;
  cancelled?: true;
}

export interface Booking {
  proId: string;
  from: string;
  until: string;
  estimateCents?: number;
  access: "code" | "host";
  heldFor?: ("cost" | "no-estimate" | "outside-window" | "overlaps-stay")[];
  hostYes?: { at: string };
  /** The visit page's token hash; a new one on every rebook, extend or cancel. */
  visitToken?: string;
  /** The host ended the visit link: no new one until a rebook or an extend. */
  visitRevokedAt?: string;
  /** When a visit link was first given for this booking. It stays after an extend or a revoke, so the code never also goes by text. */
  linkGivenAt?: string;
  /** Each time the page showed the code. */
  revealedAt?: string[];
  revisedQuote?: { cents: number; at: string; by?: "pro" | "agent" | "host"; hostYes?: { at: string } };
  extendedUntil?: string;
  /** On connected locks with pros' codes on ask: the host's OK to give the pro their code. */
  codeYes?: { at: string };
  /** When the host was asked for that OK, and reminded at the visit's start. */
  codeAskedAt?: string;
  codeRemindedAt?: string;
  /** The visit ends (ISO) already offered or given more time, on connected locks. */
  extendNoted?: string[];
  /** What the booking was checked against, so a replay is not a second booking. */
  fingerprint: string;
  cleaningOrder?: "before" | "after";
  /** Stays read after the booking that overlap it, as `checkIn|checkout`, each told to the host once. */
  stayNoted?: string[];
  /** An urgent visit the host approved during this guest stay (`checkIn|checkout`), with the guest's okay (#243). */
  urgentStay?: string;
  /** A routine vendor's visit under a standing yes (#237). Unconfirmed: no code, no page reveal, no visit window. */
  vendor?: VendorVisit;
}

/**
 * One of the host's approvals on a job, kept when the live field is replaced (a moved visit drops the
 * booking, a second raised price replaces the first, a cost saved again replaces the last). The hours log
 * (#238) reads these so a replaced approval is still the host's. Appended, never edited.
 */
export interface HostStep {
  kind: "approve-repair" | "pick-quote" | "approve-booking" | "approve-price" | "record-cost" | "confirm-repair";
  /** The same instant the live field holds. */
  at: string;
  proId?: string;
  cents?: number;
}

/** The most host steps a job keeps; the oldest go first. */
export const MAX_HOST_STEPS = 40;

export type JobState = "requested" | "shortlisted" | "contacted" | "booked" | "in-progress" | "done" | "cancelled";

export interface Job {
  id: string;
  trade: Trade;
  what: string;
  /** A locksmith job on the lock the code opens. */
  doorLock?: true;
  source: "host" | "cleaner" | "upkeep";
  sourceRef?: string;
  /** The cleaner who reported it, as the host go question names them. */
  cleanerName?: string;
  photos: PhotoRef[];
  urgency: "now" | "soon" | "by-date" | "flexible";
  cleaningOrder?: "before" | "after";
  /** Local YYYY-MM-DD, for "by-date". */
  byDate?: string;
  state: JobState;
  hostGo?: { at: string };
  /** The host's cost line for this repair, $1 to $5,000: an estimate over it, or none, holds the booking. */
  costLineCents?: number;
  /** The host chose to get quotes first: no booking until pick_quote. */
  quotesFirst?: true;
  /** The pro the host picked from the quotes, with when: check_fixes names them to book next. */
  quotePick?: { proId: string; at: string };
  /** When check_fixes last reported this quotes-only job's quotes. */
  quotesToldAt?: string;
  candidates: Candidate[];
  picked: string[];
  contacts: Contact[];
  booking?: Booking;
  done?: { at: string; by: "pro-page" | "pro-text" | "agent" | "host"; note?: string };
  cost?: { cents: number; by: "pro" | "agent" | "host"; at: string; note?: string };
  /** What the host has been told, once each. `text` is the line, never a code. */
  news: { kind: string; at: string; text?: string; toldAt?: string }[];
  preferredAsked?: { at: string; answer?: "yes" | "no" };
  /** The open or last rotation question; `proId` is the pro who saw the code that it names. */
  /** `changedAt`: when a new door code was saved after the question, so it is settled. */
  rotationAsked?: { at: string; answer?: "yes" | "no"; proId?: string; changedAt?: string };
  /** The pros the door code was shown or texted to, on any visit of this job, kept across a reschedule. */
  codeShownTo?: string[];
  /** The pros a rotation question was asked about, so each one is asked once. */
  rotationAskedFor?: string[];
  /** Each time the host moved the visit to a new time. */
  reschedules?: { at: string; reason?: string }[];
  /** Each of the host's approvals, as it happened (#238). */
  hostSteps?: HostStep[];
  /** Set and saved before the hub is asked for the code, so a restart never texts it twice. */
  codeTextAt?: string;
  /** Set once the code text was sent. */
  codeTextSent?: true;
  /** The one host note about the code for this job. */
  codeNoteAt?: string;
  /** Made under an upkeep item's standing yes (#237): the host's go and yes are that one answer, not this job's. */
  standingYes?: { upkeepId: string; at: string };
  /** A crew's workdays and hours on a multi-day job, set before the booking (#243). */
  crew?: CrewSchedule;
  /** When the guest was asked about a visit during their stay, and each answer, the last one counting (#243). */
  guest?: { asked: string[]; answers: GuestAnswer[] };
  createdAt: string;
  cancelledAt?: string;
  cancelReason?: string;
}

/** A repair block the host saved, with the news already given about it, once each. */
export interface SavedBlock extends RepairBlock {
  savedAt: string;
  told?: string[];
}

export const MAX_REPAIR_BLOCKS = 10;

export interface FixerSettings {
  checkInBufferMinutes: number;
  cleaningMinutes: number;
  /** Ask the cleaner "Anything running low or broken?" after each clean. */
  askCleaner: boolean;
  /** The host lets their agent pass vendors' completed-service emails (#237). Off by default. */
  serviceNotices?: boolean;
  activatedAt?: string;
}

export interface FixerFile {
  settings: FixerSettings;
  /** Setup steps the host finished that leave no other trace. */
  setup: { prosDone?: true; cleanerAsked?: true; upkeepDone?: true; noCalendar?: true; alertsDone?: true; alertsSkipped?: true };
  /** The one-time link for the alerts routine's address and key: only its code's sha256, expiry, and the chat that made it. */
  alertUpload?: { hash: string; expiresAt: string; by?: { assistant: CleanerAssistant; connectionId?: string } };
  pros: Pro[];
  upkeep: Upkeep[];
  jobs: Job[];
  /** The local date (YYYY-MM-DD) the host last said the guests have left, for every job's checkout-day check. */
  clearedYmd?: string;
  /** The last 200 inbound pro text ids handled, so a replayed webhook does nothing. */
  seenInbound?: string[];
  /**
   * What the host should hear that no job's news holds: an injury text, a pro's text with no visit, a
   * raised price waiting for the host. `urgent` ones come first in check_fixes. Never a code.
   */
  news?: FileNews[];
  /** Days closed for repairs (#243). */
  repairBlocks?: SavedBlock[];
  offAt?: string;
}

export interface FileNews {
  kind: string;
  at: string;
  text: string;
  jobId?: string;
  urgent?: true;
  toldAt?: string;
  /** A host alert's id (#250), so the same alert is kept once. */
  noteId?: string;
}

export function emptyFixer(): FixerFile {
  return { settings: { checkInBufferMinutes: 60, cleaningMinutes: 180, askCleaner: false }, setup: {}, pros: [], upkeep: [], jobs: [] };
}

export function readFixer(root: string): FixerFile {
  const path = join(root, FIXER_FILE);
  if (!existsSync(path)) return emptyFixer();
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<FixerFile>;
  const empty = emptyFixer();
  return {
    ...empty,
    ...raw,
    settings: { ...empty.settings, ...raw.settings },
    setup: { ...raw.setup },
    pros: raw.pros ?? [],
    upkeep: raw.upkeep ?? [],
    jobs: raw.jobs ?? [],
  };
}

export function writeFixer(root: string, file: FixerFile): void {
  writeJsonAtomic(join(root, FIXER_FILE), file);
}

/** True when Cleaner Core should ask the cleaner "Anything broken?": activated, not turned off, and the host said yes. */
export function fixerAskOn(root: string): boolean {
  const file = readFixer(root);
  return Boolean(file.settings.activatedAt) && !file.offAt && file.settings.askCleaner === true;
}

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A short id: the prefix, then `length` of `[a-z0-9]`. Pass "pro_", "job_", "upk_", "cand_" or "con_". */
export function newId(prefix: string, length: number): string {
  return `${prefix}${Array.from({ length }, () => ID_CHARS[randomInt(ID_CHARS.length)]).join("")}`;
}

/** Each half-byte as one letter a to p, so a link or text never holds a digit. */
export function letterToken(bytes = 32): string {
  return [...randomBytes(bytes)].map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15))).join("");
}

/** What is stored in place of a token: its sha256 in hex. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
