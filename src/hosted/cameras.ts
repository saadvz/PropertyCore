import { featureOn } from "../features/features";
import { propertyFolder, type Property } from "../cleaner-core/hosted/properties";
import type { Tenant } from "../cleaner-core/hosted/registry";
import type { HostedCleaner, HostedRequest } from "../cleaner-core/hosted/router";
import { CameraLinks, cameraTokenKey, maskEmail, maskLabel, readCameras, sealedTokenStore, shownWord, WaitingTokens, writeCameras, type AgreedLink, type CameraPlace, type WaitingAccount } from "../cameras/accounts";
import { CameraProviderError, type AccountRef, type CameraProvider, type Tokens } from "../cameras/adapter";
import { CameraCounting } from "../cameras/count";
import { exportRows, toCsv } from "../cameras/countTest";
import type { Counter } from "../cameras/counter";
import { detectorFromEnv } from "../cameras/detector";
import { CameraDesk } from "../cameras/desk";
import { ringProvider } from "../cameras/ring";
import { sharedCameraLog } from "../cameras/sharedLog";
import { CAMERA_TOOL_NAMES, CAMERA_TOOLS } from "../cameras/tools";
import { ingestWebhook } from "../cameras/webhook";
import { PackageDesk } from "../package-arrivals/desk";
import type { FrontReply } from "./serviceTools";
import { zonedParts } from "../core/timezone";
import { addCalendarDays } from "../hub/calendar";
import { readHubFile } from "../hub/store";

/**
 * The camera connection (#239) on the shared service, behind each account's "cameras" switch and Ring's credentials. The host agrees on a
 * one-time link, then connects Property Core in Ring; Ring posts a code to us and sends their browser back with a signed
 * nonce (#302). Their tokens are sealed in the account's secrets with CAMERA_TOKEN_KEY. Ring's webhooks land on
 * POST /webhooks/ring, are verified, and are stored in the property's shared event log. The clock counts the night's
 * events and turns a camera offline for 30 minutes into one note for the host. Nothing here texts anyone.
 */

export const CAMERA_FRONT_NAMES: ReadonlySet<string> = CAMERA_TOOL_NAMES;
export const CAMERA_WEBHOOK_PATH = "/webhooks/ring";
/** The three addresses Ring's Account linking form asks for (#302), beside the webhook's. */
export const CAMERA_TOKEN_PATH = "/cameras/ring/token";
export const CAMERA_LINK_PATH = "/cameras/ring/link";
export const CAMERA_HOME_PATH = "/cameras/ring";
const CONNECT_PREFIX = "/cameras/connect/";
/** The browser's mark from the consent page: sent back only to the Ring pages, and on Ring's redirect (Lax). */
const MARK_COOKIE = "pc_ring";
const SECRET_SLOT = "cameras";

let testProvider: CameraProvider | undefined;
let testCounter: Counter | undefined;
/** Tests swap in the fake provider and counter. Live, Ring comes from RING_* secrets and counting waits on a counter. */
export function setCameraProviderForTests(provider: CameraProvider | undefined, counter?: Counter): void {
  testProvider = provider;
  testCounter = counter;
  links = undefined;
  waiting = undefined;
  countings.clear();
}

let links: CameraLinks | undefined;
let waiting: { key: string; pool: WaitingTokens } | undefined;
const countings = new Map<string, CameraCounting>();

function providerFor(h: HostedCleaner): CameraProvider | undefined {
  if (testProvider) return testProvider;
  const env = h.baseEnv();
  const clientId = env.RING_CLIENT_ID?.trim();
  const clientSecret = env.RING_CLIENT_SECRET?.trim();
  const webhookKey = env.RING_WEBHOOK_SECRET?.trim();
  return clientId && clientSecret && webhookKey ? ringProvider({ clientId, clientSecret, webhookKey, now: () => h.now() }) : undefined;
}

/**
 * Live, the open-source detector on this server when CAMERA_DETECTOR_MODEL names its model file (Saad, 19 Nov);
 * without it, counting stays off. One counter per model path and threshold, so the model loads once.
 */
