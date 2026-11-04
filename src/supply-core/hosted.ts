import type { CleanerAssistant } from "../cleaner-core/assistant";
import type { Tenant } from "../cleaner-core/hosted/registry";
import { tenantContext, type HostedCleaner } from "../cleaner-core/hosted/router";
import { liveDeskFor } from "../cleaner-core/liveDesk";
import { ConfirmationBook } from "../operator/confirmations";
import { supplyDeskFor, type SupplyDesk, type SupplyReply } from "./desk";
import { handleSupplyTool, listedSupplyTools, STANDALONE_ONLY, SUPPLY_TOOL_NAMES, SUPPLY_TOOLS } from "./tools";

/**
 * Supply Core on the shared service, answered in this process: the whole tool list of a supplies
 * tenant, and an add-on on a cleaning tenant's Grok chat. Nothing here texts anyone.
 */

export const TURN_ON = "turn_on_supplies";
export const TURN_OFF = "turn_off_supplies";
const NOT_ON = "Supply Core isn't on for this property.";
const STALE = "That approval has expired or doesn't match. Ask the host again.";
const approvals = new ConfirmationBook();

/** Every name Supply Core answers in some state, so one called where it isn't on is refused, never forwarded. */
export const SUPPLY_FRONT_NAMES: ReadonlySet<string> = new Set([...SUPPLY_TOOL_NAMES, TURN_ON, TURN_OFF]);

export const SUPPLY_INSTRUCTIONS =
  "This number runs Supply Core: the property's supplies, reordered on a schedule. Supply Core never texts anyone and never takes card details; you shop and check out with your own shopping tools and Vault. Call get_state first and follow its ask one question at a time.";

export interface SupplyFrontContext {
  h: HostedCleaner;
  tenant: Tenant;
  caller: { grantId: string; assistant: CleanerAssistant };
  noteToolsChanged(): void;
}

function cleaningDesk(h: HostedCleaner, tenant: Tenant) {
  const ctx = tenantContext(h, tenant);
  return liveDeskFor(ctx.root, ctx.env, () => h.now());
}

/** The tenant's Supply Core desk. A cleaning tenant's property and turnovers come from Cleaner Core. */
export function supplyDesk(h: HostedCleaner, tenant: Tenant): SupplyDesk {
  const id = tenant.id;
  const root = tenantContext(h, tenant).root;
  const current = () => h.registry.get(id) ?? tenant;
  return supplyDeskFor(root, {
    now: () => h.now(),
    get standalone() {
      return current().service === "supplies";
    },
    get cleaning() {
      if (current().service !== "cleaning") return undefined;
      return {
        property: () => cleaningDesk(h, current()).propertyForSupplies(),
        turnovers: () => cleaningDesk(h, current()).turnoverDates(),
      };
    },
    uploadBase: () => {
      const origin = h.origin();
      return origin ? `${origin}/t/${id}` : undefined;
    },
  });
}

const grok = (assistant: CleanerAssistant) => assistant === "grok";

/** The Supply Core names this chat sees. A supplies tenant's get_state is Supply Core's own. */
function available(tenant: Tenant, assistant: CleanerAssistant): string[] {
  if (tenant.service === "supplies") return SUPPLY_TOOLS.map((tool) => tool.name).filter((name) => name !== "get_supply_state");
  if (tenant.service === "cleaning" && grok(assistant)) {
    if (!tenant.supplies) return [TURN_ON];
    return [...SUPPLY_TOOLS.map((tool) => tool.name).filter((name) => !STANDALONE_ONLY.has(name)), TURN_OFF];
  }
  return [];
}

