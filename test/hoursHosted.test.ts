import { afterEach, describe, expect, it } from "vitest";
import { propertyFolder } from "../src/cleaner-core/hosted/properties";
import { readHours } from "../src/hours-log/store";
import { closeHostedApps } from "./cleanerOauthHarness";
import { hub, supply } from "./hoursFixture";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** #238 on the shared service: the hours log, behind HOURS_LOG=1, answered for the property a call names. */

const LANE = "+15555550150";
const PATH = "/mcp";
const SLOW = { timeout: 90_000 };
const NOW = new Date("2026-11-03T15:00:00.000Z");
const HOURS = ["export_hours", "review_hours", "save_hours_settings"];

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
  return { m, tenant, property, token, root };
}

describe("the hours log on the shared service", () => {
  it("isn't listed or answered without HOURS_LOG", SLOW, async () => {
    const { m, token, property } = await account({});
    const names = await m.toolNames(PATH, token);
    expect(names.filter((name) => HOURS.includes(name))).toEqual([]);
    const reply = await m.toolAt(PATH, token, "review_hours", { property: property.id, month: "2026-10" });
    expect(reply.isError).toBe(true);
  });

  it("is listed with HOURS_LOG=1, and reviews and confirms the property's month", SLOW, async () => {
    const { m, token, property, root } = await account({ HOURS_LOG: "1" });
    const names = await m.toolNames(PATH, token);
    expect(names.filter((name) => HOURS.includes(name))).toEqual(HOURS);
    const asked = await m.toolAt(PATH, token, "review_hours", { property: property.id, month: "2026-10" });
    expect(asked.isError).toBe(false);
    const logs = asked.structured?.logs as { name: string }[];
    expect(logs.map((log) => log.name)).toEqual(["Owner", "Property Core"]);
    const code = (asked.structured?.confirmation as { code: string }).code;
    const confirmed = await m.toolAt(PATH, token, "review_hours", { property: property.id, month: "2026-10", confirmation: code });
    expect(confirmed.isError).toBe(false);
    expect(readHours(root).months["2026-10"]?.rows).toBe(4);
    const exported = await m.toolAt(PATH, token, "export_hours", { property: property.id, month: "2026-10" });
    expect(exported.isError).toBe(false);
  });
});
