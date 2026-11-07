import type { CleanerAssistant } from "../cleaner-core/assistant";
import { handleCleanerMcpHttp } from "../cleaner-core/http";
import { liveDeskFor } from "../cleaner-core/liveDesk";
import { CLEANER_MCP_PATH, CLEANER_TOOL_NAMES, cleanerInstructions } from "../cleaner-core/mcp";
import type { Tenant } from "../cleaner-core/hosted/registry";
import type { Property } from "../cleaner-core/hosted/properties";
import { promoteRoutineOwner, propertyContext, shareRoutine, type HostedCleaner, type HostedRequest } from "../cleaner-core/hosted/router";
import { afterPeopleSaved, peopleRefusal } from "./lineRouter";
import { attachToolListStream, noteInitialized } from "../mcp/toolListChanged";
import { OPERATOR_TOOL_NAMES } from "../operator/tools";
import { ServiceNotices } from "./crossService";
import { FRONT_TOOL_NAMES, handleFrontTool, listedFrontTools, scratchFor, toolsFor, wrongServiceLine, type FrontReply } from "./serviceTools";
import { setFlows, type FlowInput } from "./service";
import { accountState, accountTools, addProperty, flowOff, resolveProperty, withPropertyArg, type PropertyStates } from "./propertyTools";
import { listedChooseSupplies, listedSupplyFront, SUPPLY_FRONT_NAMES, suppliesLine, supplyCall, supplyDesk } from "./supplies";
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

/** A tool of Cleaner Core or the property front on a touring account: refused, never forwarded. */
function refusedHere(name: string): boolean {
  return (FRONT_TOOL_NAMES.has(name) || CLEANING_TOOLS.has(name) || SUPPLY_FRONT_NAMES.has(name) || name === "add_property" || name === "set_flows") && !TOURING_TOOLS.has(name);
}

const rpcResult = (id: RpcMessage["id"], result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (id: RpcMessage["id"], code: number, message: string) => JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const toolResult = (reply: FrontReply) => ({ content: [{ type: "text", text: reply.text }], ...(reply.structured ? { structuredContent: reply.structured } : {}), isError: reply.isError });

export async function handleTenantMcp(h: HostedCleaner, r: HostedRequest, path: string): Promise<void> {
  if (!r.authenticate) return r.send(503, JSON_TYPE, JSON.stringify({ error: { message: "This chat connection is off." } }));
  const auth = await r.authenticate(path);
  if (!auth) return;
  const extra = (auth.extra ?? {}) as { grantId?: string; tenantId?: string; assistant?: CleanerAssistant };
  const tenant = extra.tenantId ? h.registry.get(extra.tenantId) : undefined;
  if (!tenant || tenant.disabled || !extra.grantId || !extra.assistant) return r.send(403, JSON_TYPE, JSON.stringify({ error: { message: UNLINKED[path] ?? UNLINKED.shared } }));
  const caller = { grantId: extra.grantId, assistant: extra.assistant };
  h.registry.touch(tenant.id);
  if (toolsFor(tenant) === "properties") return propertiesAnswer(h, r, tenant, caller, `grant:${caller.grantId}`);
  return touringAnswer(h, r, tenant, caller, `grant:${caller.grantId}`);
}

/** A parked touring account: Tour Core's own process answers, with the touring tools the service adds. */
async function touringAnswer(h: HostedCleaner, r: HostedRequest, tenant: Tenant, caller: TouringCaller, sessionKey: string): Promise<void> {
  if (r.method !== "POST") return touringPass(h, r, tenant, caller);
  const raw = await r.readRaw();
  const message = parseMessage(raw);
  if (message?.method === "initialize") initializes.set(caller.grantId, raw);
  if (message?.method === "tools/call" && message.id !== undefined) {
    const name = typeof message.params?.name === "string" ? message.params.name : "";
    const reply = await handleFrontTool({ h, tenant, caller, noteToolsChanged: () => noteInitialized(sessionKey) }, name, message.params?.arguments);
    if (reply) return r.send(200, JSON_TYPE, rpcResult(message.id, toolResult(reply)));
    if (refusedHere(name)) return r.send(200, JSON_TYPE, rpcResult(message.id, toolResult({ text: wrongServiceLine("touring"), isError: true })));
  }
  if (message?.method === "tools/list" && message.id !== undefined) {
    const answer = await touringCall(h, tenant.id, caller, raw, r);
    if (!answer) return r.send(503, JSON_TYPE, JSON.stringify({ error: { message: TOURING_DOWN } }));
    let listed: { result?: { tools?: unknown[] } } | undefined;
    try {
      listed = JSON.parse(answer.body) as { result?: { tools?: unknown[] } };
    } catch {
      listed = undefined;
    }
    if (!listed?.result || !Array.isArray(listed.result.tools)) return r.send(answer.status, JSON_TYPE, answer.body);
    listed.result.tools = [...listed.result.tools, ...listedFrontTools("touring", scratchFor(h, tenant))];
    return r.send(200, JSON_TYPE, JSON.stringify(listed));
  }
  // Touring's get_state also carries the shared service's notes for the host, once each.
  if (message?.method === "tools/call" && message.id !== undefined && message.params?.name === "get_state") {
    const answer = await touringCall(h, tenant.id, caller, raw, r);
    if (!answer) return r.send(503, JSON_TYPE, JSON.stringify({ error: { message: TOURING_DOWN } }));
    const warn = (state: Record<string, unknown>) => taskWarning(h, tenant, isPublished(state));
    return r.send(answer.status, JSON_TYPE, withNotices(answer.body, new ServiceNotices(h.dataRoot).take(tenant.id), warn));
  }
  return touringPass(h, r, tenant, caller, raw, message?.method === "initialize");
}

function parseMessage(raw: Buffer): RpcMessage | undefined {
  try {
    const parsed = JSON.parse(raw.toString("utf8") || "null") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as RpcMessage) : undefined;
  } catch {
    return undefined;
  }
}

