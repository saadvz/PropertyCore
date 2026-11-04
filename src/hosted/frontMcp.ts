import type { CleanerAssistant } from "../cleaner-core/assistant";
import { handleCleanerMcpHttp } from "../cleaner-core/http";
import { liveDeskFor } from "../cleaner-core/liveDesk";
import { tourCoreTenants } from "../cleaner-core/flag";
import { CLEANER_MCP_PATH, CLEANER_TOOL_NAMES } from "../cleaner-core/mcp";
import type { Tenant } from "../cleaner-core/hosted/registry";
import { promoteRoutineOwner, tenantContext, type HostedCleaner, type HostedRequest } from "../cleaner-core/hosted/router";
import { attachToolListStream, noteInitialized } from "../mcp/toolListChanged";
import { OPERATOR_TOOL_NAMES } from "../operator/tools";
import { ServiceNotices } from "./crossService";
import { choicesFor, FRONT_TOOL_NAMES, handleFrontTool, listedFrontTools, scratchFor, toolsFor, UNSET_CLEANING_INSTRUCTIONS, unsetInstructions, wrongServiceLine, type FrontReply, type ToolState } from "./serviceTools";
import { handleSupplyFront, listedSupplyFront, SUPPLY_INSTRUCTIONS, suppliesLine } from "../supply-core/hosted";
import { taskWarning } from "./touringAlerts";
import { callWorkerMcp, forwardMcp, type WorkerTarget } from "./touringForward";

/**
 * The shared service's MCP door, at /mcp and at the /mcp/cleaner-core alias. The grant names the
 * tenant; the tenant's service decides who answers. The service answers its own tools (choose,
 * switch, stand down, touring alerts) and adds them to the active service's list; every other
 * message goes to that service: Cleaner Core's desk in this process, or the tenant's touring process.
 */

const JSON_TYPE = "application/json; charset=utf-8";
/** Cleaner Core's address keeps its own words. */
const UNLINKED: Record<string, string> = {
  [CLEANER_MCP_PATH]: "This connection isn't linked to a Cleaner Core account. Reconnect with an invite code from Saad.",
  shared: "This connection isn't linked to an account on this service. Reconnect with an invite code from Saad.",
};
const TOURING_DOWN = "Touring isn't answering right now. Try again in a minute.";

const TOURING_TOOLS = new Set(OPERATOR_TOOL_NAMES);
const CLEANING_TOOLS = new Set(CLEANER_TOOL_NAMES);

