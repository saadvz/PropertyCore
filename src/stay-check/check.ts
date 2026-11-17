import { zonedParts } from "../core/timezone";
import { alertText } from "./alert";
import type { MediaRef, StayEvent } from "./events";
import { CHECK_KINDS, needed, type CheckKind, type HouseRule, type RuleCheck } from "./rules";

/**
 * The night's check (#239): one night's events against the booking and the host's checkable rules. Pure: it
 * reads nothing, writes nothing, and sends nothing. A clean night means no alert.
 */

export interface NightBooking {
  /** Adults plus children, as booked. */
  guests?: number;
  infants?: number;
}

export interface NightInput {
  /** The property's name, for the alert. */
  label: string;
  rules: HouseRule[];
  sightings: Partial<Record<CheckKind, number>>;
  /** Kinds the host allowed for this stay. */
  allow: CheckKind[];
  booking?: NightBooking;
  timeZone: string;
  /** ISO instants; `to` is not included. */
  window: { from: string; to: string };
  events: StayEvent[];
}

export interface Flag {
  kind: CheckKind;
  /** The rule's text, in the host's words. */
  rule: string;
  /** Most people or cars in one event, the animal count, or the loudest dB (0 when only the sensor's alert). */
  peak: number;
  /** For people and cars. */
  allowed?: number;
  /** For people: whether the allowed number is the booking's or the host's own limit. */
  basis?: "booking" | "rules";
  /** For quiet: the host's quiet hours. */
  quietHours?: { start: string; end: string };
  sightings: number;
  /** The peak event's time and device. */
  at: string;
  device: string;
  evidence?: MediaRef;
}

export interface Unchecked {
  kind: CheckKind;
  why: string;
}

export type NightResult =
  | { status: "skipped"; reason: string }
  | { status: "clean"; unchecked: Unchecked[] }
  | { status: "flags"; flags: Flag[]; unchecked: Unchecked[]; alert: string; evidence?: MediaRef };

export const NO_CHECKABLE_RULE = "No house rule the cameras can watch, so there's nothing to check.";

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const localClock = (iso: string, timeZone: string) => {
  const p = zonedParts(new Date(iso), timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};
const inQuiet = (t: string, start: string, end: string) => (start <= end ? t >= start && t < end : t >= start || t < end);

/** The sightings for one check, and the most seen in one of them, or why it can't be checked tonight. */
type Read = { sighted: { event: StayEvent; value: number }[]; allowed?: number; basis?: Flag["basis"] } | { unchecked: string };

function read(check: RuleCheck, input: NightInput, events: StayEvent[]): Read {
  const cameras = events.filter((event) => event.source === "camera");
  switch (check.kind) {
    case "people": {
      const booked = typeof input.booking?.guests === "number" ? input.booking.guests + (count(input.booking.infants) > 0 ? 1 : 0) : undefined;
      if (check.max === undefined && booked === undefined) return { unchecked: "No booked guest count for this stay, and the rule follows the booking." };
      const basis: Flag["basis"] = booked !== undefined && (check.max === undefined || booked < check.max) ? "booking" : "rules";
      const allowed = basis === "booking" ? booked! : check.max!;
      const sighted = cameras.map((event) => ({ event, value: count(event.counts?.people) })).filter((s) => s.value > allowed);
      return { sighted, allowed, basis };
    }
    case "pets":
      return { sighted: cameras.map((event) => ({ event, value: count(event.counts?.animals) })).filter((s) => s.value >= 1) };
    case "vehicles":
      return { sighted: cameras.map((event) => ({ event, value: count(event.counts?.vehicles) })).filter((s) => s.value > check.max), allowed: check.max };
    case "quiet": {
      const sounds = events.filter((event) => event.source === "noise");
      if (!sounds.length) return { unchecked: "No noise readings tonight." };
      const sighted = sounds
        .filter((event) => inQuiet(localClock(event.at, input.timeZone), check.start, check.end))
        // The host's own limit, when set, replaces the sensor's alert: a sensor that's too touchy doesn't flag under it.
        .filter((event) => (check.noiseLimit !== undefined ? count(event.noiseDb) > check.noiseLimit : event.loud === true))
        .map((event) => ({ event, value: count(event.noiseDb) }));
      return { sighted };
    }
  }
}

export function checkNight(input: NightInput): NightResult {
  const checked = CHECK_KINDS.map((kind) => input.rules.find((rule) => rule.check?.kind === kind)).filter((rule): rule is HouseRule & { check: RuleCheck } => !!rule?.check);
  if (!checked.length) return { status: "skipped", reason: NO_CHECKABLE_RULE };
  const from = Date.parse(input.window.from);
  const to = Date.parse(input.window.to);
  const events = input.events
    .filter((event) => {
      const at = Date.parse(event.at);
      return at >= from && at < to;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const flags: Flag[] = [];
  const unchecked: Unchecked[] = [];
  for (const rule of checked) {
    const kind = rule.check.kind;
    if (input.allow.includes(kind)) {
      unchecked.push({ kind, why: "The host allowed this for the stay." });
      continue;
    }
    const result = read(rule.check, input, events);
    if ("unchecked" in result) {
      unchecked.push({ kind, why: result.unchecked });
      continue;
    }
    if (!result.sighted.length || result.sighted.length < needed(input.sightings, kind)) continue;
    const peak = result.sighted.reduce((best, s) => (s.value > best.value ? s : best));
    const evidence = peak.event.clip ?? peak.event.snapshot;
    flags.push({
      kind,
      rule: rule.text,
      peak: peak.value,
      ...(result.allowed !== undefined ? { allowed: result.allowed } : {}),
      ...(result.basis ? { basis: result.basis } : {}),
      ...(rule.check.kind === "quiet" ? { quietHours: { start: rule.check.start, end: rule.check.end } } : {}),
      sightings: result.sighted.length,
      at: peak.event.at,
      device: peak.event.device,
      ...(evidence ? { evidence } : {}),
    });
  }
  if (!flags.length) return { status: "clean", unchecked };
  const evidence = flags.find((flag) => flag.evidence)?.evidence;
  return { status: "flags", flags, unchecked, alert: alertText(input.label, flags, input.timeZone), ...(evidence ? { evidence } : {}) };
}
