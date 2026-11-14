import { hoursLogOn } from "../cleaner-core/flag";
import { propertyFolder, type Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import { hoursDeskFor } from "../hours-log/desk";
import { handleHoursTool, HOURS_TOOL_NAMES, HOURS_TOOLS } from "../hours-log/tools";
import type { FrontReply } from "./serviceTools";

/**
 * The hours log (#238) on the shared service, behind HOURS_LOG=1: built from each property's own records,
 * answered in this process. It writes only the property's hours.json, and texts nobody.
 */

export const HOURS_FRONT_NAMES: ReadonlySet<string> = HOURS_TOOL_NAMES;

const anyFlowOn = (property: Property) => property.flows.cleaning.on || property.flows.supplies.on || property.flows.fixer.on;

/** The hours log tools as tools/list shows them: while the flag is on and any property runs a flow. */
export function listedHoursFront(h: HostedCleaner, tenant: Tenant): Record<string, unknown>[] {
  if (!hoursLogOn(h.baseEnv()) || !tenant.properties.some(anyFlowOn)) return [];
  return [...HOURS_TOOLS];
}

/** Answers one hours log tool for the property it names. */
export async function hoursCall(h: HostedCleaner, tenant: Tenant, property: Property, name: string, args: Record<string, unknown>): Promise<FrontReply> {
  if (!hoursLogOn(h.baseEnv())) return { text: "The hours log isn't available yet.", isError: true };
  if (!anyFlowOn(property)) return { text: `Nothing runs at ${property.label} yet, so it has no hours log.`, isError: true };
  const desk = hoursDeskFor(propertyFolder(h.dataRoot, tenant.id, property), { now: () => h.now() });
  return (await handleHoursTool(desk, name, args)) ?? { text: "The hours log couldn't answer that.", isError: true };
}
