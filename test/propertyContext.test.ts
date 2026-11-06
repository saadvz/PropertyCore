import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { propertyFolder, type Property } from "../src/cleaner-core/hosted/properties";
import type { Tenant } from "../src/cleaner-core/hosted/registry";
import { drainAllTenants, hostedCleaner, propertyContext, splitTenantPath, type HostedCleaner } from "../src/cleaner-core/hosted/router";
import { buildTenantEnv, PER_TENANT_NAMES } from "../src/cleaner-core/hosted/tenantEnv";
import { TenantSecrets } from "../src/cleaner-core/hosted/tenantSecrets";
import { liveDeskFor } from "../src/cleaner-core/liveDesk";
import { twilioSignature } from "../src/messaging/twilio/signature";
import { BASE, closeHostedApps } from "./cleanerOauthHarness";
import { MULTI_AUTH, multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/** Each property's folder, environment and links on the multi-tenant service. Only 555 numbers. */

const LINE = "+15555550150";
const OTHER_LINE = "+15555550160";
const HOOK = "https://grok.example/routine/hook";

let open: MultiTenantApp | undefined;
let at = Date.now();
const clock = () => new Date(at);
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

async function start() {
  at = Date.now();
  open = await multiTenantApp({ now: clock });
  const m = open;
  const account = m.registry.create({ label: "Lane", twilioNumber: LINE }).tenant;
  const lane = m.registry.addProperty(account.id, "12 Scratch Lane");
  const court = m.registry.addProperty(account.id, "8 Scratch Court");
  m.registry.setFlow(account.id, lane.id, "cleaning", true);
  m.registry.setFlow(account.id, court.id, "cleaning", true);
  return { m, account: m.registry.get(account.id)!, lane, court };
}

function hosted(m: MultiTenantApp, log: (line: string) => void = () => undefined): HostedCleaner {
  return hostedCleaner({ registry: m.registry, secrets: new TenantSecrets(m.app.root), dataRoot: m.app.root, origin: () => BASE, baseEnv: () => m.app.inst.env(), grantLive: () => true, now: clock, log });
}

/** Marks the property as the one migrated from a one-property tenant, the way migrateRegistry writes it. */
function makeLegacy(m: MultiTenantApp, tenantId: string, propertyId: string): void {
  const file = join(m.app.root, "tenants.json");
  const doc = JSON.parse(readFileSync(file, "utf8")) as { tenants: Tenant[] };
  const property = doc.tenants.find((t) => t.id === tenantId)!.properties.find((p) => p.id === propertyId)!;
  property.legacyPaths = true;
  writeFileSync(file, JSON.stringify(doc));
}

function groupPost(m: MultiTenantApp, path: string) {
  const fields = { EventType: "onMessageAdded", ConversationSid: "CHproperty", Author: "+15555550101", Body: "hello", MessageSid: "IMproperty" };
  const signature = twilioSignature(MULTI_AUTH, `${BASE}${path}`, fields);
  return m.app.http(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature }, body: new URLSearchParams(fields).toString() });
}

describe("buildTenantEnv with a property", () => {
  const tenant = { id: "tnt_lane000001", label: "Lane", twilioNumber: LINE, connections: [], invites: [], properties: [], createdAt: "2026-11-01T00:00:00.000Z" } as Tenant;
  const property: Property = { id: "prp_court00001", label: "8 Scratch Court", createdAt: "2026-11-01T00:00:00.000Z", flows: { cleaning: { on: true }, supplies: { on: false }, fixer: { on: false } } };

  it("a legacy property's links stay under /t/<id>", () => {
    const env = buildTenantEnv({ base: {}, tenant, secrets: new TenantSecrets("/nonexistent"), primary: undefined, origin: BASE, property: { ...property, legacyPaths: true }, propertyCount: 1 });
    expect(env.PUBLIC_BASE_URL).toBe(`${BASE}/t/${tenant.id}`);
  });

  it("a new property's links are under /t/<id>/p/<pid>", () => {
    const env = buildTenantEnv({ base: {}, tenant, secrets: new TenantSecrets("/nonexistent"), primary: undefined, origin: BASE, property, propertyCount: 2 });
    expect(env.PUBLIC_BASE_URL).toBe(`${BASE}/t/${tenant.id}/p/${property.id}`);
  });

  it("the property's id, label and count reach the desk, and the process values for them never do", () => {
    const base = { CLEANER_CORE_PROPERTY_ID: "leak", CLEANER_CORE_PROPERTY_LABEL: "leak", CLEANER_CORE_PROPERTY_COUNT: "leak" };
    for (const name of Object.keys(base)) expect(PER_TENANT_NAMES).toContain(name);
    const env = buildTenantEnv({ base, tenant, secrets: new TenantSecrets("/nonexistent"), primary: undefined, origin: BASE, property, propertyCount: 2 });
    expect(env).toMatchObject({ CLEANER_CORE_PROPERTY_ID: property.id, CLEANER_CORE_PROPERTY_LABEL: "8 Scratch Court", CLEANER_CORE_PROPERTY_COUNT: "2" });
    const none = buildTenantEnv({ base, tenant, secrets: new TenantSecrets("/nonexistent"), primary: undefined, origin: BASE });
    expect(Object.values(none)).not.toContain("leak");
  });
});

