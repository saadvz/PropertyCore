import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/tourCoreConfig";
import { HOSTED_OWNER_RESET } from "../src/install/hostedOwner";
import { Installation } from "../src/install/installation";
import { clearHostedTenant } from "../src/install/tenant";
import { GROK_LEGACY_REDIRECT_URIS, grokLegacyCompatEnabled, hostedCompatStartupLine, redirectPolicyFor } from "../src/mcp/oauth/clients";
import { OPERATOR_SCOPE, REQUEST_SECONDS } from "../src/mcp/oauth/provider";
import { effectiveEnv } from "../src/install/settings";
import { readSendblueEnv, setSendblueRuntime } from "../src/messaging/sendblue/runtime";
import { PropertyWorkspace } from "../src/setup";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { startSetupServer } from "../src/web/server";

const DOMAIN = "demo.up.railway.app";
const BASE = `https://${DOMAIN}`;
const CURSOR_APP = "cursor://anysphere.cursor-mcp/oauth/callback";
const CURSOR_WEB = "https://www.cursor.com/agents/mcp/oauth/callback";
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((run) => run()));

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tourcore-hosted-oauth-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function hostedEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0", RAILWAY_PUBLIC_DOMAIN: DOMAIN, TOURCORE_HOME: root, PORT: "8080", ...extra };
}

function installation(root: string, env: NodeJS.ProcessEnv, now = () => Date.now()) {
  const runtime = new FileRuntimeStore(join(root, "runtime"));
  let inst!: Installation;
  inst = new Installation({ root, runtime, env: () => env, now, sendblueEnv: () => readSendblueEnv(inst.env()) });
  return inst;
}

