import { afterEach, describe, expect, it } from "vitest";
import { SERVICE_CHOICES } from "../src/hosted/serviceTools";
import { BASE, closeHostedApps, pkce } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/**
 * The service pick on the shared address's Allow page, next to the invite code: the first chat a host
 * opens already has its service's tools, so Claude and ChatGPT, which keep a chat's first tool list,
 * need no new chat. Only 555 numbers.
 */

const LANE = "+15555550150";
const SLOW = { timeout: 90_000 };
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

/** The Allow page for a Claude chat at an address. */
async function allowPage(m: MultiTenantApp, path: "/mcp" | "/mcp/cleaner-core") {
  const clientId = await m.app.register("claude", CLAUDE_REDIRECT);
  const page = await m.app.authorize(clientId, pkce().challenge, `${BASE}${path}`, path === "/mcp" ? "tourcore.operator" : "cleaner.operator", "state-1", CLAUDE_REDIRECT);
  return page.text();
}

describe("the Allow page's service pick", () => {
  it("offers Tour Core and Cleaner Core on the shared address, and nothing on the cleaning address", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const shared = await allowPage(m, "/mcp");
    expect(shared).toContain("What do you want to set up?");
    for (const choice of SERVICE_CHOICES) expect(shared).toContain(`value="${choice.service}"`);
    for (const choice of SERVICE_CHOICES) expect(shared).toContain(choice.label);
    expect(await allowPage(m, "/mcp/cleaner-core")).not.toContain("What do you want to set up?");
  });

  it("offers no pick while touring is off, since cleaning is the only service", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: {} }));
    expect(await allowPage(m, "/mcp")).not.toContain("What do you want to set up?");
  });

  it("sets the picked service as the chat connects, so its first tool list is touring's", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "claude", "/mcp", "touring");
    expect(m.registry.get(tenant.id)?.service).toBe("touring");
    const names = await m.toolNames("/mcp", token);
    expect(names).toEqual(expect.arrayContaining(["backup_records", "save_alert_routine", "save_host_texts"]));
    expect(names).not.toContain("choose_service");
  });

  it("sets cleaning the same way", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    await m.joinAt(tenant.id, "chatgpt", "/mcp", "cleaning");
    expect(m.registry.get(tenant.id)?.service).toBe("cleaning");
  });

  it("leaves the choice to the chat when nothing was picked", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "claude", "/mcp");
    expect(m.registry.get(tenant.id)?.service).toBeUndefined();
    expect(await m.toolNames("/mcp", token)).toEqual(["choose_service", "get_state"]);
  });

  it("never switches a number that already has a service", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    m.registry.setService(tenant.id, "cleaning");
    await m.joinAt(tenant.id, "claude", "/mcp", "touring");
    expect(m.registry.get(tenant.id)?.service).toBe("cleaning");
  });

  it("ignores a pick it doesn't know", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    await m.joinAt(tenant.id, "claude", "/mcp", "everything" as "touring");
    expect(m.registry.get(tenant.id)?.service).toBeUndefined();
  });
});
