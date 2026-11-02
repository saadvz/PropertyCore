import { resolveSpokenTime } from "../core/customSlot";
import { orList, resolveQuestion, unitsNamedIn } from "../core/questions";
import { isoDate, parseIsoDate } from "../core/schedule";
import { dayReference, spokenTimes, type DayReference, type SpokenTime } from "../core/spokenTime";
import { bookedClockZone, tourAlreadyUnderway } from "../core/inProgressTour";
import { addDays, formatDay, formatTime, formatVisitorClock, isValidTimeZone, localDateOf, UnsetTimeZoneError, weekdayOf, zonedParts, type LocalDate } from "../core/timezone";
import {
  NOTHING_BOOKED_CANCEL,
  TOUR_AGAIN_SUFFIX,
  TOUR_ENDED_REPLY,
  unknownAnswerReply,
  VisitorDenialCopy,
  visitorCancelConfirm,
  visitorCancelKeptFor,
  visitorBookingConfirmed,
  type InboundMeta,
} from "../core/TourCore";
import { cannotCancelRunningOfferLater, cannotCancelRunningTour, laterCancelConfirm } from "../core/availabilityCopy";
import { CANCEL_OPT_OUT, renderSms, visitorTeamName } from "../sms/templates";
import { propertyDirectionsUrl } from "../core/mapsLink";
import { namedCancelFocus } from "./cancelTarget";
import { awaitingLatestYesNo, doorAskSupersedesCancel } from "./latestQuestion";
import { DOOR_AFTER_T, isLeavingTour, T5_NO_OFFER_BARE_YES } from "../core/overstayCopy";
import { afterCloseAlertOpen } from "./overstayScheduler";
import { isBareTodayOrTonight } from "../intent/tourHoursAsk";
import { isFlexibleYes, yesNo } from "../intent/yesNo";
import { isRunningReservation, TERMINAL } from "../domain/stateMachine";
import { stripFiller } from "../intent/normalize";
import {
  isCancelTourAsk,
  isConcreteHelpProblem,
  isMedicalEmergency,
  isUnbookedCancelAsk,
  isConfident,
  keywordOf,
  messagingKeyword,
  onTourDoorIntent,
  LayeredIntentInterpreter,
  normalize,
  type Awaiting,
  type IntentInterpretation,
  type IntentInterpreter,
  type InterpretContext,
  type StepAwaiting,
  type StopRef,
  type TourIntent,
} from "../intent";
import type { ReplyPrompt } from "../messaging/presentation";
import { timeMenu } from "./entry";
import { OPERATOR_SCHEDULE_CONFIRM_PROMPT, type InterpretationNote, type Said, type VisitorDemoSession, type VisitorStage } from "./session";
import { savedTourHours } from "./tourHoursQuestion";
import { acceptsOfferedOpening, nextOpeningFollowUp, offerDate, takeOfferedOpening } from "./unavailableDay";
import { firstInboundMatch, isBareCarrierCancel, isSchedulingMenuAnswer, type InboundKind } from "./inboundTextPipeline";
import { SMS_GATE_REMINDER, SMS_KEYWORD_PROMPT, smsDisclosure, smsHelpBody, smsOptInConfirmation } from "./smsConsent";

/**
 * Typed replies from a real phone ("1", "YES", "just pulled up", "does it
 * have laundry?") mapped onto the same visitor actions the browser phone's
 * buttons use. An interpreter says what the visitor is trying to do; this
 * file decides, deterministically, whether that's clear enough to act on or
 * needs a question back. Whether a door opens is still decided only by Tour
 * Core's policy, exactly as for a button tap.
 *
 * A text is one intent. If it asks a property question and names a custom
 * time, the question is answered and the time is filed only after the visitor
 * confirms it. The time is not dropped.
 */

export { keywordOf, type Keyword } from "../intent";

export const isGreeting = (text: string) => /^(hi|hello|hey|hiya|tour|book|start over|new tour|hi there|good (morning|afternoon|evening))\b/.test(normalize(text));

/** A greeting and nothing else — "hi", "hello!", "yo" — not "Hi, I'm still stuck". */
export function isStandaloneGreeting(text: string): boolean {
  return /^(hi|hello|hey|hiya|yo|hi there|good (morning|afternoon|evening))$/.test(normalize(text));
}

const AFTER_CLOSE_DISTRESS =
  /\b(stuck|trapped|inside|door|help|emergency|jammed|lock|locked|gate|let me out|lock in|cannot get out|can t get out|cannot get outside|can t get outside|no way out|will not open|cannot open|still in the unit|still inside|cannot find (?:the |my |a )?way out|can not find (?:the |my |a )?way out|where is the way out|where is the exit|how do i get out|how can i get out)\b/;
const LEAVE_DISTRESS = /\b(cannot leave|unable to leave|how do i leave|let me leave)\b/;
const HELP_BOOKING = /\bhelp(?: me)? book(?:ing)?\b/;

/** After-close distress: never start a booking, even when booking words are also present. */
export function mentionsAfterCloseDistress(text: string): boolean {
  if (/🔒/.test(text)) return true;
  const t = stripFiller(normalize(text));
  const rest = HELP_BOOKING.test(t) ? t.replace(HELP_BOOKING, " ") : t;
  return AFTER_CLOSE_DISTRESS.test(rest) || LEAVE_DISTRESS.test(rest);
}

/** A clear ask to book — not a bare greeting. Distress always wins. */
export function isClearBookingPhrase(text: string, intent?: TourIntent): boolean {
  if (mentionsAfterCloseDistress(text)) return false;
  if (intent?.type === "START_INQUIRY") return true;
  const t = stripFiller(normalize(text));
  if (/^(tour|book|start over|new tour)$/.test(t)) return true;
  if (HELP_BOOKING.test(t)) return true;
  return /\b(book (another |a )?(tour|look|showing)|another (tour|look|showing)|new tour|tour again|i would like to book|see it again|schedule another (visit|tour))\b/.test(t);
}

/** After a +15 close, only a standalone greeting or a clear booking phrase starts a new booking. */
export function startsNewBookingAfterClose(text: string, intent?: TourIntent): boolean {
  if (mentionsAfterCloseDistress(text)) return false;
  if (isStandaloneGreeting(text)) return true;
  return isClearBookingPhrase(text, intent);
}

/** Locked visitor copy when an inbound is a photo with no caption. Do not say MMS. */
export const PHOTO_ALONE_REPLY = "I can't take photos yet. Text your question and I'll pass it along.";
/** Locked visitor copy when an inbound is a photo plus handleable text. Unanswerable questions use UNKNOWN_ANSWER_WITH_PHOTO instead. */
export const PHOTO_WITH_TEXT_REPLY = "I can't take photos yet.";

/** Sends the short photo line unless a combined unknown-question text will replace it. */
function photoAckFor(session: VisitorDemoSession, pending: boolean) {
  let open = pending;
  return {
    consume() {
      open = false;
    },
    async send() {
      if (!open) return;
      open = false;
      await session.reply(PHOTO_WITH_TEXT_REPLY);
    },
  };
}

