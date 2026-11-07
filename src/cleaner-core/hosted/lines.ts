import { parsePhone } from "../../core/phone";
import { NumberPool, PoolError, POOL_LOW_AT } from "./numberPool";
import type { Tenant } from "./registry";
import type { HostedCleaner } from "./router";
import { findIncomingNumber, pointSmsWebhook, releaseNumber } from "./twilioNumbers";

/**
 * Each account's one text line (saadvz/TourCore#163). The line exists for the cleaner, and maybe pros;
 * the host never texts it. Sign-up takes a registered number from the pool, points its webhook at this
 * service, and records it. Closing the account gives it back to rest, or releases it from Twilio.
 */

/** Where every account's line sends its texts. The `To` number picks the account. */
export const LINE_WEBHOOK_PATH = "/webhooks/twilio/cleaner-core";

export function numberPool(h: HostedCleaner): NumberPool {
  return new NumberPool(h.dataRoot, () => h.now());
}

export function lineWebhookUrl(h: HostedCleaner): string {
  return `${h.origin() ?? ""}${LINE_WEBHOOK_PATH}`;
}

export type OpenRefusal = "bad-label" | "no-line";

export interface OpenedAccount {
  tenant: Tenant;
  inviteCode: string;
  number: string;
  /** False when Twilio didn't take the webhook. /admin shows it and can point it again. */
  webhookOk: boolean;
}

/**
 * Creates an account and attaches the ready line that has waited longest. The pick, the account and
 * the pool's record happen with no await between them, so two sign-ups never get the same line.
 */
export async function openAccount(h: HostedCleaner, input: { label: string }): Promise<OpenedAccount | { refused: OpenRefusal }> {
  const label = input.label.trim();
  if (!label) return { refused: "bad-label" };
  const pool = numberPool(h);
  let line = pool.next();
  // A ready number an account already holds (added by hand before the pool knew it) is recorded and skipped.
  while (line) {
    const holder = h.registry.byNumber(line.number);
    if (!holder) break;
    pool.assign(line.number, line.sid, holder.id);
    line = pool.next();
  }
  if (!line) {
    h.log("Sign-up found no ready number in the pool. Add registered numbers on /admin.");
    return { refused: "no-line" };
  }
  const created = h.registry.create({ label, twilioNumber: line.number });
  pool.assign(line.number, line.sid, created.tenant.id);
  const webhookOk = await pointLine(h, pool, line.number, line.sid);
  h.log(`Created ${created.tenant.id} with a line from the pool.`);
  warnIfLow(h, pool);
  return { ...created, number: line.number, webhookOk };
}

/** Records a number typed on /admin as the account's line, in the pool too, and points its webhook. */
export async function attachTypedLine(h: HostedCleaner, tenant: Tenant, sid: string): Promise<boolean> {
  const pool = numberPool(h);
  pool.assign(tenant.twilioNumber, sid, tenant.id);
  const ok = await pointLine(h, pool, tenant.twilioNumber, sid);
  warnIfLow(h, pool);
  return ok;
}

/** Points the account's line at this service again, after Twilio refused it once. */
export async function repointLine(h: HostedCleaner, tenant: Tenant): Promise<boolean> {
  const pool = numberPool(h);
  const sid = pool.get(tenant.twilioNumber)?.sid ?? (await findIncomingNumber(h.baseEnv(), tenant.twilioNumber))?.sid;
  if (!sid) return false;
  return pointLine(h, pool, tenant.twilioNumber, sid);
}

async function pointLine(h: HostedCleaner, pool: NumberPool, number: string, sid: string): Promise<boolean> {
  const ok = await pointSmsWebhook(h.baseEnv(), sid, lineWebhookUrl(h));
  pool.setWebhook(number, ok);
  if (!ok) h.log("Twilio didn't take a line's webhook. Point it again from the number pool on /admin.");
  return ok;
}

