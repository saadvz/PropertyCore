import { afterEach, describe, expect, it } from "vitest";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/**
 * One address for both services: the tenant's service decides the tools, and the number answers for
 * that service only. Touring tenants run a real touring process. Only 555 numbers, so every touring
 * text stays in that process's local outbox.
 */

const LANE = "+15555550150";
const COURT = "+15555550160";
const VISITOR = "+15555550177";
const SLOW = { timeout: 90_000 };

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

async function start(env: NodeJS.ProcessEnv = { TOUR_CORE_TENANTS: "1" }) {
  open = await multiTenantApp({ env });
  return open;
}

describe("one address, tools by service", () => {
  it("shows a tenant with no service only get_state and choose_service", async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    expect(await m.toolNames("/mcp", token)).toEqual(["choose_service", "get_state"]);
    const state = await m.toolAt("/mcp", token, "get_state");
    // One question with two choices, so the chat can offer them as buttons the moment it connects.
    expect(state.structured?.say).toBe("Which do you want to set up: Tour Core or Cleaner Core?");
    expect(state.structured?.choices).toEqual([
      { label: "Tour Core: self-guided tours for a rental unit", service: "touring" },
      { label: "Cleaner Core: a cleaner for a property", service: "cleaning" },
    ]);
    // A chat that only reads its tool list still gets the question and both choices.
    const listed = await m.rpcAt("/mcp", token, "tools/list", {});
    const tools = (listed.json.result as { tools: { name: string; description: string }[] }).tools;
    for (const tool of tools) {
      expect(tool.description, tool.name).toContain('ask the host exactly "Which do you want to set up: Tour Core or Cleaner Core?"');
      expect(tool.description, tool.name).toContain("Cleaner Core: a cleaner for a property");
    }
  });

  it("answers initialize for a tenant with no service, asking the question as soon as it connects", async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    const init = await m.rpcAt("/mcp", token, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Grok", version: "1" } });
    expect(JSON.stringify(init.json.result)).toContain("As soon as you're connected, without waiting for the host to ask, ask exactly");
  });

  it("turns a tenant into a touring tenant and lists Tour Core's tools", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    const chosen = await m.toolAt("/mcp", token, "choose_service", { service: "touring" });
    expect(chosen.text).toBe("Set up for touring. Your tools have changed. If you don't see the new ones, start a new chat.");
    expect(m.registry.get(tenant.id)?.service).toBe("touring");
    const names = await m.toolNames("/mcp", token);
    expect(names).toEqual(expect.arrayContaining(["get_state", "pause_tours", "save_alert_routine", "switch_service", "stand_down_service"]));
    expect(names).not.toContain("choose_service");
    expect(names).not.toContain("save_door_code");
  });

  it("refuses to choose a second time", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    await m.toolAt("/mcp", token, "choose_service", { service: "cleaning" });
    const again = await m.toolAt("/mcp", token, "choose_service", { service: "touring" });
    expect(again.text).toContain("This number is set up for cleaning now. Start a new chat to see its tools.");
  });

  it("keeps an existing cleaning host working on /mcp/cleaner-core, and picks cleaning for a new one there", async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Court", twilioNumber: COURT });
    const token = await m.join(tenant.id, "grok");
    const state = await m.tool(token, "get_state");
    expect(state.isError).toBe(false);
    expect(m.registry.get(tenant.id)?.service).toBe("cleaning");
    expect(await m.toolNames("/mcp/cleaner-core", token)).toEqual(expect.arrayContaining(["save_property", "switch_service", "stand_down_service"]));
  });

  it("goes straight to cleaning setup after choosing cleaning, without asking tours or cleaners again", async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    await m.toolAt("/mcp", token, "choose_service", { service: "cleaning" });
    const state = await m.toolAt("/mcp", token, "get_state");
    expect(state.isError).toBe(false);
    expect(state.text).not.toContain("Letting renters tour a unit");
    expect((state.structured?.ask as { step?: string } | undefined)?.step).toBe("property");
  });

  it("asks nothing about Tour Core on connect while TOUR_CORE_TENANTS is off", async () => {
    const m = await start({});
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    const init = await m.rpcAt("/mcp", token, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Grok", version: "1" } });
    expect(JSON.stringify(init.json.result)).not.toContain("Tour Core: self-guided tours");
    const listed = await m.rpcAt("/mcp", token, "tools/list", {});
    expect(JSON.stringify(listed.json.result)).not.toContain("Tour Core: self-guided tours");
  });

  it("offers only cleaning while TOUR_CORE_TENANTS is off", async () => {
    const m = await start({});
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    const state = await m.toolAt("/mcp", token, "get_state");
    expect(state.text).not.toContain("touring");
    expect(state.text).toContain("Call choose_service with cleaning.");
    const refused = await m.toolAt("/mcp", token, "choose_service", { service: "touring" });
    expect(refused.isError).toBe(true);
    expect(m.registry.get(tenant.id)?.service).toBeUndefined();
  });

  it("refuses a cleaning tool on a touring tenant with the start-a-new-chat line", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    await m.toolAt("/mcp", token, "choose_service", { service: "touring" });
    const refused = await m.toolAt("/mcp", token, "save_door_code", {});
    expect(refused.text).toBe("This number is set up for touring now. Start a new chat to see its tools.");
  });

  it("gives a touring tool call to the touring process", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    await m.toolAt("/mcp", token, "choose_service", { service: "touring" });
    const state = await m.toolAt("/mcp", token, "get_state");
    expect(state.isError).toBe(false);
    expect(state.text).toContain("milestones");
  });
});

describe("texts by service", () => {
  it("hands a text for a touring tenant to its process, and keeps nothing queued", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    await m.toolAt("/mcp", token, "choose_service", { service: "touring" });
    const res = await m.text(LANE, VISITOR, "Tour", "SMlane0001");
    expect(res.status).toBe(200);
    expect(m.touring()!.inbox.pending(tenant.id)).toEqual([]);
  });

  it("answers nothing to a text for a tenant with no service", async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const res = await m.text(LANE, VISITOR, "Tour", "SMlane0002");
    expect(res.status).toBe(200);
    expect(m.sms.sent).toEqual([]);
    expect(m.app.logs.join("\n")).toContain(`A text reached ${tenant.id}, which has no service yet. Nothing was sent.`);
  });

  it("refuses a touring text with a bad signature and queues nothing", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    await m.toolAt("/mcp", token, "choose_service", { service: "touring" });
    const res = await m.twilio("/webhooks/twilio/cleaner-core", { MessageSid: "SMbad", From: VISITOR, To: LANE, Body: "Tour" }, "/somewhere-else");
    expect(res.status).toBe(403);
    expect(m.touring()!.inbox.pending(tenant.id)).toEqual([]);
  });

  it("queues a touring text while its process is down, and hands it over when it is back", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    await m.toolAt("/mcp", token, "choose_service", { service: "touring" });
    const touring = m.touring()!;
    touring.supervisor.stop(tenant.id);
    expect((await m.text(LANE, VISITOR, "Tour", "SMlane0003")).status).toBe(200);
    expect(touring.inbox.pending(tenant.id)).toHaveLength(1);
    await touring.start(m.registry.get(tenant.id)!);
    expect(touring.inbox.pending(tenant.id)).toEqual([]);
  });
});
