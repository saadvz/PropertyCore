import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { ASSISTANT_PROFILES, type CleanerAssistant } from "../assistant";
import { currentCaller } from "../callerContext";
import {
  ALERT_UPLOAD_MAX_BYTES,
  alertUploadCode,
  calendarUploadCode,
  CLEANER_MCP_PATH,
  CLEANER_TWILIO_GROUP_PATH,
  CLEANER_TWILIO_PATH,
  CLEANER_TWILIO_STATUS_PATH,
  doorCodeUploadCode,
  handleCleanerAlertUpload,
  handleCleanerCalendarUpload,
  handleCleanerDoorCodeUpload,
  handleCleanerGroupWebhook,
  handleCleanerMcpHttp,
  handleCleanerTwilioStatus,
  handleCleanerTwilioWebhook,
  uploadBody,
  uploadPageOf,
} from "../http";
import { drainCleanerAlerts, liveDeskFor } from "../liveDesk";
import type { DeleteSecrets, SaveSecrets } from "../mcp";
import { CLEANER_PHOTO_PREFIX, photoKey, servePhoto } from "../photos";
import { handleCleanerUploadPage, isFormPost } from "../uploadPage";
import { isTenantId, tenantFolder, type Tenant, type TenantRegistry } from "./registry";
import { screenText } from "../../hosted/crossService";
import { handleTenantMcp } from "../../hosted/frontMcp";
import type { TouringFront } from "../../hosted/serviceTools";
import { handleTouringAlertUpload, TOURING_ALERT_LINK_HEADERS, TOURING_ALERT_LINK_PAGE, touringAlertsConnected, touringAlertUploadCode } from "../../hosted/touringAlerts";
import { forwardTenantPath } from "../../hosted/touringForward";
import { touringPublicRoute } from "../../hosted/workerRoutes";
import { MCP_PATH } from "../../mcp/paths";
import { TWILIO_WEBHOOK_PATH } from "../../messaging/twilio/provider";
import { formParams, verifyTwilioSignature } from "../../messaging/twilio/signature";
import { buildTenantEnv, ROUTINE_NAMES } from "./tenantEnv";
import type { TenantSecrets } from "./tenantSecrets";

/**
 * The multi-tenant Cleaner Core's front door. Every request resolves one tenant (an OAuth grant, the
 * Twilio number a text was sent to, or the /t/<id>/ prefix on a link Cleaner Core gave out) and then
 * goes to the same handlers a single-tenant deployment uses, with that tenant's folder and
 * environment. A request that names no tenant stops here.
 */

export interface HostedCleaner {
  registry: TenantRegistry;
  secrets: TenantSecrets;
  dataRoot: string;
  /** The service's https origin. Undefined until the public address is known. */
  origin(): string | undefined;
  /** The process environment, before any tenant's values. */
  baseEnv(): NodeJS.ProcessEnv;
  grantLive(grantId: string): boolean;
  now(): Date;
  log(line: string): void;
  /** Touring tenants' processes and saved texts. Absent when the service runs no touring. */
  touring?: TouringFront;
}

export function hostedCleaner(h: HostedCleaner): HostedCleaner {
  return h;
}

export interface TenantContext {
  root: string;
  env: () => NodeJS.ProcessEnv;
  saveSecrets: SaveSecrets;
  deleteSecrets: DeleteSecrets;
}

const ROUTINE = new Set<string>(ROUTINE_NAMES);
const UNLINKED = "This connection isn't linked to a Cleaner Core account. Reconnect with an invite code from Saad.";
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const TOUR_CORE_PATHS = new Set(["/mcp/ops", "/mcp/qa"]);
const TENANT_PATH = /^\/t\/([^/]+)(\/.+)$/;

export function splitTenantPath(pathname: string): { tenantId: string; rest: string } | undefined {
  const match = TENANT_PATH.exec(pathname);
  if (!match || !isTenantId(match[1]!)) return undefined;
  return { tenantId: match[1]!, rest: match[2]! };
}

