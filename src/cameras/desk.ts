import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zonedParts } from "../core/timezone";
import { stayForNight } from "../hub/bookingEmails";
import { addCalendarDays, zonedInstant } from "../hub/calendar";
import { readHubFile, type HubFile } from "../hub/store";
import type { NightResult } from "../stay-check/check";
import { stayCheckDeskFor, type StayCheckDesk } from "../stay-check/desk";
import { readStayCheck } from "../stay-check/store";
import { readCameras, writeCameras, type CamerasFile, type PickedCamera } from "./accounts";
import { CameraProviderError, type AccountRef, type CameraDevice, type CameraProvider } from "./adapter";
import { dueCameraNotes, type CameraNote } from "./health";
import { isCameraEvent, type EventLog } from "./lines";
import { CLIP_AFTER_MS, CLIP_BEFORE_MS, stayEventsFrom } from "./night";
import { stayTimeline, timelineText } from "./timeline";

/**
 * One property's cameras (#239): the night's check on its camera events, which events fall in a stay, offline
 * notes, the stay timeline, and pinning a clip as evidence. It texts nobody: notes go back to the caller, which
 * reaches the host through the account's alerts routine.
 */

export interface CameraReply {
  text: string;
  structured?: Record<string, unknown>;
  isError: boolean;
}

export interface CameraDeskDeps {
  log: EventLog;
  provider?: CameraProvider;
  account?: AccountRef;
  now: () => Date;
  /** The property's name, for notes and alerts. */
  label: string;
  /** The service's own counter: the night's check and the timeline read only its counts. Unset, the newest count per event. */
  counter?: string;
}

const ok = (structured: Record<string, unknown>): CameraReply => ({ text: JSON.stringify(structured), structured, isError: false });
const fail = (text: string): CameraReply => ({ text, isError: true });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TOLD = 200;

export class CameraDesk {
  private readonly stays: StayCheckDesk;

  constructor(
    private readonly root: string,
    private readonly deps: CameraDeskDeps,
  ) {
    this.stays = stayCheckDeskFor(root, { now: deps.now });
  }

  private hub(): HubFile | undefined {
    try {
      return readHubFile(this.root);
    } catch {
      return undefined;
    }
  }

  cameras(): CamerasFile {
    return readCameras(this.root);
  }

  /** One night of a stay against the property's camera events. Sends nothing. */
  runNight(date: string): NightResult {
    const window = this.stays.nightWindow(date);
    const events = window ? stayEventsFrom(this.deps.log.read(), window, this.deps.counter) : [];
    return this.stays.runNight(date, events, this.deps.label);
  }

  /** Whether a time falls in a night of a stay that has a house rule the cameras can watch: only those are counted. */
  inStay(at: string): boolean {
    const timeZone = this.hub()?.property.timeZone;
    if (!timeZone) return false;
    try {
      if (!readStayCheck(this.root).rules.some((rule) => rule.check && rule.check.kind !== "quiet")) return false;
    } catch {
      return false;
    }
    const when = Date.parse(at);
    const { year, month, day } = zonedParts(new Date(when), timeZone);
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return [date, addCalendarDays(date, -1)].some((night) => {
      const window = this.stays.nightWindow(night);
      return !!window && when >= Date.parse(window.from) && when < Date.parse(window.to);
    });
  }

  /** The stay night a time belongs to, for the counting cap: its local date, before noon counted with the night before. */
  nightOf(at: string): string {
    const timeZone = this.hub()?.property.timeZone ?? "UTC";
    const { year, month, day, hour } = zonedParts(new Date(at), timeZone);
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return hour < 12 ? addCalendarDays(date, -1) : date;
  }

  /**
   * Saves the host's picks: which of the account's cameras belong to this property. Each must be one the account
   * has, and the host must have said it's outdoors. The list replaces the last one; an empty list picks none.
   */
  pick(input: { cameras?: unknown }, available: readonly CameraDevice[]): CameraReply {
    if (!Array.isArray(input.cameras)) return fail("Give the cameras as a list of { deviceId, outdoor: true }.");
    const file = this.cameras();
    const now = this.deps.now().toISOString();
    const picked: PickedCamera[] = [];
    for (const raw of input.cameras as unknown[]) {
      const entry = raw && typeof raw === "object" ? (raw as { deviceId?: unknown; outdoor?: unknown }) : {};
      const device = available.find((camera) => camera.id === entry.deviceId);
      if (!device) return fail("One of those cameras isn't on the host's account. Use the deviceId from the list.");
      if (entry.outdoor !== true) return fail(`Ask the host whether "${device.name}" is outdoors. Only outdoor cameras can be used; indoor cameras never are.`);
      if (!picked.some((camera) => camera.deviceId === device.id)) picked.push({ deviceId: device.id, name: device.name, outdoor: true as const, pickedAt: file.cameras.find((camera) => camera.deviceId === device.id)?.pickedAt ?? now });
    }
    writeCameras(this.root, { ...file, cameras: picked });
    return ok({ saved: true, cameras: picked.map(({ deviceId, name }) => ({ deviceId, name })), next: picked.length ? "Saved. Events from these cameras are kept from now on, and the nightly check reads them." : "Saved. No camera is read for this property now." });
  }

