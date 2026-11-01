import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testEvent, timeRequestedEvent } from "../src/alerts/operatorEvents";
import type { CleanerAssistant } from "../src/cleaner-core/assistant";
import { tenantFolder } from "../src/cleaner-core/hosted/registry";
import { touringSinkFor } from "../src/hosted/touringAlerts";
import { PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { hillsideConfig, publishForVisitors } from "./liveApp";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/** ChatGPT and Muse: a recurring task connects with no link, and reads new tour events with get_updates. Only 555 numbers. */

const LANE = "+15555550150";
const SLOW = { timeout: 90_000 };
const ALERTS_FIRST = "Connect the touring alert routine first.";
const LIMIT = {
  chatgpt: "ChatGPT checks for updates at most once an hour, so a text gets you there sooner.",
  muse: "Muse checks for updates as often as you set its task, so a text gets you there sooner.",
} as const;

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

async function touring(assistant: CleanerAssistant) {
  const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
  const token = await m.joinAt(tenant.id, assistant, "/mcp");
  await m.toolAt("/mcp", token, "choose_service", { service: "touring" });
  return { m, tenant: m.registry.get(tenant.id)!, token };
}

const timeRequest = () => timeRequestedEvent({ propertyId: "prop_lane", tourTimeRequestId: "ttr_0123456789ab", occurredAt: "2026-11-01T15:00:00.000Z" });

/** Publish's answer once the touring process has heard the alerts change. */
async function publishAnswer(m: MultiTenantApp, token: string): Promise<string> {
  let text = "";
  for (let i = 0; i < 30; i++) {
    text = (await m.toolAt("/mcp", token, "publish", { property: "Hillside" })).text;
    if (!text.includes(ALERTS_FIRST)) return text;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return text;
}

describe.each(["chatgpt", "muse"] as const)("a %s task", (assistant) => {
  it("connects with no link or secret, says the platform's limit, and asks about texts", SLOW, async () => {
    const { m, token } = await touring(assistant);
    const reply = await m.toolAt("/mcp", token, "save_alert_routine");
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.structured?.connected).toBe(true);
    expect(reply.structured?.uploadUrl).toBeUndefined();
    expect(String(reply.structured?.next)).toContain(LIMIT[assistant]);
    expect(String(reply.structured?.next)).toContain("Want tour updates texted to your phone too?");
    expect(await publishAnswer(m, token)).not.toContain(ALERTS_FIRST);
    // Nothing can wake the task, so there is no test update.
    expect(m.wakes).toEqual([]);
  });

  it("reads each new event once, and never the setup test", SLOW, async () => {
    const { m, tenant, token } = await touring(assistant);
    await m.toolAt("/mcp", token, "save_alert_routine");
    const sink = touringSinkFor(m.hosted(), tenant);
    await sink.deliver(testEvent(new Date("2026-11-01T14:00:00.000Z")));
    await sink.deliver(timeRequest());
    const first = await m.toolAt("/mcp", token, "get_updates");
    expect(first.structured?.updates).toEqual([{ eventType: "tour.time_requested", occurredAt: "2026-11-01T15:00:00.000Z", line: "A visitor asked for a tour time." }]);
    expect((await m.toolAt("/mcp", token, "get_updates")).structured?.updates).toEqual([]);
  });
});

describe("two chats on one touring number", () => {
  it("keeps a ChatGPT task's reads from emptying a Grok chat's list", SLOW, async () => {
    const { m, tenant, token } = await touring("chatgpt");
    const grok = await m.joinAt(tenant.id, "grok", "/mcp");
    await m.toolAt("/mcp", token, "save_alert_routine");
    await touringSinkFor(m.hosted(), m.registry.get(tenant.id)!).deliver(timeRequest());
    expect((await m.toolAt("/mcp", token, "get_updates")).structured?.updates).toHaveLength(1);
    expect((await m.toolAt("/mcp", grok, "get_updates")).structured?.updates).toHaveLength(1);
  });
});

describe("a Grok chat", () => {
  it("still gets a one-time link, and the texts question for after", SLOW, async () => {
    const { m, token } = await touring("grok");
    const reply = await m.toolAt("/mcp", token, "save_alert_routine");
    expect(String(reply.structured?.uploadUrl)).toMatch(/\/touring\/alert-routine\//);
    expect(String(reply.structured?.next)).toContain("Want tour updates texted to your phone too?");
  });
});

describe("a task that stops checking in", () => {
  const WARNING = /^Your Tour Core task hasn't checked in since .+ at .+\. Turn it back on in your chat's scheduled tasks\.$/;

  /** A touring tenant with a published property, joined by `assistant`, on a clock the test moves. */
  async function published(assistant: CleanerAssistant) {
    let clock = Date.parse("2026-11-01T15:00:00.000Z");
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" }, now: () => new Date(clock) }));
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    m.registry.setService(tenant.id, "touring");
    const ws = new PropertyWorkspace(join(tenantFolder(m.app.root, tenant.id), "tour-core"));
    const { config } = ws.save({ ...hillsideConfig(), messagingProvider: "local" });
    ws.recordReadiness(config.property.id, await runReadinessCheck(config, { now: new Date(), installed: { provider: "local" } }));
    publishForVisitors(ws, config.property.id, new Date());
    await m.touring()!.start(m.registry.get(tenant.id)!);
    const token = await m.joinAt(tenant.id, assistant, "/mcp");
    const warning = async () => (await m.toolAt("/mcp", token, "get_state")).structured?.warning as string | undefined;
    return { m, token, warning, advance: (ms: number) => void (clock += ms) };
  }

  it("is warned about after two and a half hours with no check, on ChatGPT", SLOW, async () => {
    const { m, token, warning, advance } = await published("chatgpt");
    await m.toolAt("/mcp", token, "save_alert_routine");
    await m.toolAt("/mcp", token, "get_updates");
    advance(2 * 3_600_000);
    expect(await warning()).toBeUndefined();
    advance(3_600_000);
    expect(await warning()).toMatch(WARNING);
  });

  it("never comes up for a Grok chat", SLOW, async () => {
    const { m, token, warning, advance } = await published("grok");
    await m.toolAt("/mcp", token, "get_updates");
    advance(5 * 3_600_000);
    expect(await warning()).toBeUndefined();
  });
});
