import { mkdirSync } from "node:fs";
import { runsFixer, runsSupplies, type CleanerAssistant } from "../cleaner-core/assistant";
import { findProperty, propertyFolder, type FlowName, type Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import type { FrontReply } from "./serviceTools";

/**
 * The account's own tools on the shared address, and how a property tool call names its property.
 * Every Cleaner Core, Supply Core and Fixer Core tool takes a `property`; it's required once the account has two
 * or more properties, and is taken out before the call reaches the property's desk.
 */

export const LABEL_MAX = 120;
export const FIXER_NOT_YET = "Fixer Core isn't available yet.";
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
    "Call this first. Lists the account's properties, which flows each one has on, and each one's next step. With property, gives that property's own Cleaner Core state and next step (or Supply Core's, when only Supply Core is on there, or Fixer Core's, when only Fixer Core is). With one property, it gives that property's state directly. agentNumber is the account's text line: when the host asks for their agent's number, give it, and say their pros and cleaner text or call it, while the host talks to you in chat. Setup starts with a draft for each property: pass drafted: true with the property once the host corrected its summary.",
  inputSchema: { type: "object", properties: { property: PROPERTY_ARG, choice: { type: "string", maxLength: 40 }, drafted: { type: "boolean" } }, additionalProperties: false },
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
  /** The next step of one property, for the overview: its Cleaner Core ask, else Supply Core's, else Fixer Core's. */
  next(property: Property): Promise<string | undefined>;
}

/** get_state: the overview, or one property's own state when the call names it or there's only one. */
export async function accountState(tenant: Tenant, args: unknown, states: PropertyStates, assistant: CleanerAssistant): Promise<FrontReply> {
  const reply = await stateOf(tenant, args, states, assistant);
  if (reply.isError || !reply.structured) return reply;
  // The account's line, so the host can ask for their agent's number.
  const structured = { ...reply.structured, ...(tenant.twilioNumber ? { agentNumber: tenant.twilioNumber } : {}) };
  return { ...reply, text: JSON.stringify(structured), structured };
}

async function stateOf(tenant: Tenant, args: unknown, states: PropertyStates, assistant: CleanerAssistant): Promise<FrontReply> {
  const list = tenant.properties.map(propertyLine);
  if (tenant.properties.length === 0) return done({ properties: [], next: FIRST_PROPERTY });
  const named = args && typeof args === "object" && typeof (args as { property?: unknown }).property === "string";
  // Each property has its own draft (#166), so drafted: true names the property it's for.
  if (!named && tenant.properties.length > 1 && (args as { drafted?: unknown } | undefined)?.drafted === true) return fail("Name the property whose draft the host saw: call get_state with property and drafted: true.");
  if (named || tenant.properties.length === 1) {
    const resolved = resolveProperty(tenant, args);
    if ("refusal" in resolved) return fail(resolved.refusal);
    const { property } = resolved;
    const reply = property.flows.cleaning.on
      ? await states.cleaning(property, resolved.args)
      : property.flows.supplies.on && runsSupplies(assistant)
        ? await states.supplies(property)
        : property.flows.fixer.on && runsFixer(assistant)
          ? await states.fixer(property)
          : done({ next: TURN_A_FLOW_ON });
    if (reply.isError || !reply.structured) return reply;
    const structured = { ...reply.structured, properties: list };
    return { ...reply, text: JSON.stringify(structured), structured };
  }
  const properties = await Promise.all(
    tenant.properties.map(async (property) => {
      const next = await states.next(property);
      return { ...propertyLine(property), ...(next ? { next } : {}) };
    }),
  );
  return done({ properties, next: "Name the property in every property tool call. Call get_state with property for one property's own next step." });
}
