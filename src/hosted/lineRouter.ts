import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePhone } from "../core/phone";
import type { Property } from "../cleaner-core/hosted/properties";
import { tenantFolder, type Tenant } from "../cleaner-core/hosted/registry";
import { propertyContext, type HostedCleaner, type HostedRequest } from "../cleaner-core/hosted/router";
import { liveDeskFor } from "../cleaner-core/liveDesk";
import { sendLiveSms } from "../cleaner-core/liveSms";
import type { InboundMedia } from "../cleaner-core/photos";
import { EMPTY_TWIML, handleCleanerTwilioWebhook, mediaOf } from "../cleaner-core/twilioHook";
import { hubFor } from "../hub/hub";
import type { People } from "../hub/people";
import { keywordOf } from "../intent/ruleBased";
import { formParams, verifyTwilioSignature } from "../messaging/twilio/signature";
import { proRoute } from "../fixer-core/proLine";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { isStartText, isStopText, TenantOptOuts } from "./crossService";
import { fixerProText } from "./fixer";
import { LineAsks } from "./lineAsks";
import { accountPeople } from "./sharedPeople";
import { answerOf, bareAnswer, businessFor, droppedNote, lineStartText, lineStopText, namedProperty, whichPropertyText, type Named } from "./sharedRoute";

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

export type LineRoute =
  | { kind: "property"; property: Property }
  /** A person on two or more properties sent STOP or START: it covers every one (saadvz/PropertyCore#190). */
  | { kind: "person-all"; properties: Property[] }
  /** A person on two or more properties sent HELP: no property, and Twilio answers it. */
  | { kind: "person-help" }
  /** A person on two or more properties sent anything else: by name, by which waits on them, or by asking. */
  | { kind: "shared"; properties: Property[] }
  | { kind: "host-all"; properties: Property[] }
  | { kind: "host-unused"; property: Property }
  | { kind: "host-help" }
  | { kind: "unknown" };

