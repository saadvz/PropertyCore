import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { propertyContext } from "../src/cleaner-core/hosted/router";
import { resetFixerDesks } from "../src/fixer-core/desk";
import { readFixer } from "../src/fixer-core/store";
import { tickAllLocks } from "../src/hosted/locks";
import { hubFor, resetHubs } from "../src/hub/hub";
import type { LockWebhookEvent } from "../src/locks/adapter";
import { VISIT_EVENTS_DIR } from "../src/locks/eventLog";
import { FakeLockAdapter } from "../src/locks/fake";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/**
 * The lock partner's webhook on the shared service (#180): verified before it's read, applied only to
 * the account and property it names, stored once, and the host told once. Fake adapter, 555 numbers.
 */

const NOW = new Date("2026-12-01T12:00:00.000Z");
const WINDOW = { from: "2026-12-01T16:00:00.000Z", until: "2026-12-02T05:00:00.000Z" };
let clock = new Date(NOW);
let open: MultiTenantApp | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
  resetFixerDesks();
  resetHubs();
  setLockAdapter(undefined);
  clock = new Date(NOW);
});

async function world(env: NodeJS.ProcessEnv = { SMART_LOCKS: "1", FIXER_CORE: "1" }) {
  open = await multiTenantApp({ env, now: () => clock });
  const m = open;
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  const make = (label: string, number: string, deviceId: string) => {
    const { tenant } = m.registry.create({ label, twilioNumber: number });
    const property = m.registry.addProperty(tenant.id, `${label} house`);
    m.registry.setFlow(tenant.id, property.id, "fixer", true);
    const device = fake.addDevice(tenant.id, { id: deviceId, name: "Front door" });
    const fresh = m.registry.get(tenant.id)!;
    const prop = fresh.properties[0]!;
    const ctx = propertyContext(m.hosted(), fresh, prop);
    hubFor(ctx.root, { now: () => clock })
      .doorAccess(ctx.env)
      .saveLocks({ ...emptyLocks(), customerKey: tenant.id, devices: [storedDevice(device)], doors: [device.id], activeAt: NOW.toISOString() });
    return { tenant: fresh, property: prop, root: ctx.root, device };
  };
  const a = make("Lane", "+15555550150", "dev-a");
  const b = make("Court", "+15555550160", "dev-b");
  const post = (headers: Record<string, string>, body: string) => m.app.http("/webhooks/seam", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  const send = (event: LockWebhookEvent) => {
    const signed = fake.webhook(event);
    return post(signed.headers, signed.body);
  };
  return { m, fake, a, b, post, send };
}

function lines(root: string): Record<string, unknown>[] {
  const dir = join(root, VISIT_EVENTS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>));
}

const lockNews = (root: string) => [...(readFixer(root).news ?? []), ...readFixer(root).jobs.flatMap((job) => job.news)].filter((item) => item.kind === "lock").map((item) => item.text);

const unlock = (id: string, deviceId: string, extra: Partial<LockWebhookEvent> = {}): LockWebhookEvent => ({ id, kind: "unlock", partnerType: "lock.unlocked", at: "2026-12-01T16:05:00.000Z", deviceId, side: "outside", ...extra });

