import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tenantFolder } from "../src/cleaner-core/hosted/registry";
import { PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { closeHostedApps } from "./cleanerOauthHarness";
import { hillsideConfig, publishForVisitors } from "./liveApp";
import { multiTenantApp } from "./multiTenantHarness";

/**
 * The scenario catalog's one entry through the shared service on a 555 Scratch tenant, so the hosted
 * path is proven too; the rest run in-process in visitorScenarios.test.ts. Its own file, since the
 * shared service's harness changes test-wide state the in-process harness relies on.
 */

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

describe("through the shared service", () => {
  it("answers a first text on a 555 Scratch tenant", { timeout: 90_000 }, async () => {
    const m = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1", CLEANER_CORE_SCRATCH_TOOLS: "1" } });
    cleanups.push(() => {
      m.close();
      closeHostedApps();
    });
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: "+15555550150" });
    m.registry.setTouring(tenant.id);
    const ws = new PropertyWorkspace(join(tenantFolder(m.app.root, tenant.id), "tour-core"));
    const { config } = ws.save({ ...hillsideConfig(), messagingProvider: "local" });
    ws.recordReadiness(config.property.id, await runReadinessCheck(config, { now: new Date(), installed: { provider: "local" } }));
    publishForVisitors(ws, config.property.id, new Date());
    await m.touring()!.start(m.registry.get(tenant.id)!);
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    await m.toolAt("/mcp", token, "send_test_text", { from: "+15555550177", text: "TOUR" });
    const outbox = ((await m.toolAt("/mcp", token, "read_outbox")).structured?.texts ?? []) as { to: string; text: string }[];
    expect(outbox.some((t) => t.to === "+15555550177")).toBe(true);
  });
});

