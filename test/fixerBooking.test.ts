import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixerDeskFor, resetFixerDesks, type FixerDeps } from "../src/fixer-core/desk";
import { setCalendarFetch } from "../src/hub/calendarFetch";
import { FIXER_FILE, readFixer, writeFixer } from "../src/fixer-core/store";
import { hubFor, resetHubs } from "../src/hub/hub";

/** Booking: the pro's yes, the host's yes, the gates at redeem, cancel. Made-up pros, 555 numbers, a made-up door code. */

const NOW = new Date("2026-11-08T15:00:00.000Z");
const PROPERTY = { nickname: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" };
const LANE = "https://calendar.example/lane.ics";
const CODE = "6159";
const SERVER_KEY = randomBytes(32).toString("base64");
const env = () => ({ CLEANER_CORE_PIN_KEY: SERVER_KEY });

const dirs: string[] = [];
afterEach(() => {
  setCalendarFetch(undefined);
  resetFixerDesks();
  resetHubs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ics = (...stays: [string, string][]) =>
  ["BEGIN:VCALENDAR", ...stays.flatMap(([a, b], i) => ["BEGIN:VEVENT", `UID:s${i}`, `DTSTART;VALUE=DATE:${a}`, `DTEND;VALUE=DATE:${b}`, "SUMMARY:Guest", "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
const serve = (body: string) => setCalendarFetch(async (url) => ({ status: 200, url, async text() { return body; } }));
const codeOf = (reply: { structured?: Record<string, unknown> }): string => (reply.structured!.confirmation as { code: string }).code;

type Opts = { code?: boolean; costLine?: number; locksmith?: boolean; cleanings?: FixerDeps["cleanings"] };

/** An activated property with a plumber (and a locksmith) ranked first, and one host job open. */
async function setup(opts: Opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "fixer-book-"));
  dirs.push(root);
  const hub = hubFor(root, { now: () => NOW });
  hub.saveProperty(PROPERTY);
  hub.setCalendars({ calendars: [{ name: "Airbnb", url: LANE }], done: true });
  if (opts.code !== false) hub.doorAccess(env).save(CODE, undefined, undefined);
  const desk = fixerDeskFor(root, { now: () => NOW, env, ...(opts.cleanings ? { cleanings: opts.cleanings, cleaningOn: () => true } : {}) });
  await desk.savePro({ name: "Joe's Plumbing", trades: ["plumbing"], reach: { phone: "+15555550142" }, preferredFor: [{ trade: "plumbing", rank: 1 }] });
  await desk.savePro({ name: "Rita Rooter", trades: ["plumbing"], reach: { phone: "+15555550143" }, preferredFor: [{ trade: "plumbing", rank: 2 }] });
  await desk.savePro({ name: "Lou Locks", trades: ["locksmith"], reach: { phone: "+15555550144" }, preferredFor: [{ trade: "locksmith", rank: 1 }] });
  await desk.saveSettings({ prosDone: true });
  await desk.saveSettings(opts.costLine ? { costLineCents: opts.costLine } : { costLineCents: null });
  await desk.saveSettings({ upkeepDone: true });
  expect((await desk.activate()).isError).toBe(false);
  serve(ics());
  const lock = opts.locksmith === true;
  await desk.openJob({ trade: lock ? "locksmith" : "plumbing", what: lock ? "Lock sticks" : "Sink leaks", urgency: "soon", source: "host", ...(lock ? { doorLock: true as const } : {}) });
  await desk.checkFixes({});
  const state = () => readFixer(root);
  const job = () => state().jobs[0]!;
  const pro = (name: string) => state().pros.find((p) => p.name.startsWith(name))!;
  const contact = async (name = "Joe") => (await desk.contactPro({ jobId: job().id, to: pro(name).id, how: "call" })).structured!.contactToken as string;
  return { root, desk, state, job, pro, contact };
}
type World = Awaited<ReturnType<typeof setup>>;

const TUE = { from: "2026-11-10T15:00:00.000Z", until: "2026-11-10T17:00:00.000Z" };

async function booked(w: World, name = "Joe", extra: Record<string, unknown> = {}) {
  const token = await w.contact(name);
  return w.desk.recordContact({ contactToken: token, outcome: "booked", ...TUE, estimateCents: 18000, ...extra });
}

/** The host's yes in two calls. */
async function yes(w: World, input: Record<string, unknown> = {}) {
  const first = await w.desk.approveBooking({ jobId: w.job().id, ...input });
  if (first.isError || !first.structured?.confirmation) return first;
  return w.desk.approveBooking({ jobId: w.job().id, ...input, confirmation: codeOf(first) });
}

describe("the pro's yes", () => {
  it("stores a pending booking and asks the exact booking question", async () => {
    const w = await setup();
    const reply = await booked(w);
    expect(reply.structured!.question).toBe("Joe's Plumbing can come Tuesday 10 to 12, about $180. Book it and let them in with the door code?");
    expect(w.job().booking).toMatchObject({ proId: w.pro("Joe").id, ...TUE, estimateCents: 18000, access: "code" });
    expect(w.job().booking!.hostYes).toBeUndefined();
    expect(w.job().booking!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(w.job().state).toBe("contacted");
  });

  it("leaves out the estimate when there is none", async () => {
    const w = await setup();
    const reply = await booked(w, "Joe", { estimateCents: undefined });
    expect(reply.structured!.question).toBe("Joe's Plumbing can come Tuesday 10 to 12. Book it and let them in with the door code?");
  });

  it("books a locksmith job on the coded lock with the host letting them in", async () => {
    const w = await setup({ locksmith: true });
    const reply = await booked(w, "Lou");
    expect(w.job().booking!.access).toBe("host");
    expect(reply.structured!.question).toBe("Lou Locks can come Tuesday 10 to 12, about $180. Book it and you'll let them in?");
  });

  it("books with the host letting them in when no code is saved", async () => {
    const w = await setup({ code: false });
    await booked(w);
    expect(w.job().booking!.access).toBe("host");
  });

  it("holds a time inside a stay for the host with outside-window", async () => {
    const w = await setup();
    serve(ics(["20261109", "20261112"]));
    await w.desk.checkFixes({});
    const reply = await booked(w);
    expect(w.job().booking!.heldFor).toContain("outside-window");
    expect(reply.structured!.question).toBeUndefined();
    const held = ((await w.desk.checkFixes({})).structured as { held: { jobId: string; heldFor: string[] }[] }).held;
    expect(held).toEqual([expect.objectContaining({ jobId: w.job().id, heldFor: expect.arrayContaining(["outside-window"]) })]);
    expect((await w.desk.approveBooking({ jobId: w.job().id })).isError).toBe(true);
  });

  it("holds a price over the cost line, and the host's yes still books it", async () => {
    const w = await setup({ costLine: 10_000 });
    await booked(w);
    expect(w.job().booking!.heldFor).toEqual(["cost"]);
    expect((await yes(w)).isError).toBe(false);
    expect(w.job().state).toBe("booked");
  });

  it("keeps a second yes on its contact and lists it for the host to choose", async () => {
    const w = await setup();
    await booked(w);
    const rita = await w.contact("Rita");
    const second = await w.desk.recordContact({ contactToken: rita, outcome: "booked", from: "2026-11-11T15:00:00.000Z", until: "2026-11-11T17:00:00.000Z" });
    expect(second.structured).toMatchObject({ heldForHost: true });
    expect(w.job().booking!.proId).toBe(w.pro("Joe").id);
    const held = ((await w.desk.checkFixes({})).structured as { held: { others?: { name: string }[] }[] }).held;
    expect(held[0]!.others).toEqual([expect.objectContaining({ name: "Rita Rooter" })]);
    const choose = await yes(w, { proId: w.pro("Rita").id });
    expect(choose.isError).toBe(false);
    expect(w.job().booking).toMatchObject({ proId: w.pro("Rita").id, from: "2026-11-11T15:00:00.000Z" });
  });

  it("refuses a booked outcome on a job that already has a live booking", async () => {
    const w = await setup();
    await booked(w);
    await yes(w);
    const rita = await w.desk.contactPro({ jobId: w.job().id, to: w.pro("Rita").id, how: "call" });
    expect(rita.isError).toBe(true);
  });
});

describe("the host's yes", () => {
  it("books in two calls and sets the host's yes", async () => {
    const w = await setup();
    await booked(w);
    const first = await w.desk.approveBooking({ jobId: w.job().id });
    expect(first.structured!.question).toBe("Joe's Plumbing can come Tuesday 10 to 12, about $180. Book it and let them in with the door code?");
    expect(w.job().state).toBe("contacted");
    const second = await w.desk.approveBooking({ jobId: w.job().id, confirmation: codeOf(first) });
    expect(second.isError).toBe(false);
    expect(w.job()).toMatchObject({ state: "booked", booking: { hostYes: { at: NOW.toISOString() }, access: "code" } });
    const replay = await w.desk.approveBooking({ jobId: w.job().id, confirmation: codeOf(first) });
    expect(replay.isError).toBe(true);
  });

  it("binds the code to the access chosen", async () => {
    const w = await setup();
    await booked(w);
    const first = await w.desk.approveBooking({ jobId: w.job().id });
    const other = await w.desk.approveBooking({ jobId: w.job().id, access: "host", confirmation: codeOf(first) });
    expect(other.isError).toBe(true);
    expect(w.job().state).toBe("contacted");
  });

  it("books with access host when the host will let them in", async () => {
    const w = await setup();
    await booked(w);
    const first = await w.desk.approveBooking({ jobId: w.job().id, access: "host" });
    expect(first.structured!.question).toContain("you'll let them in?");
    await w.desk.approveBooking({ jobId: w.job().id, access: "host", confirmation: codeOf(first) });
    expect(w.job().booking!.access).toBe("host");
  });

  it("refuses the code for access when none is saved", async () => {
    const w = await setup({ code: false });
    await booked(w);
    expect((await w.desk.approveBooking({ jobId: w.job().id, access: "code" })).isError).toBe(true);
  });

  it("refuses a yes after the stays changed, and books nothing", async () => {
    const w = await setup();
    await booked(w);
    const first = await w.desk.approveBooking({ jobId: w.job().id });
    serve(ics(["20261109", "20261112"]));
    const second = await w.desk.approveBooking({ jobId: w.job().id, confirmation: codeOf(first) });
    expect(second.isError).toBe(true);
    expect(second.text).toMatch(/guest|open between/);
    expect(w.job().state).toBe("contacted");
    expect(w.job().booking!.hostYes).toBeUndefined();
  });

  it("refuses a yes once the offered time has passed", async () => {
    const w = await setup();
    await booked(w);
    const first = await w.desk.approveBooking({ jobId: w.job().id });
    // Move the stored span into the past: the window check at redeem sees it outside.
    const file = readFixer(w.root);
    file.jobs[0]!.booking!.from = "2026-11-06T15:00:00.000Z";
    file.jobs[0]!.booking!.until = "2026-11-06T17:00:00.000Z";
    writeFixer(w.root, file);
    expect((await w.desk.approveBooking({ jobId: w.job().id, confirmation: codeOf(first) })).isError).toBe(true);
  });

  it("asks before or after the cleaning when a cleaning shares the turnover", async () => {
    const w = await setup({ cleanings: async () => ({ cleared: false }) });
    serve(ics(["20261107", "20261110"], ["20261114", "20261116"]));
    // Cleaner Core reads the calendars when it runs, so the desk doesn't.
    await hubFor(w.root, { now: () => NOW }).readCalendars({ tenantId: "test" });
    const token = await w.contact();
    await w.desk.recordContact({ contactToken: token, outcome: "booked", from: "2026-11-10T16:00:00.000Z", until: "2026-11-10T18:00:00.000Z", estimateCents: 18000 });
    const ask = await w.desk.approveBooking({ jobId: w.job().id });
    expect(ask.structured!.confirmation).toBeUndefined();
    expect(ask.structured!.question).toMatch(/before or after the cleaning/i);
    // After the cleaning leaves no room at 11 to 1, so that order is refused.
    expect((await w.desk.approveBooking({ jobId: w.job().id, cleaningOrder: "after" })).isError).toBe(true);
    const done = await yes(w, { cleaningOrder: "before" });
    expect(done.isError).toBe(false);
    expect(w.job().booking!.cleaningOrder).toBe("before");
    expect(w.job().cleaningOrder).toBe("before");
  });

  it("approves a held raised price with revised", async () => {
    const w = await setup();
    await booked(w);
    await yes(w);
    const file = readFixer(w.root);
    file.jobs[0]!.booking!.revisedQuote = { cents: 30000, at: NOW.toISOString() };
    writeFixer(w.root, file);
    const first = await w.desk.approveBooking({ jobId: w.job().id, revised: true });
    expect(first.structured!.question).toBe("Joe's Plumbing says the fix is $300.00, not $180.00. Go ahead?");
    await w.desk.approveBooking({ jobId: w.job().id, revised: true, confirmation: codeOf(first) });
    expect(w.job().booking!.revisedQuote!.hostYes).toBeDefined();
  });
});

describe("cancel", () => {
  it("cancels an unbooked job at once", async () => {
    const w = await setup();
    const reply = await w.desk.cancelJob({ jobId: w.job().id, reason: "fixed it myself" });
    expect(reply.isError).toBe(false);
    expect(w.job()).toMatchObject({ state: "cancelled", cancelReason: "fixed it myself" });
    expect(reply.structured!.tellPro).toBeUndefined();
  });

  it("asks twice for a live booking, ends the visit link and says who to tell", async () => {
    const w = await setup();
    await booked(w);
    await yes(w);
    const file = readFixer(w.root);
    file.jobs[0]!.booking!.visitToken = "hash";
    writeFixer(w.root, file);
    const first = await w.desk.cancelJob({ jobId: w.job().id });
    expect(first.structured!.question).toContain("Joe's Plumbing");
    expect(w.job().state).toBe("booked");
    const second = await w.desk.cancelJob({ jobId: w.job().id, confirmation: codeOf(first) });
    expect(second.structured!.tellPro).toEqual({ name: "Joe's Plumbing", reach: { phone: "+15555550142" } });
    expect(w.job().state).toBe("cancelled");
    expect(w.job().cancelledAt).toBe(NOW.toISOString());
    expect(w.job().booking!.visitToken).toBeUndefined();
    expect(w.job().rotationAsked).toBeUndefined();
  });

  it("adds the rotation question when the code was shown", async () => {
    const w = await setup();
    await booked(w);
    await yes(w);
    const file = readFixer(w.root);
    file.jobs[0]!.booking!.revealedAt = [NOW.toISOString()];
    writeFixer(w.root, file);
    await yes0(w);
    expect(w.job().rotationAsked).toEqual({ at: NOW.toISOString() });
    const asks = ((await w.desk.checkFixes({})).structured as { rotationAsk: { question: string }[] }).rotationAsk;
    expect(asks).toEqual([{ jobId: w.job().id, question: "Joe's Plumbing knows the door code. Want to change it? Set the new code on the lock, then save it here." }]);
    expect(readFileSync(join(w.root, FIXER_FILE), "utf8")).not.toContain(CODE);
  });

  it("turning off with cancel lists the pros to tell", async () => {
    const w = await setup();
    await booked(w);
    await yes(w);
    const reply = await w.desk.turnOff(true);
    expect(reply.structured!.tellPro).toEqual([{ name: "Joe's Plumbing", reach: { phone: "+15555550142" } }]);
    expect(w.job().state).toBe("cancelled");
  });
});

/** A cancel in two calls. */
async function yes0(w: World) {
  const first = await w.desk.cancelJob({ jobId: w.job().id });
  return w.desk.cancelJob({ jobId: w.job().id, confirmation: codeOf(first) });
}
