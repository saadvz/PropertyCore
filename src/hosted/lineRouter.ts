import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePhone } from "../core/phone";
import type { Property } from "../cleaner-core/hosted/properties";
import { tenantFolder, type Tenant } from "../cleaner-core/hosted/registry";
import { propertyContext, type HostedCleaner, type HostedRequest } from "../cleaner-core/hosted/router";
import { liveDeskFor } from "../cleaner-core/liveDesk";
import { sendLiveSms } from "../cleaner-core/liveSms";
import { handleCleanerTwilioWebhook } from "../cleaner-core/twilioHook";
import { keywordOf } from "../intent/ruleBased";
import { formParams, verifyTwilioSignature } from "../messaging/twilio/signature";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { isStartText, isStopText, TenantOptOuts } from "./crossService";

/**
 * One-to-one texts on an account's shared line. The `To` number names the account; the sender names
 * the property. Group texts and status callbacks never come here: they arrive on a property's own
 * /t/<id>/… path. With one property running Cleaner Core, every text goes to it, as before. With
 * more, the host runs everything from the agent: their STOP and START reach every property where
 * they're the host, and anything else they text changes nothing.
 */

export const LANDLORD_USE_AGENT = "Please tell me in your agent chat so I know which property.";
/** The landlord's reply goes out at most once in this long per phone. */
const REPLY_EVERY_MS = 12 * 60 * 60_000;
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export type LineRoute =
  | { kind: "property"; property: Property }
  | { kind: "host-all"; properties: Property[] }
  | { kind: "host-unused"; property: Property }
  | { kind: "host-help" }
  | { kind: "unknown" };

/** Where a one-to-one text goes. Only properties running Cleaner Core count. */
export function routeLineText(tenant: Tenant, from: string, text: string, phones: (property: Property) => { host?: string; people: string[] }): LineRoute {
  const cleaning = tenant.properties.filter((p) => p.flows.cleaning.on);
  if (cleaning.length === 0) return { kind: "unknown" };
  if (cleaning.length === 1) return { kind: "property", property: cleaning[0]! };
  const known = cleaning.map((property) => ({ property, ...phones(property) }));
  const person = known.find((entry) => entry.people.includes(from));
  if (person) return { kind: "property", property: person.property };
  const hosted = known.filter((entry) => entry.host === from).map((entry) => entry.property);
  if (hosted.length > 0) {
    // Only STOP and START words reach every property. A bare YES would act as the host's answer on
    // each desk (saving times, sending offers), so it changes nothing, like any other host text.
    if (isStopText(text) || keywordOf(text) === "start") return { kind: "host-all", properties: hosted };
    if (keywordOf(text) === "help") return { kind: "host-help" };
    return { kind: "host-unused", property: hosted[0]! };
  }
  return { kind: "unknown" };
}

/** Each property's saved phones, read from its desk. */
async function phonesOf(h: HostedCleaner, tenant: Tenant): Promise<Map<string, { host?: string; people: string[] }>> {
  const out = new Map<string, { host?: string; people: string[] }>();
  for (const property of tenant.properties.filter((p) => p.flows.cleaning.on)) {
    const ctx = propertyContext(h, tenant, property);
    out.set(property.id, await liveDeskFor(ctx.root, ctx.env, () => h.now()).phonesOnProperty());
  }
  return out;
}

const repliesFile = (h: HostedCleaner, tenantId: string) => join(tenantFolder(h.dataRoot, tenantId), "line-replies.json");

/** True when the landlord hasn't had the reply in the last 12 hours, and records this one. */
function replyDue(h: HostedCleaner, tenantId: string, phone: string): boolean {
  const file = repliesFile(h, tenantId);
  let doc: Record<string, string> = {};
  try {
    if (existsSync(file)) doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    doc = {};
  }
  const last = doc[phone] ? Date.parse(doc[phone]!) : 0;
  if (h.now().getTime() - last < REPLY_EVERY_MS) return false;
  writeJsonAtomic(file, { ...doc, [phone]: h.now().toISOString() });
  return true;
}