let liveCounter: { key: string; counter: Counter } | undefined;
function counterFor(h: HostedCleaner): Counter | undefined {
  if (testCounter) return testCounter;
  const env = h.baseEnv();
  const key = `${env.CAMERA_DETECTOR_MODEL ?? ""}|${env.CAMERA_DETECTOR_THRESHOLD ?? ""}`;
  if (liveCounter?.key !== key) {
    const counter = detectorFromEnv(env);
    liveCounter = counter ? { key, counter } : undefined;
  }
  return liveCounter?.counter;
}
const linksFor = (h: HostedCleaner) => (links ??= new CameraLinks(() => h.now()));
/** Tokens Ring released that no host has claimed yet. Undefined without the service's sealing key. */
function waitingFor(h: HostedCleaner): WaitingTokens | undefined {
  const key = cameraTokenKey(h.baseEnv());
  if (!key) return undefined;
  const name = key.toString("base64");
  if (waiting?.key !== name) waiting = { key: name, pool: new WaitingTokens(key, () => h.now()) };
  return waiting.pool;
}
/** Tokens held in memory for one call to the provider, before they belong to any account. */
function heldAccount(tokens: Tokens): AccountRef & { current(): Tokens } {
  let current = tokens;
  return { tokens: { get: () => current, save: (next) => void (current = next) }, current: () => current };
}
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

/** The property's camera desk on the service. */
export function cameraDeskFor(h: HostedCleaner, tenant: Tenant, property: Property): CameraDesk {
  return deskFor(h, tenant, property);
}

function deskFor(h: HostedCleaner, tenant: Tenant, property: Property): CameraDesk {
  const root = propertyFolder(h.dataRoot, tenant.id, property);
  const provider = providerFor(h);
  const ref = account(h, tenant.id);
  const counter = counterFor(h);
  return new CameraDesk(root, { log: sharedCameraLog(root, () => h.now()), ...(provider ? { provider } : {}), ...(ref ? { account: ref } : {}), now: () => h.now(), label: property.label, ...(counter ? { counter: counter.name } : {}) });
}

/** The camera tools as tools/list shows them: while the account's cameras are on and any property runs a flow. */
export function listedCameraFront(h: HostedCleaner, tenant: Tenant): Record<string, unknown>[] {
  if (!featureOn(tenant, "cameras", h.baseEnv()) || !tenant.properties.some(anyFlowOn)) return [];
  return [...CAMERA_TOOLS];
}

const fail = (text: string): FrontReply => ({ text, isError: true });
const done = (structured: Record<string, unknown>): FrontReply => ({ text: JSON.stringify(structured), structured, isError: false });
const plain = (error: unknown) => (error instanceof CameraProviderError ? error.message : "Ring couldn't be reached right now.");

/** Answers one camera tool for the property it names. */
export async function camerasCall(h: HostedCleaner, tenant: Tenant, property: Property, name: string, args: Record<string, unknown>): Promise<FrontReply> {
  if (!featureOn(tenant, "cameras", h.baseEnv())) return fail("The camera connection isn't available yet.");
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
      return done({ link: `${origin}${CONNECT_PREFIX}${link.state}`, expiresInMinutes: 30, next: "Give the host this link. They agree to what's read, then the page tells them how to connect Property Core in Ring. Ring sends them back to a Property Core page to finish. Never ask for their Ring password or for the pairing word the page shows. Then call list_cameras." });
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
            // Every camera's state, picked or not (#302): from the list when Ring gave it, else asked one by one.
            const status = device.online === true ? "online" : device.online === false ? "offline" : await provider.status(ref, device.id).catch(() => "unknown");
            return { deviceId: device.id, name: device.name, usedHere: used, status };
          }),
        );
        const week = desk.countingWindow();
        const counting = week && Date.parse(week.until) > h.now().getTime() ? { countingWeek: week } : {};
        return done({ connected: true, cameras, ...counting, ...tell, ...(picked.length ? {} : { next: "Ask the host which of these cameras are outdoors at this property, then call pick_cameras." }) });
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
    case "counting_week":
      return desk.countingWeek({ action: args.action, hostAgreed: args.hostAgreed });
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
    // An account with cameras off gets no events and no clock, whatever its cameras.json says.
    if (!tenant || tenant.disabled || !featureOn(tenant, "cameras", h.baseEnv())) continue;
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

const CONSENT = (label: string, counter: string) => `<h1>Connect Ring to Property Core</h1>
<p>For <strong>${escapeHtml(label)}</strong>, Property Core will read:</p>
<ul>
<li>motion, doorbell and online/offline events from the outdoor cameras you pick next;</li>
<li>a still image from each motion event during a guest's stay. ${counter} counts the people, vehicles and pets in it, then deletes it. The image is never sent to anyone else;</li>
<li>a video clip only when you ask to keep one as evidence.</li>
</ul>
<p>No one is identified. Indoor cameras are never used. You sign in on Ring's own page; Property Core never sees your password. You can disconnect at any time.</p>
<form method="post"><button type="submit" name="agree" value="yes">I agree</button></form>`;

