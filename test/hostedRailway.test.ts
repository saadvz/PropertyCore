import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publicHealth, runtimeHealth, testVisitorMessaging } from "../src/install/checks";
import { selectPublicEndpoint } from "../src/install/bootstrap";
import { parseDeploymentMode, resolveDeploymentMode } from "../src/install/deployment";
import { externalUrls, hostedConnectLine, hostedTenancyLine, listenHost, listenPort, redactSecrets, resolveHostedPublicUrl, startupLines, validateHostedConfig } from "../src/install/hostedRuntime";
import { Installation } from "../src/install/installation";
import { HOSTED_SETUP_WRITES } from "../src/install/setupSessions";
import { handleSecureSetupApi } from "../src/install/secureSetup";
import { SECOND_TENANT_MESSAGE, clearHostedTenant } from "../src/install/tenant";
import { OPERATOR_SCOPE } from "../src/mcp/oauth";
import { endpointsFor } from "../src/mcp/oauth/provider";
import { webhookUrlFor } from "../src/messaging/sendblue/runtime";
import { readSendblueEnv, setSendblueRuntime } from "../src/messaging/sendblue/runtime";
import { effectiveEnv } from "../src/install/settings";
import { redirectUriFor } from "../src/storage/googleOAuth";
import { FakeGoogleDrive } from "../src/storage/googleDrive";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { PropertyWorkspace } from "../src/setup";
import { startSetupServer } from "../src/web/server";
import { fakeSendblue } from "./fakeSendblue";
import { GRANT_9AM } from "./grokHarness";
import { installHarness, SB_KEY, SB_SECRET } from "./installHarness";

const DOMAIN = "demo.up.railway.app";
const BASE = `https://${DOMAIN}`;
const SECRET = "sb-api-key-SECRETVALUE-11111111";
const REFRESH = "google-refresh-SECRET-token-xyz";
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((run) => run()));

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tourcore-hosted-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function hostedEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0", RAILWAY_PUBLIC_DOMAIN: DOMAIN, TOURCORE_HOME: root, PORT: "8080", ...extra };
}

function installation(root: string, env: NodeJS.ProcessEnv, now = () => Date.now(), drive?: FakeGoogleDrive) {
  const runtime = new FileRuntimeStore(join(root, "runtime"));
  let inst!: Installation;
  inst = new Installation({
    root,
    runtime,
    env: () => env,
    now,
    driveClient: drive,
    sendblueEnv: () => readSendblueEnv(inst.env()),
  });
  return inst;
}

