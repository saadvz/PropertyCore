import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXER_AGENTS_ONLY } from "../src/cleaner-core/assistant";
import { propertyFolder, type Property } from "../src/cleaner-core/hosted/properties";
import { tickAllFixers } from "../src/cleaner-core/hosted/router";
import type { Tenant } from "../src/cleaner-core/hosted/registry";
import { resetFixerDesks } from "../src/fixer-core/desk";
import { readFixer } from "../src/fixer-core/store";
import { FIXER_TOOL_NAMES } from "../src/fixer-core/tools";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/**
 * Fixer Core on the shared service, per property, behind FIXER_CORE=1, for Grok Bot and Muse only.
 * Only 555 numbers, example.com addresses and made-up pros; nobody is texted or called.
 */

const LANE = "+15555550150";
const COURT = "+15555550160";
const JOE = "+15555550142";
const SLOW = { timeout: 90_000 };
const PATH = "/mcp";
const NOW = new Date("2026-11-08T15:00:00.000Z");
/** Tuesday 10 to 12 in Teaneck. */
const TUE = { from: "2026-11-10T15:00:00.000Z", until: "2026-11-10T17:00:00.000Z" };
const PLACE = { address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" };
const JOES = { name: "Joe's Plumbing", trades: ["plumbing"], reach: { phone: JOE }, preferredFor: [{ trade: "plumbing", rank: 1 }] };

let open: MultiTenantApp | undefined;
let clock = new Date(NOW);
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
  resetFixerDesks();
  clock = new Date(NOW);
});

async function start(env: NodeJS.ProcessEnv = { FIXER_CORE: "1" }) {
  open = await multiTenantApp({ env, now: () => clock });
  return open;
}

/** An account with one property and a chat of the given kind on the shared address. */
async function account(m: MultiTenantApp, assistant: "grok" | "muse" | "claude" | "chatgpt" = "grok", number = LANE) {
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: number });
  const property = m.registry.addProperty(tenant.id, "12 Scratch Lane");
  const token = await m.joinAt(tenant.id, assistant, PATH);
  return { tenant, property, token };
}

const folder = (m: MultiTenantApp, tenant: Tenant, property: Property) => propertyFolder(m.app.root, tenant.id, property);
const flows = (m: MultiTenantApp, tenant: Tenant) => m.registry.get(tenant.id)!.properties[0]!.flows;
const codeOf = (reply: { structured?: Record<string, unknown> }) => (reply.structured!.confirmation as { code: string }).code;

/** Turns Fixer Core on and activates it with Joe saved, through the tools. */
async function activeFixer(m: MultiTenantApp, token: string, property: Property) {
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await m.toolAt(PATH, token, name, { property: property.id, ...args });
    expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
    return reply;
  };
  await call("set_flows", { fixer: true });
  await call("save_fixer_property", PLACE);
  await call("save_fixer_sources", { done: true });
  const joe = await call("save_pro", JOES);
  await call("save_fixer_settings", { prosDone: true });
  await call("save_fixer_settings", { costLineCents: null });
  await call("save_fixer_settings", { upkeepDone: true });
  await call("activate_fixer");
  return { call, joeId: joe.structured!.proId as string };
}

/** Opens a host's job and books Joe for Tuesday, with the host's yes. */
async function bookedJob(m: MultiTenantApp, token: string, property: Property) {
  const { call, joeId } = await activeFixer(m, token, property);
  const jobId = (await call("open_job", { trade: "plumbing", what: "Sink leaks", urgency: "soon", source: "host" })).structured!.jobId as string;
  await call("check_fixes");
  const contactToken = (await call("contact_pro", { jobId, to: joeId, how: "call" })).structured!.contactToken as string;
  await call("record_contact", { contactToken, outcome: "booked", ...TUE, estimateCents: 18000 });
  const ask = await call("approve_booking", { jobId });
  await call("approve_booking", { jobId, confirmation: codeOf(ask) });
  return { call, jobId, joeId };
}

