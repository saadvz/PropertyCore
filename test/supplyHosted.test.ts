import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { propertyFolder, type Property } from "../src/cleaner-core/hosted/properties";
import type { Tenant } from "../src/cleaner-core/hosted/registry";
import { readSupply } from "../src/supply-core/store";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/**
 * Supply Core on the shared service, per property: on its own behind SUPPLY_CORE=1, and beside
 * Cleaner Core at the same property. Grok only. Only 555 numbers, made-up stores and links; nothing
 * reaches a store.
 */

const LANE = "+15555550150";
const COURT = "+15555550160";
const SLOW = { timeout: 90_000 };
const PATH = "/mcp";
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

/** An account whose one property runs Supply Core on its own, joined by a Grok chat. */
async function suppliesAccount(m: MultiTenantApp, number = LANE) {
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: number });
  const property = m.registry.addProperty(tenant.id, "12 Scratch Lane");
  m.registry.setFlow(tenant.id, property.id, "supplies", true);
  const token = await m.joinAt(tenant.id, "grok", PATH);
  return { tenant, property, token };
}

const folder = (m: MultiTenantApp, tenant: Tenant, property: Property) => propertyFolder(m.app.root, tenant.id, property);

describe("turning Supply Core on", () => {
  it("set_flows turns it on for a Grok chat; on its own only with SUPPLY_CORE=1", SLOW, async () => {
    const m = await start({});
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const lane = m.registry.addProperty(tenant.id, "12 Scratch Lane");
    const grok = await m.joinAt(tenant.id, "grok", PATH);
    const alone = await m.toolAt(PATH, grok, "set_flows", { property: lane.id, supplies: true });
    expect(alone.isError).toBe(true);
    expect(alone.text).toContain("Turn on Cleaner Core for this property first.");
    await m.toolAt(PATH, grok, "set_flows", { property: lane.id, cleaning: true });
    expect((await m.toolAt(PATH, grok, "set_flows", { property: lane.id, supplies: true })).isError).toBe(false);
    expect(m.registry.get(tenant.id)?.properties[0]?.flows.supplies.on).toBe(true);
  });

  it("refuses a chat that isn't Grok", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const lane = m.registry.addProperty(tenant.id, "12 Scratch Lane");
    const claude = await m.joinAt(tenant.id, "claude", PATH);
    const refused = await m.toolAt(PATH, claude, "set_flows", { property: lane.id, supplies: true });
    expect(refused).toMatchObject({ isError: true, text: "Supply Core works with Grok only for now: it shops with Grok's own shopping tools and Vault." });
    expect(m.registry.get(tenant.id)?.properties[0]?.flows.supplies.on).toBe(false);
  });
});

describe("a property running Supply Core on its own", () => {
  it("lists Supply Core's tools and no Cleaner Core tool", SLOW, async () => {
    const m = await start();
    const { token } = await suppliesAccount(m);
    const names = await m.toolNames(PATH, token);
    expect(names).toEqual(expect.arrayContaining(["get_state", "get_supply_state", "save_supply_item", "check_cart", "set_flows"]));
    for (const name of ["save_people", "save_door_code", "choose_supplies", "switch_service"]) expect(names).not.toContain(name);
  });

  it("get_state is Supply Core's setup", SLOW, async () => {
    const m = await start();
    const { token } = await suppliesAccount(m);
    const state = await m.toolAt(PATH, token, "get_state");
    expect((state.structured?.ask as { step: string }).step).toBe("property");
    expect(state.structured?.properties).toHaveLength(1);
  });

  it("two accounts never see each other's items, orders, or spending", SLOW, async () => {
    const m = await start();
    const a = await suppliesAccount(m, LANE);
    const b = await suppliesAccount(m, COURT);
    await m.toolAt(PATH, a.token, "save_supply_settings", { property: PROPERTY });
    await m.toolAt(PATH, a.token, "save_supply_item", towels);
    expect(readSupply(folder(m, a.tenant, a.property)).items).toHaveLength(1);
    expect(readSupply(folder(m, b.tenant, b.property)).items).toHaveLength(0);
    const bState = await m.toolAt(PATH, b.token, "get_supply_state");
    expect(bState.structured?.items).toEqual([]);
  });

  it("a text to its line gets no reply", SLOW, async () => {
    const m = await start();
    await suppliesAccount(m);
    const res = await m.text(LANE, "+15555550199", "hello", "SMsupply1");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Response></Response>");
    expect(m.sms.sent).toEqual([]);
  });

  it("a tool call with a card-like argument is refused before the desk", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await suppliesAccount(m);
    const reply = await m.toolAt(PATH, token, "save_supply_settings", { property: { ...PROPERTY, name: "4242 4242 4242 4242" } });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("card");
    expect(existsSync(join(folder(m, tenant, property), "supply.json"))).toBe(false);
  });

  it("takes the address, the whole list, and the store plan before any product", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await suppliesAccount(m);
    expect((await m.toolAt(PATH, token, "save_supply_settings", { property: { address: PROPERTY.address, timeZone: PROPERTY.timeZone } })).isError).toBe(false);
    expect((await m.toolAt(PATH, token, "save_supply_list", { names: ["Paper towels", "Dish soap"] })).isError).toBe(false);
    expect(((await m.toolAt(PATH, token, "get_state")).structured?.ask as { step: string }).step).toBe("stores");
    expect((await m.toolAt(PATH, token, "save_supply_stores", { primary: { name: "Example Mart", channel: "shipping" }, fast: { name: "Example Now", channel: "same-day" } })).isError).toBe(false);
    expect(((await m.toolAt(PATH, token, "get_state")).structured?.ask as { step: string }).step).toBe("schedule");
    expect((await m.toolAt(PATH, token, "save_supply_settings", { sharedSchedule: { kind: "every", days: 21 } })).isError).toBe(false);
    expect((await m.toolAt(PATH, token, "save_supply_item", { ...towels, storeNote: undefined, schedule: undefined })).isError).toBe(false);
    expect(readSupply(folder(m, tenant, property)).draft).toEqual(["Dish soap"]);
  });
});

