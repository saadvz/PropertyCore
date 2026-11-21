import { randomBytes } from "node:crypto";
import { liveDeskFor } from "../cleaner-core/liveDesk";
import { sendLiveSms } from "../cleaner-core/liveSms";
import { propertyBasePath, propertyFolder, type Property } from "../cleaner-core/hosted/properties";
import { tenantFolder, type Tenant } from "../cleaner-core/hosted/registry";
import { peopleFor } from "../hub/people";
import { LockDesk, STANDING_PAGE_PREFIX } from "../locks/desk";
import { handleLockTool, LOCK_TOOL_NAMES, LOCK_TOOLS } from "../locks/tools";
import { GUEST_PAGE_PREFIX, GuestCodeDesk } from "../locks/guestDesk";
import { GUEST_TOOL_NAMES, GUEST_TOOLS, handleGuestTool } from "../locks/guestTools";
import type { FrontReply } from "./serviceTools";
import { propertyContext, type HostedCleaner, type HostedRequest } from "../cleaner-core/hosted/router";
import type { GrantNote } from "../hub/doorAccess";
import { hubFor } from "../hub/hub";
import type { LockWebhookEvent } from "../locks/adapter";
import { applyLockEvent, lockHealthNotes } from "../locks/inbound";
import { lockAdapter } from "../locks/registry";
import { featureOn } from "../features/features";
import { readDoorLocks } from "../locks/settings";
import { fixerDesk } from "./fixer";

/**
 * Connected locks on the shared service (#180): the lock partner's webhook, and the clock pass for
 * lock health. A webhook is verified by the adapter before anything in it is read, and goes only to
 * the one property whose account and device it names. Nothing here logs a body or a code.
 */

export const LOCK_WEBHOOK_PATH = "/webhooks/seam";
const MAX_WEBHOOK_BYTES = 64 * 1024;

interface Owner {
  tenant: Tenant;
  property: Property;
}

/**
 * The property an event belongs to: the one whose saved devices hold its device, under the account
 * the partner tagged (its customer key is the account id). An account-wide event (disconnected) goes
 * to each of that account's properties using the partner account. None when nothing matches.
 */
export function lockOwners(h: HostedCleaner, event: LockWebhookEvent): Owner[] {
  const owners: Owner[] = [];
  for (const listed of h.registry.list()) {
    const tenant = h.registry.get(listed.id);
    // An account with connected locks off takes no lock event: its properties keep their saved door codes.
    if (!tenant || tenant.disabled || !featureOn(tenant, "locks", h.baseEnv())) continue;
    if (event.customerKey && event.customerKey !== tenant.id) continue;
    for (const property of tenant.properties) {
      let file;
      try {
        file = readDoorLocks(propertyFolder(h.dataRoot, tenant.id, property));
      } catch {
        continue;
      }
      if (file.customerKey !== tenant.id) continue;
      const holds = event.deviceId ? file.devices.some((device) => device.id === event.deviceId) : event.accountId ? file.devices.some((device) => device.accountId === event.accountId) : false;
      if (holds) owners.push({ tenant, property });
    }
  }
  // A device belongs to one property. Two matches for one device means the mapping is wrong: drop it.
  if (event.deviceId && owners.length > 1) return [];
  return owners;
}

/** Tells the host through Cleaner Core's notes, or Fixer Core's when cleaning is off here. */
export async function tellLockNote(h: HostedCleaner, owner: Owner, note: GrantNote): Promise<void> {
  const { tenant, property } = owner;
  try {
    if (property.flows.cleaning.on) {
      const ctx = propertyContext(h, tenant, property);
      await liveDeskFor(ctx.root, ctx.env, () => h.now()).noteForHost(`host:${note.id}`, note.text);
      return;
    }
    if (property.flows.fixer.on) await fixerDesk(h, tenant, property).noteForHost(note.id, note.text, note.jobId);
  } catch {
    h.log(`A lock note for ${tenant.id}/${property.id} couldn't be kept this time.`);
  }
}

