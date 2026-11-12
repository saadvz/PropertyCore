import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CARD_REFUSAL, fixerDeskFor, resetFixerDesks, type FixerDesk, type FixerDeps, type FixerReply } from "../src/fixer-core/desk";
import { FIXER_TOOL_NAMES, FIXER_TOOLS, handleFixerTool, listedFixerTools } from "../src/fixer-core/tools";
import { readFixer } from "../src/fixer-core/store";
import { setCalendarFetch } from "../src/hub/calendarFetch";
import { hubFor, resetHubs } from "../src/hub/hub";
import { peopleFor, resetPeople } from "../src/hub/people";
import { supplySetupAsk } from "../src/supply-core/setupAsk";
import { emptySupply, type SupplyFile } from "../src/supply-core/store";

/**
 * Fixer Core's MCP tools: strict inputs, card refusal before the desk, one desk method per tool, and
 * no reply that ever holds the door code. Made-up pros, 555 numbers, and a made-up code.
 */

const CARD = "4242 4242 4242 4242";
const CODE = ["5", "8", "1", "9"].join("");
const NOW = new Date("2026-11-08T15:00:00.000Z");
const JOE = "+15555550142";
const HOST = "+15555550100";
const PROPERTY_ID = "prop_scratch";
const TUE = { from: "2026-11-10T15:00:00.000Z", until: "2026-11-10T17:00:00.000Z" };
const EVENTS = { items: [{ id: "e1", summary: `Booking 4111111111111111`, start: { date: "2026-11-20" }, end: { date: "2026-11-22" } }] };