/** A tenant's folder, its environment (rebuilt on every read, so a saved secret is seen at once), and its secret saver. */
export function tenantContext(h: HostedCleaner, tenant: Tenant): TenantContext {
  const id = tenant.id;
  return {
    root: tenantFolder(h.dataRoot, id),
    env: () => {
      const current = h.registry.get(id);
      const primary = h.registry.primary(id, (grantId) => h.grantLive(grantId));
      const env = buildTenantEnv({ base: h.baseEnv(), tenant: current ?? tenant, secrets: h.secrets, primary, origin: h.origin() ?? "" });
      // Deleted or turned off while a request or drain was under way: nothing more is sent for it.
      if (!current || current.disabled) env.CLEANER_CORE_ENABLED = "0";
      return env;
    },
    // A routine belongs to the connection that saved it. Everything else is the tenant's.
    saveSecrets: (values) => {
      const connection = currentCaller()?.connectionId;
      const own: Record<string, string> = {};
      const routine: Record<string, string> = {};
      for (const [name, value] of Object.entries(values)) {
        if (value === undefined) continue;
        if (connection && ROUTINE.has(name)) routine[name] = value;
        else own[name] = value;
      }
      if (Object.keys(own).length > 0) h.secrets.set(id, own);
      if (connection && Object.keys(routine).length > 0) h.secrets.setForConnection(id, connection, routine);
    },
    deleteSecrets: (names) => h.secrets.delete(id, names),
  };
}

/** The chat a private upload page speaks as when its link doesn't say: the primary when it uses pages, else the first connection that does. */
function pageAssistant(h: HostedCleaner, tenant: Tenant): CleanerAssistant | undefined {
  const primary = h.registry.primary(tenant.id, (grantId) => h.grantLive(grantId));
  if (primary && ASSISTANT_PROFILES[primary.assistant].privatePages) return primary.assistant;
  return tenant.connections.find((c) => ASSISTANT_PROFILES[c.assistant].privatePages)?.assistant;
}

function formTo(raw: Buffer): string {
  return new URLSearchParams(raw.toString("utf8")).get("To") ?? "";
}

export interface HostedRequest {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  send(status: number, type: string, body: string, extra?: Record<string, string>): void;
  readRaw(): Promise<Buffer>;
  readCapped(max: number): Promise<Buffer | undefined>;
  /** OAuth for one MCP address on this service. Undefined after it answered the request itself. */
  authenticate?(path: string): Promise<AuthInfo | undefined>;
}

const JSON_TYPE = "application/json; charset=utf-8";