// The steps match the live link of 24 Nov (#302): a private Ring app sits under Staging Apps in the Ring Appstore.
// Once Ring publishes the app, the second step changes.
const AGREED = (label: string, word: string) => `<h1>Now connect Property Core in Ring</h1>
<p>Thanks. You agreed to what Property Core reads for <strong>${escapeHtml(label)}</strong>.</p>
<ol>
<li>In this same browser, sign in at the Ring Appstore.</li>
<li>Under Staging Apps, find <strong>Property Core</strong> and press Connect App.</li>
<li>Agree on Ring's page, and pick the cameras to share.</li>
<li>Ring sends you back to a Property Core page to finish.</li>
</ol>
<p>If that page asks for a pairing word, yours is <strong class="word">${shownWord(word)}</strong>. It works for 30 minutes.</p>`;

const CONFIRM = (input: { label?: string; email?: string; nonce: string; time: string; wrong?: boolean }) => `<h1>Connect this Ring account?</h1>
<p>Ring account: <strong>${escapeHtml(input.email ? maskEmail(input.email) : "the one you just used in Ring")}</strong></p>
${input.label ? `<p>Property: <strong>${escapeHtml(input.label)}</strong></p>` : `<p>Type the pairing word from the Property Core page where you agreed. If you haven't opened that page, ask your assistant to connect Ring and start there.</p>`}
${input.wrong ? `<p role="alert">That pairing word didn't match. Check it and try again.</p>` : ""}
<form method="post"><input type="hidden" name="nonce" value="${escapeHtml(input.nonce)}"><input type="hidden" name="time" value="${escapeHtml(input.time)}">
${input.label ? "" : `<p><label>Pairing word <input name="word" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="20" required></label></p>`}
<button type="submit">Connect</button></form>
<p>If this isn't your Ring account, close this page. Nothing is connected until you choose Connect.</p>`;

const NOT_CONNECTED = "<h1>Ring wasn't connected</h1><p>This page has expired, or it wasn't opened from Ring. Ask your assistant to connect Ring again and start from the link it gives you.</p>";
const HOME = "<h1>Property Core and Ring</h1><p>Property Core reads only the outdoor cameras you picked, and only what you agreed to.</p><p>You manage the connection from your assistant's chat. Ask it which cameras are used, to change them, or to disconnect Ring. You can also remove Property Core in the Ring app at any time.</p>";

