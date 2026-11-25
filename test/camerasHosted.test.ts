import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { propertyFolder } from "../src/cleaner-core/hosted/properties";
import { tenantFolder } from "../src/cleaner-core/hosted/registry";
import { fakeCounter } from "../src/cameras/counter";
import { FAKE_CLIENT_ID, fakeCameraProvider, type FakeCameraProvider } from "../src/cameras/fake";
import { setCameraProviderForTests, tickAllCameras } from "../src/hosted/cameras";
import { resetHostAlertClock, tickAllHostAlerts } from "../src/hosted/hostAlerts";
import { resetVisitLogCache } from "../src/visits/store";
import { writeStayCheck } from "../src/stay-check/store";
import { closeHostedApps } from "./cleanerOauthHarness";
import { credentialsFor, switchOn } from "./featureEnv";
import type { Feature } from "../src/features/features";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/** #239 on the shared service, behind each account's "cameras" switch: connecting, picking, webhooks, the night's check, notes. Fake provider only; nothing reaches Ring. */

const LANE = "+15555550152";
const PATH = "/mcp";
const SLOW = { timeout: 90_000 };
const TOOLS = ["connect_cameras", "list_cameras", "pick_cameras", "counting_week", "disconnect_cameras", "check_night", "stay_timeline", "pin_clip"];
const KEY = randomBytes(32).toString("base64");
const TZ = "America/New_York";
const ADMIN_PASSWORD = "made-up-admin-password-239";

let open: MultiTenantApp | undefined;
/** The running test's clock, so the fake provider signs its redirects at the service's time. */
let current: { now: Date } | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
  setCameraProviderForTests(undefined);
  resetVisitLogCache();
  resetHostAlertClock();
});

/** The service's tick: the camera clock counts, and since #250 the host-alert clock tells camera notes. */
async function tickBoth(m: MultiTenantApp) {
  await tickAllCameras(m.hosted());
  await tickAllHostAlerts(m.hosted());
}

/** Ring's made-up credentials and the token key are always on the service here: the account's switch is what decides. */
async function account(features: Feature[], clock: { now: Date }) {
  current = clock;
  open = await multiTenantApp({ env: { SUPPLY_CORE: "1", CAMERA_TOKEN_KEY: KEY, CLEANER_CORE_ADMIN_PASSWORD: ADMIN_PASSWORD, ...credentialsFor(["cameras"]) }, now: () => clock.now });
  const m = open;
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
  switchOn(m.registry, tenant.id, ...features);
  const property = m.registry.addProperty(tenant.id, "12 Scratch Lane");
  m.registry.setFlow(tenant.id, property.id, "supplies", true);
  const root = propertyFolder(m.app.root, tenant.id, property);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "hub.json"), JSON.stringify({ schemaVersion: 1, property: { nickname: "Scratch Lane", timeZone: TZ, checkInTime: "16:00", checkoutTime: "11:00" }, calendars: [], stays: [{ checkIn: "2026-11-20", checkout: "2026-11-23", kind: "stay" }] }));
  writeFileSync(join(root, "supply.json"), JSON.stringify({ items: [], orders: [] }));
  const token = await m.joinAt(tenant.id, "grok", PATH);
  return { m, tenant, property, token, root };
}

function withFake() {
  const provider: FakeCameraProvider = fakeCameraProvider({ name: "ring", now: () => current?.now ?? new Date() });
  provider.cameras = [
    { id: "dev-aaa", name: "Front door" },
    { id: "dev-bbb", name: "Driveway" },
  ];
  const counter = fakeCounter(() => ({ people: 8, vehicles: 1, animals: 0 }));
  setCameraProviderForTests(provider, counter);
  return { provider, counter };
}

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const cookieOf = (headers: Record<string, unknown>) => String((headers["set-cookie"] as string[] | undefined)?.[0] ?? "").split(";")[0]!;

