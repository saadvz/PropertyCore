import { setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import type { CleanerAssistant } from "../src/cleaner-core/assistant";
import { propertyFolder } from "../src/cleaner-core/hosted/properties";
import { TenantRegistry } from "../src/cleaner-core/hosted/registry";
import { setTouringAlertFetch } from "../src/hosted/touringAlerts";
import { jobOfPath } from "../src/jobs/jobs";
import { CLEANER_SCOPE, JOB_SCOPES, OPERATOR_SCOPE } from "../src/mcp/oauth/provider";
import { twilioSignature } from "../src/messaging/twilio/signature";
import { BASE, CLEANER_RESOURCE, hostedApp, pkce } from "./cleanerOauthHarness";
import { CALENDAR_ICS, CALENDAR_URL, fakeSms } from "./wiringProof";

/**
 * A multi-tenant Cleaner Core on a made-up Railway domain: one server, tenants from the registry,
 * each chat connected with an invite code. Texts go to a fake Twilio. Only 555 numbers.
 */

export const MULTI_AUTH = "multi-tenant-twilio-auth-token";
export const REDIRECTS: Record<CleanerAssistant, string> = {
  grok: "https://grok.com/connectors/oauth/callback",
  claude: "https://claude.ai/api/mcp/auth_callback",
  chatgpt: "https://chatgpt.com/connector_platform_oauth_redirect",
  muse: "https://agent.meta.ai/api/hatch/oauth/callback",
};

/** Every address a chat can connect to: the shared one, its old alias, and one for each core's own bot (#250). */
export type McpAddress = "/mcp" | "/mcp/cleaner-core" | "/mcp/cleaner" | "/mcp/supply" | "/mcp/fixer";

export interface Wake {
  url: string;
  body: string;
}

export async function multiTenantApp(options: { now?: () => Date; authNow?: () => number; env?: NodeJS.ProcessEnv } = {}) {
  const sms = fakeSms();
  setCleanerTwilioClient(sms);
  setCleanerCalendarFetch(async (url) => ({
    status: url === CALENDAR_URL ? 200 : 404,
    url,
    async text() {
      return url === CALENDAR_URL ? CALENDAR_ICS : "";
    },
  }));
  const wakes: Wake[] = [];
  let wakeStatus = 200;
  setCleanerAlertFetch(async (url, init) => {
    wakes.push({ url, body: init.body });
    return { status: wakeStatus };
  });
  setTouringAlertFetch(async (url, init) => {
    wakes.push({ url, body: init.body });
    return { status: wakeStatus };
  });
  const now = options.now ?? (() => new Date());
  const app = await hostedApp(
    {
      CLEANER_CORE_MULTI_TENANT: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_SMS_ALLOWLIST: "*",
      CLEANER_CORE_GROUP_CHAT: "0",
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACmultitenant",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: MULTI_AUTH,
      ...options.env,
    },
    undefined,
    undefined,
    now,
    options.authNow,
  );
  const registry = new TenantRegistry(app.root, now);
  let rpc = 0;

  /** Connects one chat to a tenant with a fresh invite. Returns its access token. */
  const join = async (tenantId: string, assistant: CleanerAssistant) => {
    const redirect = REDIRECTS[assistant];
    const clientId = await app.register(assistant, redirect);
    const inviteCode = registry.invite(tenantId);
    const { access } = await app.connect(clientId, CLEANER_RESOURCE, CLEANER_SCOPE, CLEANER_RESOURCE, { inviteCode, redirect });
    return access;
  };

  /** Connects one chat at an address on the service: /mcp/cleaner-core (the default) or the shared /mcp. */
  /** `service` is the pick on the shared address's Allow page. */
  /** The scope each address grants: /mcp's, a core's own bot's (#250), or /mcp/cleaner-core's. */
  const scopeAt = (path: string) => {
    const job = jobOfPath(path);
    return path === "/mcp" ? OPERATOR_SCOPE : job ? JOB_SCOPES[job] : CLEANER_SCOPE;
  };

  const joinAt = async (tenantId: string, assistant: CleanerAssistant, path: McpAddress, service?: "touring" | "cleaning") => {
    const redirect = REDIRECTS[assistant];
    const clientId = await app.register(assistant, redirect);
    const inviteCode = registry.invite(tenantId);
    const resource = `${BASE}${path}`;
    const { access } = await app.connect(clientId, resource, scopeAt(path), resource, { inviteCode, redirect, ...(service ? { service } : {}) });
    return access;
  };

  /** The approval page a chat is shown for an address. */
  const pageAt = async (assistant: CleanerAssistant, path: McpAddress) => {
    const redirect = REDIRECTS[assistant];
    const clientId = await app.register(assistant, redirect);
    const page = await app.authorize(clientId, pkce().challenge, `${BASE}${path}`, scopeAt(path), "state-1", redirect);
    return { status: page.status, html: await page.text() };
  };

  /** A sign-in at an address that the page refuses: the refusal's words, and the invite it was given, still unused. */
  const refusedAt = async (tenantId: string, assistant: CleanerAssistant, path: McpAddress) => {
    const page = await pageAt(assistant, path);
    const { id, code } = app.pageParts(page.html);
    const inviteCode = registry.invite(tenantId);
    const res = await app.approve(id, code, {}, inviteCode);
    const body = (await res.json()) as { ok?: boolean; error?: { message?: string } };
    return { status: res.status, message: body.error?.message ?? "", inviteCode };
  };

  /** One JSON-RPC message to an address. */
  const rpcAt = async (path: string, token: string, method: string, params: Record<string, unknown> = {}) => {
    const res = await app.http(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method, params }),
    });
    const raw = await res.text();
    return { status: res.status, raw, json: (raw.startsWith("{") ? JSON.parse(raw) : {}) as { result?: Record<string, unknown>; error?: { message?: string } } };
  };

  const toolAt = async (path: string, token: string, name: string, args: Record<string, unknown> = {}) => {
    const { status, raw, json } = await rpcAt(path, token, "tools/call", { name, arguments: args });
    const result = json.result as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text?: string }[] } | undefined;
    return { status, raw, isError: result?.isError === true || Boolean(json.error), structured: result?.structuredContent, text: result?.content?.[0]?.text ?? json.error?.message ?? "" };
  };

  /** The names on a chat's tool list, sorted. */
  const toolNames = async (path: string, token: string) => {
    const { json } = await rpcAt(path, token, "tools/list");
    return ((json.result?.tools ?? []) as { name: string }[]).map((t) => t.name).sort();
  };

  const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const res = await app.http("/mcp/cleaner-core", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }),
    });
    const raw = await res.text();
    const parsed = (raw.startsWith("{") ? JSON.parse(raw) : {}) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text?: string }[] }; error?: { message?: string } };
    return { status: res.status, raw, isError: parsed.result?.isError === true || Boolean(parsed.error), structured: parsed.result?.structuredContent, text: parsed.result?.content?.[0]?.text ?? parsed.error?.message ?? "" };
  };

  /** A Twilio post signed over the public URL, as Twilio sends it. */
  const twilio = async (path: string, fields: Record<string, string>, signWith = path) => {
    const signature = twilioSignature(MULTI_AUTH, `${BASE}${signWith}`, fields);
    return app.http(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature }, body: new URLSearchParams(fields).toString() });
  };

  const text = (to: string, from: string, body: string, sid: string) =>
    twilio("/webhooks/twilio/cleaner-core", { MessageSid: sid, From: from, To: to, Body: body, SmsStatus: "received" });

  const close = () => {
    // Touring processes first: the test folder is removed next, and a running process may still write to it.
    app.server.tourCore.touring?.supervisor.stopAll();
    setCleanerTwilioClient(undefined);
    setCleanerCalendarFetch(undefined);
    setCleanerAlertFetch(undefined);
    setTouringAlertFetch(undefined);
    resetLiveDesks();
  };

  const touring = () => app.server.tourCore.touring;
  /**
   * An existing cleaning host: the account gets one property with Cleaner Core on, if it has none,
   * then the chat connects at /mcp/cleaner-core. Returns its access token.
   */
  const joinCleaning = async (tenantId: string, assistant: CleanerAssistant = "grok") => {
    const account = registry.get(tenantId)!;
    if (account.properties.length === 0) registry.setFlow(tenantId, registry.addProperty(tenantId, `${account.label} property`).id, "cleaning", true);
    return join(tenantId, assistant);
  };

  /** The folder of the account's first property: its Cleaner Core desk's root. */
  const cleaningRoot = (tenantId: string) => propertyFolder(app.root, tenantId, registry.get(tenantId)!.properties[0]!);

  /** Makes an account a parked touring account, as /admin does, and starts its touring process. */
  const makeTouring = async (tenantId: string) => {
    registry.setTouring(tenantId);
    await app.server.tourCore.touring?.start(registry.get(tenantId)!);
  };
  const hosted = () => app.server.tourCore.hosted!;

  return { app, registry, sms, wakes, makeTouring, joinCleaning, cleaningRoot, setWakeStatus: (status: number) => void (wakeStatus = status), join, joinAt, pageAt, refusedAt, tool, toolAt, rpcAt, toolNames, twilio, text, touring, hosted, close };
}

export type MultiTenantApp = Awaited<ReturnType<typeof multiTenantApp>>;
