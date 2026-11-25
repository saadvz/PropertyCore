import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { propertyFolder } from "../src/cleaner-core/hosted/properties";
import { VISIT_TOOLS } from "../src/visits/tools";
import { resetVisitLogCache, VISIT_EVENTS_DIR, VisitLog } from "../src/visits/store";
import { closeHostedApps } from "./cleanerOauthHarness";
import { hub } from "./hoursFixture";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { credentialsFor, switchOn } from "./featureEnv";

/** #237 on the shared service: visit records' tools, behind the account's "visits" switch, read-only but for lock code names. */

const LANE = "+15555550153";
const PATH = "/mcp";
const SLOW = { timeout: 90_000 };
const NOW = new Date("2027-01-05T15:00:00.000Z");
const TOOLS = ["list_visits", "visit_health", "door_activity", "name_lock_code"];

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
  resetVisitLogCache();
});

async function account(visits: boolean, env: NodeJS.ProcessEnv = {}) {
  open = await multiTenantApp({ env, now: () => NOW });
  const m = open;
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
  if (visits) switchOn(m.registry, tenant.id, "visits");
  const property = m.registry.addProperty(tenant.id, "12 Scratch Lane");
  m.registry.setFlow(tenant.id, property.id, "fixer", true);
  const root = propertyFolder(m.app.root, tenant.id, property);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "hub.json"), JSON.stringify(hub));
  const token = await m.joinAt(tenant.id, "grok", PATH);
  return { m, tenant, property, token, root };
}

describe("the visit tools", () => {
  it("offers no tool that writes a lock or message event", () => {
    expect(VISIT_TOOLS.map((tool) => tool.name)).toEqual(TOOLS);
    for (const tool of VISIT_TOOLS) expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"(at|action|side|device|direction|body)"/);
  });
});

describe("visit records on the shared service", () => {
  it("isn't listed or answered with the account's visits switch off", SLOW, async () => {
    const { m, token, property } = await account(false);
    const names = await m.toolNames(PATH, token);
    expect(names.filter((name) => TOOLS.includes(name))).toEqual([]);
    const reply = await m.toolAt(PATH, token, "list_visits", { property: property.id });
    expect(reply.isError).toBe(true);
  });

  it("is listed with the account's visits switch on, lists visits and names a code, and writes no event", SLOW, async () => {
    const { m, token, property, root } = await account(true);
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

  it("shows a person seen on a camera close to DONE only with the account's cameras on, and says it isn't who", SLOW, async () => {
    const { m, tenant, token, property, root } = await account(true, { CAMERA_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64"), ...credentialsFor(["cameras"]) });
    const log = new VisitLog(root, () => NOW);
    log.append({ type: "visit-window", id: "w1", at: "2027-01-01T00:00:00.000Z", visit: "cleaning:j1", kind: "cleaning", from: "2027-01-04T16:00:00.000Z", until: "2027-01-04T21:00:00.000Z", expectedAt: "2027-01-04T16:00:00.000Z", sameDay: true, checkIn: "2027-01-04T21:00:00.000Z", who: { role: "cleaner", name: "Maria Lopez" } });
    log.append({ type: "message", id: "s1", at: "2027-01-04T16:05:00.000Z", direction: "in", role: "cleaner", visit: "cleaning:j1", label: "start" });
    log.append({ type: "message", id: "d1", at: "2027-01-04T18:40:00.000Z", direction: "in", role: "cleaner", visit: "cleaning:j1", label: "done" });
    log.append({ type: "camera", id: "c1", at: "2027-01-04T18:47:00.000Z", kind: "motion", deviceId: "cam-1", provider: "ring", device: "Front porch", label: "human" });
    const list = async () => ((await m.toolAt(PATH, token, "list_visits", { property: property.id, from: "2027-01-01", to: "2027-01-05" })).structured?.visits as { departure: Record<string, unknown>; minutes: number }[])[0]!;

    const off = await list();
    expect(off.departure).toMatchObject({ at: "2027-01-04T18:40:00.000Z", timeFrom: "done", cameraCheck: "no-camera" });
    expect(off.departure).not.toHaveProperty("camera");

    switchOn(m.registry, tenant.id, "cameras");
    const on = await list();
    expect(on.departure).toMatchObject({ at: "2027-01-04T18:47:00.000Z", local: "1:47 PM", source: "done-text", timeFrom: "camera", cameraCheck: "seen", camera: { device: "Front porch", eventId: "c1", local: "1:47 PM" } });
    expect(on.minutes).toBe(162);
    expect(VISIT_TOOLS.find((entry) => entry.name === "list_visits")?.description).toContain("never tell the host a camera saw the cleaner or the pro leave");
    expect(new VisitLog(root).read()).toHaveLength(4);
  });

  it("one account's visits switch doesn't list the tools for another account", SLOW, async () => {
    const { m, tenant, token } = await account(true);
    const other = m.registry.create({ label: "Court", twilioNumber: "+15555550154" }).tenant;
    const court = m.registry.addProperty(other.id, "8 Scratch Court");
    m.registry.setFlow(other.id, court.id, "fixer", true);
    const otherToken = await m.joinAt(other.id, "grok", PATH);
    expect((await m.toolNames(PATH, token)).filter((name) => TOOLS.includes(name)).sort()).toEqual([...TOOLS].sort());
    expect((await m.toolNames(PATH, otherToken)).filter((name) => TOOLS.includes(name))).toEqual([]);
    expect((await m.toolAt(PATH, otherToken, "list_visits", { property: court.id })).isError).toBe(true);
    expect(m.registry.get(tenant.id)?.features?.visits?.on).toBe(true);
    expect(m.registry.get(other.id)?.features).toBeUndefined();
  });
});
