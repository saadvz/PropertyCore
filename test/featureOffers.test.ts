import { afterEach, describe, expect, it } from "vitest";
import { propertyContext } from "../src/cleaner-core/hosted/router";
import { resetFixerDesks } from "../src/fixer-core/desk";
import { readFixer, writeFixer } from "../src/fixer-core/store";
import { nextOffer, offersFor, type OfferContext } from "../src/hosted/featureOffers";
import { resetLockDesks } from "../src/hosted/locks";
import { resetHubs } from "../src/hub/hub";
import { setLockAdapter } from "../src/locks/registry";
import { FakeLockAdapter } from "../src/locks/fake";
import type { Feature } from "../src/features/features";
import { closeHostedApps } from "./cleanerOauthHarness";
import { credentialsFor, switchOn } from "./featureEnv";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/**
 * After core setup, get_state offers each feature that's on for the account and fits the property, one at a time,
 * worked out from the listed tools. Every answer, yes or skip, is kept so the offer isn't made again. 555 numbers.
 */

const ALL = ["connect_lock", "get_locks", "save_locks", "guest_codes", "get_house_rules", "save_house_rules", "get_guest_facts", "save_guest_facts", "add_expected_visit", "list_expected_visits", "save_package_settings", "check_packages", "save_hours_settings", "review_hours", "export_hours", "list_visits"];
const ctx = (over: Partial<OfferContext> = {}): OfferContext => ({ listed: new Set(ALL), lockConnected: false, supplies: false, answered: [], ...over });
const ids = (c: OfferContext) => offersFor(c).map((offer) => offer.offer);

describe("the feature offers", () => {
  it("offers only what's listed, in setup order", () => {
    expect(ids(ctx({ listed: new Set() }))).toEqual([]);
    expect(ids(ctx({ listed: new Set(["save_hours_settings", "list_visits"]) }))).toEqual(["hours", "visits"]);
    expect(ids(ctx())).toEqual(["locks", "house-rules", "expected-visits", "hours", "visits"]);
  });

  it("offers guest codes only once a lock is connected, and packages only with Supply Core on", () => {
    expect(ids(ctx({ lockConnected: true, supplies: true }))).toEqual(["guest-codes", "house-rules", "expected-visits", "packages", "hours", "visits"]);
  });

  it("offers house rules as one item, whichever rules tools are listed", () => {
    expect(ids(ctx({ listed: new Set(["get_guest_facts", "save_guest_facts"]) }))).toEqual(["house-rules"]);
    expect(ids(ctx({ listed: new Set(["get_house_rules", "save_house_rules"]) }))).toEqual(["house-rules"]);
    const onYes = (names: string[]) => offersFor(ctx({ listed: new Set(names) })).find((offer) => offer.offer === "house-rules")!.onYes;
    expect(onYes(["get_house_rules", "get_guest_facts"])).toBe("Call get_house_rules and follow what it says.");
    expect(onYes(["get_guest_facts"])).toBe("Call get_guest_facts and follow what it says.");
  });

  it("gives one offer at a time with Skip always there, and skips the answered ones", () => {
    const first = nextOffer(ctx(), "grok")!;
    expect(first.offer).toBe("locks");
    expect(first.more).toBe(4);
    expect(String(first.next)).toContain("Yes and Skip as a choice card");
    expect(String(first.next)).toContain('offered: "locks"');
    expect(String(first.next)).toContain("never on a routine run");
    expect(String(nextOffer(ctx(), "claude")!.next)).toContain("a short list of choices");
    expect(nextOffer(ctx({ answered: ["locks", "house-rules"] }), "grok")!.offer).toBe("expected-visits");
    expect(nextOffer(ctx({ answered: ["locks", "house-rules", "expected-visits", "hours", "visits"] }), "grok")).toBeUndefined();
    const visits = nextOffer(ctx({ answered: ["locks", "house-rules", "expected-visits", "hours"] }), "grok")!;
    expect(String(visits.next)).toContain("with nothing to answer");
    expect(visits.more).toBeUndefined();
  });

  it("keeps every pitch to one short line", () => {
    for (const offer of offersFor(ctx({ lockConnected: true, supplies: true }))) {
      expect(offer.pitch.length, offer.offer).toBeLessThanOrEqual(160);
      expect(offer.pitch).not.toMatch(/\n|tour/i);
    }
  });
});

const NOW = new Date("2026-11-22T15:00:00.000Z");
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

/** One account with these switches on and one property running only Fixer Core, set up or not. */
async function account(features: Feature[], activated: boolean) {
  open = await multiTenantApp({ env: { ...credentialsFor(features) }, now: () => NOW });
  setLockAdapter(new FakeLockAdapter());
  const m = open;
  const { tenant } = m.registry.create({ label: "Adelie", twilioNumber: "+15555550170" });
  switchOn(m.registry, tenant.id, ...features);
  const token = await m.joinAt(tenant.id, "grok", "/mcp");
  const added = await m.toolAt("/mcp", token, "add_property", { label: "12 Scratch Lane, Teaneck, NJ 07666" });
  const property = (added.structured as { property: { id: string } }).property.id;
  expect((await m.toolAt("/mcp", token, "set_flows", { property, fixer: true })).isError).toBe(false);
  if (activated) {
    const fresh = m.registry.get(tenant.id)!;
    const root = propertyContext(m.hosted(), fresh, fresh.properties[0]!).root;
    const file = readFixer(root);
    file.settings.activatedAt = NOW.toISOString();
    writeFixer(root, file);
    resetFixerDesks();
  }
  return { m, token, property, tenantId: tenant.id };
}

describe("get_state's feature offers on the shared service", () => {
  it("waits until the property's setup is done", async () => {
    const w = await account(["hours", "visits", "oversight"], false);
    const state = await w.m.toolAt("/mcp", w.token, "get_state", { property: w.property });
    expect(state.isError).toBe(false);
    expect(state.structured?.offer).toBeUndefined();
  });

  it("offers each switched-on feature once, and keeps each answer on the property", async () => {
    const w = await account(["locks", "guest-codes", "stay-check", "oversight", "hours", "visits"], true);
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const state = await w.m.toolAt("/mcp", w.token, "get_state", { property: w.property });
      expect(state.isError).toBe(false);
      const offer = state.structured?.offer as { offer: string; next: string } | undefined;
      if (!offer) break;
      if (offer.offer === "locks") expect((state.structured?.locks as { next?: string }).next).toBeDefined();
      seen.push(offer.offer);
      expect((await w.m.toolAt("/mcp", w.token, "get_state", { property: w.property, offered: offer.offer })).isError).toBe(false);
    }
    // Guest codes need a connected lock, and packages need Supply Core: neither is offered here.
    expect(seen).toEqual(["locks", "house-rules", "expected-visits", "hours", "visits"]);
    expect(w.m.registry.get(w.tenantId)!.properties[0]!.offersAnswered).toEqual(seen);
    // A skipped lock offer isn't asked again in the lock status either.
    const after = await w.m.toolAt("/mcp", w.token, "get_state", { property: w.property });
    expect((after.structured?.locks as { next?: string }).next).toBeUndefined();
  });

  it("offers nothing with every switch off, and refuses an offer name it doesn't know", async () => {
    const w = await account([], true);
    expect((await w.m.toolAt("/mcp", w.token, "get_state", { property: w.property })).structured?.offer).toBeUndefined();
    const wrong = await w.m.toolAt("/mcp", w.token, "get_state", { property: w.property, offered: "tours" });
    expect(wrong.isError).toBe(true);
  });
});
