import type { DoorAccess, GrantNote } from "../hub/doorAccess";
import type { LockAdapter, LockWebhookEvent } from "./adapter";
import { appendLockLine, lockLine, type GrantRef } from "./eventLog";
import type { DoorLocksFile } from "./settings";

/**
 * What one verified lock event changes on its property, and what the host hears. The event is stored
 * first, as received; then a code's status, a backup code, and each alert, told once by its key. No
 * note holds a code, and none names the lock partner.
 */

export const OFFLINE_ALERT_MS = 30 * 60_000;

function who(label: string | undefined, flow: GrantRef["flow"]): string {
  return label?.trim() || (flow === "cleaning" ? "the cleaner" : flow === "repair" ? "the pro" : "they");
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
export async function applyLockEvent(door: DoorAccess, adapter: LockAdapter, event: LockWebhookEvent, now: Date): Promise<InboundResult> {
  const file = door.locks();
  const device = event.deviceId ? file.devices.find((item) => item.id === event.deviceId) : undefined;
  const ref = event.codeId ? door.grants().grantOf(event.codeId) : undefined;
  const grant: GrantRef | undefined = ref ? { flow: ref.flow, jobId: ref.jobId, ...(ref.backup ? { backup: true } : {}) } : undefined;
  const stored = appendLockLine(door.root, lockLine(event, { ...(device ? { deviceName: device.name } : {}), ...(grant ? { grant } : {}), loggedAt: now.toISOString() }));
  // A resent event changes nothing twice.
  if (!stored) return { stored, notes: [] };
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
      notes.push({
        id: `lock:failed:${event.codeId}`,
        jobId: ref.jobId,
        urgent: true,
        text: ready
          ? `The ${door_} didn't take ${person}'s code. A backup code for that door is ready, and ${person} gets it with their code.`
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
    case "account-disconnected": {
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
