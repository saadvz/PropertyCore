import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatorEventSchema } from "../src/alerts/operatorEvents";
import { attachToolListStream } from "../src/mcp/toolListChanged";
import { liveDeskFor, PIN_FAILED as GROK_PIN_FAILED } from "../src/cleaner-core/liveDesk";
import { propertyContext } from "../src/cleaner-core/hosted/router";
import type { Tenant } from "../src/cleaner-core/hosted/registry";
import { fixerDesk } from "../src/hosted/fixer";
import { tenantPage } from "../src/cleaner-core/hosted/adminPages";
import { propertyFolder, type FlowName, type Property } from "../src/cleaner-core/hosted/properties";
import { tenantFolder } from "../src/cleaner-core/hosted/registry";
import { resetFixerDesks } from "../src/fixer-core/desk";
import { readFixer } from "../src/fixer-core/store";
import { readSupply } from "../src/supply-core/store";
import type { Feature } from "../src/features/features";
import { BOT_APPROVAL_STALE, botRemovedLine, noBotLine, noRoutineNote, QUIET_BOTS_FILE, quietLine, quietNote, removeBotQuestion, setupWaitingNote, type TeamEntry } from "../src/hosted/botTools";
import { filedLine, FILING_SOURCE } from "../src/hosted/filing";
import { BOTS_GROK_ONLY, BOTS_NEED_MAIN, BOTS_OFF, dropConnection } from "../src/hosted/jobDeps";
import { KEPT_WAKES_FILE } from "../src/hosted/jobWake";
import { elsewhereLine, jobInstructions, jobsOf, leftBehindLine, NO_JOBS, teamLine } from "../src/hosted/jobTools";
import { flowOff } from "../src/hosted/propertyTools";
import { ALERT_KEEPS_MS } from "../src/host-alerts/clock";
import { readHostAlerts } from "../src/host-alerts/ledger";
import { resetHostAlertClock, tickAllHostAlerts } from "../src/hosted/hostAlerts";
import { zonedInstant } from "../src/hub/calendar";
import { hubFor } from "../src/hub/hub";
import { hashSecret, OAuthGrantStore } from "../src/mcp/oauth/store";
import { resetVisitLogCache } from "../src/visits/store";
import { closeHostedApps } from "./cleanerOauthHarness";
import { credentialsFor, switchOn } from "./featureEnv";
import { multiTenantApp, type McpAddress, type MultiTenantApp } from "./multiTenantHarness";
import { order, writeOrders } from "./packageFixture";
import { CLEANER, LANE as SCRATCH_LANE, sharedAccount } from "./sharedHarness";

/**
 * #250 on the shared service: a bot for each core. Each connection carries the job of the address it signed in at,
 * and the server lists, refuses and wakes by job. 555 numbers, made-up codes and keys, a stubbed routine; nothing
 * reaches a lock, Ring or a phone.
 */

const LANE = "+15555550180";
const COURT = "+15555550181";
const P = "/mcp";
const C = "/mcp/cleaner";
const S = "/mcp/supply";
const F = "/mcp/fixer";
const SLOW = { timeout: 90_000 };
const NY = "America/New_York";
const KEY = randomBytes(32).toString("base64");
const ALL_FLOWS: FlowName[] = ["cleaning", "supplies", "fixer"];

let open: MultiTenantApp | undefined;
const clock = { now: new Date("2026-11-21T15:00:00.000Z") };
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
  resetFixerDesks();
  resetHostAlertClock();
  resetVisitLogCache();
  clock.now = new Date("2026-11-21T15:00:00.000Z");
});

async function service() {
  open ??= await multiTenantApp({ env: { SUPPLY_CORE: "1", CAMERA_TOKEN_KEY: KEY, ...credentialsFor(["cameras", "locks"]) }, now: () => clock.now });
  return open;
}

/** One account on the shared service with one property, its Property Core chat on Grok Bot unless told otherwise. `bots` is on unless told otherwise. */
async function account(options: { bots?: boolean; flows?: FlowName[]; features?: Feature[]; label?: string; line?: string; main?: "grok" | "claude" } = {}) {
  const m = await service();
  const { tenant } = m.registry.create({ label: options.label ?? "Lane", twilioNumber: options.line ?? LANE });
  switchOn(m.registry, tenant.id, ...(options.bots === false ? [] : (["bots"] as Feature[])), ...(options.features ?? []));
  const property = m.registry.addProperty(tenant.id, "12 Scratch Lane");
  for (const flow of options.flows ?? []) m.registry.setFlow(tenant.id, property.id, flow, true);
  const root = propertyFolder(m.app.root, tenant.id, property);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "hub.json"), JSON.stringify({ schemaVersion: 1, property: { nickname: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: NY }, calendars: [], stays: [] }));
  const main = await m.joinAt(tenant.id, options.main ?? "grok", P);
  return { m, tenant, property, main, root };
}

/** The grant behind an access token. */
const grantOf = (m: MultiTenantApp, token: string) => new OAuthGrantStore(m.app.inst.runtime).findByAccessHash(hashSecret(token))!.id;

describe("an address and a sign-in for each core's bot", () => {
  it("a token for one address is refused at the others", SLOW, async () => {
    const { m, tenant } = await account({ flows: ["fixer"] });
    const fixer = await m.joinAt(tenant.id, "grok", F);
    expect((await m.rpcAt(F, fixer, "tools/list")).status).toBe(200);
    for (const path of [P, C, S, "/mcp/cleaner-core"]) expect((await m.rpcAt(path, fixer, "tools/list")).status, path).toBe(401);
    const { main } = { main: await m.joinAt(tenant.id, "grok", P) };
    for (const path of [C, S, F]) expect((await m.rpcAt(path, main, "tools/list")).status, path).toBe(401);
  });

  it("the connection carries its job and never becomes primary", SLOW, async () => {
    const { m, tenant, main } = await account({ flows: ["fixer"] });
    const fixer = await m.joinAt(tenant.id, "grok", F);
    const supply = await m.joinAt(tenant.id, "grok", S);
    const cleaner = await m.joinAt(tenant.id, "grok", C);
    const now = m.registry.get(tenant.id)!;
    const jobOf = (token: string) => now.connections.find((c) => c.grantId === grantOf(m, token))?.job;
    expect(jobOf(fixer)).toBe("fixer");
    expect(jobOf(supply)).toBe("supplies");
    expect(jobOf(cleaner)).toBe("cleaning");
    expect(jobOf(main)).toBeUndefined();
    expect(now.primaryGrantId).toBe(grantOf(m, main));
  });

  it("a second Fixer Core bot replaces the first", SLOW, async () => {
    const { m, tenant } = await account({ flows: ["fixer"] });
    const first = await m.joinAt(tenant.id, "grok", F);
    const firstId = grantOf(m, first);
    m.hosted().secrets.setForConnection(tenant.id, firstId, { CLEANER_CORE_ROUTINE_URL: "https://example.com/first-hook", CLEANER_CORE_ROUTINE_KEY: "made-up-key-first" });
    const second = await m.joinAt(tenant.id, "grok", F);
    expect((await m.rpcAt(F, first, "tools/list")).status).toBe(401);
    expect((await m.rpcAt(F, second, "tools/list")).status).toBe(200);
    expect(m.registry.get(tenant.id)!.connections.filter((c) => c.job === "fixer").map((c) => c.grantId)).toEqual([grantOf(m, second)]);
    expect(m.hosted().secrets.connection(tenant.id, firstId)).toEqual({});
  });

  it("refuses a core address with the switch off, without using the invite", SLOW, async () => {
    const { m, tenant } = await account({ bots: false, flows: ["fixer"] });
    const refused = await m.refusedAt(tenant.id, "grok", F);
    expect(refused.status).toBe(403);
    expect(refused.message).toBe(BOTS_OFF);
    expect(m.registry.get(tenant.id)!.connections.some((c) => c.job)).toBe(false);
    expect(m.registry.claimInvite(refused.inviteCode)).toEqual({ tenantId: tenant.id });
  });

  it("refuses any agent but Grok Bot, and an account whose primary isn't Grok Bot", SLOW, async () => {
    const { m, tenant } = await account({ flows: ["fixer"] });
    expect((await m.refusedAt(tenant.id, "claude", F)).message).toBe(BOTS_GROK_ONLY);
    expect((await m.refusedAt(tenant.id, "muse", C)).message).toBe(BOTS_GROK_ONLY);
    const other = await account({ label: "Court", line: COURT, flows: ["fixer"], main: "claude" });
    expect((await m.refusedAt(other.tenant.id, "grok", F)).message).toBe(BOTS_NEED_MAIN);
    const empty = m.registry.create({ label: "Mill", twilioNumber: "+15555550182" }).tenant;
    switchOn(m.registry, empty.id, "bots");
    expect((await m.refusedAt(empty.id, "grok", S)).message).toBe(BOTS_NEED_MAIN);
    for (const id of [tenant.id, other.tenant.id, empty.id]) expect(m.registry.get(id)!.connections.some((c) => c.job)).toBe(false);
  });

  it("the approval page names the job", SLOW, async () => {
    const m = await service();
    expect((await m.pageAt("grok", F)).html).toContain("Allow this chat to run Fixer Core for your account.");
    expect((await m.pageAt("grok", S)).html).toContain("Allow this chat to run Supply Core for your account.");
    expect((await m.pageAt("grok", C)).html).toContain("Allow this chat to run Cleaner Core for your account.");
    expect((await m.pageAt("grok", P)).html).not.toContain("Allow this chat to run");
  });

  it("/admin shows each connection's job and offers Make primary only for /mcp", SLOW, async () => {
    const { m, tenant } = await account({ flows: ["fixer"] });
    await m.joinAt(tenant.id, "grok", F);
    await m.joinAt(tenant.id, "grok", P);
    const html = tenantPage(m.registry.get(tenant.id)!, "csrf", undefined, { service: "properties", process: "—", restartsLastDay: 0, queuedTexts: 0, alerts: "—" }, false);
    const rows = html.split("<tr>").filter((row) => row.includes('name="grantId"'));
    expect(rows).toHaveLength(3);
    const fixerRow = rows.find((row) => row.includes("Fixer Core"))!;
    expect(fixerRow).not.toContain("Make primary");
    expect(fixerRow).toContain("Disconnect");
    const mcpRows = rows.filter((row) => row.includes("Property Core"));
    expect(mcpRows).toHaveLength(2);
    expect(mcpRows.filter((row) => row.includes("Make primary"))).toHaveLength(1);
    expect(mcpRows.filter((row) => row.includes("<strong>primary</strong>"))).toHaveLength(1);
  });
});

/** Every switch but bots, so every tool that can be listed is. */
const EVERYTHING: Feature[] = ["visits", "hours", "stay-check", "guest-messages", "packages", "oversight", "booking-platforms", "locks", "guest-codes", "cameras"];
const instructionsAt = async (m: MultiTenantApp, path: string, token: string) => String((await m.rpcAt(path, token, "initialize", { protocolVersion: "2025-06-18" })).json.result?.instructions);

