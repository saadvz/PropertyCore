import { existsSync, readdirSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOSTED_ADMIN_TOOLS } from "../src/install/hostedAdminTools";
import { DISK_NOT_SAVED, TEXTING_ERROR, TEXTING_KEYS_NEEDED, TEXTING_NEEDS_LINE, TEXTING_NOT_CHOSEN, TEXTING_TEST_MODE, TEXTING_TESTING, TEXTING_WORKING, textingSummary } from "../src/install/stateView";
import { ANNOTATION_DECISIONS_FOR_SAAD, annotationsFor } from "../src/mcp/annotations";
import { handleMcpMessage, mcpToolList } from "../src/mcp/mcpBridge";
import { MCP_INSTRUCTIONS } from "../src/playbooks/instructions";
import { renderPlaybook, spokenAsk } from "../src/playbooks/compose";
import { GROK_ALERTS_SAY, GROK_WAKE_NO_PLACE, GROK_WAKE_WITH_PLACE } from "../src/playbooks/grok";
import { GROK_CLIENT_NAMES, preferPlaybookClient, reportedClientFromInitialize, selectPlaybook } from "../src/playbooks/select";
import { OPERATOR_SCOPE } from "../src/mcp/oauth";
import { hashSecret, OAuthGrantStore } from "../src/mcp/oauth/store";
import { SETUP_HELP_ENDING, SETUP_HELP_PAGE, SETUP_HELP_URL } from "../src/playbooks/setupHelp";
import { SHARED_STEPS } from "../src/playbooks/shared";
import { OPERATOR_TOOLS } from "../src/operator/tools";
import { PropertyWorkspace } from "../src/setup";
import { createSetupServer, PLAYBOOK_CLIENT_CAP } from "../src/web/server";
import { filesUnder } from "./files";
import { installHarness } from "./installHarness";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const DESTRUCTIVE = new Set(["cancel_tour", "restore_records", "remove_property", "revoke_tour_access", "import_portable_backup"]);
const SIDE_EFFECT_READS = new Set(["get_next_installation_step", "get_installation_status", "get_installation_component", "check_runtime_health", "verify_storage_migration"]);
const KEPT = new Set(["reset_hosted_demo", "disconnect_google_drive_storage", "takeover_storage_writer", "migrate_storage_to_google_drive"]);

function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[path.slice(dir.length)] = readFileSync(path).toString("base64");
    }
  };
  walk(dir);
  return out;
}

describe("get_state does not write", () => {
  it("leaves stored files byte-identical, including when a texting login would otherwise be saved", async () => {
    const h = installHarness({
      env: {
        SENDBLUE_API_API_KEY: "sb-key-phase1",
        SENDBLUE_API_API_SECRET: "sb-secret-phase1",
        SENDBLUE_FROM_NUMBER: "+15550109999",
      },
    });
    cleanups.push(h.cleanup);
    expect(h.inst.files.state().messagingProviderChoice).toBeUndefined();
    const before = snapshotTree(h.root);
    const state = await h.ok("get_state");
    expect(state.scope).toBe("install");
    expect(snapshotTree(h.root)).toEqual(before);
    expect(h.inst.files.state().messagingProviderChoice).toBeUndefined();
    await h.setUpAlfredWay();
    const afterSetup = snapshotTree(h.root);
    await h.ok("get_state");
    expect(snapshotTree(h.root)).toEqual(afterSetup);
    await h.ok("get_installation_status");
    expect(h.inst.files.state().messagingProviderChoice).toBe("sendblue");
  });
});

const grokClientCaps = { elicitation: { form: {} }, sampling: {}, roots: { listChanged: true } };

function realisticInitialize(name: string, capabilities: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities, clientInfo: { name, version: "1.0.0" } },
  };
}

