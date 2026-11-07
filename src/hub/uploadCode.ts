import { createHash, timingSafeEqual } from "node:crypto";

/** What every one-time upload link in the hub shares: its lifetime, its refusal, and how its code is kept. */

export const UPLOAD_MINUTES = 10;
export const UPLOAD_GONE = "This upload link isn't valid anymore. Ask for a new one.";

export function uploadHash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Compares two sha256 hex digests in constant time. */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
}
