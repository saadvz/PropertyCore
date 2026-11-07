import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { writeJsonAtomic } from "../storage/atomicWrite";
import {
  CALENDAR_COUNT_REFUSED,
  CALENDAR_NAME_LONG,
  MAX_CALENDAR_NAME,
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
import { interpretFeed } from "./calendar";
import { calendarFetch } from "./calendarFetch";
import { calendarUrlAllowed, readPublicCalendar } from "./fetchLimits";
import { googleCalendarSource, type GoogleEventList, type SourceSnapshot } from "./sources";
import { folderNeedsMove, migrateFolder } from "./migrate";
import { HUB_CALENDAR_PREFIX } from "./paths";
import { emptyHub, hubPath, readHubFile, type HubCaller, type HubFile, type HubProperty } from "./store";

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
  /** The upcoming cleanings this calendar list would call off, by checkout date. */
  wouldCancel(next: CalendarClaim[]): Promise<string[]>;
}

export interface HubDeps {
  now(): Date;
  /**
   * Which calendar list wins when both flows saved one and the data moves on this open. The shared
   * service moves every property at startup with its own cleaning switch; a single folder runs
   * Cleaner Core, so its list wins by default.
   */
  migrate?: { cleaningInUse: boolean };
}

export type HubSave = { ok: true } | { ok: false; error: string; reason: CalendarRefusal };

export const UPLOAD_MINUTES = 10;
export const UPLOAD_GONE = "This upload link isn't valid anymore. Ask for a new one.";
export const CALENDAR_UPLOAD_REFUSED = "Send the calendar's public https link as url.";
export const CALENDAR_UPLOAD_SAVED = "Saved the calendar link.";
export const wouldCallOff = (count: number) =>
  `Removing that calendar would call off ${count} upcoming ${count === 1 ? "cleaning" : "cleanings"}. Ask the host, then save again with dropJobs: true.`;

export interface UploadResult {
  status: 200 | 400 | 404 | 409;
  body: { ok: boolean; message?: string; error?: string };
}

function uploadHash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Compares two sha256 hex digests in constant time. */
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
}

