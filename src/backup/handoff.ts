import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic, writeJsonAtomic } from "../storage/atomicWrite";
import { RestoreUploadTooLargeError, restoreUploadMaxBytes } from "./limits";

/** Short-lived capability for Grok to download or upload one artifact. Not a public URL. */
export const HANDOFF_TTL_MS = 15 * 60_000;

interface HandoffRecord {
  schemaVersion: 1;
  kind: "download" | "upload";
  tokenHash: string;
  fileName?: string;
  checksum?: string;
  expiresAt: number;
  createdAt: number;
  /** Present after a download is prepared. Uploads keep bytes in a sibling file. */
  body?: string;
  /** Upload bytes live in `${id}.body`, not in this JSON record. */
  bodyFile?: boolean;
  bytes?: number;
  consumed?: boolean;
  /** Set once an upload link has expired, so a later preview still explains it. */
  expired?: boolean;
  /** Keep the expired explanation this long, then drop the record. */
  tombstoneUntil?: number;
}

/** How long an expired upload keeps the timed-out explanation. */
const TOMBSTONE_MS = 7 * 24 * 60 * 60 * 1000;

/** Preview or import was asked before the backup file was stored. */
export const UPLOAD_BACKUP_FIRST = "Upload the backup file first, then I can show you what's in it.";

/** Every expired upload, including a second look and a file that arrived before the link expired. */
export const UPLOAD_TIMED_OUT = "That upload timed out. Send me the backup file again and I'll check it.";

export class HandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffError";
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function matches(stored: string, token: string): boolean {
  const given = hashToken(token);
  const a = Buffer.from(stored);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The record id from a handoff record path, e.g. `.../portable-handoff/<id>.json`. */
export function handoffIdFromPath(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1, -".json".length);
}

/**
 * Artifacts live beside the data folder, outside install/properties/runtime,
 * so a portable snapshot never includes the handoff itself.
 */
export class HandoffStore {
  constructor(
    private readonly root: string,
    private readonly now: () => number,
  ) {}

  private dir(): string {
    return join(this.root, "portable-handoff");
  }

  private path(id: string): string {
    if (!/^art_[A-Za-z0-9_-]{20,80}$/.test(id)) throw new HandoffError("That backup link isn't valid.");
    return join(this.dir(), `${id}.json`);
  }

