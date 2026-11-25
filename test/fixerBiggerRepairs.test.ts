import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixerDeskFor, resetFixerDesks } from "../src/fixer-core/desk";
import { setCalendarFetch } from "../src/hub/calendarFetch";
import { readFixer, type Job } from "../src/fixer-core/store";
import { hubFor, resetHubs } from "../src/hub/hub";

/** Bigger repairs (#243): repair blocks, urgent visits during a stay, crew schedules. Made-up pros, 555 numbers, a made-up door code. */

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

type Event = [checkIn: string, checkout: string, summary?: string];
const ics = (events: Event[]) =>
  ["BEGIN:VCALENDAR", ...events.flatMap(([a, b, summary], i) => ["BEGIN:VEVENT", `UID:e${i}`, `DTSTART;VALUE=DATE:${a.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${b.replace(/-/g, "")}`, `SUMMARY:${summary ?? "Guest"}`, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
const serve = (events: Event[]) => setCalendarFetch(async (url) => ({ status: 200, url, async text() { return ics(events); } }));
const codeOf = (reply: { structured?: Record<string, unknown> }): string => (reply.structured!.confirmation as { code: string }).code;

/** An activated property with a ranked plumber, a door code, the given calendar, and one host job open. */
async function setup(opts: { events?: Event[]; urgency?: Job["urgency"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fixer-big-"));
  dirs.push(root);
  const hub = hubFor(root, { now: () => NOW });
  hub.saveProperty(PROPERTY);
  hub.setCalendars({ calendars: [{ name: "Airbnb", url: LANE }], done: true });
  hub.doorAccess(env).save(CODE, undefined, undefined);
  let now = NOW;
  const desk = () => fixerDeskFor(root, { now: () => now, env });
  await desk().savePro({ name: "Joe's Plumbing", trades: ["plumbing"], reach: { phone: "+15555550142" }, preferredFor: [{ trade: "plumbing", rank: 1 }] });
  await desk().saveSettings({ prosDone: true });
  await desk().saveSettings({ upkeepDone: true });
  expect((await desk().activate()).isError).toBe(false);
  serve(opts.events ?? []);
  await desk().openJob({ trade: "plumbing", what: "Sink leaks", urgency: opts.urgency ?? "soon", source: "host" });
  await desk().checkFixes({});
  const state = () => readFixer(root);
  const job = () => state().jobs[0]!;
  const pro = () => state().pros[0]!;
  const contact = async () => (await desk().contactPro({ jobId: job().id, to: pro().id, how: "call" })).structured!.contactToken as string;
  const setNow = (iso: string) => {
    now = new Date(iso);
  };
  return { root, desk, state, job, pro, contact, setNow };
}

/** Calls a two-call tool: the question, then the same input with the host's code. */
async function twice<T extends object>(call: (input: T & { confirmation?: string }) => Promise<{ isError?: boolean; structured?: Record<string, unknown> }>, input: T) {
  const first = await call(input);
  if (first.isError || !first.structured?.confirmation) return first;
  return call({ ...input, confirmation: codeOf(first) });
}

type World = Awaited<ReturnType<typeof setup>>;
const BLOCK = { firstDay: "2026-11-16", lastDay: "2026-11-20" };
/** Tuesday 10 to 12 in New York, inside the block. */
const TUE = { from: "2026-11-17T15:00:00.000Z", until: "2026-11-17T17:00:00.000Z" };

describe("repair blocks", () => {
  it("saves a block in two calls and says the dates still need closing on the calendar", async () => {
    const w = await setup();
    const first = await w.desk().saveRepairBlock(BLOCK);
    expect(first.structured!.question).toBeDefined();
    expect(w.state().repairBlocks ?? []).toEqual([]);
    const saved = await w.desk().saveRepairBlock({ ...BLOCK, confirmation: codeOf(first) });
    expect(saved.isError).toBe(false);
    expect(saved.structured).toMatchObject({ onCalendar: false, openNights: ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"], collisions: [] });
    expect(saved.structured!.blockId).toMatch(/^blk_[a-z0-9]+$/);
    expect(String(saved.structured!.next)).toContain("booking calendar");
    expect(w.state().repairBlocks).toHaveLength(1);
  });

  it("refuses bad days, more than 92 days, an unknown job, and an eleventh block", async () => {
    const w = await setup();
    expect((await w.desk().saveRepairBlock({ firstDay: "2026-11-31", lastDay: "2026-12-02" })).isError).toBe(true);
    expect((await w.desk().saveRepairBlock({ firstDay: "2026-11-10", lastDay: "2027-02-10" })).isError).toBe(true);
    expect((await w.desk().saveRepairBlock({ ...BLOCK, jobIds: ["job_nothere000"] })).isError).toBe(true);
    for (let i = 0; i < 10; i++) {
      const day = `2026-12-${String(i + 10).padStart(2, "0")}`;
      expect((await twice((input) => w.desk().saveRepairBlock(input), { firstDay: day, lastDay: day })).isError).toBe(false);
    }
    expect((await w.desk().saveRepairBlock(BLOCK)).isError).toBe(true);
  });

  it("lets a pro be booked inside a saved block that is on the calendar", async () => {
    const w = await setup({ events: [["2026-11-16", "2026-11-21", "Blocked"]] });
    const held = await w.desk().recordContact({ contactToken: await w.contact(), outcome: "booked", ...TUE, estimateCents: 18000 });
    expect(held.structured!.heldFor).toEqual(["outside-window", "overlaps-stay"]);
    await w.desk().cancelJob({ jobId: w.job().id, reason: "test" });

    await twice((input) => w.desk().saveRepairBlock(input), BLOCK);
    await w.desk().openJob({ trade: "plumbing", what: "Pipe in the wall", urgency: "soon", source: "host" });
    const job = w.state().jobs[1]!;
    const token = (await w.desk().contactPro({ jobId: job.id, to: w.pro().id, how: "call" })).structured!.contactToken as string;
    const reply = await w.desk().recordContact({ contactToken: token, outcome: "booked", ...TUE, estimateCents: 18000 });
    expect(reply.structured!.heldFor).toBeUndefined();
    expect(reply.structured!.question).toBeDefined();
  });

  it("tells the host once about open nights, and once, urgently, about a guest stay inside the block", async () => {
    const w = await setup({ events: [["2026-11-19", "2026-11-23"]] });
    await twice((input) => w.desk().saveRepairBlock(input), BLOCK);
    const first = (await w.desk().checkFixes({})).structured!.news as { kind: string; urgent?: true }[];
    expect(first.filter((n) => n.kind === "repair-block-open")).toHaveLength(1);
    expect(first.filter((n) => n.kind === "repair-block-collision")).toEqual([expect.objectContaining({ urgent: true })]);
    const again = (await w.desk().checkFixes({})).structured!.news as { kind: string }[];
    expect(again.filter((n) => n.kind.startsWith("repair-block"))).toEqual([]);
  });

  it("lists blocks and who the door is for in get_fixer_state", async () => {
    const w = await setup({ events: [["2026-11-16", "2026-11-21", "Blocked"]] });
    await twice((input) => w.desk().saveRepairBlock(input), BLOCK);
    const summary = (await w.desk().state()).structured!.summary as Record<string, unknown>;
    expect(summary.repairBlocks).toEqual([expect.objectContaining({ ...BLOCK, onCalendar: true, openNights: [], collisions: [] })]);
    expect(summary.doorNow).toBe("none");
  });

  it("removes a block in two calls", async () => {
    const w = await setup();
    const saved = await twice((input) => w.desk().saveRepairBlock(input), BLOCK);
    const blockId = saved.structured!.blockId as string;
    const removed = await twice((input) => w.desk().removeRepairBlock(input), { blockId });
    expect(removed.isError).toBe(false);
    expect(w.state().repairBlocks).toEqual([]);
  });
});

describe("an urgent visit during a stay", () => {
  /** A guest stays Sunday to Friday; the visit is Tuesday 10 to 12. */
  const STAY: Event = ["2026-11-15", "2026-11-20"];
  const AGREED = { from: "2026-11-17T14:00:00.000Z", until: "2026-11-17T18:00:00.000Z" };
  const urgent = () => setup({ events: [STAY], urgency: "now" });
  const offer = async (w: World, span = TUE) => w.desk().recordContact({ contactToken: await w.contact(), outcome: "booked", ...span, estimateCents: 18000 });
  const guestYes = (w: World, window = AGREED) => w.desk().recordGuestAnswer({ jobId: w.job().id, answer: "yes", ...window, via: "text" });
  const approve = (w: World) => twice((input) => w.desk().approveBooking(input), { jobId: w.job().id, confirmedVia: "call" as const });
  async function bookedUrgent() {
    const w = await urgent();
    await offer(w);
    await guestYes(w);
    expect((await approve(w)).structured).toMatchObject({ booked: true });
    return w;
  }

  it("asks for the guest's okay before the host's question", async () => {
    const w = await urgent();
    const reply = await offer(w);
    expect(reply.structured!.question).toBeUndefined();
    expect(String(reply.structured!.next)).toContain("record_guest_answer");
    expect(reply.structured!.heldFor).toContain("overlaps-stay");
  });

  it("gives the host's question once the guest agreed, and books it with the stay", async () => {
    const w = await urgent();
    await offer(w);
    expect((await w.desk().recordGuestAnswer({ jobId: w.job().id, answer: "asked", via: "text" })).isError).toBe(false);
    const reply = await guestYes(w);
    expect(reply.structured!.question).toBe("Joe's Plumbing can come Tuesday 10 to 12, about $180. It's during the guest's stay, and the guest agreed to this time. Book it and let them in with the door code?");
    expect((await approve(w)).structured).toMatchObject({ booked: true });
    expect(w.job().booking!.urgentStay).toBe("2026-11-15|2026-11-20");
    expect(w.job().guest!.asked).toHaveLength(1);
    const open = ((await w.desk().state()).structured!.summary as { openJobs: Record<string, unknown>[] }).openJobs;
    expect(open[0]).toMatchObject({ guestAnswer: "yes" });
  });

  it("never books over a stay for a job that isn't urgent", async () => {
    const w = await setup({ events: [STAY] });
    const reply = await offer(w);
    expect(String(reply.structured!.next)).toContain("overlaps a guest stay");
    expect((await w.desk().recordGuestAnswer({ jobId: w.job().id, answer: "yes", ...AGREED, via: "text" })).isError).toBe(true);
    expect((await w.desk().approveBooking({ jobId: w.job().id })).isError).toBe(true);
  });

  it("refuses a visit over 4 hours or past checkout, with the reason", async () => {
    const long = await urgent();
    const tooLong = await offer(long, { from: "2026-11-17T14:00:00.000Z", until: "2026-11-17T19:00:00.000Z" });
    expect(String(tooLong.structured!.next)).toContain("at most 4 hours");
    const late = await urgent();
    const pastCheckout = await offer(late, { from: "2026-11-20T14:00:00.000Z", until: "2026-11-20T17:00:00.000Z" });
    expect(String(pastCheckout.structured!.next)).toContain("past the guest's checkout");
  });

  it("refuses the host's yes when the guest agreed to a shorter window", async () => {
    const w = await urgent();
    await offer(w);
    const reply = await guestYes(w, { from: "2026-11-17T15:30:00.000Z", until: "2026-11-17T18:00:00.000Z" });
    expect(reply.structured!.question).toBeUndefined();
    expect((await w.desk().approveBooking({ jobId: w.job().id })).isError).toBe(true);
  });

  it("shows the code from the visit's start, with no early lead", async () => {
    const w = await bookedUrgent();
    w.setNow("2026-11-17T14:50:00.000Z");
    expect(await w.desk().revealCode(w.job().id)).toEqual({ ok: false, reason: "before-visit" });
    w.setNow("2026-11-17T15:00:00.000Z");
    expect(await w.desk().revealCode(w.job().id)).toMatchObject({ ok: true, code: CODE });
  });

  it("stops the code when the guest says no, and tells the host urgently", async () => {
    const w = await bookedUrgent();
    w.setNow("2026-11-17T15:10:00.000Z");
    const no = await w.desk().recordGuestAnswer({ jobId: w.job().id, answer: "no", via: "host" });
    expect(no.isError).toBe(false);
    expect(await w.desk().revealCode(w.job().id)).toEqual({ ok: false, reason: "guest-not-agreed" });
    const news = (await w.desk().checkFixes({})).structured!.news as { kind: string; urgent?: true }[];
    expect(news.filter((n) => n.kind === "guest-withdrew")).toEqual([expect.objectContaining({ urgent: true })]);
  });

  it("needs a new yes for more time than the guest agreed to", async () => {
    const w = await bookedUrgent();
    w.setNow("2026-11-17T16:30:00.000Z");
    const extended = await twice((input) => w.desk().extendVisit(input), { jobId: w.job().id, until: "2026-11-17T19:00:00.000Z" });
    expect(extended.isError).toBe(false);
    expect(String(extended.structured!.next)).toContain("record_guest_answer");
    expect(await w.desk().revealCode(w.job().id)).toEqual({ ok: false, reason: "guest-not-agreed" });
    await guestYes(w, { from: "2026-11-17T14:00:00.000Z", until: "2026-11-17T19:00:00.000Z" });
    expect(await w.desk().revealCode(w.job().id)).toMatchObject({ ok: true });
  });

  it("isn't held or told as a stay over the visit", async () => {
    const w = await bookedUrgent();
    const body = (await w.desk().checkFixes({})).structured!;
    expect(body.held).toEqual([]);
    expect((body.news as { kind: string }[]).filter((n) => n.kind === "stay-over-booking")).toEqual([]);
  });

  it("gives the platform a timeline with no code or phone in it", async () => {
    const w = await bookedUrgent();
    w.setNow("2026-11-17T15:00:00.000Z");
    await w.desk().revealCode(w.job().id);
    const reply = await w.desk().urgentTimeline({ jobId: w.job().id });
    const entries = reply.structured!.timeline as { kind: string; text: string }[];
    expect(entries.map((e) => e.kind)).toEqual(["reported", "guest-agreed", "host-yes", "code-shown"]);
    const text = JSON.stringify(reply);
    expect(text).not.toContain(CODE);
    expect(text).not.toContain("5555550142");
  });
});

describe("a crew's schedule", () => {
  const WEEK = { firstDay: "2026-11-16", lastDay: "2026-11-20", workdays: ["MON", "TUE", "WED", "THU", "FRI"] as ("MON" | "TUE" | "WED" | "THU" | "FRI")[], start: "08:00", end: "17:00" };
  const SPAN = { from: "2026-11-16T13:00:00.000Z", until: "2026-11-20T22:00:00.000Z" };
  const save = (w: World) => twice((input) => w.desk().saveCrewSchedule(input), { jobId: w.job().id, ...WEEK });
  const offer = async (w: World, span: { from: string; until: string }) => w.desk().recordContact({ contactToken: await w.contact(), outcome: "booked", ...span, estimateCents: 400000 });

  it("saves in two calls and answers each workday's window", async () => {
    const w = await setup();
    const first = await w.desk().saveCrewSchedule({ jobId: w.job().id, ...WEEK });
    expect(first.structured!.question).toContain("Mon, Tue, Wed, Thu, Fri, 8 AM to 5 PM");
    // Crew-day codes (#243) exist now, so the question no longer says the host lets the crew in until they do.
    expect(first.structured!.question).not.toMatch(/crew codes exist/);
    const reply = await w.desk().saveCrewSchedule({ jobId: w.job().id, ...WEEK, confirmation: codeOf(first) });
    expect(reply.structured).toMatchObject({ saved: true, workdays: 5, first: { day: "2026-11-16", from: SPAN.from, until: "2026-11-16T22:00:00.000Z" }, span: SPAN, conflicts: [] });
    expect(w.job().crew).toEqual(WEEK);
    const open = ((await w.desk().state()).structured!.summary as { openJobs: Record<string, unknown>[] }).openJobs;
    expect(open[0]).toMatchObject({ crew: WEEK });
  });

  it("refuses a schedule once a visit is booked", async () => {
    const w = await setup();
    await offer(w, TUE);
    await twice((input) => w.desk().approveBooking(input), { jobId: w.job().id });
    expect((await w.desk().saveCrewSchedule({ jobId: w.job().id, ...WEEK })).isError).toBe(true);
  });

  it("books the whole schedule only, and the host lets the crew in", async () => {
    const w = await setup();
    await save(w);
    const wrong = await offer(w, TUE);
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain("books its saved schedule");
    const right = await w.desk().recordContact({ contactToken: w.job().contacts[0]!.token, outcome: "booked", ...SPAN, estimateCents: 400000 });
    expect(right.structured).toMatchObject({ access: "host" });
    expect(String(right.structured!.question)).toMatch(/you'll let them in\?$/);
    expect((await w.desk().approveBooking({ jobId: w.job().id, access: "code" })).isError).toBe(true);
    expect((await twice((input) => w.desk().approveBooking(input), { jobId: w.job().id })).structured).toMatchObject({ booked: true, access: "host" });
  });

  it("refuses the booking when a guest stay touches a workday", async () => {
    const w = await setup({ events: [["2026-11-18", "2026-11-19"]] });
    const saved = await save(w);
    expect((saved.structured!.conflicts as unknown[]).length).toBeGreaterThan(0);
    const reply = await offer(w, SPAN);
    expect(reply.structured!.question).toBeUndefined();
    expect(String(reply.structured!.next)).toContain("overlaps a guest stay");
  });
});

describe("review fixes", () => {
  const WEEK = { firstDay: "2026-11-16", lastDay: "2026-11-20", workdays: ["MON", "TUE", "WED", "THU", "FRI"] as ("MON" | "TUE" | "WED" | "THU" | "FRI")[], start: "08:00", end: "17:00" };
  const SPAN = { from: "2026-11-16T13:00:00.000Z", until: "2026-11-20T22:00:00.000Z" };

  it("never shows the code inside a calendar block, which can be a guest booking a calendar labels Not available", async () => {
    const w = await setup({ events: [["2026-11-16", "2026-11-21", "CLOSED - Not available"]] });
    await twice((input) => w.desk().saveRepairBlock(input), BLOCK);
    const offer = await w.desk().recordContact({ contactToken: await w.contact(), outcome: "booked", ...TUE, estimateCents: 18000 });
    expect(offer.structured).toMatchObject({ access: "host" });
    expect((await w.desk().approveBooking({ jobId: w.job().id, access: "code" })).isError).toBe(true);
    await twice((input) => w.desk().approveBooking(input), { jobId: w.job().id });
    w.setNow("2026-11-17T15:00:00.000Z");
    expect((await w.desk().revealCode(w.job().id)).ok).toBe(false);
  });

  it("refuses a new crew schedule while a booking waits, and checks the span again at the host's yes", async () => {
    const w = await setup();
    await twice((input) => w.desk().saveCrewSchedule(input), { jobId: w.job().id, ...WEEK });
    await w.desk().recordContact({ contactToken: await w.contact(), outcome: "booked", ...SPAN, estimateCents: 400000 });
    expect((await w.desk().saveCrewSchedule({ jobId: w.job().id, ...WEEK, firstDay: "2026-11-30", lastDay: "2026-12-04" })).isError).toBe(true);
  });

  it("says a crew booking runs over several days in the host's question", async () => {
    const w = await setup();
    await twice((input) => w.desk().saveCrewSchedule(input), { jobId: w.job().id, ...WEEK });
    const reply = await w.desk().recordContact({ contactToken: await w.contact(), outcome: "booked", ...SPAN, estimateCents: 400000 });
    expect(reply.structured!.question).toBe("Joe's Plumbing can come Monday 8 to Friday 5, about $4,000. That's the crew's schedule: Mon, Tue, Wed, Thu, Fri, 8 AM to 5 PM. Book it and you'll let them in?");
  });
});

describe("review fixes: urgent visits", () => {
  const STAY: Event = ["2026-11-15", "2026-11-20"];
  const AGREED = { from: "2026-11-17T14:00:00.000Z", until: "2026-11-17T18:00:00.000Z" };
  async function bookedUrgent() {
    const w = await setup({ events: [STAY], urgency: "now" });
    await w.desk().recordContact({ contactToken: await w.contact(), outcome: "booked", ...TUE, estimateCents: 18000 });
    await w.desk().recordGuestAnswer({ jobId: w.job().id, answer: "yes", ...AGREED, via: "text" });
    await twice((input) => w.desk().approveBooking(input), { jobId: w.job().id, confirmedVia: "call" as const });
    return w;
  }

  it("after the guest's no, says the pro already saw the code, asks about changing it, and a later yes doesn't reopen it", async () => {
    const w = await bookedUrgent();
    w.setNow("2026-11-17T15:05:00.000Z");
    expect((await w.desk().revealCode(w.job().id)).ok).toBe(true);
    w.setNow("2026-11-17T15:10:00.000Z");
    const no = await w.desk().recordGuestAnswer({ jobId: w.job().id, answer: "no", via: "text" });
    expect(no.structured!.rotationAsk).toBeDefined();
    const news = (await w.desk().checkFixes({})).structured!.news as { kind: string; text?: string }[];
    expect(news.find((n) => n.kind === "guest-withdrew")!.text).toContain("already saw the door code");
    await w.desk().recordGuestAnswer({ jobId: w.job().id, answer: "yes", ...AGREED, via: "text" });
    expect(await w.desk().revealCode(w.job().id)).toEqual({ ok: false, reason: "guest-not-agreed" });
  });

  it("refuses to extend an urgent visit past checkout or beyond 4 hours", async () => {
    const w = await bookedUrgent();
    expect((await w.desk().extendVisit({ jobId: w.job().id, until: "2026-11-17T20:00:00.000Z" })).isError).toBe(true);
  });
});

describe("minor fixes: urgent visits", () => {
  const offerAndApprove = async (w: World, span: { from: string; until: string }, agreed: { from: string; until: string }) => {
    await w.desk().recordContact({ contactToken: await w.contact(), outcome: "booked", ...span, estimateCents: 18000 });
    const yes = await w.desk().recordGuestAnswer({ jobId: w.job().id, answer: "yes", ...agreed, via: "text" });
    await twice((input) => w.desk().approveBooking(input), { jobId: w.job().id, confirmedVia: "call" as const });
    return yes;
  };

  it("waits for the guests_left check when an earlier stay checks out the day of the visit", async () => {
    const w = await setup({ events: [["2026-11-10", "2026-11-15"], ["2026-11-15", "2026-11-20"]], urgency: "now" });
    // Sunday 3:30 to 5:30 PM, as the next guests arrive.
    await offerAndApprove(w, { from: "2026-11-15T20:30:00.000Z", until: "2026-11-15T22:30:00.000Z" }, { from: "2026-11-15T20:00:00.000Z", until: "2026-11-15T23:00:00.000Z" });
    expect(w.job().booking!.urgentStay).toBe("2026-11-15|2026-11-20");
    w.setNow("2026-11-15T20:30:00.000Z");
    expect(await w.desk().revealCode(w.job().id)).toEqual({ ok: false, reason: "guests-not-left" });
    await w.desk().guestsLeft({ confirmed: true });
    expect(await w.desk().revealCode(w.job().id)).toMatchObject({ ok: true, code: CODE });
  });

  it("doesn't wait for guests_left on the urgent stay's own checkout morning, since that guest agreed", async () => {
    const w = await setup({ events: [["2026-11-15", "2026-11-20"]], urgency: "now" });
    // Friday 9 to 10:30 AM, before the 11 AM checkout.
    const span = { from: "2026-11-20T14:00:00.000Z", until: "2026-11-20T15:30:00.000Z" };
    await offerAndApprove(w, span, span);
    expect(w.job().booking!.urgentStay).toBe("2026-11-15|2026-11-20");
    w.setNow("2026-11-20T14:00:00.000Z");
    expect(await w.desk().revealCode(w.job().id)).toMatchObject({ ok: true, code: CODE });
  });

  it("tells the host once, urgently, when the stay an urgent visit was approved for changes or leaves the calendar", async () => {
    const w = await setup({ events: [["2026-11-15", "2026-11-20"]], urgency: "now" });
    await offerAndApprove(w, TUE, { from: "2026-11-17T14:00:00.000Z", until: "2026-11-17T18:00:00.000Z" });
    serve([]);
    const news = (await w.desk().checkFixes({})).structured!.news as { kind: string; text?: string; urgent?: true }[];
    const gone = news.filter((n) => n.kind === "urgent-stay-changed");
    expect(gone).toEqual([expect.objectContaining({ urgent: true })]);
    expect(gone[0]!.text).toContain("Joe's Plumbing");
    expect(gone[0]!.text).toContain("door code won't go out");
    const again = (await w.desk().checkFixes({})).structured!.news as { kind: string }[];
    expect(again.filter((n) => n.kind === "urgent-stay-changed")).toEqual([]);
    w.setNow("2026-11-17T15:00:00.000Z");
    expect((await w.desk().revealCode(w.job().id)).ok).toBe(false);
  });

  it("keeps the outside-window sentence when the visit is outside the open times for another reason than the stay", async () => {
    const w = await setup({ events: [["2026-11-15", "2026-12-10"]], urgency: "now" });
    // Wednesday 11-25 10 to 12: inside the stay, and past the 14 days an urgent job looks ahead.
    await w.desk().recordContact({ contactToken: await w.contact(), outcome: "booked", from: "2026-11-25T15:00:00.000Z", until: "2026-11-25T17:00:00.000Z", estimateCents: 18000 });
    const yes = await w.desk().recordGuestAnswer({ jobId: w.job().id, answer: "yes", from: "2026-11-25T14:00:00.000Z", until: "2026-11-25T18:00:00.000Z", via: "text" });
    expect(String(yes.structured!.question)).toContain("outside the open times");
    expect(String(yes.structured!.question)).toContain("the guest agreed to this time");
  });
});
