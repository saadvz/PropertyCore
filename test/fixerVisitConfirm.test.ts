import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXER_PRO_CODE_PREFIX, fixerDeskFor, resetFixerDesks, type FixerDeps, type FixerReply } from "../src/fixer-core/desk";
import { readFixer, writeFixer } from "../src/fixer-core/store";
import { confirmHostAsk, confirmQuestion, noConfirmAtStart, proCodeLinkQuestion, visitTextPath } from "../src/fixer-core/texts";
import { setCalendarFetch } from "../src/hub/calendarFetch";
import { hubFor, resetHubs } from "../src/hub/hub";
import { peopleFor, resetPeople } from "../src/hub/people";
import { FakeLockAdapter } from "../src/locks/fake";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice, type ReleaseMode } from "../src/locks/settings";
import { visitLogFor } from "../src/visits/store";
import { deskFeatures } from "./featureEnv";

/**
 * A pro's code waits for a yes on record (#243 ruling, 24 Nov): no code goes on the lock at booking, for a crew or a
 * one-day pro. The yes is the pro's own YES to one confirm text, or one the host passes on. Fake lock adapter, 555
 * numbers, made-up codes that no assertion prints.
 */

const NOW = new Date("2026-11-08T15:00:00.000Z");
const PROPERTY = { nickname: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" };
const SAVED = ["7", "3", "0", "6"].join("");
const HOST = "+15555550100";
const JOE = "+15555550142";
const PROPERTY_ID = "prop_scratch";
/** Mon 16 to Wed 18 Nov, 08:00 to 17:00 New York: 13:00 to 22:00 UTC each day. */
const CREW = { firstDay: "2026-11-16", lastDay: "2026-11-18", workdays: ["MON", "TUE", "WED"] as ("MON" | "TUE" | "WED")[], start: "08:00", end: "17:00" };
const CREW_SPAN = { from: "2026-11-16T13:00:00.000Z", until: "2026-11-18T22:00:00.000Z" };
/** One visit, Tue 17 Nov, 10 AM to noon New York. */
const ONE_DAY = { from: "2026-11-17T15:00:00.000Z", until: "2026-11-17T17:00:00.000Z" };

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

async function setup(options: { crew?: boolean; pros?: ReleaseMode; texts?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fixer-confirm-"));
  const account = mkdtempSync(join(tmpdir(), "fixer-confirm-acct-"));
  dirs.push(root, account);
  let clock = new Date(NOW);
  const env: NodeJS.ProcessEnv = { CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64"), ...deskFeatures("locks") };
  const now = () => clock;
  const hub = hubFor(root, { now });
  hub.saveProperty(PROPERTY);
  hub.setCalendars({ calendars: [{ name: "Airbnb", url: "https://calendar.example/lane.ics" }], done: true });
  hub.doorAccess(() => env).save(SAVED, undefined, undefined);
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  const front = fake.addDevice("acct-1", { id: "dev-front", name: "Front door" });
  hub.doorAccess(() => env).saveLocks({ ...emptyLocks(), customerKey: "acct-1", devices: [storedDevice(front)], doors: [front.id], activeAt: NOW.toISOString(), release: { cleaners: "ask", pros: options.pros ?? "automatic" } });
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
  const texts = options.texts !== false;
  await desk().savePro({ name: "Joe's Builders", trades: ["handyman"], reach: { phone: JOE }, ...(texts ? { prefersText: true as const } : {}), preferredFor: [{ trade: "handyman", rank: 1 }] });
  await desk().saveSettings({ prosDone: true });
  await desk().saveSettings({ upkeepDone: true });
  expect((await desk().activate()).isError).toBe(false);
  if (texts) people().optIn(JOE, PROPERTY_ID);
  sent.splice(0);
  setCalendarFetch(async (url) => ({ status: 200, url, async text() { return "BEGIN:VCALENDAR\r\nEND:VCALENDAR"; } }));
  await desk().openJob({ trade: "handyman", what: "Redo the deck", urgency: "flexible", source: "host" });
  await desk().checkFixes({});
  const job = () => readFixer(root).jobs.at(-1)!;
  const crew = options.crew !== false;
  if (crew) expect((await approved((confirmation) => desk().saveCrewSchedule({ jobId: job().id, ...CREW, ...(confirmation ? { confirmation } : {}) }))).isError).toBe(false);
  const span = crew ? CREW_SPAN : ONE_DAY;
  const offer = async () => {
    const pro = readFixer(root).pros[0]!;
    const token = (await desk().contactPro({ jobId: job().id, to: pro.id, how: "call" })).structured!.contactToken as string;
    expect((await desk().recordContact({ contactToken: token, outcome: "booked", ...span, estimateCents: 40000 })).isError).toBe(false);
  };
  const book = async (confirmedVia?: "email" | "call" | "host-arranged") => {
    await offer();
    return approved((confirmation) => desk().approveBooking({ jobId: job().id, access: "code", ...(confirmedVia ? { confirmedVia } : {}), ...(confirmation ? { confirmation } : {}) }));
  };
  const news = () => [...(readFixer(root).news ?? []), ...readFixer(root).jobs.flatMap((item) => item.news)];
  return { root, desk, job, book, fake, sent, news, span, at: (iso: string) => (clock = new Date(iso)) };
}

const live = (fake: FakeLockAdapter) => fake.liveCodes("dev-front").filter((code) => !code.backup);
const confirmTexts = (sent: { body: string }[]) => sent.filter((item) => item.body.endsWith("Reply YES to confirm."));

describe("a pro's code waits for their yes on record", () => {
  it("a crew booked with a code gets nothing on the lock at the host's yes, and the page shows no code", async () => {
    const w = await setup();
    expect((await w.book()).structured).toMatchObject({ booked: true, access: "code", confirmed: false });
    expect(w.job().booking!.confirmed).toBeUndefined();
    expect(live(w.fake)).toEqual([]);
    w.at("2026-11-16T14:00:00.000Z");
    await w.desk().tick();
    expect(live(w.fake)).toEqual([]);
    expect(await w.desk().revealCode(w.job().id)).toEqual({ ok: false, reason: "not-confirmed" });
  });

  it("the same rule holds for a one-day pro", async () => {
    const w = await setup({ crew: false });
    await w.book();
    await w.desk().tick();
    expect(live(w.fake)).toEqual([]);
    w.at(ONE_DAY.from);
    expect(await w.desk().revealCode(w.job().id)).toEqual({ ok: false, reason: "not-confirmed" });
  });

  it("the pro's YES to the one confirm text makes the code, and records who said it, when and how", async () => {
    const w = await setup();
    await w.book();
    await w.desk().tick();
    await w.desk().tick();
    expect(confirmTexts(w.sent)).toEqual([{ to: JOE, body: "Hi Joe's, you're booked at 12 Scratch Lane (redo the deck) for Mon, Nov 16 to Wed, Nov 18 (Mon, Tue, Wed, 8 AM to 5 PM). Reply YES to confirm." }]);
    expect(live(w.fake)).toEqual([]);
    w.sent.splice(0);
    w.at("2026-11-08T16:00:00.000Z");
    await w.desk().proInbound({ id: "yes-1", from: JOE, text: "YES" });
    expect(w.job().booking!.confirmed).toEqual({ at: "2026-11-08T16:00:00.000Z", by: "pro", via: "text" });
    expect(w.sent).toEqual([{ to: JOE, body: "Thanks, you're confirmed. You'll get your door code when the visit starts." }]);
    expect(w.news().map((item) => item.text)).toContain("Joe's Builders confirmed by text for Mon, Nov 16 to Wed, Nov 18 (Mon, Tue, Wed, 8 AM to 5 PM). Their door code is made now.");
    const codes = live(w.fake);
    expect(codes).toHaveLength(1);
    expect(codes[0]!.window).toEqual({ from: "2026-11-16T13:00:00.000Z", until: "2026-11-16T22:00:00.000Z" });
    // A replayed YES does nothing a second time, and the record keeps the first.
    w.sent.splice(0);
    await w.desk().proInbound({ id: "yes-1", from: JOE, text: "YES" });
    expect(w.sent).toEqual([]);
    expect(w.job().booking!.confirmed!.at).toBe("2026-11-08T16:00:00.000Z");
    // No pro text carries a code.
    expect(w.sent.some((item) => codes.some((code) => item.body.includes(code.code)))).toBe(false);
  });

  it("never texts a pro who hasn't said YES to texts, and the host is still asked", async () => {
    const w = await setup({ texts: false });
    await w.book();
    await w.desk().tick();
    expect(w.sent).toEqual([]);
    w.at("2026-11-14T13:00:00.000Z");
    await w.desk().tick();
    expect(w.sent).toEqual([]);
    expect(w.news().filter((item) => item.kind === "confirm-ask")).toHaveLength(1);
  });

  it("confirm_visit takes the host's two-call yes, records the host and how, and makes the code", async () => {
    const w = await setup({ texts: false, pros: "ask" });
    await w.book();
    const ask = await w.desk().confirmVisit({ jobId: w.job().id, via: "email" });
    expect(ask.structured?.question).toBe(confirmQuestion({ proName: "Joe's Builders", span: "Mon, Nov 16 to Wed, Nov 18 (Mon, Tue, Wed, 8 AM to 5 PM)", via: "email" }));
    expect(ask.structured?.question).toBe("Joe's Builders confirmed Mon, Nov 16 to Wed, Nov 18 (Mon, Tue, Wed, 8 AM to 5 PM) by email? Their door code is made then.");
    expect(live(w.fake)).toEqual([]);
    w.at("2026-11-08T15:05:00.000Z");
    const yes = await w.desk().confirmVisit({ jobId: w.job().id, via: "email", confirmation: codeOf(ask)! });
    expect(yes.structured).toMatchObject({ confirmed: true, by: "host", via: "email" });
    const booking = w.job().booking!;
    expect(booking.confirmed).toEqual({ at: "2026-11-08T15:05:00.000Z", by: "host", via: "email" });
    // Under ask, the host passing on the yes is also their OK for the code: one question, not two.
    expect(booking.codeYes).toEqual({ at: "2026-11-08T15:05:00.000Z" });
    expect(w.job().hostSteps?.filter((step) => step.kind === "confirm-visit")).toEqual([{ kind: "confirm-visit", at: "2026-11-08T15:05:00.000Z", proId: booking.proId }]);
    expect(live(w.fake)).toHaveLength(1);
    expect(JSON.stringify(yes).includes(live(w.fake)[0]!.code)).toBe(false);
    // Asked again, it's already confirmed and nothing changes.
    expect((await w.desk().confirmVisit({ jobId: w.job().id, via: "call" })).structured).toMatchObject({ already: true, by: "host", via: "email" });
  });

  it("is refused without how the pro confirmed, and for a visit that isn't booked", async () => {
    const w = await setup();
    expect((await w.desk().confirmVisit({ jobId: w.job().id, via: "call" })).isError).toBe(true);
    await w.book();
    expect((await w.desk().confirmVisit({ jobId: w.job().id })).isError).toBe(true);
    expect((await w.desk().confirmVisit({ jobId: w.job().id, via: "text" as never })).isError).toBe(true);
  });

  it("confirmedVia on approve_booking puts both in one question and confirms at the booking", async () => {
    const w = await setup();
    await w.desk().contactPro({ jobId: w.job().id, to: readFixer(w.root).pros[0]!.id, how: "call" });
    const token = w.job().contacts.at(-1)!.token;
    await w.desk().recordContact({ contactToken: token, outcome: "booked", ...CREW_SPAN });
    const ask = await w.desk().approveBooking({ jobId: w.job().id, access: "code", confirmedVia: "host-arranged" });
    expect(ask.structured?.question).toContain("You set this up with Joe's Builders yourself, so it counts as confirmed. Book it and let them in with the door code?");
    // A yes to the question without confirmedVia doesn't carry it.
    expect((await w.desk().approveBooking({ jobId: w.job().id, access: "code", confirmation: codeOf(ask)! })).isError).toBe(true);
    const again = await w.desk().approveBooking({ jobId: w.job().id, access: "code", confirmedVia: "host-arranged" });
    expect((await w.desk().approveBooking({ jobId: w.job().id, access: "code", confirmedVia: "host-arranged", confirmation: codeOf(again)! })).isError).toBe(false);
    expect(w.job().booking!.confirmed).toEqual({ at: NOW.toISOString(), by: "host", via: "host-arranged" });
    expect(live(w.fake)).toHaveLength(1);
    await w.desk().tick();
    expect(confirmTexts(w.sent)).toEqual([]);
  });

  it("asks the host once 48 hours before the first workday, and notes once at the start, with no code", async () => {
    const w = await setup({ texts: false });
    await w.book();
    w.at("2026-11-14T12:59:00.000Z");
    await w.desk().tick();
    expect(w.news().filter((item) => item.kind === "confirm-ask")).toEqual([]);
    w.at("2026-11-14T13:00:00.000Z");
    await w.desk().tick();
    await w.desk().tick();
    const asks = w.news().filter((item) => item.kind === "confirm-ask");
    expect(asks.map((item) => item.text)).toEqual([confirmHostAsk({ proName: "Joe's Builders", span: "Mon, Nov 16 to Wed, Nov 18 (Mon, Tue, Wed, 8 AM to 5 PM)" })]);
    w.at("2026-11-16T13:00:00.000Z");
    await w.desk().tick();
    await w.desk().tick();
    const missing = w.news().filter((item) => item.kind === "confirm-missing");
    expect(missing.map((item) => item.text)).toEqual([noConfirmAtStart({ proName: "Joe's Builders" })]);
    expect(missing[0]).toMatchObject({ urgent: true });
    expect(live(w.fake)).toEqual([]);
    // The host's yes then makes the code, live in today's window.
    await approved((confirmation) => w.desk().confirmVisit({ jobId: w.job().id, via: "call", ...(confirmation ? { confirmation } : {}) }));
    expect(live(w.fake).map((code) => code.window)).toEqual([{ from: "2026-11-16T13:00:00.000Z", until: "2026-11-16T22:00:00.000Z" }]);
  });

  it("a booking inside 48 hours asks in its reply, not again on the clock", async () => {
    const w = await setup({ crew: false, texts: false });
    w.at("2026-11-16T12:00:00.000Z");
    const reply = await w.book();
    expect(reply.structured?.next).toBe("Tell Joe's Builders the time. Their door code is made once they confirm: ask the host if they already have, and call confirm_visit.");
    await w.desk().tick();
    expect(w.news().filter((item) => item.kind === "confirm-ask")).toEqual([]);
  });

  it("a booking that had a code with no yes on record loses it until a yes comes in", async () => {
    const w = await setup();
    await w.book("call");
    expect(live(w.fake)).toHaveLength(1);
    // A booking from before the rule: no yes on record.
    const file = readFixer(w.root);
    delete file.jobs.at(-1)!.booking!.confirmed;
    writeFixer(w.root, file);
    w.at("2026-11-08T16:00:00.000Z");
    await w.desk().tick();
    expect(live(w.fake)).toEqual([]);
  });
});

describe("the host's page with a pro's code, for a pro who doesn't take texts", () => {
  const tokenOf = (reply: FixerReply) => String(reply.structured?.url).split(FIXER_PRO_CODE_PREFIX)[1]!;

  it("is refused before the yes, and for a pro who gets their code by text", async () => {
    const byText = await setup();
    await byText.book("call");
    expect((await byText.desk().proCodeLink({ jobId: byText.job().id })).text).toBe(visitTextPath({ proName: "Joe's Builders" }));
    const noYes = await setup({ texts: false });
    await noYes.book();
    expect((await noYes.desk().proCodeLink({ jobId: noYes.job().id })).isError).toBe(true);
  });

  it("shows the pro's own code once, after the host's two-call yes, and never counts as an arrival", async () => {
    const w = await setup({ texts: false });
    await w.book("call");
    const ask = await w.desk().proCodeLink({ jobId: w.job().id });
    expect(ask.structured?.question).toBe(proCodeLinkQuestion({ proName: "Joe's Builders" }));
    const made = await w.desk().proCodeLink({ jobId: w.job().id, confirmation: codeOf(ask)! });
    expect(made.isError).toBe(false);
    const token = tokenOf(made);
    expect(token).toMatch(/^[a-p]{40}$/);
    // Only the token's hash is kept.
    expect(JSON.stringify(readFixer(w.root)).includes(token)).toBe(false);
    expect(w.desk().proCodeOpen(token)).toEqual({ proName: "Joe's Builders", street: "12 Scratch Lane" });
    const code = live(w.fake)[0]!.code;
    const shown = await w.desk().showProCode(token);
    expect(shown.ok && shown.code === code).toBe(true);
    expect(await w.desk().showProCode(token)).toEqual({ ok: false, reason: "gone" });
    expect(w.desk().proCodeOpen(token)).toBeUndefined();
    expect(visitLogFor(w.root).read().some((event) => event.type === "visit-page")).toBe(false);
    // The pro saw the code through the host, so it counts for the change-the-code question.
    expect(w.job().codeShownTo).toEqual([w.job().booking!.proId]);
    // A wrong token never opens it.
    expect(await w.desk().showProCode("a".repeat(40))).toEqual({ ok: false, reason: "gone" });
  });

  it("ends with a cancel", async () => {
    const w = await setup({ texts: false });
    await w.book("call");
    const token = tokenOf(await approved((confirmation) => w.desk().proCodeLink({ jobId: w.job().id, ...(confirmation ? { confirmation } : {}) })));
    await approved((confirmation) => w.desk().cancelJob({ jobId: w.job().id, ...(confirmation ? { confirmation } : {}) }));
    expect(w.desk().proCodeOpen(token)).toBeUndefined();
    expect(await w.desk().showProCode(token)).toEqual({ ok: false, reason: "gone" });
  });
});
