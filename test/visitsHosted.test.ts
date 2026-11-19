import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { propertyFolder } from "../src/cleaner-core/hosted/properties";
import { visitRecordsOn } from "../src/cleaner-core/flag";
import { VISIT_TOOLS } from "../src/visits/tools";
import { resetVisitLogCache, VISIT_EVENTS_DIR, VisitLog } from "../src/visits/store";
import { closeHostedApps } from "./cleanerOauthHarness";
import { hub } from "./hoursFixture";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/** #237 on the shared service: visit records' tools, behind VISIT_RECORDS=1, read-only but for lock code names. */

const LANE = "+15555550153";
const PATH = "/mcp";
const SLOW = { timeout: 90_000 };
const NOW = new Date("2027-01-05T15:00:00.000Z");
const TOOLS = ["list_visits", "visit_health", "name_lock_code"];

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
  resetVisitLogCache();
});

async function account(env: NodeJS.ProcessEnv) {
  open = await multiTenantApp({ env: { FIXER_CORE: "1", ...env }, now: () => NOW });
  const m = open;
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
  const property = m.registry.addProperty(tenant.id, "12 Scratch Lane");
  m.registry.setFlow(tenant.id, property.id, "fixer", true);
  const root = propertyFolder(m.app.root, tenant.id, property);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "hub.json"), JSON.stringify(hub));
  const token = await m.joinAt(tenant.id, "grok", PATH);
  return { m, property, token, root };
}

describe("the VISIT_RECORDS flag", () => {
  it("is off unless 1 or true", () => {
    expect(visitRecordsOn({})).toBe(false);
    expect(visitRecordsOn({ VISIT_RECORDS: "0" })).toBe(false);
    expect(visitRecordsOn({ VISIT_RECORDS: " TRUE " })).toBe(true);
    expect(visitRecordsOn({ VISIT_RECORDS: "1" })).toBe(true);
  });

  it("offers no tool that writes a lock or message event", () => {
    expect(VISIT_TOOLS.map((tool) => tool.name)).toEqual(TOOLS);
    for (const tool of VISIT_TOOLS) expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"(at|action|side|device|direction|body)"/);
  });
});

describe("visit records on the shared service", () => {
  it("isn't listed or answered without VISIT_RECORDS", SLOW, async () => {
    const { m, token, property } = await account({});
    const names = await m.toolNames(PATH, token);
    expect(names.filter((name) => TOOLS.includes(name))).toEqual([]);
    const reply = await m.toolAt(PATH, token, "list_visits", { property: property.id });
    expect(reply.isError).toBe(true);
  });

  it("is listed with VISIT_RECORDS=1, lists visits and names a code, and writes no event", SLOW, async () => {
    const { m, token, property, root } = await account({ VISIT_RECORDS: "1" });
    const names = await m.toolNames(PATH, token);
    expect(names.filter((name) => TOOLS.includes(name)).sort()).toEqual([...TOOLS].sort());
    const log = new VisitLog(root, () => NOW);
    log.append({ type: "lock-connection", id: "conn", at: "2027-01-01T00:00:00.000Z", connected: true });
    log.append({ type: "visit-window", id: "w1", at: "2027-01-01T00:00:00.000Z", visit: "cleaning:j1", kind: "cleaning", from: "2027-01-04T16:00:00.000Z", until: "2027-01-04T21:00:00.000Z", expectedAt: "2027-01-04T16:00:00.000Z", sameDay: true, checkIn: "2027-01-04T21:00:00.000Z", who: { role: "cleaner", name: "Maria Lopez" } });
    log.append({ type: "lock", id: "u1", at: "2027-01-04T16:05:00.000Z", device: "Front door", action: "unlock", side: "outside", codeName: "Cleaner" });
    const named = await m.toolAt(PATH, token, "name_lock_code", { property: property.id, codeName: "Cleaner", person: "cleaner" });
    expect(named.isError).toBe(false);
    const refused = await m.toolAt(PATH, token, "name_lock_code", { property: property.id, codeName: `Code ${["6", "3", "5", "9"].join("")}`, person: "cleaner" });
    expect(refused.isError).toBe(true);
    const listed = await m.toolAt(PATH, token, "list_visits", { property: property.id, from: "2027-01-01", to: "2027-01-05" });
    expect(listed.isError).toBe(false);
    expect(listed.structured?.visits).toEqual([expect.objectContaining({ id: "cleaning:j1", lock: true, arrival: expect.objectContaining({ source: "lock", local: "11:05 AM" }) })]);
    const health = await m.toolAt(PATH, token, "visit_health", { property: property.id });
    expect(health.structured).toMatchObject({ lines: 3, skipped: 0, codes: 1, sends: false });
    expect(new VisitLog(root).read()).toHaveLength(3);
    expect(readdirSync(join(root, VISIT_EVENTS_DIR)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
  });
});
