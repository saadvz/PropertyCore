import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tenantFolder } from "../src/cleaner-core/hosted/registry";
import { readSupply, supplyAskOn } from "../src/supply-core/store";
import { BASE, closeHostedApps, pkce } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/**
 * Supply Core on the shared service: the supplies choice behind SUPPLY_CORE=1, and the add-on on a
 * cleaning tenant's Grok chat. Only 555 numbers, made-up stores and links; nothing reaches a store.
 */

const LANE = "+15555550150";
const COURT = "+15555550160";
const SLOW = { timeout: 90_000 };
const GROK_REDIRECT = "https://grok.com/connectors/oauth/callback";
const PROPERTY = { name: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" };
const towels = {
  name: "Paper towels",
  qtyPerOrder: 2,
  preferred: { title: "Example towels", store: "Example Mart", url: "https://shop.example/towels", packSize: "12 rolls", priceCents: 2400 },
  storeNote: "Cheapest per roll.",
  schedule: { kind: "every", days: 21 },
};

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

async function start(env: NodeJS.ProcessEnv = { SUPPLY_CORE: "1" }) {
  open = await multiTenantApp({ env });
  return open;
}

async function suppliesTenant(m: MultiTenantApp, number = LANE) {
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: number });
  m.registry.setService(tenant.id, "supplies");
  const token = await m.joinAt(tenant.id, "grok", "/mcp");
  return { tenant, token };
}

async function allowPage(m: MultiTenantApp) {
  const clientId = await m.app.register("grok", GROK_REDIRECT);
  const page = await m.app.authorize(clientId, pkce().challenge, `${BASE}/mcp`, "tourcore.operator", "state-1", GROK_REDIRECT);
  return page.text();
}

describe("the supplies choice", () => {
  it("offers Supply Core only with SUPPLY_CORE=1, on the Allow page and in get_state", SLOW, async () => {
    const m = await start();
    const page = await allowPage(m);
    expect(page).toContain('value="supplies"');
    expect(page).toContain("Supply Core: supplies reordered for a property");
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    const state = await m.toolAt("/mcp", token, "get_state");
    expect(state.structured?.say).toBe("Which do you want to set up: Cleaner Core or Supply Core?");
    open!.close();
    closeHostedApps();

    const off = await start({});
    expect(await allowPage(off)).not.toContain('value="supplies"');
    const other = off.registry.create({ label: "Court", twilioNumber: COURT });
    const offToken = await off.joinAt(other.tenant.id, "grok", "/mcp");
    expect((await off.toolAt("/mcp", offToken, "choose_service", { service: "supplies" })).isError).toBe(true);
  });

  it("choose_service with supplies sets the service", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const token = await m.joinAt(tenant.id, "grok", "/mcp");
    expect((await m.toolAt("/mcp", token, "choose_service", { service: "supplies" })).isError).toBe(false);
    expect(m.registry.get(tenant.id)?.service).toBe("supplies");
  });

  it("a supplies tenant lists Supply Core's tools, switch_service and stand_down_service, and no Cleaner Core tool", SLOW, async () => {
    const m = await start();
    const { token } = await suppliesTenant(m);
    const names = await m.toolNames("/mcp", token);
    for (const name of ["get_state", "save_supply_list", "save_supply_stores", "save_supply_item", "save_supply_sources", "check_cart", "record_order", "switch_service", "stand_down_service"]) expect(names).toContain(name);
    for (const name of ["check_now", "save_property", "get_supply_state", "turn_on_supplies"]) expect(names).not.toContain(name);
  });

  it("a supplies tenant's get_state is Supply Core's setup", SLOW, async () => {
    const m = await start();
    const { token } = await suppliesTenant(m);
    const state = await m.toolAt("/mcp", token, "get_state");
    expect((state.structured?.ask as { step: string }).step).toBe("property");
    expect((await m.toolAt("/mcp", token, "check_now")).isError).toBe(true);
  });

  it("two tenants never see each other's items, orders, or spending", SLOW, async () => {
    const m = await start();
    const a = await suppliesTenant(m, LANE);
    const b = await suppliesTenant(m, COURT);
    await m.toolAt("/mcp", a.token, "save_supply_settings", { property: PROPERTY });
    await m.toolAt("/mcp", a.token, "save_supply_item", towels);
    expect(readSupply(tenantFolder(m.app.root, a.tenant.id)).items).toHaveLength(1);
    expect(readSupply(tenantFolder(m.app.root, b.tenant.id)).items).toHaveLength(0);
    const bState = await m.toolAt("/mcp", b.token, "get_state");
    expect(bState.structured?.items).toEqual([]);
  });

  it("a text to a supplies tenant's number gets no reply", SLOW, async () => {
    const m = await start();
    await suppliesTenant(m);
    const res = await m.text(LANE, "+15555550199", "hello", "SMsupply1");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Response></Response>");
    expect(m.sms.sent).toEqual([]);
  });

  it("a tool call with a card-like argument is refused before the desk", SLOW, async () => {
    const m = await start();
    const { tenant, token } = await suppliesTenant(m);
    const reply = await m.toolAt("/mcp", token, "save_supply_settings", { property: { ...PROPERTY, name: "4242 4242 4242 4242" } });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("card");
    expect(existsSync(join(tenantFolder(m.app.root, tenant.id), "supply.json"))).toBe(false);
  });

  it("switching supplies to cleaning works with nothing live, and stand-down clears open carts", SLOW, async () => {
    const m = await start();
    const { tenant, token } = await suppliesTenant(m);
    await m.toolAt("/mcp", token, "save_supply_settings", { property: PROPERTY });
    await m.toolAt("/mcp", token, "save_supply_item", towels);
    await m.toolAt("/mcp", token, "save_supply_item", { done: true });
    await m.toolAt("/mcp", token, "save_supply_settings", { mode: "checkout", perOrderCapCents: null, perMonthCapCents: null, checkTime: "10:00", routineCreated: true });
    expect((await m.toolAt("/mcp", token, "activate_supplies")).isError).toBe(false);
    const itemId = readSupply(tenantFolder(m.app.root, tenant.id)).items[0]!.id;
    const held = await m.toolAt("/mcp", token, "check_cart", { store: "Example Mart", items: [{ itemId, product: "preferred", qty: 2, unitCents: 2400 }], shippingCents: 0, taxCents: 0, totalCents: 4800, deliveryBy: "2026-11-01" });
    expect(held.structured?.verdict).toBe("held");
    expect(readSupply(tenantFolder(m.app.root, tenant.id)).carts).toHaveLength(1);
    expect((await m.toolAt("/mcp", token, "stand_down_service")).isError).toBe(false);
    expect(readSupply(tenantFolder(m.app.root, tenant.id)).carts).toHaveLength(0);
    const ask = await m.toolAt("/mcp", token, "switch_service", { to: "cleaning" });
    const code = (ask.structured?.confirmation as { code: string }).code;
    expect((await m.toolAt("/mcp", token, "switch_service", { to: "cleaning", confirmation: code })).isError).toBe(false);
    expect(m.registry.get(tenant.id)?.service).toBe("cleaning");
  });
});