describe("playbook selection", () => {
  it("picks a playbook from the client name and real client capabilities, and never a gate", () => {
    for (const name of GROK_CLIENT_NAMES) {
      expect(selectPlaybook({ name, capabilities: {} })).toEqual({ id: "grok", mode: "full", version: "grok@2026-10-08" });
      expect(selectPlaybook({ name: name.toUpperCase(), capabilities: { prompts: {}, resources: {} } })).toMatchObject({ id: "grok", mode: "full" });
    }
    expect(selectPlaybook({ name: "Grok", capabilities: grokClientCaps })).toEqual({ id: "grok", mode: "full", version: "grok@2026-10-08" });
    expect(selectPlaybook({ name: "grok", capabilities: { tools: {} } })).toEqual({ id: "baseline", mode: "tools", version: "baseline@2026-10-08.tools" });
    expect(selectPlaybook({ name: "Grok", capabilities: { tools: {} } })).toMatchObject({ id: "baseline", mode: "tools" });
    expect(selectPlaybook({ name: "ChatGPT", capabilities: grokClientCaps })).toMatchObject({ id: "chatgpt", mode: "tools", version: "chatgpt@2026-10-08.tools" });
    expect(selectPlaybook({ name: "OpenAI", capabilities: { prompts: {}, resources: {} } })).toMatchObject({ id: "chatgpt", mode: "tools" });
    expect(selectPlaybook({ name: "claude-ai", capabilities: grokClientCaps })).toMatchObject({ id: "claude", mode: "full", version: "claude@2026-10-08" });
    expect(selectPlaybook({ name: "Claude", capabilities: { prompts: {}, resources: {} } })).toMatchObject({ id: "claude", mode: "tools", version: "claude@2026-10-08.tools" });
    expect(selectPlaybook({ name: "Anthropic", capabilities: { sampling: {} } })).toMatchObject({ id: "claude", mode: "full" });
    expect(selectPlaybook({ name: "cursor-vscode" })).toMatchObject({ id: "grok", mode: "full", version: "grok@2026-10-08" });
    expect(selectPlaybook({ name: "Cursor" })).toMatchObject({ id: "grok", mode: "full" });
    expect(selectPlaybook(preferPlaybookClient({}, { name: "Cursor" }))).toMatchObject({ id: "grok", mode: "full" });
    expect(selectPlaybook(preferPlaybookClient({ name: "example-client" }, { name: "Cursor" }, { name: "example-client" }))).toMatchObject({ id: "grok", mode: "full" });
    const claudeFull = { name: "claude-ai", capabilities: { roots: { listChanged: true }, elicitation: { form: {} } } };
    expect(selectPlaybook(preferPlaybookClient(claudeFull, { name: "Claude" }))).toMatchObject({ id: "claude", mode: "full" });
    expect(selectPlaybook(preferPlaybookClient(claudeFull, { name: "Cursor" }))).toMatchObject({ id: "claude", mode: "full" });
    expect(selectPlaybook(preferPlaybookClient(undefined, { name: "Cursor" }))).toMatchObject({ id: "grok", mode: "full" });
    expect(preferPlaybookClient(undefined, undefined, {})).toBeUndefined();
    expect(selectPlaybook({ name: "mystery-client", capabilities: grokClientCaps })).toMatchObject({ id: "baseline", mode: "tools", version: "baseline@2026-10-08.tools" });
    expect(selectPlaybook(undefined)).toMatchObject({ id: "baseline", mode: "tools" });
    expect(selectPlaybook({})).toMatchObject({ id: "baseline", mode: "tools" });
  });

  it("same install, different clients: identical milestones and gates, different playbook text", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    h.ctx.client = { name: "Grok", capabilities: grokClientCaps };
    const grok = await h.ok("get_state");
    h.ctx.client = { name: "someone-else" };
    const baseline = await h.ok("get_state");
    expect(grok.milestones).toEqual(baseline.milestones);
    expect(grok.nextStep.action).toBe(baseline.nextStep.action);
    expect(grok.nextStep.component).toBe(baseline.nextStep.component);
    expect(grok.health).toEqual(baseline.health);
    expect(grok.storage).toEqual(baseline.storage);
    expect(grok.currentMilestone).toBe(baseline.currentMilestone);
    expect(grok.playbook).toMatchObject({ id: "grok", version: "grok@2026-10-08", mode: "full" });
    expect(baseline.playbook).toMatchObject({ id: "baseline", version: "baseline@2026-10-08.tools", mode: "tools" });
    expect(grok.playbook.text).not.toBe(baseline.playbook.text);
    expect(JSON.stringify({ setup: grok.setup, units: grok.units, properties: grok.properties })).not.toMatch(/Main Home/);
  });
});

describe("MCP instructions", () => {
  it("stays under 2048 bytes, and the first 512 bytes end on a sentence", async () => {
    const bytes = Buffer.from(MCP_INSTRUCTIONS, "utf8");
    expect(bytes.length).toBeLessThan(2048);
    const head = bytes.subarray(0, 512).toString("utf8");
    expect(head.trimEnd().endsWith(".")).toBe(true);
    expect(head.startsWith("Call get_state first and follow its next step.")).toBe(true);
    const h = installHarness();
    cleanups.push(h.cleanup);
    const init = await handleMcpMessage(h.ctx, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "grok", version: "1" } } });
    expect(init.body).toMatchObject({ result: { instructions: MCP_INSTRUCTIONS } });
  });
});

