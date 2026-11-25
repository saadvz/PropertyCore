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
import { ACCOUNT_FEATURES } from "../src/features/features";
import { buildVisits } from "../src/visits/derive";
import { resetVisitLogCache, visitLogFor } from "../src/visits/store";
import { deskFeatures } from "./featureEnv";

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
    ...deskFeatures(...(options.visitRecords === false ? [] : (["visits"] as const)), ...(options.locks === false ? [] : (["locks"] as const))),
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

  it("texts a vendor who is also the property's cleaner the same proposal, and their YES confirms it", async () => {
    const w = await setup();
    w.people().savePropertyPeople(PROPERTY_ID, HOST, [{ phone: BUGS, role: "cleaner", name: "Bug" }]);
    expect(w.people().rolesOn(BUGS, PROPERTY_ID).sort()).toEqual(["cleaner", "pro"]);
    await w.savePest();
    w.at(LEAD);
    await w.desk().tick();
    expect(w.toBugs()).toEqual(["Hi Bug, pest control at 12 Scratch Lane is due. Can you come Sun, Jan 10, 9 to 11 AM? Reply YES, or send another day and time."]);
    await w.text("YES", "m1");
    expect(w.job()!.booking!.vendor!.confirmedAt).toBeDefined();
    expect(w.fake.liveCodes("dev-front")).toHaveLength(1);
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
    const fixes = (await w.desk().checkFixes({})).structured as { upkeepDue: { upkeepId: string }[]; routineVisits: unknown[] };
    expect(fixes.upkeepDue.map((entry) => entry.upkeepId)).toEqual([readFixer(w.root).upkeep[0]!.id]);
    expect(fixes.routineVisits).toEqual([]);
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
    off.env[ACCOUNT_FEATURES] = "locks";
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
    // Past its end, never confirmed, it's called off rather than started.
    expect(w.job()!.state).toBe("cancelled");
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
    expect(w.toBugs().at(-1)).toBe("Thanks, see you Sun, Jan 10, 9 to 11 AM. You'll get your door code by text when the visit starts.");
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
    expect(w.toBugs().at(-1)).toBe("Done, you're moved to Tue, Jan 12, 1 to 3 PM. You'll get your door code by text when the visit starts.");
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
    const w = await proposed();
    // Past the days looked at for this visit: outside the open times, not over a stay.
    await w.text("Jan 25, 9-11?");
    const booking = w.job()!.booking!;
    expect({ from: booking.from, until: booking.until }).toEqual(DUE_VISIT);
    expect(booking.vendor!.confirmedAt).toBeUndefined();
    expect(booking.vendor!.held).toMatchObject({ from: "2027-01-25T14:00:00.000Z", until: "2027-01-25T16:00:00.000Z" });
    expect(w.toBugs().at(-1)).toBe("Thanks, I'll check that time with the host and text you back.");
    expect(w.news().filter((t) => t.includes("asked to move pest control to Mon, Jan 25"))).toHaveLength(1);
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
    expect(w.news().filter((t) => t.startsWith("Bug Busters hasn't answered about pest control on Sun, Jan 10, 9 to 11 AM. No code goes out until they confirm."))).toHaveLength(1);
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
    expect(w.toBugs().filter((b) => b.startsWith("Done, you're moved to"))).toHaveLength(1);
  });
});

