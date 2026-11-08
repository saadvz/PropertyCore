import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { propertyFolder, type FlowName, type Property } from "../cleaner-core/hosted/properties";
import { tenantFolder, type Tenant } from "../cleaner-core/hosted/registry";
import { propertyContext, type HostedCleaner } from "../cleaner-core/hosted/router";
import { liveDeskFor } from "../cleaner-core/liveDesk";
import { ConfirmationBook } from "../operator/confirmations";
import { supplyDesk, turnOffSupplies, turnOnSupplies } from "./supplies";
import { fixerCoreOn, supplyCoreOn } from "../cleaner-core/flag";
import { FIXER_AGENTS_ONLY, runsFixer, runsSupplies, SUPPLIES_AGENTS_ONLY, type CleanerAssistant } from "../cleaner-core/assistant";
import { fixerOffQuestion } from "../fixer-core/texts";
import { cancelFingerprint, jobsToCancel, turnOffFixer, turnOnFixer } from "./fixer";
import { FIXER_NOT_YET, resolveProperty } from "./propertyTools";
import type { FrontReply } from "./serviceTools";

/**
 * Turning a property's flows on or off. On starts that flow's setup and texts nobody. Off stands the
 * flow down first, after the host's yes when anything is live: no new offers, no door code, open carts
 * closed. The setup is kept, so turning the flow on again picks it up. /admin can force a flow off,
 * which sends nothing.
 */

export interface FlowContext {
  h: HostedCleaner;
  tenant: Tenant;
  actor: "host" | "admin";
  /** The chat asking. Supply Core and Fixer Core turn on only for Grok Bot and Muse, which shop and book pros themselves. */
  assistant?: CleanerAssistant;
  noteToolsChanged(): void;
}

export interface FlowInput {
  property?: unknown;
  cleaning?: unknown;
  supplies?: unknown;
  fixer?: unknown;
  confirmation?: unknown;
  force?: boolean;
}

const STALE = "That approval has expired or doesn't match. Ask the host again.";
const NAMES: Record<FlowName, string> = { cleaning: "Cleaner Core", supplies: "Supply Core", fixer: "Fixer Core" };

const fail = (text: string): FrontReply => ({ text, isError: true });

/** The property's approvals for turning Supply Core or Fixer Core off, kept in its folder across restarts. */
function flowApprovals(h: HostedCleaner, tenant: Tenant, property: Property): ConfirmationBook {
  return new ConfirmationBook(10 * 60_000, () => h.now().getTime(), { file: join(propertyFolder(h.dataRoot, tenant.id, property), "flow-approvals.json") });
}