type Caller = { grantId: string; assistant: CleanerAssistant };

/**
 * An account of properties. The service answers every message itself: the account's tools, and each
 * Cleaner Core or Supply Core call handed to the desk of the property it names.
 */
async function propertiesAnswer(h: HostedCleaner, r: HostedRequest, tenant: Tenant, caller: Caller, sessionKey: string): Promise<void> {
  if (r.method === "GET") {
    // A chat that holds a stream hears tools/list_changed the moment a flow is turned on or off.
    if (!String(r.req.headers.accept ?? "").includes("text/event-stream")) return r.send(405, JSON_TYPE, JSON.stringify({ error: { message: "Send MCP requests with POST." } }), { Allow: "POST, GET" });
    r.res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    attachToolListStream(sessionKey, r.res);
    return;
  }
  if (r.method !== "POST") return r.send(405, JSON_TYPE, JSON.stringify({ error: { message: "Send MCP requests with POST." } }), { Allow: "POST, GET" });
  const message = parseMessage(await r.readRaw());
  if (!message) return r.send(400, JSON_TYPE, rpcError(null, -32600, "That isn't a valid request."));
  if (message.id === undefined) return r.send(202, JSON_TYPE, "");
  if (message.method === "initialize") {
    const version = typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "2025-03-26";
    return r.send(200, JSON_TYPE, rpcResult(message.id, { protocolVersion: version, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "property-core", title: "Property Core", version: "0.1.0" }, instructions: `${PROPERTY_INSTRUCTIONS} ${cleanerInstructions(caller.assistant)}` }));
  }
  if (message.method === "ping") return r.send(200, JSON_TYPE, rpcResult(message.id, {}));
  if (message.method === "tools/list") return r.send(200, JSON_TYPE, rpcResult(message.id, { tools: await propertyToolList(h, r, tenant, caller) }));
  if (message.method !== "tools/call") return r.send(200, JSON_TYPE, rpcError(message.id, -32601, "I don't support that."));
  const name = typeof message.params?.name === "string" ? message.params.name : "";
  const reply = await propertyToolCall(h, r, tenant, caller, sessionKey, name, message.params?.arguments);
  return r.send(200, JSON_TYPE, rpcResult(message.id, toolResult(reply)));
}