function hostedFetch(port: number) {
  return (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; text: () => Promise<string>; json: () => Promise<unknown> }>((resolve, reject) => {
      const body = init.body ? Buffer.from(init.body) : undefined;
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: init.method ?? "GET",
          headers: { host: DOMAIN, "x-forwarded-proto": "https", ...init.headers, ...(body ? { "content-length": String(body.length) } : {}) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            resolve({ status: res.statusCode ?? 0, headers: res.headers, text: async () => raw, json: async () => (raw ? JSON.parse(raw) : {}) });
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function hostedApp(options: { env?: NodeJS.ProcessEnv; now?: () => number; authNow?: () => number; seed?: boolean; bootstrapSecret?: string } = {}) {
  const root = tempDir();
  const env = options.env ?? hostedEnv(root, options.bootstrapSecret ? { TOURCORE_HOSTED_OWNER_BOOTSTRAP_SECRET: options.bootstrapSecret } : {});
  const inst = installation(root, env, options.now);
  inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
  const workspace = new PropertyWorkspace(root);
  if (options.seed) workspace.save(loadConfig());
  const logs: string[] = [];
  cleanups.push(setSendblueRuntime({ env: () => readSendblueEnv(effectiveEnv(env, inst.settingsSource())) }));
  const { server } = await startSetupServer({
    toolSurface: "all",
    installation: inst,
    workspace,
    host: "127.0.0.1",
    port: 0,
    open: false,
    oauthRateLimit: false,
    authNow: options.authNow ?? options.now,
    now: options.now ? () => new Date(options.now!()) : undefined,
    log: (line) => logs.push(line),
  });
  cleanups.push(() => server.close());
  const port = (server.address() as { port: number }).port;
  return { inst, root, env, logs, http: hostedFetch(port), server, port };
}

describe("hosted Grok callback compatibility", () => {
  it("turns the narrow list on for HOSTED_RAILWAY_P0 unless it is explicitly false", () => {
    expect(grokLegacyCompatEnabled({}, "HOSTED_RAILWAY_P0")).toBe(true);
    expect(grokLegacyCompatEnabled({ TOURCORE_GROK_LEGACY_OAUTH_COMPAT: "1" }, "HOSTED_RAILWAY_P0")).toBe(true);
    expect(grokLegacyCompatEnabled({ TOURCORE_GROK_LEGACY_OAUTH_COMPAT: "false" }, "HOSTED_RAILWAY_P0")).toBe(false);
    expect(grokLegacyCompatEnabled({ TOURCORE_GROK_LEGACY_OAUTH_COMPAT: " FALSE " }, "HOSTED_RAILWAY_P0")).toBe(false);
    expect(grokLegacyCompatEnabled({ TOURCORE_GROK_LEGACY_OAUTH_COMPAT: "true" }, "LOCAL_DEVELOPER")).toBe(true);
    expect(grokLegacyCompatEnabled({}, "LOCAL_DEVELOPER")).toBe(false);
    expect(grokLegacyCompatEnabled({}, "SELF_HOSTED")).toBe(false);
    expect(grokLegacyCompatEnabled({}, "GROK_MANAGED_P0")).toBe(false);
    expect(redirectPolicyFor({}, "HOSTED_RAILWAY_P0").exact).toEqual([...GROK_LEGACY_REDIRECT_URIS]);
    expect(redirectPolicyFor({ TOURCORE_GROK_LEGACY_OAUTH_COMPAT: "false" }, "HOSTED_RAILWAY_P0").exact).toEqual([]);
    expect(hostedCompatStartupLine({}, "HOSTED_RAILWAY_P0")).toBe("Grok legacy OAuth compatibility active for HOSTED_RAILWAY_P0.");
    expect(hostedCompatStartupLine({ TOURCORE_GROK_LEGACY_OAUTH_COMPAT: "false" }, "HOSTED_RAILWAY_P0")).toMatch(/false/);
    expect(hostedCompatStartupLine({}, "LOCAL_DEVELOPER")).toBeUndefined();
  });

  it("accepts the known Grok callbacks on a hosted server without the Railway flag", async () => {
    const { http, logs } = await hostedApp();
    for (const uri of [CURSOR_WEB, CURSOR_APP]) {
      const res = await http("/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Cursor", redirect_uris: [uri], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }),
      });
      expect(res.status, uri).toBe(201);
    }
    const log = logs.join("\n");
    expect(log).toContain("accepted redirect: scheme=https host=www.cursor.com path=/agents/mcp/oauth/callback reason: known Grok legacy callback");
    expect(log).toContain("accepted redirect: scheme=cursor host=anysphere.cursor-mcp path=/oauth/callback reason: known Grok legacy callback");
    expect(log).not.toContain("TOURCORE_GROK_LEGACY_OAUTH_COMPAT=true");
  });

  it("rejects lookalikes, other cursor hosts, changed paths and added queries", async () => {
    const { http, logs } = await hostedApp();
    const lookalikes = [
      "cursor://anysphere.cursor-mcp/oauth/callback2",
      "cursor://anysphere.cursor-mcp/oauth/callback?x=evil-query-secret",
      "https://www.cursor.com/agents/mcp/oauth/callback/extra",
      "https://www.cursor.com/agents/mcp/oauth/callback?next=evil-query-secret",
      "https://cursor.com/agents/mcp/oauth/callback",
      "https://evil.cursor.com/agents/mcp/oauth/callback",
      "https://api2.cursor.sh/agents/mcp/oauth/callback",
      "https://user:embedded-secret@www.cursor.com/agents/mcp/oauth/callback",
      "http://www.cursor.com/agents/mcp/oauth/callback",
      "https://www.cursor.com.evil.example/agents/mcp/oauth/callback",
    ];
    for (const uri of lookalikes) {
      const res = await http("/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Cursor", redirect_uris: [uri], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }),
      });
      expect(res.status, uri).toBe(400);
    }
    const log = logs.join("\n");
    expect(log).toContain("refused redirect: scheme=cursor host=anysphere.cursor-mcp path=/oauth/callback2");
    expect(log).toContain("refused redirect: scheme=https host=cursor.com path=/agents/mcp/oauth/callback");
    expect(log).toContain("refused redirect: scheme=https host=api2.cursor.sh path=/agents/mcp/oauth/callback");
    expect(log).toContain("reason: contains credentials");
    expect(log).not.toContain("evil-query-secret");
    expect(log).not.toContain("embedded-secret");
  });

  it("lets an explicit false turn the hosted default off", async () => {
    const root = tempDir();
    const { http, logs } = await hostedApp({ env: hostedEnv(root, { TOURCORE_GROK_LEGACY_OAUTH_COMPAT: "false" }) });
    const refused = await http("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Cursor", redirect_uris: [CURSOR_WEB, CURSOR_APP], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    expect(refused.status).toBe(400);
    expect(logs.join("\n")).toContain("TOURCORE_GROK_LEGACY_OAUTH_COMPAT=false");
    const allowed = await http("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Grok", redirect_uris: ["https://grok.com/connectors/oauth/callback"], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    expect(allowed.status).toBe(201);
  });
});

