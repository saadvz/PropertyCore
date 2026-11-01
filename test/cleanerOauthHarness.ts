import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { Installation } from "../src/install/installation";
import { effectiveEnv } from "../src/install/settings";
import { readSendblueEnv, setSendblueRuntime } from "../src/messaging/sendblue/runtime";
import type { McpAuthMode } from "../src/mcp/authMode";
import { PropertyWorkspace } from "../src/setup";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { startSetupServer } from "../src/web/server";

/**
 * A hosted Tour Core on a made-up Railway domain, and the OAuth dance a Grok Bot does to connect.
 * Shared by the Cleaner Core OAuth tests and the full-diagram rehearsal. No real phone, no network.
 */

export const DOMAIN = "cleaner-demo.up.railway.app";
export const BASE = `https://${DOMAIN}`;
export const CLEANER_RESOURCE = `${BASE}/mcp/cleaner-core`;
export const CLEANER_PRM = `${BASE}/.well-known/oauth-protected-resource/mcp/cleaner-core`;
export const TOUR_PRM = `${BASE}/.well-known/oauth-protected-resource/mcp`;
export const REDIRECT = "https://grok.com/connectors/oauth/callback";

const cleanups: Array<() => void> = [];

/** Closes every hosted app and removes its folder. Call it in afterEach. */
export function closeHostedApps(): void {
  cleanups.splice(0).forEach((run) => run());
}

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tourcore-cleaner-oauth-"));
  // A touring process killed a moment ago may still be writing; removal retries briefly.
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

export function hostedEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0", RAILWAY_PUBLIC_DOMAIN: DOMAIN, TOURCORE_HOME: root, PORT: "8080", CLEANER_CORE_ENABLED: "1", ...extra };
}

function installation(root: string, env: NodeJS.ProcessEnv) {
  const runtime = new FileRuntimeStore(join(root, "runtime"));
  let inst!: Installation;
  inst = new Installation({ root, runtime, env: () => env, sendblueEnv: () => readSendblueEnv(inst.env()) });
  return inst;
}

export type Reply = { status: number; headers: IncomingHttpHeaders; text: () => Promise<string>; json: () => Promise<unknown>; bytes: () => Buffer };

function hostedFetch(port: number) {
  return (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<Reply>((resolve, reject) => {
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
            const bytes = Buffer.concat(chunks);
            const raw = bytes.toString("utf8");
            resolve({ status: res.statusCode ?? 0, headers: res.headers, text: async () => raw, json: async () => (raw ? JSON.parse(raw) : {}), bytes: () => bytes });
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
}

export const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

/** `now` is the server's clock for Cleaner Core; OAuth keeps the real clock. */
export async function hostedApp(extra: NodeJS.ProcessEnv = {}, existing?: { root: string; env: NodeJS.ProcessEnv }, mcpAuth?: McpAuthMode, now?: () => Date) {
  const root = existing?.root ?? tempDir();
  const env = existing?.env ?? hostedEnv(root, extra);
  const inst = installation(root, env);
  inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
  const logs: string[] = [];
  cleanups.push(setSendblueRuntime({ env: () => readSendblueEnv(effectiveEnv(env, inst.settingsSource())) }));
  const { server } = await startSetupServer({
    toolSurface: "all",
    installation: inst,
    workspace: new PropertyWorkspace(root),
    host: "127.0.0.1",
    port: 0,
    open: false,
    oauthRateLimit: false,
    ...(mcpAuth ? { mcpAuth } : {}),
    ...(now ? { now } : {}),
    log: (line) => logs.push(line),
  });
  cleanups.push(() => server.close());
  const http = hostedFetch((server.address() as { port: number }).port);

  const register = async (name = "Grok", redirect = REDIRECT) => {
    const res = await http("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: name, redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { client_id: string }).client_id;
  };

  const authorize = (clientId: string, challenge: string, resource: string, scope: string, state = "state-1", redirect = REDIRECT) =>
    http(`/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, scope, resource })}`);

  const pageParts = (html: string) => ({ id: /data-request="([^"]+)"/.exec(html)![1]!, code: /class="match-code">([^<]+)/.exec(html)![1]! });

  /** `inviteCode` is the multi-tenant service's invite field on the Allow page. */
  const approve = (id: string, code: string, headers: Record<string, string> = {}, inviteCode?: string) =>
    http(`/oauth/requests/${id}/approve`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ matchCode: code, ...(inviteCode !== undefined ? { inviteCode } : {}) }) });

  /** The whole dance for one resource. Returns the access token. */
  const connect = async (clientId: string, resource: string, scope: string, tokenResource = resource, options: { inviteCode?: string; redirect?: string } = {}) => {
    const { verifier, challenge } = pkce();
    const redirect = options.redirect ?? REDIRECT;
    const page = await authorize(clientId, challenge, resource, scope, "state-1", redirect);
    expect(page.status).toBe(200);
    const { id, code } = pageParts(await page.text());
    expect((await approve(id, code, {}, options.inviteCode)).status).toBe(200);
    const back = await http(`/oauth/requests/${id}/continue`);
    expect(back.status).toBe(302);
    const location = new URL(back.headers.location!);
    const token = await http("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: location.searchParams.get("code")!, code_verifier: verifier, client_id: clientId, redirect_uri: redirect, resource: tokenResource }).toString(),
    });
    expect(token.status).toBe(200);
    const body = (await token.json()) as { access_token: string; refresh_token: string; scope: string };
    return { access: body.access_token, refresh: body.refresh_token, scope: body.scope, verifier };
  };

  const refresh = (clientId: string, refreshToken: string, resource: string) =>
    http("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource }).toString(),
    });

  const rpc = (path: string, method: string, token?: string) =>
    http(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
    });

  return { inst, root, env, logs, server, http, register, authorize, pageParts, approve, connect, refresh, rpc };
}
