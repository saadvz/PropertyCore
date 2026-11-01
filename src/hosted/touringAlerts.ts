import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeRoutineFireSink, GrokRoutineWebhookSink, NoopOperatorNotificationSink, type OperatorNotificationSink } from "../alerts/operatorEvents";
import { tenantFolder, type Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import { writeJsonAtomic } from "../storage/atomicWrite";

/**
 * A touring tenant's landlord alerts. Each chat connected to the tenant saves its own routine through a
 * one-time link, kept with that connection's secrets under the touring names. The touring process's
 * events go to the primary chat's routine, or the most recent chat that has one.
 */

export const TOURING_ROUTINE_NAMES = ["TOURING_ROUTINE_URL", "TOURING_ROUTINE_KEY"] as const;
export const TOURING_ALERT_UPLOAD_PREFIX = "/touring/alert-routine/";

const UPLOAD_CODE = /^[A-Za-z0-9_-]{43}$/;
export const TOURING_ALERT_LINK_MINUTES = 30;
const LINK_MS = TOURING_ALERT_LINK_MINUTES * 60_000;
const MAX_KEY = 512;

type AlertFetch = NonNullable<ConstructorParameters<typeof GrokRoutineWebhookSink>[1]>["fetch"];
let alertFetch: AlertFetch | undefined;

/** Tests replace the network for touring wakes here. */
export function setTouringAlertFetch(next: AlertFetch | undefined): void {
  alertFetch = next;
}

interface Upload {
  hash: string;
  grantId: string;
  expiresAt: string;
  usedAt?: string;
}

const hash = (code: string) => createHash("sha256").update(code).digest("hex");
const uploadsFile = (h: HostedCleaner, tenantId: string) => join(tenantFolder(h.dataRoot, tenantId), "touring-uploads.json");

function readUploads(h: HostedCleaner, tenantId: string): Upload[] {
  const file = uploadsFile(h, tenantId);
  if (!existsSync(file)) return [];
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as { uploads?: Upload[] };
    return Array.isArray(doc.uploads) ? doc.uploads : [];
  } catch {
    return [];
  }
}

function writeUploads(h: HostedCleaner, tenantId: string, uploads: Upload[]): void {
  const now = h.now().getTime();
  writeJsonAtomic(uploadsFile(h, tenantId), { uploads: uploads.filter((u) => Date.parse(u.expiresAt) > now - LINK_MS) });
}

/** A one-time link for the chat on `grantId` to save its touring routine. */
export function issueTouringAlertLink(h: HostedCleaner, tenant: Tenant, grantId: string): string {
  const code = randomBytes(32).toString("base64url");
  const uploads = readUploads(h, tenant.id);
  uploads.push({ hash: hash(code), grantId, expiresAt: new Date(h.now().getTime() + LINK_MS).toISOString() });
  writeUploads(h, tenant.id, uploads);
  return `${h.origin() ?? ""}/t/${tenant.id}${TOURING_ALERT_UPLOAD_PREFIX}${code}`;
}

/** The code in a touring alert upload path, or undefined. */
export function touringAlertUploadCode(rest: string): string | undefined {
  if (!rest.startsWith(TOURING_ALERT_UPLOAD_PREFIX)) return undefined;
  const code = rest.slice(TOURING_ALERT_UPLOAD_PREFIX.length);
  return UPLOAD_CODE.test(code) ? code : undefined;
}

/**
 * What a browser sees on the link. The chat posts to it from its own computer, so a host who opens it
 * is told to go back instead of seeing "Not found". It never uses the link up.
 */
export const TOURING_ALERT_LINK_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>Tour updates</title>
    <style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}</style>
  </head>
  <body>
    <h1>Nothing to do here</h1>
    <p>This link is for your assistant, which connects tour updates for you. Go back to your chat and say "connect my tour updates".</p>
  </body>
</html>
`;

export const TOURING_ALERT_LINK_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

type UploadReply ={ status: 200 | 400 | 404; body: { ok: boolean; message?: string; error?: string } };

/** Saves the routine from the one-time link. The address and key are never repeated or logged. */
export function handleTouringAlertUpload(h: HostedCleaner, tenant: Tenant, code: string, body: Record<string, unknown>): UploadReply {
  const uploads = readUploads(h, tenant.id);
  const upload = uploads.find((u) => u.hash === hash(code));
  const now = h.now().getTime();
  if (!upload || upload.usedAt || Date.parse(upload.expiresAt) <= now) return { status: 404, body: { ok: false, error: "This link was already used or has expired. Ask for a new one." } };
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const given = typeof body.token === "string" ? body.token : typeof body.key === "string" ? body.key : "";
  const key = given.trim();
  let https = false;
  try {
    https = new URL(url).protocol === "https:";
  } catch {
    https = false;
  }
  if (!https || !key || key.length > MAX_KEY) return { status: 400, body: { ok: false, error: "That needs the routine's https webhook address and its key." } };
  upload.usedAt = new Date(now).toISOString();
  writeUploads(h, tenant.id, uploads);
  h.secrets.setForConnection(tenant.id, upload.grantId, { TOURING_ROUTINE_URL: url, TOURING_ROUTINE_KEY: key });
  h.log(`${tenant.id}'s touring alert routine is connected.`);
  return { status: 200, body: { ok: true, message: "Touring alerts are connected." } };
}

/** The chat whose routine gets the wake: the primary when it has one, else the most recent chat that does. */
function routineConnection(h: HostedCleaner, tenant: Tenant): { grantId: string; assistant: Tenant["connections"][number]["assistant"]; url: string; key: string } | undefined {
  const routine = (grantId: string) => {
    const saved = h.secrets.connection(tenant.id, grantId);
    return saved.TOURING_ROUTINE_URL && saved.TOURING_ROUTINE_KEY ? { url: saved.TOURING_ROUTINE_URL, key: saved.TOURING_ROUTINE_KEY } : undefined;
  };
  const primary = h.registry.primary(tenant.id, (grantId) => h.grantLive(grantId));
  const primaryRoutine = primary ? routine(primary.grantId) : undefined;
  if (primary && primaryRoutine) return { grantId: primary.grantId, assistant: primary.assistant, ...primaryRoutine };
  const live = [...tenant.connections].filter((c) => h.grantLive(c.grantId)).sort((a, b) => Date.parse(b.connectedAt) - Date.parse(a.connectedAt));
  for (const connection of live) {
    const found = routine(connection.grantId);
    if (found) return { grantId: connection.grantId, assistant: connection.assistant, ...found };
  }
  return undefined;
}

/** Where a touring tenant's events go. ChatGPT and Muse poll for alerts and aren't connected for touring yet. */
export function touringSinkFor(h: HostedCleaner, tenant: Tenant): OperatorNotificationSink {
  const current = h.registry.get(tenant.id) ?? tenant;
  const chosen = routineConnection(h, current);
  if (!chosen) return new NoopOperatorNotificationSink();
  const settings = { url: () => chosen.url, key: () => chosen.key };
  const options = alertFetch ? { fetch: alertFetch } : {};
  if (chosen.assistant === "grok") return new GrokRoutineWebhookSink(settings, options);
  if (chosen.assistant === "claude") return new ClaudeRoutineFireSink(settings, options);
  return new NoopOperatorNotificationSink();
}

export function touringAlertsConnected(h: HostedCleaner, tenant: Tenant): boolean {
  return touringSinkFor(h, tenant).configured();
}
