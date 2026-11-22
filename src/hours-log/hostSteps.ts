import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The host's own steps in the newer features (#18), for the hours log: one JSON line each in the property's
 * `host-steps.jsonl`, append-only, never edited. A feature appends one right after it saved what the host
 * said yes to, and only then: a refused, stale or unconfirmed call writes nothing. Property Core's own work
 * (a sweep, a lock's event, a text from a cleaner) never writes one. Lines hold no door code, no digits of
 * one, and no phone number: a person is named as the host named them, a device by its name.
 *
 * Features whose own record already keeps the host's yes (guest replies, late checkouts, other platforms'
 * bookings, expected visits, house facts' history, approved texts in the visit log) aren't written here: the
 * hours log reads those records where they are. See docs/superpowers/specs/2026-11-22-house-rules-facts-hours-design.md.
 */

export const HOST_STEPS_FILE = "host-steps.jsonl";

export const HOST_STEP_KINDS = [
  // Setup: the host's first Activate of a flow that keeps no time of its own (Cleaner Core)
  "activate",
  // Connected locks (#180)
  "locks-on",
  "locks-off",
  "lock-settings",
  "standing-add",
  "standing-invite",
  "standing-link",
  "standing-remove",
  // Guest codes (#262)
  "guest-codes-mode",
  "guest-code-make",
  "guest-code-link",
  "lease-add",
  "lease-change",
  "lease-remove",
  "lease-link",
  // The nightly stay check's house rules (#239, #15)
  "rules-save",
  "rules-add",
  "check-time",
  "stay-allow",
  "flag-false",
  // Fixer Core upkeep (#245)
  "upkeep-save",
  "upkeep-remove",
] as const;

export type HostStepKind = (typeof HOST_STEP_KINDS)[number];

export interface HostStep {
  at: string;
  kind: HostStepKind;
  /** What the step was about, for the row's task: a door's or person's name, a date, a mode. Never a code or a phone. */
  about?: string;
  /** The record it belongs to, for the row's reference: a person's, lease's, stay's or upkeep item's id. */
  ref?: string;
}

const KINDS: ReadonlySet<string> = new Set(HOST_STEP_KINDS);
/** No door code or phone in a line: four or more digits in a row (dates and clock times aside) are left out. */
const DIGITS = /\d(?:[\s.()-]?\d){3,}/;
const SAFE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function clean(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim().slice(0, 120);
  if (!trimmed) return undefined;
  if (SAFE_DATE.test(trimmed)) return trimmed;
  return DIGITS.test(trimmed.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ").replace(/\b\d{1,2}:\d{2}\b/g, " ")) ? undefined : trimmed;
}

/** An id or a booking's reference, like std_ab12cd34ef or vrbo:HA-1A2B3C: letters first, never a bare number. */
const ID = /^[A-Za-z][A-Za-z_]*[:_-]?[A-Za-z0-9_:-]{1,60}$/;

/** Appends one of the host's steps. A record, not a gate: a failure to write never undoes or blocks the host's action. */
export function recordHostStep(root: string, step: HostStep): void {
  try {
    const about = clean(step.about);
    const ref = step.ref && ID.test(step.ref) ? step.ref : clean(step.ref);
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, HOST_STEPS_FILE), `${JSON.stringify({ at: step.at, kind: step.kind, ...(about ? { about } : {}), ...(ref ? { ref } : {}) })}\n`);
  } catch {
    // The hours log loses one row; the host's action stands.
  }
}

export function readHostSteps(root: string): HostStep[] {
  const path = join(root, HOST_STEPS_FILE);
  if (!existsSync(path)) return [];
  const out: HostStep[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const step = JSON.parse(line) as HostStep;
      if (step && typeof step.at === "string" && !Number.isNaN(Date.parse(step.at)) && KINDS.has(step.kind)) out.push(step);
    } catch {
      // A torn line from a crash mid-append is skipped; the rest still reads.
    }
  }
  return out;
}
