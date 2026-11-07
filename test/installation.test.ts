import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDeploymentMode, resolveDeploymentMode } from "../src/install/deployment";
import { assertNoSecrets, InstallationFiles, ManifestSchema } from "../src/install/manifest";
import { LocalSecretStore, MemorySecretStore } from "../src/install/secretStore";
import { effectiveEnv, secretValues, settingSource } from "../src/install/settings";
import { SetupSessions } from "../src/install/setupSessions";
import { INSTALLATION_TOOLS } from "../src/install/tools";
import { mcpToolList } from "../src/mcp/mcpBridge";
import { readSendblueEnv, setSendblueRuntime } from "../src/messaging/sendblue/runtime";
import { MemoryRuntimeStore } from "../src/storage/runtimeStore";
import { fakeSendblue } from "./fakeSendblue";
import { installHarness, ROUTINE_KEY, ROUTINE_URL, SB_KEY, SB_SECRET, type InstallHarness } from "./installHarness";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function harness(env: NodeJS.ProcessEnv = { TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0" }): InstallHarness {
  const h = installHarness({ env });
  cleanups.push(h.cleanup);
  return h;
}

const TUNNEL = "https://brave-otter-lamp.trycloudflare.com";
const TUNNEL_2 = "https://quiet-heron-glass.trycloudflare.com";

/** Records what the checks would record after a real, successful pass (the checks themselves are tested below). */
function markChecked(h: InstallHarness, what: "endpoint" | "messaging" | "alerts") {
  const at = new Date(h.now()).toISOString();
  const url = h.inst.publicBaseUrl()!;
  if (what === "endpoint") h.inst.files.recordCheck("publicEndpointCheck", { ok: true, at, message: "ok", url });
  if (what === "messaging") h.inst.files.recordCheck("visitorMessaging", { ok: true, at, message: "ok", problems: [], publicBaseUrl: url, webhookUrl: `${url}/webhooks/sendblue` });
  if (what === "alerts") {
    const changed = [h.inst.secrets.updatedAt("TOURCORE_GROK_ROUTINE_URL"), h.inst.secrets.updatedAt("TOURCORE_GROK_ROUTINE_KEY")].filter(Boolean).sort().at(-1);
    h.inst.files.recordCheck("operatorAlerts", { ok: true, at, message: "ok", ...(changed ? { credentialsChangedAt: changed } : {}) });
  }
}

async function completeInfrastructure(h: InstallHarness) {
  h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
  h.inst.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL");
  markChecked(h, "endpoint");
  h.connectGrok();
  h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: "+15550109999" });
  markChecked(h, "messaging");
  h.inst.files.writeState({ ...h.inst.files.state(), storage: { mode: "LOCAL_DEMO", phase: "READY", chosenAt: new Date(h.now()).toISOString() } });
  h.inst.secrets.set({ TOURCORE_GROK_ROUTINE_URL: ROUTINE_URL, TOURCORE_GROK_ROUTINE_KEY: ROUTINE_KEY });
  markChecked(h, "alerts");
}

describe("deployment modes", () => {
  it("parses the three modes and friendly spellings; anything else is reported, never guessed", () => {
    expect(parseDeploymentMode("GROK_MANAGED_P0")).toEqual({ mode: "GROK_MANAGED_P0" });
    expect(parseDeploymentMode("grok")).toEqual({ mode: "GROK_MANAGED_P0" });
    expect(parseDeploymentMode("self-hosted")).toEqual({ mode: "SELF_HOSTED" });
    expect(parseDeploymentMode(" local ")).toEqual({ mode: "LOCAL_DEVELOPER" });
    expect(parseDeploymentMode("")).toBeUndefined();
    expect(parseDeploymentMode("kubernetes")).toEqual({ invalid: "kubernetes" });
  });

  it("environment beats the manifest, the manifest beats the LOCAL_DEVELOPER default", () => {
    expect(resolveDeploymentMode({}, undefined)).toEqual({ mode: "LOCAL_DEVELOPER", source: "default" });
    expect(resolveDeploymentMode({}, "GROK_MANAGED_P0")).toEqual({ mode: "GROK_MANAGED_P0", source: "manifest" });
    expect(resolveDeploymentMode({ TOURCORE_DEPLOYMENT_MODE: "self_hosted" }, "GROK_MANAGED_P0")).toEqual({ mode: "SELF_HOSTED", source: "environment" });
    expect(resolveDeploymentMode({ TOURCORE_DEPLOYMENT_MODE: "nope" }, "GROK_MANAGED_P0")).toMatchObject({ mode: "GROK_MANAGED_P0", invalid: "nope" });
  });
});

