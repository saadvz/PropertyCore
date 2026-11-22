import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../storage/atomicWrite";
import { holdsCodeToken, joinSplitDigits } from "./digits";
import { openPin, sealPin, serverPinKey, type PinSeal } from "./pinSeal";

/** A flow reads a request's door-code key, and the server's, through here: never the seal itself. */
export { pinKeyFromHeader, serverPinKey } from "./pinSeal";
import { HUB_DOOR_CODE_PREFIX } from "./paths";
import { DOOR_GRANTS_FILE, GrantBook, type GrantFlow, type GrantNote, type GrantStatus, type WantedCode } from "./grants";
import { lockAdapter } from "../locks/registry";
import { deskFeatureOn } from "../features/features";
import { visitLogFor } from "../visits/store";
import { allDoorsConnected, asLockDevice, doorDevices, readDoorLocks, writeDoorLocks, type DoorLocksFile } from "../locks/settings";
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
  purpose: "cleaning" | "repair" | "standing" | "guest" | "bring-in";
  /** The request's own key, else the server's key. */
  key?: Buffer;
  /** The flow's job. On connected locks the code is that job's own; without one, the saved code answers. */
  jobId?: string;
  /** How a note to the host names the person ("Maria"). Never a phone. */
  label?: string;
}

/** `lock-failed`: on connected locks, the code didn't program, no backup was left, and no code is saved. */
export type AccessRefusal = "no-code" | "no-key" | "sealed" | "window-over" | "lock-failed";

/**
 * `doors` is set when the doors take different codes (one fell back to a backup code): the text names
 * each door's code. `notes` are for the host, told once each by the asking flow; they never hold a code.
 */
export type AccessGrant =
  | { ok: true; kind: "code"; code: string; lockLocation?: string; until: string; doors?: { door: string; code: string }[]; notes?: GrantNote[] }
  | { ok: false; reason: AccessRefusal; notes?: GrantNote[] };

export type { GrantFlow, GrantNote, GrantStatus, WantedCode };

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

/**
 * Where each property's account saves its server key when it has none yet, by property folder. The
 * shared service registers it as it builds a tenant's context; grants are sealed with that key.
 */
const secretSavers = new Map<string, (values: { CLEANER_CORE_PIN_KEY: string }) => void>();

