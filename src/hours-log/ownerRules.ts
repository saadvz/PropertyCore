import type { RowKind } from "./codes";
import type { RowFact } from "./fact";

/**
 * Which rows are the owner's (#238). Owner rows record only what the owner did: reviewing, approving,
 * handling a flag, being on site. The system never writes owner time for work it did itself.
 *
 * A tax professional is still to review how owner rows are written, so this file is the one place those
 * rules live. Rows are rebuilt on every read, so a change here rebuilds every month; bump the version so a
 * month confirmed under the old rules is reviewed again before it exports.
 */

export const OWNER_RULES_VERSION = 1;

/** The things only the host does, in chat or in person. */
export const OWNER_KINDS: ReadonlySet<RowKind> = new Set<RowKind>([
  "confirm-times",
  "pay-cleaner",
  "approve-repair",
  "approve-booking",
  "approve-price",
  "pick-quote",
  "reschedule-repair",
  "record-cost",
  "confirm-repair",
  "approve-order",
  "place-order",
  "owner-on-site",
]);

/** True when a fact may stay in the owner's log: the host did it, and it's one of the owner's kinds. */
export function ownerMay(fact: RowFact): boolean {
  return fact.actor === "host" && OWNER_KINDS.has(fact.kind);
}

/**
 * Where a fact really goes. Whatever a source says, nothing the host didn't do stays in the owner's log:
 * it moves to Property Core's own log, at no hours. A host action always goes in the owner's log.
 */
export function routeFact(fact: RowFact): RowFact {
  if (fact.log === "owner" && !ownerMay(fact)) return { ...fact, log: "property-core", participant: "Property Core", timing: "system" };
  if (fact.log !== "owner" && ownerMay(fact)) return { ...fact, log: "owner", participant: "", timing: fact.timing === "system" ? "rule" : fact.timing };
  return fact;
}