/** One line per change in the account's folder: who, which property and flow, on or off, and whether it was forced. */
function recordFlow(h: HostedCleaner, tenantId: string, entry: { actor: "host" | "admin"; property: string; flow: FlowName; on: boolean; forced: boolean }): void {
  const file = join(tenantFolder(h.dataRoot, tenantId), "service-audit.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ at: h.now().toISOString(), ...entry })}\n`, { mode: 0o600 });
}

export async function setFlows(ctx: FlowContext, input: FlowInput): Promise<FrontReply> {
  const { h, tenant } = ctx;
  const resolved = resolveProperty(tenant, { property: input.property });
  if ("refusal" in resolved) return fail(resolved.refusal);
  const { property } = resolved;
  // Read again each time: turning a flow on or off saves the property.
  const latest = () => (h.registry.get(tenant.id) ?? tenant).properties.find((p) => p.id === property.id) ?? property;
  const wanted = (["cleaning", "supplies", "fixer"] as const).filter((flow) => typeof input[flow] === "boolean");
  if (wanted.length === 0) return fail("Say which flow to turn on or off: cleaning, supplies, or fixer, each true or false.");
  // Fixer Core turns on only while FIXER_CORE is set on the service; without it nothing changes.
  if (input.fixer === true && !fixerCoreOn(h.baseEnv())) return fail(FIXER_NOT_YET);
  if (wanted.length > 1 && typeof input.confirmation === "string") return fail("Turn one flow off at a time when you pass a confirmation.");
  const forced = ctx.actor === "admin" && input.force === true;
  const confirmation = typeof input.confirmation === "string" ? input.confirmation.trim() : "";
  // Every flow turning on is checked before any changes, so a refusal never leaves a half-made change.
  for (const flow of wanted) {
    if (input[flow] !== true) continue;
    const current = latest();
    const refusal = turnOnRefusal(ctx, current, flow, wanted.includes("cleaning") && input.cleaning === true);
    if (refusal) return fail(refusal);
  }
  const done: string[] = [];
  // What a flow's turn-off leaves for the agent to do, such as the pros to tell.
  const extra: Record<string, unknown> = {};
  for (const flow of wanted) {
    const on = input[flow] as boolean;
    const current = latest();
    if (current.flows[flow].on === on) {
      done.push(`${NAMES[flow]} was already ${on ? "on" : "off"} for ${current.label}.`);
      continue;
    }
    const reply = on ? await turnOn(ctx, current, flow) : await turnOff(ctx, current, flow, confirmation, forced, extra);
    if (reply) return reply;
    recordFlow(h, tenant.id, { actor: ctx.actor, property: current.id, flow, on, forced });
    h.log(`${tenant.id}/${current.id} turned ${flow} ${on ? "on" : "off"}${forced ? " (forced by the admin)" : ""}.`);
    done.push(`${NAMES[flow]} is ${on ? "on" : "off"} for ${current.label}.${on ? "" : " Its setup is kept."}`);
  }
  if (Array.isArray(extra.tellPro) && extra.tellPro.length > 0) done.push("Tell each pro in tellPro their visit is cancelled.");
  if (Array.isArray(extra.rotationAsk) && extra.rotationAsk.length > 0) done.push("Then ask the host each question in rotationAsk.");
  ctx.noteToolsChanged();
  const after = latest();
  const structured = { property: after.id, flows: { cleaning: after.flows.cleaning.on, supplies: after.flows.supplies.on, fixer: after.flows.fixer.on }, ...extra };
  return { text: `${done.join(" ")} Call get_state with property ${after.id} for the next step. If the tools don't change, start a new chat.`, structured, isError: false };
}

/** Why a flow can't turn on, or undefined. `cleaningComing` is true when the same call turns cleaning on. */
function turnOnRefusal(ctx: FlowContext, property: Property, flow: FlowName, cleaningComing: boolean): string | undefined {
  // Fixer Core runs on an always-on agent that finds, calls and books pros itself.
  if (flow === "fixer") return ctx.assistant && runsFixer(ctx.assistant) ? undefined : FIXER_AGENTS_ONLY;
  if (flow !== "supplies") return undefined;
  if (!ctx.assistant || !runsSupplies(ctx.assistant)) return SUPPLIES_AGENTS_ONLY;
  // Supply Core on its own, without Cleaner Core at the property, only while SUPPLY_CORE is on.
  if (!property.flows.cleaning.on && !cleaningComing && !supplyCoreOn(ctx.h.baseEnv())) return "Supply Core on its own isn't available on this service yet. Turn on Cleaner Core for this property first.";
  return undefined;
}

async function turnOn(ctx: FlowContext, property: Property, flow: FlowName): Promise<FrontReply | undefined> {
  if (flow === "supplies") {
    await turnOnSupplies(ctx.h, ctx.tenant, property);
    return undefined;
  }
  if (flow === "fixer") {
    const reply = await turnOnFixer(ctx.h, ctx.tenant, property);
    return reply.isError ? fail(reply.text) : undefined;
  }
  ctx.h.registry.setFlow(ctx.tenant.id, property.id, flow, true);
  return undefined;
}

/** Stands the flow down and turns it off. A reply means it stopped there: a question with a code, or a refusal. */
async function turnOff(ctx: FlowContext, property: Property, flow: FlowName, confirmation: string, forced: boolean, extra: Record<string, unknown>): Promise<FrontReply | undefined> {
  const { h, tenant } = ctx;
  if (flow === "fixer") return turnOffRepairs(ctx, property, confirmation, forced, extra);
  if (flow === "cleaning") {
    // Forced from /admin: the flow goes off and its desk sends nothing more. What was live stays frozen.
    if (!forced) {
      const c = propertyContext(h, tenant, property);
      const reply = await liveDeskFor(c.root, c.env, () => h.now()).standDown(confirmation ? { confirmation } : {});
      if (!reply.ok) return fail(reply.error);
      // A question with a code: nothing changes until the host's yes comes back with it.
      if (reply.result.confirmation) return { text: String(reply.result.next ?? ""), structured: reply.result, isError: false };
    }
    h.registry.setFlow(tenant.id, property.id, "cleaning", false);
    return undefined;
  }
  // Supply Core sends no texts, but closes open carts: the host says yes first.
  if (!forced) {
    const fingerprint = createHash("sha256").update(`supplies-off|${property.id}`).digest("hex");
    const book = flowApprovals(h, tenant, property);
    if (!confirmation) {
      const question = `Turn off Supply Core for ${property.label}? No new orders, open carts close, and the cleaner isn't asked about supplies. The list is kept. Reply yes to turn it off.`;
      return { text: question, structured: { question, confirmation: book.issue("supplies-off", property.id, fingerprint, question) }, isError: false };
    }
    try {
      book.redeem(confirmation, "supplies-off", property.id, fingerprint);
    } catch {
      return fail(STALE);
    }
  }
  await supplyDesk(h, tenant, property).clearCarts();
  await turnOffSupplies(h, tenant, property);
  return undefined;
}

/**
 * Fixer Core off. With a visit booked, the host's yes comes first: the question names every job that
 * will be cancelled, and the code is bound to them as they stand. After the yes the jobs are cancelled,
 * and `extra` carries the pros to tell and any door-code question. Forced from /admin, nothing is
 * cancelled or sent: what was booked stays frozen.
 */
async function turnOffRepairs(ctx: FlowContext, property: Property, confirmation: string, forced: boolean, extra: Record<string, unknown>): Promise<FrontReply | undefined> {
  const { h, tenant } = ctx;
  const jobs = forced ? [] : jobsToCancel(h, tenant, property);
  if (jobs.length > 0) {
    const fingerprint = cancelFingerprint(h, tenant, property);
    const book = flowApprovals(h, tenant, property);
    if (!confirmation) {
      const question = fixerOffQuestion({ label: property.label, jobs });
      return { text: question, structured: { question, jobs, confirmation: book.issue("fixer-off", property.id, fingerprint, question) }, isError: false };
    }
    try {
      book.redeem(confirmation, "fixer-off", property.id, fingerprint);
    } catch {
      return fail(STALE);
    }
  }
  const reply = await turnOffFixer(h, tenant, property, jobs.length > 0);
  const { tellPro, rotationAsk } = (reply.structured ?? {}) as { tellPro?: unknown[]; rotationAsk?: unknown[] };
  if (tellPro?.length) extra.tellPro = tellPro;
  if (rotationAsk?.length) extra.rotationAsk = rotationAsk;
  return undefined;
}
