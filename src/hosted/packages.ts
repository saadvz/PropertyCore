import { packageArrivalsOn } from "../cleaner-core/flag";
import { liveDeskFor } from "../cleaner-core/liveDesk";
import { sendLiveSms } from "../cleaner-core/liveSms";
import { propertyFolder, type Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import { propertyContext, type HostedCleaner } from "../cleaner-core/hosted/router";
import { hubFor } from "../hub/hub";
import { lockAdapter, smartLocksOn } from "../locks/registry";
import { packageDeskFor } from "../package-arrivals/desk";
import { BRING_IN_CODE_TOOLS, handlePackageTool, PACKAGE_TOOL_NAMES, PACKAGE_TOOLS } from "../package-arrivals/tools";
import { hostNotePath } from "./hostAlerts";
import type { FrontReply } from "./serviceTools";

/**
 * Package arrivals (#241) on the shared service, behind PACKAGE_ARRIVALS=1, answered in this process, for a
 * property that runs Supply Core. It writes the property's packages.json. Only on a property on connected locks
 * (SMART_LOCKS) does it do more: after each call it syncs the bring-in codes and texts a person their own code
 * once, under the host's choice; the reply's lockNotes are for the host and never hold a code.
 */

export const PACKAGE_FRONT_NAMES: ReadonlySet<string> = PACKAGE_TOOL_NAMES;

/** The package tools as tools/list shows them: while the flag is on and any property runs Supply Core. */
export function listedPackageFront(h: HostedCleaner, tenant: Tenant): Record<string, unknown>[] {
  if (!packageArrivalsOn(h.baseEnv()) || !tenant.properties.some((property) => property.flows.supplies.on)) return [];
  const env = h.baseEnv();
  return [...PACKAGE_TOOLS, ...(smartLocksOn(env) && lockAdapter() ? BRING_IN_CODE_TOOLS : [])];
}

/** Answers one package tool for the property it names. */
export async function packageCall(h: HostedCleaner, tenant: Tenant, property: Property, name: string, args: Record<string, unknown>): Promise<FrontReply> {
  if (!packageArrivalsOn(h.baseEnv())) return { text: "Package arrivals isn't available yet.", isError: true };
  if (!property.flows.supplies.on) return { text: `Supply Core doesn't run at ${property.label}, so it has no expected packages.`, isError: true };
  const fresh = () => {
    const account = h.registry.get(tenant.id) ?? tenant;
    return { account, property: account.properties.find((item) => item.id === property.id) ?? property };
  };
  const ctx = () => propertyContext(h, fresh().account, fresh().property);
  const desk = packageDeskFor(propertyFolder(h.dataRoot, tenant.id, property), {
    now: () => h.now(),
    door: () => (smartLocksOn(h.baseEnv()) ? hubFor(ctx().root, { now: () => h.now() }).doorAccess(() => ctx().env()) : undefined),
    // Texts go only where Cleaner Core says texts can go out from this property (the host's phone confirmed).
    textsAllowed: async () => {
      const now = fresh();
      if (!now.property.flows.cleaning.on) return false;
      const c = propertyContext(h, now.account, now.property);
      return (await liveDeskFor(c.root, c.env, () => h.now()).textsAllowed()) === true;
    },
    // The body is never logged or kept: sendLiveSms hands it to Twilio and keeps only the message id.
    send: async (to, body) => (await sendLiveSms(ctx().env(), { to, body })) !== undefined,
    // The host-alert clock (#250) tells the host about packages not seen where Cleaner Core or Fixer Core runs.
    alertsByClock: () => hostNotePath(fresh().property),
  });
  const reply = handlePackageTool(desk, name, args);
  if (!reply) return { text: "Package arrivals couldn't answer that.", isError: true };
  if (reply.isError) return reply;
  const { notes } = await desk.syncCodes();
  if (notes.length === 0) return reply;
  const structured = { ...(reply.structured ?? {}), lockNotes: notes, lockNext: "Tell the host each of lockNotes once." };
  return { text: JSON.stringify(structured), structured, isError: false };
}
