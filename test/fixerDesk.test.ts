import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixerDeskFor, resetFixerDesks, type FixerDeps } from "../src/fixer-core/desk";
import { fixerSetupAsk } from "../src/fixer-core/setupAsk";
import { FIXER_FILE, emptyFixer, readFixer, writeFixer } from "../src/fixer-core/store";
import { cleanerAskQuestion } from "../src/fixer-core/texts";
import { hubFor, resetHubs } from "../src/hub/hub";

/** Fixer Core's desk: setup, cost line, upkeep, activate, state. Made-up pros, 555 numbers, example.com links. */

const NOW = new Date("2026-11-08T15:00:00.000Z");
const PROPERTY = { nickname: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" };

const dirs: string[] = [];
afterEach(() => {
  resetFixerDesks();
  resetHubs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "fixer-desk-"));
  dirs.push(dir);
  return dir;
}

/** A desk on a property whose hub has an address, time zone and a calendar already. */
function made(extra: Partial<FixerDeps> = {}, ready = true) {
  const root = folder();
  if (ready) {
    const hub = hubFor(root, { now: () => NOW });
    hub.saveProperty(PROPERTY);
    hub.setCalendars({ calendars: [{ name: "Airbnb", url: "https://calendar.example/lane.ics" }], done: true });
  }
  return { root, desk: fixerDeskFor(root, { now: () => NOW, ...extra }) };
}

/** The approval code a first call returned. */
const codeOf = (reply: { structured?: Record<string, unknown> }): string => (reply.structured!.confirmation as { code: string }).code;

type Desk = ReturnType<typeof made>["desk"];

const joe = { name: "Joe's Plumbing", trades: ["plumbing" as const], reach: { phone: "+15555550142" } };
const ana = { name: "Ana Electric", trades: ["electrical" as const], reach: { email: "ana@example.com" } };

async function step(desk: Desk): Promise<string | undefined> {
  const state = await desk.state();
  return (state.structured?.ask as { step?: string } | undefined)?.step;
}

/** Setup taken to the review step. */
async function toReview(desk: Desk) {
  await desk.savePro(joe);
  await desk.saveSettings({ prosDone: true });
  await desk.saveSettings({ costLineCents: null });
  await desk.saveSettings({ upkeepDone: true });
}

async function activated(extra: Partial<FixerDeps> = {}) {
  const m = made(extra);
  await toReview(m.desk);
  expect((await m.desk.activate()).isError).toBe(false);
  return m;
}

