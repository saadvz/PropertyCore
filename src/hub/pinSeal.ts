import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface PinSeal {
  iv: string;
  tag: string;
  data: string;
}

export function pinKeyFor(propertyId: string): Buffer {
  return createHash("sha256").update(`cleaner-core-pin:${propertyId}`).digest();
}

/** The only place a cleaning-chat request's door-code key is read. */
export function pinKeyFromHeader(value: string | string[] | undefined): Buffer | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return undefined;
  const bytes = Buffer.from(trimmed, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== trimmed) return undefined;
  return bytes;
}

/**
 * The server's own door-code key, used when a cleaning-chat request carries no key header (a Grok Bot
 * connected by OAuth sends only its bearer token): CLEANER_CORE_PIN_KEY, 32 random bytes in base64,
 * or else a fresh one saved once through `save` (the secret store). Without either there is no key.
 * The seal then guards a copied volume, not a copy of the volume and the secret store together.
 */
export function serverPinKey(env: NodeJS.ProcessEnv, save?: (values: { CLEANER_CORE_PIN_KEY: string }) => void): Buffer | undefined {
  const saved = pinKeyFromHeader(env.CLEANER_CORE_PIN_KEY);
  if (saved) return saved;
  if (!save) return undefined;
  const fresh = randomBytes(32);
  save({ CLEANER_CORE_PIN_KEY: fresh.toString("base64") });
  return fresh;
}

export function sealPin(pin: string, key: Buffer): PinSeal {
  for (let attempt = 0; attempt < 8; attempt++) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(pin, "utf8"), cipher.final()]);
    const sealed = { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
    if (!JSON.stringify(sealed).includes(pin)) return sealed;
  }
  throw new Error("Could not seal the door code.");
}

export function openPin(sealed: PinSeal, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
}
