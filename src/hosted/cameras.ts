import { camerasOn, packageArrivalsOn } from "../cleaner-core/flag";
import { liveDeskFor } from "../cleaner-core/liveDesk";
import { propertyFolder, type Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import { propertyContext, type HostedCleaner, type HostedRequest } from "../cleaner-core/hosted/router";
import { CameraLinks, cameraTokenKey, readCameras, sealedTokenStore, writeCameras, type CameraPlace } from "../cameras/accounts";
import { CameraProviderError, type AccountRef, type CameraProvider } from "../cameras/adapter";
import { CameraCounting } from "../cameras/count";
import type { Counter } from "../cameras/counter";
import { CameraDesk } from "../cameras/desk";
import { ringProvider } from "../cameras/ring";
import { sharedCameraLog } from "../cameras/sharedLog";
import { CAMERA_TOOL_NAMES, CAMERA_TOOLS } from "../cameras/tools";
import { ingestWebhook } from "../cameras/webhook";
import { packageDeskFor } from "../package-arrivals/desk";
import type { FrontReply } from "./serviceTools";

/**
 * The camera connection (#239) on the shared service, behind CAMERAS=1. The host signs in on Ring's own page from a
 * one-time link; their tokens are sealed in the account's secrets with CAMERA_TOKEN_KEY. Ring's webhooks land on
 * POST /webhooks/ring, are verified, and are stored in the property's shared event log. The clock counts the night's
 * events and turns a camera offline for 30 minutes into one note for the host. Nothing here texts anyone.
 */

export const CAMERA_FRONT_NAMES: ReadonlySet<string> = CAMERA_TOOL_NAMES;
export const CAMERA_WEBHOOK_PATH = "/webhooks/ring";
export const CAMERA_LINKED_PATH = "/cameras/ring/linked";
const CONNECT_PREFIX = "/cameras/connect/";
const SECRET_SLOT = "cameras";

let testProvider: CameraProvider | undefined;
let testCounter: Counter | undefined;
/** Tests swap in the fake provider and counter. Live, Ring comes from RING_* secrets and counting waits on a counter. */
export function setCameraProviderForTests(provider: CameraProvider | undefined, counter?: Counter): void {
  testProvider = provider;
  testCounter = counter;
  links = undefined;
  countings.clear();
}

let links: CameraLinks | undefined;
const countings = new Map<string, CameraCounting>();

function providerFor(h: HostedCleaner): CameraProvider | undefined {
  if (testProvider) return testProvider;
  const env = h.baseEnv();
  const clientId = env.RING_CLIENT_ID?.trim();
  const clientSecret = env.RING_CLIENT_SECRET?.trim();
  const webhookKey = env.RING_WEBHOOK_SECRET?.trim();
  return clientId && clientSecret && webhookKey ? ringProvider({ clientId, clientSecret, webhookKey, now: () => h.now() }) : undefined;
}

const counterFor = (): Counter | undefined => testCounter;
const linksFor = (h: HostedCleaner) => (links ??= new CameraLinks(() => h.now()));
const anyFlowOn = (property: Property) => property.flows.cleaning.on || property.flows.supplies.on || property.flows.fixer.on;

function account(h: HostedCleaner, tenantId: string): (AccountRef & { tokens: ReturnType<typeof sealedTokenStore> }) | undefined {
  const key = cameraTokenKey(h.baseEnv());
  if (!key) return undefined;
  const slot = {
    get: () => h.secrets.connection(tenantId, SECRET_SLOT),
    set: (values: Record<string, string>) => h.secrets.setForConnection(tenantId, SECRET_SLOT, values),
    clear: () => h.secrets.deleteConnection(tenantId, SECRET_SLOT),
  };
  return { tokens: sealedTokenStore(slot, key) };
}

function deskFor(h: HostedCleaner, tenant: Tenant, property: Property): CameraDesk {
  const root = propertyFolder(h.dataRoot, tenant.id, property);
  const provider = providerFor(h);
  const ref = account(h, tenant.id);
  return new CameraDesk(root, { log: sharedCameraLog(root, () => h.now()), ...(provider ? { provider } : {}), ...(ref ? { account: ref } : {}), now: () => h.now(), label: property.label });
}

/** The camera tools as tools/list shows them: while the flag is on and any property runs a flow. */
export function listedCameraFront(h: HostedCleaner, tenant: Tenant): Record<string, unknown>[] {
  if (!camerasOn(h.baseEnv()) || !tenant.properties.some(anyFlowOn)) return [];
  return [...CAMERA_TOOLS];
}

const fail = (text: string): FrontReply => ({ text, isError: true });
const done = (structured: Record<string, unknown>): FrontReply => ({ text: JSON.stringify(structured), structured, isError: false });
const plain = (error: unknown) => (error instanceof CameraProviderError ? error.message : "Ring couldn't be reached right now.");

/** Answers one camera tool for the property it names. */
export async function camerasCall(h: HostedCleaner, tenant: Tenant, property: Property, name: string, args: Record<string, unknown>): Promise<FrontReply> {
  if (!camerasOn(h.baseEnv())) return fail("The camera connection isn't available yet.");
  if (!anyFlowOn(property)) return fail(`Nothing runs at ${property.label} yet, so it has no cameras.`);
  const provider = providerFor(h);
  const ref = account(h, tenant.id);
  const desk = deskFor(h, tenant, property);
  const linked = () => !!ref?.tokens.get();
  switch (name) {
    case "connect_cameras": {
      const origin = h.origin();
      if (!provider || !ref || !origin) return fail("The Ring connection isn't set up on this service yet.");
      const link = linksFor(h).start({ tenantId: tenant.id, propertyId: property.id });
      return done({ link: `${origin}${CONNECT_PREFIX}${link.state}`, expiresInMinutes: 30, next: "Give the host this link. They agree to what's read, then sign in to Ring on Ring's own page. Never ask for their Ring password. Then call list_cameras." });
    }
    case "list_cameras": {
      const picked = desk.cameras().cameras;
      const notes = desk.takeWaiting();
      const tell = notes.length ? { notes, next: "Tell the host each note in notes once." } : {};
      if (!provider || !ref || !linked()) return done({ connected: false, picked: picked.map(({ deviceId, name }) => ({ deviceId, name })), ...tell, next: notes.length ? "Tell the host each note in notes once. Ring isn't connected; use connect_cameras." : "Ring isn't connected for this account. Use connect_cameras." });
      try {
        const devices = await provider.devices(ref);
        const cameras = await Promise.all(
          devices.map(async (device) => {
            const used = picked.some((camera) => camera.deviceId === device.id);
            const status = used ? await provider.status(ref, device.id).catch(() => "unknown") : undefined;
            return { deviceId: device.id, name: device.name, usedHere: used, ...(status ? { status } : {}) };
          }),
        );
        return done({ connected: true, cameras, ...tell, ...(picked.length ? {} : { next: "Ask the host which of these cameras are outdoors at this property, then call pick_cameras." }) });
      } catch (error) {
        return done({ connected: false, problem: plain(error), picked: picked.map(({ deviceId, name }) => ({ deviceId, name })), ...tell });
      }
    }
    case "pick_cameras": {
      if (!provider || !ref || !linked()) return fail("Ring isn't connected for this account. Use connect_cameras first.");
      try {
        return desk.pick({ cameras: args.cameras }, await provider.devices(ref));
      } catch (error) {
        return fail(plain(error));
      }
    }
    case "disconnect_cameras": {
      ref?.tokens.clear();
      for (const each of tenant.properties) deskFor(h, tenant, each).forget();
      return done({ disconnected: true, next: "Ring is disconnected and no camera is read now. Events already kept stay in each property's record. The host can also remove Property Core from their Ring app." });
    }
    case "check_night":
      return done({ ...desk.runNight(String(args.date ?? "")) });
    case "stay_timeline":
      return desk.timeline({ checkIn: args.checkIn });
    case "pin_clip":
      return desk.pin({ eventId: args.eventId });
  }
  return fail("The camera connection couldn't answer that.");
}

/** Every property's picked cameras on the service, for routing a webhook. */
function places(h: HostedCleaner): CameraPlace[] {
  const out: CameraPlace[] = [];
  for (const listed of h.registry.list()) {
    const tenant = h.registry.get(listed.id);
    if (!tenant || tenant.disabled) continue;
    for (const property of tenant.properties) {
      try {
        const cameras = readCameras(propertyFolder(h.dataRoot, tenant.id, property)).cameras;
        if (cameras.length) out.push({ tenantId: tenant.id, propertyId: property.id, cameras });
      } catch {
        // An unreadable cameras.json routes nothing; it never stops the rest.
      }
    }
  }
  return out;
}

const html = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}button{font:inherit;padding:.6rem 1.2rem}</style></head><body>${body}</body></html>`;
const PAGE_HEADERS = { "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:" };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const CONSENT = (label: string) => `<h1>Connect Ring to Property Core</h1>
<p>For <strong>${escapeHtml(label)}</strong>, Property Core will read:</p>
<ul>
<li>motion, doorbell and online/offline events from the outdoor cameras you pick next;</li>
<li>a still image from each motion event during a guest's stay, which is counted (people, vehicles, animals) by an AI counting model and then thrown away;</li>
<li>a video clip only when you ask to keep one as evidence.</li>
</ul>
<p>No one is identified. Indoor cameras are never used. You sign in on Ring's own page; Property Core never sees your password. You can disconnect at any time.</p>
<form method="post"><button type="submit" name="agree" value="yes">I agree, continue to Ring</button></form>`;

/** Ring's webhook and the sign-in pages, on the service's own paths. True when the request was one of them. */
export async function handleCameraRoutes(h: HostedCleaner, r: HostedRequest): Promise<boolean> {
  const path = r.url.pathname;
  const isCamera = path === CAMERA_WEBHOOK_PATH || path === CAMERA_LINKED_PATH || path.startsWith(CONNECT_PREFIX);
  if (!isCamera) return false;
  const provider = providerFor(h);
  if (!camerasOn(h.baseEnv()) || !provider) {
    r.send(404, "text/plain", "Not found");
    return true;
  }
  if (path === CAMERA_WEBHOOK_PATH) {
    if (r.method !== "POST") return (r.send(405, "text/plain", "Method not allowed"), true);
    const rawBody = await r.readRaw();
    const result = ingestWebhook({ provider, places: places(h), logFor: (tenantId, propertyId) => logOf(h, tenantId, propertyId), rawBody, headers: r.req.headers });
    r.send(result.status, "text/plain", result.status === 200 ? "ok" : "Unauthorized");
    if (result.status === 200 && result.stored) void afterStored(h, result.stored).catch(() => h.log("A camera event was stored but its follow-up didn't run."));
    if (result.status === 200 && result.unlinked) h.log("A Ring account removed Property Core.");
    return true;
  }
  const origin = h.origin();
  const redirectUri = origin ? `${origin}${CAMERA_LINKED_PATH}` : undefined;
  if (path.startsWith(CONNECT_PREFIX)) {
    const state = path.slice(CONNECT_PREFIX.length);
    const link = /^[A-Za-z0-9_-]{32,100}$/.test(state) ? linksFor(h).peek(state) : undefined;
    const place = link && placeOf(h, link.tenantId, link.propertyId);
    if (!link || !place || !redirectUri) return (r.send(404, "text/html; charset=utf-8", html("Link expired", "<p>This link has expired or was already used. Ask your assistant for a new one.</p>"), PAGE_HEADERS), true);
    if (r.method === "GET") return (r.send(200, "text/html; charset=utf-8", html("Connect Ring", CONSENT(place.property.label)), PAGE_HEADERS), true);
    if (r.method !== "POST") return (r.send(405, "text/plain", "Method not allowed"), true);
    const form = new URLSearchParams(((await r.readCapped(1024)) ?? Buffer.alloc(0)).toString("utf8"));
    if (form.get("agree") !== "yes") return (r.send(400, "text/html; charset=utf-8", html("Connect Ring", "<p>Nothing was connected.</p>"), PAGE_HEADERS), true);
    const root = propertyFolder(h.dataRoot, place.tenant.id, place.property);
    writeCameras(root, { ...readCameras(root), consentAt: h.now().toISOString() });
    r.send(302, "text/plain", "", { Location: provider.linkUrl({ state, codeChallenge: link.codeChallenge, redirectUri }), "Cache-Control": "no-store" });
    return true;
  }
  // Ring's return from its sign-in page.
  const code = r.url.searchParams.get("code");
  const state = r.url.searchParams.get("state");
  const link = state ? linksFor(h).finish(state) : undefined;
  const place = link && placeOf(h, link.tenantId, link.propertyId);
  const ref = link && account(h, link.tenantId);
  if (!code || !link || !place || !ref || !redirectUri) return (r.send(400, "text/html; charset=utf-8", html("Not connected", "<p>Ring wasn't connected. The link may have expired; ask your assistant for a new one.</p>"), PAGE_HEADERS), true);
  try {
    ref.tokens.save(await provider.finishLink({ code, codeVerifier: link.codeVerifier, redirectUri }));
  } catch (error) {
    return (r.send(502, "text/html; charset=utf-8", html("Not connected", `<p>${escapeHtml(plain(error))} Ask your assistant for a new link.</p>`), PAGE_HEADERS), true);
  }
  const root = propertyFolder(h.dataRoot, place.tenant.id, place.property);
  writeCameras(root, { ...readCameras(root), provider: provider.name, connectedAt: h.now().toISOString() });
  r.send(200, "text/html; charset=utf-8", html("Ring connected", "<h1>Ring is connected</h1><p>Go back to your assistant's chat to pick which outdoor cameras belong to this property.</p>"), PAGE_HEADERS);
  return true;
}

function placeOf(h: HostedCleaner, tenantId: string, propertyId: string): { tenant: Tenant; property: Property } | undefined {
  const tenant = h.registry.get(tenantId);
  const property = tenant?.properties.find((p) => p.id === propertyId);
  return tenant && !tenant.disabled && property ? { tenant, property } : undefined;
}

function logOf(h: HostedCleaner, tenantId: string, propertyId: string) {
  const place = placeOf(h, tenantId, propertyId);
  if (!place) return { append: () => false, read: () => [] };
  return sharedCameraLog(propertyFolder(h.dataRoot, tenantId, place.property), () => h.now());
}

/** After a stored event: a package drop goes to package arrivals; a motion event may want counting. */
async function afterStored(h: HostedCleaner, stored: { tenantId: string; propertyId: string; line: { label?: string; at: string; kind: string } }): Promise<void> {
  const place = placeOf(h, stored.tenantId, stored.propertyId);
  if (!place) return;
  if (stored.line.kind === "motion" && stored.line.label === "package_delivery" && packageArrivalsOn(h.baseEnv()) && place.property.flows.supplies.on) {
    packageDeskFor(propertyFolder(h.dataRoot, place.tenant.id, place.property), { now: () => h.now() }).cameraSighting({ at: stored.line.at });
  }
  await countingFor(h, place.tenant, place.property)?.run();
}

function countingFor(h: HostedCleaner, tenant: Tenant, property: Property): CameraCounting | undefined {
  const provider = providerFor(h);
  const counter = counterFor();
  const ref = account(h, tenant.id);
  if (!provider || !counter || !ref?.tokens.get()) return undefined;
  const key = `${tenant.id}/${property.id}`;
  let counting = countings.get(key);
  if (!counting) {
    const desk = deskFor(h, tenant, property);
    const root = propertyFolder(h.dataRoot, tenant.id, property);
    counting = new CameraCounting({ provider, account: ref, counter, log: sharedCameraLog(root, () => h.now()), inStay: (at) => desk.inStay(at), nightOf: (at) => desk.nightOf(at) });
    countings.set(key, counting);
  }
  return counting;
}

let round = false;

/**
 * The cameras' clock, on the same tick as Fixer Core's: count what's waiting, and turn a camera offline for 30
 * minutes into one note. A note goes to the host through Cleaner Core's alert path when it runs at the property;
 * otherwise it waits for list_cameras. One property's failure never stops the rest.
 */
export async function tickAllCameras(h: HostedCleaner): Promise<void> {
  if (round || !camerasOn(h.baseEnv())) return;
  round = true;
  try {
    for (const place of places(h)) {
      const found = placeOf(h, place.tenantId, place.propertyId);
      if (!found) continue;
      try {
        await countingFor(h, found.tenant, found.property)?.run();
        const desk = deskFor(h, found.tenant, found.property);
        const notes = desk.takeNotes();
        if (!notes.length) continue;
        const waiting = [];
        for (const note of notes) {
          const delivered = found.property.flows.cleaning.on ? await cleaningNote(h, found.tenant, found.property, note.id, note.text) : false;
          if (!delivered) waiting.push(note);
        }
        desk.queueNotes(waiting);
      } catch {
        h.log(`The cameras couldn't run ${place.tenantId}/${place.propertyId}'s clock this round.`);
      }
    }
  } finally {
    round = false;
  }
}

async function cleaningNote(h: HostedCleaner, tenant: Tenant, property: Property, id: string, text: string): Promise<boolean> {
  const ctx = propertyContext(h, tenant, property);
  return (await liveDeskFor(ctx.root, ctx.env, () => h.now()).noteForHost(id, text)) === true;
}