describe("set_flows fixer", () => {
  it("is refused without FIXER_CORE=1, and nothing changes", SLOW, async () => {
    const m = await start({});
    const { tenant, property, token } = await account(m);
    const refused = await m.toolAt(PATH, token, "set_flows", { property: property.id, fixer: true });
    expect(refused).toMatchObject({ isError: true, text: "Fixer Core isn't available yet." });
    expect(flows(m, tenant).fixer.on).toBe(false);
    expect(existsSync(join(folder(m, tenant, property), "fixer.json"))).toBe(false);
  });

  it("turns on for Grok Bot and Muse with FIXER_CORE=1, and contacts nobody", SLOW, async () => {
    const m = await start();
    for (const [assistant, number] of [["grok", LANE], ["muse", COURT]] as const) {
      const { tenant, property, token } = await account(m, assistant, number);
      const on = await m.toolAt(PATH, token, "set_flows", { property: property.id, fixer: true });
      expect(on.isError, on.text).toBe(false);
      expect(on.structured?.flows).toMatchObject({ fixer: true });
      expect(flows(m, tenant).fixer.on).toBe(true);
    }
    expect(m.sms.sent).toEqual([]);
  });

  it("is refused for Claude and ChatGPT with the plain-chat line", SLOW, async () => {
    const m = await start();
    for (const [assistant, number] of [["claude", LANE], ["chatgpt", COURT]] as const) {
      const { tenant, property, token } = await account(m, assistant, number);
      const refused = await m.toolAt(PATH, token, "set_flows", { property: property.id, fixer: true });
      expect(refused).toMatchObject({ isError: true, text: FIXER_AGENTS_ONLY });
      expect(flows(m, tenant).fixer.on).toBe(false);
    }
    expect(FIXER_AGENTS_ONLY).toBe("Fixer Core works with Grok Bot and Muse for now: they find, call and book pros themselves. In this chat, Cleaner Core works without Fixer Core.");
  });
});

describe("Fixer Core's tools on the list", () => {
  it("are listed for Grok while a property has Fixer Core on, with the hub's setup, the preview and photos", SLOW, async () => {
    const m = await start();
    const { property, token } = await account(m);
    const before = await m.toolNames(PATH, token);
    for (const name of FIXER_TOOL_NAMES) expect(before).not.toContain(name);
    expect(before).not.toContain("preview_schedule");
    await m.toolAt(PATH, token, "set_flows", { property: property.id, fixer: true });
    const on = await m.toolNames(PATH, token);
    for (const name of [...FIXER_TOOL_NAMES, "preview_schedule", "get_job_photos", "get_state", "set_flows"]) expect(on).toContain(name);
    expect(on.filter((name) => name === "preview_schedule")).toHaveLength(1);
    for (const name of ["save_people", "check_cart", "choose_supplies"]) expect(on).not.toContain(name);
    await m.toolAt(PATH, token, "set_flows", { property: property.id, fixer: false });
    const off = await m.toolNames(PATH, token);
    for (const name of FIXER_TOOL_NAMES) expect(off).not.toContain(name);
  });

  it("are never listed or answered for a plain chat on the same account", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    await m.toolAt(PATH, token, "set_flows", { property: property.id, fixer: true });
    const claude = await m.joinAt(tenant.id, "claude", PATH);
    const names = await m.toolNames(PATH, claude);
    for (const name of FIXER_TOOL_NAMES) expect(names).not.toContain(name);
    expect(await m.toolAt(PATH, claude, "get_fixer_state", { property: property.id })).toMatchObject({ isError: true, text: FIXER_AGENTS_ONLY });
    // get_state on a Fixer-only property isn't Fixer Core's for a plain chat.
    expect((await m.toolAt(PATH, claude, "get_state", { property: property.id })).structured?.ask).toBeUndefined();
  });

  it("refuses a Fixer Core tool on a property where it is off", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    const other = m.registry.addProperty(tenant.id, "8 Scratch Court");
    await m.toolAt(PATH, token, "set_flows", { property: property.id, fixer: true });
    expect(await m.toolAt(PATH, token, "get_fixer_state", { property: other.id })).toMatchObject({ isError: true, text: "Fixer Core isn't on for 8 Scratch Court." });
  });
});

describe("get_state with Fixer Core on", () => {
  it("is Fixer Core's setup on a property where only Fixer Core is on", SLOW, async () => {
    const m = await start();
    const { property, token } = await account(m);
    await m.toolAt(PATH, token, "set_flows", { property: property.id, fixer: true });
    const state = await m.toolAt(PATH, token, "get_state");
    expect((state.structured?.ask as { step: string }).step).toBe("pros");
    expect(state.structured?.properties).toHaveLength(1);
  });

  it("carries the repairs line beside Cleaner Core's and Supply Core's state", SLOW, async () => {
    const m = await start({ FIXER_CORE: "1", SUPPLY_CORE: "1" });
    const { tenant, property, token } = await account(m);
    const court = m.registry.addProperty(tenant.id, "8 Scratch Court");
    for (const flow of ["cleaning", "fixer"]) await m.toolAt(PATH, token, "set_flows", { property: property.id, [flow]: true });
    for (const flow of ["supplies", "fixer"]) await m.toolAt(PATH, token, "set_flows", { property: court.id, [flow]: true });
    const lane = await m.toolAt(PATH, token, "get_state", { property: property.id });
    expect(lane.structured?.repairs).toBe("Repairs: setup not finished.");
    const supplies = await m.toolAt(PATH, token, "get_state", { property: court.id });
    expect(supplies.structured?.repairs).toBe("Repairs: setup not finished.");
    expect((supplies.structured?.ask as { step: string }).step).toBe("property");
  });
});

