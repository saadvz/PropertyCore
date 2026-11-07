import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tenantFolder } from "../src/cleaner-core/hosted/registry";
import { SCRATCH_TEST_WENT_THROUGH } from "../src/cleaner-core/scratchQa";
import { PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { closeHostedApps } from "./cleanerOauthHarness";
import { hillsideConfig, publishForVisitors } from "./liveApp";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/**
 * Touring end to end on Claude, ChatGPT, and Muse through the shared service: connect at /mcp, choose
 * touring, connect tour updates the platform's way, choose host texts, and a visitor's text gets an
 * answer. A Scratch tenant, so every text stays in its test outbox. Only 555 numbers.
 */

const LANE = "+15555550150";
const HOST = "+15555550151";
const VISITOR = "+15555550177";
const FIRE = "https://api.anthropic.com/v1/claude_code/routines/r1/fire";
const SLOW = { timeout: 120_000 };

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

const waitFor = async (check: () => boolean, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

describe.each(["claude", "chatgpt", "muse"] as const)("touring on %s", (assistant) => {
  it("sets up, connects tour updates, takes host texts, and answers a visitor", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1", CLEANER_CORE_SCRATCH_TOOLS: "1" } }));
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    await m.makeTouring(tenant.id);
    const token = await m.joinAt(tenant.id, assistant, "/mcp");

    // A published Scratch property, as a host's would be at the end of setup.
    const touring = m.touring()!;
    touring.supervisor.stop(tenant.id);
    const ws = new PropertyWorkspace(join(tenantFolder(m.app.root, tenant.id), "tour-core"));
    const { config } = ws.save({ ...hillsideConfig(), messagingProvider: "local" });
    ws.recordReadiness(config.property.id, await runReadinessCheck(config, { now: new Date(), installed: { provider: "local" } }));
    publishForVisitors(ws, config.property.id, new Date());
    await touring.start(m.registry.get(tenant.id)!);

    const routine = await m.toolAt("/mcp", token, "save_alert_routine");
    expect(routine.isError, routine.text).toBe(false);
    expect(String(routine.structured?.next)).toContain("Want tour updates texted to your phone too?");
    if (assistant === "claude") {
      const path = new URL(String(routine.structured?.uploadUrl)).pathname;
      const form = new URLSearchParams({ url: FIRE, token: "claude-token-0123456789" }).toString();
      expect((await m.app.http(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form })).status).toBe(200);
      await waitFor(() => m.wakes.some((w) => w.url === FIRE));
    } else {
      expect(routine.structured?.connected).toBe(true);
      expect(Array.isArray((await m.toolAt("/mcp", token, "get_updates")).structured?.updates)).toBe(true);
    }

    expect((await m.toolAt("/mcp", token, "save_host_texts", { which: "urgent", phone: HOST })).isError).toBe(false);
    expect((await m.toolAt("/mcp", token, "send_test_text", { from: VISITOR, text: "TOUR" })).text).toBe(SCRATCH_TEST_WENT_THROUGH);
    const outbox = ((await m.toolAt("/mcp", token, "read_outbox")).structured?.texts ?? []) as { to: string }[];
    expect(outbox.some((t) => t.to === VISITOR)).toBe(true);
    expect(m.sms.sent).toEqual([]);
  });
});
