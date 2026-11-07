import type { CleanerAssistant } from "../cleaner-core/assistant";
import type { Tenant } from "../cleaner-core/hosted/registry";
import { propertyBasePath, propertyFolder, type Property } from "../cleaner-core/hosted/properties";
import { propertyContext, type HostedCleaner } from "../cleaner-core/hosted/router";
import { liveDeskFor } from "../cleaner-core/liveDesk";
import { supplyDeskFor, type SupplyDesk, type SupplyReply } from "./desk";
import { handleSupplyTool, listedSupplyTools, SUPPLY_TOOL_NAMES, SUPPLY_TOOLS } from "./tools";

/**
 * Supply Core on the shared service, answered in this process, one desk per property. With Cleaner
 * Core on for the same property, it reads that property and its turnovers. Nothing here texts anyone.
 */

/** Cleaner Core's setup question: set up Supply Core for this property now, or not now. */
export const CHOOSE = "choose_supplies";
/** Every name Supply Core answers in some state, so one called where it isn't on is refused, never forwarded. */
export const SUPPLY_FRONT_NAMES: ReadonlySet<string> = new Set([...SUPPLY_TOOL_NAMES, CHOOSE]);

function cleaningDesk(h: HostedCleaner, tenant: Tenant, property: Property) {
  const ctx = propertyContext(h, tenant, property);
  return liveDeskFor(ctx.root, ctx.env, () => h.now());
}

/** The property's Supply Core desk. With cleaning on, the property and turnovers come from its Cleaner Core. */
export function supplyDesk(h: HostedCleaner, tenant: Tenant, property: Property): SupplyDesk {
  const id = tenant.id;
  const root = propertyFolder(h.dataRoot, id, property);
  const current = () => {
    const account = h.registry.get(id) ?? tenant;
    return { account, property: account.properties.find((p) => p.id === property.id) ?? property };
  };
  return supplyDeskFor(root, {
    now: () => h.now(),
    get standalone() {
      return !current().property.flows.cleaning.on;
    },
    get cleaning() {
      const now = current();
      if (!now.property.flows.cleaning.on) return undefined;
      return {
        property: () => cleaningDesk(h, now.account, now.property).propertyForSupplies(),
        turnovers: () => cleaningDesk(h, now.account, now.property).turnoverDates(),
      };
    },
    uploadBase: () => {
      const origin = h.origin();
      return origin ? `${origin}${propertyBasePath(id, current().property)}` : undefined;
    },
  });
}

const grok = (assistant: CleanerAssistant) => assistant === "grok";

/** Supply Core's tools as tools/list shows them: only for a Grok chat, which shops with its own tools. */
export function listedSupplyFront(assistant: CleanerAssistant): Record<string, unknown>[] {
  if (!grok(assistant)) return [];
  return listedSupplyTools(SUPPLY_TOOLS.map((tool) => tool.name));
}

/** Cleaner Core's setup question about Supply Core, listed for a Grok chat while any property runs Cleaner Core. */
export function listedChooseSupplies(assistant: CleanerAssistant): Record<string, unknown>[] {
  return grok(assistant) ? [CHOOSE_TOOL] : [];
}

const CHOOSE_TOOL = {
  name: CHOOSE,
  title: "Set up Supply Core now?",
  description: "The host's answer to Cleaner Core's setup question about Supply Core for this property: on true turns it on and sets it up now, on false leaves it for later. Either way, setup doesn't ask again.",
  inputSchema: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"], additionalProperties: false },
};

/** The line Cleaner Core's get_state carries while Supply Core is on for the property. */
export function suppliesLine(h: HostedCleaner, tenant: Tenant, property: Property): string | undefined {
  if (!property.flows.cleaning.on || !property.flows.supplies.on) return undefined;
  return supplyDesk(h, tenant, property).summaryLine();
}

/** Turns Supply Core on for the property: the flow, the record, and Cleaner Core's engine. */
export async function turnOnSupplies(h: HostedCleaner, tenant: Tenant, property: Property): Promise<void> {
  h.registry.setFlow(tenant.id, property.id, "supplies", true);
  const now = h.registry.get(tenant.id) ?? tenant;
  const updated = now.properties.find((p) => p.id === property.id) ?? property;
  await supplyDesk(h, now, updated).turnOn();
  if (updated.flows.cleaning.on) {
    await cleaningDesk(h, now, updated).noteSuppliesChoice();
    cleaningDesk(h, now, updated).refreshSupplyAsk();
  }
  h.log(`${tenant.id}/${property.id} turned Supply Core on.`);
}

/** Turns Supply Core off for the property: no new orders and no supplies question. The list is kept. */
export async function turnOffSupplies(h: HostedCleaner, tenant: Tenant, property: Property): Promise<void> {
  await supplyDesk(h, tenant, property).turnOff();
  h.registry.setFlow(tenant.id, property.id, "supplies", false);
  if (property.flows.cleaning.on) cleaningDesk(h, tenant, property).refreshSupplyAsk();
  h.log(`${tenant.id}/${property.id} turned Supply Core off.`);
}

/** The host's answer to Cleaner Core's Supply Core question for this property. */
export async function chooseSupplies(h: HostedCleaner, tenant: Tenant, property: Property, args: unknown): Promise<SupplyReply> {
  const on = (args as { on?: unknown } | undefined)?.on;
  if (typeof on !== "boolean") return { text: "Pass on: true to set Supply Core up now, or on: false for later.", isError: true };
  if (property.flows.cleaning.on) await cleaningDesk(h, tenant, property).noteSuppliesChoice();
  if (!on) return { text: "Okay, no Supply Core for now. Tell the host they can set it up later by asking you to reorder supplies. Then call get_state for Cleaner Core's next step.", structured: { supplies: false }, isError: false };
  if (!property.flows.supplies.on) await turnOnSupplies(h, tenant, property);
  return { text: "Supply Core is on. Set it up now: call get_supply_state and follow its ask. When it's activated, call get_state for Cleaner Core's next step. If the new tools don't appear, start a new chat.", structured: { supplies: true }, isError: false };
}

/** Answers one Supply Core tool for the property. Undefined when the name isn't Supply Core's. */
export async function supplyCall(h: HostedCleaner, tenant: Tenant, property: Property, assistant: CleanerAssistant, name: string, args: unknown): Promise<SupplyReply | undefined> {
  if (!SUPPLY_FRONT_NAMES.has(name)) return undefined;
  if (!grok(assistant)) return { text: GROK_ONLY, isError: true };
  if (name === CHOOSE) return chooseSupplies(h, tenant, property, args);
  const reply = await handleSupplyTool(supplyDesk(h, tenant, property), name, args);
  // Activating reopens Cleaner Core's engine, so the next DONE already asks about supplies.
  if (reply && !reply.isError && name === "activate_supplies" && property.flows.cleaning.on) cleaningDesk(h, tenant, property).refreshSupplyAsk();
  return reply;
}

export const GROK_ONLY = "Supply Core works with Grok only for now: it shops with Grok's own shopping tools and Vault.";
