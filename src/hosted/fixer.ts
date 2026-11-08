import { createHash } from "node:crypto";
import { FIXER_AGENTS_ONLY, runsFixer, type CleanerAssistant } from "../cleaner-core/assistant";
import { liveDeskFor } from "../cleaner-core/liveDesk";
import { sendLiveSms } from "../cleaner-core/liveSms";
import { photoKey } from "../cleaner-core/photos";
import { propertyBasePath, propertyFolder, type Property } from "../cleaner-core/hosted/properties";
import { tenantFolder, type Tenant } from "../cleaner-core/hosted/registry";
import { propertyContext, type HostedCleaner } from "../cleaner-core/hosted/router";
import { parsePhone } from "../core/phone";
import { CARD_REFUSAL, fixerDeskFor, type FixerDesk, type FixerReply } from "../fixer-core/desk";
import { liveBooking } from "../fixer-core/gate";
import { readFixer, type FixerFile } from "../fixer-core/store";
import { FIXER_TOOL_NAMES, handleFixerTool, listedFixerTools } from "../fixer-core/tools";
import { refuseCards } from "../hub/cards";
import { peopleFor } from "../hub/people";
import { listedSupplyTools, SUPPLY_TOOLS } from "../supply-core/tools";
import { cleaningForCheckout } from "./crossService";
import { accountPeople } from "./sharedPeople";
import { sharedRefusal } from "./sharedRoute";

/**
 * Fixer Core on the shared service, answered in this process, one desk per property. The property's
 * details and calendars come from its hub; texts go out on the account's line, and only to a pro who
 * said YES. Grok Bot and Muse run it; a plain chat gets one line saying so.
 */

/** The Fixer Core tools the front lists for a Grok Bot or Muse chat. */
export const FIXER_FRONT_NAMES: ReadonlySet<string> = FIXER_TOOL_NAMES;
const PREVIEW = "preview_schedule";
const PHOTOS = "get_job_photos";

/** The account's property as saved now, or as passed. */
function current(h: HostedCleaner, tenant: Tenant, property: Property): { account: Tenant; property: Property } {
  const account = h.registry.get(tenant.id) ?? tenant;
  return { account, property: account.properties.find((p) => p.id === property.id) ?? property };
}

/** The property's Cleaner Core desk while Cleaner Core runs there. */
function cleaningDesk(h: HostedCleaner, tenant: Tenant, property: Property) {
  const now = current(h, tenant, property);
  if (!now.property.flows.cleaning.on) return undefined;
  const ctx = propertyContext(h, now.account, now.property);
  return liveDeskFor(ctx.root, ctx.env, () => h.now());
}

/**
 * The property's Fixer Core desk. Every dependency reads the account again on each call, so a flow
 * turned on or off since the desk opened is seen at once. Texts to pros, the business name and the
 * host's notes go through Cleaner Core while it runs at the property; without it, no pro is texted.
 */
export function fixerDesk(h: HostedCleaner, tenant: Tenant, property: Property): FixerDesk {
  const id = tenant.id;
  const ctx = () => {
    const now = current(h, tenant, property);
    return propertyContext(h, now.account, now.property);
  };
  return fixerDeskFor(propertyFolder(h.dataRoot, id, property), {
    now: () => h.now(),
    propertyId: property.id,
    people: () => peopleFor(tenantFolder(h.dataRoot, id), { now: () => h.now() }),
    cleaningOn: () => current(h, tenant, property).property.flows.cleaning.on,
    cleanings: (checkoutYmd) => {
      const now = current(h, tenant, property);
      return cleaningForCheckout(h, now.account, now.property, checkoutYmd);
    },
    env: () => ctx().env(),
    publicBase: () => {
      const origin = h.origin();
      return origin ? `${origin}${propertyBasePath(id, current(h, tenant, property).property)}` : undefined;
    },
    // The body is never logged or kept: sendLiveSms hands it to Twilio and keeps only the message id.
    send: async (to, body) => (await sendLiveSms(ctx().env(), { to, body })) !== undefined,
    textsAllowed: async () => (await cleaningDesk(h, tenant, property)?.textsAllowed()) ?? false,
    business: async () => cleaningDesk(h, tenant, property)?.businessName(),
    notifyHost: async (noteId, text) => {
      await cleaningDesk(h, tenant, property)?.noteForHost(noteId, text);
    },
    photoKey: () => {
      const c = ctx();
      return photoKey(c.env(), c.saveSecrets);
    },
  });
}

