import { z } from "zod";
import type { LocalDate } from "../core/timezone";

/**
 * What a visitor is trying to do, in Tour Core's own terms. An interpreter
 * turns free text into one of these; it never decides whether anything is
 * allowed. Tour Core's state machine and access policy decide that, exactly
 * as they do for a button tap.
 */

export const HelpProblemSchema = z.enum(["DOOR_WONT_OPEN", "LOST", "CANT_FIND_UNIT", "GENERAL"]);

const Name = z.string().trim().min(1).max(80);
const CalendarDate = z.object({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
});

export const TourIntentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("START_INQUIRY") }),
  /** `unitName` is one of the unit names Tour Core offered. */
  z.object({ type: z.literal("SELECT_UNIT"), unitName: Name }),
  /** `timeLabel` is one of the time labels Tour Core offered ("2:00 PM"). */
  z.object({ type: z.literal("SELECT_TIME"), timeLabel: Name }),
  /**
   * A specific time that isn't being booked as a normal slot. Hour is 1–12.
   * Meridiem and day are present only when the visitor said them.
   */
  z.object({
    type: z.literal("REQUEST_CUSTOM_TIME"),
    hour: z.number().int().min(1).max(12),
    minute: z.number().int().min(0).max(59),
    meridiem: z.enum(["AM", "PM"]).optional(),
    day: z.enum(["today", "tomorrow"]).optional(),
    weekday: z.enum(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]).optional(),
    nextWeek: z.boolean().optional(),
    date: CalendarDate.optional(),
  }),
  z.object({
    type: z.literal("SELECT_DATE"),
    weekday: z.enum(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]).optional(),
    relative: z.enum(["today", "tomorrow", "weekend"]).optional(),
    nextWeek: z.boolean().optional(),
    /** Property-local calendar date when the visitor named one ("Dec 1", "12/1"). */
    date: CalendarDate.optional(),
    /** They asked for a day that could not be resolved ("the 45th", "next month"). */
    unclear: z.boolean().optional(),
  }),
  /** "What times do you have?": the open tour times, for one weekday when named. Never the unit's move-in availability. */
  z.object({
    type: z.literal("ASK_OPEN_TIMES"),
    weekday: z.enum(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]).optional(),
  }),
  /** A booked visitor wants a different time, without naming one: "can I change the time?", "Thursday instead?". */
  z.object({
    type: z.literal("RESCHEDULE_TOUR"),
    weekday: z.enum(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]).optional(),
  }),
  /** "When is my tour?": the booked day, time, door window, and address. */
  z.object({ type: z.literal("ASK_MY_TOUR") }),
  /** "Where is it?", "what's the address?": the address and a directions link. */
  z.object({ type: z.literal("ASK_DIRECTIONS") }),
  z.object({ type: z.literal("ACCEPT_PROPOSED_TIME") }),
  z.object({ type: z.literal("DECLINE_PROPOSED_TIME") }),
  z.object({ type: z.literal("CONSENT_YES") }),
  z.object({ type: z.literal("CONSENT_NO") }),
  z.object({ type: z.literal("ARRIVAL") }),
  /** A non-unit stop by door name ("Entrance"); no name means "wherever I'm expected next". */
  z.object({ type: z.literal("AT_ROUTE_STOP"), stopName: Name.optional() }),
  /** A unit by name; no name means "the unit" without saying which. */
  z.object({ type: z.literal("AT_UNIT"), unitName: Name.optional() }),
  z.object({ type: z.literal("ASK_PROPERTY_QUESTION"), question: z.string().trim().min(1).max(300) }),
  z.object({ type: z.literal("REQUEST_HELP"), problem: HelpProblemSchema.optional() }),
  z.object({ type: z.literal("FINISH_TOUR") }),
  z.object({ type: z.literal("ASK_MORE_TIME") }),
  z.object({ type: z.literal("FOLLOW_UP_YES") }),
  z.object({ type: z.literal("FOLLOW_UP_NO") }),
  z.object({ type: z.literal("STOP_MESSAGES") }),
  z.object({ type: z.literal("START_MESSAGES") }),
  /** Visitor wants to cancel a booked tour; Tour Core confirms before acting. */
  z.object({ type: z.literal("CANCEL_TOUR") }),
  z.object({ type: z.literal("CONFIRM_CANCEL_TOUR") }),
  z.object({ type: z.literal("KEEP_TOUR") }),
  z.object({ type: z.literal("UNKNOWN") }),
]);
export type TourIntent = z.infer<typeof TourIntentSchema>;
export type IntentType = TourIntent["type"];

export type InterpreterKind = "rules" | "semantic";

export interface IntentInterpretation {
  intent: TourIntent;
  /** 0..1. Tour Core compares this against its own thresholds; the interpreter doesn't act on it. */
  confidence: number;
  interpreter: InterpreterKind;
  /** The interpreter saw more than one plausible meaning (e.g. two units named). */
  clarificationNeeded: boolean;
  /** Tour Core-authored wording for the clarification, when the rules have a specific one. */
  clarificationQuestion?: string;
  /**
   * A clock time mentioned next to a property question. One message still has
   * one intent: the question is answered, and the time is filed only after the
   * visitor confirms it.
   */
  mentionedTime?: {
    hour: number;
    minute: number;
    meridiem?: "AM" | "PM";
    day?: "today" | "tomorrow";
    weekday?: "SUN" | "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT";
    nextWeek?: boolean;
    date?: { year: number; month: number; day: number };
  };
  /** A day named next to a property question. The question is answered, then that day's times are shown. */
  mentionedDate?: {
    weekday?: "SUN" | "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT";
    relative?: "today" | "tomorrow" | "weekend";
    nextWeek?: boolean;
    date?: { year: number; month: number; day: number };
    unclear?: boolean;
  };
  /** The text reads like an instruction to the assistant ("ignore your rules..."), not a visitor action. */
  manipulation?: boolean;
}

