import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../storage/atomicWrite";
import type { Tokens, TokenStore } from "./adapter";

/**
 * Linked camera accounts and the cameras each property picked (#239). A host's tokens are sealed with the
 * service's CAMERA_TOKEN_KEY and kept in the tenant's own secrets, never in the clear and never in a property's
 * files. The property's `cameras.json` holds only the picked cameras, the consent time and the provider's name.
 */

/** One place in the tenant's secrets, like `TenantSecrets.connection(id, "cameras")`. */
export interface SecretSlot {
  get(): Record<string, string>;
  set(values: Record<string, string>): void;
  clear(names: string[]): void;
}

const TOKENS = "CAMERA_TOKENS";

/** The service's key for sealing camera tokens: 32 random bytes in base64. Without it, no camera account can be linked. */
export function cameraTokenKey(env: NodeJS.ProcessEnv): Buffer | undefined {
  const raw = env.CAMERA_TOKEN_KEY?.trim();
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return undefined;
  const bytes = Buffer.from(raw, "base64");
  return bytes.length === 32 && bytes.toString("base64") === raw ? bytes : undefined;
}

interface Seal {
  iv: string;
  tag: string;
  data: string;
}

function seal(text: string, key: Buffer): Seal {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function open(sealed: Seal, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
}

export function sealedTokenStore(slot: SecretSlot, key: Buffer): TokenStore & { clear(): void } {
  return {
    get() {
      const raw = slot.get()[TOKENS];
      if (!raw) return undefined;
      try {
        const tokens = JSON.parse(open(JSON.parse(raw) as Seal, key)) as Tokens;
        return typeof tokens.access === "string" && typeof tokens.refresh === "string" && typeof tokens.expiresAt === "number" ? tokens : undefined;
      } catch {
        return undefined;
      }
    },
    save(tokens) {
      slot.set({ [TOKENS]: JSON.stringify(seal(JSON.stringify(tokens), key)) });
    },
    clear() {
      slot.clear([TOKENS]);
    },
  };
}

interface PendingLink {
  tenantId: string;
  propertyId: string;
  /** The pairing word, shown only after the host agrees. */
  word: string;
  /** The browser's mark, set when the host agrees on the consent page. */
  mark?: string;
  expiresAt: number;
}

const LINK_MS = 30 * 60_000;
const b64url = (bytes: Buffer) => bytes.toString("base64url");
/** No vowels, so a word never spells anything, and no letters that look alike. Never digits. */
const WORD_LETTERS = "BCDFGHJKMNPQRSTVWXYZ";
const WORD_LENGTH = 8;

function newWord(): string {
  let word = "";
  for (let i = 0; i < WORD_LENGTH; i += 1) word += WORD_LETTERS[randomInt(WORD_LETTERS.length)];
  return word;
}

/** The pairing word as the host types it: case, spaces and the dash don't matter. */
export function normalWord(typed: string): string {
  return typed.toUpperCase().replace(/[^A-Z]/g, "");
}

/** The pairing word as the page shows it: two groups of four. */
export const shownWord = (word: string) => `${word.slice(0, 4)}-${word.slice(4)}`;

function same(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export interface AgreedLink {
  state: string;
  tenantId: string;
  propertyId: string;
}

/**
 * One-time connect links (#239, #302): a state that ties a host's browser to a property, good once for 30 minutes.
 * The host's assistant hands the link over, so opening it is the host's sign-in. Agreeing on the consent page marks
 * the browser and shows a pairing word; either one names the host when the provider sends their browser back. Kept in
 * memory only.
 */
export class CameraLinks {
  private readonly pending = new Map<string, PendingLink>();
  constructor(private readonly now: () => Date) {}

  private live(): [string, PendingLink][] {
    const nowMs = this.now().getTime();
    for (const [state, link] of this.pending) if (link.expiresAt <= nowMs) this.pending.delete(state);
    return [...this.pending];
  }

  start(place: { tenantId: string; propertyId: string }): { state: string } {
    this.live();
    const state = b64url(randomBytes(32));
    this.pending.set(state, { ...place, word: newWord(), expiresAt: this.now().getTime() + LINK_MS });
    return { state };
  }

  /** The link's property without using it up, and whether the host has agreed yet. */
  peek(state: string): { tenantId: string; propertyId: string; agreed: boolean } | undefined {
    const link = this.pending.get(state);
    if (!link || link.expiresAt <= this.now().getTime()) return undefined;
    return { tenantId: link.tenantId, propertyId: link.propertyId, agreed: link.mark !== undefined };
  }

  /** The host agreed: the browser's mark and the pairing word. Agreeing twice gives the same two. */
  agree(state: string): { mark: string; word: string } | undefined {
    const link = this.pending.get(state);
    if (!link || link.expiresAt <= this.now().getTime()) return undefined;
    link.mark ??= b64url(randomBytes(32));
    return { mark: link.mark, word: link.word };
  }

  /** The agreed link a browser's mark belongs to. */
  byMark(mark: string): AgreedLink | undefined {
    let found: AgreedLink | undefined;
    for (const [state, link] of this.live()) if (link.mark !== undefined && same(link.mark, mark)) found = { state, tenantId: link.tenantId, propertyId: link.propertyId };
    return found;
  }

  /** The agreed link a typed pairing word belongs to. */
  byWord(typed: string): AgreedLink | undefined {
    const word = normalWord(typed);
    let found: AgreedLink | undefined;
    if (word.length !== WORD_LENGTH) return undefined;
    for (const [state, link] of this.live()) if (link.mark !== undefined && same(link.word, word)) found = { state, tenantId: link.tenantId, propertyId: link.propertyId };
    return found;
  }

  finish(state: string): { tenantId: string; propertyId: string } | undefined {
    const link = this.pending.get(state);
    this.pending.delete(state);
    if (!link || link.expiresAt <= this.now().getTime()) return undefined;
    return { tenantId: link.tenantId, propertyId: link.propertyId };
  }
}

/** How long the provider's signed browser redirect stays good, and how far ahead of our clock its time may be. */
export const NONCE_MS = 600_000;
export const NONCE_AHEAD_MS = 30_000;
const WAITING_MS = 15 * 60_000;
const WORD_TRIES = 5;

interface Waiting {
  sealed: Seal;
  email?: string;
  expiresAt: number;
  wrongWords: number;
}

export interface WaitingAccount {
  accountId: string;
  email?: string;
  tokens: Tokens;
}

/**
 * Tokens the provider released before we know whose they are (#302): held sealed, in memory only, for 15 minutes,
 * by the provider's account id. The provider's signed nonce is what finds them again; only then, and once the host is
 * matched, are they saved to an account. Unclaimed ones are dropped.
 */
export class WaitingTokens {
  private readonly held = new Map<string, Waiting>();
  constructor(
    private readonly key: Buffer,
    private readonly now: () => Date,
  ) {}

  private sweep(): void {
    const nowMs = this.now().getTime();
    for (const [accountId, waiting] of this.held) if (waiting.expiresAt <= nowMs) this.held.delete(accountId);
  }

  /** The newest tokens for an account replace any still waiting. */
  hold(account: WaitingAccount): void {
    this.sweep();
    this.held.set(account.accountId, { sealed: seal(JSON.stringify(account.tokens), this.key), ...(account.email ? { email: account.email } : {}), expiresAt: this.now().getTime() + WAITING_MS, wrongWords: 0 });
  }

  /**
   * The waiting tokens a redirect's nonce was signed for. Undefined when its time is over 10 minutes old or ahead of
   * our clock, or no waiting account produces that nonce. Every waiting account is tried, in constant time each.
   */
  match(nonce: string, time: string, nonceFor: (time: string, accountId: string) => string): WaitingAccount | undefined {
    this.sweep();
    if (!/^\d{10,16}$/.test(time) || !/^[A-Za-z0-9_-]{20,100}$/.test(nonce)) return undefined;
    const age = this.now().getTime() - Number(time);
    if (age > NONCE_MS || age < -NONCE_AHEAD_MS) return undefined;
    let found: WaitingAccount | undefined;
    for (const [accountId, waiting] of this.held) {
      if (!same(nonceFor(time, accountId), nonce)) continue;
      try {
        found = { accountId, ...(waiting.email ? { email: waiting.email } : {}), tokens: JSON.parse(open(waiting.sealed, this.key)) as Tokens };
      } catch {
        this.held.delete(accountId);
      }
    }
    return found;
  }

  /** A wrong pairing word for these tokens. True once they've had five and are dropped. */
  wrongWord(accountId: string): boolean {
    const waiting = this.held.get(accountId);
    if (!waiting) return true;
    waiting.wrongWords += 1;
    if (waiting.wrongWords < WORD_TRIES) return false;
    this.held.delete(accountId);
    return true;
  }

  drop(accountId: string): void {
    this.held.delete(accountId);
  }

  get size(): number {
    this.sweep();
    return this.held.size;
  }
}

/** An email with its middle hidden, for a page: j***e@example.com. Something that isn't an email is hidden whole. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return "***";
  const local = email.slice(0, at);
  return `${local[0]}***${local.length > 2 ? local[local.length - 1] : ""}${email.slice(at)}`;
}

/** A name with its middle hidden, for the provider's own confirmation to the host. */
export function maskLabel(label: string): string {
  const text = label.trim();
  return text.length > 2 ? `${text[0]}***${text[text.length - 1]}` : "***";
}

export interface PickedCamera {
  deviceId: string;
  /** The host's name for it. */
  name: string;
  /** The host said it's outdoors. Indoor cameras are never picked. */
  outdoor: true;
  pickedAt: string;
}

export interface CamerasFile {
  provider?: string;
  /** When the host agreed to what is read and where snapshots go. */
  consentAt?: string;
  connectedAt?: string;
  cameras: PickedCamera[];
  /** Ids of camera notes already given to the host, newest last. */
  told?: string[];
  /** Notes nothing could deliver yet, for the host's next chat. */
  waiting?: { id: string; text: string }[];
}

export const CAMERAS_FILE = "cameras.json";

export function readCameras(root: string): CamerasFile {
  const path = join(root, CAMERAS_FILE);
  if (!existsSync(path)) return { cameras: [] };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CamerasFile>;
  return { ...raw, cameras: Array.isArray(raw.cameras) ? raw.cameras.filter((camera) => camera && typeof camera.deviceId === "string" && camera.outdoor === true) : [] };
}

export function writeCameras(root: string, file: CamerasFile): void {
  const path = join(root, CAMERAS_FILE);
  writeJsonAtomic(path, file);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Not every filesystem keeps modes.
  }
}

export interface CameraPlace {
  tenantId: string;
  propertyId: string;
  cameras: PickedCamera[];
}

/** The property that picked a device. A device nobody picked is dropped unstored. */
export function routeDevice(places: readonly CameraPlace[], deviceId: string): { tenantId: string; propertyId: string; camera: PickedCamera } | undefined {
  for (const place of places) {
    const camera = place.cameras.find((entry) => entry.deviceId === deviceId);
    if (camera) return { tenantId: place.tenantId, propertyId: place.propertyId, camera };
  }
  return undefined;
}