/** Said on initialize before Cleaner Core's own instructions. */
export const PROPERTY_INSTRUCTIONS =
  "This connection runs Property Core for the host's properties: Cleaner Core for turnover cleanings and Supply Core for supplies. Call get_state first. When the account has more than one property, name the property in every property tool call with its id from get_state. Use set_flows to turn Cleaner Core or Supply Core on or off for a property. The host runs everything from this chat.";

async function propertyToolList(h: HostedCleaner, r: HostedRequest, tenant: Tenant, caller: Caller): Promise<Record<string, unknown>[]> {
  const required = tenant.properties.length > 1;
  const tools: Record<string, unknown>[] = [...accountTools(), ...listedFrontTools("properties")];
  const cleaning = tenant.properties.find((p) => p.flows.cleaning.on);
  if (cleaning) {
    const listed = deskJson(await cleaningCall(h, tenant, cleaning, caller, rpcBody("tools/list", {}), r));
    const own = ((listed?.result as { tools?: Record<string, unknown>[] } | undefined)?.tools ?? []).filter((tool) => tool.name !== "get_state");
    tools.push(...own.map((tool) => withPropertyArg(tool, required)));
    tools.push(...listedChooseSupplies(caller.assistant).map((tool) => withPropertyArg(tool, required)));
  }
  if (tenant.properties.some((p) => p.flows.supplies.on)) tools.push(...listedSupplyFront(caller.assistant).map((tool) => withPropertyArg(tool, required)));
  return tools;
}

async function propertyToolCall(h: HostedCleaner, r: HostedRequest, tenant: Tenant, caller: Caller, sessionKey: string, name: string, args: unknown): Promise<FrontReply> {
  const noteToolsChanged = () => noteInitialized(sessionKey);
  if (name === "get_state") return accountState(tenant, args, propertyStates(h, r, tenant, caller), caller.assistant);
  if (name === "add_property") {
    const reply = addProperty(h, tenant, args);
    if (!reply.isError) noteToolsChanged();
    return reply;
  }
  if (name === "set_flows") {
    const reply = await setFlows({ h, tenant, actor: "host", assistant: caller.assistant, noteToolsChanged }, (args ?? {}) as FlowInput);
    // A property that turns cleaning on starts with the account's routine connected.
    if (!reply.isError) await shareRoutine(h, tenant.id);
    return reply;
  }
  const front = await handleFrontTool({ h, tenant, caller, noteToolsChanged }, name, args);
  if (front) return front;
  const supply = SUPPLY_FRONT_NAMES.has(name);
  if (!supply && !CLEANING_TOOLS.has(name)) return { text: `There's no tool named ${name || "that"} here. Call get_state.`, isError: true };
  // A scheduled run checks every property at once: check_now with no property, on an account of two
  // or more, runs each property with Cleaner Core on and names it in the result.
  // Google events come from one property's calendar, so they always name their property.
  const googleEvents = args && typeof args === "object" && "googleEvents" in (args as Record<string, unknown>);
  if (name === "check_now" && !namesProperty(args) && !googleEvents && tenant.properties.length > 1) return checkEveryProperty(h, r, tenant, caller, args);
  const resolved = resolveProperty(tenant, args);
  if ("refusal" in resolved) return { text: resolved.refusal, isError: true };
  const { property } = resolved;
  if (supply) {
    // The setup question about Supply Core is Cleaner Core's, asked while cleaning is on.
    const flow = name === "choose_supplies" ? "cleaning" : "supplies";
    if (!property.flows[flow].on) return { text: flowOff(flow, property.label), isError: true };
    const reply = await supplyCall(h, tenant, property, caller.assistant, name, resolved.args);
    if (name === "choose_supplies" && reply && !reply.isError) noteToolsChanged();
    return reply ?? { text: "Supply Core couldn't answer that.", isError: true };
  }
  if (!property.flows.cleaning.on) return { text: flowOff("cleaning", property.label), isError: true };
  if (name === "save_people") {
    const refusal = await peopleRefusal(h, tenant, property, resolved.args);
    if (refusal) return { text: refusal, isError: true };
  }
  const reply = await cleaningTool(h, r, tenant, property, caller, name, resolved.args);
  if (name === "save_people" && !reply.isError) await afterPeopleSaved(h, tenant, property);
  return reply;
}

