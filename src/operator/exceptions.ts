import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FAIR_HOUSING_CODE } from "../core/fairHousing";
import { HANDLER_FAILED_NEXT_STEP, isTeamTextFailedNotice } from "../core/TourCore";
import { isMedicalEmergency } from "../intent/ruleBased";
import { formatPhone, helpNear, looksLikePhone, normalizePhone } from "../core/phone";
import { formatShortDateTime, isValidTimeZone } from "../core/timezone";
import { profileFacts, questionTopic, structuredAnswer, type ProfileField, type UnitProfile } from "../config/unitProfile";
import { MAX_FACT_LENGTH } from "../config/validateConfig";
import { UNNAMED_VISITOR, type AuditEvent, type Message, type Reservation, type ReservationStatus } from "../domain/model";
import { PAUSED, TERMINAL } from "../domain/stateMachine";
import { currentDecisionCode } from "../policy/evaluateAccess";
import { applySetupCommand } from "../setup/commands";
import { SetupInputError } from "../setup/setupActions";
import { statusLabel } from "../setup/workspace";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { resumeStep } from "../visitor/conversation";
import type { OperatorServices } from "./services";
import { persistSession } from "./services";
import { visitorSubject } from "../visitor/identity";
import { STATUS_LABELS } from "../visitor/views";
import {
  currentReservation,
  findTour,
  statusOf,
  tourRef,
  tourSnapshots,
  tourSummary,
  unitNameOf,
  visitorNameOf,
  type TourSnapshot,
} from "./tours";

/** A blank zone must not throw and hide the rest of the inbox. */
function shortWhen(at: string, timeZone: string): string {
  if (!isValidTimeZone(timeZone)) return "";
  return formatShortDateTime(new Date(at), timeZone);
}

/**
 * The operator's exception queue. Exceptions are derived from the canonical
 * tour records (append-only audit) plus conversations that couldn't be
 * restored; the only thing stored here is the operator's resolution, in an
 * append-only ledger next to the property. Resolving an exception never
 * changes a tour, a reservation or the setup.
 */

export type ExceptionKind =
  | "unanswered-question"
  | "handler-failed"
  | "needs-help"
  | "off-route-door"
  | "door-system"
  | "provider-failure"
  | "access-problem"
  | "verification-failed"
  | "operator-hold"
  | "message-failed"
  | "restore-conflict"
  | "overstay";

const TITLES: Record<ExceptionKind, string> = {
  "unanswered-question": "Question with no approved answer",
  "handler-failed": "Couldn't handle their text",
  "needs-help": "Visitor asked for help",
  "off-route-door": "Tried a door that isn't on their tour",
  "door-system": "Door system wasn't responding",
  "provider-failure": "Door system problem",
  "access-problem": "Couldn't get in",
  "verification-failed": "Identity check didn't pass",
  "operator-hold": "Tour paused by your team",
  "message-failed": "Message couldn't be delivered",
  "restore-conflict": "Tour couldn't be restored",
  overstay: "Visitor hasn't confirmed leaving",
};

export interface ExceptionResolution {
  exceptionId: string;
  resolvedAt: string;
  note: string;
  /** "answered": the operator supplied an approved fact and the visitor was sent it. */
  action: "resolved" | "answered";
  approvedFact?: string;
  visitorAnswered?: boolean;
}

export interface OperatorException {
  exceptionId: string;
  propertyId: string;
  property: string;
  kind: ExceptionKind;
  title: string;
  /** One plain sentence: what happened. */
  summary: string;
  visitorName: string;
  unitName?: string;
  tourRef?: string;
  happenedAt: string;
  when: string;
  /** Where the tour stands now, e.g. "Touring" or "Paused". */
  tourStatus: string;
  /** Doors won't open for this tour right now. */
  accessBlocked: boolean;
  /** The visitor's own words, for an unanswered question. */
  question?: string;
  /** The unit an unanswered question was about, when the visitor named one before booking. */
  questionUnitId?: string;
  /** The reservation the issue is about. A leaving issue is the closed tour, not a later held rebook. */
  reservationId?: string;
  /** open = needs a decision; cleared = no longer applies (e.g. the hold was lifted); resolved = the team closed it. */
  status: "open" | "cleared" | "resolved";
  resolution?: ExceptionResolution;
  /** What the team can do next, in plain language. */
  nextSteps: string[];
  /** False on a fair-housing flag: no draft answer is proposed. Omitted otherwise. */
  proposeDraft?: false;
}

// -------------------------------------------------------------------- ledger

interface LedgerFile {
  schemaVersion: 1;
  resolutions: ExceptionResolution[];
}

function ledgerPath(services: OperatorServices, propertyId: string): string {
  if (!/^[a-z0-9_]+$/.test(propertyId)) throw new SetupInputError("PROPERTY_ID_INVALID", "That property label isn't valid.");
  return join(services.workspace.root, "properties", propertyId, "operator", "exception-resolutions.json");
}

export function readResolutions(services: OperatorServices, propertyId: string): ExceptionResolution[] {
  const path = ledgerPath(services, propertyId);
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, "utf8")) as LedgerFile).resolutions;
}

function appendResolution(services: OperatorServices, propertyId: string, entry: ExceptionResolution): void {
  const resolutions = readResolutions(services, propertyId);
  writeJsonAtomic(ledgerPath(services, propertyId), { schemaVersion: 1, resolutions: [...resolutions, entry] } satisfies LedgerFile);
}

// ------------------------------------------------------------------ derive

const id = (...parts: string[]) => `exc_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12)}`;
const BLOCKING: ReservationStatus[] = [...PAUSED, "REVOKED", "CANCELLED", "VERIFICATION_FAILED", "EXPIRED"];
const ACCESS_KINDS: Record<string, ExceptionKind | undefined> = {
  DENY_WRONG_ROUTE: "off-route-door",
  DENY_DOOR_UNHEALTHY: "door-system",
  DENY_UNKNOWN: "access-problem",
  DENY_PROSPECT_MISMATCH: "access-problem",
  DENY_NO_RESERVATION: "access-problem",
};

