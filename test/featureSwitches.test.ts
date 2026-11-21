import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetAdminSessions } from "../src/cleaner-core/hosted/admin";
import { FEATURE_CHANGES_KEPT, TenantRegistry } from "../src/cleaner-core/hosted/registry";
import { buildTenantEnv } from "../src/cleaner-core/hosted/tenantEnv";
import { TenantSecrets } from "../src/cleaner-core/hosted/tenantSecrets";
import { ACCOUNT_FEATURES, deskFeatureOn, FEATURES, featureOn, featureState, logFeatureSettings, type FeatureAccount } from "../src/features/features";
import { closeHostedApps } from "./cleanerOauthHarness";
import { FAKE_LOCK_CREDENTIALS, FAKE_RING_CREDENTIALS, switchOn } from "./featureEnv";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/**
 * Per-account feature switches: one rule (featureOn), off by default, changed only on /admin, and one account's
 * switch never reaches another. 555 numbers only; made-up credentials; nothing reaches a lock, Ring or a phone.
 */

const CAMERA_KEY = Buffer.alloc(32, 7).toString("base64");
const ALL_CREDENTIALS = { ...FAKE_LOCK_CREDENTIALS, ...FAKE_RING_CREDENTIALS, CAMERA_TOKEN_KEY: CAMERA_KEY };
const on = (...features: (typeof FEATURES)[number][]): FeatureAccount => ({ features: Object.fromEntries(features.map((f) => [f, { on: true, changedAt: "2026-11-21T00:00:00.000Z", changedBy: "admin" }])) });

describe("featureOn", () => {
  it("is off for every feature on an account with no switches, and with no account at all", () => {
    for (const feature of FEATURES) {
      expect(featureOn({}, feature, ALL_CREDENTIALS)).toBe(false);
      expect(featureOn(undefined, feature, ALL_CREDENTIALS)).toBe(false);
    }
  });

  it("is on only for the switches that are on, and a switch turned off is off", () => {
    const account = on("hours", "visits");
    expect(featureOn(account, "hours", {})).toBe(true);
    expect(featureOn(account, "visits", {})).toBe(true);
    expect(featureOn(account, "stay-check", {})).toBe(false);
    expect(featureOn({ features: { hours: { on: false, changedAt: "x", changedBy: "admin" } } }, "hours", {})).toBe(false);
  });

  it("needs the lock partner's key and webhook secret for locks, and Ring's secrets with a valid token key for cameras", () => {
    const account = on("locks", "cameras");
    expect(featureState(account, "locks", {})).toEqual({ on: false, why: "no-credentials" });
    expect(featureOn(account, "locks", { SEAM_API_KEY: "test-seam-key-not-real" })).toBe(false);
    expect(featureOn(account, "locks", FAKE_LOCK_CREDENTIALS)).toBe(true);
    expect(featureOn(account, "cameras", FAKE_RING_CREDENTIALS)).toBe(false);
    expect(featureOn(account, "cameras", { ...FAKE_RING_CREDENTIALS, CAMERA_TOKEN_KEY: "short" })).toBe(false);
    expect(featureOn(account, "cameras", { ...FAKE_RING_CREDENTIALS, CAMERA_TOKEN_KEY: CAMERA_KEY })).toBe(true);
    // Credentials alone turn nothing on for an account whose switch is off.
    expect(featureOn({}, "locks", ALL_CREDENTIALS)).toBe(false);
    expect(featureOn({}, "cameras", ALL_CREDENTIALS)).toBe(false);
  });

  it("turns guest codes on only with the same account's connected locks on", () => {
    expect(featureState(on("guest-codes"), "guest-codes", ALL_CREDENTIALS)).toEqual({ on: false, why: "needs-locks" });
    expect(featureOn(on("guest-codes", "locks"), "guest-codes", ALL_CREDENTIALS)).toBe(true);
    expect(featureOn(on("guest-codes", "locks"), "guest-codes", {})).toBe(false);
  });

  it("is shut off for every account by FEATURES_OFF, whatever the switch says", () => {
    const account = on(...FEATURES);
    expect(featureState(account, "cameras", { ...ALL_CREDENTIALS, FEATURES_OFF: " Cameras , locks" })).toEqual({ on: false, why: "emergency-off" });
    expect(featureOn(account, "locks", { ...ALL_CREDENTIALS, FEATURES_OFF: "cameras,locks" })).toBe(false);
    // Guest codes go with locks.
    expect(featureOn(account, "guest-codes", { ...ALL_CREDENTIALS, FEATURES_OFF: "locks" })).toBe(false);
    expect(featureOn(account, "hours", { ...ALL_CREDENTIALS, FEATURES_OFF: "cameras,locks" })).toBe(true);
    for (const feature of FEATURES) expect(featureOn(account, feature, { ...ALL_CREDENTIALS, FEATURES_OFF: "all" })).toBe(false);
  });

  it("reads a desk's account from its environment by the same rule", () => {
    const desk = { [ACCOUNT_FEATURES]: "visits,locks,guest-codes", ...FAKE_LOCK_CREDENTIALS };
    expect(deskFeatureOn(desk, "visits")).toBe(true);
    expect(deskFeatureOn(desk, "guest-codes")).toBe(true);
    expect(deskFeatureOn(desk, "hours")).toBe(false);
    expect(deskFeatureOn({ ...desk, FEATURES_OFF: "visits" }, "visits")).toBe(false);
    expect(deskFeatureOn({ [ACCOUNT_FEATURES]: "locks" }, "locks")).toBe(false);
    expect(deskFeatureOn({}, "visits")).toBe(false);
  });
});

