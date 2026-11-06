import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { propertyFolder } from "../src/cleaner-core/hosted/properties";
import { BASE, closeHostedApps, pkce } from "./cleanerOauthHarness";
import { multiTenantApp, REDIRECTS, type MultiTenantApp } from "./multiTenantHarness";
import { ADDRESS, BUSINESS } from "./wiringProof";

/** The account's tools on the shared address: properties, the property argument, and get_state. Only 555 numbers. */

const LINE = "+15555550150";
const ZONE = "America/New_York";
const SLOW = { timeout: 90_000 };
const PATH = "/mcp/cleaner-core";

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

async function start(env: NodeJS.ProcessEnv = {}) {
  open = await multiTenantApp({ env });
  const m = open;
  const account = m.registry.create({ label: "Lane", twilioNumber: LINE }).tenant;
  const token = await m.join(account.id, "grok");
  return { m, account, token };
}

/** A property with the given flows on, made the way /admin or set_flows would. */
function property(m: MultiTenantApp, accountId: string, label: string, flows: ("cleaning" | "supplies")[]) {
  const made = m.registry.addProperty(accountId, label);
  for (const flow of flows) m.registry.setFlow(accountId, made.id, flow, true);
  return made;
}

describe("the account's tools", () => {
  it("a new account's get_state asks for the first property", SLOW, async () => {
    const { m, token } = await start();
    const state = await m.toolAt(PATH, token, "get_state");
    expect(state.isError).toBe(false);
    expect(state.structured).toMatchObject({ properties: [], next: "Ask the host for the property's address, then call add_property with it." });
  });

  it("add_property then get_state lists it with every flow off", SLOW, async () => {
    const { m, account, token } = await start();
    const added = await m.toolAt(PATH, token, "add_property", { label: "12 Scratch Lane" });
    expect(added.isError).toBe(false);
    const id = (added.structured?.property as { id: string }).id;
    expect(existsSync(propertyFolder(m.app.root, account.id, m.registry.get(account.id)!.properties[0]!))).toBe(true);
    const state = await m.toolAt(PATH, token, "get_state");
    expect(state.structured?.properties).toEqual([{ id, label: "12 Scratch Lane", flows: { cleaning: false, supplies: false, fixer: false } }]);
    expect((await m.toolAt(PATH, token, "add_property", { label: " " })).isError).toBe(true);
    expect((await m.toolAt(PATH, token, "add_property", { label: "x".repeat(121) })).isError).toBe(true);
  });

  it("with one property a Cleaner Core call needs no property argument", SLOW, async () => {
    const { m, account, token } = await start();
    const lane = property(m, account.id, "12 Scratch Lane", ["cleaning"]);
    await m.toolAt(PATH, token, "get_state", { choice: "cleaners" });
    const saved = await m.toolAt(PATH, token, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE });
    expect(saved.isError).toBe(false);
    expect(existsSync(join(propertyFolder(m.app.root, account.id, lane), "cleaner-live.json"))).toBe(true);
    const state = await m.toolAt(PATH, token, "get_state");
    expect(state.structured?.done).toContain("Property saved.");
    expect(state.structured?.properties).toEqual([{ id: lane.id, label: "12 Scratch Lane", flows: { cleaning: true, supplies: false, fixer: false } }]);
  });

  it("with two properties a call without property is refused with the list", SLOW, async () => {
    const { m, account, token } = await start();
    const lane = property(m, account.id, "12 Scratch Lane", ["cleaning"]);
    const court = property(m, account.id, "8 Scratch Court", ["cleaning"]);
    const refused = await m.toolAt(PATH, token, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(`Which property? Pass property as one of: ${lane.id} (12 Scratch Lane), ${court.id} (8 Scratch Court).`);
    expect((await m.toolAt(PATH, token, "save_property", { property: "prp_nothere000", business: BUSINESS, address: ADDRESS, timeZone: ZONE })).text).toBe(refused.text);
    const saved = await m.toolAt(PATH, token, "save_property", { property: court.id, business: BUSINESS, address: ADDRESS, timeZone: ZONE });
    expect(saved.isError).toBe(false);
    expect(existsSync(join(propertyFolder(m.app.root, account.id, court), "cleaner-live.json"))).toBe(true);
    expect(existsSync(join(propertyFolder(m.app.root, account.id, lane), "cleaner-live.json"))).toBe(false);
  });

  it("with two properties get_state lists them, and a property's own state comes with property", SLOW, async () => {
    const { m, account, token } = await start();
    const lane = property(m, account.id, "12 Scratch Lane", ["cleaning"]);
    property(m, account.id, "8 Scratch Court", ["cleaning"]);
    const overview = await m.toolAt(PATH, token, "get_state");
    expect((overview.structured?.properties as { id: string; next?: Record<string, string> }[]).map((p) => p.id)).toContain(lane.id);
    const own = await m.toolAt(PATH, token, "get_state", { property: lane.id, choice: "cleaners" });
    expect(own.isError).toBe(false);
    expect(own.structured?.ask).toBeDefined();
  });

  it("a label works in place of the id", SLOW, async () => {
    const { m, account, token } = await start();
    property(m, account.id, "12 Scratch Lane", ["cleaning"]);
    const court = property(m, account.id, "8 Scratch Court", ["cleaning"]);
    const saved = await m.toolAt(PATH, token, "save_property", { property: "8 scratch court", business: BUSINESS, address: ADDRESS, timeZone: ZONE });
    expect(saved.isError).toBe(false);
    expect(existsSync(join(propertyFolder(m.app.root, account.id, court), "cleaner-live.json"))).toBe(true);
  });

  it("a property whose flow is off is refused", SLOW, async () => {
    const { m, account, token } = await start({ SUPPLY_CORE: "1" });
    property(m, account.id, "12 Scratch Lane", ["cleaning"]);
    const court = property(m, account.id, "8 Scratch Court", ["supplies"]);
    const refused = await m.toolAt(PATH, token, "save_property", { property: court.id, business: BUSINESS, address: ADDRESS, timeZone: ZONE });
    expect(refused).toMatchObject({ isError: true, text: "Cleaner Core isn't on for 8 Scratch Court." });
    const supplies = await m.toolAt(PATH, token, "get_supply_state", { property: "12 Scratch Lane" });
    expect(supplies).toMatchObject({ isError: true, text: "Supply Core isn't on for 12 Scratch Lane." });
  });

  it("tools/list carries property on every property tool, and no choose_service", SLOW, async () => {
    const { m, account, token } = await start({ SUPPLY_CORE: "1" });
    property(m, account.id, "12 Scratch Lane", ["cleaning", "supplies"]);
    const { json } = await m.rpcAt(PATH, token, "tools/list");
    const tools = (json.result?.tools ?? []) as { name: string; inputSchema: { properties?: Record<string, unknown> } }[];
    const names = tools.map((t) => t.name);
    for (const name of ["get_state", "add_property", "save_property", "save_people", "get_supply_state", "save_supply_item"]) expect(names).toContain(name);
    for (const name of ["choose_service", "switch_service", "stand_down_service", "turn_on_supplies", "turn_off_supplies"]) expect(names).not.toContain(name);
    expect(names.filter((n) => n === "get_state")).toHaveLength(1);
    for (const tool of tools.filter((t) => !["add_property"].includes(t.name))) expect(tool.inputSchema.properties ?? {}).toHaveProperty("property");
  });

  it("Supply Core tools are listed for Grok only", SLOW, async () => {
    const { m, account } = await start({ SUPPLY_CORE: "1" });
    property(m, account.id, "12 Scratch Lane", ["cleaning", "supplies"]);
    const claude = await m.join(account.id, "claude");
    const names = await m.toolNames(PATH, claude);
    expect(names).toContain("save_property");
    expect(names).not.toContain("get_supply_state");
    expect((await m.toolAt(PATH, claude, "get_supply_state")).text).toBe("Supply Core works with Grok only for now: it shops with Grok's own shopping tools and Vault.");
  });

  it("the Allow page asks for the invite code and no service", SLOW, async () => {
    const { m } = await start({ SUPPLY_CORE: "1", TOUR_CORE_TENANTS: "1" });
    const clientId = await m.app.register("grok", REDIRECTS.grok);
    const page = await m.app.authorize(clientId, pkce().challenge, `${BASE}/mcp`, "tourcore.operator", "state-1", REDIRECTS.grok);
    const html = await page.text();
    expect(html).toContain("invite");
    expect(html).not.toContain('name="service"');
  });
});