const page = (r: HostedRequest, status: number, title: string, body: string, extra: Record<string, string> = {}) => (r.send(status, "text/html; charset=utf-8", html(title, body), { ...PAGE_HEADERS, ...extra }), true);
const markCookie = (mark: string, maxAge: number) => `${MARK_COOKIE}=${mark}; Path=${CAMERA_HOME_PATH}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

function markOf(r: HostedRequest): string | undefined {
  const header = r.req.headers.cookie;
  for (const part of typeof header === "string" ? header.split(";") : []) {
    const [name, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (name === MARK_COOKIE && /^[A-Za-z0-9_-]{32,100}$/.test(value)) return value;
  }
  return undefined;
}

/** Ring's webhook, the consent link and Ring's account-linking addresses, on the service's own paths. True when the request was one of them. */
export async function handleCameraRoutes(h: HostedCleaner, r: HostedRequest): Promise<boolean> {
  const path = r.url.pathname;
  const isCamera = path === CAMERA_WEBHOOK_PATH || path === CAMERA_TOKEN_PATH || path === CAMERA_LINK_PATH || path === CAMERA_HOME_PATH || path.startsWith(CONNECT_PREFIX);
  if (!isCamera) return false;
  const provider = providerFor(h);
  // Not found until some account has cameras on; each link and event is then checked against its own account.
  if (!provider || !anyAccountOn(h)) {
    r.send(404, "text/plain", "Not found");
    return true;
  }
  if (path === CAMERA_WEBHOOK_PATH) {
    if (r.method !== "POST") return (r.send(405, "text/plain", "Method not allowed"), true);
    const rawBody = await r.readRaw();
    const result = ingestWebhook({ provider, places: () => places(h), logFor: (tenantId, propertyId) => logOf(h, tenantId, propertyId), rawBody, headers: r.req.headers });
    r.send(result.status, "text/plain", result.status === 200 ? "ok" : "Unauthorized");
    if (result.status === 200 && result.stored) void afterStored(h, result.stored).catch(() => h.log("A camera event was stored but its follow-up didn't run."));
    if (result.status === 200 && result.unlinked) h.log("A Ring account removed Property Core.");
    return true;
  }
  if (path === CAMERA_HOME_PATH) {
    if (r.method !== "GET") return (r.send(405, "text/plain", "Method not allowed"), true);
    return page(r, 200, "Property Core and Ring", HOME);
  }
  if (path.startsWith(CONNECT_PREFIX)) return consentPage(h, r, path.slice(CONNECT_PREFIX.length));
  const pool = waitingFor(h);
  // Without the sealing key nothing can be held or saved, so Ring's linking addresses aren't there either.
  if (!pool) return (r.send(404, "text/plain", "Not found"), true);
  return path === CAMERA_TOKEN_PATH ? tokenExchange(h, r, provider, pool) : accountLink(h, r, provider, pool);
}

/** The one-time link from the host's assistant: what's read, the host's yes, then how to connect in Ring. */
async function consentPage(h: HostedCleaner, r: HostedRequest, state: string): Promise<boolean> {
  const link = /^[A-Za-z0-9_-]{32,100}$/.test(state) ? linksFor(h).peek(state) : undefined;
  const place = link && placeOf(h, link.tenantId, link.propertyId);
  if (!link || !place) return page(r, 404, "Link expired", "<p>This link has expired or was already used. Ask your assistant for a new one.</p>");
  const agreedPage = () => {
    const agreed = linksFor(h).agree(state);
    if (!agreed) return page(r, 404, "Link expired", "<p>This link has expired or was already used. Ask your assistant for a new one.</p>");
    return page(r, 200, "Connect Ring", AGREED(place.property.label, agreed.word), { "Set-Cookie": markCookie(agreed.mark, 1800) });
  };
  if (r.method === "GET") return link.agreed ? agreedPage() : page(r, 200, "Connect Ring", CONSENT(place.property.label, "Property Core's own server"));
  if (r.method !== "POST") return (r.send(405, "text/plain", "Method not allowed"), true);
  const form = new URLSearchParams(((await r.readCapped(1024)) ?? Buffer.alloc(0)).toString("utf8"));
  if (form.get("agree") !== "yes") return page(r, 400, "Connect Ring", "<p>Nothing was connected.</p>");
  const root = propertyFolder(h.dataRoot, place.tenant.id, place.property);
  if (!link.agreed) writeCameras(root, { ...readCameras(root), consentAt: h.now().toISOString() });
  return agreedPage();
}

/**
 * Ring's Token Exchange URL (#302): Ring posts a one-time code, server to server, as a form. It can't be verified by
 * signature; the code is useless without our client secret. We trade it inside its 60 seconds, read whose Ring account
 * it is over the new token, hold the tokens as waiting, and only then answer 200. Any other answer fails the link at
 * Ring, which doesn't retry. Nothing about the code or the tokens is logged.
 */
async function tokenExchange(h: HostedCleaner, r: HostedRequest, provider: CameraProvider, pool: WaitingTokens): Promise<boolean> {
  if (r.method !== "POST") return (r.send(405, "text/plain", "Method not allowed"), true);
  const form = new URLSearchParams(((await r.readCapped(8192)) ?? Buffer.alloc(0)).toString("utf8"));
  const code = form.get("code");
  const clientId = form.get("client_id");
  // A client id that isn't ours gets nothing done.
  if (!code || !clientId || code.length > 4096 || !provider.ownsClient(clientId)) return (r.send(400, "text/plain", "Bad request"), true);
  try {
    const held = heldAccount(await provider.exchangeCode(code));
    const profile = await provider.profile(held);
    pool.hold({ accountId: profile.accountId, ...(profile.email ? { email: profile.email } : {}), tokens: held.current() });
  } catch {
    h.log("Ring posted a sign-in code that couldn't be traded.");
    return (r.send(502, "text/plain", "Not linked"), true);
  }
  r.send(200, "text/plain", "ok");
  return true;
}

/**
 * Ring's Account Link URL (#302): the host's browser, sent by Ring with a nonce and a time. The nonce finds the waiting
 * tokens; the browser's mark from the consent page, or the pairing word, says which host this is. Tokens are saved to
 * an account only after both, a fresh time, the host's Connect, and Ring's own check of the nonce.
 */
async function accountLink(h: HostedCleaner, r: HostedRequest, provider: CameraProvider, pool: WaitingTokens): Promise<boolean> {
  if (r.method !== "GET" && r.method !== "POST") return (r.send(405, "text/plain", "Method not allowed"), true);
  const form = r.method === "POST" ? new URLSearchParams(((await r.readCapped(2048)) ?? Buffer.alloc(0)).toString("utf8")) : r.url.searchParams;
  const nonce = form.get("nonce") ?? "";
  const time = form.get("time") ?? "";
  const found = pool.match(nonce, time, (at, accountId) => provider.linkNonce(at, accountId));
  if (!found) return page(r, 400, "Not connected", NOT_CONNECTED);
  const mark = markOf(r);
  const marked = mark ? linksFor(h).byMark(mark) : undefined;
  const labelOf = (link: AgreedLink | undefined) => (link ? placeOf(h, link.tenantId, link.propertyId)?.property.label : undefined);
  const ask = (status: number, wrong = false) => {
    const label = labelOf(marked);
    return page(r, status, "Connect Ring", CONFIRM({ ...(label ? { label } : {}), ...(found.email ? { email: found.email } : {}), nonce, time, wrong }));
  };
  if (r.method === "GET") return ask(200);

  const typed = form.get("word");
  const link = labelOf(marked) ? marked : typed ? linksFor(h).byWord(typed) : undefined;
  if (!link) {
    if (!typed) return ask(400);
    // Five wrong words and these tokens are dropped: the host starts again from their assistant.
    return pool.wrongWord(found.accountId) ? page(r, 400, "Not connected", NOT_CONNECTED) : ask(400, true);
  }
  const place = placeOf(h, link.tenantId, link.propertyId);
  const ref = account(h, link.tenantId);
  if (!place || !ref) return page(r, 400, "Not connected", NOT_CONNECTED);
  return claim(h, r, provider, pool, { found, nonce, link, place, ref });
}

async function claim(
  h: HostedCleaner,
  r: HostedRequest,
  provider: CameraProvider,
  pool: WaitingTokens,
  input: { found: WaitingAccount; nonce: string; link: AgreedLink; place: { tenant: Tenant; property: Property }; ref: NonNullable<ReturnType<typeof account>> },
): Promise<boolean> {
  const { found, nonce, link, place, ref } = input;
  const held = heldAccount(found.tokens);
  // Out of the pool first, so two Connects for the same tokens can't both reach Ring.
  pool.drop(found.accountId);
  try {
    await provider.confirmLink(held, { nonce, accountIdentifier: maskLabel(place.tenant.label) });
  } catch (error) {
    return page(r, 502, "Not connected", `<h1>Ring wasn't connected</h1><p>${escapeHtml(plain(error))} Ask your assistant to connect Ring again and start from the link it gives you.</p>`);
  }
  linksFor(h).finish(link.state);
  ref.tokens.save(held.current());
  const root = propertyFolder(h.dataRoot, place.tenant.id, place.property);
  writeCameras(root, { ...readCameras(root), provider: provider.name, connectedAt: h.now().toISOString() });
  return page(r, 200, "Ring connected", "<h1>Ring is connected</h1><p>Go back to your assistant's chat to pick which outdoor cameras belong to this property.</p>", { "Set-Cookie": markCookie("", 0) });
}

