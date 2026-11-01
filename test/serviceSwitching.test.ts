import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tenantFolder } from "../src/cleaner-core/hosted/registry";
import { switchService, type LiveReport } from "../src/hosted/service";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/**
 * Switching a number between touring and cleaning: only when nothing is live, with the host's yes,
 * and with no texts. Touring tenants run a real touring process. Only 555 numbers.
 */

const LANE = "+15555550150";
const SLOW = { timeout: 120_000 };

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

async function start() {
  open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } });
  return open;
}

async function chosen(m: MultiTenantApp, service: "touring" | "cleaning") {
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
  const token = await m.joinAt(tenant.id, "grok", "/mcp");
  await m.toolAt("/mcp", token, "choose_service", { service });
  return { tenant, token };
}

/** Asks, then answers yes with the code. */
async function switchTo(m: MultiTenantApp, token: string, to: "touring" | "cleaning") {
  const asked = await m.toolAt("/mcp", token, "switch_service", { to });
  const code = (asked.structured?.confirmation as { code?: string } | undefined)?.code;
  expect(code, asked.text).toBeDefined();
  return { asked, done: await m.toolAt("/mcp", token, "switch_service", { to, confirmation: code }) };
}

const installationId = (m: MultiTenantApp, tenantId: string) =>
  (JSON.parse(readFileSync(join(tenantFolder(m.app.root, tenantId), "tour-core", "install", "manifest.json"), "utf8")) as { installationId: string }).installationId;

describe("switching a number's service", () => {
  it("switches a quiet touring number to cleaning with no texts, and back to the same Tour Core", SLOW, async () => {
    const m = await start();
    const { tenant, token } = await chosen(m, "touring");
    const before = installationId(m, tenant.id);
    const { asked, done } = await switchTo(m, token, "cleaning");
    expect(asked.text).toBe("Switch this number from touring to cleaning? Touring stops answering texts. Its setup is kept, so you can switch back later. Reply yes to switch.");
    expect(done.text).toBe("Set up for cleaning. Your tools have changed. If you don't see the new ones, start a new chat.");
    expect(m.registry.get(tenant.id)?.service).toBe("cleaning");
    expect(m.touring()!.supervisor.target(tenant.id)).toBeUndefined();
    expect(await m.toolNames("/mcp", token)).toEqual(expect.arrayContaining(["save_property", "switch_service"]));

    const back = await switchTo(m, token, "touring");
    expect(back.done.isError).toBe(false);
    expect(m.registry.get(tenant.id)?.service).toBe("touring");
    expect(m.touring()!.supervisor.target(tenant.id)).toBeDefined();
    expect(installationId(m, tenant.id)).toBe(before);
    expect(m.sms.sent).toEqual([]);
  });

  it("refuses to switch to the service the number already runs", SLOW, async () => {
    const m = await start();
    const { token } = await chosen(m, "cleaning");
    const same = await m.toolAt("/mcp", token, "switch_service", { to: "cleaning" });
    expect(same.isError).toBe(true);
    expect(same.text).toBe("This number is already set up for cleaning.");
  });

  it("refuses a code the host wasn't given", SLOW, async () => {
    const m = await start();
    const { tenant, token } = await chosen(m, "cleaning");
    const refused = await m.toolAt("/mcp", token, "switch_service", { to: "touring", confirmation: "made-up-code" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe("That approval has expired or doesn't match. Ask the host again.");
    expect(m.registry.get(tenant.id)?.service).toBe("cleaning");
  });

  it("refuses to switch when the touring process isn't answering", SLOW, async () => {
    const m = await start();
    const { tenant, token } = await chosen(m, "touring");
    m.touring()!.supervisor.stop(tenant.id);
    const refused = await m.toolAt("/mcp", token, "switch_service", { to: "cleaning" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe("Touring isn't answering right now. Try again in a minute.");
    expect(m.registry.get(tenant.id)?.service).toBe("touring");
  });

  it("says nothing is live when touring has nothing to stand down", SLOW, async () => {
    const m = await start();
    const { token } = await chosen(m, "touring");
    const reply = await m.toolAt("/mcp", token, "stand_down_service");
    expect(reply.isError).toBe(false);
    expect(reply.text).toBe("Nothing is live on touring, so there's nothing to stand down. You can switch now.");
  });

  it("records each switch in the tenant's service audit", SLOW, async () => {
    const m = await start();
    const { tenant, token } = await chosen(m, "cleaning");
    await switchTo(m, token, "touring");
    const audit = readFileSync(join(tenantFolder(m.app.root, tenant.id), "service-audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit.at(-1)).toMatchObject({ actor: "host", from: "cleaning", to: "touring", forced: false });
  });
});

describe("switchService's live check", () => {
  const live = (report: LiveReport | "unreachable") => async () => report;

  it("lists what's still live and points to stand_down_service", async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    m.registry.setService(tenant.id, "cleaning");
    const reply = await switchService(
      { h: m.hosted(), tenant: m.registry.get(tenant.id)!, actor: "host", noteToolsChanged: () => {} },
      { to: "touring" },
      { live: live({ live: ["The cleaning for checkout on 2026-10-18 is confirmed."], inProgress: false, texts: [] }) },
    );
    expect(reply.isError).toBe(true);
    expect(reply.text).toBe("Cleaning is still live, so the number can't switch yet:\n- The cleaning for checkout on 2026-10-18 is confirmed.\nCall stand_down_service to stop it first. Its setup is kept.");
    expect(m.registry.get(tenant.id)?.service).toBe("cleaning");
  });

  it("switches with force even when live, and sends nothing", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    m.registry.setService(tenant.id, "cleaning");
    const reply = await switchService(
      { h: m.hosted(), tenant: m.registry.get(tenant.id)!, actor: "admin", noteToolsChanged: () => {} },
      { to: "touring", force: true },
      { live: live({ live: ["The cleaning for checkout on 2026-10-18 is confirmed."], inProgress: false, texts: [] }) },
    );
    expect(reply.isError).toBe(false);
    expect(m.registry.get(tenant.id)?.service).toBe("touring");
    expect(m.sms.sent).toEqual([]);
    expect(existsSync(join(tenantFolder(m.app.root, tenant.id), "service-audit.jsonl"))).toBe(true);
  });

  it("drops texts still waiting for touring when the number switches away", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    m.registry.setService(tenant.id, "touring");
    m.touring()!.inbox.save(tenant.id, Buffer.from(new URLSearchParams({ MessageSid: "SMw1", From: "+15555550177", To: LANE, Body: "TOUR" }).toString()));
    const reply = await switchService({ h: m.hosted(), tenant: m.registry.get(tenant.id)!, actor: "admin", noteToolsChanged: () => {} }, { to: "cleaning", force: true });
    expect(reply.isError).toBe(false);
    expect(m.touring()!.inbox.pending(tenant.id)).toEqual([]);
    expect(m.app.logs.join("\n")).toContain(`1 text waiting for ${tenant.id}'s touring was dropped by the switch.`);
  });
});
