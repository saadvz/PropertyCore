import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { calendarUrlAllowed } from "../hub/fetchLimits";
import { basicAuth, cleanerTwilioLogin } from "./liveSms";

/**
 * The cleaner's photos from MMS, so Grok can look at them. Each photo is downloaded once from Twilio
 * with Cleaner Core's own login and kept under the job. Grok gets links that expire after an hour.
 *
 * Nothing here holds a digit the cleaner or the host chose: a job's folder is 16 letters from a hash
 * of its id, and a link's token is letters only, so no path or link can carry a phone number or the
 * door code. The media URL and the Twilio login are never written or returned.
 */

export const CLEANER_PHOTO_PREFIX = "/cleaner-core/photos/";
export const MAX_JOB_PHOTOS = 10;
export const PHOTO_LINK_MS = 60 * 60_000;
/** Photos are deleted this long after the cleaning is done. */
export const PHOTO_KEEP_MS = 30 * 24 * 60 * 60_000;
/** A photo that came with a message is deleted this long after it came in. */
export const MESSAGE_PHOTO_KEEP_MS = 7 * 24 * 60 * 60_000;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_PHOTO_MS = 10_000;
const MAX_REDIRECTS = 3;
const TWILIO_MEDIA = "https://api.twilio.com/";
/** A group photo's record in the Conversations media service. Its temporary link holds the photo. */
const CONVERSATION_MEDIA = "https://mcs.us1.twilio.com/v1/Services/";
const MAX_MEDIA_RECORD_BYTES = 64 * 1024;
const MIN_KEY = 16;
const SIGNATURE_LETTERS = 64;

/** Photo types that are kept, by their file extension. Anything else, like SVG, is skipped. */
const TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};
const SERVED: Record<string, string> = { jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif" };

export interface InboundMedia {
  url: string;
  contentType: string;
}

export type PhotoFetch = (url: string, init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

let photoFetch: PhotoFetch | undefined;

/** Tests stub the Twilio media download. Unset uses the platform fetch. */
export function setCleanerPhotoFetch(fetchImpl: PhotoFetch | undefined): void {
  photoFetch = fetchImpl;
}

export function cleanerPhotoFetch(): PhotoFetch {
  return photoFetch ?? ((url, init) => fetch(url, init));
}

function photosDir(root: string): string {
  return join(root, "cleaner-job", "photos");
}

/** 16 lowercase letters from a hash of the job id. A job id can hold a booking's digits; this can't. */
export function photoFolder(jobId: string): string {
  return [...createHash("sha256").update(jobId).digest().subarray(0, 16)].map((byte) => String.fromCharCode(97 + (byte % 26))).join("");
}

/** Each half-byte as one letter a to p, so the text never holds a digit. */
function toLetters(bytes: Buffer): string {
  return [...bytes].map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15))).join("");
}

