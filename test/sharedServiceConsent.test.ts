import { afterEach, describe, expect, it } from "vitest";
import { BASE, closeHostedApps, pkce } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/**
 * The Allow page takes the invite code and nothing else: a new account picks no service there. Its
 * chat adds properties and turns flows on with its own tools. Only 555 numbers.
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

describe("the Allow page", () => {
  it("asks for the invite code and offers no service pick, on either address, with touring on", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1", SUPPLY_CORE: "1" } }));
    for (const path of ["/mcp", "/mcp/cleaner-core"] as const) {
      const page = await allowPage(m, path);
      expect(page).not.toContain("What do you want to set up?");
      expect(page).not.toContain('name="service"');
    }
  });

  it("ignores a service posted with the invite: the account keeps no service, and lists the account tools", SLOW, async () => {
    const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } }));
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "claude", "/mcp", "touring");
    expect(m.registry.get(tenant.id)?.service).toBeUndefined();
    expect(await m.toolNames("/mcp", token)).toEqual(["add_property", "get_state", "set_flows"]);
    expect(m.touring()!.supervisor.target(tenant.id)).toBeUndefined();
  });
});