const TURN_TOOLS: Record<string, Record<string, unknown>> = {
  [TURN_ON]: {
    name: TURN_ON,
    title: "Turn on Supply Core",
    description: "Adds Supply Core to this property: supplies reordered on a schedule, and the cleaner asked what's running low after each DONE once it's active. Only when the host asks. Then call get_supply_state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  [TURN_OFF]: {
    name: TURN_OFF,
    title: "Turn off Supply Core",
    description: "Stops Supply Core here: no new orders and no supplies question to the cleaner. Its list is kept. Call once without confirmation to get the question and a code, ask the host, and again with the code only after their yes.",
    inputSchema: { type: "object", properties: { confirmation: { type: "string", maxLength: 40 } }, additionalProperties: false },
  },
};

const GET_STATE_ALIAS = {
  name: "get_state",
  title: "What's next",
  description: "Supply Core's setup step to ask next, or once it's active, the list, mode, caps, this month's spending, and open holds. Call first.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

/** Supply Core's tools as tools/list shows them for this chat. */
export function listedSupplyFront(tenant: Tenant, assistant: CleanerAssistant): Record<string, unknown>[] {
  const names = available(tenant, assistant);
  const turns = names.filter((name) => name in TURN_TOOLS).map((name) => TURN_TOOLS[name]!);
  return [...(tenant.service === "supplies" ? [GET_STATE_ALIAS] : []), ...listedSupplyTools(names), ...turns];
}

/** The line Cleaner Core's get_state carries while the add-on is on. */
export function suppliesLine(h: HostedCleaner, tenant: Tenant): string | undefined {
  if (tenant.service !== "cleaning" || !tenant.supplies) return undefined;
  return supplyDesk(h, tenant).summaryLine();
}

/** Answers a Supply Core tool for this chat. Undefined when the name isn't Supply Core's. */
export async function handleSupplyFront(ctx: SupplyFrontContext, name: string, args: unknown): Promise<SupplyReply | undefined> {
  const { h } = ctx;
  const tenant = h.registry.get(ctx.tenant.id) ?? ctx.tenant;
  const supplies = tenant.service === "supplies";
  if (supplies && name === "get_state") return supplyDesk(h, tenant).state();
  if (!SUPPLY_FRONT_NAMES.has(name)) return undefined;
  if (!available(tenant, ctx.caller.assistant).includes(name)) return { text: NOT_ON, isError: true };
  if (name === TURN_ON) {
    h.registry.setSupplies(tenant.id, true);
    await supplyDesk(h, tenant).turnOn();
    cleaningDesk(h, tenant).refreshSupplyAsk();
    h.log(`${tenant.id} turned Supply Core on.`);
    ctx.noteToolsChanged();
    return { text: "Supply Core is on. Call get_supply_state for the first setup step. If the new tools don't appear, start a new chat.", structured: { supplies: true }, isError: false };
  }
  if (name === TURN_OFF) {
    const code = typeof (args as { confirmation?: unknown } | undefined)?.confirmation === "string" ? (args as { confirmation: string }).confirmation.trim() : "";
    const question = "Turn off Supply Core? No new orders, and the cleaner isn't asked about supplies. Your list is kept. Reply yes to turn it off.";
    if (!code) return { text: question, structured: { question, confirmation: approvals.issue("supplies-off", tenant.id, "off", question) }, isError: false };
    try {
      approvals.redeem(code, "supplies-off", tenant.id, "off");
    } catch {
      return { text: STALE, isError: true };
    }
    await supplyDesk(h, tenant).turnOff();
    h.registry.setSupplies(tenant.id, false);
    cleaningDesk(h, tenant).refreshSupplyAsk();
    h.log(`${tenant.id} turned Supply Core off.`);
    ctx.noteToolsChanged();
    return { text: "Supply Core is off. Your list is kept.", structured: { supplies: false }, isError: false };
  }
  const reply = await handleSupplyTool(supplyDesk(h, tenant), name, args);
  // Activating reopens Cleaner Core's engine, so the next DONE already asks about supplies.
  if (reply && !reply.isError && name === "activate_supplies" && tenant.service === "cleaning") cleaningDesk(h, tenant).refreshSupplyAsk();
  return reply;
}

