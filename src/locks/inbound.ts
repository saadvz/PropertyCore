import type { DoorAccess, GrantFlow, GrantNote } from "../hub/doorAccess";
import { visitLogFor } from "../visits/store";
import type { LockAdapter, LockWebhookEvent } from "./adapter";
import { lockLines, recordLockEvent } from "./eventLog";
import type { DoorLocksFile } from "./settings";

/**
 * What one verified lock event changes on its property, and what the host hears. The event is stored
 * first, as received; then a code's status, a backup code, and each alert, told once by its key. No
 * note holds a code, and none names the lock partner.
 */

export const OFFLINE_ALERT_MS = 30 * 60_000;

function who(label: string | undefined, flow: GrantRef["flow"]): string {
  return label?.trim() || (flow === "cleaning" ? "the cleaner" : flow === "repair" ? "the pro" : flow === "guest" ? "the guest" : flow === "bring-in" ? "the person bringing the package in" : "they");
}

/** Marks an alert told. False when it was already. */
function once(file: DoorLocksFile, key: string): boolean {
  const told = (file.told ??= []);
  if (told.includes(key)) return false;
  told.push(key);
  // The newest 500 keys are enough to keep each alert to once.
  if (told.length > 500) told.splice(0, told.length - 500);
  return true;
}

/** Which Property Core code an event names, never the code. */
export interface GrantRef {
  flow: GrantFlow;
  jobId: string;
  backup?: boolean;
}

export interface InboundResult {
  stored: boolean;
  notes: GrantNote[];
  /** The grant whose code opened the door, for an unlock with a Property Core code. */
  unlockedBy?: GrantRef;
}

/**
 * Applies one verified event to the property. `adapter` makes a fresh connect link when the lock
 * account was disconnected. Returns the notes for the host, each with a stable id.
 */
