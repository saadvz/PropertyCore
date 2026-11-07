import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tenantFolder } from "../src/cleaner-core/hosted/registry";
import { hostedCleaner, propertyContext } from "../src/cleaner-core/hosted/router";
import { TenantSecrets } from "../src/cleaner-core/hosted/tenantSecrets";
import { withCaller } from "../src/cleaner-core/callerContext";
import { liveDeskFor, resetLiveDesks } from "../src/cleaner-core/liveDesk";
import { readSupply } from "../src/supply-core/store";
import { supplyDesk } from "../src/supply-core/hosted";
import { BASE, closeHostedApps } from "./cleanerOauthHarness";
import { ROUTINE, setUp } from "./cleanerDeskHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { CLEANER, HOST, TEST_PIN_KEY } from "./wiringProof";

/** set_flows on one property of an account: on, off with a stand-down, and Fixer Core. Only 555 numbers. */

const LINE = "+15555550150";
const SLOW = { timeout: 90_000 };
const PATH = "/mcp/cleaner-core";

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
});

async function start(env: NodeJS.ProcessEnv = {}) {
  open = await multiTenantApp({ env: { SUPPLY_CORE: "1", ...env } });
  const m = open;
  const account = m.registry.create({ label: "Lane", twilioNumber: LINE }).tenant;
  const lane = m.registry.addProperty(account.id, "12 Scratch Lane");
  const court = m.registry.addProperty(account.id, "8 Scratch Court");
  const token = await m.join(account.id, "grok");
  const h = hostedCleaner({ registry: m.registry, secrets: new TenantSecrets(m.app.root), dataRoot: m.app.root, origin: () => BASE, baseEnv: () => m.app.inst.env(), grantLive: () => true, now: () => new Date(), log: () => undefined });
  const prop = (id: string) => m.registry.get(account.id)!.properties.find((p) => p.id === id)!;
  return { m, h, account, token, lane: () => prop(lane.id), court: () => prop(court.id) };
}

/** Takes Lane through Cleaner Core's setup on its own desk, with the cleaner's first YES. */
async function confirmedJob(s: Awaited<ReturnType<typeof start>>) {
  // The routine belongs to the account's Grok chat, as when it saved it.
  const primary = s.m.registry.primary(s.account.id, () => true)!;
  s.h.secrets.setForConnection(s.account.id, primary.grantId, { CLEANER_CORE_ROUTINE_URL: ROUTINE.url, CLEANER_CORE_ROUTINE_KEY: ROUTINE.token });
  // The service's door-code key, as on the live service, so a reopened desk opens the saved code.
  s.h.secrets.set(s.account.id, { CLEANER_CORE_PIN_KEY: TEST_PIN_KEY });
  const ctx = propertyContext(s.h, s.m.registry.get(s.account.id)!, s.lane());
  const desk = liveDeskFor(ctx.root, ctx.env, () => new Date());
  // As the account's Grok chat, so its routine counts as the primary's own.
  await withCaller({ assistant: "grok", connectionId: primary.grantId }, () => setUp(desk, { groupChat: "cleaner-only" }));
  await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
  await desk.inbound({ id: "yes-job", from: CLEANER, text: "YES" });
  const live = await desk.liveWork();
  expect(live.live.length).toBeGreaterThan(0);
  return desk;
}

