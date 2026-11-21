import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { propertyFolder } from "../src/cleaner-core/hosted/properties";
import { tenantFolder } from "../src/cleaner-core/hosted/registry";
import { fakeCounter } from "../src/cameras/counter";
import { fakeCameraProvider, type FakeCameraProvider } from "../src/cameras/fake";
import { setCameraProviderForTests, tickAllCameras } from "../src/hosted/cameras";
import { resetHostAlertClock, tickAllHostAlerts } from "../src/hosted/hostAlerts";
import { resetVisitLogCache } from "../src/visits/store";
import { writeStayCheck } from "../src/stay-check/store";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/** #239 on the shared service, behind CAMERAS=1: connecting, picking, webhooks, the night's check, notes. Fake provider only; nothing reaches Ring. */

const LANE = "+15555550152";
const PATH = "/mcp";
const SLOW = { timeout: 90_000 };
const TOOLS = ["connect_cameras", "list_cameras", "pick_cameras", "disconnect_cameras", "check_night", "stay_timeline", "pin_clip"];
const KEY = randomBytes(32).toString("base64");
const TZ = "America/New_York";

let open: MultiTenantApp | undefined;
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

async function account(env: NodeJS.ProcessEnv, clock: { now: Date }) {
  open = await multiTenantApp({ env: { SUPPLY_CORE: "1", ...env }, now: () => clock.now });
  const m = open;
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
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
  const provider: FakeCameraProvider = fakeCameraProvider({ name: "ring" });
  provider.cameras = [
    { id: "dev-aaa", name: "Front door" },
    { id: "dev-bbb", name: "Driveway" },
  ];
  const counter = fakeCounter(() => ({ people: 8, vehicles: 1, animals: 0 }));
  setCameraProviderForTests(provider, counter);
  return { provider, counter };
}

async function connect(m: MultiTenantApp, token: string, propertyId: string) {
  const reply = await m.toolAt(PATH, token, "connect_cameras", { property: propertyId });
  expect(reply.isError).toBe(false);
  const link = new URL(String(reply.structured?.link));
  const page = await m.app.http(link.pathname);
  expect(page.status).toBe(200);
  const consent = await page.text();
  expect(consent).toContain("never sees your password");
  expect(consent).toContain("Property Core's own server counts the people, vehicles and pets in it, then deletes it. The image is never sent to anyone else");
  expect(consent).not.toMatch(/Google|Gemini/);
  const agreed = await m.app.http(link.pathname, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "agree=yes" });
  expect(agreed.status).toBe(302);
  const ring = new URL(String(agreed.headers.location));
  const state = String(ring.searchParams.get("state"));
  const back = await m.app.http(`/cameras/ring/linked?code=good-code&state=${encodeURIComponent(state)}`);
  expect(back.status).toBe(200);
  return { linkPath: link.pathname, state };
}

describe("cameras on the shared service", () => {
  it("isn't listed or answered without CAMERAS, and Ring's webhook is not found", SLOW, async () => {
    withFake();
    const { m, token, property } = await account({ CAMERA_TOKEN_KEY: KEY }, { now: new Date("2026-11-21T15:00:00.000Z") });
    expect((await m.toolNames(PATH, token)).filter((name) => TOOLS.includes(name))).toEqual([]);
    expect((await m.toolAt(PATH, token, "list_cameras", { property: property.id })).isError).toBe(true);
    expect((await m.app.http("/webhooks/ring", { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("connects on Ring's own page, seals the tokens, picks only outdoor cameras, and stores signed events in the shared log", SLOW, async () => {
    const { provider } = withFake();
    const clock = { now: new Date("2026-11-21T15:00:00.000Z") };
    const { m, tenant, token, property, root } = await account({ CAMERAS: "1", CAMERA_TOKEN_KEY: KEY }, clock);
    expect((await m.toolNames(PATH, token)).filter((name) => TOOLS.includes(name)).sort()).toEqual([...TOOLS].sort());

    const { linkPath, state } = await connect(m, token, property.id);
    const secrets = readFileSync(join(tenantFolder(m.app.root, tenant.id), "secrets.json"), "utf8");
    expect(secrets).not.toContain("fake-access");
    expect(secrets).not.toContain("fake-refresh");
    // The one-time link is used up.
    expect((await m.app.http(linkPath)).status).toBe(404);
    expect((await m.app.http(`/cameras/ring/linked?code=good-code&state=${state}`)).status).toBe(400);

    const listed = await m.toolAt(PATH, token, "list_cameras", { property: property.id });
    expect(listed.structured).toMatchObject({ connected: true, cameras: [{ deviceId: "dev-aaa", name: "Front door", usedHere: false }, { deviceId: "dev-bbb" }] });
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
    const { m, token, property, root } = await account({ CAMERAS: "1", CAMERA_TOKEN_KEY: KEY }, clock);
    writeStayCheck(root, { rules: [{ text: "No more than 6 guests", check: { kind: "people", max: 6 } }], sightings: {}, allowances: [] });
    await connect(m, token, property.id);
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
    const { m, token, property } = await account({ CAMERAS: "1", CAMERA_TOKEN_KEY: KEY }, clock);
    await connect(m, token, property.id);
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
});
