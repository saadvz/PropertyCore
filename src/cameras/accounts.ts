import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openPin, pinKeyFromHeader, sealPin, type PinSeal } from "../hub/pinSeal";
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
  return pinKeyFromHeader(env.CAMERA_TOKEN_KEY);
}

export function sealedTokenStore(slot: SecretSlot, key: Buffer): TokenStore & { clear(): void } {
  return {
    get() {
      const raw = slot.get()[TOKENS];
      if (!raw) return undefined;
      try {
        const tokens = JSON.parse(openPin(JSON.parse(raw) as PinSeal, key)) as Tokens;
        return typeof tokens.access === "string" && typeof tokens.refresh === "string" && typeof tokens.expiresAt === "number" ? tokens : undefined;
      } catch {
        return undefined;
      }
    },
    save(tokens) {
      slot.set({ [TOKENS]: JSON.stringify(sealPin(JSON.stringify(tokens), key)) });
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
    this.pending.set(state, { ...place, codeVerifier, expiresAt: nowMs + LINK_MS });
    return { state, codeVerifier, codeChallenge };
  }

  finish(state: string): Omit<PendingLink, "expiresAt"> | undefined {
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