function kindFor(e: AuditEvent): ExceptionKind | undefined {
  switch (e.type) {
    case "QUESTION_UNANSWERED":
      return "unanswered-question";
    case "HANDLER_FAILED":
      return "handler-failed";
    case "HELP_REQUESTED":
      return "needs-help";
    case "ACCESS_DENIED":
      return ACCESS_KINDS[currentDecisionCode(e.code) ?? ""];
    case "PROVIDER_FAILURE":
      return "provider-failure";
    case "VERIFICATION_FAILED":
      return "verification-failed";
    case "OPERATOR_HOLD_PLACED":
      return "operator-hold";
    case "MESSAGE_FAILED":
      return e.detail.startsWith("message") || isTeamTextFailedNotice(e.detail) ? "message-failed" : undefined;
    case "TOUR_OVERSTAY_CLOSED":
      return "overstay";
    case "VISITOR_CONFIRMED_LEFT":
      return undefined;
    default:
      return undefined;
  }
}

function reservationOn(tour: TourSnapshot, reservationId?: string): Reservation | undefined {
  if (reservationId) return tour.bundle.reservations.find((x) => x.id === reservationId);
  return currentReservation(tour);
}

function unitNameOn(tour: TourSnapshot, reservationId?: string): string | undefined {
  const r = reservationOn(tour, reservationId);
  const unit = tour.config.units.find((u) => u.id === r?.unitId);
  return unit ? visitorSubject(tour.config.property, unit.name) : undefined;
}

/** A double quote inside the visitor's words is a single quote, so the summary stays one pair of quotes. */
function escapeVisitorQuote(text: string): string {
  return text.replaceAll('"', "'");
}

/** `They asked: "{q}"` plus a period only when the question does not already end in . ? or ! */
function quotedVisitorAsk(question: string, lead = "They asked"): string {
  const asked = escapeVisitorQuote(question.trim());
  return `${lead}: "${asked}"${/[.!?]$/.test(asked) ? "" : "."}`;
}

const INJURY_TOLD = "They were told to call 911 if someone is hurt, and that you'd text them here.";
const INJURY_UNREACHED = "They were told to call 911 and that you couldn't be reached.";
const INJURY_BLOCKED = "Our text telling them to call 911 didn't go out, so they haven't heard back yet.";
const INJURY_SKIPPED = "They've opted out of texts, so they weren't texted back this time. They were already told to call 911.";
const INJURY_SKIPPED_UNREACHED = "They've opted out of texts, so they weren't texted back this time. Our earlier text telling them to call 911 didn't go out.";
const INJURY_QUEUED = "They were sent a text to call 911 if someone is hurt, but we can't confirm it reached them.";
const INJURY_SKIPPED_QUEUED = "They've opted out of texts, so they weren't texted back this time. Our earlier text telling them to call 911 was sent, but we can't confirm it reached them.";
const INJURY_QUEUED_UNREACHED = "We sent them a text to call 911 and said you couldn't be reached, but we can't confirm it got to them.";
const INJURY_STEP = "Text or call them now, then mark it handled.";
const INJURY_CALL_STEP = "Call them now, then mark it handled.";

function medicalHelpText(e: AuditEvent): string | undefined {
  const said = e.code?.trim();
  return said && isMedicalEmergency(said) ? said : undefined;
}

/**
 * The ending follows the latest alert attempt in this folded help item.
 * A later sent alert replaces an earlier failure. A suppressed repeat,
 * with no new attempt, leaves the previous attempt's ending in place.
 */
function latestHelpAttemptFailed(tour: TourSnapshot, helps: AuditEvent[]): boolean {
  const events = [...tour.bundle.auditEvents].sort((a, b) => a.seq - b.seq);
  for (const help of [...helps].reverse()) {
    for (const e of events) {
      if (e.seq <= help.seq) continue;
      if (help.reservationId) {
        if (e.reservationId !== help.reservationId) continue;
      } else if (e.reservationId) continue;
      if (e.type === "HELP_REQUESTED") break;
      if (e.type === "OPERATOR_NOTIFIED" && e.detail.includes("asked for help")) return false;
      if (e.type === "MESSAGE_FAILED" && isTeamTextFailedNotice(e.detail)) return true;
    }
  }
  return false;
}

function injuryEnding(tour: TourSnapshot, helps: AuditEvent[], tours: TourSnapshot[]): string {
  const latest = [...helps].sort((a, b) => a.seq - b.seq).at(-1);
  if (latest) {
    const line = visitorLineFor(tour, latest, tours);
    if (line === "skipped") return INJURY_SKIPPED;
    if (line === "skipped-unreached") return INJURY_SKIPPED_UNREACHED;
    if (line === "skipped-queued") return INJURY_SKIPPED_QUEUED;
    if (line === "blocked") return INJURY_BLOCKED;
    if (line === "queued") return latestHelpAttemptFailed(tour, helps) ? INJURY_QUEUED_UNREACHED : INJURY_QUEUED;
  }
  return latestHelpAttemptFailed(tour, helps) ? INJURY_UNREACHED : INJURY_TOLD;
}

function injuryNextStep(summary: string): string[] {
  const call =
    summary.includes(INJURY_BLOCKED) ||
    summary.includes(INJURY_SKIPPED) ||
    summary.includes(INJURY_SKIPPED_UNREACHED) ||
    summary.includes(INJURY_QUEUED) ||
    summary.includes(INJURY_SKIPPED_QUEUED) ||
    summary.includes(INJURY_QUEUED_UNREACHED);
  return call ? [INJURY_CALL_STEP] : [INJURY_STEP];
}

/** The number on a help record: the phone field, or a place field that is only a number. */
function visitorPhoneOf(event: AuditEvent): string | undefined {
  if (event.phone && looksLikePhone(event.phone)) return normalizePhone(event.phone);
  if (looksLikePhone(event.detail)) return normalizePhone(event.detail);
  return undefined;
}

function sameVisitor(a: AuditEvent, b: AuditEvent): boolean {
  if (a.prospectId && b.prospectId) return a.prospectId === b.prospectId;
  const left = visitorPhoneOf(a);
  const right = visitorPhoneOf(b);
  if (left && right) return left === right;
  return !a.prospectId && !b.prospectId;
}

function optOutMatches(event: AuditEvent, help: AuditEvent): boolean {
  if (help.prospectId && event.prospectId) return help.prospectId === event.prospectId;
  const phone = visitorPhoneOf(help);
  if (phone && event.code && looksLikePhone(event.code)) return normalizePhone(event.code) === phone;
  return !help.prospectId && !event.prospectId;
}

