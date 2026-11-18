import { remoteOversightOn } from "../cleaner-core/flag";
import { propertyFolder, type Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import { oversightDeskFor } from "../oversight/desk";
import { handleOversightTool, OVERSIGHT_TOOL_NAMES, OVERSIGHT_TOOLS } from "../oversight/tools";
import type { FrontReply } from "./serviceTools";

/**
 * Remote oversight's expected visits (#240) on the shared service, behind REMOTE_OVERSIGHT=1, answered in this
 * process. It writes only the property's oversight.json, and texts nobody. Entry events come with the lock
 * connection (#180), and sending the same-day flag waits on #250.
 */

export const OVERSIGHT_FRONT_NAMES: ReadonlySet<string> = OVERSIGHT_TOOL_NAMES;

const anyFlowOn = (property: Property) => property.flows.cleaning.on || property.flows.supplies.on || property.flows.fixer.on;

/** The expected visit tools as tools/list shows them: while the flag is on and any property runs a flow. */
export function listedOversightFront(h: HostedCleaner, tenant: Tenant): Record<string, unknown>[] {
  if (!remoteOversightOn(h.baseEnv()) || !tenant.properties.some(anyFlowOn)) return [];
  return [...OVERSIGHT_TOOLS];
}

/** Answers one expected visit tool for the property it names. */
export function oversightCall(h: HostedCleaner, tenant: Tenant, property: Property, name: string, args: Record<string, unknown>): FrontReply {
  if (!remoteOversightOn(h.baseEnv())) return { text: "Expected visits aren't available yet.", isError: true };
  if (!anyFlowOn(property)) return { text: `Nothing runs at ${property.label} yet, so it has no expected visits.`, isError: true };
  const desk = oversightDeskFor(propertyFolder(h.dataRoot, tenant.id, property), { now: () => h.now() });
  return handleOversightTool(desk, name, args) ?? { text: "Expected visits couldn't answer that.", isError: true };
}