/** A door as the interpreter sees it: names only, never credentials. */
export interface StopRef {
  doorName: string;
  kind: "ENTRANCE" | "UNIT" | "COMMON";
  /** Set for a unit's own door. */
  unitName?: string;
  /** How Tour Core refers to it in messages ("Unit 101", "the entrance"). */
  label: string;
}

/** A tour-step confirmation Tour Core is waiting on, so a bare "yes" or "2" has a meaning. */
export type StepAwaiting =
  | { kind: "confirm-arrival" }
  /** The visitor was offered these start times (ISO) to move their booked tour to. */
  | { kind: "reschedule-pick"; slots: string[] }
  | { kind: "confirm-stop"; stop: StopRef }
  | { kind: "choose-stop"; stops: StopRef[] }
  | { kind: "confirm-finish" }
  | { kind: "confirm-custom-time"; hour: number; minute: number; meridiem?: "AM" | "PM"; day?: "today" | "tomorrow" }
  | { kind: "confirm-alternative"; requestId: string; startsAt: string }
  /** Next-opening offer — `slotStart` is the exact start; `date` is its YYYY-MM-DD. Flexible yes takes it. */
  | { kind: "accept-next-opening"; date: string; slotStart: string }
  | { kind: "confirm-operator-tour"; confirmBy: string }
  /** Confirm a visitor cancel-by-text. Day/time match the booked-tour copy. */
  | { kind: "confirm-cancel-tour"; day: string; time: string; laterWhileTouring?: boolean; namedRunning?: boolean; team?: string }
  | { kind: "t15-questions" }
  | { kind: "t5-extension-offer" }
  | { kind: "t5-no-offer" };

/**
 * Something Tour Core just asked the visitor. `which-unit` interrupts the
 * step for a question ("Which unit do you mean: 1A or 2B?"); `resume` is the
 * step confirmation that was open before, restored once the question is done.
 */
export type Awaiting = StepAwaiting | { kind: "which-unit"; question: string; units: string[]; resume?: StepAwaiting };

export type ConversationStep = "intro" | "choose-unit" | "choose-date" | "choose-time" | "consent" | "identity" | "ready" | "touring" | "follow-up" | "done" | "stopped";

export interface InterpretContext {
  message: string;
  /** Where the conversation is, which also says what Tour Core last asked for. */
  step: ConversationStep;
  awaiting?: StepAwaiting;
  units: { name: string; summary?: string }[];
  /** Tour times offered, in menu order. */
  timeChoices: string[];
  /** The unit on the visitor's reservation, once there is one. */
  reservedUnit?: string;
  /** Stops on the reserved route that haven't been opened yet, in order. */
  remainingStops: StopRef[];
  /** Every door on file, so a visitor naming an off-route door is understood (and then refused by policy). */
  doors: StopRef[];
  /** Property-local calendar date "now", so year-less dates resolve to the next occurrence. */
  today?: LocalDate;
  /** Property timezone, so last-asked copy can name a weekday and time. */
  timezone?: string;
  /** Stored operator name. Visitor copy uses it only when it ends in "team". */
  teamName?: string;
  /** A booked (or held) tour the visitor can cancel by text. */
  hasCancelableTour?: boolean;
  /** On-site now: touring, operator hold, or door-system problem. */
  hasRunningTour?: boolean;
  /** The visitor's known name, only so it can be removed before anything goes to a model. */
  visitorName?: string;
}

export interface IntentInterpreter {
  /** Short label for developer details, e.g. "rules" or "rules + grok-4". */
  readonly description: string;
  interpret(context: InterpretContext): Promise<IntentInterpretation>;
  /**
   * Present only when a language model is configured. Picks the one approved fact that answers a
   * property question, as a 0-based index, or undefined for none. Never writes a reply.
   */
  pickFact?(question: string, facts: string[], options?: { name?: string }): Promise<number | undefined>;
  /** Present only when a language model is configured: a second read of a text the rules filed as a property question. */
  reclassify?(context: InterpretContext): Promise<IntentInterpretation | undefined>;
}

/** Intents that lead toward a door opening. */
export const ACCESS_INTENTS: ReadonlySet<IntentType> = new Set(["ARRIVAL", "AT_ROUTE_STOP", "AT_UNIT"]);

const STATE_CHANGING: ReadonlySet<IntentType> = new Set([
  "SELECT_UNIT",
  "SELECT_TIME",
  "REQUEST_CUSTOM_TIME",
  "SELECT_DATE",
  "ACCEPT_PROPOSED_TIME",
  "DECLINE_PROPOSED_TIME",
  "CONSENT_YES",
  "CONSENT_NO",
  "FINISH_TOUR",
  "ASK_MORE_TIME",
  "FOLLOW_UP_YES",
  "FOLLOW_UP_NO",
  "STOP_MESSAGES",
  "START_MESSAGES",
  "CONFIRM_CANCEL_TOUR",
  "KEEP_TOUR",
]);

/**
 * Tour Core's bar for acting on an interpretation. Below it, Tour Core asks
 * instead of acting. Access-bound intents need the most certainty.
 */
export function requiredConfidence(type: IntentType): number {
  if (ACCESS_INTENTS.has(type)) return 0.85;
  if (STATE_CHANGING.has(type)) return 0.75;
  return 0.5;
}

export function isConfident(i: IntentInterpretation): boolean {
  return i.intent.type !== "UNKNOWN" && !i.clarificationNeeded && !i.manipulation && i.confidence >= requiredConfidence(i.intent.type);
}
