import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publicHealth } from "../src/install/checks";
import { Installation } from "../src/install/installation";
import { DRIVE_NOT_SET_UP_LINE } from "../src/install/stateView";
import { resetLocalSmsOutbox } from "../src/messaging/local/outbox";
import { OPERATOR_SCOPE } from "../src/mcp/oauth/provider";
import { hashSecret, OAuthGrantStore } from "../src/mcp/oauth/store";
import { LANDLORD_CORE_TOOLS, QA_TOOL_NAMES } from "../src/mcp/scopes";
import { PropertyWorkspace } from "../src/setup";
import { FakeGoogleDrive } from "../src/storage/googleDrive";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { createSetupServer } from "../src/web/server";
import { grokHarness } from "./grokHarness";

/**
 * Gate cases for the landlord, ops, and QA connector split. Each `it` name starts
 * with its case number. Which tools the docs may name is checked in
 * landlordFacingTools.test.ts, and the tool tables in grokTemplate.test.ts.
 */

const LANDLORD = "landlord-token-gate-1234567890";
const OPS = "ops-token-gate-1234567890";
const QA = "qa-token-gate-1234567890";
const WRONG = "wrong-token-gate-1234567890";
const HOST = "https://demo.up.railway.app";
const OWNER = "grok-owner-client";
const PRE_SPLIT = "tca_gate_owner_access_token_ok";
const FRESH = "https://fresh-landlord.example";
const DRIVE_APPROVAL_LINE =
  "Google Drive is connected to me. For Tour Core to save its records there directly, whoever runs your Tour Core computer has to finish one more approval. Until then, your records stay on this computer.";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  resetLocalSmsOutbox();
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

async function post(port: number, path: string, body: unknown, token?: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, text };
}

const listRpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const callRpc = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });

function toolsFrom(json: unknown): Array<{ name: string; inputSchema?: unknown }> {
  return (json as { result: { tools: Array<{ name: string; inputSchema?: unknown }> } }).result.tools;
}

function namesFrom(json: unknown): string[] {
  return toolsFrom(json).map((tool) => tool.name);
}

