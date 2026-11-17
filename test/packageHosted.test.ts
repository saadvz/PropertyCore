import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { propertyFolder } from "../src/cleaner-core/hosted/properties";
import { readPackages, supplyKey } from "../src/package-arrivals/store";
import { closeHostedApps } from "./cleanerOauthHarness";
import { hub } from "./hoursFixture";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { order, writeOrders } from "./packageFixture";

/** #241 on the shared service: package arrivals, behind PACKAGE_ARRIVALS=1, where the property runs Supply Core. */

const LANE = "+15555550151";
const PATH = "/mcp";
const SLOW = { timeout: 90_000 };
const NOW = new Date("2026-11-17T15:00:00.000Z");
const TOOLS = ["check_packages", "mark_package_seen", "plan_bring_in", "mark_brought_in", "save_package_settings"];

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

async function account(env: NodeJS.ProcessEnv, supplies = true) {
  open = await multiTenantApp({ env: { SUPPLY_CORE: "1", ...env }, now: () => NOW });
  const m = open;
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
  const property = m.registry.addProperty(tenant.id, "12 Scratch Lane");
  const other = m.registry.addProperty(tenant.id, "14 Scratch Lane");
  m.registry.setFlow(tenant.id, property.id, "supplies", supplies);
  m.registry.setFlow(tenant.id, other.id, "fixer", true);
  const root = propertyFolder(m.app.root, tenant.id, property);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "hub.json"), JSON.stringify(hub));
  writeOrders(root, [order("ord_a", { expectedBy: "2026-11-17" })]);
  const token = await m.joinAt(tenant.id, "grok", PATH);
  return { m, property, other, token, root };
}

describe("package arrivals on the shared service", () => {
  it("isn't listed or answered without PACKAGE_ARRIVALS", SLOW, async () => {
    const { m, token, property } = await account({});
    expect((await m.toolNames(PATH, token)).filter((name) => TOOLS.includes(name))).toEqual([]);
    expect((await m.toolAt(PATH, token, "check_packages", { property: property.id })).isError).toBe(true);
  });

  it("is listed with PACKAGE_ARRIVALS=1 and answers for the property it names", SLOW, async () => {
    const { m, token, property, root } = await account({ PACKAGE_ARRIVALS: "1" });
    expect((await m.toolNames(PATH, token)).filter((name) => TOOLS.includes(name)).sort()).toEqual([...TOOLS].sort());
    const checked = await m.toolAt(PATH, token, "check_packages", { property: property.id });
    expect(checked.isError).toBe(false);
    expect((checked.structured?.expected as { orderId: string }[]).map((d) => d.orderId)).toEqual(["ord_a"]);
    const saved = await m.toolAt(PATH, token, "save_package_settings", { property: property.id, bringInHours: 4 });
    expect(saved.isError).toBe(false);
    const seen = await m.toolAt(PATH, token, "mark_package_seen", { property: property.id, orderId: "ord_a", how: "host" });
    expect(seen.isError).toBe(false);
    expect(readPackages(root)).toMatchObject({ settings: { bringInHours: 4 }, arrivals: { [supplyKey("ord_a")]: { seen: { how: "host" } } } });
  });

  it("refuses a property that doesn't run Supply Core", SLOW, async () => {
    const { m, token, other } = await account({ PACKAGE_ARRIVALS: "1" });
    const reply = await m.toolAt(PATH, token, "check_packages", { property: other.id });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/Supply Core/);
  });

  it("isn't listed when no property runs Supply Core", SLOW, async () => {
    const { m, token } = await account({ PACKAGE_ARRIVALS: "1" }, false);
    expect((await m.toolNames(PATH, token)).filter((name) => TOOLS.includes(name))).toEqual([]);
  });

  it("refuses unknown arguments", SLOW, async () => {
    const { m, token, property } = await account({ PACKAGE_ARRIVALS: "1" });
    const reply = await m.toolAt(PATH, token, "check_packages", { property: property.id, extra: true });
    expect(reply.isError).toBe(true);
  });
});