/** fetch() can't set Host. Railway's proxy sends the public hostname. */
function hostedFetch(port: number, extra: Record<string, string> = {}) {
  return (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; json: () => Promise<unknown>; text: () => Promise<string> }>((resolve, reject) => {
      const body = init.body ? Buffer.from(init.body) : undefined;
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: init.method ?? "GET",
          headers: { host: DOMAIN, "x-forwarded-proto": "https", ...extra, ...init.headers, ...(body ? { "content-length": String(body.length) } : {}) },
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

describe("HOSTED_RAILWAY_P0 runtime", () => {
  it("recognizes the mode, reads PORT, binds the external host, and derives an https URL", () => {
    expect(parseDeploymentMode("hosted-railway")).toEqual({ mode: "HOSTED_RAILWAY_P0" });
    expect(resolveDeploymentMode({ TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0" }).mode).toBe("HOSTED_RAILWAY_P0");
    expect(listenHost("HOSTED_RAILWAY_P0")).toBe("0.0.0.0");
    expect(listenHost("GROK_MANAGED_P0")).toBe("127.0.0.1");
    const localPort = listenPort({}, "LOCAL_DEVELOPER");
    expect("port" in localPort && localPort.port).toBe(4321);
    expect(listenPort({}, "HOSTED_RAILWAY_P0")).toEqual({ problem: expect.stringContaining("PORT") });
    expect(listenPort({ PORT: "nope" }, "HOSTED_RAILWAY_P0")).toEqual({ problem: expect.stringContaining("isn't a valid port") });
    expect(resolveHostedPublicUrl({ RAILWAY_PUBLIC_DOMAIN: DOMAIN }).url).toBe(BASE);
    expect(resolveHostedPublicUrl({ PUBLIC_BASE_URL: "https://old.trycloudflare.com", RAILWAY_PUBLIC_DOMAIN: DOMAIN }).problem).toMatch(/trycloudflare/);
    expect(resolveHostedPublicUrl({ PUBLIC_BASE_URL: "http://demo.up.railway.app" }).problem).toMatch(/https/);
    const config = validateHostedConfig(hostedEnv("/data"));
    expect(config).toMatchObject({ ok: true, port: 8080, host: "0.0.0.0", publicUrl: BASE, dataDir: "/data" });
    expect(validateHostedConfig({ TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0", PORT: "8080" }).ok).toBe(false);
    expect(validateHostedConfig(hostedEnv("/data", { RAILWAY_VOLUME_MOUNT_PATH: "/data" })).ok).toBe(true);
    expect(validateHostedConfig(hostedEnv("/var/lib/tourcore", { RAILWAY_VOLUME_MOUNT_PATH: "/data" })).ok).toBe(false);
  });

  it("never selects cloudflared, and every external URL uses the Railway address", async () => {
    const endpoint = selectPublicEndpoint("HOSTED_RAILWAY_P0", {
      env: () => ({ RAILWAY_PUBLIC_DOMAIN: DOMAIN }),
      serviceDir: tempDir(),
      binDir: tempDir(),
    });
    expect(endpoint?.kind).toBe("RAILWAY");
    expect((await endpoint!.ensure("http://127.0.0.1:4321")).url).toBe(BASE);
    expect(selectPublicEndpoint("GROK_MANAGED_P0", { env: () => ({}), serviceDir: tempDir(), binDir: tempDir() })?.kind).toBe("CLOUDFLARE_QUICK_TUNNEL");
    const urls = externalUrls(BASE);
    expect(urls.mcp).toBe(`${BASE}/mcp`);
    expect(urls.sendblueWebhook).toBe(webhookUrlFor({ publicBaseUrl: BASE }));
    expect(urls.verify("abc")).toBe(`${BASE}/verify/abc`);
    expect(urls.googleCallback).toBe(redirectUriFor(BASE));
    expect(endpointsFor(BASE, "/mcp").resource).toBe(`${BASE}/mcp`);
    expect(JSON.stringify(urls)).not.toMatch(/trycloudflare/);
  });

  it("listens on the external host and /healthz answers without secrets", async () => {
    const root = tempDir();
    const env = hostedEnv(root);
    const inst = installation(root, env);
    inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    inst.secrets.set({ SENDBLUE_API_API_KEY: SECRET });
    cleanups.push(setSendblueRuntime({ env: () => readSendblueEnv(effectiveEnv(env, inst.settingsSource())) }));
    const { server } = await startSetupServer({
    toolSurface: "all", installation: inst, workspace: new PropertyWorkspace(root), host: "0.0.0.0", port: 0, open: false });
    cleanups.push(() => server.close());
    const address = server.address();
    expect(typeof address === "object" && address ? address.address : "").not.toBe("127.0.0.1");
    const port = typeof address === "object" && address ? address.port : 0;
    const http = hostedFetch(port);
    const health = await http("/healthz");
    expect(health.status).toBe(200);
    const body = await health.text();
    expect(body).toMatch(/"service":"tour-core"/);
    expect(JSON.parse(body)).toMatchObject({
      ok: true,
      service: "tour-core",
      commit: null,
      storagePath: expect.any(String),
      persistentVolume: expect.any(Boolean),
    });
    expect(JSON.parse(body)).toHaveProperty("volumeMount");
    expect(body).not.toContain(SECRET);
    expect(body).not.toMatch(/trycloudflare|apiKey|refresh/i);
    const probe = hostedFetch(port, { host: "healthcheck.railway.app" });
    expect((await probe("/healthz")).status).toBe(200);
    expect(await (await probe("/healthz")).json()).toMatchObject({ ok: true, service: "tour-core", commit: null });
    expect((await http("/")).status).toBe(404);
  });

  it("reports the Railway commit SHA on /healthz, or null when unset", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const unsetRoot = tempDir();
    const unset = installation(unsetRoot, hostedEnv(unsetRoot));
    expect(publicHealth(unset).commit).toBeNull();
    expect(runtimeHealth(unset)).toMatchObject({
      version: expect.any(String),
      commit: null,
      storagePath: expect.any(String),
      persistentVolume: expect.any(Boolean),
    });
    expect(runtimeHealth(unset)).toHaveProperty("volumeMount");

    const root = tempDir();
    const env = hostedEnv(root, { RAILWAY_GIT_COMMIT_SHA: sha });
    const inst = installation(root, env);
    inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    expect(publicHealth(inst).commit).toBe(sha);
    expect(runtimeHealth(inst).commit).toBe(sha);
    expect(publicHealth(installation(root, hostedEnv(root, { TOURCORE_COMMIT_SHA: sha }))).commit).toBe(sha);
    expect(publicHealth(installation(root, hostedEnv(root, { GIT_COMMIT_SHA: sha }))).commit).toBe(sha);
    expect(publicHealth(installation(root, hostedEnv(root, { RAILWAY_GIT_COMMIT_SHA: "  ", TOURCORE_COMMIT_SHA: sha }))).commit).toBe(sha);

    const { server } = await startSetupServer({
    toolSurface: "all", installation: inst, workspace: new PropertyWorkspace(root), host: "0.0.0.0", port: 0, open: false });
    cleanups.push(() => server.close());
    const port = (server.address() as { port: number }).port;
    const body = await (await hostedFetch(port)("/healthz")).json();
    expect(body).toMatchObject({ ok: true, service: "tour-core", commit: sha });
    expect(JSON.stringify(body)).not.toMatch(/RAILWAY_|TOURCORE_HOME|PORT/);
  });
});

describe("hosted security", () => {
  async function app() {
    const root = tempDir();
    const env = hostedEnv(root);
    const inst = installation(root, env);
    inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    cleanups.push(setSendblueRuntime({ env: () => readSendblueEnv(effectiveEnv(env, inst.settingsSource())) }));
    const { server } = await startSetupServer({
    toolSurface: "all", installation: inst, workspace: new PropertyWorkspace(root), host: "127.0.0.1", port: 0, open: false });
    cleanups.push(() => server.close());
    const port = (server.address() as { port: number }).port;
    return { inst, http: hostedFetch(port), port };
  }

  it("requires a short-lived setup session and refuses an anonymous visitor", async () => {
    const { inst, http } = await app();
    const anon = await http("/api/install/visitor-messaging", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey: SECRET, apiSecret: SB_SECRET, fromNumber: "+15550009999" }) });
    expect(anon.status).toBe(401);
    expect(inst.secrets.get("SENDBLUE_API_API_KEY")).toBeUndefined();
    const minted = inst.sessions.mint(15, { csrf: true, writes: 1 });
    const headers = { "content-type": "application/json", "x-tourcore-setup-session": minted.token, "x-tourcore-csrf": minted.csrf!, origin: BASE };
    const saved = await http("/api/install/visitor-messaging", { method: "POST", headers, body: JSON.stringify({ apiKey: SECRET, apiSecret: SB_SECRET, fromNumber: "+15550009999" }) });
    expect([200, 400]).toContain(saved.status);
    const raw = await saved.text();
    expect(raw).not.toContain(SECRET);
    expect(inst.secrets.get("SENDBLUE_API_API_KEY")).toBe(SECRET);
    const again = await http("/api/install/visitor-messaging", { method: "POST", headers, body: JSON.stringify({ apiKey: SECRET, apiSecret: SB_SECRET, fromNumber: "+15550009999" }) });
    expect(again.status).toBe(401);
    expect(await again.text()).toMatch(/already been used|expired/);
  });

  it("expires a setup session and ignores a cross-site origin", async () => {
    const clock = { t: Date.now() };
    const root = tempDir();
    const env = hostedEnv(root);
    const inst = installation(root, env, () => clock.t);
    inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    const minted = inst.sessions.mint(15, { csrf: true, writes: HOSTED_SETUP_WRITES });
    clock.t += 16 * 60_000;
    const expired = await handleSecureSetupApi({ installation: inst, services: {} as never }, "POST", "/api/install/visitor-messaging", { "x-tourcore-setup-session": minted.token, "x-tourcore-csrf": minted.csrf }, {});
    expect(expired.status).toBe(401);
    const fresh = inst.sessions.mint(15, { csrf: true, writes: HOSTED_SETUP_WRITES });
    const crossed = await handleSecureSetupApi(
      { installation: inst, services: {} as never },
      "POST",
      "/api/install/visitor-messaging",
      { "x-tourcore-setup-session": fresh.token, "x-tourcore-csrf": fresh.csrf, origin: "https://evil.example" },
      { apiKey: SECRET, apiSecret: SB_SECRET, fromNumber: "+15550009999" },
    );
    expect(crossed.status).toBe(403);
    expect(inst.secrets.get("SENDBLUE_API_API_KEY")).toBeUndefined();
  });

  it("requires a human approval and refuses Grok's bearer token", async () => {
    const { inst, http } = await app();
    const { verifier, challenge } = (() => {
      const value = randomBytes(32).toString("base64url");
      return { verifier: value, challenge: createHash("sha256").update(value).digest("base64url") };
    })();
    const registered = await http("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Grok", redirect_uris: ["https://grok.com/connectors/oauth/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as { client_id: string };
    const state = randomBytes(8).toString("hex");
    const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://grok.com/connectors/oauth/callback", code_challenge: challenge, code_challenge_method: "S256", state, scope: OPERATOR_SCOPE, resource: `${BASE}/mcp` });
    const authorize = await http(`/authorize?${query}`);
    expect(authorize.status).toBe(200);
    const html = await authorize.text();
    const requestId = /data-request="([^"]+)"/.exec(html)?.[1];
    const matchCode = /class="match-code">([^<]+)/.exec(html)?.[1];
    expect(requestId).toBeTruthy();
    expect(html).toContain("Approving this first connection will make this Grok connection the owner of this Tour Core demo.");
    expect(html).toContain(">Allow</button>");
    expect(inst.files.state().hostedTenant).toBeUndefined();
    expect((await http(`/api/grok/requests/${requestId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
    expect((await http(`/oauth/requests/${requestId}/approve`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer grok-mcp-token" }, body: JSON.stringify({ matchCode }) })).status).toBe(401);
    expect(inst.files.state().hostedTenant).toBeUndefined();
    expect((await http(`/oauth/requests/${requestId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ matchCode: "000 000" }) })).status).toBe(403);
    const allowed = await http(`/oauth/requests/${requestId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ matchCode }) });
    expect(allowed.status).toBe(200);
    expect((await http(`/oauth/requests/${requestId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ matchCode }) })).status).toBe(403);
    expect(verifier).toBeTruthy();
    expect(inst.files.state().hostedTenant?.clientId).toBe(client.client_id);
  });
});

