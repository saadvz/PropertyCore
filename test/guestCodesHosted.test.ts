import { afterEach, describe, expect, it } from "vitest";
import { propertyContext } from "../src/cleaner-core/hosted/router";
import { resetFixerDesks } from "../src/fixer-core/desk";
import { readFixer } from "../src/fixer-core/store";
import { guestDesk, guestLineText, resetLockDesks, tickAllLocks } from "../src/hosted/locks";
import { appendBookingEmail } from "../src/hub/bookingEmails";
import { hubFor, resetHubs } from "../src/hub/hub";
import { FakeLockAdapter } from "../src/locks/fake";
import { readGuestCodes, writeGuestCodes } from "../src/locks/guestCodes";
import { GUEST_PAGE_PREFIX } from "../src/locks/guestDesk";
import { GUEST_TOOL_NAMES } from "../src/locks/guestTools";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { FAKE_LOCK_CREDENTIALS, switchOn } from "./featureEnv";
import type { Feature } from "../src/features/features";

/**
 * Guest codes on the shared service (#262): tools listed only with the account's guest-codes and locks switches, a code
 * made on the lock clock with the host told through their notes, and the host's page served only on
 * its property's path. Fake lock adapter, 555 numbers, made-up confirmation codes.
 */

const NOW = new Date("2026-12-10T12:00:00.000Z");
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

/** Two accounts on one service, each with these switches on (both locks and guest codes unless told otherwise). */
async function world(features: Feature[] = ["locks", "guest-codes"]) {
  open = await multiTenantApp({ env: { ...FAKE_LOCK_CREDENTIALS }, now: () => clock });
  const m = open;
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  const make = (label: string, number: string, deviceId: string) => {
    const { tenant } = m.registry.create({ label, twilioNumber: number });
    switchOn(m.registry, tenant.id, ...features);
    const property = m.registry.addProperty(tenant.id, `${label} house`);
    m.registry.setFlow(tenant.id, property.id, "fixer", true);
    const device = fake.addDevice(tenant.id, { id: deviceId, name: "Front door" });
    const fresh = m.registry.get(tenant.id)!;
    const prop = fresh.properties[0]!;
    const ctx = propertyContext(m.hosted(), fresh, prop);
    const hub = hubFor(ctx.root, { now: () => clock });
    hub.saveProperty({ address: `1 ${label} Lane, Teaneck, NJ 07666`, timeZone: "America/New_York" });
    hub.doorAccess(ctx.env).saveLocks({ ...emptyLocks(), customerKey: tenant.id, devices: [storedDevice(device)], doors: [device.id], activeAt: NOW.toISOString() });
    return { tenant: fresh, property: prop, root: ctx.root, device };
  };
  return { m, fake, a: make("Lane", "+15555550150", "dev-a"), b: make("Court", "+15555550160", "dev-b") };
}

const lockNews = (root: string) => [...(readFixer(root).news ?? []), ...readFixer(root).jobs.flatMap((job) => job.news)].filter((item) => item.kind === "lock").map((item) => item.text ?? "");

function booking(root: string): void {
  const at = "2026-12-09T00:00:00.000Z";
  appendBookingEmail(root, { at, receivedAt: at, from: "automated@airbnb.com", subject: "Reservation", outcome: "applied", parsed: { kind: "confirmed", confirmationCode: "HMSCRATCHAA", checkIn: { date: "2026-12-12", time: "15:00" }, checkout: { date: "2026-12-15", time: "11:00" } } });
}

describe("guest codes on the shared service", () => {
  it("lists the guest-code tools only with the account's guest-codes and locks switches on", async () => {
    const on = await world();
    const token = await on.m.joinAt(on.a.tenant.id, "grok", "/mcp");
    const names = await on.m.toolNames("/mcp", token);
    for (const name of GUEST_TOOL_NAMES) expect(names).toContain(name);
    open?.close();
    open = undefined;
    closeHostedApps();
    resetLockDesks();
    const off = await world(["locks"]);
    const offToken = await off.m.joinAt(off.a.tenant.id, "grok", "/mcp");
    const offNames = await off.m.toolNames("/mcp", offToken);
    expect(offNames.filter((name) => GUEST_TOOL_NAMES.has(name))).toEqual([]);
    expect(offNames).toContain("get_locks");
  });

  it("makes the stay's code on the lock clock, tells the host a link with no code, and serves its page on its own path only", async () => {
    const { m, fake, a, b } = await world();
    booking(a.root);
    writeGuestCodes(a.root, { ...readGuestCodes(a.root), mode: "automatic" });
    await tickAllLocks(m.hosted());
    const code = fake.liveCodes("dev-a")[0]!.code;
    const news = lockNews(a.root);
    const ready = news.find((text) => text.includes(GUEST_PAGE_PREFIX))!;
    expect(ready).toContain("the guest on 12–15 Dec");
    expect(news.join("\n").includes(code)).toBe(false);
    expect(fake.liveCodes("dev-b")).toEqual([]);
    const token = ready.slice(ready.indexOf(GUEST_PAGE_PREFIX) + GUEST_PAGE_PREFIX.length).split(/\s/)[0]!;
    const path = (tenant: { id: string }, property: { id: string }) => `/t/${tenant.id}/p/${property.id}${GUEST_PAGE_PREFIX}${token}`;
    const page = await m.app.http(path(a.tenant, a.property), { method: "GET" });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("12–15 Dec");
    expect(html.includes(code)).toBe(false);
    expect((await m.app.http(path(b.tenant, b.property), { method: "GET" })).status).toBe(404);
    const shown = await m.app.http(`${path(a.tenant, a.property)}/show`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(((await shown.json()) as { code?: string }).code).toBe(code);
    const again = await m.app.http(`${path(a.tenant, a.property)}/show`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(again.status).toBe(404);
  });

  it("makes no guest code and serves no page with the account's guest-codes switch off", async () => {
    const { m, fake, a } = await world(["locks"]);
    booking(a.root);
    writeGuestCodes(a.root, { ...readGuestCodes(a.root), mode: "automatic" });
    await tickAllLocks(m.hosted());
    expect(fake.liveCodes("dev-a")).toEqual([]);
    expect((await m.app.http(`/t/${a.tenant.id}/p/${a.property.id}${GUEST_PAGE_PREFIX}${"q".repeat(40)}`, { method: "GET" })).status).toBe(404);
  });

  it("takes a tenant's YES on the shared line for their own property only", async () => {
    const { m, fake, a } = await world();
    const desk = guestDesk(m.hosted(), a.tenant, a.property);
    writeGuestCodes(a.root, { ...readGuestCodes(a.root), leases: [{ id: "lease_scratch", name: "Sam", phone: "+15555550155", start: "2026-12-01", moveOut: "2027-06-30", addedAt: NOW.toISOString(), invitedAt: NOW.toISOString() }] });
    expect(desk.hasLease("+15555550155")).toBe(true);
    expect(await guestLineText(m.hosted(), a.tenant, "+15555550199", "YES")).toBe(false);
    expect(await guestLineText(m.hosted(), a.tenant, "+15555550155", "YES")).toBe(true);
    expect(fake.liveCodes("dev-a")).toHaveLength(1);
    expect(fake.liveCodes("dev-b")).toEqual([]);
  });
});