describe("setup asks", () => {
  it("asks pros, cost line, upkeep, review in order with cleaning off", async () => {
    const { desk } = made();
    expect(await step(desk)).toBe("pros");
    await desk.savePro(joe);
    expect(await step(desk)).toBe("pros");
    await desk.saveSettings({ prosDone: true });
    expect(await step(desk)).toBe("cost-line");
    await desk.saveSettings({ costLineCents: 50_000 });
    expect(await step(desk)).toBe("upkeep");
    await desk.saveSettings({ upkeepDone: true });
    expect(await step(desk)).toBe("review");
  });

  it("asks the cleaner only with cleaning on, and saves the answer", async () => {
    const { root, desk } = made({ cleaningOn: () => true });
    await desk.saveSettings({ prosDone: true });
    await desk.saveSettings({ costLineCents: null });
    expect(await step(desk)).toBe("ask-cleaner");
    const reply = await desk.saveSettings({ askCleaner: true });
    expect(reply.isError).toBe(false);
    expect(readFixer(root).settings.askCleaner).toBe(true);
    expect(await step(desk)).toBe("upkeep");
  });

  it("uses the approved cleaner wording, with Supply Core on or off", () => {
    const hub = { property: () => ({}), calendars: () => [], google: () => false, calendarsDone: () => false } as never;
    const file = emptyFixer();
    file.setup = { prosDone: true, costAsked: true };
    const off = fixerSetupAsk(file, hub, true, false)!;
    const on = fixerSetupAsk(file, hub, true, true)!;
    expect(off.questions[0]!.ask).toBe('Should your cleaner be asked "Anything broken?" after every cleaning? What they report opens a repair for you to approve.');
    expect(on.questions[0]!.ask).toBe(
      'After each cleaning, your cleaner is already asked "Anything running low?". Should that become "Anything running low or broken?", so they can report repairs too?',
    );
    expect(cleanerAskQuestion(true)).toBe(on.questions[0]!.ask);
  });

  it("passes the desk's own Supply Core state to the wording", async () => {
    const { root, desk } = made({ cleaningOn: () => true });
    writeFileSync(join(root, "supply.json"), JSON.stringify({ settings: { activatedAt: "2026-11-01T00:00:00Z" }, items: [] }));
    await desk.saveSettings({ prosDone: true });
    await desk.saveSettings({ costLineCents: null });
    const ask = (await desk.state()).structured!.ask as { questions: { ask: string }[] };
    expect(ask.questions[0]!.ask).toContain("Anything running low or broken?");
  });

  it("carries drafted pros by trade with the gaps marked, and counts none as saved", async () => {
    const { desk } = made();
    await desk.savePro({ name: "Joe's Plumbing", trades: ["plumbing"], draft: true });
    await desk.savePro({ name: "Ana Electric", trades: ["electrical"], reach: { email: "ana@example.com" }, draft: true });
    const state = await desk.state();
    const ask = state.structured!.ask as { step: string; drafts: { trade: string; pros: { name: string; needsYou: string[] }[] }[] };
    expect(ask.step).toBe("pros");
    expect(ask.drafts.map((d) => d.trade)).toEqual(["plumbing", "electrical"]);
    expect(ask.drafts[0]!.pros[0]).toMatchObject({ name: "Joe's Plumbing", needsYou: ["a way to reach them"] });
    expect(ask.drafts[1]!.pros[0]!.needsYou).toEqual([]);
    expect(state.structured!.pros).toEqual([]);
    expect(desk.summaryLine()).toBe("Repairs: setup not finished.");
    expect((await desk.saveSettings({ prosDone: true })).isError).toBe(true);
  });

  it("turns drafts saved on confirm, and refuses one with a gap", async () => {
    const { root, desk } = made();
    const a = (await desk.savePro({ name: "Joe's Plumbing", trades: ["plumbing"], draft: true })).structured!.proId as string;
    const b = (await desk.savePro({ ...ana, draft: true })).structured!.proId as string;
    expect((await desk.savePro({ confirm: [a, b] })).isError).toBe(true);
    expect(readFixer(root).pros.every((p) => p.status === "draft")).toBe(true);
    await desk.savePro({ id: a, ...joe, draft: true });
    expect((await desk.savePro({ confirm: [a, b] })).isError).toBe(false);
    const pros = readFixer(root).pros;
    expect(pros.map((p) => [p.status, p.source])).toEqual([["saved", "drafted"], ["saved", "drafted"]]);
    expect((await desk.savePro({ confirm: ["pro_nothere00"] })).isError).toBe(true);
  });

  it("ranks pros per trade and keeps the order after a pro takes an earlier rank", async () => {
    const { desk } = made();
    const rank = async (name: string, phone: string, r: number) =>
      (await desk.savePro({ name, trades: ["plumbing"], reach: { phone }, preferredFor: [{ trade: "plumbing", rank: r }] })).structured!.proId as string;
    await rank("First Plumbing", "+15555550101", 1);
    await rank("Second Plumbing", "+15555550102", 2);
    await rank("Newcomer Plumbing", "+15555550103", 1);
    await desk.saveSettings({ prosDone: true });
    await desk.saveSettings({ costLineCents: null });
    await desk.saveSettings({ upkeepDone: true });
    await desk.activate();
    const summary = (await desk.state()).structured!.summary as { pros: { plumbing: { name: string; rank: number }[] } };
    expect(summary.pros.plumbing.map((p) => [p.name, p.rank])).toEqual([["Newcomer Plumbing", 1], ["First Plumbing", 2], ["Second Plumbing", 3]]);
  });

  it("refuses bad pros", async () => {
    const { desk } = made();
    expect((await desk.savePro({ ...joe, name: "" })).isError).toBe(true);
    expect((await desk.savePro({ ...joe, trades: [] })).isError).toBe(true);
    expect((await desk.savePro({ ...joe, trades: ["roofing" as never] })).isError).toBe(true);
    expect((await desk.savePro({ ...joe, reach: { phone: "201-555-0142" } })).isError).toBe(true);
    expect((await desk.savePro({ ...joe, reach: { website: "http://example.com" } })).isError).toBe(true);
    expect((await desk.savePro({ name: "No reach", trades: ["hvac"] })).isError).toBe(true);
    expect((await desk.savePro({ ...joe, preferredFor: [{ trade: "hvac", rank: 1 }] })).isError).toBe(true);
    expect((await desk.savePro({ ...joe, id: "pro_missing000" })).isError).toBe(true);
    await desk.savePro(joe);
    expect((await desk.savePro({ ...ana, reach: { phone: "+15555550142" } })).isError).toBe(true);
  });
});