describe("review fixes", () => {
  it("a reply with the proposed time confirms like YES: the vendor is thanked and the host hears once", async () => {
    const w = await proposed();
    await w.text("9 to 11 works");
    expect(w.job()!.booking!.vendor!.confirmedAt).toBeDefined();
    expect(w.toBugs().at(-1)).toBe("Thanks, see you Sun, Jan 10, 9 to 11 AM. You'll get your door code by text when the visit starts.");
    expect(w.news().filter((t) => t.startsWith("Bug Busters confirmed pest control"))).toHaveLength(1);
  });

  it("a time over a stay is never offered to the host: the vendor is asked for another time", async () => {
    const w = await proposed({ stays: [["2027-01-13", "2027-01-16"]] });
    await w.text("Thursday 9-11?");
    expect(w.job()!.booking!.vendor!.held).toBeUndefined();
    expect(w.toBugs().at(-1)).toBe("Sorry, 12 Scratch Lane isn't free then. Could you send another day and time?");
    expect(w.news().some((t) => t.includes("Move it anyway"))).toBe(false);
    expect(w.news().filter((t) => t.includes("asked for Thu, Jan 14") && t.includes("guest stay"))).toHaveLength(1);
  });

  it("a fourth move that fits is held with its own question", async () => {
    const w = await proposed();
    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday"]) await w.text(`${day} 9 to 11`);
    expect(w.news().filter((t) => t === "Bug Busters wants to move pest control again, to Thu, Jan 14, 9 to 11 AM. That would be move 4. Okay?")).toHaveLength(1);
  });

  it("an unanswered visit is called off at its end, once, and the next date comes due", async () => {
    const w = await proposed();
    w.at(Date.parse(DUE_VISIT.until) + MIN);
    await w.desk().tick();
    await w.desk().tick();
    const first = readFixer(w.root).jobs[0]!;
    expect(first.state).toBe("cancelled");
    expect(w.news().filter((t) => t.includes("never confirmed"))).toHaveLength(1);
    // Due 31 Jan (21 days on), proposed from 24 Jan.
    w.at("2027-01-24T13:00:00.000Z");
    await w.desk().tick();
    expect(readFixer(w.root).jobs).toHaveLength(2);
    expect(w.toBugs().at(-1)).toContain("Sun, Jan 31, 9 to 11 AM");
  });

  it("the standing yes question says how often, and a schedule change drops the standing yes", async () => {
    const w = await setup();
    const first = await w.desk().saveUpkeep({ trade: "pest-control", what: "Pest control", schedule: { kind: "every", days: 21 }, leadDays: 7, standing: w.standing() } as never);
    expect(String(first.structured?.question)).toContain("every 21 days");
    await w.savePest();
    const id = readFixer(w.root).upkeep[0]!.id;
    await approved((confirmation) => w.desk().saveUpkeep({ id, trade: "pest-control", what: "Pest control", schedule: { kind: "every", days: 7 }, leadDays: 7, ...(confirmation ? { confirmation } : {}) } as never));
    expect(readFixer(w.root).upkeep[0]!.standing).toBeUndefined();
  });

  it("the host's own yes to move a vendor's visit is in the hours log", async () => {
    const { fixerRows, readRecords } = await import("../src/hours-log/sources");
    const w = await proposed();
    const late = { from: "2027-01-25T14:00:00.000Z", until: "2027-01-25T16:00:00.000Z" };
    await approved((confirmation) => w.desk().moveVendorVisit({ jobId: w.job()!.id, ...late, ...(confirmation ? { confirmation } : {}) }));
    expect(fixerRows(readRecords(w.root)).filter((row) => row.kind === "reschedule-repair" && row.actor === "host")).toHaveLength(1);
  });

  it("a proposal that didn't send isn't logged as proposed", async () => {
    const w = await setup();
    await w.savePest();
    const desk = w.desk() as unknown as { deps: { send: () => Promise<boolean> } };
    desk.deps.send = async () => false;
    w.at(LEAD);
    await w.desk().tick();
    expect(w.log().read().filter((e) => e.type === "message")).toEqual([]);
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
    expect(w.toBugs().at(-1)).toBe("Done, you're moved to Tue, Jan 12, 1 to 3 PM. You'll get your door code by text when the visit starts.");
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

describe("a standing yes is enough (24 Nov live run)", () => {
  type Fixes = { upkeepDue: { upkeepId: string }[]; routineVisits: { upkeepId: string; nextDate: string; proName: string; next: string }[]; needsGo: unknown[] };
  const fixes = async (w: Awaited<ReturnType<typeof setup>>) => (await w.desk().checkFixes({})).structured as Fixes;
  const openFor = (w: Awaited<ReturnType<typeof setup>>) =>
    w.desk().openJob({ trade: "pest-control", what: "Pest control", urgency: "by-date", byDate: DUE, source: "upkeep", sourceRef: readFixer(w.root).upkeep[0]!.id });

  it("check_fixes lists the due visit under routineVisits, never upkeepDue, and open_job for it is refused", async () => {
    const w = await setup();
    await w.savePest();
    // Due, and the clock pass hasn't proposed it yet: the agent is told the vendor gets it, not to open a job.
    w.at(LEAD);
    const before = await fixes(w);
    expect(before.upkeepDue).toEqual([]);
    expect(before.routineVisits).toEqual([{ upkeepId: readFixer(w.root).upkeep[0]!.id, what: "Pest control", nextDate: DUE, proName: "Bug Busters", next: "Fixer Core texts Bug Busters this visit's date on its own. Don't open a job or ask the host: the standing yes covers it." }]);
    const refused = await openFor(w);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("standing yes");
    expect(w.job()).toBeUndefined();
    // The clock pass then proposes it, with the host's yes and the usual price already on it: no go, no cost line.
    await w.desk().tick();
    expect(w.toBugs()).toHaveLength(1);
    expect(w.job()).toMatchObject({ hostGo: { at: readFixer(w.root).upkeep[0]!.standing!.yesAt }, standingYes: { upkeepId: readFixer(w.root).upkeep[0]!.id } });
    expect(w.job()!.booking).toMatchObject({ estimateCents: 12000, hostYes: { at: readFixer(w.root).upkeep[0]!.standing!.yesAt } });
    const after = await fixes(w);
    expect(after.upkeepDue).toEqual([]);
    expect(after.routineVisits).toEqual([]);
    expect(after.needsGo).toEqual([]);
    expect(w.notes).toEqual([]);
  });

  it("says what the proposal waits on while the vendor hasn't said YES to texts, and still opens no job", async () => {
    const w = await setup({ optedIn: false });
    await w.savePest();
    w.at(LEAD);
    await w.desk().tick();
    const listed = await fixes(w);
    expect(listed.upkeepDue).toEqual([]);
    expect(listed.routineVisits.map((entry) => entry.next)).toEqual(["Bug Busters hasn't said YES to texts from the line yet, so the visit is texted once they do. Don't open a job or ask the host: the standing yes covers it."]);
    expect((await openFor(w)).isError).toBe(true);
    // Once they say YES, the next pass proposes it.
    w.people().optIn(BUGS, PROPERTY_ID);
    await w.desk().tick();
    expect(w.toBugs()).toHaveLength(1);
  });

  it("goes back to today's flow when the vendor can't be texted at all, or visit records are off", async () => {
    const stopped = await setup();
    await stopped.savePest();
    stopped.people().stop(BUGS);
    stopped.at(LEAD);
    expect((await fixes(stopped)).upkeepDue).toHaveLength(1);
    expect((await fixes(stopped)).routineVisits).toEqual([]);
    expect((await openFor(stopped)).isError).toBe(false);

    const off = await setup();
    await off.savePest();
    off.env[ACCOUNT_FEATURES] = "locks";
    off.at(LEAD);
    expect((await fixes(off)).upkeepDue).toHaveLength(1);
    expect((await openFor(off)).isError).toBe(false);
  });
});

describe("a schedule that starts today", () => {
  const TODAY = "2026-12-20";
  const saveFrom = (w: Awaited<ReturnType<typeof setup>>, firstDate: string | undefined, hours = { from: "13:00", until: "15:00" }) =>
    approved((confirmation) => w.desk().saveUpkeep({ trade: "pest-control", what: "Pest control", schedule: { kind: "every", days: 90 }, leadDays: 7, standing: w.standing(hours), ...(firstDate ? { firstDate } : {}), ...(confirmation ? { confirmation } : {}) } as never));

  it("without a first date, every 90 days lands a full period out", async () => {
    const w = await setup();
    const saved = await saveFrom(w, undefined);
    expect(saved.structured!.nextDates).toEqual(["2027-03-20", "2027-06-18", "2027-09-16"]);
    await w.desk().tick();
    expect(w.toBugs()).toEqual([]);
  });

  it("with today as the first date, the question says so and today's usual hours are proposed at once", async () => {
    const w = await setup();
    const first = await w.desk().saveUpkeep({ trade: "pest-control", what: "Pest control", schedule: { kind: "every", days: 90 }, leadDays: 7, standing: w.standing({ from: "13:00", until: "15:00" }), firstDate: TODAY } as never);
    const question = (first.structured?.confirmation as { question?: string } | undefined)?.question ?? String(first.structured?.question ?? "");
    expect(question).toContain("every 90 days, starting Sun, Dec 20,");
    const saved = await saveFrom(w, TODAY);
    expect(saved.structured!.nextDates).toEqual(["2026-12-20", "2027-03-20", "2027-06-18"]);
    await w.desk().tick();
    expect(w.toBugs()).toEqual(["Hi Bug, pest control at 12 Scratch Lane is due. Can you come Sun, Dec 20, 1 to 3 PM? Reply YES, or send another day and time."]);
    expect(w.job()!.booking).toMatchObject({ from: "2026-12-20T18:00:00.000Z", until: "2026-12-20T20:00:00.000Z" });
  });

  it("moves to tomorrow when today's usual hours have already started, and runs on from the first date once done", async () => {
    const w = await setup();
    await saveFrom(w, TODAY, { from: "09:00", until: "11:00" });
    await w.desk().tick();
    expect(w.toBugs()[0]).toContain("Mon, Dec 21, 9 to 11 AM");
    await w.text("YES", "y1");
    w.at("2026-12-21T15:30:00.000Z");
    await w.desk().tick();
    expect((await w.desk().recordDone({ jobId: w.job()!.id } as never)).isError).toBe(false);
    const item = readFixer(w.root).upkeep[0]!;
    expect(item.lastDoneAt).toBeDefined();
    // Done on Dec 21: the next visit is 90 days after it, and it isn't due yet.
    w.at("2027-03-01T15:00:00.000Z");
    await w.desk().tick();
    expect(w.toBugs().filter((body) => body.includes("is due."))).toHaveLength(1);
    w.at("2027-03-14T15:00:00.000Z");
    await w.desk().tick();
    expect(w.toBugs().filter((body) => body.includes("is due.")).at(-1)).toContain("Mar 21");
  });

  it("refuses a first date in the past or more than a year out", async () => {
    const w = await setup();
    expect((await saveFrom(w, "2026-12-19")).isError).toBe(true);
    expect((await saveFrom(w, "2027-12-22")).isError).toBe(true);
    expect(readFixer(w.root).upkeep).toEqual([]);
  });
});

describe("the host passes on a vendor's yes (#243 ruling, extended 25 Nov)", () => {
  it("confirm_visit takes the host's two-call yes on a proposed visit, records the host and how, and makes the code", async () => {
    const w = await proposed();
    const jobId = w.job()!.id;
    const asked = await w.desk().confirmVisit({ jobId, via: "call" });
    expect(asked.isError).toBe(false);
    expect(codeOf(asked)).toBeDefined();
    expect(w.job()!.booking!.vendor!.confirmedAt).toBeUndefined();
    expect(w.fake.liveCodes("dev-front")).toEqual([]);
    const done = await approved((confirmation) => w.desk().confirmVisit({ jobId, via: "call", ...(confirmation ? { confirmation } : {}) }));
    expect(done.structured).toMatchObject({ confirmed: true, by: "host", via: "call" });
    const booking = w.job()!.booking!;
    expect(booking.vendor!.confirmedAt).toBeDefined();
    expect(booking.confirmed).toMatchObject({ by: "host", via: "call" });
    // The standing yes is the host's OK for the code, as with the vendor's own YES.
    expect(booking.codeYes).toBeDefined();
    await w.desk().tick();
    expect(w.fake.liveCodes("dev-front")).toHaveLength(1);
    const code = w.fake.liveCodes("dev-front")[0]!.code;
    expect(JSON.stringify(done)).not.toContain(code);
    expect(w.sent.some((s) => s.body.includes(code) || s.body.includes(SAVED))).toBe(false);
  });

  it("the vendor's text YES after the host's changes nothing and sends nothing", async () => {
    const w = await proposed();
    const jobId = w.job()!.id;
    await approved((confirmation) => w.desk().confirmVisit({ jobId, via: "email", ...(confirmation ? { confirmation } : {}) }));
    const before = w.toBugs().length;
    await w.text("YES", "after-host");
    expect(w.toBugs().length).toBe(before);
    expect(w.job()!.booking!.confirmed).toMatchObject({ by: "host", via: "email" });
    expect(w.news().filter((t) => t.includes("confirmed pest control"))).toHaveLength(0);
  });

  it("a visit the vendor already confirmed by text answers already, with nothing new on record", async () => {
    const w = await proposed();
    await w.text("Yes", "m1");
    const confirmedAt = w.job()!.booking!.vendor!.confirmedAt;
    const reply = await w.desk().confirmVisit({ jobId: w.job()!.id, via: "call" });
    expect(reply.structured).toMatchObject({ confirmed: true, already: true });
    expect(w.job()!.booking!.confirmed).toBeUndefined();
    expect(w.job()!.booking!.vendor!.confirmedAt).toBe(confirmedAt);
  });

  it("a vendor who replied STOP can still be confirmed by the host, and gets no text", async () => {
    const w = await proposed();
    await w.text("STOP");
    const before = w.toBugs().length;
    await approved((confirmation) => w.desk().confirmVisit({ jobId: w.job()!.id, via: "call", ...(confirmation ? { confirmation } : {}) }));
    await w.desk().tick();
    expect(w.job()!.booking!.vendor!.confirmedAt).toBeDefined();
    expect(w.fake.liveCodes("dev-front")).toHaveLength(1);
    expect(w.toBugs().length).toBe(before);
  });

  it("the 48-hour note offers the host's way", async () => {
    const w = await proposed();
    w.at(Date.parse(DUE_VISIT.from) - 48 * 60 * MIN);
    await w.desk().tick();
    expect(w.news()).toContain("Bug Busters hasn't answered about pest control on Sun, Jan 10, 9 to 11 AM. No code goes out until they confirm. If they told you yes another way, tell me and I'll make their code.");
  });
});