const audit = (m: MultiTenantApp, accountId: string) =>
  readFileSync(join(tenantFolder(m.app.root, accountId), "service-audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

describe("set_flows", () => {
  it("turning cleaning on starts its setup and lists its tools", SLOW, async () => {
    const s = await start();
    expect(await s.m.toolNames(PATH, s.token)).not.toContain("save_people");
    const on = await s.m.toolAt(PATH, s.token, "set_flows", { property: s.lane().id, cleaning: true });
    expect(on.isError).toBe(false);
    expect(s.lane().flows.cleaning.on).toBe(true);
    expect(s.court().flows.cleaning.on).toBe(false);
    expect(await s.m.toolNames(PATH, s.token)).toContain("save_people");
    expect(audit(s.m, s.account.id).at(-1)).toMatchObject({ actor: "host", property: s.lane().id, flow: "cleaning", on: true, forced: false });
  });

  it("turning cleaning off with nothing live takes one call", SLOW, async () => {
    const s = await start();
    await s.m.toolAt(PATH, s.token, "set_flows", { property: s.lane().id, cleaning: true });
    const off = await s.m.toolAt(PATH, s.token, "set_flows", { property: s.lane().id, cleaning: false });
    expect(off.isError).toBe(false);
    expect(s.lane().flows.cleaning.on).toBe(false);
  });

  it("turning cleaning off with a confirmed job previews the texts and needs the code", SLOW, async () => {
    const s = await start({ CLEANER_CORE_SMS_ALLOWLIST: `${HOST},${CLEANER}` });
    s.m.registry.setFlow(s.account.id, s.lane().id, "cleaning", true);
    await confirmedJob(s);
    const before = s.m.sms.sent.length;
    const ask = await s.m.toolAt(PATH, s.token, "set_flows", { property: s.lane().id, cleaning: false });
    expect(ask.isError).toBe(false);
    expect(ask.structured?.confirmation).toMatchObject({ code: expect.any(String) });
    expect(Array.isArray(ask.structured?.texts)).toBe(true);
    expect(s.lane().flows.cleaning.on).toBe(true);
    expect(s.m.sms.sent.length).toBe(before);
  });

  it("a wrong or expired code changes nothing and sends nothing", SLOW, async () => {
    const s = await start({ CLEANER_CORE_SMS_ALLOWLIST: `${HOST},${CLEANER}` });
    s.m.registry.setFlow(s.account.id, s.lane().id, "cleaning", true);
    await confirmedJob(s);
    await s.m.toolAt(PATH, s.token, "set_flows", { property: s.lane().id, cleaning: false });
    const before = s.m.sms.sent.length;
    const wrong = await s.m.toolAt(PATH, s.token, "set_flows", { property: s.lane().id, cleaning: false, confirmation: "ZZZZZZ" });
    expect(wrong.isError).toBe(true);
    expect(s.lane().flows.cleaning.on).toBe(true);
    expect(s.m.sms.sent.length).toBe(before);
  });

  it("the right code stands down, sends exactly the previewed texts, then turns cleaning off; an approval survives a restart", SLOW, async () => {
    const s = await start({ CLEANER_CORE_SMS_ALLOWLIST: `${HOST},${CLEANER}` });
    s.m.registry.setFlow(s.account.id, s.lane().id, "cleaning", true);
    await confirmedJob(s);
    const ask = await s.m.toolAt(PATH, s.token, "set_flows", { property: s.lane().id, cleaning: false });
    const previewed = (ask.structured?.texts as { body: string }[]).map((t) => t.body);
    const before = s.m.sms.sent.length;
    resetLiveDesks();
    const code = (ask.structured?.confirmation as { code: string }).code;
    const yes = await s.m.toolAt(PATH, s.token, "set_flows", { property: s.lane().id, cleaning: false, confirmation: code });
    expect(yes.isError).toBe(false);
    expect(s.lane().flows.cleaning.on).toBe(false);
    expect(s.m.sms.sent.slice(before).map((t) => t.body).sort()).toEqual([...previewed].sort());
  });

  it("the setup is kept and picks up when turned back on", SLOW, async () => {
    const s = await start();
    await s.m.toolAt(PATH, s.token, "set_flows", { property: s.lane().id, cleaning: true });
    await s.m.toolAt(PATH, s.token, "get_state", { property: s.lane().id, choice: "cleaners" });
    expect((await s.m.toolAt(PATH, s.token, "save_property", { property: s.lane().id, business: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" })).isError).toBe(false);
    await s.m.toolAt(PATH, s.token, "set_flows", { property: s.lane().id, cleaning: false });
    await s.m.toolAt(PATH, s.token, "set_flows", { property: s.lane().id, cleaning: true });
    const state = await s.m.toolAt(PATH, s.token, "get_state", { property: s.lane().id });
    expect(state.structured?.done).toContain("Property saved.");
  });

  it("turning supplies on and off takes the host's yes to turn off, closes open carts and texts nobody", SLOW, async () => {
    const s = await start();
    expect((await s.m.toolAt(PATH, s.token, "set_flows", { property: s.court().id, supplies: true })).isError).toBe(false);
    expect(s.court().flows.supplies.on).toBe(true);
    const ask = await s.m.toolAt(PATH, s.token, "set_flows", { property: s.court().id, supplies: false });
    expect(s.court().flows.supplies.on).toBe(true);
    const code = (ask.structured?.confirmation as { code: string }).code;
    expect((await s.m.toolAt(PATH, s.token, "set_flows", { property: s.court().id, supplies: false, confirmation: code })).isError).toBe(false);
    expect(s.court().flows.supplies.on).toBe(false);
    expect(readSupply(supplyDesk(s.h, s.m.registry.get(s.account.id)!, s.court()).root).offAt).toBeDefined();
    expect(s.m.sms.sent).toEqual([]);
  });

  it("fixer is refused", SLOW, async () => {
    const s = await start();
    const fixer = await s.m.toolAt(PATH, s.token, "set_flows", { property: s.lane().id, fixer: true });
    expect(fixer).toMatchObject({ isError: true, text: "Fixer Core isn't available yet." });
    expect(s.lane().flows.fixer.on).toBe(false);
  });

  it("needs a property and at least one flow", SLOW, async () => {
    const s = await start();
    expect((await s.m.toolAt(PATH, s.token, "set_flows", { cleaning: true })).text).toContain("Which property?");
    expect((await s.m.toolAt(PATH, s.token, "set_flows", { property: s.lane().id })).isError).toBe(true);
  });
});