const dirs: string[] = [];
afterEach(() => {
  setCalendarFetch(undefined);
  resetFixerDesks();
  resetHubs();
  resetPeople();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every tool with a small valid input, and the desk method it must reach with that same input. */
const SAMPLES: Record<string, { method: keyof FixerDesk; args: Record<string, unknown>; passes?: "none" | unknown[] }> = {
  get_fixer_state: { method: "state", args: {}, passes: "none" },
  save_fixer_property: { method: "saveProperty", args: { address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" } },
  save_fixer_sources: { method: "saveSources", args: { done: true } },
  save_fixer_settings: { method: "saveSettings", args: { askCleaner: true } },
  save_pro: { method: "savePro", args: { name: "Joe's Plumbing", trades: ["plumbing"], reach: { phone: JOE }, preferredFor: [{ trade: "plumbing", rank: 1 }] } },
  remove_pro: { method: "removePro", args: { id: "pro_abcdefghij" } },
  save_upkeep: { method: "saveUpkeep", args: { trade: "gutters", what: "Clean the gutters", schedule: { kind: "every", days: 180 } } },
  remove_upkeep: { method: "removeUpkeep", args: { id: "upk_abcdefgh" } },
  activate_fixer: { method: "activate", args: {}, passes: "none" },
  check_fixes: { method: "checkFixes", args: { googleEvents: EVENTS } },
  open_job: { method: "openJob", args: { trade: "plumbing", what: "Sink leaks", urgency: "soon", source: "host" } },
  approve_job: { method: "approveJob", args: { jobId: "job_abcdefghij", confirmation: "ABC123" } },
  add_candidates: { method: "addCandidates", args: { jobId: "job_abcdefghij", candidates: [{ name: "Pat Pipes", reach: { email: "pat@example.com" } }] } },
  pick_pros: { method: "pickPros", args: { jobId: "job_abcdefghij", ids: ["cand_abcdefgh"] } },
  contact_pro: { method: "contactPro", args: { jobId: "job_abcdefghij", to: "pro_abcdefghij", how: "call" } },
  record_contact: { method: "recordContact", args: { contactToken: "abcdef", outcome: "booked", ...TUE, estimateCents: 18000 } },
  approve_booking: { method: "approveBooking", args: { jobId: "job_abcdefghij", access: "code", proId: "pro_abcdefghij", googleEvents: EVENTS } },
  visit_link: { method: "visitLink", args: { jobId: "job_abcdefghij" } },
  revoke_visit: { method: "revokeVisit", args: { jobId: "job_abcdefghij" } },
  extend_visit: { method: "extendVisit", args: { jobId: "job_abcdefghij", until: "2026-11-10T18:00:00.000Z" } },
  guests_left: { method: "guestsLeft", args: { confirmed: true } },
  record_done: { method: "recordDone", args: { jobId: "job_abcdefghij", by: "agent", cents: 18000 } },
  record_cost: { method: "recordCost", args: { jobId: "job_abcdefghij", cents: 18000, by: "pro" } },
  cancel_job: { method: "cancelJob", args: { jobId: "job_abcdefghij", reason: "Fixed it myself" } },
  reschedule_job: { method: "rescheduleJob", args: { jobId: "job_abcdefghij" } },
  skip_question: { method: "skipQuestion", args: { jobId: "job_abcdefghij", question: "preferred" } },
  change_door_code: { method: "changeDoorCode", args: { jobId: "job_abcdefghij" } },
  raise_price: { method: "raisePrice", args: { jobId: "job_abcdefghij", cents: 42000 }, passes: ["job_abcdefghij", 42000, "agent"] },
};

/** A desk that records each call and answers ok. */
function spyDesk() {
  const calls: { method: string; args: unknown[] }[] = [];
  const desk = new Proxy({} as FixerDesk, {
    get: (_target, method: string) => async (...args: unknown[]) => {
      calls.push({ method, args });
      return { text: "ok", isError: false } satisfies FixerReply;
    },
  });
  return { desk, calls };
}

describe("Fixer Core's tool table", () => {
  it("has the spec's tools and the extras, and leaves the front's and the page's out", () => {
    const spec = ["get_fixer_state", "save_fixer_settings", "save_pro", "remove_pro", "save_upkeep", "remove_upkeep", "activate_fixer", "check_fixes", "open_job", "approve_job", "add_candidates", "pick_pros", "contact_pro", "record_contact", "approve_booking", "visit_link", "revoke_visit", "extend_visit", "record_done", "record_cost", "cancel_job"];
    const extras = ["guests_left", "skip_question", "change_door_code", "reschedule_job", "save_fixer_property", "save_fixer_sources", "raise_price"];
    expect([...FIXER_TOOL_NAMES].sort()).toEqual([...spec, ...extras].sort());
    expect(Object.keys(SAMPLES).sort()).toEqual([...FIXER_TOOL_NAMES].sort());
    // Answered by the front (Cleaner Core's photos, Supply Core's preview), and the page's reveal is never a tool.
    for (const name of ["get_job_photos", "preview_schedule", "reveal_code"]) expect(FIXER_TOOL_NAMES.has(name)).toBe(false);
    for (const tool of FIXER_TOOLS) for (const field of Object.keys(tool.input.shape)) expect(field, tool.name).not.toMatch(/^(code|doorCode|card\w*|payment\w*)$/i);
  });

  it("every input is strict: an unknown field is refused, and the listed schema says so", async () => {
    const listed = listedFixerTools([...FIXER_TOOL_NAMES]);
    expect(listed).toHaveLength(FIXER_TOOLS.length);
    for (const tool of listed) expect((tool.inputSchema as { additionalProperties?: unknown }).additionalProperties, String(tool.name)).toBe(false);
    for (const tool of FIXER_TOOLS) {
      const { desk, calls } = spyDesk();
      const reply = await handleFixerTool(desk, tool.name, { ...SAMPLES[tool.name]!.args, surprise: 1 });
      expect(reply?.isError, tool.name).toBe(true);
      expect(calls, tool.name).toEqual([]);
    }
  });

  it("refuses card-like text in any field before the desk", async () => {
    for (const tool of FIXER_TOOLS) {
      const { desk, calls } = spyDesk();
      const reply = await handleFixerTool(desk, tool.name, { ...SAMPLES[tool.name]!.args, note: CARD });
      expect(reply, tool.name).toEqual({ text: CARD_REFUSAL, isError: true });
      expect(calls, tool.name).toEqual([]);
    }
  });

  it("lets Google events with long booking numbers through on check_fixes and approve_booking only", async () => {
    for (const name of ["check_fixes", "approve_booking"]) {
      const { desk, calls } = spyDesk();
      expect((await handleFixerTool(desk, name, SAMPLES[name]!.args))?.isError, name).toBe(false);
      expect(calls).toHaveLength(1);
    }
    const { desk, calls } = spyDesk();
    expect(await handleFixerTool(desk, "record_contact", { contactToken: "abcdef", outcome: "waiting", note: "Booking 4111111111111111" })).toEqual({ text: CARD_REFUSAL, isError: true });
    expect(calls).toEqual([]);
  });

  it("sends each tool to its one desk method with the same input", async () => {
    for (const [name, sample] of Object.entries(SAMPLES)) {
      const { desk, calls } = spyDesk();
      expect((await handleFixerTool(desk, name, sample.args))?.isError, name).toBe(false);
      expect(calls.map((call) => call.method), name).toEqual([sample.method]);
      expect(calls[0]!.args, name).toEqual(sample.passes === "none" ? [] : (sample.passes ?? [sample.args]));
    }
    expect(await handleFixerTool(spyDesk().desk, "check_now", {})).toBeUndefined();
  });
});

describe("no tool reply holds the door code", () => {
  it("across setup, a booking, the visit and its end", async () => {
    const root = mkdtempSync(join(tmpdir(), "fixer-tools-"));
    const account = mkdtempSync(join(tmpdir(), "fixer-tools-acct-"));
    dirs.push(root, account);
    let clock = new Date(NOW);
    const key = randomBytes(32).toString("base64");
    const env = (): NodeJS.ProcessEnv => ({ CLEANER_CORE_PIN_KEY: key });
    const now = () => clock;
    hubFor(root, { now }).doorAccess(env).save(CODE, "the lockbox by the side gate", undefined);
    setCalendarFetch(async (url) => ({ status: 200, url, async text() { return "BEGIN:VCALENDAR\r\nEND:VCALENDAR"; } }));
    const people = () => peopleFor(account, { now });
    people().savePropertyPeople(PROPERTY_ID, HOST, []);
    const texts: string[] = [];
    const deps: FixerDeps = { now, env, propertyId: PROPERTY_ID, people, publicBase: () => "https://fixer.example.com/t/acct/p/prop", photoKey: () => randomBytes(32), textsAllowed: async () => true, send: async (_to, body) => (texts.push(body), true) };
    const desk = fixerDeskFor(root, deps);
    const replies: FixerReply[] = [];
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const reply = (await handleFixerTool(desk, name, args))!;
      replies.push(reply);
      return reply;
    };
    const yes = async (name: string, args: Record<string, unknown>) => {
      const ask = await call(name, args);
      const code = (ask.structured?.confirmation as { code: string } | undefined)?.code;
      return code ? call(name, { ...args, confirmation: code }) : ask;
    };
    await call("save_fixer_property", { address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" });
    await call("save_fixer_sources", { uploadLink: { name: "Airbnb" } });
    await call("save_fixer_sources", { done: true });
    const joe = await call("save_pro", { name: "Joe's Plumbing", trades: ["plumbing"], reach: { phone: JOE }, prefersText: true, preferredFor: [{ trade: "plumbing", rank: 1 }] });
    people().optIn(JOE, PROPERTY_ID);
    await call("save_fixer_settings", { prosDone: true });
    await call("save_fixer_settings", { upkeepDone: true });
    await call("get_fixer_state");
    expect((await call("activate_fixer")).isError).toBe(false);
    const job = (await call("open_job", { trade: "plumbing", what: "Sink leaks", urgency: "soon", source: "host" })).structured!.jobId as string;
    await call("check_fixes");
    const proId = joe.structured!.proId as string;
    const token = (await call("contact_pro", { jobId: job, to: proId, how: "call" })).structured!.contactToken as string;
    await call("record_contact", { contactToken: token, outcome: "booked", ...TUE, estimateCents: 18000 });
    expect((await yes("approve_booking", { jobId: job, access: "code" })).isError).toBe(false);
    await call("visit_link", { jobId: job });
    clock = new Date(Date.parse(TUE.from) - 10 * 60_000);
    await desk.tick();
    clock = new Date(TUE.from);
    await desk.tick();
    expect(readFixer(root).jobs[0]!.state).toBe("in-progress");
    await call("guests_left", { confirmed: true });
    await call("check_fixes");
    await call("get_fixer_state");
    await call("record_done", { jobId: job, by: "agent", cents: 21000 });
    await call("record_cost", { jobId: job, cents: 21000, by: "pro" });
    await call("change_door_code", { jobId: job });
    await call("check_fixes");
    expect(replies.length).toBeGreaterThan(20);
    // The code went out once, by text to Joe's own phone, and never in a reply.
    expect(texts.filter((body) => body.includes(CODE))).toHaveLength(1);
    for (const reply of replies) {
      expect(reply.text).not.toContain(CODE);
      expect(JSON.stringify(reply.structured ?? {})).not.toContain(CODE);
      expect(reply.text).not.toContain("lockbox");
    }
  });
});

describe("the hub's setup through Fixer Core", () => {
  /** A desk on a fresh folder, with its record ready for Activate but for the property and calendars. */
  async function fresh() {
    const root = mkdtempSync(join(tmpdir(), "fixer-hub-"));
    dirs.push(root);
    const now = () => NOW;
    const desk = fixerDeskFor(root, { now, publicBase: () => "https://fixer.example.com/t/acct/p/prop" });
    for (const step of [{ prosDone: true }, { upkeepDone: true }] as const) expect((await desk.saveSettings(step)).isError).toBe(false);
    return { root, desk, hub: () => hubFor(root, { now }) };
  }

  it("keeps the host's 'no booking calendar' in fixer.json, so Supply Core still asks for its calendars", async () => {
    const { root, desk, hub } = await fresh();
    await handleFixerTool(desk, "save_fixer_property", { address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" });
    const none = await handleFixerTool(desk, "save_fixer_sources", { done: true });
    expect(none?.structured).toMatchObject({ calendars: [], noCalendar: true });
    expect(readFixer(root).setup.noCalendar).toBe(true);
    expect(hub().calendarsDone()).toBe(false);
    // Supply Core, with its list done and an item that goes by bookings, still asks where the bookings come from.
    const supply = { ...emptySupply(), settings: { ...emptySupply().settings, ordering: "schedule" }, setup: { itemsDone: true }, items: [{ schedule: { kind: "bookings", stays: 2 } }] } as unknown as SupplyFile;
    expect(supplySetupAsk(supply, hub())?.step).toBe("sources");
    expect((await handleFixerTool(desk, "activate_fixer", {}))?.isError).toBe(false);
  });

  it("refuses Activate with neither a calendar nor the host's 'none'", async () => {
    const { desk } = await fresh();
    await handleFixerTool(desk, "save_fixer_property", { address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" });
    expect((await handleFixerTool(desk, "activate_fixer", {}))?.text).toBe("Save a booking calendar first, or say there is none.");
    // Google Calendar is the hub's, shared as Supply Core saves it.
    expect((await handleFixerTool(desk, "save_fixer_sources", { google: true }))?.structured).toEqual({ calendars: ["Google Calendar"] });
    expect((await handleFixerTool(desk, "activate_fixer", {}))?.isError).toBe(false);
  });

  it("checks the address and time zone as Supply Core does, and takes the host's yes to change them after Activate", async () => {
    const { desk, hub } = await fresh();
    expect((await handleFixerTool(desk, "save_fixer_property", { address: " ", timeZone: "America/New_York" }))?.text).toBe("The property needs its delivery address.");
    expect((await handleFixerTool(desk, "save_fixer_property", { address: "12 Scratch Lane", timeZone: "Mars/Olympus" }))?.text).toBe("That time zone isn't one I know. Use a name like America/New_York.");
    await handleFixerTool(desk, "save_fixer_property", { address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" });
    await handleFixerTool(desk, "save_fixer_sources", { done: true });
    await handleFixerTool(desk, "activate_fixer", {});
    const move = { address: "8 Scratch Court, Teaneck, NJ 07666", timeZone: "America/New_York" };
    const ask = (await handleFixerTool(desk, "save_fixer_property", move))!;
    expect(ask.structured?.question).toBe("Save 8 Scratch Court, Teaneck, NJ 07666 as the property's address for repairs?");
    expect(hub().property().address).toBe("12 Scratch Lane, Teaneck, NJ 07666");
    const code = (ask.structured!.confirmation as { code: string }).code;
    expect((await handleFixerTool(desk, "save_fixer_property", { ...move, address: "9 Scratch Court, Teaneck, NJ 07666", confirmation: code }))?.isError).toBe(true);
    const fresh2 = (await handleFixerTool(desk, "save_fixer_property", move))!;
    expect((await handleFixerTool(desk, "save_fixer_property", { ...move, confirmation: (fresh2.structured!.confirmation as { code: string }).code }))?.isError).toBe(false);
    expect(hub().property().address).toBe(move.address);
  });
});
