import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../storage/atomicWrite";
import type { DeviceKind, LockDevice } from "./adapter";

/**
 * One property's connected locks and sensors, and how its codes go out, in door-locks.json next to
 * door-access.json. Holds no code. A property is on connected locks only when it's switched on here,
 * every door the cleaner and pros go through is a connected lock, and the account has connected locks on.
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

export type StandingRole = "owner" | "co-owner" | "co-host";

/** A person with a standing code the host named. Their phone is kept for their texts; never a code. */
export interface StandingPerson {
  id: string;
  name: string;
  phone: string;
  role: StandingRole;
  addedAt: string;
  /** When the one invite text went out. Set only once it was sent, so a failed send is tried again. */
  invitedAt?: string;
  /** The last try at the invite that didn't go out, and how many tries so far. */
  inviteTriedAt?: string;
  inviteTries?: number;
  /** When the host last had the invite sent again (standing_code_link before the YES). */
  reinvitedAt?: string;
  yesAt?: string;
  stoppedAt?: string;
  removedAt?: string;
  /** The live page link: the sha256 of its token, never the token or the link. */
  link?: { hash: string; expiresAt: string; sentAt: string; usedAt?: string };
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
  /**
   * How codes go out. Cleaners on automatic is the checkout-time release. Default ask. `packages` is a
   * package helper's bring-in code (#241): unset reads as ask, so older files keep their shape.
   */
  release: { cleaners: ReleaseMode; pros: ReleaseMode; packages?: ReleaseMode };
  /** How a pro who runs late gets more time. Default ask. */
  extend: ReleaseMode;
  /** Alerts already told, by key, so each goes once. */
  told?: string[];
  /** Standing codes: the host and the people they named. */
  standing?: StandingPerson[];
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
    release: {
      cleaners: raw.release?.cleaners === "automatic" ? "automatic" : "ask",
      pros: raw.release?.pros === "automatic" ? "automatic" : "ask",
      ...(raw.release?.packages === "automatic" || raw.release?.packages === "ask" ? { packages: raw.release.packages } : {}),
    },
    extend: raw.extend === "automatic" ? "automatic" : "ask",
  };
}

/** How a package helper's bring-in code goes out (#241): ask unless the host chose automatic. */
export function packagesRelease(file: Pick<DoorLocksFile, "release">): ReleaseMode {
  return file.release.packages === "automatic" ? "automatic" : "ask";
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
