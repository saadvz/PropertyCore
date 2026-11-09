import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveDesk } from "../src/cleaner-core/liveDesk";
import { photoKey, photoLinks, setCleanerPhotoFetch, storePhoto } from "../src/cleaner-core/photos";
import { propertyBasePath, propertyFolder, type Property } from "../src/cleaner-core/hosted/properties";
import { propertyContext, tickAllFixers } from "../src/cleaner-core/hosted/router";
import type { Tenant } from "../src/cleaner-core/hosted/registry";
import { FixerDesk, resetFixerDesks } from "../src/fixer-core/desk";
import { readFixer } from "../src/fixer-core/store";
import { resetVisitLookups, VISIT_LOOKUPS_PER_MINUTE, VISIT_LOOKUPS_PER_PROPERTY } from "../src/hosted/fixerVisit";
import { hubFor } from "../src/hub/hub";
import { BASE, closeHostedApps, DOMAIN } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { CALENDAR_URL } from "./wiringProof";

/**
 * Fixer Core's hosted routes over the real router: the pro's visit page on a property's own path, the
 * pro's texts on the shared line, and Fixer Core's links on a property without Cleaner Core. Only 555
 * numbers, example.com addresses, made-up pros and a made-up door code, which no test prints.
 */

const LANE = "+15555550150";
const COURT = "+15555550160";
const JOE = "+15555550142";
const SLOW = { timeout: 120_000 };
const PATH = "/mcp";
const NOW = new Date("2026-11-08T15:00:00.000Z");
/** Tuesday 10 to 12 in Teaneck. */
const TUE = { from: "2026-11-10T15:00:00.000Z", until: "2026-11-10T17:00:00.000Z" };
const PLACE = { address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" };
const JOES = { name: "Joe's Plumbing", trades: ["plumbing"], reach: { phone: JOE }, preferredFor: [{ trade: "plumbing", rank: 1 }] };
/** Made up, and built so the whole code appears nowhere in this file. */
const CODE = ["7", "3", "1", "9"].join("");
const NEW_CODE = ["5", "0", "8", "6"].join("");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), Buffer.from([0xff, 0xd9])]);
const STRICT = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow", "x-content-type-options": "nosniff", "x-frame-options": "DENY" };

let open: MultiTenantApp | undefined;
let clock = new Date(NOW);
afterEach(() => {
  vi.restoreAllMocks();
  setCleanerPhotoFetch(undefined);
  open?.close();
  open = undefined;
  closeHostedApps();
  resetFixerDesks();
  resetVisitLookups();
  clock = new Date(NOW);
});

async function start() {
  resetVisitLookups();
  open = await multiTenantApp({ env: { FIXER_CORE: "1" }, now: () => clock });
  return open;
}

/** An account on a 555 line with one property and a chat of the given kind on the shared address. */
async function account(m: MultiTenantApp, assistant: "grok" | "muse" = "grok", number = LANE) {
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: number });
  const property = m.registry.addProperty(tenant.id, "12 Scratch Lane");
  const token = await m.joinAt(tenant.id, assistant, PATH);
  m.hosted().secrets.set(tenant.id, { CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64") });
  return { tenant, property, token };
}

const fresh = (m: MultiTenantApp, tenant: Tenant) => m.registry.get(tenant.id)!;
const pathOf = (url: string) => new URL(url).pathname;
const codeOf = (reply: { structured?: Record<string, unknown> }) => (reply.structured!.confirmation as { code: string }).code;
const holds = (text: string, secret: string) => text.includes(secret);

/** Every tool reply, response body and text this test saw, apart from the door's own answer. */
function watcher(m: MultiTenantApp, token: string, property: Property) {
  const seen: string[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await m.toolAt(PATH, token, name, { property: property.id, ...args });
    seen.push(reply.raw);
    expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
    return reply;
  };
  const http = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const res = await m.app.http(path, init);
    seen.push(await res.text());
    return res;
  };
  return { seen, call, http };
}

