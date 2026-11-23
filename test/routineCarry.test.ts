import { afterEach, describe, expect, it } from "vitest";
import { drainAllTenants, hostedCleaner } from "../src/cleaner-core/hosted/router";
import { TenantSecrets } from "../src/cleaner-core/hosted/tenantSecrets";
import { hashSecret, OAuthGrantStore } from "../src/mcp/oauth/store";
import { BASE, closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { ADDRESS, BUSINESS, CALENDAR_URL, DOOR_CODE } from "./wiringProof";

/**
 * A chat that signs in again gets a new grant. The alert routine it connected under the old grant
 * stays connected under the new one, so alerts keep reaching it without a new save_alert_routine.
 */

const LANE_LINE = "+15555550150";
const GROK_HOOK = "https://grok.example/routine/hook";
const LANE_HOST = "+15555550100";
const LANE_CLEANER = "+15555550101";
const DROPPED = "Cleaner Core's alerts aren't reaching this chat";

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
  return { m: open, lane };
}

const grantOf = (m: MultiTenantApp, token: string) => new OAuthGrantStore(m.app.inst.runtime).findByAccessHash(hashSecret(token))!;

function service(m: MultiTenantApp, logs: string[] = []) {
  return hostedCleaner({
    registry: m.registry,
    secrets: new TenantSecrets(m.app.root),
    dataRoot: m.app.root,
    origin: () => BASE,
    baseEnv: () => m.app.inst.env(),
    grantLive: (id) => {
      const store = new OAuthGrantStore(m.app.inst.runtime);
      const grant = store.get(id);
      return Boolean(grant && store.isLive(grant));
    },
    now: clock,
    log: (line) => logs.push(line),
  });
}

/** Saves the routine while wake-ups fail, so a wake-up is left waiting for the next round. */
async function saveWithWakeWaiting(m: MultiTenantApp, token: string) {
  m.setWakeStatus(503);
  expect((await m.tool(token, "save_alert_routine", { url: GROK_HOOK, token: "grok-routine-key-1" })).isError).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  m.setWakeStatus(200);
}

describe("the alert routine across a new sign-in", () => {
  it("still wakes the routine after the old grant ended and the chat signed in again", async () => {
    const { m, lane } = await start();
    const first = await m.joinCleaning(lane.id, "grok");
    await saveWithWakeWaiting(m, first);
    new OAuthGrantStore(m.app.inst.runtime).revokeGrant(grantOf(m, first).id);
    const second = await m.joinCleaning(lane.id, "grok");
    const secondGrant = grantOf(m, second).id;
    at += 60 * 60_000;
    const before = m.wakes.length;
    await drainAllTenants(service(m));
    expect(m.wakes.slice(before).map((wake) => wake.url)).toContain(GROK_HOOK);
    expect(new TenantSecrets(m.app.root).connection(lane.id, secondGrant).CLEANER_CORE_ROUTINE_URL).toBe(GROK_HOOK);
    expect(m.registry.get(lane.id)!.primaryGrantId).toBe(secondGrant);
  });

  it("still wakes the routine when the old grant ends after the chat signed in again", async () => {
    const { m, lane } = await start();
    const first = await m.joinCleaning(lane.id, "grok");
    await saveWithWakeWaiting(m, first);
    const second = await m.joinCleaning(lane.id, "grok");
    new OAuthGrantStore(m.app.inst.runtime).revokeGrant(grantOf(m, first).id);
    at += 60 * 60_000;
    const before = m.wakes.length;
    await drainAllTenants(service(m));
    expect(m.wakes.slice(before).map((wake) => wake.url)).toContain(GROK_HOOK);
    expect(m.registry.get(lane.id)!.primaryGrantId).toBe(grantOf(m, second).id);
  });

  it("doesn't hand one chat's routine to a chat of another assistant", async () => {
    const { m, lane } = await start();
    const grok = await m.joinCleaning(lane.id, "grok");
    await saveWithWakeWaiting(m, grok);
    new OAuthGrantStore(m.app.inst.runtime).revokeGrant(grantOf(m, grok).id);
    const claude = await m.joinCleaning(lane.id, "claude");
    at += 60 * 60_000;
    const before = m.wakes.length;
    await drainAllTenants(service(m));
    expect(m.wakes.slice(before)).toEqual([]);
    expect(new TenantSecrets(m.app.root).connection(lane.id, grantOf(m, claude).id).CLEANER_CORE_ROUTINE_URL).toBeUndefined();
  });

  it("doesn't take a routine from a second chat whose grant is still live", async () => {
    const { m, lane } = await start();
    const first = await m.joinCleaning(lane.id, "grok");
    expect((await m.tool(first, "save_alert_routine", { url: GROK_HOOK, token: "grok-routine-key-1" })).isError).toBe(false);
    const second = await m.joinCleaning(lane.id, "grok");
    await m.tool(second, "get_state");
    expect(new TenantSecrets(m.app.root).connection(lane.id, grantOf(m, second).id).CLEANER_CORE_ROUTINE_URL).toBeUndefined();
    expect(m.registry.get(lane.id)!.primaryGrantId).toBe(grantOf(m, first).id);
  });
});

describe("telling the host when alerts stop reaching the chat", () => {
  /** Lane's setup through run_checks, by `token`'s chat. */
  async function setUp(m: MultiTenantApp, token: string) {
    const call = (name: string, args: Record<string, unknown> = {}) => m.tool(token, name, args);
    await call("get_state", { choice: "cleaners" });
    await call("save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
    await call("save_people", { host: LANE_HOST, cleaner: LANE_CLEANER });
    await call("save_calendar_link", { url: CALENDAR_URL });
    await call("save_door_code", { code: DOOR_CODE });
    await call("set_up_texting");
    await call("run_checks");
    expect((await call("confirm_times", { checkout: "10:30", checkIn: "15:00" })).isError).toBe(false);
  }

  it("says so once in check_now when the routine's sign-in ended and the chat it follows now has none", async () => {
    const { m, lane } = await start();
    const grok = await m.joinCleaning(lane.id, "grok");
    const claude = await m.joinCleaning(lane.id, "claude");
    await setUp(m, claude);
    expect((await m.tool(grok, "save_alert_routine", { url: GROK_HOOK, token: "grok-routine-key-1" })).isError).toBe(false);
    expect((await m.tool(claude, "check_now")).text).not.toContain(DROPPED);
    // Grok's sign-in ends and no Grok chat signs in again: nothing can carry its routine.
    new OAuthGrantStore(m.app.inst.runtime).revokeGrant(grantOf(m, grok).id);
    const first = await m.tool(claude, "check_now");
    expect(first.text).toContain(DROPPED);
    expect(first.text).not.toContain("save_alert_routine");
    expect((await m.tool(claude, "check_now")).text).not.toContain(DROPPED);
  });

  it("says nothing when the chat signed in again and kept its routine", async () => {
    const { m, lane } = await start();
    const first = await m.joinCleaning(lane.id, "grok");
    await setUp(m, first);
    expect((await m.tool(first, "save_alert_routine", { url: GROK_HOOK, token: "grok-routine-key-1" })).isError).toBe(false);
    new OAuthGrantStore(m.app.inst.runtime).revokeGrant(grantOf(m, first).id);
    const second = await m.joinCleaning(lane.id, "grok");
    const checked = await m.tool(second, "check_now");
    expect(checked.isError).toBe(false);
    expect(checked.text).not.toContain(DROPPED);
  });
});