describe("MCP annotations", () => {
  it("marks reads, the five destructive tools, and explicit non-destructive writes", () => {
    expect(OPERATOR_TOOLS).toHaveLength(103);
    expect(OPERATOR_TOOLS.some((tool) => tool.name === "get_state")).toBe(true);
    const listed = mcpToolList();
    expect(listed).toHaveLength(103);
    for (const tool of [...OPERATOR_TOOLS, ...HOSTED_ADMIN_TOOLS]) {
      const hints = annotationsFor(tool);
      expect(hints.openWorldHint).toBe(false);
      expect(hints.idempotentHint).toBe(hints.readOnlyHint);
      const shown = listed.find((item) => item.name === tool.name);
      if (shown) expect(shown.annotations).toMatchObject(hints);
      if (KEPT.has(tool.name)) {
        expect(hints.readOnlyHint).toBe(false);
        expect(hints.destructiveHint).toBe(tool.kind === "consequential");
      } else if (DESTRUCTIVE.has(tool.name)) {
        expect(hints).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      } else if (tool.kind === "read" && !SIDE_EFFECT_READS.has(tool.name)) {
        expect(hints).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      } else {
        expect(hints).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      }
    }
    for (const name of ["schedule_one_off_tour", "reschedule_tour", "approve_tour_time_request", "activate_google_drive_storage", "schedule_tour", "hold_tour", "backup_records"]) {
      expect(annotationsFor({ name, kind: "consequential" }).destructiveHint).toBe(false);
    }
    expect(annotationsFor({ name: "get_next_installation_step", kind: "read" }).readOnlyHint).toBe(false);
    expect(annotationsFor({ name: "get_state", kind: "read" }).readOnlyHint).toBe(true);
    expect(ANNOTATION_DECISIONS_FOR_SAAD.map((item) => item.name)).toEqual([
      "reset_hosted_demo",
      "disconnect_google_drive_storage",
      "takeover_storage_writer",
      "migrate_storage_to_google_drive",
      "activate_google_drive_storage",
    ]);
  });
});

describe("spoken asks and failure lines", () => {
  it("says you in the spoken asks, and every failure line ends with the setup help link", () => {
    expect(spokenAsk(undefined, "units-home")).toBe("People will tour the whole home. What should I call it? The street is fine if you don't have a nickname.");
    expect(spokenAsk(undefined, "hours")).toContain("You can keep that.");
    expect(spokenAsk(undefined, "hours-help")).toContain("You can skip this.");
    expect(spokenAsk(undefined, "property-confirm")).toBe("Did I get that right: {address}?");
    expect(spokenAsk(undefined, "backups")).toContain("Skipping is fine.");
    expect(spokenAsk(undefined, "units-details")).toBe("");
    const details = renderPlaybook(undefined, "units-details").text;
    expect(details).not.toContain("Ask only this:");
    expect(details).toContain("For you, not out loud: ask the one detail that's still missing, in plain words.");
    expect(details).toContain("one plain link");
    expect(details).toContain("Never put that link in a text to a visitor.");
    for (const step of Object.values(SHARED_STEPS)) {
      expect(step.ifItFails.endsWith(SETUP_HELP_ENDING)).toBe(true);
    }
    expect(SHARED_STEPS.alerts.ifItFails).toContain("private link");
    expect(SHARED_STEPS["texting-keys"].ifItFails).toContain("If the private link won't open");
    expect(SHARED_STEPS["texting-keys"].ifItFails).not.toContain("private way");
    expect(renderPlaybook(undefined, "connect").text).not.toContain("Someone who runs this Tour Core");
  });
});

describe("realistic initialize messages", () => {
  const messages = {
    grok: realisticInitialize("Grok", grokClientCaps),
    claude: realisticInitialize("claude-ai", { roots: { listChanged: true }, sampling: {} }),
    chatgpt: realisticInitialize("ChatGPT", { roots: { listChanged: true } }),
    unknown: realisticInitialize("example-client", { roots: { listChanged: true }, sampling: {}, elicitation: {} }),
  };

  it("realistic initialize: Grok gets the full Grok playbook and the wake", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    const init = await handleMcpMessage(h.ctx, messages.grok);
    expect(init.body).toMatchObject({ result: { instructions: MCP_INSTRUCTIONS, capabilities: { tools: { listChanged: true } } } });
    expect(reportedClientFromInitialize(messages.grok)).toMatchObject({ name: "Grok", capabilities: grokClientCaps });
    const state = await h.ok("get_state");
    expect(state.playbook).toMatchObject({ id: "grok", mode: "full", version: "grok@2026-10-08" });
    expect(state.playbook.text).toContain(GROK_WAKE_WITH_PLACE);
    expect(state.playbook.text).toContain(GROK_WAKE_NO_PLACE);
    expect(renderPlaybook({ name: "Grok", capabilities: grokClientCaps }, "alerts").text).toContain(GROK_ALERTS_SAY);
    expect(state.playbook.text).toContain("You can keep notes");
    expect(state.playbook.text).not.toContain("You do not have a masked card");
  });

  it("realistic initialize: Claude gets the Claude playbook", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    await handleMcpMessage(h.ctx, messages.claude);
    const state = await h.ok("get_state");
    expect(state.playbook).toMatchObject({ id: "claude", mode: "full", version: "claude@2026-10-08" });
    expect(state.playbook.text).toContain("You can keep this playbook in a project");
    expect(state.playbook.text).not.toContain(GROK_WAKE_WITH_PLACE);
  });

  it("realistic initialize: ChatGPT gets the ChatGPT tools playbook", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    await handleMcpMessage(h.ctx, messages.chatgpt);
    const state = await h.ok("get_state");
    expect(state.playbook).toMatchObject({ id: "chatgpt", mode: "tools", version: "chatgpt@2026-10-08.tools" });
    expect(state.playbook.text).toContain("You only have tools. There is no saved prompt beyond this text.");
    expect(state.playbook.text).not.toContain(GROK_WAKE_WITH_PLACE);
  });

  it("realistic initialize: an unknown client gets the baseline playbook", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    await handleMcpMessage(h.ctx, messages.unknown);
    const state = await h.ok("get_state");
    expect(state.playbook).toMatchObject({ id: "baseline", mode: "tools", version: "baseline@2026-10-08.tools" });
    expect(state.playbook.text).toContain("You only have tools. Nothing here is filled in for you.");
  });

  it("realistic initialize: gates are identical for Grok, Claude, ChatGPT, and unknown", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    const pictures = [];
    const lists = [];
    for (const message of Object.values(messages)) {
      await handleMcpMessage(h.ctx, message);
      const state = await h.ok("get_state");
      pictures.push({ milestones: state.milestones, action: state.nextStep.action, component: state.nextStep.component });
      const list = await handleMcpMessage(h.ctx, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      const tools = (list.body as { result: { tools: Array<{ name: string; annotations: unknown }> } }).result.tools;
      lists.push(tools.map((tool) => ({ name: tool.name, annotations: tool.annotations })));
    }
    expect(new Set(pictures.map((item) => JSON.stringify(item))).size).toBe(1);
    expect(new Set(lists.map((item) => JSON.stringify(item))).size).toBe(1);
    expect(lists[0]).toHaveLength(103);
  });
});