describe("each bot lists and calls only its job's tools", () => {
  it("an account with one bot lists what it lists with the switch off", SLOW, async () => {
    const { m, tenant, main } = await account({ bots: false, flows: ALL_FLOWS, features: EVERYTHING });
    const names = await m.toolNames(P, main);
    const said = await instructionsAt(m, P, main);
    expect(names).toContain("check_fixes");
    expect(names).toContain("choose_supplies");
    switchOn(m.registry, tenant.id, "bots");
    expect(await m.toolNames(P, main)).toEqual(names);
    expect(await instructionsAt(m, P, main)).toBe(said);
  });

  it("each core's bot lists exactly its own tools", SLOW, async () => {
    const { m, tenant, main } = await account({ flows: ALL_FLOWS, features: EVERYTHING });
    const everything = await m.toolNames(P, main);
    const bots = { fixer: await m.joinAt(tenant.id, "grok", F), cleaning: await m.joinAt(tenant.id, "grok", C), supplies: await m.joinAt(tenant.id, "grok", S) } as const;
    const lists = { fixer: await m.toolNames(F, bots.fixer), cleaning: await m.toolNames(C, bots.cleaning), supplies: await m.toolNames(S, bots.supplies) };
    // The Cleaner Core bot also lists the three tools it files into the other cores with.
    const filing = ["get_supply_state", "report_low", "open_job"];
    for (const name of filing) expect(lists.cleaning, name).toContain(name);
    for (const job of ["fixer", "cleaning", "supplies"] as const) {
      for (const name of lists[job]) if (!(job === "cleaning" && filing.includes(name))) expect(jobsOf(name), `${job}: ${name}`).toContain(job);
      // A job never adds a tool the flows and switches wouldn't list, but for check_alerts, which exists only once a core has its own bot.
      for (const name of lists[job]) expect([...everything, "check_alerts"], `${job}: ${name}`).toContain(name);
      expect(lists[job]).toContain("get_state");
      for (const name of ["set_flows", "add_property", "choose_supplies", "connect_lock", "list_cameras"]) expect(lists[job], `${job}: ${name}`).not.toContain(name);
    }
    expect(lists.fixer).toEqual(expect.arrayContaining(["check_fixes", "open_job", "guests_left", "preview_schedule", "get_job_photos"]));
    expect(lists.cleaning).toEqual(expect.arrayContaining(["check_now", "mark_guests_left", "save_door_code", "get_job_photos"]));
    expect(lists.supplies).toEqual(expect.arrayContaining(["check_supplies", "approve_cart", "check_packages", "preview_schedule"]));
    expect(lists.fixer).not.toContain("check_now");
    expect(lists.cleaning).not.toContain("check_fixes");
    expect(lists.supplies).not.toContain("mark_guests_left");
    expect(lists.supplies).toContain("check_alerts");
    expect(everything).not.toContain("check_alerts");
    expect(everything).not.toContain("remove_bot");
    // Nothing is held yet, so the Property Core chat keeps every tool, and now has the two for an account with bots.
    expect(await m.toolNames(P, main)).toEqual([...everything, "check_alerts", "remove_bot"].sort());
  });

  it("a core's bot is refused another job's tool before any desk", SLOW, async () => {
    const { m, tenant, property } = await account({ flows: ALL_FLOWS, features: EVERYTHING });
    const fixer = await m.joinAt(tenant.id, "grok", F);
    const reply = await m.toolAt(F, fixer, "mark_guests_left", { property: property.id });
    expect(reply.isError).toBe(true);
    expect(reply.text).toBe(elsewhereLine("cleaning", false));
    const flows = await m.toolAt(F, fixer, "set_flows", { property: property.id, fixer: false });
    expect(flows.isError).toBe(true);
    expect(flows.text).toBe(elsewhereLine("property", false));
    expect(m.registry.get(tenant.id)!.properties[0]!.flows.fixer.on).toBe(true);
    expect((await m.toolAt(F, fixer, "approve_cart", { property: property.id })).text).toBe(elsewhereLine("supplies", false));
    expect((await m.toolAt(F, fixer, "add_property", { label: "9 Made-up Road" })).text).toBe(elsewhereLine("property", false));
    expect(m.registry.get(tenant.id)!.properties).toHaveLength(1);
    const cleaner = await m.joinAt(tenant.id, "grok", C);
    const choose = await m.toolAt(C, cleaner, "choose_supplies", { property: property.id, on: false });
    expect(choose.isError).toBe(true);
    expect(choose.text).toBe(elsewhereLine("property", false));
  });

  it("each core's own yes is refused from every other core's bot, on the call", SLOW, async () => {
    const { m, tenant, property } = await account({ flows: ALL_FLOWS, features: EVERYTHING });
    const bots = { cleaning: C, supplies: S, fixer: F } as const;
    const tokens = { cleaning: await m.joinAt(tenant.id, "grok", C), supplies: await m.joinAt(tenant.id, "grok", S), fixer: await m.joinAt(tenant.id, "grok", F) };
    const yes = { cleaning: ["mark_guests_left"], supplies: ["approve_cart"], fixer: ["guests_left", "approve_job"] } as const;
    const jobs = ["cleaning", "supplies", "fixer"] as const;
    for (const caller of jobs) {
      for (const owner of jobs.filter((job) => job !== caller)) {
        for (const tool of yes[owner]) {
          expect(await m.toolNames(bots[caller], tokens[caller]), `${caller} lists ${tool}`).not.toContain(tool);
          const reply = await m.toolAt(bots[caller], tokens[caller], tool, { property: property.id });
          expect(reply.isError, `${caller} calls ${tool}`).toBe(true);
          expect(reply.text, `${caller} calls ${tool}`).toBe(elsewhereLine(owner, false));
        }
      }
    }
  });

  it("an unknown tool name still gets today's line", SLOW, async () => {
    const { m, tenant } = await account({ flows: ["fixer"] });
    const fixer = await m.joinAt(tenant.id, "grok", F);
    expect((await m.toolAt(F, fixer, "no_such_tool")).text).toContain("There's no tool named no_such_tool here.");
  });

  it("Cleaner Core's setup at /mcp/cleaner never waits on the Supply Core question", SLOW, async () => {
    const { m, tenant, property, root } = await account({ flows: ["cleaning", "supplies"] });
    const cleaner = await m.joinAt(tenant.id, "grok", C);
    const asked = () => (JSON.parse(readFileSync(join(root, "cleaner-live.json"), "utf8")) as { suppliesAsked?: boolean }).suppliesAsked;
    const state = await m.toolAt(C, cleaner, "get_state", { property: property.id });
    expect(state.isError).toBe(false);
    expect(asked()).toBe(true);
    expect(JSON.stringify(state.structured)).not.toContain("choose_supplies");
    // Supply Core stays as the host set it with the Property Core bot.
    expect(m.registry.get(tenant.id)!.properties[0]!.flows.supplies.on).toBe(true);
  });

  it("a core connection made before the switch went off lists nothing and is refused", SLOW, async () => {
    const { m, tenant, property, main } = await account({ flows: ["fixer"] });
    const fixer = await m.joinAt(tenant.id, "grok", F);
    expect(await m.toolNames(F, fixer)).toContain("check_fixes");
    m.registry.setFeature(tenant.id, "bots", false, "admin");
    expect(await m.toolNames(F, fixer)).toEqual([]);
    for (const name of ["get_state", "check_fixes"]) {
      const reply = await m.toolAt(F, fixer, name, { property: property.id });
      expect(reply.isError, name).toBe(true);
      expect(reply.text, name).toBe(NO_JOBS);
    }
    expect(await m.toolNames(P, main)).toContain("check_fixes");
  });

  it("initialize speaks for the job", SLOW, async () => {
    const { m, tenant, main } = await account({ flows: ALL_FLOWS });
    const fixer = await m.joinAt(tenant.id, "grok", F);
    const cleaner = await m.joinAt(tenant.id, "grok", C);
    const fixerSays = await instructionsAt(m, F, fixer);
    expect(fixerSays).toBe(jobInstructions("fixer"));
    expect(fixerSays).not.toContain("Cleaner Core for turnover cleanings");
    const cleanerSays = await instructionsAt(m, C, cleaner);
    expect(cleanerSays.startsWith(jobInstructions("cleaning"))).toBe(true);
    expect(cleanerSays.length).toBeGreaterThan(jobInstructions("cleaning").length);
    expect(await instructionsAt(m, P, main)).toContain("This connection runs Property Core for the host's properties");
  });

  it("the Property Core chat on Grok is told which cores still need their own bot", SLOW, async () => {
    const { m, tenant, main } = await account({ flows: ["supplies", "fixer"] });
    const newBots = async (path: string, token: string) => (await m.toolAt(path, token, "get_state", {})).structured!.newBots;
    expect(await newBots(P, main)).toEqual([
      { job: "supplies", name: "Supply Core", address: S },
      { job: "fixer", name: "Fixer Core", address: F },
    ]);
    const fixer = await m.joinAt(tenant.id, "grok", F);
    expect(await newBots(P, main)).toEqual([{ job: "supplies", name: "Supply Core", address: S }]);
    expect(await newBots(F, fixer)).toBeUndefined();
  });

  it("no core is offered its own bot with the switch off, on an agent other than Grok, or with no flow on", SLOW, async () => {
    const off = await account({ bots: false, flows: ["fixer"] });
    expect((await off.m.toolAt(P, off.main, "get_state", {})).structured!.newBots).toBeUndefined();
    const claude = await account({ label: "Court", line: COURT, flows: ["fixer"], main: "claude" });
    expect((await claude.m.toolAt(P, claude.main, "get_state", {})).structured!.newBots).toBeUndefined();
    const none = await account({ label: "Bare", line: "+15555550182" });
    expect((await none.m.toolAt(P, none.main, "get_state", {})).structured!.newBots).toBeUndefined();
  });

  it("one account's bot never reaches another account", SLOW, async () => {
    const lane = await account({ flows: ["fixer"] });
    const court = await account({ label: "Court", line: COURT, flows: ["fixer"] });
    const m = lane.m;
    const fixer = await m.joinAt(lane.tenant.id, "grok", F);
    const state = await m.toolAt(F, fixer, "get_state");
    expect(JSON.stringify(state.structured)).toContain(lane.property.id);
    expect(JSON.stringify(state.structured)).not.toContain(court.property.id);
    const reach = await m.toolAt(F, fixer, "check_fixes", { property: court.property.id });
    expect(reach.isError).toBe(true);
    // The other account's own switch and connections decide for it alone.
    m.registry.setFeature(court.tenant.id, "bots", false, "admin");
    expect(await m.toolNames(F, fixer)).toContain("check_fixes");
  });

  it("photos are shown only by the bot whose core took them", SLOW, async () => {
    const { m, tenant, property } = await account({ flows: ALL_FLOWS });
    const fixer = await m.joinAt(tenant.id, "grok", F);
    const cleaner = await m.joinAt(tenant.id, "grok", C);
    const turnover = await m.toolAt(F, fixer, "get_job_photos", { property: property.id, jobId: "2026-11-21", checkout: "2026-11-21" });
    expect(turnover.isError).toBe(true);
    expect(turnover.text).toBe(elsewhereLine("cleaning", false));
    const repair = await m.toolAt(C, cleaner, "get_job_photos", { property: property.id, job: "job_madeupjob01" });
    expect(repair.isError).toBe(true);
    expect(repair.text).toBe(elsewhereLine("fixer", false));
  });

});

const JOE = "+15555550183";
const PLACE = { address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: NY };
const JOES = { name: "Joe's Plumbing", trades: ["plumbing"], reach: { phone: JOE }, preferredFor: [{ trade: "plumbing", rank: 1 }] };
const MAIN_HOOK = { url: "https://example.com/main-hook", token: "made-up-key-main-250" };
const FIX_HOOK = { url: "https://example.com/fixer-hook", token: "made-up-key-fixer-250" };
const CLEAN_HOOK = { url: "https://example.com/cleaner-hook", token: "made-up-key-cleaner-250" };

/** How many wake-ups of one kind reached one routine. A wake-up carries ids and a time, nothing else. */
const wakesTo = (m: MultiTenantApp, url: string, eventType: string) => m.wakes.filter((w) => w.url === url && JSON.parse(w.body).eventType === eventType).length;

/** Saves a routine for the calling chat through a one-time upload link, as the host's secure card does. */
async function saveRoutine(m: MultiTenantApp, path: McpAddress, token: string, tool: string, hook: { url: string; token: string }, args: Record<string, unknown> = {}) {
  const link = await m.toolAt(path, token, tool, args);
  expect(link.isError, `${tool}: ${link.text}`).toBe(false);
  const posted = await m.app.http(new URL(String(link.structured!.uploadUrl)).pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(hook) });
  expect(posted.status).toBe(200);
}