/** Fixer Core on, set up and active, with the booking calendar sent through its upload link over the router. */
async function activeFixer(m: MultiTenantApp, w: ReturnType<typeof watcher>) {
  await w.call("set_flows", { fixer: true });
  await w.call("save_fixer_property", PLACE);
  const link = await w.call("save_fixer_sources", { uploadLink: { name: "Airbnb" } });
  const saved = await w.http(pathOf(String(link.structured!.uploadUrl)), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: CALENDAR_URL }) });
  expect(saved.status).toBe(200);
  await w.call("save_fixer_sources", { done: true });
  const joe = await w.call("save_pro", JOES);
  await w.call("save_fixer_settings", { prosDone: true });
  await w.call("save_fixer_settings", { costLineCents: null });
  await w.call("save_fixer_settings", { upkeepDone: true });
  await w.call("activate_fixer");
  return joe.structured!.proId as string;
}

/** A booked visit for Joe on Tuesday, with the host's yes to letting him in with the code, and its page link. */
async function bookedVisit(m: MultiTenantApp, tenant: Tenant, property: Property, w: ReturnType<typeof watcher>) {
  const ctx = propertyContext(m.hosted(), fresh(m, tenant), property);
  expect(hubFor(ctx.root, { now: () => clock }).doorAccess(ctx.env).save(CODE, "the lockbox by the side door", undefined).ok).toBe(true);
  const joeId = await activeFixer(m, w);
  const jobId = (await w.call("open_job", { trade: "plumbing", what: "Sink leaks", urgency: "soon", source: "host" })).structured!.jobId as string;
  await w.call("check_fixes");
  const contactToken = (await w.call("contact_pro", { jobId, to: joeId, how: "call" })).structured!.contactToken as string;
  await w.call("record_contact", { contactToken, outcome: "booked", ...TUE, estimateCents: 18000 });
  const ask = await w.call("approve_booking", { jobId, access: "code" });
  await w.call("approve_booking", { jobId, access: "code", confirmation: codeOf(ask) });
  const url = String((await w.call("visit_link", { jobId })).structured!.url);
  return { jobId, url, path: pathOf(url), token: url.slice(url.lastIndexOf("/") + 1) };
}

function expectStrict(headers: Record<string, string | string[] | undefined>) {
  for (const [name, value] of Object.entries(STRICT)) expect(headers[name], name).toBe(value);
  expect(String(headers["content-security-policy"])).toContain("default-src 'none'");
}

/**
 * A POST that never finishes: it declares `declared` bytes (or is chunked when undefined), sends only
 * `sent` bytes, and resolves with the server's answer. An answer at all means the server didn't wait
 * for, or keep, the rest.
 */
function partialPost(m: MultiTenantApp, path: string, type: string, declared: number | undefined, sent = 1024): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const port = (m.app.server.address() as { port: number }).port;
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: DOMAIN, "x-forwarded-proto": "https", "content-type": type, ...(declared !== undefined ? { "content-length": String(declared) } : {}) };
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        req.destroy();
      });
    });
    // The server may close first; only its answer matters.
    req.on("error", () => undefined);
    req.on("close", () => reject(new Error("closed without an answer")));
    for (let left = sent; left > 0; left -= 1024) req.write(Buffer.alloc(Math.min(1024, left), 0x61));
  });
}

const made = () => Array.from({ length: 64 }, () => "abcdefghijklmnop"[Math.floor(Math.random() * 16)]).join("");