describe("the cleaning add-on", () => {
  it("a cleaning tenant on Grok sees turn_on_supplies; after it, Supply Core's tools join the list; Claude never sees them", SLOW, async () => {
    const m = await start({});
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const grok = await m.joinAt(tenant.id, "grok", "/mcp/cleaner-core");
    const claude = await m.joinAt(tenant.id, "claude", "/mcp/cleaner-core");
    const before = await m.toolNames("/mcp/cleaner-core", grok);
    expect(before).toContain("turn_on_supplies");
    expect(before).not.toContain("save_supply_item");
    expect(await m.toolNames("/mcp/cleaner-core", claude)).not.toContain("turn_on_supplies");
    expect((await m.toolAt("/mcp/cleaner-core", grok, "save_supply_item", towels)).text).toBe("Supply Core isn't on for this property.");

    expect((await m.toolAt("/mcp/cleaner-core", grok, "turn_on_supplies")).isError).toBe(false);
    const after = await m.toolNames("/mcp/cleaner-core", grok);
    for (const name of ["get_supply_state", "save_supply_item", "check_cart", "turn_off_supplies", "check_now"]) expect(after).toContain(name);
    for (const name of ["save_supply_sources", "turn_on_supplies"]) expect(after).not.toContain(name);
    const claudeAfter = await m.toolNames("/mcp/cleaner-core", claude);
    expect(claudeAfter).not.toContain("save_supply_item");
    expect(claudeAfter).not.toContain("turn_off_supplies");
  });

  it("Cleaner Core's get_state carries the supplies line once supplies are on", SLOW, async () => {
    const m = await start({});
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const grok = await m.joinAt(tenant.id, "grok", "/mcp/cleaner-core");
    expect((await m.toolAt("/mcp/cleaner-core", grok, "get_state")).structured?.supplies).toBeUndefined();
    await m.toolAt("/mcp/cleaner-core", grok, "turn_on_supplies");
    expect((await m.toolAt("/mcp/cleaner-core", grok, "get_state")).structured?.supplies).toBe("Supplies: setup not finished.");
  });

  it("turn_off_supplies takes two calls; the tools leave the list", SLOW, async () => {
    const m = await start({});
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const grok = await m.joinAt(tenant.id, "grok", "/mcp/cleaner-core");
    await m.toolAt("/mcp/cleaner-core", grok, "turn_on_supplies");
    const ask = await m.toolAt("/mcp/cleaner-core", grok, "turn_off_supplies");
    expect(m.registry.get(tenant.id)?.supplies).toBe(true);
    const code = (ask.structured?.confirmation as { code: string }).code;
    expect((await m.toolAt("/mcp/cleaner-core", grok, "turn_off_supplies", { confirmation: code })).isError).toBe(false);
    expect(m.registry.get(tenant.id)?.supplies).toBe(false);
    expect(await m.toolNames("/mcp/cleaner-core", grok)).not.toContain("save_supply_item");
    expect(readSupply(tenantFolder(m.app.root, tenant.id)).offAt).toBeDefined();
  });
});