function fromLetters(text: string): Buffer | undefined {
  if (text.length === 0 || text.length % 2 !== 0 || !/^[a-p]+$/.test(text)) return undefined;
  const bytes = Buffer.alloc(text.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = ((text.charCodeAt(index * 2) - 97) << 4) | (text.charCodeAt(index * 2 + 1) - 97);
  return bytes;
}

/** The saved photos of a job's folder, by number. */
function photoFiles(dir: string): { n: number; file: string; ext: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((file) => {
      const match = /^(\d{1,2})\.([a-z]+)$/.exec(file);
      if (!match?.[1] || !match[2] || !SERVED[match[2]]) return [];
      return [{ n: Number(match[1]), file, ext: match[2] }];
    })
    .sort((a, b) => a.n - b.n);
}

export function photoCount(root: string, jobId: string): number {
  return photoFiles(join(photosDir(root), photoFolder(jobId))).length;
}

/**
 * The key that signs photo links: CLEANER_CORE_PHOTO_KEY, or else a random one saved once through
 * `save` (the secret store). Without either there is no key, so no link is made or served.
 */
export function photoKey(env: NodeJS.ProcessEnv, save?: (values: { CLEANER_CORE_PHOTO_KEY: string }) => void): Buffer | undefined {
  const saved = env.CLEANER_CORE_PHOTO_KEY?.trim();
  if (saved && saved.length >= MIN_KEY) return Buffer.from(saved, "utf8");
  if (!save) return undefined;
  const fresh = randomBytes(32).toString("base64url");
  save({ CLEANER_CORE_PHOTO_KEY: fresh });
  return Buffer.from(fresh, "utf8");
}

/** The media service record of a group photo. Undefined unless both sids look like Twilio's. */
export function conversationMediaUrl(chatServiceSid: string, mediaSid: string): string | undefined {
  if (!/^IS[0-9a-f]{32}$/.test(chatServiceSid) || !/^ME[0-9a-f]{32}$/.test(mediaSid)) return undefined;
  return `${CONVERSATION_MEDIA}${chatServiceSid}/Media/${mediaSid}`;
}

/**
 * Reads a group photo's media record with the Twilio login, and returns its temporary link. The
 * link is already signed, so the login never goes to it. Undefined when anything is off.
 */
async function temporaryMediaLink(url: string, fetchImpl: PhotoFetch, basic: string, signal: AbortSignal): Promise<string | undefined> {
  const response = await fetchImpl(url, { redirect: "manual", signal, headers: { Authorization: basic } });
  if (response.status !== 200) return undefined;
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_MEDIA_RECORD_BYTES) return undefined;
  const text = await response.text();
  if (text.length > MAX_MEDIA_RECORD_BYTES) return undefined;
  let record: { links?: { content_direct_temporary?: unknown } };
  try {
    record = JSON.parse(text) as typeof record;
  } catch {
    return undefined;
  }
  const link = record.links?.content_direct_temporary;
  return typeof link === "string" && link.startsWith("https://") ? link : undefined;
}

function twilioHost(host: string): boolean {
  return host === "twilio.com" || host.endsWith(".twilio.com");
}

