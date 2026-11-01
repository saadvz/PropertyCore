import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tenantFolder } from "../src/cleaner-core/hosted/registry";
import { liveDeskFor, resetLiveDesks } from "../src/cleaner-core/liveDesk";
import { drainAllTenants, hostedCleaner, splitTenantPath, tenantContext } from "../src/cleaner-core/hosted/router";
import { TenantSecrets } from "../src/cleaner-core/hosted/tenantSecrets";
import { hashSecret, OAuthGrantStore } from "../src/mcp/oauth/store";
import { BASE, closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { ADDRESS, BUSINESS, CALENDAR_URL, DOOR_CODE } from "./wiringProof";

const ZONE = "America/New_York";
const LANE_LINE = "+15555550150";
const COURT_LINE = "+15555550151";
const LANE_HOST = "+15555550100";
const LANE_CLEANER = "+15555550101";
const GROK_HOOK = "https://grok.example/routine/hook";
const CLAUDE_FIRE = "https://api.anthropic.com/v1/claude_code/routines/trig_lane/fire";
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

let open: MultiTenantApp | undefined;
let at = Date.now();
const clock = () => new Date(at);
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

async function start() {
  at = Date.now();
  open = await multiTenantApp({ now: clock });
  const lane = open.registry.create({ label: "Lane", twilioNumber: LANE_LINE }).tenant;
  const court = open.registry.create({ label: "Court", twilioNumber: COURT_LINE }).tenant;
  return { m: open, lane, court };
}

const grantOf = (m: MultiTenantApp, token: string) => new OAuthGrantStore(m.app.inst.runtime).findByAccessHash(hashSecret(token))!;

describe("splitTenantPath", () => {
  it("reads /t/<id>/<rest> and nothing else", () => {
    expect(splitTenantPath("/t/tnt_abcdefghij/cleaner-core/photos/x")).toEqual({ tenantId: "tnt_abcdefghij", rest: "/cleaner-core/photos/x" });
    expect(splitTenantPath("/t/tnt_abcdefghij")).toBeUndefined();
    expect(splitTenantPath("/t/../cleaner-core/x")).toBeUndefined();
    expect(splitTenantPath("/cleaner-core/photos/x")).toBeUndefined();
  });
});

describe("routing on the multi-tenant service", () => {
  it("sends an MCP call to its own tenant's folder only", async () => {
    const { m, lane, court } = await start();
    const token = await m.join(lane.id, "grok");
    await m.tool(token, "get_state", { choice: "cleaners" });
    const saved = await m.tool(token, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE });
    expect(saved.isError).toBe(false);
    expect(existsSync(join(tenantFolder(m.app.root, lane.id), "cleaner-live.json"))).toBe(true);
    expect(existsSync(join(tenantFolder(m.app.root, court.id), "cleaner-live.json"))).toBe(false);
    expect(existsSync(join(m.app.root, "cleaner-live.json"))).toBe(false);
  });

  it("refuses a grant whose tenant was removed or disabled", async () => {
    const { m, lane, court } = await start();
    const laneToken = await m.join(lane.id, "grok");
    const courtToken = await m.join(court.id, "grok");
    m.registry.remove(lane.id);
    m.registry.setDisabled(court.id, true);
    for (const token of [laneToken, courtToken]) {
      const res = await m.tool(token, "get_state");
      expect(res.status).toBe(403);
      expect(JSON.parse(res.raw)).toEqual({ error: { message: "This connection isn't linked to a Cleaner Core account. Reconnect with an invite code from Saad." } });
    }
  });

  it("answers a text to an unknown number with empty TwiML and sends nothing", async () => {
    const { m } = await start();
    const res = await m.text("+15555550199", LANE_CLEANER, "YES", "SM-unknown");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(EMPTY_TWIML);
    expect(m.sms.sent).toHaveLength(0);
  });

  it("is 404 for an unknown or disabled tenant prefix and for the un-prefixed Cleaner Core links", async () => {
    const { m, court } = await start();
    m.registry.setDisabled(court.id, true);
    expect((await m.app.http("/t/tnt_zzzzzzzzzz/cleaner-core/photos/abc")).status).toBe(404);
    expect((await m.app.http(`/t/${court.id}/cleaner-core/photos/abc`)).status).toBe(404);
    expect((await m.app.http("/cleaner-core/alert-routine/abc", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
    expect((await m.app.http("/cleaner-core/photos/abc")).status).toBe(404);
  });

  it("asks an unsigned call on the shared /mcp to sign in, and lists nothing", async () => {
    const { m } = await start();
    const res = await m.app.rpc("/mcp", "tools/list");
    expect(res.status).toBe(401);
    expect(String(res.headers["www-authenticate"])).toContain("Bearer");
    expect(await res.text()).not.toContain("tools");
  });

  it("names the Grok primary in host texts while a Claude connection runs the setup", async () => {
    const { m, lane } = await start();
    await m.join(lane.id, "grok");
    const claude = await m.join(lane.id, "claude");
    const call = (name: string, args: Record<string, unknown> = {}) => m.tool(claude, name, args);
    await call("get_state", { choice: "cleaners" });
    await call("save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE });
    await call("save_people", { host: LANE_HOST, cleaner: LANE_CLEANER });
    await call("save_calendar_link", { url: CALENDAR_URL });
    await call("save_door_code", { code: DOOR_CODE });
    await call("set_up_texting");
    await call("run_checks");
    expect((await call("confirm_times", { checkout: "10:30", checkIn: "15:00" })).isError).toBe(false);
    await m.text(LANE_LINE, LANE_CLEANER, "YES", "SM-lane-yes-1");
    await m.text(LANE_LINE, LANE_CLEANER, "YES", "SM-lane-yes-2");
    const before = m.sms.sent.length;
    await m.text(LANE_LINE, LANE_CLEANER, "STOP", "SM-lane-stop");
    const toHost = m.sms.sent.slice(before).filter((item) => item.to === LANE_HOST).map((item) => item.body);
    expect(toHost).toEqual([`The cleaner opted out of cleaning texts for ${ADDRESS}, so the cleaning is on hold. Find another cleaner or reach them directly, then tell your Grok Bot to restart it.`]);
    expect(m.sms.sent.some((item) => item.body.includes("Claude"))).toBe(false);
  });

  it("wakes only the primary's routine, and falls back when the primary's grant is gone", async () => {
    const { m, lane } = await start();
    const grok = await m.join(lane.id, "grok");
    const claude = await m.join(lane.id, "claude");
    expect((await m.tool(grok, "save_alert_routine", { url: GROK_HOOK, token: "grok-routine-key-1" })).isError).toBe(false);
    expect((await m.tool(claude, "save_alert_routine", { url: CLAUDE_FIRE, token: "claude-routine-key-1" })).isError).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(m.wakes.length).toBeGreaterThan(0);
    expect(m.wakes.every((wake) => wake.url === GROK_HOOK)).toBe(true);
    const store = new OAuthGrantStore(m.app.inst.runtime);
    store.revokeGrant(grantOf(m, grok).id);
    const seen = m.wakes.length;
    expect((await m.tool(claude, "save_alert_routine", { url: CLAUDE_FIRE, token: "claude-routine-key-2" })).isError).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(m.wakes.slice(seen).map((wake) => wake.url)).toEqual([CLAUDE_FIRE]);
  });

  it("sends no cleaning alerts for a tenant that moved to touring", async () => {
    const { m, court } = await start();
    const courtToken = await m.join(court.id, "grok");
    m.setWakeStatus(503);
    expect((await m.tool(courtToken, "save_alert_routine", { url: GROK_HOOK, token: "court-routine-key" })).isError).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    m.setWakeStatus(200);
    m.registry.setService(court.id, "touring");
    at += 60 * 60_000;
    const h = hostedCleaner({
      registry: m.registry,
      secrets: new TenantSecrets(m.app.root),
      dataRoot: m.app.root,
      origin: () => BASE,
      baseEnv: () => m.app.inst.env(),
      grantLive: (id) => Boolean(new OAuthGrantStore(m.app.inst.runtime).get(id)),
      now: clock,
      log: () => {},
    });
    const before = m.wakes.length;
    await drainAllTenants(h);
    expect(m.wakes.slice(before)).toEqual([]);
  });

  it("keeps draining the other tenants when one tenant's desk throws", async () => {
    const { m, lane, court } = await start();
    const courtToken = await m.join(court.id, "grok");
    m.setWakeStatus(503);
    expect((await m.tool(courtToken, "save_alert_routine", { url: GROK_HOOK, token: "court-routine-key" })).isError).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    m.setWakeStatus(200);
    m.registry.setService(lane.id, "cleaning");
    mkdirSync(tenantFolder(m.app.root, lane.id), { recursive: true });
    writeFileSync(join(tenantFolder(m.app.root, lane.id), "cleaner-live.json"), "{ not json");
    const logs: string[] = [];
    at += 60 * 60_000;
    const h = hostedCleaner({
      registry: m.registry,
      secrets: new TenantSecrets(m.app.root),
      dataRoot: m.app.root,
      origin: () => BASE,
      baseEnv: () => m.app.inst.env(),
      grantLive: (id) => Boolean(new OAuthGrantStore(m.app.inst.runtime).get(id)),
      now: clock,
      log: (line) => logs.push(line),
    });
    const before = m.wakes.length;
    await drainAllTenants(h);
    expect(m.wakes.slice(before).map((wake) => wake.url)).toContain(GROK_HOOK);
    expect(logs.some((line) => line.includes(lane.id))).toBe(true);
  });

  it("a page probe on a fresh desk never changes which chat the tenant's texts and alerts follow", async () => {
    const { m, lane } = await start();
    await m.join(lane.id, "grok");
    await m.join(lane.id, "claude");
    resetLiveDesks();
    const probe = `/t/${lane.id}/cleaner-core/door-code/${"A".repeat(43)}`;
    expect((await m.app.http(probe)).status).toBe(404);
    const desk = liveDeskFor(tenantFolder(m.app.root, lane.id), () => ({}), () => new Date());
    expect(desk.primaryAssistant()).toBe("grok");
  });

  it("an upload page speaks as the chat that made the link, even when the primary is another chat", async () => {
    const { m, lane } = await start();
    await m.join(lane.id, "chatgpt");
    const claude = await m.join(lane.id, "claude");
    const link = await m.tool(claude, "save_alert_routine", {});
    const path = new URL(String(link.structured?.uploadUrl)).pathname;
    const page = await m.app.http(path);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Claude");
    expect(html).not.toContain("ChatGPT");
  });

  it("a removed tenant's context has Cleaner Core off, so nothing in flight can send for it", async () => {
    const { m, lane } = await start();
    const h = hostedCleaner({
      registry: m.registry,
      secrets: new TenantSecrets(m.app.root),
      dataRoot: m.app.root,
      origin: () => BASE,
      baseEnv: () => m.app.inst.env(),
      grantLive: () => true,
      now: clock,
      log: () => undefined,
    });
    const ctx = tenantContext(h, lane);
    expect(ctx.env().CLEANER_CORE_ENABLED).toBe("1");
    m.registry.remove(lane.id);
    expect(ctx.env().CLEANER_CORE_ENABLED).toBe("0");
  });

  it("asks an unsigned caller to sign in from its own chat, not from Grok", async () => {
    const { m } = await start();
    const res = await m.app.http("/mcp/cleaner-core", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { message: "Connect Cleaner Core in your chat to sign in." } });
  });

  it("makes the chat that connects its routine the primary when the primary has none", async () => {
    const { m, lane } = await start();
    await m.join(lane.id, "claude");
    const grok = await m.join(lane.id, "grok");
    const grokGrant = grantOf(m, grok).id;
    expect(m.registry.get(lane.id)!.primaryGrantId).not.toBe(grokGrant);
    expect((await m.tool(grok, "save_alert_routine", { url: GROK_HOOK, token: "grok-routine-key-1" })).isError).toBe(false);
    expect(m.registry.get(lane.id)!.primaryGrantId).toBe(grokGrant);
    // Its own alerts now reach it, including the test wake-up that waited while Claude was primary.
    expect((await m.tool(grok, "save_alert_routine", { url: GROK_HOOK, token: "grok-routine-key-2" })).isError).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(m.wakes.length).toBeGreaterThan(0);
    expect(m.wakes.every((wake) => wake.url === GROK_HOOK)).toBe(true);
  });

  it("leaves a primary whose routine is connected alone", async () => {
    const { m, lane } = await start();
    const grok = await m.join(lane.id, "grok");
    const claude = await m.join(lane.id, "claude");
    expect((await m.tool(grok, "save_alert_routine", { url: GROK_HOOK, token: "grok-routine-key-1" })).isError).toBe(false);
    expect((await m.tool(claude, "save_alert_routine", { url: CLAUDE_FIRE, token: "claude-routine-key-1" })).isError).toBe(false);
    expect(m.registry.get(lane.id)!.primaryGrantId).toBe(grantOf(m, grok).id);
  });

  it("promotes on a routine saved through the upload link, too", async () => {
    const { m, lane } = await start();
    await m.join(lane.id, "claude");
    const grok = await m.join(lane.id, "grok");
    const link = await m.tool(grok, "save_alert_routine", {});
    const path = new URL(String(link.structured?.uploadUrl)).pathname;
    expect(m.registry.get(lane.id)!.primaryGrantId).not.toBe(grantOf(m, grok).id);
    const res = await m.app.http(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: GROK_HOOK, token: "grok-routine-key-1" }) });
    expect(res.status).toBe(200);
    expect(m.registry.get(lane.id)!.primaryGrantId).toBe(grantOf(m, grok).id);
  });
});