describe("the startup log", () => {
  it("names what FEATURES_OFF shuts off, a name that isn't a feature, and a retired flag still set", () => {
    const lines: string[] = [];
    logFeatureSettings({ FEATURES_OFF: "cameras,lock", FIXER_CORE: "1", SMART_LOCKS: "0", SEAM_API_KEY: "test-seam-key-not-real" }, (line) => lines.push(line));
    expect(lines).toEqual([
      "FEATURES_OFF shuts off for every account: cameras.",
      expect.stringContaining("FEATURES_OFF names no such feature: lock."),
      "SMART_LOCKS, FIXER_CORE are no longer read: delete them on Railway. Features are switched per account on /admin.",
    ]);
    expect(lines.join(" ")).not.toContain("test-seam-key-not-real");
    const quiet: string[] = [];
    logFeatureSettings({}, (line) => quiet.push(line));
    expect(quiet).toEqual([]);
  });
});

describe("switches in the registry and the desk environment", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function registry() {
    dir = mkdtempSync(join(tmpdir(), "features-"));
    let clock = new Date("2026-11-21T15:00:00.000Z");
    const reg = new TenantRegistry(dir, () => clock);
    return { reg, root: dir, tick: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
  }

  it("starts every switch off, and records each change with who made it and when", () => {
    const { reg, tick } = registry();
    const { tenant } = reg.create({ label: "Lane", twilioNumber: "+15555550150" });
    expect(reg.get(tenant.id)!.features).toBeUndefined();
    reg.setFeature(tenant.id, "hours", true, "admin");
    tick(60_000);
    reg.setFeature(tenant.id, "hours", false, "admin");
    const saved = reg.get(tenant.id)!;
    expect(saved.features?.hours).toEqual({ on: false, changedAt: "2026-11-21T15:01:00.000Z", changedBy: "admin" });
    expect(saved.featureChanges).toEqual([
      { feature: "hours", on: true, at: "2026-11-21T15:00:00.000Z", by: "admin" },
      { feature: "hours", on: false, at: "2026-11-21T15:01:00.000Z", by: "admin" },
    ]);
    for (let i = 0; i < FEATURE_CHANGES_KEPT + 5; i++) reg.setFeature(tenant.id, "visits", i % 2 === 0, "admin");
    expect(reg.get(tenant.id)!.featureChanges).toHaveLength(FEATURE_CHANGES_KEPT);
  });

  it("changes one account's switch and no other account's", () => {
    const { reg } = registry();
    const lane = reg.create({ label: "Lane", twilioNumber: "+15555550150" }).tenant;
    const court = reg.create({ label: "Court", twilioNumber: "+15555550151" }).tenant;
    reg.setFeature(lane.id, "cameras", true, "admin");
    reg.setFeature(lane.id, "visits", true, "admin");
    expect(reg.get(court.id)!.features).toBeUndefined();
    for (const feature of FEATURES) expect(featureOn(reg.get(court.id), feature, ALL_CREDENTIALS)).toBe(false);
    expect(featureOn(reg.get(lane.id), "cameras", ALL_CREDENTIALS)).toBe(true);
  });

  it("gives each desk its own account's switches, never the process's, and no saved secret replaces the service's", () => {
    const { reg, root } = registry();
    const lane = reg.create({ label: "Lane", twilioNumber: "+15555550150" }).tenant;
    const court = reg.create({ label: "Court", twilioNumber: "+15555550151" }).tenant;
    reg.setFeature(lane.id, "visits", true, "admin");
    const secrets = new TenantSecrets(root);
    // An account's saved secrets can't stand in for the service's credentials or switches.
    secrets.set(court.id, { [ACCOUNT_FEATURES]: "visits,locks", SEAM_API_KEY: "test-seam-key-not-real", SEAM_WEBHOOK_SECRET: "test-seam-webhook-not-real", FEATURES_OFF: "" });
    const base = { [ACCOUNT_FEATURES]: "hours,visits", FEATURES_OFF: "cameras" };
    const envOf = (id: string) => buildTenantEnv({ base, tenant: reg.get(id)!, secrets, primary: undefined, origin: "https://core.example.test" });
    const laneEnv = envOf(lane.id);
    const courtEnv = envOf(court.id);
    expect(laneEnv[ACCOUNT_FEATURES]).toBe("visits");
    expect(courtEnv[ACCOUNT_FEATURES]).toBe("");
    expect(courtEnv.SEAM_API_KEY).toBeUndefined();
    expect(courtEnv.FEATURES_OFF).toBe("cameras");
    expect(deskFeatureOn(laneEnv, "visits")).toBe(true);
    expect(deskFeatureOn(laneEnv, "hours")).toBe(false);
    for (const feature of FEATURES) expect(deskFeatureOn(courtEnv, feature)).toBe(false);
  });
});