describe("a repair visit end to end on the shared service", () => {
  it("opens, books with the host's yes, shows the page, gives the code only at the door, takes the pro's DONE text with a photo, and records the cost", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    const w = watcher(m, token, property);
    const { jobId, path, token: visitToken } = await bookedVisit(m, tenant, property, w);

    // The page over the real router: the visit, never the code.
    const page = await w.http(path);
    expect(page.status).toBe(200);
    expectStrict(page.headers);
    expect(await page.text()).toContain("Sink leaks");

    // At the visit time, the door POST answers with the code: the only place it appears.
    clock = new Date(Date.parse(TUE.from) - 10 * 60_000);
    const door = await m.app.http(`${path}/door`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(door.status).toBe(200);
    expectStrict(door.headers);
    const shown = (await door.json()) as { code?: string; lockLocation?: string };
    expect(shown.code === CODE, "the door answer holds the saved code").toBe(true);
    expect(shown.lockLocation).toBe("the lockbox by the side door");

    // Joe says YES on the line, then DONE with a photo once the visit has started.
    setCleanerPhotoFetch(async () => new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } }));
    const yes = await m.text(LANE, JOE, "YES", "SMfixeryes01");
    expect(yes.status).toBe(200);
    w.seen.push(await yes.text());
    clock = new Date(Date.parse(TUE.from) + 45 * 60_000);
    await tickAllFixers(m.hosted());
    expect(readFixer(propertyFolder(m.app.root, tenant.id, property)).jobs[0]!.state).toBe("in-progress");
    const media = `https://api.twilio.com/2010-04-01/Accounts/ACmultitenant/Messages/MMfixer01/Media/MEfixer01`;
    const done = await m.twilio("/webhooks/twilio/cleaner-core", { MessageSid: "SMfixerdone01", From: JOE, To: LANE, Body: "DONE", NumMedia: "1", MediaUrl0: media, MediaContentType0: "image/jpeg", SmsStatus: "received" });
    expect(done.status).toBe(200);
    w.seen.push(await done.text());
    const file = readFixer(propertyFolder(m.app.root, tenant.id, property));
    expect(file.seenInbound).toEqual(["SMfixeryes01", "SMfixerdone01"]);
    expect(file.jobs[0]).toMatchObject({ id: jobId, state: "done" });
    expect(file.jobs[0]!.photos.filter((photo) => photo.from === "pro")).toHaveLength(1);

    // Its photo link works on this property, which runs Fixer Core without Cleaner Core.
    const photos = (await w.call("get_job_photos", { job: jobId })).structured!.photos as { url: string }[];
    expect(photos).toHaveLength(1);
    const photo = await m.app.http(pathOf(photos[0]!.url));
    expect(photo.status).toBe(200);
    expect(photo.headers["content-type"]).toBe("image/jpeg");

    const cost = await w.call("record_cost", { jobId, cents: 18000, by: "host" });
    expect(readFixer(propertyFolder(m.app.root, tenant.id, property)).jobs[0]!.cost).toMatchObject({ cents: 18000 });
    expect(cost.isError).toBe(false);

    // Nothing but the door's answer held the code, or the link's token: no reply, response, log line or text.
    expect(w.seen.length).toBeGreaterThan(15);
    expect(w.seen.some((text) => holds(text, CODE)), "a reply or response holds the code").toBe(false);
    expect(m.app.logs.some((line) => holds(line, CODE) || holds(line, visitToken) || holds(line, "/fixer-core/visit/")), "a log line holds the code or the visit path").toBe(false);
    expect(m.sms.sent.some((sms) => holds(sms.body, CODE)), "a text holds the code").toBe(false);
    expect(m.sms.sent).toEqual([]);
  });
});

