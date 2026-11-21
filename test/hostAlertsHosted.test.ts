import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { propertyFolder, type Property } from "../src/cleaner-core/hosted/properties";
import type { Tenant } from "../src/cleaner-core/hosted/registry";
import { writeCameras } from "../src/cameras/accounts";
import { sharedCameraLog } from "../src/cameras/sharedLog";
import type { CameraDesk } from "../src/cameras/desk";
import { resetFixerDesks } from "../src/fixer-core/desk";
import { readFixer } from "../src/fixer-core/store";
import { runHostAlerts, type HostAlert } from "../src/host-alerts/clock";
import { HOST_ALERTS_FILE, HostAlertLedger, readHostAlerts } from "../src/host-alerts/ledger";
import { NIGHT_COUNT_WAIT_MS, NIGHT_GRACE_MS, NIGHT_STALE_MS, stayNightSource } from "../src/host-alerts/sources";
import { setCameraProviderForTests } from "../src/hosted/cameras";
import { resetHostAlertClock, tickAllHostAlerts } from "../src/hosted/hostAlerts";
import { zonedInstant } from "../src/hub/calendar";
import type { NightResult } from "../src/stay-check/check";
import { resetVisitLogCache } from "../src/visits/store";
import { closeHostedApps } from "./cleanerOauthHarness";
import { credentialsFor, switchOn } from "./featureEnv";
import type { Feature } from "../src/features/features";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { order, writeOrders } from "./packageFixture";

/** #250 on the shared service: host alerts on the clock, through the account's Alerts routine. 555 numbers, made-up codes, a stubbed routine; nothing reaches Ring, Seam or a phone. */

const LANE = "+15555550170";
const JOE = "+15555550171";
const PATH = "/mcp";
const SLOW = { timeout: 90_000 };
const NY = "America/New_York";
const KEY = randomBytes(32).toString("base64");
const PLACE = { address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: NY };
const JOES = { name: "Joe's Plumbing", trades: ["plumbing"], reach: { phone: JOE }, preferredFor: [{ trade: "plumbing", rank: 1 }] };
const HOOK = { url: "https://example.com/alerts-hook", token: "made-up-key-250" };
/** The four features the host-alert clock reads, switched on for the account. */
const ALL_FEATURES: Feature[] = ["packages", "oversight", "cameras", "stay-check"];

let open: MultiTenantApp | undefined;
const clock = { now: new Date("2026-11-21T15:00:00.000Z") };
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
  resetFixerDesks();
  resetHostAlertClock();
  setCameraProviderForTests(undefined);
  resetVisitLogCache();
  clock.now = new Date("2026-11-21T15:00:00.000Z");
});

/** Ring's made-up credentials and the token key are always on the service here: the account's switches decide. */
async function account(features: Feature[]) {
  open = await multiTenantApp({ env: { SUPPLY_CORE: "1", CAMERA_TOKEN_KEY: KEY, ...credentialsFor(["cameras"]) }, now: () => clock.now });
  const m = open;
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
  switchOn(m.registry, tenant.id, ...features);
  const property = m.registry.addProperty(tenant.id, "12 Scratch Lane");
  m.registry.setFlow(tenant.id, property.id, "supplies", true);
  const root = propertyFolder(m.app.root, tenant.id, property);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "hub.json"), JSON.stringify({ schemaVersion: 1, property: { nickname: "Scratch Lane", address: PLACE.address, timeZone: NY }, calendars: [], stays: [] }));
  const token = await m.joinAt(tenant.id, "grok", PATH);
  return { m, tenant, property, token, root };
}

