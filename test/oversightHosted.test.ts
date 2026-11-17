import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { propertyFolder } from "../src/cleaner-core/hosted/properties";
import { remoteOversightOn } from "../src/cleaner-core/flag";
import { readOversight } from "../src/oversight/store";
import { OVERSIGHT_TOOLS } from "../src/oversight/tools";
import { closeHostedApps } from "./cleanerOauthHarness";
import { hub, supply } from "./hoursFixture";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/** #240 on the shared service: expected visits, behind REMOTE_OVERSIGHT=1, for the property a call names. */

const LANE = "+15555550152";
const PATH = "/mcp";
const SLOW = { timeout: 90_000 };
const NOW = new Date("2026-11-17T15:00:00.000Z");
const TOOLS = ["add_expected_visit", "list_expected_visits", "cancel_expected_visit"];
const MIKE = { who: "Mike Doyle", date: "2026-11-19", from: "13:00", to: "17:00", note: "walk-through" };

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

describe("the REMOTE_OVERSIGHT flag", () => {
  it("is off unless 1 or true", () => {
    expect(remoteOversightOn({})).toBe(false);
    expect(remoteOversightOn({ REMOTE_OVERSIGHT: "0" })).toBe(false);
    expect(remoteOversightOn({ REMOTE_OVERSIGHT: " TRUE " })).toBe(true);
    expect(remoteOversightOn({ REMOTE_OVERSIGHT: "1" })).toBe(true);
  });
});

describe("expected visit tools", () => {
  it("tools describe the read-back", () => {
    const add = OVERSIGHT_TOOLS.find((tool) => tool.name === "add_expected_visit");
    const description = String(add?.description);
    expect(description).toContain("Read");
    expect(description).toContain("back");
    expect(description).toContain("Never");
    expect(description).toContain("afternoon 12:00-17:00");
  });
});

describe("expected visits on the shared service", () => {
  it("isn't listed or answered without REMOTE_OVERSIGHT", SLOW, async () => {
    const { m, token, property } = await account({});
    const names = await m.toolNames(PATH, token);
    expect(names.filter((name) => TOOLS.includes(name))).toEqual([]);
    const reply = await m.toolAt(PATH, token, "list_expected_visits", { property: property.id });
    expect(reply.isError).toBe(true);
  });

  it("is listed with REMOTE_OVERSIGHT=1, adds, lists and cancels", SLOW, async () => {
    const { m, token, property, root } = await account({ REMOTE_OVERSIGHT: "1" });
    const names = await m.toolNames(PATH, token);
    expect(names.filter((name) => TOOLS.includes(name)).sort()).toEqual([...TOOLS].sort());
    const added = await m.toolAt(PATH, token, "add_expected_visit", { property: property.id, ...MIKE });
    expect(added.isError).toBe(false);
    const id = (added.structured?.visit as { id: string }).id;
    const listed = await m.toolAt(PATH, token, "list_expected_visits", { property: property.id });
    expect((listed.structured?.open as { id: string }[]).map((v) => v.id)).toEqual([id]);
    const cancelled = await m.toolAt(PATH, token, "cancel_expected_visit", { property: property.id, id });
    expect(cancelled.isError).toBe(false);
    expect(readOversight(root).visits[0]?.cancelledAt).toBe(NOW.toISOString());
  });

  it("refuses a door code in a note and saves nothing", SLOW, async () => {
    const { m, token, property, root } = await account({ REMOTE_OVERSIGHT: "true" });
    const refused = await m.toolAt(PATH, token, "add_expected_visit", { property: property.id, ...MIKE, note: `Code ${["4", "8", "2", "1"].join("")}` });
    expect(refused.isError).toBe(true);
    expect(readOversight(root).visits).toEqual([]);
  });
});
