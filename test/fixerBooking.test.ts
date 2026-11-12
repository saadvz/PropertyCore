import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixerDeskFor, resetFixerDesks, type FixerDeps } from "../src/fixer-core/desk";
import { setCalendarFetch } from "../src/hub/calendarFetch";
import { FIXER_FILE, readFixer, writeFixer } from "../src/fixer-core/store";
import { hubFor, resetHubs } from "../src/hub/hub";
import { STAYS_UNREAD, STAYS_UNREAD_BOOK } from "../src/fixer-core/texts";

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

type Opts = { code?: boolean; costLine?: number; quotesFirst?: boolean; locksmith?: boolean; cleanings?: FixerDeps["cleanings"]; /** Every calendar read fails, so the stays are never read. */ unread?: boolean };

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
  await desk.saveSettings({ upkeepDone: true });
  expect((await desk.activate()).isError).toBe(false);
  if (opts.unread) setCalendarFetch(async (url) => ({ status: 500, url, async text() { return ""; } }));
  else serve(ics());
  const lock = opts.locksmith === true;
  await desk.openJob({ trade: lock ? "locksmith" : "plumbing", what: lock ? "Lock sticks" : "Sink leaks", urgency: "soon", source: "host", ...(opts.costLine ? { costLineCents: opts.costLine } : {}), ...(opts.quotesFirst ? { quotesFirst: true as const } : {}), ...(lock ? { doorLock: true as const } : {}) });
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

  it("refuses a booked outcome on a quotes-only job, and keeps the quote", async () => {
    const w = await setup({ quotesFirst: true });
    const token = await w.contact();
    const refused = await w.desk.recordContact({ contactToken: token, outcome: "booked", ...TUE, estimateCents: 18000 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe("This repair is getting quotes first. Record what they quoted with outcome quoted, put any time they offered in the note, and tell them you'll call back.");
    expect(w.job().booking).toBeUndefined();
    expect((await w.desk.recordContact({ contactToken: token, outcome: "quoted", quoteCents: 15000, note: "Can come Tuesday" })).isError).toBe(false);
    expect(w.job().contacts[0]!.quote).toEqual({ cents: 15000, note: "Can come Tuesday" });
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
    // After the cleaning leaves no room at 11 to 1, so the question says it is outside the open times.
    const after = await w.desk.approveBooking({ jobId: w.job().id, cleaningOrder: "after" });
    expect(after.structured!.question).toContain("That's outside the open times between stays.");
    const done = await yes(w, { cleaningOrder: "before" });
    expect(done.isError).toBe(false);
    expect(w.job().booking!.cleaningOrder).toBe("before");
    expect(w.job().cleaningOrder).toBe("before");
  });

  it("approves a held raised price with revised", async () => {
    // Over the $250 cost line, so the raised price waits for the host.
    const w = await setup({ costLine: 25_000 });
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

describe("holds in the question", () => {
  it("lets the host say yes to a time outside the open times, with the hold stated", async () => {
    const w = await setup();
    const token = await w.contact();
    await w.desk.recordContact({ contactToken: token, outcome: "booked", from: "2026-11-25T15:00:00.000Z", until: "2026-11-25T17:00:00.000Z", estimateCents: 18000 });
    expect(w.job().booking!.heldFor).toEqual(["outside-window"]);
    const first = await w.desk.approveBooking({ jobId: w.job().id });
    expect(first.structured!.question).toBe("Joe's Plumbing can come Wednesday 10 to 12, about $180. That's outside the open times between stays. Book it and let them in with the door code?");
    expect((await w.desk.approveBooking({ jobId: w.job().id, confirmation: codeOf(first) })).isError).toBe(false);
    expect(w.job().state).toBe("booked");
  });

  it("states the cost hold and the no-estimate hold", async () => {
    const w = await setup({ costLine: 10_000 });
    const over = await booked(w);
    expect(over.structured!.question).toBe("Joe's Plumbing can come Tuesday 10 to 12, about $180. That's over your $100 cost line. Book it and let them in with the door code?");
    const rita = await w.contact("Rita");
    await w.desk.recordContact({ contactToken: rita, outcome: "declined" });
    const none = await w.desk.recordContact({ contactToken: await w.contact("Joe"), outcome: "booked", ...TUE });
    expect(none.structured!.question).toBe("Joe's Plumbing can come Tuesday 10 to 12. They gave no estimate, and you have a $100 cost line. Book it and let them in with the door code?");
  });

  it("refuses the second call when the job got a cost line between the calls", async () => {
    const w = await setup();
    await booked(w);
    const first = await w.desk.approveBooking({ jobId: w.job().id });
    const file = readFixer(w.root);
    file.jobs[0]!.costLineCents = 10_000;
    writeFixer(w.root, file);
    expect((await w.desk.approveBooking({ jobId: w.job().id, confirmation: codeOf(first) })).isError).toBe(true);
    expect(w.job().state).toBe("contacted");
  });

  it("refuses a time that has already started, at the pro's yes and at the host's", async () => {
    const w = await setup();
    const token = await w.contact();
    const past = await w.desk.recordContact({ contactToken: token, outcome: "booked", from: "2026-11-08T14:00:00.000Z", until: "2026-11-08T16:00:00.000Z" });
    expect(past.isError).toBe(true);
    expect(past.text).toContain("already started");
    await booked(w, "Rita");
    const file = readFixer(w.root);
    file.jobs[0]!.booking!.from = "2026-11-08T14:00:00.000Z";
    writeFixer(w.root, file);
    const refused = await w.desk.approveBooking({ jobId: w.job().id });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("already started");
  });

  it("refuses a second call after the booking was re-recorded or the cleaning order changed", async () => {
    const w = await setup();
    await booked(w);
    const first = await w.desk.approveBooking({ jobId: w.job().id });
    await w.desk.recordContact({ contactToken: readFixer(w.root).jobs[0]!.contacts[0]!.token, outcome: "booked", from: "2026-11-10T16:00:00.000Z", until: "2026-11-10T18:00:00.000Z", estimateCents: 18000 });
    expect((await w.desk.approveBooking({ jobId: w.job().id, confirmation: codeOf(first) })).isError).toBe(true);
    const second = await w.desk.approveBooking({ jobId: w.job().id, cleaningOrder: "before" });
    expect((await w.desk.approveBooking({ jobId: w.job().id, cleaningOrder: "after", confirmation: codeOf(second) })).isError).toBe(true);
    expect(w.job().state).toBe("contacted");
  });

  it("asks for Google Calendar events on both calls when Google is saved", async () => {
    const w = await setup();
    await booked(w);
    hubFor(w.root, { now: () => NOW }).setCalendars({ calendars: [{ name: "Airbnb", url: LANE }], google: true, done: true });
    const first = await w.desk.approveBooking({ jobId: w.job().id });
    expect(first.isError).toBe(true);
    expect(first.text).toContain("googleEvents");
    const second = await w.desk.approveBooking({ jobId: w.job().id, confirmation: "ABCDEF" });
    expect(second.text).toContain("googleEvents");
    const given = await w.desk.approveBooking({ jobId: w.job().id, googleEvents: { items: [] } as never });
    expect(given.isError).toBe(false);
  });
});

describe("a pending booking and its pro", () => {
  it.each(["declined", "no-answer", "waiting"] as const)("drops the pending booking when its own pro says %s", async (outcome) => {
    const w = await setup();
    await booked(w);
    const token = readFixer(w.root).jobs[0]!.contacts[0]!.token;
    await w.desk.recordContact({ contactToken: token, outcome });
    expect(w.job().booking).toBeUndefined();
    expect((await w.desk.approveBooking({ jobId: w.job().id })).isError).toBe(true);
  });

  it("keeps other pros' yes for the host to choose, and tells the displaced pro", async () => {
    const w = await setup();
    await booked(w);
    const rita = await w.contact("Rita");
    await w.desk.recordContact({ contactToken: rita, outcome: "booked", from: "2026-11-11T15:00:00.000Z", until: "2026-11-11T17:00:00.000Z" });
    await w.desk.recordContact({ contactToken: readFixer(w.root).jobs[0]!.contacts[0]!.token, outcome: "declined" });
    const held = ((await w.desk.checkFixes({})).structured as { held: { proId?: string; others: { name: string }[] }[] }).held;
    expect(held).toEqual([expect.objectContaining({ others: [expect.objectContaining({ name: "Rita Rooter" })] })]);
    expect(held[0]!.proId).toBeUndefined();
    const chosen = await yes(w, { proId: w.pro("Rita").id });
    expect(chosen.isError).toBe(false);
    expect(w.job().booking!.proId).toBe(w.pro("Rita").id);
  });

  it("tells the displaced pending pro when the host picks another", async () => {
    const w = await setup();
    await booked(w);
    const rita = await w.contact("Rita");
    await w.desk.recordContact({ contactToken: rita, outcome: "booked", from: "2026-11-11T15:00:00.000Z", until: "2026-11-11T17:00:00.000Z" });
    const chosen = await yes(w, { proId: w.pro("Rita").id });
    expect(chosen.structured!.tellPro).toEqual({ name: "Joe's Plumbing", reach: { phone: "+15555550142" } });
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
    const reply = await cancelTwice(w);
    const question = "Joe's Plumbing knows the door code. Want to change it? Set the new code on the lock, then save it here.";
    expect(reply.structured!.rotationAsk).toEqual([{ jobId: w.job().id, question }]);
    expect(w.job().rotationAsked).toEqual({ at: NOW.toISOString(), proId: w.job().booking!.proId });
    const asks = ((await w.desk.checkFixes({})).structured as { rotationAsk: { question: string }[] }).rotationAsk;
    expect(asks).toEqual([{ jobId: w.job().id, question: "Joe's Plumbing knows the door code. Want to change it? Set the new code on the lock, then save it here." }]);
    expect(readFileSync(join(w.root, FIXER_FILE), "utf8")).not.toContain(CODE);
  });

  it("turning off with cancel carries the rotation question, since check_fixes is off", async () => {
    const w = await setup();
    await booked(w);
    await yes(w);
    const file = readFixer(w.root);
    file.jobs[0]!.booking!.revealedAt = [NOW.toISOString()];
    writeFixer(w.root, file);
    const reply = await w.desk.turnOff(true);
    expect(reply.structured!.rotationAsk).toEqual([expect.objectContaining({ jobId: w.job().id, question: expect.stringContaining("knows the door code") })]);
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
async function cancelTwice(w: World) {
  const first = await w.desk.cancelJob({ jobId: w.job().id });
  return w.desk.cancelJob({ jobId: w.job().id, confirmation: codeOf(first) });
}

describe("final review fixes: unknown stays, reschedule offers, removing a pro, turning off", () => {
  it("counts stays never read as unknown while calendars are saved: no windows, no booking, until a read", async () => {
    // Cleaner Core reads the calendars here, and its read never ran.
    const w = await setup({ unread: true, cleanings: async () => undefined });
    expect(hubFor(w.root, { now: () => NOW }).stays()).toBeUndefined();
    const fixes = (await w.desk.checkFixes({})).structured as { windows: Record<string, unknown[]>; windowsNext?: string };
    expect(fixes.windows[w.job().id]).toEqual([]);
    expect(fixes.windowsNext).toBe(STAYS_UNREAD);
    const token = await w.contact();
    const refused = await w.desk.recordContact({ contactToken: token, outcome: "booked", ...TUE, estimateCents: 18000 });
    expect(refused).toMatchObject({ isError: true, text: STAYS_UNREAD_BOOK });
    expect(w.job().booking).toBeUndefined();
    // A pending booking can't be approved while the stays are unknown either.
    const file = readFixer(w.root);
    file.jobs[0]!.booking = { proId: w.pro("Joe").id, ...TUE, estimateCents: 18000, access: "code", fingerprint: "fp" };
    writeFixer(w.root, file);
    expect(await w.desk.approveBooking({ jobId: w.job().id })).toMatchObject({ isError: true, text: STAYS_UNREAD_BOOK });
    expect(w.job().state).toBe("contacted");
    // Once a read works, check_fixes reads the calendars itself, though Cleaner Core owns reading here.
    serve(ics());
    const read = (await w.desk.checkFixes({})).structured as { windows: Record<string, unknown[]>; windowsNext?: string };
    expect(read.windowsNext).toBeUndefined();
    expect(read.windows[w.job().id]!.length).toBeGreaterThan(0);
    expect(hubFor(w.root, { now: () => NOW }).stays()).toEqual([]);
    expect(STAYS_UNREAD).toBe("The booking calendars haven't been read yet, so there are no visit times. Call check_fixes again (with googleEvents when the bookings are in Google Calendar), or check_now where Cleaner Core runs.");
    expect(STAYS_UNREAD_BOOK).toBe("The booking calendars haven't been read yet, so this time can't be checked against the stays. Call check_fixes first, then try again.");
  });

  it("a reschedule turns every booked offer into waiting, so none can be rebooked, and gives the pro's token", async () => {
    const w = await setup();
    const joeToken = await w.contact("Joe");
    await w.desk.recordContact({ contactToken: joeToken, outcome: "booked", ...TUE, estimateCents: 18000 });
    const rita = await w.contact("Rita");
    await w.desk.recordContact({ contactToken: rita, outcome: "booked", from: "2026-11-11T15:00:00.000Z", until: "2026-11-11T17:00:00.000Z" });
    expect((await yes(w)).isError).toBe(false);
    const first = await w.desk.rescheduleJob({ jobId: w.job().id });
    const moved = await w.desk.rescheduleJob({ jobId: w.job().id, confirmation: codeOf(first) });
    expect(moved.structured).toMatchObject({ rescheduled: true, contactToken: joeToken });
    for (const contact of w.job().contacts) {
      expect(contact).toMatchObject({ outcome: "waiting", followUpAt: new Date(NOW.getTime() + 24 * 60 * 60_000).toISOString() });
      expect(contact.booked).toBeUndefined();
    }
    const fixes = (await w.desk.checkFixes({})).structured as { held: unknown[]; contactNext: unknown[] };
    expect(fixes.held).toEqual([]);
    expect(fixes.contactNext).toEqual([]);
    for (const name of ["Joe", "Rita"]) expect((await w.desk.approveBooking({ jobId: w.job().id, proId: w.pro(name).id })).isError).toBe(true);
    expect((await w.desk.approveBooking({ jobId: w.job().id })).isError).toBe(true);
    // The same token takes the new time.
    const again = await w.desk.recordContact({ contactToken: joeToken, outcome: "booked", from: "2026-11-12T15:00:00.000Z", until: "2026-11-12T17:00:00.000Z" });
    expect(again.isError, again.text).toBe(false);
    expect(w.job().booking).toMatchObject({ proId: w.pro("Joe").id, from: "2026-11-12T15:00:00.000Z" });
  });

  it("refuses to remove a pro with a live booking or a pending contact", async () => {
    const w = await setup();
    await booked(w);
    expect(await w.desk.removePro({ id: w.pro("Joe").id })).toMatchObject({ isError: true, text: "Joe's Plumbing has a repair visit on a job. Cancel or reschedule their visit first." });
    await yes(w);
    expect(await w.desk.removePro({ id: w.pro("Joe").id })).toMatchObject({ isError: true, text: "Joe's Plumbing has a repair visit on a job. Cancel or reschedule their visit first." });
    await w.desk.openJob({ trade: "plumbing", what: "Tub drains slowly", urgency: "soon", source: "host" });
    const second = w.state().jobs[1]!;
    await w.desk.contactPro({ jobId: second.id, to: w.pro("Rita").id, how: "call" });
    expect(await w.desk.removePro({ id: w.pro("Rita").id })).toMatchObject({ isError: true, text: "Rita Rooter is still being contacted for a job. Record what they said with record_contact first." });
    const lou = await w.desk.removePro({ id: w.pro("Lou").id });
    expect(lou.isError).toBe(false);
    expect(lou.structured!.confirmation).toBeDefined();
  });

  it("turning off lists the pros still being contacted and closes their contacts", async () => {
    const w = await setup();
    await booked(w);
    await w.contact("Rita");
    const reply = await w.desk.turnOff(false);
    expect(reply.structured!.tellPro).toEqual([
      { name: "Joe's Plumbing", reach: { phone: "+15555550142" } },
      { name: "Rita Rooter", reach: { phone: "+15555550143" } },
    ]);
    expect(w.job().contacts.every((contact) => contact.cancelled)).toBe(true);
    expect(w.job().booking).toBeUndefined();
    await w.desk.turnOn();
    const fixes = (await w.desk.checkFixes({})).structured as { held: unknown[] };
    expect(fixes.held).toEqual([]);
    expect((await w.desk.approveBooking({ jobId: w.job().id })).isError).toBe(true);
  });

  it("turning off with cancel lists the booked pro and the pros still being contacted on other jobs", async () => {
    const w = await setup();
    await booked(w);
    await yes(w);
    await w.desk.openJob({ trade: "plumbing", what: "Tub drains slowly", urgency: "soon", source: "host" });
    await w.desk.contactPro({ jobId: w.state().jobs[1]!.id, to: w.pro("Rita").id, how: "call" });
    const reply = await w.desk.turnOff(true);
    expect(reply.structured!.tellPro).toEqual([
      { name: "Joe's Plumbing", reach: { phone: "+15555550142" } },
      { name: "Rita Rooter", reach: { phone: "+15555550143" } },
    ]);
  });
});