export async function applyLockEvent(door: DoorAccess, adapter: LockAdapter, event: LockWebhookEvent, now: Date, timeZone?: string): Promise<InboundResult> {
  const file = door.locks();
  const device = event.deviceId ? file.devices.find((item) => item.id === event.deviceId) : undefined;
  const ref = event.codeId ? door.grants().grantOf(event.codeId) : undefined;
  const grant: GrantRef | undefined = ref ? { flow: ref.flow, jobId: ref.jobId, ...(ref.backup ? { backup: true } : {}) } : undefined;
  const recorded = recordLockEvent(door.root, event, { ...(device ? { deviceName: device.name } : {}), ...(ref ? { codeName: ref.codeName } : {}), now: () => now });
  // A resent event changes nothing twice.
  if (recorded === "duplicate") return { stored: false, notes: [] };
  const stored = recorded === "new";
  const notes: GrantNote[] = [];
  const door_ = device?.name ?? "a door";
  switch (event.kind) {
    case "code-set": {
      if (event.codeId) door.grants().markDevice(event.codeId, "set");
      break;
    }
    case "code-removed": {
      if (event.codeId) door.grants().markDevice(event.codeId, "removed");
      break;
    }
    case "code-failed": {
      if (!event.codeId || !ref || ref.backup) break;
      const info = door.grants().markDevice(event.codeId, "failed");
      const person = who(info?.label, ref.flow);
      const ready = await door.grants().backupNow(event.codeId);
      // A guest's or standing code never falls back to the host's saved code.
      const ownOnly = ref.flow === "guest" || ref.flow === "standing";
      notes.push({
        id: `lock:failed:${event.codeId}`,
        jobId: ref.jobId,
        urgent: true,
        text: ready
          ? `The ${door_} didn't take ${person}'s code. A backup code for that door is ready, and ${person} gets it with their code.`
          : ownOnly
            ? `The ${door_} didn't take ${person}'s code, and it has no backup code left. Let them in another way.`
            : `The ${door_} didn't take ${person}'s code, and it has no backup code left. If you saved your own door code, ${person} gets that; otherwise let them in yourself.`,
      });
      break;
    }
    case "backup-low": {
      if (device && once(file, `backup-low:${device.id}`)) notes.push({ id: `lock:backup-low:${device.id}:${event.id}`, text: `The ${door_} is running out of backup codes. Open the lock's own app to add more.` });
      break;
    }
    case "battery-low": {
      if (device) {
        if (typeof event.battery === "number") device.battery = event.battery;
        if (once(file, `battery-low:${device.id}`)) notes.push({ id: `lock:battery-low:${device.id}:${event.id}`, text: `The ${door_}'s battery is low. Change it soon, so no code stops working.` });
      }
      break;
    }
    case "offline": {
      if (device) {
        device.online = false;
        device.offlineSince ??= event.at;
      }
      break;
    }
    case "online": {
      if (device) {
        const since = device.offlineSince;
        device.online = true;
        delete device.offlineSince;
        if (since && file.told?.includes(`offline:${device.id}:${since}`)) notes.push({ id: `lock:online:${device.id}:${since}`, text: `The ${door_} is back online.` });
      }
      break;
    }
    case "unlock": {
      // Checkout-time release: when the cleaner's code first opens the door, any other unlock in the
      // hour before (the guest's code isn't Property Core's) is told to the host right away.
      if (!grant || grant.flow !== "cleaning" || file.release.cleaners !== "automatic") break;
      const since = new Date(Date.parse(event.at) - 60 * 60_000);
      const earlier = lockLines(door.root, since, new Date(event.at)).filter((line) => line.action === "unlock" && line.id !== event.id);
      const mine = ref!.codeName.toLowerCase();
      if (earlier.some((line) => line.codeName?.toLowerCase() === mine)) break;
      // Any unlock with a code Property Core didn't make (the guest's, the host's own on the lock) counts.
      const ours = new Set(Object.keys(visitLogFor(door.root).codeNames()).map((name) => name.toLowerCase()));
      const last = earlier.filter((line) => !line.codeName || !ours.has(line.codeName.toLowerCase())).at(-1);
      if (!last) break;
      const at = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: timeZone ?? "UTC" }).format(new Date(last.at));
      const person = door.grants().labelOf("cleaning", grant.jobId) ?? "the cleaner";
      notes.push({ id: `lock:someone-before:${grant.jobId}`, jobId: grant.jobId, urgent: true, text: `${capital(person)} just arrived. Someone else came in at ${at}.` });
      break;
    }
    case "account-disconnected": {
      if (file.release.cleaners === "automatic") {
        file.release.cleaners = "ask";
        notes.push({ id: `lock:auto-off:${event.id}`, text: "Checkout-time codes are off while the lock account is disconnected: the cleaner's code waits for your \"guests have left\" again." });
      }
      if (once(file, `disconnected:${event.id}`)) {
        let link = "";
        try {
          if (file.customerKey) link = ` Sign in again here: ${(await adapter.connectLink({ customerKey: file.customerKey, kind: "locks" })).url}`;
        } catch {
          link = " Ask me for a new sign-in link.";
        }
        notes.push({ id: `lock:disconnected:${event.id}`, urgent: true, text: `Your lock account was disconnected, so I can't make or change codes.${link}` });
      }
      break;
    }
    default:
      break;
  }
  door.saveLocks(file);
  return { stored, notes, ...(event.kind === "unlock" && grant ? { unlockedBy: grant } : {}) };
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The clock pass: a lock offline for 30 minutes is told once per time it went offline. */
export function lockHealthNotes(door: DoorAccess, now: Date): GrantNote[] {
  const file = door.locks();
  const notes: GrantNote[] = [];
  for (const device of file.devices) {
    if (device.online || !device.offlineSince) continue;
    if (now.getTime() - Date.parse(device.offlineSince) < OFFLINE_ALERT_MS) continue;
    if (once(file, `offline:${device.id}:${device.offlineSince}`)) notes.push({ id: `lock:offline:${device.id}:${device.offlineSince}`, urgent: true, text: `The ${device.name} has been offline for 30 minutes, so codes can't change on it. Check its power and Wi-Fi.` });
  }
  if (notes.length > 0) door.saveLocks(file);
  return notes;
}
