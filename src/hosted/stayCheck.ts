import { featureOn } from "../features/features";
import { propertyFolder, type Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import { stayCheckDeskFor } from "../stay-check/desk";
import { handleStayCheckTool, STAY_CHECK_TOOL_NAMES, STAY_CHECK_TOOLS } from "../stay-check/tools";
import type { FrontReply } from "./serviceTools";

/**
 * The nightly stay check's house rules (#239) on the shared service, behind the account's "stay-check" switch, answered in this
 * process. It writes only the property's stay-check.json, and texts nobody. Nothing records cameras yet, so the
 * account's switch is the only gate; the camera connection adds a per-property one.
 */

export const STAY_CHECK_FRONT_NAMES: ReadonlySet<string> = STAY_CHECK_TOOL_NAMES;

const anyFlowOn = (property: Property) => property.flows.cleaning.on || property.flows.supplies.on || property.flows.fixer.on;

/** The house rules tools as tools/list shows them: while the account's switch is on and any property runs a flow. */
export function listedStayCheckFront(h: HostedCleaner, tenant: Tenant): Record<string, unknown>[] {
  if (!featureOn(tenant, "stay-check", h.baseEnv()) || !tenant.properties.some(anyFlowOn)) return [];
  return [...STAY_CHECK_TOOLS];
}

/** Answers one house rules tool for the property it names. */
export function stayCheckCall(h: HostedCleaner, tenant: Tenant, property: Property, name: string, args: Record<string, unknown>): FrontReply {
  if (!featureOn(tenant, "stay-check", h.baseEnv())) return { text: "The nightly stay check isn't available yet.", isError: true };
  if (!anyFlowOn(property)) return { text: `Nothing runs at ${property.label} yet, so it has no nightly stay check.`, isError: true };
  const desk = stayCheckDeskFor(propertyFolder(h.dataRoot, tenant.id, property), { now: () => h.now() });
  return handleStayCheckTool(desk, name, args) ?? { text: "The nightly stay check couldn't answer that.", isError: true };
}