/** POST /webhooks/seam. Answered 401 when the signature fails, 200 otherwise, so the partner doesn't resend a dropped event. */
export async function handleLockWebhook(h: HostedCleaner, r: HostedRequest): Promise<void> {
  const adapter = lockAdapter();
  if (!adapter || !anyAccountOn(h)) {
    r.send(404, "text/plain", "Not found");
    return;
  }
  const raw = await r.readCapped(MAX_WEBHOOK_BYTES);
  if (!raw) {
    r.send(413, "text/plain", "Too large", { Connection: "close" });
    return;
  }
  const event = adapter.parseWebhook({ headers: r.req.headers as Record<string, string | string[] | undefined>, body: raw.toString("utf8") });
  if (!event) {
    r.send(401, "text/plain", "Unauthorized");
    return;
  }
  const owners = lockOwners(h, event);
  if (owners.length === 0) {
    h.log("A lock event for an unknown account or device was dropped.");
    r.send(200, "text/plain", "ok");
    return;
  }
  for (const owner of owners) {
    const ctx = propertyContext(h, owner.tenant, owner.property);
    const hub = hubFor(ctx.root, { now: () => h.now() });
    const door = hub.doorAccess(ctx.env);
    try {
      const result = await applyLockEvent(door, adapter, event, h.now(), hub.property().timeZone);
      for (const note of result.notes) await tellLockNote(h, owner, note);
    } catch {
      h.log(`A lock event for ${owner.tenant.id}/${owner.property.id} couldn't be applied.`);
    }
  }
  r.send(200, "text/plain", "ok");
}

/**
 * The lock clock pass, on Fixer's tick: a lock offline for 30 minutes is told once, and on a property
 * with Cleaner Core on, the checkout-time release and a paused turnover's reminders.
 */
export async function tickAllLocks(h: HostedCleaner): Promise<void> {
  if (!lockAdapter()) return;
  for (const listed of h.registry.list()) {
    const tenant = h.registry.get(listed.id);
    if (!tenant || tenant.disabled || !featureOn(tenant, "locks", h.baseEnv())) continue;
    for (const property of tenant.properties) {
      const ctx = propertyContext(h, tenant, property);
      try {
        const door = hubFor(ctx.root, { now: () => h.now() }).doorAccess(ctx.env);
        if (!door.locks().activeAt) continue;
        for (const note of lockHealthNotes(door, h.now())) await tellLockNote(h, { tenant, property }, note);
        // Guest codes (#262): each stay's code follows the booking log on this clock, so a booking email or late checkout reaches the lock within a tick.
        if (guestCodesAvailable(h, tenant) && anyDoorFlow(property)) for (const note of await guestDesk(h, tenant, property).sync()) await tellLockNote(h, { tenant, property }, note);
        // The checkout-time release and a paused turnover's reminders run on this clock.
        if (property.flows.cleaning.on) await liveDeskFor(ctx.root, ctx.env, () => h.now()).lockClock();
      } catch {
        h.log(`The lock check for ${tenant.id}/${property.id} couldn't run this round.`);
      }
    }
  }
}

const desks = new Map<string, LockDesk>();
const guestDesks = new Map<string, GuestCodeDesk>();

/** Tests only. */
export function resetLockDesks(): void {
  desks.clear();
  guestDesks.clear();
}

/** Some account on the service has connected locks on. */
function anyAccountOn(h: HostedCleaner): boolean {
  return h.registry.list().some((tenant) => !tenant.disabled && featureOn(tenant, "locks", h.baseEnv()));
}

/** Connected locks for this account: its "locks" switch, the partner's credentials, and the adapter. */
export function locksAvailable(h: HostedCleaner, tenant: Tenant): boolean {
  return featureOn(tenant, "locks", h.baseEnv()) && Boolean(lockAdapter());
}

/** Guest codes for this account (#262): its "guest-codes" switch (which needs its locks on), with the adapter. */
export function guestCodesAvailable(h: HostedCleaner, tenant: Tenant): boolean {
  return featureOn(tenant, "guest-codes", h.baseEnv()) && Boolean(lockAdapter());
}