interface RpcMessage {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** Each connection's last initialize, so a touring process that never saw it (a switch, a restart) gets it first. */
const initializes = new Map<string, Buffer>();
/** `${process key}|${grant}` pairs whose initialize the process has seen. A restart's new key starts over. */
const introduced = new Set<string>();

/** A tool of the service this number doesn't run, or a front tool from another state: refused, never forwarded. */
function refusedHere(state: Exclude<ToolState, "unset">, name: string): boolean {
  const active = state === "touring" ? TOURING_TOOLS : CLEANING_TOOLS;
  const other = state === "touring" ? CLEANING_TOOLS : TOURING_TOOLS;
  return (FRONT_TOOL_NAMES.has(name) || other.has(name)) && !active.has(name);
}

const rpcResult = (id: RpcMessage["id"], result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (id: RpcMessage["id"], code: number, message: string) => JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const toolResult = (reply: FrontReply) => ({ content: [{ type: "text", text: reply.text }], ...(reply.structured ? { structuredContent: reply.structured } : {}), isError: reply.isError });

export async function handleTenantMcp(h: HostedCleaner, r: HostedRequest, path: string): Promise<void> {
  if (!r.authenticate) return r.send(503, JSON_TYPE, JSON.stringify({ error: { message: "This chat connection is off." } }));
  const auth = await r.authenticate(path);
  if (!auth) return;
  const extra = (auth.extra ?? {}) as { grantId?: string; tenantId?: string; assistant?: CleanerAssistant };
  let tenant = extra.tenantId ? h.registry.get(extra.tenantId) : undefined;
  if (!tenant || tenant.disabled || !extra.grantId || !extra.assistant) return r.send(403, JSON_TYPE, JSON.stringify({ error: { message: UNLINKED[path] ?? UNLINKED.shared } }));
  // The cleaning address names its service: a tenant that hasn't chosen yet is a cleaning tenant there.
  if (path === CLEANER_MCP_PATH && !tenant.service) {
    h.registry.setService(tenant.id, "cleaning");
    tenant = h.registry.get(tenant.id)!;
  }
  const caller = { grantId: extra.grantId, assistant: extra.assistant };
  const sessionKey = `grant:${caller.grantId}`;
  const state = toolsFor(tenant);
  h.registry.touch(tenant.id);

  if (r.method === "GET" && (state === "unset" || state === "supplies")) {
    // A chat that holds a stream hears tools/list_changed the moment it chooses.
    if (!String(r.req.headers.accept ?? "").includes("text/event-stream")) return r.send(405, JSON_TYPE, JSON.stringify({ error: { message: "Send MCP requests with POST." } }), { Allow: "POST, GET" });
    r.res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    attachToolListStream(sessionKey, r.res);
    return;
  }
  if (r.method !== "POST") {
    if (state === "touring") return touringPass(h, r, tenant, caller);
    if (state === "supplies") return r.send(405, JSON_TYPE, JSON.stringify({ error: { message: "Send MCP requests with POST." } }), { Allow: "POST, GET" });
    return cleaningPass(h, r, tenant, caller, Buffer.alloc(0));
  }

  const raw = await r.readRaw();
  let message: RpcMessage | undefined;
  try {
    const parsed = JSON.parse(raw.toString("utf8") || "null") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) message = parsed as RpcMessage;
  } catch {
    message = undefined;
  }
  if (message?.method === "initialize") initializes.set(caller.grantId, raw);

  // While touring and Supply Core are off here, a new number can only run cleaning, so nothing offers a pick.
  const choices = choicesFor(h, caller.assistant);
  const cleaningOnly = choices.length < 2;
  if (state === "supplies") return suppliesAnswer(h, r, tenant, caller, sessionKey, message);
  if (state === "unset") {
    if (!message) return r.send(400, JSON_TYPE, rpcError(null, -32600, "That isn't a valid request."));
    if (message.id === undefined) return r.send(202, JSON_TYPE, "");
    if (message.method === "initialize") {
      const version = typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "2025-03-26";
      return r.send(200, JSON_TYPE, rpcResult(message.id, { protocolVersion: version, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "tour-core-shared", title: "Tour Core and Cleaner Core", version: "0.1.0" }, instructions: cleaningOnly ? UNSET_CLEANING_INSTRUCTIONS : unsetInstructions(choices) }));
    }
    if (message.method === "ping") return r.send(200, JSON_TYPE, rpcResult(message.id, {}));
    if (message.method === "tools/list") return r.send(200, JSON_TYPE, rpcResult(message.id, { tools: listedFrontTools("unset", false, choices) }));
    if (message.method !== "tools/call") return r.send(200, JSON_TYPE, rpcError(message.id, -32601, "I don't support that."));
  }

  if (message?.method === "tools/call" && message.id !== undefined) {
    const name = typeof message.params?.name === "string" ? message.params.name : "";
    const reply = await handleFrontTool({ h, tenant, caller, noteToolsChanged: () => noteInitialized(sessionKey) }, name, message.params?.arguments);
    if (reply) return r.send(200, JSON_TYPE, rpcResult(message.id, toolResult(reply)));
    if (state === "cleaning") {
      const supply = await handleSupplyFront({ h, tenant, caller, noteToolsChanged: () => noteInitialized(sessionKey) }, name, message.params?.arguments);
      if (supply) return r.send(200, JSON_TYPE, rpcResult(message.id, toolResult(supply)));
    }
    if (state === "unset") return r.send(200, JSON_TYPE, rpcError(message.id, -32602, "Ask the host which service to set up first. Call get_state."));
    if (refusedHere(state, name)) return r.send(200, JSON_TYPE, rpcResult(message.id, toolResult({ text: wrongServiceLine(state), isError: true })));
  }
  if (state === "unset") return;

  if (message?.method === "tools/list" && message.id !== undefined) {
    const answer = state === "touring" ? await touringCall(h, tenant.id, caller, raw, r) : await cleaningCall(h, tenant, caller, raw, r);
    if (!answer) return r.send(503, JSON_TYPE, JSON.stringify({ error: { message: TOURING_DOWN } }));
    let listed: { result?: { tools?: unknown[] } } | undefined;
    try {
      listed = JSON.parse(answer.body) as { result?: { tools?: unknown[] } };
    } catch {
      listed = undefined;
    }
    if (!listed?.result || !Array.isArray(listed.result.tools)) return r.send(answer.status, JSON_TYPE, answer.body);
    listed.result.tools = [...listed.result.tools, ...listedFrontTools(state, scratchFor(h, tenant)), ...(state === "cleaning" ? listedSupplyFront(tenant, caller.assistant) : [])];
    return r.send(200, JSON_TYPE, JSON.stringify(listed));
  }