/** Some account on the service has cameras on. */
function anyAccountOn(h: HostedCleaner): boolean {
  return h.registry.list().some((tenant) => !tenant.disabled && featureOn(tenant, "cameras", h.baseEnv()));
}

function placeOf(h: HostedCleaner, tenantId: string, propertyId: string): { tenant: Tenant; property: Property } | undefined {
  const tenant = h.registry.get(tenantId);
  const property = tenant?.properties.find((p) => p.id === propertyId);
  return tenant && !tenant.disabled && property && featureOn(tenant, "cameras", h.baseEnv()) ? { tenant, property } : undefined;
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
  if (stored.line.kind === "motion" && stored.line.label === "package_delivery" && featureOn(place.tenant, "packages", h.baseEnv()) && place.property.flows.supplies.on) {
    // Its own desk, not packageDeskFor's cached one, which keeps the deps it was first made with: check_packages' desk
    // needs its door, sender and host-alert clock (#250).
    new PackageDesk(propertyFolder(h.dataRoot, place.tenant.id, place.property), { now: () => h.now() }).cameraSighting({ at: stored.line.at });
  }
  await countingFor(h, place.tenant, place.property)?.run();
}

function countingFor(h: HostedCleaner, tenant: Tenant, property: Property): CameraCounting | undefined {
  const provider = providerFor(h);
  const counter = counterFor(h);
  const ref = account(h, tenant.id);
  if (!provider || !counter || !ref?.tokens.get()) return undefined;
  // Keyed by the counter too, so changing the model starts a fresh pass rather than reusing the old one.
  const key = `${tenant.id}/${property.id}/${counter.name}`;
  let counting = countings.get(key);
  if (!counting) {
    const desk = deskFor(h, tenant, property);
    const root = propertyFolder(h.dataRoot, tenant.id, property);
    counting = new CameraCounting({ provider, account: ref, counter, log: sharedCameraLog(root, () => h.now()), inStay: (at) => desk.counts(at), nightOf: (at) => desk.nightOf(at), capAt: (at) => desk.capAt(at) });
    countings.set(key, counting);
  }
  return counting;
}

