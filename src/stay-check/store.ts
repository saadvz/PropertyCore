import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../storage/atomicWrite";
import type { CheckKind, HouseRule } from "./rules";

/**
 * The nightly stay check's record (#239): one `stay-check.json` in the property's folder. It holds the host's
 * own house rules, their check time, per-stay allowances, and how many sightings each kind needs after false flags.
 */

export const STAY_CHECK_FILE = "stay-check.json";

export interface StayAllowance {
  /** The stay's check-in date, `YYYY-MM-DD`, as the hub's calendar has it. */
  checkIn: string;
  allow: CheckKind[];
}

export interface StayCheckFile {
  rules: HouseRule[];
  /** "HH:MM", the host's pick. Unset is 23:00. */
  checkTime?: string;
  rulesSavedAt?: string;
  /** Sightings needed per kind before it flags. Unset is 1. */
  sightings: Partial<Record<CheckKind, number>>;
  allowances: StayAllowance[];
}

/** stay-check.json is there but isn't a readable record. Nothing is written over it. */
export class StayCheckFileError extends Error {}

export function readStayCheck(root: string): StayCheckFile {
  const path = join(root, STAY_CHECK_FILE);
  if (!existsSync(path)) return { rules: [], sightings: {}, allowances: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    raw = undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new StayCheckFileError(`The house rules record (${STAY_CHECK_FILE}) can't be read, so nothing was changed. Tell the host it needs a look before the nightly check can be used.`);
  }
  const file = raw as Partial<StayCheckFile>;
  const object = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
  return {
    rules: Array.isArray(file.rules) ? file.rules : [],
    ...(typeof file.checkTime === "string" ? { checkTime: file.checkTime } : {}),
    ...(typeof file.rulesSavedAt === "string" ? { rulesSavedAt: file.rulesSavedAt } : {}),
    sightings: object(file.sightings) as StayCheckFile["sightings"],
    allowances: Array.isArray(file.allowances) ? file.allowances : [],
  };
}

export function writeStayCheck(root: string, file: StayCheckFile): void {
  writeJsonAtomic(join(root, STAY_CHECK_FILE), file);
}
