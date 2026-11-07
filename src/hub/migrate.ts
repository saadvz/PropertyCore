import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { LEGACY_CALENDAR, type StoredCalendar } from "./calendars";
import { emptyHub, hubPath, type HubFile, type HubProperty } from "./store";

/**
 * Moves a property's details and calendars out of Cleaner Core's cleaner-live.json and Supply Core's
 * supply.json into hub.json, once. hub.json is written first, then the fields are removed from each
 * old file, each write atomic, so a crash at any point is finished by the next open. Once hub.json
 * exists it is the record: an open only removes fields an old file still holds, and merges nothing.
 * The hub reads the old files as plain JSON and never imports either flow.
 */

const CLEANER_FILE = "cleaner-live.json";
const SUPPLY_FILE = "supply.json";

const CLEANER_PLACE = ["nickname", "address", "propertyType", "timeZone", "checkoutTime", "checkInTime"] as const;
const CLEANER_MOVED = [...CLEANER_PLACE, "calendarLink", "calendars", "google", "sourcesDone", "calendarUpload"] as const;
const SUPPLY_MOVED = ["sources", "calendarUpload", "checkouts"] as const;

type Json = Record<string, unknown>;

function readJson(path: string): Json | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);
const record = (value: unknown): Json | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined);

function cleanerHolds(file: Json | undefined): boolean {
  return Boolean(file && CLEANER_MOVED.some((key) => key in file));
}

function supplyHolds(file: Json | undefined): boolean {
  if (!file) return false;
  const settings = record(file.settings);
  const setup = record(file.setup);
  return SUPPLY_MOVED.some((key) => key in file) || Boolean(settings && "property" in settings) || Boolean(setup && "sourcesDone" in setup);
}

/** True when the folder still has something to move or to remove. */
export function folderNeedsMove(root: string): boolean {
  return cleanerHolds(readJson(join(root, CLEANER_FILE))) || supplyHolds(readJson(join(root, SUPPLY_FILE)));
}

interface Side {
  calendars: StoredCalendar[];
  google: boolean;
  done: boolean;
}

function cleanerSide(file: Json): Side {
  const legacy = text(file.calendarLink);
  const named = Array.isArray(file.calendars) ? (file.calendars as Json[]).flatMap((c) => (text(c.name) && text(c.url) ? [{ name: String(c.name), url: String(c.url) }] : [])) : [];
  return { calendars: [...(legacy ? [{ name: LEGACY_CALENDAR, url: legacy, legacy: true as const }] : []), ...named], google: file.google === true, done: file.sourcesDone === true };
}

function supplySide(file: Json): Side {
  const sources = Array.isArray(file.sources) ? (file.sources as Json[]) : [];
  const calendars = sources.flatMap((s) => (s.kind === "ical" && text(s.name) && text(s.url) ? [{ name: String(s.name), url: String(s.url) }] : []));
  return { calendars, google: sources.some((s) => s.kind === "google-calendar"), done: record(file.setup)?.sourcesDone === true };
}

const holds = (side: Side) => side.calendars.length > 0 || side.google;

/** The hub file built from the old files, by the spec's rules. */
function built(cleaner: Json | undefined, supply: Json | undefined, cleaningInUse: boolean): HubFile {
  const hub = emptyHub();
  const property: HubProperty = {};
  if (cleaner) for (const key of CLEANER_PLACE) if (text(cleaner[key])) property[key] = String(cleaner[key]);
  const supplied = record(record(supply?.settings)?.property);
  if (supplied) {
    // Cleaner Core's saved property names itself by its business when it has no nickname, so Supply
    // Core's name fills the nickname only when Cleaner Core never saved a property.
    if (!property.address && text(supplied.name)) property.nickname ??= String(supplied.name);
    if (text(supplied.address)) property.address ??= String(supplied.address);
    if (text(supplied.timeZone)) property.timeZone ??= String(supplied.timeZone);
  }
  hub.property = property;

  const fromCleaner = cleaner ? cleanerSide(cleaner) : { calendars: [], google: false, done: false };
  const fromSupply = supply ? supplySide(supply) : { calendars: [], google: false, done: false };
  let winner: Side;
  let loser: Side | undefined;
  if (holds(fromCleaner) && holds(fromSupply)) {
    winner = cleaningInUse ? fromCleaner : fromSupply;
    loser = cleaningInUse ? fromSupply : fromCleaner;
  } else if (holds(fromSupply)) {
    winner = fromSupply;
  } else {
    winner = { ...fromCleaner, done: fromCleaner.done || fromSupply.done };
  }
  hub.calendars = winner.calendars;
  if (winner.google) hub.google = true;
  if (winner.done) hub.calendarsDone = true;
  if (loser) {
    // Nothing from the other list is added by itself: a new calendar gives Cleaner Core new cleanings.
    const kept = new Set(winner.calendars.map((c) => c.url));
    const aside: StoredCalendar[] = loser.calendars.filter((c) => !kept.has(c.url)).map(({ name, url }) => ({ name, url }));
    if (loser.google && !winner.google) aside.push({ name: "Google Calendar", url: "" });
    if (aside.length > 0) hub.calendarsSetAside = aside;
  }

  const upload = record(cleaner?.calendarUpload);
  if (upload && text(upload.hash) && text(upload.expiresAt) && text(upload.name)) hub.calendarUpload = upload as unknown as HubFile["calendarUpload"];
  const checkouts = record(supply?.checkouts);
  if (checkouts && Array.isArray(checkouts.dates)) hub.checkouts = checkouts as unknown as HubFile["checkouts"];
  return hub;
}

function anythingToKeep(hub: HubFile): boolean {
  return Object.keys(hub.property).length > 0 || hub.calendars.length > 0 || hub.google === true || hub.calendarsDone === true || Boolean(hub.calendarUpload || hub.checkouts || hub.calendarsSetAside);
}

/**
 * Moves the folder's data into hub.json when it has none, then removes the moved fields from the
 * old files. `cleaningInUse` picks the calendar list that wins when both flows saved one.
 */
export function migrateFolder(root: string, cleaningInUse: boolean): void {
  const cleanerPath = join(root, CLEANER_FILE);
  const supplyPath = join(root, SUPPLY_FILE);
  const cleaner = readJson(cleanerPath);
  const supply = readJson(supplyPath);
  if (!cleanerHolds(cleaner) && !supplyHolds(supply)) return;
  if (!existsSync(hubPath(root))) {
    const hub = built(cleaner, supply, cleaningInUse);
    if (anythingToKeep(hub)) writeJsonAtomic(hubPath(root), hub);
  }
  if (cleaner && cleanerHolds(cleaner)) {
    const left = { ...cleaner };
    for (const key of CLEANER_MOVED) delete left[key];
    writeJsonAtomic(cleanerPath, left);
  }
  if (supply && supplyHolds(supply)) {
    const left: Json = { ...supply };
    for (const key of SUPPLY_MOVED) delete left[key];
    const settings = record(left.settings);
    if (settings) {
      const { property: _gone, ...rest } = settings;
      left.settings = rest;
    }
    const setup = record(left.setup);
    if (setup) {
      const { sourcesDone: _done, ...rest } = setup;
      left.setup = rest;
    }
    writeJsonAtomic(supplyPath, left);
  }
}
