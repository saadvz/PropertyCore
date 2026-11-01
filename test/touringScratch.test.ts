import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tenantFolder } from "../src/cleaner-core/hosted/registry";
import { SCRATCH_NUMBER_REFUSAL, SCRATCH_TEST_WENT_THROUGH } from "../src/cleaner-core/scratchQa";
import { PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { closeHostedApps } from "./cleanerOauthHarness";
import { hillsideConfig, publishForVisitors } from "./liveApp";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/** Scratch tools on a touring tenant whose number is a 555 number. Every touring text stays in the local outbox. */

const LANE = "+15555550150";
const VISITOR = "+15555550177";
const SLOW = { timeout: 120_000 };

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

async function touring(number = LANE, env: NodeJS.ProcessEnv = { TOUR_CORE_TENANTS: "1", CLEANER_CORE_SCRATCH_TOOLS: "1" }) {
  const m = (open = await multiTenantApp({ env }));
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: number });
  const token = await m.joinAt(tenant.id, "grok", "/mcp");
  await m.toolAt("/mcp", token, "choose_service", { service: "touring" });
  return { m, tenant, token };
}

const lines = (reply: { structured?: Record<string, unknown> }, key: string) => (reply.structured?.[key] ?? []) as { from?: string; to?: string; text: string }[];

describe("Scratch tools for touring", () => {
  it("hands a test visitor text to touring, which leaves a number with no property unanswered", SLOW, async () => {
    const { m, token } = await touring();
    const sent = await m.toolAt("/mcp", token, "send_test_text", { from: VISITOR, text: "Tour" });
    expect(sent.text).toBe(SCRATCH_TEST_WENT_THROUGH);
    expect(lines(await m.toolAt("/mcp", token, "read_inbox"), "texts")).toEqual([{ from: VISITOR, text: "Tour" }]);
    expect(lines(await m.toolAt("/mcp", token, "read_outbox"), "texts")).toEqual([]);
    expect(m.app.logs.join("\n")).toContain("isn't connected to a property. It was not answered.");
  });

  it("answers a test visitor on a published property, with the reply in the outbox", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1", CLEANER_CORE_SCRATCH_TOOLS: "1" } }));
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    m.registry.setService(tenant.id, "touring");
    // The property is set up and published before the touring process starts, as a host's would be.
    const ws = new PropertyWorkspace(join(tenantFolder(m.app.root, tenant.id), "tour-core"));
    // A Scratch host's property texts through the local test outbox, so its checks pass without Twilio.
    const { config } = ws.save({ ...hillsideConfig(), messagingProvider: "local" });
    ws.recordReadiness(config.property.id, await runReadinessCheck(config, { now: new Date(), installed: { provider: "local" } }));
    publishForVisitors(ws, config.property.id, new Date());
    await m.touring()!.start(m.registry.get(tenant.id)!);
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    expect((await m.toolAt("/mcp", token, "send_test_text", { from: VISITOR, text: "TOUR" })).text).toBe(SCRATCH_TEST_WENT_THROUGH);
    const outbox = lines(await m.toolAt("/mcp", token, "read_outbox"), "texts");
    expect(outbox.length).toBeGreaterThan(0);
    expect(outbox.every((line) => line.to === VISITOR)).toBe(true);
    expect(outbox.map((line) => line.text).join("\n")).not.toContain("Tours by text aren't available right now");
  });

  it("refuses send_test_text from a number outside the 555 block", SLOW, async () => {
    const { m, token } = await touring();
    const refused = await m.toolAt("/mcp", token, "send_test_text", { from: "+10000000000", text: "Tour" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(SCRATCH_NUMBER_REFUSAL);
  });

  it("makes no Twilio call for a Scratch touring tenant, even with live texts on", SLOW, async () => {
    const { m, token } = await touring();
    await m.toolAt("/mcp", token, "send_test_text", { from: VISITOR, text: "Tour" });
    expect(m.sms.sent).toEqual([]);
  });

  it("lists the Scratch tools only with the flag on and a 555 number", SLOW, async () => {
    const off = await touring(LANE, { TOUR_CORE_TENANTS: "1" });
    expect(await off.m.toolNames("/mcp", off.token)).not.toContain("send_test_text");
    off.m.close();
    closeHostedApps();
    const real = await touring("+10000000000");
    expect(await real.m.toolNames("/mcp", real.token)).not.toContain("send_test_text");
  });
});