describe("Fixer Core's records", () => {
  it("keeps two accounts apart: no pros, jobs or costs across", SLOW, async () => {
    const m = await start();
    const a = await account(m, "grok", LANE);
    const b = await account(m, "grok", COURT);
    const { call } = await activeFixer(m, a.token, a.property);
    await call("open_job", { trade: "plumbing", what: "Sink leaks", urgency: "soon", source: "host" });
    await m.toolAt(PATH, b.token, "set_flows", { property: b.property.id, fixer: true });
    expect(readFixer(folder(m, a.tenant, a.property)).pros).toHaveLength(1);
    expect(readFixer(folder(m, b.tenant, b.property))).toMatchObject({ pros: [], jobs: [] });
    const bState = await m.toolAt(PATH, b.token, "get_fixer_state");
    expect(bState.structured?.pros).toEqual([]);
    expect(JSON.stringify(bState.structured)).not.toContain("Sink");
    // B's chat can't name A's property.
    expect((await m.toolAt(PATH, b.token, "get_fixer_state", { property: a.property.id })).isError).toBe(true);
  });

  it("asks the host before saving a pro whose phone is on another property, in any role", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    const court = m.registry.addProperty(tenant.id, "8 Scratch Court");
    await activeFixer(m, token, property);
    await m.toolAt(PATH, token, "set_flows", { property: court.id, fixer: true });
    const refused = await m.toolAt(PATH, token, "save_pro", { property: court.id, ...JOES });
    expect(refused).toMatchObject({ isError: true, text: "That number is already on 12 Scratch Lane as the pro. Ask the host whether the same person helps here too, then save again with shared: true." });
    expect(readFixer(folder(m, tenant, court)).pros).toEqual([]);
    expect((await m.toolAt(PATH, token, "save_pro", { property: court.id, ...JOES, shared: true })).isError).toBe(false);
    expect(readFixer(folder(m, tenant, court)).pros).toHaveLength(1);
  });
});

describe("a booked visit", () => {
  it("turning Fixer Core off asks first, then cancels the job and says who to tell", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    const { jobId } = await bookedJob(m, token, property);
    const ask = await m.toolAt(PATH, token, "set_flows", { property: property.id, fixer: false });
    expect(ask.isError).toBe(false);
    expect(ask.structured?.jobs).toEqual([{ jobId, what: "Sink leaks", state: "booked", proName: "Joe's Plumbing" }]);
    expect(String(ask.structured?.question)).toContain("Sink leaks (Joe's Plumbing)");
    expect(flows(m, tenant).fixer.on).toBe(true);
    expect((await m.toolAt(PATH, token, "set_flows", { property: property.id, fixer: false, confirmation: "ZZZZZZ" })).isError).toBe(true);
    expect(flows(m, tenant).fixer.on).toBe(true);
    const off = await m.toolAt(PATH, token, "set_flows", { property: property.id, fixer: false, confirmation: codeOf(ask) });
    expect(off.isError, off.text).toBe(false);
    expect(flows(m, tenant).fixer.on).toBe(false);
    expect(off.structured?.tellPro).toEqual([{ name: "Joe's Plumbing", reach: { phone: JOE } }]);
    expect(off.text).toContain("Tell each pro in tellPro");
    expect(readFixer(folder(m, tenant, property)).jobs[0]).toMatchObject({ id: jobId, state: "cancelled" });
    expect(m.sms.sent).toEqual([]);
  });

  it("the service's clock moves it to in-progress at the visit's start", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    const { jobId } = await bookedJob(m, token, property);
    await tickAllFixers(m.hosted());
    expect(readFixer(folder(m, tenant, property)).jobs[0]).toMatchObject({ id: jobId, state: "booked" });
    clock = new Date(TUE.from);
    await tickAllFixers(m.hosted());
    expect(readFixer(folder(m, tenant, property)).jobs[0]).toMatchObject({ id: jobId, state: "in-progress" });
    expect(m.sms.sent).toEqual([]);
  });
});
