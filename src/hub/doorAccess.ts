import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../storage/atomicWrite";
import { holdsCodeToken, joinSplitDigits } from "./digits";
import { openPin, sealPin, serverPinKey, type PinSeal } from "./pinSeal";

/** A flow reads a request's door-code key, and the server's, through here: never the seal itself. */
export { pinKeyFromHeader, serverPinKey } from "./pinSeal";
import { HUB_DOOR_CODE_PREFIX } from "./paths";
import type { HubCaller } from "./store";
import { sameHash, UPLOAD_GONE, UPLOAD_MINUTES, uploadHash } from "./uploadCode";

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
export const DOOR_CODE_UPLOAD_REFUSED = "Send the door code as 4 to 8 digits in code.";
export const UPLOAD_LINK_OFF = "I can't make an upload link until the server's public address is saved.";
const UPLOAD_RETRY = "That didn't work. Try again.";

/** The checks the flow on the property plugs in (HubGuards' door code ones). Undefined when none runs. */
export interface DoorGuards {
  codeRefused?(code: string, lockLocation?: string): string | undefined;
  leaks?(text: string): boolean;
}

export interface AccessRequest {
  /** E.164 phone of who is let in. */
  person: string;
  /** ISO instants. */
  window: { from: string; until: string };
  /** "repair" is unused until Fixer Core. */
  purpose: "cleaning" | "repair";
  /** The request's own key, else the server's key. */
  key?: Buffer;
}

export type AccessRefusal = "no-code" | "no-key" | "sealed" | "window-over";

export type AccessGrant = { ok: true; kind: "code"; code: string; lockLocation?: string; until: string } | { ok: false; reason: AccessRefusal };

export interface SavedCode {
  code: string;
  lockLocation?: string;
}

/** What answers a door access request once the hub's own checks pass. A lock partner is another (#180). */
export interface AccessProvider {
  grant(request: AccessRequest, saved: SavedCode): AccessGrant;
}

/** The landlord's own code, for the whole window. */
export const ownCode: AccessProvider = {
  grant: (request, saved) => ({ ok: true, kind: "code", code: saved.code, ...(saved.lockLocation ? { lockLocation: saved.lockLocation } : {}), until: request.window.until }),
};

export type DoorUpload = { status: 200 | 400 | 404; body: { ok: boolean; error?: string } };

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
  private provider: AccessProvider = ownCode;
  /** The key of the call that made the pending upload link. Only in memory. */
  private uploadKey: Buffer | undefined;

  constructor(
    readonly root: string,
    private readonly now: () => Date,
    private readonly guards: () => DoorGuards | undefined,
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

  useProvider(provider: AccessProvider): void {
    this.provider = provider;
  }

  /**
   * "Let this person in during this window." The hub checks only what belongs to the property: a code
   * is saved, the key opens it (each time, as the release always has), and the window hasn't ended.
   * Who may get in is the asking flow's call, made before it asks.
   */
  request(request: AccessRequest): AccessGrant {
    const seal = this.file.pinSeal;
    if (!seal) return { ok: false, reason: "no-code" };
    const key = this.keyFor(request.key);
    if (!key) return { ok: false, reason: "no-key" };
    let code: string;
    try {
      code = openPin(seal, key);
    } catch {
      return { ok: false, reason: "sealed" };
    }
    if (!CODE_SHAPE.test(code)) return { ok: false, reason: "sealed" };
    this.open = code;
    if (this.now().getTime() >= Date.parse(request.window.until)) return { ok: false, reason: "window-over" };
    return this.provider.grant(request, { code, ...(this.file.lockLocation ? { lockLocation: this.file.lockLocation } : {}) });
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
    const refused = this.guards()?.codeRefused?.(trimmed, lock);
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

  /**
   * Makes a one-time upload link for the door code. Only the link code's sha256, its expiry, the lock
   * location and who asked are kept; the key stays in memory. A new link replaces the last one.
   * `base` is the asking flow's public address for this property.
   */
  issueUpload(lockLocation: string | undefined, key: Buffer | undefined, base: string | undefined, by?: HubCaller): { ok: true; uploadUrl: string; expiresInMinutes: number } | { ok: false; error: string } {
    const lock = lockLocation?.trim();
    if (lock && lockLocationRefused(lock)) return { ok: false, error: LOCK_LOCATION_REFUSED };
    if (!this.keyFor(key)) return { ok: false, error: PIN_KEY_MISSING };
    if (!base) return { ok: false, error: UPLOAD_LINK_OFF };
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = randomBytes(32).toString("base64url");
      const uploadUrl = `${base}${HUB_DOOR_CODE_PREFIX}${code}`;
      if (this.guards()?.leaks?.(uploadUrl)) continue;
      const expiresAt = new Date(this.now().getTime() + UPLOAD_MINUTES * 60_000).toISOString();
      this.write({ ...this.file, upload: { hash: uploadHash(code), expiresAt, ...(lock ? { lockLocation: lock } : {}), ...(by ? { by } : {}) } });
      this.uploadKey = key;
      return { ok: true, uploadUrl, expiresInMinutes: UPLOAD_MINUTES };
    }
    return { ok: false, error: UPLOAD_RETRY };
  }

  /** Whether `code` is the pending link's code and the link hasn't expired. Reads only. */
  uploadLinkOpen(code: string): { open: boolean; by?: HubCaller } {
    const pending = this.file.upload;
    if (!pending || !sameHash(uploadHash(code), pending.hash) || this.now().getTime() >= Date.parse(pending.expiresAt)) return { open: false };
    return { open: true, ...(pending.by ? { by: pending.by } : {}) };
  }

  /**
   * Opens the seal with exactly this key, never the cached code or the server's key: the release and
   * the key-token check ask whether this key opens it. Undefined when it doesn't.
   */
  opensWith(key: Buffer): string | undefined {
    if (!this.file.pinSeal) return undefined;
    try {
      const code = openPin(this.file.pinSeal, key);
      if (!CODE_SHAPE.test(code)) return undefined;
      this.open = code;
      return code;
    } catch {
      return undefined;
    }
  }

  /**
   * Seals a door code posted to its upload link, with the same checks as save(). Only a save uses the
   * link up; a refused code keeps it. The reply never holds the code.
   */
  upload(code: string, body: Record<string, unknown>): DoorUpload {
    const pending = this.file.upload;
    if (!pending || !sameHash(uploadHash(code), pending.hash)) return { status: 404, body: { ok: false, error: UPLOAD_GONE } };
    if (this.now().getTime() >= Date.parse(pending.expiresAt)) {
      const { upload: _gone, ...rest } = this.file;
      this.write(rest);
      this.uploadKey = undefined;
      return { status: 404, body: { ok: false, error: UPLOAD_GONE } };
    }
    const doorCode = typeof body.code === "string" ? body.code.trim() : typeof body.code === "number" ? String(body.code) : "";
    if (!CODE_SHAPE.test(doorCode)) return { status: 400, body: { ok: false, error: DOOR_CODE_UPLOAD_REFUSED } };
    const lockLocation = typeof body.lockLocation === "string" ? body.lockLocation : pending.lockLocation;
    const { upload: _used, ...rest } = this.file;
    this.file = rest;
    const saved = this.save(doorCode, lockLocation, this.uploadKey);
    if (!saved.ok) {
      this.file = { ...this.file, upload: pending };
      return { status: 400, body: { ok: false, error: saved.error } };
    }
    this.uploadKey = undefined;
    return { status: 200, body: { ok: true } };
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
