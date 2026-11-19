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

async function setup(options: { smartLocks?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fixer-lock-"));
  const account = mkdtempSync(join(tmpdir(), "fixer-lock-acct-"));
  dirs.push(root, account);
  let clock = new Date(NOW);
  const env: NodeJS.ProcessEnv = { CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64"), ...(options.smartLocks === false ? {} : { SMART_LOCKS: "1" }) };
  const now = () => clock;
  const hub = hubFor(root, { now });
  hub.saveProperty(PROPERTY);
  hub.setCalendars({ calendars: [{ name: "Airbnb", url: "https://calendar.example/lane.ics" }], done: true });
  hub.doorAccess(() => env).save(SAVED, undefined, undefined);
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  const front = fake.addDevice("acct-1", { id: "dev-front", name: "Front door" });
  hub.doorAccess(() => env).saveLocks({ ...emptyLocks(), customerKey: "acct-1", devices: [storedDevice(front)], doors: [front.id], activeAt: NOW.toISOString() });
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
  setCalendarFetch(async (url) => ({ status: 200, url, async text() { return "BEGIN:VCALENDAR\r\nEND:VCALENDAR"; } }));
  await desk().openJob({ trade: "plumbing", what: "Sink leaks", urgency: "soon", source: "host" });
  await desk().checkFixes({});
  const job = () => readFixer(root).jobs.at(-1)!;
  const book = async () => {
    const pro = readFixer(root).pros.find((p) => p.name.startsWith("Joe"))!;
    const token = (await desk().contactPro({ jobId: job().id, to: pro.id, how: "call" })).structured!.contactToken as string;
    expect((await desk().recordContact({ contactToken: token, outcome: "booked", ...TUE, estimateCents: 18000 })).isError).toBe(false);
    expect((await approved((confirmation) => desk().approveBooking({ jobId: job().id, ...(confirmation ? { confirmation } : {}) }))).isError).toBe(false);
  };
  return { root, desk, job, book, fake, sent, notes, at: (iso: string | number) => (clock = new Date(iso)) };
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
    const w = await setup();
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