describe("cost line and settings", () => {
  it("keeps the bounds", async () => {
    const { root, desk } = made();
    for (const bad of [{ costLineCents: 99 }, { costLineCents: 500_001 }, { checkInBufferMinutes: 241 }, { cleaningMinutes: 29 }, { cleaningMinutes: 481 }, { checkInBufferMinutes: -1 }]) {
      expect((await desk.saveSettings(bad)).isError).toBe(true);
    }
    expect((await desk.saveSettings({ costLineCents: 100, checkInBufferMinutes: 0, cleaningMinutes: 480 })).isError).toBe(false);
    expect(readFixer(root).settings).toMatchObject({ costLineCents: 100, checkInBufferMinutes: 0, cleaningMinutes: 480 });
    await desk.saveSettings({ costLineCents: null });
    expect(readFixer(root).settings.costLineCents).toBeUndefined();
  });
});

describe("upkeep", () => {
  it("reads back the next dates and keeps lead days", async () => {
    const { root, desk } = made();
    const reply = await desk.saveUpkeep({ trade: "hvac", what: "Change the HVAC filters", schedule: { kind: "every", days: 90 } });
    expect(reply.isError).toBe(false);
    expect(reply.structured!.nextDates).toEqual(["2027-02-06", "2027-05-07", "2027-08-05"]);
    expect(readFixer(root).upkeep[0]).toMatchObject({ trade: "hvac", leadDays: 14 });
  });

  it("refuses a by-bookings schedule, in save and in preview", async () => {
    const { desk } = made();
    expect((await desk.saveUpkeep({ trade: "hvac", what: "Filters", schedule: { kind: "bookings", stays: 3 } })).isError).toBe(true);
    expect((await desk.previewSchedule({ schedule: { kind: "bookings", stays: 3 } })).isError).toBe(true);
    const preview = await desk.previewSchedule({ schedule: { kind: "every", monthlyOn: 1 } });
    expect(preview.structured!.nextDates).toEqual(["2026-12-01", "2027-01-01", "2027-02-01"]);
  });

  it("refuses bounds, a long description and an unknown pro", async () => {
    const { desk } = made();
    const base = { trade: "gutters" as const, what: "Clean the gutters", schedule: { kind: "every" as const, days: 180 } };
    expect((await desk.saveUpkeep({ ...base, leadDays: 61 })).isError).toBe(true);
    expect((await desk.saveUpkeep({ ...base, what: "x".repeat(120) })).isError).toBe(true);
    expect((await desk.saveUpkeep({ ...base, what: "x".repeat(119) })).isError).toBe(false);
    expect((await desk.saveUpkeep({ ...base, proId: "pro_nothere00" })).isError).toBe(true);
    expect((await desk.saveUpkeep({ ...base, schedule: { kind: "custom", rrule: "NOT A RULE", said: "x" } })).isError).toBe(true);
  });

  it("accepts a custom rule and removes an item", async () => {
    const { root, desk } = made();
    const saved = await desk.saveUpkeep({ trade: "gutters", what: "Gutters", schedule: { kind: "custom", rrule: "FREQ=YEARLY;BYMONTH=4,10;BYMONTHDAY=1", said: "spring and fall" } });
    expect(saved.isError).toBe(false);
    expect(saved.structured!.nextDates).toEqual(["2027-04-01", "2027-10-01", "2028-04-01"]);
    const id = saved.structured!.upkeepId as string;
    expect((await desk.removeUpkeep({ id })).isError).toBe(false);
    expect(readFixer(root).upkeep).toEqual([]);
    expect((await desk.removeUpkeep({ id })).isError).toBe(true);
  });
});