/** Fixer Core's tools as tools/list shows them: only for Grok Bot and Muse. With them, Supply Core's preview and Cleaner Core's photos. */
export function listedFixerFront(assistant: CleanerAssistant): Record<string, unknown>[] {
  if (!runsFixer(assistant)) return [];
  return [...listedFixerTools([...FIXER_TOOL_NAMES]), ...listedSupplyTools([PREVIEW]), PHOTOS_TOOL];
}

const PHOTOS_TOOL = {
  name: PHOTOS,
  title: "A job's photos",
  description: "Links to a job's photos, each good for an hour: a repair job's id (job_…) from Fixer Core, or a cleaning job's from Cleaner Core.",
  inputSchema: { type: "object", properties: { job: { type: "string", maxLength: 80 } }, required: ["job"], additionalProperties: false },
};

/** True when a get_job_photos call names a Fixer Core job. */
export function namesRepairJob(args: Record<string, unknown>): boolean {
  return typeof args.job === "string" && args.job.startsWith("job_");
}

/** The line Cleaner Core's and Supply Core's get_state carry while Fixer Core is on for the property. */
export function repairsLine(h: HostedCleaner, tenant: Tenant, property: Property, assistant: CleanerAssistant): string | undefined {
  if (!property.flows.fixer.on || !runsFixer(assistant)) return undefined;
  return fixerDesk(h, tenant, property).summaryLine();
}

/**
 * Turns Fixer Core on for the property: the record first, then the flow. Setup starts; nobody is
 * contacted. A record that can't be read leaves the flow off, and the reply says why.
 */
export async function turnOnFixer(h: HostedCleaner, tenant: Tenant, property: Property): Promise<FixerReply> {
  const reply = await fixerDesk(h, tenant, property).turnOn();
  if (reply.isError) return reply;
  h.registry.setFlow(tenant.id, property.id, "fixer", true);
  cleaningDesk(h, tenant, property)?.refreshSupplyAsk();
  return reply;
}

/**
 * Turns Fixer Core off for the property. With `cancel`, every job still going is cancelled and the
 * reply lists the pros to tell and any door-code question. The pros and upkeep are kept.
 */
export async function turnOffFixer(h: HostedCleaner, tenant: Tenant, property: Property, cancel: boolean): Promise<FixerReply> {
  const reply = await fixerDesk(h, tenant, property).turnOff(cancel);
  // A record that can't be read still lets the host turn the flow off: nothing more runs for it.
  if (reply.isError) h.log(`${tenant.id}/${property.id}'s Fixer Core record couldn't be read while turning it off.`);
  h.registry.setFlow(tenant.id, property.id, "fixer", false);
  cleaningDesk(h, tenant, property)?.refreshSupplyAsk();
  return reply;
}

/** The record, or undefined when it can't be read. */
function readOrNone(root: string): FixerFile | undefined {
  try {
    return readFixer(root);
  } catch {
    return undefined;
  }
}

/** The jobs turning Fixer Core off would cancel, when a visit is booked; empty when none is. */
export function jobsToCancel(h: HostedCleaner, tenant: Tenant, property: Property): { jobId: string; what: string; state: string; proName?: string }[] {
  const file = readOrNone(propertyFolder(h.dataRoot, tenant.id, property));
  if (!file?.jobs.some(liveBooking)) return [];
  const proName = (id: string | undefined) => (id ? (file.pros.find((p) => p.id === id)?.name ?? file.jobs.flatMap((j) => j.candidates).find((c) => c.id === id)?.name) : undefined);
  return file.jobs
    .filter((job) => job.state !== "done" && job.state !== "cancelled")
    .map((job) => {
      const name = liveBooking(job) ? proName(job.booking?.proId) : undefined;
      return { jobId: job.id, what: job.what, state: job.state, ...(name ? { proName: name } : {}) };
    });
}

/** What the host's yes to turning Fixer Core off is bound to: the jobs and each booking as it stands. */
export function cancelFingerprint(h: HostedCleaner, tenant: Tenant, property: Property): string {
  const file = readOrNone(propertyFolder(h.dataRoot, tenant.id, property));
  const open = (file?.jobs ?? []).filter((job) => job.state !== "done" && job.state !== "cancelled").map((job) => [job.id, job.state, job.booking?.fingerprint ?? ""]);
  return createHash("sha256").update(JSON.stringify(["fixer-off", property.id, open])).digest("hex");
}

/**
 * Before save_pro: a phone already on another of the account's properties, in any role (a pro there
 * too), needs the host's shared: true. The refusal goes to the agent only. Nobody is texted.
 */
