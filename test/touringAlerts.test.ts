import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tenantFolder } from "../src/cleaner-core/hosted/registry";
import { renderPlaybook } from "../src/playbooks/compose";
import { PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { resetAdminSessions } from "../src/cleaner-core/hosted/admin";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { ROUTINE_KEY, ROUTINE_URL } from "./installHarness";
import { hillsideConfig, publishForVisitors } from "./liveApp";

/**
 * A touring tenant's landlord alerts: the host connects a routine through a one-time link, and the
 * touring process's events reach that routine and no other. Only 555 numbers; wakes are faked.
 */

const LANE = "+15555550150";
const MILL = "+15555550170";
const SLOW = { timeout: 90_000 };
const MILL_URL = "https://routines.example/hooks/mill-routine-SECRETPATH";

let open: MultiTenantApp | undefined;
afterEach(() => {
  resetAdminSessions();
  open?.close();
  open = undefined;
  closeHostedApps();
});

async function touringTenant(m: MultiTenantApp, label: string, number: string) {
  const { tenant } = m.registry.create({ label, twilioNumber: number });
  const token = await m.joinAt(tenant.id, "grok", "/mcp");
  await m.toolAt("/mcp", token, "choose_service", { service: "touring" });
  return { tenant, token };
}

/** Asks for the link and posts the routine to it, as Grok's computer does. */
async function connectRoutine(m: MultiTenantApp, token: string, url = ROUTINE_URL, key = ROUTINE_KEY) {
  const reply = await m.toolAt("/mcp", token, "save_alert_routine");
  const link = reply.structured?.uploadUrl as string | undefined;
  expect(link).toBeDefined();
  const path = new URL(link!).pathname;
  return { reply, path, res: await m.app.http(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, key }) }) };
}