export function registerSecretSaver(root: string, save: (values: { CLEANER_CORE_PIN_KEY: string }) => void): void {
  secretSavers.set(root, save);
}

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
  /**
   * The request key that last saved or opened the code, kept in memory with it, so a later request
   * with no key of its own (a reminder pass) opens it the same way. Undefined means the server's key.
   */
  private openKey: Buffer | undefined;
  private env: () => NodeJS.ProcessEnv = () => ({});
  private provider: AccessProvider = ownCode;
  /** The key of the call that made the pending upload link. Only in memory. */
  private uploadKey: Buffer | undefined;
  private book: GrantBook | undefined;
  private saveSecrets: ((values: { CLEANER_CORE_PIN_KEY: string }) => void) | undefined;
  private sleep: ((ms: number) => Promise<void>) | undefined;

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

  /** Where the account's server key is saved when it has none yet, so grants can be sealed (made if missing). */
  useSecretSaver(save: ((values: { CLEANER_CORE_PIN_KEY: string }) => void) | undefined): void {
    this.saveSecrets = save;
  }

  /** Tests: how the release waits for a code still programming. */
  useSleep(sleep: ((ms: number) => Promise<void>) | undefined): void {
    this.sleep = sleep;
  }

  /** The property's connected locks and code settings. Holds no code. */
  locks(): DoorLocksFile {
    return readDoorLocks(this.root);
  }

  saveLocks(file: DoorLocksFile): void {
    writeDoorLocks(this.root, file);
  }

  /**
   * True when this property is on connected locks: the account has connected locks on (featureOn) with a lock adapter,
   * the property switched on, and every door the cleaner and pros go through is a connected lock.
   * Otherwise every request gets the saved code, exactly as before.
   */
  connected(): boolean {
    if (!deskFeatureOn(this.env(), "locks") || !lockAdapter()) return false;
    const locks = this.locks();
    return Boolean(locks.activeAt) && allDoorsConnected(locks);
  }

  /** The per-visit codes. Grants are always sealed with the account's own server key, made if missing. */
  grants(): GrantBook {
    if (!this.book) {
      this.book = new GrantBook(this.root, {
        now: this.now,
        adapter: () => lockAdapter(),
        key: () => serverPinKey(this.env(), this.saveSecrets ?? secretSavers.get(this.root)),
        doors: () => doorDevices(this.locks()).map(asLockDevice),
        sleep: (ms) => (this.sleep ?? ((wait: number) => new Promise<void>((resolve) => setTimeout(resolve, wait))))(ms),
        named: (codeName, who) => void visitLogFor(this.root, this.now).nameCode(codeName, who),
      });
    }
    return this.book;
  }

  /**
   * Makes the locks hold exactly the codes this flow wants now. Does nothing off connected locks.
   * Returns notes for the host; never a code.
   */
  async syncGrants(flow: GrantFlow, wanted: readonly WantedCode[]): Promise<GrantNote[]> {
    if (!this.connected()) return [];
    return this.grants().sync(flow, wanted);
  }

  /** Where one job's code is on the locks now, without waiting (GrantBook.check). `none` off connected locks. */
  async checkGrant(flow: GrantFlow, jobId: string): Promise<"set" | "programming" | "failed" | "none"> {
    if (!this.connected()) return "none";
    return this.grants().check(flow, jobId);
  }

  /** Revokes one job's code now. Does nothing off connected locks. */
  async revokeGrant(flow: GrantFlow, jobId: string): Promise<void> {
    if (!this.connected()) return;
    await this.grants().revoke(flow, jobId);
  }

  /**
   * Every code that could be in a message about this property, for the leak checks only: the saved
   * code and, on connected locks, each grant's code and backup codes until a day after its window.
   */
  codesForChecksAll(key?: Buffer): string[] {
    const codes = new Set<string>();
    const saved = this.codeForChecks(key);
    if (saved) codes.add(saved);
    if (existsSync(join(this.root, DOOR_GRANTS_FILE))) for (const code of this.grants().codesForChecks()) codes.add(code);
    return [...codes];
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
      this.openKey = key;
      return opened;
    } catch {
      return undefined;
    }
  }

  /** Deletes the door code, the lock location and any upload link: door-access.json and what's in memory. */
  clear(): void {
    rmSync(doorAccessPath(this.root), { force: true });
    this.file = { schemaVersion: 1 };
    this.open = undefined;
    this.openKey = undefined;
    this.uploadKey = undefined;
  }

  useProvider(provider: AccessProvider): void {
    this.provider = provider;
  }

  /**
   * "Let this person in during this window." The hub checks only what belongs to the property: a code
   * is saved, the key opens it (each time, as the release always has), and the window hasn't ended.
   * Who may get in is the asking flow's call, made before it asks.
   */
  async request(request: AccessRequest): Promise<AccessGrant> {
    if (request.jobId && this.connected()) return this.requestGrant(request, request.jobId);
    return this.requestSaved(request);
  }

  private requestSaved(request: AccessRequest): AccessGrant {
    const seal = this.file.pinSeal;
    if (!seal) return { ok: false, reason: "no-code" };
    const key = this.keyFor(request.key ?? this.openKey);
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

  /** On connected locks: this person's own code for this job, with its fallbacks. The saved code is only the last one. */
  private async requestGrant(request: AccessRequest, jobId: string): Promise<AccessGrant> {
    if (this.now().getTime() >= Date.parse(request.window.until)) return { ok: false, reason: "window-over" };
    let saved: string | undefined;
    // A standing or guest code never falls back to the host's saved code: its page shows the person's own code or nothing.
    if (this.file.pinSeal && request.purpose !== "standing" && request.purpose !== "guest") {
      const key = this.keyFor(request.key ?? this.openKey);
      try {
        saved = key ? openPin(this.file.pinSeal, key) : undefined;
      } catch {
        saved = undefined;
      }
      if (saved && CODE_SHAPE.test(saved)) this.open = saved;
      else saved = undefined;
    }
    const released = await this.grants().release({ flow: request.purpose, jobId, person: request.person, window: request.window, ...(request.label ? { label: request.label } : {}) }, saved);
    if (!released.ok) return { ok: false, reason: released.reason, ...(released.notes.length > 0 ? { notes: released.notes } : {}) };
    const lockLocation = released.source === "saved" ? this.file.lockLocation : undefined;
    return {
      ok: true,
      kind: "code",
      code: released.code,
      ...(lockLocation ? { lockLocation } : {}),
      until: request.window.until,
      ...(released.doors ? { doors: released.doors } : {}),
      ...(released.notes.length > 0 ? { notes: released.notes } : {}),
    };
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
      this.openKey = key;
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
      if (!this.write({ ...this.file, upload: { hash: uploadHash(code), expiresAt, ...(lock ? { lockLocation: lock } : {}), ...(by ? { by } : {}) } })) return { ok: false, error: SEAL_FAILED };
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
      this.openKey = key;
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
      // Removing the link can't add the code to the file; a refused write just leaves an expired link.
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

  /** Writes the file. False, with nothing written, when it would hold the open code as its own token. */
  protected write(next: DoorAccessFile): boolean {
    const json = `${JSON.stringify(next)}\n`;
    if (this.open && holdsCodeToken(json, this.open)) return false;
    writeFileAtomic(doorAccessPath(this.root), json);
    this.file = next;
    return true;
  }
}