describe("hosted first approved connection owns the demo", () => {
  async function register(http: ReturnType<typeof hostedFetch>, name: string, redirect = CURSOR_WEB) {
    const res = await http("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: name, redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { client_id: string };
  }

  function authorizeQuery(clientId: string, challenge: string, state: string, redirect = CURSOR_WEB) {
    return new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, scope: OPERATOR_SCOPE, resource: `${BASE}/mcp` });
  }

  it("never sends the /connect page to the removed /claim page (#215)", async () => {
    const app = await hostedApp({ seed: true });
    const script = await app.http("/connect.js");
    expect(script.status).toBe(200);
    const text = await script.text();
    expect(text).not.toContain("/claim");
    expect(text).not.toContain("pairing code");
    expect(text).toContain("Go back to your chat and connect again, then click Allow on the page the chat opens.");
    expect((await app.http("/claim")).status).toBe(404);
  });

  it("claims only when a human clicks Allow, then the same owner can reconnect", async () => {
    const app = await hostedApp({ seed: true });
    expect(app.inst.files.state().hostedTenant).toBeUndefined();
    const { verifier, challenge } = pkce();
    const state = "first-owner-state";
    const client = await register(app.http, "Cursor");
    expect(app.inst.files.state().hostedTenant).toBeUndefined();

    const authorize = await app.http(`/authorize?${authorizeQuery(client.client_id, challenge, state)}`);
    expect(authorize.status).toBe(200);
    const html = await authorize.text();
    const requestId = /data-request="([^"]+)"/.exec(html)![1]!;
    const matchCode = /class="match-code">([^<]+)/.exec(html)![1]!;
    expect(html).toContain("Approving this first connection will make this Grok connection the owner of this Tour Core demo.");
    expect(html).toContain(">Allow</button>");
    expect(html).not.toContain("/claim");
    expect(app.inst.files.state().hostedTenant).toBeUndefined();

    const denied = await app.http(`/oauth/requests/${requestId}/deny`, { method: "POST" });
    expect(denied.status).toBe(200);
    expect(app.inst.files.state().hostedTenant).toBeUndefined();

    const again = await app.http(`/authorize?${authorizeQuery(client.client_id, challenge, state)}`);
    const page = await again.text();
    const nextId = /data-request="([^"]+)"/.exec(page)![1]!;
    const nextCode = /class="match-code">([^<]+)/.exec(page)![1]!;
    expect((await app.http(`/oauth/requests/${nextId}/approve`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer grok-mcp-token" }, body: JSON.stringify({ matchCode: nextCode }) })).status).toBe(401);
    expect(app.inst.files.state().hostedTenant).toBeUndefined();
    expect(((await (await app.http(`/oauth/requests/${nextId}`)).json()) as { status: string }).status).toBe("pending");

    const allowed = await app.http(`/oauth/requests/${nextId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ matchCode: nextCode }) });
    expect(allowed.status).toBe(200);
    expect(app.inst.files.state().hostedTenant?.clientId).toBe(client.client_id);
    const back = await app.http(`/oauth/requests/${nextId}/continue`);
    expect(back.status).toBe(302);
    const location = new URL(back.headers.location!);
    expect(location.searchParams.get("state")).toBe(state);
    expect(location.searchParams.get("code")).toMatch(/^tcc_/);
    const token = await app.http("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: location.searchParams.get("code")!, code_verifier: verifier, client_id: client.client_id, redirect_uri: CURSOR_WEB, resource: `${BASE}/mcp` }).toString(),
    });
    expect(token.status).toBe(200);
    const access = ((await token.json()) as { access_token: string }).access_token;
    const listed = await app.http("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_state", arguments: {} } }),
    });
    expect(await listed.text()).toContain("100 Alfred Way");
    expect(app.logs.join("\n")).not.toContain(verifier);
    expect(app.logs.join("\n")).not.toContain(access);

    const restarted = installation(app.root, app.env);
    expect(restarted.files.state().hostedTenant?.clientId).toBe(client.client_id);
    const { server } = await startSetupServer({
    toolSurface: "all", installation: restarted, workspace: new PropertyWorkspace(app.root), host: "127.0.0.1", port: 0, open: false, oauthRateLimit: false });
    cleanups.push(() => server.close());
    const http = hostedFetch((server.address() as { port: number }).port);
    const reconnect = pkce();
    const reconnectState = "owner-reconnect";
    const opened = await http(`/authorize?${authorizeQuery(client.client_id, reconnect.challenge, reconnectState)}`);
    const reconnectHtml = await opened.text();
    expect(reconnectHtml).not.toContain("owner of this Tour Core demo");
    expect(reconnectHtml).toContain(">Allow</button>");
    const reconnectId = /data-request="([^"]+)"/.exec(reconnectHtml)![1]!;
    const reconnectCode = /class="match-code">([^<]+)/.exec(reconnectHtml)![1]!;
    expect((await http(`/oauth/requests/${reconnectId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ matchCode: reconnectCode }) })).status).toBe(200);
    expect(restarted.files.state().hostedTenant?.clientId).toBe(client.client_id);

    const other = await register(http, "Other");
    const refused = await http(`/authorize?${authorizeQuery(other.client_id, pkce().challenge, "other-state")}`);
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain(">Allow</button>");
    expect(restarted.files.state().hostedTenant?.clientId).toBe(client.client_id);

    expect(clearHostedTenant(restarted.files)).toBe(true);
    expect(restarted.files.state().hostedTenant).toBeUndefined();
    const next = await register(http, "Next");
    const fresh = await http(`/authorize?${authorizeQuery(next.client_id, pkce().challenge, "after-reset")}`);
    const freshHtml = await fresh.text();
    expect(freshHtml).toContain("owner of this Tour Core demo");
    const freshId = /data-request="([^"]+)"/.exec(freshHtml)![1]!;
    const freshCode = /class="match-code">([^<]+)/.exec(freshHtml)![1]!;
    expect((await http(`/oauth/requests/${freshId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ matchCode: freshCode }) })).status).toBe(200);
    expect(restarted.files.state().hostedTenant?.clientId).toBe(next.client_id);
    expect(HOSTED_OWNER_RESET).toBe("reset-hosted-owner");
    expect(REQUEST_SECONDS).toBeGreaterThan(0);
  });
});