describe("the visit page route", () => {
  it("is served only on its own property's path, and only while that property's Fixer Core is on", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    const w = watcher(m, token, property);
    const court = m.registry.addProperty(tenant.id, "8 Scratch Court");
    await m.toolAt(PATH, token, "set_flows", { property: court.id, fixer: true });
    const { token: visitToken, path } = await bookedVisit(m, tenant, property, w);
    expect((await m.app.http(path)).status).toBe(200);
    // The same token on another property's path opens nothing there.
    const elsewhere = await m.app.http(`${propertyBasePath(tenant.id, court)}/fixer-core/visit/${visitToken}`);
    expect(elsewhere.status).toBe(404);
    expectStrict(elsewhere.headers);
    expect(await elsewhere.text()).not.toContain("Sink leaks");
    // With Fixer Core off at a property, its visit path isn't served at all.
    const cleaning = m.registry.addProperty(tenant.id, "3 Scratch Road");
    m.registry.setFlow(tenant.id, cleaning.id, "cleaning", true);
    const off = await m.app.http(`${propertyBasePath(tenant.id, cleaning)}/fixer-core/visit/${visitToken}`);
    expect(off.status).toBe(404);
    expect(await off.text()).toBe("Not found");
  });

  it("caps the body before reading it: 5 MB for a photo, 4096 bytes for the others, with the strict headers", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    const w = watcher(m, token, property);
    const { path } = await bookedVisit(m, tenant, property, w);
    clock = new Date(TUE.from);
    const big = await partialPost(m, `${path}/photo`, "image/jpeg", 5 * 1024 * 1024 + 1);
    expect(big.status).toBe(413);
    expectStrict(big.headers);
    expect(JSON.parse(big.body)).toEqual({ error: "That photo is over 5 MB. Send a smaller one." });
    const done = await partialPost(m, `${path}/done`, "application/json", 4097);
    expect(done.status).toBe(413);
    expectStrict(done.headers);
    expect(JSON.parse(done.body)).toEqual({ error: "That request is too large." });
    // Sent whole, a body under the caps is read and answered by the page.
    const small = await m.app.http(`${path}/done`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: "x".repeat(200) }) });
    expect(small.status).toBe(200);
    expect(readFixer(propertyFolder(m.app.root, tenant.id, property)).jobs[0]!.state).toBe("done");
  });

  it("answers a desk failure with 500, the strict headers and no error text, and logs no path or token", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    const w = watcher(m, token, property);
    const { path, token: visitToken } = await bookedVisit(m, tenant, property, w);
    clock = new Date(TUE.from);
    vi.spyOn(FixerDesk.prototype, "revealCode").mockRejectedValue(new Error("Sink leaks at the side gate"));
    const failed = await m.app.http(`${path}/door`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(failed.status).toBe(500);
    expectStrict(failed.headers);
    const body = await failed.text();
    expect(body).toBe("Something went wrong. Try again in a few minutes.");
    expect(m.app.logs).toContain(`Fixer Core's visit page couldn't answer a request for ${tenant.id}/${property.id}.`);
    expect(m.app.logs.some((line) => line.includes(visitToken) || line.includes("/fixer-core/visit/") || line.includes("Sink"))).toBe(false);
  });

  it("lets a real pro through a flood of made-up links: 30 lookups a minute per property, and a link found live needs no more", SLOW, async () => {
    const m = await start();
    const a = await account(m, "grok", LANE);
    const b = await account(m, "grok", COURT);
    const wa = watcher(m, a.token, a.property);
    const wb = watcher(m, b.token, b.property);
    const onA = await bookedVisit(m, a.tenant, a.property, wa);
    const onB = await bookedVisit(m, b.tenant, b.property, wb);
    // A's pro opened their link; after a restart, that first request finds it live again and remembers it.
    expect((await m.app.http(onA.path)).status).toBe(200);
    resetFixerDesks();
    expect((await m.app.http(onA.path)).status).toBe(200);
    // Two hours on, past the per-link hour: the remembered link still costs no lookup.
    clock = new Date(clock.getTime() + 2 * 60 * 60_000);
    const baseA = propertyBasePath(a.tenant.id, a.property);
    for (let i = 0; i < VISIT_LOOKUPS_PER_PROPERTY; i++) expect((await m.app.http(`${baseA}/fixer-core/visit/${made()}`)).status).toBe(404);
    const limited = await m.app.http(`${baseA}/fixer-core/visit/${made()}`);
    expect(limited.status).toBe(429);
    expectStrict(limited.headers);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(JSON.stringify(await limited.text())).not.toContain("Sink");
    // The flood on A never reaches A's pro, or B's pro opening their link for the first time.
    expect((await m.app.http(onA.path)).status).toBe(200);
    expect((await m.app.http(onB.path)).status).toBe(200);
    // A malformed token costs nothing. The next minute looks up again.
    expect((await m.app.http(`${baseA}/fixer-core/visit/not-a-token`)).status).toBe(404);
    clock = new Date(clock.getTime() + 61_000);
    expect((await m.app.http(`${baseA}/fixer-core/visit/${made()}`)).status).toBe(404);
  });

  it("stops new lookups at 120 a minute across every account", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    const properties = [property, ...["8 Scratch Court", "3 Scratch Road", "5 Scratch Way", "9 Scratch Row"].map((label) => m.registry.addProperty(tenant.id, label))];
    for (const p of properties) await m.toolAt(PATH, token, "set_flows", { property: p.id, fixer: true });
    const bases = properties.map((p) => propertyBasePath(tenant.id, p));
    for (const base of bases.slice(0, VISIT_LOOKUPS_PER_MINUTE / VISIT_LOOKUPS_PER_PROPERTY)) {
      for (let i = 0; i < VISIT_LOOKUPS_PER_PROPERTY; i++) expect((await m.app.http(`${base}/fixer-core/visit/${made()}`)).status).toBe(404);
    }
    expect((await m.app.http(`${bases[4]}/fixer-core/visit/${made()}`)).status).toBe(429);
  });

  it("answers a malformed or unknown link without reading the body it sends", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    await m.toolAt(PATH, token, "set_flows", { property: property.id, fixer: true });
    const base = propertyBasePath(tenant.id, property);
    for (const tok of ["not-a-token", made()]) {
      // 5 MB declared as chunks, of which 64 KB are sent and the rest never comes.
      const res = await partialPost(m, `${base}/fixer-core/visit/${tok}/photo`, "image/jpeg", undefined, 64 * 1024);
      expect(res.status).toBe(404);
      expectStrict(res.headers);
      expect(res.headers.connection).toBe("close");
    }
  });

  it("caps a chunked body for a live visit at 4096 bytes", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    const w = watcher(m, token, property);
    const { path } = await bookedVisit(m, tenant, property, w);
    clock = new Date(TUE.from);
    const res = await partialPost(m, `${path}/done`, "application/json", undefined, 8 * 1024);
    expect(res.status).toBe(413);
    expectStrict(res.headers);
    expect(JSON.parse(res.body)).toEqual({ error: "That request is too large." });
    expect(readFixer(propertyFolder(m.app.root, tenant.id, property)).jobs[0]!.state).not.toBe("done");
  });
});

