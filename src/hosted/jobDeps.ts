import type { CleanerAssistant } from "../cleaner-core/assistant";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import type { Tenant, TenantConnection } from "../cleaner-core/hosted/registry";
import { ROUTINE_NAMES } from "../cleaner-core/hosted/tenantEnv";
import { featureOn } from "../features/features";
import { CORE_JOBS, coreBot, holderOf, isSeat, isTeam, JOB_NAMES, jobOfPath, jobsFor, mainConnection, seatId, type CoreJob, type Job, type JobDeps } from "../jobs/jobs";
import { carryConnection } from "./routineCarry";
import { noteInitialized } from "../mcp/toolListChanged";
import { toolsFor } from "./serviceTools";

/**
 * The rule in src/jobs/jobs.ts, asked for one account on the shared service (#250): the account's `bots` switch, the
 * live grants, and each connection's saved Alerts routine.
 */

export const BOTS_OFF = "Separate bots aren't turned on for this account. Connect this chat to Property Core instead.";
export const BOTS_GROK_ONLY = "Separate bots work with Grok Bot only. Connect this chat to Property Core instead.";
export const BOTS_NEED_MAIN = "Set up the Property Core bot on Grok Bot first, then connect this one.";

export function jobDeps(h: HostedCleaner, tenant: Tenant): JobDeps {
  // One read of the grants where the service offers it, as the request path does.
  const live = h.liveGrantIds?.();
  return {
    botsOn: featureOn(tenant, "bots", h.baseEnv()),
    isLive: (grantId) => (live ? live.has(grantId) : h.grantLive(grantId)),
    hasRoutine: (grantId) => {
      const saved = h.secrets.connection(tenant.id, grantId);
      return ROUTINE_NAMES.every((name) => Boolean(saved[name]?.trim()));
    },
  };
}

/** The connection woken for this job's news. */
export function holder(h: HostedCleaner, tenant: Tenant, job: Job): TenantConnection | undefined {
  return holderOf(tenant, job, jobDeps(h, tenant));
}

/** Whether at least one core job is held by its own bot. */
export function team(h: HostedCleaner, tenant: Tenant): boolean {
  return isTeam(tenant, jobDeps(h, tenant));
}

/** Whether any core has its own bot connected, holding its job yet or not. False with the account's `bots` switch off. */
export function hasCoreBot(h: HostedCleaner, tenant: Tenant): boolean {
  const deps = jobDeps(h, tenant);
  return CORE_JOBS.some((job) => coreBot(tenant, job, deps) !== undefined);
}

/** A core the Property Core chat should make its own bot for: its job, its name, and the `bot` value that bot sends on every call. */
export interface NewBot {
  job: CoreJob;
  name: string;
  bot: CoreJob;
}

/**
 * The cores that run at some property and have no bot of their own connected yet, for the Property Core chat on Grok
 * Bot with the account's `bots` switch on. Undefined anywhere else, and when there are none, so get_state is unchanged.
 */
export function newBots(h: HostedCleaner, tenant: Tenant, caller: { job?: CoreJob; assistant: CleanerAssistant }): NewBot[] | undefined {
  if (caller.job || caller.assistant !== "grok" || toolsFor(tenant) !== "properties") return undefined;
  const deps = jobDeps(h, tenant);
  if (!deps.botsOn) return undefined;
  const due = CORE_JOBS.filter((job) => tenant.properties.some((property) => property.flows[job].on) && coreBot(tenant, job, deps) === undefined);
  return due.length > 0 ? due.map((job) => ({ job, name: JOB_NAMES[job], bot: job })) : undefined;
}

/**
 * The jobs a signed-in caller has. At a core's address with no matching connection on the account: none. At /mcp
 * with none on the account (a connection from before connections were kept): as a /mcp connection.
 */
export function callerJobs(h: HostedCleaner, tenant: Tenant, grantId: string, assistant: CleanerAssistant, path: string): Job[] {
  const job = jobOfPath(path);
  const known = tenant.connections.find((c) => c.grantId === grantId);
  if (job) return known?.job === job ? jobsFor(tenant, known, jobDeps(h, tenant)) : [];
  const deps = jobDeps(h, tenant);
  return jobsFor(tenant, known && !known.job ? known : { grantId, assistant, connectedAt: "" }, { ...deps, isLive: (id) => id === grantId || deps.isLive(id) });
}

/**
 * Why a sign-in at a core's address is refused for this account, or undefined to let it through. A core's bot is
 * for Grok Bot only, on an account whose `bots` switch is on and whose Property Core chat is already a Grok Bot.
 */
