import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { propertyFolder } from "../src/cleaner-core/hosted/properties";
import { propertyContext } from "../src/cleaner-core/hosted/router";
import { resetLockDesks } from "../src/hosted/locks";
import { hubFor, resetHubs } from "../src/hub/hub";
import { FakeLockAdapter } from "../src/locks/fake";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { readOversight } from "../src/oversight/store";
import { OVERSIGHT_TOOLS } from "../src/oversight/tools";
import { resetVisitLogCache, VisitLog } from "../src/visits/store";
import { closeHostedApps } from "./cleanerOauthHarness";
import { hub, supply } from "./hoursFixture";
import { credentialsFor, switchOn } from "./featureEnv";
import type { Feature } from "../src/features/features";
import { randomBytes } from "node:crypto";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/** #240 on the shared service: expected visits, behind the account's "oversight" switch, for the property a call names. */

const LANE = "+15555550152";
const PATH = "/mcp";
const SLOW = { timeout: 90_000 };
const NOW = new Date("2026-11-17T15:00:00.000Z");
const TOOLS = ["add_expected_visit", "list_expected_visits", "cancel_expected_visit"];
const MIKE = { who: "Mike Doyle", date: "2026-11-19", from: "13:00", to: "17:00", note: "walk-through" };

const CAMERA_TOKEN_KEY = randomBytes(32).toString("base64");
let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

async function account(features: Feature[]) {
  open = await multiTenantApp({ env: { SUPPLY_CORE: "1", ...credentialsFor(features), ...(features.includes("cameras") ? { CAMERA_TOKEN_KEY } : {}) }, now: () => NOW });
  const m = open;
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
  switchOn(m.registry, tenant.id, ...features);
  const property = m.registry.addProperty(tenant.id, "12 Scratch Lane");
  m.registry.setFlow(tenant.id, property.id, "supplies", true);
  const root = propertyFolder(m.app.root, tenant.id, property);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "hub.json"), JSON.stringify(hub));
  writeFileSync(join(root, "supply.json"), JSON.stringify(supply));
  const token = await m.joinAt(tenant.id, "grok", PATH);
  return { m, property, token, root };
}

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
  it("isn't listed or answered without the account's oversight switch", SLOW, async () => {
    const { m, token, property } = await account([]);
    const names = await m.toolNames(PATH, token);
    expect(names.filter((name) => TOOLS.includes(name))).toEqual([]);
    const reply = await m.toolAt(PATH, token, "list_expected_visits", { property: property.id });
    expect(reply.isError).toBe(true);
  });

  it("is listed with the account's oversight switch on, adds, lists and cancels", SLOW, async () => {
    const { m, token, property, root } = await account(["oversight"]);
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
    const { m, token, property, root } = await account(["oversight"]);
    const refused = await m.toolAt(PATH, token, "add_expected_visit", { property: property.id, ...MIKE, note: `Code ${["4", "8", "2", "1"].join("")}` });
    expect(refused.isError).toBe(true);
    expect(readOversight(root).visits).toEqual([]);
  });

  it("reads the property's evidence by the account's switches: no lock without locks, camera sightings with cameras (#240)", SLOW, async () => {
    const today = { who: "Mike Doyle", date: "2026-11-17", from: "08:00", to: "09:00" };
    const ding = { type: "camera" as const, id: "cam-ev-1", at: "2026-11-17T13:30:00.000Z", kind: "ding" as const, deviceId: "cam-1", provider: "ring" as const, device: "Front porch" };
    const { m, token, property, root } = await account(["oversight", "cameras"]);
    new VisitLog(root, () => NOW).append(ding);
    await m.toolAt(PATH, token, "add_expected_visit", { property: property.id, ...today });
    const listed = await m.toolAt(PATH, token, "list_expected_visits", { property: property.id });
    expect(listed.structured?.results).toEqual([expect.objectContaining({ outcome: "unknown", why: "no-lock", sightings: [{ at: ding.at, device: "Front porch" }] })]);
    open?.close();
    closeHostedApps();
    resetVisitLogCache();
    const off = await account(["oversight"]);
    new VisitLog(off.root, () => NOW).append(ding);
    await off.m.toolAt(PATH, off.token, "add_expected_visit", { property: off.property.id, ...today });
    const plain = await off.m.toolAt(PATH, off.token, "list_expected_visits", { property: off.property.id });
    expect(plain.structured?.results).toEqual([expect.objectContaining({ outcome: "unknown", why: "no-lock", sightings: [] })]);
  });
});

describe("expected visits on a property with connected locks (#240)", () => {
  afterEach(() => {
    resetHubs();
    setLockAdapter(undefined);
    resetLockDesks();
    resetVisitLogCache();
  });

  async function switched(features: Feature[], on: boolean, offline = "Front door") {
    open = await multiTenantApp({ env: credentialsFor(features), now: () => NOW });
    const m = open;
    const fake = new FakeLockAdapter();
    setLockAdapter(fake);
    const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
    switchOn(m.registry, tenant.id, ...features);
    const added = m.registry.addProperty(tenant.id, "12 Scratch Lane");
    m.registry.setFlow(tenant.id, added.id, "fixer", true);
    const device = fake.addDevice(tenant.id, { id: "dev-a", name: "Front door" });
    const fresh = m.registry.get(tenant.id)!;
    const property = fresh.properties[0]!;
    const ctx = propertyContext(m.hosted(), fresh, property);
    const hub = hubFor(ctx.root, { now: () => NOW });
    hub.saveProperty({ address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" });
    hub.doorAccess(ctx.env).saveLocks({ ...emptyLocks(), customerKey: tenant.id, devices: [storedDevice(device)], doors: [device.id], ...(on ? { activeAt: NOW.toISOString() } : {}) });
    new VisitLog(ctx.root, () => NOW).append({ type: "lock-status", id: "st-1", at: "2026-11-17T12:40:00.000Z", kind: "offline", device: offline });
    const token = await m.joinAt(tenant.id, "grok", PATH);
    await m.toolAt(PATH, token, "add_expected_visit", { property: property.id, who: "Mike Doyle", date: "2026-11-17", from: "08:00", to: "09:00" });
    const listed = await m.toolAt(PATH, token, "list_expected_visits", { property: property.id });
    return listed.structured?.results;
  }

  it("reads the lock's lines only when the property is switched to connected locks and the account's locks are on", SLOW, async () => {
    expect(await switched(["oversight", "locks"], true)).toEqual([expect.objectContaining({ outcome: "unknown", why: "lock-quiet" })]);
  });

  it("not switched on: no lock", SLOW, async () => {
    expect(await switched(["oversight", "locks"], false)).toEqual([expect.objectContaining({ outcome: "unknown", why: "no-lock" })]);
  });

  it("the account's locks off: no lock", SLOW, async () => {
    expect(await switched(["oversight"], true)).toEqual([expect.objectContaining({ outcome: "unknown", why: "no-lock" })]);
  });

  it("a device that isn't one of the property's doors going offline is no quiet lock (review)", SLOW, async () => {
    expect(await switched(["oversight", "locks"], true, "Hall thermostat")).toEqual([expect.objectContaining({ outcome: "missed" })]);
  });
});