  // Touring's get_state also carries the shared service's notes for the host, once each.
  if (state === "touring" && message?.method === "tools/call" && message.id !== undefined && message.params?.name === "get_state") {
    const answer = await touringCall(h, tenant.id, caller, raw, r);
    if (!answer) return r.send(503, JSON_TYPE, JSON.stringify({ error: { message: TOURING_DOWN } }));
    const warn = (state: Record<string, unknown>) => taskWarning(h, tenant, isPublished(state));
    return r.send(answer.status, JSON_TYPE, withNotices(answer.body, new ServiceNotices(h.dataRoot).take(tenant.id), warn));
  }
  if (state === "touring") return touringPass(h, r, tenant, caller, raw, message?.method === "initialize");
  // Cleaner Core's get_state carries one Supply Core line while the add-on is on.
  const line = state === "cleaning" && message?.method === "tools/call" && message.id !== undefined && message.params?.name === "get_state" ? suppliesLine(h, tenant) : undefined;
  if (line) {
    const answer = await cleaningCall(h, tenant, caller, raw, r);
    if (!answer) return;
    return r.send(answer.status, JSON_TYPE, withFields(answer.body, { supplies: line }), answer.headers);
  }
  return cleaningPass(h, r, tenant, caller, raw);
}

/** A supplies tenant: Supply Core answers every message in this process. Nothing is forwarded. */
async function suppliesAnswer(h: HostedCleaner, r: HostedRequest, tenant: Tenant, caller: { grantId: string; assistant: CleanerAssistant }, sessionKey: string, message: RpcMessage | undefined): Promise<void> {
  if (!message) return r.send(400, JSON_TYPE, rpcError(null, -32600, "That isn't a valid request."));
  if (message.id === undefined) return r.send(202, JSON_TYPE, "");
  if (message.method === "initialize") {
    const version = typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "2025-03-26";
    return r.send(200, JSON_TYPE, rpcResult(message.id, { protocolVersion: version, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "supply-core", title: "Supply Core", version: "0.1.0" }, instructions: SUPPLY_INSTRUCTIONS }));
  }
  if (message.method === "ping") return r.send(200, JSON_TYPE, rpcResult(message.id, {}));
  if (message.method === "tools/list") return r.send(200, JSON_TYPE, rpcResult(message.id, { tools: [...listedSupplyFront(tenant, caller.assistant), ...listedFrontTools("supplies")] }));
  if (message.method !== "tools/call") return r.send(200, JSON_TYPE, rpcError(message.id, -32601, "I don't support that."));
  const name = typeof message.params?.name === "string" ? message.params.name : "";
  const ctx = { h, tenant, caller, noteToolsChanged: () => noteInitialized(sessionKey) };
  const reply = (await handleFrontTool(ctx, name, message.params?.arguments)) ?? (await handleSupplyFront(ctx, name, message.params?.arguments));
  if (reply) return r.send(200, JSON_TYPE, rpcResult(message.id, toolResult(reply)));
  return r.send(200, JSON_TYPE, rpcResult(message.id, toolResult({ text: wrongServiceLine("supplies"), isError: true })));
}

/** Adds fields to a tools/call reply's structured content and its JSON text. Unchanged when it has none. */
function withFields(body: string, fields: Record<string, unknown>): string {
  try {
    const reply = JSON.parse(body) as { result?: { structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[] } };
    const result = reply.result;
    if (!result?.structuredContent) return body;
    result.structuredContent = { ...result.structuredContent, ...fields };
    const first = result.content?.[0];
    if (first?.type === "text") first.text = JSON.stringify(result.structuredContent);
    return JSON.stringify(reply);
  } catch {
    return body;
  }
}

/** True when touring's get_state says the publish milestone is done. */
function isPublished(state: Record<string, unknown>): boolean {
  const milestones = Array.isArray(state.milestones) ? (state.milestones as { id?: string; status?: string }[]) : [];
  return milestones.some((m) => m.id === "publish" && m.status === "done");
}

/**
 * Adds the notes, and a stopped-task warning when `warn` gives one, to a tools/call reply's
 * structured content and its JSON text. Unchanged when there's nothing to add.
 */