/** True when the request was a Cleaner Core one and has been answered. */
export async function handleHostedCleaner(h: HostedCleaner, r: HostedRequest): Promise<boolean> {
  const { url, method } = r;
  const path = url.pathname;
  const now = () => h.now();
  const signed = (pathname: string) => {
    const origin = h.origin();
    return origin ? `${origin}${pathname}${url.search}` : undefined;
  };
  const notFound = () => (r.send(404, "text/plain", "Not found"), true);

  if (TOUR_CORE_PATHS.has(path)) return notFound();

  if (path === MCP_PATH || path === CLEANER_MCP_PATH) {
    await handleTenantMcp(h, r, path);
    return true;
  }

  if (method === "POST" && path === CLEANER_TWILIO_PATH) {
    const rawBody = await r.readRaw();
    const tenant = h.registry.byNumber(formTo(rawBody));
    if (!tenant || tenant.disabled) {
      h.log(tenant ? `A text reached ${tenant.id}, which is turned off. Nothing was sent.` : "A text reached a number no Cleaner Core tenant uses. Nothing was sent.");
      r.send(200, "text/xml", EMPTY_TWIML);
      return true;
    }
    if (tenant.service && h.touring) {
      // The shared token signs every tenant's texts. Checked first, so a forged STOP never changes an opt-out.
      if (!signedByTwilio(h, r, rawBody, signed(path))) {
        r.send(403, "text/plain", "Forbidden");
        return true;
      }
      if ((await screenText(h, tenant, formParams(rawBody))) === "drop") {
        h.registry.touch(tenant.id);
        r.send(200, "text/xml", EMPTY_TWIML);
        return true;
      }
    }
    if (tenant.service === "touring") return touringText(h, r, tenant, rawBody, signed(path));
    if (tenant.service !== "cleaning") {
      h.log(`A text reached ${tenant.id}, which has no service yet. Nothing was sent.`);
      r.send(200, "text/xml", EMPTY_TWIML);
      return true;
    }
    const ctx = tenantContext(h, tenant);
    const result = await handleCleanerTwilioWebhook({ rawBody, headers: r.req.headers, url: signed(path), env: ctx.env, root: ctx.root, now });
    h.registry.touch(tenant.id);
    r.send(result.status, result.contentType ?? JSON_TYPE, result.body);
    return true;
  }

  // These only work under a tenant's /t/<id>/ prefix on this service.
  if (
    path === CLEANER_TWILIO_STATUS_PATH ||
    path === CLEANER_TWILIO_GROUP_PATH ||
    path.startsWith(CLEANER_PHOTO_PREFIX) ||
    alertUploadCode(path) ||
    calendarUploadCode(path) ||
    doorCodeUploadCode(path) ||
    uploadPageOf(path)
  ) {
    return notFound();
  }

  const scoped = splitTenantPath(path);
  if (!scoped) return false;
  const tenant = h.registry.get(scoped.tenantId);
  if (!tenant || tenant.disabled) return notFound();
  if (tenant.service === "touring") {
    if (method === "POST" && scoped.rest === TWILIO_WEBHOOK_PATH) return touringText(h, r, tenant, await r.readRaw(), signed(path));
    if (method === "GET" && touringAlertUploadCode(scoped.rest)) {
      r.send(200, "text/html; charset=utf-8", TOURING_ALERT_LINK_PAGE, TOURING_ALERT_LINK_HEADERS);
      return true;
    }
    const routineCode = method === "POST" ? touringAlertUploadCode(scoped.rest) : undefined;
    if (routineCode) {
      const read = await uploadBody(String(r.req.headers["content-type"] ?? ""), () => r.readCapped(ALERT_UPLOAD_MAX_BYTES));
      const result = "error" in read ? { status: read.status, body: { ok: false, error: read.error } } : handleTouringAlertUpload(h, tenant, routineCode, read.parsed);
      if (result.status === 200) h.touring?.supervisor.setAlerts(tenant.id, touringAlertsConnected(h, tenant));
      r.send(result.status, JSON_TYPE, JSON.stringify(result.body), result.status === 413 ? { Connection: "close" } : {});
      return true;
    }
    // Only the touring process's public routes. Never its connector, internal routes, or local webhook.
    const target = h.touring?.supervisor.target(tenant.id);
    if (!target || !touringPublicRoute(method, scoped.rest)) return notFound();
    await forwardTenantPath(target, r, scoped.rest);
    h.registry.touch(tenant.id);
    return true;
  }
  if (tenant.service !== "cleaning") return notFound();
  const handled = await handleTenantPath(h, r, tenant, scoped.rest, signed(path), now);
  if (!handled) return notFound();
  h.registry.touch(tenant.id);
  promoteRoutineOwner(h, tenant.id);
  return true;
}

/**
 * A text or Twilio callback for a touring tenant. The signature is checked here, over the address
 * Twilio used. The text is saved first and removed once the touring process took it; while the
 * process is down it waits, and Twilio gets an empty reply either way.
 */
function signedByTwilio(h: HostedCleaner, r: HostedRequest, rawBody: Buffer, signedUrl: string | undefined): boolean {
  const signature = r.req.headers["x-twilio-signature"];
  return verifyTwilioSignature(h.touring?.authToken(), signedUrl, formParams(rawBody), Array.isArray(signature) ? signature[0] : signature).ok;
}

async function touringText(h: HostedCleaner, r: HostedRequest, tenant: Tenant, rawBody: Buffer, signedUrl: string | undefined): Promise<boolean> {
  const touring = h.touring;
  const authToken = touring?.authToken();
  if (!touring || !authToken || !signedByTwilio(h, r, rawBody, signedUrl)) {
    r.send(403, "text/plain", "Forbidden");
    return true;
  }
  if ((await screenText(h, tenant, formParams(rawBody))) === "drop") {
    r.send(200, "text/xml", EMPTY_TWIML);
    return true;
  }
  // Saved first, then handed over behind any text already waiting, so texts keep their order.
  const saved = touring.inbox.save(tenant.id, rawBody);
  await touring.handOver(tenant);
  if (touring.inbox.pending(tenant.id).includes(saved)) h.log(`A text for ${tenant.id} is waiting for its touring process.`);
  h.registry.touch(tenant.id);
  r.send(200, "text/xml", EMPTY_TWIML);
  return true;
}