/** The property's guest-code desk. Every dependency reads the account again on each call. */
export function guestDesk(h: HostedCleaner, tenant: Tenant, property: Property): GuestCodeDesk {
  const root = propertyFolder(h.dataRoot, tenant.id, property);
  const existing = guestDesks.get(root);
  if (existing) return existing;
  const fresh = () => {
    const account = h.registry.get(tenant.id) ?? tenant;
    return { account, property: account.properties.find((item) => item.id === property.id) ?? property };
  };
  const desk = new GuestCodeDesk(root, {
    now: () => h.now(),
    env: () => propertyContext(h, fresh().account, fresh().property).env(),
    textsAllowed: async () => (await cleaningDesk(h, fresh().account, fresh().property)?.textsAllowed()) ?? false,
    stopped: (phone) => peopleFor(tenantFolder(h.dataRoot, tenant.id), { now: () => h.now() }).stopped(phone),
    // The body is never logged or kept: sendLiveSms hands it to Twilio and keeps only the message id.
    send: async (to, body) => (await sendLiveSms(propertyContext(h, fresh().account, fresh().property).env(), { to, body })) !== undefined,
    publicBase: () => {
      const origin = h.origin();
      return origin ? `${origin}${propertyBasePath(tenant.id, fresh().property)}` : undefined;
    },
  });
  guestDesks.set(root, desk);
  return desk;
}

const cleaningDesk = (h: HostedCleaner, tenant: Tenant, property: Property) => {
  if (!property.flows.cleaning.on) return undefined;
  const ctx = propertyContext(h, tenant, property);
  return liveDeskFor(ctx.root, ctx.env, () => h.now());
};

/** The property's lock desk. Every dependency reads the account again on each call. */
export function lockDesk(h: HostedCleaner, tenant: Tenant, property: Property): LockDesk {
  const root = propertyFolder(h.dataRoot, tenant.id, property);
  const existing = desks.get(root);
  if (existing) return existing;
  const fresh = () => {
    const account = h.registry.get(tenant.id) ?? tenant;
    return { account, property: account.properties.find((item) => item.id === property.id) ?? property };
  };
  const desk = new LockDesk(root, {
    now: () => h.now(),
    env: () => propertyContext(h, fresh().account, fresh().property).env(),
    customerKey: tenant.id,
    otherDevices: () =>
      fresh()
        .account.properties.filter((item) => item.id !== property.id)
        .flatMap((item) => {
          try {
            return readDoorLocks(propertyFolder(h.dataRoot, tenant.id, item)).devices.map((device) => device.id);
          } catch {
            return [];
          }
        }),
    alertsWorking: async () => {
      const now = fresh();
      if (now.property.flows.cleaning.on) return cleaningDesk(h, now.account, now.property)?.wakeHealth() === "working";
      return now.property.flows.fixer.on ? fixerDesk(h, now.account, now.property).alertsWorking() : false;
    },
    textsAllowed: async () => (await cleaningDesk(h, fresh().account, fresh().property)?.textsAllowed()) ?? false,
    stopped: (phone) => peopleFor(tenantFolder(h.dataRoot, tenant.id), { now: () => h.now() }).stopped(phone),
    // The body is never logged or kept: sendLiveSms hands it to Twilio and keeps only the message id.
    send: async (to, body) => (await sendLiveSms(propertyContext(h, fresh().account, fresh().property).env(), { to, body })) !== undefined,
    publicBase: () => {
      const origin = h.origin();
      return origin ? `${origin}${propertyBasePath(tenant.id, fresh().property)}` : undefined;
    },
    cleaningOn: () => fresh().property.flows.cleaning.on,
  });
  desks.set(root, desk);
  return desk;
}

export const LOCK_FRONT_NAMES: ReadonlySet<string> = new Set([...LOCK_TOOL_NAMES, ...GUEST_TOOL_NAMES]);

