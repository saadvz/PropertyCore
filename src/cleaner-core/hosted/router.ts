import type { DoorAccess } from "../../hub/doorAccess";
import { hubFor, type Hub } from "../../hub/hub";
import { hubCalendarCode } from "../../hub/paths";
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
  handleCleanerDoorCodeUpload,
  handleCleanerGroupWebhook,
  handleCleanerTwilioStatus,
  uploadBody,
  uploadPageOf,
} from "../http";
import { drainCleanerAlerts, liveDeskFor, type LiveDesk } from "../liveDesk";
import type { DeleteSecrets, SaveSecrets } from "../mcp";
import { CLEANER_PHOTO_PREFIX, photoKey, servePhoto } from "../photos";
import { handleCleanerUploadPage, isFormPost, type UploadPageKind } from "../uploadPage";
import { isPropertyId, propertyFolder, type Property } from "./properties";
import { isTenantId, tenantFolder, type Tenant, type TenantRegistry } from "./registry";
import { screenText } from "../../hosted/crossService";
import { handleTenantMcp } from "../../hosted/frontMcp";
import { fixerCodeChanged, fixerDesk, fixerPhotoFolders, tickFixer } from "../../hosted/fixer";
import { FIXER_ALERT_UPLOAD_PREFIX } from "../../fixer-core/desk";
import { isVisitPath, serveFixerVisit } from "../../hosted/fixerVisit";
import { handleLineText } from "../../hosted/lineRouter";
import { handleVoiceCall, handleVoiceTranscript, noCallsTwiml, VOICE_PATH, VOICE_TRANSCRIPT_PATH } from "../../hosted/voice";
import type { TouringFront } from "../../hosted/serviceTools";
import { handleTouringAlertUpload, refreshTouringAlerts, touringAlertFormReply, touringAlertPage, touringAlertUploadCode } from "../../hosted/touringAlerts";
import { forwardTenantPath } from "../../hosted/touringForward";
import { touringPublicRoute } from "../../hosted/workerRoutes";
import { MCP_PATH } from "../../mcp/paths";
import { TWILIO_WEBHOOK_PATH } from "../../messaging/twilio/provider";
import { formParams, verifyTwilioSignature } from "../../messaging/twilio/signature";
import { serviceLines } from "./lines";
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
  /** Every live grant's id, from one read of the grants. Without it, callers ask grantLive per id. */
  liveGrantIds?(): Set<string>;
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
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const TOUR_CORE_PATHS = new Set(["/mcp/ops", "/mcp/qa"]);
const TENANT_PATH = /^\/t\/([^/]+)(\/.+)$/;
const PROPERTY_PATH = /^\/p\/([^/]+)(\/.+)$/;

/** /t/<id>/<rest>, for the account's migrated property, or /t/<id>/p/<pid>/<rest>. */
export function splitTenantPath(pathname: string): { tenantId: string; propertyId?: string; rest: string } | undefined {
  const match = TENANT_PATH.exec(pathname);
  if (!match || !isTenantId(match[1]!)) return undefined;
  const rest = match[2]!;
  if (rest === "/p" || rest.startsWith("/p/")) {
    const scoped = PROPERTY_PATH.exec(rest);
    if (!scoped || !isPropertyId(scoped[1]!)) return undefined;
    return { tenantId: match[1]!, propertyId: scoped[1]!, rest: scoped[2]! };
  }
  return { tenantId: match[1]!, rest };
}

/**
 * One property's desk folder, its environment (rebuilt on every read, so a saved secret is seen at
 * once), and the account's secret saver. The line, secrets and routines are the account's.
 */
export function propertyContext(h: HostedCleaner, tenant: Tenant, property: Property): TenantContext {
  return accountContext(h, tenant, propertyFolder(h.dataRoot, tenant.id, property), property.id);
}

/**
 * A parked touring account's own folder and environment: its touring records and any cleaning setup it
 * had before the move to properties. Never a property's desk; those use propertyContext.
 */
export function touringAccountContext(h: HostedCleaner, tenant: Tenant): TenantContext {
  return accountContext(h, tenant, tenantFolder(h.dataRoot, tenant.id), undefined);
}