/** Turns Fixer Core on and activates it with Joe saved, through the tools, then connects the Alerts routine. */
async function activeFixer(m: MultiTenantApp, token: string, property: Property) {
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await m.toolAt(PATH, token, name, { property: property.id, ...args });
    expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
    return reply;
  };
  await call("set_flows", { fixer: true });
  await call("save_fixer_property", PLACE);
  await call("save_fixer_sources", { done: true });
  await call("save_pro", JOES);
  await call("save_fixer_settings", { prosDone: true });
  await call("save_fixer_settings", { upkeepDone: true });
  await call("activate_fixer");
  const link = await call("save_repair_alerts");
  const posted = await m.app.http(new URL(String(link.structured!.uploadUrl)).pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(HOOK) });
  expect(posted.status).toBe(200);
  return call;
}

function pickFrontDoor(root: string) {
  writeCameras(root, { cameras: [{ deviceId: "dev-aaa", name: "Front door", outdoor: true, pickedAt: "2026-11-20T12:00:00.000Z" }] });
}

const fileNews = (m: MultiTenantApp, tenant: Tenant, property: Property) => readFixer(propertyFolder(m.app.root, tenant.id, property)).news ?? [];

describe("host alerts on the shared service", () => {
  it("with the account's four switches off, nothing runs, nothing is kept, and check_packages is unchanged", SLOW, async () => {
    const { m, token, property, root } = await account([]);
    writeOrders(root, [order("ord_1", { expectedBy: "2026-11-21" })]);
    pickFrontDoor(root);
    sharedCameraLog(root, () => clock.now).append({ type: "camera", id: "off-1", at: "2026-11-21T19:00:00.000Z", kind: "offline", deviceId: "dev-aaa", provider: "ring", device: "Front door" });
    await activeFixer(m, token, property);
    clock.now = new Date(zonedInstant("2026-11-21", "21:05", NY));
    await tickAllHostAlerts(m.hosted());
    expect(existsSync(join(root, HOST_ALERTS_FILE))).toBe(false);
  });

  it("a Fixer Core property: a package not seen and a camera offline go to check_fixes once, wake the Alerts routine, and text nobody", SLOW, async () => {
    const { m, tenant, token, property, root } = await account(ALL_FEATURES);
    const call = await activeFixer(m, token, property);
    writeOrders(root, [order("ord_1", { expectedBy: "2026-11-21" })]);
    pickFrontDoor(root);
    sharedCameraLog(root, () => clock.now).append({ type: "camera", id: "off-1", at: zonedInstant("2026-11-21", "20:10", NY), kind: "offline", deviceId: "dev-aaa", provider: "ring", device: "Front door" });
    const textsBefore = m.sms.sent.length;
    const wakesBefore = m.wakes.filter((w) => w.url === HOOK.url && JSON.parse(w.body).eventType === "repairs.update").length;

    clock.now = new Date(zonedInstant("2026-11-21", "20:55", NY));
    await tickAllHostAlerts(m.hosted());
    // The camera note is due (offline 45 minutes); the package isn't yet (9 PM).
    expect(fileNews(m, tenant, property).map((n) => n.noteId)).toEqual(["camera-offline:off-1"]);
    expect((await call("check_packages")).structured).toMatchObject({ notSeen: [], expected: [{ orderId: "ord_1" }] });

    clock.now = new Date(zonedInstant("2026-11-21", "21:05", NY));
    // Listing first never uses the alert up: it's pending, not told.
    const listed = await call("check_packages");
    expect(listed.structured).toMatchObject({ notSeen: [], notSeenPending: [{ orderId: "ord_1" }] });
    resetHostAlertClock();
    await tickAllHostAlerts(m.hosted());
    // A restart and a second run send nothing twice.
    resetHostAlertClock();
    await tickAllHostAlerts(m.hosted());
    await tickAllHostAlerts(m.hosted());
    const news = fileNews(m, tenant, property);
    expect(news.map((n) => n.noteId)).toEqual(["camera-offline:off-1", "packages:supply:ord_1:not-seen"]);
    expect(news[1]!.text).toBe("A package from Example Mart (Paper towels x2) was expected at 12 Scratch Lane today, and nothing confirmed it arrived by 9 PM. Check its tracking.");
    expect(readHostAlerts(root).alerts.map((a) => [a.id, a.via])).toEqual([
      ["camera-offline:off-1", "fixer"],
      ["packages:supply:ord_1:not-seen", "fixer"],
    ]);
    expect((await call("check_packages")).structured).toMatchObject({ notSeen: [], waiting: [{ orderId: "ord_1" }] });
    // Not left for list_cameras as well.
    expect((await call("list_cameras")).structured?.notes).toBeUndefined();
    // check_fixes passes each on once.
    const fixes = await call("check_fixes");
    expect(JSON.stringify(fixes.structured)).toContain("nothing confirmed it arrived by 9 PM");
    expect(JSON.stringify((await call("check_fixes")).structured)).not.toContain("nothing confirmed it arrived by 9 PM");
    await vi.waitFor(() => expect(m.wakes.filter((w) => w.url === HOOK.url && JSON.parse(w.body).eventType === "repairs.update").length).toBeGreaterThan(wakesBefore));
    for (const wake of m.wakes) expect(wake.body).not.toMatch(/package|camera|Example Mart/i);
    expect(m.sms.sent.length).toBe(textsBefore);
  });

  it("tries Cleaner Core first; a Cleaner Core not yet active never swallows an alert, so Fixer Core carries it", SLOW, async () => {
    const { m, tenant, token, property, root } = await account(ALL_FEATURES);
    await activeFixer(m, token, property);
    m.registry.setFlow(tenant.id, property.id, "cleaning", true);
    pickFrontDoor(root);
    sharedCameraLog(root, () => clock.now).append({ type: "camera", id: "off-2", at: zonedInstant("2026-11-21", "12:00", NY), kind: "offline", deviceId: "dev-aaa", provider: "ring", device: "Front door" });
    clock.now = new Date(zonedInstant("2026-11-21", "12:31", NY));
    await tickAllHostAlerts(m.hosted());
    expect(readHostAlerts(root).alerts.map((a) => [a.id, a.via])).toEqual([["camera-offline:off-2", "fixer"]]);
    expect(fileNews(m, tenant, property).map((n) => n.noteId)).toEqual(["camera-offline:off-2"]);
  });

  it("without connected locks, the same-day check can't tell and sends nothing", SLOW, async () => {
    const { m, tenant, token, property, root } = await account(ALL_FEATURES);
    const call = await activeFixer(m, token, property);
    // Without connected locks the check can't tell, so it never alerts: the host isn't told a guess.
    const added = await call("add_expected_visit", { who: "Mike Doyle", date: "2026-11-21", from: "13:00", to: "17:00", note: "walk-through" });
    expect(added.structured).toMatchObject({ saved: true });
    clock.now = new Date(zonedInstant("2026-11-21", "18:20", NY));
    await tickAllHostAlerts(m.hosted());
    expect(fileNews(m, tenant, property).filter((n) => n.noteId?.startsWith("oversight:"))).toEqual([]);
    expect(readHostAlerts(root).alerts).toEqual([]);
  });

  it("a Supply Core property alone has no host-note path: packages stay with check_packages, camera notes wait for list_cameras", SLOW, async () => {
    const { m, token, property, root } = await account(ALL_FEATURES);
    writeFileSync(join(root, "supply.json"), "{}");
    writeOrders(root, [order("ord_1", { expectedBy: "2026-11-21" })]);
    pickFrontDoor(root);
    sharedCameraLog(root, () => clock.now).append({ type: "camera", id: "off-9", at: zonedInstant("2026-11-21", "20:00", NY), kind: "offline", deviceId: "dev-aaa", provider: "ring", device: "Front door" });
    clock.now = new Date(zonedInstant("2026-11-21", "21:05", NY));
    await tickAllHostAlerts(m.hosted());
    const packages = await m.toolAt(PATH, token, "check_packages", { property: property.id });
    expect(packages.structured).toMatchObject({ notSeen: [{ orderId: "ord_1" }] });
    expect(packages.structured?.notSeenPending).toBeUndefined();
    const cameras = await m.toolAt(PATH, token, "list_cameras", { property: property.id });
    expect(cameras.structured?.notes).toEqual([{ id: "camera-offline:off-9", text: expect.stringContaining("has been offline since 8:00 PM") }]);
    expect(readHostAlerts(root).alerts.map((a) => a.id)).toEqual(["camera-offline:off-9"]);
    expect(readFileSync(join(root, HOST_ALERTS_FILE), "utf8")).not.toContain("ord_1");
  });
});

