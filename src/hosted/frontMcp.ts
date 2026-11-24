import { existsSync } from "node:fs";
import { runsFixer, runsSupplies, type CleanerAssistant } from "../cleaner-core/assistant";
import { supplyReplyFor } from "./supplyWording";
import { handleCleanerMcpHttp } from "../cleaner-core/http";
import { liveDeskFor } from "../cleaner-core/liveDesk";
import { CLEANER_MCP_PATH, CLEANER_TOOL_NAMES, cleanerInstructions } from "../cleaner-core/mcp";
import type { Tenant } from "../cleaner-core/hosted/registry";
import type { FlowName, Property } from "../cleaner-core/hosted/properties";
import { carryRoutines, promoteRoutineOwner, propertyContext, shareRoutine, type HostedCleaner, type HostedRequest } from "../cleaner-core/hosted/router";
import { sweepHeldTexts } from "./lineRouter";
import { bookingEmailProperty } from "./bookingEmailRoute";
import { signUpFlag } from "./signUp";
import { afterPeopleSaved, draftPeople, peopleRefusal } from "./sharedPeople";
import { attachToolListStream, noteInitialized } from "../mcp/toolListChanged";
import { negotiatedProtocolVersion } from "../mcp/protocol";
import { OPERATOR_TOOL_NAMES } from "../operator/tools";
import { ServiceNotices } from "./crossService";
import { FRONT_TOOL_NAMES, handleFrontTool, listedFrontTools, scratchFor, toolsFor, wrongServiceLine, type FrontReply } from "./serviceTools";
import { hasOwnRoutine, listedBotTools, noRoutineNote, REMOVE_BOT, removeBotCall, teamView } from "./botTools";
import { CHECK_ALERTS, checkAlertsCall, listedCheckAlerts } from "./checkAlerts";
import { fileCall } from "./filing";
import { setFlows, type FlowInput } from "./service";
import { accountState, accountTools, addProperty, flowOff, resolveProperty, withPropertyArg, type PropertyStates, type StateView } from "./propertyTools";
import { listedChooseSupplies, listedSupplyFront, SUPPLY_FRONT_NAMES, suppliesLine, supplyCall, supplyDesk } from "./supplies";
import { HOURS_FRONT_NAMES, hoursCall, listedHoursFront } from "./hours";
import { listedOversightFront, OVERSIGHT_FRONT_NAMES, oversightCall } from "./oversight";
import { listedLockFront, LOCK_FRONT_NAMES, lockCall, lockDesk } from "./locks";
import { listedVisitsFront, VISITS_FRONT_NAMES, visitsCall } from "./visits";
import { listedStayCheckFront, STAY_CHECK_FRONT_NAMES, stayCheckCall } from "./stayCheck";
import { CAMERA_FRONT_NAMES, camerasCall, listedCameraFront } from "./cameras";
import { listedPackageFront, PACKAGE_FRONT_NAMES, packageCall } from "./packages";
import { GUEST_FRONT_NAMES, withRoutedProperty, GUEST_MESSAGES_INSTRUCTION, guestCall, guestMessageProperty, listedGuestFront } from "./guestMessages";
import { featureOn } from "../features/features";
import { BOOKING_PLATFORMS_INSTRUCTION } from "../cleaner-core/bookingEmailDesk";
import { FIXER_FRONT_NAMES, fixerCall, fixerDesk, fixerPhotos, fixerPreview, listedFixerFront, namesRepairJob, repairsLine } from "./fixer";
import { taskWarning } from "./touringAlerts";
import { CORE_JOBS, jobOfPath, type CoreJob, type Job } from "../jobs/jobs";
import { BOTS_NEED_MAIN, callerJobs, hasCoreBot, holder, newBots, team } from "./jobDeps";
import { elsewhereLine, isFiling, jobInstructions, leftBehindLine, mayCall, NO_JOBS, ownerFor, routineCheckOf, teamLine } from "./jobTools";
import { isOfferId, nextOffer, OFFER_IDS, offersFor, type OfferContext } from "./featureOffers";
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
/** With sign-up open, the connect page offers Sign in, so the invite code isn't the only way back. */
const UNLINKED_SIGN_IN = "This connection isn't linked to an account on this service. Reconnect, then sign in on the page that opens.";
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
/** Each connection's process key that has seen its initialize. A restart's new key starts over. */
const introduced = new Map<string, string>();

/** A new initialize drops what both maps keep for connections whose grant has ended. */
function rememberInitialize(h: HostedCleaner, grantId: string, raw: Buffer): void {
  const tracked = new Set([...initializes.keys(), ...introduced.keys()]);
  tracked.delete(grantId);
  // One read of the grants for the whole sweep, when the service offers it.
  const live = tracked.size > 0 ? h.liveGrantIds?.() : undefined;
  for (const id of tracked) {
    if (!(live ? live.has(id) : h.grantLive(id))) {
      initializes.delete(id);
      introduced.delete(id);
    }
  }
  initializes.set(grantId, raw);
}

