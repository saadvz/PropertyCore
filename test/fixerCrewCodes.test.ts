import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixerDeskFor, resetFixerDesks, type FixerDeps, type FixerReply } from "../src/fixer-core/desk";
import { readFixer } from "../src/fixer-core/store";
import { CREW_HOST_ACCESS } from "../src/fixer-core/texts";
import { setCalendarFetch } from "../src/hub/calendarFetch";
import { hubFor, resetHubs } from "../src/hub/hub";
import { peopleFor, resetPeople } from "../src/hub/people";
import { FakeLockAdapter } from "../src/locks/fake";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice, type ReleaseMode } from "../src/locks/settings";
import { visitLogFor } from "../src/visits/store";

/**
 * Crew-day codes (#243): one code for the crew's booked pro, live only in each workday's window, moved to the
 * next workday after each one ends. Fake lock adapter, 555 numbers, made-up codes that no assertion prints.
 */

const NOW = new Date("2026-11-08T15:00:00.000Z");
const PROPERTY = { nickname: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" };
const SAVED = ["7", "3", "0", "6"].join("");
const HOST = "+15555550100";
const JOE = "+15555550142";
const PROPERTY_ID = "prop_scratch";
/** Mon 16 to Wed 18 Nov, 08:00 to 17:00 New York: 13:00 to 22:00 UTC each day. */
const CREW = { firstDay: "2026-11-16", lastDay: "2026-11-18", workdays: ["MON", "TUE", "WED"] as ("MON" | "TUE" | "WED")[], start: "08:00", end: "17:00" };
const SPAN = { from: "2026-11-16T13:00:00.000Z", until: "2026-11-18T22:00:00.000Z" };
const DAY = (n: 16 | 17 | 18) => ({ from: `2026-11-${n}T13:00:00.000Z`, until: `2026-11-${n}T22:00:00.000Z` });

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

async function approved(call: (confirmation?: string) => Promise<FixerReply>): Promise<FixerReply> {
  const first = await call();
  const code = codeOf(first);
  return code ? call(code) : first;
}

async function setup(options: { smartLocks?: boolean; pros?: ReleaseMode } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fixer-crew-"));
  const account = mkdtempSync(join(tmpdir(), "fixer-crew-acct-"));
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
  hub.doorAccess(() => env).saveLocks({ ...emptyLocks(), customerKey: "acct-1", devices: [storedDevice(front)], doors: [front.id], activeAt: NOW.toISOString(), release: { cleaners: "ask", pros: options.pros ?? "ask" } });
  const people = () => peopleFor(account, { now });
  people().savePropertyPeople(PROPERTY_ID, HOST, []);
  const sent: { to: string; body: string }[] = [];
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
    notifyHost: async () => undefined,
  };
  const desk = () => fixerDeskFor(root, deps);
  await desk().savePro({ name: "Joe's Builders", trades: ["handyman"], reach: { phone: JOE }, prefersText: true, preferredFor: [{ trade: "handyman", rank: 1 }] });
  await desk().saveSettings({ prosDone: true });
  await desk().saveSettings({ upkeepDone: true });
  expect((await desk().activate()).isError).toBe(false);
  people().optIn(JOE, PROPERTY_ID);
  setCalendarFetch(async (url) => ({ status: 200, url, async text() { return "BEGIN:VCALENDAR\r\nEND:VCALENDAR"; } }));
  await desk().openJob({ trade: "handyman", what: "Redo the deck", urgency: "flexible", source: "host" });
  await desk().checkFixes({});
  const job = () => readFixer(root).jobs.at(-1)!;
  expect((await approved((confirmation) => desk().saveCrewSchedule({ jobId: job().id, ...CREW, ...(confirmation ? { confirmation } : {}) }))).isError).toBe(false);
  const offer = async () => {
    const pro = readFixer(root).pros[0]!;
    const token = (await desk().contactPro({ jobId: job().id, to: pro.id, how: "call" })).structured!.contactToken as string;
    expect((await desk().recordContact({ contactToken: token, outcome: "booked", ...SPAN, estimateCents: 400000 })).isError).toBe(false);
  };
  const book = (access?: "code" | "host") => approved((confirmation) => desk().approveBooking({ jobId: job().id, ...(access ? { access } : {}), ...(confirmation ? { confirmation } : {}) }));
  return { root, env, desk, job, offer, book, fake, sent, at: (iso: string) => (clock = new Date(iso)) };
}

const live = (fake: FakeLockAdapter) => fake.liveCodes("dev-front").filter((code) => !code.backup);

