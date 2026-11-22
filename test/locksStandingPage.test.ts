import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { propertyContext } from "../src/cleaner-core/hosted/router";
import { resetFixerDesks } from "../src/fixer-core/desk";
import { readFixer } from "../src/fixer-core/store";
import { CODE_PAGE_SCRIPT, guestDesk, resetLockDesks, tickAllLocks } from "../src/hosted/locks";
import { hubFor, resetHubs } from "../src/hub/hub";
import { STANDING_PAGE_PREFIX } from "../src/locks/desk";
import { FakeLockAdapter } from "../src/locks/fake";
import { readGuestCodes, writeGuestCodes } from "../src/locks/guestCodes";
import { GUEST_PAGE_PREFIX } from "../src/locks/guestDesk";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, readDoorLocks, storedDevice, writeDoorLocks } from "../src/locks/settings";
import { closeHostedApps } from "./cleanerOauthHarness";
import { FAKE_LOCK_CREDENTIALS, switchOn } from "./featureEnv";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/**
 * The standing and guest code pages on the shared service, with their script run against the
 * service (#180 live run: tapping "show me the code" did nothing, because the script had a syntax
 * error). Every tap ends in the code or a plain line, never silence. Fake lock adapter, 555 numbers,
 * made-up tokens.
 */

const NOW = new Date("2026-12-10T12:00:00.000Z");
let open: MultiTenantApp | undefined;

afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
  resetFixerDesks();
  resetHubs();
  setLockAdapter(undefined);
  resetLockDesks();
});

async function world() {
  open = await multiTenantApp({ env: { ...FAKE_LOCK_CREDENTIALS }, now: () => NOW });
  const m = open;
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: "+15555550150" });
  switchOn(m.registry, tenant.id, "locks", "guest-codes");
  m.registry.addProperty(tenant.id, "Lane house");
  const property = m.registry.get(tenant.id)!.properties[0]!;
  m.registry.setFlow(tenant.id, property.id, "fixer", true);
  const fresh = m.registry.get(tenant.id)!;
  const prop = fresh.properties[0]!;
  const ctx = propertyContext(m.hosted(), fresh, prop);
  const device = fake.addDevice(tenant.id, { id: "dev-a", name: "Front door" });
  const hub = hubFor(ctx.root, { now: () => NOW });
  hub.saveProperty({ address: "1 Lane Lane, Teaneck, NJ 07666", timeZone: "America/New_York" });
  hub.doorAccess(ctx.env).saveLocks({ ...emptyLocks(), customerKey: tenant.id, devices: [storedDevice(device)], doors: [device.id], activeAt: NOW.toISOString() });
  return { m, fake, tenant: fresh, property: prop, root: ctx.root };
}

const TOKEN = "q".repeat(20) + "z".repeat(20);
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** A standing person who replied YES, with a live link for TOKEN. Written as the desk would. */
function standingWithLink(root: string): void {
  const file = readDoorLocks(root);
  const at = NOW.toISOString();
  writeDoorLocks(root, { ...file, standing: [{ id: "std_scratchaaa", name: "Pat Lee", phone: "+15555550144", role: "co-host", addedAt: at, invitedAt: at, yesAt: at, link: { hash: hash(TOKEN), expiresAt: "2026-12-11T12:00:00.000Z", sentAt: at } }] });
}

/** Opens the page, checks its script runs under its own CSP, and returns a tap that resolves to the line the page shows. */
async function page(m: MultiTenantApp, path: string) {
  const res = await m.app.http(path, { method: "GET" });
  expect(res.status).toBe(200);
  const csp = String((res.headers as unknown as Record<string, string>)["content-security-policy"] ?? "");
  const html = await res.text();
  const script = /<script nonce="([^"]+)">([\s\S]*?)<\/script>/.exec(html)!;
  expect(csp).toContain(`script-src 'nonce-${script[1]}'`);
  expect(script[2]).toBe(CODE_PAGE_SCRIPT);
  const dataset: Record<string, string> = {};
  for (const [, key, value] of html.matchAll(/data-([a-z]+)="([^"]*)"/g)) dataset[key!] = value!.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  let click: (() => void) | undefined;
  const button = { disabled: false, hidden: false, addEventListener: (_: string, fn: () => void) => (click = fn) };
  const out = { textContent: "" };
  const fetches: { url: string; method: string }[] = [];
  runInNewContext(script[2]!, {
    document: { getElementById: (id: string) => (id === "show" ? button : id === "out" ? out : { dataset }) },
    location: { pathname: path },
    fetch: async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      fetches.push({ url, method: init.method });
      return m.app.http(url, init);
    },
  });
  expect(click).toBeDefined();
  return {
    fetches,
    button,
    tap: async () => {
      out.textContent = "";
      click!();
      for (let i = 0; i < 200 && !out.textContent; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      return out.textContent;
    },
  };
}