describe("the pro's texts on the shared line", () => {
  it("leave a text from someone who isn't a pro on the old path", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    const w = watcher(m, token, property);
    await bookedVisit(m, tenant, property, w);
    const res = await m.text(LANE, "+15555550199", "DONE", "SMnotapro01");
    expect(res.status).toBe(200);
    expect(m.app.logs).toContain(`A text reached ${tenant.id}'s line from someone on no property. Nothing was sent.`);
    expect(readFixer(propertyFolder(m.app.root, tenant.id, property)).seenInbound ?? []).toEqual([]);
  });

  it("refuse a pro's DONE with a forged signature, and change nothing", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    const w = watcher(m, token, property);
    await bookedVisit(m, tenant, property, w);
    await m.text(LANE, JOE, "YES", "SMforgeyes01");
    clock = new Date(Date.parse(TUE.from) + 30 * 60_000);
    const forged = await m.twilio("/webhooks/twilio/cleaner-core", { MessageSid: "SMforged01", From: JOE, To: LANE, Body: "DONE", SmsStatus: "received" }, "/webhooks/twilio/elsewhere");
    expect(forged.status).toBe(403);
    const file = readFixer(propertyFolder(m.app.root, tenant.id, property));
    expect(file.seenInbound).toEqual(["SMforgeyes01"]);
    expect(file.jobs[0]!.state).toBe("booked");
  });

  it("go to the property with the pro's visit under way, over an earlier booked one", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    const court = m.registry.addProperty(tenant.id, "8 Scratch Court");
    const lane = watcher(m, token, property);
    await bookedVisit(m, tenant, property, lane);
    // Joe also books on Court, on Tuesday at 8:00, before Lane's visit.
    const ctx = propertyContext(m.hosted(), fresh(m, tenant), court);
    expect(hubFor(ctx.root, { now: () => clock }).doorAccess(ctx.env).save(NEW_CODE, undefined, undefined).ok).toBe(true);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const reply = await m.toolAt(PATH, token, name, { property: court.id, ...args });
      expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
      return reply;
    };
    await call("set_flows", { fixer: true });
    await call("save_fixer_property", { ...PLACE, address: "8 Scratch Court, Teaneck, NJ 07666" });
    await call("save_fixer_sources", { done: true });
    const joe = await call("save_pro", { ...JOES, shared: true });
    for (const settings of [{ prosDone: true }, { costLineCents: null }, { upkeepDone: true }]) await call("save_fixer_settings", settings);
    await call("activate_fixer");
    const courtJob = (await call("open_job", { trade: "plumbing", what: "Tub drains slowly", urgency: "soon", source: "host" })).structured!.jobId as string;
    const contactToken = (await call("contact_pro", { jobId: courtJob, to: joe.structured!.proId, how: "call" })).structured!.contactToken as string;
    await call("record_contact", { contactToken, outcome: "booked", from: "2026-11-10T13:00:00.000Z", until: "2026-11-10T14:00:00.000Z" });
    const ask = await call("approve_booking", { jobId: courtJob });
    await call("approve_booking", { jobId: courtJob, confirmation: codeOf(ask) });
    // Joe is at Court; Lane's later visit is booked and hasn't started.
    clock = new Date("2026-11-10T13:15:00.000Z");
    await tickAllFixers(m.hosted());
    await m.text(LANE, JOE, "YES", "SMpickyes01");
    expect((await m.text(LANE, JOE, "DONE", "SMpickdone01")).status).toBe(200);
    const atCourt = readFixer(propertyFolder(m.app.root, tenant.id, court));
    expect(atCourt.jobs[0]).toMatchObject({ id: courtJob, state: "done" });
    expect(atCourt.seenInbound).toContain("SMpickdone01");
    expect(readFixer(propertyFolder(m.app.root, tenant.id, property)).jobs[0]!.state).not.toBe("done");
  });

  it("leave a cleaner who is also a pro with Cleaner Core, through the real webhook", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const reply = await m.toolAt(PATH, token, name, { property: property.id, ...args });
      expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
      return reply;
    };
    await call("set_flows", { cleaning: true });
    await call("set_flows", { fixer: true });
    await call("save_property", { business: "Lane Stays", ...PLACE });
    await call("save_people", { host: "+15555550101", cleaner: JOE });
    await call("save_pro", JOES);
    const cleanerInbound = vi.spyOn(LiveDesk.prototype, "inbound");
    expect((await m.text(LANE, JOE, "DONE", "SMcleanerpro01")).status).toBe(200);
    expect(readFixer(propertyFolder(m.app.root, tenant.id, property)).seenInbound ?? []).toEqual([]);
    expect(cleanerInbound.mock.calls.map(([input]) => input.id)).toEqual(["SMcleanerpro01"]);
  });
});

