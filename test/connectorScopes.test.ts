import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Installation } from "../src/install/installation";
import { resetLocalSmsOutbox } from "../src/messaging/local/outbox";
import { LANDLORD_CORE_TOOLS, OPS_TOOL_NAMES, QA_TOOL_NAMES, toolsForConnector, type ConnectorScope } from "../src/mcp/scopes";
import { mcpInstructions } from "../src/playbooks/instructions";
import { OPERATOR_TOOLS } from "../src/operator/tools";
import { OPERATOR_SCOPE } from "../src/mcp/oauth/provider";
import { hashSecret, OAuthGrantStore } from "../src/mcp/oauth/store";
import { PropertyWorkspace } from "../src/setup";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { createSetupServer } from "../src/web/server";
import { grokHarness, type GrokHarness } from "./grokHarness";

const LANDLORD = "landlord-token-pre-split-123456";
const OPS = "ops-token-secret-value-123456";
const QA = "qa-token-secret-value-123456";
const HOST = "https://demo.up.railway.app";
const OWNER = "grok-owner-client";
const PRE_SPLIT = "tca_pre_split_access_token_landlord_ok";

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
const initRpc = { jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2025-11-25" } };

/** Live checks that left the landlord list. The second name is the landlord tool for the same check. */
const QA_LIVE_CHECK_MAP = [
  ["list_exceptions", "get_inbox"],
  ["inspect_exception", "get_inbox"],
  ["resolve_exception", "resolve_issue"],
  ["begin_restore_upload", "restore_records"],
  ["preview_portable_restore", "restore_records"],
  ["import_portable_backup", "restore_records"],
  ["schedule_one_off_tour", "schedule_tour"],
  ["resume_tours", "pause_tours"],
  ["revoke_tour_access", "cancel_tour"],
] as const;

/** These stay on /mcp/qa. run_checks stops before them, and get_state is not the status tool. */
const QA_ONLY_TOOLS = ["test_operator_alerts", "run_dry_tour", "get_installation_status"] as const;
const callRpc = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });

function namesFrom(json: unknown): string[] {
  return toolsFrom(json).map((tool) => tool.name);
}

function toolsFrom(json: unknown): Array<{ name: string; description?: string }> {
  return (json as { result: { tools: Array<{ name: string; description?: string }> } }).result.tools;
}