/** Reads at most MAX_PHOTO_BYTES. A bigger body is dropped. */
async function readCapped(response: Response, controller: AbortController): Promise<Buffer | undefined> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_PHOTO_BYTES) return undefined;
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length > MAX_PHOTO_BYTES ? undefined : bytes;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PHOTO_BYTES) {
      controller.abort();
      return undefined;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Downloads one MMS photo. Only an image type, only from https://api.twilio.com/, with Basic auth
 * from the Cleaner Core Twilio settings. A redirect is followed only to https, and the login goes
 * only to twilio.com hosts. A group photo is read through the Conversations media service: its
 * record with the login, then its temporary link without it. Five megabytes and ten seconds at
 * most. Undefined when anything is off.
 */
export async function downloadPhoto(media: InboundMedia, fetchImpl: PhotoFetch, env: NodeJS.ProcessEnv): Promise<{ bytes: Buffer; ext: string } | undefined> {
  const ext = TYPES[media.contentType.trim().toLowerCase()];
  if (!ext) return undefined;
  const grouped = media.url.startsWith(CONVERSATION_MEDIA);
  if (!grouped && !media.url.startsWith(TWILIO_MEDIA)) return undefined;
  const login = cleanerTwilioLogin(env);
  if (!login) return undefined;
  const basic = basicAuth(login);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_PHOTO_MS);
  try {
    let current = media.url;
    if (grouped) {
      const link = await temporaryMediaLink(media.url, fetchImpl, basic, controller.signal);
      if (!link) return undefined;
      current = link;
    }
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!calendarUrlAllowed(current)) return undefined;
      const host = new URL(current).hostname.toLowerCase();
      const headers: Record<string, string> = !grouped && twilioHost(host) ? { Authorization: basic } : {};
      const response = await fetchImpl(current, { redirect: "manual", signal: controller.signal, headers });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return undefined;
        current = new URL(location, current).toString();
        continue;
      }
      if (response.status !== 200) return undefined;
      const type = response.headers.get("content-type")?.toLowerCase();
      if (type && !type.startsWith("image/")) return undefined;
      const bytes = await readCapped(response, controller);
      if (!bytes || bytes.length === 0) return undefined;
      return { bytes, ext };
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Writes a downloaded photo as the job's next number. False once the job has 10. */
export function storePhoto(root: string, jobId: string, photo: { bytes: Buffer; ext: string }): boolean {
  const dir = join(photosDir(root), photoFolder(jobId));
  const files = photoFiles(dir);
  if (files.length >= MAX_JOB_PHOTOS) return false;
  const n = (files.at(-1)?.n ?? 0) + 1;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${n}.${photo.ext}`), photo.bytes);
  return true;
}

/** Downloads one MMS's photos side by side, up to 10, in order. A photo that fails is left out. */
export async function downloadPhotos(media: readonly InboundMedia[], fetchImpl: PhotoFetch, env: NodeJS.ProcessEnv): Promise<{ bytes: Buffer; ext: string }[]> {
  const downloads = await Promise.all(media.slice(0, MAX_JOB_PHOTOS).map((item) => downloadPhoto(item, fetchImpl, env)));
  return downloads.filter((photo): photo is { bytes: Buffer; ext: string } => Boolean(photo));
}

/** Keeps downloaded photos as the job's next numbers, while there is room. Returns how many were kept. */
export function storePhotos(root: string, jobId: string, photos: readonly { bytes: Buffer; ext: string }[]): number {
  let saved = 0;
  for (const photo of photos) if (storePhoto(root, jobId, photo)) saved += 1;
  return saved;
}

/**
 * The folder key for the photos that came with one kept message. It goes through photoFolder like a
 * job id, so its folder and links are letters only, and photoLinks and servePhoto work unchanged.
 */
export function messagePhotoId(messageId: string): string {
  return `message:${messageId}`;
}

/** Deletes the photos kept under one id, a job's or a message's. */
export function dropPhotos(root: string, id: string): void {
  const dir = join(photosDir(root), photoFolder(id));
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function sign(key: Buffer, folder: string, n: number, expiry: number): Buffer {
  return createHmac("sha256", key).update(`${folder}|${n}|${expiry}`).digest();
}

function tokenFor(key: Buffer, folder: string, n: number, expiry: number): string {
  return `${toLetters(Buffer.from(`${folder}.${n}.${expiry}`, "utf8"))}${toLetters(sign(key, folder, n, expiry))}`;
}

/** One link per saved photo of the job, each good for one hour. The url is `/cleaner-core/photos/<token>`. */
export function photoLinks(root: string, jobId: string, baseUrl: string, key: Buffer, now: Date): { url: string; expiresAt: string }[] {
  const folder = photoFolder(jobId);
  const expiry = now.getTime() + PHOTO_LINK_MS;
  const base = baseUrl.replace(/\/+$/, "");
  return photoFiles(join(photosDir(root), folder)).map((photo) => ({
    url: `${base}${CLEANER_PHOTO_PREFIX}${tokenFor(key, folder, photo.n, expiry)}`,
    expiresAt: new Date(expiry).toISOString(),
  }));
}

export type ServedPhoto = { status: 404 } | { status: 200; body: Buffer; headers: Record<string, string> };

/** The photo a valid, unexpired token names, sent with no-store. Anything else is not found. */
export function servePhoto(root: string, token: string, key: Buffer | undefined, now: Date): ServedPhoto {
  const missing: ServedPhoto = { status: 404 };
  if (!key || token.length <= SIGNATURE_LETTERS) return missing;
  const payload = fromLetters(token.slice(0, -SIGNATURE_LETTERS))?.toString("utf8");
  const signature = fromLetters(token.slice(-SIGNATURE_LETTERS));
  const match = payload ? /^([a-z]{16})\.(\d{1,2})\.(\d{1,15})$/.exec(payload) : null;
  if (!signature || !match?.[1] || !match[2] || !match[3]) return missing;
  const folder = match[1];
  const n = Number(match[2]);
  const expiry = Number(match[3]);
  const expected = sign(key, folder, n, expiry);
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return missing;
  if (now.getTime() > expiry) return missing;
  const photo = photoFiles(join(photosDir(root), folder)).find((item) => item.n === n);
  const type = photo ? SERVED[photo.ext] : undefined;
  if (!photo || !type) return missing;
  try {
    return {
      status: 200,
      body: readFileSync(join(photosDir(root), folder, photo.file)),
      headers: { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" },
    };
  } catch {
    return missing;
  }
}

/** Deletes each job's photos 30 days after it was done. */
export function prunePhotos(root: string, jobs: readonly { id: string; doneAt?: string }[], now: Date): void {
  for (const job of jobs) {
    if (!job.doneAt || now.getTime() - Date.parse(job.doneAt) < PHOTO_KEEP_MS) continue;
    dropPhotos(root, job.id);
  }
}