describe("playbook client is per session", () => {
  const token = "test-operator-token-123456";
  const listen = async (root: string, playbookClientCap?: number) => {
    const server = createSetupServer({
    toolSurface: "all",
      workspace: new PropertyWorkspace(root),
      operatorToken: () => token,
      log: () => {},
      ...(playbookClientCap ? { playbookClientCap } : {}),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => server.close());
    return { server, port: (server.address() as { port: number }).port };
  };
  const post = async (port: number, id: number, method: string, params: unknown, session?: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(session ? { "Mcp-Session-Id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const body = (await res.json()) as { error?: { code: number }; result: { structuredContent?: { playbook: { id: string; text: string } } } };
    return { status: res.status, session: res.headers.get("mcp-session-id"), body };
  };
  const postSignedIn = async (port: number, access: string, id: number, method: string, params: unknown, session?: string) => {
    const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise<{ status: number; session: string | null; body: { error?: { code: number }; result?: { structuredContent?: { playbook: { id: string; mode: string } } } } }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(payload.length),
            host: "tour.example",
            authorization: `Bearer ${access}`,
            ...(session ? { "mcp-session-id": session } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: res.statusCode ?? 0,
              session: res.headers["mcp-session-id"] ? String(res.headers["mcp-session-id"]) : null,
              body: raw ? (JSON.parse(raw) as { error?: { code: number }; result?: { structuredContent?: { playbook: { id: string; mode: string } } } }) : {},
            });
          });
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  };

  it("two sessions echo the server-issued id, and each gets their own playbook", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    const { port } = await listen(h.root);
    const grokInit = await post(port, 1, "initialize", realisticInitialize("Grok", grokClientCaps).params);
    const otherInit = await post(port, 1, "initialize", realisticInitialize("example-client", grokClientCaps).params);
    expect(grokInit.status).toBe(200);
    expect(otherInit.status).toBe(200);
    expect(grokInit.session).toMatch(/^[0-9a-f-]{36}$/i);
    expect(otherInit.session).toMatch(/^[0-9a-f-]{36}$/i);
    expect(otherInit.session).not.toBe(grokInit.session);
    const grok = await post(port, 2, "tools/call", { name: "get_state", arguments: {} }, grokInit.session!);
    const other = await post(port, 3, "tools/call", { name: "get_state", arguments: {} }, otherInit.session!);
    expect(grok.status).toBe(200);
    expect(grok.body.result.structuredContent?.playbook.id).toBe("grok");
    expect(grok.body.result.structuredContent?.playbook.text).toContain(GROK_WAKE_WITH_PLACE);
    expect(other.body.result.structuredContent?.playbook.id).toBe("baseline");
    expect(other.body.result.structuredContent?.playbook.text).not.toContain(GROK_WAKE_WITH_PLACE);
  });

  it("a stale session id after a restart returns the grok playbook for a signed-in Grok", async () => {
    const h = installHarness({ env: { PUBLIC_BASE_URL: "https://tour.example" } });
    cleanups.push(h.cleanup);
    const access = "tca_signed-in-grok-access-token";
    const base = h.inst.publicBaseUrl();
    expect(base).toBe("https://tour.example");
    const origin = new URL(base!).origin;
    const now = Date.now();
    new OAuthGrantStore(h.runtime, () => now).addGrant({
      clientId: "grok-client",
      clientName: "Grok",
      issuer: origin,
      resource: `${origin}/mcp`,
      scopes: [OPERATOR_SCOPE],
      createdAt: now,
      expiresAt: now + 30 * 86_400_000,
      accessHash: hashSecret(access),
      accessExpiresAt: now + 3_600_000,
    });
    const listenOauth = async () => {
      const server = createSetupServer({
    toolSurface: "all", workspace: new PropertyWorkspace(h.root), installation: h.inst, mcpAuth: "oauth", authNow: () => now, log: () => {} });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      cleanups.push(() => server.close());
      return { server, port: (server.address() as { port: number }).port };
    };
    const first = await listenOauth();
    const init = await postSignedIn(first.port, access, 1, "initialize", realisticInitialize("Grok", grokClientCaps).params);
    expect(init.status).toBe(200);
    expect(init.session).toBeTruthy();
    const before = await postSignedIn(first.port, access, 2, "tools/call", { name: "get_state", arguments: {} }, init.session!);
    expect(before.body.result?.structuredContent?.playbook.id).toBe("grok");
    await new Promise<void>((resolve) => first.server.close(() => resolve()));
    const second = await listenOauth();
    const call = await postSignedIn(second.port, access, 3, "tools/call", { name: "get_state", arguments: {} }, init.session!);
    expect(call.status).toBe(200);
    expect(call.body.error).toBeUndefined();
    expect(call.body.result?.structuredContent?.playbook.id).toBe("grok");
    expect(call.session).toBe(init.session);
  });

  const claudeCaps = { roots: { listChanged: true }, elicitation: { form: {} } };

  it("claude-ai with roots and elicitation stays claude/full when the grant is stored as Claude", async () => {
    const h = installHarness({ env: { PUBLIC_BASE_URL: "https://tour.example" } });
    cleanups.push(h.cleanup);
    const access = "tca_signed-in-claude-access-token";
    const origin = new URL(h.inst.publicBaseUrl()!).origin;
    const now = Date.now();
    new OAuthGrantStore(h.runtime, () => now).addGrant({
      clientId: "claude-client",
      clientName: "Claude",
      issuer: origin,
      resource: `${origin}/mcp`,
      scopes: [OPERATOR_SCOPE],
      createdAt: now,
      expiresAt: now + 30 * 86_400_000,
      accessHash: hashSecret(access),
      accessExpiresAt: now + 3_600_000,
    });
    const server = createSetupServer({
    toolSurface: "all", workspace: new PropertyWorkspace(h.root), installation: h.inst, mcpAuth: "oauth", authNow: () => now, log: () => {} });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => server.close());
    const port = (server.address() as { port: number }).port;
    const init = await postSignedIn(port, access, 1, "initialize", realisticInitialize("claude-ai", claudeCaps).params);
    expect(init.status).toBe(200);
    expect(init.session).toBeTruthy();
    const afterInit = await postSignedIn(port, access, 2, "tools/call", { name: "get_state", arguments: {} }, init.session!);
    const next = await postSignedIn(port, access, 3, "tools/call", { name: "get_state", arguments: {} }, init.session!);
    expect(afterInit.body.result?.structuredContent?.playbook).toMatchObject({ id: "claude", mode: "full" });
    expect(next.body.result?.structuredContent?.playbook).toMatchObject({ id: "claude", mode: "full" });
  });

  it("initializing as claude-ai overrides a grant stored as Cursor, on this session and a new one", async () => {
    const h = installHarness({ env: { PUBLIC_BASE_URL: "https://tour.example" } });
    cleanups.push(h.cleanup);
    const access = "tca_signed-in-cursor-then-claude";
    const origin = new URL(h.inst.publicBaseUrl()!).origin;
    const now = Date.now();
    new OAuthGrantStore(h.runtime, () => now).addGrant({
      clientId: "cursor-client",
      clientName: "Cursor",
      issuer: origin,
      resource: `${origin}/mcp`,
      scopes: [OPERATOR_SCOPE],
      createdAt: now,
      expiresAt: now + 30 * 86_400_000,
      accessHash: hashSecret(access),
      accessExpiresAt: now + 3_600_000,
    });
    const server = createSetupServer({
    toolSurface: "all", workspace: new PropertyWorkspace(h.root), installation: h.inst, mcpAuth: "oauth", authNow: () => now, log: () => {} });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => server.close());
    const port = (server.address() as { port: number }).port;
    const same = "11111111-1111-4111-8111-111111111111";
    const fresh = "22222222-2222-4222-8222-222222222222";
    const initSame = await postSignedIn(port, access, 1, "initialize", realisticInitialize("claude-ai", claudeCaps).params, same);
    expect(initSame.status).toBe(200);
    expect(initSame.session).toBe(same);
    const onSame = await postSignedIn(port, access, 2, "tools/call", { name: "get_state", arguments: {} }, same);
    expect(onSame.body.result?.structuredContent?.playbook).toMatchObject({ id: "claude", mode: "full" });
    const initFresh = await postSignedIn(port, access, 3, "initialize", realisticInitialize("claude-ai", claudeCaps).params, fresh);
    expect(initFresh.session).toBe(fresh);
    const onFresh = await postSignedIn(port, access, 4, "tools/call", { name: "get_state", arguments: {} }, fresh);
    expect(onFresh.body.result?.structuredContent?.playbook).toMatchObject({ id: "claude", mode: "full" });
    const stillSame = await postSignedIn(port, access, 5, "tools/call", { name: "get_state", arguments: {} }, same);
    expect(stillSame.body.result?.structuredContent?.playbook).toMatchObject({ id: "claude", mode: "full" });
    const madeUp = "33333333-3333-4333-8333-333333333333";
    const onMadeUp = await postSignedIn(port, access, 6, "tools/call", { name: "get_state", arguments: {} }, madeUp);
    const onNone = await postSignedIn(port, access, 7, "tools/call", { name: "get_state", arguments: {} });
    expect(onMadeUp.body.result?.structuredContent?.playbook).toMatchObject({ id: "claude", mode: "full" });
    expect(onNone.body.result?.structuredContent?.playbook).toMatchObject({ id: "claude", mode: "full" });
  });

  it("a static token follows the latest initialize, so a later unnamed client is baseline", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    const { port } = await listen(h.root);
    const grokInit = await post(port, 1, "initialize", realisticInitialize("grok", { prompts: {}, resources: {} }).params);
    expect(grokInit.status).toBe(200);
    const named = await post(port, 2, "tools/call", { name: "get_state", arguments: {} });
    expect(named.body.result.structuredContent?.playbook.id).toBe("grok");
    const unnamed = await post(port, 3, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    expect(unnamed.status).toBe(200);
    const after = await post(port, 4, "tools/call", { name: "get_state", arguments: {} });
    expect(after.body.result.structuredContent?.playbook).toMatchObject({ id: "baseline", mode: "tools" });
    const stillNamed = await post(port, 5, "tools/call", { name: "get_state", arguments: {} }, grokInit.session!);
    expect(stillNamed.body.result.structuredContent?.playbook.id).toBe("grok");
  });

  it("a static-token caller with a stale session id gets the baseline playbook", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    const first = await listen(h.root);
    const init = await post(first.port, 1, "initialize", realisticInitialize("Grok", grokClientCaps).params);
    expect(init.status).toBe(200);
    expect(init.session).toBeTruthy();
    const before = await post(first.port, 2, "tools/call", { name: "get_state", arguments: {} }, init.session!);
    expect(before.body.result.structuredContent?.playbook.id).toBe("grok");
    await new Promise<void>((resolve) => first.server.close(() => resolve()));
    const second = await listen(h.root);
    const call = await post(second.port, 3, "tools/call", { name: "get_state", arguments: {} }, init.session!);
    expect(call.status).toBe(200);
    expect(call.body.error).toBeUndefined();
    expect(call.body.result.structuredContent?.playbook.id).toBe("baseline");
    expect(call.session).toBe(init.session);
  });

  it("a session that keeps being read keeps its playbook while an idle one is evicted first", async () => {
    expect(PLAYBOOK_CLIENT_CAP).toBe(1000);
    const h = installHarness();
    cleanups.push(h.cleanup);
    const { port } = await listen(h.root, 2);
    const idle = await post(port, 1, "initialize", realisticInitialize("Grok", grokClientCaps).params);
    const live = await post(port, 2, "initialize", realisticInitialize("ChatGPT", grokClientCaps).params);
    const idleFirst = await post(port, 3, "tools/call", { name: "get_state", arguments: {} }, idle.session!);
    expect(idleFirst.body.result.structuredContent?.playbook.id).toBe("grok");
    const liveRead = await post(port, 4, "tools/call", { name: "get_state", arguments: {} }, live.session!);
    const liveAgain = await post(port, 5, "tools/call", { name: "get_state", arguments: {} }, live.session!);
    expect(liveRead.body.result.structuredContent?.playbook.id).toBe("chatgpt");
    expect(liveAgain.body.result.structuredContent?.playbook.id).toBe("chatgpt");
    const newest = await post(port, 6, "initialize", realisticInitialize("Claude", grokClientCaps).params);
    const liveAfter = await post(port, 7, "tools/call", { name: "get_state", arguments: {} }, live.session!);
    const newestRead = await post(port, 8, "tools/call", { name: "get_state", arguments: {} }, newest.session!);
    const idleAfter = await post(port, 9, "tools/call", { name: "get_state", arguments: {} }, idle.session!);
    expect(liveAfter.status).toBe(200);
    expect(liveAfter.body.error).toBeUndefined();
    expect(liveAfter.body.result.structuredContent?.playbook.id).toBe("chatgpt");
    expect(idleAfter.status).toBe(200);
    expect(idleAfter.body.error).toBeUndefined();
    expect(idleAfter.body.result.structuredContent?.playbook.id).not.toBe("grok");
    expect(newestRead.body.result.structuredContent?.playbook.id).toBe("claude");
  });

  it("one new session adds exactly one playbook entry", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    const { port } = await listen(h.root, 2);
    const grok = await post(port, 1, "initialize", realisticInitialize("Grok", grokClientCaps).params);
    const chatgpt = await post(port, 2, "initialize", realisticInitialize("ChatGPT", grokClientCaps).params);
    const grokRead = await post(port, 3, "tools/call", { name: "get_state", arguments: {} }, grok.session!);
    const chatgptRead = await post(port, 4, "tools/call", { name: "get_state", arguments: {} }, chatgpt.session!);
    expect(grokRead.status).toBe(200);
    expect(grokRead.body.error).toBeUndefined();
    expect(grokRead.body.result.structuredContent?.playbook.id).toBe("grok");
    expect(chatgptRead.body.result.structuredContent?.playbook.id).toBe("chatgpt");
  });
});

