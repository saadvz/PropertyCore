import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { GrokRoutineWebhookSink, repairsUpdateEvent, suppliesUpdateEvent, type OperatorEvent } from "../alerts/operatorEvents";
import { tenantFolder, type Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import { cleanerAlertFetch } from "../cleaner-core/liveDesk";
import { ALERT_KEEPS_MS } from "../host-alerts/clock";
import type { Job } from "../jobs/jobs";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { holder } from "./jobDeps";

/**
 * One wake-up for the bot that holds a job (#250), outside any desk's own outbox: the Property Core bot's and the
 * Supply Core bot's alerts have no desk. The event carries its kind and a time, nothing else, and the address and key
 * are read from the holder's saved routine on each send and never logged.
 */

/**
 * Sends one event to the routine of the job's holder. False when the holder has no saved routine, isn't a Grok Bot
 * (only its routine can be woken), or the send fails. The caller decides whether to try again.
 */
export async function wakeHolder(h: HostedCleaner, tenant: Tenant, job: Job, event: OperatorEvent): Promise<boolean> {
  const account = h.registry.get(tenant.id) ?? tenant;
  const held = holder(h, account, job);
  if (!held || held.assistant !== "grok") return false;
  const saved = h.secrets.connection(account.id, held.grantId);
  const url = saved.CLEANER_CORE_ROUTINE_URL?.trim();
  const key = saved.CLEANER_CORE_ROUTINE_KEY?.trim();
  if (!url || !key) return false;
  // Read on each send, so a test's stub of the routine webhook reaches these wake-ups too.
  const stub = cleanerAlertFetch();
  try {
    await new GrokRoutineWebhookSink({ url: () => url, key: () => key }, stub ? { fetch: stub } : {}).deliver(event);
    return true;
  } catch {
    return false;
  }
}

/** A wake-up that didn't go through is tried again after this long, not on every tick. */
export const WAKE_RETRY_MS = 5 * 60_000;

/** In the account's folder: a filing's wake-up that didn't go through, per owning core. A time and nothing else. */
export const KEPT_WAKES_FILE = "kept-wakes.json";

/** The cores a filing wakes, each with its own event. */
const FILED_EVENT = { supplies: suppliesUpdateEvent, fixer: repairsUpdateEvent } as const;
export type FiledJob = keyof typeof FILED_EVENT;
const FILED_JOBS = Object.keys(FILED_EVENT) as FiledJob[];

type KeptWakes = Partial<Record<FiledJob, { since: string; triedAt: string }>>;

const keptPath = (h: HostedCleaner, tenantId: string) => join(tenantFolder(h.dataRoot, tenantId), KEPT_WAKES_FILE);

function readKept(path: string): KeptWakes {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: KeptWakes = {};
  for (const job of FILED_JOBS) {
    const entry = (raw as Record<string, unknown>)[job] as { since?: unknown; triedAt?: unknown } | undefined;
    if (entry && typeof entry.since === "string" && typeof entry.triedAt === "string") out[job] = { since: entry.since, triedAt: entry.triedAt };
  }
  return out;
}

function writeKept(path: string, file: KeptWakes): void {
  if (Object.keys(file).length === 0) rmSync(path, { force: true });
  else writeJsonAtomic(path, file);
}

/**
 * Wakes the bot that holds `job` for a filing. One that doesn't go through is kept, by time only, and the service's
 * clock tries it again (retryKeptWakes): Supply Core's own check runs once a day, so a cleaner's report shouldn't
 * wait on it. True when it went through now.
 */
export async function wakeOrKeep(h: HostedCleaner, tenant: Tenant, job: FiledJob): Promise<boolean> {
  const now = h.now();
  const woken = await wakeHolder(h, tenant, job, FILED_EVENT[job](now));
  const path = keptPath(h, tenant.id);
  const kept = existsSync(path) ? readKept(path) : {};
  if (woken) {
    if (!kept[job]) return true;
    delete kept[job];
  } else kept[job] = { since: kept[job]?.since ?? now.toISOString(), triedAt: now.toISOString() };
  writeKept(path, kept);
  return woken;
}

/**
 * The clock's pass over one account's kept wake-ups. Each is tried again WAKE_RETRY_MS after its last try, and let go
 * once it goes through, once the holder has called since (it read the record on its own), or after ALERT_KEEPS_MS.
 */
export async function retryKeptWakes(h: HostedCleaner, tenant: Tenant): Promise<void> {
  const path = keptPath(h, tenant.id);
  if (!existsSync(path)) return;
  const kept = readKept(path);
  const now = h.now();
  const account = h.registry.get(tenant.id) ?? tenant;
  let changed = false;
  for (const job of FILED_JOBS) {
    const entry = kept[job];
    if (!entry) continue;
    const seen = Date.parse(holder(h, account, job)?.lastSeenAt ?? "");
    if (now.getTime() - Date.parse(entry.since) >= ALERT_KEEPS_MS || seen > Date.parse(entry.since)) {
      delete kept[job];
      changed = true;
      continue;
    }
    if (now.getTime() - Date.parse(entry.triedAt) < WAKE_RETRY_MS) continue;
    if (await wakeHolder(h, account, job, FILED_EVENT[job](now))) delete kept[job];
    else kept[job] = { since: entry.since, triedAt: now.toISOString() };
    changed = true;
  }
  if (changed) writeKept(path, kept);
}
