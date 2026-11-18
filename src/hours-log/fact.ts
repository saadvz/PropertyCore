import type { RowKind } from "./codes";

/** Who did the work on a row. Only "host" can land in the owner's log. A helper is a co-host or assistant who brought a package in. */
export type Actor = "host" | "cleaner" | "pro" | "helper" | "system";

/**
 * How a row's hours are found. measured: from times someone sent (START, DONE, a lock entry). scheduled:
 * from a booked or saved time. rule: an owner action in chat, timed by the host's own minutes for its code.
 * system: work Property Core did itself, at 0 hours.
 */
export type Timing = "measured" | "scheduled" | "rule" | "system";

/**
 * Whose log a row goes in: the owner's, Property Core's own (work the system did), the cleaner's, one
 * pro's (`pro:<proId>`), or one helper's (`helper:<hash>`, never their phone).
 */
export type LogKey = "owner" | "property-core" | "cleaner" | `pro:${string}` | `helper:${string}`;

/** One thing someone did, before the month turns it into a row. Always rebuilt from the records; never stored. */
export interface RowFact {
  kind: RowKind;
  actor: Actor;
  log: LogKey;
  /** The person's name. Empty on an owner row: the month fills in the owner's name. */
  participant: string;
  /** When it started, as an instant. */
  at: string;
  /** When it ended, as an instant. Absent on a single moment, like an approval. */
  until?: string;
  task: string;
  /** The record that proves it: a job, an order, or the host's saved approval. Never empty. */
  reference: string;
  onSite: boolean;
  timing: Timing;
  /** A line for the host's review when the row is missing something. */
  needs?: string;
}
