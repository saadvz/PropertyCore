import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FixerDesk, fixerDeskFor, resetFixerDesks, type FixerDeps } from "../src/fixer-core/desk";
import { storePhoto, messagePhotoId, photoCount } from "../src/cleaner-core/photos";
import { setCalendarFetch } from "../src/hub/calendarFetch";
import { fixerSetupAsk } from "../src/fixer-core/setupAsk";
import { FIXER_FILE, TRADES, emptyFixer, readFixer, writeFixer } from "../src/fixer-core/store";
import { cleanerAskQuestion } from "../src/fixer-core/texts";
import { hubFor, resetHubs } from "../src/hub/hub";

/** Fixer Core's desk: setup, cost line, upkeep, activate, state. Made-up pros, 555 numbers, example.com links. */

const NOW = new Date("2026-11-08T15:00:00.000Z");
const PROPERTY = { nickname: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" };

const dirs: string[] = [];
afterEach(() => {
  setCalendarFetch(undefined);
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
  await desk.saveSettings({ upkeepDone: true });
}

async function activated(extra: Partial<FixerDeps> = {}) {
  const m = made(extra);
  await toReview(m.desk);
  expect((await m.desk.activate()).isError).toBe(false);
  return m;
}

describe("setup asks", () => {
  it("asks pros, upkeep, review in order with cleaning off, and never a cost line", async () => {
    const { desk } = made();
    expect(await step(desk)).toBe("pros");
    await desk.savePro(joe);
    expect(await step(desk)).toBe("pros");
    await desk.saveSettings({ prosDone: true });
    expect(await step(desk)).toBe("upkeep");
    await desk.saveSettings({ upkeepDone: true });
    expect(await step(desk)).toBe("review");
  });

  it("asks for alerts after upkeep only on Grok with no routine and Cleaner Core off, and not after Not now", async () => {
    const { desk } = made({ assistant: () => "grok" });
    await desk.saveSettings({ prosDone: true });
    await desk.saveSettings({ upkeepDone: true });
    expect(await step(desk)).toBe("alerts");
    const ask = ((await desk.state()).structured!.ask as { questions: { ask: string; options?: { label: string }[] }[] }).questions[0]!;
    expect(ask.ask).toBe("Want me to tell you the moment a pro texts or calls back? I'll set up an alert for this chat. You'll copy two values into secure cards.");
    expect(ask.options!.map((o) => o.label)).toEqual(["Yes", "Not now"]);
    expect((await desk.saveSettings({ alertsSkipped: true })).isError).toBe(false);
    expect(await step(desk)).toBe("review");
    for (const extra of [{ assistant: () => "muse" as const }, { assistant: () => "grok" as const, routine: () => ({ url: "https://example.com/hook", key: "made-up-key-123" }) }, { assistant: () => "grok" as const, cleaningOn: () => true }]) {
      const other = made(extra).desk;
      await other.saveSettings({ prosDone: true });
      if (extra.cleaningOn) await other.saveSettings({ askCleaner: false });
      await other.saveSettings({ upkeepDone: true });
      expect(await step(other)).toBe("review");
    }
  });

  it("asks the pros as two cards of at most five, each with None of these", async () => {
    const { desk } = made();
    const questions = ((await desk.state()).structured!.ask as { questions: { field: string; options?: { value: string }[]; multiple?: boolean; how?: string }[] }).questions;
    expect(questions.map((q) => q.field)).toEqual(["pros", "pros-more"]);
    for (const q of questions) {
      expect(q.multiple).toBe(true);
      expect(q.options!.length).toBeLessThanOrEqual(5);
    }
    expect(questions[0]!.options!.map((o) => o.value)).toEqual(["plumbing", "hvac", "electrical", "handyman", "none"]);
    expect(questions[1]!.options!.map((o) => o.value)).toEqual(["gutters", "pest-control", "appliance", "locksmith", "none"]);
    const covered = new Set(questions.flatMap((q) => q.options!.map((o) => o.value)));
    for (const trade of TRADES) expect(covered.has(trade), trade).toBe(true);
    expect(questions[0]!.how).toContain("one card per message");
  });

  it("asks the cleaner only with cleaning on, and saves the answer", async () => {
    const { root, desk } = made({ cleaningOn: () => true });
    await desk.saveSettings({ prosDone: true });
    expect(await step(desk)).toBe("ask-cleaner");
    const reply = await desk.saveSettings({ askCleaner: true });
    expect(reply.isError).toBe(false);
    expect(readFixer(root).settings.askCleaner).toBe(true);
    expect(await step(desk)).toBe("upkeep");
  });

  it("uses the approved cleaner wording, with Supply Core on or off", () => {
    const hub = { property: () => ({}), calendars: () => [], google: () => false, calendarsDone: () => false } as never;
    const file = emptyFixer();
    file.setup = { prosDone: true };
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

describe("settings", () => {
  it("keeps the bounds", async () => {
    const { root, desk } = made();
    for (const bad of [{ checkInBufferMinutes: 241 }, { cleaningMinutes: 29 }, { cleaningMinutes: 481 }, { checkInBufferMinutes: -1 }]) {
      expect((await desk.saveSettings(bad)).isError).toBe(true);
    }
    expect((await desk.saveSettings({ checkInBufferMinutes: 0, cleaningMinutes: 480 })).isError).toBe(false);
    expect(readFixer(root).settings).toMatchObject({ checkInBufferMinutes: 0, cleaningMinutes: 480 });
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
    const settings = await desk.saveSettings({ cleaningMinutes: 240 });
    expect(settings.structured!.question).toBeTruthy();
    expect(readFixer(root).settings.cleaningMinutes).toBe(180);
    expect((await desk.saveSettings({ cleaningMinutes: 240, confirmation: codeOf(settings) })).isError).toBe(false);
    expect(readFixer(root).settings.cleaningMinutes).toBe(240);

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
    for (const reply of [await desk.state(), await desk.savePro(joe), await desk.saveSettings({ askCleaner: false }), await desk.activate(), await desk.saveUpkeep({ trade: "hvac", what: "x", schedule: { kind: "every", days: 90 } })]) {
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

/** Jobs: what starts them, the host's go, and the check. */

const LANE = "https://calendar.example/lane.ics";
const ics = (...stays: [string, string][]) =>
  ["BEGIN:VCALENDAR", ...stays.flatMap(([a, b], i) => ["BEGIN:VEVENT", `UID:s${i}`, `DTSTART;VALUE=DATE:${a}`, `DTEND;VALUE=DATE:${b}`, "SUMMARY:Guest", "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
const serve = (body: string) => setCalendarFetch(async (url) => ({ status: 200, url, async text() { return body; } }));

/** An activated desk whose plumber is ranked first. */
async function withPlumber(extra: Partial<FixerDeps> = {}) {
  const m = made(extra);
  await m.desk.savePro({ ...joe, preferredFor: [{ trade: "plumbing", rank: 1 }] });
  await m.desk.saveSettings({ prosDone: true });
  await m.desk.saveSettings({ upkeepDone: true });
  await m.desk.activate();
  serve(ics());
  return m;
}

type Check = {
  needsGo: { jobId: string; question: string }[];
  upkeepDue: { upkeepId: string; nextDate: string; proId?: string }[];
  contactNext: { jobId: string; proId: string; name: string; rank: number }[];
  windows: Record<string, { from: string; until: string }[]>;
  news: { jobId: string }[];
  unconfirmed: unknown[];
};
const check = async (desk: Desk) => (await desk.checkFixes({})).structured as unknown as Check;

describe("jobs", () => {
  it("starts a host job at once with the go, and names the rank 1 pro", async () => {
    const { root, desk } = await withPlumber();
    const reply = await desk.openJob({ trade: "plumbing", what: "Kitchen sink leaks", urgency: "now", source: "host" });
    expect(reply.isError).toBe(false);
    const job = readFixer(root).jobs[0]!;
    expect(job).toMatchObject({ state: "requested", source: "host", hostGo: { at: NOW.toISOString() } });
    const seen = await check(desk);
    expect(seen.needsGo).toEqual([]);
    expect(seen.contactNext).toEqual([expect.objectContaining({ jobId: job.id, name: "Joe's Plumbing", rank: 1 })]);
  });

  it("makes a cleaner job that waits for the go, with the exact question and the photo copied", async () => {
    const { root, desk } = await withPlumber();
    storePhoto(root, messagePhotoId("m1"), { bytes: Buffer.from("jpg"), ext: "jpg" });
    const reply = await desk.openJob({ trade: "plumbing", what: "Sink leaks", urgency: "soon", source: "cleaner", sourceRef: "m1", photoMessageIds: ["m1"], cleanerName: "Maria" });
    const job = readFixer(root).jobs[0]!;
    expect(job.hostGo).toBeUndefined();
    expect(job.photos).toEqual([{ id: "1", from: "cleaner", at: NOW.toISOString() }]);
    expect(photoCount(root, `fixer:${job.id}`)).toBe(1);
    expect(reply.structured!.question).toBe("Sink leaks (photo from Maria). Want me to call Joe's Plumbing?");
    const seen = await check(desk);
    expect(seen.needsGo).toEqual([{ jobId: job.id, question: "Sink leaks (photo from Maria). Want me to call Joe's Plumbing?" }]);
    expect(seen.contactNext).toEqual([]);
    expect(seen.windows).toEqual({});
  });

  it("asks to find someone when no pro is preferred", async () => {
    const { desk } = await activated();
    storePhoto(desk.root, messagePhotoId("m2"), { bytes: Buffer.from("jpg"), ext: "jpg" });
    const reply = await desk.openJob({ trade: "hvac", what: "No heat", urgency: "now", source: "cleaner", cleanerName: "Maria", photoMessageIds: ["m2"] });
    expect(reply.structured!.question).toBe("No heat (photo from Maria). Want me to find someone?");
  });

  it("claims no photo when the cleaner job has none", async () => {
    const { desk } = await activated();
    const reply = await desk.openJob({ trade: "hvac", what: "No heat", urgency: "now", source: "cleaner", cleanerName: "Maria", photoMessageIds: ["nothing"] });
    expect(reply.structured!.question).toBe("No heat. Want me to find someone?");
    expect((await check(desk)).needsGo[0]!.question).toBe("No heat. Want me to find someone?");
  });

  it("holds the length bound after redaction", async () => {
    const { root, desk } = await activated();
    // 40 four-digit runs are 239 characters raw but 40 x 16 once redacted.
    const what = Array.from({ length: 40 }, () => "1234a").join(" ");
    expect(what.length).toBeLessThan(300);
    expect((await desk.openJob({ trade: "hvac", what, urgency: "now", source: "cleaner" })).isError).toBe(true);
    expect(readFixer(root).jobs).toEqual([]);
  });

  it("saves a cleaner's digits redacted, including split ones", async () => {
    const { root, desk } = await withPlumber();
    await desk.openJob({ trade: "plumbing", what: "Lock box is 4812 and the gate is 9 9 3 1 7", urgency: "soon", source: "cleaner" });
    const what = readFixer(root).jobs[0]!.what;
    expect(what).toBe("Lock box is [number removed] and the gate is [number removed]");
    expect(what).not.toContain("4812");
  });

  it("refuses bad jobs and card numbers", async () => {
    const { root, desk } = await withPlumber();
    const base = { trade: "plumbing" as const, what: "Leak", urgency: "now" as const, source: "host" as const };
    for (const bad of [{ trade: "roofing" as never }, { what: "" }, { what: "x".repeat(300) }, { urgency: "later" as never }, { urgency: "by-date" as const }, { byDate: "2026-12-01" }, { source: "pro" as never }, { source: "upkeep" as const }, { source: "host" as const, photoMessageIds: ["m1"] }]) {
      expect((await desk.openJob({ ...base, ...bad })).isError).toBe(true);
    }
    expect((await desk.openJob({ ...base, what: "pay with 4111 1111 1111 1111" })).isError).toBe(true);
    expect((await desk.openJob({ ...base, urgency: "by-date", byDate: "2026-11-07" })).isError).toBe(true);
    expect(readFixer(root).jobs).toEqual([]);
    expect((await desk.openJob({ ...base, what: "x".repeat(299) })).isError).toBe(false);
  });

  it("refuses a job before activation or while repairs are off", async () => {
    const { desk } = made();
    expect((await desk.openJob({ trade: "plumbing", what: "Leak", urgency: "now", source: "host" })).isError).toBe(true);
    const on = await withPlumber();
    await on.desk.turnOff(false);
    expect((await on.desk.openJob({ trade: "plumbing", what: "Leak", urgency: "now", source: "host" })).isError).toBe(true);
  });
});

describe("the host's go", () => {
  async function waiting() {
    const m = await withPlumber();
    const opened = await m.desk.openJob({ trade: "plumbing", what: "Sink leaks", urgency: "soon", source: "cleaner", cleanerName: "Maria" });
    return { ...m, jobId: opened.structured!.jobId as string };
  }

  it("saves quotes-only and a cost line on the host's job, and with the go on a cleaner's job", async () => {
    const { root, desk, jobId } = await waiting();
    const first = await desk.approveJob({ jobId });
    expect((await desk.approveJob({ jobId, quotesFirst: true, confirmation: codeOf(first) })).isError).toBe(false);
    const host = await desk.openJob({ trade: "plumbing", what: "Tap drips", urgency: "soon", source: "host", quotesFirst: true, costLineCents: 20_000 });
    const jobs = readFixer(root).jobs;
    expect(jobs.find((job) => job.id === jobId)!.quotesFirst).toBe(true);
    expect(jobs.find((job) => job.id === host.structured!.jobId)).toMatchObject({ quotesFirst: true, costLineCents: 20_000 });
    expect((await desk.openJob({ trade: "plumbing", what: "Leak", urgency: "now", source: "cleaner", quotesFirst: true })).isError).toBe(true);
  });

  it("takes the host's cost line with the go, after the question, and saves it on that job only", async () => {
    const { root, desk, jobId } = await waiting();
    const first = await desk.approveJob({ jobId });
    expect((await desk.approveJob({ jobId, costLineCents: 99, confirmation: codeOf(first) })).isError).toBe(true);
    expect((await desk.approveJob({ jobId, costLineCents: 20_000, confirmation: codeOf(first) })).isError).toBe(false);
    const other = await desk.openJob({ trade: "plumbing", what: "Tap drips", urgency: "soon", source: "host" });
    const jobs = readFixer(root).jobs;
    expect(jobs.find((job) => job.id === jobId)!.costLineCents).toBe(20_000);
    expect(jobs.find((job) => job.id === other.structured!.jobId)!.costLineCents).toBeUndefined();
  });

  it("takes a cost line on the host's own job, and never from a cleaner's or upkeep job", async () => {
    const { root, desk } = await withPlumber();
    for (const bad of [99, 500_001]) expect((await desk.openJob({ trade: "plumbing", what: "Leak", urgency: "now", source: "host", costLineCents: bad })).isError).toBe(true);
    expect((await desk.openJob({ trade: "plumbing", what: "Leak", urgency: "now", source: "cleaner", costLineCents: 20_000 })).isError).toBe(true);
    expect(readFixer(root).jobs).toHaveLength(0);
    expect((await desk.openJob({ trade: "plumbing", what: "Leak", urgency: "now", source: "host", costLineCents: 20_000 })).isError).toBe(false);
    expect(readFixer(root).jobs[0]!.costLineCents).toBe(20_000);
    expect("costLineCents" in readFixer(root).settings).toBe(false);
  });

  it("takes two calls, then names the pro to contact", async () => {
    const { root, desk, jobId } = await waiting();
    const first = await desk.approveJob({ jobId });
    expect((first.structured!.question as string)).toContain("Want me to call Joe's Plumbing?");
    expect(readFixer(root).jobs[0]!.hostGo).toBeUndefined();
    expect((await desk.approveJob({ jobId, confirmation: "wrong" })).isError).toBe(true);
    expect((await desk.approveJob({ jobId, confirmation: codeOf(first) })).isError).toBe(false);
    expect(readFixer(root).jobs[0]!.hostGo).toEqual({ at: NOW.toISOString() });
    expect((await check(desk)).contactNext).toEqual([expect.objectContaining({ jobId, name: "Joe's Plumbing" })]);
    expect((await desk.approveJob({ jobId })).isError).toBe(true);
  });

  it("cancels on no", async () => {
    const { root, desk, jobId } = await waiting();
    expect((await desk.approveJob({ jobId, no: true })).isError).toBe(false);
    expect(readFixer(root).jobs[0]).toMatchObject({ state: "cancelled", cancelReason: "host-said-no" });
    expect((await check(desk)).needsGo).toEqual([]);
    expect((await desk.approveJob({ jobId: "job_missing000" })).isError).toBe(true);
  });
});

describe("upkeep jobs", () => {
  async function withUpkeep() {
    const m = await withPlumber();
    const item = { trade: "hvac" as const, what: "Change the filters", schedule: { kind: "every" as const, days: 30 }, leadDays: 7 };
    await m.desk.saveUpkeep({ ...item, confirmation: codeOf(await m.desk.saveUpkeep(item)) });
    return { ...m, upkeepId: readFixer(m.root).upkeep[0]!.id };
  }

  it("is due leadDays before the date, and not while its job is open", async () => {
    const m = made({});
    await m.desk.savePro({ ...joe, preferredFor: [{ trade: "plumbing", rank: 1 }] });
    await m.desk.saveSettings({ prosDone: true });
    await m.desk.saveUpkeep({ trade: "hvac", what: "Change the filters", schedule: { kind: "every", days: 30 }, leadDays: 7, proId: readFixer(m.root).pros[0]!.id });
    await m.desk.saveSettings({ upkeepDone: true });
    await m.desk.activate();
    serve(ics());
    const upkeepId = readFixer(m.root).upkeep[0]!.id;
    expect((await check(m.desk)).upkeepDue).toEqual([]);
    // Saved 2026-11-08, so the next date is 2026-12-08 and it is due from 2026-12-01.
    let clock = new Date("2026-12-01T15:00:00.000Z");
    const desk = new FixerDesk(m.root, { now: () => clock });
    const due = (await check(desk)).upkeepDue;
    expect(due).toEqual([{ upkeepId, trade: "hvac", what: "Change the filters", nextDate: "2026-12-08", proId: readFixer(m.root).pros[0]!.id }]);
    expect((await desk.openJob({ trade: "hvac", what: "Change the filters", urgency: "flexible", source: "upkeep", sourceRef: upkeepId })).isError).toBe(false);
    expect((await check(desk)).upkeepDue).toEqual([]);
    clock = new Date("2026-12-05T15:00:00.000Z");
    expect((await check(desk)).upkeepDue).toEqual([]);
    expect((await desk.openJob({ trade: "hvac", what: "Again", urgency: "flexible", source: "upkeep", sourceRef: upkeepId })).isError).toBe(true);
  });

  it("needs an existing upkeep id, and waits for the go like a cleaner job", async () => {
    const { root, desk, upkeepId } = await withUpkeep();
    expect((await desk.openJob({ trade: "hvac", what: "Filters", urgency: "flexible", source: "upkeep" })).isError).toBe(true);
    expect((await desk.openJob({ trade: "hvac", what: "Filters", urgency: "flexible", source: "upkeep", sourceRef: "upk_nothere0" })).isError).toBe(true);
    const reply = await desk.openJob({ trade: "hvac", what: "Filters", urgency: "flexible", source: "upkeep", sourceRef: upkeepId });
    expect(reply.structured!.question).toBe("Filters. Want me to find someone?");
    expect(readFixer(root).jobs[0]!.hostGo).toBeUndefined();
    expect((await check(desk)).needsGo).toHaveLength(1);
  });
});

describe("check_fixes", () => {
  it("returns every list, empty when nothing, and refuses before activation", async () => {
    expect((await made().desk.checkFixes({})).isError).toBe(true);
    const { desk } = await withPlumber();
    expect((await desk.checkFixes({})).structured).toEqual({ needsGo: [], upkeepDue: [], contactNext: [], quotesReady: [], windows: {}, unconfirmed: [], followUps: [], held: [], delays: [], preferredAsk: [], rotationAsk: [], news: [] });
  });

  it("windows respect the next check-in and its buffer", async () => {
    const { desk } = await withPlumber();
    serve(ics(["20261110", "20261113"]));
    const opened = await desk.openJob({ trade: "plumbing", what: "Leak", urgency: "now", source: "host" });
    const windows = (await check(desk)).windows[opened.structured!.jobId as string]!;
    // Now is 10:00 on Nov 8 in New York; check-in is 16:00 on Nov 10, less the 60 minute buffer.
    expect(windows[0]).toEqual({ from: NOW.toISOString(), until: "2026-11-10T20:00:00.000Z" });
    expect(windows[1]!.from).toBe("2026-11-13T16:00:00.000Z");
  });

  it("applies the cleaner's cleaning through deps.cleanings", async () => {
    const asked: string[] = [];
    const { desk } = await withPlumber({ cleanings: async (day) => (asked.push(day), { cleared: true }) });
    serve(ics(["20261104", "20261109"], ["20261112", "20261114"]));
    const opened = await desk.openJob({ trade: "plumbing", what: "Leak", urgency: "now", source: "host", });
    const job = readFixer(desk.root).jobs.find((j) => j.id === opened.structured!.jobId)!;
    await check(desk);
    expect(asked).toContain("2026-11-09");
    expect((await desk.windowsFor({ ...job, cleaningOrder: "after" })).every((w) => Date.parse(w.from) >= NOW.getTime())).toBe(true);
  });

  it("does not read calendars while Cleaner Core runs, or Supply Core asks", async () => {
    let reads = 0;
    const count = async (url: string) => (reads++, { status: 200, url, async text() { return ics(); } });
    const cleaning = await withPlumber({ cleaningOn: () => true });
    setCalendarFetch(count);
    // Stays never read are unknown, so the first check reads them even so; after that Cleaner Core reads.
    await check(cleaning.desk);
    expect(reads).toBe(1);
    await check(cleaning.desk);
    expect(reads).toBe(1);
    reads = 0;
    const plain = await withPlumber();
    setCalendarFetch(count);
    await check(plain.desk);
    expect(reads).toBe(1);
  });

  it("tells the news once", async () => {
    const { root, desk } = await withPlumber();
    const opened = await desk.openJob({ trade: "plumbing", what: "Leak", urgency: "now", source: "host" });
    const file = readFixer(root);
    file.jobs[0]!.news.push({ kind: "revealed", at: NOW.toISOString() }, { kind: "old", at: NOW.toISOString(), toldAt: NOW.toISOString() });
    writeFixer(root, file);
    expect((await check(desk)).news).toEqual([{ jobId: opened.structured!.jobId, kind: "revealed", at: NOW.toISOString() }]);
    expect((await check(desk)).news).toEqual([]);
    expect(readFixer(root).jobs[0]!.news.every((n) => n.toldAt)).toBe(true);
  });

  it("names no pro for a draft or an unranked one", async () => {
    const { desk } = await activated();
    serve(ics());
    await desk.savePro({ name: "Draft Plumbing", trades: ["plumbing"], preferredFor: [{ trade: "plumbing", rank: 1 }], reach: { phone: "+15555550177" }, draft: true });
    await desk.savePro({ ...ana, preferredFor: [{ trade: "electrical", rank: 1 }] }).then(async (r) => desk.savePro({ ...ana, preferredFor: [{ trade: "electrical", rank: 1 }], confirmation: codeOf(r) }));
    await desk.openJob({ trade: "plumbing", what: "Leak", urgency: "now", source: "host" });
    expect((await check(desk)).contactNext).toEqual([]);
  });
});

/** The shortlist, the host's pick and contacting a pro. */

const cand = (name: string, extra: Record<string, unknown> = {}) => ({ name, source: "search", licensed: "yes" as const, reach: { phone: "+15555550177" }, ...extra });

/** A plumber ranked first, a second saved plumber, and a host job started; the clock can move. */
async function withJob(extra: Partial<FixerDeps> = {}) {
  const clock = { at: NOW };
  const m = made({ now: () => clock.at, ...extra });
  await m.desk.savePro({ ...joe, preferredFor: [{ trade: "plumbing", rank: 1 }] });
  await m.desk.savePro({ name: "Rita Rooter", trades: ["plumbing"], reach: { phone: "+15555550143" }, preferredFor: [{ trade: "plumbing", rank: 2 }] });
  await m.desk.saveSettings({ prosDone: true });
  await m.desk.saveSettings({ upkeepDone: true });
  await m.desk.activate();
  serve(ics());
  await m.desk.openJob({ trade: "plumbing", what: "Kitchen sink leaks", urgency: "now", source: "host" });
  const job = () => readFixer(m.root).jobs[0]!;
  return { ...m, clock, job };
}

describe("shortlist and pick", () => {
  it("keeps up to 8 candidates, https links only, and moves the job to shortlisted", async () => {
    const { desk, job } = await withJob();
    const bad = await desk.addCandidates({ jobId: job().id, candidates: [cand("Web Pro", { reach: { website: "http://pro.example.com" } })] });
    expect(bad.isError).toBe(true);
    const ok1 = await desk.addCandidates({ jobId: job().id, candidates: [cand("Pipe One", { reach: { website: "https://pipes.example.com" }, priceText: "$95/hr" })] });
    expect(ok1.isError).toBe(false);
    expect(job().state).toBe("shortlisted");
    expect(job().candidates[0]!.id).toMatch(/^cand_[a-z0-9]{8}$/);
    const many = Array.from({ length: 8 }, (_, i) => cand(`Pro Number ${i}`));
    expect((await desk.addCandidates({ jobId: job().id, candidates: many })).isError).toBe(true);
    expect(job().candidates).toHaveLength(1);
    expect((await desk.addCandidates({ jobId: job().id, candidates: many.slice(0, 7) })).isError).toBe(false);
    expect(job().candidates).toHaveLength(8);
    expect((await desk.addCandidates({ jobId: job().id, candidates: [cand("One More")] })).isError).toBe(true);
  });

  it("refuses a price text of 60 characters or more", async () => {
    const { desk, job } = await withJob();
    expect((await desk.addCandidates({ jobId: job().id, candidates: [cand("Long Price", { priceText: "x".repeat(60) })] })).isError).toBe(true);
  });

  it("adds options to a contacted job only when asked", async () => {
    const { desk, job } = await withJob();
    const joeId = readFixer(desk.root).pros[0]!.id;
    await desk.contactPro({ jobId: job().id, to: joeId, how: "call" });
    expect((await desk.addCandidates({ jobId: job().id, candidates: [cand("Late One")] })).isError).toBe(true);
    expect((await desk.addCandidates({ jobId: job().id, candidates: [cand("Late One")], options: true })).isError).toBe(false);
    expect(job().state).toBe("shortlisted");
  });

  it("picks in two calls, in order, and refuses ids that are not on the job before the question", async () => {
    const { desk, job } = await withJob();
    await desk.addCandidates({ jobId: job().id, candidates: [cand("Pipe One"), cand("Pipe Two")] });
    const [a, b] = job().candidates.map((c) => c.id);
    const stranger = await desk.pickPros({ jobId: job().id, ids: [a!, "cand_zzzzzzzz"] });
    expect(stranger.isError).toBe(true);
    expect(stranger.structured?.confirmation).toBeUndefined();
    const first = await desk.pickPros({ jobId: job().id, ids: [b!, a!] });
    expect(first.structured!.question).toBe("Call Pipe Two, then Pipe One?");
    expect(job().picked).toEqual([]);
    expect((await desk.pickPros({ jobId: job().id, ids: [a!, b!], confirmation: codeOf(first) })).isError).toBe(true);
    const again = await desk.pickPros({ jobId: job().id, ids: [b!, a!] });
    expect((await desk.pickPros({ jobId: job().id, ids: [b!, a!], confirmation: codeOf(again) })).isError).toBe(false);
    expect(job().picked).toEqual([b, a]);
  });

  it("refuses a drafted pro in a pick", async () => {
    const { desk, job } = await withJob();
    await desk.savePro({ name: "Draft Dan", trades: ["plumbing"], draft: true });
    const draft = readFixer(desk.root).pros.find((p) => p.status === "draft")!;
    expect((await desk.pickPros({ jobId: job().id, ids: [draft.id] })).isError).toBe(true);
  });
});

describe("contacting a pro", () => {
  it("refuses anyone not picked and not preferred, and tells the host", async () => {
    const { desk, job } = await withJob();
    await desk.addCandidates({ jobId: job().id, candidates: [cand("Pipe One")] });
    const refused = await desk.contactPro({ jobId: job().id, to: job().candidates[0]!.id, how: "call" });
    expect(refused).toMatchObject({ isError: true, structured: { tellHost: true } });
    expect(refused.text).toContain("Pipe One");
    expect(job().contacts).toEqual([]);
  });

  it("contacts a preferred pro after the go, and a picked candidate", async () => {
    const { desk, job } = await withJob();
    const joeId = readFixer(desk.root).pros[0]!.id;
    const reply = await desk.contactPro({ jobId: job().id, to: joeId, how: "call" });
    expect(reply.structured).toMatchObject({ reach: { phone: "+15555550142" } });
    expect(reply.structured!.contactToken).toMatch(/^[a-p]+$/);
    expect(job().contacts[0]!.id).toMatch(/^con_[a-z0-9]{8}$/);
    expect(job().contacts[0]!.token).toBe(reply.structured!.contactToken);
    expect(job().state).toBe("contacted");
    await desk.addCandidates({ jobId: job().id, candidates: [cand("Pipe One")], options: true });
    const id = job().candidates[0]!.id;
    const pick = await desk.pickPros({ jobId: job().id, ids: [id] });
    await desk.pickPros({ jobId: job().id, ids: [id], confirmation: codeOf(pick) });
    expect((await desk.contactPro({ jobId: job().id, to: id, how: "call" })).isError).toBe(false);
  });

  it("refuses a text to a pro who has not opted in or has stopped", async () => {
    const dir = folder();
    const { peopleFor, resetPeople } = await import("../src/hub/people");
    const people = () => peopleFor(dir, { now: () => NOW });
    const { desk, job } = await withJob({ people, propertyId: "prop_a" });
    const joeId = readFixer(desk.root).pros[0]!.id;
    const no = await desk.contactPro({ jobId: job().id, to: joeId, how: "text" });
    expect(no).toMatchObject({ isError: true, structured: { tellHost: true } });
    people().optIn("+15555550142", "prop_a");
    expect((await desk.contactPro({ jobId: job().id, to: joeId, how: "text" })).isError).toBe(false);
    people().stop("+15555550142");
    expect((await desk.contactPro({ jobId: job().id, to: joeId, how: "text" })).isError).toBe(true);
    resetPeople();
  });
});

describe("what a pro said", () => {
  async function contacted() {
    const w = await withJob();
    const joeId = readFixer(w.root).pros[0]!.id;
    const token = (await w.desk.contactPro({ jobId: w.job().id, to: joeId, how: "call" })).structured!.contactToken as string;
    return { ...w, joeId, token };
  }

  it("refuses an unknown token and a contact on a cancelled job", async () => {
    const { desk, job, token } = await contacted();
    expect((await desk.recordContact({ contactToken: "nope", outcome: "declined" })).isError).toBe(true);
    await desk.cancelJob({ jobId: job().id });
    expect((await desk.recordContact({ contactToken: token, outcome: "declined" })).isError).toBe(true);
  });

  it("records a quote, then declined offers the next rank and no-answer too", async () => {
    const { desk, job, token } = await contacted();
    const quoted = await desk.recordContact({ contactToken: token, outcome: "quoted", quoteCents: 18000, note: "Parts extra" });
    expect(quoted.isError).toBe(false);
    expect(job().contacts[0]).toMatchObject({ outcome: "quoted", quote: { cents: 18000, note: "Parts extra" } });
    const declined = await desk.recordContact({ contactToken: token, outcome: "declined" });
    expect(declined.structured!.next).toMatchObject({ name: "Rita Rooter", rank: 2 });
    const ritaId = readFixer(desk.root).pros[1]!.id;
    const second = (await desk.contactPro({ jobId: job().id, to: ritaId, how: "call" })).structured!.contactToken as string;
    const none = await desk.recordContact({ contactToken: second, outcome: "no-answer" });
    expect(none.structured!.state).toBe("requested");
    expect(job().state).toBe("requested");
  });

  it("goes back to shortlisted when candidates exist and nobody is left", async () => {
    const { desk, job, token } = await contacted();
    await desk.addCandidates({ jobId: job().id, candidates: [cand("Pipe One")], options: true });
    const ritaId = readFixer(desk.root).pros[1]!.id;
    await desk.recordContact({ contactToken: token, outcome: "declined" });
    const second = (await desk.contactPro({ jobId: job().id, to: ritaId, how: "call" })).structured!.contactToken as string;
    await desk.recordContact({ contactToken: second, outcome: "declined" });
    expect(job().state).toBe("shortlisted");
  });

  it("puts a contact with no outcome after 2 hours under unconfirmed, once", async () => {
    const { desk, clock, token } = await contacted();
    expect((await check(desk)).unconfirmed).toEqual([]);
    clock.at = new Date(NOW.getTime() + 2 * 3_600_000);
    const seen = await check(desk);
    expect(seen.unconfirmed).toEqual([expect.objectContaining({ contactToken: token, name: "Joe's Plumbing" })]);
    expect((await check(desk)).unconfirmed).toEqual([]);
  });

  it("puts a waiting contact past 24 hours under follow-ups with the next pick", async () => {
    const { desk, clock, token } = await contacted();
    await desk.recordContact({ contactToken: token, outcome: "waiting" });
    clock.at = new Date(NOW.getTime() + 23 * 3_600_000);
    expect(((await desk.checkFixes({})).structured as { followUps: unknown[] }).followUps).toEqual([]);
    clock.at = new Date(NOW.getTime() + 24 * 3_600_000);
    const follow = ((await desk.checkFixes({})).structured as { followUps: { name: string; next?: { name: string } }[] }).followUps;
    expect(follow).toEqual([expect.objectContaining({ name: "Joe's Plumbing", next: expect.objectContaining({ name: "Rita Rooter" }) })]);
  });
});

/** A quotes-only repair reports its quotes once. Made-up pros, 555 numbers. */
describe("quotes first", () => {
  async function quotesJob() {
    const w = await withJob();
    const file = readFixer(w.root);
    file.jobs[0]!.quotesFirst = true;
    writeFixer(w.root, file);
    const [joe, rita] = readFixer(w.root).pros;
    const contact = async (proId: string) => (await w.desk.contactPro({ jobId: w.job().id, to: proId, how: "call" })).structured!.contactToken as string;
    return { ...w, joe: joe!.id, rita: rita!.id, contact };
  }
  const ready = async (desk: Desk) => ((await desk.checkFixes({})).structured as { quotesReady?: { jobId: string; quotes: { proId: string; cents: number }[]; question: string }[] }).quotesReady ?? [];

  it("reports the quotes once every contacted pro answered", async () => {
    const w = await quotesJob();
    const joe = await w.contact(w.joe);
    const rita = await w.contact(w.rita);
    expect(await ready(w.desk)).toEqual([]);
    await w.desk.recordContact({ contactToken: joe, outcome: "quoted", quoteCents: 15000 });
    expect(await ready(w.desk)).toEqual([]);
    await w.desk.recordContact({ contactToken: rita, outcome: "declined" });
    const listed = await ready(w.desk);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.question).toBe("Quotes for Kitchen sink leaks: Joe's Plumbing $150. Who should I book, and want a cost line?");
    expect(listed[0]!.quotes).toEqual([{ proId: w.joe, name: "Joe's Plumbing", cents: 15000 }]);
    expect(await ready(w.desk)).toEqual([]);
  });

  it("says no quotes yet when everyone declined", async () => {
    const w = await quotesJob();
    await w.desk.recordContact({ contactToken: await w.contact(w.joe), outcome: "declined" });
    expect((await ready(w.desk))[0]!.question).toBe("No quotes yet for Kitchen sink leaks. Want me to find more pros?");
  });

  it("reports again after more pros are contacted", async () => {
    const w = await quotesJob();
    await w.desk.recordContact({ contactToken: await w.contact(w.joe), outcome: "quoted", quoteCents: 15000, note: "Can come Tuesday" });
    expect(await ready(w.desk)).toHaveLength(1);
    w.clock.at = new Date(NOW.getTime() + 60_000);
    await w.desk.recordContact({ contactToken: await w.contact(w.rita), outcome: "quoted", quoteCents: 22000 });
    expect((await ready(w.desk))[0]!.question).toBe("Quotes for Kitchen sink leaks: Joe's Plumbing $150 (Can come Tuesday), Rita Rooter $220. Who should I book, and want a cost line?");
  });

  it("pick_quote books the picked pro next, with the host's yes and a cost line", async () => {
    const w = await quotesJob();
    const joe = await w.contact(w.joe);
    await w.desk.recordContact({ contactToken: joe, outcome: "quoted", quoteCents: 15000 });
    const ask = await w.desk.pickQuote({ jobId: w.job().id, proId: w.joe, costLineCents: 20_000 });
    expect(ask.structured!.question).toBe("Book Joe's Plumbing for Kitchen sink leaks with a $200 cost line?");
    expect(w.job().quotesFirst).toBe(true);
    expect((await w.desk.pickQuote({ jobId: w.job().id, proId: w.joe, costLineCents: 20_000, confirmation: codeOf(ask) })).isError).toBe(false);
    expect(w.job()).toMatchObject({ costLineCents: 20_000 });
    expect(w.job().quotesFirst).toBeUndefined();
    expect((await check(w.desk)).contactNext[0]).toMatchObject({ jobId: w.job().id, proId: w.joe });
    const again = await w.contact(w.joe);
    expect((await w.desk.recordContact({ contactToken: again, outcome: "booked", from: "2026-11-10T15:00:00.000Z", until: "2026-11-10T17:00:00.000Z", estimateCents: 15000 })).isError).toBe(false);
  });

  it("refuses a pro who didn't quote, a job that isn't quotes-only, and a stale code", async () => {
    const w = await quotesJob();
    await w.desk.recordContact({ contactToken: await w.contact(w.rita), outcome: "declined" });
    expect((await w.desk.pickQuote({ jobId: w.job().id, proId: w.rita })).isError).toBe(true);
    await w.desk.recordContact({ contactToken: await w.contact(w.joe), outcome: "quoted", quoteCents: 15000 });
    const ask = await w.desk.pickQuote({ jobId: w.job().id, proId: w.joe });
    expect((await w.desk.pickQuote({ jobId: w.job().id, proId: w.joe, costLineCents: 99_00, confirmation: codeOf(ask) })).isError).toBe(true);
    expect(w.job().quotesFirst).toBe(true);
    const plain = await withJob();
    expect((await plain.desk.pickQuote({ jobId: plain.job().id, proId: readFixer(plain.root).pros[0]!.id })).isError).toBe(true);
  });
});