describe("connector scopes", () => {
  it("lists 22 landlord tools on a self-host static token, and refuses QA and ops tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-scope-"));
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

    const qaCall = await post(port, "/mcp", callRpc("inject_local_sms", { from: "+15555550100", text: "Hi" }), LANDLORD);
    const opsCall = await post(port, "/mcp", callRpc("discover_storage"), LANDLORD);
    expect(qaCall.json).toMatchObject({ error: { code: -32602, message: "That's no longer something I can do from this chat. Disconnect and reconnect Tour Core so I'm working from the current list, then ask me again." } });
    expect(opsCall.json).toMatchObject({ error: { code: -32602, message: "That's no longer something I can do from this chat. Disconnect and reconnect Tour Core so I'm working from the current list, then ask me again." } });
    expect(namesFrom(listed.json)).not.toContain("inject_local_sms");
    expect(namesFrom(listed.json)).not.toContain("discover_storage");

    expect((await post(port, "/mcp/qa", listRpc, LANDLORD)).status).toBe(401);
    expect((await post(port, "/mcp/ops", listRpc, LANDLORD)).status).toBe(401);
    expect((await post(port, "/mcp/qa", callRpc("inject_local_sms", { from: "+15555550100", text: "Hi" }), LANDLORD)).status).toBe(401);
    expect((await post(port, "/mcp/ops", callRpc("discover_storage"), LANDLORD)).status).toBe(401);

    const qa = await post(port, "/mcp/qa", listRpc, QA);
    const ops = await post(port, "/mcp/ops", listRpc, OPS);
    expect(namesFrom(qa.json)).toEqual([...QA_TOOL_NAMES]);
    expect(namesFrom(ops.json)).toEqual([...OPS_TOOL_NAMES]);
  });

  it("fails closed when the ops or QA secret is missing, and the landlord connector still answers", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-scope-off-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const server = createSetupServer({
      workspace: new PropertyWorkspace(root),
      mcpAuth: "static",
      operatorToken: () => LANDLORD,
      opsToken: () => undefined,
      qaToken: () => undefined,
      log: () => {},
    });
    cleanups.push(() => server.close());
    const port = await listen(server);
    expect((await post(port, "/mcp/ops", listRpc, OPS)).json).toMatchObject({ error: { message: "The Tour Core ops connector is off." } });
    expect((await post(port, "/mcp/qa", listRpc, QA)).json).toMatchObject({ error: { message: "The Tour Core QA connector is off." } });
    expect((await post(port, "/mcp/ops", listRpc, OPS)).status).toBe(503);
    expect((await post(port, "/mcp/qa", listRpc, QA)).status).toBe(503);
    expect((await post(port, "/mcp", listRpc, LANDLORD)).status).toBe(200);
    expect(namesFrom((await post(port, "/mcp", listRpc, LANDLORD)).json)).toEqual([...LANDLORD_CORE_TOOLS]);
  });

  it("shows reset_hosted_demo only to the hosted owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-scope-owner-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const env: NodeJS.ProcessEnv = { TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0", RAILWAY_PUBLIC_DOMAIN: "demo.up.railway.app" };
    const runtime = new FileRuntimeStore(join(root, "runtime"));
    const inst = new Installation({ root, runtime, env: () => env });
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
    const server = createSetupServer({ workspace: new PropertyWorkspace(root), installation: inst, mcpAuth: "oauth", log: () => {} });
    cleanups.push(() => server.close());
    const port = await listen(server);
    const listed = await post(port, "/mcp", listRpc, PRE_SPLIT);
    expect(listed.status).toBe(200);
    expect(namesFrom(listed.json)).toEqual([...LANDLORD_CORE_TOOLS, "reset_hosted_demo"]);
  });

  it("keeps a pre-split static token on the landlord connector", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-scope-static-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const server = createSetupServer({
      workspace: new PropertyWorkspace(root),
      mcpAuth: "static",
      operatorToken: () => LANDLORD,
      log: () => {},
    });
    cleanups.push(() => server.close());
    const port = await listen(server);
    expect(namesFrom((await post(port, "/mcp", listRpc, LANDLORD)).json)).toEqual([...LANDLORD_CORE_TOOLS]);
    const state = await post(port, "/mcp", callRpc("get_state"), LANDLORD);
    expect(state.status).toBe(200);
    expect(JSON.stringify(state.json)).not.toMatch(/can't run that tool/);
  });

  it("each former live-check tool is callable on /mcp/qa and mapped in the docs", async () => {
    const session = await legacySession();
    expect(session.names).toEqual([...LANDLORD_CORE_TOOLS]);
    const qa = await post(session.port, "/mcp/qa", listRpc, QA);
    expect(namesFrom(qa.json)).toEqual([...QA_TOOL_NAMES]);
    for (const name of [...QA_LIVE_CHECK_MAP.map(([tool]) => tool), ...QA_ONLY_TOOLS]) {
      expect(namesFrom(qa.json)).toContain(name);
      const called = await post(session.port, "/mcp/qa", callRpc(name), QA);
      expect(JSON.stringify(called.json)).not.toContain("The QA connector can't run that tool.");
    }
    const refused = await post(session.port, "/mcp", callRpc("run_dry_tour"), LANDLORD);
    expect(refused.json).toMatchObject({ error: { code: -32602, message: "That's no longer something I can do from this chat. Disconnect and reconnect Tour Core so I'm working from the current list, then ask me again." } });

    const toolsDoc = readFileSync(new URL("../grok-template/integrations/tour-core-tools.md", import.meta.url), "utf8");
    const qaTable = toolsDoc.slice(toolsDoc.indexOf("## QA connector"));
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const connectorSection = readme.slice(readme.indexOf("### Ops and QA connectors"), readme.indexOf("## Getting started"));
    for (const [qaTool, landlordTool] of QA_LIVE_CHECK_MAP) {
      const row = qaTable.split("\n").find((line) => line.startsWith(`| \`${qaTool}\` |`));
      expect(row, qaTool).toContain(`\`${landlordTool}\``);
      expect(connectorSection).toContain(`\`${qaTool}\``);
      expect(connectorSection).toContain(`\`${landlordTool}\``);
    }
    for (const name of QA_ONLY_TOOLS) {
      const row = qaTable.split("\n").find((line) => line.startsWith(`| \`${name}\` |`));
      expect(row, name).toContain("Stays on QA");
      expect(row, name).not.toContain("`run_checks`");
      expect(row, name).not.toContain("`get_state`");
      expect(connectorSection).toMatch(new RegExp(`\`${name}\`[^\\n]*stays on QA`));
    }
  });

  it("lists test_operator_alerts, run_dry_tour, and get_installation_status on /mcp/qa, and /mcp lists none of them", async () => {
    const session = await legacySession();
    const qa = namesFrom((await post(session.port, "/mcp/qa", listRpc, QA)).json);
    const mcp = namesFrom((await post(session.port, "/mcp", listRpc, LANDLORD)).json);
    expect(mcp).toEqual([...LANDLORD_CORE_TOOLS]);
    for (const name of QA_ONLY_TOOLS) {
      expect(qa).toContain(name);
      expect(mcp).not.toContain(name);
    }
  });

  it("names only tools that connector lists in its startup instructions", async () => {
    const session = await legacySession();
    const catalog = [...OPERATOR_TOOLS.map((tool) => tool.name), "reset_hosted_demo"];
    const named = (text: string) => catalog.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
    const connectors: Array<[string, ConnectorScope, string]> = [
      ["/mcp", "landlord", LANDLORD],
      ["/mcp/ops", "ops", OPS],
      ["/mcp/qa", "qa", QA],
    ];
    for (const [path, scope, token] of connectors) {
      const res = await post(session.port, path, initRpc, token);
      const instructions = (res.json as { result: { instructions: string } }).result.instructions;
      expect(instructions).toBe(mcpInstructions(scope));
      const allowed = new Set(toolsForConnector(scope, undefined).map((tool) => tool.name));
      const hits = named(instructions);
      expect(hits.length).toBeGreaterThan(0);
      for (const name of hits) expect(allowed, `${scope} instructions name ${name}`).toContain(name);
    }
    expect(mcpInstructions("landlord").startsWith("Call get_state first")).toBe(true);
    expect(mcpInstructions("qa")).not.toMatch(/\bget_state\b/);
    expect(mcpInstructions("ops")).not.toMatch(/\bget_state\b/);
    expect(mcpInstructions("qa")).toMatch(/\bget_installation_status\b/);
  });

  it("shared-line inject omits the property: a picker for two places, and a skip for one", async () => {
    const many = await sharedInject(["12 Scratch Lane, Teaneck, NJ 07666", "88 Pine St, Teaneck, NJ 07666"], { nameFirst: "Scratch House" });
    expect(many.result.sharedLine).toBe(true);
    expect(many.result.summary).toBe("Delivered the visitor text on the shared line.");
    const asked = (many.result.bubbles as Array<{ body: string }>).map((b) => b.body).join("\n");
    expect(asked).toContain("Which place are you touring?");
    expect(asked).toContain("Reply 1 or 2.");
    expect(asked).toContain("Scratch House");
    expect(asked).toContain("88 Pine St");

    resetLocalSmsOutbox();
    const one = await sharedInject(["12 Scratch Lane, Teaneck, NJ 07666"], { nameFirst: "Scratch House" });
    expect(one.result.sharedLine).toBe(true);
    const skipped = (one.result.bubbles as Array<{ body: string }>).map((b) => b.body).join("\n");
    expect(skipped).not.toContain("Which place are you touring?");
    expect(skipped.length).toBeGreaterThan(0);
  }, 120_000);
});

