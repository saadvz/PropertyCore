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
import { emptyLocks, storedDevice, type ReleaseMode } from "../src/locks/settings";

/**
 * Fixer Core on connected locks (#180): the pro's own code for each booked visit, made at the host's
 * yes, moved with an extension, revoked on a cancel or Fixer off. Fake lock adapter, 555 numbers, and
 * made-up codes that no assertion prints.
 */

const NOW = new Date("2026-11-08T15:00:00.000Z");
const PROPERTY = { nickname: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" };
const SAVED = ["7", "3", "0", "6"].join("");
const HOST = "+15555550100";
const JOE = "+15555550142";
const PROPERTY_ID = "prop_scratch";
/** Tuesday 10 to 12 local. */
const TUE = { from: "2026-11-10T15:00:00.000Z", until: "2026-11-10T17:00:00.000Z" };
const MIN = 60_000;

const dirs: string[] = [];
afterEach(() => {
  setCalendarFetch(undefined);
  setLockAdapter(undefined);
  resetFixerDesks();
  resetHubs();
  resetPeople();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const codeOf = (reply: FixerReply): string | undefined => (reply.structured?.confirmation as { code: string } | undefined)?.code;

/** Asks, then answers with the approval code when the first call asked for one. */
async function approved(call: (confirmation?: string) => Promise<FixerReply>): Promise<FixerReply> {
  const first = await call();
  const code = codeOf(first);
  return code ? call(code) : first;
}

async function setup(options: { smartLocks?: boolean; pros?: ReleaseMode; extend?: ReleaseMode; stays?: [string, string][] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fixer-lock-"));
  const account = mkdtempSync(join(tmpdir(), "fixer-lock-acct-"));
  dirs.push(root, account);
  let clock = new Date(NOW);
  const env: NodeJS.ProcessEnv = { CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64"), ...(options.smartLocks === false ? {} : { SMART_LOCKS: "1" }) };
  const now = () => clock;
  const hub = hubFor(root, { now });
  hub.saveProperty(options.stays ? { ...PROPERTY, checkInTime: "13:00" } : PROPERTY);
  hub.setCalendars({ calendars: [{ name: "Airbnb", url: "https://calendar.example/lane.ics" }], done: true });
  hub.doorAccess(() => env).save(SAVED, undefined, undefined);
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  const front = fake.addDevice("acct-1", { id: "dev-front", name: "Front door" });
  hub.doorAccess(() => env).saveLocks({ ...emptyLocks(), customerKey: "acct-1", devices: [storedDevice(front)], doors: [front.id], activeAt: NOW.toISOString(), release: { cleaners: "ask", pros: options.pros ?? "ask" }, extend: options.extend ?? "ask" });
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
  await desk().savePro({ name: "Joe's Plumbing", trades: ["plumbing"], reach: { phone: JOE }, prefersText: true, preferredFor: [{ trade: "plumbing", rank: 1 }] });
  await desk().saveSettings({ prosDone: true });
  await desk().saveSettings({ upkeepDone: true });
  expect((await desk().activate()).isError).toBe(false);
  people().optIn(JOE, PROPERTY_ID);
  const ics = ["BEGIN:VCALENDAR", ...(options.stays ?? []).flatMap(([a, b], i) => ["BEGIN:VEVENT", `UID:s${i}`, `DTSTART;VALUE=DATE:${a}`, `DTEND;VALUE=DATE:${b}`, "SUMMARY:Guest", "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
  setCalendarFetch(async (url) => ({ status: 200, url, async text() { return ics; } }));
  await desk().openJob({ trade: "plumbing", what: "Sink leaks", urgency: "soon", source: "host" });
  await desk().checkFixes({});
  const job = () => readFixer(root).jobs.at(-1)!;
  const book = async () => {
    const pro = readFixer(root).pros.find((p) => p.name.startsWith("Joe"))!;
    const token = (await desk().contactPro({ jobId: job().id, to: pro.id, how: "call" })).structured!.contactToken as string;
    expect((await desk().recordContact({ contactToken: token, outcome: "booked", ...TUE, estimateCents: 18000 })).isError).toBe(false);
    expect((await approved((confirmation) => desk().approveBooking({ jobId: job().id, ...(confirmation ? { confirmation } : {}) }))).isError).toBe(false);
  };
  const news = () => [...(readFixer(root).news ?? []), ...readFixer(root).jobs.flatMap((job) => job.news)].map((item) => item.text ?? "");
  return { root, desk, job, book, fake, sent, notes, news, at: (iso: string | number) => (clock = new Date(iso)) };
}

describe("Fixer Core on connected locks", () => {
  it("makes the pro's own code at the host's yes, for 30 minutes before the visit to its end", async () => {
    const w = await setup();
    expect(w.fake.liveCodes("dev-front")).toEqual([]);
    await w.book();
    const live = w.fake.liveCodes("dev-front");
    expect(live.length).toBe(1);
    expect(live[0]!.window).toEqual({ from: new Date(Date.parse(TUE.from) - 30 * MIN).toISOString(), until: TUE.until });
    expect(live[0]!.code === SAVED).toBe(false);
  });

  it("texts the pro their own code, not the saved one, and the record holds neither", async () => {
    const w = await setup({ pros: "automatic" });
    await w.book();
    const code = w.fake.liveCodes("dev-front")[0]!.code;
    w.at(Date.parse(TUE.from) - 30 * MIN);
    await w.desk().tick();
    expect(w.sent.length).toBe(1);
    expect(w.sent[0]!.to).toBe(JOE);
    expect(w.sent[0]!.body.includes(code)).toBe(true);
    expect(w.sent[0]!.body.includes(SAVED)).toBe(false);
    const record = readFileSync(join(w.root, "fixer.json"), "utf8");
    expect(record.includes(code)).toBe(false);
  });

  it("moves the code when the host extends the visit", async () => {
    const w = await setup();
    await w.book();
    const until = "2026-11-10T18:00:00.000Z";
    expect((await approved((confirmation) => w.desk().extendVisit({ jobId: w.job().id, until, ...(confirmation ? { confirmation } : {}) }))).isError).toBe(false);
    expect(w.fake.liveCodes("dev-front")[0]!.window.until).toBe(until);
  });

  it("revokes the code when the job is cancelled", async () => {
    const w = await setup();
    await w.book();
    expect((await approved((confirmation) => w.desk().cancelJob({ jobId: w.job().id, ...(confirmation ? { confirmation } : {}) }))).isError).toBe(false);
    expect(w.fake.liveCodes("dev-front")).toEqual([]);
  });

  it("revokes every pro's code when Fixer Core is turned off", async () => {
    const w = await setup();
    await w.book();
    await w.desk().turnOff(false);
    expect(w.fake.liveCodes("dev-front")).toEqual([]);
  });

  it("with SMART_LOCKS off, nothing reaches the lock and the saved code goes as before", async () => {
    const w = await setup({ smartLocks: false });
    await w.book();
    w.at(Date.parse(TUE.from) - 30 * MIN);
    await w.desk().tick();
    expect(w.fake.calls).toEqual([]);
    expect(w.sent[0]!.body.includes(SAVED)).toBe(true);
  });
});

describe("how a pro's code goes out on connected locks", () => {
  it("defaults to ask: the host is asked when the window opens, the pro sees waiting, and the code goes only after the OK", async () => {
    const w = await setup();
    await w.book();
    w.at(Date.parse(TUE.from) - 30 * MIN);
    await w.desk().tick();
    expect(w.sent).toEqual([]);
    expect(w.news()).toContain("OK to send Joe's Plumbing their code for the 10:00 visit? Their code waits for your yes.");
    const page = await w.desk().revealCode(w.job().id);
    expect(page.ok ? "opened" : page.reason).toBe("waiting-for-host");
    w.at(TUE.from);
    await w.desk().tick();
    expect(w.news()).toContain("Joe's Plumbing's visit has started, and their code is still waiting for your OK.");
    expect((await approved((confirmation) => w.desk().approveCode({ jobId: w.job().id, ...(confirmation ? { confirmation } : {}) }))).isError).toBe(false);
    await w.desk().tick();
    expect(w.sent.length).toBe(1);
    expect(w.sent[0]!.body.includes(w.fake.liveCodes("dev-front")[0]!.code)).toBe(true);
  });

  it("asks the host's OK with a question and an approval code, never a code", async () => {
    const w = await setup();
    await w.book();
    const asked = await w.desk().approveCode({ jobId: w.job().id });
    expect(asked.structured?.question).toBe("OK to send Joe's Plumbing their code for the 10:00 visit?");
    expect(JSON.stringify(asked).includes(w.fake.liveCodes("dev-front")[0]!.code)).toBe(false);
  });

  it("on automatic, the pro's tap at the door inside the window shows the code", async () => {
    const w = await setup({ pros: "automatic" });
    await w.book();
    w.at(TUE.from);
    const page = await w.desk().revealCode(w.job().id);
    expect(page.ok && page.code === w.fake.liveCodes("dev-front")[0]!.code).toBe(true);
  });
});

describe("more time for a pro still inside", () => {
  it("on ask, asks the host 15 minutes before the code stops, once", async () => {
    const w = await setup({ pros: "automatic" });
    await w.book();
    w.at(Date.parse(TUE.until) - 16 * MIN);
    await w.desk().tick();
    w.at(Date.parse(TUE.until) - 15 * MIN);
    await w.desk().tick();
    await w.desk().tick();
    expect(w.news().filter((text) => text.includes("Give them more time?"))).toEqual(["Joe's Plumbing hasn't said done, and their code stops at 12:00. Give them more time?"]);
    expect(w.fake.liveCodes("dev-front")[0]!.window.until).toBe(TUE.until);
  });

  it("on automatic, gives 30 more minutes and moves the code, without ending the visit link", async () => {
    const w = await setup({ pros: "automatic", extend: "automatic" });
    await w.book();
    w.at(Date.parse(TUE.until) - 15 * MIN);
    await w.desk().tick();
    const until = new Date(Date.parse(TUE.until) + 30 * MIN).toISOString();
    expect(w.job().booking!.extendedUntil).toBe(until);
    expect(w.fake.liveCodes("dev-front")[0]!.window.until).toBe(until);
    expect(w.news()).toContain("Joe's Plumbing hasn't said done, so I gave them 30 more minutes, until 12:30.");
  });

  it("never extends into the next check-in or the time kept free before it", async () => {
    // A stay checks in Tuesday at 1:00 PM: the hour kept free before it leaves no room past noon.
    const w = await setup({ pros: "automatic", extend: "automatic", stays: [["20261110", "20261113"]] });
    await w.book();
    w.at(Date.parse(TUE.until) - 15 * MIN);
    await w.desk().tick();
    expect(w.job().booking!.extendedUntil).toBeUndefined();
    expect(w.fake.liveCodes("dev-front")[0]!.window.until).toBe(TUE.until);
    expect(w.news()).toContain("Joe's Plumbing hasn't said done, and their code stops at 12:00. I can't give them more time: the next check-in is too close.");
  });

  it("gives no more time once the pro said done", async () => {
    const w = await setup({ pros: "automatic", extend: "automatic" });
    await w.book();
    await w.desk().recordDone({ jobId: w.job().id, by: "host" });
    w.at(Date.parse(TUE.until) - 15 * MIN);
    await w.desk().tick();
    expect(w.job().booking!.extendedUntil).toBeUndefined();
  });
});