/** True when this injury is a later one in the same opt-out, so no new 911 text was sent. */
function repeatAfterOptOut(tour: TourSnapshot, help: AuditEvent): boolean {
  if (!medicalHelpText(help)) return false;
  let optSeq = -1;
  for (const event of [...tour.bundle.auditEvents].sort((a, b) => a.seq - b.seq)) {
    if (event.seq > help.seq) break;
    if (!optOutMatches(event, help)) continue;
    if (event.type === "MESSAGING_OPTED_OUT") optSeq = event.seq;
    if (event.type === "MESSAGING_OPTED_IN") optSeq = -1;
  }
  if (optSeq < 0) return false;
  return tour.bundle.auditEvents.some(
    (event) =>
      event.type === "HELP_REQUESTED" && !!medicalHelpText(event) && sameVisitor(event, help) && event.seq > optSeq && event.seq < help.seq,
  );
}

function messageForVisitor(message: Message, help: AuditEvent): boolean {
  if (help.prospectId && message.prospectId) return help.prospectId === message.prospectId;
  const phone = visitorPhoneOf(help);
  if (phone) return normalizePhone(message.counterparty) === phone;
  return !help.prospectId && !message.prospectId;
}

/** Queued means the provider accepted the send but delivery is unconfirmed. Receipts aren't recorded yet, so only SENT or DELIVERED got through. */
function injuryTextGotThrough(status: Message["deliveryStatus"]): boolean {
  return status === "SENT" || status === "DELIVERED";
}

function visitorPhoneFor(help: AuditEvent, tour: TourSnapshot): string | undefined {
  return visitorPhoneOf(help) ?? (tour.visitorPhone && looksLikePhone(tour.visitorPhone) ? normalizePhone(tour.visitorPhone) : undefined);
}

/** The earlier 911 text for this visitor, including on another tour. Confirmed delivery wins over an unconfirmed queue. */
function earlier911Line(tours: TourSnapshot[], help: AuditEvent, tour: TourSnapshot): "through" | "queued" | "none" {
  const phone = visitorPhoneFor(help, tour);
  let queued = false;
  for (const item of tours) {
    for (const message of item.bundle.messages) {
      if (message.audience !== "PROSPECT" || message.direction !== "OUTBOUND" || !message.body.includes("call 911 now")) continue;
      const mine = messageForVisitor(message, help) || (!!phone && looksLikePhone(message.counterparty) && normalizePhone(message.counterparty) === phone);
      if (!mine) continue;
      if (injuryTextGotThrough(message.deliveryStatus)) return "through";
      if (message.deliveryStatus === "QUEUED") queued = true;
    }
  }
  return queued ? "queued" : "none";
}

/**
 * The 911 text for this help. A repeat after STOP does not use up a message.
 * Each earlier try in this opt-out uses the next matching outbound text.
 * A missing text or a failed send is blocked. A queued text was accepted
 * but is unconfirmed. A suppressed or skipped text (the one allowed try
 * for this opt-out was already used) is skipped when an earlier 911 text
 * was sent or delivered, skipped-queued when that earlier text is only
 * queued, and skipped-unreached otherwise. SENT or DELIVERED was sent.
 */
function visitorLineFor(tour: TourSnapshot, help: AuditEvent, tours: TourSnapshot[]): "sent" | "blocked" | "queued" | "skipped" | "skipped-unreached" | "skipped-queued" {
  const helps = tour.bundle.auditEvents
    .filter((event) => event.type === "HELP_REQUESTED" && !!medicalHelpText(event) && sameVisitor(event, help) && event.seq <= help.seq)
    .sort((a, b) => a.seq - b.seq);
  const messages = tour.bundle.messages.filter(
    (message) => message.audience === "PROSPECT" && message.direction === "OUTBOUND" && message.body.includes("call 911 now") && messageForVisitor(message, help),
  );
  const skipped = (): "skipped" | "skipped-unreached" | "skipped-queued" => {
    const earlier = earlier911Line(tours, help, tour);
    if (earlier === "through") return "skipped";
    if (earlier === "queued") return "skipped-queued";
    return "skipped-unreached";
  };
  let index = 0;
  let line: "sent" | "blocked" | "queued" | "skipped" | "skipped-unreached" | "skipped-queued" = "blocked";
  for (const item of helps) {
    if (repeatAfterOptOut(tour, item)) {
      line = skipped();
      continue;
    }
    const message = messages[index++];
    const status = message?.deliveryStatus;
    line =
      !message || status === "FAILED" || !status
        ? "blocked"
        : status === "SUPPRESSED" || status === "SKIPPED"
          ? skipped()
          : status === "QUEUED"
            ? "queued"
            : status === "SENT" || status === "DELIVERED"
              ? "sent"
              : "blocked";
  }
  return line;
}

/** The fair-housing last sentence becomes the injury ending when this text also got the 911 line. */
function injuryEndingForQuestion(tour: TourSnapshot, asked: string, reservationId?: string): string | undefined {
  if (!isMedicalEmergency(asked)) return undefined;
  const helps = tour.bundle.auditEvents.filter(
    (e) => e.type === "HELP_REQUESTED" && e.reservationId === reservationId && (e.code ?? "").trim() === asked.trim() && !!medicalHelpText(e),
  );
  return helps.length ? injuryEnding(tour, helps, [tour]) : undefined;
}

function askedAgain(tour: TourSnapshot, event: AuditEvent): string {
  const when = shortWhen(event.at, tour.config.property.timezone);
  const said = inboundAt(event);
  return said ? ` Asked again at ${when}: "${escapeVisitorQuote(said)}".` : ` Asked again at ${when}.`;
}

/** Same injury words stay the sent sentence. A different later ask is added before the ending. */
function injuryFoldSummary(tour: TourSnapshot, events: AuditEvent[], tours: TourSnapshot[]): string {
  const first = events[0];
  const opening = (first && medicalHelpText(first)) || (first && inboundAt(first)) || "";
  let summary = quotedVisitorAsk(opening, "They texted");
  for (const later of events.slice(1)) {
    const said = inboundAt(later);
    const sameInjury = !!said && said === opening && !!medicalHelpText(later);
    if (!sameInjury) summary += askedAgain(tour, later);
  }
  return `${summary} ${injuryEnding(tour, events, tours)}`;
}

/** True when this visitor had opted out and had not texted START again by this event. */
function injuryWhileOptedOut(tour: TourSnapshot, event: AuditEvent): boolean {
  if (!medicalHelpText(event)) return false;
  let opted = false;
  for (const e of [...tour.bundle.auditEvents].sort((a, b) => a.seq - b.seq)) {
    if (e.seq > event.seq) break;
    if (event.prospectId && e.prospectId && e.prospectId !== event.prospectId) continue;
    if (e.type === "MESSAGING_OPTED_OUT") opted = true;
    if (e.type === "MESSAGING_OPTED_IN") opted = false;
  }
  return opted;
}

