import { mkdirSync } from "node:fs";
import { runsFixer, runsSupplies, type CleanerAssistant } from "../cleaner-core/assistant";
import { findProperty, propertyFolder, type FlowName, type Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import type { Job } from "../jobs/jobs";
import type { TeamEntry } from "./botTools";
import type { FrontReply } from "./serviceTools";
import { OFFER_IDS } from "./featureOffers";

/**
 * The account's own tools on the shared address, and how a property tool call names its property.
 * Every Cleaner Core, Supply Core and Fixer Core tool takes a `property`; it's required once the account has two
 * or more properties, and is taken out before the call reaches the property's desk.
 */

export const LABEL_MAX = 120;
export const FIRST_PROPERTY = "Ask the host for the property's address, then call add_property with it.";
export const TURN_A_FLOW_ON = "No flow is on for this property yet. Ask the host what they want here, then call set_flows to turn Cleaner Core, Supply Core or Fixer Core on.";

const FLOW_NAMES: Record<FlowName, string> = { cleaning: "Cleaner Core", supplies: "Supply Core", fixer: "Fixer Core" };

export const flowOff = (flow: FlowName, label: string) => `${FLOW_NAMES[flow]} isn't on for ${label}.`;
export const nameProperty = (tenant: Tenant) => `Which property? Pass property as one of: ${tenant.properties.map((p) => `${p.id} (${p.label})`).join(", ")}.`;

const PROPERTY_ARG = { type: "string", maxLength: 200, description: "The property's id from get_state, like prp_abc123defg. Its exact label works too." };

/** The property a call names, and its arguments without `property`, or why it can't run. */
export function resolveProperty(tenant: Tenant, args: unknown): { property: Property; args: Record<string, unknown> } | { refusal: string } {
  const all = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  // A tool with its own `property` field (Supply Core's settings) names the property with propertyId.
  const { propertyId, ...withoutId } = all;
  const named = typeof all.property === "string";
  const { property: _ref, ...rest } = withoutId;
  const ref = typeof propertyId === "string" ? propertyId : named ? (all.property as string) : undefined;
  const kept = named ? rest : withoutId;
  if (typeof ref === "string" && ref.trim()) {
    const property = findProperty(tenant, ref);
    return property ? { property, args: kept } : { refusal: nameProperty(tenant) };
  }
  if (tenant.properties.length === 1) return { property: tenant.properties[0]!, args: kept };
  if (tenant.properties.length === 0) return { refusal: FIRST_PROPERTY };
  return { refusal: nameProperty(tenant) };
}

/** A listed tool with the `property` argument added to its input. */
export function withPropertyArg(tool: Record<string, unknown>, required: boolean): Record<string, unknown> {
  const schema = (tool.inputSchema ?? { type: "object", properties: {} }) as { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown };
  // A tool that already has a `property` field of its own takes the property's id as propertyId.
  const key = schema.properties && "property" in schema.properties ? "propertyId" : "property";
  const properties = { ...(schema.properties ?? {}), [key]: PROPERTY_ARG };
  const own = (schema.required ?? []).filter((name) => key === "property" || name !== "propertyId");
  const needed = required ? [...new Set([...own, key])] : own.filter((name) => name !== key);
  return { ...tool, inputSchema: { ...schema, properties, ...(needed.length > 0 ? { required: needed } : {}) } };
}

const GET_STATE = {
  name: "get_state",
  title: "What's next",
  description:
    "Call this first. Lists the account's properties, which flows each one has on, and each one's next step. With property, gives that property's own Cleaner Core state and next step (or Supply Core's, when only Supply Core is on there, or Fixer Core's, when only Fixer Core is). With one property, it gives that property's state directly. agentNumber is the account's text line: when the host asks for their agent's number, give it, and say their pros and cleaner text or call it, while the host talks to you in chat. Setup starts with a draft for each property: pass drafted: true with the property once the host corrected its summary. Once setup is done, it may give offer: one feature that's on for the account, to offer the host in one line with Skip always there; pass offered with that offer's name and the property once the host answered, yes or skip.",
  inputSchema: { type: "object", properties: { property: PROPERTY_ARG, choice: { type: "string", maxLength: 40 }, drafted: { type: "boolean" }, offered: { type: "string", enum: [...OFFER_IDS] } }, additionalProperties: false },
};

const ADD_PROPERTY = {
  name: "add_property",
  title: "Add a property",
  description: "Adds a property to the account, with every flow off. Use the address as the label. It texts nobody. Then call set_flows to turn Cleaner Core, Supply Core or Fixer Core on for it.",
  inputSchema: { type: "object", properties: { label: { type: "string", maxLength: LABEL_MAX } }, required: ["label"], additionalProperties: false },
};

const SET_FLOWS = {
  name: "set_flows",
  title: "Turn flows on or off",
  description:
    "Turns Cleaner Core (cleaning), Supply Core (supplies) or Fixer Core (fixer) on or off for one property, only when the host asks. Turning one on starts its setup and texts nobody. Turning one off with anything live gives the exact texts and stops first, with a code: show the host, and call again with the code only after their yes. The setup is kept.",
  inputSchema: {
    type: "object",
    properties: { property: PROPERTY_ARG, cleaning: { type: "boolean" }, supplies: { type: "boolean" }, fixer: { type: "boolean" }, confirmation: { type: "string", maxLength: 40 } },
    required: ["property"],
    additionalProperties: false,
  },
};

/** The account's own tools as tools/list shows them. */
export function accountTools(): Record<string, unknown>[] {
  return [GET_STATE, ADD_PROPERTY, SET_FLOWS];
}

/** One line per property, as get_state lists it. */
export function propertyLine(property: Property): { id: string; label: string; flows: Record<FlowName, boolean> } {
  return { id: property.id, label: property.label, flows: { cleaning: property.flows.cleaning.on, supplies: property.flows.supplies.on, fixer: property.flows.fixer.on } };
}

const done = (structured: Record<string, unknown>): FrontReply => ({ text: JSON.stringify(structured), structured, isError: false });
const fail = (text: string): FrontReply => ({ text, isError: true });

export function addProperty(h: HostedCleaner, tenant: Tenant, args: unknown): FrontReply {
  const label = typeof (args as { label?: unknown } | undefined)?.label === "string" ? (args as { label: string }).label.trim() : "";
  if (!label || label.length > LABEL_MAX) return fail(`Give the property a label of 1 to ${LABEL_MAX} characters, like its address.`);
  const same = tenant.properties.find((p) => p.label.trim().toLowerCase() === label.toLowerCase());
  if (same) return fail(`There's already a property called ${same.label}. Use a different label, like the unit number.`);
  const property = h.registry.addProperty(tenant.id, label);
  mkdirSync(propertyFolder(h.dataRoot, tenant.id, property), { recursive: true });
  h.log(`${tenant.id} added ${property.id}.`);
  return done({ property: propertyLine(property), next: `Added ${label}. Ask the host which flows they want here, then call set_flows with property ${property.id}.` });
}

/** Everything a property's own state can come from, so this file stays free of the desks. */
export interface PropertyStates {
  cleaning(property: Property, args: Record<string, unknown>): Promise<FrontReply>;
  supplies(property: Property): Promise<FrontReply>;
  fixer(property: Property): Promise<FrontReply>;
  /** The next step of one property, for the overview: its Cleaner Core ask, else Supply Core's, else Fixer Core's, among the flows the caller runs. */
  next(property: Property): Promise<string | undefined>;
  /** The name of one flow's next step at a property, and nothing else of that flow's state. */
  step(property: Property, flow: FlowName): Promise<string | undefined>;
}

/**
 * How get_state is cut for this caller on an account where a core has its own bot (#250). Left out on an account with
 * one bot, which gets what it always got.
 */
export interface StateView {
  /** The jobs the caller has now. A caller without "property" is a core's own bot. */
  jobs: readonly Job[];
  /** The Property Core chat's view of the account's bots. */
  team?: TeamEntry[];
  /** True on a team: each property's line carries one next step per flow, by name only. */
  perFlow?: boolean;
  /** For a core's own bot that hasn't saved its Alerts routine yet. */
  alertsNote?: string;
  /** The line that sends the host to the bots that run these cores. */
  sendTo(flows: FlowName[]): string;
}

const FLOWS: readonly FlowName[] = ["cleaning", "supplies", "fixer"];

/** get_state: the overview, or one property's own state when the call names it or there's only one. */
export async function accountState(tenant: Tenant, args: unknown, states: PropertyStates, assistant: CleanerAssistant, view?: StateView): Promise<FrontReply> {
  const reply = await stateOf(tenant, args, states, assistant, view);
  if (reply.isError || !reply.structured) return reply;
  // The account's line, so the host can ask for their agent's number.
  const structured = { ...reply.structured, ...(tenant.twilioNumber ? { agentNumber: tenant.twilioNumber } : {}), ...(view?.team ? { team: view.team } : {}), ...(view?.alertsNote ? { alertsNote: view.alertsNote } : {}) };
  return { ...reply, text: JSON.stringify(structured), structured };
}

async function stateOf(tenant: Tenant, args: unknown, states: PropertyStates, assistant: CleanerAssistant, view?: StateView): Promise<FrontReply> {
  // A core's own bot sees only its own flow; the Property Core chat only the flows it still runs.
  const core = view && !view.jobs.includes("property") ? (view.jobs[0] as FlowName | undefined) : undefined;
  const has = (flow: FlowName) => !view || view.jobs.includes(flow);
  /** A property as this caller lists it. A core's bot is told only whether its own flow runs there. */
  const line = async (property: Property): Promise<Record<string, unknown>> => {
    if (core) return { id: property.id, label: property.label, flow: property.flows[core].on ? "on" : "off" };
    if (!view?.perFlow) return propertyLine(property);
    // On a team, which flow waits on what, by the step's name only: never another core's question, code or token.
    const next: Partial<Record<FlowName, string>> = {};
    for (const flow of FLOWS) {
      const step = property.flows[flow].on ? await states.step(property, flow) : undefined;
      if (step) next[flow] = step;
    }
    return { ...propertyLine(property), ...(Object.keys(next).length > 0 ? { next } : {}) };
  };
  if (tenant.properties.length === 0) return done({ properties: [], next: FIRST_PROPERTY });
  const named = args && typeof args === "object" && typeof (args as { property?: unknown }).property === "string";
  // Each property has its own draft (#166), so drafted: true names the property it's for.
  if (!named && tenant.properties.length > 1 && (args as { drafted?: unknown } | undefined)?.drafted === true) return fail("Name the property whose draft the host saw: call get_state with property and drafted: true.");
  if (named || tenant.properties.length === 1) {
    const resolved = resolveProperty(tenant, args);
    if ("refusal" in resolved) return fail(resolved.refusal);
    const { property } = resolved;
    const runs = (flow: FlowName) => property.flows[flow].on && has(flow);
    const elsewhere = FLOWS.filter((flow) => property.flows[flow].on && !has(flow));
    const reply =
      core && !property.flows[core].on
        ? done({ flow: "off", note: `${flowOff(core, property.label)} The host turns it on in the Property Core bot's chat.` })
        : runs("cleaning")
          ? await states.cleaning(property, resolved.args)
          : runs("supplies") && runsSupplies(assistant)
            ? await states.supplies(property)
            : runs("fixer") && runsFixer(assistant)
              ? await states.fixer(property)
              : view && elsewhere.length > 0
                ? done({ next: view.sendTo(elsewhere) })
                : done({ next: TURN_A_FLOW_ON });
    if (reply.isError || !reply.structured) return reply;
    const structured = { ...reply.structured, properties: await Promise.all(tenant.properties.map(line)) };
    return { ...reply, text: JSON.stringify(structured), structured };
  }
  const properties = await Promise.all(
    tenant.properties.map(async (property) => {
      const listed = await line(property);
      if (view?.perFlow && !core) return listed;
      const next = !core || property.flows[core].on ? await states.next(property) : undefined;
      return { ...listed, ...(next ? { next } : {}) };
    }),
  );
  return done({ properties, next: "Name the property in every property tool call. Call get_state with property for one property's own next step." });
}