/** The host's half before Ring: the one-time link, the consent page and their yes. Gives the browser's cookie and the pairing word. */
async function agree(m: MultiTenantApp, token: string, propertyId: string) {
  const reply = await m.toolAt(PATH, token, "connect_cameras", { property: propertyId });
  expect(reply.isError).toBe(false);
  const link = new URL(String(reply.structured?.link));
  const page = await m.app.http(link.pathname);
  expect(page.status).toBe(200);
  expect(page.headers["set-cookie"]).toBeUndefined();
  const consent = await page.text();
  expect(consent).toContain("never sees your password");
  expect(consent).toContain("Property Core's own server counts the people, vehicles and pets in it, then deletes it. The image is never sent to anyone else");
  expect(consent).not.toMatch(/Google|Gemini/);
  const agreed = await m.app.http(link.pathname, { method: "POST", headers: FORM, body: "agree=yes" });
  expect(agreed.status).toBe(200);
  const next = await agreed.text();
  expect(next).toContain("Now connect Property Core in Ring");
  const word = /class="word">([A-Z]{4}-[A-Z]{4})</.exec(next)?.[1] ?? "";
  expect(word).not.toBe("");
  const setCookie = String((agreed.headers["set-cookie"] as string[])[0]);
  expect(setCookie).toMatch(/^pc_ring=[A-Za-z0-9_-]{32,}; Path=\/cameras\/ring; Max-Age=1800; HttpOnly; Secure; SameSite=Lax$/);
  return { linkPath: link.pathname, cookie: cookieOf(agreed.headers), word };
}

/** Ring's half: its server posts the code to the Token Exchange address. */
const ringPosts = (m: MultiTenantApp, fields: Record<string, string> = { code: "good-code", client_id: FAKE_CLIENT_ID }) =>
  m.app.http("/cameras/ring/token", { method: "POST", headers: FORM, body: new URLSearchParams(fields).toString() });

/** The whole link in one browser: agree, Ring's code, Ring's redirect, Connect. */
async function connect(m: MultiTenantApp, token: string, propertyId: string, provider: FakeCameraProvider) {
  const { linkPath, cookie, word } = await agree(m, token, propertyId);
  expect((await ringPosts(m)).status).toBe(200);
  const { nonce, time } = provider.redirect();
  const back = await m.app.http(`/cameras/ring/link?nonce=${nonce}&time=${time}`, { headers: { cookie } });
  expect(back.status).toBe(200);
  const confirm = await back.text();
  expect(confirm).toContain("j***t@example.com");
  expect(confirm).toContain("12 Scratch Lane");
  expect(confirm).not.toContain('name="word"');
  const done = await m.app.http("/cameras/ring/link", { method: "POST", headers: { ...FORM, cookie }, body: new URLSearchParams({ nonce, time }).toString() });
  expect(done.status).toBe(200);
  expect(await done.text()).toContain("Ring is connected");
  return { linkPath, cookie, word, nonce, time };
}

