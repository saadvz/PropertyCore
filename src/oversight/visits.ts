import { randomBytes } from "node:crypto";
import { mayHoldCode } from "../hub/codeText";

/**
 * Expected visits (#240): someone told the host "I'll stop by", or sent a calendar invite, and the host's agent saved
 * it after reading it back. Nothing is created ahead of time or from a guess.
 */

export interface ExpectedVisit {
  /** "v-" and 8 hex characters, made on save. */
  id: string;
  /** The person's name as the host or the invite gives it. */
  who: string;
  /** Local date at the property, YYYY-MM-DD. */
  date: string;
  /** "HH:MM", local. Both or neither. */
  from?: string;
  to?: string;
  /** Why, like "walk-through". */
  note?: string;
  source: "text" | "invite";
  savedAt: string;
  /** A cancelled visit is kept but never checked. */
  cancelledAt?: string;
  /** When a run of the day first found it missed. */
  flaggedAt?: string;
  /** The visitor's mobile (#280 17), for their own door code. Unset: no code, checked as before. */
  phone?: string;
  /** The visit code's text: marked before it's sent, so a restart never sends twice. Never the code. */
  code?: { textAt?: string; sent?: boolean; told?: string[] };
}

/** Someone the host expects, saved with a visit that has a phone (#280 17). Never a code. */
export interface Visitor {
  phone: string;
  name: string;
  addedAt: string;
  invitedAt?: string;
  inviteTriedAt?: string;
  inviteTries?: number;
  yesAt?: string;
  stoppedAt?: string;
}

export interface VisitInput {
  who: string;
  date: string;
  from?: string;
  to?: string;
  note?: string;
}

export const MAX_WHO = 60;
export const MAX_NOTE = 200;
export const MAX_OPEN_VISITS = 50;

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_SHAPE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** A real calendar date as YYYY-MM-DD: 2026-02-31 isn't one. */
export const isDate = (value: unknown): value is string => typeof value === "string" && DATE_SHAPE.test(value) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
export const isClock = (value: unknown): value is string => typeof value === "string" && CLOCK.test(value);

/** Why this visit can't be saved, or undefined when it can. `today` is the property's local date. */
export function visitProblem(input: unknown, today: string): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "Give who's coming and the day.";
  const { who, date, from, to, note } = input as Record<string, unknown>;
  if (typeof who !== "string" || !who.trim() || who.trim().length > MAX_WHO) return `Give who's coming in 1 to ${MAX_WHO} characters.`;
  // A refusal names the field, never its words, so a code isn't repeated back.
  if (mayHoldCode(who)) return "Keep door codes and long numbers out of who's coming. Give the name only.";
  if (!isDate(date)) return "Give the day as YYYY-MM-DD, like 2026-11-19.";
  if (date < today) return `Give a day today or later. Today at the property is ${today}.`;
  if ((from === undefined) !== (to === undefined)) return "Give both a from and a to time, or neither for an all-day visit.";
  if (from !== undefined) {
    if (!isClock(from) || !isClock(to)) return "Give the times as 24-hour times, like 13:00 to 17:00.";
    if ((to as string) <= from) return "The to time has to be after the from time, on the same day.";
  }
  if (note !== undefined) {
    if (typeof note !== "string" || !note.trim() || note.trim().length > MAX_NOTE) return `Give the note in 1 to ${MAX_NOTE} characters, or leave it out.`;
    if (mayHoldCode(note)) return "Keep door codes and long numbers out of the note.";
  }
  return undefined;
}

/** A visit rebuilt from its known fields only, trimmed. Assumes it passed visitProblem. */
export function cleanVisit(input: VisitInput): VisitInput {
  return {
    who: input.who.trim(),
    date: input.date,
    ...(input.from !== undefined && input.to !== undefined ? { from: input.from, to: input.to } : {}),
    ...(input.note !== undefined ? { note: input.note.trim() } : {}),
  };
}

const name = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

/** The same person on the same day with the same window. */
export function sameVisit(a: VisitInput, b: VisitInput): boolean {
  return name(a.who) === name(b.who) && a.date === b.date && a.from === b.from && a.to === b.to;
}

/** Case and spacing ignored; a first name alone matches a full name that starts with it. */
export function whoMatches(expected: string, person: string): boolean {
  const a = name(expected);
  const b = name(person);
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return !short.includes(" ") && long.split(" ")[0] === short;
}

export function newVisitId(): string {
  return `v-${randomBytes(4).toString("hex")}`;
}