let round = false;

/**
 * The cameras' clock, on the same tick as Fixer Core's: count what's waiting. Camera offline and back-online notes
 * are the host-alert clock's since #250 (src/hosted/hostAlerts.ts), so the host is told once, through one path.
 * One property's failure never stops the rest.
 */
export async function tickAllCameras(h: HostedCleaner): Promise<void> {
  if (round || !anyAccountOn(h)) return;
  round = true;
  try {
    for (const place of places(h)) {
      const found = placeOf(h, place.tenantId, place.propertyId);
      if (!found) continue;
      try {
        await countingFor(h, found.tenant, found.property)?.run();
      } catch {
        h.log(`The cameras couldn't run ${place.tenantId}/${place.propertyId}'s clock this round.`);
      }
    }
  } finally {
    round = false;
  }
}

/** A property's counting week (#239), for the admin page's sheet link. */
export interface CountingWeekRow {
  propertyId: string;
  label: string;
  from: string;
  until: string;
}

/** Every property of an account with a counting week saved, running or done. */
export function countingWeeks(h: HostedCleaner, tenant: Tenant): CountingWeekRow[] {
  if (!featureOn(tenant, "cameras", h.baseEnv())) return [];
  return tenant.properties.flatMap((property) => {
    try {
      const week = readCameras(propertyFolder(h.dataRoot, tenant.id, property)).countingWeek;
      return week ? [{ propertyId: property.id, label: property.label, from: week.from, until: week.until }] : [];
    } catch {
      return [];
    }
  });
}

const SHEET_DATE = /^\d{4}-\d{2}-\d{2}$/;
const localDate = (iso: string, timeZone: string) => {
  const p = zonedParts(new Date(iso), timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};

/**
 * The counting week's review sheet (#239) for one property, as CSV: one row per counted motion event between two
 * local dates (the end date not included), with empty columns for the host's own numbers. Without dates, the
 * counting week's days. It reads only the property's event log: no image, link or code is in it.
 */
export function countSheetFor(h: HostedCleaner, tenant: Tenant, propertyId: string, asked: { from?: string; to?: string } = {}): { csv: string; filename: string; rows: number } | { error: string } {
  if (!featureOn(tenant, "cameras", h.baseEnv())) return { error: "Cameras aren't on for this account." };
  const property = tenant.properties.find((each) => each.id === propertyId);
  if (!property) return { error: "That property isn't on this account." };
  const root = propertyFolder(h.dataRoot, tenant.id, property);
  const timeZone = readHubFile(root)?.property.timeZone;
  if (!timeZone) return { error: "The property has no time zone, so its events can't be put in local time." };
  const week = readCameras(root).countingWeek;
  const from = asked.from || (week ? localDate(week.from, timeZone) : undefined);
  const to = asked.to || (week ? addCalendarDays(localDate(week.until, timeZone), 1) : undefined);
  if (!from || !to || !SHEET_DATE.test(from) || !SHEET_DATE.test(to) || to <= from) return { error: "Give from and to as YYYY-MM-DD, with to after from." };
  const counter = counterFor(h)?.name;
  const rows = exportRows(sharedCameraLog(root, () => h.now()).read(), { timeZone, from, to, ...(counter ? { counter } : {}) });
  return { csv: toCsv(rows), filename: `counting-sheet-${property.id}-${from}-to-${to}.csv`, rows: rows.length };
}
