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
import { accountPeople } from "../src/hosted/sharedPeople";
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

  it("one YES on the line answers both a visit invite and a Fixer invite on another property of the account", async () => {
    const { m, a } = await world();
    invited(a.root);
    const annex = m.registry.addProperty(a.tenant.id, "Lane annex");
    m.registry.setFlow(a.tenant.id, annex.id, "fixer", true);
    const people = await accountPeople(m.hosted(), m.registry.get(a.tenant.id)!);
    people.saveRolePeople(annex.id, "pro", [{ phone: MIKE, name: "Mike Doyle" }]);
    expect(people.optedIn(MIKE)).toBe(false);
    const res = await m.text("+15555550150", MIKE, "YES", "SMvisitpro01");
    expect(res.status).toBe(200);
    expect(readOversight(a.root).visitors![0]!.yesAt).toBeDefined();
    expect((await accountPeople(m.hosted(), m.registry.get(a.tenant.id)!)).optedIn(MIKE)).toBe(true);
  });
});

describe("the host's page with a visitor's code on the shared service (25 Nov)", () => {
  it("confirm_expected_visit and visit_code_link make a page on its own property's path only: no code on GET, the code once on POST", async () => {
    const { m, fake, a, b } = await world();
    invited(a.root);
    const call = (name: string, args: Record<string, unknown>) => oversightCall(m.hosted(), a.tenant, a.property, name, args);
    const twice = (name: string, args: Record<string, unknown>) => {
      const first = call(name, args);
      const code = (first.structured?.confirmation as { code?: string } | undefined)?.code;
      return code ? call(name, { ...args, confirmation: code }) : first;
    };
    expect(twice("confirm_expected_visit", { id: "v-0000aaaa", via: "call" }).isError).toBe(false);
    await tickAllLocks(m.hosted());
    expect(fake.liveCodes("dev-a")).toHaveLength(1);
    const code = fake.liveCodes("dev-a")[0]!.code;
    const made = twice("visit_code_link", { id: "v-0000aaaa" });
    expect(made.isError, made.text).toBe(false);
    expect(made.text.includes(code)).toBe(false);
    const url = String(made.structured!.url);
    const prefix = "/oversight/visit-code/";
    const pageToken = url.slice(url.indexOf(prefix) + prefix.length);
    const path = (tenant: { id: string }, property: { id: string }) => `/t/${tenant.id}/p/${property.id}${prefix}${pageToken}`;
    const page = await m.app.http(path(a.tenant, a.property), { method: "GET" });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Door code for Mike Doyle at 1 Lane Lane");
    expect(html.includes(code)).toBe(false);
    expect((await m.app.http(path(b.tenant, b.property), { method: "GET" })).status).toBe(404);
    const post = () => m.app.http(`${path(a.tenant, a.property)}/show`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const shown = await post();
    expect(shown.status).toBe(200);
    expect(((await shown.json()) as { code?: string }).code === code).toBe(true);
    expect((await post()).status).toBe(404);
    expect(m.app.logs.some((line) => line.includes(code) || line.includes(pageToken))).toBe(false);
  });
});