describe("hosted storage, secrets, and one demo tenant", () => {
  it("keeps secrets across a restart, out of Drive, and out of logs", () => {
    const root = tempDir();
    const env = hostedEnv(root);
    const first = installation(root, env);
    first.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    first.secrets.set({ SENDBLUE_API_API_KEY: SECRET, GOOGLE_OAUTH_REFRESH_TOKEN: REFRESH, TOURCORE_GROK_ROUTINE_KEY: "routine-bearer-SECRETKEY-1a2b3c4d" });
    const second = installation(root, env);
    expect(second.secrets.get("SENDBLUE_API_API_KEY")).toBe(SECRET);
    expect(second.secrets.get("GOOGLE_OAUTH_REFRESH_TOKEN")).toBe(REFRESH);
    const lines = startupLines({ version: "0.4.0", mode: "HOSTED_RAILWAY_P0", port: 8080, host: "0.0.0.0", publicHost: DOMAIN, storage: "Google Drive (canonical)" }).map((line) => redactSecrets(line, [SECRET, REFRESH, "routine-bearer-SECRETKEY-1a2b3c4d"]));
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain(REFRESH);
    expect(JSON.stringify(second.files.manifest())).not.toContain(SECRET);
  });

  it("describes the hosted service as it runs: one demo owner, or many hosts on invite codes (#215)", () => {
    const mcp = `https://${DOMAIN}/mcp`;
    expect(hostedTenancyLine(false)).toBe("Hosted Railway P0 is single-tenant. Marketplace publication requires tenant isolation.");
    expect(hostedConnectLine(mcp, false)).toBe(`Grok connects at ${mcp}. The first Allow on the authorization page claims this demo.`);
    const tenancy = hostedTenancyLine(true);
    const connect = hostedConnectLine(mcp, true);
    expect(tenancy).toContain("multi-tenant");
    expect(tenancy).not.toContain("single-tenant");
    expect(connect).toContain(mcp);
    expect(connect).toContain("invite code");
    expect(connect).not.toContain("claims this demo");
  });

  it("restores Drive records, refuses a second live writer, and does not let a stale cache win", async () => {
    const fake = new FakeGoogleDrive();
    const clock = { t: Date.parse("2026-09-28T15:00:00.000Z") };
    const origin = tempDir();
    mkdirSync(join(origin, "properties", "prop_elm"), { recursive: true });
    mkdirSync(join(origin, "runtime", "operator-events"), { recursive: true });
    writeFileSync(join(origin, "properties", "prop_elm", "tourcore.config.json"), JSON.stringify({ schemaVersion: 1, property: { id: "prop_elm", name: "Elm" } }));
    writeFileSync(join(origin, "runtime", "operator-events", "evt_booked01.json"), JSON.stringify({ schemaVersion: 1, event: { eventId: "evt_booked01", eventType: "tour.booked", occurredAt: "2026-09-28T15:00:00.000Z" }, status: "delivered", attempts: 1 }));
    const local = installation(origin, hostedEnv(origin, { TOURCORE_STORAGE_MODEL: "DIRECT_GOOGLE_DRIVE" }), () => clock.t, fake);
    local.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    local.secrets.set({ GOOGLE_OAUTH_REFRESH_TOKEN: REFRESH });
    local.files.update({ storageProvider: "GOOGLE_DRIVE" });
    expect((await local.records.finish()).ok).toBe(true);
    expect(JSON.stringify([...fake.files.values()])).not.toContain(REFRESH);
    expect(JSON.stringify([...fake.files.values()])).not.toContain(SECRET);

    const storeId = local.files.state().storage?.storeId!;
    const hostedRoot = tempDir();
    const hosted = installation(hostedRoot, hostedEnv(hostedRoot, { TOURCORE_STORAGE_MODEL: "DIRECT_GOOGLE_DRIVE" }), () => clock.t + 30_000, fake);
    hosted.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    hosted.secrets.set({ GOOGLE_OAUTH_REFRESH_TOKEN: REFRESH });
    hosted.files.update({ storageProvider: "GOOGLE_DRIVE" });
    hosted.files.writeState({ ...hosted.files.state(), storage: { mode: "GOOGLE_DRIVE", phase: "READY", storeId } });
    const busy = await hosted.records.resumeCanonical();
    expect(busy.ok).toBe(false);
    expect(busy.summary).toMatch(/another Tour Core/i);

    const laterRoot = tempDir();
    mkdirSync(join(laterRoot, "properties", "prop_elm"), { recursive: true });
    const later = installation(laterRoot, hostedEnv(laterRoot, { TOURCORE_STORAGE_MODEL: "DIRECT_GOOGLE_DRIVE" }), () => clock.t + 5 * 60_000, fake);
    later.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    later.secrets.set({ GOOGLE_OAUTH_REFRESH_TOKEN: REFRESH });
    later.files.update({ storageProvider: "GOOGLE_DRIVE" });
    later.files.writeState({ ...later.files.state(), storage: { mode: "GOOGLE_DRIVE", phase: "READY", storeId } });
    writeFileSync(join(laterRoot, "properties", "prop_elm", "tourcore.config.json"), JSON.stringify({ schemaVersion: 1, property: { name: "STALE CACHE" } }));
    const resumed = await later.records.resumeCanonical();
    expect(resumed.ok).toBe(true);
    expect(readFileSync(join(later.root, "properties", "prop_elm", "tourcore.config.json"), "utf8")).not.toContain("STALE CACHE");
    expect(readFileSync(join(later.root, "properties", "prop_elm", "tourcore.config.json"), "utf8")).toContain("Elm");
    expect(readFileSync(join(later.root, "runtime", "operator-events", "evt_booked01.json"), "utf8")).toContain("delivered");
    expect(later.files.state().storage?.hostId).not.toBe(local.files.state().storage?.hostId);
    expect(later.secrets.get("GOOGLE_OAUTH_REFRESH_TOKEN")).toBe(REFRESH);
  });

  it("moves a quick-tunnel Drive install onto the Railway address and repairs Sendblue", async () => {
    const h = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0", RAILWAY_PUBLIC_DOMAIN: DOMAIN } });
    const hooks: Array<{ url: string; secret?: string }> = [{ url: "https://old-name.trycloudflare.com/webhooks/sendblue" }];
    const fake = fakeSendblue({ hooks, lines: [{ sendblue_number: "+15550009999", status: "ONLINE" }] });
    const create = fake.client.webhooks.create.bind(fake.client.webhooks);
    fake.client.webhooks.create = async (body) => {
      hooks.push(...((body.webhooks as Array<{ url: string; secret?: string }>) ?? []));
      return create(body);
    };
    cleanups.push(setSendblueRuntime({ env: () => h.inst.sendblueEnv(), client: () => fake.client }));
    cleanups.push(h.cleanup);
    h.inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    h.inst.files.setPublicBaseUrl("https://old-name.trycloudflare.com", "CLOUDFLARE_QUICK_TUNNEL");
    expect(h.inst.publicBaseUrl()).toBe(BASE);
    const change = h.inst.files.setPublicBaseUrl(BASE, "RAILWAY");
    expect(change.changed).toBe(true);
    expect(h.inst.files.state().publicBaseUrlHistory.some((entry) => entry.url.includes("trycloudflare") && entry.until)).toBe(true);
    h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: "+15550009999" });
    h.inst.files.recordCheck("visitorMessaging", { ok: true, at: "2020-01-01T00:00:00.000Z", message: "old", problems: [], publicBaseUrl: "https://old-name.trycloudflare.com", webhookUrl: "https://old-name.trycloudflare.com/webhooks/sendblue" });
    const result = await testVisitorMessaging(h.inst);
    expect(result.ok).toBe(true);
    expect(h.inst.files.state().visitorMessaging?.webhookUrl).toBe(`${BASE}/webhooks/sendblue`);
    expect(h.inst.files.state().visitorMessaging?.webhookUrl).not.toMatch(/trycloudflare/);
  });

  it("refuses a second unrelated account instead of mixing installations", async () => {
    const root = tempDir();
    const env = hostedEnv(root);
    const inst = installation(root, env);
    inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    cleanups.push(setSendblueRuntime({ env: () => readSendblueEnv(effectiveEnv(env, inst.settingsSource())) }));
    const { server: listening } = await startSetupServer({
    toolSurface: "all", installation: inst, workspace: new PropertyWorkspace(root), host: "127.0.0.1", port: 0, open: false });
    cleanups.push(() => listening.close());
    const http = hostedFetch((listening.address() as { port: number }).port);
    const register = (name: string) =>
      http("/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: name, redirect_uris: ["https://grok.com/connectors/oauth/callback"], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }),
      });
    const first = (await (await register("First")).json()) as { client_id: string };
    const { challenge } = (() => {
      const value = randomBytes(32).toString("base64url");
      return { challenge: createHash("sha256").update(value).digest("base64url") };
    })();
    const query = (clientId: string) => new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://grok.com/connectors/oauth/callback", code_challenge: challenge, code_challenge_method: "S256", state: "state-one", scope: OPERATOR_SCOPE, resource: `${BASE}/mcp` });
    const opened = await http(`/authorize?${query(first.client_id)}`);
    const html = await opened.text();
    const requestId = /data-request="([^"]+)"/.exec(html)?.[1]!;
    const matchCode = /class="match-code">([^<]+)/.exec(html)?.[1];
    expect((await http(`/oauth/requests/${requestId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ matchCode }) })).status).toBe(200);
    const second = (await (await register("Second")).json()) as { client_id: string };
    const refused = await http(`/authorize?${query(second.client_id)}`);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("Marketplace publication requires tenant isolation.");
    expect(clearHostedTenant(inst.files)).toBe(true);
    expect((await http(`/authorize?${query(second.client_id)}`)).status).toBe(200);
  });
});

describe("hosted audit export download", () => {
  it("builds a public-base download URL, serves it with the token, and refuses missing or expired tokens", async () => {
    const h = installHarness({ env: { TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0", RAILWAY_PUBLIC_DOMAIN: DOMAIN, PORT: "8080" } });
    cleanups.push(h.cleanup);
    h.inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    expect(h.inst.publicBaseUrl()).toBe(BASE);

    const id = await h.publish();
    await h.touringVisitor(id);
    const { server } = await startSetupServer({
    toolSurface: "all", installation: h.inst, workspace: h.workspace, host: "127.0.0.1", port: 0, open: false, now: () => new Date(h.now()) });
    cleanups.push(() => server.close());
    const port = (server.address() as { port: number }).port;
    const http = hostedFetch(port);

    const out = await h.ok("export_audit", { day: "today" });
    const url = out.files[0].openOnTourCoreComputer as string;
    expect(url).toMatch(new RegExp(`^${BASE}/api/properties/${id}/audit-exports/2026-09-28_.+/audit-export\\.json\\?t=`));
    expect(url).not.toMatch(/localhost|127\.0\.0\.1/);
    expect(out.accessGrants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ doorName: "Lobby Entrance", ...GRANT_9AM, unitName: "Unit 101" }),
        expect.objectContaining({ doorName: "Unit 101 Door", ...GRANT_9AM, unitName: "Unit 101" }),
      ]),
    );

    const path = url.slice(BASE.length);
    const withToken = await http(path);
    expect(withToken.status).toBe(200);
    expect(JSON.parse(await withToken.text()).summary.tours).toBe(1);

    const bare = path.replace(/\?t=[^&]+$/, "");
    const missing = await http(bare);
    expect(missing.status).toBe(401);
    expect(await missing.text()).toMatch(/isn't valid or has expired/);

    h.setClock(h.now() + 31 * 60_000);
    const expired = await http(path);
    expect(expired.status).toBe(401);
    expect(await expired.text()).toMatch(/isn't valid or has expired/);
  });
});
