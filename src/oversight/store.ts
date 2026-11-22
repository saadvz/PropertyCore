import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../storage/atomicWrite";
import type { ExpectedVisit, Visitor } from "./visits";

/** Remote oversight's record (#240): one `oversight.json` in the property's folder, holding the expected visits. */

export const OVERSIGHT_FILE = "oversight.json";

export interface OversightFile {
  visits: ExpectedVisit[];
  /** The people saved with a visit's phone, and their YES or STOP (#280 17). */
  visitors?: Visitor[];
}

/** oversight.json is there but isn't a readable record. Nothing is written over it. */
export class OversightFileError extends Error {}

export function readOversight(root: string): OversightFile {
  const path = join(root, OVERSIGHT_FILE);
  if (!existsSync(path)) return { visits: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    raw = undefined;
  }
  const unreadable = () => new OversightFileError(`The expected visits record (${OVERSIGHT_FILE}) can't be read, so nothing was changed. Tell the host it needs a look before expected visits can be used.`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw unreadable();
  const visits = (raw as { visits?: unknown }).visits;
  if (visits === undefined) return { visits: [] };
  // A record that parses but isn't the right shape is never read as empty, so it's never written over.
  if (!Array.isArray(visits) || !visits.every(isVisit)) throw unreadable();
  const visitors = (raw as { visitors?: unknown }).visitors;
  if (visitors === undefined) return { visits };
  if (!Array.isArray(visitors) || !visitors.every(isVisitor)) throw unreadable();
  return { visits, visitors };
}

function isVisit(value: unknown): value is ExpectedVisit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.who === "string" && typeof v.date === "string";
}

function isVisitor(value: unknown): value is Visitor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.phone === "string" && typeof v.name === "string" && typeof v.addedAt === "string";
}

export function writeOversight(root: string, file: OversightFile): void {
  writeJsonAtomic(join(root, OVERSIGHT_FILE), file);
}