/** For tests: the keys both maps hold now. */
export function trackedConnections(): { initializes: string[]; introduced: string[] } {
  return { initializes: [...initializes.keys()], introduced: [...introduced.keys()] };
}

/** A tool of Cleaner Core or the property front on a touring account: refused, never forwarded. */
function refusedHere(name: string): boolean {
  return (FRONT_TOOL_NAMES.has(name) || CLEANING_TOOLS.has(name) || SUPPLY_FRONT_NAMES.has(name) || FIXER_FRONT_NAMES.has(name) || name === "add_property" || name === "set_flows") && !TOURING_TOOLS.has(name);
}

const rpcResult = (id: RpcMessage["id"], result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (id: RpcMessage["id"], code: number, message: string) => JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const toolResult = (reply: FrontReply) => ({ content: [{ type: "text", text: reply.text }], ...(reply.structured ? { structuredContent: reply.structured } : {}), isError: reply.isError });

export async function handleTenantMcp(h: HostedCleaner, r: HostedRequest, path: string): Promise<void> {
  if (!r.authenticate) return r.send(503, JSON_TYPE, JSON.stringify({ error: { message: "This chat connection is off." } }));
  const auth = await r.authenticate(path);
  if (!auth) return;
  const extra = (auth.extra ?? {}) as { grantId?: string; tenantId?: string; assistant?: CleanerAssistant };
  const signedIn = extra.tenantId ? h.registry.get(extra.tenantId) : undefined;
  if (!signedIn || signedIn.disabled || !extra.grantId || !extra.assistant) {
    const message = signUpFlag(h.baseEnv()) ? UNLINKED_SIGN_IN : (UNLINKED[path] ?? UNLINKED.shared);
    return r.send(403, JSON_TYPE, JSON.stringify({ error: { message } }));
  }
  // A chat that signed in again keeps the alert routine of its ended sign-in, before this call reads it.
  if (toolsFor(signedIn) === "properties") await carryRoutines(h, signedIn.id).marked.catch(() => h.log(`Couldn't keep ${signedIn.id}'s alert routine connected this time.`));
  const tenant = h.registry.get(signedIn.id) ?? signedIn;
  // A core's own bot (#250): the job is the address's, which the grant is bound to. Nothing a chat sends can change it.
  const job = jobOfPath(path);
  const properties = toolsFor(tenant) === "properties";
  if (job && !properties) return r.send(403, JSON_TYPE, JSON.stringify({ error: { message: BOTS_NEED_MAIN } }));
  const caller: Caller = { grantId: extra.grantId, assistant: extra.assistant, ...(job ? { job } : {}), jobs: properties ? callerJobs(h, tenant, extra.grantId, extra.assistant, path) : [] };
  h.registry.touch(tenant.id);
  // When this connection last called: a core's own bot that stops calling is told about as quiet (#250).
  h.registry.seen(tenant.id, caller.grantId);
  if (properties) return propertiesAnswer(h, r, tenant, caller, `grant:${caller.grantId}`);
  return touringAnswer(h, r, tenant, caller);
}

/** A parked touring account: Tour Core's own process answers, with the touring tools the service adds. */
async function touringAnswer(h: HostedCleaner, r: HostedRequest, tenant: Tenant, caller: Caller): Promise<void> {
  if (r.method !== "POST") return touringPass(h, r, tenant, caller);
  const raw = await r.readRaw();
  const message = parseMessage(raw);
  if (message?.method === "initialize") rememberInitialize(h, caller.grantId, raw);
  if (message?.method === "tools/call" && message.id !== undefined) {
    const name = typeof message.params?.name === "string" ? message.params.name : "";
    const reply = await handleFrontTool({ h, tenant, caller }, name, message.params?.arguments);
    if (reply) return r.send(200, JSON_TYPE, rpcResult(message.id, toolResult(reply)));
    if (refusedHere(name)) return r.send(200, JSON_TYPE, rpcResult(message.id, toolResult({ text: wrongServiceLine("touring"), isError: true })));
  }
  if (message?.method === "tools/list" && message.id !== undefined) {
    const answer = await touringCall(h, tenant.id, caller, raw, r);
    if (!answer) return r.send(503, JSON_TYPE, JSON.stringify({ error: { message: TOURING_DOWN } }));
    const listed = deskJson(answer) as { result?: { tools?: unknown[] } } | undefined;
    if (!listed?.result || !Array.isArray(listed.result.tools)) return r.send(answer.status, JSON_TYPE, answer.body);
    listed.result.tools = [...listed.result.tools, ...listedFrontTools("touring", scratchFor(h, tenant))];
    return r.send(200, JSON_TYPE, JSON.stringify(listed));
  }
  // Touring's get_state also carries the shared service's notes for the host, once each.
  if (message?.method === "tools/call" && message.id !== undefined && message.params?.name === "get_state") {
    const answer = await touringCall(h, tenant.id, caller, raw, r);
    if (!answer) return r.send(503, JSON_TYPE, JSON.stringify({ error: { message: TOURING_DOWN } }));
    const warn = (state: Record<string, unknown>) => taskWarning(h, tenant, isPublished(state));
    const notices = new ServiceNotices(h.dataRoot);
    const pending = notices.pending(tenant.id);
    const reply = withNotices(answer.body, pending, warn);
    // Cleared only once a good reply carried them; an error reply leaves them for the next get_state.
    if (reply.delivered && answer.status === 200) notices.shown(tenant.id, pending);
    return r.send(answer.status, JSON_TYPE, reply.body);
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

/** The connection a call is for, and the chat its sign-in recorded. */
/** Who is calling: `job` is the job of a core's own address, and `jobs` is what this connection has now (src/jobs/jobs.ts). */
export type Caller = { grantId: string; assistant: CleanerAssistant; job?: CoreJob; jobs: Job[] };

/**
 * An account of properties. The service answers every message itself: the account's tools, and each
 * Cleaner Core, Supply Core or Fixer Core call handed to the desk of the property it names.
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
    const version = negotiatedProtocolVersion(message.params?.protocolVersion);
    return r.send(200, JSON_TYPE, rpcResult(message.id, { protocolVersion: version, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "property-core", title: "Property Core", version: "0.1.0" }, instructions: instructionsFor(h, tenant, caller) }));
  }
  if (message.method === "ping") return r.send(200, JSON_TYPE, rpcResult(message.id, {}));
  if (message.method === "tools/list") return r.send(200, JSON_TYPE, rpcResult(message.id, { tools: await propertyToolList(h, r, tenant, caller) }));
  if (message.method !== "tools/call") return r.send(200, JSON_TYPE, rpcError(message.id, -32601, "I don't support that."));
  const name = typeof message.params?.name === "string" ? message.params.name : "";
  const reply = await propertyToolCall(h, r, tenant, caller, sessionKey, name, message.params?.arguments);
  return r.send(200, JSON_TYPE, rpcResult(message.id, toolResult(reply)));
}

/**
 * What initialize says. A chat that has every job gets what it always got. A core's own bot (#250) gets one line for
 * its job and only that job's instructions, and the Property Core chat on a team is told which cores have their own bot.
 */
function instructionsFor(h: HostedCleaner, tenant: Tenant, caller: Caller): string {
  if (caller.job) return `${jobInstructions(caller.job)}${caller.job === "cleaning" ? ` ${cleanerInstructions(caller.assistant)}` : ""}`;
  const guests = featureOn(tenant, "guest-messages", h.baseEnv()) ? ` ${GUEST_MESSAGES_INSTRUCTION}` : "";
  const platforms = featureOn(tenant, "booking-platforms", h.baseEnv()) && caller.assistant !== "grok" ? ` ${BOOKING_PLATFORMS_INSTRUCTION}` : "";
  const elsewhere = CORE_JOBS.filter((job) => !caller.jobs.includes(job));
  if (elsewhere.length === 0) return `${PROPERTY_INSTRUCTIONS}${guests} ${cleanerInstructions(caller.assistant)}${platforms}`;
  return `${PROPERTY_INSTRUCTIONS}${guests}${caller.jobs.includes("cleaning") ? ` ${cleanerInstructions(caller.assistant)}${platforms}` : ""} ${teamLine(elsewhere)}`;
}

/** Said on initialize before Cleaner Core's own instructions. */
export const PROPERTY_INSTRUCTIONS =
  "This connection runs Property Core for the host's properties: Cleaner Core for turnover cleanings, Supply Core for supplies, and Fixer Core for repairs. Call get_state first. When the account has more than one property, name the property in every property tool call with its id from get_state. Use set_flows to turn Cleaner Core, Supply Core or Fixer Core on or off for a property. The host runs everything from this chat. Touring is parked: never offer the host tours.";

async function propertyToolList(h: HostedCleaner, r: HostedRequest, tenant: Tenant, caller: Caller): Promise<Record<string, unknown>[]> {
  // A connection lists only its jobs' tools (#250). A flow's section is skipped whole when the caller lacks its job,
  // so no desk is asked for a list it won't show; the finished list is filtered once more below.
  if (caller.jobs.length === 0) return [];
  const has = (job: Job) => caller.jobs.includes(job);
  const required = tenant.properties.length > 1;
  const tools: Record<string, unknown>[] = [...accountTools()];
  const cleaning = has("cleaning") ? tenant.properties.find((p) => p.flows.cleaning.on) : undefined;
  if (cleaning) {
    const listed = deskJson(await cleaningCall(h, tenant, cleaning, caller, rpcBody("tools/list", {}), r));
    const own = ((listed?.result as { tools?: Record<string, unknown>[] } | undefined)?.tools ?? []).filter((tool) => tool.name !== "get_state");
    tools.push(...own.map((tool) => withPropertyArg(tool, required)));
    tools.push(...listedChooseSupplies(caller.assistant).map((tool) => withPropertyArg(tool, required)));
  }
  if (has("supplies") && tenant.properties.some((p) => p.flows.supplies.on)) tools.push(...listedSupplyFront(caller.assistant).map((tool) => withPropertyArg(tool, required)));
  if (has("fixer") && tenant.properties.some((p) => p.flows.fixer.on)) {
    // preview_schedule and get_job_photos come once, from the flow that listed them first.
    const listed = new Set(tools.map((tool) => tool.name));
    tools.push(...listedFixerFront(caller.assistant).filter((tool) => !listed.has(tool.name)).map((tool) => withPropertyArg(tool, required)));
  }
  if (has("property")) {
    tools.push(...listedHoursFront(h, tenant).map((tool) => withPropertyArg(tool, required)));
    tools.push(...listedStayCheckFront(h, tenant).map((tool) => withPropertyArg(tool, required)));
    tools.push(...listedCameraFront(h, tenant).map((tool) => withPropertyArg(tool, required)));
    tools.push(...listedOversightFront(h, tenant).map((tool) => withPropertyArg(tool, required)));
    tools.push(...listedVisitsFront(h, tenant).map((tool) => withPropertyArg(tool, required)));
  }
  if (has("supplies")) tools.push(...listedPackageFront(h, tenant).map((tool) => withPropertyArg(tool, required)));
  if (has("property")) {
    tools.push(...listedGuestFront(h, tenant).map((tool) => withPropertyArg(tool, required)));
    tools.push(...listedLockFront(h, tenant).map((tool) => withPropertyArg(tool, required)));
  }
  // Filing (#250): a chat that runs Cleaner Core lists the three tools it files with into a core another bot holds.
  if (tenant.properties.some((p) => p.flows.cleaning.on)) {
    const files = (tool: Record<string, unknown>) => isFiling(String(tool.name), caller);
    if (!has("supplies") && tenant.properties.some((p) => p.flows.supplies.on)) tools.push(...listedSupplyFront(caller.assistant).filter(files).map((tool) => withPropertyArg(tool, required)));
    if (!has("fixer") && tenant.properties.some((p) => p.flows.fixer.on)) tools.push(...listedFixerFront(caller.assistant).filter(files).map((tool) => withPropertyArg(tool, required)));
  }
  tools.push(...listedCheckAlerts(h, tenant, caller));
  tools.push(...listedBotTools(h, tenant, caller));
  return tools.filter((tool) => mayCall(String(tool.name), caller));
}

/** The line for a tool this caller may not call: it names the bot that holds it, so the host is sent to the right chat. */
function heldElsewhere(h: HostedCleaner, tenant: Tenant, caller: Caller, name: string): string {
  if (caller.jobs.length === 0) return NO_JOBS;
  const owner = ownerFor(name, caller);
  const check = routineCheckOf(name);
  // A routine left behind in the Property Core chat still calls the check another bot now runs.
  return `${botLine(h, tenant, owner)}${ownBot(h, tenant, owner) && !caller.job && check ? ` ${leftBehindLine(check)}` : ""}`;
}

/** Whether this job is held by its own bot, not by the Property Core chat. */
function ownBot(h: HostedCleaner, tenant: Tenant, job: Job): boolean {
  return job !== "property" && Boolean(holder(h, tenant, job)?.job);
}

/** The line that sends the host to the bot holding this job. */
function botLine(h: HostedCleaner, tenant: Tenant, job: Job): string {
  return elsewhereLine(job, ownBot(h, tenant, job));
}

/**
 * At a core's own address, Cleaner Core's setup never asks whether to set up Supply Core: a core's bot can't turn a
 * flow on or off, so the answer is the property's own flow, as the host set it with the Property Core bot.
 */
async function settleSuppliesQuestion(h: HostedCleaner, tenant: Tenant): Promise<void> {
  for (const property of tenant.properties.filter((p) => p.flows.cleaning.on)) {
    const ctx = propertyContext(h, tenant, property);
    await liveDeskFor(ctx.root, ctx.env, () => h.now()).noteSuppliesChoice();
  }
}

async function propertyToolCall(h: HostedCleaner, r: HostedRequest, tenant: Tenant, caller: Caller, sessionKey: string, name: string, args: unknown): Promise<FrontReply> {
  const noteToolsChanged = () => noteInitialized(sessionKey);
  // The job check (#250), before any desk is reached: a tool outside the caller's jobs is refused here.
  if (!mayCall(name, caller)) return { text: heldElsewhere(h, tenant, caller, name), isError: true };
  if (caller.job === "cleaning") await settleSuppliesQuestion(h, tenant);
  if (name === "get_state") {
    const answered = answerOffer(h, tenant, caller, args);
    if (answered.refusal) return { text: answered.refusal, isError: true };
    const now = h.registry.get(tenant.id) ?? tenant;
    return accountState(now, answered.args, propertyStates(h, r, now, caller), caller.assistant, stateView(h, now, caller), newBots(h, now, caller));
  }
  if (isFiling(name, caller)) {
    const resolved = resolveProperty(tenant, args);
    if ("refusal" in resolved) return { text: resolved.refusal, isError: true };
    // Where Cleaner Core doesn't run there is no cleaner to file for: the host is sent to the bot that holds the core.
    if (!resolved.property.flows.cleaning.on) return { text: heldElsewhere(h, tenant, caller, name), isError: true };
    return fileCall(h, tenant, resolved.property, caller, name, resolved.args);
  }
  if (name === CHECK_ALERTS) return checkAlertsCall(h, tenant, caller, args);
  if (name === REMOVE_BOT) {
    const reply = await removeBotCall(h, tenant, caller, args);
    // The core is back in this chat: its tools are listed here again.
    if (!reply.isError && reply.structured?.removed) noteToolsChanged();
    return reply;
  }
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
  if (HOURS_FRONT_NAMES.has(name)) {
    const resolved = resolveProperty(tenant, args);
    if ("refusal" in resolved) return { text: resolved.refusal, isError: true };
    return hoursCall(h, tenant, resolved.property, name, resolved.args);
  }
  if (STAY_CHECK_FRONT_NAMES.has(name)) {
    const resolved = resolveProperty(tenant, args);
    if ("refusal" in resolved) return { text: resolved.refusal, isError: true };
    return stayCheckCall(h, tenant, resolved.property, name, resolved.args);
  }
  if (LOCK_FRONT_NAMES.has(name)) {
    const resolved = resolveProperty(tenant, args);
    if ("refusal" in resolved) return { text: resolved.refusal, isError: true };
    return lockCall(h, tenant, resolved.property, name, resolved.args);
  }
  if (CAMERA_FRONT_NAMES.has(name)) {
    const resolved = resolveProperty(tenant, args);
    if ("refusal" in resolved) return { text: resolved.refusal, isError: true };
    return camerasCall(h, tenant, resolved.property, name, resolved.args);
  }
  if (OVERSIGHT_FRONT_NAMES.has(name)) {
    const resolved = resolveProperty(tenant, args);
    if ("refusal" in resolved) return { text: resolved.refusal, isError: true };
    return oversightCall(h, tenant, resolved.property, name, resolved.args);
  }
  if (VISITS_FRONT_NAMES.has(name)) {
    const resolved = resolveProperty(tenant, args);
    if ("refusal" in resolved) return { text: resolved.refusal, isError: true };
    return visitsCall(h, tenant, resolved.property, name, resolved.args);
  }
  if (PACKAGE_FRONT_NAMES.has(name)) {
    const resolved = resolveProperty(tenant, args);
    if ("refusal" in resolved) return { text: resolved.refusal, isError: true };
    return packageCall(h, tenant, resolved.property, name, resolved.args);
  }
  if (GUEST_FRONT_NAMES.has(name)) {
    // An Airbnb message that names no property goes to the one whose listing it matches.
    if (name === "read_guest_message" && !namesProperty(args) && tenant.properties.length > 1) {
      const routed = guestMessageProperty(h.dataRoot, tenant, args, () => h.now());
      if ("refusal" in routed) return { text: routed.refusal, isError: true };
      return withRoutedProperty(guestCall(h, tenant, routed.property, name, (args ?? {}) as Record<string, unknown>), routed.property);
    }
    const resolved = resolveProperty(tenant, args);
    if ("refusal" in resolved) return { text: resolved.refusal, isError: true };
    return guestCall(h, tenant, resolved.property, name, resolved.args);
  }
  const fixer = FIXER_FRONT_NAMES.has(name);
  const shared = name === "preview_schedule" || name === "get_job_photos";
  if (fixer || shared) {
    const resolved = resolveProperty(tenant, args);
    if ("refusal" in resolved) return { text: resolved.refusal, isError: true };
    // Photos belong to the core that took them: a repair job's to Fixer Core, a turnover's to Cleaner Core (#250).
    if (name === "get_job_photos") {
      const from: Job = namesRepairJob(resolved.args) ? "fixer" : "cleaning";
      if (!caller.jobs.includes(from)) return { text: botLine(h, tenant, from), isError: true };
    }
    const answered = await repairCall(h, tenant, resolved.property, caller, name, resolved.args);
    if (answered) return answered;
  }
  const supply = SUPPLY_FRONT_NAMES.has(name);
  if (!supply && !CLEANING_TOOLS.has(name)) return { text: `There's no tool named ${name || "that"} here. Call get_state.`, isError: true };
  // A scheduled run checks every property at once: check_now with no property, on an account of two
  // or more, runs each property with Cleaner Core on and names it in the result.
  // Google events come from one property's calendar, so they always name their property.
  const googleEvents = args && typeof args === "object" && "googleEvents" in (args as Record<string, unknown>);
  // A held text on the shared line that nobody answered for 2 hours is dropped here, with a note for the host.
  if (name === "check_now") await sweepHeldTexts(h, tenant);
  if (name === "check_now" && !namesProperty(args) && !googleEvents && tenant.properties.length > 1) return checkEveryProperty(h, r, tenant, caller, args);
  // An Airbnb booking email that names no property goes to the one whose listing it matches.
  if (name === "read_booking_email" && !namesProperty(args) && tenant.properties.length > 1) {
    const routed = bookingEmailProperty(h.dataRoot, tenant, args, () => h.now(), featureOn(tenant, "booking-platforms", h.baseEnv()));
    if ("refusal" in routed) return { text: routed.refusal, isError: true };
    return cleaningTool(h, r, tenant, routed.property, caller, name, (args ?? {}) as Record<string, unknown>);
  }
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
  if (name === "check_now" && !reply.isError && tenant.properties.length > 1) return withNewsElsewhere(h, tenant, property, reply);
  return reply;
}

/**
 * check_now that names one property, on an account of two or more, names every other property with a note or a
 * message check_now hasn't returned yet. An alerts routine whose prompt names one property otherwise never reads
 * the others' (23 Nov Grok run: the cleaner's progress at 12 Scratch Lane never reached the chat).
 */
async function withNewsElsewhere(h: HostedCleaner, tenant: Tenant, checked: Property, reply: FrontReply): Promise<FrontReply> {
  if (!reply.structured) return reply;
  const waiting: string[] = [];
  for (const other of tenant.properties.filter((p) => p.id !== checked.id && p.flows.cleaning.on)) {
    const ctx = propertyContext(h, tenant, other);
    if (!existsSync(ctx.root)) continue;
    try {
      if (await liveDeskFor(ctx.root, ctx.env, () => h.now()).newsWaiting()) waiting.push(other.label);
    } catch {
      // A desk that can't be read now is read by the next check.
    }
  }
  if (waiting.length === 0) return reply;
  const line = `New notes or messages are waiting at ${waiting.join(", ")}. Call check_now with no property to read every property, and tell the host about each by its label.`;
  return withField(reply, "newsElsewhere", line);
}

/**
 * A Fixer Core call, or a shared one Fixer Core answers here: preview_schedule when Supply Core doesn't
 * run at the property, and get_job_photos for a repair job. Undefined hands it on to Supply Core or Cleaner Core.
 */
async function repairCall(h: HostedCleaner, tenant: Tenant, property: Property, caller: Caller, name: string, args: Record<string, unknown>): Promise<FrontReply | undefined> {
  const fixerOn = property.flows.fixer.on && runsFixer(caller.assistant);
  if (name === "preview_schedule") return !(property.flows.supplies.on && runsSupplies(caller.assistant)) && fixerOn ? fixerPreview(h, tenant, property, args) : undefined;
  if (name === "get_job_photos") {
    if (!namesRepairJob(args)) return undefined;
    return fixerOn ? fixerPhotos(h, tenant, property, args) : { text: flowOff("fixer", property.label), isError: true };
  }
  if (!property.flows.fixer.on) return { text: flowOff("fixer", property.label), isError: true };
  return (await fixerCall(h, tenant, property, caller.assistant, name, args, caller.grantId)) ?? { text: "Fixer Core couldn't answer that.", isError: true };
}

/** Adds draft.knownPeople to a property's setup draft, when the account has people on other properties. */
async function withDraftPeople(h: HostedCleaner, tenant: Tenant, property: Property, reply: FrontReply): Promise<FrontReply> {
  const draft = reply.structured?.draft;
  if (reply.isError || !reply.structured || !draft || typeof draft !== "object") return reply;
  const knownPeople = await draftPeople(h, tenant, property);
  if (knownPeople.length === 0) return reply;
  const structured = { ...reply.structured, draft: { ...(draft as Record<string, unknown>), knownPeople } };
  return { ...reply, text: JSON.stringify(structured), structured };
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

/**
 * How get_state is cut for this caller (#250). Undefined on an account where no core has its own bot connected:
 * get_state there is what it always was.
 */
function stateView(h: HostedCleaner, tenant: Tenant, caller: Caller): StateView | undefined {
  if (!hasCoreBot(h, tenant)) return undefined;
  if (caller.job) return { jobs: caller.jobs, sendTo: teamLine, ...(hasOwnRoutine(h, tenant, caller.grantId) ? {} : { alertsNote: noRoutineNote(caller.job) }) };
  return { jobs: caller.jobs, team: teamView(h, tenant, h.now()), perFlow: team(h, tenant), sendTo: teamLine };
}

function propertyStates(h: HostedCleaner, r: HostedRequest, tenant: Tenant, caller: Caller): PropertyStates {
  const cleaning = async (property: Property, args: Record<string, unknown>): Promise<FrontReply> => {
    const desk = await cleaningTool(h, r, tenant, property, caller, "get_state", args);
    // A setup draft names the people already on the account's other properties (#166).
    const reply = await withDraftPeople(h, tenant, property, desk);
    // Cleaner Core's get_state carries one Supply Core line while Supply Core is on for the property.
    const line = !reply.isError && reply.structured ? suppliesLine(h, tenant, property) : undefined;
    return withOffers(property, withLocks(property, withRepairs(property, line && reply.structured ? withField(reply, "supplies", line) : reply)));
  };
  // With connected locks on the service, Cleaner Core's and Fixer Core's get_state carry the property's lock status, never a code.
  const withLocks = (property: Property, reply: FrontReply): FrontReply => {
    if (reply.isError || !reply.structured || listedLockFront(h, tenant).length === 0) return reply;
    const status = lockDesk(h, tenant, property).status().structured;
    if (!status) return reply;
    // A host who answered the locks offer isn't asked again here.
    const asked = (property.offersAnswered ?? []).includes("locks");
    const summary = status.connected
      ? { connected: true, devices: status.devices, problems: status.problems }
      : { connected: false, ...(asked ? {} : { next: "Ask the host whether they have a smart lock that works with an app. connect_lock connects it, so each cleaner and pro gets their own code." }) };
    return withField(reply, "locks", summary);
  };
  // Cleaner Core's and Supply Core's get_state carry one Fixer Core line while Fixer Core is on for the property.
  const withRepairs = (property: Property, reply: FrontReply): FrontReply => {
    const line = !reply.isError && reply.structured ? repairsLine(h, tenant, property, caller.assistant) : undefined;
    return line ? withField(reply, "repairs", line) : reply;
  };
  // Once the property's core setup is done, get_state offers the next feature that's on for the account and fits here.
  const withOffers = (property: Property, reply: FrontReply): FrontReply => {
    const s = reply.structured;
    if (reply.isError || !s || s.ask || s.draft) return reply;
    // Cleaner Core is live once its checks ran (get_state then lists turns); Supply and Fixer Core once activated.
    if (property.flows.cleaning.on && !("turns" in s)) return reply;
    if ([s.supplies, s.repairs].some((line) => typeof line === "string" && line.endsWith("setup not finished."))) return reply;
    const offer = nextOffer(offerContext(h, tenant, property, caller), caller.assistant);
    return offer ? offerFirst(reply, offer) : reply;
  };
  // The offer leads next, so it isn't read as an extra after a next that waits on a booking (#280 item 4), and the
  // lock status drops its own smart-lock ask, which the offer makes with Yes and Skip.
  const offerFirst = (reply: FrontReply, offer: Record<string, unknown>): FrontReply => {
    const s = reply.structured!;
    const locks = s.locks && typeof s.locks === "object" ? Object.fromEntries(Object.entries(s.locks as Record<string, unknown>).filter(([key]) => key !== "next")) : undefined;
    const lead = `In a chat with the host, never on a routine run, first make the feature offer in offer, as its next says.${typeof s.next === "string" && s.next ? ` Then: ${s.next}` : ""}`;
    const structured = { ...s, ...(locks ? { locks } : {}), next: lead, offer };
    return { ...reply, text: JSON.stringify(structured), structured };
  };
  const supplies = async (property: Property): Promise<FrontReply> => withOffers(property, withRepairs(property, supplyReplyFor(caller.assistant, "get_supply_state", await supplyDesk(h, tenant, property).state())));
  const fixer = async (property: Property): Promise<FrontReply> => withOffers(property, withLocks(property, await fixerDesk(h, tenant, property).state()));
  /** The step's name in a flow's own state, and nothing else of it. */
  const stepOf = (reply: FrontReply | undefined): string | undefined => {
    // A setup still in its draft (#166) has no ask yet: its next step is the draft.
    if (reply?.structured?.draft) return "draft";
    const ask = reply?.structured?.ask as { step?: unknown } | undefined;
    return typeof ask?.step === "string" ? ask.step : undefined;
  };
  // No desk is asked for a flow the caller doesn't run (#250), but for one step's name in the team view.
  const runs = (property: Property, flow: FlowName) => property.flows[flow].on && caller.jobs.includes(flow);
  return {
    cleaning,
    supplies,
    fixer,
    next: async (property) =>
      stepOf(
        runs(property, "cleaning")
          ? await cleaning(property, {})
          : runs(property, "supplies") && runsSupplies(caller.assistant)
            ? await supplies(property)
            : runs(property, "fixer") && runsFixer(caller.assistant)
              ? await fixer(property)
              : undefined,
      ),
    step: async (property, flow) => {
      if (flow === "cleaning") {
        // Asked for another bot's flow, so it must use nothing up: the desk's own get_state shows a one-time line.
        const ctx = propertyContext(h, tenant, property);
        const desk = liveDeskFor(ctx.root, ctx.env, () => h.now());
        await desk.chooseCleaning();
        return desk.peekStep();
      }
      if (flow === "supplies") return runsSupplies(caller.assistant) ? stepOf(await supplies(property)) : undefined;
      return runsFixer(caller.assistant) ? stepOf(await fixer(property)) : undefined;
    },
  };
}

/** The names of every feature tool listed for the account now: what get_state's offers are worked out from. */
function listedFeatureTools(h: HostedCleaner, tenant: Tenant): Set<string> {
  const listed = [
    ...listedHoursFront(h, tenant),
    ...listedStayCheckFront(h, tenant),
    ...listedOversightFront(h, tenant),
    ...listedVisitsFront(h, tenant),
    ...listedPackageFront(h, tenant),
    ...listedGuestFront(h, tenant),
    ...listedLockFront(h, tenant),
  ];
  return new Set(listed.map((tool) => String(tool.name)));
}

/**
 * What a property's feature offers are worked out from, for this caller: the feature tools listed for the account
 * that the caller's jobs may call (#250). A chat with every job sees them all; a core's own bot is offered only
 * what it can run.
 */
function offerContext(h: HostedCleaner, tenant: Tenant, property: Property, caller: Caller): OfferContext {
  return {
    listed: new Set([...listedFeatureTools(h, tenant)].filter((name) => mayCall(name, caller))),
    lockConnected: listedLockFront(h, tenant).length > 0 && lockDesk(h, tenant, property).status().structured?.connected === true,
    supplies: property.flows.supplies.on,
    answered: property.offersAnswered ?? [],
  };
}

/**
 * get_state's offered: the host answered that feature offer (yes or skip) on the property, so it isn't made again.
 * Returns the arguments without it, for the property's own get_state. A core's own bot answers only an offer it
 * could have been made.
 */
function answerOffer(h: HostedCleaner, tenant: Tenant, caller: Caller, args: unknown): { args: unknown; refusal?: string } {
  if (!args || typeof args !== "object" || !("offered" in args)) return { args };
  const { offered, ...rest } = args as Record<string, unknown>;
  if (!isOfferId(offered)) return { args: rest, refusal: `offered is one of ${OFFER_IDS.join(", ")}.` };
  const resolved = resolveProperty(tenant, rest);
  if ("refusal" in resolved) return { args: rest, refusal: resolved.refusal };
  if (caller.job && !offersFor(offerContext(h, tenant, resolved.property, caller)).some((offer) => offer.offer === offered)) return { args: rest, refusal: elsewhereLine("property", false) };
  h.registry.noteOfferAnswered(tenant.id, resolved.property.id, offered);
  return { args: rest };
}

/** A reply with one more field in its structured content and JSON text. */
function withField(reply: FrontReply, key: string, value: unknown): FrontReply {
  const structured = { ...(reply.structured ?? {}), [key]: value };
  return { ...reply, text: JSON.stringify(structured), structured };
}

/** True when touring's get_state says the publish milestone is done. */
function isPublished(state: Record<string, unknown>): boolean {
  const milestones = Array.isArray(state.milestones) ? (state.milestones as { id?: string; status?: string }[]) : [];
  return milestones.some((m) => m.id === "publish" && m.status === "done");
}

/**
 * Adds the notes, and a stopped-task warning when `warn` gives one, to a tools/call reply's
 * structured content and its JSON text. Unchanged when there's nothing to add. An error reply
 * never carries the notes. `delivered` is true only when the notes went into the reply.
 */
function withNotices(body: string, notices: string[], warn?: (state: Record<string, unknown>) => string | undefined): { body: string; delivered: boolean } {
  try {
    const reply = JSON.parse(body) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[] } };
    const result = reply.result;
    if (!result?.structuredContent) return { body, delivered: false };
    const carried = result.isError === true ? [] : notices;
    const warning = warn?.(result.structuredContent);
    if (carried.length === 0 && !warning) return { body, delivered: false };
    result.structuredContent = { ...result.structuredContent, ...(carried.length > 0 ? { serviceNotices: carried } : {}), ...(warning ? { warning } : {}) };
    const first = result.content?.[0];
    if (first?.type === "text") first.text = JSON.stringify(result.structuredContent);
    return { body: JSON.stringify(reply), delivered: carried.length > 0 };
  } catch {
    return { body, delivered: false };
  }
}

/** How long a call waits for a touring process that is still starting. */
const STARTING_WAIT_MS = 30_000;

/** The touring process for this tenant, once it has seen this connection's initialize. */
async function touringTarget(h: HostedCleaner, tenantId: string, caller: Caller, isInitialize = false): Promise<WorkerTarget | undefined> {
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
  if (isInitialize) {
    introduced.set(caller.grantId, target.key);
    return target;
  }
  const init = initializes.get(caller.grantId);
  if (init && introduced.get(caller.grantId) !== target.key) {
    await callWorkerMcp(target, init, {}, caller.assistant);
    await callWorkerMcp(target, Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })), {}, caller.assistant);
    introduced.set(caller.grantId, target.key);
  }
  return target;
}

async function touringPass(h: HostedCleaner, r: HostedRequest, tenant: Tenant, caller: Caller, raw?: Buffer, isInitialize = false): Promise<void> {
  const target = await touringTarget(h, tenant.id, caller, isInitialize);
  if (!target) return r.send(503, JSON_TYPE, JSON.stringify({ error: { message: TOURING_DOWN } }));
  return forwardMcp(target, r, raw, caller.assistant);
}

async function touringCall(h: HostedCleaner, tenantId: string, caller: Caller, raw: Buffer, r: HostedRequest): Promise<{ status: number; body: string } | undefined> {
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