/** Turns Fixer Core on and activates it with Joe saved, through the Property Core chat, and saves that chat's Alerts routine unless told not to. */
async function activeFixer(m: MultiTenantApp, token: string, property: Property, routine = true) {
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await m.toolAt(P, token, name, { property: property.id, ...args });
    expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
    return reply;
  };
  await call("set_flows", { fixer: true });
  await call("save_fixer_property", PLACE);
  await call("save_fixer_sources", { done: true });
  await call("save_pro", JOES);
  await call("save_fixer_settings", { prosDone: true });
  await call("save_fixer_settings", { upkeepDone: true });
  await call("activate_fixer");
  if (routine) await saveRoutine(m, P, token, "save_repair_alerts", MAIN_HOOK, { property: property.id });
}

/** One note for the host from Fixer Core's own desk, as a pro's reply or a clock check leaves one. Made-up words only. */
const pushFixerNews = (m: MultiTenantApp, tenant: Tenant, property: Property, id: string, text: string) => fixerDesk(m.hosted(), m.registry.get(tenant.id)!, property).hostAlert(id, text);

/** A team of two: the Property Core chat with its routine and Fixer Core active, and a Fixer Core bot connected with nothing saved yet. */
async function fixerTeam(options: Parameters<typeof account>[0] = {}) {
  const made = await account(options);
  await activeFixer(made.m, made.main, made.property);
  const fixer = await made.m.joinAt(made.tenant.id, "grok", F);
  return { ...made, fixer };
}

