import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../storage/atomicWrite";
import type { ParsedGuestMessage } from "./airbnbMessage";
import { FACT_TOPICS, isFactTopic, type GuestFact, type GuestFactTopic } from "./facts";

/**
 * Guest messages' records (#242), in the property's folder: `guest-facts.json` holds the host's house facts
 * for guests; `guest-messages.jsonl` holds every message email taken (door codes out), each approved or
 * skipped reply, and each late checkout the host allowed, one JSON line each, append-only.
 */

export const GUEST_FACTS_FILE = "guest-facts.json";
export const GUEST_MESSAGES_FILE = "guest-messages.jsonl";
export const GUEST_APPROVALS_FILE = "guest-approvals.json";

export interface GuestFactsFile {
  facts: GuestFact[];
  /** Topics the host passed on, so they aren't asked again. */
  skipped: GuestFactTopic[];
}

/** guest-facts.json is there but isn't a readable record. Nothing is written over it. */
export class GuestFactsFileError extends Error {}

export function readGuestFacts(root: string): GuestFactsFile {
  const path = join(root, GUEST_FACTS_FILE);
  if (!existsSync(path)) return { facts: [], skipped: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    raw = undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new GuestFactsFileError(`The house facts record (${GUEST_FACTS_FILE}) can't be read, so nothing was changed. Tell the host it needs a look.`);
  }
  const file = raw as Partial<GuestFactsFile>;
  const facts = (Array.isArray(file.facts) ? file.facts : []).filter(
    (fact): fact is GuestFact => !!fact && typeof fact === "object" && isFactTopic((fact as GuestFact).topic) && typeof (fact as GuestFact).text === "string",
  );
  const skipped = (Array.isArray(file.skipped) ? file.skipped : []).filter(isFactTopic);
  return { facts, skipped: FACT_TOPICS.filter((topic) => skipped.includes(topic)) };
}

export function writeGuestFacts(root: string, file: GuestFactsFile): void {
  writeJsonAtomic(join(root, GUEST_FACTS_FILE), file);
}

export type GuestMessageEvent = "taken" | "refused" | "reply-approved" | "reply-skipped" | "late-checkout";

export interface GuestMessageRecord {
  /** When Property Core took it. */
  at: string;
  /** Property Core's id for the message (gm_...), or for a late checkout (lc_...). */
  id: string;
  event: GuestMessageEvent;
  receivedAt?: string;
  /** The email's Message-ID header. */
  messageId?: string;
  from?: string;
  subject?: string;
  /** A hash of the body as received, door codes out, so a second copy is known. */
  bodyHash?: string;
  /** The guest's words with door codes out. Never kept for a refused email. */
  parsed?: ParsedGuestMessage;
  refused?: string;
  stay?: { checkIn: string; checkout: string; confirmationCode?: string };
  topics?: GuestFactTopic[];
  /** The reply the host approved. */
  reply?: string;
  lateCheckout?: { checkout: string; time: string };
}

export function readGuestMessages(root: string): GuestMessageRecord[] {
  const path = join(root, GUEST_MESSAGES_FILE);
  if (!existsSync(path)) return [];
  const out: GuestMessageRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as GuestMessageRecord;
      if (record && typeof record === "object" && typeof record.id === "string" && typeof record.event === "string") out.push(record);
    } catch {
      // A torn line from a crash mid-append is skipped; the rest still reads.
    }
  }
  return out;
}

export function appendGuestMessage(root: string, record: GuestMessageRecord): void {
  mkdirSync(root, { recursive: true });
  appendFileSync(join(root, GUEST_MESSAGES_FILE), `${JSON.stringify(record)}\n`);
}

/** Property Core's id for one email: the same email always gets the same id. */
export function messageIdFor(email: { from: string; subject: string; messageId?: string }, bodyHash: string): string {
  const key = email.messageId?.trim() || `${email.from}|${email.subject}|${bodyHash}`;
  return `gm_${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/** The latest late checkout the host allowed for the stay checking out that day, as "HH:MM". */
export function lateCheckoutFor(records: readonly GuestMessageRecord[], checkout: string): string | undefined {
  let time: string | undefined;
  for (const record of records) if (record.event === "late-checkout" && record.lateCheckout?.checkout === checkout) time = record.lateCheckout.time;
  return time;
}
