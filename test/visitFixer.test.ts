import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixerDeskFor, resetFixerDesks, type FixerDeps } from "../src/fixer-core/desk";
import { readFixer } from "../src/fixer-core/store";
import { setCalendarFetch } from "../src/hub/calendarFetch";
import { hubFor, resetHubs } from "../src/hub/hub";
import { peopleFor, resetPeople } from "../src/hub/people";
import { buildVisits } from "../src/visits/derive";
import { resetVisitLogCache, VISIT_EVENTS_DIR, VisitLog } from "../src/visits/store";
import { deskFeatures } from "./featureEnv";

/** #237 through Fixer Core: a repair visit's window, measured times, and one news line per flag. Made-up pros, 555 numbers, fake lock events. */

const NOW = new Date("2026-11-08T15:00:00.000Z");
const PROPERTY = { nickname: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" };
const CODE = ["5", "1", "9", "7"].join("");
const HOST = "+15555550100";
const PROPERTY_ID = "prop_scratch";
const JOE = "+15555550142";
/** Tuesday 10 to 12 local. */
const TUE = { from: "2026-11-10T15:00:00.000Z", until: "2026-11-10T17:00:00.000Z" };
const MIN = 60_000;

const dirs: string[] = [];
afterEach(() => {
  setCalendarFetch(undefined);
  resetFixerDesks();
  resetHubs();
  resetPeople();
  resetVisitLogCache();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const codeOf = (reply: { structured?: Record<string, unknown> }): string => (reply.structured!.confirmation as { code: string }).code;

async function setup(opts: { visits?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "visit-fixer-"));
  const account = mkdtempSync(join(tmpdir(), "visit-fixer-acct-"));
  dirs.push(root, account);
  let clock = new Date(NOW);
  const key = randomBytes(32).toString("base64");
  const env = (): NodeJS.ProcessEnv => ({ CLEANER_CORE_PIN_KEY: key, ...(opts.visits === false ? {} : deskFeatures("visits")) });
  const now = () => clock;
  const hub = hubFor(root, { now });
  hub.saveProperty(PROPERTY);
  hub.setCalendars({ calendars: [{ name: "Airbnb", url: "https://calendar.example/lane.ics" }], done: true });
  hub.doorAccess(env).save(CODE, undefined, undefined);
  const people = () => peopleFor(account, { now });
  people().savePropertyPeople(PROPERTY_ID, HOST, []);
  const sent: { to: string; body: string }[] = [];
  const notes: { id: string; text: string }[] = [];
  const deps: FixerDeps = {
    now,
    env,
    propertyId: PROPERTY_ID,
    people,
    publicBase: () => "https://fixer.example.com",
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
  const proId = readFixer(root).pros[0]!.id;
  const token = (await desk().contactPro({ jobId: job().id, to: proId, how: "call" })).structured!.contactToken as string;
  expect((await desk().recordContact({ contactToken: token, outcome: "booked", ...TUE, estimateCents: 18000 })).isError).toBe(false);
  const first = await desk().approveBooking({ jobId: job().id });
  expect((await desk().approveBooking({ jobId: job().id, confirmation: codeOf(first) })).isError).toBe(false);
  const log = new VisitLog(root, now);
  return { root, desk, job, proId, log, sent, notes, at: (t: string | number) => (clock = new Date(t)) };
}

const lateNews = (notes: { text: string }[]) => notes.filter((note) => note.text.includes("hasn't arrived"));

describe("visit records in Fixer Core", () => {
  it("writes the booked visit's window on the clock pass, once", async () => {
    const w = await setup();
    await w.desk().tick();
    await w.desk().tick();
    const windows = w.log.read().filter((event) => event.type === "visit-window");
    expect(windows).toEqual([expect.objectContaining({ visit: `repair:${w.job().id}`, kind: "repair", from: TUE.from, until: TUE.until, who: { role: "pro", name: "Joe's Plumbing", proId: w.proId } })]);
  });

  it("with the account's visits switch off, still writes the log, but tells the host nothing", async () => {
    const w = await setup({ visits: false });
    w.log.append({ type: "lock-connection", id: "conn", at: "2026-11-01T00:00:00.000Z", connected: true });
    await w.desk().tick();
    expect(existsSync(join(w.root, VISIT_EVENTS_DIR))).toBe(true);
    expect(w.log.read().filter((event) => event.type === "visit-window")).toEqual([expect.objectContaining({ visit: `repair:${w.job().id}` })]);
    w.at(Date.parse(TUE.from) + 45 * MIN);
    await w.desk().tick();
    expect(lateNews(w.notes)).toEqual([]);
  });

  it("with a lock, tells the host once when the pro isn't in by the start plus 30 minutes, and never texts the pro about it", async () => {
    const w = await setup();
    w.log.append({ type: "lock-connection", id: "conn", at: "2026-11-01T00:00:00.000Z", connected: true });
    w.at(Date.parse(TUE.from) + 29 * MIN);
    await w.desk().tick();
    expect(lateNews(w.notes)).toEqual([]);
    const textsBefore = w.sent.length;
    w.at(Date.parse(TUE.from) + 30 * MIN);
    await w.desk().tick();
    w.at(Date.parse(TUE.from) + 45 * MIN);
    await w.desk().tick();
    expect(lateNews(w.notes)).toEqual([{ id: `fixer:${w.job().id}:visit-no-arrival`, text: "Joe's Plumbing hasn't arrived for the visit that started at 10 AM." }]);
    expect(w.sent.slice(textsBefore).filter((text) => text.to === JOE)).toEqual([]);
  });

  it("without a lock, adds no news", async () => {
    const w = await setup();
    w.at(Date.parse(TUE.from) + 45 * MIN);
    await w.desk().tick();
    expect(lateNews(w.notes)).toEqual([]);
  });

  it("measures the visit from the pro's code to their DONE text and the lock after it", async () => {
    const w = await setup();
    w.log.append({ type: "lock-connection", id: "conn", at: "2026-11-01T00:00:00.000Z", connected: true });
    w.log.nameCode("Joe", { role: "pro", proId: w.proId });
    w.at(TUE.from);
    await w.desk().tick();
    w.log.append({ type: "lock", id: "u1", at: new Date(Date.parse(TUE.from) + 5 * MIN).toISOString(), device: "Front door", action: "unlock", side: "outside", codeName: "Joe" });
    w.at(Date.parse(TUE.from) + 80 * MIN);
    await w.desk().proInbound({ id: "pro-done", from: JOE, text: "DONE" });
    w.log.append({ type: "lock", id: "l1", at: new Date(Date.parse(TUE.from) + 84 * MIN).toISOString(), device: "Front door", action: "lock", side: "outside" });
    expect(w.job().state).toBe("done");
    const [visit] = buildVisits(w.log.read(), { timeZone: PROPERTY.timeZone, codeNames: w.log.codeNames(), now: new Date(TUE.until) }).visits;
    expect(visit).toMatchObject({ arrival: { source: "lock" }, departure: { source: "done-pro-text", lockCheck: "matched" }, minutes: 79 });
    expect(lateNews(w.notes)).toEqual([]);
    expect(JSON.stringify(w.log.read())).not.toContain(JOE.slice(2));
  });

  it("logs the pro's at-the-door on the visit page", async () => {
    const w = await setup();
    w.at(Date.parse(TUE.from) + 10 * MIN);
    await w.desk().revealCode(w.job().id);
    expect(w.log.read().filter((event) => event.type === "visit-page")).toEqual([expect.objectContaining({ step: "at-door", visit: `repair:${w.job().id}` })]);
  });

  it("calls the visit off in the log when the job is cancelled", async () => {
    const w = await setup();
    await w.desk().tick();
    const ask = await w.desk().cancelJob({ jobId: w.job().id, reason: "Fixed it myself" });
    const cancel = ask.structured?.confirmation ? await w.desk().cancelJob({ jobId: w.job().id, reason: "Fixed it myself", confirmation: codeOf(ask) }) : ask;
    expect(cancel.isError).toBe(false);
    expect(w.job().state).toBe("cancelled");
    await w.desk().tick();
    expect(w.log.read().filter((event) => event.type === "visit-cancelled")).toEqual([expect.objectContaining({ visit: `repair:${w.job().id}` })]);
  });
});