describe("the standing code page", () => {
  it("its script is valid JavaScript (the live run's had `//` from an eaten backslash)", () => {
    expect(() => new Function(CODE_PAGE_SCRIPT)).not.toThrow();
    expect(CODE_PAGE_SCRIPT).not.toContain("\\");
  });

  it("a tap shows a plain line while the code is still going on the lock, then the code once, then that the link ended", async () => {
    const { m, fake, tenant, property, root } = await world();
    fake.programSlowly("dev-a");
    standingWithLink(root);
    const path = `/t/${tenant.id}/p/${property.id}${STANDING_PAGE_PREFIX}${TOKEN}`;
    const shown = await page(m, path);
    expect(await shown.tap()).toBe("Your code is still being added to the lock. Try again in a minute.");
    expect(shown.fetches).toEqual([{ url: `${path}/show`, method: "POST" }]);
    expect(shown.button.disabled).toBe(false);
    fake.settle("dev-a");
    const code = fake.liveCodes("dev-a")[0]!.code;
    expect(await shown.tap()).toBe(`Your code: ${code}`);
    expect(shown.button.hidden).toBe(true);
    expect(await shown.tap()).toBe("This link has ended. Ask the host for a new one.");
  });

  it("a lock that refused the code shows why, and the host hears it once through the alerts path", async () => {
    const { m, fake, tenant, property, root } = await world();
    fake.failCodes("dev-a");
    standingWithLink(root);
    await tickAllLocks(m.hosted());
    expect(fake.liveCodes("dev-a")).toHaveLength(1);
    const shown = await page(m, `/t/${tenant.id}/p/${property.id}${STANDING_PAGE_PREFIX}${TOKEN}`);
    expect(await shown.tap()).toBe("Your code couldn't be added to the lock yet. The host has been told, and this link still works once it's there.");
    const news = [...(readFixer(root).news ?? []), ...readFixer(root).jobs.flatMap((job) => job.news)].filter((item) => item.kind === "lock").map((item) => item.text ?? "");
    expect(news.filter((text) => text.includes("Pat Lee's standing code"))).toHaveLength(1);
    expect(news.join("\n").includes(fake.liveCodes("dev-a")[0]!.code)).toBe(false);
  });

  it("the lock clock puts a standing code on the lock after the YES, when the YES-time try didn't", async () => {
    const { m, fake, root } = await world();
    standingWithLink(root);
    expect(fake.liveCodes("dev-a")).toEqual([]);
    await tickAllLocks(m.hosted());
    expect(fake.liveCodes("dev-a")).toHaveLength(1);
  });
});

describe("the guest code page shares the renderer, and its faults are fixed too", () => {
  it("a tenant's lease page says the code is still going on, keeps the link, then shows it once", async () => {
    const { m, fake, tenant, property, root } = await world();
    fake.programSlowly("dev-a");
    const at = NOW.toISOString();
    writeGuestCodes(root, { ...readGuestCodes(root), leases: [{ id: "lease_scratch", name: "Sam", phone: "+15555550155", start: "2026-12-01", moveOut: "2027-06-30", addedAt: at, invitedAt: at, yesAt: at, link: { hash: hash(TOKEN), expiresAt: "2026-12-11T12:00:00.000Z", sentAt: at } }] });
    await guestDesk(m.hosted(), tenant, property).sync();
    const shown = await page(m, `/t/${tenant.id}/p/${property.id}${GUEST_PAGE_PREFIX}${TOKEN}`);
    expect(await shown.tap()).toBe("Your code is still being added to the lock. Try again in a minute.");
    fake.settle("dev-a");
    expect(await shown.tap()).toBe(`Your code: ${fake.liveCodes("dev-a")[0]!.code}`);
    expect(await shown.tap()).toBe("This link has ended. Ask for a new one.");
  });

  it("a lease whose invite couldn't go is sent on the lock clock, not lost as waiting for YES", async () => {
    const { m, tenant, property, root } = await world();
    writeGuestCodes(root, { ...readGuestCodes(root), leases: [{ id: "lease_scratch", name: "Sam", phone: "+15555550155", start: "2026-12-01", moveOut: "2027-06-30", addedAt: NOW.toISOString() }] });
    // No Cleaner Core here, so the property's texts aren't on: the invite waits, unmarked, for the next pass that can send it.
    await guestDesk(m.hosted(), tenant, property).sync();
    expect(readGuestCodes(root).leases[0]!.invitedAt).toBeUndefined();
  });
});