function namesProperty(args: unknown): boolean {
  const all = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  return typeof all.property === "string" || typeof all.propertyId === "string";
}

async function checkEveryProperty(h: HostedCleaner, r: HostedRequest, tenant: Tenant, caller: Caller, args: unknown): Promise<FrontReply> {
  const own = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const properties: Record<string, unknown>[] = [];
  for (const property of tenant.properties.filter((p) => p.flows.cleaning.on)) {
    const reply = await cleaningTool(h, r, tenant, property, caller, "check_now", own);
    properties.push({ id: property.id, label: property.label, ...(reply.isError ? { error: reply.text } : (reply.structured ?? { text: reply.text })) });
  }
  const structured = { properties, next: "Each result names its property. Tell the host about each one by its label." };
  return { text: JSON.stringify(structured), structured, isError: false };
}

let rpcIds = 0;
const rpcBody = (method: string, params: Record<string, unknown>) => Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: ++rpcIds, method, params }));

function deskJson(answer: { status: number; body: string } | undefined): Record<string, unknown> | undefined {
  if (!answer) return undefined;
  try {
    return JSON.parse(answer.body) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** One Cleaner Core tool on one property's desk, as a front reply. */
async function cleaningTool(h: HostedCleaner, r: HostedRequest, tenant: Tenant, property: Property, caller: Caller, name: string, args: Record<string, unknown>): Promise<FrontReply> {
  const reply = deskJson(await cleaningCall(h, tenant, property, caller, rpcBody("tools/call", { name, arguments: args }), r));
  const result = reply?.result as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[] } | undefined;
  const error = reply?.error as { message?: string } | undefined;
  if (!result) return { text: error?.message ?? "Cleaner Core couldn't answer that.", isError: true };
  return { text: result.content?.find((c) => c.type === "text")?.text ?? "", ...(result.structuredContent ? { structured: result.structuredContent } : {}), isError: result.isError === true };
}

function propertyStates(h: HostedCleaner, r: HostedRequest, tenant: Tenant, caller: Caller): PropertyStates {
  const cleaning = async (property: Property, args: Record<string, unknown>): Promise<FrontReply> => {
    const reply = await cleaningTool(h, r, tenant, property, caller, "get_state", args);
    // Cleaner Core's get_state carries one Supply Core line while Supply Core is on for the property.
    const line = !reply.isError && reply.structured ? suppliesLine(h, tenant, property) : undefined;
    if (!line || !reply.structured) return reply;
    const structured = { ...reply.structured, supplies: line };
    return { ...reply, text: JSON.stringify(structured), structured };
  };
  const supplies = async (property: Property): Promise<FrontReply> => supplyDesk(h, tenant, property).state();
  return {
    cleaning,
    supplies,
    next: async (property) => {
      const reply = property.flows.cleaning.on ? await cleaning(property, {}) : property.flows.supplies.on && caller.assistant === "grok" ? await supplies(property) : undefined;
      const ask = reply?.structured?.ask as { step?: unknown } | undefined;
      return typeof ask?.step === "string" ? ask.step : undefined;
    },
  };
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
async function cleaningCall(h: HostedCleaner, tenant: Tenant, property: Property, caller: Caller, raw: Buffer, r: HostedRequest): Promise<{ status: number; body: string; headers?: Record<string, string> } | undefined> {
  const ctx = propertyContext(h, tenant, property);
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