export function admitBot(h: HostedCleaner, tenant: Tenant | undefined, assistant: CleanerAssistant, path: string): string | undefined {
  if (!jobOfPath(path)) return undefined;
  if (!tenant || !featureOn(tenant, "bots", h.baseEnv())) return BOTS_OFF;
  if (assistant !== "grok") return BOTS_GROK_ONLY;
  const main = mainConnection(tenant, jobDeps(h, tenant));
  if (!main || main.assistant !== "grok" || toolsFor(tenant) !== "properties") return BOTS_NEED_MAIN;
  return undefined;
}

/**
 * Tells every other open chat of the account that its tool list changed: a core's bot took hold of its job, went
 * away, or the account's `bots` switch changed. A chat with no open stream hears it when it next opens one.
 */
export function noteTeamChanged(tenant: Tenant, exceptGrantId?: string): void {
  for (const connection of tenant.connections) if (connection.grantId !== exceptGrantId) noteInitialized(`grant:${connection.grantId}`);
}

/** What /admin's Disconnect does, in one place: end the grant, delete the connection's saved values, and drop it from the account. */
export function dropConnection(h: HostedCleaner, tenantId: string, grantId: string): void {
  // A core's bot on the shared connector has no grant of its own: the Property Core bot's sign-in stays.
  if (!isSeat(grantId)) h.revokeGrant?.(grantId);
  h.secrets.deleteConnection(tenantId, grantId);
  if (h.registry.get(tenantId)?.connections.some((c) => c.grantId === grantId)) h.registry.disconnect(tenantId, grantId);
  const left = h.registry.get(tenantId);
  if (left) noteTeamChanged(left);
}

/** What a core's bot on the shared connector is told when `bot` names no core. */
export const BOT_ARG_VALUES = "bot is cleaning, supplies or fixer, sent only by a Cleaner Core, Supply Core or Fixer Core bot. The Property Core bot leaves it out.";

/** The `bot` argument every tool takes on a Grok account with the switch on: how a core's bot on the shared connector says which it is. */
export const BOT_ARG = {
  type: "string",
  enum: [...CORE_JOBS],
  description: "Only for a Cleaner Core, Supply Core or Fixer Core bot: your own flow, cleaning, supplies or fixer, on every call. The Property Core bot leaves it out.",
} as const;

/** Whether this /mcp caller's tools take `bot`: Grok Bot, a properties account, and the account's `bots` switch on. */
export function takesBotArg(h: HostedCleaner, tenant: Tenant, caller: { job?: CoreJob; assistant: CleanerAssistant }): boolean {
  return !caller.job && caller.assistant === "grok" && toolsFor(tenant) === "properties" && featureOn(tenant, "bots", h.baseEnv());
}

/**
 * The connection a call with `bot` is for (#250): the core's bot on the account's shared Property Core connector. The
 * first call records it, so it is a core connection like one that signed in at the core's own address, and it takes
 * that one's place. Its routine and saved values are kept under its own id. Refused off Grok, with the switch off,
 * or for a value that isn't a core.
 */
export function seatFor(h: HostedCleaner, tenant: Tenant, caller: { grantId: string; assistant: CleanerAssistant; job?: CoreJob }, bot: unknown): { connection: TenantConnection } | { refusal: string } {
  if (!featureOn(tenant, "bots", h.baseEnv())) return { refusal: BOTS_OFF };
  if (caller.assistant !== "grok") return { refusal: BOTS_GROK_ONLY };
  if (caller.job || toolsFor(tenant) !== "properties") return { refusal: BOT_ARG_VALUES };
  const job = CORE_JOBS.find((one) => one === bot);
  if (!job) return { refusal: BOT_ARG_VALUES };
  const id = seatId(caller.grantId, job);
  const known = tenant.connections.find((c) => c.grantId === id);
  if (known) return { connection: known };
  const connection: TenantConnection = { grantId: id, assistant: caller.assistant, job, connectedAt: h.now().toISOString() };
  const { replaced } = h.registry.connect(tenant.id, connection);
  // The same bot after the host signed in again, or one that signed in at the core's address: its routine stays with this one.
  for (const old of replaced) {
    carryConnection(h, tenant.id, old, id);
    dropConnection(h, tenant.id, old);
  }
  return { connection };
}

/** The jobs a shared connector lists: its own, and those of the core bots that call over it. */
export function sharedJobs(h: HostedCleaner, tenant: Tenant, grantId: string, own: Job[]): Job[] {
  const deps = jobDeps(h, tenant);
  const seats = tenant.connections.filter((c) => c.job && c.grantId.startsWith(`${grantId}#`));
  const jobs = new Set<Job>([...own, ...seats.flatMap((seat) => jobsFor(tenant, seat, deps))]);
  return (["property", ...CORE_JOBS] as Job[]).filter((job) => jobs.has(job));
}
