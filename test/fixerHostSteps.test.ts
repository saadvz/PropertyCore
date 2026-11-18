import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixerDeskFor, resetFixerDesks } from "../src/fixer-core/desk";
import { setCalendarFetch } from "../src/hub/calendarFetch";
import { MAX_HOST_STEPS, readFixer, writeFixer, type HostStep } from "../src/fixer-core/store";
import { hubFor, resetHubs } from "../src/hub/hub";

/**
 * #238 follow-up: Fixer Core keeps a record of each of the host's approvals on the job, so the hours log
 * still has it after the live field is replaced. Made-up pros, 555 numbers, a made-up door code.
 */

const START = new Date("2026-11-08T15:00:00.000Z");
const PROPERTY = { nickname: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" };
const LANE = "https://calendar.example/lane.ics";
const CODE = ["6", "1", "5", "9"].join("");
const SERVER_KEY = randomBytes(32).toString("base64");
const env = () => ({ CLEANER_CORE_PIN_KEY: SERVER_KEY });
const TUE = { from: "2026-11-10T15:00:00.000Z", until: "2026-11-10T17:00:00.000Z" };
const WED = { from: "2026-11-11T15:00:00.000Z", until: "2026-11-11T17:00:00.000Z" };

const dirs: string[] = [];
afterEach(() => {
  setCalendarFetch(undefined);
  resetFixerDesks();
  resetHubs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ics = () => ["BEGIN:VCALENDAR", "END:VCALENDAR"].join("\r\n");
const codeOf = (reply: { structured?: Record<string, unknown> }): string => (reply.structured!.confirmation as { code: string }).code;

/** An activated property with a plumber, one host job open, and a clock each test moves on. */
async function setup(opts: { costLine?: number; quotesFirst?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fixer-steps-"));
  dirs.push(root);
  const clock = { now: new Date(START) };
  const now = () => clock.now;
  const tick = (minutes = 5) => (clock.now = new Date(clock.now.getTime() + minutes * 60_000));
  const hub = hubFor(root, { now });
  hub.saveProperty(PROPERTY);
  hub.setCalendars({ calendars: [{ name: "Airbnb", url: LANE }], done: true });
  hub.doorAccess(env).save(CODE, undefined, undefined);
  setCalendarFetch(async (url) => ({ status: 200, url, async text() { return ics(); } }));
  const desk = fixerDeskFor(root, { now, env });
  await desk.savePro({ name: "Joe's Plumbing", trades: ["plumbing"], reach: { phone: "+15555550142" }, preferredFor: [{ trade: "plumbing", rank: 1 }] });
  await desk.savePro({ name: "Rita Rooter", trades: ["plumbing"], reach: { phone: "+15555550143" }, preferredFor: [{ trade: "plumbing", rank: 2 }] });
  await desk.saveSettings({ prosDone: true });
  await desk.saveSettings({ upkeepDone: true });
  expect((await desk.activate()).isError).toBe(false);
  await desk.openJob({ trade: "plumbing", what: "Sink leaks", urgency: "soon", source: "host", ...(opts.costLine ? { costLineCents: opts.costLine } : {}), ...(opts.quotesFirst ? { quotesFirst: true as const } : {}) });
  await desk.checkFixes({});
  const job = () => readFixer(root).jobs[0]!;
  const pro = (name: string) => readFixer(root).pros.find((p) => p.name.startsWith(name))!;
  const contact = async (name = "Joe") => (await desk.contactPro({ jobId: job().id, to: pro(name).id, how: "call" })).structured!.contactToken as string;
  const booked = async (span = TUE, name = "Joe") => desk.recordContact({ contactToken: await contact(name), outcome: "booked", ...span, estimateCents: 18000 });
  const yes = async (input: Record<string, unknown> = {}) => {
    const first = await desk.approveBooking({ jobId: job().id, ...input });
    expect(first.isError, first.text).toBe(false);
    const done = await desk.approveBooking({ jobId: job().id, ...input, confirmation: codeOf(first) });
    expect(done.isError, done.text).toBe(false);
  };
  return { root, desk, job, pro, contact, booked, yes, tick };
}

const kinds = (steps: HostStep[] | undefined) => (steps ?? []).map((step) => step.kind);

describe("Fixer Core keeps the host's approvals (#238 follow-up)", () => {
  it("the host's go on a job they opened is the first step, at the job's hostGo time", async () => {
    const w = await setup();
    expect(w.job().hostSteps).toEqual([{ kind: "approve-repair", at: w.job().hostGo!.at }]);
  });

  it("the host's yes to a booking stays after the visit is moved, and the new yes is its own step", async () => {
    const w = await setup();
    await w.booked();
    w.tick();
    await w.yes();
    const yesAt = w.job().booking!.hostYes!.at;
    w.tick();
    const first = await w.desk.rescheduleJob({ jobId: w.job().id });
    expect((await w.desk.rescheduleJob({ jobId: w.job().id, confirmation: codeOf(first) })).isError).toBe(false);
    expect(w.job().booking).toBeUndefined();
    expect(w.job().hostSteps).toContainEqual({ kind: "approve-booking", at: yesAt, proId: w.pro("Joe").id });
    w.tick();
    await w.booked(WED);
    w.tick();
    await w.yes();
    const again = w.job().booking!.hostYes!.at;
    expect(again).not.toBe(yesAt);
    expect(w.job().hostSteps!.filter((s) => s.kind === "approve-booking").map((s) => s.at)).toEqual([yesAt, again]);
  });

  it("a raised price the host approved stays after a second raise replaces it", async () => {
    const w = await setup({ costLine: 30_000 });
    await w.booked();
    await w.yes();
    w.tick();
    expect((await w.desk.raisePrice(w.job().id, 42_000, "pro")).isError).toBe(false);
    w.tick();
    await w.yes({ revised: true });
    const yesAt = w.job().booking!.revisedQuote!.hostYes!.at;
    w.tick();
    await w.desk.raisePrice(w.job().id, 45_000, "pro");
    expect(w.job().booking!.revisedQuote!.hostYes).toBeUndefined();
    expect(w.job().hostSteps).toContainEqual({ kind: "approve-price", at: yesAt, proId: w.pro("Joe").id, cents: 42_000 });
  });

  it("the host's quote pick is a step, with the pro", async () => {
    const w = await setup({ quotesFirst: true });
    for (const name of ["Joe", "Rita"]) await w.desk.recordContact({ contactToken: await w.contact(name), outcome: "quoted", quoteCents: name === "Joe" ? 20_000 : 21_000 });
    w.tick();
    const first = await w.desk.pickQuote({ jobId: w.job().id, proId: w.pro("Rita").id });
    expect(first.isError, first.text).toBe(false);
    expect((await w.desk.pickQuote({ jobId: w.job().id, proId: w.pro("Rita").id, confirmation: codeOf(first) })).isError).toBe(false);
    expect(w.job().hostSteps).toContainEqual({ kind: "pick-quote", at: w.job().quotePick!.at, proId: w.pro("Rita").id });
  });

  it("each cost the host saves is a step, even when a later one replaces it", async () => {
    const w = await setup();
    await w.booked();
    await w.yes();
    w.tick();
    await w.desk.recordCost({ jobId: w.job().id, cents: 18_000, by: "host" });
    const firstAt = w.job().cost!.at;
    w.tick();
    await w.desk.recordCost({ jobId: w.job().id, cents: 19_000, by: "host" });
    expect(w.job().hostSteps!.filter((s) => s.kind === "record-cost")).toEqual([
      { kind: "record-cost", at: firstAt, cents: 18_000 },
      { kind: "record-cost", at: w.job().cost!.at, cents: 19_000 },
    ]);
  });

  it("done with an amount from the host is two steps at the live fields' own times", async () => {
    const w = await setup();
    await w.booked();
    await w.yes();
    w.tick();
    await w.desk.recordDone({ jobId: w.job().id, by: "host", cents: 18_000 });
    const job = w.job();
    expect(job.hostSteps).toContainEqual({ kind: "confirm-repair", at: job.done!.at });
    expect(job.hostSteps).toContainEqual({ kind: "record-cost", at: job.cost!.at, cents: 18_000 });
  });

  it("the agent's or the pro's cost and done leave no step", async () => {
    const w = await setup();
    await w.booked();
    await w.yes();
    await w.desk.recordDone({ jobId: w.job().id, cents: 18_000 });
    await w.desk.recordCost({ jobId: w.job().id, cents: 19_000, by: "pro" });
    expect(kinds(w.job().hostSteps)).not.toContain("record-cost");
    expect(kinds(w.job().hostSteps)).not.toContain("confirm-repair");
  });

  it("an older job with no steps reads, and its next approval starts the list", async () => {
    const w = await setup();
    const file = readFixer(w.root);
    delete file.jobs[0]!.hostSteps;
    writeFixer(w.root, file);
    expect((await w.desk.checkFixes({})).isError).toBe(false);
    await w.booked();
    await w.yes();
    expect(kinds(w.job().hostSteps)).toEqual(["approve-booking"]);
  });

  it(`keeps at most ${MAX_HOST_STEPS} steps a job, the newest last`, async () => {
    const w = await setup();
    const file = readFixer(w.root);
    file.jobs[0]!.hostSteps = Array.from({ length: MAX_HOST_STEPS }, (_, i) => ({ kind: "record-cost" as const, at: new Date(START.getTime() - (i + 1) * 60_000).toISOString(), cents: i }));
    writeFixer(w.root, file);
    await w.booked();
    w.tick();
    await w.yes();
    const steps = w.job().hostSteps!;
    expect(steps).toHaveLength(MAX_HOST_STEPS);
    expect(steps.at(-1)).toMatchObject({ kind: "approve-booking", at: w.job().booking!.hostYes!.at });
  });
});
