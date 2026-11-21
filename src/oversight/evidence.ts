import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cameraCounts, codeKey, entryEventsFrom, type CodeNames, type EntryNames, type VisitEvent } from "../visits/events";
import type { EntryEvent } from "./events";

/**
 * What the same-day check (#240) reads from the property's visit log: each unlock named by its code's role, the
 * spans when a lock couldn't report, and people seen on a picked camera. Pure over the stored lines, plus one
 * reader for standing code names. Nothing here is made up: a line that isn't stored isn't evidence.
 */

/** A span when a lock couldn't report: one device offline, or the whole lock account disconnected. */
export interface QuietSpan {
  from: string;
  /** Unset while it's still quiet. */
  until?: string;
  /** The lock's name; unset when the whole account was disconnected. */
  device?: string;
  why: "offline" | "disconnected";
}

/** A person seen on a camera: support for a visit, never proof of it on its own. */
export interface Sighting {
  at: string;
  device: string;
}

/** A stretch when the host had the property switched to connected locks. Unset `until` while it still is. */
export interface SwitchedOn {
  from: string;
  until?: string;
}

export interface Evidence {
  /** Whether lock lines are read at all (the account's locks on, property on connected locks or once was). */
  lock: boolean;
  /** The host's switch to connected locks over time, from its own `pc-locks:` lines. Unset when there are none. */
  switched?: SwitchedOn[];
  entries: EntryEvent[];
  quiet: QuietSpan[];
  sightings: Sighting[];
}

export interface EvidenceInput {
  codeNames: CodeNames;
  names: EntryNames;
  /** The property is switched to connected locks (and the account has connected locks on). */
  locks: boolean;
  /** The account has cameras on. */
  cameras: boolean;
  /** The property's door locks, by name. Only these open quiet spans: a thermostat or noise sensor isn't a door. Unset: every device. */
  doors?: readonly string[];
}

/** The id prefix of the host's own switch lines (`recordLockConnection`). Any other connection line is the lock partner's. */
const SWITCH_PREFIX = "pc-locks:";

const ms = (iso: string) => Date.parse(iso);
const byTime = <T extends { at: string }>(list: T[]): T[] => [...list].sort((a, b) => ms(a.at) - ms(b.at));

/** Ring's label for a person, in any case. */
const PERSON_LABELS = new Set(["human", "person"]);

/**
 * When a door couldn't report: from its `offline` to its next `online`, or its next lock or unlock line (it reported).
 * The lock partner's account disconnect is a span for every door. The host's own switch lines aren't spans: they
 * are `switchedOn`.
 */
function quietSpans(events: readonly VisitEvent[], doors: readonly string[] | undefined): QuietSpan[] {
  const isDoor = (device: string) => !doors || doors.includes(device);
  const spans: QuietSpan[] = [];
  const offline = new Map<string, QuietSpan>();
  let disconnected: QuietSpan | undefined;
  const close = (device: string, at: string) => {
    const open = offline.get(device);
    if (!open) return;
    open.until = at;
    offline.delete(device);
  };
  for (const event of byTime([...events])) {
    if (event.type === "lock-status" && (event.kind === "offline" || event.kind === "online")) {
      if (!isDoor(event.device)) continue;
      if (event.kind === "offline" && !offline.has(event.device)) {
        const span: QuietSpan = { from: event.at, device: event.device, why: "offline" };
        offline.set(event.device, span);
        spans.push(span);
      } else if (event.kind === "online") close(event.device, event.at);
    } else if (event.type === "lock") {
      close(event.device, event.at);
    } else if (event.type === "lock-connection" && !event.id.startsWith(SWITCH_PREFIX)) {
      if (!event.connected && !disconnected) {
        disconnected = { from: event.at, why: "disconnected" };
        spans.push(disconnected);
      } else if (event.connected && disconnected) {
        disconnected.until = event.at;
        disconnected = undefined;
      }
    }
  }
  return spans.sort((a, b) => ms(a.from) - ms(b.from));
}

/** The stretches the host had connected locks switched on, from their own switch lines. Undefined when there are none. */
function switchedOn(events: readonly VisitEvent[]): SwitchedOn[] | undefined {
  const lines = byTime(events.filter((event): event is Extract<VisitEvent, { type: "lock-connection" }> => event.type === "lock-connection" && event.id.startsWith(SWITCH_PREFIX)));
  if (!lines.length) return undefined;
  const out: SwitchedOn[] = [];
  let open: SwitchedOn | undefined;
  for (const line of lines) {
    if (line.connected && !open) {
      open = { from: line.at };
      out.push(open);
    } else if (!line.connected && open) {
      open.until = line.at;
      open = undefined;
    }
  }
  return out;
}

function sightingsFrom(events: readonly VisitEvent[]): Sighting[] {
  const counts = cameraCounts(events);
  const out: Sighting[] = [];
  for (const event of events) {
    if (event.type !== "camera") continue;
    const count = counts.get(event.id);
    const seen = event.kind === "ding" || (event.kind === "motion" && (count ? count.people >= 1 : PERSON_LABELS.has((event.label ?? "").toLowerCase())));
    if (seen) out.push({ at: event.at, device: event.device });
  }
  return byTime(out);
}

export function dayEvidence(events: readonly VisitEvent[], input: EvidenceInput): Evidence {
  return {
    lock: input.locks,
    ...(input.locks && switchedOn(events) ? { switched: switchedOn(events)! } : {}),
    entries: input.locks ? entryEventsFrom(events, input.codeNames, input.names) : [],
    quiet: input.locks ? quietSpans(events, input.doors) : [],
    sightings: input.cameras ? sightingsFrom(events) : [],
  };
}

/** The cleaner's and each pro's name, from their latest window line, and the standing code names given. */
export function entryNamesFrom(events: readonly VisitEvent[], codes: Record<string, string> = {}): EntryNames {
  let cleaner: { at: string; name: string } | undefined;
  const pros: Record<string, { at: string; name: string }> = {};
  for (const event of events) {
    if (event.type !== "visit-window") continue;
    const { who } = event;
    if (who.role === "cleaner" && (!cleaner || ms(event.at) >= ms(cleaner.at))) cleaner = { at: event.at, name: who.name };
    if (who.role === "pro" && who.proId && (!pros[who.proId] || ms(event.at) >= ms(pros[who.proId]!.at))) pros[who.proId] = { at: event.at, name: who.name };
  }
  return {
    ...(cleaner ? { cleaner: cleaner.name } : {}),
    pros: Object.fromEntries(Object.entries(pros).map(([id, entry]) => [id, entry.name])),
    codes,
  };
}

/**
 * Each standing or bring-in code's person (#241's package helper), by the code's name, from `door-grants.json`. Only a grant's flow, code name and
 * label are read; its sealed code never is. A label holding a run of 4 or more digits is left out. A missing or
 * unreadable file is no names.
 */
export function standingNames(root: string): Record<string, string> {
  const file = join(root, "door-grants.json");
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { grants?: unknown };
    const out: Record<string, string> = {};
    for (const grant of Array.isArray(raw.grants) ? raw.grants : []) {
      if (!grant || typeof grant !== "object") continue;
      const { flow, codeName, label } = grant as { flow?: unknown; codeName?: unknown; label?: unknown };
      if ((flow !== "standing" && flow !== "bring-in") || typeof codeName !== "string" || typeof label !== "string") continue;
      const name = label.trim();
      if (!name || name.length > 80 || /\d(?:[\s.\-_/]*\d){3,}/.test(name)) continue;
      out[codeKey(codeName)] = name;
    }
    return out;
  } catch {
    return {};
  }
}