function accountContext(h: HostedCleaner, tenant: Tenant, root: string, propertyId: string | undefined): TenantContext {
  const id = tenant.id;
  return {
    root,
    env: () => {
      const current = h.registry.get(id);
      const property = propertyId ? current?.properties.find((p) => p.id === propertyId) : undefined;
      const primary = h.registry.primary(id, (grantId) => h.grantLive(grantId));
      // Every number the service owns, the pool's too, so none is ever texted as a person.
      const ownLines = serviceLines(h);
      const env = buildTenantEnv({
        base: h.baseEnv(),
        tenant: current ?? tenant,
        secrets: h.secrets,
        primary,
        origin: h.origin() ?? "",
        serviceLines: ownLines,
        ...(property ? { property, propertyCount: current?.properties.length ?? 1 } : {}),
      });
      // Deleted, turned off, or the property gone or its cleaning off while a request or drain was under way: nothing more is sent for it.
      if (!current || current.disabled || (propertyId && !property?.flows.cleaning.on)) env.CLEANER_CORE_ENABLED = "0";
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

  if (method === "POST" && path === VOICE_TRANSCRIPT_PATH) {
    const rawBody = await r.readRaw();
    const tenant = h.registry.byNumber(formTo(rawBody));
    if (!tenant || tenant.disabled || tenant.service === "touring") {
      r.send(200, "text/xml", EMPTY_TWIML);
      return true;
    }
    await handleVoiceTranscript(h, r, tenant, rawBody, signed(path));
    return true;
  }

  if (method === "POST" && path === VOICE_PATH) {
    const rawBody = await r.readRaw();
    const tenant = h.registry.byNumber(formTo(rawBody));
    // A line no account uses, a turned-off account, or a touring line: nothing is recorded.
    if (!tenant || tenant.disabled || tenant.service === "touring") {
      r.send(200, "text/xml", noCallsTwiml());
      return true;
    }
    await handleVoiceCall(h, r, tenant, rawBody, signed(path));
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
    if (tenant.service === "touring") {
      // The shared token signs every tenant's texts. Checked first, so a forged STOP never changes an opt-out.
      if (h.touring && !signedByTwilio(h, r, rawBody, signed(path))) {
        r.send(403, "text/plain", "Forbidden");
        return true;
      }
      if (h.touring && (await screenText(h, tenant, formParams(rawBody))) === "drop") {
        h.registry.touch(tenant.id);
        r.send(200, "text/xml", EMPTY_TWIML);
        return true;
      }
      return touringText(h, r, tenant, rawBody, signed(path));
    }
    // One line, several properties: the sender names the property.
    await handleLineText(h, r, tenant, rawBody, signed(path));
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
    const routineCode = touringAlertUploadCode(scoped.rest);
    if (routineCode && method === "GET") {
      const page = touringAlertPage(h, tenant, routineCode);
      r.send(page.status, "text/html; charset=utf-8", page.html, page.headers);
      return true;
    }
    // A Claude host's browser posts the private form.
    if (routineCode && method === "POST" && isFormPost(String(r.req.headers["content-type"] ?? ""))) {
      const raw = await r.readCapped(ALERT_UPLOAD_MAX_BYTES);
      const form = Object.fromEntries(new URLSearchParams(raw?.toString("utf8") ?? ""));
      const result = handleTouringAlertUpload(h, tenant, routineCode, form);
      if (result.status === 200) refreshTouringAlerts(h, tenant);
      const page = touringAlertFormReply(h, tenant, routineCode, result);
      r.send(page.status, "text/html; charset=utf-8", page.html, page.headers);
      return true;
    }
    if (routineCode && method === "POST") {
      const read = await uploadBody(String(r.req.headers["content-type"] ?? ""), () => r.readCapped(ALERT_UPLOAD_MAX_BYTES));
      const result = "error" in read ? { status: read.status, body: { ok: false, error: read.error } } : handleTouringAlertUpload(h, tenant, routineCode, read.parsed);
      if (result.status === 200) refreshTouringAlerts(h, tenant);
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
  // The migrated property answers the old /t/<id>/ links; every other property its /t/<id>/p/<pid>/ ones.
  const property = scoped.propertyId ? tenant.properties.find((p) => p.id === scoped.propertyId) : tenant.properties.find((p) => p.legacyPaths);
  if (!property) return notFound();
  const handled = await handleTenantPath(h, r, tenant, property, scoped.rest, signed(path), now);
  if (!handled) return notFound();
  h.registry.touch(tenant.id);
  promoteRoutineOwner(h, tenant.id);
  return true;
}

function signedByTwilio(h: HostedCleaner, r: HostedRequest, rawBody: Buffer, signedUrl: string | undefined): boolean {
  const signature = r.req.headers["x-twilio-signature"];
  return verifyTwilioSignature(h.touring?.authToken(), signedUrl, formParams(rawBody), Array.isArray(signature) ? signature[0] : signature).ok;
}

/**
 * A text or Twilio callback for a touring tenant. The signature is checked here, over the address
 * Twilio used. The text is saved first and removed once the touring process took it; while the
 * process is down it waits, and Twilio gets an empty reply either way.
 */
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

async function handleTenantPath(h: HostedCleaner, r: HostedRequest, tenant: Tenant, property: Property, rest: string, signedUrl: string | undefined, now: () => Date): Promise<boolean> {
  const { method } = r;
  const { cleaning, supplies, fixer } = property.flows;
  // The pro's visit page is Fixer Core's, for this path's property only. Its path holds the link's token, so it is never logged.
  if (isVisitPath(rest)) {
    if (!fixer.on) return false;
    await serveFixerVisit(h, r, tenant, property, rest);
    return true;
  }
  const ctx = propertyContext(h, tenant, property);
  const contentType = String(r.req.headers["content-type"] ?? "");
  // A calendar link is the property's, in its hub: it works while any flow is on.
  const calendarCode = hubCalendarCode(rest);
  if (calendarCode) return cleaning.on || supplies.on || fixer.on ? handleHubCalendar(h, r, tenant, property, ctx, calendarCode, contentType, now) : false;
  // Without Cleaner Core, Fixer Core's own links still work: its job photos and the door code link. Every other link needs cleaning on.
  if (!cleaning.on) return fixer.on ? handleFixerOnlyPath(h, r, tenant, property, ctx, rest, contentType, now) : false;
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
  if (method === "GET" && rest.startsWith(CLEANER_PHOTO_PREFIX)) return sendPhoto(r, ctx, rest, now);
  const page = uploadPageOf(rest);
  if (page && (method === "GET" || (method === "POST" && isFormPost(contentType)))) {
    const status = await sendUploadPage(h, r, tenant, ctx, page, contentType, now);
    // A new door code, whichever flow gave the link: Fixer Core stops asking about the old one.
    if (page.kind === "door-code" && method === "POST" && status === 200) await fixerCodeChanged(h, tenant, property);
    return true;
  }
  if (method !== "POST") return false;
  const upload = { contentType, readBody: () => r.readCapped(ALERT_UPLOAD_MAX_BYTES), env: ctx.env, root: ctx.root, now };
  const alert = alertUploadCode(rest);
  const door = doorCodeUploadCode(rest);
  const result = alert
    ? await handleCleanerAlertUpload({ ...upload, code: alert, saveSecrets: ctx.saveSecrets })
    : door
      ? await handleCleanerDoorCodeUpload({ ...upload, code: door })
      : undefined;
  if (!result) return false;
  if (door && result.status === 200) await fixerCodeChanged(h, tenant, property);
  r.send(result.status, JSON_TYPE, result.body, result.status === 413 ? { Connection: "close" } : {});
  return true;
}

/** A photo link's photo, or false when the link isn't valid or has expired, or names a folder outside `onlyFolders`. */
function sendPhoto(r: HostedRequest, ctx: TenantContext, rest: string, now: () => Date, onlyFolders?: ReadonlySet<string>): boolean {
  const photo = servePhoto(ctx.root, rest.slice(CLEANER_PHOTO_PREFIX.length), photoKey(ctx.env()), now(), onlyFolders);
  if (photo.status !== 200) return false;
  r.res.writeHead(200, { ...photo.headers, "Content-Length": String(photo.body.length) });
  r.res.end(photo.body);
  return true;
}

/** The code of a Fixer Core alerts upload link, or undefined. */
function fixerAlertUploadCode(rest: string): string | undefined {
  if (!rest.startsWith(FIXER_ALERT_UPLOAD_PREFIX)) return undefined;
  const code = rest.slice(FIXER_ALERT_UPLOAD_PREFIX.length);
  return /^[A-Za-z0-9_-]{43}$/.test(code) ? code : undefined;
}

/**
 * A property where Fixer Core runs without Cleaner Core: the job photo links get_job_photos gives,
 * and the door code link from change_door_code, which saves to the hub's door access. Grok's own
 * computer posts JSON; other chats use the private page. The door code is never repeated or logged.
 */
async function handleFixerOnlyPath(h: HostedCleaner, r: HostedRequest, tenant: Tenant, property: Property, ctx: TenantContext, rest: string, contentType: string, now: () => Date): Promise<boolean> {
  const { method } = r;
  // Only a repair job's photos: Cleaner Core's, from when it ran here, stay off with it.
  if (method === "GET" && rest.startsWith(CLEANER_PHOTO_PREFIX)) return sendPhoto(r, ctx, rest, now, fixerPhotoFolders(h, tenant, property));
  const alert = fixerAlertUploadCode(rest);
  if (alert) {
    if (method !== "POST") return false;
    const read = await uploadBody(contentType, () => r.readCapped(ALERT_UPLOAD_MAX_BYTES));
    const saved = "error" in read ? { status: read.status, body: { ok: false, error: read.error } } : await fixerDesk(h, tenant, property).uploadAlerts(alert, read.parsed, ctx.saveSecrets);
    r.send(saved.status, JSON_TYPE, JSON.stringify(saved.body), saved.status === 413 ? { Connection: "close" } : {});
    return true;
  }
  const code = doorCodeUploadCode(rest);
  if (!code) return false;
  const door = hubFor(ctx.root, { now }).doorAccess(ctx.env);
  if (method === "GET" || (method === "POST" && isFormPost(contentType))) {
    const status = await sendUploadPage(h, r, tenant, ctx, { kind: "door-code", code }, contentType, now, { door });
    if (method === "POST" && status === 200) await fixerCodeChanged(h, tenant, property);
    return true;
  }
  if (method !== "POST") return false;
  const read = await uploadBody(contentType, () => r.readCapped(ALERT_UPLOAD_MAX_BYTES));
  const saved = "error" in read ? { status: read.status, body: { ok: false, error: read.error } } : door.upload(code, read.parsed);
  if (saved.status === 200) await fixerCodeChanged(h, tenant, property);
  r.send(saved.status, JSON_TYPE, JSON.stringify(saved.body), saved.status === 413 ? { Connection: "close" } : {});
  return true;
}

/** A private upload page, or its form post, for one property, and its status. A calendar link's page saves through `hub`; a Fixer-only property's door code link through `door`. */
async function sendUploadPage(
  h: HostedCleaner,
  r: HostedRequest,
  tenant: Tenant,
  ctx: TenantContext,
  link: { kind: UploadPageKind; code: string },
  contentType: string,
  now: () => Date,
  store: { hub?: Hub; door?: DoorAccess } = {},
): Promise<number> {
  const result = await handleCleanerUploadPage({
    ...link,
    method: r.method,
    contentType,
    readBody: () => r.readCapped(ALERT_UPLOAD_MAX_BYTES),
    env: ctx.env,
    root: ctx.root,
    now,
    saveSecrets: ctx.saveSecrets,
    multiTenant: { fallback: pageAssistant(h, tenant) },
    ...(store.hub ? { hub: store.hub } : {}),
    ...(store.door ? { door: store.door } : {}),
  });
  r.send(result.status, result.headers["Content-Type"] ?? "text/html; charset=utf-8", result.body, { ...result.headers, ...(result.status === 413 ? { Connection: "close" } : {}) });
  return result.status;
}

/**
 * A calendar upload link: Grok's own computer posts JSON, and other chats use the private page. Both
 * save through the property's hub. With cleaning on, Cleaner Core's desk opens first, so its checks
 * (the door code, and cleanings a change would call off) guard the save even right after a restart.
 */
async function handleHubCalendar(h: HostedCleaner, r: HostedRequest, tenant: Tenant, property: Property, ctx: TenantContext, code: string, contentType: string, now: () => Date): Promise<boolean> {
  if (property.flows.cleaning.on) liveDeskFor(ctx.root, ctx.env, now);
  const hub = hubFor(ctx.root, { now });
  const { method } = r;
  if (method === "GET" || (method === "POST" && isFormPost(contentType))) {
    await sendUploadPage(h, r, tenant, ctx, { kind: "calendar-link", code }, contentType, now, { hub });
    return true;
  }
  if (method !== "POST") return false;
  const read = await uploadBody(contentType, () => r.readCapped(ALERT_UPLOAD_MAX_BYTES));
  const saved = "error" in read ? { status: read.status, body: { ok: false, error: read.error } } : await hub.uploadCalendarLink(code, read.parsed);
  r.send(saved.status, JSON_TYPE, JSON.stringify(saved.body), saved.status === 413 ? { Connection: "close" } : {});
  return true;
}

/**
 * The primary is the chat that gets the alerts. When its routine isn't connected but another live
 * connection's is, the most recent such connection becomes primary, so setup doesn't wait on a chat
 * that will never connect one. A primary with a connected routine is never changed here.
 */
export function promoteRoutineOwner(h: HostedCleaner, tenantId: string): void {
  void shareRoutine(h, tenantId).catch(() => h.log(`Couldn't share ${tenantId}'s alert routine with its properties this time.`));
  const tenant = h.registry.get(tenantId);
  if (!tenant || tenant.disabled) return;
  const live = (grantId: string) => h.grantLive(grantId) && tenant.connections.some((c) => c.grantId === grantId);
  // A routine connected through any of the account's properties counts, in the order they were connected.
  const ids = cleaningDesks(h, tenant).flatMap((desk) => desk.routineConnectionIds());
  const connected = [...new Set(ids)].filter(live);
  const primary = h.registry.primary(tenantId, (grantId) => h.grantLive(grantId));
  if (connected.length === 0 || (primary && connected.includes(primary.grantId))) return;
  const next = connected.at(-1)!;
  h.registry.setPrimary(tenantId, next);
  h.log(`${tenantId}'s primary chat is now the one that connected its alert routine.`);
}

/**
 * The account's alert routine belongs to its chats, not to one property: a routine connected through
 * any property counts on every property running Cleaner Core, so setup never asks for it again.
 */
export async function shareRoutine(h: HostedCleaner, tenantId: string): Promise<void> {
  const tenant = h.registry.get(tenantId);
  if (!tenant || tenant.disabled) return;
  const desks = cleaningDesks(h, tenant);
  const ids = [...new Set(desks.flatMap((desk) => desk.routineConnectionIds()))];
  if (ids.length === 0) return;
  for (const desk of desks) if (ids.some((id) => !desk.routineConnectionIds().includes(id))) await desk.markRoutineConnected(ids);
}

/** The desk of each of the account's properties with Cleaner Core on, in the account's order. */
function cleaningDesks(h: HostedCleaner, tenant: Tenant): LiveDesk[] {
  return tenant.properties
    .filter((p) => p.flows.cleaning.on)
    .map((p) => {
      const ctx = propertyContext(h, tenant, p);
      return liveDeskFor(ctx.root, ctx.env, () => h.now());
    });
}

/** Delivers every enabled tenant's waiting wake-ups. One tenant's failure never stops the rest. */
export async function drainAllTenants(h: HostedCleaner): Promise<void> {
  for (const listed of h.registry.list()) {
    // Read again: a tenant deleted or turned off, or a property whose cleaning went off, while this round runs is skipped.
    const tenant = h.registry.get(listed.id);
    if (!tenant || tenant.disabled) continue;
    for (const property of tenant.properties) {
      if (!property.flows.cleaning.on) continue;
      const ctx = propertyContext(h, tenant, property);
      try {
        await drainCleanerAlerts(ctx.root, ctx.env, () => h.now());
      } catch {
        h.log(`Cleaner Core couldn't deliver ${tenant.id}/${property.id}'s alerts this round.`);
      }
    }
  }
}

/** True while a round of Fixer Core's clock runs, so the next tick skips rather than overlaps it. */
let fixerRound = false;

/**
 * Fixer Core's clock: one pass for each property with Fixer Core on, on the same tick as the alerts.
 * One property's failure never stops the rest, and the log line names only the property. A round
 * still running when the next tick comes makes that tick skip.
 */
export async function tickAllFixers(h: HostedCleaner): Promise<void> {
  if (fixerRound) return;
  fixerRound = true;
  try {
    await fixerPass(h);
  } finally {
    fixerRound = false;
  }
}

async function fixerPass(h: HostedCleaner): Promise<void> {
  for (const listed of h.registry.list()) {
    const tenant = h.registry.get(listed.id);
    if (!tenant || tenant.disabled) continue;
    for (const property of tenant.properties) {
      if (!property.flows.fixer.on) continue;
      try {
        await tickFixer(h, tenant, property);
      } catch {
        h.log(`Fixer Core couldn't run ${tenant.id}/${property.id}'s clock this round.`);
      }
    }
  }
}