describe("splitTenantPath", () => {
  it("reads /t/<id>/<rest> and /t/<id>/p/<pid>/<rest>", () => {
    expect(splitTenantPath("/t/tnt_abcdefghij/cleaner-core/photos/x")).toEqual({ tenantId: "tnt_abcdefghij", rest: "/cleaner-core/photos/x" });
    expect(splitTenantPath("/t/tnt_abcdefghij/p/prp_abcdefghij/cleaner-core/photos/x")).toEqual({ tenantId: "tnt_abcdefghij", propertyId: "prp_abcdefghij", rest: "/cleaner-core/photos/x" });
    expect(splitTenantPath("/t/tnt_abcdefghij/p/prp_abcdefghij")).toBeUndefined();
    expect(splitTenantPath("/t/tnt_abcdefghij/p/../x")).toBeUndefined();
    expect(splitTenantPath("/t/../cleaner-core/x")).toBeUndefined();
  });
});

describe("propertyContext", () => {
  it("roots each property's desk in its own folder, with the account's line", async () => {
    const { m, account, lane, court } = await start();
    const h = hosted(m);
    const a = propertyContext(h, account, lane);
    const b = propertyContext(h, account, court);
    expect(a.root).toBe(propertyFolder(m.app.root, account.id, lane));
    expect(b.root).toBe(propertyFolder(m.app.root, account.id, court));
    expect(a.env().CLEANER_CORE_TWILIO_PHONE_NUMBER).toBe(LINE);
    expect(a.env().PUBLIC_BASE_URL).toBe(`${BASE}/t/${account.id}/p/${lane.id}`);
    expect(a.env().CLEANER_CORE_PROPERTY_COUNT).toBe("2");
  });

  it("turns Cleaner Core off for a property that was removed or whose cleaning is off", async () => {
    const { m, account, lane } = await start();
    const ctx = propertyContext(hosted(m), account, lane);
    expect(ctx.env().CLEANER_CORE_ENABLED).toBe("1");
    m.registry.setFlow(account.id, lane.id, "cleaning", false);
    expect(ctx.env().CLEANER_CORE_ENABLED).toBe("0");
  });
});

describe("links on a property's path", () => {
  it("a group webhook on /t/<id>/p/<pid>/ reaches that property", async () => {
    const { m, account, court } = await start();
    const res = await groupPost(m, `/t/${account.id}/p/${court.id}/webhooks/twilio/cleaner-core/conversation`);
    expect(res.status).toBe(200);
  });

  it("an old /t/<id>/ group webhook reaches the migrated property", async () => {
    const { m, account, lane } = await start();
    expect((await groupPost(m, `/t/${account.id}/webhooks/twilio/cleaner-core/conversation`)).status).toBe(404);
    makeLegacy(m, account.id, lane.id);
    expect((await groupPost(m, `/t/${account.id}/webhooks/twilio/cleaner-core/conversation`)).status).toBe(200);
  });

  it("a path naming another account's property, or a property whose cleaning is off, answers 404 and sends nothing", async () => {
    const { m, account, lane, court } = await start();
    const other = m.registry.create({ label: "Other", twilioNumber: OTHER_LINE }).tenant;
    m.registry.setFlow(account.id, court.id, "cleaning", false);
    const before = m.sms.sent.length;
    expect((await groupPost(m, `/t/${other.id}/p/${lane.id}/webhooks/twilio/cleaner-core/conversation`)).status).toBe(404);
    expect((await groupPost(m, `/t/${account.id}/p/${court.id}/webhooks/twilio/cleaner-core/conversation`)).status).toBe(404);
    expect((await groupPost(m, `/t/${account.id}/p/prp_nothere000/webhooks/twilio/cleaner-core/conversation`)).status).toBe(404);
    expect(m.sms.sent.length).toBe(before);
  });
});

describe("drainAllTenants", () => {
  it("delivers each property with cleaning on, and one property's failure doesn't stop the next", async () => {
    const { m, account, lane, court } = await start();
    const logs: string[] = [];
    const h = hosted(m, (line) => logs.push(line));
    // Lane's record is broken, so its desk throws when it opens.
    mkdirSync(propertyFolder(m.app.root, account.id, lane), { recursive: true });
    writeFileSync(join(propertyFolder(m.app.root, account.id, lane), "cleaner-live.json"), "{ not json");
    // Court connects its routine while the routine is down, so its test wake waits.
    m.setWakeStatus(503);
    // The routine belongs to the account's Grok connection, as when its chat saved it.
    m.registry.connect(account.id, { grantId: "grant-grok", assistant: "grok", connectedAt: clock().toISOString() });
    h.secrets.setForConnection(account.id, "grant-grok", { CLEANER_CORE_ROUTINE_URL: HOOK, CLEANER_CORE_ROUTINE_KEY: "court-routine-key" });
    const ctx = propertyContext(h, m.registry.get(account.id)!, court);
    const desk = liveDeskFor(ctx.root, ctx.env, clock);
    expect((await desk.saveAlertRoutine({ url: HOOK, token: "court-routine-key" }, () => undefined)).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    m.setWakeStatus(200);
    at += 60 * 60_000;
    const before = m.wakes.length;
    await drainAllTenants(h);
    expect(m.wakes.slice(before).map((wake) => wake.url)).toContain(HOOK);
    expect(logs.some((line) => line.includes(account.id) && line.includes(lane.id))).toBe(true);
  });
});