describe("two properties", () => {
  it("save_supply_settings names its property with propertyId, beside its own property field", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await suppliesAccount(m);
    const court = m.registry.addProperty(tenant.id, "8 Scratch Court");
    m.registry.setFlow(tenant.id, court.id, "supplies", true);
    const listed = await m.rpcAt(PATH, token, "tools/list");
    const settings = ((listed.json.result?.tools ?? []) as { name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }[]).find((t) => t.name === "save_supply_settings")!;
    expect(settings.inputSchema.properties).toHaveProperty("propertyId");
    expect(settings.inputSchema.required).toContain("propertyId");
    const saved = await m.toolAt(PATH, token, "save_supply_settings", { propertyId: court.id, property: PROPERTY });
    expect(saved.isError).toBe(false);
    expect(readSupply(folder(m, tenant, court)).settings.property).toEqual(PROPERTY);
    expect(readSupply(folder(m, tenant, property)).settings.property).toBeUndefined();
    expect((await m.toolAt(PATH, token, "save_supply_settings", { property: PROPERTY })).text).toContain("Which property?");
  });
});

describe("beside Cleaner Core", () => {
  it("Cleaner Core's get_state carries the supplies line once supplies are on", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const lane = m.registry.addProperty(tenant.id, "12 Scratch Lane");
    m.registry.setFlow(tenant.id, lane.id, "cleaning", true);
    const grok = await m.joinAt(tenant.id, "grok", PATH);
    expect((await m.toolAt(PATH, grok, "get_state")).structured?.supplies).toBeUndefined();
    await m.toolAt(PATH, grok, "set_flows", { property: lane.id, supplies: true });
    expect((await m.toolAt(PATH, grok, "get_state")).structured?.supplies).toBe("Supplies: setup not finished.");
  });

  it("a Claude chat never sees Supply Core's tools or choose_supplies", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const lane = m.registry.addProperty(tenant.id, "12 Scratch Lane");
    m.registry.setFlow(tenant.id, lane.id, "cleaning", true);
    m.registry.setFlow(tenant.id, lane.id, "supplies", true);
    const claude = await m.joinAt(tenant.id, "claude", PATH);
    const names = await m.toolNames(PATH, claude);
    expect(names).toContain("save_property");
    for (const name of ["get_supply_state", "save_supply_item", "choose_supplies"]) expect(names).not.toContain(name);
  });

  it("choose_supplies: Yes turns Supply Core on; Not now leaves it off; Grok sees it before Supply Core is on", SLOW, async () => {
    const m = await start({});
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const lane = m.registry.addProperty(tenant.id, "12 Scratch Lane");
    m.registry.setFlow(tenant.id, lane.id, "cleaning", true);
    const grok = await m.joinAt(tenant.id, "grok", "/mcp/cleaner-core");
    expect(await m.toolNames("/mcp/cleaner-core", grok)).toContain("choose_supplies");
    const no = await m.toolAt("/mcp/cleaner-core", grok, "choose_supplies", { on: false });
    expect(no.isError).toBe(false);
    expect(no.text).toContain("later");
    expect(m.registry.get(tenant.id)?.properties[0]?.flows.supplies.on).toBe(false);
    const yes = await m.toolAt("/mcp/cleaner-core", grok, "choose_supplies", { on: true });
    expect(yes.isError).toBe(false);
    expect(yes.text).toContain("get_supply_state");
    expect(m.registry.get(tenant.id)?.properties[0]?.flows.supplies.on).toBe(true);
  });

  it("turning supplies off keeps the list and closes the supplies question", SLOW, async () => {
    const m = await start();
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    const lane = m.registry.addProperty(tenant.id, "12 Scratch Lane");
    m.registry.setFlow(tenant.id, lane.id, "cleaning", true);
    const grok = await m.joinAt(tenant.id, "grok", PATH);
    await m.toolAt(PATH, grok, "set_flows", { property: lane.id, supplies: true });
    await m.toolAt(PATH, grok, "save_supply_list", { names: ["Paper towels"] });
    const ask = await m.toolAt(PATH, grok, "set_flows", { property: lane.id, supplies: false });
    await m.toolAt(PATH, grok, "set_flows", { property: lane.id, supplies: false, confirmation: (ask.structured?.confirmation as { code: string }).code });
    const fresh = m.registry.get(tenant.id)!;
    expect(fresh.properties[0]?.flows.supplies.on).toBe(false);
    expect(readSupply(folder(m, fresh, fresh.properties[0]!)).draft).toEqual(["Paper towels"]);
    expect(await m.toolNames(PATH, grok)).not.toContain("save_supply_item");
  });
});