describe("crew-day codes", () => {
  it("off connected locks, a crew still can't be booked with a code: the host lets them in", async () => {
    const w = await setup({ smartLocks: false });
    await w.offer();
    const refused = await w.desk().approveBooking({ jobId: w.job().id, access: "code" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(CREW_HOST_ACCESS);
    expect((await w.book()).structured).toMatchObject({ booked: true, access: "host" });
    expect(live(w.fake)).toEqual([]);
  });

  it("on connected locks, a crew booked with a code gets one code for the pro, live only in the first workday's window", async () => {
    const w = await setup();
    await w.offer();
    expect((await w.book("code")).structured).toMatchObject({ booked: true, access: "code" });
    const codes = live(w.fake);
    expect(codes).toHaveLength(1);
    expect(codes[0]!.window).toEqual(DAY(16));
    const pro = readFixer(w.root).pros[0]!;
    expect(visitLogFor(w.root).codeNames()[codes[0]!.name]).toEqual({ role: "pro", proId: pro.id });
  });

  it("moves the same code to the next workday once a day's window ends, and ends it after the last", async () => {
    const w = await setup();
    await w.offer();
    await w.book("code");
    const code = live(w.fake)[0]!.code;
    w.at("2026-11-16T22:00:00.000Z");
    await w.desk().tick();
    expect(live(w.fake).map((item) => [item.code === code, item.window])).toEqual([[true, DAY(17)]]);
    w.at("2026-11-17T23:00:00.000Z");
    await w.desk().tick();
    expect(live(w.fake).map((item) => [item.code === code, item.window])).toEqual([[true, DAY(18)]]);
    w.at("2026-11-18T22:00:00.000Z");
    await w.desk().tick();
    expect(live(w.fake)).toEqual([]);
  });

  it("shows the code on the visit page only inside a workday's window", async () => {
    const w = await setup({ pros: "automatic" });
    await w.offer();
    await w.book("code");
    const code = live(w.fake)[0]!.code;
    // No early lead for a crew: a minute before the first workday starts, the page says it's outside the crew's hours.
    w.at("2026-11-16T12:59:00.000Z");
    expect(await w.desk().revealCode(w.job().id)).toEqual({ ok: false, reason: "outside-crew-hours" });
    w.at("2026-11-16T14:00:00.000Z");
    expect(await w.desk().revealCode(w.job().id)).toMatchObject({ ok: true, code });
    // Overnight, between workdays: no code, and the lock refuses it anyway.
    w.at("2026-11-17T03:00:00.000Z");
    expect(await w.desk().revealCode(w.job().id)).toEqual({ ok: false, reason: "outside-crew-hours" });
    w.at("2026-11-17T14:00:00.000Z");
    const day2 = await w.desk().revealCode(w.job().id);
    expect(day2).toMatchObject({ ok: true, code });
    // The release never stretches the code past today's window.
    expect(live(w.fake)[0]!.window).toEqual(DAY(17));
  });

  it("under ask, waits for the host's OK once for the whole job; on automatic, texts the pro once with the crew's hours", async () => {
    const asked = await setup();
    await asked.offer();
    await asked.book("code");
    asked.at("2026-11-16T14:00:00.000Z");
    expect(await asked.desk().revealCode(asked.job().id)).toEqual({ ok: false, reason: "waiting-for-host" });
    expect((await approved((confirmation) => asked.desk().approveCode({ jobId: asked.job().id, ...(confirmation ? { confirmation } : {}) }))).isError).toBe(false);
    expect((await asked.desk().revealCode(asked.job().id)).ok).toBe(true);
    asked.at("2026-11-17T14:00:00.000Z");
    expect((await asked.desk().revealCode(asked.job().id)).ok).toBe(true);

    const auto = await setup({ pros: "automatic" });
    await auto.offer();
    await auto.book("code");
    auto.at("2026-11-16T13:00:00.000Z");
    await auto.desk().tick();
    const code = live(auto.fake)[0]!.code;
    expect(auto.sent).toHaveLength(1);
    expect(auto.sent[0]!.to).toBe(JOE);
    expect(auto.sent[0]!.body).toContain(code);
    expect(auto.sent[0]!.body).toMatch(/Mon, Tue, Wed, 08:00 to 17:00/);
    auto.at("2026-11-17T13:00:00.000Z");
    await auto.desk().tick();
    expect(auto.sent).toHaveLength(1);
    expect(readFileSync(join(auto.root, "fixer.json"), "utf8")).not.toContain(code);
  });

  it("revokes the crew's code when the job is cancelled", async () => {
    const w = await setup();
    await w.offer();
    await w.book("code");
    expect(live(w.fake)).toHaveLength(1);
    await approved((confirmation) => w.desk().cancelJob({ jobId: w.job().id, reason: "test", ...(confirmation ? { confirmation } : {}) }));
    expect(live(w.fake)).toEqual([]);
  });

  it("holds the crew's code in the leak checks", async () => {
    const w = await setup();
    await w.offer();
    await w.book("code");
    const code = live(w.fake)[0]!.code;
    expect(hubFor(w.root, { now: () => NOW }).doorAccess(() => w.env).codesForChecksAll().includes(code)).toBe(true);
  });
});
