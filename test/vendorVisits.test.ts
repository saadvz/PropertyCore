import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixerDeskFor, resetFixerDesks, type FixerDeps, type FixerReply } from "../src/fixer-core/desk";
import { readFixer } from "../src/fixer-core/store";
import { setCalendarFetch } from "../src/hub/calendarFetch";
import { hubFor, resetHubs } from "../src/hub/hub";
import { peopleFor, resetPeople } from "../src/hub/people";
import { FakeLockAdapter } from "../src/locks/fake";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { buildVisits } from "../src/visits/derive";
import { resetVisitLogCache, visitLogFor } from "../src/visits/store";

/**
 * Routine vendor visits (#237): a standing yes per upkeep item, the visit proposed by text, the vendor's YES or
 * new time, their own code moving with the window, and time on site. Fake lock adapter, 555 numbers, and
 * made-up codes that no assertion prints.
 */

const NOW = new Date("2026-12-20T15:00:00.000Z");
const PROPERTY = { nickname: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" };
const SAVED = ["7", "3", "0", "6"].join("");
const HOST = "+15555550100";
const BUGS = "+15555550177";
const JOE = "+15555550142";
const PROPERTY_ID = "prop_scratch";
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** Every 21 days from the save, opened 7 days ahead: due Sun 10 Jan 2027, proposed from Sun 3 Jan. */
const DUE = "2027-01-10";
/** The usual hours on the due date, 9 to 11 in New York. */
const DUE_VISIT = { from: "2027-01-10T14:00:00.000Z", until: "2027-01-10T16:00:00.000Z" };

const dirs: string[] = [];
afterEach(() => {
  setCalendarFetch(undefined);
  setLockAdapter(undefined);
  resetFixerDesks();
  resetHubs();
  resetPeople();
  resetVisitLogCache();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const codeOf = (reply: FixerReply): string | undefined => (reply.structured?.confirmation as { code: string } | undefined)?.code;

async function approved(call: (confirmation?: string) => Promise<FixerReply>): Promise<FixerReply> {
  const first = await call();
  const code = codeOf(first);
  return code ? call(code) : first;
}

interface Options {
  visitRecords?: boolean;
  locks?: boolean;
  stays?: [string, string][];
  /** Bug Busters said YES to texts. */
  optedIn?: boolean;
}

async function setup(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "vendor-"));
  const account = mkdtempSync(join(tmpdir(), "vendor-acct-"));
  dirs.push(root, account);
  let clock = new Date(NOW);
  const env: NodeJS.ProcessEnv = {
    CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64"),
    FIXER_CORE: "1",
    ...(options.visitRecords === false ? {} : { VISIT_RECORDS: "1" }),
    ...(options.locks === false ? {} : { SMART_LOCKS: "1" }),
  };
  const now = () => clock;
  const hub = hubFor(root, { now });
  hub.saveProperty(PROPERTY);
  hub.setCalendars({ calendars: [{ name: "Airbnb", url: "https://calendar.example/lane.ics" }], done: true });
  hub.doorAccess(() => env).save(SAVED, undefined, undefined);
  const fake = new FakeLockAdapter();
  if (options.locks !== false) {
    setLockAdapter(fake);
    const front = fake.addDevice("acct-1", { id: "dev-front", name: "Front door" });
    hub.doorAccess(() => env).saveLocks({ ...emptyLocks(), customerKey: "acct-1", devices: [storedDevice(front)], doors: [front.id], activeAt: NOW.toISOString(), release: { cleaners: "ask", pros: "ask" }, extend: "ask" });
  }
  const people = () => peopleFor(account, { now });
  people().savePropertyPeople(PROPERTY_ID, HOST, []);
  const sent: { to: string; body: string }[] = [];
  const notes: { id: string; text: string }[] = [];
  const deps: FixerDeps = {
    now,
    env: () => env,
    propertyId: PROPERTY_ID,
    people,
    publicBase: () => "https://fixer.example.com",
    photoKey: () => randomBytes(32),
    textsAllowed: async () => true,
    send: async (to, body) => {
      sent.push({ to, body });
      return true;
    },
    notifyHost: async (id, text) => {
      notes.push({ id, text });
    },
  };
  const desk = () => fixerDeskFor(root, deps);
  await desk().savePro({ name: "Bug Busters", trades: ["pest-control"], reach: { phone: BUGS, email: "office@bugbusters.example.com" }, prefersText: true, preferredFor: [{ trade: "pest-control", rank: 1 }] });
  await desk().savePro({ name: "Joe's Plumbing", trades: ["plumbing"], reach: { phone: JOE }, preferredFor: [{ trade: "plumbing", rank: 1 }] });
  await desk().saveSettings({ prosDone: true });
  await desk().saveSettings({ upkeepDone: true });
  expect((await desk().activate()).isError).toBe(false);
  if (options.optedIn !== false) people().optIn(BUGS, PROPERTY_ID);
  const ics = ["BEGIN:VCALENDAR", ...(options.stays ?? []).flatMap(([a, b], i) => ["BEGIN:VEVENT", `UID:s${i}`, `DTSTART;VALUE=DATE:${a.replaceAll("-", "")}`, `DTEND;VALUE=DATE:${b.replaceAll("-", "")}`, "SUMMARY:Guest", "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
  setCalendarFetch(async (url) => ({ status: 200, url, async text() { return ics; } }));
  await desk().checkFixes({});
  const pro = (name: string) => readFixer(root).pros.find((p) => p.name === name)!;
  const standing = (over: Record<string, unknown> = {}) => ({ proId: pro("Bug Busters").id, from: "09:00", until: "11:00", access: "code" as const, usualCents: 12000, ...over });
  const savePest = async (over: Record<string, unknown> = {}) =>
    approved((confirmation) => desk().saveUpkeep({ trade: "pest-control", what: "Pest control", schedule: { kind: "every", days: 21 }, leadDays: 7, standing: standing(over), ...(confirmation ? { confirmation } : {}) } as never));
  const job = () => readFixer(root).jobs.at(-1);
  const text = (body: string, id = `msg-${Math.random()}`) => desk().proInbound({ id, from: BUGS, text: body });
  const news = () => [...(readFixer(root).news ?? []), ...readFixer(root).jobs.flatMap((j) => j.news)].map((item) => item.text ?? "");
  const toBugs = () => sent.filter((s) => s.to === BUGS).map((s) => s.body);
  const log = () => visitLogFor(root, now);
  const visits = () => buildVisits(log().read(), { timeZone: PROPERTY.timeZone, codeNames: log().codeNames(), now: clock }).visits;
  return { root, env, desk, people, fake, sent, notes, pro, standing, savePest, job, text, news, toBugs, log, visits, at: (iso: string | number) => (clock = new Date(iso)) };
}

describe("the standing yes", () => {
  it("always takes two calls, even before the visit, and its question names the vendor and their own code", async () => {
    const w = await setup();
    const first = await w.desk().saveUpkeep({ trade: "pest-control", what: "Pest control", schedule: { kind: "every", days: 21 }, leadDays: 7, standing: w.standing() } as never);
    expect(first.isError).toBe(false);
    const question = (first.structured?.confirmation as { question?: string } | undefined)?.question ?? String(first.structured?.question ?? "");
    expect(question).toContain("Bug Busters");
    expect(question).toMatch(/own door code/);
    expect(readFixer(w.root).upkeep).toEqual([]);
    expect((await w.savePest()).isError).toBe(false);
    const item = readFixer(w.root).upkeep[0]!;
    expect(item.standing).toMatchObject({ proId: w.pro("Bug Busters").id, from: "09:00", until: "11:00", access: "code", usualCents: 12000 });
    expect(item.standing!.yesAt).toBe(NOW.toISOString());
    expect(item.proId).toBe(w.pro("Bug Busters").id);
  });

  it("is refused for a pro who doesn't text on the line, and for hours backwards or over 4 hours", async () => {
    const w = await setup();
    const joe = w.pro("Joe's Plumbing").id;
    expect((await w.savePest({ proId: joe })).isError).toBe(true);
    expect((await w.savePest({ from: "11:00", until: "09:00" })).isError).toBe(true);
    expect((await w.savePest({ from: "08:00", until: "13:00" })).isError).toBe(true);
    expect((await w.savePest({ from: "9am" })).isError).toBe(true);
    expect(readFixer(w.root).upkeep).toEqual([]);
  });

  it("is refused with visit records off", async () => {
    const w = await setup({ visitRecords: false });
    const reply = await w.savePest();
    expect(reply.isError).toBe(true);
    expect(readFixer(w.root).upkeep).toEqual([]);
  });

  it("is withdrawn with standing: null, and the item stays", async () => {
    const w = await setup();
    await w.savePest();
    const id = readFixer(w.root).upkeep[0]!.id;
    const reply = await approved((confirmation) => w.desk().saveUpkeep({ id, trade: "pest-control", what: "Pest control", schedule: { kind: "every", days: 21 }, leadDays: 7, standing: null, ...(confirmation ? { confirmation } : {}) } as never));
    expect(reply.isError).toBe(false);
    expect(readFixer(w.root).upkeep[0]!.standing).toBeUndefined();
  });
});

/** The day the proposal opens: 7 days before the due date, 8 AM local. */
const LEAD = "2027-01-03T13:00:00.000Z";

describe("proposing a routine visit", () => {
  it("texts the vendor once when the visit comes due, with no code on the lock and no visit window yet", async () => {
    const w = await setup();
    await w.savePest();
    w.at(Date.parse(LEAD) - DAY);
    await w.desk().tick();
    expect(w.toBugs()).toEqual([]);
    expect(w.job()).toBeUndefined();
    w.at(LEAD);
    await w.desk().tick();
    expect(w.toBugs()).toEqual(["Hi Bug, pest control at 12 Scratch Lane is due. Can you come Sun, Jan 10, 9 to 11 AM? Reply YES, or send another day and time."]);
    const job = w.job()!;
    expect(job).toMatchObject({ source: "upkeep", state: "booked", trade: "pest-control" });
    expect(job.booking).toMatchObject({ ...DUE_VISIT, access: "code", estimateCents: 12000 });
    expect(job.booking!.vendor!.proposedAt).toBe(LEAD);
    expect(job.booking!.vendor!.confirmedAt).toBeUndefined();
    expect(w.fake.liveCodes("dev-front")).toEqual([]);
    expect(w.log().read().filter((e) => e.type === "visit-window")).toEqual([]);
    expect(w.log().read().filter((e) => e.type === "message").map((e) => (e as { label: string }).label)).toEqual(["window-proposed"]);
    expect(w.notes).toEqual([]);
  });

  it("never sends a second proposal across ticks and a restart", async () => {
    const w = await setup();
    await w.savePest();
    w.at(LEAD);
    await w.desk().tick();
    await w.desk().tick();
    resetFixerDesks();
    w.at(Date.parse(LEAD) + DAY);
    await w.desk().tick();
    expect(w.toBugs().length).toBe(1);
    expect(readFixer(w.root).jobs.length).toBe(1);
  });

  it("moves a busy due date to the next day that fits", async () => {
    const w = await setup({ stays: [["2027-01-09", "2027-01-11"]] });
    await w.savePest();
    w.at(LEAD);
    await w.desk().tick();
    expect(w.toBugs()[0]).toContain("Tue, Jan 12, 9 to 11 AM");
  });

  it("asks the host once when no day in the next week fits, and leaves the upkeep to today's flow", async () => {
    const w = await setup({ stays: [["2027-01-08", "2027-01-20"]] });
    await w.savePest();
    w.at(LEAD);
    await w.desk().tick();
    await w.desk().tick();
    expect(w.toBugs()).toEqual([]);
    expect(w.job()).toBeUndefined();
    expect(w.news().filter((t) => t.includes("usual hours don't fit"))).toHaveLength(1);
    const fixes = await w.desk().checkFixes({});
    expect(JSON.stringify(fixes.structured)).toContain("upkeepDue");
  });

  it("proposes nothing to a vendor who hasn't said YES to texts, or with visit records off", async () => {
    const quiet = await setup({ optedIn: false });
    await quiet.savePest();
    quiet.at(LEAD);
    await quiet.desk().tick();
    expect(quiet.toBugs()).toEqual([]);
    expect(quiet.job()).toBeUndefined();

    const off = await setup();
    await off.savePest();
    delete off.env.VISIT_RECORDS;
    off.at(LEAD);
    await off.desk().tick();
    expect(off.toBugs()).toEqual([]);
    expect(off.job()).toBeUndefined();
  });

  it("an unconfirmed visit never starts: no code text, no code on the lock, no late news", async () => {
    const w = await setup();
    await w.savePest();
    w.at(LEAD);
    await w.desk().tick();
    for (const t of [Date.parse(DUE_VISIT.from) - 30 * MIN, Date.parse(DUE_VISIT.from) + 45 * MIN, Date.parse(DUE_VISIT.until) + MIN]) {
      w.at(t);
      await w.desk().tick();
    }
    expect(w.toBugs().length).toBe(1);
    expect(w.fake.liveCodes("dev-front")).toEqual([]);
    expect(w.job()!.state).toBe("booked");
    expect(w.log().read().filter((e) => e.type === "visit-window")).toEqual([]);
  });
});

/** Proposes the due visit and gives back the world. */
async function proposed(options: Options = {}) {
  const w = await setup(options);
  await w.savePest();
  w.at(LEAD);
  await w.desk().tick();
  w.at(Date.parse(LEAD) + 60 * MIN);
  return w;
}

describe("the vendor's reply", () => {
  it("YES confirms: their own code is made, the window goes in the visit log, they're thanked, the host hears once", async () => {
    const w = await proposed();
    await w.text("Yes", "m1");
    const booking = w.job()!.booking!;
    expect(booking.vendor!.confirmedAt).toBeDefined();
    const live = w.fake.liveCodes("dev-front");
    expect(live).toHaveLength(1);
    expect(live[0]!.window).toEqual({ from: new Date(Date.parse(DUE_VISIT.from) - 30 * MIN).toISOString(), until: DUE_VISIT.until });
    expect(w.toBugs().at(-1)).toBe("Thanks, see you Sun, Jan 10, 9 to 11 AM. Your door code comes by text when the visit starts.");
    expect(w.news().filter((t) => t.startsWith("Bug Busters confirmed pest control for Sun, Jan 10"))).toHaveLength(1);
    await w.desk().tick();
    const windows = w.log().read().filter((e) => e.type === "visit-window");
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ visit: `repair:${w.job()!.id}`, ...DUE_VISIT });
    // A second YES confirms nothing new.
    await w.text("YES", "m2");
    expect(w.news().filter((t) => t.includes("confirmed pest control"))).toHaveLength(1);
    const code = live[0]!.code;
    expect(w.sent.some((s) => s.body.includes(code) || s.body.includes(SAVED))).toBe(false);
  });

  it("a new time that fits moves the visit and confirms it, with an echo and one host line", async () => {
    const w = await proposed();
    await w.text("Can we do Tuesday 1 to 3 instead?");
    const booking = w.job()!.booking!;
    expect({ from: booking.from, until: booking.until }).toEqual({ from: "2027-01-12T18:00:00.000Z", until: "2027-01-12T20:00:00.000Z" });
    expect(booking.vendor!.confirmedAt).toBeDefined();
    expect(w.toBugs().at(-1)).toBe("Moved to Tue, Jan 12, 1 to 3 PM. Your door code comes by text when the visit starts.");
    expect(w.news().filter((t) => t === "Bug Busters moved pest control to Tue, Jan 12, 1 to 3 PM.")).toHaveLength(1);
    expect(w.fake.liveCodes("dev-front")[0]!.window.until).toBe("2027-01-12T20:00:00.000Z");
  });

  it("after YES, a move moves the same code on the lock, not a new one", async () => {
    const w = await proposed();
    await w.text("YES");
    const before = w.fake.liveCodes("dev-front");
    await w.text("Actually Monday 9 to 11 works better");
    const after = w.fake.liveCodes("dev-front");
    expect(after).toHaveLength(1);
    expect(after[0]!.codeId).toBe(before[0]!.codeId);
    expect(after[0]!.window).toEqual({ from: "2027-01-11T13:30:00.000Z", until: "2027-01-11T16:00:00.000Z" });
  });

  it("a time that doesn't fit changes nothing: the vendor is told the host will check, the host is asked", async () => {
    const w = await proposed({ stays: [["2027-01-13", "2027-01-16"]] });
    await w.text("Thursday 9-11?");
    const booking = w.job()!.booking!;
    expect({ from: booking.from, until: booking.until }).toEqual(DUE_VISIT);
    expect(booking.vendor!.confirmedAt).toBeUndefined();
    expect(booking.vendor!.held).toMatchObject({ from: "2027-01-14T14:00:00.000Z", until: "2027-01-14T16:00:00.000Z" });
    expect(w.toBugs().at(-1)).toBe("Thanks, I'll check that time with the host and text you back.");
    expect(w.news().filter((t) => t.includes("asked to move pest control to Thu, Jan 14"))).toHaveLength(1);
    expect(w.fake.liveCodes("dev-front")).toEqual([]);
  });

  it("NO or words it can't read go to the host as news, and change nothing", async () => {
    const w = await proposed();
    await w.text("Sorry we can't that week, call me 5555550177");
    expect(w.job()!.booking!.vendor!.confirmedAt).toBeUndefined();
    expect(w.job()!.booking!.from).toBe(DUE_VISIT.from);
    const said = w.news().filter((t) => t.includes("can't that week"));
    expect(said).toHaveLength(1);
    expect(said[0]!.includes("5555550177")).toBe(false);
  });

  it("takes at most 3 moves by text; a fourth goes to the host", async () => {
    const w = await proposed();
    await w.text("Monday 9 to 11");
    await w.text("Tuesday 9 to 11");
    await w.text("Wednesday 9 to 11");
    await w.text("Thursday 9 to 11");
    const booking = w.job()!.booking!;
    expect(booking.vendor!.moves).toHaveLength(3);
    expect(booking.from).toBe("2027-01-13T14:00:00.000Z");
    expect(booking.vendor!.held).toBeDefined();
  });

  it("no answer: one host note 48 hours before the visit, and still no code", async () => {
    const w = await proposed();
    w.at(Date.parse(DUE_VISIT.from) - 49 * 60 * MIN);
    await w.desk().tick();
    expect(w.news().filter((t) => t.includes("hasn't answered"))).toHaveLength(0);
    w.at(Date.parse(DUE_VISIT.from) - 48 * 60 * MIN);
    await w.desk().tick();
    await w.desk().tick();
    expect(w.news().filter((t) => t === "Bug Busters hasn't answered about pest control on Sun, Jan 10, 9 to 11 AM. No code goes out until they confirm.")).toHaveLength(1);
    expect(w.fake.liveCodes("dev-front")).toEqual([]);
  });

  it("only the vendor's own opted-in phone moves the visit: not after their STOP, not from another number", async () => {
    const w = await proposed();
    await w.desk().proInbound({ id: "other", from: "+15555550199", text: "Tuesday 1 to 3" });
    expect(w.job()!.booking!.from).toBe(DUE_VISIT.from);
    await w.text("STOP");
    await w.text("Tuesday 1 to 3");
    await w.text("YES");
    expect(w.job()!.booking!.from).toBe(DUE_VISIT.from);
    expect(w.job()!.booking!.vendor!.confirmedAt).toBeUndefined();
    expect(w.fake.liveCodes("dev-front")).toEqual([]);
  });

  it("a replayed YES or move does nothing a second time", async () => {
    const w = await proposed();
    await w.text("Tuesday 1 to 3", "same");
    await w.text("Tuesday 1 to 3", "same");
    expect(w.job()!.booking!.vendor!.moves).toHaveLength(1);
    expect(w.toBugs().filter((b) => b.startsWith("Moved to"))).toHaveLength(1);
  });
});

describe("move_vendor_visit", () => {
  const move = (w: Awaited<ReturnType<typeof setup>>, span: { from: string; until: string }, confirmation?: string) => w.desk().moveVendorVisit({ jobId: w.job()!.id, ...span, ...(confirmation ? { confirmation } : {}) });

  it("moves at once when the vendor's time fits, and texts them the echo", async () => {
    const w = await proposed();
    const reply = await move(w, { from: "2027-01-12T18:00:00.000Z", until: "2027-01-12T20:00:00.000Z" });
    expect(reply.isError).toBe(false);
    expect(w.job()!.booking!.from).toBe("2027-01-12T18:00:00.000Z");
    expect(w.job()!.booking!.vendor!.moves!.at(-1)!.by).toBe("agent");
    expect(w.toBugs().at(-1)).toBe("Moved to Tue, Jan 12, 1 to 3 PM. Your door code comes by text when the visit starts.");
  });

  it("outside the open times takes the host's two-call yes", async () => {
    const w = await proposed();
    const late = { from: "2027-01-25T14:00:00.000Z", until: "2027-01-25T16:00:00.000Z" };
    const first = await move(w, late);
    expect(first.isError).toBe(false);
    expect(codeOf(first)).toBeDefined();
    expect(w.job()!.booking!.from).toBe(DUE_VISIT.from);
    expect((await move(w, late, codeOf(first))).isError).toBe(false);
    expect(w.job()!.booking!.from).toBe(late.from);
    expect(w.job()!.booking!.vendor!.moves!.at(-1)!.by).toBe("host");
  });

  it("never moves a visit over a stay, even with the host's code", async () => {
    const w = await proposed({ stays: [["2027-01-13", "2027-01-16"]] });
    const over = { from: "2027-01-14T14:00:00.000Z", until: "2027-01-14T16:00:00.000Z" };
    const first = await move(w, over);
    expect(first.isError).toBe(true);
    expect(w.job()!.booking!.from).toBe(DUE_VISIT.from);
  });

  it("refuses a job that isn't a routine vendor's visit", async () => {
    const w = await proposed();
    await w.desk().openJob({ trade: "plumbing", what: "Sink leaks", urgency: "soon", source: "host" });
    const reply = await move(w, { from: "2027-01-12T18:00:00.000Z", until: "2027-01-12T20:00:00.000Z" });
    expect(reply.isError).toBe(true);
  });
});

describe("two routine pest-control visits, end to end on the fake lock", () => {
  it("proposes, confirms or moves, issues and ends the code, and measures time on site for each", async () => {
    const { fixerRows, readRecords } = await import("../src/hours-log/sources");
    const w = await setup();
    await w.savePest();

    /** One visit: proposal, the vendor's reply, the code text, an unlock with their code, DONE, a lock from outside. */
    const visit = async (lead: string, reply: string, expected: { from: string; until: string }, arriveAfter: number, minutesOnSite: number) => {
      w.at(lead);
      await w.desk().tick();
      const job = w.job()!;
      expect(job.booking!.vendor!.proposedAt).toBe(lead);
      expect(w.fake.liveCodes("dev-front")).toEqual([]);
      w.at(Date.parse(lead) + 2 * 60 * MIN);
      await w.text(reply);
      expect({ from: w.job()!.booking!.from, until: w.job()!.booking!.until }).toEqual(expected);
      const [code] = w.fake.liveCodes("dev-front");
      expect(code!.window).toEqual({ from: new Date(Date.parse(expected.from) - 30 * MIN).toISOString(), until: expected.until });
      // The code goes by text when the window opens, to the vendor only.
      w.at(Date.parse(expected.from) - 30 * MIN);
      await w.desk().tick();
      const codeTexts = w.sent.filter((s) => s.body.includes(code!.code));
      expect(codeTexts.map((s) => s.to)).toEqual([BUGS]);
      const arrive = Date.parse(expected.from) + arriveAfter * MIN;
      w.log().append({ type: "lock", id: `unlock-${job.id}`, at: new Date(arrive).toISOString(), device: "Front door", action: "unlock", side: "outside", codeName: code!.name, method: "keypad" });
      w.at(arrive + minutesOnSite * MIN);
      await w.text("DONE");
      expect(w.job()!.state).toBe("done");
      w.log().append({ type: "lock", id: `lock-${job.id}`, at: new Date(arrive + (minutesOnSite + 2) * MIN).toISOString(), device: "Front door", action: "lock", side: "outside" });
      await w.desk().tick();
      // The code is gone once the visit is done.
      expect(w.fake.liveCodes("dev-front")).toEqual([]);
      const record = w.visits().find((v) => v.id === `repair:${job.id}`)!;
      expect(record.arrival).toMatchObject({ source: "lock" });
      expect(record.departure).toMatchObject({ source: "done-pro-text", lockCheck: "matched" });
      expect(record.minutes).toBe(minutesOnSite + 2);
      return job.id;
    };

    const first = await visit(LEAD, "YES", DUE_VISIT, 10, 45);
    // Done on 10 Jan: the next visit is due 31 Jan, proposed from 24 Jan; the vendor moves it to Monday 1 Feb.
    const second = await visit("2027-01-24T13:00:00.000Z", "Can we do Monday 1 to 3?", { from: "2027-02-01T18:00:00.000Z", until: "2027-02-01T20:00:00.000Z" }, 5, 50);

    const rows = fixerRows(readRecords(w.root)).filter((row) => row.kind === "repair-visit");
    for (const id of [first, second]) expect(rows.find((row) => row.reference.includes(id))).toMatchObject({ timing: "measured" });
    // A visit under a standing yes is not a fresh approval by the host each time.
    expect(fixerRows(readRecords(w.root)).filter((row) => row.actor === "host" && [first, second].some((id) => row.reference.includes(id)))).toEqual([]);
    // No text to anyone but the vendor, and none holds the saved code.
    expect(w.sent.every((s) => s.to === BUGS && !s.body.includes(SAVED))).toBe(true);
  });
});