const anyDoorFlow = (property: Property) => property.flows.cleaning.on || property.flows.fixer.on;

/** The lock tools as tools/list shows them: with the account's locks on, and a property running Cleaner Core or Fixer Core. */
export function listedLockFront(h: HostedCleaner, tenant: Tenant): Record<string, unknown>[] {
  if (!locksAvailable(h, tenant) || !tenant.properties.some(anyDoorFlow)) return [];
  return [...LOCK_TOOLS, ...(guestCodesAvailable(h, tenant) ? GUEST_TOOLS : [])];
}

/** Answers one lock tool for the property it names. */
export async function lockCall(h: HostedCleaner, tenant: Tenant, property: Property, name: string, args: Record<string, unknown>): Promise<FrontReply> {
  if (!locksAvailable(h, tenant)) return { text: "Connected locks aren't available yet.", isError: true };
  if (!anyDoorFlow(property)) return { text: `Connected locks work with Cleaner Core or Fixer Core, and neither is on for ${property.label}.`, isError: true };
  if (GUEST_TOOL_NAMES.has(name)) {
    if (!guestCodesAvailable(h, tenant)) return { text: "Guest door codes aren't available yet.", isError: true };
    const guest = await handleGuestTool(guestDesk(h, tenant, property), name, args);
    return guest ?? { text: "That guest-code tool couldn't answer.", isError: true };
  }
  const reply = await handleLockTool(lockDesk(h, tenant, property), name, args);
  return reply ?? { text: "That lock tool couldn't answer.", isError: true };
}

/**
 * A text on the shared line from a phone with a standing code on one of the account's properties.
 * Only its YES (after the invite) is taken here; STOP is noted and still goes on to the usual routing.
 */
export async function standingLineText(h: HostedCleaner, tenant: Tenant, from: string, text: string): Promise<boolean> {
  if (!locksAvailable(h, tenant) || !from) return false;
  let handled = false;
  for (const property of tenant.properties) {
    if (!anyDoorFlow(property)) continue;
    try {
      if (!(readDoorLocks(propertyFolder(h.dataRoot, tenant.id, property)).standing ?? []).some((person) => person.phone === from && !person.removedAt)) continue;
      if (await lockDesk(h, tenant, property).standingText(from, text)) handled = true;
    } catch {
      h.log(`A standing code text for ${tenant.id}/${property.id} couldn't be read.`);
    }
  }
  return handled;
}

/**
 * A text on the shared line from a phone with a lease on one of the account's properties (#262). Only
 * its YES (after the invite) is taken here; STOP takes the code off and still goes on to the usual routing.
 */
export async function guestLineText(h: HostedCleaner, tenant: Tenant, from: string, text: string): Promise<boolean> {
  if (!guestCodesAvailable(h, tenant) || !from) return false;
  let handled = false;
  for (const property of tenant.properties) {
    if (!anyDoorFlow(property)) continue;
    try {
      const desk = guestDesk(h, tenant, property);
      if (!desk.hasLease(from)) continue;
      if (await desk.leaseText(from, text)) handled = true;
    } catch {
      h.log(`A lease text for ${tenant.id}/${property.id} couldn't be read.`);
    }
  }
  return handled;
}

/** True when the property path is a guest code's page. */
export function isGuestPath(rest: string): boolean {
  return rest.startsWith(GUEST_PAGE_PREFIX);
}

/** True when the property path is a standing code's page. */
export function isStandingPath(rest: string): boolean {
  return rest.startsWith(STANDING_PAGE_PREFIX);
}

const PAGE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
};

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

interface CodePage {
  heading: string;
  intro: string;
  button: string;
  shownAs: string;
}

/**
 * A code page: GET shows a button and nothing else, so a link preview never uses it up; POST .../show
 * (JSON) shows the code once and ends the link. The token, the path and the body are never logged.
 */