describe("texting summaries", () => {
  it("gives each texting state its own plain line, with no provider name", () => {
    expect(textingSummary(undefined)).toBe(TEXTING_NOT_CHOSEN);
    expect(textingSummary({ state: "NOT_CONFIGURED", next: { action: "CHOOSE_MESSAGING_PROVIDER" } })).toBe(TEXTING_NOT_CHOSEN);
    expect(textingSummary({ state: "ACTION_REQUIRED", next: { action: "CONNECT_VISITOR_MESSAGING" } })).toBe(TEXTING_KEYS_NEEDED);
    expect(textingSummary({ state: "ACTION_REQUIRED", next: { action: "FIX_VISITOR_MESSAGING" } })).toBe(TEXTING_KEYS_NEEDED);
    expect(textingSummary({ state: "ACTION_REQUIRED", next: { action: "CHOOSE_MESSAGING_LINE" } })).toBe(TEXTING_NEEDS_LINE);
    expect(textingSummary({ state: "ACTION_REQUIRED", next: { action: "TEST_VISITOR_MESSAGING" } })).toBe(TEXTING_TESTING);
    expect(textingSummary({ state: "ACTION_REQUIRED", next: { action: "RECONNECT_VISITOR_MESSAGING" } })).toBe(TEXTING_TESTING);
    expect(textingSummary({ state: "READY", next: undefined })).toBe(TEXTING_WORKING);
    expect(textingSummary({ state: "READY", provider: "local" })).toBe(TEXTING_TEST_MODE);
    expect(textingSummary({ state: "READY", provider: "sendblue" })).toBe(TEXTING_WORKING);
    expect(textingSummary({ state: "ERROR" })).toBe(TEXTING_ERROR);
    const joined = [TEXTING_NOT_CHOSEN, TEXTING_KEYS_NEEDED, TEXTING_NEEDS_LINE, TEXTING_TESTING, TEXTING_WORKING, TEXTING_ERROR].join("\n");
    expect(joined).not.toMatch(/sendblue|twilio|photon/i);
  });

  it("a fresh install reads as texting not chosen", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    const state = await h.ok("get_state");
    expect(state.texting.summary).toBe(TEXTING_NOT_CHOSEN);
  });

  it("a local test install says texts won't reach real phones", async () => {
    const h = installHarness();
    cleanups.push(h.cleanup);
    h.inst.files.ensure({ deploymentMode: "GROK_MANAGED_P0" });
    h.inst.files.setPublicBaseUrl("https://example.test", "MANUAL");
    await h.ok("choose_messaging_provider", { provider: "local" });
    await h.ok("test_visitor_messaging");
    const state = await h.ok("get_state");
    expect(state.texting.summary).toBe(TEXTING_TEST_MODE);
    expect(state.texting.summary).not.toBe("Texting is working.");
  });
});