  /** Forgets the property's camera picks. Stored lines stay: the log is append-only. */
  forget(): void {
    const file = this.cameras();
    writeCameras(this.root, { cameras: [], ...(file.told ? { told: file.told } : {}) });
  }

  /** Notes kept for the host's next chat, when nothing else delivered them. Given once. */
  queueNotes(notes: readonly CameraNote[]): void {
    if (!notes.length) return;
    const file = this.cameras();
    writeCameras(this.root, { ...file, waiting: [...(file.waiting ?? []), ...notes].slice(-50) });
  }

  takeWaiting(): CameraNote[] {
    const file = this.cameras();
    if (!file.waiting?.length) return [];
    const { waiting, ...rest } = file;
    writeCameras(this.root, rest);
    return waiting;
  }

  /** Offline and back-online notes due now, each given once. */
  takeNotes(): CameraNote[] {
    const file = this.cameras();
    const timeZone = this.hub()?.property.timeZone;
    const notes = dueCameraNotes(this.deps.log.read(), file.cameras, this.deps.now(), { label: this.deps.label, ...(timeZone ? { timeZone } : {}), told: file.told ?? [] });
    if (notes.length) writeCameras(this.root, { ...file, told: [...(file.told ?? []), ...notes.map((note) => note.id)].slice(-MAX_TOLD) });
    return notes;
  }

  /** The stay that checks in on `checkIn`, from its check-in time to its checkout time, as a timeline. */
  timeline(input: { checkIn?: unknown }): CameraReply {
    if (typeof input.checkIn !== "string" || !DATE.test(input.checkIn)) return fail("Give the stay's check-in date as YYYY-MM-DD.");
    const hub = this.hub();
    const timeZone = hub?.property.timeZone;
    if (!hub || !timeZone) return fail("The property has no time zone, so its stays can't be laid out.");
    const stay = (hub.stays ?? []).find((entry) => entry.kind === "stay" && entry.checkIn === input.checkIn);
    if (!stay) return fail(`No stay on the calendar checks in ${input.checkIn}.`);
    const email = stayForNight(this.root, stay.checkIn);
    const checkInTime = (email?.checkIn === stay.checkIn ? email.checkInTime : undefined) ?? hub.property.checkInTime ?? "16:00";
    const checkoutTime = (email?.checkout === stay.checkout ? email.checkoutTime : undefined) ?? hub.property.checkoutTime ?? "11:00";
    const window = { from: zonedInstant(stay.checkIn, checkInTime, timeZone), to: zonedInstant(stay.checkout, checkoutTime, timeZone) };
    const entries = stayTimeline(this.deps.log.read(), window, timeZone, this.deps.counter);
    return ok({ checkIn: stay.checkIn, checkout: stay.checkout, window, entries, text: timelineText(this.deps.label, entries, timeZone), next: "Any camera entry's clip can be kept as evidence with pin_clip. Nothing else is copied." });
  }

  /** Copies one clip into the property's evidence/ folder and logs the pin. The only video Property Core keeps. */
  async pin(input: { eventId?: unknown }): Promise<CameraReply> {
    const { provider, account } = this.deps;
    if (!provider || !account) return fail("No camera account is connected for this property.");
    const event = this.deps.log.read().filter(isCameraEvent).find((line) => line.id === input.eventId);
    if (!event) return fail("No camera event has that id. Take the id from stay_timeline.");
    const at = Date.parse(event.at);
    const ref = { deviceId: event.deviceId, from: new Date(at - CLIP_BEFORE_MS).toISOString(), until: new Date(at + CLIP_AFTER_MS).toISOString() };
    let clip: Uint8Array;
    try {
      clip = await provider.clip(account, ref);
    } catch (error) {
      return fail(error instanceof CameraProviderError ? error.message : "The clip couldn't be fetched.");
    }
    // Named from a hash of the event id, so two events never share a file and nothing pinned is written over.
    const file = `evidence/clip-${createHash("sha256").update(event.id).digest("hex").slice(0, 32)}.mp4`;
    mkdirSync(join(this.root, "evidence"), { recursive: true });
    writeFileSync(join(this.root, file), clip, { mode: 0o600 });
    try {
      chmodSync(join(this.root, file), 0o600);
    } catch {
      // Not every filesystem keeps modes.
    }
    this.deps.log.append({ type: "camera-pin", id: `pin:${event.id}`, at: this.deps.now().toISOString(), event: event.id, deviceId: event.deviceId, from: ref.from, until: ref.until, file });
    return ok({ pinned: true, eventId: event.id, file, from: ref.from, until: ref.until, next: "Kept as evidence for this property. Tell the host it's saved." });
  }
}