describe("the hand-over when a core's bot saves its routine", () => {
  it("a core bot with no routine holds nothing", SLOW, async () => {
    const { m, tenant, property, main, fixer } = await fixerTeam();
    expect(await m.toolNames(P, main)).toContain("check_fixes");
    expect(await m.toolNames(F, fixer)).toContain("check_fixes");
    await pushFixerNews(m, tenant, property, "note-before", "A made-up repair note.");
    await vi.waitFor(() => expect(wakesTo(m, MAIN_HOOK.url, "repairs.update")).toBe(1));
    expect(m.wakes.filter((w) => w.url === FIX_HOOK.url)).toHaveLength(0);
    // Either chat reads it, as two chats on one account do today.
    const news = (await m.toolAt(F, fixer, "check_fixes", { property: property.id })).structured;
    expect(JSON.stringify(news)).toContain("A made-up repair note.");
  });

  it("saving its routine hands the job over", SLOW, async () => {
    const { m, tenant, property, main, fixer } = await fixerTeam();
    const mainId = grantOf(m, main);
    await saveRoutine(m, F, fixer, "save_repair_alerts", FIX_HOOK, { property: property.id });
    const mainNames = await m.toolNames(P, main);
    for (const name of ["check_fixes", "open_job", "guests_left"]) expect(mainNames, name).not.toContain(name);
    expect(mainNames).toEqual(expect.arrayContaining(["get_state", "set_flows"]));
    expect(await m.toolNames(F, fixer)).toContain("check_fixes");
    const before = wakesTo(m, MAIN_HOOK.url, "repairs.update");
    await pushFixerNews(m, tenant, property, "note-after", "A second made-up repair note.");
    await vi.waitFor(() => expect(wakesTo(m, FIX_HOOK.url, "repairs.update")).toBe(1));
    expect(wakesTo(m, MAIN_HOOK.url, "repairs.update")).toBe(before);
    expect(m.registry.get(tenant.id)!.primaryGrantId).toBe(mainId);
    for (const wake of m.wakes) expect(wake.body).not.toMatch(/made-up repair note/);
  });

  it("the account's other chats hear that their tool list changed, at the hand-over and when the bot goes", SLOW, async () => {
    const { m, tenant, property, main, fixer } = await fixerTeam();
    const stream = () => {
      const notices: string[] = [];
      const res = { writableEnded: false, destroyed: false, write: (chunk: string) => notices.push(chunk), on: () => res } as unknown as ServerResponse;
      return { res, count: () => notices.filter((n) => n.includes("notifications/tools/list_changed")).length };
    };
    const mainStream = stream();
    const fixerStream = stream();
    attachToolListStream(`grant:${grantOf(m, main)}`, mainStream.res);
    attachToolListStream(`grant:${grantOf(m, fixer)}`, fixerStream.res);
    const before = { main: mainStream.count(), fixer: fixerStream.count() };
    await saveRoutine(m, F, fixer, "save_repair_alerts", FIX_HOOK, { property: property.id });
    expect(mainStream.count()).toBe(before.main + 1);
    expect(fixerStream.count()).toBe(before.fixer);
    dropConnection(m.hosted(), tenant.id, grantOf(m, fixer));
    expect(mainStream.count()).toBe(before.main + 2);
  });

  it("a left-behind routine's check is refused before the desk", SLOW, async () => {
    const { m, tenant, property, main, fixer } = await fixerTeam();
    await saveRoutine(m, F, fixer, "save_repair_alerts", FIX_HOOK, { property: property.id });
    await pushFixerNews(m, tenant, property, "note-held", "A made-up repair note for the Fixer bot.");
    const reply = await m.toolAt(P, main, "check_fixes", { property: property.id });
    expect(reply.isError).toBe(true);
    expect(reply.text).toBe(`${elsewhereLine("fixer", true)} ${leftBehindLine("fixer")}`);
    // The note is still unread for the bot that holds the job.
    expect(JSON.stringify((await m.toolAt(F, fixer, "check_fixes", { property: property.id })).structured)).toContain("A made-up repair note for the Fixer bot.");
    expect((await m.toolAt(P, main, "open_job", { property: property.id, trade: "plumbing", what: "A made-up drip.", urgency: "soon", source: "host" })).text).toBe(elsewhereLine("fixer", true));
  });

  it("the job comes back when the bot is disconnected", SLOW, async () => {
    const { m, tenant, property, main, fixer } = await fixerTeam();
    await saveRoutine(m, F, fixer, "save_repair_alerts", FIX_HOOK, { property: property.id });
    expect(await m.toolNames(P, main)).not.toContain("check_fixes");
    dropConnection(m.hosted(), tenant.id, grantOf(m, fixer));
    expect(await m.toolNames(P, main)).toContain("check_fixes");
    expect((await m.rpcAt(F, fixer, "tools/list")).status).toBe(401);
    const before = wakesTo(m, MAIN_HOOK.url, "repairs.update");
    await pushFixerNews(m, tenant, property, "note-back", "A made-up repair note.");
    await vi.waitFor(() => expect(wakesTo(m, MAIN_HOOK.url, "repairs.update")).toBe(before + 1));
    expect(wakesTo(m, FIX_HOOK.url, "repairs.update")).toBe(0);
  });

  it("the job comes back when the bot's grant ends", SLOW, async () => {
    const { m, tenant, property, main, fixer } = await fixerTeam();
    await saveRoutine(m, F, fixer, "save_repair_alerts", FIX_HOOK, { property: property.id });
    expect(await m.toolNames(P, main)).not.toContain("check_fixes");
    // Nobody disconnects it: the grant is gone, and the connection's row is still on the account.
    expect(new OAuthGrantStore(m.app.inst.runtime).revokeGrant(grantOf(m, fixer))).toBe(true);
    expect(m.registry.get(tenant.id)!.connections.some((c) => c.job === "fixer")).toBe(true);
    expect(await m.toolNames(P, main)).toContain("check_fixes");
    expect((await m.rpcAt(F, fixer, "tools/list")).status).toBe(401);
    const before = wakesTo(m, MAIN_HOOK.url, "repairs.update");
    await pushFixerNews(m, tenant, property, "note-grant", "A made-up repair note.");
    await vi.waitFor(() => expect(wakesTo(m, MAIN_HOOK.url, "repairs.update")).toBe(before + 1));
    expect(wakesTo(m, FIX_HOOK.url, "repairs.update")).toBe(0);
  });

  it("the job comes back when the switch goes off", SLOW, async () => {
    const { m, tenant, property, main, fixer } = await fixerTeam();
    await saveRoutine(m, F, fixer, "save_repair_alerts", FIX_HOOK, { property: property.id });
    m.registry.setFeature(tenant.id, "bots", false, "admin");
    expect(await m.toolNames(P, main)).toContain("check_fixes");
    expect(await m.toolNames(F, fixer)).toEqual([]);
    const before = wakesTo(m, MAIN_HOOK.url, "repairs.update");
    await pushFixerNews(m, tenant, property, "note-off", "A made-up repair note.");
    await vi.waitFor(() => expect(wakesTo(m, MAIN_HOOK.url, "repairs.update")).toBe(before + 1));
    expect(wakesTo(m, FIX_HOOK.url, "repairs.update")).toBe(0);
  });

  it("a live Cleaner Core desk stays ready through the hand-over", SLOW, async () => {
    const s = await sharedAccount();
    open = s.m;
    const m = s.m;
    switchOn(m.registry, s.accountId, "bots");
    const id = await s.liveProperty("Scratch Lane", SCRATCH_LANE, { cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
    await s.tool("save_alert_routine", { property: id, url: MAIN_HOOK.url, token: MAIN_HOOK.token });
    const desk = () => {
      const ctx = propertyContext(m.hosted(), m.registry.get(s.accountId)!, s.property(id));
      return liveDeskFor(ctx.root, ctx.env, () => m.hosted().now());
    };
    const cleaner = await m.joinAt(s.accountId, "grok", C);
    // Connected, nothing saved: the turnover's news still wakes the Property Core chat.
    expect(await desk().noteForHost("note-during-setup", "A made-up note for the host.")).toBe(true);
    await vi.waitFor(() => expect(wakesTo(m, MAIN_HOOK.url, "cleaning.update")).toBe(1));
    expect(await m.toolNames("/mcp", s.token)).toContain("check_now");
    expect((await m.toolAt(C, cleaner, "save_alert_routine", { property: id, url: CLEAN_HOOK.url, token: CLEAN_HOOK.token })).isError).toBe(false);
    expect(await m.toolNames("/mcp", s.token)).not.toContain("check_now");
    expect(await desk().noteForHost("note-after-hand-over", "A second made-up note for the host.")).toBe(true);
    await vi.waitFor(() => expect(wakesTo(m, CLEAN_HOOK.url, "cleaning.update")).toBe(1));
    expect(wakesTo(m, MAIN_HOOK.url, "cleaning.update")).toBe(1);
    const read = await m.toolAt(C, cleaner, "check_now", { property: id });
    expect(read.isError).toBe(false);
    expect(JSON.stringify(read.structured)).toContain("A second made-up note for the host.");
  });
});

describe("each core's notes go to the bot that holds it", () => {
  /** One property with Cleaner Core live and Fixer Core active, and the Property Core chat's Alerts routine saved. */
  async function bothCores() {
    const s = await sharedAccount();
    open = s.m;
    const m = s.m;
    switchOn(m.registry, s.accountId, "bots");
    const id = await s.liveProperty("Scratch Lane", SCRATCH_LANE, { cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
    await s.tool("save_alert_routine", { property: id, url: MAIN_HOOK.url, token: MAIN_HOOK.token });
    const p = { property: id };
    await s.tool("set_flows", { ...p, fixer: true });
    await s.tool("save_pro", { ...p, ...JOES });
    await s.tool("save_fixer_settings", { ...p, prosDone: true });
    await s.tool("save_fixer_settings", { ...p, upkeepDone: true });
    await s.tool("activate_fixer", p);
    const fixerNote = (noteId: string, text: string) => fixerDesk(m.hosted(), m.registry.get(s.accountId)!, s.property(id)).noteForHost(noteId, text);
    return { s, m, id, fixerNote };
  }

  it("with one holder, a Fixer Core note shows in check_now, as today", SLOW, async () => {
    const { s, m, id, fixerNote } = await bothCores();
    const before = wakesTo(m, MAIN_HOOK.url, "cleaning.update");
    await fixerNote("made-up-1", "A made-up note from Fixer Core.");
    await vi.waitFor(() => expect(wakesTo(m, MAIN_HOOK.url, "cleaning.update")).toBe(before + 1));
    expect(wakesTo(m, MAIN_HOOK.url, "repairs.update")).toBe(0);
    expect(JSON.stringify((await s.tool("check_now", { property: id })).structured)).toContain("A made-up note from Fixer Core.");
  });

  it("with different holders, a Fixer Core note wakes the Fixer bot and never shows in check_now", SLOW, async () => {
    const { s, m, id, fixerNote } = await bothCores();
    const fixer = await m.joinAt(s.accountId, "grok", F);
    // Fixer Core's own bot connects its own routine, even where Cleaner Core runs.
    await saveRoutine(m, F, fixer, "save_repair_alerts", FIX_HOOK, { property: id });
    const cleaningBefore = wakesTo(m, MAIN_HOOK.url, "cleaning.update");
    await fixerNote("made-up-2", "A made-up note for the Fixer bot only.");
    await vi.waitFor(() => expect(wakesTo(m, FIX_HOOK.url, "repairs.update")).toBe(1));
    expect(wakesTo(m, MAIN_HOOK.url, "cleaning.update")).toBe(cleaningBefore);
    expect(JSON.stringify((await s.tool("check_now", { property: id })).structured)).not.toContain("A made-up note for the Fixer bot only.");
    expect(JSON.stringify((await m.toolAt(F, fixer, "check_fixes", { property: id })).structured)).toContain("A made-up note for the Fixer bot only.");
  });

  it("the Property Core chat still connects alerts through Cleaner Core where it runs", SLOW, async () => {
    const { s, id } = await bothCores();
    const reply = await s.call("save_repair_alerts", { property: id });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("Cleaner Core runs at this property");
  });
});


/** A made-up door code, joined here so the digits never sit together in this file. */
const MADE_UP_CODE = ["7", "3", "0", "6"].join("");
const SUP_HOOK = { url: "https://example.com/supply-hook", token: "made-up-key-supply-250" };
const NOT_SEEN = "packages:supply:ord_1:not-seen";
/** Five past 9 PM at the property: a package expected today and not seen is due. */
const afterNine = () => void (clock.now = new Date(zonedInstant("2026-11-21", "21:05", NY)));
const later = (minutes: number) => void (clock.now = new Date(clock.now.getTime() + minutes * 60_000));
const alertsOf = (reply: { structured?: Record<string, unknown> }) => reply.structured!.alerts as { id: string; kind: string; property: string; text: string; keptAt: string }[];
const wakesOf = (m: MultiTenantApp, eventType: string) => m.wakes.filter((w) => JSON.parse(w.body).eventType === eventType).length;

describe("host alerts for the Property Core and Supply Core bots", () => {
  /** A property with only Supply Core on, a Supply Core bot that saved its routine through check_alerts, and one package expected today. */
  async function supplyOnly() {
    const made = await account({ flows: ["supplies"], features: ["packages"] });
    const supply = await made.m.joinAt(made.tenant.id, "grok", S);
    await saveRoutine(made.m, S, supply, "check_alerts", SUP_HOOK, { connect: true });
    writeOrders(made.root, [order("ord_1", { expectedBy: "2026-11-21" })]);
    afterNine();
    return { ...made, supply };
  }

  /** The Fixer Core bot holds its job, Supply Core is on with packages expected today, and the Property Core chat reads the alerts. */
  async function propertyReads(orders = ["ord_1"]) {
    const made = await fixerTeam({ flows: ["supplies"], features: ["packages"] });
    await saveRoutine(made.m, F, made.fixer, "save_repair_alerts", FIX_HOOK, { property: made.property.id });
    writeOrders(made.root, orders.map((id) => order(id, { expectedBy: "2026-11-21" })));
    afterNine();
    return made;
  }

  it("a property with only Supply Core on gets its package alert through check_alerts", SLOW, async () => {
    const { m, property, main, supply, root } = await supplyOnly();
    await tickAllHostAlerts(m.hosted());
    await vi.waitFor(() => expect(wakesTo(m, SUP_HOOK.url, "supplies.update")).toBe(1));
    const packages = readFileSync(join(root, "packages.json"), "utf8");
    const first = await m.toolAt(S, supply, "check_alerts");
    expect(first.isError).toBe(false);
    expect(alertsOf(first)).toEqual([{ id: NOT_SEEN, kind: "packages", property: property.id, text: expect.stringContaining("nothing confirmed it arrived by 9 PM"), keptAt: clock.now.toISOString() }]);
    expect(first.structured!.notes).toEqual([]);
    expect(alertsOf(await m.toolAt(S, supply, "check_alerts"))).toHaveLength(0);
    for (const wake of m.wakes) expect(wake.body).not.toMatch(/package|Example Mart/i);
    // The producer's own record is never marked by the hand-over.
    expect(readFileSync(join(root, "packages.json"), "utf8")).toBe(packages);
    // It was the Supply Core bot's to read, so the Property Core chat is never shown it.
    expect(alertsOf(await m.toolAt(P, main, "check_alerts"))).toHaveLength(0);
    expect(readHostAlerts(root).alerts.map((a) => [a.id, a.via, Boolean(a.deliveredAt), Boolean(a.shownAt)])).toEqual([[NOT_SEEN, "supplies", true, true]]);
  });

  it("check_packages lists a package the clock tells as pending, never told twice", SLOW, async () => {
    const { m, property, supply } = await supplyOnly();
    expect((await m.toolAt(S, supply, "check_packages", { property: property.id })).structured).toMatchObject({ notSeen: [], notSeenPending: [{ orderId: "ord_1" }] });
    await tickAllHostAlerts(m.hosted());
    expect((await m.toolAt(S, supply, "check_packages", { property: property.id })).structured).toMatchObject({ notSeen: [], waiting: [{ orderId: "ord_1" }] });
    expect(alertsOf(await m.toolAt(S, supply, "check_alerts"))).toHaveLength(1);
  });

  it("a delivered alert is not sent again after a restart", SLOW, async () => {
    const { m } = await supplyOnly();
    await tickAllHostAlerts(m.hosted());
    await vi.waitFor(() => expect(wakesTo(m, SUP_HOOK.url, "supplies.update")).toBe(1));
    resetHostAlertClock();
    later(16);
    await tickAllHostAlerts(m.hosted());
    await tickAllHostAlerts(m.hosted());
    expect(wakesOf(m, "supplies.update")).toBe(1);
  });

  it("an alert with no routine waits and is shown once", SLOW, async () => {
    const { m, tenant, main } = await propertyReads();
    // The Property Core chat has no routine saved.
    m.hosted().secrets.deleteConnection(tenant.id, grantOf(m, main));
    await tickAllHostAlerts(m.hosted());
    later(16);
    await tickAllHostAlerts(m.hosted());
    expect(wakesOf(m, "property.update")).toBe(0);
    expect(alertsOf(await m.toolAt(P, main, "check_alerts"))).toHaveLength(1);
    expect(alertsOf(await m.toolAt(P, main, "check_alerts"))).toHaveLength(0);
    // Read once, it is never the reason for a wake-up later.
    await saveRoutine(m, P, main, "check_alerts", MAIN_HOOK, { connect: true });
    later(16);
    await tickAllHostAlerts(m.hosted());
    expect(wakesOf(m, "property.update")).toBe(0);
  });

  it("an alert that waited is sent once its bot saves a routine", SLOW, async () => {
    const { m, tenant, main } = await propertyReads();
    m.hosted().secrets.deleteConnection(tenant.id, grantOf(m, main));
    await tickAllHostAlerts(m.hosted());
    expect(wakesOf(m, "property.update")).toBe(0);
    await saveRoutine(m, P, main, "check_alerts", MAIN_HOOK, { connect: true });
    later(16);
    await tickAllHostAlerts(m.hosted());
    await vi.waitFor(() => expect(wakesTo(m, MAIN_HOOK.url, "property.update")).toBe(1));
    expect(alertsOf(await m.toolAt(P, main, "check_alerts"))).toHaveLength(1);
  });

  it("two alerts in one pass send one wake-up", SLOW, async () => {
    const { m, property, main, fixer } = await propertyReads(["ord_1", "ord_2"]);
    await tickAllHostAlerts(m.hosted());
    await vi.waitFor(() => expect(wakesTo(m, MAIN_HOOK.url, "property.update")).toBe(1));
    expect(wakesOf(m, "property.update")).toBe(1);
    expect(wakesOf(m, "supplies.update")).toBe(0);
    // A wrong argument or an unknown property reads nothing.
    expect((await m.toolAt(P, main, "check_alerts", { nope: true })).isError).toBe(true);
    expect((await m.toolAt(P, main, "check_alerts", { property: "prp_nothere000" })).isError).toBe(true);
    // Fixer Core's bot has neither job that reads them.
    const refused = await m.toolAt(F, fixer, "check_alerts");
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(elsewhereLine("property", false));
    expect(alertsOf(await m.toolAt(P, main, "check_alerts", { property: property.id })).map((a) => a.id)).toEqual([NOT_SEEN, "packages:supply:ord_2:not-seen"]);
    expect(alertsOf(await m.toolAt(P, main, "check_alerts"))).toHaveLength(0);
  });

  it("a wake-up that fails is tried again later, not on every tick", SLOW, async () => {
    const { m, main } = await propertyReads();
    const attempts = () => wakesTo(m, MAIN_HOOK.url, "property.update");
    m.setWakeStatus(500);
    await tickAllHostAlerts(m.hosted());
    await tickAllHostAlerts(m.hosted());
    expect(attempts()).toBe(1);
    m.setWakeStatus(200);
    later(6);
    await tickAllHostAlerts(m.hosted());
    expect(attempts()).toBe(2);
    later(6);
    await tickAllHostAlerts(m.hosted());
    expect(attempts()).toBe(2);
    expect(alertsOf(await m.toolAt(P, main, "check_alerts"))).toHaveLength(1);
  });

  it("an alert older than two days is let go, not shown late", SLOW, async () => {
    const { m, main } = await propertyReads();
    await tickAllHostAlerts(m.hosted());
    await vi.waitFor(() => expect(wakesTo(m, MAIN_HOOK.url, "property.update")).toBe(1));
    clock.now = new Date(clock.now.getTime() + ALERT_KEEPS_MS);
    expect(alertsOf(await m.toolAt(P, main, "check_alerts"))).toHaveLength(0);
  });

  it("an alert a bot was woken for and never read goes to the host's notes when the last core bot goes", SLOW, async () => {
    const { m, tenant, property, main, fixer, root } = await propertyReads();
    await tickAllHostAlerts(m.hosted());
    await vi.waitFor(() => expect(wakesTo(m, MAIN_HOOK.url, "property.update")).toBe(1));
    expect(readHostAlerts(root).alerts.map((a) => [a.id, a.via, Boolean(a.shownAt)])).toEqual([[NOT_SEEN, "property", false]]);
    // The Fixer Core bot goes before the Property Core chat read the alert, and check_alerts goes with it.
    dropConnection(m.hosted(), tenant.id, grantOf(m, fixer));
    expect(await m.toolNames(P, main)).not.toContain("check_alerts");
    later(1);
    await tickAllHostAlerts(m.hosted());
    const news = () => m.toolAt(P, main, "check_fixes", { property: property.id });
    expect(JSON.stringify((await news()).structured)).toContain("nothing confirmed it arrived by 9 PM");
    expect(readHostAlerts(root).alerts.map((a) => [a.id, a.via])).toEqual([[NOT_SEEN, "fixer"]]);
    // Once, however many passes follow.
    later(1);
    await tickAllHostAlerts(m.hosted());
    expect(JSON.stringify((await news()).structured)).not.toContain("nothing confirmed it arrived by 9 PM");
  });

  it("an alert a bot already read stays read when the last core bot goes", SLOW, async () => {
    const { m, tenant, property, main, fixer, root } = await propertyReads();
    await tickAllHostAlerts(m.hosted());
    expect(alertsOf(await m.toolAt(P, main, "check_alerts"))).toHaveLength(1);
    dropConnection(m.hosted(), tenant.id, grantOf(m, fixer));
    later(1);
    await tickAllHostAlerts(m.hosted());
    expect(JSON.stringify((await m.toolAt(P, main, "check_fixes", { property: property.id })).structured)).not.toContain("nothing confirmed it arrived by 9 PM");
    expect(readHostAlerts(root).alerts.map((a) => [a.id, a.via, Boolean(a.shownAt)])).toEqual([[NOT_SEEN, "property", true]]);
  });

  it("an account that isn't a team keeps today's path", SLOW, async () => {
    // A Fixer Core bot is connected and has saved nothing, so the Property Core chat still holds every job.
    const { m, property, main, root } = await fixerTeam({ flows: ["supplies"], features: ["packages"] });
    writeOrders(root, [order("ord_1", { expectedBy: "2026-11-21" })]);
    afterNine();
    await tickAllHostAlerts(m.hosted());
    expect(readHostAlerts(root).alerts.map((a) => [a.id, a.via])).toEqual([[NOT_SEEN, "fixer"]]);
    expect(wakesOf(m, "property.update")).toBe(0);
    expect(alertsOf(await m.toolAt(P, main, "check_alerts"))).toHaveLength(0);
    expect(JSON.stringify((await m.toolAt(P, main, "check_fixes", { property: property.id })).structured)).toContain("nothing confirmed it arrived by 9 PM");
  });

  it("check_alerts is listed only where a core has its own bot connected", SLOW, async () => {
    const off = await account({ bots: false, flows: ALL_FLOWS, features: EVERYTHING });
    expect(await off.m.toolNames(P, off.main)).not.toContain("check_alerts");
    const refused = await off.m.toolAt(P, off.main, "check_alerts");
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("There's no tool named check_alerts here.");
    // The switch on and one bot: what it lists today, nothing more.
    const one = await account({ label: "Court", line: COURT, flows: ALL_FLOWS, features: EVERYTHING });
    expect(await one.m.toolNames(P, one.main)).not.toContain("check_alerts");
    const m = one.m;
    const supply = await m.joinAt(one.tenant.id, "grok", S);
    const fixer = await m.joinAt(one.tenant.id, "grok", F);
    const cleaner = await m.joinAt(one.tenant.id, "grok", C);
    expect(await m.toolNames(P, one.main)).toContain("check_alerts");
    expect(await m.toolNames(S, supply)).toContain("check_alerts");
    expect(await m.toolNames(F, fixer)).not.toContain("check_alerts");
    expect(await m.toolNames(C, cleaner)).not.toContain("check_alerts");
  });

  it("the upload link is single-use and saves to the caller only", SLOW, async () => {
    const { m, tenant, property, main, supply, root } = await supplyOnly();
    await tickAllHostAlerts(m.hosted());
    const secrets = m.hosted().secrets;
    const mainBefore = secrets.connection(tenant.id, grantOf(m, main));
    const link = await m.toolAt(S, supply, "check_alerts", { connect: true });
    expect(link.structured).toEqual({ uploadUrl: expect.stringContaining(`/t/${tenant.id}/bots/alert-routine/`), expiresInMinutes: 30 });
    // Asking for the link reads nothing.
    expect(readHostAlerts(root).alerts[0]!.shownAt).toBeUndefined();
    const path = new URL(String(link.structured!.uploadUrl)).pathname;
    const post = (body: unknown) => m.app.http(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    // Values that can't be a routine are refused and leave the link open.
    expect((await post({ url: "http://example.com/not-https", token: "made-up-key-other-250" })).status).toBe(400);
    const other = { url: "https://example.com/second-supply-hook", token: "made-up-key-second-250" };
    expect((await post(other)).status).toBe(200);
    expect((await post(other)).status).toBe(404);
    expect(secrets.connection(tenant.id, grantOf(m, supply))).toEqual({ CLEANER_CORE_ROUTINE_URL: other.url, CLEANER_CORE_ROUTINE_KEY: other.token });
    expect(secrets.connection(tenant.id, grantOf(m, main))).toEqual(mainBefore);
    // The key that opens a saved door code is never taken as a routine's key.
    const doorKey = randomBytes(32);
    const ctx = propertyContext(m.hosted(), m.registry.get(tenant.id)!, property);
    expect(hubFor(ctx.root, { now: () => clock.now }).doorAccess(ctx.env).save(MADE_UP_CODE, undefined, doorKey).ok).toBe(true);
    const guarded = new URL(String((await m.toolAt(S, supply, "check_alerts", { connect: true })).structured!.uploadUrl)).pathname;
    expect((await m.app.http(guarded, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: other.url, token: doorKey.toString("base64") }) })).status).toBe(400);
    // A link nobody used stops working after 30 minutes.
    const stale = new URL(String((await m.toolAt(S, supply, "check_alerts", { connect: true })).structured!.uploadUrl)).pathname;
    later(31);
    expect((await m.app.http(stale, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(other) })).status).toBe(404);
  });
});

const notesOf = (reply: { structured?: Record<string, unknown> }) => reply.structured!.notes as string[];
const codeOf = (reply: { structured?: Record<string, unknown> }) => (reply.structured!.confirmation as { code: string }).code;
const START = new Date("2026-11-21T15:00:00.000Z");

describe("a quiet bot, and remove_bot", () => {
  /** The Fixer Core bot holds its job and last called at 15:00Z; the Property Core chat has its routine. */
  async function holdingFixer() {
    const made = await fixerTeam();
    await saveRoutine(made.m, F, made.fixer, "save_repair_alerts", FIX_HOOK, { property: made.property.id });
    expect((await made.m.toolAt(F, made.fixer, "check_fixes", { property: made.property.id })).isError).toBe(false);
    return made;
  }

  it("a holder quiet for 2.5 hours: the next wake-up also tells the Property Core bot, once, with no content", SLOW, async () => {
    const { m, tenant, property, main } = await holdingFixer();
    clock.now = new Date("2026-11-21T17:31:00.000Z");
    await pushFixerNews(m, tenant, property, "note-quiet-1", "The pro found a made-up leak under the sink.");
    await vi.waitFor(() => expect(wakesTo(m, MAIN_HOOK.url, "property.update")).toBe(1));
    for (const wake of m.wakes) expect(wake.body).not.toMatch(/leak|sink/);
    const first = await m.toolAt(P, main, "check_alerts");
    expect(notesOf(first)).toEqual([quietLine("fixer", START, NY)]);
    expect(notesOf(first)[0]).toBe("The Fixer Core bot hasn't checked in since 10:00 AM, and it has news waiting. Open it, or tell me if you removed it.");
    expect(notesOf(first)[0]).not.toMatch(/leak|sink/);
    expect(notesOf(await m.toolAt(P, main, "check_alerts"))).toEqual([]);
    await pushFixerNews(m, tenant, property, "note-quiet-2", "A second made-up note.");
    await vi.waitFor(() => expect(wakesTo(m, FIX_HOOK.url, "repairs.update")).toBeGreaterThan(0));
    expect(wakesTo(m, MAIN_HOOK.url, "property.update")).toBe(1);
    expect(notesOf(await m.toolAt(P, main, "check_alerts"))).toEqual([]);
  });

  it("a bot that isn't quiet tells nobody", SLOW, async () => {
    const { m, tenant, property, main } = await holdingFixer();
    clock.now = new Date("2026-11-21T17:00:00.000Z");
    await pushFixerNews(m, tenant, property, "note-busy", "A made-up repair note.");
    await vi.waitFor(() => expect(wakesTo(m, FIX_HOOK.url, "repairs.update")).toBeGreaterThan(0));
    expect(wakesOf(m, "property.update")).toBe(0);
    expect(notesOf(await m.toolAt(P, main, "check_alerts"))).toEqual([]);
  });

  it("a bot that checks in again is no longer told about, and a later quiet spell is told once more", SLOW, async () => {
    const { m, tenant, property, main, fixer } = await holdingFixer();
    clock.now = new Date("2026-11-21T17:31:00.000Z");
    await pushFixerNews(m, tenant, property, "note-a", "A made-up repair note.");
    await vi.waitFor(() => expect(wakesTo(m, MAIN_HOOK.url, "property.update")).toBe(1));
    // The Fixer Core bot wakes and reads its news before the Property Core bot asks.
    expect((await m.toolAt(F, fixer, "check_fixes", { property: property.id })).isError).toBe(false);
    expect(notesOf(await m.toolAt(P, main, "check_alerts"))).toEqual([]);
    clock.now = new Date("2026-11-21T20:05:00.000Z");
    await pushFixerNews(m, tenant, property, "note-b", "A second made-up repair note.");
    await vi.waitFor(() => expect(wakesTo(m, MAIN_HOOK.url, "property.update")).toBe(2));
    expect(notesOf(await m.toolAt(P, main, "check_alerts"))).toEqual([quietLine("fixer", new Date("2026-11-21T17:31:00.000Z"), NY)]);
  });

  /** Supply Core on with one package expected on `day`, a Supply Core bot holding its job since 15:00Z on the 21st, and the Property Core chat's own routine. */
  async function holdingSupply(day: string) {
    const made = await account({ flows: ["supplies"], features: ["packages"] });
    const supply = await made.m.joinAt(made.tenant.id, "grok", S);
    await saveRoutine(made.m, S, supply, "check_alerts", SUP_HOOK, { connect: true });
    await saveRoutine(made.m, P, made.main, "check_alerts", MAIN_HOOK, { connect: true });
    writeOrders(made.root, [order("ord_1", { expectedBy: day })]);
    clock.now = new Date(zonedInstant(day, "21:05", NY));
    return { ...made, supply };
  }

  it("a Supply Core bot that checked in earlier today isn't called quiet: its check runs once a day", SLOW, async () => {
    // Its last call was 11 hours before the alert, well inside a day.
    const { m, main } = await holdingSupply("2026-11-21");
    await tickAllHostAlerts(m.hosted());
    await vi.waitFor(() => expect(wakesTo(m, SUP_HOOK.url, "supplies.update")).toBe(1));
    expect(wakesTo(m, MAIN_HOOK.url, "property.update")).toBe(0);
    expect(notesOf(await m.toolAt(P, main, "check_alerts"))).toEqual([]);
    const entry = ((await m.toolAt(P, main, "get_state", {})).structured!.team as TeamEntry[]).find((each) => each.job === "supplies")!;
    expect(entry.quiet).toBeUndefined();
  });

  it("a Supply Core bot quiet for over a day with an alert waiting is told about too, and the alert stays its own", SLOW, async () => {
    // Its last call was 35 hours before the alert.
    const { m, main } = await holdingSupply("2026-11-22");
    await tickAllHostAlerts(m.hosted());
    await vi.waitFor(() => expect(wakesTo(m, SUP_HOOK.url, "supplies.update")).toBe(1));
    await vi.waitFor(() => expect(wakesTo(m, MAIN_HOOK.url, "property.update")).toBe(1));
    const read = await m.toolAt(P, main, "check_alerts");
    expect(alertsOf(read)).toEqual([]);
    expect(notesOf(read)).toEqual([quietLine("supplies", START, NY, clock.now)]);
    expect(notesOf(read)[0]).not.toMatch(/package|Example Mart/i);
    const entry = ((await m.toolAt(P, main, "get_state", {})).structured!.team as TeamEntry[]).find((each) => each.job === "supplies")!;
    expect(entry.quiet).toBe(true);
    expect(entry.note).toBe(quietNote("supplies"));
    expect(entry.note).toBe("The Supply Core bot hasn't checked in for over a day.");
  });

  it("a quiet Cleaner Core bot is told about when its desk queues a wake-up", SLOW, async () => {
    const at = { now: new Date("2026-11-21T15:00:00.000Z") };
    const s = await sharedAccount({ now: () => at.now });
    open = s.m;
    const m = s.m;
    switchOn(m.registry, s.accountId, "bots");
    const id = await s.liveProperty("Scratch Lane", SCRATCH_LANE, { cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
    await s.tool("save_alert_routine", { property: id, url: MAIN_HOOK.url, token: MAIN_HOOK.token });
    const cleaner = await m.joinAt(s.accountId, "grok", C);
    expect((await m.toolAt(C, cleaner, "save_alert_routine", { property: id, url: CLEAN_HOOK.url, token: CLEAN_HOOK.token })).isError).toBe(false);
    const lastCall = at.now;
    at.now = new Date(at.now.getTime() + 151 * 60_000);
    const ctx = propertyContext(m.hosted(), m.registry.get(s.accountId)!, s.property(id));
    expect(await liveDeskFor(ctx.root, ctx.env, () => m.hosted().now()).noteForHost("note-quiet-cleaner", "A made-up note for the host.")).toBe(true);
    await vi.waitFor(() => expect(wakesTo(m, MAIN_HOOK.url, "property.update")).toBe(1));
    const read = await s.tool("check_alerts", {});
    expect(notesOf(read)).toHaveLength(1);
    expect(notesOf(read)[0]).toBe(quietLine("cleaning", lastCall, String(JSON.parse(readFileSync(join(ctx.root, "hub.json"), "utf8")).property.timeZone), at.now));
    expect(notesOf(read)[0]).not.toMatch(/made-up note/);
  });

  it("every wake-up is an event's name, ids and a time, and never holds the door code", SLOW, async () => {
    const at = { now: new Date("2026-11-21T15:00:00.000Z") };
    const s = await sharedAccount({ now: () => at.now });
    open = s.m;
    const m = s.m;
    switchOn(m.registry, s.accountId, "bots");
    const id = await s.liveProperty("Scratch Lane", SCRATCH_LANE, { cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
    await s.tool("save_alert_routine", { property: id, url: MAIN_HOOK.url, token: MAIN_HOOK.token });
    const cleaner = await m.joinAt(s.accountId, "grok", C);
    expect((await m.toolAt(C, cleaner, "save_alert_routine", { property: id, url: CLEAN_HOOK.url, token: CLEAN_HOOK.token })).isError).toBe(false);
    const ctx = propertyContext(m.hosted(), m.registry.get(s.accountId)!, s.property(id));
    const desk = () => liveDeskFor(ctx.root, ctx.env, () => m.hosted().now());
    expect(await desk().noteForHost("note-wake-1", "A made-up note for the host.")).toBe(true);
    await vi.waitFor(() => expect(wakesTo(m, CLEAN_HOOK.url, "cleaning.update")).toBe(1));
    at.now = new Date(at.now.getTime() + 151 * 60_000);
    expect(await desk().noteForHost("note-wake-2", "A second made-up note for the host.")).toBe(true);
    await vi.waitFor(() => expect(wakesTo(m, MAIN_HOOK.url, "property.update")).toBe(1));
    // The routine's own test wake-up at save time is checked with the rest.
    expect([...new Set(m.wakes.map((wake) => JSON.parse(wake.body).eventType))].sort()).toEqual(["cleaning.update", "installation.test", "property.update"]);
    for (const wake of m.wakes) {
      const event = OperatorEventSchema.parse(JSON.parse(wake.body));
      expect(Object.keys(event).filter((key) => !["schemaVersion", "eventId", "eventType", "propertyId", "occurredAt"].includes(key))).toEqual([]);
      expect(Number.isNaN(Date.parse(event.occurredAt))).toBe(false);
      // The event's own id is random letters and digits, so it's left out of the search for the saved code.
      expect(JSON.stringify({ ...event, eventId: "" })).not.toContain(SCRATCH_LANE.pin);
      expect(JSON.stringify(event)).not.toMatch(/made-up note/);
    }
  });

  it("the quiet line says the day when it isn't today, and no time without a time zone", () => {
    const since = new Date("2026-11-20T19:10:00.000Z");
    expect(quietLine("cleaning", since, NY)).toBe("The Cleaner Core bot hasn't checked in since 2:10 PM, and it has news waiting. Open it, or tell me if you removed it.");
    expect(quietLine("cleaning", since, NY, new Date("2026-11-20T23:00:00.000Z"))).toBe(quietLine("cleaning", since, NY));
    expect(quietLine("cleaning", since, NY, new Date("2026-11-21T15:00:00.000Z"))).toBe("The Cleaner Core bot hasn't checked in since Friday, Nov 20 at 2:10 PM, and it has news waiting. Open it, or tell me if you removed it.");
    expect(quietLine("fixer", since, undefined)).toBe("The Fixer Core bot hasn't checked in in over 2 hours, and it has news waiting. Open it, or tell me if you removed it.");
    expect(quietLine("supplies", since, undefined)).toBe("The Supply Core bot hasn't checked in in over a day, and it has news waiting. Open it, or tell me if you removed it.");
  });

  it("remove_bot hands the job back after the host's yes", SLOW, async () => {
    const { m, tenant, property, main, fixer } = await holdingFixer();
    const fixerId = grantOf(m, fixer);
    clock.now = new Date("2026-11-21T17:31:00.000Z");
    await pushFixerNews(m, tenant, property, "note-gone", "A made-up note written while the bot was gone.");
    const ask = await m.toolAt(P, main, "remove_bot", { bot: "fixer" });
    expect(ask.isError).toBe(false);
    expect(ask.text).toBe(removeBotQuestion("fixer"));
    // Asking changes nothing.
    expect(await m.toolNames(P, main)).not.toContain("check_fixes");
    expect((await m.rpcAt(F, fixer, "tools/list")).status).toBe(200);
    const done = await m.toolAt(P, main, "remove_bot", { bot: "fixer", confirmation: codeOf(ask) });
    expect(done.isError).toBe(false);
    expect(done.text).toBe(botRemovedLine("fixer"));
    expect(await m.toolNames(P, main)).toContain("check_fixes");
    expect((await m.rpcAt(F, fixer, "tools/list")).status).toBe(401);
    expect(m.hosted().secrets.connection(tenant.id, fixerId)).toEqual({});
    expect(m.registry.get(tenant.id)!.connections.some((c) => c.job)).toBe(false);
    expect(JSON.stringify((await m.toolAt(P, main, "check_fixes", { property: property.id })).structured)).toContain("A made-up note written while the bot was gone.");
    // The code worked once.
    expect((await m.toolAt(P, main, "remove_bot", { bot: "fixer", confirmation: codeOf(ask) })).isError).toBe(true);
    // Nothing is left to tell the host about a bot that is gone.
    expect(JSON.parse(readFileSync(join(tenantFolder(m.app.root, tenant.id), QUIET_BOTS_FILE), "utf8"))).toEqual({});
  });

  it("remove_bot is refused from a core's bot, and with a wrong confirmation", SLOW, async () => {
    const { m, tenant, main, fixer } = await holdingFixer();
    const fromBot = await m.toolAt(F, fixer, "remove_bot", { bot: "fixer" });
    expect(fromBot.isError).toBe(true);
    expect(fromBot.text).toBe(elsewhereLine("property", false));
    expect(await m.toolNames(F, fixer)).not.toContain("remove_bot");
    expect(await m.toolNames(P, main)).toContain("remove_bot");
    const wrong = await m.toolAt(P, main, "remove_bot", { bot: "fixer", confirmation: "MADEUP" });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toBe(BOT_APPROVAL_STALE);
    const none = await m.toolAt(P, main, "remove_bot", { bot: "supplies" });
    expect(none.isError).toBe(true);
    expect(none.text).toBe(noBotLine("supplies"));
    for (const args of [{}, { bot: "property" }, { bot: "fixer", force: true }]) expect((await m.toolAt(P, main, "remove_bot", args)).isError, JSON.stringify(args)).toBe(true);
    // A confirmation for one bot never removes another.
    const supply = await m.joinAt(tenant.id, "grok", S);
    const forFixer = await m.toolAt(P, main, "remove_bot", { bot: "fixer" });
    expect((await m.toolAt(P, main, "remove_bot", { bot: "supplies", confirmation: codeOf(forFixer) })).isError).toBe(true);
    expect((await m.rpcAt(F, fixer, "tools/list")).status).toBe(200);
    expect((await m.rpcAt(S, supply, "tools/list")).status).toBe(200);
    expect(await m.toolNames(P, main)).not.toContain("check_fixes");
  });

  it("a confirmation asked for one Fixer Core bot doesn't remove the one that replaced it", SLOW, async () => {
    const { m, tenant, main } = await holdingFixer();
    const ask = await m.toolAt(P, main, "remove_bot", { bot: "fixer" });
    const second = await m.joinAt(tenant.id, "grok", F);
    expect((await m.toolAt(P, main, "remove_bot", { bot: "fixer", confirmation: codeOf(ask) })).isError).toBe(true);
    expect((await m.rpcAt(F, second, "tools/list")).status).toBe(200);
  });

  it("remove_bot is listed only where a core has its own bot connected", SLOW, async () => {
    const off = await account({ bots: false, flows: ALL_FLOWS });
    expect(await off.m.toolNames(P, off.main)).not.toContain("remove_bot");
    expect((await off.m.toolAt(P, off.main, "remove_bot", { bot: "fixer" })).text).toContain("There's no tool named remove_bot here.");
    const one = await account({ label: "Court", line: COURT, flows: ALL_FLOWS });
    expect(await one.m.toolNames(P, one.main)).not.toContain("remove_bot");
    await one.m.joinAt(one.tenant.id, "grok", F);
    expect(await one.m.toolNames(P, one.main)).toContain("remove_bot");
  });

  it("lastSeenAt moves at most every 5 minutes", SLOW, async () => {
    const { m, tenant, property, fixer } = await holdingFixer();
    const seenAt = () => m.registry.get(tenant.id)!.connections.find((c) => c.job === "fixer")!.lastSeenAt;
    expect(seenAt()).toBe(START.toISOString());
    later(4);
    await m.toolAt(F, fixer, "check_fixes", { property: property.id });
    expect(seenAt()).toBe(START.toISOString());
    later(2);
    await m.toolAt(F, fixer, "check_fixes", { property: property.id });
    expect(seenAt()).toBe(new Date(START.getTime() + 6 * 60_000).toISOString());
  });
});

describe("filing from the Cleaner Core bot", () => {
  const DRIP = { trade: "plumbing", what: "The kitchen tap drips.", urgency: "soon" };

  /** Every flow on, Fixer Core active, one item on the supply list, and a bot for each core. The Supply Core and Fixer Core bots hold their jobs. */
  async function threeBots() {
    const made = await account({ flows: ALL_FLOWS });
    const { m, tenant, property, main, root } = made;
    await activeFixer(m, main, property, false);
    writeOrders(root, []);
    const cleaner = await m.joinAt(tenant.id, "grok", C);
    const supply = await m.joinAt(tenant.id, "grok", S);
    const fixer = await m.joinAt(tenant.id, "grok", F);
    await saveRoutine(m, S, supply, "check_alerts", SUP_HOOK, { connect: true });
    await saveRoutine(m, F, fixer, "save_repair_alerts", FIX_HOOK, { property: property.id });
    return { ...made, cleaner, supply, fixer };
  }

  it("the Cleaner bot lists the three filing tools and nothing else of the other cores", SLOW, async () => {
    const { m, cleaner } = await threeBots();
    const names = await m.toolNames(C, cleaner);
    for (const name of ["get_supply_state", "report_low", "open_job"]) expect(names, name).toContain(name);
    for (const name of ["approve_cart", "check_supplies", "check_cart", "record_order", "approve_job", "check_fixes", "save_pro", "check_alerts", "remove_bot"]) expect(names, name).not.toContain(name);
  });

  it("report_low from the Cleaner bot is written once, wakes the Supply bot, and carries no question", SLOW, async () => {
    const { m, property, cleaner, root } = await threeBots();
    const list = await m.toolAt(C, cleaner, "get_supply_state", { property: property.id });
    expect(list.isError).toBe(false);
    expect(list.structured).toEqual({ items: [{ id: "itm_towels", name: "Paper towels" }] });
    const p = { property: property.id, itemIds: ["itm_towels"] };
    for (const source of ["host", undefined]) {
      const refused = await m.toolAt(C, cleaner, "report_low", { ...p, ...(source ? { source } : {}) });
      expect(refused.isError).toBe(true);
      expect(refused.text).toBe(FILING_SOURCE);
    }
    expect(readSupply(root).lowReports).toEqual([]);
    expect(wakesOf(m, "supplies.update")).toBe(0);
    const filed = await m.toolAt(C, cleaner, "report_low", { ...p, source: "cleaner" });
    expect(filed.isError).toBe(false);
    expect(filed.text).toBe(filedLine("report_low", true));
    expect(filed.structured).toEqual({ filed: true });
    await vi.waitFor(() => expect(wakesTo(m, SUP_HOOK.url, "supplies.update")).toBe(1));
    expect(wakesOf(m, "supplies.update")).toBe(1);
    expect(readSupply(root).lowReports).toEqual([{ itemId: "itm_towels", source: "cleaner", at: clock.now.toISOString() }]);
    for (const wake of m.wakes) expect(wake.body).not.toMatch(/towel/i);
    // An id that isn't on the list is the desk's own refusal, and wakes nobody.
    const unknown = await m.toolAt(C, cleaner, "report_low", { property: property.id, itemIds: ["itm_nothere"], source: "cleaner" });
    expect(unknown.isError).toBe(true);
    expect(unknown.structured).toBeUndefined();
    expect(wakesOf(m, "supplies.update")).toBe(1);
  });

  it("open_job from the Cleaner bot waits for the host in the Fixer bot's chat", SLOW, async () => {
    const { m, tenant, property, cleaner, fixer, root } = await threeBots();
    const p = { property: property.id, ...DRIP };
    const refused = await m.toolAt(C, cleaner, "open_job", { ...p, source: "host" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(FILING_SOURCE);
    expect(readFixer(root).jobs).toEqual([]);
    const before = wakesTo(m, FIX_HOOK.url, "repairs.update");
    const filed = await m.toolAt(C, cleaner, "open_job", { ...p, source: "cleaner" });
    expect(filed.isError).toBe(false);
    expect(filed.text).toBe(filedLine("open_job", true));
    expect(Object.keys(filed.structured!).sort()).toEqual(["filed", "jobId"]);
    expect(filed.text).not.toMatch(/\?/);
    await vi.waitFor(() => expect(wakesTo(m, FIX_HOOK.url, "repairs.update")).toBe(before + 1));
    const jobs = readFixer(propertyFolder(m.app.root, tenant.id, property)).jobs;
    expect(jobs.map((job) => [job.id, job.source, job.hostGo])).toEqual([[filed.structured!.jobId, "cleaner", undefined]]);
    // The host's go is asked for in the Fixer Core bot's chat, as for any job that waits on it.
    const fixes = JSON.stringify((await m.toolAt(F, fixer, "check_fixes", { property: property.id })).structured);
    expect(fixes).toContain(String(filed.structured!.jobId));
    expect(fixes).toContain("The kitchen tap drips.");
    expect(wakesTo(m, FIX_HOOK.url, "repairs.update")).toBe(before + 1);
  });

  it("a filing's wake-up that doesn't go through is tried again by the clock, until it does", SLOW, async () => {
    const { m, property, cleaner } = await threeBots();
    const attempts = () => wakesTo(m, SUP_HOOK.url, "supplies.update");
    m.setWakeStatus(500);
    const filed = await m.toolAt(C, cleaner, "report_low", { property: property.id, itemIds: ["itm_towels"], source: "cleaner" });
    expect(filed.structured).toEqual({ filed: true });
    expect(attempts()).toBe(1);
    // Not on every tick: after 5 minutes.
    await tickAllHostAlerts(m.hosted());
    expect(attempts()).toBe(1);
    later(6);
    await tickAllHostAlerts(m.hosted());
    expect(attempts()).toBe(2);
    m.setWakeStatus(200);
    later(6);
    await tickAllHostAlerts(m.hosted());
    expect(attempts()).toBe(3);
    // Once it went through, it's done.
    later(6);
    await tickAllHostAlerts(m.hosted());
    expect(attempts()).toBe(3);
    for (const wake of m.wakes) expect(wake.body).not.toMatch(/towel/i);
  });

  it("a filing's wake-up isn't tried again once its bot has checked in, or after two days", SLOW, async () => {
    const { m, property, cleaner, supply, fixer } = await threeBots();
    m.setWakeStatus(500);
    expect((await m.toolAt(C, cleaner, "report_low", { property: property.id, itemIds: ["itm_towels"], source: "cleaner" })).isError).toBe(false);
    expect((await m.toolAt(C, cleaner, "open_job", { property: property.id, ...DRIP, source: "cleaner" })).isError).toBe(false);
    const sent = () => [wakesTo(m, SUP_HOOK.url, "supplies.update"), wakesTo(m, FIX_HOOK.url, "repairs.update")];
    const before = sent();
    // The Supply Core bot reads its list on its own; the Fixer Core bot stays away.
    later(6);
    expect((await m.toolAt(S, supply, "get_state", { property: property.id })).isError).toBe(false);
    await tickAllHostAlerts(m.hosted());
    expect(sent()).toEqual([before[0]!, before[1]! + 1]);
    clock.now = new Date(clock.now.getTime() + ALERT_KEEPS_MS);
    await tickAllHostAlerts(m.hosted());
    await tickAllHostAlerts(m.hosted());
    expect(sent()).toEqual([before[0]!, before[1]! + 1]);
    expect(await m.toolNames(F, fixer)).toContain("check_fixes");
  });

  it("a filing whose wake-up went through keeps nothing to try again", SLOW, async () => {
    const { m, tenant, property, cleaner } = await threeBots();
    expect((await m.toolAt(C, cleaner, "report_low", { property: property.id, itemIds: ["itm_towels"], source: "cleaner" })).isError).toBe(false);
    expect(existsSync(join(tenantFolder(m.app.root, tenant.id), KEPT_WAKES_FILE))).toBe(false);
    later(6);
    await tickAllHostAlerts(m.hosted());
    expect(wakesTo(m, SUP_HOOK.url, "supplies.update")).toBe(1);
  });

  it("a filing into a core with no bot of its own names the Property Core bot and wakes its routine", SLOW, async () => {
    const { m, tenant, property, main, root } = await account({ flows: ALL_FLOWS });
    await activeFixer(m, main, property, false);
    writeOrders(root, []);
    const cleaner = await m.joinAt(tenant.id, "grok", C);
    await saveRoutine(m, P, main, "check_alerts", MAIN_HOOK, { connect: true });
    const low = await m.toolAt(C, cleaner, "report_low", { property: property.id, itemIds: ["itm_towels"], source: "cleaner" });
    expect(low.text).toBe(filedLine("report_low", false));
    const job = await m.toolAt(C, cleaner, "open_job", { property: property.id, ...DRIP, source: "cleaner" });
    expect(job.text).toBe(filedLine("open_job", false));
    await vi.waitFor(() => expect(wakesTo(m, MAIN_HOOK.url, "supplies.update")).toBe(1));
    await vi.waitFor(() => expect(wakesTo(m, MAIN_HOOK.url, "repairs.update")).toBe(1));
  });

  it("the Property Core chat files too once Supply Core has its own bot, and keeps Fixer Core's own answers", SLOW, async () => {
    const { m, tenant, property, main, root } = await account({ flows: ALL_FLOWS });
    await activeFixer(m, main, property, false);
    writeOrders(root, []);
    const supply = await m.joinAt(tenant.id, "grok", S);
    await saveRoutine(m, S, supply, "check_alerts", SUP_HOOK, { connect: true });
    const names = await m.toolNames(P, main);
    for (const name of ["get_supply_state", "report_low"]) expect(names, name).toContain(name);
    expect(names).not.toContain("check_supplies");
    expect((await m.toolAt(P, main, "report_low", { property: property.id, itemIds: ["itm_towels"], source: "host" })).text).toBe(FILING_SOURCE);
    expect((await m.toolAt(P, main, "report_low", { property: property.id, itemIds: ["itm_towels"], source: "cleaner" })).text).toBe(filedLine("report_low", true));
    await vi.waitFor(() => expect(wakesTo(m, SUP_HOOK.url, "supplies.update")).toBe(1));
    // Fixer Core is still this chat's own: its open_job answers as it always did.
    const own = await m.toolAt(P, main, "open_job", { property: property.id, ...DRIP, source: "host" });
    expect(own.isError).toBe(false);
    expect(Object.keys(own.structured!)).toEqual(expect.arrayContaining(["jobId", "state", "next"]));
    // The Supply Core bot's own report is its own call, not a filing.
    const direct = await m.toolAt(S, supply, "report_low", { property: property.id, itemIds: ["itm_towels"], source: "host" });
    expect(direct.isError).toBe(false);
    expect(direct.structured).toMatchObject({ due: ["Paper towels"] });
    expect(wakesOf(m, "supplies.update")).toBe(1);
  });

  it("a filing is refused where the owning core isn't on", SLOW, async () => {
    const { m, tenant, property } = await account({ flows: ["cleaning", "fixer"] });
    const cleaner = await m.joinAt(tenant.id, "grok", C);
    expect(await m.toolNames(C, cleaner)).not.toContain("report_low");
    const reply = await m.toolAt(C, cleaner, "report_low", { property: property.id, itemIds: ["itm_towels"], source: "cleaner" });
    expect(reply.isError).toBe(true);
    expect(reply.text).toBe(flowOff("supplies", property.label));
    expect(wakesOf(m, "supplies.update")).toBe(0);
    // Where Cleaner Core doesn't run there is no cleaner to file for: the host is sent to the bot that holds Supply Core.
    const other = await account({ label: "Court", line: COURT, flows: ["supplies"] });
    const supply = await m.joinAt(other.tenant.id, "grok", S);
    await saveRoutine(m, S, supply, "check_alerts", SUP_HOOK, { connect: true });
    writeOrders(other.root, []);
    expect(await m.toolNames(P, other.main)).not.toContain("report_low");
    const sent = await m.toolAt(P, other.main, "report_low", { property: other.property.id, itemIds: ["itm_towels"], source: "cleaner" });
    expect(sent.isError).toBe(true);
    expect(sent.text).toBe(elsewhereLine("supplies", true));
    expect(readSupply(other.root).lowReports).toEqual([]);
  });

  it("with one bot, report_low and open_job answer as on master", SLOW, async () => {
    const { m, property, main, root } = await account({ flows: ["supplies"] });
    await activeFixer(m, main, property);
    writeOrders(root, []);
    const low = await m.toolAt(P, main, "report_low", { property: property.id, itemIds: ["itm_towels"], source: "host" });
    expect(low.isError).toBe(false);
    expect(low.structured).toMatchObject({ due: ["Paper towels"], next: expect.any(String) });
    const job = await m.toolAt(P, main, "open_job", { property: property.id, ...DRIP, source: "cleaner" });
    expect(job.isError).toBe(false);
    expect(Object.keys(job.structured!)).toEqual(expect.arrayContaining(["jobId", "state", "question", "next"]));
    expect(wakesOf(m, "supplies.update")).toBe(0);
  });
});

describe("get_state by job, and the team view", () => {
  type Line = { id: string; label: string; flow?: string; flows?: Record<string, boolean>; next?: unknown };
  const stateAt = async (m: MultiTenantApp, path: McpAddress, token: string, args: Record<string, unknown> = {}) => {
    const reply = await m.toolAt(path, token, "get_state", args);
    expect(reply.isError, reply.text).toBe(false);
    return reply.structured!;
  };

  /** Every flow on at one property, Fixer Core active, and a Fixer Core bot that holds its job. */
  async function withFixerBot() {
    const made = await account({ flows: ALL_FLOWS });
    await activeFixer(made.m, made.main, made.property, false);
    const fixer = await made.m.joinAt(made.tenant.id, "grok", F);
    await saveRoutine(made.m, F, fixer, "save_repair_alerts", FIX_HOOK, { property: made.property.id });
    return { ...made, fixer };
  }

  it("a core's bot sees only its own flow", SLOW, async () => {
    const { m, tenant, property, fixer } = await withFixerBot();
    const one = await stateAt(m, F, fixer, { property: property.id });
    expect(String(one.line)).toMatch(/^Repairs: on/);
    expect(one.ask).toBeUndefined();
    expect(one.properties).toEqual([{ id: property.id, label: property.label, flow: "on" }]);
    expect(JSON.stringify(one)).not.toMatch(/"cleaning"|"supplies":\s*(true|false)|doorCode|checklist/);
    // A second property that doesn't run Fixer Core is listed as off, with no next step.
    const second = m.registry.addProperty(tenant.id, "9 Made-up Road");
    m.registry.setFlow(tenant.id, second.id, "cleaning", true);
    const all = await stateAt(m, F, fixer);
    expect(all.properties).toEqual([
      { id: property.id, label: property.label, flow: "on" },
      { id: second.id, label: second.label, flow: "off" },
    ]);
    const off = await stateAt(m, F, fixer, { property: second.id });
    expect(off.flow).toBe("off");
    expect(off.next).toBeUndefined();
    expect(off.ask).toBeUndefined();
    expect(JSON.stringify(off)).not.toMatch(/"cleaning"/);
  });

  it("a core's bot in setup gets its own flow's ask, never Cleaner Core's", SLOW, async () => {
    const { m, tenant, property, main } = await account({ flows: ALL_FLOWS });
    const cleaningStep = ((await stateAt(m, P, main, { property: property.id })).ask as { step: string } | undefined)?.step ?? "draft";
    const fixer = await m.joinAt(tenant.id, "grok", F);
    const state = await stateAt(m, F, fixer, { property: property.id });
    const ask = state.ask as { step: string; tool: string };
    expect(ask.tool).toMatch(/fixer|pro|repair/);
    expect(ask.step).not.toBe(cleaningStep);
    expect(state.draft).toBeUndefined();
    const supply = await m.joinAt(tenant.id, "grok", S);
    expect(((await stateAt(m, S, supply, { property: property.id })).ask as { tool: string }).tool).toMatch(/suppl|store|item|list/);
  });

  it("the Property Core bot sees the team", SLOW, async () => {
    const { m, main, fixer } = await withFixerBot();
    const team = (await stateAt(m, P, main)).team as TeamEntry[];
    expect(team.map((entry) => entry.job)).toEqual(["cleaning", "supplies", "fixer"]);
    expect(team.find((entry) => entry.job === "fixer")).toEqual({ job: "fixer", holder: "own bot", agent: "grok", connectedAt: expect.any(String), lastSeenAt: clock.now.toISOString(), alerts: "connected" });
    expect(team.find((entry) => entry.job === "cleaning")).toEqual({ job: "cleaning", holder: "this chat", alerts: "not connected" });
    // No core's bot ever sees the team.
    expect((await stateAt(m, F, fixer)).team).toBeUndefined();
  });

  it("the team has an entry only for a core that runs somewhere", SLOW, async () => {
    const { m, tenant, main } = await fixerTeam();
    await m.joinAt(tenant.id, "grok", S);
    const team = (await stateAt(m, P, main)).team as TeamEntry[];
    expect(team.map((entry) => entry.job)).toEqual(["fixer"]);
    // Connected, nothing saved: the core is still in the Property Core chat, and the host is told why.
    expect(team[0]).toEqual({ job: "fixer", holder: "this chat", alerts: "connected", note: setupWaitingNote("fixer") });
  });

  it("the team view names each flow's next step and nothing more", SLOW, async () => {
    const { m, tenant, property, main } = await account({ flows: ALL_FLOWS });
    const fixer = await m.joinAt(tenant.id, "grok", F);
    await saveRoutine(m, F, fixer, "save_repair_alerts", FIX_HOOK, { property: property.id });
    const own = (await stateAt(m, F, fixer, { property: property.id })).ask as Record<string, unknown>;
    expect(typeof own.step).toBe("string");
    const seen = await stateAt(m, P, main, { property: property.id });
    const line = (seen.properties as Line[])[0]!;
    expect(line.next).toEqual({ cleaning: expect.any(String), supplies: expect.any(String), fixer: own.step });
    // Nothing of Fixer Core's ask but the step's name reaches the Property Core chat.
    const said = JSON.stringify({ properties: seen.properties, team: seen.team });
    for (const [key, value] of Object.entries(own)) if (key !== "step" && typeof value === "string" && value.length > 12) expect(said, key).not.toContain(value);
    // The property's own state here is Cleaner Core's, which this chat still runs.
    expect((seen.ask as { tool?: string } | undefined)?.tool ?? "draft").not.toBe(own.tool);
  });

  it("a property whose only core has its own bot sends the host there", SLOW, async () => {
    const { m, property, main, fixer } = await fixerTeam();
    await saveRoutine(m, F, fixer, "save_repair_alerts", FIX_HOOK, { property: property.id });
    const seen = await stateAt(m, P, main, { property: property.id });
    expect(seen.next).toBe(teamLine(["fixer"]));
    expect(seen.line).toBeUndefined();
    expect(seen.summary).toBeUndefined();
    expect((seen.properties as Line[])[0]!.flows).toEqual({ cleaning: false, supplies: false, fixer: true });
  });

  it("the Property Core chat's team view uses up nothing of the Cleaner Core bot's: the door-code failure line stays for it", SLOW, async () => {
    const s = await sharedAccount();
    open = s.m;
    const m = s.m;
    switchOn(m.registry, s.accountId, "bots");
    const id = await s.liveProperty("Scratch Lane", SCRATCH_LANE, { cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
    await s.tool("save_alert_routine", { property: id, url: MAIN_HOOK.url, token: MAIN_HOOK.token });
    const cleaner = await m.joinAt(s.accountId, "grok", C);
    expect((await m.toolAt(C, cleaner, "save_alert_routine", { property: id, url: CLEAN_HOOK.url, token: CLEAN_HOOK.token })).isError).toBe(false);
    expect((await m.toolAt(C, cleaner, "get_state", { property: id })).isError).toBe(false);
    // A code text that failed sets the engine's one-time flag; the next get_state that reads the desk says so, once.
    const ctx = propertyContext(m.hosted(), m.registry.get(s.accountId)!, s.property(id));
    const engine = (liveDeskFor(ctx.root, ctx.env, () => m.hosted().now()) as unknown as { engine?: { pinFailurePending: boolean } }).engine!;
    engine.pinFailurePending = true;
    const team = await s.tool("get_state", {});
    expect(team.isError).toBe(false);
    expect(JSON.stringify(team.structured)).not.toContain(GROK_PIN_FAILED);
    const own = await m.toolAt(C, cleaner, "get_state", { property: id });
    expect(String(own.structured!.next)).toBe(GROK_PIN_FAILED);
    expect(String((await m.toolAt(C, cleaner, "get_state", { property: id })).structured!.next)).not.toBe(GROK_PIN_FAILED);
  });

  it("a core's bot is never made, and can't answer, an offer for a feature it can't run", SLOW, async () => {
    // Fixer Core alone at the property and set up, with three Property Core features switched on for the account.
    const { m, tenant, property, fixer } = await fixerTeam({ features: ["hours", "visits", "oversight"] });
    await saveRoutine(m, F, fixer, "save_repair_alerts", FIX_HOOK, { property: property.id });
    const own = await stateAt(m, F, fixer, { property: property.id });
    expect(own.offer).toBeUndefined();
    const answer = await m.toolAt(F, fixer, "get_state", { property: property.id, offered: "hours" });
    expect(answer.isError).toBe(true);
    expect(answer.text).toBe(elsewhereLine("property", false));
    expect(m.registry.get(tenant.id)!.properties[0]!.offersAnswered ?? []).toEqual([]);
  });

  it("with one bot, a set-up property is still made its feature offers", SLOW, async () => {
    const { m, tenant, property, main } = await account({ flows: ["fixer"], features: ["hours", "visits", "oversight"] });
    await activeFixer(m, main, property);
    const state = await stateAt(m, P, main, { property: property.id });
    expect((state.offer as { offer: string }).offer).toBe("expected-visits");
    expect((await m.toolAt(P, main, "get_state", { property: property.id, offered: "expected-visits" })).isError).toBe(false);
    expect(m.registry.get(tenant.id)!.properties[0]!.offersAnswered).toEqual(["expected-visits"]);
  });

  it("a quiet bot is marked", SLOW, async () => {
    const { m, main } = await withFixerBot();
    later(151);
    const entry = ((await stateAt(m, P, main)).team as TeamEntry[]).find((each) => each.job === "fixer")!;
    expect(entry.quiet).toBe(true);
    expect(entry.note).toBe(quietNote("fixer"));
    expect(entry.note).toBe("The Fixer Core bot hasn't checked in for over 2 hours.");
  });

  it("a core's bot that hasn't saved its routine is told to, even when the Property Core chat has one", SLOW, async () => {
    const { m, property, fixer } = await fixerTeam();
    const before = await stateAt(m, F, fixer, { property: property.id });
    expect(before.alertsNote).toBe(noRoutineNote("fixer"));
    expect(String(before.alertsNote)).toContain("save_repair_alerts");
    await saveRoutine(m, F, fixer, "save_repair_alerts", FIX_HOOK, { property: property.id });
    expect((await stateAt(m, F, fixer, { property: property.id })).alertsNote).toBeUndefined();
    expect(noRoutineNote("cleaning")).toContain("save_alert_routine");
    expect(noRoutineNote("supplies")).toContain("check_alerts");
  });

  it("with one bot, get_state is what it is with the switch off", SLOW, async () => {
    const { m, tenant, property, main } = await account({ bots: false, flows: ALL_FLOWS });
    await activeFixer(m, main, property, false);
    const second = m.registry.addProperty(tenant.id, "9 Made-up Road");
    const before = { all: await stateAt(m, P, main), one: await stateAt(m, P, main, { property: property.id }), empty: await stateAt(m, P, main, { property: second.id }) };
    expect(before.all.team).toBeUndefined();
    expect(before.all.newBots).toBeUndefined();
    switchOn(m.registry, tenant.id, "bots");
    const without = async (args?: Record<string, unknown>) => {
      const { newBots, ...rest } = await stateAt(m, P, main, args);
      expect(newBots).toEqual(ALL_FLOWS.map((job) => expect.objectContaining({ job })));
      return rest;
    };
    expect(await without()).toEqual(before.all);
    expect(await without({ property: property.id })).toEqual(before.one);
    expect(await without({ property: second.id })).toEqual(before.empty);
  });
});