/** The audit row stays. It is not listed when the record before it, for that reservation, is an injury help request. */
function teamMissAfterInjury(tour: TourSnapshot, failed: AuditEvent): boolean {
  if (!isTeamTextFailedNotice(failed.detail)) return false;
  const prior = tour.bundle.auditEvents
    .filter((e) => e.seq < failed.seq && e.reservationId === failed.reservationId)
    .sort((a, b) => b.seq - a.seq)[0];
  return !!prior && prior.type === "HELP_REQUESTED" && !!medicalHelpText(prior);
}

function summaryFor(kind: ExceptionKind, e: AuditEvent, tour: TourSnapshot): string {
  const door = tour.config.doors.find((d) => d.id === e.doorId)?.name ?? "a door that isn't on file";
  switch (kind) {
    case "unanswered-question":
      return `${quotedVisitorAsk(e.detail)} There's no approved answer yet.`;
    case "handler-failed":
      return e.detail;
    case "needs-help":
      return `Asked for help${helpNear(e.detail)}.`;
    case "off-route-door":
      return `Tried ${door}, which isn't on their tour. It stayed locked.`;
    case "door-system":
      return `The door system wasn't responding at ${door}, so it stayed locked.`;
    case "provider-failure":
      return e.code === "DENY_STORAGE_FAILURE"
        ? "Tour Core couldn't save the visit record, so the tour was paused."
        : `The door system couldn't open ${door}, so the tour was paused.`;
    case "access-problem":
      return `Couldn't get into ${door}.`;
    case "verification-failed":
      return "Their identity details didn't check out, so the tour was stopped.";
    case "operator-hold":
      return `Your team paused this tour${e.detail ? `: ${e.detail}` : ""}.`;
    case "message-failed":
      return isTeamTextFailedNotice(e.detail) ? e.detail : "A message to the visitor couldn't be delivered.";
    case "restore-conflict":
      return "Couldn't be restored after a restart.";
    case "overstay":
      return `Hasn't confirmed leaving ${unitNameOn(tour, e.reservationId) ?? "the property"}.`;
  }
}

/** Drops a next step whose whole sentence is already in the summary. Other wording stays. */
function stepsNotAlreadyInSummary(summary: string, steps: string[]): string[] {
  return steps.filter((step) => !summary.includes(step));
}

function nextStepsFor(kind: ExceptionKind, tour: TourSnapshot | undefined, stillPaused: boolean, fairHousing = false): string[] {
  const canChange = !!tour?.live;
  switch (kind) {
    case "unanswered-question":
      if (fairHousing) return [...FAIR_HOUSING_STEPS];
      return [
        "If you know the answer, tell me and I can add it to the approved facts and text the visitor (with your OK).",
        "Or mark it handled if you've already answered them another way.",
      ];
    case "handler-failed":
      return [HANDLER_FAILED_NEXT_STEP, "Mark it handled once you've dealt with it."];
    case "needs-help":
      return ["Reach out to the visitor.", "Mark it handled once they're sorted."];
    case "off-route-door":
      return ["Check in with the visitor if they seem lost.", ...(canChange ? ["You can pause or call off the tour if something looks wrong."] : []), "Mark it handled."];
    case "door-system":
    case "provider-failure":
      return [
        "Check the door system, then reach out to the visitor.",
        ...(stillPaused && canChange ? ["Once the doors are working, I can resume the tour (with your OK)."] : []),
        "Mark it handled.",
      ];
    case "operator-hold":
      return stillPaused && canChange ? ["I can resume the tour (with your OK) or call it off.", "Mark it handled once it's sorted."] : ["Mark it handled."];
    case "restore-conflict":
      return ["Reach out to the visitor; no doors will open for this tour.", "If they text HI again, a fresh tour starts.", "Mark it handled."];
    case "overstay":
      return ["Reach out to the visitor if they may still be inside.", "Mark it handled once you've confirmed."];
    default:
      return ["Reach out to the visitor.", "Mark it handled."];
  }
}

function tourStatusFor(tour: TourSnapshot | undefined, reservationId?: string): { tourStatus: string; accessBlocked: boolean } {
  const r = tour ? reservationOn(tour, reservationId) : undefined;
  if (!tour) return { tourStatus: "Access is blocked", accessBlocked: true };
  const status = r ? STATUS_LABELS[r.status] : statusOf(tour);
  const blocked = !!r && BLOCKING.includes(r.status);
  return { tourStatus: blocked ? `${status}. Access is blocked.` : r && r.status === "TOURING" ? "Tour still active" : status, accessBlocked: blocked };
}

/** Whether a pause from this event is still in force (nothing lifted or replaced it since). */
function stillApplies(e: AuditEvent, tour: TourSnapshot): boolean {
  const r: Reservation | undefined = tour.bundle.reservations.find((x) => x.id === e.reservationId);
  if (!r || !PAUSED.includes(r.status)) return false;
  return !tour.bundle.auditEvents.some((later) => later.seq > e.seq && later.reservationId === e.reservationId && (later.type === "RESERVATION_RESUMED" || later.type === "OPERATOR_HOLD_PLACED" || later.type === "PROVIDER_FAILURE"));
}

function unitSubject(tour: TourSnapshot, unitId?: string): string | undefined {
  const unit = tour.config.units.find((u) => u.id === unitId);
  return unit ? visitorSubject(tour.config.property, unit.name) : undefined;
}

