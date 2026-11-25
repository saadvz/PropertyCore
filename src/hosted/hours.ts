import { featureOn } from "../features/features";
import { propertyFolder, type Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import { hoursDeskFor } from "../hours-log/desk";
import { handleHoursTool, HOURS_TOOL_NAMES, HOURS_TOOLS } from "../hours-log/tools";
import type { FrontReply } from "./serviceTools";

/**
 * The hours log (#238) on the shared service, behind the account's "hours" switch: built from each property's own records,
 * answered in this process. It writes only the property's hours.json, and texts nobody.
 */

export const HOURS_FRONT_NAMES: ReadonlySet<string> = HOURS_TOOL_NAMES;

const anyFlowOn = (property: Property) => property.flows.cleaning.on || property.flows.supplies.on || property.flows.fixer.on;

/** The hours log tools as tools/list shows them: while the account's switch is on and any property runs a flow. */
export function listedHoursFront(h: HostedCleaner, tenant: Tenant): Record<string, unknown>[] {
  if (!featureOn(tenant, "hours", h.baseEnv()) || !tenant.properties.some(anyFlowOn)) return [];
  return [...HOURS_TOOLS];
}

/** Answers one hours log tool for the property it names. */
export async function hoursCall(h: HostedCleaner, tenant: Tenant, property: Property, name: string, args: Record<string, unknown>): Promise<FrontReply> {
  if (!featureOn(tenant, "hours", h.baseEnv())) return { text: "The hours log isn't available yet.", isError: true };
  if (!anyFlowOn(property)) return { text: `Nothing runs at ${property.label} yet, so it has no hours log.`, isError: true };
  const desk = hoursDeskFor(propertyFolder(h.dataRoot, tenant.id, property), { now: () => h.now(), cameras: () => featureOn(h.registry.get(tenant.id), "cameras", h.baseEnv()) });
  return (await handleHoursTool(desk, name, args)) ?? { text: "The hours log couldn't answer that.", isError: true };
}
