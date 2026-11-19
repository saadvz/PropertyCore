import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../storage/atomicWrite";
import type { DeviceKind, LockDevice } from "./adapter";

/**
 * One property's connected locks and sensors, and how its codes go out, in door-locks.json next to
 * door-access.json. Holds no code. A property is on connected locks only when it's switched on here,
 * every door the cleaner and pros go through is a connected lock, and the service runs SMART_LOCKS.
 */

export const DOOR_LOCKS_FILE = "door-locks.json";

export type ReleaseMode = "ask" | "automatic";

export interface StoredDevice {
  id: string;
  accountId: string;
  name: string;
  kind: DeviceKind;
  online: boolean;
  battery?: number;
  codeLengths?: number[];
  backupCodes?: boolean;
  /** When the device was last seen offline, while it still is. */
  offlineSince?: string;
}

export interface DoorLocksFile {
  schemaVersion: 1;
  /** The Property Core account the partner's accounts are tagged with. */
  customerKey?: string;
  /** Devices the host put on this property: locks and sensors. A device belongs to one property. */
  devices: StoredDevice[];
  /** The lock ids the cleaner and pros go through. */
  doors: string[];
  /** Set when the property switched to connected locks. */
  activeAt?: string;
  /** Why the property can't switch, as last told to the host. */
  blockedBy?: "mixed-doors" | "no-alerts";
  /** How codes go out. Cleaners on automatic is the checkout-time release. Default ask. */
  release: { cleaners: ReleaseMode; pros: ReleaseMode };
  /** How a pro who runs late gets more time. Default ask. */
  extend: ReleaseMode;
  /** Alerts already told, by key, so each goes once. */
  told?: string[];
}

export function emptyLocks(): DoorLocksFile {
  return { schemaVersion: 1, devices: [], doors: [], release: { cleaners: "ask", pros: "ask" }, extend: "ask" };
}

export function readDoorLocks(root: string): DoorLocksFile {
  const path = join(root, DOOR_LOCKS_FILE);
  if (!existsSync(path)) return emptyLocks();
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DoorLocksFile>;
  const base = emptyLocks();
  return {
    ...base,
    ...raw,
    schemaVersion: 1,
    devices: Array.isArray(raw.devices) ? raw.devices : [],
    doors: Array.isArray(raw.doors) ? raw.doors : [],
    release: { cleaners: raw.release?.cleaners === "automatic" ? "automatic" : "ask", pros: raw.release?.pros === "automatic" ? "automatic" : "ask" },
    extend: raw.extend === "automatic" ? "automatic" : "ask",
  };
}

export function writeDoorLocks(root: string, file: DoorLocksFile): void {
  writeFileAtomic(join(root, DOOR_LOCKS_FILE), `${JSON.stringify(file)}\n`);
}

export function storedDevice(device: LockDevice, before?: StoredDevice): StoredDevice {
  return {
    id: device.id,
    accountId: device.accountId,
    name: device.name,
    kind: device.kind,
    online: device.online,
    ...(device.battery !== undefined ? { battery: device.battery } : {}),
    ...(device.codeLengths ? { codeLengths: [...device.codeLengths] } : {}),
    ...(device.backupCodes !== undefined ? { backupCodes: device.backupCodes } : {}),
    ...(!device.online && before?.offlineSince ? { offlineSince: before.offlineSince } : {}),
  };
}

/** The doors the cleaner and pros go through, as stored devices. */
export function doorDevices(file: DoorLocksFile): StoredDevice[] {
  return file.doors.map((id) => file.devices.find((device) => device.id === id)).filter((device): device is StoredDevice => Boolean(device && device.kind === "lock"));
}

/** True when every saved door is a connected lock on this property, and there's at least one. */
export function allDoorsConnected(file: DoorLocksFile): boolean {
  return file.doors.length > 0 && doorDevices(file).length === file.doors.length;
}

export function asLockDevice(device: StoredDevice): LockDevice {
  return {
    id: device.id,
    accountId: device.accountId,
    name: device.name,
    kind: device.kind,
    online: device.online,
    ...(device.battery !== undefined ? { battery: device.battery } : {}),
    ...(device.codeLengths ? { codeLengths: device.codeLengths } : {}),
    ...(device.backupCodes !== undefined ? { backupCodes: device.backupCodes } : {}),
  };
}