function fromEvent(tour: TourSnapshot, e: AuditEvent, kind: ExceptionKind, resolutions: Map<string, ExceptionResolution>, tours: TourSnapshot[] = [tour]): OperatorException {
  const exceptionId = id(tour.propertyId, tour.tourId, e.id);
  const pauseKind = kind === "operator-hold" || kind === "provider-failure";
  const paused = pauseKind && stillApplies(e, tour);
  const leftAfterClose =
    kind === "overstay" &&
    tour.bundle.auditEvents.some((later) => later.reservationId === e.reservationId && later.type === "VISITOR_CONFIRMED_LEFT" && later.seq > e.seq);
  const resolution = resolutions.get(exceptionId);
  const status = resolution ? "resolved" : pauseKind && !paused ? "cleared" : leftAfterClose ? "cleared" : "open";
  const replies =
    kind === "overstay"
      ? tour.bundle.auditEvents.filter((later) => later.reservationId === e.reservationId && later.type === "OPERATOR_NOTIFIED" && later.detail.includes("replied after their tour"))
      : [];
  const extra = replies.map((later) => later.detail).join(" ");
  const asked = kind === "unanswered-question" && e.detail ? e.detail : undefined;
  const fairHousing = kind === "unanswered-question" && e.code === FAIR_HOUSING_CODE;
  const injury = kind === "needs-help" ? medicalHelpText(e) : undefined;
  const sent = resolution?.approvedFact?.trim();
  const sentPeriod = sent && /[.!?]$/.test(sent) ? "" : ".";
  const main = injury
    ? injuryFoldSummary(tour, [e], tours)
    : asked && sent
      ? `${quotedVisitorAsk(asked)} They were sent "${escapeVisitorQuote(sent)}"${sentPeriod}`
      : summaryFor(kind, e, tour);
  const teamTextMissed = kind === "message-failed" && isTeamTextFailedNotice(e.detail);
  const injuryTold = fairHousing && asked ? injuryEndingForQuestion(tour, asked, e.reservationId) : undefined;
  const fairInbox = injuryTold ? FAIR_HOUSING_INBOX.replace(/They were told you'd text them back here\.$/, injuryTold) : FAIR_HOUSING_INBOX;
  const summary = fairHousing
    ? `${asked ? quotedVisitorAsk(asked) : "They asked a question."} ${fairInbox}`
    : teamTextMissed
      ? e.detail
      : extra
        ? `${main} ${extra}`
        : main;
  return {
    exceptionId,
    propertyId: tour.propertyId,
    property: tour.config.property.name,
    kind,
    title: injury ? "Possible injury" : teamTextMissed ? "A text to you didn't go out" : fairHousing ? FAIR_HOUSING_TITLE : TITLES[kind],
    summary,
    visitorName: visitorNameOf(tour),
    unitName: unitNameOn(tour, e.reservationId) ?? unitSubject(tour, e.unitId),
    tourRef: tourRef(tour.propertyId, tour.tourId),
    happenedAt: e.at,
    when: shortWhen(e.at, tour.config.property.timezone),
    ...tourStatusFor(tour, e.reservationId),
    ...(kind === "unanswered-question" ? { question: e.detail, ...(e.unitId ? { questionUnitId: e.unitId } : {}) } : {}),
    ...(e.reservationId ? { reservationId: e.reservationId } : {}),
    status,
    ...(resolution ? { resolution } : {}),
    nextSteps: status === "open" ? stepsNotAlreadyInSummary(summary, injury ? injuryNextStep(summary) : nextStepsFor(kind, tour, paused, fairHousing)) : [],
    ...(fairHousing ? { proposeDraft: false as const } : {}),
  };
}

function inboundAt(event: AuditEvent): string | undefined {
  return event.code?.trim() || undefined;
}

/** Later asks stay on the same exception while it is open, or if they happened before it was marked handled. */
function belongsToCurrentHelp(current: OperatorException, event: AuditEvent): boolean {
  if (current.status === "open") return true;
  if (current.status !== "resolved" || !current.resolution) return false;
  return Date.parse(event.at) <= Date.parse(current.resolution.resolvedAt);
}

/**
 * Help on one reservation stays one open item, except an injury text.
 * An injury never folds into an open plain-help item. A later plain HELP
 * still folds into an open injury item. A later injury folds into that
 * injury item, and the ending follows the latest alert attempt. While the
 * visitor is opted out, each injury stays its own item.
 */
function foldHelpExceptions(tour: TourSnapshot, events: AuditEvent[], resolutions: Map<string, ExceptionResolution>, tours: TourSnapshot[]): OperatorException[] {
  const byReservation = new Map<string, AuditEvent[]>();
  for (const e of events) {
    const key = e.reservationId ?? e.id;
    const list = byReservation.get(key) ?? [];
    list.push(e);
    byReservation.set(key, list);
  }
  const out: OperatorException[] = [];
  const members = new Map<OperatorException, AuditEvent[]>();
  for (const group of byReservation.values()) {
    let current: OperatorException | undefined;
    for (const e of group) {
      const incomingInjury = !!medicalHelpText(e);
      const startNew =
        !current ||
        !belongsToCurrentHelp(current, e) ||
        (incomingInjury && current.title !== "Possible injury") ||
        (incomingInjury && injuryWhileOptedOut(tour, e));
      if (!startNew && current) {
        const folded = members.get(current) ?? [];
        folded.push(e);
        members.set(current, folded);
        if (current.title === "Possible injury") {
          current.summary = injuryFoldSummary(tour, folded, tours);
          if (current.status === "open") current.nextSteps = stepsNotAlreadyInSummary(current.summary, injuryNextStep(current.summary));
        } else current.summary += askedAgain(tour, e);
        current.happenedAt = e.at;
        current.when = shortWhen(e.at, tour.config.property.timezone);
        continue;
      }
      current = fromEvent(tour, e, "needs-help", resolutions, tours);
      members.set(current, [e]);
      out.push(current);
    }
  }
  return out;
}

/** Every exception for one property or all of them, newest first. Open ones only unless asked. */
export async function listExceptions(services: OperatorServices, options: { propertyId?: string; includeClosed?: boolean } = {}): Promise<OperatorException[]> {
  const tours = await tourSnapshots(services, { propertyId: options.propertyId });
  const ids = options.propertyId ? [options.propertyId] : services.workspace.list().map((p) => p.config.property.id);
  const out: OperatorException[] = [];
  for (const propertyId of ids) {
    if (!services.workspace.has(propertyId)) continue;
    const resolutions = new Map(readResolutions(services, propertyId).map((r) => [r.exceptionId, r]));
    const mine = tours.filter((t) => t.propertyId === propertyId);
    for (const tour of mine) {
      const help: AuditEvent[] = [];
      for (const e of tour.bundle.auditEvents) {
        const kind = kindFor(e);
        if (kind === "needs-help") help.push(e);
        else if (kind === "message-failed" && teamMissAfterInjury(tour, e)) continue;
        else if (kind) out.push(fromEvent(tour, e, kind, resolutions));
      }
      out.push(...foldHelpExceptions(tour, help, resolutions, mine));
    }
    const { config } = services.workspace.load(propertyId);
    for (const broken of services.needsAttention?.(propertyId) ?? []) {
      const at = broken.at ?? new Date(0).toISOString();
      const exceptionId = id(propertyId, "restore", broken.visitorPhone, at);
      const resolution = resolutions.get(exceptionId);
      const earlier = mine.find((t) => t.kind === "messaging" && t.visitorPhone === broken.visitorPhone);
      const summary = `Couldn't be restored after a restart (${broken.problem.replace(/\.$/, "")}). No doors will open for it.`;
      out.push({
        exceptionId,
        propertyId,
        property: config.property.name,
        kind: "restore-conflict",
        title: TITLES["restore-conflict"],
        summary,
        visitorName: earlier ? visitorNameOf(earlier) : formatPhone(broken.visitorPhone),
        unitName: earlier ? unitNameOf(earlier) : undefined,
        happenedAt: at,
        when: shortWhen(at, config.property.timezone),
        tourStatus: "Access is blocked",
        accessBlocked: true,
        status: resolution ? "resolved" : "open",
        ...(resolution ? { resolution } : {}),
        nextSteps: resolution ? [] : stepsNotAlreadyInSummary(summary, nextStepsFor("restore-conflict", undefined, false)),
      });
    }
  }
  const visible = options.includeClosed ? out : out.filter((x) => x.status === "open");
  return visible.sort((a, b) => b.happenedAt.localeCompare(a.happenedAt));
}

export async function findException(services: OperatorServices, exceptionId: string): Promise<OperatorException> {
  const found = (await listExceptions(services, { includeClosed: true })).find((x) => x.exceptionId === exceptionId);
  if (!found) throw new SetupInputError("EXCEPTION_NOT_FOUND", "I couldn't find that issue.");
  return found;
}

/** One exception with its tour's context. */
export async function inspectException(services: OperatorServices, exceptionId: string) {
  const exception = await findException(services, exceptionId);
  const tour = exception.tourRef ? await findTour(services, exception.tourRef) : undefined;
  return {
    ...exception,
    tour: tour ? tourSummary(tour) : undefined,
    recentMessages: (tour?.conversation ?? []).slice(-6).map((m) => ({ from: m.from === "tourcore" ? "Tour Core" : m.from === "visitor" ? "Visitor" : "Demo note", text: m.text })),
  };
}

// ----------------------------------------------------------------- actions

/** Closes an exception with the team's note. Changes nothing else. Resolving twice keeps the first resolution. */
export async function resolveException(services: OperatorServices, exceptionId: string, note: string, now: Date) {
  const exception = await findException(services, exceptionId);
  const clean = note.trim().slice(0, 500);
  if (!clean) throw new SetupInputError("NOTE_MISSING", "Add a short note about how it was handled.");
  if (exception.status === "resolved") return { alreadyResolved: true, exception };
  appendResolution(services, exception.propertyId, { exceptionId, resolvedAt: now.toISOString(), note: clean, action: "resolved" });
  if (exception.kind === "overstay" && exception.tourRef) {
    try {
      const tour = await findTour(services, exception.tourRef);
      const reservationId = exception.reservationId;
      if (reservationId) tour.live?.overstay?.closeAlertWindow(reservationId);
    } catch {
      /* saved tours without a live conversation still clear via the ledger */
    }
  }
  return { alreadyResolved: false, exception: await findException(services, exceptionId) };
}

/** A tour this process is running, ready for an operator change. */
async function liveTour(services: OperatorServices, ref: string) {
  const tour = await findTour(services, ref);
  const r = currentReservation(tour);
  if (!tour.live || !r) throw new SetupInputError("TOUR_NOT_RUNNING", "That tour isn't running right now, so there's nothing to change.");
  return { tour, session: tour.live, reservation: r };
}

const HOLDABLE: ReservationStatus[] = ["RESERVED", "AWAITING_CONSENT", "AWAITING_VERIFICATION", "READY", "TOURING"];
const REVOCABLE: ReservationStatus[] = [...HOLDABLE, ...PAUSED];

export type TourChange = "hold" | "resume" | "revoke";

/** Refuses a change the tour can't make from where it is, before anyone is asked to approve it. */
function assertCanChange(tour: TourSnapshot, reservation: Reservation, change: TourChange): void {
  const name = visitorNameOf(tour);
  const now = statusOf(tour).toLowerCase();
  if (change === "hold" && !HOLDABLE.includes(reservation.status)) throw new SetupInputError("NOT_HOLDABLE", `${name}'s tour is ${now}, so it can't be paused.`);
  if (change === "resume" && !PAUSED.includes(reservation.status)) throw new SetupInputError("NOT_PAUSED", `${name}'s tour isn't paused.`);
  if (change === "revoke" && !REVOCABLE.includes(reservation.status)) throw new SetupInputError("NOT_REVOCABLE", `${name}'s tour is already ${now}, so there's nothing to call off.`);
}

/** The running tour an operator change is about, checked for that change. */
export async function describeChangeTarget(services: OperatorServices, ref: string, change: TourChange) {
  const { tour, reservation } = await liveTour(services, ref);
  assertCanChange(tour, reservation, change);
  return { tour, reservation, name: visitorNameOf(tour), unit: unitNameOf(tour) ?? "their unit" };
}

/** Pauses a tour: its doors are switched off and none open until the team resumes it. */
export async function placeHold(services: OperatorServices, ref: string, reason: string) {
  const { tour, session, reservation } = await liveTour(services, ref);
  assertCanChange(tour, reservation, "hold");
  const why = reason.trim().slice(0, 300) || "paused by the property team";
  await session.operatorChange((core, id) => core.placeOperatorHold(id, why), reservation.id);
  await persistSession(services, session);
  return tourSummary(await findTour(services, ref));
}

/** Resumes a paused tour. Access is still decided by policy on every request. */
export async function clearHold(services: OperatorServices, ref: string) {
  const { tour, session, reservation } = await liveTour(services, ref);
  assertCanChange(tour, reservation, "resume");
  await session.operatorChange((core, id) => core.resumeReservation(id), reservation.id);
  await persistSession(services, session);
  return tourSummary(await findTour(services, ref));
}

/** Calls a tour off for good: every door is switched off and the visitor is told. */
export async function revokeTour(services: OperatorServices, ref: string, reason: string) {
  const { tour, session, reservation } = await liveTour(services, ref);
  assertCanChange(tour, reservation, "revoke");
  const calledOff = tourSummary(tour);
  const why = reason.trim().slice(0, 300) || "called off by the property team";
  await session.operatorChange((core, id) => core.revokeReservation(id, why), reservation.id);
  if (session.pendingBookingId === reservation.id) session.pendingBookingId = undefined;
  // A later booking held on this conversation stays. Any other live booking does not,
  // so call-off cannot leave a Ready reservation the visitor is no longer on.
  for (const other of await session.store.list("reservations")) {
    if (other.id === reservation.id || other.id === session.pendingBookingId) continue;
    if (other.prospectId !== reservation.prospectId || !other.slotStart || TERMINAL.includes(other.status)) continue;
    await session.operatorChange((core, id) => core.revokeReservation(id, why), other.id);
  }
  await session.promotePendingBookingIfTourEnded();
  await persistSession(services, session);
  return {
    ...calledOff,
    status: STATUS_LABELS.REVOKED,
    currentStep: STATUS_LABELS.REVOKED,
    active: false,
    canChange: false,
  };
}

export function cleanFact(fact: string): string {
  const clean = fact.trim().replace(/\s+/g, " ");
  if (!clean) throw new SetupInputError("FACT_MISSING", "I need the answer in your own words before I can add it.");
  if (clean.length > MAX_FACT_LENGTH) throw new SetupInputError("FACT_TOO_LONG", `Please keep it under ${MAX_FACT_LENGTH} characters.`);
  return clean;
}

/** What the visitor receives: the approved fact itself, conversationally. */
export function visitorAnswerText(_question: string, fact: string): string {
  return `${fact} Let me know if you have any other questions.`;
}

/** Landlord-facing refusal. The visitor never sees this, and never hears "fair housing". */
export const FAIR_HOUSING_REFUSAL = "This one touches on fair housing, so I won't draft an answer. Reply to them yourself, then mark it handled.";

/** The one landlord sentence on a fair-housing flag. The summary says it once. The next step does not repeat it. */
export const FAIR_HOUSING_TITLE = "Possible fair-housing question";

export const FAIR_HOUSING_INBOX =
  "This may touch on fair housing, so there's no draft. Only you can answer this one. They were told you'd text them back here.";

export const FAIR_HOUSING_STEPS = ["Mark it handled once you've replied."] as const;

/**
 * The landlord's approve question. The quoted text equals `visitorWillReceive` byte for byte.
 * A save also says the answer will be kept. A send-only reply does not.
 */
export function sendThisQuestion(who: string, visitorWillReceive: string, options?: { save?: boolean }): string {
  const lead = options?.save ? `Send this to ${who} and save it for anyone who asks the same thing later?` : `Send this to ${who}?`;
  return `${lead} "${visitorWillReceive}"`;
}

/** An operator's answer to a flagged question, as Tour Core will save it. */
export interface FlaggedAnswerPlan {
  exception: OperatorException;
  appliesTo: "property" | "unit";
  unitId?: string;
  /** Saved as a structured unit detail (e.g. bedrooms) rather than free text. */
  field?: ProfileField;
  value?: NonNullable<UnitProfile[ProfileField]>;
  /** The approved fact exactly as it will be saved and sent. */
  fact: string;
  where: string;
  /** Handler-failure reply: text the visitor, never save an approved fact. */
  sendOnly?: boolean;
  /** First name, or the phone label when they have no name. Never "A". */
  who: string;
}

export const QUESTION_ALREADY_HANDLED = "That question has already been handled.";
export const ISSUE_ALREADY_HANDLED = "That's already been handled.";

function looksLikePhoneLabel(name: string): boolean {
  return /^\(?\+?\d/.test(name);
}

/** Operator-facing visitor label: first name, or the phone-based alert label. Never an id, never "A". */
export function operatorWhoLabel(visitorName: string | undefined, phone?: string): string {
  const name = visitorName?.trim();
  if (name && name !== UNNAMED_VISITOR && !/^A visitor\b/i.test(name) && !looksLikePhoneLabel(name)) {
    return name.split(/\s+/)[0]!;
  }
  if (phone) return formatPhone(phone);
  if (name && looksLikePhoneLabel(name)) return name;
  return "the visitor";
}

export function sendOnlyUnreachableLine(who: string): string {
  return `I couldn't text ${who}, so nothing was sent and this is still open. If you can reach them another way, do that, then mark it handled.`;
}

export function saveSendOptedOutLine(answer: string, who: string): string {
  return `Saved "${answer}" for future questions. ${who} has turned off texts from us, so I didn't send it and this is still open. If you can reach them another way, do that, then mark it handled.`;
}

export function saveSendUnreachableLine(answer: string, who: string): string {
  return `Saved "${answer}" for future questions, but I couldn't text ${who}, so nothing was sent and this is still open. If you can reach them another way, do that, then mark it handled.`;
}

const MISSED_SEND = new Set(["SUPPRESSED", "FAILED", "SKIPPED"]);

async function lastProspectOutbound(
  session: { store: { list: (kind: "messages") => Promise<Array<{ audience: string; direction: string; body: string; deliveryStatus?: string }>> } },
  body: string,
): Promise<{ body: string; deliveryStatus?: string } | undefined> {
  const outbound = (await session.store.list("messages")).filter((m) => m.audience === "PROSPECT" && m.direction === "OUTBOUND");
  return [...outbound].reverse().find((m) => m.body === body) ?? outbound.at(-1);
}

async function sendOnlyMissedVisitor(session: { store: { list: (kind: "messages") => Promise<Array<{ audience: string; direction: string; body: string; deliveryStatus?: string }>> } }, body: string): Promise<boolean> {
  const last = await lastProspectOutbound(session, body);
  return !last || last.body !== body || !last.deliveryStatus || MISSED_SEND.has(last.deliveryStatus);
}

/**
 * Works out how an operator's answer will be saved, without saving anything.
 * An answer to a question about a unit detail ("How many bedrooms?" / "2
 * bedrooms") becomes that unit's structured value, and the visitor gets the
 * canonical sentence ("Unit 1A has 2 bedrooms."). Anything else is kept in the
 * operator's own words as a unit or property fact.
 */
export async function planFlaggedAnswer(services: OperatorServices, input: { exceptionId: string; approvedFact: string; appliesTo?: "property" | "unit" }, now: Date): Promise<FlaggedAnswerPlan> {
  const exception = await findException(services, input.exceptionId);
  if (exception.status === "resolved") {
    throw new SetupInputError("ALREADY_RESOLVED", exception.kind === "handler-failed" ? ISSUE_ALREADY_HANDLED : QUESTION_ALREADY_HANDLED);
  }
  const tourForWho = exception.tourRef ? await findTour(services, exception.tourRef) : undefined;
  const who = operatorWhoLabel(exception.visitorName, tourForWho?.visitorPhone);
  if (exception.proposeDraft === false) {
    throw new SetupInputError("NO_DRAFT", FAIR_HOUSING_REFUSAL);
  }
  if (exception.kind === "handler-failed") {
    const words = cleanFact(input.approvedFact);
    return { exception, appliesTo: "property", fact: words, where: exception.property, sendOnly: true, who };
  }
  if (exception.kind !== "unanswered-question" || !exception.question) throw new SetupInputError("NOT_A_QUESTION", "That issue isn't an unanswered question.");
  const words = cleanFact(input.approvedFact);
  const tour = tourForWho;
  const unitId = exception.questionUnitId ?? (tour ? reservationOn(tour, exception.reservationId)?.unitId : undefined);
  const { draft } = services.workspace.openDraft(exception.propertyId);
  const unit = draft.units.find((u) => u.id === unitId);
  const topic = questionTopic(exception.question);
  if (unit && topic && input.appliesTo !== "property") {
    const value = structuredAnswer(topic, words, now);
    if (value) {
      const fact = profileFacts({ name: visitorSubject(draft.property, unit.name), profile: { [topic]: value } }).find((f) => f.field === topic)!.text;
      return { exception, appliesTo: "unit", unitId: unit.id, field: topic, value, fact, where: visitorSubject(draft.property, unit.name), who };
    }
  }
  const unitTopic = !!topic && ["bedrooms", "bathrooms", "monthlyRent", "availability", "squareFeet", "floor", "furnished", "features"].includes(topic);
  const appliesTo = input.appliesTo ?? (unit && unitTopic ? "unit" : "property");
  if (appliesTo === "unit" && !unit) throw new SetupInputError("UNIT_NOT_FOUND", "I couldn't tell which unit that question was about. Add it as a property fact instead.");
  const fact = /[.!?]$/.test(words) ? words : `${words}.`;
  return { exception, appliesTo, unitId: unit?.id, fact: fact.charAt(0).toUpperCase() + fact.slice(1), where: appliesTo === "unit" ? visitorSubject(draft.property, unit!.name) : exception.property, who };
}

/**
 * The operator supplied the answer to a flagged question. It becomes approved
 * content through the normal setup edit (content changes keep the property
 * published), the visitor is sent exactly that fact, and the exception is
 * resolved. Tour Core never writes the answer itself.
 */
export async function answerFlaggedQuestion(
  services: OperatorServices,
  input: { exceptionId: string; approvedFact: string; appliesTo?: "property" | "unit" },
  now: Date,
) {
  const plan = await planFlaggedAnswer(services, input, now);
  const { exception, fact } = plan;
  const ws = services.workspace;
  const tour = exception.tourRef ? await findTour(services, exception.tourRef) : undefined;
  const wasPublished = ws.has(exception.propertyId) && ws.load(exception.propertyId).state.status === "PUBLISHED_FOR_DEMO";

  if (plan.sendOnly) {
    if (!tour?.live) {
      throw new SetupInputError("VISITOR_UNREACHABLE", sendOnlyUnreachableLine(plan.who));
    }
    await tour.live.reply(fact, undefined, { templateId: "approved-answer" });
    await persistSession(services, tour.live);
    if (await sendOnlyMissedVisitor(tour.live, fact)) {
      throw new SetupInputError("VISITOR_UNREACHABLE", sendOnlyUnreachableLine(plan.who));
    }
    appendResolution(services, exception.propertyId, {
      exceptionId: exception.exceptionId,
      resolvedAt: now.toISOString(),
      note: "Sent a reply.",
      action: "answered",
    });
    const after = ws.has(exception.propertyId) ? ws.load(exception.propertyId) : undefined;
    return {
      savedToSetup: false,
      visitorAnswered: true,
      visitorMessage: fact,
      setupStatus: after ? statusLabel(after) : "Setup in progress",
      stillPublished: wasPublished && after?.state.status === "PUBLISHED_FOR_DEMO",
      needsRecheck: false,
    };
  }

  const { draft } = ws.openDraft(exception.propertyId);
  let next;
  if (plan.field && plan.unitId && plan.value) {
    next = structuredClone(draft);
    const unit = next.units.find((u) => u.id === plan.unitId)!;
    unit.profile = { ...(unit.profile ?? {}), [plan.field]: plan.value };
  } else if (plan.appliesTo === "unit") {
    const unit = draft.units.find((u) => u.id === plan.unitId)!;
    next = applySetupCommand(draft, "setUnitDetails", { unitId: unit.id, facts: [...unit.facts, fact] });
  } else {
    next = applySetupCommand(draft, "setPropertyDetails", { facts: [...draft.property.facts, fact] }, { everPublished: ws.wasEverPublished(exception.propertyId) });
  }
  const saved = ws.persistEdit(next, now);

  let visitorAnswered = false;
  let sendMissed: "opted-out" | "unreachable" | undefined;
  const visitorMessage = visitorAnswerText(exception.question!, fact);
  if (tour?.live) {
    const prospects = await tour.live.store.list("prospects");
    const optedOut = tour.live.optedOut || tour.live.smsConsent === "opted_out" || prospects.some((prospect) => prospect.messagingOptedOut);
    if (optedOut) {
      sendMissed = "opted-out";
    } else {
      await tour.live.reply(visitorMessage, undefined, { templateId: "approved-answer-closing" });
      await resumeStep(tour.live);
      await persistSession(services, tour.live);
      if (await sendOnlyMissedVisitor(tour.live, visitorMessage)) {
        const last = await lastProspectOutbound(tour.live, visitorMessage);
        sendMissed = last?.deliveryStatus === "SUPPRESSED" ? "opted-out" : "unreachable";
      } else {
        visitorAnswered = true;
      }
    }
  }
  if (!sendMissed) {
    appendResolution(services, exception.propertyId, {
      exceptionId: exception.exceptionId,
      resolvedAt: now.toISOString(),
      note: visitorAnswered ? "Answered with a new approved fact." : "Added a new approved fact; the visitor's tour wasn't running, so they weren't texted.",
      action: "answered",
      approvedFact: fact,
      visitorAnswered,
    });
  }
  const after = ws.has(exception.propertyId) ? ws.load(exception.propertyId) : undefined;
  return {
    approvedFact: fact,
    addedTo: plan.where,
    savedToSetup: saved === "saved",
    visitorAnswered,
    visitorMessage: visitorAnswered ? visitorMessage : undefined,
    ...(sendMissed ? { sendMissed } : {}),
    setupStatus: after ? statusLabel(after) : "Setup in progress",
    stillPublished: wasPublished && after?.state.status === "PUBLISHED_FOR_DEMO",
    /** Only if something structural changed (never for an approved fact). */
    needsRecheck: wasPublished && after?.state.status !== "PUBLISHED_FOR_DEMO",
  };
}
