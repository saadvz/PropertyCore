import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { randomInt } from "node:crypto";
import { hashSecret } from "../mcp/oauth/store";
import { SetupInputError } from "../setup/setupActions";
import { writeJsonAtomic } from "../storage/atomicWrite";

/**
 * Explicit operator approval for consequential actions (publish, pausing or
 * resuming a tour, calling one off, adding an approved fact). The first call
 * returns the exact question to ask and a short code bound to that action,
 * that target and the current state. Only a second call carrying the code
 * does the work, and only if nothing changed in between. Codes are single
 * use and expire quickly.
 *
 * Without a file, codes live only in this process, so a restart means asking
 * again. With a file, pending codes are kept there as hashes, so an approval
 * survives a restart with the same expiry and still works once only.
 */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface Pending {
  action: string;
  target: string;
  fingerprint: string;
  /** Epoch ms. Infinity for a code that never expires. */
  expiresAt: number;
  /** Groups codes so they can be dropped together, such as every code for one draft. */
  tag?: string;
}

/** The file's shape. Codes are keyed by their hash; a code that never expires has expiresAt null. */
interface StoredBook {
  version: 1;
  pending: Record<string, Omit<Pending, "expiresAt"> & { expiresAt: number | null }>;
}

export interface ConfirmationRequest {
  code: string;
  question: string;
  /** Left out when the book's codes never expire. */
  expiresInMinutes?: number;
}

export interface ConfirmationBookOptions {
  /** Where pending codes are kept across restarts. Unset keeps them only in memory. */
  file?: string;
}

const keyOf = (code: string) => hashSecret(code.trim().toUpperCase());

export class ConfirmationBook {
  /** Pending codes by the hash of the code. */
  private readonly pending = new Map<string, Pending>();
  private readonly file: string | undefined;

  constructor(
    /** Number.POSITIVE_INFINITY makes codes that never expire. */
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = () => Date.now(),
    options: ConfirmationBookOptions = {},
  ) {
    this.file = options.file;
    this.load();
  }

  issue(action: string, target: string, fingerprint: string, question: string, tag?: string): ConfirmationRequest {
    this.sweep();
    let code: string;
    do code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    while (this.pending.has(keyOf(code)));
    this.pending.set(keyOf(code), { action, target, fingerprint, expiresAt: this.now() + this.ttlMs, ...(tag !== undefined ? { tag } : {}) });
    this.save();
    return { code, question, ...(Number.isFinite(this.ttlMs) ? { expiresInMinutes: Math.round(this.ttlMs / 60_000) } : {}) };
  }

  /** Looks up an unused code without consuming it. */
  peek(code: string): { action: string; target: string; fingerprint: string } | undefined {
    this.sweep();
    const entry = this.pending.get(keyOf(code));
    return entry ? { action: entry.action, target: entry.target, fingerprint: entry.fingerprint } : undefined;
  }

  /**
   * Uses up the code. Throws in plain language if it doesn't match this exact action, target and state.
   * The code is gone from the file before this returns, so a crash during the action can't reuse it.
   */
  redeem(code: string, action: string, target: string, fingerprint: string): void {
    this.sweep();
    const key = keyOf(code);
    const entry = this.pending.get(key);
    if (this.pending.delete(key)) this.save();
    if (!entry) throw new SetupInputError("CONFIRMATION_EXPIRED", "That approval has expired or was already used. Ask the operator again.");
    if (entry.action !== action || entry.target !== target) throw new SetupInputError("CONFIRMATION_MISMATCH", "That approval was for something else. Ask the operator again.");
    if (entry.fingerprint !== fingerprint) throw new SetupInputError("CONFIRMATION_STALE", "Something changed since the operator approved this. Show them the current details and ask again.");
  }

  /** Drops one code, used or not. Nothing happens for a code it doesn't hold. */
  drop(code: string): void {
    if (this.pending.delete(keyOf(code))) this.save();
  }

  /** Drops every code issued with this tag. */
  dropTagged(tag: string): void {
    let changed = false;
    for (const [key, entry] of this.pending) {
      if (entry.tag === tag) changed = this.pending.delete(key) || changed;
    }
    if (changed) this.save();
  }

  /** How many codes are waiting. */
  get size(): number {
    this.sweep();
    return this.pending.size;
  }

  /** Drops every outstanding approval. Used when the installation they belonged to is gone. */
  clear(): void {
    this.pending.clear();
    if (this.file) rmSync(this.file, { force: true });
  }

  private sweep(): void {
    const now = this.now();
    let changed = false;
    for (const [key, entry] of this.pending) {
      if (entry.expiresAt <= now) changed = this.pending.delete(key) || changed;
    }
    if (changed) this.save();
  }

  /** Reads the file once. A missing or unreadable file means nothing is pending. */
  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    let stored: Partial<StoredBook>;
    try {
      stored = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoredBook>;
    } catch {
      return;
    }
    if (stored.version !== 1 || !stored.pending || typeof stored.pending !== "object") return;
    for (const [key, entry] of Object.entries(stored.pending)) {
      if (!entry || typeof entry.action !== "string" || typeof entry.target !== "string" || typeof entry.fingerprint !== "string") continue;
      const expiresAt = entry.expiresAt === null ? Number.POSITIVE_INFINITY : entry.expiresAt;
      if (typeof expiresAt !== "number" || Number.isNaN(expiresAt)) continue;
      this.pending.set(key, { action: entry.action, target: entry.target, fingerprint: entry.fingerprint, expiresAt, ...(typeof entry.tag === "string" ? { tag: entry.tag } : {}) });
    }
  }

  private save(): void {
    if (!this.file) return;
    if (this.pending.size === 0) {
      rmSync(this.file, { force: true });
      return;
    }
    const pending: StoredBook["pending"] = {};
    for (const [key, entry] of this.pending) pending[key] = { ...entry, expiresAt: Number.isFinite(entry.expiresAt) ? entry.expiresAt : null };
    writeJsonAtomic(this.file, { version: 1, pending } satisfies StoredBook);
    chmodSync(this.file, 0o600);
  }
}