export async function handleLineText(h: HostedCleaner, r: HostedRequest, tenant: Tenant, rawBody: Buffer, signedUrl: string | undefined): Promise<void> {
  const fields = formParams(rawBody);
  // Checked first, so a forged text never changes an opt-out or reaches a desk.
  const signature = r.req.headers["x-twilio-signature"];
  if (!verifyTwilioSignature(h.baseEnv().CLEANER_CORE_TWILIO_AUTH_TOKEN?.trim(), signedUrl, fields, Array.isArray(signature) ? signature[0] : signature).ok) {
    return r.send(403, "text/plain", "Forbidden");
  }
  const from = parsePhone(fields.From ?? "") ?? "";
  const text = fields.Body ?? "";
  const phones = await phonesOf(h, tenant);
  const route = routeLineText(tenant, from, text, (p) => phones.get(p.id) ?? { people: [] });
  const toDesk = (property: Property) => {
    const ctx = propertyContext(h, tenant, property);
    return handleCleanerTwilioWebhook({ rawBody, headers: r.req.headers, url: signedUrl, env: ctx.env, root: ctx.root, now: () => h.now() });
  };
  h.registry.touch(tenant.id);
  if (route.kind === "property") {
    // A person's START or YES lifts a STOP they sent the line before they were saved, for good, so
    // saving the property's people again doesn't opt them out again.
    // A STOP holds for the whole line, so a property that saves this phone later starts opted out.
    if (from && isStopText(text)) new TenantOptOuts(h.dataRoot).stop(tenant.id, from);
    else if (from && isStartText(text)) new TenantOptOuts(h.dataRoot).start(tenant.id, from);
    const result = await toDesk(route.property);
    return r.send(result.status, result.contentType ?? "text/xml", result.body);
  }
  if (route.kind === "host-all") {
    // Kept for the whole line too, so a property added later starts with the landlord opted out.
    const optOuts = new TenantOptOuts(h.dataRoot);
    if (isStopText(text)) optOuts.stop(tenant.id, from);
    else optOuts.start(tenant.id, from);
    for (const property of route.properties) await toDesk(property);
    return r.send(200, "text/xml", EMPTY_TWIML);
  }
  if (route.kind === "host-unused") {
    const ctx = propertyContext(h, tenant, route.property);
    await liveDeskFor(ctx.root, ctx.env, () => h.now()).noteUnusedHostText(text);
    if (replyDue(h, tenant.id, from)) await sendLiveSms(ctx.env(), { to: from, body: LANDLORD_USE_AGENT }).catch(() => undefined);
    h.log(`The host texted ${tenant.id}'s line one-to-one. It wasn't used: the account has several properties.`);
    return r.send(200, "text/xml", EMPTY_TWIML);
  }
  if (route.kind === "unknown" && from) {
    // A STOP from someone on no property holds for the whole line, and START or YES lifts it.
    const optOuts = new TenantOptOuts(h.dataRoot);
    if (isStopText(text)) optOuts.stop(tenant.id, from);
    else if (isStartText(text)) optOuts.start(tenant.id, from);
  }
  h.log(route.kind === "host-help" ? `The host texted HELP to ${tenant.id}'s line. Twilio answers it.` : `A text reached ${tenant.id}'s line from someone on no property. Nothing was sent.`);
  return r.send(200, "text/xml", EMPTY_TWIML);
}

export const phoneTaken = (label: string) => `That number is already on ${label}. For now one person can be on only one property.`;

/**
 * Until people can be shared: a phone can be the cleaner or a contact on only one of the account's
 * properties, and the landlord's phone can be the host on every property but a person on none.
 * The refusal goes to the agent only. Nobody is texted.
 */
export async function peopleRefusal(h: HostedCleaner, tenant: Tenant, property: Property, args: Record<string, unknown>): Promise<string | undefined> {
  const phone = (raw: unknown) => (typeof raw === "string" ? parsePhone(raw) : undefined);
  const contacts = Array.isArray(args.contacts) ? (args.contacts as { phone?: unknown }[]).map((c) => phone(c?.phone)) : [];
  const people = [phone(args.cleaner), phone(args.observer), ...contacts].filter((p): p is string => !!p);
  const host = phone(args.host);
  for (const other of tenant.properties) {
    if (other.id === property.id) continue;
    const ctx = propertyContext(h, tenant, other);
    if (!existsSync(join(ctx.root, "cleaner-live.json"))) continue;
    const saved = await liveDeskFor(ctx.root, ctx.env, () => h.now()).phonesOnProperty();
    if (people.some((p) => saved.people.includes(p) || p === saved.host)) return phoneTaken(other.label);
    if (host && saved.people.includes(host)) return phoneTaken(other.label);
  }
  return undefined;
}

/** After people are saved: anyone who texted STOP to the line before stays opted out on this property. */
export async function afterPeopleSaved(h: HostedCleaner, tenant: Tenant, property: Property): Promise<void> {
  const ctx = propertyContext(h, tenant, property);
  const desk = liveDeskFor(ctx.root, ctx.env, () => h.now());
  const optOuts = new TenantOptOuts(h.dataRoot);
  const { host, people } = await desk.phonesOnProperty();
  for (const phone of [...(host ? [host] : []), ...people]) if (optOuts.stopped(tenant.id, phone)) await desk.markOptedOut(phone);
}
