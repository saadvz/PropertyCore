import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { propertyContext } from "../src/cleaner-core/hosted/router";
import { resetFixerDesks } from "../src/fixer-core/desk";
import { readFixer } from "../src/fixer-core/store";
import { resetLockDesks, tickAllLocks } from "../src/hosted/locks";
import { hubFor, resetHubs } from "../src/hub/hub";
import type { LockWebhookEvent } from "../src/locks/adapter";
import { VISIT_EVENTS_DIR } from "../src/locks/eventLog";
import { FakeLockAdapter } from "../src/locks/fake";
import { setLockAdapter } from "../src/locks/registry";
import { visitLogFor } from "../src/visits/store";
import { LOCK_TOOL_NAMES } from "../src/locks/tools";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { FAKE_LOCK_CREDENTIALS, switchOn } from "./featureEnv";

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
  resetLockDesks();
  clock = new Date(NOW);
});

/** Two accounts on one service. Each account's "locks" switch is on unless `switchedOn` leaves it out. */
async function world(options: { env?: NodeJS.ProcessEnv; switchedOn?: ("Lane" | "Court")[] } = {}) {
  const switchedOn = options.switchedOn ?? ["Lane", "Court"];
  open = await multiTenantApp({ env: options.env ?? { ...FAKE_LOCK_CREDENTIALS }, now: () => clock });
  const m = open;
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  const make = (label: string, number: string, deviceId: string) => {
    const { tenant } = m.registry.create({ label, twilioNumber: number });
    if ((switchedOn as string[]).includes(label)) switchOn(m.registry, tenant.id, "locks");
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
    expect(lines(a.root)).toEqual([expect.objectContaining({ type: "lock", id: "evt-1", action: "unlock", device: "Front door", side: "outside" })]);
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
    await door.syncGrants("repair", [{ jobId: "fix-1", person: "+15555550142", window: WINDOW, who: { role: "pro", proId: "pro_joe" } }]);
    const codeId = fake.liveCodes("dev-a")[0]!.codeId;
    const codeName = door.grants().grantOf(codeId)!.codeName;
    await send(unlock("evt-5", "dev-a", { codeId, codeName: "whatever the partner calls it" }));
    // The line carries Property Core's name for the code, which visit-codes.json maps to the pro.
    expect(lines(a.root)[0]).toMatchObject({ type: "lock", codeName });
    expect(visitLogFor(ctx.root).codeNames()[codeName]).toEqual({ role: "pro", proId: "pro_joe" });
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
    expect(lockNews(a.root)).toEqual(["The Front door couldn't save Joe's code, so Joe will get a backup code for that door."]);
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
    expect(lines(a.root).filter((line) => line.type === "lock-status").map((line) => [line.kind, line.battery])).toEqual([
      ["battery", 10],
      ["battery", 8],
      ["offline", undefined],
      ["online", undefined],
    ]);
    expect(lockNews(a.root)).toEqual([
      "The Front door's battery is low. Please change it soon so codes keep working.",
      "The Front door has been offline for 30 minutes, so codes can't change on it. Check its power and Wi-Fi.",
      "The Front door is back online.",
    ]);
  });

  it("tells the host to sign in again, with a fresh link, when the lock account is disconnected", async () => {
    const { send, a } = await world();
    await send({ id: "evt-11", kind: "account-disconnected", partnerType: "connected_account.disconnected", at: NOW.toISOString(), accountId: `acct-${a.tenant.id}`, customerKey: a.tenant.id });
    expect(lines(a.root)).toEqual([expect.objectContaining({ type: "lock-connection", id: "evt-11", connected: false })]);
    expect(lockNews(a.root)).toEqual([expect.stringMatching(/^Your lock account was disconnected, so I can't make or change codes\. Sign in again here: https:\/\/connect\.example\.com\/locks\/link-\d+$/)]);
  });

  it("with checkout-time codes on, tells the host when someone else came in during the hour before the cleaner", async () => {
    const { send, a, fake, m } = await world();
    const ctx = propertyContext(m.hosted(), a.tenant, a.property);
    const hub = hubFor(ctx.root, { now: () => clock });
    hub.saveProperty({ address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" });
    const door = hub.doorAccess(ctx.env);
    door.saveLocks({ ...door.locks(), release: { cleaners: "automatic", pros: "ask" } });
    await door.syncGrants("cleaning", [{ jobId: "job-1", person: "+15555550131", window: WINDOW, label: "Ana" }]);
    const codeId = fake.liveCodes("dev-a")[0]!.codeId;
    await send(unlock("evt-20", "dev-a", { at: "2026-12-01T15:40:00.000Z" }));
    await send(unlock("evt-21", "dev-a", { at: "2026-12-01T16:05:00.000Z", codeId }));
    await send(unlock("evt-22", "dev-a", { at: "2026-12-01T16:20:00.000Z", codeId }));
    expect(lockNews(a.root)).toEqual(["Ana just arrived. Someone else came in at 10:40 AM."]);
  });

  it("says nothing about an earlier unlock when the cleaner's code goes on the host's yes", async () => {
    const { send, a, fake, m } = await world();
    const ctx = propertyContext(m.hosted(), a.tenant, a.property);
    const door = hubFor(ctx.root, { now: () => clock }).doorAccess(ctx.env);
    await door.syncGrants("cleaning", [{ jobId: "job-1", person: "+15555550131", window: WINDOW, label: "Ana" }]);
    const codeId = fake.liveCodes("dev-a")[0]!.codeId;
    await send(unlock("evt-23", "dev-a", { at: "2026-12-01T15:40:00.000Z" }));
    await send(unlock("evt-24", "dev-a", { at: "2026-12-01T16:05:00.000Z", codeId }));
    expect(lockNews(a.root)).toEqual([]);
  });

  it("turns checkout-time codes off when the lock account disconnects, and says so", async () => {
    const { send, a, m } = await world();
    const ctx = propertyContext(m.hosted(), a.tenant, a.property);
    const door = hubFor(ctx.root, { now: () => clock }).doorAccess(ctx.env);
    door.saveLocks({ ...door.locks(), release: { cleaners: "automatic", pros: "ask" } });
    await send({ id: "evt-25", kind: "account-disconnected", partnerType: "connected_account.disconnected", at: NOW.toISOString(), accountId: `acct-${a.tenant.id}`, customerKey: a.tenant.id });
    expect(door.locks().release.cleaners).toBe("ask");
    expect(lockNews(a.root)[0]).toBe("While your lock account is disconnected, the cleaner's code won't go out at checkout. Tell me when the guests have left, like before.");
  });

  it("serves a standing code's page only on its property's path: no code on GET, the code once on POST", async () => {
    const { a, b, fake, m } = await world();
    const ctx = propertyContext(m.hosted(), a.tenant, a.property);
    const door = hubFor(ctx.root, { now: () => clock }).doorAccess(ctx.env);
    const token = "q".repeat(40);
    const hash = createHash("sha256").update(token).digest("hex");
    const yesAt = NOW.toISOString();
    door.saveLocks({ ...door.locks(), standing: [{ id: "std_pat", name: "Pat Lee", phone: "+15555550144", role: "co-host", addedAt: yesAt, invitedAt: yesAt, yesAt, link: { hash, expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(), sentAt: yesAt } }] });
    await door.syncGrants("standing", [{ jobId: "std_pat", person: "+15555550144", window: { from: yesAt, until: "2046-12-01T12:00:00.000Z" } }]);
    const code = fake.liveCodes("dev-a")[0]!.code;
    const base = (tenant: { id: string }, property: { id: string }) => `/t/${tenant.id}/p/${property.id}/locks/code/${token}`;
    const page = await m.app.http(base(a.tenant, a.property), { method: "GET" });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html.includes(code)).toBe(false);
    expect(html).toContain("Pat Lee");
    expect((await m.app.http(base(b.tenant, b.property), { method: "GET" })).status).toBe(404);
    expect((await m.app.http(`${base(a.tenant, a.property)}/show`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    const shown = await m.app.http(`${base(a.tenant, a.property)}/show`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(((await shown.json()) as { code?: string }).code).toBe(code);
    const again = await m.app.http(`${base(a.tenant, a.property)}/show`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(again.status).toBe(404);
    expect(((await again.json()) as { code?: string }).code).toBeUndefined();
  });

  it("lists the lock tools and puts the lock status in get_state only with the account's locks switch on, never a code", async () => {
    const { a, m, fake } = await world();
    const ctx = propertyContext(m.hosted(), a.tenant, a.property);
    await hubFor(ctx.root, { now: () => clock }).doorAccess(ctx.env).syncGrants("cleaning", [{ jobId: "job-1", person: "+15555550131", window: WINDOW }]);
    const token = await m.joinAt(a.tenant.id, "grok", "/mcp");
    const names = await m.toolNames("/mcp", token);
    for (const name of ["get_locks", "connect_lock", "save_locks", "lock_settings", "add_standing_code"]) expect(names).toContain(name);
    const state = await m.toolAt("/mcp", token, "get_state", { property: a.property.id });
    expect(state.structured?.locks).toMatchObject({ connected: true });
    const locks = await m.toolAt("/mcp", token, "get_locks", { property: a.property.id });
    expect(locks.isError).toBe(false);
    expect(locks.raw.includes(fake.liveCodes("dev-a")[0]!.code)).toBe(false);
    open?.close();
    open = undefined;
    closeHostedApps();
    const off = await world({ switchedOn: [] });
    const offToken = await off.m.joinAt(off.a.tenant.id, "grok", "/mcp");
    expect((await off.m.toolNames("/mcp", offToken)).filter((name) => LOCK_TOOL_NAMES.has(name))).toEqual([]);
  });

  it("is not served while no account has its locks switch on", async () => {
    const { send } = await world({ switchedOn: [] });
    expect((await send(unlock("evt-12", "dev-a"))).status).toBe(404);
  });

  it("is not served without the lock partner's credentials, even with an account's switch on", async () => {
    const { send } = await world({ env: {} });
    expect((await send(unlock("evt-13", "dev-a"))).status).toBe(404);
  });

  it("drops an event for an account whose locks switch is off, while another account's is on", async () => {
    const { send, a, b } = await world({ switchedOn: ["Lane"] });
    expect((await send(unlock("evt-14", "dev-b"))).status).toBe(200);
    expect(lines(b.root).filter((line) => line.type === "lock")).toEqual([]);
    expect((await send(unlock("evt-15", "dev-a"))).status).toBe(200);
    expect(lines(a.root).some((line) => line.type === "lock")).toBe(true);
  });
});
