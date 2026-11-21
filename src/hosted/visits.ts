import { featureOn } from "../features/features";
import { propertyFolder, type Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import { visitDeskFor } from "../visits/desk";
import { handleVisitTool, VISIT_TOOL_NAMES, VISIT_TOOLS } from "../visits/tools";
import type { FrontReply } from "./serviceTools";

/**
 * Visit records (#237) on the shared service, behind the account's "visits" switch, answered in this process. The tools read the
 * property's visit log and save lock code names; they write no lock or message event, and text nobody.
 */

export const VISITS_FRONT_NAMES: ReadonlySet<string> = VISIT_TOOL_NAMES;

const visitFlowOn = (property: Property) => property.flows.cleaning.on || property.flows.fixer.on;

/** The visit tools as tools/list shows them: while the account's switch is on and any property runs Cleaner Core or Fixer Core. */
export function listedVisitsFront(h: HostedCleaner, tenant: Tenant): Record<string, unknown>[] {
  if (!featureOn(tenant, "visits", h.baseEnv()) || !tenant.properties.some(visitFlowOn)) return [];
  return [...VISIT_TOOLS];
}

/** Answers one visit tool for the property it names. */
export function visitsCall(h: HostedCleaner, tenant: Tenant, property: Property, name: string, args: Record<string, unknown>): FrontReply {
  if (!featureOn(tenant, "visits", h.baseEnv())) return { text: "Visit records aren't available yet.", isError: true };
  if (!visitFlowOn(property)) return { text: `Neither cleaning nor repairs run at ${property.label} yet, so it has no visits.`, isError: true };
  const desk = visitDeskFor(propertyFolder(h.dataRoot, tenant.id, property), { now: () => h.now() });
  return handleVisitTool(desk, name, args) ?? { text: "Visit records couldn't answer that.", isError: true };
}
