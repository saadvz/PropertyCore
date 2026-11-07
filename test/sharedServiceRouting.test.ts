import { afterEach, describe, expect, it } from "vitest";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/**
 * One address for every account: an account of properties gets the property tools, and a parked
 * touring account its touring process. Touring accounts run a real touring process. Only 555 numbers,
 * so every touring text stays in that process's local outbox.
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
  it("shows a new account the account tools and no service choice", async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    expect(await m.toolNames("/mcp", token)).toEqual(["add_property", "get_state", "set_flows"]);
    const state = await m.toolAt("/mcp", token, "get_state");
    expect(state.structured).toMatchObject({ properties: [], next: "Ask the host for the property's address, then call add_property with it." });
  });

  it("answers initialize by asking for get_state first, never for a service", async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    const init = JSON.stringify((await m.rpcAt("/mcp", token, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Grok", version: "1" } })).json.result);
    expect(init).toContain("Call get_state first.");
    expect(init).not.toContain("Which do you want to set up");
    expect(init).not.toContain("Tour Core: self-guided tours");
  });

  it("lists Tour Core's tools for a touring account, without the property tools or a switch", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    await m.makeTouring(tenant.id);
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    const names = await m.toolNames("/mcp", token);
    expect(names).toEqual(expect.arrayContaining(["get_state", "pause_tours", "save_alert_routine"]));
    for (const name of ["choose_service", "switch_service", "stand_down_service", "add_property", "set_flows", "save_door_code"]) expect(names).not.toContain(name);
  });

  it("keeps an existing cleaning host working on /mcp/cleaner-core", async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Court", twilioNumber: COURT });
    const property = m.registry.addProperty(tenant.id, "8 Scratch Court");
    m.registry.setFlow(tenant.id, property.id, "cleaning", true);
    const token = await m.join(tenant.id, "grok");
    const state = await m.tool(token, "get_state");
    expect(state.isError).toBe(false);
    expect(await m.toolNames("/mcp/cleaner-core", token)).toEqual(expect.arrayContaining(["save_property", "set_flows", "add_property"]));
  });

  it("goes straight to cleaning setup once cleaning is on, without asking tours or cleaners", async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    const added = await m.toolAt("/mcp", token, "add_property", { label: "12 Scratch Lane" });
    await m.toolAt("/mcp", token, "set_flows", { property: (added.structured?.property as { id: string }).id, cleaning: true });
    const state = await m.toolAt("/mcp", token, "get_state");
    expect(state.isError).toBe(false);
    expect(state.text).not.toContain("Letting renters tour a unit");
    expect((state.structured?.ask as { step?: string } | undefined)?.step).toBe("property");
  });

  it("asks nothing about Tour Core while TOUR_CORE_TENANTS is off", async () => {
    const m = await start({});
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    const init = await m.rpcAt("/mcp", token, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Grok", version: "1" } });
    expect(JSON.stringify(init.json.result)).not.toContain("Tour Core: self-guided tours");
    const listed = await m.rpcAt("/mcp", token, "tools/list", {});
    expect(JSON.stringify(listed.json.result)).not.toContain("Tour Core: self-guided tours");
  });

  it("refuses a cleaning tool on a touring tenant with the start-a-new-chat line", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    await m.makeTouring(tenant.id);
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    const refused = await m.toolAt("/mcp", token, "save_door_code", {});
    expect(refused.text).toBe("This number is set up for touring now. Start a new chat to see its tools.");
  });

  it("gives a touring tool call to the touring process", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    await m.makeTouring(tenant.id);
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    const state = await m.toolAt("/mcp", token, "get_state");
    expect(state.isError).toBe(false);
    expect(state.text).toContain("milestones");
  });
});

describe("texts by service", () => {
  it("hands a text for a touring tenant to its process, and keeps nothing queued", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    await m.makeTouring(tenant.id);
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    const res = await m.text(LANE, VISITOR, "Tour", "SMlane0001");
    expect(res.status).toBe(200);
    expect(m.touring()!.inbox.pending(tenant.id)).toEqual([]);
  });

  it("answers nothing to a text for an account with no property running Cleaner Core", async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const res = await m.text(LANE, VISITOR, "Tour", "SMlane0002");
    expect(res.status).toBe(200);
    expect(m.sms.sent).toEqual([]);
    expect(m.app.logs.join("\n")).toContain(`A text reached ${tenant.id}'s line from someone on no property. Nothing was sent.`);
  });

  it("refuses a touring text with a bad signature and queues nothing", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    await m.makeTouring(tenant.id);
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    const res = await m.twilio("/webhooks/twilio/cleaner-core", { MessageSid: "SMbad", From: VISITOR, To: LANE, Body: "Tour" }, "/somewhere-else");
    expect(res.status).toBe(403);
    expect(m.touring()!.inbox.pending(tenant.id)).toEqual([]);
  });

  it("queues a touring text while its process is down, and hands it over when it is back", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    await m.makeTouring(tenant.id);
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    const touring = m.touring()!;
    touring.supervisor.stop(tenant.id);
    expect((await m.text(LANE, VISITOR, "Tour", "SMlane0003")).status).toBe(200);
    expect(touring.inbox.pending(tenant.id)).toHaveLength(1);
    await touring.start(m.registry.get(tenant.id)!);
    expect(touring.inbox.pending(tenant.id)).toEqual([]);
  });
});
