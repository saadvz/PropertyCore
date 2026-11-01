import { withCaller, type CleanerCaller } from "./callerContext";
import { authorized } from "../mcp/mcpBridge";
import { cleanerAssistant } from "./assistant";
import { cleanerCoreEnabled } from "./flag";
import { ALERT_UPLOAD_PREFIX, CALENDAR_UPLOAD_PREFIX, DOOR_CODE_UPLOAD_PREFIX, liveDeskFor } from "./liveDesk";
import { CLEANER_MCP_PATH, handleCleanerMcpMessage, type DeleteSecrets, type SaveSecrets } from "./mcp";
import { pinKeyFromHeader, serverPinKey } from "./pinSeal";
import { scratchToolsOn } from "./scratchQa";
import type { UploadPageKind } from "./uploadPage";
import { CLEANER_TWILIO_GROUP_PATH, CLEANER_TWILIO_PATH, CLEANER_TWILIO_STATUS_PATH, handleCleanerGroupWebhook, handleCleanerTwilioStatus, handleCleanerTwilioWebhook, textAddressedTo } from "./twilioHook";

export { ALERT_UPLOAD_PREFIX, CALENDAR_UPLOAD_PREFIX, DOOR_CODE_UPLOAD_PREFIX, CLEANER_MCP_PATH, CLEANER_TWILIO_GROUP_PATH, CLEANER_TWILIO_PATH, CLEANER_TWILIO_STATUS_PATH, handleCleanerGroupWebhook, handleCleanerTwilioStatus, handleCleanerTwilioWebhook, textAddressedTo };

/** The response was already written (an OAuth 401/403/503). The caller sends nothing more. */
export const ANSWERED = { answered: true } as const;

/**
 * Cleaning scheduler chat. Its own credential. It lists none of the touring tools.
 * Off unless cleaning texts are turned on and a credential is set: the fixed
 * CLEANER_CORE_MCP_TOKEN, or OAuth with a grant for this path and the
 * cleanercore.operator scope. A Tour Core grant never opens it.
 */
export async function handleCleanerMcpHttp(input: {
  method: string;
  authorization: string | undefined;
  pinKeyHeader: string | string[] | undefined;
  contentType: string;
  readBody: () => Promise<Buffer>;
  /** Live: the desk keeps this getter, so a secret saved during the request is seen at once. */
  env: () => NodeJS.ProcessEnv;
  root: string;
  now: () => Date;
  /** Writes to the secret store. Only `save_alert_routine` uses it. */
  saveSecrets: SaveSecrets;
  /** Removes from the secret store. Only `reset_property` uses it. */
  deleteSecrets: DeleteSecrets;
  /**
   * OAuth for /mcp/cleaner-core. True when the bearer is a live cleaner grant;
   * false after it has answered the request itself.
   */
  oauth?: { authenticate(): Promise<boolean> };
  /** On a multi-tenant service: the connection making this call. Its chat gets the replies. */
  caller?: CleanerCaller;
}): Promise<{ status: number; body: string; headers?: Record<string, string> } | typeof ANSWERED> {
  const env = input.env();
  if (!cleanerCoreEnabled(env)) {
    return { status: 503, body: JSON.stringify({ error: { message: "Cleaning texts aren't turned on." } }) };
  }
  const token = env.CLEANER_CORE_MCP_TOKEN?.trim();
  // The fixed token is checked first. Anything else goes to OAuth when it is on.
  if (!(token && authorized(input.authorization, token))) {
    if (input.oauth) {
      if (!(await input.oauth.authenticate())) return ANSWERED;
    } else if (!token) {
      return { status: 503, body: JSON.stringify({ error: { message: "The cleaning scheduler chat is off." } }) };
    } else {
      return {
        status: 401,
        body: JSON.stringify({ error: { message: "Missing or wrong cleaning scheduler credential." } }),
        headers: { "WWW-Authenticate": 'Bearer realm="cleaning"' },
      };
    }
  }
  if (input.method !== "POST") {
    return { status: 405, body: JSON.stringify({ error: { message: "Send requests with POST." } }), headers: { Allow: "POST" } };
  }
  if (!input.contentType.startsWith("application/json")) {
    return { status: 415, body: JSON.stringify({ error: { message: "Unsupported request." } }) };
  }
  let message: unknown;
  try {
    message = JSON.parse((await input.readBody()).toString("utf8") || "null");
  } catch {
    return { status: 400, body: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "That request couldn't be read." } }) };
  }
  // The header wins. Without it (a Grok Bot connected by OAuth), the server's own key, made once.
  const pinKey = pinKeyFromHeader(input.pinKeyHeader) ?? serverPinKey(input.env(), input.saveSecrets);
  const desk = liveDeskFor(input.root, input.env, input.now);
  const caller = input.caller;
  const handle = () => handleCleanerMcpMessage(desk, message, pinKey, scratchToolsOn(env), input.saveSecrets, input.deleteSecrets, caller?.assistant ?? cleanerAssistant(env));
  const reply = caller ? await withCaller(caller, handle) : await handle();
  if (reply.body === undefined) return { status: reply.status, body: "" };
  return { status: reply.status, body: JSON.stringify(reply.body) };
}

/** The most an alert upload body may hold. A webhook address and key fit many times over. */
export const ALERT_UPLOAD_MAX_BYTES = 4096;

const UPLOAD_CODE = /^[A-Za-z0-9_-]{43}$/;

