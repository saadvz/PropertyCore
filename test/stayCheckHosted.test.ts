import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { propertyFolder } from "../src/cleaner-core/hosted/properties";
import { readStayCheck } from "../src/stay-check/store";
import { closeHostedApps } from "./cleanerOauthHarness";
import { hub, supply } from "./hoursFixture";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/** #239 on the shared service: the host's house rules, behind STAY_CHECK=1, for the property a call names. */

const LANE = "+15555550151";
const PATH = "/mcp";
const SLOW = { timeout: 90_000 };
const NOW = new Date("2026-11-17T15:00:00.000Z");
const TOOLS = ["get_house_rules", "save_house_rules", "allow_for_stay"];
const RULES = [{ text: "No more than 6 guests", check: { kind: "people", max: 6 } }, { text: "No smoking" }];

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

async function account(env: NodeJS.ProcessEnv) {
  open = await multiTenantApp({ env: { SUPPLY_CORE: "1", ...env }, now: () => NOW });
  const m = open;
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
  const property = m.registry.addProperty(tenant.id, "12 Scratch Lane");
  m.registry.setFlow(tenant.id, property.id, "supplies", true);
  const root = propertyFolder(m.app.root, tenant.id, property);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "hub.json"), JSON.stringify(hub));
  writeFileSync(join(root, "supply.json"), JSON.stringify(supply));
  const token = await m.joinAt(tenant.id, "grok", PATH);
  return { m, property, token, root };
}

describe("house rules on the shared service", () => {
  it("isn't listed or answered without STAY_CHECK", SLOW, async () => {
    const { m, token, property } = await account({});
    const names = await m.toolNames(PATH, token);
    expect(names.filter((name) => TOOLS.includes(name))).toEqual([]);
    const reply = await m.toolAt(PATH, token, "get_house_rules", { property: property.id });
    expect(reply.isError).toBe(true);
  });

  it("is listed with STAY_CHECK=1, saves and reads the host's rules", SLOW, async () => {
    const { m, token, property, root } = await account({ STAY_CHECK: "1" });
    const names = await m.toolNames(PATH, token);
    expect(names.filter((name) => TOOLS.includes(name)).sort()).toEqual([...TOOLS].sort());
    const asked = await m.toolAt(PATH, token, "get_house_rules", { property: property.id });
    expect(asked.isError).toBe(false);
    expect(String(asked.structured?.ask)).toContain("No more than 6 guests");
    const saved = await m.toolAt(PATH, token, "save_house_rules", { property: property.id, rules: RULES, checkTime: "22:30" });
    expect(saved.isError).toBe(false);
    const read = await m.toolAt(PATH, token, "get_house_rules", { property: property.id });
    expect(read.structured).toMatchObject({ rules: RULES, checkTime: "22:30" });
    expect(readStayCheck(root).rules).toHaveLength(2);
  });

  it("refuses a rule with a door code, and keeps the saved rules", SLOW, async () => {
    const { m, token, property, root } = await account({ STAY_CHECK: "true" });
    await m.toolAt(PATH, token, "save_house_rules", { property: property.id, rules: RULES });
    const refused = await m.toolAt(PATH, token, "save_house_rules", { property: property.id, rules: [{ text: `Lockbox ${["4", "8", "2", "1"].join("")} by the side door` }] });
    expect(refused.isError).toBe(true);
    expect(readStayCheck(root).rules).toEqual(RULES);
  });

  it("an empty list clears the rules", SLOW, async () => {
    const { m, token, property, root } = await account({ STAY_CHECK: "1" });
    await m.toolAt(PATH, token, "save_house_rules", { property: property.id, rules: RULES });
    const cleared = await m.toolAt(PATH, token, "save_house_rules", { property: property.id, rules: [] });
    expect(cleared.isError).toBe(false);
    expect(readStayCheck(root).rules).toEqual([]);
    const asked = await m.toolAt(PATH, token, "get_house_rules", { property: property.id });
    expect(asked.structured?.ask).toBeTypeOf("string");
  });

  it("allow_for_stay takes a check-in date and kinds", SLOW, async () => {
    const { m, token, property, root } = await account({ STAY_CHECK: "1" });
    const allowed = await m.toolAt(PATH, token, "allow_for_stay", { property: property.id, checkIn: "2026-11-20", allow: ["pets"] });
    expect(allowed.isError).toBe(false);
    expect(readStayCheck(root).allowances).toEqual([{ checkIn: "2026-11-20", allow: ["pets"] }]);
    const bad = await m.toolAt(PATH, token, "allow_for_stay", { property: property.id, checkIn: "2026-11-20", allow: ["smoke"] });
    expect(bad.isError).toBe(true);
  });
});