function resultOf(json: unknown): Record<string, unknown> {
  const body = json as { error?: { message: string }; result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: Array<{ text: string }> } };
  if (body.error) throw new Error(body.error.message);
  if (body.result?.isError) throw new Error(body.result.content?.[0]?.text ?? "tool error");
  return body.result?.structuredContent ?? {};
}

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("landlord, ops, and QA connector split", () => {
  it("gate 1: flag off, landlord /mcp lists the 22 tools and refuses an ops or QA tool by name", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-gate1-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const server = createSetupServer({
      workspace: new PropertyWorkspace(root),
      mcpAuth: "static",
      operatorToken: () => LANDLORD,
      opsToken: () => OPS,
      qaToken: () => QA,
      log: () => {},
    });
    cleanups.push(() => server.close());
    const port = await listen(server);
    const listed = await post(port, "/mcp", listRpc, LANDLORD);
    expect(listed.status).toBe(200);
    expect(namesFrom(listed.json)).toEqual([...LANDLORD_CORE_TOOLS]);
    expect(namesFrom(listed.json)).not.toContain("inject_local_sms");
    expect(namesFrom(listed.json)).not.toContain("discover_storage");
    expect(namesFrom(listed.json)).not.toContain("reset_hosted_demo");

    const qaCall = await post(port, "/mcp", callRpc("inject_local_sms", { from: "+15555550100", text: "Hi" }), LANDLORD);
    const opsCall = await post(port, "/mcp", callRpc("discover_storage"), LANDLORD);
    expect(qaCall.json).toMatchObject({ error: { code: -32602, message: "That's no longer something I can do from this chat. Disconnect and reconnect Tour Core so I'm working from the current list, then ask me again." } });
    expect(opsCall.json).toMatchObject({ error: { code: -32602, message: "That's no longer something I can do from this chat. Disconnect and reconnect Tour Core so I'm working from the current list, then ask me again." } });

    const ownerRoot = mkdtempSync(join(tmpdir(), "tourcore-gate1-owner-"));
    cleanups.push(() => rmSync(ownerRoot, { recursive: true, force: true }));
    const env: NodeJS.ProcessEnv = { TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0", RAILWAY_PUBLIC_DOMAIN: "demo.up.railway.app" };
    const runtime = new FileRuntimeStore(join(ownerRoot, "runtime"));
    const inst = new Installation({ root: ownerRoot, runtime, env: () => env });
    inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    inst.files.setPublicBaseUrl(HOST, "RAILWAY");
    inst.files.writeState({ ...inst.files.state(), hostedTenant: { clientId: OWNER, boundAt: "2026-09-01T00:00:00.000Z" } });
    const now = Date.now();
    new OAuthGrantStore(runtime).addGrant({
      clientId: OWNER,
      clientName: "Grok",
      issuer: HOST,
      resource: `${HOST}/mcp`,
      scopes: [OPERATOR_SCOPE],
      createdAt: now,
      expiresAt: now + 86_400_000,
      accessHash: hashSecret(PRE_SPLIT),
      accessExpiresAt: now + 3_600_000,
    });
    const ownerServer = createSetupServer({ workspace: new PropertyWorkspace(ownerRoot), installation: inst, mcpAuth: "oauth", log: () => {} });
    cleanups.push(() => ownerServer.close());
    const ownerPort = await listen(ownerServer);
    const ownerListed = await post(ownerPort, "/mcp", listRpc, PRE_SPLIT);
    expect(namesFrom(ownerListed.json)).toEqual([...LANDLORD_CORE_TOOLS, "reset_hosted_demo"]);
    const stranger = mkdtempSync(join(tmpdir(), "tourcore-gate1-stranger-"));
    cleanups.push(() => rmSync(stranger, { recursive: true, force: true }));
    const strangerEnv: NodeJS.ProcessEnv = { TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0", RAILWAY_PUBLIC_DOMAIN: "demo.up.railway.app" };
    const strangerRuntime = new FileRuntimeStore(join(stranger, "runtime"));
    const strangerInst = new Installation({ root: stranger, runtime: strangerRuntime, env: () => strangerEnv });
    strangerInst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    strangerInst.files.setPublicBaseUrl(HOST, "RAILWAY");
    const strangerServer = createSetupServer({ workspace: new PropertyWorkspace(stranger), installation: strangerInst, mcpAuth: "static", operatorToken: () => LANDLORD, log: () => {} });
    cleanups.push(() => strangerServer.close());
    const strangerPort = await listen(strangerServer);
    expect(namesFrom((await post(strangerPort, "/mcp", listRpc, LANDLORD)).json)).toEqual([...LANDLORD_CORE_TOOLS]);
    expect(namesFrom((await post(strangerPort, "/mcp", listRpc, LANDLORD)).json)).not.toContain("reset_hosted_demo");
  });

  it("gate 2: ops and QA connectors refuse a missing, wrong, landlord, or other-connector token, and an unset token says the connector is off", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-gate2-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const open = (opsToken?: string, qaToken?: string) => {
      const server = createSetupServer({
        workspace: new PropertyWorkspace(root),
        mcpAuth: "static",
        operatorToken: () => LANDLORD,
        opsToken: () => opsToken,
        qaToken: () => qaToken,
        log: () => {},
      });
      cleanups.push(() => server.close());
      return listen(server);
    };
    const port = await open(OPS, QA);
    for (const [path, label] of [["/mcp/ops", "ops"], ["/mcp/qa", "QA"]] as const) {
      const other = path === "/mcp/ops" ? QA : OPS;
      for (const token of [undefined, WRONG, LANDLORD, other]) {
        const refused = await post(port, path, listRpc, token);
        expect(refused.status, `${path} ${token ?? "no token"}`).toBe(401);
        expect(refused.json).toMatchObject({ error: { message: `Missing or wrong Tour Core ${label} connector token.` } });
      }
    }
    const off = await open(undefined, undefined);
    expect((await post(off, "/mcp/ops", listRpc, OPS)).status).toBe(503);
    expect((await post(off, "/mcp/ops", listRpc, OPS)).json).toMatchObject({ error: { message: "The Tour Core ops connector is off." } });
    expect((await post(off, "/mcp/qa", listRpc, QA)).status).toBe(503);
    expect((await post(off, "/mcp/qa", listRpc, QA)).json).toMatchObject({ error: { message: "The Tour Core QA connector is off." } });
  });

  it("gate 4: QA connector test text, outbox, and shared-line inject with no property", async () => {
    const h = grokHarness();
    cleanups.push(h.cleanup);
    const created = await h.ok("create_property_setup", { address: "12 Scratch Lane, Teaneck, NJ 07666", name: "Scratch House", propertyType: "SINGLE_FAMILY" });
    const id = created.setup.propertyId as string;
    await h.ok("add_unit", { property: id });
    await h.ok("set_unit_details", { property: id, units: [{ unit: "Main Home", bedrooms: "3", bathrooms: "2", monthlyRent: "$3,400", availability: "now" }] });
    await h.ok("set_tour_hours", { property: id, days: "weekdays", start: "9am", end: "5pm" });
    await h.ok("set_verification_policy", { property: id, level: "basic-form" });
    await h.ok("update_property_details", { property: id, skipVisitorHelp: true });
    await h.ok("set_services", { property: id, messaging: "local" });
    await h.ok("run_readiness_check", { property: id });
    h.workspace.recordDryTour(id, { passed: true, ranAt: new Date(h.now()).toISOString(), checks: [], audit: [] });
    await h.approve("publish_demo_property", { property: id });

    const server = createSetupServer({
      workspace: h.workspace,
      mcpAuth: "static",
      operatorToken: () => LANDLORD,
      qaToken: () => QA,
      log: () => {},
    });
    cleanups.push(() => server.close());
    const port = await listen(server);
    expect(namesFrom((await post(port, "/mcp/qa", listRpc, QA)).json)).toEqual([...QA_TOOL_NAMES]);

    const sent = resultOf(await (await post(port, "/mcp/qa", callRpc("inject_local_sms", { from: "+15555550111", text: "Tour" }), QA)).json);
    expect(sent.sharedLine).toBe(true);
    expect(sent.summary).toBe("Delivered the visitor text on the shared line.");
    const asked = (sent.bubbles as Array<{ body: string }>).map((bubble) => bubble.body).join("\n");
    expect(asked).not.toContain("Which place are you touring?");

    const outbox = resultOf(await (await post(port, "/mcp/qa", callRpc("read_local_outbox", { from: "+15555550111", property: id }), QA)).json);
    const bubbles = (outbox.bubbles as Array<{ body: string }> | undefined) ?? (outbox.messages as Array<{ body: string }> | undefined) ?? [];
    const text = JSON.stringify(outbox);
    expect(text).toContain("Tour");
    expect(bubbles.length + text.length).toBeGreaterThan(0);
  }, 120_000);

  it("gate 5: flag off, an older Drive install keeps backing up to Drive", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-gate5-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    cpSync(new URL("./fixtures/pre-split-drive-install/", import.meta.url), join(root, "install"), { recursive: true });
    const drive = new FakeGoogleDrive();
    const env: NodeJS.ProcessEnv = {};
    const runtime = new FileRuntimeStore(join(root, "runtime"));
    const inst = new Installation({ root, runtime, env: () => env, driveClient: drive, now: () => Date.parse("2026-10-08T12:00:00.000Z") });
    expect(inst.files.manifest()?.storageProvider).toBe("GOOGLE_DRIVE");
    expect(inst.records.provider()).toBe("GOOGLE_DRIVE_READY");
    expect(inst.files.state().portableBackup?.destination?.provider).toBe("google_drive");

    const server = createSetupServer({
      workspace: new PropertyWorkspace(root),
      installation: inst,
      mcpAuth: "static",
      operatorToken: () => LANDLORD,
      log: () => {},
    });
    cleanups.push(() => server.close());
    const port = await listen(server);
    const state = resultOf((await post(port, "/mcp", callRpc("get_state"), LANDLORD)).json);
    expect(JSON.stringify(state.storage)).toContain("folder you own");
    expect(JSON.stringify(state)).not.toContain("Records stay on this computer");

    await inst.records.commitLocal();
    expect(inst.records.provider()).toBe("GOOGLE_DRIVE_READY");
    expect(inst.files.manifest()?.storageProvider).toBe("GOOGLE_DRIVE");
    expect(inst.files.state().storage?.mode).toBe("GOOGLE_DRIVE");
    expect(inst.files.state().portableBackup?.destination?.folderName).toBe("Tour Core");
    expect([...drive.files.values()].length).toBeGreaterThan(0);
    const backup = resultOf((await post(port, "/mcp", callRpc("backup_records", { action: "status" }), LANDLORD)).json);
    expect(JSON.stringify(backup)).toContain("Tour Core");
    expect(inst.files.manifest()?.storageProvider).toBe("GOOGLE_DRIVE");
    expect(inst.records.provider()).not.toBe("LOCAL_DEMO");
  });

  it("gate 6: flag off, a fresh landlord reaches publish on the 22 tools, the Drive line shows, and records stay local", async () => {
    // Which tools those docs may name is checked in landlordFacingTools.test.ts.
    const skill = read(".grok/skills/install-tour-core/SKILL.md");
    expect(skill).toContain(DRIVE_APPROVAL_LINE);
    expect(skill).toContain(DRIVE_NOT_SET_UP_LINE);

    const root = mkdtempSync(join(tmpdir(), "tourcore-gate6-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const env: NodeJS.ProcessEnv = {
      TOURCORE_DEPLOYMENT_MODE: "GROK_MANAGED_P0",
      TOURCORE_MCP_AUTH_MODE: "static",
      TOURCORE_OPERATOR_TOKEN: LANDLORD,
      PUBLIC_BASE_URL: FRESH,
    };
    const runtime = new FileRuntimeStore(join(root, "runtime"));
    let inst!: Installation;
    const fetchImpl = async (url: string) => {
      if (url.includes("/healthz")) return { status: 200, json: async () => publicHealth(inst) };
      return { status: 200, json: async () => ({}) };
    };
    inst = new Installation({ root, runtime, env: () => env, fetch: fetchImpl as never, now: () => Date.parse("2026-10-08T15:00:00.000Z") });
    inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    inst.files.setPublicBaseUrl(FRESH, "CLOUDFLARE_QUICK_TUNNEL");
    inst.files.recordCheck("publicEndpointCheck", { ok: true, at: "2026-10-08T15:00:00.000Z", message: "Tour Core is reachable at its public address.", url: FRESH });

    const server = createSetupServer({
      workspace: new PropertyWorkspace(root),
      installation: inst,
      mcpAuth: "static",
      operatorToken: () => LANDLORD,
      log: () => {},
    });
    cleanups.push(() => server.close());
    const port = await listen(server);
    const used: string[] = [];
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      expect(LANDLORD_CORE_TOOLS, name).toContain(name);
      used.push(name);
      const response = await post(port, "/mcp", callRpc(name, args), LANDLORD);
      return resultOf(response.json);
    };

    await call("get_state");
    const texting = await call("set_up_texting", { provider: "local" });
    expect(texting.status).toBe("done");
    const pictured = await call("get_state");
    expect(JSON.stringify(pictured)).toContain(DRIVE_NOT_SET_UP_LINE);
    const declined = await call("backup_records", { action: "decline" });
    expect(declined.message).toBe(DRIVE_NOT_SET_UP_LINE);
    expect(inst.records.provider()).toBe("LOCAL_DEMO");
    expect(inst.files.manifest()?.storageProvider).not.toBe("GOOGLE_DRIVE");

    const property = await call("save_property", {
      address: "18 Maple Street, Teaneck, NJ 07666",
      propertyType: "MULTIFAMILY_HOME",
      confirmAddress: true,
      skipVisitorHelp: true,
    });
    const propertyId = String(property.propertyId);
    await call("save_settings", { property: propertyId, verification: "basic-form", skipAlerts: true });
    await call("save_units", {
      property: propertyId,
      units: [{ name: "Unit A" }, { name: "Unit B" }],
      details: "Unit A is 2 bed 1 bath for $2,200, available now. Unit B is 1 bed 1 bath for $1,950, available October 15.",
    });
    await call("save_doors_and_routes", {
      property: propertyId,
      doors: [{ name: "Front Door", kind: "entrance" }],
      routes: [
        { unit: "Unit A", doors: ["Front Door", "Unit A Door"] },
        { unit: "Unit B", doors: ["Front Door", "Unit B Door"] },
      ],
    });
    await call("save_hours", { property: propertyId, days: "weekdays", start: "9am", end: "5pm" });
    const checks = await call("run_checks", { property: propertyId });
    expect(checks.status).toBe("done");
    const asked = await call("publish", { property: propertyId });
    const code = (asked.confirmation as { code?: string } | undefined)?.code;
    expect(code).toBeTruthy();
    const published = await call("publish", { property: propertyId, confirmationCode: code });
    expect(published.published).toBe(true);
    expect(inst.records.provider()).toBe("LOCAL_DEMO");
    expect(inst.files.manifest()?.storageProvider).not.toBe("GOOGLE_DRIVE");
    expect(used.every((name) => (LANDLORD_CORE_TOOLS as readonly string[]).includes(name))).toBe(true);
  }, 120_000);
});