describe("Fixer Core's links on a property without Cleaner Core", () => {
  it("saves a new door code from the link change_door_code gives, by JSON and on the private page, without repeating it", SLOW, async () => {
    const m = await start();
    const grok = await account(m, "grok", LANE);
    const muse = await account(m, "muse", COURT);
    for (const [who, code] of [[grok, CODE], [muse, NEW_CODE]] as const) {
      await m.toolAt(PATH, who.token, "set_flows", { property: who.property.id, fixer: true });
      const ctx = propertyContext(m.hosted(), fresh(m, who.tenant), who.property);
      const door = hubFor(ctx.root, { now: () => clock }).doorAccess(ctx.env);
      // What change_door_code does after the host's yes.
      const link = door.issueUpload(undefined, undefined, `${BASE}${propertyBasePath(who.tenant.id, who.property)}`);
      expect(link.ok).toBe(true);
      const path = pathOf((link as { uploadUrl: string }).uploadUrl);
      const saved =
        who === grok
          ? await m.app.http(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) })
          : await (async () => {
              expect((await m.app.http(path)).status).toBe(200);
              return m.app.http(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code }).toString() });
            })();
      expect(saved.status).toBe(200);
      expect(holds(await saved.text(), code), "the save repeats the code").toBe(false);
      expect(door.saved()).toBe(true);
      expect(door.codeForChecks() === code, "the new code is saved").toBe(true);
    }
    expect(m.app.logs.some((line) => holds(line, CODE) || holds(line, NEW_CODE))).toBe(false);
  });

  it("serves only repair job photos there", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    await m.toolAt(PATH, token, "set_flows", { property: property.id, fixer: true });
    const root = propertyFolder(m.app.root, tenant.id, property);
    const ctx = propertyContext(m.hosted(), fresh(m, tenant), property);
    // A cleaning job's photo, kept from when Cleaner Core ran here, with a link signed by the same key.
    expect(storePhoto(root, "job_cleaning1", { bytes: JPEG, ext: "jpg" }, 20)).toBe(true);
    const key = photoKey(ctx.env(), ctx.saveSecrets)!;
    const [link] = photoLinks(root, "job_cleaning1", `${BASE}${propertyBasePath(tenant.id, property)}`, key, clock);
    expect((await m.app.http(pathOf(link!.url))).status).toBe(404);
  });

  it("serves no Cleaner Core link there", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    await m.toolAt(PATH, token, "set_flows", { property: property.id, fixer: true });
    const base = propertyBasePath(tenant.id, property);
    expect((await m.app.http(`${base}/cleaner-core/alert-routine/${"a".repeat(43)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
    expect((await m.app.http(`${base}/door-code/${"a".repeat(43)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: NEW_CODE }) })).status).toBe(404);
  });
});

