import { timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { hashSecret } from "../mcp/oauth/store";
import type { Installation } from "./installation";

/**
 * The owner of the single hosted demo installation: checks the owner's
 * browser session and CSRF token, and releases the owner so the demo is
 * unclaimed. SecretStore keeps only hashes.
 *
 * This exists only because HOSTED_RAILWAY_P0 is one shared demo. It is not
 * the future Marketplace sign-in. The owner cookie proves who may approve.
 * An OAuth request id does not.
 */

export const HOSTED_OWNER_RESET = "reset-hosted-owner";
export const OWNER_COOKIE = "tourcore_owner";
/** A one-time claim file older builds wrote. Nothing writes it now; releasing the owner still deletes it. */
const CLAIM_FILE = "owner-claim.once";
const TOKEN = /^[A-Za-z0-9_-]{20,80}$/;
export const OAUTH_REQUEST_ID = /^[A-Za-z0-9_-]{16,80}$/;

export const claimFilePath = (root: string) => join(root, "install", CLAIM_FILE);

export type OwnerCheck = { ok: true; ownerId: string } | { ok: false; reason: "missing" | "unknown" | "expired" };

/** Hash both sides, then compare in constant time. Length differences do not skip the compare. */
const hashesEqual = (given: string, expectedHex: string) => {
  const actual = Buffer.from(hashSecret(given), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && expected.length > 0 && timingSafeEqual(actual, expected);
};

function deleteClaimFile(root: string): void {
  rmSync(claimFilePath(root), { force: true });
}

/**
 * Drops the hosted owner session and claim so the demo is unclaimed.
 * Does not mint a new claim and does not delete tour records.
 * A bootstrap secret that was already used stays spent.
 */
export function releaseHostedOwner(inst: Installation): void {
  const consumed = inst.secrets.hostedOwner()?.consumedBootstrapHash;
  inst.secrets.saveHostedOwner(undefined);
  deleteClaimFile(inst.root);
  if (!consumed) return;
  inst.secrets.saveHostedOwner({
    schemaVersion: 1,
    claimHash: consumed,
    claimed: false,
    consumedBootstrapHash: consumed,
  });
}

export function hostedInstallationClaimed(inst: Installation): boolean {
  return !!inst.secrets.hostedOwner()?.claimed;
}

export function ownerFromCookie(inst: Installation, cookieHeader: string | undefined): OwnerCheck {
  const token = readCookie(cookieHeader, OWNER_COOKIE);
  if (!token || !TOKEN.test(token)) return { ok: false, reason: token ? "unknown" : "missing" };
  const record = inst.secrets.hostedOwner();
  if (!record?.claimed || !record.sessionHash || !record.ownerId) return { ok: false, reason: "unknown" };
  if (!record.sessionExpiresAt || record.sessionExpiresAt <= inst.now()) return { ok: false, reason: "expired" };
  if (!hashesEqual(token, record.sessionHash)) return { ok: false, reason: "unknown" };
  return { ok: true, ownerId: record.ownerId };
}

export function ownerCsrfOk(inst: Installation, cookieHeader: string | undefined, csrf: string | undefined): boolean {
  const session = ownerFromCookie(inst, cookieHeader);
  if (!session.ok) return false;
  const record = inst.secrets.hostedOwner();
  if (!record?.csrfHash || !csrf || !TOKEN.test(csrf)) return false;
  return hashesEqual(csrf, record.csrfHash);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}
