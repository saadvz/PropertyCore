import type { CleanerAssistant } from "../cleaner-core/assistant";

/**
 * A bot for each core (saadvz/PropertyCore#250). Every connection carries a job, taken from the address its sign-in
 * grant is bound to, and this file is the whole rule for who has and who holds each one:
 *
 * A core's job is held by its own bot once that bot is connected and has saved its Alerts routine. Until then, and
 * whenever that bot goes away, the Property Core connection holds it.
 *
 * A bot HAS a job when it may list and call that job's tools. A bot HOLDS a job when it is also the one woken for
 * that job's news. Each job has exactly one holder. Nothing is saved for a hand-over: every answer is computed from
 * the account's connections, their saved routines and the account's `bots` switch, on each request.
 */

export const JOBS = ["property", "cleaning", "supplies", "fixer"] as const;
export type Job = (typeof JOBS)[number];
export type CoreJob = Exclude<Job, "property">;
export const CORE_JOBS: readonly CoreJob[] = ["cleaning", "supplies", "fixer"];

/** The address each core's own bot connects to. Everything else connects to /mcp. */
export const JOB_PATHS: Record<CoreJob, string> = { cleaning: "/mcp/cleaner", supplies: "/mcp/supply", fixer: "/mcp/fixer" };
export const JOB_NAMES: Record<Job, string> = { property: "Property Core", cleaning: "Cleaner Core", supplies: "Supply Core", fixer: "Fixer Core" };

/** A core's bot that hasn't called for this long is quiet: the stopped-task threshold (CHATGPT_CHECK_GAP_MS), for a check that runs every hour. */
export const QUIET_MS = 150 * 60_000;
/** Supply Core's check runs once a day, so its bot is quiet only after a day and two hours' slack. */
export const SUPPLY_QUIET_MS = 26 * 60 * 60_000;

/** How long this core's bot may go without a call before it's quiet: a missed check, by how often its own check runs. */
export function quietAfterMs(job: CoreJob): number {
  return job === "supplies" ? SUPPLY_QUIET_MS : QUIET_MS;
}

export function jobOfPath(path: string): CoreJob | undefined {
  return CORE_JOBS.find((job) => JOB_PATHS[job] === path);
}

/** A connection as the rule reads it. TenantConnection satisfies it. */
export interface JobConnection {
  grantId: string;
  assistant: CleanerAssistant;
  connectedAt: string;
  /** Set for a connection at a core's address. Unset: a /mcp connection. */
  job?: CoreJob;
  lastSeenAt?: string;
}

/** An account as the rule reads it. Tenant satisfies it. */
export interface JobAccount {
  primaryGrantId?: string;
  connections: JobConnection[];
}

export interface JobDeps {
  /** The account's `bots` switch, as featureOn answers it. Off: every core connection is ignored. */
  botsOn: boolean;
  isLive(grantId: string): boolean;
  /** Whether this connection has saved its Alerts routine. */
  hasRoutine(grantId: string): boolean;
}

const byAge = (a: JobConnection, b: JobConnection) => Date.parse(a.connectedAt) - Date.parse(b.connectedAt);

/** The primary among live connections with no job: primaryGrantId when it is one, else the oldest. Never a core connection. */
export function mainConnection<C extends JobConnection>(account: { primaryGrantId?: string; connections: C[] }, deps: Pick<JobDeps, "isLive">): C | undefined {
  const own = account.connections.filter((c) => !c.job && deps.isLive(c.grantId));
  return own.find((c) => c.grantId === account.primaryGrantId) ?? [...own].sort(byAge)[0];
}

/** The live connection at this core's address, the newest when there are two. Undefined when the switch is off. */
export function coreBot<C extends JobConnection>(account: { connections: C[] }, job: CoreJob, deps: JobDeps): C | undefined {
  if (!deps.botsOn) return undefined;
  return account.connections.filter((c) => c.job === job && deps.isLive(c.grantId)).sort(byAge).at(-1);
}

/** The core's own bot when it holds its job: connected, live, and its routine saved. */
function ownHolder<C extends JobConnection>(account: { connections: C[] }, job: CoreJob, deps: JobDeps): C | undefined {
  const bot = coreBot(account, job, deps);
  return bot && deps.hasRoutine(bot.grantId) ? bot : undefined;
}

/** The connection woken for this job's news: the core's own bot once its routine is saved, else the primary /mcp connection. */
export function holderOf<C extends JobConnection>(account: { primaryGrantId?: string; connections: C[] }, job: Job, deps: JobDeps): C | undefined {
  return (job === "property" ? undefined : ownHolder(account, job, deps)) ?? mainConnection(account, deps);
}

/** The jobs whose tools this connection may list and call now. */
export function jobsFor(account: JobAccount, connection: JobConnection, deps: JobDeps): Job[] {
  if (!deps.isLive(connection.grantId)) return [];
  if (connection.job) return coreBot(account, connection.job, deps)?.grantId === connection.grantId ? [connection.job] : [];
  return ["property", ...CORE_JOBS.filter((job) => !ownHolder(account, job, deps))];
}

/** A team: at least one core job is held by its own bot. */
export function isTeam(account: JobAccount, deps: JobDeps): boolean {
  return CORE_JOBS.some((job) => ownHolder(account, job, deps) !== undefined);
}

/** No call for its job's quiet time, counted from the last call, or from connecting when it never called. */
export function isQuiet(connection: JobConnection, now: Date): boolean {
  const last = Date.parse(connection.lastSeenAt ?? connection.connectedAt);
  return Number.isFinite(last) && now.getTime() - last >= (connection.job ? quietAfterMs(connection.job) : QUIET_MS);
}
