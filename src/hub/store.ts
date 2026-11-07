import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StoredCalendar } from "./calendars";

/** One property's hub file: its details and booking calendars, shared by every flow. */

export const HUB_FILE = "hub.json";

/** Who asked for an upload link. Cleaner Core's caller fits it. */
export interface HubCaller {
  assistant: string;
  connectionId?: string;
}

export interface HubProperty {
  nickname?: string;
  address?: string;
  propertyType?: string;
  timeZone?: string;
  /** "HH:MM" */
  checkoutTime?: string;
  checkInTime?: string;
}

export interface HubFile {
  schemaVersion: 1;
  property: HubProperty;
  /** In dedupe order. The legacy single Guesty Lite link is the first entry, with legacy: true. */
  calendars: StoredCalendar[];
  google?: boolean;
  /** The host said there are no more booking calendars to add. */
  calendarsDone?: boolean;
  /** The pending upload link: the sha256 of its code, never the code or the link. */
  calendarUpload?: { hash: string; expiresAt: string; name: string; by?: HubCaller };
  /** Checkout dates from the last read where every calendar read cleanly. */
  checkouts?: { dates: string[]; at?: string; failedAt?: string };
  /** Calendars only one flow had when the data moved. Never read; names shown, links never. */
  calendarsSetAside?: StoredCalendar[];
}

export function emptyHub(): HubFile {
  return { schemaVersion: 1, property: {}, calendars: [] };
}

export function hubPath(root: string): string {
  return join(root, HUB_FILE);
}

export function readHubFile(root: string): HubFile | undefined {
  const path = hubPath(root);
  if (!existsSync(path)) return undefined;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<HubFile>;
  return { ...emptyHub(), ...raw, property: raw.property ?? {}, calendars: raw.calendars ?? [] };
}