/** The one-time code in an alert upload path, or undefined when the path isn't one. */
export function alertUploadCode(pathname: string): string | undefined {
  if (!pathname.startsWith(ALERT_UPLOAD_PREFIX)) return undefined;
  const code = pathname.slice(ALERT_UPLOAD_PREFIX.length);
  return UPLOAD_CODE.test(code) ? code : undefined;
}

/** The one-time code in a calendar upload path, or undefined when the path isn't one. */
export function calendarUploadCode(pathname: string): string | undefined {
  if (!pathname.startsWith(CALENDAR_UPLOAD_PREFIX)) return undefined;
  const code = pathname.slice(CALENDAR_UPLOAD_PREFIX.length);
  return UPLOAD_CODE.test(code) ? code : undefined;
}

/** The one-time code in a door code upload path, or undefined when the path isn't one. */
export function doorCodeUploadCode(pathname: string): string | undefined {
  if (!pathname.startsWith(DOOR_CODE_UPLOAD_PREFIX)) return undefined;
  const code = pathname.slice(DOOR_CODE_UPLOAD_PREFIX.length);
  return UPLOAD_CODE.test(code) ? code : undefined;
}

/** Which upload link a path is, for a Claude deployment's private page. */
export function uploadPageOf(pathname: string): { kind: UploadPageKind; code: string } | undefined {
  const door = doorCodeUploadCode(pathname);
  if (door) return { kind: "door-code", code: door };
  const calendar = calendarUploadCode(pathname);
  if (calendar) return { kind: "calendar-link", code: calendar };
  const alert = alertUploadCode(pathname);
  return alert ? { kind: "alert-routine", code: alert } : undefined;
}

/**
 * Grok's own computer posts the door code from its secure card here, to the link save_door_code
 * made. Public: the one-time code is the credential. The door code is never repeated or logged.
 */
export async function handleCleanerDoorCodeUpload(input: {
  code: string;
  contentType: string;
  /** Undefined when the body is over ALERT_UPLOAD_MAX_BYTES. */
  readBody: () => Promise<Buffer | undefined>;
  env: () => NodeJS.ProcessEnv;
  root: string;
  now: () => Date;
}): Promise<{ status: number; body: string }> {
  const reply = (status: number, body: Record<string, unknown>) => ({ status, body: JSON.stringify(body) });
  if (!cleanerCoreEnabled(input.env())) return reply(404, { ok: false, error: "Not found." });
  const read = await uploadBody(input.contentType, input.readBody);
  if ("error" in read) return reply(read.status, { ok: false, error: read.error });
  const desk = liveDeskFor(input.root, input.env, input.now);
  const result = await desk.uploadDoorCode(input.code, read.parsed);
  return reply(result.status, result.body);
}

/** A JSON object body, or the refusal to send. */
/** A JSON upload body, capped by `readBody`. Shared with the touring alert link on the multi-tenant service. */
export async function uploadBody(contentType: string, readBody: () => Promise<Buffer | undefined>): Promise<{ parsed: Record<string, unknown> } | { status: number; error: string }> {
  if (!contentType.toLowerCase().startsWith("application/json")) return { status: 415, error: "Send JSON with Content-Type: application/json." };
  const raw = await readBody();
  if (!raw) return { status: 413, error: "That request is too large." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return { status: 415, error: "Send JSON with Content-Type: application/json." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: 415, error: "Send JSON with Content-Type: application/json." };
  return { parsed: parsed as Record<string, unknown> };
}

/**
 * Grok's own computer posts a calendar link from its secure card here, to the link save_sources
 * made. Public: the one-time code is the credential. The link is never repeated or logged.
 */
export async function handleCleanerCalendarUpload(input: {
  code: string;
  contentType: string;
  /** Undefined when the body is over ALERT_UPLOAD_MAX_BYTES. */
  readBody: () => Promise<Buffer | undefined>;
  env: () => NodeJS.ProcessEnv;
  root: string;
  now: () => Date;
}): Promise<{ status: number; body: string }> {
  const reply = (status: number, body: Record<string, unknown>) => ({ status, body: JSON.stringify(body) });
  if (!cleanerCoreEnabled(input.env())) return reply(404, { ok: false, error: "Not found." });
  const read = await uploadBody(input.contentType, input.readBody);
  if ("error" in read) return reply(read.status, { ok: false, error: read.error });
  const desk = liveDeskFor(input.root, input.env, input.now);
  const result = await desk.uploadCalendarLink(input.code, read.parsed);
  return reply(result.status, result.body);
}

/**
 * Grok's own computer posts the alert routine's address and key here, to the link
 * `save_alert_routine` made. Public: the one-time code is the credential. Nothing posted, and not
 * the code, is repeated, logged, or kept outside the secret store.
 */
export async function handleCleanerAlertUpload(input: {
  code: string;
  contentType: string;
  /** Undefined when the body is over ALERT_UPLOAD_MAX_BYTES. */
  readBody: () => Promise<Buffer | undefined>;
  env: () => NodeJS.ProcessEnv;
  root: string;
  now: () => Date;
  saveSecrets: SaveSecrets;
}): Promise<{ status: number; body: string }> {
  const reply = (status: number, body: Record<string, unknown>) => ({ status, body: JSON.stringify(body) });
  if (!cleanerCoreEnabled(input.env())) return reply(404, { ok: false, error: "Not found." });
  const read = await uploadBody(input.contentType, input.readBody);
  if ("error" in read) return reply(read.status, { ok: false, error: read.error });
  const desk = liveDeskFor(input.root, input.env, input.now);
  const result = await desk.uploadAlertRoutine(input.code, read.parsed, input.saveSecrets);
  return reply(result.status, result.body);
}