async function proSharedRefusal(h: HostedCleaner, tenant: Tenant, property: Property, args: Record<string, unknown>): Promise<string | undefined> {
  if (args.shared === true || args.draft === true) return undefined;
  const phones: string[] = [];
  if (Array.isArray(args.confirm)) {
    const file = readOrNone(propertyFolder(h.dataRoot, tenant.id, property));
    for (const id of args.confirm) {
      const phone = file?.pros.find((pro) => pro.id === id && pro.status === "draft")?.reach.phone;
      if (phone) phones.push(phone);
    }
  } else {
    const raw = (args.reach as { phone?: unknown } | undefined)?.phone;
    const phone = typeof raw === "string" ? parsePhone(raw) : undefined;
    if (phone) phones.push(phone);
  }
  if (phones.length === 0) return undefined;
  const people = await accountPeople(h, tenant);
  const others = current(h, tenant, property).account.properties.filter((p) => p.id !== property.id);
  const places = [...new Set(phones)].flatMap((phone) =>
    (people.person(phone)?.where ?? []).flatMap((w) => {
      const label = others.find((p) => p.id === w.propertyId)?.label;
      return label ? [{ label, role: w.role }] : [];
    }),
  );
  return places.length > 0 ? sharedRefusal(places) : undefined;
}

/** Answers one Fixer Core tool for the property. Undefined when the name isn't Fixer Core's. */
export async function fixerCall(h: HostedCleaner, tenant: Tenant, property: Property, assistant: CleanerAssistant, name: string, args: Record<string, unknown>): Promise<FixerReply | undefined> {
  if (!FIXER_TOOL_NAMES.has(name)) return undefined;
  if (!runsFixer(assistant)) return { text: FIXER_AGENTS_ONLY, isError: true };
  // The account's people list is moved from the older files before any pro is saved into it.
  await accountPeople(h, tenant);
  if (name === "save_pro" && !refuseCards(args)) {
    const refusal = await proSharedRefusal(h, tenant, property, args);
    if (refusal) return { text: refusal, isError: true };
  }
  // With Cleaner Core on, its desk opens first, so its checks guard the hub's saves even after a restart.
  const cleaning = cleaningDesk(h, tenant, property);
  const reply = await handleFixerTool(fixerDesk(h, tenant, property), name, args);
  // Asking the cleaner "Anything broken?" follows Fixer Core's settings: Cleaner Core's engine reads them again.
  if (reply && !reply.isError && (name === "save_fixer_settings" || name === "activate_fixer")) cleaning?.refreshSupplyAsk();
  return reply;
}

/** Fixer Core's preview of an upkeep schedule, when Supply Core doesn't answer it for the property. Its input is Supply Core's, strict. */
export async function fixerPreview(h: HostedCleaner, tenant: Tenant, property: Property, args: Record<string, unknown>): Promise<FixerReply> {
  if (refuseCards(args)) return { text: CARD_REFUSAL, isError: true };
  const parsed = SUPPLY_TOOLS.find((tool) => tool.name === PREVIEW)!.input.safeParse(args);
  if (!parsed.success) return { text: "Pass one schedule: every so many days, a day of the month, or another rule.", isError: true };
  return fixerDesk(h, tenant, property).previewSchedule(parsed.data as never);
}

/** A repair job's photo links. Card-like text is refused before the desk, as on every Fixer Core tool. */
export async function fixerPhotos(h: HostedCleaner, tenant: Tenant, property: Property, args: Record<string, unknown>): Promise<FixerReply> {
  if (refuseCards(args)) return { text: CARD_REFUSAL, isError: true };
  return fixerDesk(h, tenant, property).jobPhotos(String(args.job));
}

/** Within this long of a done, a job's photos may still be due to go. */
const PHOTO_WATCH_MS = 31 * 24 * 60 * 60_000;

/** True when the clock pass has something to do: a booked visit, or a done job whose photos may be due to go. */
function needsTick(root: string, now: Date): boolean {
  const file = readOrNone(root);
  // A record that can't be read is left to the desk, which skips it.
  if (!file) return true;
  if (!file.settings.activatedAt) return false;
  return file.jobs.some((job) => (liveBooking(job) && job.booking?.hostYes) || (job.done && now.getTime() - Date.parse(job.done.at) < PHOTO_WATCH_MS));
}

/** One clock pass for one property with Fixer Core on. Skipped when nothing is booked or due. */
export async function tickFixer(h: HostedCleaner, tenant: Tenant, property: Property): Promise<void> {
  if (!needsTick(propertyFolder(h.dataRoot, tenant.id, property), h.now())) return;
  await accountPeople(h, tenant);
  await fixerDesk(h, tenant, property).tick();
}
