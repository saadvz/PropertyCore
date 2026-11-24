import type { CleanerAssistant } from "../cleaner-core/assistant";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import type { Tenant, TenantConnection } from "../cleaner-core/hosted/registry";
import { ROUTINE_NAMES } from "../cleaner-core/hosted/tenantEnv";
import { featureOn } from "../features/features";
import { CORE_JOBS, coreBot, holderOf, isTeam, JOB_NAMES, JOB_PATHS, jobOfPath, jobsFor, mainConnection, type CoreJob, type Job, type JobDeps } from "../jobs/jobs";
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

/** A core the Property Core chat should make its own bot for: its job, its name, and the address that bot connects to. */
export interface NewBot {
  job: CoreJob;
  name: string;
  address: string;
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
  return due.length > 0 ? due.map((job) => ({ job, name: JOB_NAMES[job], address: JOB_PATHS[job] })) : undefined;
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
  h.revokeGrant?.(grantId);
  h.secrets.deleteConnection(tenantId, grantId);
  if (h.registry.get(tenantId)?.connections.some((c) => c.grantId === grantId)) h.registry.disconnect(tenantId, grantId);
  const left = h.registry.get(tenantId);
  if (left) noteTeamChanged(left);
}
