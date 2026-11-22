import { afterEach, describe, expect, it } from "vitest";
import { propertyContext } from "../src/cleaner-core/hosted/router";
import { resetFixerDesks } from "../src/fixer-core/desk";
import { oversightCall } from "../src/hosted/oversight";
import { resetLockDesks, tickAllLocks, visitorLineText } from "../src/hosted/locks";
import { hubFor, resetHubs } from "../src/hub/hub";
import { FakeLockAdapter } from "../src/locks/fake";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { readOversight, writeOversight } from "../src/oversight/store";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { FAKE_LOCK_CREDENTIALS, switchOn } from "./featureEnv";
import type { Feature } from "../src/features/features";

/**
 * Visit codes on the shared service (#280 17): a visitor's YES on the shared line for their own property only, and the
 * lock clock putting their code on the lock. Fake lock adapter, 555 numbers, no code in any note.
 */

const NOW = new Date("2026-11-17T14:00:00.000Z");
const MIKE = "+15555550161";
let clock = new Date(NOW);
let open: MultiTenantApp | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
  resetFixerDesks();
  resetHubs();
  setLockAdapter(undefined);
  resetLockDesks();
  clock = new Date(NOW);
});

async function world(features: Feature[] = ["locks", "oversight"]) {
  open = await multiTenantApp({ env: { ...FAKE_LOCK_CREDENTIALS }, now: () => clock });
  const m = open;
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  const make = (label: string, number: string, deviceId: string) => {
    const { tenant } = m.registry.create({ label, twilioNumber: number });
    switchOn(m.registry, tenant.id, ...features);
    m.registry.addProperty(tenant.id, `${label} house`);
    const added = m.registry.get(tenant.id)!.properties[0]!;
    m.registry.setFlow(tenant.id, added.id, "fixer", true);
    const device = fake.addDevice(tenant.id, { id: deviceId, name: "Front door" });
    const fresh = m.registry.get(tenant.id)!;
    const prop = fresh.properties[0]!;
    const ctx = propertyContext(m.hosted(), fresh, prop);
    const hub = hubFor(ctx.root, { now: () => clock });
    hub.saveProperty({ address: `1 ${label} Lane, Teaneck, NJ 07666`, timeZone: "America/New_York" });
    hub.doorAccess(ctx.env).saveLocks({ ...emptyLocks(), customerKey: tenant.id, devices: [storedDevice(device)], doors: [device.id], activeAt: NOW.toISOString() });
    return { tenant: fresh, property: prop, root: ctx.root };
  };
  return { m, fake, a: make("Lane", "+15555550150", "dev-a"), b: make("Court", "+15555550160", "dev-b") };
}

function invited(root: string): void {
  writeOversight(root, {
    visits: [{ id: "v-0000aaaa", who: "Mike Doyle", date: "2026-11-19", from: "12:00", to: "17:00", source: "text", savedAt: NOW.toISOString(), phone: MIKE }],
    visitors: [{ phone: MIKE, name: "Mike Doyle", addedAt: NOW.toISOString(), invitedAt: NOW.toISOString() }],
  });
}

describe("visit codes on the shared service (#280 17)", () => {
  it("takes a visitor's YES on the shared line for their own property only", async () => {
    const { m, fake, a } = await world();
    invited(a.root);
    expect(await visitorLineText(m.hosted(), a.tenant, "+15555550199", "YES")).toBe(false);
    expect(await visitorLineText(m.hosted(), a.tenant, MIKE, "YES")).toBe(true);
    expect(fake.liveCodes("dev-a")).toHaveLength(1);
    expect(fake.liveCodes("dev-b")).toEqual([]);
  });

  it("the lock clock makes the code, and nothing without the account's expected-visits switch", async () => {
    const on = await world();
    invited(on.a.root);
    const file = readOversight(on.a.root);
    file.visitors![0]!.yesAt = NOW.toISOString();
    writeOversight(on.a.root, file);
    await tickAllLocks(on.m.hosted());
    expect(on.fake.liveCodes("dev-a")).toHaveLength(1);
    open?.close();
    open = undefined;
    closeHostedApps();
    resetLockDesks();
    resetHubs();
    const off = await world(["locks"]);
    invited(off.a.root);
    const offFile = readOversight(off.a.root);
    offFile.visitors![0]!.yesAt = NOW.toISOString();
    writeOversight(off.a.root, offFile);
    await tickAllLocks(off.m.hosted());
    expect(off.fake.liveCodes("dev-a")).toEqual([]);
    expect(await visitorLineText(off.m.hosted(), off.a.tenant, MIKE, "YES")).toBe(false);
  });

  it("add_expected_visit takes a phone on connected locks, with the host's yes", async () => {
    const { m, a } = await world();
    const asked = oversightCall(m.hosted(), a.tenant, a.property, "add_expected_visit", { who: "Mike Doyle", date: "2026-11-19", from: "12:00", to: "17:00", phone: MIKE });
    expect(asked.isError).toBe(false);
    expect(asked.text).toContain("with their own door code?");
  });
});