/** Where a one-to-one text goes. Only properties running Cleaner Core count. */
export function routeLineText(tenant: Tenant, from: string, text: string, people: Pick<People, "propertiesOf" | "hostOf">): LineRoute {
  const cleaning = tenant.properties.filter((p) => p.flows.cleaning.on);
  if (cleaning.length === 0) return { kind: "unknown" };
  if (cleaning.length === 1) return { kind: "property", property: cleaning[0]! };
  const on = new Set(people.propertiesOf(from));
  const mine = cleaning.filter((p) => on.has(p.id));
  if (mine.length === 1) return { kind: "property", property: mine[0]! };
  if (mine.length > 1) {
    if (isStopText(text) || keywordOf(text) === "start") return { kind: "person-all", properties: mine };
    if (keywordOf(text) === "help") return { kind: "person-help" };
    return { kind: "shared", properties: mine };
  }
  const hosted = cleaning.filter((p) => people.hostOf(p.id) === from);
  if (hosted.length > 0) {
    // Only STOP and START words reach every property. A bare YES would act as the host's answer on
    // each desk (saving times, sending offers), so it changes nothing, like any other host text.
    if (isStopText(text) || keywordOf(text) === "start") return { kind: "host-all", properties: hosted };
    if (keywordOf(text) === "help") return { kind: "host-help" };
    return { kind: "host-unused", property: hosted[0]! };
  }
  return { kind: "unknown" };
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

/** The landlord's phone: the host on any of the account's properties. */
export function isLandlord(tenant: Tenant, people: People, phone: string): boolean {
  return tenant.properties.some((p) => people.hostOf(p.id) === phone);
}

/** A person's own STOP, or their START or YES after one, for the whole account. `from` already has it. */
async function markPerson(people: People, phone: string, text: string, from?: string): Promise<void> {
  const change = isStopText(text) ? people.stop(phone) : isStartText(text) ? people.start(phone) : undefined;
  await people.relay(change ? { ...change, ...(from ? { from } : {}) } : undefined);
}

const deskOf = (h: HostedCleaner, tenant: Tenant, property: Property) => {
  const ctx = propertyContext(h, tenant, property);
  return { ctx, desk: liveDeskFor(ctx.root, ctx.env, () => h.now()) };
};

/** True when every listed property's saved host is the account's confirmed landlord (#164). */
async function allConfirmed(h: HostedCleaner, tenant: Tenant, properties: Property[]): Promise<boolean> {
  const each = await Promise.all(properties.map((property) => deskOf(h, tenant, property).desk.textsAllowed().catch(() => false)));
  return each.length > 0 && each.every(Boolean);
}

/** The person's properties by the names they could use: label, nickname and address. */
function namedOf(h: HostedCleaner, tenant: Tenant, properties: Property[]): Named[] {
  return properties.map((property) => {
    const details = hubFor(propertyContext(h, tenant, property).root, { now: () => h.now() }).property();
    return { id: property.id, label: property.label, ...(details.nickname ? { nickname: details.nickname } : {}), ...(details.address ? { address: details.address } : {}) };
  });
}

/** Held texts past 2 hours are dropped, with a note for the host on each property they could be about. */
export async function sweepHeldTexts(h: HostedCleaner, tenant: Tenant): Promise<void> {
  const asks = new LineAsks(tenantFolder(h.dataRoot, tenant.id), () => h.now());
  const expired = asks.expired();
  if (expired.length === 0) return;
  const people = await accountPeople(h, tenant);
  for (const { phone, text } of expired) {
    const role = text.propertyIds.map((id) => people.roleOn(phone, id)).find((r) => r) ?? "cleaner";
    const note = droppedNote(people.person(phone)?.name ?? `the ${role}`);
    for (const id of text.propertyIds) {
      const property = tenant.properties.find((p) => p.id === id);
      if (property) await deskOf(h, tenant, property).desk.noteDroppedText(note);
    }
    h.log(`A held text on ${tenant.id}'s line was dropped after 2 hours.`);
  }
}

/** A shared person's text that isn't STOP, START or HELP: by an answer, a name, the one property waiting, or the ask. */
async function routeShared(h: HostedCleaner, tenant: Tenant, people: People, properties: Property[], from: string, fields: Record<string, string>): Promise<void> {
  await sweepHeldTexts(h, tenant);
  const text = fields.Body ?? "";
  const id = fields.MessageSid?.trim() || createHash("sha256").update(`${from}\n${text}`).digest("hex");
  const media = mediaOf(fields);
  // A YES from a stopped person lifts their STOP first, as it would on one property.
  if (people.stopped(from) && isStartText(text)) await people.relay(people.start(from));
  const named = namedOf(h, tenant, properties);
  const deliver = async (propertyId: string, inbound: { id: string; text: string; media?: InboundMedia[] }) => {
    const property = properties.find((p) => p.id === propertyId);
    if (property) await deskOf(h, tenant, property).desk.inbound({ id: inbound.id, from, text: inbound.text, ...(inbound.media && inbound.media.length > 0 ? { media: inbound.media } : {}) });
  };
  const asks = new LineAsks(tenantFolder(h.dataRoot, tenant.id), () => h.now());
  const held = asks.held(from);
  const current = { id, text, ...(media.length > 0 ? { media } : {}) };
  // The answer is read against the list that was asked, so a property switched off since doesn't shift the numbers.
  const asked = held ? held.propertyIds.map((pid) => named.find((n) => n.id === pid) ?? { id: pid, label: "" }) : [];
  const answer = held ? (held.numbers === false ? namedProperty(text, asked) : answerOf(text, asked)) : undefined;
  if (held && answer && properties.some((p) => p.id === answer)) {
    asks.take(from);
    await deliver(answer, { id: held.id, text: held.text, ...(held.media ? { media: held.media } : {}) });
    // An answer with more to say goes to the same property, after the held text.
    if (!bareAnswer(text, asked) || media.length > 0) await deliver(answer, current);
    return;
  }
  // A text that goes to a property while one is held means the conversation moved on: a later bare
  // number, such as a towel count, is no longer taken as the answer to the held text.
  const byName = namedProperty(text, named);
  if (byName) {
    if (held) asks.closeNumbers(from);
    return deliver(byName, current);
  }
  const waiting: string[] = [];
  for (const property of properties) if (await deskOf(h, tenant, property).desk.waitingOn(from)) waiting.push(property.id);
  if (waiting.length === 1) {
    if (held) asks.closeNumbers(from);
    return deliver(waiting[0]!, current);
  }
  const { ask } = asks.hold(from, { ...current, propertyIds: properties.map((p) => p.id) });
  // A stopped person is never asked: their text waits quietly.
  // The ask lists every property's address, so it waits until each one's host is confirmed (#164).
  if (ask && !people.stopped(from) && (await allConfirmed(h, tenant, properties))) {
    await sendLiveSms(deskOf(h, tenant, properties[0]!).ctx.env(), { to: from, body: whichPropertyText(named) }).catch(() => undefined);
  }
}

/** A shared person's STOP or START: once for the account, every property applies it, and one reply from the line. */
async function personAll(h: HostedCleaner, tenant: Tenant, people: People, properties: Property[], from: string, text: string): Promise<void> {
  const stop = isStopText(text);
  const change = stop ? people.stop(from) : people.start(from);
  if (!change) return;
  // The line's reply goes whether or not every property applied it: a property that missed it catches up when it opens.
  await people.relay(change).catch(() => h.log(`A property on ${tenant.id} couldn't apply a shared person's ${stop ? "STOP" : "START"} yet.`));
  // The opt-out is kept above. The reply waits until every property's host is confirmed (#164).
  if (!(await allConfirmed(h, tenant, properties))) return;
  const names = await Promise.all(properties.map((property) => deskOf(h, tenant, property).desk.businessName().catch(() => undefined)));
  const business = businessFor(names);
  await sendLiveSms(deskOf(h, tenant, properties[0]!).ctx.env(), { to: from, body: stop ? lineStopText(business) : lineStartText(business) }).catch(() => undefined);
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
  const people = await accountPeople(h, tenant);
  // A pro, and nothing else on the account, texts Fixer Core: their DONE, a price, photos, or YES and STOP.
  const pros = proRoute(tenant, people, from);
  if (pros) {
    h.registry.touch(tenant.id);
    await fixerProText(h, tenant, pros, { id: fields.MessageSid ?? "", from, text, media: mediaOf(fields) });
    return r.send(200, "text/xml", EMPTY_TWIML);
  }
  const route = routeLineText(tenant, from, text, people);
  const landlord = !!from && isLandlord(tenant, people, from);
  const toDesk = (property: Property) => {
    const ctx = propertyContext(h, tenant, property);
    return handleCleanerTwilioWebhook({ rawBody, headers: r.req.headers, url: signedUrl, env: ctx.env, root: ctx.root, now: () => h.now() });
  };
  h.registry.touch(tenant.id);
  if (route.kind === "property") {
    // The landlord's STOP holds for the whole line, so a property added later starts with them opted out.
    if (landlord && isStopText(text)) new TenantOptOuts(h.dataRoot).stop(tenant.id, from);
    else if (landlord && isStartText(text)) new TenantOptOuts(h.dataRoot).start(tenant.id, from);
    const result = await toDesk(route.property);
    // A person's STOP holds on every property that saves them, now or later; their START or YES lifts it.
    // The desk answers first, so its STOP reply still goes.
    if (from && !landlord) await markPerson(people, from, text, route.property.id).catch(() => h.log(`A property on ${tenant.id} couldn't apply a person's STOP or START yet.`));
    return r.send(result.status, result.contentType ?? "text/xml", result.body);
  }
  if (route.kind === "person-all") {
    await personAll(h, tenant, people, route.properties, from, text);
    return r.send(200, "text/xml", EMPTY_TWIML);
  }
  if (route.kind === "shared") {
    await routeShared(h, tenant, people, route.properties, from, fields);
    return r.send(200, "text/xml", EMPTY_TWIML);
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
    const { ctx, desk } = deskOf(h, tenant, route.property);
    await desk.noteUnusedHostText(text);
    if ((await desk.textsAllowed()) && replyDue(h, tenant.id, from)) await sendLiveSms(ctx.env(), { to: from, body: LANDLORD_USE_AGENT }).catch(() => undefined);
    h.log(`The host texted ${tenant.id}'s line one-to-one. It wasn't used: the account has several properties.`);
    return r.send(200, "text/xml", EMPTY_TWIML);
  }
  // A STOP from someone on no property holds for the whole line, and START or YES lifts it.
  if (route.kind === "unknown" && from && !landlord) await markPerson(people, from, text).catch(() => undefined);
  const said =
    route.kind === "host-help"
      ? `The host texted HELP to ${tenant.id}'s line. Twilio answers it.`
      : route.kind === "person-help"
        ? `Someone on several of ${tenant.id}'s properties texted HELP. Twilio answers it.`
        : `A text reached ${tenant.id}'s line from someone on no property. Nothing was sent.`;
  h.log(said);
  return r.send(200, "text/xml", EMPTY_TWIML);
}
