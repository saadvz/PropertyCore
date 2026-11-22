import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { routineValuesRefused } from "../alerts/routineCheck";
import { ALERT_UPLOAD_MAX_BYTES, uploadBody } from "../cleaner-core/http";
import { tenantFolder, type Tenant } from "../cleaner-core/hosted/registry";
import { promoteFixerRoutine, propertyContext, type HostedCleaner, type HostedRequest } from "../cleaner-core/hosted/router";
import { hubFor } from "../hub/hub";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { noteTeamChanged } from "./jobDeps";

/**
 * A bot's own Alerts routine, saved through a one-time link (#250). The Property Core bot and the Supply Core bot
 * have no desk whose setup connects one, so check_alerts with connect: true gives them this link, and the chat's own
 * computer posts the routine's address and key to it. Saving it is also how a Supply Core bot takes hold of its job.
 * Only the code's sha256, its expiry and the connection that asked are kept; the address and key are never repeated
 * or logged.
 */

export const JOB_ROUTINE_UPLOAD_PREFIX = "/bots/alert-routine/";
export const JOB_ROUTINE_LINK_MINUTES = 30;
const LINK_MS = JOB_ROUTINE_LINK_MINUTES * 60_000;
const UPLOAD_CODE = /^[A-Za-z0-9_-]{43}$/;
const UPLOADS_FILE = "bot-uploads.json";
const JSON_TYPE = "application/json; charset=utf-8";

interface Upload {
  hash: string;
  grantId: string;
  expiresAt: string;
  usedAt?: string;
}

const hash = (code: string) => createHash("sha256").update(code).digest("hex");
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const uploadsFile = (h: HostedCleaner, tenantId: string) => join(tenantFolder(h.dataRoot, tenantId), UPLOADS_FILE);

function readUploads(h: HostedCleaner, tenantId: string): Upload[] {
  const file = uploadsFile(h, tenantId);
  if (!existsSync(file)) return [];
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as { uploads?: Upload[] };
    return Array.isArray(doc.uploads) ? doc.uploads.filter((u) => !!u && typeof u.hash === "string" && typeof u.grantId === "string" && typeof u.expiresAt === "string") : [];
  } catch {
    return [];
  }
}

function writeUploads(h: HostedCleaner, tenantId: string, uploads: Upload[]): void {
  const now = h.now().getTime();
  writeJsonAtomic(uploadsFile(h, tenantId), { uploads: uploads.filter((u) => Date.parse(u.expiresAt) > now - LINK_MS) });
}

/** A one-time link for the chat on `grantId` to save its own Alerts routine. A newer link ends that chat's older ones. */
export function issueJobRoutineLink(h: HostedCleaner, tenant: Tenant, grantId: string): string {
  const code = randomBytes(32).toString("base64url");
  const uploads = readUploads(h, tenant.id).filter((u) => u.grantId !== grantId);
  uploads.push({ hash: hash(code), grantId, expiresAt: new Date(h.now().getTime() + LINK_MS).toISOString() });
  writeUploads(h, tenant.id, uploads);
  return `${h.origin() ?? ""}/t/${tenant.id}${JOB_ROUTINE_UPLOAD_PREFIX}${code}`;
}

/** True when the key, read as a base64 or base64url key, opens a door code saved at any of the account's properties. */
function opensADoor(h: HostedCleaner, tenant: Tenant, token: string): boolean {
  const keys = (["base64", "base64url"] as const).map((encoding) => Buffer.from(token, encoding)).filter((key) => key.length === 32);
  if (keys.length === 0) return false;
  for (const property of tenant.properties) {
    try {
      const ctx = propertyContext(h, tenant, property);
      const door = hubFor(ctx.root, { now: () => h.now() }).doorAccess(ctx.env);
      if (door.saved() && keys.some((key) => door.opensWith(key) !== undefined)) return true;
    } catch {
      // A property whose door record can't be read has no code this key could open.
    }
  }
  return false;
}

type Reply = { status: number; body: { ok: boolean; message?: string; error?: string } };

function save(h: HostedCleaner, tenant: Tenant, code: string, body: Record<string, unknown>): Reply {
  const uploads = readUploads(h, tenant.id);
  const wanted = hash(code);
  const upload = uploads.find((u) => sameHash(u.hash, wanted));
  const account = h.registry.get(tenant.id) ?? tenant;
  // The link is the asking connection's alone: once that chat is gone, so is its link.
  if (!upload || upload.usedAt || Date.parse(upload.expiresAt) <= h.now().getTime() || !account.connections.some((c) => c.grantId === upload.grantId)) {
    return { status: 404, body: { ok: false, error: "This upload link isn't valid anymore. Call check_alerts with connect: true for a new one." } };
  }
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const given = typeof body.token === "string" ? body.token : typeof body.key === "string" ? body.key : "";
  const token = given.trim();
  if (routineValuesRefused(url, token) || opensADoor(h, account, token)) return { status: 400, body: { ok: false, error: "Send the routine's https webhook address as url and its key as token." } };
  upload.usedAt = h.now().toISOString();
  writeUploads(h, tenant.id, uploads);
  h.secrets.setForConnection(tenant.id, upload.grantId, { CLEANER_CORE_ROUTINE_URL: url, CLEANER_CORE_ROUTINE_KEY: token });
  // A /mcp chat that saved one gets the alerts when the primary chat has none; a core's bot holds its job by the rule.
  promoteFixerRoutine(h, tenant.id, upload.grantId);
  // A core's bot that saved its routine now holds its job: the account's other chats list fewer tools.
  noteTeamChanged(h.registry.get(tenant.id) ?? account, upload.grantId);
  h.log(`A chat on ${tenant.id} connected its own alerts routine.`);
  return { status: 200, body: { ok: true, message: "Alerts are connected." } };
}

/**
 * Answers a POST to a bot's routine link under /t/<id>. Undefined when the path isn't one, so the caller goes on;
 * false when it is one and can't be answered (anything but a POST), so the caller says not found.
 */
export async function handleJobRoutineUpload(h: HostedCleaner, r: HostedRequest, tenant: Tenant, rest: string): Promise<boolean | undefined> {
  if (!rest.startsWith(JOB_ROUTINE_UPLOAD_PREFIX)) return undefined;
  const code = rest.slice(JOB_ROUTINE_UPLOAD_PREFIX.length);
  if (!UPLOAD_CODE.test(code) || r.method !== "POST") return false;
  const read = await uploadBody(String(r.req.headers["content-type"] ?? ""), () => r.readCapped(ALERT_UPLOAD_MAX_BYTES));
  const reply: Reply = "error" in read ? { status: read.status, body: { ok: false, error: read.error } } : save(h, tenant, code, read.parsed);
  r.send(reply.status, JSON_TYPE, JSON.stringify(reply.body), reply.status === 413 ? { Connection: "close" } : {});
  return true;
}
