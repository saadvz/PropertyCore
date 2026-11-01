import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tourCoreTenants } from "../cleaner-core/flag";
import { tenantFolder, type Tenant, type TenantService } from "../cleaner-core/hosted/registry";
import { tenantContext, type HostedCleaner } from "../cleaner-core/hosted/router";
import { liveDeskFor } from "../cleaner-core/liveDesk";
import { ConfirmationBook } from "../operator/confirmations";
import { CHOSEN_LINE, type FrontReply } from "./serviceTools";
import { TOURING_LIVE_PATH, TOURING_STAND_DOWN_PATH, type TouringLive } from "./touringLive";
import { workerJson } from "./touringForward";

/**
 * Switching a number between touring and cleaning, and standing a service down first. A switch
 * happens only when nothing on the current service is live (Saad's force on /admin aside), only after
 * the host's yes, and sends no texts. Stand-down stops what's live, with the texts it previews.
 */

export type LiveReport = TouringLive;

export interface SwitchContext {
  h: HostedCleaner;
  tenant: Tenant;
  actor: "host" | "admin";
  noteToolsChanged(): void;
}

export const TOURING_DOWN = "Touring isn't answering right now. Try again in a minute.";
const TOURING_UNDER_WAY = "Someone is on a tour right now. Stand down after it ends.";
const NOTHING_LIVE_TOURING = "Nothing is live on touring, so there's nothing to stand down. You can switch now.";
const TOURING_STOOD_DOWN = "Touring is stood down. Nothing is live, so you can switch now.";
const STALE = "That approval has expired or doesn't match. Ask the host again.";
/** How long a choice waits for a touring process before answering anyway. */
const START_WAIT_MS = 30_000;

/** Codes for a switch or a touring stand-down. Ten minutes, in memory; a restart means asking again. */
const approvals = new ConfirmationBook();

const capital = (service: TenantService) => `${service[0]!.toUpperCase()}${service.slice(1)}`;
const fail = (text: string): FrontReply => ({ text, isError: true });

/** What's live on the tenant's current service. Unreachable when its touring process can't answer. */
export async function liveOf(h: HostedCleaner, tenant: Tenant): Promise<LiveReport | "unreachable"> {
  if (tenant.service === "touring") {
    const target = h.touring?.supervisor.target(tenant.id);
    const answer = target ? await workerJson<LiveReport>(target, "GET", TOURING_LIVE_PATH) : undefined;
    return answer && answer.status === 200 && answer.json ? answer.json : "unreachable";
  }
  if (tenant.service === "cleaning") {
    const ctx = tenantContext(h, tenant);
    const work = await liveDeskFor(ctx.root, ctx.env, () => h.now()).liveWork();
    return { ...work, texts: [] };
  }
  return { live: [], inProgress: false, texts: [] };
}

