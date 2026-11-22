import { propertyFolder, type Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner } from "../cleaner-core/hosted/router";
import type { CleanerAssistant } from "../cleaner-core/assistant";
import { JOB_NAMES, type CoreJob } from "../jobs/jobs";
import { readSupply } from "../supply-core/store";
import { noteQuiet } from "./botTools";
import { fixerCall } from "./fixer";
import { holder } from "./jobDeps";
import { FILING_TOOLS, type FilingTool, type ToolCaller } from "./jobTools";
import { wakeOrKeep, type FiledJob } from "./jobWake";
import { flowOff } from "./propertyTools";
import type { FrontReply } from "./serviceTools";
import { supplyCall, supplyDesk } from "./supplies";

/**
 * Filing between cores (#250). A chat that runs Cleaner Core but not the core a tool belongs to may still file into
 * it: read Supply Core's list for its item ids, mark items low, and open a repair the cleaner reported. The filing is
 * an ordinary write to the owning core's own record, so there is no second ledger. What changes is the reply: the
 * filing chat is told only that it was filed, never the owning core's question, and the bot that holds the owning
 * core is woken to work it.
 */

export { FILING_TOOLS, isFiling } from "./jobTools";

export const FILING_SOURCE = "From this chat, source must be cleaner.";

/** What the filing chat is told. The bot named is the Property Core bot when the owning core has no bot of its own. */
export function filedLine(tool: "report_low" | "open_job", ownBot: boolean): string {
  const owner: CoreJob = FILING_TOOLS[tool];
  const bot = `The ${JOB_NAMES[ownBot ? owner : "property"]} bot`;
  return tool === "report_low" ? `Filed. ${bot} orders these.` : `Filed. ${bot} asks the host.`;
}

const fail = (text: string): FrontReply => ({ text, isError: true });
const ok = (text: string, structured: Record<string, unknown>): FrontReply => ({ text, structured, isError: false });

type Caller = ToolCaller & { grantId: string; assistant: CleanerAssistant };

/** Wakes the bot that holds the owning core. A wake-up that doesn't go through never undoes the filing: it is kept and tried again by the clock, and the record is read on that bot's next check either way. */
async function wakeOwner(h: HostedCleaner, tenant: Tenant, owner: FiledJob): Promise<void> {
  try {
    await wakeOrKeep(h, tenant, owner);
    await noteQuiet(h, tenant.id, owner);
  } catch {
    // The filing is already written.
  }
}

/** Answers a filing for the property it names: the owning desk's own tool, then the reply cut down and the holder woken. */
export async function fileCall(h: HostedCleaner, tenant: Tenant, property: Property, caller: Caller, name: FilingTool, args: Record<string, unknown>): Promise<FrontReply> {
  const owner: FiledJob = FILING_TOOLS[name];
  if (!property.flows[owner].on) return fail(flowOff(owner, property.label));
  if (name === "get_supply_state") {
    // Read only, and only what matching a cleaner's words to the list takes: the rest of Supply Core's state carries its questions.
    await supplyDesk(h, tenant, property).state();
    const items = readSupply(propertyFolder(h.dataRoot, tenant.id, property)).items.map((item) => ({ id: item.id, name: item.name }));
    return ok(JSON.stringify({ items }), { items });
  }
  if (args.source !== "cleaner") return fail(FILING_SOURCE);
  const reply = owner === "supplies" ? await supplyCall(h, tenant, property, caller.assistant, name, args) : await fixerCall(h, tenant, property, caller.assistant, name, args, caller.grantId);
  if (!reply) return fail(`${JOB_NAMES[owner]} couldn't take that.`);
  // The owning desk's own refusal says what to fix in the call. Nothing else of its reply is passed on.
  if (reply.isError) return fail(reply.text);
  const account = h.registry.get(tenant.id) ?? tenant;
  const ownBot = Boolean(holder(h, account, owner)?.job);
  await wakeOwner(h, account, owner);
  if (name === "report_low") return ok(filedLine(name, ownBot), { filed: true });
  const jobId = reply.structured?.jobId;
  return ok(filedLine("open_job", ownBot), { filed: true, ...(typeof jobId === "string" ? { jobId } : {}) });
}
