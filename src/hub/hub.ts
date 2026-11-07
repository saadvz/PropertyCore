import { mkdirSync } from "node:fs";
import { writeJsonAtomic } from "../storage/atomicWrite";
import {
  CALENDAR_COUNT_REFUSED,
  calendarRefusal,
  claimsOf,
  DOOR_CODE_IN_CHAT,
  MAX_CALENDARS,
  savedCalendars,
  type CalendarClaim,
  type CalendarRefusal,
  type SavedCalendar,
  type StoredCalendar,
} from "./calendars";
import { emptyHub, hubPath, readHubFile, type HubFile, type HubProperty } from "./store";

/**
 * One property's hub: its details and booking calendars, kept in hub.json in the property's folder.
 * Cleaner Core and Supply Core both read it. Reads and writes are synchronous on an in-memory copy,
 * so a write never interleaves with another; the only awaits are calendar reads and the
 * wouldCancel guard, and after either the state is read again before anything is written.
 */

/** Checks Cleaner Core plugs in while it runs on the property. The hub never imports Cleaner Core. */
export interface HubGuards {
  /** True when a calendar name or link carries the door code. */
  carriesCode(text: string): boolean;
  /** The upcoming cleanings this calendar list would call off. */
  wouldCancel(next: CalendarClaim[]): Promise<string[]>;
}

export interface HubDeps {
  now(): Date;
}

export type HubSave = { ok: true } | { ok: false; error: string; reason: CalendarRefusal };

const hubs = new Map<string, Hub>();

/** The property folder's hub, one per folder. */
export function hubFor(root: string, deps: HubDeps): Hub {
  const existing = hubs.get(root);
  if (existing) return existing;
  const hub = new Hub(root, deps);
  hubs.set(root, hub);
  return hub;
}

/** Drops one folder's hub, so nothing keeps working on a folder that is being removed. */
export function forgetHub(root: string): void {
  hubs.delete(root);
}

export function resetHubs(): void {
  hubs.clear();
}

export class Hub {
  protected file: HubFile;
  private guards: () => HubGuards | undefined = () => undefined;

  constructor(
    readonly root: string,
    protected readonly deps: HubDeps,
  ) {
    this.file = readHubFile(root) ?? emptyHub();
  }

  property(): HubProperty {
    return { ...this.file.property };
  }

  /** Saves the given details. A field passed as undefined is left as it is. */
  saveProperty(details: Partial<HubProperty>): void {
    const next = { ...this.file.property };
    for (const [key, value] of Object.entries(details) as [keyof HubProperty, string | undefined][]) {
      if (value !== undefined) next[key] = value;
    }
    this.file = { ...this.file, property: next };
    this.save();
  }

  stored(): StoredCalendar[] {
    return this.file.calendars.map((calendar) => ({ ...calendar }));
  }

  calendars(): SavedCalendar[] {
    return savedCalendars(this.file.calendars);
  }

  google(): boolean {
    return this.file.google === true;
  }

  calendarsDone(): boolean {
    return this.file.calendarsDone === true;
  }

  /** The engine's claims for a calendar list, the saved one by default. */
  claims(list: readonly StoredCalendar[] = this.file.calendars, google = this.google()): CalendarClaim[] {
    return claimsOf(list, google);
  }

  /** Cleaner Core's checks, asked for each time they're used, so a flow switched off stops guarding. */
  useGuards(provider: () => HubGuards | undefined): void {
    this.guards = provider;
  }

  /** The names of calendars set aside when the data moved. Never their links. */
  setAside(): string[] {
    return (this.file.calendarsSetAside ?? []).map((calendar) => calendar.name);
  }

  clearSetAside(): void {
    if (!this.file.calendarsSetAside) return;
    const { calendarsSetAside: _gone, ...rest } = this.file;
    this.file = rest;
    this.save();
  }

  /**
   * Saves the calendar list, Google, and done. Never asks wouldCancel: Cleaner Core asks it itself
   * before saving, from inside its own queue. Any save clears the set-aside list.
   */
  setCalendars(input: { calendars?: StoredCalendar[]; google?: boolean; done?: boolean }): HubSave {
    if (input.calendars !== undefined) {
      const refused = this.refusal(input.calendars);
      if (refused) return refused;
    }
    const next: HubFile = { ...this.file };
    if (input.calendars !== undefined) next.calendars = input.calendars.map((calendar) => ({ ...calendar, name: calendar.name.trim(), url: calendar.url.trim() }));
    if (input.google === true) next.google = true;
    if (input.google === false) delete next.google;
    if (input.done === true) next.calendarsDone = true;
    delete next.calendarsSetAside;
    this.file = next;
    this.save();
    return { ok: true };
  }

  /** Why a calendar list can't be saved, or undefined. */
  protected refusal(list: readonly StoredCalendar[]): Extract<HubSave, { ok: false }> | undefined {
    if (list.length > MAX_CALENDARS) return { ok: false, reason: "count", error: CALENDAR_COUNT_REFUSED };
    for (const calendar of list) {
      const name = calendar.name.trim();
      const url = calendar.url.trim();
      const refused = calendarRefusal(name, url);
      if (refused) return { ok: false, ...refused };
      if (this.carriesCode(name) || this.carriesCode(url, true)) return { ok: false, reason: "code", error: DOOR_CODE_IN_CHAT };
    }
    return undefined;
  }

  /**
   * The door-code check. With Cleaner Core's guard connected, its check. Without it, a name with a
   * run of 4 or more digits is refused, as Cleaner Core does when it can't open the sealed code.
   */
  protected carriesCode(text: string, isLink = false): boolean {
    const guards = this.guards();
    if (guards) return guards.carriesCode(text);
    return !isLink && /\d{4,}/.test(text.replace(/[\s.-]/g, ""));
  }

  protected save(): void {
    mkdirSync(this.root, { recursive: true });
    writeJsonAtomic(hubPath(this.root), this.file);
  }
}