/** Key phrases of the no-permanent-storage help: who fixes it, and not to update until then. */
const HOSTING_STORAGE = ["needs to attach permanent storage", "hold off on updating Tour Core"];

describe("setup help", () => {
  it("matches the public page, has no contact line, and stays out of visitor copy", () => {
    const page = readFileSync(join("docs", "setup-help.md"), "utf8");
    expect(page).toBe(SETUP_HELP_PAGE);
    expect(page.startsWith("# Setup help\n\n")).toBe(true);
    const lines = page.split("\n");
    const headings = lines.filter((line) => line.startsWith("## "));
    expect(headings).toContain("## Your records aren't saved anywhere permanent yet");
    expect(headings).toContain("## Texting isn't working right now");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]?.startsWith("## ")) continue;
      expect(lines[i + 1]).toBe("");
      expect(lines[i + 2]?.length).toBeGreaterThan(0);
      expect(lines[i + 3]).toBe("");
      expect(lines[i + 4]?.length).toBeGreaterThan(0);
    }
    expect(page).toContain(DISK_NOT_SAVED);
    for (const phrase of HOSTING_STORAGE) expect(page).toContain(phrase);
    expect(page).toMatch(/Nothing went live, so it's safe to say yes again/);
    expect(page).toMatch(/can add a texting service/);
    expect(SHARED_STEPS["texting-test"].ifItFails).toContain("texting isn't working right now");
    expect(SETUP_HELP_ENDING.endsWith(SETUP_HELP_URL)).toBe(true);
    expect(SETUP_HELP_ENDING.endsWith(".")).toBe(false);
    for (const step of Object.values(SHARED_STEPS)) {
      expect(step.ifItFails.endsWith(SETUP_HELP_URL)).toBe(true);
      expect(step.ifItFails.includes(`${SETUP_HELP_URL}.`)).toBe(false);
    }
    for (const phrase of contactPhrases()) expect(page.toLowerCase()).not.toContain(phrase.toLowerCase());
    expect(page).not.toMatch(/sendblue|twilio|photon|durin|main home/i);
    expect(SETUP_HELP_URL).toBe("https://github.com/saadvz/PropertyCore/blob/master/docs/setup-help.md");
    const files = ["src/visitor", "src/core"].flatMap((root) => filesUnder(root)).filter((file) => file.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toContain(SETUP_HELP_URL);
    expect(renderPlaybook(undefined, "connect").text).toContain(SETUP_HELP_URL);
    const install = readFileSync(".grok/skills/install-tour-core/SKILL.md", "utf8");
    const work = readFileSync(".grok/skills/work-exception/SKILL.md", "utf8");
    expect(install).toContain(GROK_ALERTS_SAY);
    expect(work).toContain(GROK_WAKE_WITH_PLACE);
    expect(work).toContain(GROK_WAKE_NO_PLACE);
    for (const path of ["docs/tour-core/README.md", "GROK_BOOTSTRAP.md", "grok-template/bot-profile.md", "grok-template/context/installation.md"]) {
      const doc = readFileSync(path, "utf8");
      expect(doc).toContain("visitorWillReceive");
      expect(doc).toMatch(/destructive/i);
      expect(doc).toMatch(/setup-help|setup help/i);
    }
    expect(readFileSync("docs/tour-core/README.md", "utf8")).toContain("revoke_tour_access");
    expect(readFileSync("GROK_BOOTSTRAP.md", "utf8")).toContain("cancel_tour");
    const prefs = OPERATOR_TOOLS.find((tool) => tool.name === "set_notification_preferences");
    expect(prefs?.description).toContain(SHARED_STEPS.alerts.ask);
    expect(prefs?.description).not.toContain(GROK_ALERTS_SAY);
    const inspect = OPERATOR_TOOLS.find((tool) => tool.name === "inspect_tour_time_request");
    expect(inspect?.description).toContain("place");
    expect(inspect?.description).toContain("never Main Home");
    expect(readFileSync("grok-template/integrations/tour-core-tools.md", "utf8")).toContain("`place`");
  });

  it("no landlord-facing string points at a contact", () => {
    const files = [
      "docs/setup-help.md",
      "README.md",
      "docs/tour-core/README.md",
      "GROK_BOOTSTRAP.md",
      ".grok/skills/install-tour-core/SKILL.md",
      "grok-template/bot-profile.md",
      "grok-template/context/installation.md",
      "grok-template/integrations/tour-core-tools.md",
      "src/install/stateView.ts",
      "src/playbooks/setupHelp.ts",
      "src/playbooks/shared.ts",
    ];
    const phrases = contactPhrases();
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const phrase of phrases) expect(text.toLowerCase(), file).not.toContain(phrase.toLowerCase());
    }
    for (const step of Object.values(SHARED_STEPS)) {
      const text = `${step.ask}\n${step.done}\n${step.ifItFails}`;
      for (const phrase of phrases) expect(text.toLowerCase()).not.toContain(phrase.toLowerCase());
    }
    for (const file of [
      "docs/setup-help.md",
      ".grok/skills/install-tour-core/SKILL.md",
      "grok-template/bot-profile.md",
      "grok-template/context/installation.md",
      "grok-template/integrations/tour-core-tools.md",
    ]) {
      for (const phrase of HOSTING_STORAGE) expect(readFileSync(file, "utf8"), file).toContain(phrase);
    }
  });
});

/** Phrases that would send a landlord to a person. Split so this file does not contain them whole. */
function contactPhrases(): string[] {
  return [
    ["reach", "a", "person"].join(" "),
    ["Waiting", "on", "Saad"].join(" "),
    ["contact", "at", "the", "bottom"].join(" "),
    ["person", "who", "runs", "your", "Tour", "Core"].join(" "),
    ["person", "who", "runs", "Tour", "Core"].join(" "),
  ];
}