describe("switches on the shared service", () => {
  const PASSWORD = "admin-test-password-1";
  const PATH = "/mcp";
  const FORM = "application/x-www-form-urlencoded";
  const SLOW = { timeout: 120_000 };
  const HOURS = ["export_hours", "review_hours", "save_hours_settings"];
  let open: MultiTenantApp | undefined;
  afterEach(() => {
    resetAdminSessions();
    open?.close();
    open = undefined;
    closeHostedApps();
  });

  async function twoAccounts(env: NodeJS.ProcessEnv = {}) {
    open = await multiTenantApp({ env: { CLEANER_CORE_ADMIN_PASSWORD: PASSWORD, SUPPLY_CORE: "1", ...env } });
    const m = open;
    const make = async (label: string, number: string) => {
      const { tenant } = m.registry.create({ label, twilioNumber: number });
      const property = m.registry.addProperty(tenant.id, `12 Scratch ${label}`);
      m.registry.setFlow(tenant.id, property.id, "supplies", true);
      return { tenant, property, token: await m.joinAt(tenant.id, "grok", PATH) };
    };
    return { m, lane: await make("Lane", "+15555550150"), court: await make("Court", "+15555550151") };
  }

  async function signIn(m: MultiTenantApp) {
    const login = await m.app.http("/admin/login", { method: "POST", headers: { "content-type": FORM }, body: new URLSearchParams({ password: PASSWORD }).toString() });
    expect(login.status).toBe(303);
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const page = async (path: string) => (await m.app.http(path, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page("/admin"))?.[1] ?? "";
    const post = async (path: string, fields: Record<string, string>, withCsrf = true) => {
      const res = await m.app.http(path, { method: "POST", headers: { "content-type": FORM, cookie }, body: new URLSearchParams({ ...fields, ...(withCsrf ? { csrf } : {}) }).toString() });
      return { status: res.status, html: await res.text() };
    };
    return { page, post, csrf };
  }

  it("lists a feature's tools only for the account whose switch is on", SLOW, async () => {
    const { m, lane, court } = await twoAccounts();
    expect((await m.toolNames(PATH, lane.token)).filter((n) => HOURS.includes(n))).toEqual([]);
    switchOn(m.registry, lane.tenant.id, "hours");
    expect((await m.toolNames(PATH, lane.token)).filter((n) => HOURS.includes(n))).toEqual(HOURS);
    expect((await m.toolNames(PATH, court.token)).filter((n) => HOURS.includes(n))).toEqual([]);
    const refused = await m.toolAt(PATH, court.token, "review_hours", { property: court.property.id, month: "2026-10" });
    expect(refused.isError).toBe(true);
  });

  it("is changed only on /admin: no tool a chat lists touches a switch, whatever it's passed", SLOW, async () => {
    const { m, lane } = await twoAccounts();
    const names = await m.toolNames(PATH, lane.token);
    expect(names.filter((n) => /feature|switch|admin/i.test(n))).toEqual([]);
    const sneaky = { property: lane.property.id, features: { hours: { on: true } }, feature: "hours", on: true };
    for (const name of ["set_flows", "get_state", "set_features", "save_sources"]) await m.toolAt(PATH, lane.token, name, sneaky);
    expect(m.registry.get(lane.tenant.id)!.features).toBeUndefined();
    expect((await m.toolNames(PATH, lane.token)).filter((n) => HOURS.includes(n))).toEqual([]);
  });

  it("turns a switch on and off from /admin for one account, recorded and live without a restart", SLOW, async () => {
    const { m, lane, court } = await twoAccounts();
    const admin = await signIn(m);
    const before = await admin.page(`/admin/tenants/${lane.tenant.id}`);
    expect(before).toContain("<h2>Features</h2>");
    expect(before).toMatch(/data-feature="hours"><td>Hours log/);
    expect((await admin.post(`/admin/tenants/${lane.tenant.id}/features`, { feature: "hours", on: "1" })).status).toBe(303);
    const saved = m.registry.get(lane.tenant.id)!.features?.hours;
    expect(saved?.on).toBe(true);
    expect(saved?.changedBy).toBe("admin");
    expect(Number.isFinite(Date.parse(saved!.changedAt))).toBe(true);
    expect(m.registry.get(court.tenant.id)!.features).toBeUndefined();
    expect((await m.toolNames(PATH, lane.token)).filter((n) => HOURS.includes(n))).toEqual(HOURS);
    expect(await admin.page("/admin")).toContain("<td>Hours log</td>");
    expect((await admin.post(`/admin/tenants/${lane.tenant.id}/features`, { feature: "hours", on: "0" })).status).toBe(303);
    expect((await m.toolNames(PATH, lane.token)).filter((n) => HOURS.includes(n))).toEqual([]);
    expect(m.registry.get(lane.tenant.id)!.featureChanges?.map((c) => c.on)).toEqual([true, false]);
  });

  it("refuses a switch change without a session, without the form's token, or for a feature that doesn't exist", SLOW, async () => {
    const { m, lane } = await twoAccounts();
    const anonymous = await m.app.http(`/admin/tenants/${lane.tenant.id}/features`, { method: "POST", headers: { "content-type": FORM }, body: new URLSearchParams({ feature: "hours", on: "1", csrf: "x" }).toString() });
    expect(anonymous.status).toBe(403);
    const admin = await signIn(m);
    expect((await admin.post(`/admin/tenants/${lane.tenant.id}/features`, { feature: "hours", on: "1" }, false)).status).toBe(403);
    expect((await admin.post(`/admin/tenants/${lane.tenant.id}/features`, { feature: "teleport", on: "1" })).status).toBe(400);
    expect((await admin.post(`/admin/tenants/${lane.tenant.id}/features`, { feature: "hours", on: "yes" })).status).toBe(400);
    expect(m.registry.get(lane.tenant.id)!.features).toBeUndefined();
  });

  it("shuts a feature off for every account with FEATURES_OFF, and the page says why", SLOW, async () => {
    const { m, lane } = await twoAccounts({ FEATURES_OFF: "hours" });
    switchOn(m.registry, lane.tenant.id, "hours", "locks");
    expect((await m.toolNames(PATH, lane.token)).filter((n) => HOURS.includes(n))).toEqual([]);
    const page = await (await signIn(m)).page(`/admin/tenants/${lane.tenant.id}`);
    expect(page).toContain("off for every account: FEATURES_OFF names it");
    expect(page).toContain("off: the service doesn&#39;t have its credentials");
  });
});
