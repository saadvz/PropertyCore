import { hubFor } from "../src/hub/hub";
import { afterEach, describe, expect, it } from "vitest";
import { hostedCleaner, propertyContext, type HostedCleaner } from "../src/cleaner-core/hosted/router";
import { TenantSecrets } from "../src/cleaner-core/hosted/tenantSecrets";
import { liveDeskFor } from "../src/cleaner-core/liveDesk";
import { chooseSupplies, supplyDesk, turnOffSupplies, turnOnSupplies } from "../src/hosted/supplies";
import { readSupply } from "../src/supply-core/store";
import { BASE, closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/** Supply Core on each property of one account. Made-up stores; nothing reaches a store or a phone. */

const LINE = "+15555550150";
const ZONE = "America/New_York";
const COURT = { name: "Scratch Court", address: "8 Scratch Court, Teaneck, NJ 07666", timeZone: ZONE };

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

async function start() {
  open = await multiTenantApp({ env: { SUPPLY_CORE: "1" } });
  const m = open;
  const account = m.registry.create({ label: "Lane", twilioNumber: LINE }).tenant;
  const lane = m.registry.addProperty(account.id, "12 Scratch Lane");
  const court = m.registry.addProperty(account.id, "8 Scratch Court");
  m.registry.setFlow(account.id, lane.id, "cleaning", true);
  m.registry.setFlow(account.id, lane.id, "supplies", true);
  m.registry.setFlow(account.id, court.id, "supplies", true);
  const h: HostedCleaner = hostedCleaner({ registry: m.registry, secrets: new TenantSecrets(m.app.root), dataRoot: m.app.root, origin: () => BASE, baseEnv: () => m.app.inst.env(), grantLive: () => true, now: () => new Date(), log: () => undefined });
  const fresh = () => m.registry.get(account.id)!;
  const prop = (id: string) => fresh().properties.find((p) => p.id === id)!;
  return { m, h, fresh, lane: () => prop(lane.id), court: () => prop(court.id) };
}

describe("Supply Core per property", () => {
  it("a property with cleaning on reads Cleaner Core's property and turnovers", async () => {
    const { h, fresh, lane } = await start();
    const ctx = propertyContext(h, fresh(), lane());
    const cleaning = liveDeskFor(ctx.root, ctx.env, () => new Date());
    await cleaning.getState("cleaners");
    expect((await cleaning.saveProperty({ business: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: ZONE })).ok).toBe(true);
    const desk = supplyDesk(h, fresh(), lane());
    expect(desk.root).toBe(ctx.root);
    expect(desk.deps.cleaningOn?.()).toBe(true);
    // Cleaner Core's property is the hub's, so Supply Core reads the same one.
    expect(hubFor(ctx.root, { now: () => new Date() }).property()).toMatchObject({ address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: ZONE });
    expect(((await desk.state()).structured?.ask as { step?: string } | undefined)?.step).not.toBe("property");
  });

  it("a property with only supplies on knows Cleaner Core is off there", async () => {
    const { h, fresh, court } = await start();
    const desk = supplyDesk(h, fresh(), court());
    expect(desk.deps.cleaningOn?.()).toBe(false);
    expect(desk.deps.uploadBase?.()).toBe(`${BASE}/t/${fresh().id}/p/${court().id}`);
  });

  it("two properties keep separate supply lists", async () => {
    const { h, fresh, lane, court } = await start();
    const courtDesk = supplyDesk(h, fresh(), court());
    expect((await courtDesk.saveSettings({ property: COURT })).isError).toBe(false);
    expect(hubFor(courtDesk.root, { now: () => new Date() }).property()).toEqual({ nickname: COURT.name, address: COURT.address, timeZone: COURT.timeZone });
    expect(hubFor(supplyDesk(h, fresh(), lane()).root, { now: () => new Date() }).property()).toEqual({});
  });

  it("choose_supplies on turns the property's flow on; off only stops the setup question", async () => {
    const { m, h, fresh, lane } = await start();
    m.registry.setFlow(fresh().id, lane().id, "supplies", false);
    const no = await chooseSupplies(h, fresh(), lane(), { on: false });
    expect(no.isError).toBe(false);
    expect(lane().flows.supplies.on).toBe(false);
    const yes = await chooseSupplies(h, fresh(), lane(), { on: true });
    expect(yes.isError).toBe(false);
    expect(lane().flows.supplies.on).toBe(true);
    expect((await chooseSupplies(h, fresh(), lane(), {})).isError).toBe(true);
  });

  it("turning supplies off and on keeps the list", async () => {
    const { h, fresh, court } = await start();
    await supplyDesk(h, fresh(), court()).saveSettings({ property: COURT });
    await turnOffSupplies(h, fresh(), court());
    expect(court().flows.supplies.on).toBe(false);
    expect(readSupply(supplyDesk(h, fresh(), court()).root).offAt).toBeDefined();
    await turnOnSupplies(h, fresh(), court());
    expect(court().flows.supplies.on).toBe(true);
    expect(hubFor(supplyDesk(h, fresh(), court()).root, { now: () => new Date() }).property()).toEqual({ nickname: COURT.name, address: COURT.address, timeZone: COURT.timeZone });
  });
});
