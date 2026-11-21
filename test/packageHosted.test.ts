import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { propertyFolder } from "../src/cleaner-core/hosted/properties";
import { tenantFolder } from "../src/cleaner-core/hosted/registry";
import { propertyContext } from "../src/cleaner-core/hosted/router";
import { hubFor, resetHubs } from "../src/hub/hub";
import { peopleFor, resetPeople } from "../src/hub/people";
import { FakeLockAdapter } from "../src/locks/fake";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { resetPackageDesks } from "../src/package-arrivals/desk";
import { readPackages, supplyKey } from "../src/package-arrivals/store";
import { closeHostedApps } from "./cleanerOauthHarness";
import { hub } from "./hoursFixture";
import { credentialsFor, switchOn } from "./featureEnv";
import type { Feature } from "../src/features/features";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { order, writeOrders } from "./packageFixture";

/** #241 on the shared service: package arrivals, behind the account's "packages" switch, where the property runs Supply Core. */

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

async function account(features: Feature[], supplies = true) {
  open = await multiTenantApp({ env: { SUPPLY_CORE: "1", ...credentialsFor(features) }, now: () => NOW });
  const m = open;
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
  switchOn(m.registry, tenant.id, ...features);
  const property = m.registry.addProperty(tenant.id, "12 Scratch Lane");
  const other = m.registry.addProperty(tenant.id, "14 Scratch Lane");
  m.registry.setFlow(tenant.id, property.id, "supplies", supplies);
  m.registry.setFlow(tenant.id, other.id, "fixer", true);
  const root = propertyFolder(m.app.root, tenant.id, property);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "hub.json"), JSON.stringify(hub));
  writeOrders(root, [order("ord_a", { expectedBy: "2026-11-17" })]);
  const token = await m.joinAt(tenant.id, "grok", PATH);
  return { m, tenant, property, other, token, root };
}

describe("package arrivals on the shared service", () => {
  it("isn't listed or answered without the account's packages switch", SLOW, async () => {
    const { m, token, property } = await account([]);
    expect((await m.toolNames(PATH, token)).filter((name) => TOOLS.includes(name))).toEqual([]);
    expect((await m.toolAt(PATH, token, "check_packages", { property: property.id })).isError).toBe(true);
  });

  it("is listed with the account's packages switch on and answers for the property it names", SLOW, async () => {
    const { m, token, property, root } = await account(["packages"]);
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
    const { m, token, other } = await account(["packages"]);
    const reply = await m.toolAt(PATH, token, "check_packages", { property: other.id });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/Supply Core/);
  });

  it("isn't listed when no property runs Supply Core", SLOW, async () => {
    const { m, token } = await account(["packages"], false);
    expect((await m.toolNames(PATH, token)).filter((name) => TOOLS.includes(name))).toEqual([]);
  });

  it("refuses unknown arguments", SLOW, async () => {
    const { m, token, property } = await account(["packages"]);
    const reply = await m.toolAt(PATH, token, "check_packages", { property: property.id, extra: true });
    expect(reply.isError).toBe(true);
  });
});

describe("bring-in codes on the shared service (#241)", () => {
  afterEach(() => {
    resetPackageDesks();
    resetPeople();
    resetHubs();
    setLockAdapter(undefined);
  });

  async function locked(features: Feature[]) {
    const fake = new FakeLockAdapter();
    setLockAdapter(fake);
    const world = await account(["packages", ...features]);
    const { m, property, tenant } = world;
    const fresh = m.registry.get(tenant.id)!;
    const prop = fresh.properties.find((item) => item.id === property.id)!;
    const ctx = propertyContext(m.hosted(), fresh, prop);
    const device = fake.addDevice(tenant.id, { id: "dev-front", name: "Front door" });
    hubFor(ctx.root, { now: () => NOW }).doorAccess(ctx.env).saveLocks({ ...emptyLocks(), customerKey: tenant.id, devices: [storedDevice(device)], doors: [device.id], activeAt: NOW.toISOString(), release: { cleaners: "ask", pros: "ask", packages: "automatic" } });
    const people = peopleFor(tenantFolder(m.app.root, tenant.id), { now: () => NOW });
    people.savePropertyPeople(prop.id, "+15555550100", [{ phone: "+15555550111", role: "cleaner", name: "Ana" }]);
    people.optIn("+15555550111", prop.id);
    return { ...world, fake };
  }

  it("lists approve_bring_in_code only with the account's locks on and a lock adapter", SLOW, async () => {
    const off = await account(["packages"]);
    expect(await off.m.toolNames(PATH, off.token)).not.toContain("approve_bring_in_code");
    open?.close();
    open = undefined;
    closeHostedApps();
    const on = await locked(["locks"]);
    expect(await on.m.toolNames(PATH, on.token)).toContain("approve_bring_in_code");
  });

  it("on connected locks, puts the person's code on the lock, and tells the host when texts can't go out here", SLOW, async () => {
    const { m, token, property, fake, root } = await locked(["locks"]);
    await m.toolAt(PATH, token, "save_package_settings", { property: property.id, bringInHours: 4 });
    await m.toolAt(PATH, token, "plan_bring_in", { property: property.id, orderId: "ord_a", person: "+15555550111" });
    const seen = await m.toolAt(PATH, token, "mark_package_seen", { property: property.id, orderId: "ord_a", how: "host" });
    expect(seen.isError).toBe(false);
    const codes = fake.liveCodes("dev-front");
    expect(codes).toHaveLength(1);
    expect(codes[0]!.name).toMatch(/^Package /);
    // Cleaner Core isn't on here, so texts can't go out: no send is tried, and the host hears it once.
    expect((seen.structured?.lockNotes as string[]).join(" ")).toMatch(/Texts can't go out/);
    expect(seen.text).not.toContain(codes[0]!.code);
    expect(JSON.stringify(readPackages(root))).not.toContain(codes[0]!.code);
    await m.toolAt(PATH, token, "mark_brought_in", { property: property.id, orderId: "ord_a" });
    expect(fake.liveCodes("dev-front")).toEqual([]);
  });
});