describe("the nightly check's timing (Saad, 21 Nov: window close plus 30 minutes, no hold)", () => {
  const CLOSE = new Date("2026-11-21T04:00:00.000Z"); // 11 PM in New York on the 20th
  const root = () => {
    const dir = join(require("node:os").tmpdir(), `night-${randomBytes(6).toString("hex")}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  /** A camera desk with one stay night (the 20th) whose window closes at CLOSE. */
  function desk(result: () => NightResult): CameraDesk & { runs: number } {
    const stub = {
      runs: 0,
      nightWindow: (night: string) => (night === "2026-11-20" ? { from: "2026-11-20T21:00:00.000Z", to: CLOSE.toISOString() } : undefined),
      runNight(_night: string) {
        stub.runs++;
        return result();
      },
    };
    return stub as unknown as CameraDesk & { runs: number };
  }

  const at = (ms: number) => new Date(CLOSE.getTime() + ms);
  const flags: NightResult = { status: "flags", flags: [], unchecked: [], alert: "Tonight at Scratch Lane: 8 people on camera at 9:14 PM, and the house rules allow 6. Clip: Front door camera, 9:14 PM." };

  async function pass(dir: string, d: CameraDesk, now: Date, handed: HostAlert[]) {
    const ledger = new HostAlertLedger(dir, () => now);
    await runHostAlerts({ sources: [stayNightSource(d, ledger, now, NY)], ledger, sinkFor: () => async (a) => (handed.push(a), "cleaning"), now });
  }

  it("waits 30 minutes after the window closes, then tells a flagged night once", async () => {
    const dir = root();
    const d = desk(() => flags);
    const handed: HostAlert[] = [];
    await pass(dir, d, at(NIGHT_GRACE_MS - 60_000), handed);
    expect(d.runs).toBe(0);
    await pass(dir, d, at(NIGHT_GRACE_MS), handed);
    await pass(dir, d, at(NIGHT_GRACE_MS + 5 * 60_000), handed);
    expect(handed).toEqual([{ id: "stay-night:2026-11-20", kind: "stay-night", text: flags.alert }]);
    expect(d.runs).toBe(1);
  });

  it("an uncounted event waits up to an hour, then the night is told with it unchecked", async () => {
    const dir = root();
    const d = desk(() => ({ ...flags, unchecked: [{ kind: "people", why: "One event isn't counted yet." }] }) as NightResult);
    const handed: HostAlert[] = [];
    await pass(dir, d, at(NIGHT_GRACE_MS), handed);
    expect(handed).toEqual([]);
    await pass(dir, d, at(NIGHT_COUNT_WAIT_MS), handed);
    expect(handed).toHaveLength(1);
  });

  it("a clean night sends nothing and is checked once", async () => {
    const dir = root();
    const d = desk(() => ({ status: "clean", unchecked: [] }));
    const handed: HostAlert[] = [];
    await pass(dir, d, at(NIGHT_GRACE_MS), handed);
    await pass(dir, d, at(NIGHT_GRACE_MS + 60_000), handed);
    expect(handed).toEqual([]);
    expect(d.runs).toBe(1);
    expect(readHostAlerts(dir).nights).toEqual(["2026-11-20"]);
  });

  it("a night closed more than 12 hours ago isn't told late", async () => {
    const dir = root();
    const d = desk(() => flags);
    const handed: HostAlert[] = [];
    await pass(dir, d, at(NIGHT_STALE_MS + 60_000), handed);
    expect(handed).toEqual([]);
    expect(d.runs).toBe(0);
  });
});