/** Lead when published hours changed and a numbered/old-menu reply can't be mapped safely. */
export const SCHEDULE_CHANGED_LEAD = "Tour times just changed. Here's what's open now:";
const WHICH_DAY = "Which day works for you?";
const DAY_MENU = `I have tours available. ${WHICH_DAY}`;
const MENU_NUMBER = /^\s*(?:#|number |option )?(\d{1,2})\s*[.!]?\s*$/i;
const EXPLICIT_CHANGE_PHRASE = /\b(instead|switch|change to|move it|reschedule|another time|another day|different day)\b/;
const WEEKDAY_OR_DAY = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b/;
const WEEKDAY_WORD: Record<string, string> = {
  MON: "monday",
  TUE: "tuesday",
  WED: "wednesday",
  THU: "thursday",
  FRI: "friday",
  SAT: "saturday",
  SUN: "sunday",
};
const TIME_SHIFT_ASK =
  /\b((?:make|move|switch|change)(?: it| the tour| that)? (?:later|earlier)|(?:a |an )?(?:later|earlier) (?:time|slot|opening)|(?:later|earlier) if possible|can we do (?:it )?(?:later|earlier)|later in the week|(?:is there )?anything (?:later|earlier)(?! is fine)|(?:later|earlier) would be better)\b/;
/** "sooner" is a change only as an ask, not in consent idioms like "the sooner the better". */
const SOONER_CHANGE_ASK =
  /\b(sooner would be better|can we do (?:it )?sooner|(?:is there )?anything sooner|something sooner)\b/;
const NEGATED_CHANGE = /\b(no need to|do not need to|will not need to|would not need to|no reason to|not going to)\b.{0,40}\b(switch|reschedule|change|move|cancel)\b|\bno change\b/;
const ARRIVAL_REMARK =
  /\b(be there|arrive|get there|show up|come by|get in)\b.{0,40}\b(earlier|later|early|late)\b|\b(might be|may be|could be|will be)\b.{0,30}\b(\d+\s*(min|minutes?) )?(early|late|earlier|later)\b|\b(\d+\s*(min|minutes?) )(early|late)\b/;
const WEEKDAY_CODE: Record<string, string> = {
  monday: "MON",
  tuesday: "TUE",
  wednesday: "WED",
  thursday: "THU",
  friday: "FRI",
  saturday: "SAT",
  sunday: "SUN",
};

function namesDayOrTime(text: string): boolean {
  const n = normalize(text);
  return WEEKDAY_OR_DAY.test(n) || spokenTimes(n).length > 0;
}

function isNegatedChange(text: string): boolean {
  return NEGATED_CHANGE.test(text);
}

function isArrivalRemark(text: string): boolean {
  if (TIME_SHIFT_ASK.test(text)) return false;
  return ARRIVAL_REMARK.test(text);
}

function consentRemainder(text: string): string {
  return text.replace(/^\s*(yes|yeah|yep|yup|ok|okay|sure)[,!.]?\s+/i, "").replace(/^but\s+/i, "").trim();
}

function isSoonerQuestionAsk(text: string): boolean {
  return /^\s*sooner\s*\?+\s*$/i.test(text) || /^\s*sooner\s*\?+\s*$/i.test(consentRemainder(text));
}

function isSoonerChangeAsk(text: string): boolean {
  if (isSoonerQuestionAsk(text)) return true;
  const n = stripFiller(normalize(text));
  if (SOONER_CHANGE_ASK.test(n)) return true;
  return /\bsooner\b/.test(n) && namesDayOrTime(n);
}

function laterOrEarlierShift(text: string): "later" | "earlier" | "later-in-week" | undefined {
  const n = stripFiller(normalize(text));
  if (isArrivalRemark(n) || isNegatedChange(n)) return undefined;
  if (/\blater in the week\b/.test(n)) return "later-in-week";
  if (isSoonerChangeAsk(text)) return "earlier";
  if (
    /\b(make it earlier|move it earlier|an earlier time|earlier time|earlier slot|earlier if possible|can we do (?:it )?earlier|anything earlier|is there anything earlier|earlier would be better)\b/.test(n)
  ) {
    return "earlier";
  }
  if (
    /\b(make it later|move it later|a later time|later time|later slot|later if possible|can we do (?:it )?later|anything later|later would be better)\b/.test(n)
  ) {
    return "later";
  }
  return undefined;
}

/** A weekday or relative day they want instead — not a day they ruled out. */
function requestedChangeDay(text: string): DayReference | undefined {
  if (isNegatedChange(text) || isArrivalRemark(text)) return undefined;
  const n = normalize(text);
  const excluded = excludedDays(text);
  const found: DayReference[] = [];
  for (const [word, code] of Object.entries(WEEKDAY_CODE)) {
    if (excluded.has(code)) continue;
    if (new RegExp(`\\b${word}\\b`).test(n)) found.push({ weekday: code as NonNullable<DayReference["weekday"]> });
  }
  if (/\btoday\b/.test(n) && !excluded.has("today")) found.push({ relative: "today" });
  if (/\btomorrow\b/.test(n) && !excluded.has("tomorrow")) found.push({ relative: "tomorrow" });
  return found.length === 1 ? found[0] : undefined;
}

function isBareLaterOrEarlier(text: string): boolean {
  return /^(later|earlier|sooner)$/.test(stripFiller(normalize(text)));
}

function isScheduleChangeRemainder(text: string): boolean {
  const n = normalize(text);
  if (isNegatedChange(n) || isArrivalRemark(n)) return false;
  if (isSoonerChangeAsk(text)) return true;
  if (/\b(different day|another day|another time)\b/.test(n)) return true;
  if (TIME_SHIFT_ASK.test(n)) return true;
  if (/\b(instead|switch|change to|move it|reschedule)\b/.test(n)) return true;
  if (namesDayOrTime(n)) return true;
  return false;
}

/** Days the visitor ruled out ("not monday", "tomorrow I am busy"). Never pick these. */
function excludedDays(text: string): Set<string> {
  const n = normalize(text);
  const excluded = new Set<string>();
  for (const [word, code] of Object.entries(WEEKDAY_CODE)) {
    if (new RegExp(`\\bnot ${word}\\b`).test(n) || new RegExp(`\\b${word} i am busy\\b`).test(n)) excluded.add(code);
  }
  if (/\bnot today\b/.test(n) || /\btoday i am busy\b/.test(n)) excluded.add("today");
  if (/\bnot tomorrow\b/.test(n) || /\btomorrow i am busy\b/.test(n)) excluded.add("tomorrow");
  return excluded;
}

function sameLocalDay(a: LocalDate, b: LocalDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function dayAskExcluded(ask: DayReference, text: string, today: LocalDate): boolean {
  const excluded = excludedDays(text);
  if (ask.relative === "today" && excluded.has("today")) return true;
  if (ask.relative === "tomorrow" && excluded.has("tomorrow")) return true;
  if (ask.weekday && excluded.has(ask.weekday)) return true;
  if (ask.date) {
    const wd = weekdayOf(ask.date);
    if (excluded.has(wd)) return true;
    if (excluded.has("today") && sameLocalDay(ask.date, today)) return true;
    if (excluded.has("tomorrow") && sameLocalDay(ask.date, addDays(today, 1))) return true;
  }
  return false;
}

/** Change only when the leftover words actually modify the tour time. Farewells and arrival remarks are not a change. */
function hasExplicitChangeAsk(text: string): boolean {
  const n = stripFiller(normalize(text));
  if (isNegatedChange(n) || isArrivalRemark(n)) return false;
  if (leftoverAfterConsent(text)) return false;
  if (EXPLICIT_CHANGE_PHRASE.test(n)) return true;
  if (TIME_SHIFT_ASK.test(n)) return true;
  if (isSoonerChangeAsk(text)) return true;
  if (/\brather\b/.test(n) && namesDayOrTime(n)) return true;
  return /\b(but|instead)\b/.test(n) && namesDayOrTime(n);
}

function leftoverAfterConsent(text: string): string | undefined {
  const stripped = text.replace(/^\s*(yes|yeah|yep|yup|ok|okay|sure)[,!.]?\s+/i, "").replace(/^but\s+/i, "").trim();
  if (!stripped) return undefined;
  if (isIdentityFormAsk(stripped) || isScheduleChangeRemainder(stripped)) return undefined;
  if (/\?/.test(stripped) || /\b(park|parking|entrance|prepare)\b/i.test(stripped)) return stripped;
  return undefined;
}

/** "Where's the form?" resends the identity link. It is not a property question. */
function isIdentityFormAsk(text: string): boolean {
  return /\b(form|links?|identity|verif\w*|id check|my id)\b/.test(stripFiller(normalize(text)));
}

async function answerLeftoverAfterConsent(turn: Turn, text: string): Promise<void> {
  const leftover = leftoverAfterConsent(text);
  if (!leftover) return;
  await turn.session.askQuestion(leftover, {
    meta: turn.said.meta,
    alreadyRecorded: true,
    unknownReply: unknownReplyFor(turn),
  });
}

async function affirmsBookedDay(turn: Turn): Promise<boolean> {
  const reservation = await turn.session.reservation();
  if (!reservation?.slotStart) return false;
  const booked = weekdayOf(localDateOf(new Date(reservation.slotStart), turn.session.config.property.timezone));
  const word = WEEKDAY_WORD[booked];
  if (!word) return false;
  const n = normalize(turn.said.text ?? "");
  return new RegExp(`\\b${word}\\b.{0,24}\\b(fine|ok|okay|good|works|great)\\b`).test(n) || new RegExp(`\\b(fine|ok|okay|good|works|great).{0,24}\\b${word}\\b`).test(n);
}

/** A clear YES/NO, including yes/ok plus extra words. Change markers are not consent. */
function clearConsentAnswer(text: string): "yes" | "no" | undefined {
  const normalized = normalize(text).replace(NEGATED_CHANGE, " ");
  if (hasExplicitChangeAsk(text)) return undefined;
  const t = stripFiller(normalized);
  if (hasExplicitChangeAsk(t)) return undefined;
  const yn = yesNo(normalized);
  if (yn.answer && yn.confidence >= 0.75) return yn.answer;
  const ynStripped = yesNo(t);
  if (ynStripped.answer && ynStripped.confidence >= 0.75) return ynStripped.answer;
  if (/\b(yes|yeah|yep|yup|ok|okay|sure)\b/.test(normalized) && !/\b(no|nope|nah)\b/.test(normalized)) return "yes";
  if (/\b(no|nope|nah)\b/.test(normalized) && !/\b(yes|yeah|yep|ok|okay)\b/.test(normalized)) return "no";
  return undefined;
}

const SORRY = "Sorry, I didn't catch that.";
const rulesOnly = new LayeredIntentInterpreter();

function stopRef(session: VisitorDemoSession, doorId: string): StopRef {
  const door = session.config.doors.find((d) => d.id === doorId);
  const unit = session.config.units.find((u) => u.doorId === doorId);
  return { doorName: door?.name ?? doorId, kind: door?.kind ?? "COMMON", ...(unit ? { unitName: unit.name } : {}), label: session.stopLabel(doorId) };
}

async function contextFor(session: VisitorDemoSession, message: string, step: VisitorStage, awaiting?: StepAwaiting): Promise<InterpretContext> {
  const r = await session.reservation();
  const remaining = step === "ready" || step === "touring" ? await session.remainingStops() : [];
  const now = session.clock.now();
  const underway = !!r && tourAlreadyUnderway(r, now);
  const zone = isValidTimeZone(session.config.property.timezone)
    ? session.config.property.timezone
    : underway
      ? bookedClockZone(session.config.property.timezone, r)
      : undefined;
  if (!zone && !underway) throw new UnsetTimeZoneError();
  return {
    message,
    step,
    ...(awaiting ? { awaiting } : {}),
    units: session.config.units.map((u) => ({ name: u.name, ...(u.summary ? { summary: u.summary } : {}) })),
    timeChoices: step === "choose-date" ? session.offeredDates.map((day) => day.label) : session.offeredSlots.map((s) => s.label),
    ...(zone ? { today: localDateOf(now, zone), timezone: zone } : {}),
    teamName: session.config.operator.name,
    ...(r ? { reservedUnit: session.config.units.find((u) => u.id === r.unitId)?.name } : {}),
    remainingStops: remaining.map((id) => stopRef(session, id)),
    doors: session.config.doors.map((d) => stopRef(session, d.id)),
    hasCancelableTour: await session.hasCancelableTour(),
    hasRunningTour: !!r && isRunningReservation(r.status),
  };
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The door a named stop refers to. Only doors on file; the interpreter can't invent one. */
function namedDoor(session: VisitorDemoSession, intent: TourIntent): string | undefined {
  if (intent.type === "AT_UNIT" && intent.unitName) return session.config.units.find((u) => same(u.name, intent.unitName!))?.doorId;
  if (intent.type === "AT_ROUTE_STOP" && intent.stopName) return session.config.doors.find((d) => same(d.name, intent.stopName!))?.id;
  return undefined;
}

type Target = { doorId: string } | { choices: string[] } | { none: true } | { unknownName: true };

/** Which door "I'm at the unit" / "I'm here" means. A reference that fits more than one stop is never guessed. */
function targetOf(session: VisitorDemoSession, intent: TourIntent, remaining: string[]): Target {
  const named = intent.type === "AT_UNIT" ? intent.unitName : intent.type === "AT_ROUTE_STOP" ? intent.stopName : undefined;
  if (named) {
    const doorId = namedDoor(session, intent);
    return doorId ? { doorId } : { unknownName: true };
  }
  const unitDoors = new Set(session.config.units.map((u) => u.doorId));
  const candidates = intent.type === "AT_UNIT" ? remaining.filter((d) => unitDoors.has(d)) : remaining;
  if (candidates.length === 1) return { doorId: candidates[0]! };
  if (candidates.length > 1) return { choices: candidates };
  return { none: true };
}

/** One typed message being handled: its interpretation, and what Tour Core said back. */
class Turn {
  constructor(
    readonly session: VisitorDemoSession,
    readonly said: Said,
    readonly stage: VisitorStage,
    readonly interpretation: IntentInterpretation,
    private readonly note: InterpretationNote,
    /** The step confirmation Tour Core was waiting on when this message arrived. */
    readonly awaiting?: StepAwaiting,
  ) {}

  /** True when this inbound already got the short photo line. Combined unknown replies must not mention photos again. */
  photoLineSent = false;

  markClarification(): void {
    this.note.clarification = true;
  }

  get intent(): TourIntent {
    return this.interpretation.intent;
  }

  get confident(): boolean {
    return isConfident(this.interpretation);
  }

  act(action: string, input: unknown = {}): Promise<void> {
    return this.session.act(action, input, this.said);
  }

  /** Records the visitor's text and answers without acting. */
  async respond(body: string, prompt?: ReplyPrompt): Promise<void> {
    await this.session.recordText(this.said);
    await this.session.reply(body, prompt);
  }

  /** Asks instead of acting. `awaiting` gives the visitor's next short reply ("yes", "2") its meaning. */
  async clarify(body: string, prompt?: ReplyPrompt, awaiting?: Awaiting): Promise<void> {
    this.note.clarification = true;
    if (awaiting) this.session.expect(this.stage, awaiting);
    await this.respond(body, prompt);
  }

  /** The rules' own follow-up ("No rush! Text me when...") or a nudge after "ignore your rules...". */
  async fallback(sorry: string, prompt?: ReplyPrompt, hint = ""): Promise<void> {
    const i = this.interpretation;
    if (i.manipulation) return this.clarify(`I can only help with your own tour. Doors open only for the stops on it, during your tour time.${hint}`);
    // A "Text X when..." prompt would repeat the follow-up's own wording; menus and yes/no still apply.
    if (i.clarificationQuestion) return this.clarify(i.clarificationQuestion, prompt?.kind === "say" ? undefined : prompt);
    return this.respond(sorry, prompt);
  }
}

/** Facts for the shared inbound pipeline. Doors are included only while a tour is running. */
async function classifyInbound(session: VisitorDemoSession, text: string): Promise<{
  kind?: InboundKind;
  touring: boolean;
  doors: StopRef[];
  reservation: Awaited<ReturnType<VisitorDemoSession["reservation"]>>;
}> {
  const reservation = await session.reservation();
  const touring = !!reservation && isRunningReservation(reservation.status);
  // Every door on the property, not only the route. A named door that is not
  // on this tour is still a door ask, so policy can refuse it. Limiting the
  // list to the route made "I'm at unit 102" look like a generic unit and
  // opened the next stop.
  const doors = touring ? session.config.doors.map((door) => stopRef(session, door.id)) : [];
  return { kind: firstInboundMatch({ text, touring, doors }), touring, doors, reservation };
}

/**
 * The single entry point for a typed message from a visitor. The caller
 * (any messaging webhook) has already verified and de-duplicated it.
 * Returns how the message was read, for the caller's own records.
 */
export async function handleVisitorText(
  session: VisitorDemoSession,
  from: string,
  text: string,
  meta?: InboundMeta,
  interpreter: IntentInterpreter = rulesOnly,
): Promise<IntentInterpretation | undefined> {
  const said: Said = { text, meta };
  const firstMessage = !session.visitor;
  if (firstMessage) session.identify(from);

  const photo = !!meta?.hasMedia;
  const typed = text.trim();
  const keyword = messagingKeyword(text);
  const silent = session.optedOut && keyword !== "start" && keyword !== "stop";
  const photoAck = photoAckFor(session, photo && !!typed && !silent);

  if (photo && !typed) {
    if (!silent) await session.reply(PHOTO_ALONE_REPLY);
    await session.recordText({ text: "(photo)", meta });
    return undefined;
  }

  const inbound = await classifyInbound(session, text);
  if (inbound.kind === "help") {
    await session.help(said);
    return undefined;
  }
  if (inbound.kind === "emergency") {
    await session.help(said);
    return undefined;
  }
  if (inbound.kind === "stop") {
    if (session.pendingClarification?.awaiting.kind === "confirm-operator-tour") session.takeExpected(await session.stage());
    const bareBookedCancel = !inbound.touring && isBareCarrierCancel(text) && (await session.hasCancelableTour());
    await session.optOut(said, bareBookedCancel ? { reply: CANCEL_OPT_OUT, keyword: "STOP", restoreOnStart: true } : undefined);
    return undefined;
  }
  if (!session.optedOut && session.smsConsent !== "opted_in" && !inbound.reservation && isConcreteHelpProblem(text)) {
    await session.help(said);
    return undefined;
  }

  // Operator-set tour: YES/NO/STOP are about that confirmation, not the SMS keyword gate.
  // A released or cancelled hold is not still waiting — don't send another confirm text.
  if (session.pendingClarification?.awaiting.kind === "confirm-operator-tour") {
    const reservation = await session.reservation();
    if (reservation?.awaitingVisitorConfirm?.kind === "OPERATOR_SCHEDULED") {
      await photoAck.send();
      await handleOperatorScheduledReply(session, said, text);
      return undefined;
    }
    session.takeExpected(session.pendingClarification.stage);
  }

  // Someone who opted out gets no texts, except HELP and one 911 line per opt-out.
  // The alert and the Possible injury item do not text the visitor. Check before
  // the SMS keyword gate so STOP'd visitors aren't treated as un-enrolled senders.
  if (session.optedOut && keyword !== "start" && keyword !== "stop") {
    photoAck.consume();
    if (keyword === "help") {
      await session.recordText(said);
      await session.reply(smsHelpBody(process.env, { visitorContact: session.config.operator.visitorContact }), undefined, { deliverDespiteOptOut: true });
      return undefined;
    }
    if (isMedicalEmergency(text)) {
      await session.help(said);
      return undefined;
    }
    await flagSilentOptedOutQuestion(session, said, text, photo, interpreter);
    return undefined;
  }

  // SMS campaign consent comes before any property or booking content.
  if (!silent && keyword !== "stop" && session.core) {
    await session.core.expirePassedTourTimeRequests();
  }

  const outboundBefore = (await session.store.list("messages")).filter((m) => m.audience === "PROSPECT" && m.direction === "OUTBOUND").length;

  if (session.kind === "messaging" && session.smsConsentMode !== "disabled" && session.smsConsent !== "opted_in") {
    await photoAck.send();
    await handleSmsGate(session, said, text);
    return undefined;
  }

  // After-close handling stays on the expired tour while the leaving issue is
  // open. A held booking is not promoted until that window ends.
  if (!isLeavingTour(stripFiller(normalize(text))) && !(await session.afterCloseStillOpen())) {
    await session.promotePendingBookingIfTourEnded();
  }

  const stage = await session.stage();
  const pending = session.takeExpected(stage);
  const awaiting = pending?.kind === "which-unit" ? pending.resume : pending;

  // "Which unit do you mean?" was asked for a question: a reply naming one answers that question, then the step resumes.
  if (pending?.kind === "which-unit" && !keyword) {
    const unit = unitFromReply(session, text, pending.units);
    if (unit) {
      const interpretation: IntentInterpretation = { intent: { type: "ASK_PROPERTY_QUESTION", question: pending.question }, confidence: 1, interpreter: "rules", clarificationNeeded: false };
      session.noteInterpretation(interpretation);
      await session.recordText(said);
      const resolved = resolveQuestion(session.config, pending.question, { selectedUnitId: unit.id, pickedUnitId: unit.id });
      if (resolved.kind === "unknown") photoAck.consume();
      else await photoAck.send();
      const endedPick = (stage === "done" || stage === "stopped") && !(await session.isPaused());
      const out = await session.askQuestion(pending.question, {
        meta,
        unitId: unit.id,
        alreadyRecorded: true,
        unknownReply: unknownAnswerReply({ hasMedia: photo && resolved.kind === "unknown", ended: endedPick, team: session.config.operator.name }),
        ...(endedPick ? { answerSuffix: TOUR_AGAIN_SUFFIX } : {}),
      });
      if (out.outcome !== "which-unit" && !endedPick) await resumeStep(session, stage, pending.resume);
      return interpretation;
    }
  }

  let interpretation = await interpreter.interpret(await contextFor(session, text, stage, awaiting));
  if (inbound.kind === "door") {
    const doorIntent = onTourDoorIntent(text, inbound.doors);
    if (doorIntent) interpretation = { intent: doorIntent, confidence: 1, interpreter: "rules", clarificationNeeded: false };
  }
  const note = session.noteInterpretation(interpretation);
  const turn = new Turn(session, said, stage, interpretation, note, awaiting);
  const { intent } = interpretation;
  const ended = (stage === "done" || stage === "stopped") && !(await session.isPaused());
  if (awaiting?.kind !== "confirm-cancel-tour" && (await willSendCombinedUnknown(session, intent, stage, ended, firstMessage))) {
    photoAck.consume();
  } else {
    await photoAck.send();
    turn.photoLineSent = photo && !!typed && !silent;
  }

  if (intent.type === "START_MESSAGES" && turn.confident) await session.optIn(said);
  else if (await handleOverstayReply(turn)) {
    /* T-15 / T-5 / more-time / DONE / after-close / rebook after no-time */
  } else if (await handlePostTourDistress(turn)) {
    /* after DONE + follow-up, locked-in and other distress alert like +15 */
  } else if (await handlePendingRebookPick(turn)) {
    /* day/time for a secondary rebook; tour commands already won above */
  } else if (await handleProposedTimeReply(turn)) {
    /* outstanding operator proposal wins over held-booking consent */
  } else if (await handlePendingBookingReply(turn)) {
    /* consent / verification for a booking held while the current tour runs */
  } else if (await takeOverHeldBookingOnGreeting(turn)) {
    /* after the tour ends, HI continues the held booking with booked-for then consent */
  } else if (inbound.kind !== "door" && (await handleCancelIntent(turn))) {
    /* cancel-by-text: confirm, YES, or NO; or stop when nothing is booked */
  } else if (await handleMyTourOrDirections(turn)) {
    /* "when is my tour?" and "where is it?", answered from the booking and the address */
  } else if (await handleRescheduleIntent(turn)) {
    /* "can I change the time?": the open times, then a pick moves the booking */
  } else if (await handleOpenTimesIntent(turn)) {
    /* "what times do you have?": the open tour times, then back to the step */
  } else if (await resumeClearedScheduling(turn)) {
    /* the text after an unbooked cancel starts scheduling again */
  } else if (firstMessage) {
    if (await openBareTodayOrTonight(turn)) {
      /* today's remaining times, from the hours that are saved */
    } else if (intent.type === "SELECT_UNIT" && turn.confident) await chooseUnit(turn);
    else if (intent.type === "REQUEST_CUSTOM_TIME" && turn.confident) await openWithCustomTime(turn);
    else if (intent.type === "ASK_PROPERTY_QUESTION") await ask(turn, intent.question, () => session.welcome());
    else await session.greet(said);
  }   else await byStage(turn);
  if (
    awaiting?.kind === "confirm-cancel-tour" &&
    doorAskSupersedesCancel(intent) &&
    !session.pendingClarification
  ) {
    session.expect(stage, awaiting);
  }
  if (session.overstay) await session.overstay.tickSession(session);
  if (keyword !== "stop" && !silent && typed) {
    const outboundAfter = (await session.store.list("messages")).filter((m) => m.audience === "PROSPECT" && m.direction === "OUTBOUND").length;
    if (outboundAfter === outboundBefore) await session.reply(SORRY);
  }
  return interpretation;
}

async function handleOperatorScheduledReply(session: VisitorDemoSession, said: Said, text: string): Promise<void> {
  const keyword = messagingKeyword(text);
  if (keyword === "stop") {
    session.takeExpected(await session.stage());
    await session.optOut(said);
    return;
  }
  if (keyword === "help") {
    await session.help(said);
    return;
  }
  const normalized = normalize(text);
  if (normalized === "yes" || /^(yeah|yep|sure|ok|okay)$/.test(normalized)) {
    session.takeExpected(await session.stage());
    await session.recordText(said);
    await session.allowMessagingAgain();
    session.noteSmsConsent("opted_in", "YES");
    await session.confirmOperatorSchedule();
    return;
  }
  if (normalized === "no" || /^(nope|nah)$/.test(normalized)) {
    session.takeExpected(await session.stage());
    await session.recordText(said);
    await session.declineOperatorSchedule();
    return;
  }
  if (isBareMenuNumber(text)) {
    await session.recordText(said);
    await session.reply(OPERATOR_SCHEDULE_CONFIRM_PROMPT);
    return;
  }
  await session.flagQuestionWhileAwaitingConfirm(said);
}

/**
 * Keyword campaign gate. Property questions, availability, and booking stay
 * closed until the sender replies YES to the disclosure. That YES is also
 * enough to keep a record of the visit; booking does not ask again.
 */
async function handleSmsGate(session: VisitorDemoSession, said: Said, text: string): Promise<void> {
  const keyword = messagingKeyword(text);
  // Bare cancel told them START books again. A plain STOP still needs YES.
  if (keyword === "start" && session.consentRestoresOnStart) {
    session.consentRestoresOnStart = false;
    session.bindNextBooking = true;
    await session.optIn(said);
    session.noteSmsConsent("opted_in", "START");
    return;
  }
  const normalized = normalize(text);
  // A yes with no campaign record is the disclosure, not an opt-in. Draft START does not leave a pending record.
  const freshYes = !session.smsConsent && isFlexibleYes(normalized);
  if (keyword === "start" || normalized === "tour" || said.meta?.countsAsOptIn || freshYes) {
    await session.recordText(said);
    await session.allowMessagingAgain();
    session.noteSmsConsent("pending", keyword === "start" ? "START" : freshYes ? "YES" : "TOUR");
    await session.reply(smsDisclosure(session.complianceBaseUrl?.()), undefined, { deliverDespiteOptOut: true });
    return;
  }
  if (session.smsConsent === "pending" && isFlexibleYes(normalized)) {
    await session.recordText(said);
    await session.allowMessagingAgain();
    session.noteSmsConsent("opted_in", "YES");
    await session.reply(smsOptInConfirmation(), undefined, { deliverDespiteOptOut: true });
    const leftover = consentRemainder(text);
    if (leftover && /\bsooner\b/.test(normalize(leftover))) {
      await session.refreshOfferedSchedule();
      const labels = session.offeredDates.map((day) => day.label);
      if (labels.length) {
        session.markDatesShown();
        await session.reply(DAY_MENU, { kind: "choose", options: labels, what: "a day" });
        return;
      }
    }
    if (!(await session.reservation())) await session.welcome();
    return;
  }
  await session.recordText(said);
  if (session.smsConsent === "opted_out" || session.optedOut) return;
  await session.reply(session.smsConsent === "pending" ? SMS_GATE_REMINDER : SMS_KEYWORD_PROMPT, undefined, { deliverDespiteOptOut: true });
}

/** The unit a short reply points at, among the ones offered: its name ("1A") or its number in the list ("2"). */
function unitFromReply(session: VisitorDemoSession, text: string, offered: string[]) {
  const units = session.config.units.filter((u) => offered.includes(u.name));
  const named = unitsNamedIn(text, units);
  if (named.length === 1) return units.find((u) => u.id === named[0]!.id);
  const n = /^\s*(?:#|number |option )?(\d{1,2})\s*[.!]?\s*$/i.exec(text)?.[1];
  const pick = n ? offered[Number(n) - 1] : undefined;
  return pick ? units.find((u) => u.name === pick) : undefined;
}

function unknownReplyFor(turn: Turn, ended = false): string {
  return unknownAnswerReply({ hasMedia: !!turn.said.meta?.hasMedia && !turn.photoLineSent, ended, team: turn.session.config.operator.name });
}

/** True when this turn will send a combined unknown-question text instead of the short photo line. */
async function willSendCombinedUnknown(
  session: VisitorDemoSession,
  intent: TourIntent,
  stage: VisitorStage,
  ended: boolean,
  firstMessage: boolean,
): Promise<boolean> {
  if (intent.type !== "ASK_PROPERTY_QUESTION") return false;
  if (stage === "intro" && !firstMessage) return false;
  if ((stage === "stopped" || stage === "done") && !ended) return false;
  const r = await session.reservation();
  return resolveQuestion(session.config, intent.question, { selectedUnitId: r?.unitId }).kind === "unknown";
}

/** Ended tour: answer from approved facts first; flag only when there is no answer. */
async function handleEndedQuestion(turn: Turn): Promise<void> {
  const question = turn.intent.type === "ASK_PROPERTY_QUESTION" ? turn.intent.question : (turn.said.text ?? "");
  await turn.session.recordText(turn.said);
  const r = await turn.session.reservation();
  const resolved = resolveQuestion(turn.session.config, question, { selectedUnitId: r?.unitId });
  if (resolved.kind === "unknown") {
    await turn.session.flagUnknownQuestion(turn.said, { reply: unknownReplyFor(turn, true), alreadyRecorded: true });
    return;
  }
  const out = await turn.session.askQuestion(question, {
    meta: turn.said.meta,
    alreadyRecorded: true,
    unknownReply: unknownReplyFor(turn, true),
    answerSuffix: TOUR_AGAIN_SUFFIX,
  });
  if (out.outcome === "which-unit") {
    const units = out.units ?? [];
    turn.markClarification();
    turn.session.expect(turn.stage, { kind: "which-unit", question, units, ...(turn.awaiting ? { resume: turn.awaiting } : {}) });
    await turn.session.reply(`Which unit do you mean: ${orList(units)}?`, { kind: "choose", options: units, what: "a unit" });
  }
}

/** STOP'd visitors get no texts; an unanswerable question is still flagged. */
async function flagSilentOptedOutQuestion(
  session: VisitorDemoSession,
  said: Said,
  text: string,
  photo: boolean,
  interpreter: IntentInterpreter,
): Promise<void> {
  const stage = await session.stage();
  const interpretation = await interpreter.interpret(await contextFor(session, text, stage));
  session.noteInterpretation(interpretation);
  if (interpretation.intent.type !== "ASK_PROPERTY_QUESTION") {
    await session.recordText(said);
    return;
  }
  const ended = (stage === "done" || stage === "stopped") && !(await session.isPaused());
  const r = await session.reservation();
  const resolved = resolveQuestion(session.config, interpretation.intent.question, { selectedUnitId: r?.unitId });
  if (resolved.kind === "unknown") {
    await session.flagUnknownQuestion(said, { reply: unknownAnswerReply({ hasMedia: photo, ended, team: session.config.operator.name }) });
    return;
  }
  await session.recordText(said);
}

/**
 * A property question, at any step. It's answered from approved facts only
 * (or flagged for the team), then the visitor is shown exactly where they
 * were: the same menu, the same offered times, the same pending
 * confirmation. Nothing about the booking changes.
 */
async function ask(turn: Turn, question: string, resume?: () => Promise<void>): Promise<void> {
  if (await openBareTodayOrTonight(turn)) return;
  const { session } = turn;
  await session.recordText(turn.said);
  const out = await session.askQuestion(question, {
    meta: turn.said.meta,
    alreadyRecorded: true,
    unknownReply: unknownReplyFor(turn),
  });
  if (turn.interpretation.mentionedTime && out.outcome !== "which-unit") {
    await confirmMentionedTime(turn, turn.interpretation.mentionedTime);
    return;
  }
  if (turn.interpretation.mentionedDate && out.outcome !== "which-unit") {
    await showAskedDay(turn, turn.interpretation.mentionedDate, true);
    return;
  }
  if (out.outcome === "which-unit") {
    const units = out.units ?? [];
    turn.markClarification();
    session.expect(turn.stage, { kind: "which-unit", question, units, ...(turn.awaiting ? { resume: turn.awaiting } : {}) });
    await session.reply(`Which unit do you mean: ${orList(units)}?`, { kind: "choose", options: units, what: "a unit" });
    return;
  }
  if (resume) await resume();
  else await resumeStep(session, turn.stage, turn.awaiting, out.fairHousing ? { repeatLiveMenu: true } : undefined);
}

const listOf = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

async function contextDay(session: VisitorDemoSession): Promise<LocalDate | undefined> {
  const reservation = await session.reservation();
  const tz = session.config.property.timezone;
  if (reservation?.slotStart) return localDateOf(new Date(reservation.slotStart), tz);
  if (session.selectedDate) return parseIsoDate(session.selectedDate);
  const offered = session.offeredSlots[0];
  return offered ? localDateOf(offered.start, tz) : undefined;
}

/** A new day named while a next-opening offer is pending — not an accept of that offer. */
function dayAskWhileOfferPending(turn: Turn): DayReference | undefined {
  const { intent } = turn;
  if (intent.type === "SELECT_DATE" && (intent.date || intent.weekday || intent.relative || intent.unclear)) return intent;
  if (intent.type === "REQUEST_CUSTOM_TIME") {
    if (intent.date) return { date: intent.date };
    if (intent.weekday) return { weekday: intent.weekday, ...(intent.nextWeek ? { nextWeek: true } : {}) };
    if (intent.day) return { relative: intent.day };
  }
  const today = localDateOf(turn.session.clock.now(), turn.session.config.property.timezone);
  const asked = dayReference(normalize(turn.said.text ?? ""), today);
  return asked && asked !== "menu" ? asked : undefined;
}

function asSpoken(intent: Extract<TourIntent, { type: "REQUEST_CUSTOM_TIME" }> | SpokenTime): SpokenTime {
  return {
    hour: intent.hour,
    minute: intent.minute,
    ...(intent.meridiem ? { meridiem: intent.meridiem } : {}),
    ...(intent.day ? { day: intent.day } : {}),
    ...("weekday" in intent && intent.weekday ? { weekday: intent.weekday } : {}),
    ...("nextWeek" in intent && intent.nextWeek ? { nextWeek: true } : {}),
    ...("date" in intent && intent.date ? { date: intent.date } : {}),
  };
}

function meridiemOf(session: VisitorDemoSession, start: Date): "AM" | "PM" {
  return zonedParts(start, session.config.property.timezone).hour >= 12 ? "PM" : "AM";
}

/** Files a custom-time request, or books a regular slot when that's what they named. */
async function fileCustomTime(turn: Turn, spoken: SpokenTime, alreadyRecorded = false): Promise<void> {
  const { session } = turn;
  const resolved = resolveSpokenTime(session.config, session.clock.now(), spoken, await contextDay(session));
  if (!resolved.ok) {
    const awaiting = { kind: "confirm-custom-time" as const, hour: spoken.hour, minute: spoken.minute, ...(spoken.day ? { day: spoken.day } : {}) };
    if (alreadyRecorded) {
      turn.markClarification();
      session.expect(await session.stage(), awaiting);
      await session.reply(resolved.ask);
    } else await turn.clarify(resolved.ask, undefined, awaiting);
    return;
  }
  const reservation = await session.reservation();
  if (resolved.placement === "ON_GRID") {
    if (reservation?.status === "TOURING") {
      if (!alreadyRecorded) await session.recordText(turn.said);
      await session.confirmRebook(resolved.start.toISOString());
      return;
    }
    if (reservation) {
      if (!alreadyRecorded) await session.recordText(turn.said);
      if (await session.bookOffered(resolved.start.toISOString())) return;
      alreadyRecorded = true;
    }
  }
  if (!reservation) {
    session.holdTime(spoken);
    const menu: ReplyPrompt = { kind: "choose", options: session.offerableUnits().map((unit) => unit.name), what: "a unit" };
    const body = `${resolved.label} isn't one of the regular tour times. Which unit should I ask the ${visitorTeamName(session.config.operator.name)} about?`;
    if (alreadyRecorded) {
      turn.markClarification();
      await session.reply(body, menu);
    } else await turn.clarify(body, menu);
    return;
  }
  if (!alreadyRecorded) await session.recordText(turn.said);
  await session.requestCustomTime(resolved.start, turn.said.meta?.providerMessageId);
}

async function confirmMentionedTime(turn: Turn, spoken: SpokenTime): Promise<void> {
  const { session } = turn;
  const resolved = resolveSpokenTime(session.config, session.clock.now(), spoken, await contextDay(session));
  if (!resolved.ok) {
    session.expect(turn.stage, { kind: "confirm-custom-time", hour: spoken.hour, minute: spoken.minute, ...(spoken.day ? { day: spoken.day } : {}) });
    await session.reply(resolved.ask);
    return;
  }
  session.expect(turn.stage, {
    kind: "confirm-custom-time",
    hour: spoken.hour,
    minute: spoken.minute,
    meridiem: meridiemOf(session, resolved.start),
    ...(spoken.day ? { day: spoken.day } : {}),
  });
  await session.reply(`If you'd like ${resolved.label}, reply YES and I'll ask the ${visitorTeamName(session.config.operator.name)}.`, { kind: "yes-no" });
}

async function openWithCustomTime(turn: Turn): Promise<void> {
  if (turn.intent.type !== "REQUEST_CUSTOM_TIME") return;
  const spoken = asSpoken(turn.intent);
  await turn.session.recordText(turn.said);
  await turn.session.welcome();
  if (await turn.session.reservation()) await fileCustomTime(turn, spoken, true);
  else turn.session.holdTime(spoken);
}

/**
 * What Tour Core was asking before a question interrupted it, asked again
 * from the saved conversation (menus keep their numbering). During a booked
 * or running tour there's no menu to repeat, so only an open confirmation is
 * asked again.
 */
export async function resumeStep(
  session: VisitorDemoSession,
  stage?: VisitorStage,
  awaiting?: StepAwaiting,
  options?: { repeatLiveMenu?: boolean },
): Promise<void> {
  const now = await session.stage();
  // Called from outside a text (e.g. the operator answered later): repeat whatever confirmation is still open.
  const open = stage === undefined ? session.pendingClarification : undefined;
  const pending = open && open.stage === now && open.awaiting.kind !== "which-unit" ? open.awaiting : undefined;
  const p = stepPrompt(session, now, stage === undefined ? pending : stage === now ? awaiting : undefined);
  if (!p) return;
  if (p.awaiting) session.expect(now, p.awaiting);
  const menuAlreadyLive =
    (now === "choose-date" && session.dateMenuLive && session.lastShownDates.length > 0) ||
    (now === "choose-time" && session.slotMenuLive && session.lastShownSlots.length > 0);
  if (now === "choose-date") session.markDatesShown();
  if (now === "choose-time") session.markTimesShown();
  if (menuAlreadyLive && !options?.repeatLiveMenu) return;
  await session.reply(p.body, p.prompt);
}

function stepPrompt(session: VisitorDemoSession, stage: VisitorStage, awaiting?: StepAwaiting): { body: string; prompt?: ReplyPrompt; awaiting?: StepAwaiting } | undefined {
  const yesNo: ReplyPrompt = { kind: "yes-no" };
  switch (awaiting?.kind) {
    case "confirm-arrival":
      return { body: "Are you at the property now?", prompt: yesNo, awaiting };
    case "confirm-stop":
      return { body: `Are you at ${awaiting.stop.label} now?`, prompt: yesNo, awaiting };
    case "choose-stop":
      return { body: `Which door are you at: ${awaiting.stops.map((s) => s.label).join(" or ")}?`, prompt: { kind: "choose", options: awaiting.stops.map((s) => s.label), what: "a door" }, awaiting };
    case "confirm-finish":
      return { body: "Are you finished with your tour?", prompt: yesNo, awaiting };
    case "confirm-cancel-tour":
      return {
        body: awaiting.namedRunning
          ? cannotCancelRunningOfferLater(awaiting.time, awaiting.day, awaiting.team)
          : awaiting.laterWhileTouring
            ? laterCancelConfirm(awaiting.time, awaiting.day)
            : visitorCancelConfirm(awaiting.day, awaiting.time),
        awaiting,
      };
  }
  switch (stage) {
    case "choose-unit":
      return { body: "Which unit would you like to see?", prompt: { kind: "choose", options: session.offerableUnits().map((u) => u.name), what: "a unit" } };
    case "choose-date": {
      const labels = session.offeredDates.map((day) => day.label);
      if (!labels.length) return undefined;
      return { body: "I have tours available. Which day works for you?", prompt: { kind: "choose", options: labels, what: "a day" } };
    }
    case "choose-time": {
      const labels = session.offeredSlots.map((s) => s.label);
      if (!labels.length) return undefined;
      const day = session.selectedDate ? formatDay(session.offeredSlots[0]!.start, session.config.property.timezone) : formatDay(session.offeredSlots[0]!.start, session.config.property.timezone);
      return timeMenu(day, labels);
    }
    case "identity":
      return { body: "Your identity form is in my earlier message. Once it's filled out, I'll confirm your tour." };
    case "follow-up":
      return { body: followUpQuestion(session), prompt: yesNo };
    default:
      return undefined;
  }
}

function followUpQuestion(session: VisitorDemoSession): string {
  return renderSms("follow-up-question", { team: visitorTeamName(session.config.operator.name) }).body;
}

/** Pause-cancel team label, only on hold or a door-system problem. */
function runningCancelTeam(session: VisitorDemoSession, status?: string): string | undefined {
  return status === "OPERATOR_HOLD" || status === "PROVIDER_FAILURE" ? visitorTeamName(session.config.operator.name) : undefined;
}

async function offerCancelConfirm(turn: Turn): Promise<void> {
  const target = await turn.session.cancelTarget();
  const line = target ? turn.session.cancelConfirmLine(target.reservation, target.laterWhileTouring) : undefined;
  if (!line || !target?.reservation.slotStart) {
    await turn.session.reportCancelFailed(turn.said);
    return;
  }
  const start = new Date(target.reservation.slotStart);
  const current = await turn.session.reservation();
  const zone = bookedClockZone(turn.session.config.property.timezone, current ?? target.reservation);
  if (!zone) {
    await turn.session.reportCancelFailed(turn.said);
    return;
  }
  const day = formatDay(start, zone);
  const time = formatTime(start, zone);
  const namedRunning =
    target.laterWhileTouring &&
    namedCancelFocus({
      text: turn.said.text ?? "",
      current,
      later: await turn.session.pendingBooking(),
      timeZone: zone,
      now: turn.session.clock.now(),
    }) === "running";
  const team = runningCancelTeam(turn.session, current?.status);
  await turn.clarify(namedRunning ? cannotCancelRunningOfferLater(time, day, team) : line, undefined, {
    kind: "confirm-cancel-tour",
    day,
    time,
    ...(target.laterWhileTouring ? { laterWhileTouring: true } : {}),
    ...(namedRunning ? { namedRunning: true } : {}),
    ...(namedRunning && team ? { team } : {}),
  });
}

/**
 * Booked-tour cancel-by-text. Confirm first; never send the unanswered-
 * question fallback for a clear cancel ask.
 */
/** "When is my tour?" from the booking; "where is it?" with the address and the directions link. */
async function handleMyTourOrDirections(turn: Turn): Promise<boolean> {
  const { session, intent } = turn;
  if ((intent.type !== "ASK_MY_TOUR" && intent.type !== "ASK_DIRECTIONS") || !turn.confident) return false;
  const property = session.config.property;
  const send = async (sms: { templateId: string; body: string }) => session.reply(sms.body, undefined, { templateId: sms.templateId });
  if (intent.type === "ASK_MY_TOUR") {
    const r = await session.reservation();
    if (!visitorBookingConfirmed(r) || !r?.slotStart || !r.windowStart || !r.windowEnd) {
      await send(renderSms("no-tour-booked"));
      return true;
    }
    const tz = property.timezone;
    const start = new Date(r.slotStart);
    await send(renderSms("my-tour", { time: formatTime(start, tz), day: formatDay(start, tz), start: formatTime(new Date(r.windowStart), tz), end: formatTime(new Date(r.windowEnd), tz), address: property.address }));
    return true;
  }
  await send(renderSms("property-address", { address: property.address }));
  const url = propertyDirectionsUrl(property);
  if (url) await send(renderSms("tour-directions", { url }));
  return true;
}

/** The times a booked visitor can move to, for one weekday when named, at most six. */
async function rescheduleChoices(session: VisitorDemoSession, weekday?: string): Promise<{ start: Date; line: string }[]> {
  const tz = session.config.property.timezone;
  const slots = await session.rescheduleOptions();
  const named = weekday ? slots.filter((s) => formatDay(s.start, tz).startsWith(WEEKDAY_NAMES[weekday]!)) : [];
  return (named.length ? named : slots).slice(0, 6).map((s) => ({ start: s.start, line: `${formatDay(s.start, tz)} at ${s.label}` }));
}

function numbered(choices: { line: string }[]): string {
  return choices.map((c, i) => `${i + 1}) ${c.line}`).join("\n");
}

/** Offers the times, and waits for the visitor's pick. */
async function offerReschedule(turn: Turn, template: "reschedule-offer" | "reschedule-taken", weekday?: string): Promise<void> {
  const { session } = turn;
  const choices = await rescheduleChoices(session, weekday);
  if (!choices.length) {
    const sms = renderSms("reschedule-none");
    await session.reply(sms.body, undefined, { templateId: sms.templateId });
    return;
  }
  const sms = renderSms(template, { options: numbered(choices) });
  await session.reply(sms.body, undefined, { templateId: sms.templateId });
  session.expect(await session.stage(), { kind: "reschedule-pick", slots: choices.map((c) => c.start.toISOString()) });
}

/**
 * A booked visitor moving their tour: "can I change the time?" offers the open times, and a number picks
 * one. The booking moves only once the new time is taken; a time someone just took offers the rest.
 */
async function handleRescheduleIntent(turn: Turn): Promise<boolean> {
  const { session, intent, awaiting } = turn;
  if (awaiting?.kind === "reschedule-pick") {
    const n = Number(/^\s*#?\s*(\d{1,2})\s*[.)]?\s*$/.exec(turn.said.text ?? "")?.[1]);
    const picked = Number.isInteger(n) ? awaiting.slots[n - 1] : undefined;
    if (picked) {
      let changed = false;
      try {
        ({ changed } = await session.reschedule(picked, { notice: "moved" }));
      } catch {
        changed = false;
      }
      if (!changed) await offerReschedule(turn, "reschedule-taken");
      return true;
    }
  }
  if (intent.type !== "RESCHEDULE_TOUR" || !turn.confident) return false;
  if (!visitorBookingConfirmed(await session.reservation())) return false;
  await offerReschedule(turn, "reschedule-offer", intent.weekday);
  return true;
}

const WEEKDAY_NAMES: Record<string, string> = { SUN: "Sunday", MON: "Monday", TUE: "Tuesday", WED: "Wednesday", THU: "Thursday", FRI: "Friday", SAT: "Saturday" };

/**
 * The open tour times: the next few days with openings, or the named weekday's times. A booked
 * visitor's tour stays as it is. Afterwards the visitor is back on the step they were on.
 */
async function handleOpenTimesIntent(turn: Turn): Promise<boolean> {
  const { session, intent } = turn;
  if (intent.type !== "ASK_OPEN_TIMES" || !turn.confident) return false;
  const days = await session.core.availableDates(intent.weekday ? 14 : 3);
  const named = intent.weekday ? days.filter((d) => d.label.startsWith(WEEKDAY_NAMES[intent.weekday!]!)).slice(0, 1) : [];
  // A named day with nothing open falls back to the next open days.
  const shown = intent.weekday && named.length ? named : days.slice(0, 3);
  const lines: string[] = [];
  for (const day of shown) {
    const [year, month, date] = day.date.split("-").map(Number) as [number, number, number];
    const slots = await session.core.availableSlots({ year, month, day: date });
    if (slots.length) lines.push(`${day.label}: ${slots.map((s) => s.label).join(", ")}`);
  }
  const booked = visitorBookingConfirmed(await session.reservation());
  const times = lines.join("\n");
  const sms = !lines.length
    ? renderSms("open-times-none")
    : intent.weekday && !named.length
      ? renderSms("open-times-other-day", { day: WEEKDAY_NAMES[intent.weekday], times })
      : renderSms(booked ? "open-times-booked" : "open-times", { times });
  await session.reply(sms.body, undefined, { templateId: sms.templateId });
  if (!booked) await resumeStep(session, turn.stage, turn.awaiting, { repeatLiveMenu: true });
  return true;
}

async function handleCancelIntent(turn: Turn): Promise<boolean> {
  const { session, intent } = turn;
  const text = turn.said.text ?? "";
  const cancelable = await session.hasCancelableTour();
  const cancelAsk = intent.type === "CANCEL_TOUR" || intent.type === "CONFIRM_CANCEL_TOUR" || isCancelTourAsk(text);
  const awaiting = turn.awaiting?.kind === "confirm-cancel-tour" ? turn.awaiting : undefined;

  if (awaiting && doorAskSupersedesCancel(intent)) return false;
  if (awaiting && intent.type === "KEEP_TOUR" && turn.confident) {
    await turn.respond(visitorCancelKeptFor(awaiting.day, awaiting.time, awaiting.laterWhileTouring));
    return true;
  }
  if (awaiting && intent.type === "CONFIRM_CANCEL_TOUR" && turn.confident) {
    await session.cancelBookedTour(turn.said, awaiting.laterWhileTouring);
    return true;
  }
  if (awaiting && cancelAsk && intent.type !== "ASK_PROPERTY_QUESTION" && intent.type !== "REQUEST_HELP") {
    await session.cancelBookedTour(turn.said, awaiting.laterWhileTouring);
    return true;
  }
  if (awaiting && intent.type !== "REQUEST_HELP") {
    await session.flagQuestionWhileAwaitingConfirm(turn.said);
    session.expect(turn.stage, awaiting);
    return true;
  }
  if (cancelAsk && cancelable) {
    await offerCancelConfirm(turn);
    return true;
  }
  if (cancelAsk && !cancelable) {
    const current = await session.reservation();
    if (current && isRunningReservation(current.status)) {
      await turn.respond(cannotCancelRunningTour(runningCancelTeam(turn.session, current.status)));
      return true;
    }
  }
  if (!cancelable && isUnbookedCancelAsk(text) && (await inUnbookedScheduling(session, turn.stage))) {
    session.clearUnbookedSchedule();
    await turn.respond(NOTHING_BOOKED_CANCEL);
    return true;
  }
  if (intent.type === "CANCEL_TOUR" && !cancelable) {
    await session.reportCancelFailed(turn.said);
    return true;
  }
  return false;
}

/** Day menu, time menu, or unit menu, and no tour is booked. */
async function inUnbookedScheduling(session: VisitorDemoSession, stage: VisitorStage): Promise<boolean> {
  if (stage !== "choose-unit" && stage !== "choose-date" && stage !== "choose-time") return false;
  const current = await session.reservation();
  if (!current) return true;
  return current.status === "INQUIRY" && !current.slotStart;
}

async function chooseUnit(turn: Turn): Promise<void> {
  const units = turn.session.config.units;
  const unit = turn.intent.type === "SELECT_UNIT" ? units.find((u) => same(u.name, (turn.intent as { unitName: string }).unitName)) : undefined;
  const menu: ReplyPrompt = { kind: "choose", options: turn.session.offerableUnits().map((u) => u.name), what: "a unit" };
  if (unit && turn.confident) {
    await turn.act("chooseUnit", { unitId: unit.id });
    const held = turn.session.takeHeldTime();
    if (held) await fileCustomTime(turn, held, true);
    return;
  }
  const names = units.map((u) => u.name);
  const which = names.length === 2 ? `did you mean ${names[0]} or ${names[1]}?` : "which unit did you mean?";
  return turn.clarify(`Sure — ${which}`, menu);
}

function dayOnOrAfter(start: LocalDate, weekday: NonNullable<DayReference["weekday"]>): LocalDate {
  let day = start;
  for (let i = 0; i < 14; i++) {
    if (weekdayOf(day) === weekday) return day;
    day = addDays(day, 1);
  }
  return start;
}

async function showAskedDay(turn: Turn, ask: DayReference, alreadyRecorded = false): Promise<void> {
  const { session } = turn;
  const today = localDateOf(session.clock.now(), session.config.property.timezone);
  if (dayAskExcluded(ask, turn.said.text ?? "", today)) {
    await offerOpenDays(turn, excludedDays(turn.said.text ?? ""));
    return;
  }
  const dates = session.offeredDates;
  const dateMenu = { kind: "choose" as const, options: dates.map((day) => day.label), what: "a day" };
  if (ask.date) {
    await presentDay(turn, isoDate(ask.date), alreadyRecorded);
    return;
  }
  if (ask.unclear) {
    if (!alreadyRecorded) await session.recordText(turn.said);
    session.markDatesShown();
    await session.reply("I couldn't tell which day you meant. Which day works for you?", dateMenu);
    return;
  }
  if (!ask.weekday && !ask.relative) {
    const index = /^\s*(?:#|number |option )?(\d{1,2})\s*[.!]?\s*$/i.exec(turn.said.text ?? "")?.[1];
    const menu = session.lastShownDates;
    const picked = index && menu.length ? menu[Number(index) - 1] : undefined;
    if (picked) return presentDay(turn, picked.date, alreadyRecorded);
    session.markDatesShown();
    if (alreadyRecorded) await session.reply(DAY_MENU, dateMenu);
    else await turn.respond(DAY_MENU, dateMenu);
    return;
  }
  if (ask.relative === "weekend") {
    const weekend = dates.filter((day) => {
      const local = parseIsoDate(day.date);
      const name = local ? weekdayOf(local) : undefined;
      return name === "SAT" || name === "SUN";
    });
    if (!alreadyRecorded) await session.recordText(turn.said);
    if (weekend.length === 1) return presentDay(turn, weekend[0]!.date, true);
    const options = (weekend.length ? weekend : dates).map((day) => day.label);
    const lead = weekend.length ? DAY_MENU : "I don't have weekend tours, but weekdays are open. Which day works for you?";
    session.markDatesShown();
    await session.reply(lead, { kind: "choose", options, what: "a day" });
    return;
  }
  const start = ask.relative === "today" ? today : ask.relative === "tomorrow" || ask.nextWeek ? addDays(today, 1) : today;
  const day = ask.weekday ? dayOnOrAfter(start, ask.weekday) : start;
  await presentDay(turn, isoDate(day), alreadyRecorded);
}

/** Offer remaining regular days, skipping any the visitor ruled out. */
async function offerOpenDays(turn: Turn, excluded: Set<string>): Promise<void> {
  const { session } = turn;
  await session.refreshOfferedSchedule();
  const tz = session.config.property.timezone;
  const today = localDateOf(session.clock.now(), tz);
  const dates = session.offeredDates.filter((day) => {
    const local = parseIsoDate(day.date);
    if (!local) return true;
    const wd = weekdayOf(local);
    if (excluded.has(wd)) return false;
    if (excluded.has("today") && sameLocalDay(local, today)) return false;
    if (excluded.has("tomorrow") && sameLocalDay(local, addDays(today, 1))) return false;
    return true;
  });
  session.offeredDates = dates;
  session.selectedDate = undefined;
  session.offeredSlots = [];
  session.markDatesShown();
  const labels = dates.map((day) => day.label);
  if (!labels.length) {
    await turn.respond(VisitorDenialCopy.noOpenTimes(session.config.operator.name));
    return;
  }
  await turn.respond(DAY_MENU, { kind: "choose", options: labels, what: "a day" });
}

/** START_INQUIRY during booking: keep the unit, offer days again from the current schedule. */
async function restartBookingDays(turn: Turn, alreadyRecorded = false): Promise<void> {
  const { session } = turn;
  session.selectedDate = undefined;
  await session.refreshOfferedSchedule();
  const labels = session.offeredDates.map((day) => day.label);
  const menu = { kind: "choose" as const, options: labels, what: "a day" };
  if (!labels.length) {
    const line = VisitorDenialCopy.noOpenTimes(session.config.operator.name);
    if (alreadyRecorded) await session.reply(line);
    else await turn.respond(line);
    return;
  }
  session.markDatesShown();
  if (alreadyRecorded) await session.reply(DAY_MENU, menu);
  else await turn.respond(DAY_MENU, menu);
}

/** After an unbooked cancel, show the day list again, or the welcome when no unit is chosen yet. */
async function restartScheduling(turn: Turn, alreadyRecorded = false): Promise<void> {
  const reservation = await turn.session.reservation();
  if (reservation?.status === "INQUIRY") {
    await restartBookingDays(turn, alreadyRecorded);
    return;
  }
  if (alreadyRecorded) await turn.session.welcome();
  else await turn.session.greet(turn.said);
}

/**
 * The text after "nothing's booked, I'll stop here." Any text starts
 * scheduling again. A named day or time is used. A bare menu number is not.
 */
async function resumeClearedScheduling(turn: Turn): Promise<boolean> {
  const { session, intent } = turn;
  if (!session.schedulingIdle) return false;
  const reservation = await session.reservation();
  const open = !reservation || (reservation.status === "INQUIRY" && !reservation.slotStart);
  if (!open) {
    session.schedulingIdle = false;
    return false;
  }
  session.schedulingIdle = false;
  if (intent.type === "SELECT_DATE" && (intent.weekday || intent.relative || intent.date) && reservation?.status === "INQUIRY") {
    await session.refreshOfferedSchedule();
    await showAskedDay(turn, intent);
    return true;
  }
  if (intent.type === "REQUEST_CUSTOM_TIME" && turn.confident && reservation?.status === "INQUIRY") {
    await fileCustomTime(turn, asSpoken(intent));
    return true;
  }
  if (intent.type === "ASK_PROPERTY_QUESTION") {
    await ask(turn, intent.question, () => restartScheduling(turn, true));
    return true;
  }
  await restartScheduling(turn);
  return true;
}

function isBareMenuNumber(text: string): boolean {
  return MENU_NUMBER.test(text);
}

/** Day name, or a number/time from a menu the visitor actually saw. */
async function isShownMenuBookingInput(turn: Turn): Promise<boolean> {
  const { session, intent } = turn;
  const text = turn.said.text ?? "";
  if (intent.type === "SELECT_DATE") {
    if (intent.date || intent.weekday || intent.relative) return true;
    const index = MENU_NUMBER.exec(text)?.[1];
    return !!(index && session.lastShownDates[Number(index) - 1]);
  }
  if (intent.type === "SELECT_TIME") {
    return session.lastShownSlots.some((slot) => same(slot.label, intent.timeLabel));
  }
  if (isBareMenuNumber(text)) {
    if (session.selectedDate && session.lastShownSlots.length) {
      const index = MENU_NUMBER.exec(text)?.[1];
      return !!(index && session.lastShownSlots[Number(index) - 1]);
    }
    const index = MENU_NUMBER.exec(text)?.[1];
    return !!(index && session.lastShownDates[Number(index) - 1]);
  }
  return false;
}

/** A day name, shown time, or menu number from a leftover slot/day menu. */
async function tryShownSlotPick(turn: Turn, book: (slotStart: string) => Promise<void>): Promise<boolean> {
  const { session } = turn;
  const text = turn.said.text ?? "";
  if (isBareLaterOrEarlier(text)) return false;
  const step: VisitorStage = session.selectedDate && session.lastShownSlots.length ? "choose-time" : "choose-date";
  const interpretation = await rulesOnly.interpret(await contextFor(session, text, step));
  const intent = interpretation.intent;
  if (intent.type === "SELECT_DATE" && (intent.date || intent.weekday || intent.relative)) {
    const today = localDateOf(session.clock.now(), session.config.property.timezone);
    if (dayAskExcluded(intent, text, today)) return false;
    await showAskedDay(turn, intent);
    return true;
  }
  const slotsLive = session.slotMenuLive && session.lastShownSlots.length > 0;
  const datesLive = session.dateMenuLive && session.lastShownDates.length > 0;
  if (intent.type === "SELECT_TIME" && slotsLive) {
    const slot =
      session.lastShownSlots.find((s) => same(s.label, intent.timeLabel)) ??
      session.offeredSlots.find((s) => same(s.label, intent.timeLabel));
    if (slot && isConfident(interpretation)) {
      await session.recordText(turn.said);
      await book(slot.start.toISOString());
      return true;
    }
  }
  if (isBareMenuNumber(text) && slotsLive) {
    const index = MENU_NUMBER.exec(text)?.[1];
    const slot = index ? session.lastShownSlots[Number(index) - 1] : undefined;
    if (slot) {
      await session.recordText(turn.said);
      await book(slot.start.toISOString());
      return true;
    }
  }
  if (isBareMenuNumber(text) && datesLive && !slotsLive) {
    await showAskedDay(turn, intent.type === "SELECT_DATE" ? intent : {});
    return true;
  }
  return false;
}

/**
 * A number from a menu shown after booking (a later time, or another day).
 * A leftover number from the menu that booked this slot resends the form instead.
 */
async function acceptShownBookingChange(turn: Turn): Promise<boolean> {
  const text = turn.said.text ?? "";
  if (!isBareMenuNumber(text)) return false;
  const { session } = turn;
  const current = await session.reservation();
  const shownOtherDay =
    session.slotMenuLive &&
    !!current?.slotStart &&
    session.lastShownSlots.length > 0 &&
    session.lastShownSlots.every((slot) => slot.start.toISOString() !== current.slotStart);
  const shownDaysOnly =
    session.dateMenuLive && session.lastShownDates.length > 0 && session.lastShownSlots.length === 0 && (await session.hasLiveRegularTour());
  if (!(shownOtherDay || shownDaysOnly)) return false;
  return tryRegularSlotFromConsent(turn);
}

/** A booked visitor can still move the time. This does not ask a second consent question. */
async function offerBookedTimeChange(turn: Turn): Promise<boolean> {
  const { session, intent } = turn;
  const text = turn.said.text ?? "";
  if (!hasExplicitChangeAsk(text)) return false;
  const named = requestedChangeDay(text);
  if (named) {
    await showAskedDay(turn, named);
    return true;
  }
  const shift = laterOrEarlierShift(text);
  if (shift === "later-in-week") {
    await offerRestOfWeek(turn);
    return true;
  }
  if (shift) {
    await offerSameDayShift(turn, shift);
    return true;
  }
  const spoken = spokenTimes(normalize(text));
  if (spoken.length === 1) {
    await fileCustomTime(turn, spoken[0]!);
    return true;
  }
  if (intent.type === "REQUEST_CUSTOM_TIME" && turn.confident) {
    await fileCustomTime(turn, asSpoken(intent));
    return true;
  }
  if (await tryRegularSlotFromConsent(turn)) return true;
  await offerOpenDays(turn, excludedDays(text));
  return true;
}

/** From a booked tour, a regular day or shown slot replaces that tour. */
async function tryRegularSlotFromConsent(turn: Turn): Promise<boolean> {
  return tryShownSlotPick(turn, (slotStart) => turn.session.bookOffered(slotStart).then(() => undefined));
}

async function offerSameDayShift(turn: Turn, direction: "later" | "earlier"): Promise<void> {
  const { session } = turn;
  await session.recordText(turn.said);
  const reservation = await session.reservation();
  const tz = session.config.property.timezone;
  const current = reservation?.slotStart ? new Date(reservation.slotStart) : undefined;
  const day = current ? localDateOf(current, tz) : localDateOf(session.clock.now(), tz);
  const open = await session.core.availableSlots(day);
  const filtered = current
    ? open.filter((slot) => (direction === "later" ? slot.start.getTime() > current.getTime() : slot.start.getTime() < current.getTime()))
    : open;
  if (!filtered.length) {
    await session.refreshOfferedSchedule();
    const labels = session.offeredDates.map((item) => item.label);
    session.markDatesShown();
    if (!labels.length) {
      await session.reply(VisitorDenialCopy.noOpenTimes(session.config.operator.name));
      return;
    }
    await session.reply(DAY_MENU, { kind: "choose", options: labels, what: "a day" });
    return;
  }
  session.offeredSlots = filtered;
  session.selectedDate = isoDate(day);
  session.markTimesShown();
  const menu = timeMenu(formatDay(filtered[0]!.start, tz), filtered.map((slot) => slot.label));
  await session.reply(menu.body, menu.prompt);
}

/** Remaining bookable days this calendar week, not today. */
async function offerRestOfWeek(turn: Turn): Promise<void> {
  const { session } = turn;
  await session.refreshOfferedSchedule();
  const tz = session.config.property.timezone;
  const today = localDateOf(session.clock.now(), tz);
  const remaining: Record<string, number> = { MON: 6, TUE: 5, WED: 4, THU: 3, FRI: 2, SAT: 1, SUN: 0 };
  const last = addDays(today, remaining[weekdayOf(today)] ?? 6);
  const dates = session.offeredDates.filter((day) => {
    const local = parseIsoDate(day.date);
    if (!local) return false;
    if (sameLocalDay(local, today)) return false;
    const t = Date.UTC(local.year, local.month - 1, local.day);
    const start = Date.UTC(today.year, today.month - 1, today.day);
    const end = Date.UTC(last.year, last.month - 1, last.day);
    return t > start && t <= end;
  });
  if (!dates.length) {
    await offerOpenDays(turn, new Set(["today"]));
    return;
  }
  session.offeredDates = dates;
  session.selectedDate = undefined;
  session.offeredSlots = [];
  session.markDatesShown();
  await turn.respond(DAY_MENU, { kind: "choose", options: dates.map((day) => day.label), what: "a day" });
}

function matchesLabel(text: string, labels: string[]): boolean {
  return labels.some((label) => same(label, text));
}

async function showScheduleChanged(turn: Turn): Promise<void> {
  const { session } = turn;
  session.selectedDate = undefined;
  session.offeredSlots = [];
  await session.refreshOfferedSchedule();
  const labels = session.offeredDates.map((day) => day.label);
  if (!labels.length) {
    await turn.respond(VisitorDenialCopy.noOpenTimes(session.config.operator.name));
    return;
  }
  session.markDatesShown();
  await turn.respond(SCHEDULE_CHANGED_LEAD, { kind: "choose", options: labels, what: "a day", after: WHICH_DAY });
}

async function presentDay(turn: Turn, date: string, alreadyRecorded = false): Promise<void> {
  const { session } = turn;
  if (!alreadyRecorded) await session.recordText(turn.said);
  await offerDate(session, date);
}

/** Bare today or tonight, with hours saved, opens today's times and is not sent to the team. */
async function openBareTodayOrTonight(turn: Turn): Promise<boolean> {
  if (!isBareTodayOrTonight(turn.said.text ?? "")) return false;
  if (!savedTourHours(turn.session.config.tourHours)) return false;
  await showAskedDay(turn, { relative: "today" });
  return true;
}

/** A shown day or time already won in the pipeline. The word "help" in that text is not distress. */
function helpAheadOfMenu(turn: Turn): boolean {
  if (isSchedulingMenuAnswer(turn.stage, turn.intent.type)) return false;
  return mentionsAfterCloseDistress(turn.said.text ?? "") || turn.intent.type === "REQUEST_HELP";
}

async function byStage(turn: Turn): Promise<void> {
  const { session, intent } = turn;
  const yesNo: ReplyPrompt = { kind: "yes-no" };
  if (await openBareTodayOrTonight(turn)) return;
  if (turn.awaiting?.kind === "confirm-custom-time" && turn.interpretation.clarificationQuestion === "No problem.") {
    await turn.respond("No problem.");
    await resumeStep(session, turn.stage);
    return;
  }
  if (intent.type === "ACCEPT_PROPOSED_TIME" && turn.awaiting?.kind === "confirm-alternative" && turn.confident) {
    await session.recordText(turn.said);
    await session.acceptAlternative(turn.awaiting.requestId);
    return;
  }
  if (intent.type === "DECLINE_PROPOSED_TIME" && turn.awaiting?.kind === "confirm-alternative" && turn.confident) {
    await session.recordText(turn.said);
    await session.declineAlternative(turn.awaiting.requestId);
    return;
  }
  if (intent.type === "REQUEST_CUSTOM_TIME" && turn.confident) {
    const named = turn.awaiting?.kind === "accept-next-opening" ? dayAskWhileOfferPending(turn) : undefined;
    if (named) return showAskedDay(turn, named);
    return fileCustomTime(turn, asSpoken(intent));
  }
  if (
    intent.type === "ASK_PROPERTY_QUESTION" &&
    !hasExplicitChangeAsk(turn.said.text ?? "") &&
    turn.stage !== "stopped" &&
    turn.stage !== "done" &&
    turn.stage !== "intro"
  ) {
    return ask(turn, intent.question);
  }

  switch (turn.stage) {
    case "intro":
      return session.greet(turn.said);

    case "choose-unit": {
      const menu: ReplyPrompt = { kind: "choose", options: session.offerableUnits().map((u) => u.name), what: "a unit" };
      if (intent.type === "SELECT_DATE") return showAskedDay(turn, intent);
      if (intent.type === "SELECT_UNIT") return chooseUnit(turn);
      if (intent.type === "REQUEST_HELP") return session.help(turn.said);
      // After pause, welcome() may have sent the paused line without starting
      // an inquiry. Tour / Hi / book must restart like a first text: a home
      // gets the welcome and day list, not a leftover unit-picker fallthrough.
      if (intent.type === "START_INQUIRY") return session.greet(turn.said);
      if (turn.interpretation.clarificationNeeded && !turn.interpretation.manipulation) return chooseUnit(turn);
      return turn.fallback(`${SORRY} Which unit would you like to see?`, menu);
    }

    case "choose-date": {
      const pendingDateRequest = await session.unapprovedCustomTimeRequest();
      if (pendingDateRequest && !pendingDateRequest.pendingNoticeSentAt && !(await isShownMenuBookingInput(turn))) {
        await session.recordText(turn.said);
        await session.announceUnapprovedCustomTime();
        return;
      }
      if (turn.awaiting?.kind === "accept-next-opening") {
        const today = localDateOf(session.clock.now(), session.config.property.timezone);
        if (acceptsOfferedOpening(turn.said.text ?? "", today)) {
          return takeOfferedOpening(session, turn.awaiting, turn.said);
        }
      }
      if (helpAheadOfMenu(turn)) return session.help(turn.said);
      if (intent.type === "START_INQUIRY") return restartBookingDays(turn);
      if (session.staleDateMenu) {
        const text = turn.said.text ?? "";
        const still = session.offeredDates.find((day) => same(day.label, text) || day.date === text.trim());
        if (still) return presentDay(turn, still.date);
        if (isBareMenuNumber(text) || matchesLabel(text, session.lastShownDates.map((day) => day.label))) return showScheduleChanged(turn);
      }
      if (intent.type === "SELECT_DATE") return showAskedDay(turn, intent);
      if (turn.awaiting?.kind === "accept-next-opening") {
        const labels = session.offeredDates.map((day) => day.label);
        session.markDatesShown();
        return turn.clarify(nextOpeningFollowUp(new Date(turn.awaiting.slotStart), session.config.property.timezone), { kind: "choose", options: labels, what: "a day", after: "" }, turn.awaiting);
      }
      session.markDatesShown();
      return turn.fallback(`${SORRY} Which day works for you?`, { kind: "choose", options: session.offeredDates.map((day) => day.label), what: "a day" });
    }

    case "choose-time": {
      const pendingTimeRequest = await session.unapprovedCustomTimeRequest();
      if (pendingTimeRequest && !pendingTimeRequest.pendingNoticeSentAt && !(await isShownMenuBookingInput(turn))) {
        await session.recordText(turn.said);
        await session.announceUnapprovedCustomTime();
        return;
      }
      const labels = session.offeredSlots.map((s) => s.label);
      const menu: ReplyPrompt = { kind: "choose", options: labels, what: "a time" };
      if (helpAheadOfMenu(turn)) return session.help(turn.said);
      if (intent.type === "START_INQUIRY") return restartBookingDays(turn);
      if (session.staleTimeMenu || session.staleDateMenu) {
        const text = turn.said.text ?? "";
        const still = session.offeredSlots.find((slot) => same(slot.label, text));
        if (still && turn.confident) return turn.act("chooseTime", { slotStart: still.start.toISOString() });
        if (isBareMenuNumber(text) || matchesLabel(text, session.lastShownSlots.map((slot) => slot.label))) return showScheduleChanged(turn);
      }
      if (intent.type === "SELECT_DATE") return showAskedDay(turn, intent);
      if (intent.type === "SELECT_TIME") {
        const slot = session.offeredSlots.find((s) => same(s.label, intent.timeLabel));
        if (slot && turn.confident) return turn.act("chooseTime", { slotStart: slot.start.toISOString() });
        return turn.clarify("Which time works for you?", menu);
      }
      if (turn.interpretation.clarificationQuestion) return turn.clarify(`${turn.interpretation.clarificationQuestion} Which time works for you?`, menu);
      if (turn.interpretation.clarificationNeeded && !turn.interpretation.manipulation) return turn.clarify("Sure — which time works for you?", menu);
      session.markTimesShown();
      return turn.fallback(`${SORRY} Which time works for you?`, menu);
    }

    case "consent":
      await session.finishVisitRecordFromTextingOptIn(turn.said);
      return;

    case "identity":
      if (intent.type === "REQUEST_HELP") return session.help(turn.said);
      if (isIdentityFormAsk(turn.said.text ?? "")) return session.resendVerificationLink(turn.said);
      if (await offerBookedTimeChange(turn)) return;
      if (await acceptShownBookingChange(turn)) return;
      if (leftoverAfterConsent(turn.said.text ?? "")) {
        await session.recordText(turn.said);
        await answerLeftoverAfterConsent(turn, turn.said.text ?? "");
        return;
      }
      return session.resendVerificationLink(turn.said);

    case "ready":
      return onArrival(turn);

    case "touring":
      return onTour(turn);

    case "follow-up": {
      const question = followUpQuestion(session);
      if (intent.type === "FOLLOW_UP_YES" || intent.type === "FOLLOW_UP_NO") {
        if (turn.confident) return turn.act("followUp", { wantsContact: intent.type === "FOLLOW_UP_YES" });
        return turn.clarify(`Just to check: ${question.charAt(0).toLowerCase()}${question.slice(1)}`, yesNo);
      }
      if (await takeOverHeldBookingOnGreeting(turn)) return;
      if (intent.type === "REQUEST_HELP") return session.help(turn.said);
      return turn.fallback(`${SORRY} ${question}`, yesNo);
    }

    case "done":
    case "stopped":
      if (await session.isPaused()) {
        if (intent.type === "REQUEST_HELP") return session.help(turn.said);
        return turn.respond(VisitorDenialCopy.operatorHold(session.config.operator.name, session.config.operator.visitorContact));
      }
      if (session.slotMenuLive && (await tryShownSlotPick(turn, (slotStart) => session.bookOffered(slotStart).then(() => undefined)))) return;
      if (intent.type === "ASK_PROPERTY_QUESTION") return handleEndedQuestion(turn);
      return turn.respond(TOUR_ENDED_REPLY);
  }
}

/** Booked and verified, not yet in: the only door that can be asked for is the first stop, via arrival. */
async function onArrival(turn: Turn): Promise<void> {
  const { session, intent } = turn;
  const r = (await session.reservation())!;
  const first = r.allowedRoute[0]!;
  const yesNo: ReplyPrompt = { kind: "yes-no" };
  const confirmArrival = () => turn.clarify("Are you at the property now?", yesNo, { kind: "confirm-arrival" });

  switch (intent.type) {
    case "ARRIVAL":
      return turn.confident ? turn.act("arrive") : confirmArrival();
    case "AT_UNIT":
    case "AT_ROUTE_STOP": {
      const doorId = namedDoor(session, intent);
      const named = (intent.type === "AT_UNIT" && intent.unitName) || (intent.type === "AT_ROUTE_STOP" && intent.stopName);
      if (!named || doorId === first) return turn.confident ? turn.act("arrive") : confirmArrival();
      // A later stop, or a door off the route: start at the first stop, and only once they confirm they're there.
      return turn.clarify(`Let's start at ${session.stopLabel(first)}. Are you there now?`, yesNo, { kind: "confirm-arrival" });
    }
    case "REQUEST_HELP":
      return session.help(turn.said);
    case "FINISH_TOUR":
      return turn.respond("Your tour hasn't started yet.", { kind: "say", phrase: "I'm here", purpose: "when you arrive" });
    default:
      if (session.slotMenuLive && (await tryShownSlotPick(turn, (slotStart) => session.bookOffered(slotStart).then(() => undefined)))) return;
      return turn.fallback(`${SORRY} You can ask me a question about the property.`, { kind: "say", phrase: "I'm here", purpose: "when you arrive" });
  }
}

async function handlePostTourDistress(turn: Turn): Promise<boolean> {
  if (!mentionsAfterCloseDistress(turn.said.text ?? "")) return false;
  const session = turn.session;
  const current = await session.reservation();
  const reservations = await session.store.list("reservations");
  const finished = reservations.find(
    (reservation) => reservation.status === "COMPLETED" && (!current || reservation.prospectId === current.prospectId),
  );
  if (!finished || !(await session.hasFollowUpResponse(finished.id))) return false;
  await session.alertDistress(turn.said, finished.id);
  return true;
}

async function handleOverstayReply(turn: Turn): Promise<boolean> {
  const { session, intent } = turn;
  const reservation = await session.reservation();
  const overstay = session.overstay;
  if (!overstay || !reservation?.windowEnd) return false;
  if (reservation.status !== "TOURING" && reservation.status !== "EXPIRED") return false;
  const said = turn.said.text ?? "";

  if (reservation.status === "EXPIRED") {
    const confirmed = await session.core.hasConfirmedLeftAfterClose(reservation.id);
    if (confirmed) return false;
    if (isLeavingTour(stripFiller(normalize(said))) || (intent.type === "FINISH_TOUR" && turn.confident)) {
      await session.recordText(turn.said);
      await session.core.confirmLeftAfterClose(reservation.id);
      overstay.cancel(reservation.id);
      await session.refreshThread();
      session.followUpReservationId = reservation.id;
      return true;
    }
    const closedAt = (await session.store.listAudit()).find((e) => e.type === "TOUR_OVERSTAY_CLOSED" && e.reservationId === reservation.id)?.at;
    const afterCloseOpen = afterCloseAlertOpen({
      nowMs: session.clock.now().getTime(),
      closedAt,
      confirmedLeft: false,
      exceptionResolved: !!overstay.get(reservation.id)?.alertClosedAt,
    });
    if (afterCloseOpen) {
      if (isClearBookingPhrase(said, intent) && !session.pendingBookingId) {
        await startBookingAfterClose(turn);
        return true;
      }
      await session.recordText(turn.said);
      await session.core.replyAfterOverstayClose(reservation.id, said);
      await session.refreshThread();
      return true;
    }
    if (session.pendingBookingId) {
      session.promotePendingBookingIfEnded();
      if (await session.activeNeedsConsent()) {
        await session.recordText(turn.said);
        await session.announceHeldBookingConsent();
        return true;
      }
    }
    if (startsNewBookingAfterClose(said, intent)) {
      await startBookingAfterClose(turn);
      return true;
    }
    return false;
  }

  if (overstay.takePendingRebook(reservation.id, said)) {
    await startRebook(turn);
    return true;
  }

  // T-15 / T-5 / more-time replies first so "all set" after T-15 is not treated as leaving.
  const reply = await overstay.replyToVisitor(session.core, reservation.id, said);
  if (reply !== undefined) {
    if (reply === T5_NO_OFFER_BARE_YES && (await session.pendingBookingNeedsConsent())) {
      await session.answerPendingConsent(true, turn.said);
      return true;
    }
    await turn.respond(reply);
    if (reply.startsWith("You've got 10 more minutes.") && (await session.pendingBookingNeedsConsent())) {
      await session.grantPendingVisitRecord();
    }
    return true;
  }

  if (intent.type === "FINISH_TOUR" && turn.confident) {
    await turn.act("finish");
    overstay.cancel(reservation.id);
    return true;
  }
  if (intent.type === "ASK_MORE_TIME" && turn.confident) {
    const body = await overstay.handleAsk(session.core, reservation.id, "natural");
    await turn.respond(body);
    return true;
  }
  return false;
}

async function startRebook(turn: Turn): Promise<void> {
  const { session } = turn;
  await session.recordText(turn.said);
  const dates = await session.beginRebook();
  if (!dates.length) {
    await session.reply(VisitorDenialCopy.noOpenTimes(session.config.operator.name));
    return;
  }
  session.markDatesShown();
  await session.reply(DAY_MENU, { kind: "choose", options: dates.map((day) => day.label), what: "a day" });
}

/** After a tour ends, a greeting continues the held booking: booked-for line, then the usual next steps. */
async function takeOverHeldBookingOnGreeting(turn: Turn): Promise<boolean> {
  const { session, intent } = turn;
  const text = turn.said.text ?? "";
  if (await session.afterCloseStillOpen()) return false;
  if (session.followUpReservationId && !(await session.hasFollowUpResponse(session.followUpReservationId))) return false;
  if (!startsNewBookingAfterClose(text, intent)) return false;
  if (session.pendingBookingId) {
    const current = await session.reservation();
    if (current && !TERMINAL.includes(current.status)) return false;
    if (current?.status === "COMPLETED" && !(await session.hasFollowUpResponse(current.id))) return false;
    session.promotePendingBookingIfEnded();
  }
  if ((session.heldBookingTakenOver || session.followUpReservationId) && (await session.activeNeedsConsent())) {
    session.followUpReservationId = undefined;
    await session.recordText(turn.said);
    await session.announceHeldBookingConsent();
    return true;
  }
  return false;
}

async function outstandingProposedRequest(session: VisitorDemoSession) {
  const requests = await session.store.list("tourTimeRequests");
  const ids = new Set([session.reservationId, session.pendingBookingId, session.pendingCustomRequestId].filter((id): id is string => !!id));
  return requests.find(
    (request) =>
      request.status === "PENDING" &&
      request.proposedAlternativeAt &&
      ((request.reservationId && ids.has(request.reservationId)) || request.id === session.pendingCustomRequestId),
  );
}

async function handleProposedTimeReply(turn: Turn): Promise<boolean> {
  const { session } = turn;
  const request = turn.awaiting?.kind === "confirm-alternative"
    ? (await session.store.get("tourTimeRequests", turn.awaiting.requestId)) ?? (await outstandingProposedRequest(session))
    : await outstandingProposedRequest(session);
  if (!request?.proposedAlternativeAt || request.status !== "PENDING") return false;
  const text = turn.said.text ?? "";
  if (hasExplicitChangeAsk(text)) return false;
  const answer = clearConsentAnswer(text);
  if (answer === "yes") {
    await session.recordText(turn.said);
    await session.acceptAlternative(request.id);
    return true;
  }
  if (answer === "no") {
    const reservation = await session.reservation();
    const zone = bookedClockZone(session.config.property.timezone, reservation ?? undefined);
    if (!zone) return false;
    const named = spokenTimes(normalize(text), localDateOf(session.clock.now(), zone));
    if (named.length === 1 || turn.intent.type === "REQUEST_CUSTOM_TIME") return false;
    await session.recordText(turn.said);
    await session.declineAlternative(request.id);
    return true;
  }
  return false;
}

async function handlePendingBookingReply(turn: Turn): Promise<boolean> {
  const { session } = turn;
  if (!session.pendingBookingId) return false;
  if ((await session.stage()) === "follow-up") return false;
  if (await outstandingProposedRequest(session)) return false;
  // A bare YES/NO answers the latest question asked — a door check wins over pending rebook consent.
  if (awaitingLatestYesNo(turn.awaiting)) return false;
  const text = turn.said.text ?? "";
  if (hasExplicitChangeAsk(text)) return false;
  if (await session.pendingBookingNeedsConsent()) {
    if (isCancelTourAsk(text)) return false;
    await session.answerPendingConsent(true, turn.said);
    return true;
  }
  if ((await session.pendingBookingNeedsVerification()) && /\b(form|link|identity|verify|verification)\b/.test(stripFiller(normalize(text)))) {
    await session.resendPendingVerification(turn.said);
    return true;
  }
  return false;
}

async function startBookingAfterClose(turn: Turn): Promise<void> {
  const { session } = turn;
  session.pendingRebook = false;
  session.rebookUnitId = undefined;
  const current = await session.reservation();
  if (current) session.overstay?.cancel(current.id);
  session.reservationId = undefined;
  await session.greet(turn.said);
}

async function handlePendingRebookPick(turn: Turn): Promise<boolean> {
  const { session } = turn;
  if (!session.pendingRebook) return false;
  if (
    turn.awaiting &&
    (turn.awaiting.kind === "confirm-stop" ||
      turn.awaiting.kind === "confirm-arrival" ||
      turn.awaiting.kind === "confirm-finish" ||
      turn.awaiting.kind === "choose-stop" ||
      turn.awaiting.kind === "confirm-cancel-tour")
  ) {
    return false;
  }
  const step: VisitorStage = session.selectedDate ? "choose-time" : "choose-date";
  const interpretation = await rulesOnly.interpret(await contextFor(session, turn.said.text ?? "", step, turn.awaiting));
  if (interpretation.intent.type === "SELECT_DATE") {
    await showAskedDay(turn, interpretation.intent);
    return true;
  }
  if (interpretation.intent.type === "SELECT_TIME") {
    const picked = interpretation.intent;
    const slot = session.offeredSlots.find((s) => same(s.label, picked.timeLabel));
    if (slot && isConfident(interpretation)) {
      await session.recordText(turn.said);
      await session.confirmRebook(slot.start.toISOString());
      return true;
    }
  }
  if (await tryShownSlotPick(turn, (slotStart) => session.confirmRebook(slotStart))) return true;
  return false;
}

/** In the building: stops along the route, questions, help, finishing. */
async function onTour(turn: Turn): Promise<void> {
  const { session, intent } = turn;
  const remaining = await session.remainingStops();
  const next = remaining[0];
  const yesNo: ReplyPrompt = { kind: "yes-no" };
  const nextHint = next ? ` Text me when you're at ${session.stopLabel(next)}.` : " Text DONE when you're finished.";

  switch (intent.type) {
    case "FINISH_TOUR":
      return turn.confident ? turn.act("finish") : turn.clarify("Are you finished with your tour?", yesNo, { kind: "confirm-finish" });
    case "AT_UNIT":
    case "AT_ROUTE_STOP": {
      const target = targetOf(session, intent, remaining);
      if ("choices" in target) {
        const stops = target.choices.map((d) => stopRef(session, d));
        return turn.clarify(
          `Which door are you at: ${stops.map((s) => s.label).join(" or ")}?`,
          { kind: "choose", options: stops.map((s) => s.label), what: "a door" },
          { kind: "choose-stop", stops },
        );
      }
      if ("none" in target) {
        const reservation = await session.reservation();
        const end = reservation?.windowEnd ? Date.parse(reservation.windowEnd) : Number.NaN;
        if (!Number.isNaN(end) && session.clock.now().getTime() >= end) {
          const zone = bookedClockZone(session.config.property.timezone, reservation);
          if (!zone) return turn.respond(DOOR_AFTER_T);
          const time = formatVisitorClock(new Date(reservation!.windowEnd!), zone);
          return turn.respond(`Your tour time ended at ${time}, so the doors are locked now. Want to come back another time? Just reply with a day that works.`);
        }
        return turn.clarify("Every door on your tour is already open for you. Text HELP if one isn't working.", { kind: "say", phrase: "DONE", purpose: "when you're finished" });
      }
      if ("unknownName" in target) return turn.fallback(`${SORRY}${nextHint}`);
      if (turn.confident) return turn.act("atStop", { doorId: target.doorId });
      return turn.clarify(`Are you at ${session.stopLabel(target.doorId)} now?`, yesNo, { kind: "confirm-stop", stop: stopRef(session, target.doorId) });
    }
    case "ARRIVAL":
      return turn.respond(`You're all set.${nextHint}`);
    case "REQUEST_HELP":
      return session.help(turn.said);
    default:
      if (session.slotMenuLive && (await tryShownSlotPick(turn, (slotStart) => session.confirmRebook(slotStart)))) return;
      return turn.fallback(
        `${SORRY} You can ask me a question${next ? `, text "at ${session.stopLabel(next)}" when you get there,` : ","} or text DONE when you're finished.`,
        undefined,
        nextHint,
      );
  }
}