describe("the lock webhook", () => {
  it("refuses a webhook that fails verification and changes nothing", async () => {
    const { post, a, b, fake } = await world();
    const signed = fake.webhook(unlock("evt-1", "dev-a"));
    expect((await post(signed.headers, signed.body.replace("evt-1", "evt-9"))).status).toBe(401);
    expect((await post({}, signed.body)).status).toBe(401);
    expect(lines(a.root)).toEqual([]);
    expect(lines(b.root)).toEqual([]);
  });

  it("stores an event only on the property whose device it names, once", async () => {
    const { send, a, b } = await world();
    expect((await send(unlock("evt-1", "dev-a"))).status).toBe(200);
    expect((await send(unlock("evt-1", "dev-a"))).status).toBe(200);
    expect(lines(a.root)).toEqual([expect.objectContaining({ type: "lock", id: "evt-1", action: "unlock", device: "Front door", deviceId: "dev-a", side: "outside" })]);
    expect(lines(b.root)).toEqual([]);
  });

  it("never crosses accounts: an event tagged with one account naming another's device is dropped", async () => {
    const { send, a, b } = await world();
    expect((await send(unlock("evt-2", "dev-a", { customerKey: b.tenant.id }))).status).toBe(200);
    expect(lines(a.root)).toEqual([]);
    expect(lines(b.root)).toEqual([]);
  });

  it("drops an event for an unknown device", async () => {
    const { send, a, b } = await world();
    expect((await send(unlock("evt-3", "dev-nobody"))).status).toBe(200);
    expect(lines(a.root)).toEqual([]);
    expect(lines(b.root)).toEqual([]);
  });

  it("stores no digit run of 4 or more, even when the partner sends one", async () => {
    const { send, a } = await world();
    await send(unlock("evt-4", "dev-a", { codeName: ["Code ", "9", "9", "1", "2"].join(""), method: "keypad" }));
    const text = JSON.stringify(lines(a.root));
    expect(/\d{4,}/.test(text.replace(/"(at|loggedAt)":"[^"]+"/g, ""))).toBe(false);
  });

  it("names the grant whose code opened the door", async () => {
    const { send, a, fake, m } = await world();
    const ctx = propertyContext(m.hosted(), a.tenant, a.property);
    const door = hubFor(ctx.root, { now: () => clock }).doorAccess(ctx.env);
    await door.syncGrants("repair", [{ jobId: "fix-1", person: "+15555550142", window: WINDOW }]);
    const codeId = fake.liveCodes("dev-a")[0]!.codeId;
    await send(unlock("evt-5", "dev-a", { codeId }));
    expect(lines(a.root)[0]).toMatchObject({ grant: { flow: "repair", jobId: "fix-1" } });
  });

  it("a code that failed pulls a backup code now and tells the host once", async () => {
    const { send, a, fake, m } = await world();
    const ctx = propertyContext(m.hosted(), a.tenant, a.property);
    const door = hubFor(ctx.root, { now: () => clock }).doorAccess(ctx.env);
    fake.programSlowly("dev-a");
    // Cleaner Core is off here, so no desk syncs the cleaning codes away while the note is kept.
    await door.syncGrants("cleaning", [{ jobId: "job-1", person: "+15555550142", window: WINDOW, label: "Joe" }]);
    const codeId = fake.liveCodes("dev-a")[0]!.codeId;
    await send({ id: "evt-6", kind: "code-failed", partnerType: "access_code.failed_to_set_on_device", at: NOW.toISOString(), deviceId: "dev-a", codeId });
    await send({ id: "evt-6", kind: "code-failed", partnerType: "access_code.failed_to_set_on_device", at: NOW.toISOString(), deviceId: "dev-a", codeId });
    expect(fake.liveCodes("dev-a").filter((code) => code.backup).length).toBe(1);
    expect(lockNews(a.root)).toEqual(["The Front door didn't take Joe's code. A backup code for that door is ready, and Joe gets it with their code."]);
  });

  it("tells the host once about a low battery, and about a lock offline for 30 minutes and back", async () => {
    const { send, a, m } = await world();
    await send({ id: "evt-7", kind: "battery-low", partnerType: "device.low_battery", at: NOW.toISOString(), deviceId: "dev-a", battery: 0.1 });
    await send({ id: "evt-8", kind: "battery-low", partnerType: "device.low_battery", at: NOW.toISOString(), deviceId: "dev-a", battery: 0.08 });
    await send({ id: "evt-9", kind: "offline", partnerType: "device.disconnected", at: NOW.toISOString(), deviceId: "dev-a" });
    clock = new Date(NOW.getTime() + 29 * 60_000);
    await tickAllLocks(m.hosted());
    expect(lockNews(a.root).length).toBe(1);
    clock = new Date(NOW.getTime() + 30 * 60_000);
    await tickAllLocks(m.hosted());
    await tickAllLocks(m.hosted());
    await send({ id: "evt-10", kind: "online", partnerType: "device.connected", at: clock.toISOString(), deviceId: "dev-a" });
    expect(lockNews(a.root)).toEqual([
      "The Front door's battery is low. Change it soon, so no code stops working.",
      "The Front door has been offline for 30 minutes, so codes can't change on it. Check its power and Wi-Fi.",
      "The Front door is back online.",
    ]);
  });

  it("tells the host to sign in again, with a fresh link, when the lock account is disconnected", async () => {
    const { send, a } = await world();
    await send({ id: "evt-11", kind: "account-disconnected", partnerType: "connected_account.disconnected", at: NOW.toISOString(), accountId: `acct-${a.tenant.id}`, customerKey: a.tenant.id });
    expect(lockNews(a.root)).toEqual([expect.stringMatching(/^Your lock account was disconnected, so I can't make or change codes\. Sign in again here: https:\/\/connect\.example\.com\/locks\/link-\d+$/)]);
  });

  it("is not served with SMART_LOCKS off", async () => {
    const { send } = await world({ FIXER_CORE: "1" });
    expect((await send(unlock("evt-12", "dev-a"))).status).toBe(404);
  });
});
