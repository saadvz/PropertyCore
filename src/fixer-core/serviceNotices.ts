import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { zonedParts } from "../core/timezone";
import { addCalendarDays } from "../hub/calendar";
import { redactDigitRuns } from "../visits/store";

/**
 * Vendors' completed-service emails (#237), as the host's agent received them, one JSON line each, append-only, like
 * booking emails. They are evidence for a visit: read only for the service date, to find the visit, and never for
 * times. Each code the property knows and every run of 4 or more digits is taken out before anything is written.
 */

export const SERVICE_NOTICES_FILE = "service-notices.jsonl";

export interface ServiceNoticeInput {
  from: string;
  subject: string;
  body: string;
  messageId?: string;
  receivedAt?: string;
}

export interface ServiceNoticeRecord {
  /** When Property Core took it. */
  at: string;
  receivedAt: string;
  messageId?: string;
  from: string;
  subject: string;
  /** The body as received, with codes and digit runs taken out. Not kept again for a duplicate. */
  body?: string;
  /** A hash of the cleaned body, so a second copy is known. */
  bodyHash: string;
  /** The Fixer Core job it was matched to. */
  jobId?: string;
  serviceDate?: string;
  outcome: "matched" | "unmatched" | "duplicate";
}

export const MAX_NOTICE_BODY = 20_000;

export function serviceNoticesPath(root: string): string {
  return join(root, SERVICE_NOTICES_FILE);
}

export function readServiceNotices(root: string): ServiceNoticeRecord[] {
  const path = serviceNoticesPath(root);
  if (!existsSync(path)) return [];
  const out: ServiceNoticeRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ServiceNoticeRecord);
    } catch {
      // A line cut short by a crash is skipped; every whole line still counts.
    }
  }
  return out;
}

/** Adds one line. Lines are never rewritten or removed. */
export function appendServiceNotice(root: string, record: ServiceNoticeRecord): void {
  mkdirSync(root, { recursive: true });
  appendFileSync(serviceNoticesPath(root), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** Text with each known code and every run of 4 or more digits taken out. */
export function cleanNoticeText(text: string, codes: readonly string[]): string {
  let out = text;
  for (const code of codes) if (code) out = out.split(code).join("[code]");
  return redactDigitRuns(out);
}

export function noticeHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 32);
}

/** The email's sender address, lowercased: the part in angle brackets, or the whole header. */
export function senderAddress(from: string): string {
  const inside = from.match(/<([^>]+)>/);
  return (inside ? inside[1]! : from).trim().toLowerCase();
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function ymd(year: number, month: number, day: number): string | undefined {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return undefined;
  return d.toISOString().slice(0, 10);
}

/**
 * Every date the notice names, in order and once each: "January 10, 2027", "Jan 10", "1/10/2027", "1/10/27",
 * "2027-01-10". A date with no year takes the year of `receivedAt`, or the year before when that would be after it.
 * Read before digit runs are taken out, on the raw text, and kept only as dates.
 */
export function noticeDates(text: string, receivedAt: string, timeZone: string): string[] {
  const got = zonedParts(new Date(receivedAt), timeZone);
  const received = `${got.year}-${String(got.month).padStart(2, "0")}-${String(got.day).padStart(2, "0")}`;
  const noYear = (month: number, day: number) => {
    const here = ymd(got.year, month, day);
    return here && here > addCalendarDays(received, 1) ? ymd(got.year - 1, month, day) : here;
  };
  const found: { index: number; date: string }[] = [];
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const date = ymd(Number(m[1]), Number(m[2]), Number(m[3]));
    if (date) found.push({ index: m.index!, date });
  }
  for (const m of text.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/g)) {
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined;
    const date = year ? ymd(year, Number(m[1]), Number(m[2])) : noYear(Number(m[1]), Number(m[2]));
    if (date) found.push({ index: m.index!, date });
  }
  for (const m of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/gi)) {
    const month = MONTHS[m[1]!.toLowerCase()]!;
    const date = m[3] ? ymd(Number(m[3]), month, Number(m[2])) : noYear(month, Number(m[2]));
    if (date) found.push({ index: m.index!, date });
  }
  return [...new Set(found.sort((a, b) => a.index - b.index).map((item) => item.date))];
}
