import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { DEFAULT_CODES, isRowKind, type ActivityCode, type RowKind } from "./codes";
import type { RowFact } from "./fact";
import { COLUMN_FIELDS, type Column } from "./sheet";

/**
 * The hours log's record: one `hours.json` in the property's folder, beside `fixer.json`. It holds the host's
 * settings and each month's confirmation and export. Never the rows: they are rebuilt from the records.
 */

export const HOURS_FILE = "hours.json";
export const MAX_CODES = 80;
export const MAX_MINUTES = 480;
const MAX_TEXT = 80;

export interface HoursSettings {
  /** The host's codes. Each replaces the placeholder with the same code, or adds one. */
  codes?: ActivityCode[];
  /** The host's code for a row kind, over the placeholder mapping. */
  kindCodes?: Partial<Record<RowKind, string>>;
  /** The host's columns, in their spreadsheet's order. Unset is the issue's twelve. */
  columns?: Column[];
  /** The name on the owner's rows. Unset is the name the group calls the host. */
  ownerName?: string;
  /** The host's spreadsheet, by name or link, in whatever product they use, for the agent to write to. */
  sheet?: string;
}

/** A month the host confirmed: what the rows were, so a change since is caught before export. */
export interface MonthMark {
  confirmedAt: string;
  fingerprint: string;
  rulesVersion: number;
  rows: number;
  /** When the agent said it wrote the month to the host's spreadsheet. */
  exportedAt?: string;
  /** The month's owner facts as they were confirmed, so a replaced record never drops the host's approval. */
  ownerFacts?: RowFact[];
  /** When export_hours last gave the rows out, and which rows: stored: true must follow it. */
  handedOut?: { at: string; fingerprint: string };
  /** The set of row kinds it was confirmed with (codes.ts ROW_KIND_SET). Unset: before #18, so it's built with those kinds only. */
  kindSet?: number;
}

export interface HoursFile {
  settings: HoursSettings;
  /** By month, `YYYY-MM`. */
  months: Record<string, MonthMark>;
}

/** hours.json is there but isn't a readable record. Nothing is written over it. */
export class HoursFileError extends Error {}

export function readHours(root: string): HoursFile {
  const path = join(root, HOURS_FILE);
  if (!existsSync(path)) return { settings: {}, months: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    raw = undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HoursFileError(`The hours log's record (${HOURS_FILE}) can't be read, so nothing was changed. Tell the host it needs a look before the hours log can be used.`);
  const file = raw as Partial<HoursFile>;
  const object = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
  return { settings: object(file.settings) as HoursSettings, months: object(file.months) as Record<string, MonthMark> };
}

export function writeHours(root: string, file: HoursFile): void {
  writeJsonAtomic(join(root, HOURS_FILE), file);
}

/** The placeholders with the host's own codes over them, in order: the host's replace theirs in place. */
export function codeList(settings: HoursSettings): ActivityCode[] {
  const own = settings.codes ?? [];
  const merged = DEFAULT_CODES.map((code) => own.find((mine) => mine.code === code.code) ?? code);
  return [...merged, ...own.filter((mine) => !DEFAULT_CODES.some((code) => code.code === mine.code))];
}

const text = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT;

/** Why these settings can't be saved, or undefined when they can. */
export function checkSettings(settings: HoursSettings): string | undefined {
  if (settings.codes !== undefined) {
    if (!Array.isArray(settings.codes) || settings.codes.length > MAX_CODES) return `Give up to ${MAX_CODES} codes.`;
    const seen = new Set<string>();
    for (const code of settings.codes) {
      if (!code || !text(code.code) || !text(code.group) || !text(code.activity)) return `Each code needs a code, a group and an activity, each 1 to ${MAX_TEXT} characters.`;
      if (seen.has(code.code)) return `The code ${code.code} is in the list twice.`;
      seen.add(code.code);
      if (code.minutes !== undefined && (!Number.isInteger(code.minutes) || code.minutes < 0 || code.minutes > MAX_MINUTES)) return `Give ${code.code}'s minutes as a whole number from 0 to ${MAX_MINUTES}.`;
    }
  }
  if (settings.kindCodes !== undefined) {
    const codes = new Set(codeList(settings).map((code) => code.code));
    for (const [kind, code] of Object.entries(settings.kindCodes)) {
      if (!isRowKind(kind)) return `There's no row kind called ${kind}.`;
      if (typeof code !== "string" || !codes.has(code)) return `There's no code ${String(code)} for ${kind}. Add it to codes first.`;
    }
  }
  if (settings.columns !== undefined) {
    if (!Array.isArray(settings.columns) || settings.columns.length === 0) return "Give at least one column.";
    for (const column of settings.columns) {
      if (!column || !(COLUMN_FIELDS as readonly string[]).includes(column.field)) return `There's no column called ${String(column?.field)}. Use: ${COLUMN_FIELDS.join(", ")}.`;
      if (!text(column.header)) return `Give the ${column.field} column a header of 1 to ${MAX_TEXT} characters.`;
    }
  }
  if (settings.ownerName !== undefined && !text(settings.ownerName)) return `Give the owner's name in 1 to ${MAX_TEXT} characters.`;
  if (settings.sheet !== undefined && (typeof settings.sheet !== "string" || !settings.sheet.trim() || settings.sheet.length > 300)) return "Give the spreadsheet's name or link in 1 to 300 characters.";
  return undefined;
}
