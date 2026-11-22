import { featureOn } from "../features/features";
import { propertyFolder, type Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import { stayCheckDeskFor } from "../stay-check/desk";
import { handleStayCheckTool, STAY_CHECK_TOOL_NAMES, STAY_CHECK_TOOLS } from "../stay-check/tools";
import type { FrontReply } from "./serviceTools";

/**
 * The house rules (#239) on the shared service, answered in this process. They're one list (#15): the nightly
 * stay check reads it behind the account's "stay-check" switch, and guest replies draft from it behind
 * "guest-messages". The tools are listed while either switch is on; a camera check can be saved only with
 * "stay-check" on. It writes only the property's stay-check.json, guest-facts.json (moving an older rules
 * fact onto the list) and host-steps.jsonl, and texts nobody.
 */

export const STAY_CHECK_FRONT_NAMES: ReadonlySet<string> = STAY_CHECK_TOOL_NAMES;

const anyFlowOn = (property: Property) => property.flows.cleaning.on || property.flows.supplies.on || property.flows.fixer.on;

/** Only the nightly check's own tools need its switch; the house rules list is shared with guest replies. */
const CHECK_ONLY: ReadonlySet<string> = new Set(["allow_for_stay", "mark_flag_false"]);

const switches = (h: HostedCleaner, tenant: Tenant) => ({ checks: featureOn(tenant, "stay-check", h.baseEnv()), guestReplies: featureOn(tenant, "guest-messages", h.baseEnv()) });

/** The house rules tools as tools/list shows them: while either switch is on and any property runs a flow. The check's own tools need its switch. */
export function listedStayCheckFront(h: HostedCleaner, tenant: Tenant): Record<string, unknown>[] {
  const on = switches(h, tenant);
  if (!(on.checks || on.guestReplies) || !tenant.properties.some(anyFlowOn)) return [];
  return STAY_CHECK_TOOLS.filter((tool) => on.checks || !CHECK_ONLY.has(tool.name as string));
}

/** Answers one house rules tool for the property it names. */
export function stayCheckCall(h: HostedCleaner, tenant: Tenant, property: Property, name: string, args: Record<string, unknown>): FrontReply {
  const on = switches(h, tenant);
  if (!on.checks && (!on.guestReplies || CHECK_ONLY.has(name))) return { text: "The nightly stay check isn't available yet.", isError: true };
  if (!anyFlowOn(property)) return { text: `Nothing runs at ${property.label} yet, so it has no nightly stay check.`, isError: true };
  const desk = stayCheckDeskFor(propertyFolder(h.dataRoot, tenant.id, property), { now: () => h.now(), ...on });
  return handleStayCheckTool(desk, name, args) ?? { text: "The nightly stay check couldn't answer that.", isError: true };
}