function withNotices(body: string, notices: string[], warn?: (state: Record<string, unknown>) => string | undefined): string {
  try {
    const reply = JSON.parse(body) as { result?: { structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[] } };
    const result = reply.result;
    if (!result?.structuredContent) return body;
    const warning = warn?.(result.structuredContent);
    if (notices.length === 0 && !warning) return body;
    result.structuredContent = { ...result.structuredContent, ...(notices.length > 0 ? { serviceNotices: notices } : {}), ...(warning ? { warning } : {}) };
    const first = result.content?.[0];
    if (first?.type === "text") first.text = JSON.stringify(result.structuredContent);
    return JSON.stringify(reply);
  } catch {
    return body;
  }
}

/** The touring process for this tenant, once it has seen this connection's initialize. */
/** How long a call waits for a touring process that is still starting. */
const STARTING_WAIT_MS = 30_000;

async function touringTarget(h: HostedCleaner, tenantId: string, caller: TouringCaller, isInitialize = false): Promise<WorkerTarget | undefined> {
  // A process still starting (the service was just picked, or it's restarting) is waited for, so a
  // chat's first tool list is never empty: Claude and ChatGPT keep the list a chat started with.
  if (!h.touring?.supervisor.target(tenantId)) {
    const tenant = h.registry.get(tenantId);
    if (h.touring && tenant?.service === "touring" && !tenant.disabled) {
      await Promise.race([h.touring.start(tenant).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, STARTING_WAIT_MS).unref())]);
    }
  }
  const target = h.touring?.supervisor.target(tenantId);
  if (!target) return undefined;
  const seen = `${target.key}|${caller.grantId}`;
  if (isInitialize) {
    introduced.add(seen);
    return target;
  }
  const init = initializes.get(caller.grantId);
  if (init && !introduced.has(seen)) {
    await callWorkerMcp(target, init, {}, caller.assistant);
    await callWorkerMcp(target, Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })), {}, caller.assistant);
    introduced.add(seen);
  }
  return target;
}

/** The connection a touring call is for, and the chat its sign-in recorded, which picks touring's playbook. */
type TouringCaller = { grantId: string; assistant: CleanerAssistant };

async function touringPass(h: HostedCleaner, r: HostedRequest, tenant: Tenant, caller: TouringCaller, raw?: Buffer, isInitialize = false): Promise<void> {
  const target = await touringTarget(h, tenant.id, caller, isInitialize);
  if (!target) return r.send(503, JSON_TYPE, JSON.stringify({ error: { message: TOURING_DOWN } }));
  return forwardMcp(target, r, raw, caller.assistant);
}

async function touringCall(h: HostedCleaner, tenantId: string, caller: TouringCaller, raw: Buffer, r: HostedRequest): Promise<{ status: number; body: string } | undefined> {
  const target = await touringTarget(h, tenantId, caller);
  if (!target) return undefined;
  const answer = await callWorkerMcp(target, raw, r.req.headers, caller.assistant);
  return answer ? { status: answer.status, body: answer.body.toString("utf8") } : undefined;
}

/** Cleaner Core's desk for this tenant, exactly as the cleaning address always answered. */
async function cleaningCall(h: HostedCleaner, tenant: Tenant, caller: { grantId: string; assistant: CleanerAssistant }, raw: Buffer, r: HostedRequest): Promise<{ status: number; body: string; headers?: Record<string, string> } | undefined> {
  const ctx = tenantContext(h, tenant);
  // The tenant's service is cleaning, so Cleaner Core's own setup doesn't ask touring or cleaning again.
  await liveDeskFor(ctx.root, ctx.env, () => h.now()).chooseCleaning();
  const result = await handleCleanerMcpHttp({
    method: r.method,
    authorization: r.req.headers.authorization,
    pinKeyHeader: r.req.headers["x-cleaner-core-pin-key"],
    contentType: String(r.req.headers["content-type"] ?? ""),
    readBody: async () => raw,
    env: ctx.env,
    root: ctx.root,
    now: () => h.now(),
    saveSecrets: ctx.saveSecrets,
    deleteSecrets: ctx.deleteSecrets,
    oauth: { authenticate: async () => true },
    caller: { assistant: caller.assistant, connectionId: caller.grantId },
  });
  promoteRoutineOwner(h, tenant.id);
  return "answered" in result ? undefined : result;
}

async function cleaningPass(h: HostedCleaner, r: HostedRequest, tenant: Tenant, caller: { grantId: string; assistant: CleanerAssistant }, raw: Buffer): Promise<void> {
  const result = await cleaningCall(h, tenant, caller, raw, r);
  if (!result) return;
  r.send(result.status, JSON_TYPE, result.body, result.headers);
}