describe("Grok only, and switching away", () => {
  it("doesn't offer Supply Core to a Claude chat, and a Claude chat on a supplies tenant gets no supply tools", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const claude = await m.joinAt(tenant.id, "claude", "/mcp");
    const state = await m.toolAt("/mcp", claude, "get_state");
    expect(JSON.stringify(state.structured)).not.toContain("supplies");
    expect((await m.toolAt("/mcp", claude, "choose_service", { service: "supplies" })).isError).toBe(true);
    const clientId = await m.app.register("claude", "https://claude.ai/api/mcp/auth_callback");
    const page = await (await m.app.authorize(clientId, pkce().challenge, `${BASE}/mcp`, "tourcore.operator", "state-1", "https://claude.ai/api/mcp/auth_callback")).text();
    expect(page).not.toContain('value="supplies"');

    const other = m.registry.create({ label: "Court", twilioNumber: COURT });
    m.registry.setService(other.tenant.id, "supplies");
    const claudeOnSupplies = await m.joinAt(other.tenant.id, "claude", "/mcp");
    const names = await m.toolNames("/mcp", claudeOnSupplies);
    expect(names).not.toContain("save_supply_item");
    expect((await m.toolAt("/mcp", claudeOnSupplies, "save_supply_item", towels)).isError).toBe(true);
  });

  it("switching supplies to cleaning turns the supplies question off and keeps the list", SLOW, async () => {
    const m = await start();
    const { tenant, token } = await suppliesTenant(m);
    await m.toolAt("/mcp", token, "save_supply_settings", { property: PROPERTY });
    await m.toolAt("/mcp", token, "save_supply_item", towels);
    await m.toolAt("/mcp", token, "save_supply_item", { done: true });
    await m.toolAt("/mcp", token, "save_supply_settings", { mode: "checkout", perOrderCapCents: null, perMonthCapCents: null, checkTime: "10:00", routineCreated: true });
    await m.toolAt("/mcp", token, "activate_supplies");
    const ask = await m.toolAt("/mcp", token, "switch_service", { to: "cleaning" });
    await m.toolAt("/mcp", token, "switch_service", { to: "cleaning", confirmation: (ask.structured?.confirmation as { code: string }).code });
    const root = tenantFolder(m.app.root, tenant.id);
    expect(supplyAskOn(root)).toBe(false);
    expect(readSupply(root).items).toHaveLength(1);
  });

  it("switching a cleaning tenant with the add-on to supplies keeps the property's details", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const grok = await m.joinAt(tenant.id, "grok", "/mcp/cleaner-core");
    await m.toolAt("/mcp/cleaner-core", grok, "get_state", { choice: "cleaners" });
    await m.toolAt("/mcp/cleaner-core", grok, "save_property", { business: "Scratch", nickname: "Lake House", address: PROPERTY.address, timeZone: PROPERTY.timeZone, checkoutTime: "11:00", checkInTime: "16:00" });
    await m.toolAt("/mcp/cleaner-core", grok, "turn_on_supplies");
    const ask = await m.toolAt("/mcp/cleaner-core", grok, "switch_service", { to: "supplies" });
    const switched = await m.toolAt("/mcp/cleaner-core", grok, "switch_service", { to: "supplies", confirmation: (ask.structured?.confirmation as { code: string }).code });
    expect(switched.isError).toBe(false);
    expect(readSupply(tenantFolder(m.app.root, tenant.id)).settings.property).toEqual({ name: "Lake House", address: PROPERTY.address, timeZone: PROPERTY.timeZone });
  });
});

describe("setup through the tools", () => {
  it("takes the address, the whole list, and the store plan before any product", SLOW, async () => {
    const m = await start();
    const { tenant, token } = await suppliesTenant(m);
    expect((await m.toolAt("/mcp", token, "save_supply_settings", { property: { address: PROPERTY.address, timeZone: PROPERTY.timeZone } })).isError).toBe(false);
    expect((await m.toolAt("/mcp", token, "save_supply_list", { names: ["Paper towels", "Dish soap"] })).isError).toBe(false);
    expect(((await m.toolAt("/mcp", token, "get_state")).structured?.ask as { step: string }).step).toBe("stores");
    expect((await m.toolAt("/mcp", token, "save_supply_stores", { primary: { name: "Example Mart", channel: "shipping" }, fast: { name: "Example Now", channel: "same-day" } })).isError).toBe(false);
    expect(((await m.toolAt("/mcp", token, "get_state")).structured?.ask as { step: string }).step).toBe("products");
    expect((await m.toolAt("/mcp", token, "save_supply_item", { ...towels, storeNote: undefined })).isError).toBe(false);
    expect(readSupply(tenantFolder(m.app.root, tenant.id)).draft).toEqual(["Dish soap"]);
  });

  it("tells Grok to call the connection Supply Core", SLOW, async () => {
    const m = await start();
    const { token } = await suppliesTenant(m);
    const init = await m.rpcAt("/mcp", token, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "grok", version: "1" } });
    expect(String((init.json.result as { instructions?: string }).instructions)).toContain("Call this connection Supply Core");
  });
});