describe("activate", () => {
  it("is refused without an address and time zone", async () => {
    const { desk } = made({}, false);
    const reply = await desk.activate();
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("address and time zone");
  });

  it("is refused without a booking calendar, then allowed once the host says there is none", async () => {
    const { root, desk } = made({}, false);
    const hub = hubFor(root, { now: () => NOW });
    hub.saveProperty(PROPERTY);
    expect((await desk.activate()).text).toContain("booking calendar");
    hub.setCalendars({ done: true });
    expect((await desk.activate()).isError).toBe(false);
  });

  it("counts Google Calendar as a booking calendar", async () => {
    const { root, desk } = made({}, false);
    const hub = hubFor(root, { now: () => NOW });
    hub.saveProperty(PROPERTY);
    hub.setCalendars({ google: true });
    expect((await desk.activate()).isError).toBe(false);
  });

  it("turns on, says so, and a second activate changes nothing", async () => {
    const { root, desk } = await activated();
    const at = readFixer(root).settings.activatedAt;
    expect(at).toBe(NOW.toISOString());
    expect(desk.summaryLine()).toBe("Repairs: on, 1 pro, 0 jobs open.");
    expect((await desk.activate()).structured).toMatchObject({ active: true });
    expect(readFixer(root).settings.activatedAt).toBe(at);
  });

  it("shows the blockers on the review step", async () => {
    const { desk } = made({}, false);
    await desk.saveSettings({ prosDone: true });
    await desk.saveSettings({ costLineCents: null });
    await desk.saveSettings({ upkeepDone: true });
    const ask = (await desk.state()).structured!.ask as { step: string; blockers: string[] };
    expect(ask.step).toBe("review");
    expect(ask.blockers).toHaveLength(2);
  });
});

describe("state after activation", () => {
  it("gives the summary: pros by trade, upkeep, open jobs and the cost log by trade", async () => {
    const { root, desk } = await activated();
    const file = readFixer(root);
    file.upkeep = [{ id: "upk_aaaaaaaa", trade: "gutters", what: "Gutters", schedule: { kind: "every", days: 180 }, leadDays: 14, savedAt: NOW.toISOString() }];
    const job = (id: string, trade: "plumbing" | "gutters", state: "booked" | "done", cents?: number, at?: string) => ({
      id, trade, what: "x", source: "host" as const, photos: [], urgency: "soon" as const, state, candidates: [], picked: [], contacts: [], news: [], createdAt: NOW.toISOString(),
      ...(cents !== undefined ? { cost: { cents, by: "host" as const, at: at! } } : {}),
    });
    file.jobs = [
      job("job_open000001", "plumbing", "booked"),
      job("job_done000001", "plumbing", "done", 18_000, "2026-11-03T15:00:00Z"),
      job("job_done000002", "gutters", "done", 25_000, "2026-03-03T15:00:00Z"),
    ];
    writeFixer(root, file);
    const state = await desk.state();
    expect(state.structured!.line).toBe("Repairs: on, 1 pro, 1 job open.");
    const summary = state.structured!.summary as Record<string, any>;
    expect(summary.pros.plumbing).toHaveLength(1);
    expect(summary.upkeep).toHaveLength(1);
    expect(summary.openJobs.map((j: { jobId: string }) => j.jobId)).toEqual(["job_open000001"]);
    expect(summary.costLog.month).toEqual({ totalCents: 18_000, byTrade: { plumbing: 18_000 } });
    expect(summary.costLog.year).toEqual({ totalCents: 43_000, byTrade: { plumbing: 18_000, gutters: 25_000 } });
  });

  it("turns off and on, and off with cancel closes the open jobs", async () => {
    const { root, desk } = await activated();
    const file = readFixer(root);
    file.jobs = [{ id: "job_open000001", trade: "plumbing", what: "x", source: "host", photos: [], urgency: "soon", state: "contacted", candidates: [], picked: [], contacts: [], news: [], createdAt: NOW.toISOString() }];
    writeFixer(root, file);
    await desk.turnOff(false);
    expect(desk.summaryLine()).toBe("Repairs: off.");
    expect(readFixer(root).jobs[0]!.state).toBe("contacted");
    await desk.turnOn();
    expect(desk.summaryLine()).toContain("on");
    await desk.turnOff(true);
    expect(readFixer(root).jobs[0]).toMatchObject({ state: "cancelled", cancelledAt: NOW.toISOString() });
  });
});

