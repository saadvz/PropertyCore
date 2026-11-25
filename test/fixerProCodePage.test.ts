import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { propertyContext } from "../src/cleaner-core/hosted/router";
import { FIXER_PRO_CODE_PREFIX, resetFixerDesks, type FixerReply } from "../src/fixer-core/desk";
import { readFixer } from "../src/fixer-core/store";
import { fixerDesk } from "../src/hosted/fixer";
import { resetLockDesks } from "../src/hosted/locks";
import { hubFor, resetHubs } from "../src/hub/hub";
import { FakeLockAdapter } from "../src/locks/fake";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { FAKE_LOCK_CREDENTIALS, switchOn } from "./featureEnv";

/**
 * The host's page with a pro's door code (#243 ruling) on the shared service: served only on its property's path,
 * a button on GET, the code once on POST. Fake lock adapter, 555 numbers, a made-up pro.
 */

const NOW = new Date("2026-11-08T15:00:00.000Z");
/** The host's saved code, made up and built so it appears nowhere in this file. */
const SAVED = ["7", "3", "0", "6"].join("");
/** One visit, Tue 17 Nov, 10 AM to noon New York. */
const VISIT = { from: "2026-11-17T15:00:00.000Z", until: "2026-11-17T17:00:00.000Z" };
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

const codeOf = (reply: FixerReply) => (reply.structured?.confirmation as { code: string } | undefined)?.code;
async function approved(call: (confirmation?: string) => Promise<FixerReply>): Promise<FixerReply> {
  const first = await call();
  const code = codeOf(first);
  return code ? call(code) : first;
}

async function world() {
  open = await multiTenantApp({ env: { ...FAKE_LOCK_CREDENTIALS }, now: () => clock });
  const m = open;
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  const make = (label: string, number: string, deviceId: string) => {
    const { tenant } = m.registry.create({ label, twilioNumber: number });
    switchOn(m.registry, tenant.id, "locks");
    m.registry.addProperty(tenant.id, `${label} house`);
    m.registry.setFlow(tenant.id, m.registry.get(tenant.id)!.properties[0]!.id, "fixer", true);
    const device = fake.addDevice(tenant.id, { id: deviceId, name: "Front door" });
    const fresh = m.registry.get(tenant.id)!;
    const property = fresh.properties[0]!;
    const ctx = propertyContext(m.hosted(), fresh, property);
    const hub = hubFor(ctx.root, { now: () => clock });
    hub.saveProperty({ address: `1 ${label} Lane, Teaneck, NJ 07666`, timeZone: "America/New_York" });
    m.hosted().secrets.set(tenant.id, { CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64") });
    expect(hubFor(ctx.root, { now: () => clock }).doorAccess(propertyContext(m.hosted(), m.registry.get(tenant.id)!, property).env).save(SAVED, undefined, undefined).ok).toBe(true);
    hub.doorAccess(ctx.env).saveLocks({ ...emptyLocks(), customerKey: tenant.id, devices: [storedDevice(device)], doors: [device.id], activeAt: NOW.toISOString(), release: { cleaners: "ask", pros: "automatic" } });
    return { tenant: fresh, property, root: ctx.root };
  };
  return { m, fake, a: make("Lane", "+15555550150", "dev-a"), b: make("Court", "+15555550160", "dev-b") };
}

describe("the host's page with a pro's door code on the shared service", () => {
  it("serves on its own property's path only, shows no code on GET, and the code once on POST", async () => {
    const { m, fake, a, b } = await world();
    const desk = fixerDesk(m.hosted(), a.tenant, a.property);
    // A pro who only takes calls: no texts.
    await desk.savePro({ name: "Pat Builders", trades: ["handyman"], reach: { phone: "+15555550142" }, preferredFor: [{ trade: "handyman", rank: 1 }] });
    await desk.saveSources({ done: true });
    await desk.saveSettings({ prosDone: true });
    await desk.saveSettings({ upkeepDone: true });
    const act = await desk.activate();
    expect(act.isError, act.text).toBe(false);
    await desk.openJob({ trade: "handyman", what: "Fix the gate", urgency: "flexible", source: "host" });
    await desk.checkFixes({});
    const job = () => readFixer(a.root).jobs.at(-1)!;
    const token = (await desk.contactPro({ jobId: job().id, to: readFixer(a.root).pros[0]!.id, how: "call" })).structured!.contactToken as string;
    expect((await desk.recordContact({ contactToken: token, outcome: "booked", ...VISIT })).isError).toBe(false);
    const booked = await approved((confirmation) => desk.approveBooking({ jobId: job().id, access: "code", confirmedVia: "call", ...(confirmation ? { confirmation } : {}) }));
    expect(booked.isError, booked.text).toBe(false);
    const code = fake.liveCodes("dev-a")[0]!.code;
    const made = await approved((confirmation) => desk.proCodeLink({ jobId: job().id, ...(confirmation ? { confirmation } : {}) }));
    expect(made.isError, made.text).toBe(false);
    expect(made.text.includes(code)).toBe(false);
    const url = String(made.structured!.url);
    const pageToken = url.slice(url.indexOf(FIXER_PRO_CODE_PREFIX) + FIXER_PRO_CODE_PREFIX.length);
    const path = (tenant: { id: string }, property: { id: string }) => `/t/${tenant.id}/p/${property.id}${FIXER_PRO_CODE_PREFIX}${pageToken}`;
    const page = await m.app.http(path(a.tenant, a.property), { method: "GET" });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Door code for Pat Builders at 1 Lane Lane");
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
