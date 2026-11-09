import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXER_AGENTS_ONLY } from "../src/cleaner-core/assistant";
import { propertyFolder, type Property } from "../src/cleaner-core/hosted/properties";
import { hostedCleaner, propertyContext, tickAllFixers } from "../src/cleaner-core/hosted/router";
import type { Tenant } from "../src/cleaner-core/hosted/registry";
import { FixerDesk, resetFixerDesks } from "../src/fixer-core/desk";
import { readFixer, tokenHash } from "../src/fixer-core/store";
import { fixerDesk } from "../src/hosted/fixer";
import { hubFor } from "../src/hub/hub";
import { peopleFor } from "../src/hub/people";
import { tenantFolder } from "../src/cleaner-core/hosted/registry";
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
  vi.restoreAllMocks();
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
async function bookedJob(m: MultiTenantApp, token: string, property: Property, access?: "code", before?: (call: (name: string, args?: Record<string, unknown>) => Promise<unknown>, joeId: string) => Promise<void>) {
  const { call, joeId } = await activeFixer(m, token, property);
  await before?.(call, joeId);
  const jobId = (await call("open_job", { trade: "plumbing", what: "Sink leaks", urgency: "soon", source: "host" })).structured!.jobId as string;
  await call("check_fixes");
  const contactToken = (await call("contact_pro", { jobId, to: joeId, how: "call" })).structured!.contactToken as string;
  await call("record_contact", { contactToken, outcome: "booked", ...TUE, estimateCents: 18000 });
  const ask = await call("approve_booking", { jobId, ...(access ? { access } : {}) });
  await call("approve_booking", { jobId, ...(access ? { access } : {}), confirmation: codeOf(ask) });
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

describe("round 1 fixes", () => {
  it("turning on with an unreadable record says so and leaves Fixer Core off", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    mkdirSync(folder(m, tenant, property), { recursive: true });
    writeFileSync(join(folder(m, tenant, property), "fixer.json"), "{ not json");
    const refused = await m.toolAt(PATH, token, "set_flows", { property: property.id, fixer: true });
    expect(refused).toMatchObject({ isError: true, text: "Fixer Core's record (fixer.json) couldn't be read, so nothing was changed. Ask for help restoring it." });
    expect(flows(m, tenant).fixer.on).toBe(false);
  });

  it("refuses card-like text on get_job_photos for a repair job before the desk", SLOW, async () => {
    const m = await start();
    const { property, token } = await account(m);
    const { jobId } = await bookedJob(m, token, property);
    const refused = await m.toolAt(PATH, token, "get_job_photos", { property: property.id, job: jobId, note: "4242 4242 4242 4242" });
    expect(refused).toMatchObject({ isError: true, text: "That looks like a card number. Fixer Core never takes card details: keep them in your Vault." });
  });

  it("one property's clock failing never stops another's, logs no job text, and rounds never overlap", SLOW, async () => {
    const m = await start();
    const a = await account(m, "grok", LANE);
    const b = await account(m, "grok", COURT);
    await bookedJob(m, a.token, a.property);
    await bookedJob(m, b.token, b.property);
    const bad = folder(m, a.tenant, a.property);
    const tick = FixerDesk.prototype.tick;
    const spy = vi.spyOn(FixerDesk.prototype, "tick").mockImplementation(function (this: FixerDesk) {
      if (this.root === bad) throw new Error("Sink leaks at the side gate");
      return tick.call(this);
    });
    const lines: string[] = [];
    const server = m.hosted();
    const h = hostedCleaner({ ...server, log: (line) => lines.push(line) });
    clock = new Date(TUE.from);
    // A second round asked while the first runs is skipped.
    await Promise.all([tickAllFixers(h), tickAllFixers(h)]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(readFixer(folder(m, b.tenant, b.property)).jobs[0]!.state).toBe("in-progress");
    expect(readFixer(bad).jobs[0]!.state).toBe("booked");
    expect(lines).toEqual([`Fixer Core couldn't run ${a.tenant.id}/${a.property.id}'s clock this round.`]);
    // The guard lets the next round run.
    await tickAllFixers(h);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("turning Fixer Core off after the pro saw the door code asks the host about changing it", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    m.hosted().secrets.set(tenant.id, { CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64") });
    const ctx = propertyContext(m.hosted(), m.registry.get(tenant.id)!, property);
    expect(hubFor(ctx.root, { now: () => clock }).doorAccess(ctx.env).save(["6", "2", "0", "4"].join(""), undefined, undefined).ok).toBe(true);
    const { call, jobId } = await bookedJob(m, token, property, "code");
    const url = String((await call("visit_link", { jobId })).structured!.url);
    clock = new Date(Date.parse(TUE.from) - 10 * 60_000);
    const shown = await fixerDesk(m.hosted(), m.registry.get(tenant.id)!, property).revealCode(jobId, tokenHash(url.slice(url.lastIndexOf("/") + 1)));
    expect(shown.ok).toBe(true);
    const ask = await m.toolAt(PATH, token, "set_flows", { property: property.id, fixer: false });
    const off = await m.toolAt(PATH, token, "set_flows", { property: property.id, fixer: false, confirmation: codeOf(ask) });
    expect(off.isError, off.text).toBe(false);
    expect(off.structured?.rotationAsk).toEqual([{ jobId, question: "Joe's Plumbing knows the door code. Want to change it? Set the new code on the lock, then save it here." }]);
    expect(off.text).toContain("Then ask the host each question in rotationAsk.");
    expect(off.raw).not.toContain(["6", "2", "0", "4"].join(""));
  });
});

describe("final review fixes on the shared service", () => {
  /** Saves a made-up door code for the property, under the account's own key. */
  function saveCode(m: MultiTenantApp, tenant: Tenant, property: Property) {
    m.hosted().secrets.set(tenant.id, { CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64") });
    const ctx = propertyContext(m.hosted(), m.registry.get(tenant.id)!, property);
    expect(hubFor(ctx.root, { now: () => clock }).doorAccess(ctx.env).save(["6", "2", "0", "4"].join(""), undefined, undefined).ok).toBe(true);
  }

  it("on a Fixer-only property, a pro who texts on the line still gets the visit page", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    saveCode(m, tenant, property);
    const { jobId } = await bookedJob(m, token, property, "code", async (save, joeId) => {
      const ask = (await save("save_pro", { id: joeId, ...JOES, prefersText: true })) as { structured?: Record<string, unknown> };
      await save("save_pro", { id: joeId, ...JOES, prefersText: true, confirmation: codeOf(ask) });
      peopleFor(tenantFolder(m.app.root, tenant.id), { now: () => clock }).optIn(JOE, property.id);
    });
    const link = await m.toolAt(PATH, token, "visit_link", { property: property.id, jobId });
    expect(link.isError, link.text).toBe(false);
    clock = new Date(Date.parse(TUE.from) - 10 * 60_000);
    await tickAllFixers(m.hosted());
    expect(m.sms.sent).toEqual([]);
  });

  it("turning Fixer Core off refuses a yes given before the visit was extended", SLOW, async () => {
    const m = await start();
    const { tenant, property, token } = await account(m);
    const { call, jobId } = await bookedJob(m, token, property);
    const ask = await m.toolAt(PATH, token, "set_flows", { property: property.id, fixer: false });
    const extend = await call("extend_visit", { jobId, until: "2026-11-10T18:00:00.000Z" });
    await call("extend_visit", { jobId, until: "2026-11-10T18:00:00.000Z", confirmation: codeOf(extend as { structured?: Record<string, unknown> }) });
    const stale = await m.toolAt(PATH, token, "set_flows", { property: property.id, fixer: false, confirmation: codeOf(ask) });
    expect(stale.isError).toBe(true);
    expect(flows(m, tenant).fixer.on).toBe(true);
    expect(readFixer(folder(m, tenant, property)).jobs[0]).toMatchObject({ id: jobId, state: "booked" });
  });
});