describe("two-call approvals after Activate", () => {
  it("asks first, refuses a wrong code, saves on the right one", async () => {
    const { root, desk } = await activated();
    const asked = await desk.savePro(ana);
    expect(asked.isError).toBe(false);
    expect(asked.structured!.question).toBe("Add Ana Electric to your pros for electrical?");
    expect(readFixer(root).pros).toHaveLength(1);
    const code = codeOf(asked);
    expect((await desk.savePro({ ...ana, confirmation: "wrong" })).isError).toBe(true);
    // A code is bound to the exact change, and a mismatch spends it.
    expect((await desk.savePro({ ...ana, name: "Other", confirmation: code })).isError).toBe(true);
    expect((await desk.savePro({ ...ana, confirmation: code })).isError).toBe(true);
    expect(readFixer(root).pros).toHaveLength(1);
    const saved = await desk.savePro({ ...ana, confirmation: codeOf(await desk.savePro(ana)) });
    expect(saved.isError).toBe(false);
    expect(readFixer(root).pros.map((p) => p.name)).toEqual(["Joe's Plumbing", "Ana Electric"]);
  });

  it("asks before settings, upkeep and removals", async () => {
    const { root, desk } = await activated();
    const settings = await desk.saveSettings({ costLineCents: 20_000 });
    expect(settings.structured!.question).toBeTruthy();
    expect(readFixer(root).settings.costLineCents).toBeUndefined();
    expect((await desk.saveSettings({ costLineCents: 20_000, confirmation: codeOf(settings) })).isError).toBe(false);
    expect(readFixer(root).settings.costLineCents).toBe(20_000);

    const upkeep = { trade: "gutters" as const, what: "Gutters", schedule: { kind: "every" as const, days: 180 } };
    const askedUpkeep = await desk.saveUpkeep(upkeep);
    expect(readFixer(root).upkeep).toEqual([]);
    const savedUpkeep = await desk.saveUpkeep({ ...upkeep, confirmation: codeOf(askedUpkeep) });
    const upkeepId = savedUpkeep.structured!.upkeepId as string;
    const askedRemoveUpkeep = await desk.removeUpkeep({ id: upkeepId });
    expect(readFixer(root).upkeep).toHaveLength(1);
    expect((await desk.removeUpkeep({ id: upkeepId, confirmation: codeOf(askedRemoveUpkeep) })).isError).toBe(false);

    const proId = readFixer(root).pros[0]!.id;
    const askedRemove = await desk.removePro({ id: proId });
    expect(askedRemove.structured!.question).toBe("Remove Joe's Plumbing from your pros?");
    expect(readFixer(root).pros).toHaveLength(1);
    expect((await desk.removePro({ id: proId, confirmation: "wrong" })).isError).toBe(true);
    expect((await desk.removePro({ id: proId, confirmation: codeOf(askedRemove) })).isError).toBe(false);
    expect(readFixer(root).pros).toEqual([]);
  });

  it("keeps a pro's id and addedAt on an edit by id, and asks first", async () => {
    const { root, desk } = await activated();
    const before = readFixer(root).pros[0]!;
    const edit = { id: before.id, ...joe, reach: { phone: "+15555550199" } };
    const asked = await desk.savePro(edit);
    const done = await desk.savePro({ ...edit, confirmation: codeOf(asked) });
    expect(done.structured!.proId).toBe(before.id);
    const after = readFixer(root).pros;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before.id, addedAt: before.addedAt, reach: { phone: "+15555550199" } });
  });

  it("asks before confirming drafts, and a draft itself needs no code", async () => {
    const { root, desk } = await activated();
    const draft = await desk.savePro({ ...ana, draft: true });
    expect(draft.structured).toMatchObject({ saved: true, status: "draft" });
    const id = draft.structured!.proId as string;
    const asked = await desk.savePro({ confirm: [id] });
    expect(asked.structured!.question).toBe("Save Ana Electric to your pros?");
    expect(readFixer(root).pros.find((p) => p.id === id)!.status).toBe("draft");
    expect((await desk.savePro({ confirm: [id], confirmation: codeOf(asked) })).isError).toBe(false);
    expect(readFixer(root).pros.find((p) => p.id === id)!.status).toBe("saved");
  });

  it("refuses the code once a draft is edited after the question", async () => {
    const { root, desk } = await activated();
    const id = (await desk.savePro({ ...ana, draft: true })).structured!.proId as string;
    const asked = await desk.savePro({ confirm: [id] });
    await desk.savePro({ ...ana, id, reach: { phone: "+15555550199" }, draft: true });
    expect((await desk.savePro({ confirm: [id], confirmation: codeOf(asked) })).isError).toBe(true);
    expect(readFixer(root).pros.find((p) => p.id === id)!.status).toBe("draft");
    const again = await desk.savePro({ confirm: [id] });
    expect((await desk.savePro({ confirm: [id], confirmation: codeOf(again) })).isError).toBe(false);
  });

  it("lets a done job's pro be saved by job id", async () => {
    const { root, desk } = await activated();
    expect((await desk.savePro({ ...ana, jobId: "job_nothere00" })).isError).toBe(true);
    const file = readFixer(root);
    file.jobs = [{ id: "job_done000001", trade: "electrical", what: "x", source: "host", photos: [], urgency: "soon", state: "done", candidates: [], picked: [], contacts: [], news: [], createdAt: NOW.toISOString() }];
    writeFixer(root, file);
    const asked = await desk.savePro({ ...ana, jobId: "job_done000001" });
    await desk.savePro({ ...ana, jobId: "job_done000001", confirmation: codeOf(asked) });
    expect(readFixer(root).pros.find((p) => p.name === "Ana Electric")!.source).toBe("job");
  });
});