const waitFor = async (check: () => boolean, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

describe("touring alerts", () => {
  it("gives a private link and never repeats the routine's address or key", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { tenant, token } = await touringTenant(m, "Lane", LANE);
    const { reply, path, res } = await connectRoutine(m, token);
    // Grok posts the routine it made from its own computer; the host never opens the link.
    expect(reply.structured?.next).toContain("From your own cloud computer, POST JSON");
    expect(reply.structured?.next).toContain("Never send uploadUrl to the host");
    expect(path).toMatch(new RegExp(`^/t/${tenant.id}/touring/alert-routine/[A-Za-z0-9_-]{43}$`));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(ROUTINE_KEY);
    expect(m.app.logs.join("\n")).not.toContain(ROUTINE_KEY);
  });

  it("tells a host who opens the link to go back to the chat, and keeps the link usable", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { token } = await touringTenant(m, "Lane", LANE);
    const reply = await m.toolAt("/mcp", token, "save_alert_routine");
    const path = new URL(reply.structured!.uploadUrl as string).pathname;
    const page = await m.app.http(path);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Go back to your chat");
    const saved = await m.app.http(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: ROUTINE_URL, key: ROUTINE_KEY }) });
    expect(saved.status).toBe(200);
  });

  it("answers get_state with Grok's playbook, and counts the routine as connected once it's saved", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    m.registry.setService(tenant.id, "touring");
    // A finished property, so the alerts step is what get_state offers next.
    const ws = new PropertyWorkspace(join(tenantFolder(m.app.root, tenant.id), "tour-core"));
    const { config } = ws.save({ ...hillsideConfig(), messagingProvider: "local" });
    ws.recordReadiness(config.property.id, await runReadinessCheck(config, { now: new Date(), installed: { provider: "local" } }));
    publishForVisitors(ws, config.property.id, new Date());
    await m.touring()!.start(m.registry.get(tenant.id)!);
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    await m.toolAt("/mcp", token, "backup_records", { action: "decline" });
    const state = async () => (await m.toolAt("/mcp", token, "get_state")).structured as { playbook: { id: string }; alerts: { summary: string } };
    const before = await state();
    // The front says which chat this is, so touring answers with Grok's playbook, secure card and all.
    expect(before.playbook.id).toBe("grok");
    expect(before.alerts.summary).toBe("Tour updates aren't turned on yet.");
    await connectRoutine(m, token);
    await waitFor(() => m.wakes.length > 0);
    // The test update that went out on connecting is the passed test. No test tool, no setup page.
    let after = await state();
    for (let i = 0; i < 50 && !after.alerts.summary.startsWith("I'll keep you posted"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      after = await state();
    }
    expect(after.alerts.summary).toMatch(/^I'll keep you posted on /);
    expect(JSON.stringify(after)).not.toMatch(/localhost|get_secure_setup_url/);
  });

  it("tells Grok on touring's alerts step to post the routine itself, never to send the host a link", () => {
    const shared = renderPlaybook({ name: "Grok" }, "alerts", undefined, { sharedService: true }).text;
    expect(shared).toContain("Call save_alert_routine");
    expect(shared).toContain("Never send that link to the landlord");
    expect(shared).not.toContain("operator-alerts secure input");
    expect(renderPlaybook({ name: "Grok" }, "alerts").text).toContain("operator-alerts secure input");
  });

  it("wakes the Grok routine with a test event, carrying no phone numbers", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { token } = await touringTenant(m, "Lane", LANE);
    await connectRoutine(m, token);
    await waitFor(() => m.wakes.length > 0);
    const wake = m.wakes[0]!;
    expect(wake.url).toBe(ROUTINE_URL);
    expect(JSON.parse(wake.body).eventType).toBe("installation.test");
    expect(wake.body).not.toMatch(/\+1555/);
  });

  it("lets publish past the alerts check only after the routine is connected", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { token } = await touringTenant(m, "Lane", LANE);
    expect((await m.toolAt("/mcp", token, "publish", { property: "Hillside" })).text).toContain("Connect the touring alert routine first.");
    await connectRoutine(m, token);
    await waitFor(() => m.wakes.length > 0);
    expect((await m.toolAt("/mcp", token, "publish", { property: "Hillside" })).text).not.toContain("Connect the touring alert routine first.");
  });

  it("refuses an http routine address, and a used link", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { token } = await touringTenant(m, "Lane", LANE);
    const plain = await connectRoutine(m, token, "http://routines.example/hooks/x");
    expect(plain.res.status).toBe(400);
    const good = await connectRoutine(m, token);
    expect(good.res.status).toBe(200);
    const again = await m.app.http(good.path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: ROUTINE_URL, key: ROUTINE_KEY }) });
    expect(again.status).toBe(404);
  });

  it("keeps one tenant's routine away from another's events", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const lane = await touringTenant(m, "Lane", LANE);
    const mill = await touringTenant(m, "Mill", MILL);
    await connectRoutine(m, mill.token, MILL_URL);
    await waitFor(() => m.wakes.length > 0);
    await connectRoutine(m, lane.token);
    await waitFor(() => m.wakes.length > 1);
    expect(m.wakes.filter((w) => w.url === MILL_URL)).toHaveLength(1);
    expect(m.wakes.filter((w) => w.url === ROUTINE_URL)).toHaveLength(1);
    expect(lane.tenant.id).not.toBe(mill.tenant.id);
  });

  it("retries a wake the routine refused, from the touring process's outbox", { timeout: 120_000 }, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { token } = await touringTenant(m, "Lane", LANE);
    m.setWakeStatus(500);
    await connectRoutine(m, token);
    await waitFor(() => m.wakes.length > 0);
    const summary = async () => ((await m.toolAt("/mcp", token, "get_state")).structured as { alerts: { summary: string } }).alerts.summary;
    expect(await summary()).toBe("Tour updates are connected. The test update is on its way.");
    m.setWakeStatus(200);
    await waitFor(() => m.wakes.length > 1, 90_000);
    expect(JSON.parse(m.wakes[1]!.body).eventId).toBe(JSON.parse(m.wakes[0]!.body).eventId);
  });

  it("stops publishing again once /admin disconnects the only chat with a routine", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1", CLEANER_CORE_ADMIN_PASSWORD: "admin-test-password-1" } }));
    const { tenant, token: withRoutine } = await touringTenant(m, "Lane", LANE);
    const other = await m.joinAt(tenant.id, "grok", "/mcp");
    await connectRoutine(m, withRoutine);
    await waitFor(() => m.wakes.length > 0);
    expect((await m.toolAt("/mcp", other, "publish", { property: "Hillside" })).text).not.toContain("Connect the touring alert routine first.");
    const form = "application/x-www-form-urlencoded";
    const login = await m.app.http("/admin/login", { method: "POST", headers: { "content-type": form }, body: "password=admin-test-password-1" });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const page = await (await m.app.http(`/admin/tenants/${tenant.id}`, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
    const grantId = m.registry.get(tenant.id)!.connections[0]!.grantId;
    await m.app.http(`/admin/tenants/${tenant.id}/disconnect`, { method: "POST", headers: { "content-type": form, cookie }, body: new URLSearchParams({ csrf, grantId }).toString() });
    expect((await m.toolAt("/mcp", other, "publish", { property: "Hillside" })).text).toContain("Connect the touring alert routine first.");
  });
});