async function serveCodePage(r: HostedRequest, sub: string, page: CodePage | undefined, show: () => Promise<{ code: string; doors?: { door: string; code: string }[] } | undefined>, gone: string): Promise<void> {
  if (r.method === "GET" && sub === "") {
    if (!page) return r.send(404, "text/html; charset=utf-8", `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Door code</title><p>${escape(gone)}</p>`, PAGE_HEADERS);
    const nonce = randomBytes(16).toString("base64");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>Door code</title></head><body><main><h1>${escape(page.heading)}</h1><p>${escape(page.intro)}</p><button id="show">${escape(page.button)}</button><p id="out" aria-live="polite"></p></main><script nonce="${nonce}">document.getElementById("show").addEventListener("click",async()=>{const b=document.getElementById("show");b.disabled=true;let d={};try{const r=await fetch(location.pathname.replace(/\/$/,"")+"/show",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}",cache:"no-store",credentials:"omit"});d=await r.json();}catch(e){}document.getElementById("out").textContent=d.code?(${JSON.stringify(page.shownAs)}+d.code):(d.error||${JSON.stringify(gone)});});</script></body></html>`;
    return r.send(200, "text/html; charset=utf-8", html, { ...PAGE_HEADERS, "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'` });
  }
  if (r.method === "POST" && sub === "show") {
    if (!String(r.req.headers["content-type"] ?? "").startsWith("application/json")) return r.send(415, "application/json; charset=utf-8", JSON.stringify({ error: "Send JSON." }), { ...PAGE_HEADERS, Connection: "close" });
    const shown = await show();
    if (!shown) return r.send(404, "application/json; charset=utf-8", JSON.stringify({ error: gone }), PAGE_HEADERS);
    const code = shown.doors && shown.doors.length > 1 ? shown.doors.map((item) => `${item.door}: ${item.code}`).join(", ") : shown.code;
    return r.send(200, "application/json; charset=utf-8", JSON.stringify({ code }), PAGE_HEADERS);
  }
  return r.send(404, "text/plain", "Not found", PAGE_HEADERS);
}

/** A standing code's page, shown to its person once. */
export async function serveStandingPage(h: HostedCleaner, r: HostedRequest, tenant: Tenant, property: Property, rest: string): Promise<void> {
  const [token = "", sub = ""] = rest.slice(STANDING_PAGE_PREFIX.length).split("/");
  if (!locksAvailable(h, tenant)) return r.send(404, "text/plain", "Not found");
  const desk = lockDesk(h, tenant, property);
  const open = r.method === "GET" && sub === "" ? desk.pageOpen(token) : undefined;
  const page = open ? { heading: `Your door code at ${open.street}`, intro: `Hi ${open.name}. Tap to see your code. It shows once, so note it somewhere safe.`, button: "Show my code", shownAs: "Your code: " } : undefined;
  return serveCodePage(r, sub, page, () => desk.showCode(token), "This link has ended. Ask the host for a new one.");
}

/** A guest code's page (#262): the host's for a stay, or a tenant's for a lease. Shows the code once. */
export async function serveGuestPage(h: HostedCleaner, r: HostedRequest, tenant: Tenant, property: Property, rest: string): Promise<void> {
  const [token = "", sub = ""] = rest.slice(GUEST_PAGE_PREFIX.length).split("/");
  if (!guestCodesAvailable(h, tenant)) return r.send(404, "text/plain", "Not found");
  const desk = guestDesk(h, tenant, property);
  const open = r.method === "GET" && sub === "" ? desk.pageOpen(token) : undefined;
  const page = !open
    ? undefined
    : open.kind === "stay"
      ? { heading: `${open.title} at ${open.street}`, intro: "Tap to see the code. It shows only once, so copy it into your arrival message right away.", button: "Show the code", shownAs: "Door code: " }
      : { heading: open.title, intro: `Hi ${open.name}. Tap to see your code. It shows once, so note it somewhere safe.`, button: "Show my code", shownAs: "Your code: " };
  return serveCodePage(r, sub, page, () => desk.showCode(token), "This link has ended. Ask for a new one.");
}