describe("cards and a damaged file", () => {
  it("refuses card-like input on every method and saves nothing", async () => {
    const { root, desk } = await activated();
    const before = readFileSync(join(root, FIXER_FILE), "utf8");
    const card = "4242 4242 4242 4242";
    const replies = [
      await desk.saveSettings({ confirmation: card }),
      await desk.savePro({ ...ana, name: card }),
      await desk.savePro({ confirm: [card] }),
      await desk.removePro({ id: card }),
      await desk.saveUpkeep({ trade: "hvac", what: card, schedule: { kind: "every", days: 90 } }),
      await desk.removeUpkeep({ id: card }),
      await desk.previewSchedule({ schedule: { kind: "custom", rrule: "FREQ=DAILY", said: card } }),
    ];
    for (const reply of replies) {
      expect(reply.isError).toBe(true);
      expect(reply.text).toContain("card number");
    }
    expect(readFileSync(join(root, FIXER_FILE), "utf8")).toBe(before);
  });

  it("answers a corrupt fixer.json with a plain refusal and leaves the file alone", async () => {
    const { root, desk } = made();
    writeFileSync(join(root, FIXER_FILE), "{ not json");
    for (const reply of [await desk.state(), await desk.savePro(joe), await desk.saveSettings({ costLineCents: null }), await desk.activate(), await desk.saveUpkeep({ trade: "hvac", what: "x", schedule: { kind: "every", days: 90 } })]) {
      expect(reply.isError).toBe(true);
      expect(reply.text).toContain("fixer.json");
    }
    expect(readFileSync(join(root, FIXER_FILE), "utf8")).toBe("{ not json");
  });

  it("says the record is unreadable in the summary line, and turn on and off answer plainly", async () => {
    const { root, desk } = made();
    writeFileSync(join(root, FIXER_FILE), "{ not json");
    expect(desk.summaryLine()).toBe("Repairs: record unreadable.");
    for (const reply of [await desk.turnOn(), await desk.turnOff(false), await desk.turnOff(true)]) {
      expect(reply.isError).toBe(true);
      expect(reply.text).toContain("fixer.json");
    }
    expect(readFileSync(join(root, FIXER_FILE), "utf8")).toBe("{ not json");
  });

  it("never lets one failed call stop the next", async () => {
    const { root, desk } = made();
    writeFileSync(join(root, FIXER_FILE), "{ not json");
    await desk.state();
    writeFileSync(join(root, FIXER_FILE), JSON.stringify(emptyFixer()));
    expect((await desk.state()).isError).toBe(false);
  });
});