/** One line per switch in the tenant's folder: who, from, to, and whether it was forced. */
function recordSwitch(h: HostedCleaner, tenantId: string, entry: { actor: "host" | "admin"; from: TenantService; to: TenantService; forced: boolean }): void {
  const file = join(tenantFolder(h.dataRoot, tenantId), "service-audit.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ at: h.now().toISOString(), ...entry })}\n`, { mode: 0o600 });
}

export async function switchService(
  ctx: SwitchContext,
  input: { to: TenantService; confirmation?: string; force?: boolean },
  deps: { live?: (h: HostedCleaner, tenant: Tenant) => Promise<LiveReport | "unreachable"> } = {},
): Promise<FrontReply> {
  const { h, tenant } = ctx;
  const from = tenant.service;
  const to = input.to;
  if (!from) return fail("Choose a service first. Call get_state.");
  if (to === from) return fail(`This number is already set up for ${to}.`);
  if (to === "touring" && !(tourCoreTenants(h.baseEnv()) && h.touring)) return fail("Touring isn't available on this service yet.");
  const forced = input.force === true;
  if (!forced) {
    const live = await (deps.live ?? liveOf)(h, tenant);
    if (live === "unreachable") return fail(TOURING_DOWN);
    if (live.live.length > 0) {
      return fail(`${capital(from)} is still live, so the number can't switch yet:\n${live.live.map((line) => `- ${line}`).join("\n")}\nCall stand_down_service to stop it first. Its setup is kept.`);
    }
    if (ctx.actor === "host") {
      const fingerprint = `${from}>${to}`;
      const code = input.confirmation?.trim() ?? "";
      if (!code) {
        const question = `Switch this number from ${from} to ${to}? ${capital(from)} stops answering texts. Its setup is kept, so you can switch back later. Reply yes to switch.`;
        const confirmation = approvals.issue("switch-service", tenant.id, fingerprint, question);
        return { text: question, structured: { confirmation }, isError: false };
      }
      try {
        approvals.redeem(code, "switch-service", tenant.id, fingerprint);
      } catch {
        return fail(STALE);
      }
    }
  }
  h.registry.setService(tenant.id, to);
  if (from === "touring") {
    h.touring?.supervisor.stop(tenant.id);
    // Texts that waited for touring are not replayed into a later touring setup.
    const dropped = h.touring?.inbox.clear(tenant.id) ?? 0;
    if (dropped) h.log(`${dropped} text${dropped === 1 ? "" : "s"} waiting for ${tenant.id}'s touring ${dropped === 1 ? "was" : "were"} dropped by the switch.`);
  }
  if (to === "touring" && h.touring) {
    const current = h.registry.get(tenant.id)!;
    await Promise.race([h.touring.start(current), new Promise((resolve) => setTimeout(resolve, START_WAIT_MS).unref())]);
  }
  recordSwitch(h, tenant.id, { actor: ctx.actor, from, to, forced });
  h.log(`${tenant.id} switched from ${from} to ${to}${forced ? " (forced by the admin)" : ""}.`);
  ctx.noteToolsChanged();
  return { text: CHOSEN_LINE(to), structured: { service: to }, isError: false };
}

export async function standDownService(ctx: SwitchContext, input: { confirmation?: string }): Promise<FrontReply> {
  const { h, tenant } = ctx;
  if (tenant.service === "cleaning") {
    const desk = (() => {
      const c = tenantContext(h, tenant);
      return liveDeskFor(c.root, c.env, () => h.now());
    })();
    const reply = await desk.standDown(input);
    if (!reply.ok) return fail(reply.error);
    const result = reply.result ?? {};
    return { text: typeof result.next === "string" ? result.next : JSON.stringify(result), structured: result, isError: false };
  }
  if (tenant.service !== "touring") return fail("Choose a service first. Call get_state.");
  const target = h.touring?.supervisor.target(tenant.id);
  const live = await liveOf(h, tenant);
  if (!target || live === "unreachable") return fail(TOURING_DOWN);
  if (live.inProgress) return fail(TOURING_UNDER_WAY);
  if (live.live.length === 0) return { text: NOTHING_LIVE_TOURING, isError: false };
  const fingerprint = createHash("sha256").update(JSON.stringify(live)).digest("hex");
  const code = input.confirmation?.trim() ?? "";
  if (!code) {
    const goes = live.texts.length ? `These texts go out:\n${live.texts.map((t) => `- To ${t.to}: "${t.body}"`).join("\n")}` : "No texts go out.";
    const question = `Stand down touring? This stops:\n${live.live.map((line) => `- ${line}`).join("\n")}\n${goes}\nThe setup is kept. Reply yes to stand down.`;
    const confirmation = approvals.issue("stand-down-touring", tenant.id, fingerprint, question);
    return { text: question, structured: { confirmation, texts: live.texts }, isError: false };
  }
  try {
    approvals.redeem(code, "stand-down-touring", tenant.id, fingerprint);
  } catch {
    return fail(STALE);
  }
  const done = await workerJson<{ paused: number; cancelled: number }>(target, "POST", TOURING_STAND_DOWN_PATH, {});
  if (!done) return fail(TOURING_DOWN);
  if (done.status === 409) return fail(TOURING_UNDER_WAY);
  h.log(`${tenant.id} stood touring down.`);
  return { text: TOURING_STOOD_DOWN, structured: { ...done.json, texts: live.texts }, isError: false };
}
