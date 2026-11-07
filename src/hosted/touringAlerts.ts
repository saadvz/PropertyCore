import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeRoutineFireSink, GrokRoutineWebhookSink, NoopOperatorNotificationSink, type OperatorEvent, type OperatorNotificationSink } from "../alerts/operatorEvents";
import { tenantFolder, type Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { ASSISTANT_PROFILES, CLAUDE_FIRE_URL, type CleanerAssistant } from "../cleaner-core/assistant";
import { formatWhen } from "../hub/calendar";
import { PropertyWorkspace } from "../setup/workspace";
import { sendHostText } from "./hostTexts";
import { appendUpdate, lastCheckAt, UpdateFeedSink } from "./touringUpdates";

/**
 * A touring tenant's landlord alerts. Each chat connected to the tenant saves its own routine through a
 * one-time link, kept with that connection's secrets under the touring names. The touring process's
 * events go to the primary chat's routine, or the most recent chat that has one.
 */

export const TOURING_ROUTINE_NAMES = ["TOURING_ROUTINE_URL", "TOURING_ROUTINE_KEY"] as const;
/** A ChatGPT or Muse connection's "1": its recurring task is connected. Nothing secret. */
export const TOURING_TASK_NAME = "TOURING_ROUTINE_TASK";
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

const CLAUDE_REFUSED = "Paste the Fire URL from the scheduled task's API trigger, and its token.";

/** The chat that asked for an upload link, by its connection. */
function uploadAssistant(h: HostedCleaner, tenant: Tenant, grantId: string): CleanerAssistant | undefined {
  return (h.registry.get(tenant.id) ?? tenant).connections.find((c) => c.grantId === grantId)?.assistant;
}

/** The headers on the Claude form page: no framing, no referrer, and it posts only to itself. */
const FORM_HEADERS: Record<string, string> = {
  ...TOURING_ALERT_LINK_HEADERS,
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

/**
 * What a browser sees on the link. A Claude chat's host gets the private form for the scheduled
 * task's Fire URL and token; every other chat posts from its own computer, so its host is told to go back.
 */
export function touringAlertPage(h: HostedCleaner, tenant: Tenant, code: string, error?: string): { status: number; html: string; headers: Record<string, string> } {
  const upload = readUploads(h, tenant.id).find((u) => u.hash === hash(code));
  const open = !!upload && !upload.usedAt && Date.parse(upload.expiresAt) > h.now().getTime();
  if (!open || uploadAssistant(h, tenant, upload!.grantId) !== "claude") return { status: 200, html: TOURING_ALERT_LINK_PAGE, headers: TOURING_ALERT_LINK_HEADERS };
  return { status: error ? 400 : 200, html: claudeForm(error), headers: FORM_HEADERS };
}

const pageShell = (title: string, body: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>${title}</title>
    <style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}label,input{display:block;width:100%}input{margin:.25rem 0 1rem;padding:.5rem}.error{color:#a00}</style>
  </head>
  <body>
    <h1>${title}</h1>
    ${body}
  </body>
</html>
`;

function claudeForm(error?: string): string {
  return pageShell(
    "Connect tour updates",
    `<p>Paste the Fire URL and the token from the Tour Core scheduled task's API trigger. Tour Core uses them only to wake that task when something happens on a tour.</p>
    ${error ? `<p class="error" role="alert">${error}</p>` : ""}
    <form method="post">
      <label for="url">Fire URL</label>
      <input id="url" name="url" type="url" autocomplete="off" spellcheck="false" placeholder="https://api.anthropic.com/v1/claude_code/routines/…/fire" required>
      <label for="token">Token</label>
      <input id="token" name="token" type="password" autocomplete="off" spellcheck="false" required>
      <button type="submit">Save</button>
    </form>
    <p>This private page works once and expires 30 minutes after Claude made it. Nothing you type is shown back to anyone, Claude included.</p>`,
  );
}

/** The page after a form post: saved, gone, or the form again with why. */
export function touringAlertFormReply(h: HostedCleaner, tenant: Tenant, code: string, result: UploadReply): { status: number; html: string; headers: Record<string, string> } {
  if (result.status === 200) return { status: 200, html: pageShell("Saved", "<p>Tour updates are connected. You can close this page and go back to Claude.</p>"), headers: FORM_HEADERS };
  if (result.status === 404) return { status: 404, html: pageShell("This link isn't valid anymore", "<p>It was already used, or it expired. Go back to Claude and ask for a new one.</p>"), headers: FORM_HEADERS };
  return touringAlertPage(h, tenant, code, CLAUDE_REFUSED);
}

type UploadReply = { status: 200 | 400 | 404; body: { ok: boolean; message?: string; error?: string } };

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
  // A Claude chat wakes only a scheduled task's Fire URL, the one shape its sender speaks.
  if (uploadAssistant(h, tenant, upload.grantId) === "claude" && (!CLAUDE_FIRE_URL.test(url) || key.length < 8)) {
    return { status: 400, body: { ok: false, error: CLAUDE_REFUSED } };
  }
  upload.usedAt = new Date(now).toISOString();
  writeUploads(h, tenant.id, uploads);
  h.secrets.setForConnection(tenant.id, upload.grantId, { TOURING_ROUTINE_URL: url, TOURING_ROUTINE_KEY: key });
  h.log(`${tenant.id}'s touring alert routine is connected.`);
  return { status: 200, body: { ok: true, message: "Touring alerts are connected." } };
}

/** The chat whose routine gets the wake: the primary when it has one, else the most recent chat that does. */
type Routine = { kind: "webhook"; url: string; key: string } | { kind: "task" };

function routineConnection(h: HostedCleaner, tenant: Tenant): ({ grantId: string; assistant: Tenant["connections"][number]["assistant"] } & Routine) | undefined {
  const routine = (grantId: string, assistant: CleanerAssistant): Routine | undefined => {
    const saved = h.secrets.connection(tenant.id, grantId);
    if (ASSISTANT_PROFILES[assistant].polledTask) return saved[TOURING_TASK_NAME] === "1" ? { kind: "task" } : undefined;
    return saved.TOURING_ROUTINE_URL && saved.TOURING_ROUTINE_KEY ? { kind: "webhook", url: saved.TOURING_ROUTINE_URL, key: saved.TOURING_ROUTINE_KEY } : undefined;
  };
  const primary = h.registry.primary(tenant.id, (grantId) => h.grantLive(grantId));
  const primaryRoutine = primary ? routine(primary.grantId, primary.assistant) : undefined;
  if (primary && primaryRoutine) return { grantId: primary.grantId, assistant: primary.assistant, ...primaryRoutine };
  const live = [...tenant.connections].filter((c) => h.grantLive(c.grantId)).sort((a, b) => Date.parse(b.connectedAt) - Date.parse(a.connectedAt));
  for (const connection of live) {
    const found = routine(connection.grantId, connection.assistant);
    if (found) return { grantId: connection.grantId, assistant: connection.assistant, ...found };
  }
  return undefined;
}

/** Where a touring tenant's events go: a Grok or Claude routine's wake, or a ChatGPT or Muse task's list. */
export function touringSinkFor(h: HostedCleaner, tenant: Tenant): OperatorNotificationSink {
  const current = h.registry.get(tenant.id) ?? tenant;
  const chosen = routineConnection(h, current);
  if (!chosen) return new NoopOperatorNotificationSink();
  if (chosen.kind === "task") return new UpdateFeedSink(h, tenant.id);
  const settings = { url: () => chosen.url, key: () => chosen.key };
  const options = alertFetch ? { fetch: alertFetch } : {};
  if (chosen.assistant === "grok") return new GrokRoutineWebhookSink(settings, options);
  if (chosen.assistant === "claude") return new ClaudeRoutineFireSink(settings, options);
  return new NoopOperatorNotificationSink();
}

export function touringAlertsConnected(h: HostedCleaner, tenant: Tenant): boolean {
  return touringSinkFor(h, tenant).configured();
}

/** True when the chosen connection is a ChatGPT or Muse task. */
export function touringAlertsPolled(h: HostedCleaner, tenant: Tenant): boolean {
  return routineConnection(h, h.registry.get(tenant.id) ?? tenant)?.kind === "task";
}

/** Longer than one missed hourly run, as Cleaner Core waits. */
const TASK_GAP_MS = 2.5 * 3_600_000;

/**
 * The warning when the chosen chat's recurring task hasn't called get_updates for too long, once a
 * property is published. The task can pause itself, and nothing else would tell the host.
 */
export function taskWarning(h: HostedCleaner, tenant: Tenant, published: boolean): string | undefined {
  const chosen = routineConnection(h, h.registry.get(tenant.id) ?? tenant);
  if (!published || chosen?.kind !== "task") return undefined;
  const last = lastCheckAt(h, tenant.id, chosen.grantId);
  if (!last || h.now().getTime() - Date.parse(last) <= TASK_GAP_MS) return undefined;
  const when = formatWhen(last, touringTimeZone(h, tenant.id));
  return `Your Tour Core task hasn't checked in since ${when.day} at ${when.time}. Turn it back on in your chat's scheduled tasks.`;
}

/** The time zone of the tenant's first property, for saying a time. UTC when there's none. */
function touringTimeZone(h: HostedCleaner, tenantId: string): string {
  try {
    const ws = new PropertyWorkspace(join(tenantFolder(h.dataRoot, tenantId), "tour-core"));
    return ws.list().map(({ config }) => config.property.timezone).find(Boolean) ?? "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * One tour event from the tenant's touring process: onto the "what's new" list every chat can read
 * with get_updates, to the host's phone when their choice covers it, and to the chosen chat's routine.
 * Only the routine's delivery decides whether the touring process retries; it throws when that fails.
 */
export async function deliverTouringEvent(h: HostedCleaner, tenant: Tenant, event: OperatorEvent): Promise<void> {
  appendUpdate(h, tenant.id, event);
  void sendHostText(h, tenant, event);
  await touringSinkFor(h, tenant).deliver(event);
}

/** Tells the tenant's touring process whether its updates are connected, and how. */
export function refreshTouringAlerts(h: HostedCleaner, tenant: Tenant): void {
  h.touring?.supervisor.setAlerts(tenant.id, touringAlertsConnected(h, tenant), touringAlertsPolled(h, tenant));
}