describe("a new door code through change_door_code's link", () => {
  /** A visit where Joe opened the code, then cancelled: the host is asked about changing it, says yes, and gets the link. */
  async function codeChangeLink(m: MultiTenantApp, tenant: Tenant, property: Property, w: ReturnType<typeof watcher>) {
    const { jobId, path } = await bookedVisit(m, tenant, property, w);
    clock = new Date(Date.parse(TUE.from) - 10 * 60_000);
    expect((await m.app.http(`${path}/door`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(200);
    const ask = await w.call("cancel_job", { jobId });
    const cancelled = await w.call("cancel_job", { jobId, confirmation: codeOf(ask) });
    expect(cancelled.structured?.rotationAsk).toMatchObject([{ jobId }]);
    const link = await w.call("change_door_code", { jobId });
    return { jobId, path: pathOf(String(link.structured!.uploadUrl)) };
  }

  async function expectSettled(m: MultiTenantApp, tenant: Tenant, property: Property, w: ReturnType<typeof watcher>, jobId: string, path: string) {
    expect(readFixer(propertyFolder(m.app.root, tenant.id, property)).jobs[0]!.rotationAsked?.changedAt).toBeUndefined();
    const saved = await m.app.http(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: NEW_CODE }) });
    const body = await saved.text();
    expect(saved.status, body).toBe(200);
    expect(holds(body, NEW_CODE), "the save repeats the code").toBe(false);
    const job = readFixer(propertyFolder(m.app.root, tenant.id, property)).jobs.find((entry) => entry.id === jobId)!;
    expect(job.rotationAsked).toMatchObject({ answer: "yes", changedAt: clock.toISOString() });
    const ctx = propertyContext(m.hosted(), fresh(m, tenant), property);
    expect(hubFor(ctx.root, { now: () => clock }).doorAccess(ctx.env).codeForChecks() === NEW_CODE, "the new code is saved").toBe(true);
    const state = await w.call("get_fixer_state");
    expect(state.raw).not.toContain("knows the door code");
    expect(m.app.logs.some((line) => holds(line, NEW_CODE) || holds(line, CODE))).toBe(false);
  }

  it("on a Fixer-only property, is saved and settles Fixer Core's question", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    const w = watcher(m, token, property);
    const { jobId, path } = await codeChangeLink(m, tenant, property, w);
    await expectSettled(m, tenant, property, w, jobId, path);
  });

  it("with Cleaner Core on, is accepted by Cleaner Core's desk and settles Fixer Core's question", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    const w = watcher(m, token, property);
    await w.call("set_flows", { cleaning: true });
    await w.call("save_property", { business: "Lane Stays", ...PLACE });
    const upload = vi.spyOn(LiveDesk.prototype, "uploadDoorCode");
    const { jobId, path } = await codeChangeLink(m, tenant, property, w);
    await expectSettled(m, tenant, property, w, jobId, path);
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
