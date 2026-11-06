import { randomInt } from "node:crypto";
import { SetupInputError } from "../setup/setupActions";

/**
 * Explicit operator approval for consequential actions (publish, pausing or
 * resuming a tour, calling one off, adding an approved fact). The first call
 * returns the exact question to ask and a short code bound to that action,
 * that target and the current state. Only a second call carrying the code
 * does the work, and only if nothing changed in between. Codes are single
 * use, expire quickly and live only in this process, so a restart simply
 * means asking again.
 */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface Pending {
  action: string;
  target: string;
  fingerprint: string;
  expiresAt: number;
}

export interface ConfirmationRequest {
  code: string;
  question: string;
  /** Left out when the book's codes never expire. */
  expiresInMinutes?: number;
}

export class ConfirmationBook {
  private readonly pending = new Map<string, Pending>();

  constructor(
    /** Number.POSITIVE_INFINITY makes codes that never expire. */
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  issue(action: string, target: string, fingerprint: string, question: string): ConfirmationRequest {
    this.sweep();
    let code: string;
    do code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    while (this.pending.has(code));
    this.pending.set(code, { action, target, fingerprint, expiresAt: this.now() + this.ttlMs });
    return { code, question, ...(Number.isFinite(this.ttlMs) ? { expiresInMinutes: Math.round(this.ttlMs / 60_000) } : {}) };
  }

  /** Looks up an unused code without consuming it. */
  peek(code: string): { action: string; target: string; fingerprint: string } | undefined {
    this.sweep();
    const entry = this.pending.get(code.trim().toUpperCase());
    return entry ? { action: entry.action, target: entry.target, fingerprint: entry.fingerprint } : undefined;
  }

  /** Uses up the code. Throws in plain language if it doesn't match this exact action, target and state. */
  redeem(code: string, action: string, target: string, fingerprint: string): void {
    this.sweep();
    const key = code.trim().toUpperCase();
    const entry = this.pending.get(key);
    this.pending.delete(key);
    if (!entry) throw new SetupInputError("CONFIRMATION_EXPIRED", "That approval has expired or was already used. Ask the operator again.");
    if (entry.action !== action || entry.target !== target) throw new SetupInputError("CONFIRMATION_MISMATCH", "That approval was for something else. Ask the operator again.");
    if (entry.fingerprint !== fingerprint) throw new SetupInputError("CONFIRMATION_STALE", "Something changed since the operator approved this. Show them the current details and ask again.");
  }

  /** Drops one code, used or not. Nothing happens for a code it doesn't hold. */
  drop(code: string): void {
    this.pending.delete(code.trim().toUpperCase());
  }

  /** How many codes are waiting. */
  get size(): number {
    this.sweep();
    return this.pending.size;
  }

  /** Drops every outstanding approval. Used when the installation they belonged to is gone. */
  clear(): void {
    this.pending.clear();
  }

  private sweep(): void {
    const now = this.now();
    for (const [code, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(code);
  }
}