describe("installation manifest", () => {
  it("creates one GROK_MANAGED_P0 manifest and keeps the same installation on every later run", () => {
    const h = harness();
    const first = h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0", now: new Date(h.now()) });
    expect(first.created).toBe(true);
    expect(first.manifest).toMatchObject({
      schemaVersion: 1,
      deploymentMode: "GROK_MANAGED_P0",
      messagingProvider: "UNSET",
      storageProvider: "LOCAL_DEMO",
      accessProvider: "DURIN_DEMO",
      operatorNotificationProvider: "NONE",
      publicEndpointProvider: "NONE",
    });
    expect(first.manifest.installationId).toMatch(/^inst_[A-Za-z0-9_-]{16}$/);
    const again = h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    expect(again).toEqual({ manifest: first.manifest, created: false });
    expect(new InstallationFiles(h.root).manifest()?.installationId).toBe(first.manifest.installationId);
  });

  it("contains no secrets: strict schema, and a credential value is refused even inside an allowed field", async () => {
    const h = harness();
    await completeInfrastructure(h);
    const text = readFileSync(h.inst.files.paths.manifest, "utf8") + readFileSync(h.inst.files.paths.state, "utf8");
    for (const s of [SB_KEY, SB_SECRET, ROUTINE_URL, ROUTINE_KEY]) expect(text).not.toContain(s);
    expect(ManifestSchema.safeParse({ ...h.inst.files.manifest(), sendblueApiKey: SB_KEY }).success).toBe(false);
    expect(() => assertNoSecrets({ publicBaseUrl: `https://x.example/${ROUTINE_KEY}` }, [ROUTINE_KEY])).toThrow("may not contain a credential");
    expect(() => h.inst.files.update({ publicBaseUrl: `https://x.example/${ROUTINE_KEY}` })).toThrow("may not contain a credential");
  });

  it("a changed public address is detected and recorded in the address history", () => {
    const h = harness();
    h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    expect(h.inst.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL")).toEqual({ changed: false, previous: undefined });
    expect(h.inst.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL")).toEqual({ changed: false, previous: TUNNEL });
    expect(h.inst.files.setPublicBaseUrl(TUNNEL_2, "CLOUDFLARE_QUICK_TUNNEL")).toEqual({ changed: true, previous: TUNNEL });
    const history = h.inst.files.state().publicBaseUrlHistory;
    expect(history.map((x) => [x.url, !!x.until])).toEqual([
      [TUNNEL, true],
      [TUNNEL_2, false],
    ]);
  });
});

describe("settings layer and SecretStore", () => {
  it("LOCAL_DEVELOPER: a .env-only setup reads exactly as before", () => {
    const env = { SENDBLUE_API_API_KEY: "env-key-123456", SENDBLUE_API_API_SECRET: "env-secret-123456", SENDBLUE_FROM_NUMBER: "+15550109999", PUBLIC_BASE_URL: "https://dev.example" };
    const sb = readSendblueEnv(effectiveEnv(env, {}));
    expect(sb).toMatchObject({ apiKey: "env-key-123456", apiSecret: "env-secret-123456", fromNumber: "+15550109999", publicBaseUrl: "https://dev.example" });
  });

  it("secure-setup values win over .env; the manifest address is used when none is set, and always in GROK_MANAGED_P0", () => {
    const secrets = new MemorySecretStore();
    secrets.set({ SENDBLUE_API_API_KEY: "secure-key-123456" });
    const manifest = () => ({ ...ManifestSchema.parse({ schemaVersion: 1, deploymentMode: "LOCAL_DEVELOPER", installationId: "inst_abcdefghijklmnop", publicEndpointProvider: "MANUAL", messagingProvider: "SENDBLUE", storageProvider: "LOCAL_DEMO", accessProvider: "DURIN_DEMO", operatorNotificationProvider: "NONE", installedAt: "x", updatedAt: "x" }), publicBaseUrl: TUNNEL });
    const env = { SENDBLUE_API_API_KEY: "env-key-123456", PUBLIC_BASE_URL: "https://dev.example" };
    expect(effectiveEnv(env, { secrets, manifest }).SENDBLUE_API_API_KEY).toBe("secure-key-123456");
    expect(effectiveEnv(env, { secrets, manifest }).PUBLIC_BASE_URL).toBe("https://dev.example");
    expect(effectiveEnv({}, { secrets, manifest }).PUBLIC_BASE_URL).toBe(TUNNEL);
    expect(effectiveEnv(env, { secrets, manifest, deploymentMode: () => "GROK_MANAGED_P0" }).PUBLIC_BASE_URL).toBe(TUNNEL);
    expect(settingSource("SENDBLUE_API_API_KEY", env, { secrets })).toBe("secure-setup");
    expect(settingSource("SENDBLUE_API_API_SECRET", { SENDBLUE_API_API_SECRET: "x" }, { secrets })).toBe("environment");
    expect(secretValues(env, { secrets })).toEqual(expect.arrayContaining(["secure-key-123456"]));
  });

  it("LocalSecretStore keeps values in the git-ignored data folder, owner-only where supported, and never in the manifest", () => {
    const h = harness();
    const store = new LocalSecretStore(h.inst.files.paths.secrets);
    store.set({ TOURCORE_GROK_ROUTINE_KEY: ROUTINE_KEY, SENDBLUE_API_API_KEY: "  " });
    expect(store.get("TOURCORE_GROK_ROUTINE_KEY")).toBe(ROUTINE_KEY);
    expect(store.get("SENDBLUE_API_API_KEY")).toBeUndefined();
    expect(store.updatedAt("TOURCORE_GROK_ROUTINE_KEY")).toBeTruthy();
    if (process.platform !== "win32") expect(statSync(h.inst.files.paths.secrets).mode & 0o077).toBe(0);
    expect(h.inst.files.paths.secrets.startsWith(h.root)).toBe(true);
    const gitignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
    expect(gitignore).toMatch(/^tourcore-data\/$/m);
    store.delete(["TOURCORE_GROK_ROUTINE_KEY"]);
    expect(store.get("TOURCORE_GROK_ROUTINE_KEY")).toBeUndefined();
    expect(() => store.set({ NOT_A_SETTING: "x" } as never)).toThrow("Unknown provider setting");
  });
});

describe("secure setup sessions", () => {
  it("are short-lived, stored only as hashes, and rejected once expired", () => {
    let t = 1_000_000;
    const store = new MemoryRuntimeStore();
    const sessions = new SetupSessions(store, () => t);
    const { token, expiresAt } = sessions.mint(30);
    expect(expiresAt).toBe(t + 30 * 60_000);
    expect(JSON.stringify(store.list("setup-sessions"))).not.toContain(token);
    expect(sessions.check(token)).toEqual({ ok: true, expiresAt });
    expect(sessions.check(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(sessions.check("x".repeat(32))).toEqual({ ok: false, reason: "unknown" });
    t += 30 * 60_000;
    expect(sessions.check(token)).toEqual({ ok: false, reason: "expired" });
    expect(sessions.check(token)).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("installation status", () => {
  it("blank install: runtime ready, public address needed first, property not configured", async () => {
    const h = harness();
    const s = await h.status();
    expect(s.components.map((c) => [c.component, c.state])).toEqual([
      ["RUNTIME", "READY"],
      ["PUBLIC_ENDPOINT", "ACTION_REQUIRED"],
      ["GROK_OPERATOR", "NOT_CONFIGURED"],
      ["VISITOR_MESSAGING", "NOT_CONFIGURED"],
      ["STORAGE", "NOT_CONFIGURED"],
      ["ACCESS", "READY"],
      ["PROPERTY", "NOT_CONFIGURED"],
      ["OPERATOR_ALERTS", "NOT_CONFIGURED"],
      ["READINESS", "NOT_CONFIGURED"],
      ["PRACTICE_TOUR", "NOT_CONFIGURED"],
      ["PUBLISH", "NOT_CONFIGURED"],
    ]);
    expect(s.nextStep).toMatchObject({ component: "PUBLIC_ENDPOINT", action: "ESTABLISH_PUBLIC_ENDPOINT", performedBy: "GROK", command: "npm run bootstrap:grok" });
    expect(s.infrastructureReady).toBe(false);
    expect(s.components.find((c) => c.component === "STORAGE")).toMatchObject({ requirement: "REQUIRED_BEFORE_PROPERTY", technical: { provider: "NOT_CONFIGURED" }, summary: "Offered once visitor texting is working." });
    expect(s.components.find((c) => c.component === "ACCESS")).toMatchObject({ technical: { provider: "DEMO" }, summary: "Demo. No real doors open." });
    expect(s.components.find((c) => c.component === "OPERATOR_ALERTS")).toMatchObject({ requirement: "RECOMMENDED", summary: "Offered once your first property is set up." });
    expect(s.lines).toContain("\u2713 Access system: Demo. No real doors open.");
  });

  it("decides the whole installation sequence deterministically, infrastructure before property", async () => {
    const h = harness();
    const next = async () => {
      const s = await h.status();
      return [s.nextStep.action, s.nextStep.performedBy, s.nextStep.tool ?? ""];
    };
    h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    expect(await next()).toEqual(["ESTABLISH_PUBLIC_ENDPOINT", "GROK", ""]);
    h.inst.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL");
    expect(await next()).toEqual(["CHECK_PUBLIC_ENDPOINT", "GROK", "check_public_endpoint"]);
    markChecked(h, "endpoint");
    expect(await next()).toEqual(["CONNECT_GROK", "OPERATOR", ""]);
    h.connectGrok();
    expect(await next()).toEqual(["CHOOSE_MESSAGING_PROVIDER", "OPERATOR_DECISION", "choose_messaging_provider"]);
    const choice = await h.ok("get_next_installation_step");
    expect(choice.operatorMessage).toBe("How would you like prospects to text Tour Core?");
    expect(JSON.stringify(choice)).not.toMatch(/Sendblue API|secure setup page|\/install/);
    await h.ok("choose_messaging_provider", { provider: "sendblue" });
    expect(await next()).toEqual(["CONNECT_VISITOR_MESSAGING", "OPERATOR_IN_SECURE_SETUP", "get_secure_setup_url"]);
    expect((await h.ok("get_next_installation_step")).operatorMessage).toBe(
      "Sendblue needs your API key, API secret, and messaging number. I'll ask for them securely; they won't be shown to me in chat.",
    );
    h.inst.secrets.set({ SENDBLUE_API_API_KEY: SB_KEY, SENDBLUE_API_API_SECRET: SB_SECRET, SENDBLUE_FROM_NUMBER: "+15550109999" });
    expect(await next()).toEqual(["TEST_VISITOR_MESSAGING", "GROK", "test_visitor_messaging"]);
    markChecked(h, "messaging");
    const drive = await h.status();
    expect(drive.infrastructureReady).toBe(false);
    expect(drive.nextStep).toMatchObject({
      component: "STORAGE",
      action: "CONNECT_GOOGLE_DRIVE",
      performedBy: "OPERATOR_DECISION",
      operatorMessage: "Visitor texting is working. Next I recommend connecting Google Drive so your property and tour records stay with you even if this Tour Core computer changes.",
    });
    await h.ok("use_local_demo_storage");
    // Only now does property setup come up; alerts wait for a property.
    const infra = await h.status();
    expect(infra.infrastructureReady).toBe(true);
    expect(infra.nextStep).toMatchObject({ component: "PROPERTY", action: "SET_UP_PROPERTY", performedBy: "OPERATOR_DECISION", phase: "PROPERTY", operatorMessage: "Everything needed to start is connected and tested. Would you like to add your first property?" });
    await h.setUpAlfredWay();
    expect(await next()).toEqual(["OFFER_OPERATOR_ALERTS", "OPERATOR_DECISION", "set_notification_preferences"]);
    await h.ok("set_notification_preferences", { preset: "recommended" });
    expect(await next()).toEqual(["CONNECT_OPERATOR_ALERTS", "OPERATOR_IN_SECURE_SETUP", "get_secure_setup_url"]);
    h.inst.secrets.set({ TOURCORE_GROK_ROUTINE_URL: ROUTINE_URL, TOURCORE_GROK_ROUTINE_KEY: ROUTINE_KEY });
    expect(await next()).toEqual(["TEST_OPERATOR_ALERTS", "GROK", "test_operator_alerts"]);
    markChecked(h, "alerts");
    expect(await next()).toEqual(["RUN_READINESS", "GROK", "run_readiness_check"]);
    await h.ok("run_readiness_check");
    expect(await next()).toEqual(["RUN_PRACTICE_TOUR", "GROK", "run_dry_tour"]);
    await h.ok("run_dry_tour");
    expect(await next()).toEqual(["PUBLISH", "OPERATOR_DECISION", "publish_demo_property"]);
    await h.approve("publish_demo_property", {});
    const done = await h.status();
    expect(done.nextStep.action).toBe("ADD_ANOTHER_PROPERTY");
    expect(done.components.every((c) => c.state === "READY")).toBe(true);
    expect(done.lines).toContain("\u2713 Visitor texting: Visitor texting is connected and working (+15550109999).");
  });

  it("a changed public URL marks the Grok connection, messaging and the address itself as needing action", async () => {
    const h = harness();
    await completeInfrastructure(h);
    expect((await h.status()).infrastructureReady).toBe(true);
    expect(h.inst.files.setPublicBaseUrl(TUNNEL_2, "CLOUDFLARE_QUICK_TUNNEL").changed).toBe(true);
    const s = await h.status();
    const byName = Object.fromEntries(s.components.map((c) => [c.component, c]));
    expect(byName.PUBLIC_ENDPOINT).toMatchObject({ state: "ACTION_REQUIRED", next: { action: "CHECK_PUBLIC_ENDPOINT" } });
    expect(byName.GROK_OPERATOR).toMatchObject({ state: "ACTION_REQUIRED", next: { action: "RECONNECT_GROK" } });
    expect(byName.VISITOR_MESSAGING).toMatchObject({ state: "ACTION_REQUIRED", next: { action: "RECONNECT_VISITOR_MESSAGING" } });
    expect(JSON.stringify(byName.GROK_OPERATOR)).toContain(`${TUNNEL_2}/mcp`);
    expect(s.infrastructureReady).toBe(false);
  });

  it("MCP installation tools never expose a credential, and none takes one as input", async () => {
    const h = harness();
    await completeInfrastructure(h);
    const fake = fakeSendblue({ hooks: [{ url: `${TUNNEL}/webhooks/sendblue` }], lines: [{ sendblue_number: "+15550109999", status: "ONLINE" }] });
    cleanups.push(setSendblueRuntime({ client: () => fake.client }));
    h.net.state.health = { ok: true, service: "tour-core" };
    const replies: string[] = [];
    for (const t of INSTALLATION_TOOLS) {
      const args = t.name === "get_installation_component" ? { component: "OPERATOR_ALERTS" } : t.name === "get_secure_setup_url" ? { step: "operator-alerts" } : {};
      replies.push(JSON.stringify((await h.mcp("tools/call", { name: t.name, arguments: args })).body));
    }
    const all = replies.join("\n");
    for (const secret of [SB_KEY, SB_SECRET, ROUTINE_URL, ROUTINE_KEY, h.inst.secrets.get("SENDBLUE_WEBHOOK_SECRET")!]) expect(all).not.toContain(secret);
    expect(h.net.routineCalls()).toHaveLength(1);
    // The webhook secret Tour Core created for Sendblue went to the secret store and Sendblue, not to Grok.
    expect(h.inst.secrets.get("SENDBLUE_WEBHOOK_SECRET")).toBeTruthy();
    expect(JSON.stringify(fake.created)).toContain(h.inst.secrets.get("SENDBLUE_WEBHOOK_SECRET"));

    const names = mcpToolList().map((t) => t.name);
    for (const forbidden of ["set_api_key", "set_sender_key", "set_sendblue_secret", "run_command", "exec", "shell"]) expect(names).not.toContain(forbidden);
    for (const t of mcpToolList()) {
      const props = Object.keys(((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}) as object);
      for (const p of props) expect(p, `${t.name}.${p}`).not.toMatch(/key|secret|token|password|credential|webhook/i);
    }
  });

  it("get_secure_setup_url returns a short-lived local link; the session it carries works only until it expires", async () => {
    const h = harness();
    const out = await h.ok("get_secure_setup_url", { step: "visitor-messaging" });
    expect(out.url).toMatch(/^http:\/\/localhost:4321\/install#s=[A-Za-z0-9_-]{32}&step=visitor-messaging$/);
    expect(out.expiresInMinutes).toBe(30);
    const token = /#s=([^&]+)/.exec(out.url)![1]!;
    expect(h.inst.sessions.check(token).ok).toBe(true);
    h.setClock(h.now() + 31 * 60_000);
    expect(h.inst.sessions.check(token)).toEqual({ ok: false, reason: "expired" });
    expect(await h.fails("get_secure_setup_url", { step: "visitor-messaging", apiKey: "x" })).toContain("unexpected apiKey");
  });

  it("check_public_endpoint verifies it's this installation answering, and records the result", async () => {
    const h = harness();
    h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    h.inst.files.setPublicBaseUrl(TUNNEL, "CLOUDFLARE_QUICK_TUNNEL");
    h.net.state.health = { ok: true, service: "tour-core", installation: "someone-else" };
    expect(await h.ok("check_public_endpoint")).toMatchObject({ ok: false, summary: "Tour Core's secure public connection isn't working yet.", technical: { detail: "Tour Core's public address reaches a different Tour Core installation." } });
    const { publicHealth } = await import("../src/install/checks");
    h.net.state.health = publicHealth(h.inst);
    expect(await h.ok("check_public_endpoint")).toMatchObject({ ok: true, summary: "Tour Core has a secure public connection.", technical: { publicAddress: TUNNEL } });
    expect((await h.component("PUBLIC_ENDPOINT")).state).toBe("READY");
    expect(h.net.calls.at(-1)!.url).toBe(`${TUNNEL}/healthz`);
  });

  it("test_storage and test_access report the demo providers in operator words", async () => {
    const h = harness();
    expect(await h.ok("test_storage")).toMatchObject({ ok: true, provider: "NOT_CONFIGURED" });
    expect(await h.ok("test_access")).toMatchObject({ ok: true, accessSystem: "Demo", summary: "Access system: Demo. It's answering, and no real doors open." });
    expect(await h.ok("check_runtime_health")).toMatchObject({ summary: "Tour Core is running and healthy.", ok: true, technical: { running: true, deploymentMode: "GROK_MANAGED_P0" } });
  });
});