/** One read of every saved calendar, for each flow to use its own way. */
export interface HubRead {
  links: { calendar: SavedCalendar; read: { ok: true; body: string } | { ok: false; reason: string } }[];
  /** Undefined when Google isn't saved, no events were passed, or the events read as nothing. */
  google?: SourceSnapshot;
  /** Events were passed, but none of them reads as a stay or a block: a shape this reader doesn't know. */
  googleUnread: boolean;
}

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
    if (folderNeedsMove(root)) migrateFolder(root, deps.migrate?.cleaningInUse ?? true);
    this.file = readHubFile(root) ?? emptyHub();
  }

  property(): HubProperty {
    return { ...this.file.property };
  }

  /** Saves the given details. A field passed as undefined is left as it is; a field in `clear` is removed. */
  saveProperty(details: Partial<HubProperty>, clear: readonly (keyof HubProperty)[] = []): void {
    const next = { ...this.file.property };
    for (const [key, value] of Object.entries(details) as [keyof HubProperty, string | undefined][]) {
      if (value !== undefined) next[key] = value;
    }
    for (const key of clear) delete next[key];
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
   * Makes the one-time upload link for one calendar, saved under `name`. Only the code's sha256, its
   * expiry, and the name are kept. A new link replaces the last one, whichever flow asked.
   * google: true is saved now. `base` is the asking flow's public base for this property.
   */
  issueCalendarUpload(input: { name: string; google?: boolean; base: string; by?: HubCaller }): { uploadUrl: string; expiresInMinutes: number } | { error: string } {
    const name = input.name.trim();
    if (name.length > MAX_CALENDAR_NAME) return { error: CALENDAR_NAME_LONG };
    if (this.carriesCode(name)) return { error: DOOR_CODE_IN_CHAT };
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = randomBytes(32).toString("base64url");
      const uploadUrl = `${input.base}${HUB_CALENDAR_PREFIX}${code}`;
      // A link that happens to carry the door code is never handed out.
      if (this.carriesCode(uploadUrl, true)) continue;
      const expiresAt = new Date(this.deps.now().getTime() + UPLOAD_MINUTES * 60_000).toISOString();
      this.file = { ...this.file, calendarUpload: { hash: uploadHash(code), expiresAt, name, ...(input.by ? { by: input.by } : {}) }, ...(input.google === true ? { google: true } : {}) };
      this.save();
      return { uploadUrl, expiresInMinutes: UPLOAD_MINUTES };
    }
    return { error: "That didn't work. Try again." };
  }

  /** True while the link with this code waits and hasn't expired. Reads only; opening the page never uses it up. */
  uploadLinkOpen(code: string): { open: boolean; name?: string; by?: HubCaller } {
    const pending = this.pending(code);
    if (!pending || this.expired(pending)) return { open: false };
    return { open: true, name: pending.name, ...(pending.by ? { by: pending.by } : {}) };
  }

  /**
   * Saves a calendar link posted to its upload link. A link under the same name replaces that one,
   * and every other calendar stays. Only a save uses the link up. The link is never repeated or logged.
   */
  async uploadCalendarLink(code: string, body: Record<string, unknown>): Promise<UploadResult> {
    const pending = this.pending(code);
    if (!pending) return { status: 404, body: { ok: false, error: UPLOAD_GONE } };
    if (this.expired(pending)) {
      this.dropUpload();
      return { status: 404, body: { ok: false, error: UPLOAD_GONE } };
    }
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url || url.length > 2000 || !calendarUrlAllowed(url)) return { status: 400, body: { ok: false, error: CALENDAR_UPLOAD_REFUSED } };
    const wanted = pending.name.toLowerCase();
    const at = this.file.calendars.findIndex((calendar) => calendar.name.toLowerCase() === wanted);
    const next = at >= 0
      ? this.file.calendars.map((calendar, i) => (i === at ? { name: calendar.name, url } : { ...calendar }))
      : [...this.file.calendars.map((calendar) => ({ ...calendar })), { name: pending.name, url }];
    const refused = this.refusal(next);
    if (refused) return { status: 400, body: { ok: false, error: refused.reason === "count" ? refused.error : CALENDAR_UPLOAD_REFUSED } };
    const guards = this.guards();
    if (guards) {
      const lost = await guards.wouldCancel(this.claims(next));
      if (lost.length > 0) return { status: 409, body: { ok: false, error: wouldCallOff(lost.length) } };
    }
    // Something else may have used or replaced the link while the guard ran.
    if (this.pending(code)?.hash !== pending.hash) return { status: 404, body: { ok: false, error: UPLOAD_GONE } };
    const saved = this.setCalendars({ calendars: next });
    if (!saved.ok) return { status: 400, body: { ok: false, error: CALENDAR_UPLOAD_REFUSED } };
    this.dropUpload();
    return { status: 200, body: { ok: true, message: CALENDAR_UPLOAD_SAVED } };
  }

  /**
   * Reads every saved calendar now, and Google from the events the agent passed when Google is saved.
   * When every one read cleanly, keeps their checkout dates; otherwise notes the failure and keeps
   * the last good dates. The links are never returned in a reason or logged.
   */
  async readCalendars(input: { googleEvents?: GoogleEventList; tenantId: string }): Promise<HubRead> {
    const calendars = this.calendars();
    const googleSaved = this.google();
    let google: SourceSnapshot | undefined;
    let googleUnread = false;
    if (googleSaved && input.googleEvents) {
      google = await googleCalendarSource(input.googleEvents, input.tenantId).read();
      if (input.googleEvents.items.length > 0 && google.turnovers.length === 0 && google.blocks.length === 0) {
        google = undefined;
        googleUnread = true;
      }
    }
    const links = await Promise.all(calendars.map(async (calendar) => ({ calendar, read: await readPublicCalendar(calendar.url, calendarFetch()) })));
    if (calendars.length === 0 && !googleSaved) return { links, googleUnread };
    const all = links.every((link) => link.read.ok) && (!googleSaved || google !== undefined);
    const last = this.file.checkouts;
    const at = this.deps.now().toISOString();
    if (all) {
      const dates = new Set<string>();
      for (const link of links) if (link.read.ok) for (const turn of interpretFeed(link.read.body).turnovers) dates.add(turn.checkoutDate);
      for (const turn of google?.turnovers ?? []) dates.add(turn.checkoutDate);
      this.file = { ...this.file, checkouts: { dates: [...dates].sort(), at } };
    } else {
      this.file = { ...this.file, checkouts: { dates: last?.dates ?? [], ...(last?.at ? { at: last.at } : {}), failedAt: at } };
    }
    this.save();
    return { links, ...(google ? { google } : {}), googleUnread };
  }

  /** Checkout dates from the last read where every calendar read cleanly. */
  checkouts(): { dates: string[]; at?: string; failedAt?: string } | undefined {
    const checkouts = this.file.checkouts;
    return checkouts ? { ...checkouts, dates: [...checkouts.dates] } : undefined;
  }

  private pending(code: string): NonNullable<HubFile["calendarUpload"]> | undefined {
    const pending = this.file.calendarUpload;
    return pending && sameHash(uploadHash(code), pending.hash) ? pending : undefined;
  }

  private expired(pending: NonNullable<HubFile["calendarUpload"]>): boolean {
    return this.deps.now().getTime() >= Date.parse(pending.expiresAt);
  }

  private dropUpload(): void {
    const { calendarUpload: _gone, ...rest } = this.file;
    this.file = rest;
    this.save();
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

  /** Forgets everything the hub holds and removes hub.json. Memory is cleared even if the delete fails. */
  clear(): void {
    this.file = emptyHub();
    rmSync(hubPath(this.root), { force: true });
  }

  protected save(): void {
    mkdirSync(this.root, { recursive: true });
    writeJsonAtomic(hubPath(this.root), this.file);
  }
}