describe("cameras on the shared service", () => {
  it("isn't listed or answered without the account's cameras switch, and Ring's webhook is not found", SLOW, async () => {
    withFake();
    const { m, token, property } = await account([], { now: new Date("2026-11-21T15:00:00.000Z") });
    expect((await m.toolNames(PATH, token)).filter((name) => TOOLS.includes(name))).toEqual([]);
    expect((await m.toolAt(PATH, token, "list_cameras", { property: property.id })).isError).toBe(true);
    expect((await m.app.http("/webhooks/ring", { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("connects on Ring's own page, seals the tokens, picks only outdoor cameras, and stores signed events in the shared log", SLOW, async () => {
    const { provider } = withFake();
    const clock = { now: new Date("2026-11-21T15:00:00.000Z") };
    const { m, tenant, token, property, root } = await account(["cameras"], clock);
    expect((await m.toolNames(PATH, token)).filter((name) => TOOLS.includes(name)).sort()).toEqual([...TOOLS].sort());

    const { linkPath, cookie, nonce, time } = await connect(m, token, property.id, provider);
    expect(provider.calls.map((call) => call.call).filter((call) => /exchangeCode|profile|confirmLink/.test(call))).toEqual(["exchangeCode", "profile", "confirmLink"]);
    const secrets = readFileSync(join(tenantFolder(m.app.root, tenant.id), "secrets.json"), "utf8");
    expect(secrets).not.toContain("fake-access");
    expect(secrets).not.toContain("fake-refresh");
    expect(JSON.parse(readFileSync(join(root, "cameras.json"), "utf8"))).toMatchObject({ provider: "ring", consentAt: clock.now.toISOString(), connectedAt: clock.now.toISOString() });
    // The one-time link, the waiting tokens and the browser's mark are all used up.
    expect((await m.app.http(linkPath)).status).toBe(404);
    expect((await m.app.http(`/cameras/ring/link?nonce=${nonce}&time=${time}`, { headers: { cookie } })).status).toBe(400);
    expect((await m.app.http("/cameras/ring/link", { method: "POST", headers: { ...FORM, cookie }, body: new URLSearchParams({ nonce, time }).toString() })).status).toBe(400);
    expect(m.app.logs.join("\n")).not.toMatch(/fake-access|fake-refresh|good-code/);

    const listed = await m.toolAt(PATH, token, "list_cameras", { property: property.id });
    // Every camera says whether it's online, picked or not (#302), from the one list call.
    expect(listed.structured).toMatchObject({ connected: true, cameras: [{ deviceId: "dev-aaa", name: "Front door", usedHere: false, status: "online" }, { deviceId: "dev-bbb", status: "online" }] });
    expect(provider.calls.filter((call) => call.call === "status")).toHaveLength(0);
    expect((await m.toolAt(PATH, token, "pick_cameras", { property: property.id, cameras: [{ deviceId: "dev-aaa", outdoor: false }] })).isError).toBe(true);
    expect((await m.toolAt(PATH, token, "pick_cameras", { property: property.id, cameras: [{ deviceId: "dev-aaa", outdoor: true }] })).isError).toBe(false);

    const delivery = provider.webhook({ id: "req-1", at: "2026-11-21T02:14:00.000Z", deviceId: "dev-aaa", kind: "motion", label: "human" });
    expect((await m.app.http("/webhooks/ring", { method: "POST", headers: delivery.headers, body: delivery.body.toString() })).status).toBe(200);
    expect((await m.app.http("/webhooks/ring", { method: "POST", body: delivery.body.toString() })).status).toBe(401);
    const other = provider.webhook({ id: "req-2", at: "2026-11-21T02:15:00.000Z", deviceId: "dev-bbb", kind: "motion", label: "human" });
    expect((await m.app.http("/webhooks/ring", { method: "POST", headers: other.headers, body: other.body.toString() })).status).toBe(200);
    const log = readFileSync(join(root, "visit-events", "2026-11.jsonl"), "utf8");
    expect(log).toContain('"id":"req-1"');
    expect(log).not.toContain("req-2");
    expect(log).not.toMatch(/fake-access|https?:/);
  });

  it("counts the night's events, flags the night, lays out the stay and pins one clip", SLOW, async () => {
    const { provider, counter } = withFake();
    const clock = { now: new Date("2026-11-21T15:00:00.000Z") };
    const { m, token, property, root } = await account(["cameras"], clock);
    writeStayCheck(root, { rules: [{ text: "No more than 6 guests", check: { kind: "people", max: 6 } }], sightings: {}, allowances: [] });
    await connect(m, token, property.id, provider);
    await m.toolAt(PATH, token, "pick_cameras", { property: property.id, cameras: [{ deviceId: "dev-aaa", outdoor: true }] });
    const delivery = provider.webhook({ id: "req-9", at: "2026-11-21T02:14:00.000Z", deviceId: "dev-aaa", kind: "motion", label: "human" });
    await m.app.http("/webhooks/ring", { method: "POST", headers: delivery.headers, body: delivery.body.toString() });
    await tickAllCameras(m.hosted());
    expect(counter.seen).toBe(1);

    const night = await m.toolAt(PATH, token, "check_night", { property: property.id, date: "2026-11-20" });
    expect(night.structured).toMatchObject({ status: "flags", flags: [{ kind: "people", peak: 8, allowed: 6 }] });
    expect(String(night.structured?.alert)).toContain("8 people");

    const timeline = await m.toolAt(PATH, token, "stay_timeline", { property: property.id, checkIn: "2026-11-20" });
    expect(String(timeline.structured?.text)).toContain("Front door camera, human: 8 people, 1 vehicle");
    const pinned = await m.toolAt(PATH, token, "pin_clip", { property: property.id, eventId: "req-9" });
    expect(pinned.isError).toBe(false);
    expect(provider.calls.filter((call) => call.call === "clip")).toHaveLength(1);
  });

  it("a camera offline for 30 minutes is one note for the host, and one when it's back; with no Cleaner Core or Fixer Core it waits for list_cameras", SLOW, async () => {
    const { provider } = withFake();
    const clock = { now: new Date("2026-11-21T19:00:00.000Z") };
    const { m, token, property } = await account(["cameras"], clock);
    await connect(m, token, property.id, provider);
    await m.toolAt(PATH, token, "pick_cameras", { property: property.id, cameras: [{ deviceId: "dev-aaa", outdoor: true }] });
    const off = provider.webhook({ id: "off-1", at: "2026-11-21T19:10:00.000Z", deviceId: "dev-aaa", kind: "offline" });
    await m.app.http("/webhooks/ring", { method: "POST", headers: off.headers, body: off.body.toString() });
    clock.now = new Date("2026-11-21T19:20:00.000Z");
    await tickBoth(m);
    expect((await m.toolAt(PATH, token, "list_cameras", { property: property.id })).structured?.notes).toBeUndefined();
    clock.now = new Date("2026-11-21T19:45:00.000Z");
    await tickBoth(m);
    await tickBoth(m);
    const listed = await m.toolAt(PATH, token, "list_cameras", { property: property.id });
    expect(listed.structured?.notes).toEqual([{ id: "camera-offline:off-1", text: "The Front door camera at 12 Scratch Lane has been offline since 2:10 PM. Check its power and Wi-Fi." }]);
    expect((await m.toolAt(PATH, token, "list_cameras", { property: property.id })).structured?.notes).toBeUndefined();
    const on = provider.webhook({ id: "on-1", at: "2026-11-21T20:30:00.000Z", deviceId: "dev-aaa", kind: "online" });
    await m.app.http("/webhooks/ring", { method: "POST", headers: on.headers, body: on.body.toString() });
    clock.now = new Date("2026-11-21T20:31:00.000Z");
    await tickBoth(m);
    await tickBoth(m);
    expect((await m.toolAt(PATH, token, "list_cameras", { property: property.id })).structured?.notes).toEqual([{ id: "camera-online:on-1", text: "The Front door camera at 12 Scratch Lane is back online." }]);
  });

  it("an account whose cameras are switched off gets no tools, no link and no events, while another account's stay on", SLOW, async () => {
    const { provider } = withFake();
    const clock = { now: new Date("2026-11-21T15:00:00.000Z") };
    const { m, tenant, token, property, root } = await account(["cameras"], clock);
    const started = await m.toolAt(PATH, token, "connect_cameras", { property: property.id });
    const linkPath = new URL(String(started.structured?.link)).pathname;
    // A second account on the same service keeps cameras on, so Ring's webhook still answers.
    const other = m.registry.create({ label: "Court", twilioNumber: "+15555550153" }).tenant;
    switchOn(m.registry, other.id, "cameras");
    m.registry.setFeature(tenant.id, "cameras", false, "admin");
    expect((await m.toolNames(PATH, token)).filter((name) => TOOLS.includes(name))).toEqual([]);
    expect((await m.toolAt(PATH, token, "list_cameras", { property: property.id })).isError).toBe(true);
    expect((await m.app.http(linkPath)).status).toBe(404);
    const delivery = provider.webhook({ id: "req-off", at: "2026-11-21T02:14:00.000Z", deviceId: "dev-aaa", kind: "motion", label: "human" });
    expect((await m.app.http("/webhooks/ring", { method: "POST", headers: delivery.headers, body: delivery.body.toString() })).status).toBe(200);
    let log = "";
    try {
      log = readFileSync(join(root, "visit-events", "2026-11.jsonl"), "utf8");
    } catch {
      log = "";
    }
    expect(log).not.toContain("req-off");
    // With no account on, the routes are not found again.
    m.registry.setFeature(other.id, "cameras", false, "admin");
    expect((await m.app.http("/webhooks/ring", { method: "POST", headers: delivery.headers, body: delivery.body.toString() })).status).toBe(404);
  });
});

describe("Ring account linking on the shared service (#302)", () => {
  const start = async () => {
    const { provider } = withFake();
    const clock = { now: new Date("2026-11-21T15:00:00.000Z") };
    return { provider, clock, ...(await account(["cameras"], clock)) };
  };
  const linked = async (m: MultiTenantApp, token: string, propertyId: string) => (await m.toolAt(PATH, token, "list_cameras", { property: propertyId })).structured?.connected;
  const post = (m: MultiTenantApp, fields: Record<string, string>, cookie?: string) =>
    m.app.http("/cameras/ring/link", { method: "POST", headers: { ...FORM, ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString() });

  it("links by pairing word when Ring opens a browser that never saw the consent page", SLOW, async () => {
    const { m, token, property, provider } = await start();
    const { word } = await agree(m, token, property.id);
    expect((await ringPosts(m)).status).toBe(200);
    const { nonce, time } = provider.redirect();
    const back = await m.app.http(`/cameras/ring/link?nonce=${nonce}&time=${time}`);
    expect(back.status).toBe(200);
    const asked = await back.text();
    expect(asked).toContain('name="word"');
    expect(asked).toContain("j***t@example.com");
    expect(asked).not.toContain("12 Scratch Lane");
    expect(asked).not.toMatch(/jane\.host|fake-access|fake-refresh/);
    // Connect with no word saves nothing.
    expect((await post(m, { nonce, time })).status).toBe(400);
    expect(await linked(m, token, property.id)).toBe(false);
    const done = await post(m, { nonce, time, word: word.toLowerCase() });
    expect(done.status).toBe(200);
    expect(await linked(m, token, property.id)).toBe(true);
  });

  it("drops the waiting tokens after five wrong pairing words", SLOW, async () => {
    const { m, token, property, provider } = await start();
    const { word } = await agree(m, token, property.id);
    await ringPosts(m);
    const { nonce, time } = provider.redirect();
    for (let i = 0; i < 4; i += 1) {
      const wrong = await post(m, { nonce, time, word: "BCDF-GHJK" });
      expect(wrong.status).toBe(400);
      expect(await wrong.text()).toContain("didn't match");
    }
    expect(await (await post(m, { nonce, time, word: "BCDF-GHJK" })).text()).toContain("Ring wasn't connected");
    expect((await post(m, { nonce, time, word })).status).toBe(400);
    expect(await linked(m, token, property.id)).toBe(false);
    expect(provider.calls.some((call) => call.call === "confirmLink")).toBe(false);
  });

  it("refuses a stale or future time, a nonce for no waiting tokens, and a nonce for another Ring account", SLOW, async () => {
    const { m, token, property, provider, clock } = await start();
    const { cookie } = await agree(m, token, property.id);
    // Before Ring has posted any code, nothing waits.
    const early = provider.redirect();
    expect((await m.app.http(`/cameras/ring/link?nonce=${early.nonce}&time=${early.time}`, { headers: { cookie } })).status).toBe(400);
    await ringPosts(m);
    const other = provider.redirect("ava1.ring.account.SOMEONE-ELSE");
    expect((await post(m, other, cookie)).status).toBe(400);
    const good = provider.redirect();
    expect((await post(m, { nonce: good.nonce, time: String(Number(good.time) + 1) }, cookie)).status).toBe(400);
    expect((await m.app.http("/cameras/ring/link", { headers: { cookie } })).status).toBe(400);
    const ahead = String(clock.now.getTime() + 31_000);
    expect((await post(m, { nonce: provider.linkNonce(ahead, provider.owner.accountId), time: ahead }, cookie)).status).toBe(400);
    // The redirect is good for 10 minutes: at 10 minutes and a second, the same nonce is refused.
    clock.now = new Date(clock.now.getTime() + 601_000);
    expect((await post(m, good, cookie)).status).toBe(400);
    expect(await linked(m, token, property.id)).toBe(false);
    expect(provider.calls.some((call) => call.call === "confirmLink")).toBe(false);
  });

  it("the Token Exchange address does nothing for another client id, a missing code or JSON, and fails the link when Ring refuses the code", SLOW, async () => {
    const { m, provider } = await start();
    expect((await ringPosts(m, { code: "good-code", client_id: "someone-else" })).status).toBe(400);
    expect((await ringPosts(m, { client_id: FAKE_CLIENT_ID })).status).toBe(400);
    expect((await m.app.http("/cameras/ring/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "good-code", client_id: FAKE_CLIENT_ID }) })).status).toBe(400);
    expect(provider.calls).toEqual([]);
    expect((await m.app.http("/cameras/ring/token")).status).toBe(405);
    const refused = await ringPosts(m, { code: "used-code", client_id: FAKE_CLIENT_ID });
    expect(refused.status).toBe(502);
    expect(await refused.text()).not.toContain("used-code");
    expect(m.app.logs.join("\n")).not.toContain("used-code");
    // Nothing waits after any of these.
    const { nonce, time } = provider.redirect();
    expect((await m.app.http(`/cameras/ring/link?nonce=${nonce}&time=${time}`)).status).toBe(400);
  });

  it("saves nothing when Ring refuses the nonce, and the host starts again", SLOW, async () => {
    const { m, token, property, provider } = await start();
    const { cookie } = await agree(m, token, property.id);
    await ringPosts(m);
    provider.refuseNonce = true;
    const refused = await post(m, provider.redirect(), cookie);
    expect(refused.status).toBe(502);
    expect(await refused.text()).toContain("Ask your assistant to connect Ring again");
    expect(await linked(m, token, property.id)).toBe(false);
    provider.refuseNonce = false;
    expect((await post(m, provider.redirect(), cookie)).status).toBe(400);
    // A fresh code from Ring and the same agreed link finish it.
    await ringPosts(m);
    expect((await post(m, provider.redirect(), cookie)).status).toBe(200);
    expect(await linked(m, token, property.id)).toBe(true);
  });

  it("a browser's mark never links another account's property, and a mark from a switched-off account asks for the word", SLOW, async () => {
    const { m, tenant, token, property, provider } = await start();
    const { cookie } = await agree(m, token, property.id);
    const other = m.registry.create({ label: "Court", twilioNumber: "+15555550153" }).tenant;
    switchOn(m.registry, other.id, "cameras");
    m.registry.setFeature(tenant.id, "cameras", false, "admin");
    await ringPosts(m);
    const { nonce, time } = provider.redirect();
    const back = await m.app.http(`/cameras/ring/link?nonce=${nonce}&time=${time}`, { headers: { cookie } });
    expect(await back.text()).toContain('name="word"');
    expect((await post(m, { nonce, time }, cookie)).status).toBe(400);
    expect(provider.calls.some((call) => call.call === "confirmLink")).toBe(false);
  });

  it("has a homepage, and every Ring address is not found without Ring's secrets or the sealing key", SLOW, async () => {
    const { m } = await start();
    const home = await m.app.http("/cameras/ring");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("managed from your assistant's chat");
    open?.close();
    closeHostedApps();
    setCameraProviderForTests(undefined);
    for (const env of [{ CAMERA_TOKEN_KEY: KEY }, credentialsFor(["cameras"])]) {
      open = await multiTenantApp({ env: { SUPPLY_CORE: "1", ...env } });
      const { tenant } = open.registry.create({ label: "Lane", twilioNumber: LANE });
      switchOn(open.registry, tenant.id, "cameras");
      expect((await open.app.http("/cameras/ring/token", { method: "POST", headers: FORM, body: "code=c&client_id=test-ring-id" })).status).toBe(404);
      expect((await open.app.http("/cameras/ring/link?nonce=n&time=1")).status).toBe(404);
      open.close();
      closeHostedApps();
    }
    open = undefined;
  });
  it("lists an offline camera as offline, picked or not, and says unknown when Ring can't say (#302)", SLOW, async () => {
    const { provider } = withFake();
    const clock = { now: new Date("2026-11-21T15:00:00.000Z") };
    const { m, token, property } = await account(["cameras"], clock);
    await connect(m, token, property.id, provider);
    provider.offline.add("dev-bbb");
    const listed = await m.toolAt(PATH, token, "list_cameras", { property: property.id });
    expect(listed.structured?.cameras).toEqual([
      { deviceId: "dev-aaa", name: "Front door", usedHere: false, status: "online" },
      { deviceId: "dev-bbb", name: "Driveway", usedHere: false, status: "offline" },
    ]);
    // A list without the state falls back to asking each camera, and a failure there is unknown, never online.
    const devices = provider.devices.bind(provider);
    provider.devices = async (ref) => (await devices(ref)).map(({ id, name }) => ({ id, name }));
    provider.status = async () => {
      throw new Error("Ring didn't say");
    };
    const unsure = await m.toolAt(PATH, token, "list_cameras", { property: property.id });
    expect((unsure.structured?.cameras as { status: string }[]).map((camera) => camera.status)).toEqual(["unknown", "unknown"]);
  });

  it("the counting week counts every motion event on the picked cameras for 7 days, with no stay, only after the host agreed", SLOW, async () => {
    const { provider, counter } = withFake();
    const clock = { now: new Date("2026-11-25T20:00:00.000Z") };
    const { m, tenant, token, property, root } = await account(["cameras"], clock);
    // No house rule and no stay this week: before the counting week, nothing is counted.
    await connect(m, token, property.id, provider);
    const week = (args: Record<string, unknown>) => m.toolAt(PATH, token, "counting_week", { property: property.id, ...args });
    expect((await week({ action: "start", hostAgreed: true })).text).toContain("No camera is picked");
    await m.toolAt(PATH, token, "pick_cameras", { property: property.id, cameras: [{ deviceId: "dev-aaa", outdoor: true }] });
    const send = async (id: string, at: string) => {
      const delivery = provider.webhook({ id, at, deviceId: "dev-aaa", kind: "motion", label: "human" });
      expect((await m.app.http("/webhooks/ring", { method: "POST", headers: delivery.headers, body: delivery.body.toString() })).status).toBe(200);
    };
    await send("before", "2026-11-25T19:30:00.000Z");
    await tickAllCameras(m.hosted());
    expect(counter.seen).toBe(0);

    expect((await week({ action: "start" })).isError).toBe(true);
    expect(counter.seen).toBe(0);
    const started = await week({ action: "start", hostAgreed: true });
    expect(started.structured).toMatchObject({ running: true, from: "2026-11-25T20:00:00.000Z", until: "2026-12-02T20:00:00.000Z", cameras: [{ deviceId: "dev-aaa", name: "Front door" }] });
    expect(String(started.structured?.next)).toContain("Wednesday, Dec 2 at 3:00 PM");
    expect((await week({ action: "start", hostAgreed: true })).structured).toMatchObject({ running: true, until: "2026-12-02T20:00:00.000Z" });
    expect((await m.toolAt(PATH, token, "list_cameras", { property: property.id })).structured).toMatchObject({ countingWeek: { from: "2026-11-25T20:00:00.000Z", until: "2026-12-02T20:00:00.000Z" } });

    // An event the night after, at 3 AM local, with no guest staying: counted. The one from before the week isn't.
    clock.now = new Date("2026-11-26T09:00:00.000Z");
    await send("night-1", "2026-11-26T08:00:00.000Z");
    await tickAllCameras(m.hosted());
    expect(counter.seen).toBe(1);
    const log = readFileSync(join(root, "visit-events", "2026-11.jsonl"), "utf8");
    expect(log).toContain('"event":"night-1"');
    expect(log).not.toContain('"event":"before"');

    // The review sheet: the admin downloads it, one row per counted event, and it carries no image or link.
    const login = await m.app.http("/admin/login", { method: "POST", headers: FORM, body: new URLSearchParams({ password: ADMIN_PASSWORD }).toString() });
    expect(login.status).toBe(303);
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const page = await (await m.app.http(`/admin/tenants/${tenant.id}`, { headers: { cookie } })).text();
    expect(page).toContain("Counting week");
    expect(page).toContain(`/admin/tenants/${tenant.id}/count-sheet?property=${property.id}`);
    expect((await m.app.http(`/admin/tenants/${tenant.id}/count-sheet?property=${property.id}`)).status).toBe(303);
    const sheet = await m.app.http(`/admin/tenants/${tenant.id}/count-sheet?property=${property.id}`, { headers: { cookie } });
    expect(sheet.status).toBe(200);
    expect(String(sheet.headers["content-type"])).toContain("text/csv");
    expect(String(sheet.headers["content-disposition"])).toContain("counting-sheet-");
    const csv = await sheet.text();
    expect(csv.split("\n")[0]).toBe("event_id,local_date,local_time,camera,label,period,our_people,our_vehicles,our_animals,host_people,host_vehicles,host_animals,note");
    expect(csv).toContain("night-1,2026-11-26,03:00,Front door,human,night,8,1,0,,,,");
    expect(csv).not.toMatch(/https?:|before/);
    expect((await m.app.http(`/admin/tenants/${tenant.id}/count-sheet?property=nope`, { headers: { cookie } })).status).toBe(400);

    // Stopped early: an event after that waits for a stay again.
    clock.now = new Date("2026-11-27T12:00:00.000Z");
    expect((await week({ action: "stop" })).structured).toMatchObject({ running: false, stopped: true });
    await send("after-stop", "2026-11-27T13:00:00.000Z");
    clock.now = new Date("2026-11-27T13:30:00.000Z");
    await tickAllCameras(m.hosted());
    expect(counter.seen).toBe(1);
    expect((await m.toolAt(PATH, token, "list_cameras", { property: property.id })).structured?.countingWeek).toBeUndefined();
  });
});