  sweep(): void {
    const dir = this.dir();
    if (!existsSync(dir)) return;
    const now = this.now();
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as HandoffRecord;
        if (record.consumed) {
          rmSync(join(dir, name), { force: true });
          rmSync(join(dir, `${name.slice(0, -".json".length)}.body`), { force: true });
          continue;
        }
        if (record.expired) {
          if ((record.tombstoneUntil ?? 0) <= now) {
            rmSync(join(dir, name), { force: true });
            rmSync(join(dir, `${name.slice(0, -".json".length)}.body`), { force: true });
          }
          continue;
        }
        if (record.expiresAt <= now) {
          if (record.kind === "upload") this.writeTombstone(join(dir, name), record);
          else {
            rmSync(join(dir, name), { force: true });
            rmSync(join(dir, `${name.slice(0, -".json".length)}.body`), { force: true });
          }
        }
      } catch {
        rmSync(join(dir, name), { force: true });
      }
    }
  }

  /** A temp file in the handoff directory so a finished upload can be renamed into place. */
  incomingPath(): string {
    mkdirSync(this.dir(), { recursive: true });
    return join(this.dir(), `.incoming-${randomBytes(9).toString("hex")}.tmp`);
  }

  putDownload(body: string, fileName: string, checksum: string): { id: string; capability: string; expiresAt: string; path: string } {
    this.sweep();
    const id = `art_${randomBytes(24).toString("base64url")}`;
    const capability = randomBytes(32).toString("base64url");
    const createdAt = this.now();
    const expiresAt = createdAt + HANDOFF_TTL_MS;
    const record: HandoffRecord = { schemaVersion: 1, kind: "download", tokenHash: hashToken(capability), fileName, checksum, expiresAt, createdAt, body };
    mkdirSync(this.dir(), { recursive: true });
    writeJsonAtomic(this.path(id), record);
    return { id, capability, expiresAt: new Date(expiresAt).toISOString(), path: `/portable/artifacts/${id}` };
  }

  /** One successful download deletes the artifact. */
  takeDownload(id: string, capability: string): { body: string; fileName: string; checksum?: string } {
    this.sweep();
    const record = this.read(id);
    if (!record || record.kind !== "download" || record.consumed || record.expiresAt <= this.now() || !record.body || !matches(record.tokenHash, capability)) {
      throw new HandoffError("That backup link has expired.");
    }
    rmSync(this.path(id), { force: true });
    return { body: record.body, fileName: record.fileName ?? "tour-core-backup.json", checksum: record.checksum };
  }

  beginUpload(): { id: string; capability: string; expiresAt: string; path: string } {
    this.sweep();
    const id = `art_${randomBytes(24).toString("base64url")}`;
    const capability = randomBytes(32).toString("base64url");
    const createdAt = this.now();
    const expiresAt = createdAt + HANDOFF_TTL_MS;
    const record: HandoffRecord = { schemaVersion: 1, kind: "upload", tokenHash: hashToken(capability), expiresAt, createdAt };
    mkdirSync(this.dir(), { recursive: true });
    writeJsonAtomic(this.path(id), record);
    return { id, capability, expiresAt: new Date(expiresAt).toISOString(), path: `/portable/uploads/${id}` };
  }

  /** Stores the uploaded text. Does not import it. */
  receiveUpload(id: string, capability: string, body: string): void {
    const record = this.openUpload(id, capability);
    const bytes = Buffer.byteLength(body);
    this.assertUploadSize(bytes);
    const dest = this.bodyPath(id);
    writeFileAtomic(dest, body);
    this.markUploaded(id, record, bytes);
  }

  /**
   * Moves an already-spooled upload into the handoff. The file is raw backup
   * bytes, so preview reads it once instead of keeping extra copies from the request.
   */
  acceptUploadFile(id: string, capability: string, filePath: string): void {
    const record = this.openUpload(id, capability);
    const bytes = existsSync(filePath) ? statSync(filePath).size : 0;
    this.assertUploadSize(bytes);
    const dest = this.bodyPath(id);
    renameSync(filePath, dest);
    try {
      this.markUploaded(id, record, bytes);
    } catch (err) {
      rmSync(dest, { force: true });
      throw err;
    }
  }

  /**
   * Accepts a file only for a live upload that has not been stored.
   * Reads the handoff record and does not create a file.
   */
  assertUploadAvailable(id: string, capability: string): void {
    const record = this.read(id);
    const capabilityOk = !!record && matches(record.tokenHash, capability);
    if (!record || record.kind !== "upload" || record.consumed || record.expiresAt <= this.now() || record.body || record.bodyFile || !capabilityOk) {
      throw new HandoffError("That restore link has expired.");
    }
  }

  readUpload(id: string): string {
    this.sweep();
    const record = this.read(id);
    if (record?.kind === "upload" && (record.expired || record.expiresAt <= this.now())) {
      throw new HandoffError(UPLOAD_TIMED_OUT);
    }
    if (!record || record.kind !== "upload" || (!record.body && !record.bodyFile)) {
      throw new HandoffError(UPLOAD_BACKUP_FIRST);
    }
    if (record.bodyFile) {
      const path = this.bodyPath(id);
      if (!existsSync(path)) throw new HandoffError(UPLOAD_BACKUP_FIRST);
      return readFileSync(path, "utf8");
    }
    return record.body!;
  }

  consumeUpload(id: string): void {
    this.discard(id);
  }

  /** Drops the file and keeps a small expired record so the timed-out line still shows. */
  private writeTombstone(path: string, record: HandoffRecord): void {
    const id = handoffIdFromPath(path);
    rmSync(this.bodyPath(id), { force: true });
    const now = this.now();
    writeJsonAtomic(path, {
      schemaVersion: 1 as const,
      kind: "upload" as const,
      tokenHash: record.tokenHash,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      expired: true,
      tombstoneUntil: now + TOMBSTONE_MS,
    });
  }

  private bodyPath(id: string): string {
    return join(this.dir(), `${id}.body`);
  }

  private discard(id: string): void {
    rmSync(this.path(id), { force: true });
    rmSync(this.bodyPath(id), { force: true });
  }

  private openUpload(id: string, capability: string): HandoffRecord {
    this.sweep();
    const record = this.read(id);
    if (!record || record.kind !== "upload" || record.consumed || record.expiresAt <= this.now() || record.body || record.bodyFile || !matches(record.tokenHash, capability)) {
      throw new HandoffError("That restore link has expired.");
    }
    return record;
  }

  private assertUploadSize(bytes: number): void {
    const max = restoreUploadMaxBytes();
    if (bytes > max) throw new RestoreUploadTooLargeError(max);
  }

  private markUploaded(id: string, record: HandoffRecord, bytes: number): void {
    writeJsonAtomic(this.path(id), { ...record, bodyFile: true, bytes });
  }

  private read(id: string): HandoffRecord | undefined {
    let path: string;
    try {
      path = this.path(id);
    } catch {
      return undefined;
    }
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as HandoffRecord;
    } catch {
      return undefined;
    }
  }
}
