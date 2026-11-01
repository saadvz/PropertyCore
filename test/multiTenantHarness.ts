import { setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import type { CleanerAssistant } from "../src/cleaner-core/assistant";
import { TenantRegistry } from "../src/cleaner-core/hosted/registry";
import { setTouringAlertFetch } from "../src/hosted/touringAlerts";
import { CLEANER_SCOPE, OPERATOR_SCOPE } from "../src/mcp/oauth/provider";
import { twilioSignature } from "../src/messaging/twilio/signature";
import { BASE, CLEANER_RESOURCE, hostedApp } from "./cleanerOauthHarness";
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

export interface Wake {
  url: string;
  body: string;
}

export async function multiTenantApp(options: { now?: () => Date; env?: NodeJS.ProcessEnv } = {}) {
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
  const joinAt = async (tenantId: string, assistant: CleanerAssistant, path: "/mcp" | "/mcp/cleaner-core") => {
    const redirect = REDIRECTS[assistant];
    const clientId = await app.register(assistant, redirect);
    const inviteCode = registry.invite(tenantId);
    const resource = `${BASE}${path}`;
    const { access } = await app.connect(clientId, resource, path === "/mcp" ? OPERATOR_SCOPE : CLEANER_SCOPE, resource, { inviteCode, redirect });
    return access;
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
  const hosted = () => app.server.tourCore.hosted!;

  return { app, registry, sms, wakes, setWakeStatus: (status: number) => void (wakeStatus = status), join, joinAt, tool, toolAt, rpcAt, toolNames, twilio, text, touring, hosted, close };
}

export type MultiTenantApp = Awaited<ReturnType<typeof multiTenantApp>>;
