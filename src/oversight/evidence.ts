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

export interface Evidence {
  /** Whether the property is on connected locks, so its entries can be read. */
  lock: boolean;
  entries: EntryEvent[];
  quiet: QuietSpan[];
  sightings: Sighting[];
}

export interface EvidenceInput {
  codeNames: CodeNames;
  names: EntryNames;
  /** The property is switched to connected locks (and SMART_LOCKS is on). */
  locks: boolean;
  /** CAMERAS is on. */
  cameras: boolean;
}

const ms = (iso: string) => Date.parse(iso);
const byTime = <T extends { at: string }>(list: T[]): T[] => [...list].sort((a, b) => ms(a.at) - ms(b.at));

/** Ring's label for a person, in any case. */
const PERSON_LABELS = new Set(["human", "person"]);

function quietSpans(events: readonly VisitEvent[]): QuietSpan[] {
  const spans: QuietSpan[] = [];
  const offline = new Map<string, QuietSpan>();
  let disconnected: QuietSpan | undefined;
  for (const event of byTime([...events])) {
    if (event.type === "lock-status" && (event.kind === "offline" || event.kind === "online")) {
      const open = offline.get(event.device);
      if (event.kind === "offline" && !open) {
        const span: QuietSpan = { from: event.at, device: event.device, why: "offline" };
        offline.set(event.device, span);
        spans.push(span);
      } else if (event.kind === "online" && open) {
        open.until = event.at;
        offline.delete(event.device);
      }
    } else if (event.type === "lock-connection") {
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
    entries: input.locks ? entryEventsFrom(events, input.codeNames, input.names) : [],
    quiet: input.locks ? quietSpans(events) : [],
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
 * Each standing code's person, by the code's name, from `door-grants.json`. Only a grant's flow, code name and
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
      if (flow !== "standing" || typeof codeName !== "string" || typeof label !== "string") continue;
      const name = label.trim();
      if (!name || name.length > 80 || /\d(?:[\s.\-_/]*\d){3,}/.test(name)) continue;
      out[codeKey(codeName)] = name;
    }
    return out;
  } catch {
    return {};
  }
}
