import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { propertyUpdateEvent } from "../alerts/operatorEvents";
import { propertyFolder } from "../cleaner-core/hosted/properties";
import { tenantFolder, type Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import { formatWhen } from "../hub/calendar";
import { readHubFile } from "../hub/store";
import { CORE_JOBS, coreBot, isQuiet, JOB_NAMES, quietAfterMs, type CoreJob } from "../jobs/jobs";
import { onWake } from "../jobs/wakeListeners";
import { ConfirmationBook } from "../operator/confirmations";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { dropConnection, hasCoreBot, holder, jobDeps } from "./jobDeps";
import type { ToolCaller } from "./jobTools";
import { wakeHolder } from "./jobWake";
import type { FrontReply } from "./serviceTools";

/**
 * Looking after the account's bots from the Property Core chat (#250): telling the host once when a core's own bot
 * has gone quiet with news waiting, and remove_bot, which hands a core back after the host's yes. The server can't
 * tell a deleted bot from a quiet one, so it only ever says the bot is quiet. A quiet line names the bot and a time,
 * and never carries anything from that core's news.
 */

export const REMOVE_BOT = "remove_bot";
/** In the account's folder: for each core whose bot went quiet with news waiting, since when, and when the host was told. */
export const QUIET_BOTS_FILE = "quiet-bots.json";
const APPROVALS_FILE = "bot-approvals.json";

type QuietFile = Partial<Record<CoreJob, { since: string; toldAt?: string }>>;

const quietPath = (h: HostedCleaner, tenantId: string) => join(tenantFolder(h.dataRoot, tenantId), QUIET_BOTS_FILE);

function readQuiet(h: HostedCleaner, tenantId: string): QuietFile {
  const path = quietPath(h, tenantId);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: QuietFile = {};
  for (const job of CORE_JOBS) {
    const entry = (raw as Record<string, unknown>)[job] as { since?: unknown; toldAt?: unknown } | undefined;
    if (entry && typeof entry.since === "string") out[job] = { since: entry.since, ...(typeof entry.toldAt === "string" ? { toldAt: entry.toldAt } : {}) };
  }
  return out;
}

const writeQuiet = (h: HostedCleaner, tenantId: string, file: QuietFile) => writeJsonAtomic(quietPath(h, tenantId), file);

/** When this core's own bot last called, while it holds the job and has been quiet since. Undefined for a bot that isn't quiet, doesn't hold its job, or is gone. */
function quietSince(h: HostedCleaner, tenant: Tenant, job: CoreJob): string | undefined {
  const held = holder(h, tenant, job);
  if (!held?.job || !isQuiet(held, h.now())) return undefined;
  return held.lastSeenAt ?? held.connectedAt;
}

/**
 * Called when a wake-up is queued for `job`'s routine. When the job's holder is its own bot and quiet, and the host
 * hasn't been sent to it for this quiet spell yet: note it and send one property.update, so the Property Core bot
 * reads the line with check_alerts.
 */
export async function noteQuiet(h: HostedCleaner, tenantId: string, job: CoreJob): Promise<void> {
  const tenant = h.registry.get(tenantId);
  if (!tenant || tenant.disabled) return;
  const since = quietSince(h, tenant, job);
  if (!since) return;
  const file = readQuiet(h, tenantId);
  if (file[job]?.since === since) return;
  file[job] = { since };
  writeQuiet(h, tenantId, file);
  await wakeHolder(h, tenant, "property", propertyUpdateEvent(h.now()));
}

/** Registers the property's folder so a wake-up its Cleaner Core or Fixer Core desk queues is checked for a quiet bot. */
export function listenForQuiet(h: HostedCleaner, tenantId: string, root: string): void {
  onWake(root, (job) => void noteQuiet(h, tenantId, job).catch(() => undefined));
}

/** A job's quiet time in the host's words: Supply Core's check runs once a day, the others' every hour. */
const quietSpan = (job: CoreJob) => (quietAfterMs(job) >= 24 * 60 * 60_000 ? "a day" : "2 hours");

/**
 * The line for the host. With the property's time zone it says when the bot last checked in, with the day when that
 * wasn't today; without one it says only how long it's been at least.
 */
export function quietLine(job: CoreJob, since: Date, timeZone: string | undefined, now?: Date): string {
  let when = `in over ${quietSpan(job)}`;
  if (timeZone) {
    const at = formatWhen(since.toISOString(), timeZone);
    const today = now ? formatWhen(now.toISOString(), timeZone).day : at.day;
    when = at.day === today ? `since ${at.time}` : `since ${at.day} at ${at.time}`;
  }
  return `The ${JOB_NAMES[job]} bot hasn't checked in ${when}, and it has news waiting. Open it, or tell me if you removed it.`;
}

/** The time zone of the account's first property that has one. */
function accountTimeZone(h: HostedCleaner, tenant: Tenant): string | undefined {
  for (const property of tenant.properties) {
    try {
      const zone = readHubFile(propertyFolder(h.dataRoot, tenant.id, property))?.property.timeZone;
      if (zone) return zone;
    } catch {
      // A property whose hub can't be read has no time zone to offer.
    }
  }
  return undefined;
}

/**
 * One line per quiet bot the host hasn't been told about, each marked told. An entry whose bot has called since, no
 * longer holds its job or is gone is dropped, told or not.
 */
export function quietLines(h: HostedCleaner, tenant: Tenant): string[] {
  const file = readQuiet(h, tenant.id);
  const jobs = CORE_JOBS.filter((job) => file[job]);
  if (jobs.length === 0) return [];
  const now = h.now();
  const lines: string[] = [];
  const next: QuietFile = {};
  let zone: string | undefined;
  for (const job of jobs) {
    const entry = file[job]!;
    if (quietSince(h, tenant, job) !== entry.since) continue;
    if (!entry.toldAt) {
      zone ??= accountTimeZone(h, tenant);
      lines.push(quietLine(job, new Date(entry.since), zone, now));
    }
    next[job] = { since: entry.since, toldAt: entry.toldAt ?? now.toISOString() };
  }
  if (JSON.stringify(next) !== JSON.stringify(file)) writeQuiet(h, tenant.id, next);
  return lines;
}

const Args = z.strictObject({ bot: z.enum(["cleaning", "supplies", "fixer"]), confirmation: z.string().trim().min(1).max(40).optional() });

const TOOL = {
  name: REMOVE_BOT,
  title: "Remove a core's bot",
  description:
    "Disconnects a core's own bot and brings that core back to this chat. Use it only when the host says they deleted or no longer want the Cleaner Core, Supply Core or Fixer Core bot. The first call changes nothing: it returns what will happen and a confirmation. Ask the host, and only after their yes call it again with that confirmation.",
  inputSchema: {
    type: "object",
    properties: {
      bot: { type: "string", enum: ["cleaning", "supplies", "fixer"], description: "Which core's bot: cleaning for Cleaner Core, supplies for Supply Core, fixer for Fixer Core." },
      confirmation: { type: "string", maxLength: 40, description: "The confirmation code from the first call, after the host said yes." },
    },
    required: ["bot"],
    additionalProperties: false,
  },
};

/** True when this caller manages the account's bots: it has the Property Core job, and a core has its own bot connected. */
function manages(h: HostedCleaner, tenant: Tenant, caller: ToolCaller): boolean {
  return caller.jobs.includes("property") && hasCoreBot(h, tenant);
}

/** remove_bot as tools/list shows it. An account with one bot lists what it always listed. */
export function listedBotTools(h: HostedCleaner, tenant: Tenant, caller: ToolCaller): Record<string, unknown>[] {
  return manages(h, tenant, caller) ? [TOOL] : [];
}

export const BOT_APPROVAL_STALE = "That approval has expired or doesn't match. Ask the host again.";
/** What remove_bot's first call says will happen. */
export const removeBotQuestion = (job: CoreJob) => `This disconnects the ${JOB_NAMES[job]} bot and deletes its Alerts routine. ${JOB_NAMES[job]} comes back to this chat. Ask the host, then call remove_bot again with this confirmation.`;
export const botRemovedLine = (job: CoreJob) => `The ${JOB_NAMES[job]} bot is disconnected. ${JOB_NAMES[job]} is back in this chat.`;
export const noBotLine = (job: CoreJob) => `There's no ${JOB_NAMES[job]} bot on this account.`;
const fail = (text: string): FrontReply => ({ text, isError: true });

/** The account's approvals for removing a bot, kept in its folder across restarts. */
function approvals(h: HostedCleaner, tenant: Tenant): ConfirmationBook {
  return new ConfirmationBook(10 * 60_000, () => h.now().getTime(), { file: join(tenantFolder(h.dataRoot, tenant.id), APPROVALS_FILE) });
}

export async function removeBotCall(h: HostedCleaner, tenant: Tenant, caller: ToolCaller, args: unknown): Promise<FrontReply> {
  if (!manages(h, tenant, caller)) return fail(`There's no tool named ${REMOVE_BOT} here. Call get_state.`);
  const parsed = Args.safeParse(args ?? {});
  if (!parsed.success) return fail("remove_bot takes bot (cleaning, supplies or fixer) and, on the second call, confirmation.");
  const job = parsed.data.bot;
  const name = JOB_NAMES[job];
  const account = h.registry.get(tenant.id) ?? tenant;
  const bot = coreBot(account, job, jobDeps(h, account));
  if (!bot) return fail(noBotLine(job));
  // The approval is for this bot's own connection: a bot connected since is never removed by an older yes.
  const fingerprint = createHash("sha256").update(`remove-bot|${job}|${bot.grantId}`).digest("hex");
  const book = approvals(h, tenant);
  if (!parsed.data.confirmation) {
    const question = removeBotQuestion(job);
    return { text: question, structured: { question, confirmation: book.issue("remove-bot", job, fingerprint, question) }, isError: false };
  }
  try {
    book.redeem(parsed.data.confirmation, "remove-bot", job, fingerprint);
  } catch {
    return fail(BOT_APPROVAL_STALE);
  }
  dropConnection(h, tenant.id, bot.grantId);
  const quiet = readQuiet(h, tenant.id);
  if (quiet[job]) {
    delete quiet[job];
    writeQuiet(h, tenant.id, quiet);
  }
  h.log(`${tenant.id}'s ${name} bot was removed from its Property Core chat.`);
  return { text: botRemovedLine(job), structured: { removed: job }, isError: false };
}

/** One core in the Property Core chat's view of the account's bots. Nothing here is from the core's own news or setup. */
export interface TeamEntry {
  job: CoreJob;
  /** Who is woken for this core's news: its own bot, or the Property Core chat. */
  holder: "own bot" | "this chat";
  /** The own bot's agent, such as "grok". */
  agent?: string;
  connectedAt?: string;
  lastSeenAt?: string;
  /** Whether the holder has saved an Alerts routine. */
  alerts: "connected" | "not connected";
  quiet?: true;
  note?: string;
}

export const quietNote = (job: CoreJob) => `The ${JOB_NAMES[job]} bot hasn't checked in for over ${quietSpan(job)}.`;
/** A core's bot that is connected but doesn't hold its job yet. */
export const setupWaitingNote = (job: CoreJob) => `The ${JOB_NAMES[job]} bot is connected but hasn't saved its Alerts routine yet, so ${JOB_NAMES[job]} is still in this chat.`;

const ROUTINE_TOOL: Record<CoreJob, string> = { cleaning: "save_alert_routine", supplies: "check_alerts with connect: true", fixer: "save_repair_alerts" };
/** For a core's own bot with no saved routine: its core's setup never asks once the Property Core chat has one. */
export const noRoutineNote = (job: CoreJob) => `This bot has no Alerts routine of its own yet, so ${JOB_NAMES[job]}'s news still goes to the Property Core bot's chat. Once setup is done, connect one: call ${ROUTINE_TOOL[job]}.`;

/** True when this connection has saved its own Alerts routine. */
export function hasOwnRoutine(h: HostedCleaner, tenant: Tenant, grantId: string): boolean {
  return jobDeps(h, tenant).hasRoutine(grantId);
}

/**
 * The account's bots as the Property Core chat sees them: one entry per core that runs at some property. A core's
 * own bot that has gone quiet is marked, with one line for the host.
 */
export function teamView(h: HostedCleaner, tenant: Tenant, now: Date): TeamEntry[] {
  const deps = jobDeps(h, tenant);
  return CORE_JOBS.filter((job) => tenant.properties.some((property) => property.flows[job].on)).map((job) => {
    const held = holder(h, tenant, job);
    const own = held?.job === job ? held : undefined;
    const waiting = !own && coreBot(tenant, job, deps) !== undefined;
    const quiet = own !== undefined && isQuiet(own, now);
    return {
      job,
      holder: own ? ("own bot" as const) : ("this chat" as const),
      ...(own ? { agent: own.assistant, connectedAt: own.connectedAt, ...(own.lastSeenAt ? { lastSeenAt: own.lastSeenAt } : {}) } : {}),
      alerts: held && deps.hasRoutine(held.grantId) ? ("connected" as const) : ("not connected" as const),
      ...(quiet ? { quiet: true as const, note: quietNote(job) } : {}),
      ...(waiting ? { note: setupWaitingNote(job) } : {}),
    };
  });
}