export type CloseLine = "return" | "release";

/**
 * A closing account's line stops reaching this service. "return" puts it back in the pool, where it
 * rests before another account gets it. "release" gives it back to Twilio for good; if Twilio
 * refuses, it rests in the pool instead and can be released from there.
 */
export async function closeLine(h: HostedCleaner, tenant: Tenant, how: CloseLine): Promise<void> {
  const env = h.baseEnv();
  const pool = numberPool(h);
  const sid = pool.get(tenant.twilioNumber)?.sid ?? (await findIncomingNumber(env, tenant.twilioNumber))?.sid;
  if (!sid) {
    h.log(`${tenant.id}'s line isn't on the Twilio account, so nothing went back to the pool.`);
    return;
  }
  await pointSmsWebhook(env, sid, "");
  pool.giveBack(tenant.twilioNumber, sid);
  if (how === "return") {
    h.log(`${tenant.id}'s line went back to the pool to rest.`);
    return;
  }
  if (await releaseNumber(env, sid)) {
    pool.remove(tenant.twilioNumber);
    h.log(`Released ${tenant.id}'s line from Twilio.`);
  } else {
    h.log(`Twilio didn't release ${tenant.id}'s line. It rests in the pool; release it from there.`);
  }
}

export type ReleaseRefusal = "not-pooled" | "in-use" | "twilio";

/** Releases a pooled line no account holds. An account's own line is never released this way. */
export async function releasePooled(h: HostedCleaner, raw: string): Promise<{ released: string } | { refused: ReleaseRefusal }> {
  const pool = numberPool(h);
  const entry = pool.get(raw);
  if (!entry) return { refused: "not-pooled" };
  if (entry.tenantId || h.registry.byNumber(entry.number)) return { refused: "in-use" };
  if (!(await releaseNumber(h.baseEnv(), entry.sid))) return { refused: "twilio" };
  try {
    pool.remove(entry.number);
  } catch (err) {
    if (!(err instanceof PoolError)) throw err;
  }
  h.log("Released a pooled line from Twilio.");
  return { released: entry.number };
}

export type TopUpRefusal = "bad-number" | "already-pooled" | "in-use" | "not-on-twilio";

/** Adds registered numbers to the pool. Each must be on the Twilio account and held by no account. */
export async function topUp(h: HostedCleaner, raws: string[]): Promise<{ added: string[]; refused: { raw: string; reason: TopUpRefusal }[] }> {
  const pool = numberPool(h);
  const added: string[] = [];
  const refused: { raw: string; reason: TopUpRefusal }[] = [];
  for (const raw of raws) {
    const e164 = parsePhone(raw);
    const reason: TopUpRefusal | undefined = !e164 ? "bad-number" : h.registry.byNumber(e164) ? "in-use" : pool.get(e164) ? "already-pooled" : undefined;
    if (reason || !e164) {
      refused.push({ raw, reason: reason ?? "bad-number" });
      continue;
    }
    const number = await findIncomingNumber(h.baseEnv(), e164);
    if (!number) {
      refused.push({ raw, reason: "not-on-twilio" });
      continue;
    }
    try {
      added.push(pool.add(e164, number.sid).number);
    } catch (err) {
      // The same number twice in one top-up.
      if (err instanceof PoolError && err.reason === "already-pooled") refused.push({ raw, reason: "already-pooled" });
      else throw err;
    }
  }
  if (added.length > 0) h.log(`Added ${added.length} number${added.length === 1 ? "" : "s"} to the pool.`);
  return { added, refused };
}

/** After every take, the log says so once ready numbers are at or below POOL_LOW_AT. */
export function warnIfLow(h: HostedCleaner, pool: NumberPool = numberPool(h)): void {
  const { ready, low } = pool.summary();
  if (low) h.log(`The number pool is low: ${ready} ready (alert at ${POOL_LOW_AT} or fewer). Add registered numbers on /admin.`);
}
