import { mayHoldCode } from "../hub/codeText";
import type { StayCheckFile } from "./store";

/**
 * The host's own house rules (#239). Each rule is kept in the host's words. A rule the cameras can watch also
 * carries a check, saved only after the agent read it back and the host agreed. Nothing here is filled in ahead
 * of time: no rules, no check.
 */

export type CheckKind = "people" | "pets" | "vehicles" | "quiet";
export const CHECK_KINDS: readonly CheckKind[] = ["people", "pets", "vehicles", "quiet"];

export type RuleCheck =
  | { kind: "people"; max?: number } // no max: no more people than booked
  | { kind: "pets" } // no pets
  | { kind: "vehicles"; max: number }
  | { kind: "quiet"; start: string; end: string; noiseLimit?: number }; // "HH:MM", dB

export interface HouseRule {
  /** The host's words, 1 to 200 characters. */
  text: string;
  /** Only when the agent read it back and the host agreed. */
  check?: RuleCheck;
}

export const MAX_RULES = 20;
export const MAX_RULE_TEXT = 200;
export const MAX_SIGHTINGS = 3;

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isCheckKind = (value: unknown): value is CheckKind => typeof value === "string" && (CHECK_KINDS as readonly string[]).includes(value);
export const isClock = (value: unknown): value is string => typeof value === "string" && CLOCK.test(value);
const whole = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

function checkProblem(check: unknown): string | undefined {
  if (!check || typeof check !== "object" || Array.isArray(check)) return "A rule's check needs a kind: people, pets, vehicles or quiet.";
  const c = check as Record<string, unknown>;
  switch (c.kind) {
    case "people":
      return c.max === undefined || whole(c.max, 1, 50) ? undefined : "Give the most guests as a whole number from 1 to 50, or leave it out to use the booked number.";
    case "pets":
      return undefined;
    case "vehicles":
      return whole(c.max, 0, 20) ? undefined : "Give the most cars as a whole number from 0 to 20.";
    case "quiet":
      if (!isClock(c.start) || !isClock(c.end)) return "Give quiet hours as 24-hour times, like 22:00 to 07:00.";
      if (c.start === c.end) return "Quiet hours need a start and an end that differ.";
      return c.noiseLimit === undefined || whole(c.noiseLimit, 30, 120) ? undefined : "Give the noise limit in decibels, as a whole number from 30 to 120, or leave it out to use the sensor's own noise alert.";
    default:
      return `There's no check called ${String(c.kind)}. Use people, pets, vehicles or quiet, or save the rule as text only.`;
  }
}

/** Why these rules can't be saved, or undefined when they can. */
export function rulesProblem(rules: unknown): string | undefined {
  if (!Array.isArray(rules)) return "Give the house rules as a list.";
  if (rules.length > MAX_RULES) return `Give up to ${MAX_RULES} house rules.`;
  const seen = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return "Each house rule needs its text.";
    const { text, check } = rule as Record<string, unknown>;
    if (typeof text !== "string" || !text.trim() || text.length > MAX_RULE_TEXT) return `Give each house rule in 1 to ${MAX_RULE_TEXT} characters.`;
    // The refusal names the rule by its place, never by its words, so a code isn't repeated back.
    if (mayHoldCode(text)) return `Keep door codes out of house rules. Give rule ${index + 1} without the number.`;
    if (check === undefined) continue;
    const problem = checkProblem(check);
    if (problem) return problem;
    const kind = (check as { kind: CheckKind }).kind;
    if (seen.has(kind)) return `Only one rule can carry the ${kind} check. Keep the other as text only.`;
    seen.add(kind);
  }
  return undefined;
}

/** Why this check time can't be saved, or undefined when it can. */
export function checkTimeProblem(time: unknown): string | undefined {
  return isClock(time) ? undefined : "Give the check time as a 24-hour time, like 23:00.";
}

/** A check rebuilt from its known fields only, so nothing else rides along into the record. Assumes it passed rulesProblem. */
export function cleanCheck(check: RuleCheck): RuleCheck {
  switch (check.kind) {
    case "people":
      return check.max === undefined ? { kind: "people" } : { kind: "people", max: check.max };
    case "pets":
      return { kind: "pets" };
    case "vehicles":
      return { kind: "vehicles", max: check.max };
    case "quiet":
      return { kind: "quiet", start: check.start, end: check.end, ...(check.noiseLimit !== undefined ? { noiseLimit: check.noiseLimit } : {}) };
  }
}

/** How many sightings a kind needs before it flags: 1, raised by false flags up to 3. */
export function needed(sightings: Partial<Record<CheckKind, number>>, kind: CheckKind): number {
  const n = sightings[kind];
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_SIGHTINGS) : 1;
}

/** A flag the host marked false: that kind needs one more sighting next time, never past 3. Allowed numbers never change. */
export function markFalse(file: StayCheckFile, kind: CheckKind): StayCheckFile {
  return { ...file, sightings: { ...file.sightings, [kind]: Math.min(needed(file.sightings, kind) + 1, MAX_SIGHTINGS) } };
}
