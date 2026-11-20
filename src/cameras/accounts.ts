import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
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
  codeVerifier: string;
  codeChallenge: string;
  expiresAt: number;
}

const LINK_MS = 30 * 60_000;
const b64url = (bytes: Buffer) => bytes.toString("base64url");

/** One-time sign-in links: a state that ties the provider's return to a property, good once for 30 minutes. Kept in memory only. */
export class CameraLinks {
  private readonly pending = new Map<string, PendingLink>();
  constructor(private readonly now: () => Date) {}

  start(place: { tenantId: string; propertyId: string }): { state: string; codeVerifier: string; codeChallenge: string } {
    const nowMs = this.now().getTime();
    for (const [state, link] of this.pending) if (link.expiresAt <= nowMs) this.pending.delete(state);
    const state = b64url(randomBytes(32));
    const codeVerifier = b64url(randomBytes(48));
    const codeChallenge = b64url(createHash("sha256").update(codeVerifier).digest());
    this.pending.set(state, { ...place, codeVerifier, codeChallenge, expiresAt: nowMs + LINK_MS });
    return { state, codeVerifier, codeChallenge };
  }

  /** The link's property and challenge without using it up: the consent page reads it before the host signs in. */
  peek(state: string): { tenantId: string; propertyId: string; codeChallenge: string } | undefined {
    const link = this.pending.get(state);
    if (!link || link.expiresAt <= this.now().getTime()) return undefined;
    return { tenantId: link.tenantId, propertyId: link.propertyId, codeChallenge: link.codeChallenge };
  }

  finish(state: string): { tenantId: string; propertyId: string; codeVerifier: string } | undefined {
    const link = this.pending.get(state);
    this.pending.delete(state);
    if (!link || link.expiresAt <= this.now().getTime()) return undefined;
    return { tenantId: link.tenantId, propertyId: link.propertyId, codeVerifier: link.codeVerifier };
  }
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