async function legacySession(): Promise<{ port: number; names: string[]; tools: Array<{ name: string; description?: string }> }> {
  const root = mkdtempSync(join(tmpdir(), "tourcore-scope-legacy-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const runtime = new FileRuntimeStore(join(root, "runtime"));
  const installation = new Installation({ root, runtime, env: () => ({}) });
  const server = createSetupServer({
    workspace: new PropertyWorkspace(root),
    installation,
    mcpAuth: "static",
    operatorToken: () => LANDLORD,
    opsToken: () => OPS,
    qaToken: () => QA,
    log: () => {},
  });
  cleanups.push(() => server.close());
  const port = await listen(server);
  const tools = toolsFrom((await post(port, "/mcp", listRpc, LANDLORD)).json);
  return { port, names: tools.map((tool) => tool.name), tools };
}

async function sharedInject(addresses: string[], options: { nameFirst?: string }) {
  const h = grokHarness();
  cleanups.push(h.cleanup);
  for (const [index, address] of addresses.entries()) {
    h.setClock(h.now() + 60_000);
    const created = await h.ok("create_property_setup", {
      address,
      ...(index === 0 && options.nameFirst ? { name: options.nameFirst } : {}),
      propertyType: "SINGLE_FAMILY",
    });
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
  }
  const server = createSetupServer({
    workspace: h.workspace,
    mcpAuth: "static",
    operatorToken: () => LANDLORD,
    qaToken: () => QA,
    log: () => {},
  });
  cleanups.push(() => server.close());
  const port = await listen(server);
  const sent = await post(port, "/mcp/qa", callRpc("inject_local_sms", { from: "+15555550111", text: "Tour" }), QA);
  expect(sent.status).toBe(200);
  const body = sent.json as { result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: Array<{ text: string }> }; error?: { message: string } };
  expect(body.error).toBeUndefined();
  expect(body.result?.isError).not.toBe(true);
  return { result: body.result!.structuredContent!, h: h as GrokHarness };
}
