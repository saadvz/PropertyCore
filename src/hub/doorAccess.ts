import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../storage/atomicWrite";
import { holdsCodeToken, joinSplitDigits } from "./digits";
import { openPin, sealPin, serverPinKey, type PinSeal } from "./pinSeal";
import type { HubCaller } from "./store";

/**
 * One property's door access: its sealed door code, where the lock is, and the pending upload link,
 * kept in door-access.json in the property's folder, apart from hub.json. Only the hub reads the seal.
 * A flow gets the code to send through request(), after its own checks; codeForChecks() is only for
 * the flow's leak checks, and its result is never sent.
 */

export const DOOR_ACCESS_FILE = "door-access.json";
export const MAX_LOCK_LOCATION = 80;
const CODE_SHAPE = /^\d{4,8}$/;

export interface DoorAccessFile {
  schemaVersion: 1;
  pinSeal?: PinSeal;
  /** Where the lock is, named in the door-code text. Never a code. */
  lockLocation?: string;
  /** The pending upload link: the sha256 of its code, never the code or the link. */
  upload?: { hash: string; expiresAt: string; lockLocation?: string; by?: HubCaller };
}

export type DoorSave = { ok: true } | { ok: false; error: string; reason: "code" | "lock" | "key" | "guard" | "seal" };

export const DOOR_CODE_SHAPE_REFUSED = "Send the door code as 4 to 8 digits.";
export const LOCK_LOCATION_REFUSED = `Say where the lock is in under ${MAX_LOCK_LOCATION} characters, with no code or long number in it.`;
export const PIN_KEY_MISSING = "I can't send the door code yet. Let's finish setting up Cleaner Core first.";
export const SEAL_FAILED = "Could not seal the door code.";

/** The guard the flow on the property plugs in. Undefined when no flow guards the code. */
export type CodeRefused = ((code: string, lockLocation?: string) => string | undefined) | undefined;

export function doorAccessPath(root: string): string {
  return join(root, DOOR_ACCESS_FILE);
}

export function readDoorAccessFile(root: string): DoorAccessFile | undefined {
  const path = doorAccessPath(root);
  if (!existsSync(path)) return undefined;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DoorAccessFile>;
  return { ...raw, schemaVersion: 1 };
}

/** True when the lock location is too long or holds a run of 4 or more digits, even split. */
export function lockLocationRefused(lockLocation: string): boolean {
  return lockLocation.length > MAX_LOCK_LOCATION || /\d{4,}/.test(joinSplitDigits(lockLocation));
}

export class DoorAccess {
  private file: DoorAccessFile;
  /** The open code, only in memory. */
  private open: string | undefined;
  private env: () => NodeJS.ProcessEnv = () => ({});

  constructor(
    readonly root: string,
    private readonly guard: () => CodeRefused,
  ) {
    this.file = readDoorAccessFile(root) ?? { schemaVersion: 1 };
  }

  useEnv(env: () => NodeJS.ProcessEnv): void {
    this.env = env;
  }

  /** The request's key, or else the server's own key. Undefined when neither is there. */
  keyFor(key: Buffer | undefined): Buffer | undefined {
    return key ?? serverPinKey(this.env());
  }

  saved(): boolean {
    return Boolean(this.file.pinSeal);
  }

  lockLocation(): string | undefined {
    return this.file.lockLocation;
  }

  /** The open code for leak checks only; never sent. Undefined when none is saved or the key can't open it. */
  codeForChecks(key?: Buffer): string | undefined {
    if (this.open) return this.open;
    if (!this.file.pinSeal) return undefined;
    const usable = this.keyFor(key);
    if (!usable) return undefined;
    try {
      const opened = openPin(this.file.pinSeal, usable);
      if (!CODE_SHAPE.test(opened)) return undefined;
      this.open = opened;
      return opened;
    } catch {
      return undefined;
    }
  }

  /**
   * Seals a 4 to 8 digit code. A lockLocation of undefined keeps the saved one, and "" clears it.
   * The file is written only when it holds neither the code as its own token nor the key.
   */
  save(code: string, lockLocation: string | undefined, key: Buffer | undefined): DoorSave {
    const trimmed = code.trim();
    if (!CODE_SHAPE.test(trimmed)) return { ok: false, reason: "code", error: DOOR_CODE_SHAPE_REFUSED };
    const lock = lockLocation?.trim();
    if (lock && (lockLocationRefused(lock) || joinSplitDigits(lock).includes(trimmed))) return { ok: false, reason: "lock", error: LOCK_LOCATION_REFUSED };
    const refused = this.guard()?.(trimmed, lock);
    if (refused) return { ok: false, reason: "guard", error: refused };
    const usable = this.keyFor(key);
    if (!usable) return { ok: false, reason: "key", error: PIN_KEY_MISSING };
    const next: DoorAccessFile = { ...this.file };
    if (lock !== undefined) {
      if (lock) next.lockLocation = lock;
      else delete next.lockLocation;
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      next.pinSeal = sealPin(trimmed, usable);
      const json = `${JSON.stringify(next)}\n`;
      if (holdsCodeToken(json, trimmed) || json.includes(usable.toString("base64"))) continue;
      writeFileAtomic(doorAccessPath(this.root), json);
      this.file = next;
      this.open = trimmed;
      return { ok: true };
    }
    return { ok: false, reason: "seal", error: SEAL_FAILED };
  }

  /** Writes the file, refusing one that would hold the open code as its own token. */
  protected write(next: DoorAccessFile): void {
    const json = `${JSON.stringify(next)}\n`;
    if (this.open && holdsCodeToken(json, this.open)) throw new Error(SEAL_FAILED);
    writeFileAtomic(doorAccessPath(this.root), json);
    this.file = next;
  }

  protected current(): DoorAccessFile {
    return this.file;
  }
}