async function handleTenantPath(h: HostedCleaner, r: HostedRequest, tenant: Tenant, rest: string, signedUrl: string | undefined, now: () => Date): Promise<boolean> {
  const { method } = r;
  const ctx = tenantContext(h, tenant);
  const contentType = String(r.req.headers["content-type"] ?? "");
  if (method === "POST" && rest === CLEANER_TWILIO_STATUS_PATH) {
    const result = await handleCleanerTwilioStatus({ rawBody: await r.readRaw(), headers: r.req.headers, url: signedUrl, env: ctx.env, root: ctx.root, now });
    r.send(result.status, JSON_TYPE, result.body);
    return true;
  }
  if (method === "POST" && rest === CLEANER_TWILIO_GROUP_PATH) {
    const result = await handleCleanerGroupWebhook({ rawBody: await r.readRaw(), headers: r.req.headers, url: signedUrl, env: ctx.env, root: ctx.root, now });
    r.send(result.status, JSON_TYPE, result.body);
    return true;
  }
  if (method === "GET" && rest.startsWith(CLEANER_PHOTO_PREFIX)) {
    const env = ctx.env();
    const photo = servePhoto(ctx.root, rest.slice(CLEANER_PHOTO_PREFIX.length), photoKey(env), now());
    if (photo.status !== 200) return false;
    r.res.writeHead(200, { ...photo.headers, "Content-Length": String(photo.body.length) });
    r.res.end(photo.body);
    return true;
  }
  const page = uploadPageOf(rest);
  if (page && (method === "GET" || (method === "POST" && isFormPost(contentType)))) {
    const result = await handleCleanerUploadPage({
      ...page,
      method,
      contentType,
      readBody: () => r.readCapped(ALERT_UPLOAD_MAX_BYTES),
      env: ctx.env,
      root: ctx.root,
      now,
      saveSecrets: ctx.saveSecrets,
      multiTenant: { fallback: pageAssistant(h, tenant) },
    });
    r.send(result.status, result.headers["Content-Type"] ?? "text/html; charset=utf-8", result.body, { ...result.headers, ...(result.status === 413 ? { Connection: "close" } : {}) });
    return true;
  }
  if (method !== "POST") return false;
  const upload = { contentType, readBody: () => r.readCapped(ALERT_UPLOAD_MAX_BYTES), env: ctx.env, root: ctx.root, now };
  const alert = alertUploadCode(rest);
  const calendar = calendarUploadCode(rest);
  const door = doorCodeUploadCode(rest);
  const result = alert
    ? await handleCleanerAlertUpload({ ...upload, code: alert, saveSecrets: ctx.saveSecrets })
    : calendar
      ? await handleCleanerCalendarUpload({ ...upload, code: calendar })
      : door
        ? await handleCleanerDoorCodeUpload({ ...upload, code: door })
        : undefined;
  if (!result) return false;
  r.send(result.status, JSON_TYPE, result.body, result.status === 413 ? { Connection: "close" } : {});
  return true;
}

/**
 * The primary is the chat that gets the alerts. When its routine isn't connected but another live
 * connection's is, the most recent such connection becomes primary, so setup doesn't wait on a chat
 * that will never connect one. A primary with a connected routine is never changed here.
 */
export function promoteRoutineOwner(h: HostedCleaner, tenantId: string): void {
  const tenant = h.registry.get(tenantId);
  if (!tenant || tenant.disabled) return;
  const live = (grantId: string) => h.grantLive(grantId) && tenant.connections.some((c) => c.grantId === grantId);
  const ctx = tenantContext(h, tenant);
  const connected = liveDeskFor(ctx.root, ctx.env, () => h.now()).routineConnectionIds().filter(live);
  const primary = h.registry.primary(tenantId, (grantId) => h.grantLive(grantId));
  if (connected.length === 0 || (primary && connected.includes(primary.grantId))) return;
  const next = connected.at(-1)!;
  h.registry.setPrimary(tenantId, next);
  h.log(`${tenantId}'s primary chat is now the one that connected its alert routine.`);
}

/** Delivers every enabled tenant's waiting wake-ups. One tenant's failure never stops the rest. */
export async function drainAllTenants(h: HostedCleaner): Promise<void> {
  for (const listed of h.registry.list()) {
    // Read again: a tenant deleted, turned off, or moved off cleaning while this round runs is skipped.
    const tenant = h.registry.get(listed.id);
    if (!tenant || tenant.disabled || tenant.service !== "cleaning") continue;
    const ctx = tenantContext(h, tenant);
    try {
      await drainCleanerAlerts(ctx.root, ctx.env, () => h.now());
    } catch {
      h.log(`Cleaner Core couldn't deliver ${tenant.id}'s alerts this round.`);
    }
  }
}
