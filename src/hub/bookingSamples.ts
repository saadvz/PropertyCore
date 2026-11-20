import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COUNTED, readBookingEmails, recordBodyHash } from "./bookingEmails";
import { readHubFile } from "./store";

/**
 * Samples for the Vrbo and Booking.com readers (#263). Until those readers exist, their emails go
 * through the Other path. When the host agreed (save_sources shareSamples), the emails they said yes
 * to can be written out with guest names, phone numbers and email addresses replaced. The stored body
 * already has door codes taken out. Saad reads every sample before any goes into test/fixtures/.
 */

export interface BookingSample {
  platform: "vrbo" | "booking";
  kind: "confirmed" | "changed" | "cancelled";
  from: string;
  subject: string;
  body: string;
}

const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}/g;
const HAS_EMAIL = new RegExp(EMAIL.source);
/** A phone number with separators, like +1 (555) 555-0199 or +44 20 7946 0958. A bare run of digits is a booking number and stays. */
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{2,4}[\s.-]\d{3,4}\b/g;
const NAME_LABEL = /^(\s*(?:guest name|guest|name|traveler|traveller|booker|booked by|primary guest|lead guest|contact|reserved by)\s*:)\s*(\S.*)$/i;
const NAME_LABEL_ALONE = /^\s*(?:guest name|guest|name|traveler|traveller|booker|booked by|primary guest|lead guest|contact|reserved by)\s*:?\s*$/i;
const NAME_REMOVED = "[name removed]";

/** The names on labeled lines, for removing them wherever else they appear. */
function labeledNames(text: string): string[] {
  const names: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const labeled = NAME_LABEL.exec(lines[i]!);
    if (labeled) names.push(labeled[2]!.trim());
    else if (NAME_LABEL_ALONE.test(lines[i]!)) {
      const next = lines.slice(i + 1).find((line) => line.trim() !== "");
      if (next) names.push(next.trim());
    }
  }
  return names.filter((name) => !HAS_EMAIL.test(name));
}

/** Replaces email addresses, phone numbers and guest names. `names` are removed too, word by word. */
export function redactSample(text: string, names: readonly string[] = labeledNames(text)): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const labeled = NAME_LABEL.exec(lines[i]!);
    if (labeled) lines[i] = `${labeled[1]} ${NAME_REMOVED}`;
    else if (NAME_LABEL_ALONE.test(lines[i]!)) {
      const next = lines.findIndex((line, j) => j > i && line.trim() !== "");
      if (next > i) lines[next] = NAME_REMOVED;
    }
  }
  return removeNames(lines.join("\n").replace(EMAIL, "[email removed]").replace(PHONE, "[phone removed]"), names);
}

/** Removes each word of these names wherever it appears, and nothing else. */
function removeNames(text: string, names: readonly string[]): string {
  let out = text;
  const words = new Set(names.flatMap((name) => name.split(/\s+/)).filter((word) => /^[\p{L}][\p{L}'-]+$/u.test(word)));
  for (const word of words) out = out.replace(new RegExp(`(?<![\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "gu"), NAME_REMOVED);
  return out;
}

/** The emails that may become samples: Vrbo's and Booking.com's that the host said yes to, on a property whose host agreed. */
export function sampleRecords(root: string): BookingSample[] {
  if (readHubFile(root)?.shareSamples !== true) return [];
  const seen = new Set<string>();
  const out: BookingSample[] = [];
  for (const record of readBookingEmails(root)) {
    const platform = record.parsed?.platform;
    if ((platform !== "vrbo" && platform !== "booking") || record.hostConfirmed !== true || !COUNTED.has(record.outcome) || !record.body) continue;
    const key = record.messageId ?? `${record.from}\n${record.subject}\n${recordBodyHash(record)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const names = labeledNames(record.body);
    out.push({ platform, kind: record.parsed!.kind, from: removeNames(record.from, names), subject: redactSample(record.subject, names), body: redactSample(record.body, names) });
  }
  return out;
}

/** Writes each sample as test/fixtures expects one (From, Subject, a blank line, the body). Returns how many. */
export function writeSamples(root: string, outDir: string): number {
  const samples = sampleRecords(root);
  if (samples.length === 0) return 0;
  mkdirSync(outDir, { recursive: true });
  const counts = new Map<string, number>();
  for (const sample of samples) {
    const stem = `${sample.platform}-${sample.kind}`;
    const n = (counts.get(stem) ?? 0) + 1;
    counts.set(stem, n);
    writeFileSync(join(outDir, `${stem}-${n}.txt`), `From: ${sample.from}\nSubject: ${sample.subject}\n\n${sample.body}\n`, { encoding: "utf8", mode: 0o600 });
  }
  return samples.length;
}
