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
  const ics = ["BEGIN:VCALENDAR", ...(options.stays ?? []).flatMap(([a, b], i) => ["BEGIN:VEVENT", `UID:s${i}`, `DTSTART;VALUE=DATE:${a}`, `DTEND;VALUE=DATE:${b}`, "SUMMARY:Guest", "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
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
