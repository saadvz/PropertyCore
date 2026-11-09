import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixerDeskFor, resetFixerDesks, type FixerDeps, type FixerDesk, type RevealResult } from "../src/fixer-core/desk";
import { codeText, codeTextOffNote, stayOverBookingNews } from "../src/fixer-core/texts";
import { readFixer, writeFixer } from "../src/fixer-core/store";
import { photoLinks, storePhoto } from "../src/cleaner-core/photos";
import { setCalendarFetch } from "../src/hub/calendarFetch";
import { hubFor, resetHubs } from "../src/hub/hub";
import { peopleFor, resetPeople } from "../src/hub/people";

/**
 * The visit: the clock pass, the door code by text or on the page, done, cost, raised prices,
 * extensions, delays, the questions after the visit, photos. Made-up pros, 555 numbers, and a
 * made-up door code that no assertion prints.
 */

const NOW = new Date("2026-11-08T15:00:00.000Z");
const PROPERTY = { nickname: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" };
const LANE = "https://calendar.example/lane.ics";
const CODE = ["7", "3", "0", "6"].join("");
const SERVER_KEY = randomBytes(32).toString("base64");
const BASE = "https://fixer.example.com";
const PHOTO_KEY = randomBytes(32);
const HOST = "+15555550100";
const PROPERTY_ID = "prop_scratch";
const JOE = "+15555550142";
const SAM = "+15555550145";
const CARA = "+15555550146";
/** Tuesday 10 to 12 local. */
const TUE = { from: "2026-11-10T15:00:00.000Z", until: "2026-11-10T17:00:00.000Z" };
const MIN = 60_000;

const dirs: string[] = [];
afterEach(() => {
  setCalendarFetch(undefined);
  resetFixerDesks();
  resetHubs();
  resetPeople();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ics = (...stays: [string, string][]) =>
  ["BEGIN:VCALENDAR", ...stays.flatMap(([a, b], i) => ["BEGIN:VEVENT", `UID:s${i}`, `DTSTART;VALUE=DATE:${a}`, `DTEND;VALUE=DATE:${b}`, "SUMMARY:Guest", "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");
const serve = (body: string) => setCalendarFetch(async (url) => ({ status: 200, url, async text() { return body; } }));
const codeOf = (reply: { structured?: Record<string, unknown> }): string => (reply.structured!.confirmation as { code: string }).code;

type Opts = {
  costLine?: number;
  stays?: [string, string][];
  lockLocation?: string;
  /** Seal the code with only a request key, so a fresh door access can't open it. */
  requestKeyOnly?: boolean;
  textsAllowed?: boolean;
  cleanings?: FixerDeps["cleanings"];
  send?: (to: string, body: string) => Promise<boolean>;
};

/** An activated property with Joe (preferred, texts on the line) and Sam (saved, not preferred), and one host job. */
async function setup(opts: Opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "fixer-visit-"));
  const account = mkdtempSync(join(tmpdir(), "fixer-visit-acct-"));
  dirs.push(root, account);
  let clock = new Date(NOW);
  let serverKey: string | undefined = SERVER_KEY;
  const env = (): NodeJS.ProcessEnv => (serverKey ? { CLEANER_CORE_PIN_KEY: serverKey } : {});
  const now = () => clock;
  const hub = hubFor(root, { now });
  hub.saveProperty(PROPERTY);
  hub.setCalendars({ calendars: [{ name: "Airbnb", url: LANE }], done: true });
  if (opts.requestKeyOnly) {
    serverKey = undefined;
    hub.doorAccess(env).save(CODE, opts.lockLocation, randomBytes(32));
  } else {
    hub.doorAccess(env).save(CODE, opts.lockLocation, undefined);
  }
  const people = () => peopleFor(account, { now });
  people().savePropertyPeople(PROPERTY_ID, HOST, []);
  const sent: { to: string; body: string }[] = [];
  const notes: { id: string; text: string }[] = [];
  const deps: FixerDeps = {
    now,
    env,
    propertyId: PROPERTY_ID,
    people,
    publicBase: () => BASE,
    photoKey: () => PHOTO_KEY,
    textsAllowed: async () => opts.textsAllowed ?? true,
    send: opts.send ?? (async (to, body) => {
      sent.push({ to, body });
      return true;
    }),
    notifyHost: async (id, text) => {
      notes.push({ id, text });
    },
    ...(opts.cleanings ? { cleanings: opts.cleanings } : {}),
  };
  const desk = () => fixerDeskFor(root, deps);
  await desk().savePro({ name: "Joe's Plumbing", trades: ["plumbing"], reach: { phone: JOE }, prefersText: true, preferredFor: [{ trade: "plumbing", rank: 1 }] });
  await desk().savePro({ name: "Sam Spigot", trades: ["plumbing"], reach: { phone: SAM } });
  await desk().saveSettings({ prosDone: true });
  await desk().saveSettings(opts.costLine ? { costLineCents: opts.costLine } : { costLineCents: null });
  await desk().saveSettings({ upkeepDone: true });
  expect((await desk().activate()).isError).toBe(false);
  people().optIn(JOE, PROPERTY_ID);
  serve(ics(...(opts.stays ?? [])));
  await desk().openJob({ trade: "plumbing", what: "Sink leaks", urgency: "soon", source: "host" });
  await desk().checkFixes({});
  const state = () => readFixer(root);
  /** The job opened last: the one from setup, unless a test opens another. */
  const job = () => state().jobs.at(-1)!;
  const pro = (name: string) => state().pros.find((p) => p.name.startsWith(name))!;
  const at = (iso: string | number) => {
    clock = new Date(iso);
  };
  /** Drops every desk and hub, as a restart would. */
  const restart = () => {
    resetFixerDesks();
    resetHubs();
  };
  return { root, desk, deps, people, state, job, pro, at, restart, sent, notes, setServerKey: (key: string | undefined) => (serverKey = key) };
}
type World = Awaited<ReturnType<typeof setup>>;

/** Books the job with the host's yes: Joe by default, or Sam after the host picks him. */
async function book(w: World, name: "Joe" | "Sam" = "Joe", span = TUE, extra: Record<string, unknown> = {}) {
  const id = w.pro(name).id;
  if (name === "Sam") {
    const first = await w.desk().pickPros({ jobId: w.job().id, ids: [id] });
    expect((await w.desk().pickPros({ jobId: w.job().id, ids: [id], confirmation: codeOf(first) })).isError).toBe(false);
  }
  const token = (await w.desk().contactPro({ jobId: w.job().id, to: id, how: "call" })).structured!.contactToken as string;
  expect((await w.desk().recordContact({ contactToken: token, outcome: "booked", ...span, estimateCents: 18000 })).isError).toBe(false);
  const first = await w.desk().approveBooking({ jobId: w.job().id, ...extra });
  const done = await w.desk().approveBooking({ jobId: w.job().id, ...extra, confirmation: codeOf(first) });
  expect(done.isError).toBe(false);
  expect(w.job().state).toBe("booked");
}

/** True when this text is exactly the code text, compared without printing it. */
const isCodeText = (body: string, lockLocation?: string) => body === codeText({ proName: "Joe's Plumbing", street: "12 Scratch Lane", code: CODE, ...(lockLocation ? { lockLocation } : {}) });
const noCodeIn = (text: string) => !text.includes(CODE);
/** A reveal as a word, so a failing assertion can never print a code. */
const outcome = (result: RevealResult): string => (result.ok ? (result.code === CODE ? "opened" : "wrong code") : result.reason);

describe("the clock pass and the code text", () => {
  it("runs a whole job: one code text, in progress, done with a photo, then the cost", async () => {
    const w = await setup({ lockLocation: "side door keypad" });
    await book(w);
    w.at(Date.parse(TUE.from) - 31 * MIN);
    await w.desk().tick();
    expect(w.sent.length).toBe(0);
    w.at(Date.parse(TUE.from) - 30 * MIN);
    await w.desk().tick();
    expect(w.sent.length).toBe(1);
    expect(w.sent[0]!.to).toBe(JOE);
    expect(isCodeText(w.sent[0]!.body, "side door keypad")).toBe(true);
    expect(w.sent[0]!.body.startsWith("Hi Joe's, the door code for 12 Scratch Lane is ")).toBe(true);
    expect(w.job()).toMatchObject({ state: "booked", codeTextSent: true });
    expect(w.job().codeTextAt).toBeDefined();
    expect(w.job().booking!.revealedAt).toHaveLength(1);
    expect(w.notes.map((n) => n.text)).toEqual(["Joe's Plumbing got the door code by text at 9:30."]);
    w.at(TUE.from);
    await w.desk().tick();
    expect(w.job().state).toBe("in-progress");
    await w.desk().tick();
    w.restart();
    await w.desk().tick();
    expect(w.sent.length).toBe(1);
    // The record holds no code anywhere.
    expect(noCodeIn(readFileSync(join(w.root, "fixer.json"), "utf8"))).toBe(true);

    w.at(Date.parse(TUE.from) + 90 * MIN);
    storePhoto(w.root, `fixer:${w.job().id}`, { bytes: Buffer.from("photo"), ext: "jpg" });
    const file = w.state();
    file.jobs[0]!.photos.push({ id: "1", from: "pro", at: new Date(Date.parse(TUE.from) + 90 * MIN).toISOString() });
    writeFixer(w.root, file);
    const done = await w.desk().recordDone({ jobId: w.job().id, note: "Replaced the trap" });
    expect(done.isError).toBe(false);
    expect(w.job()).toMatchObject({ state: "done", done: { by: "agent", note: "Replaced the trap" } });
    expect(w.job().news.some((n) => n.kind === "no-photos")).toBe(false);
    expect(w.pro("Joe").lastJobAt).toBeDefined();
    const cost = await w.desk().recordCost({ jobId: w.job().id, cents: 19000, by: "agent" });
    expect(cost.isError).toBe(false);
    expect(w.job().cost).toMatchObject({ cents: 19000, by: "agent" });
    const photos = await w.desk().jobPhotos(w.job().id);
    expect((photos.structured!.photos as unknown[]).length).toBe(1);
    expect(noCodeIn(JSON.stringify([done, cost, photos]))).toBe(true);
    // A done job gets no more texts or delay news.
    w.at(Date.parse(TUE.until) + 10 * MIN);
    await w.desk().tick();
    expect(w.sent.length).toBe(1);
    expect(w.notes.length).toBe(1);
  });

  it("marks the text before asking the hub, so the send sees it saved", async () => {
    let sawMark = false;
    let root = "";
    const w = await setup({
      send: async () => {
        sawMark = Boolean(readFixer(root).jobs[0]!.codeTextAt);
        return true;
      },
    });
    root = w.root;
    await book(w);
    w.at(TUE.from);
    await w.desk().tick();
    expect(sawMark).toBe(true);
    expect(w.job().codeTextSent).toBe(true);
  });

  it("after a restart between the mark and the send, sends nothing and leaves one note", async () => {
    const w = await setup();
    await book(w);
    // The state a crash right after the mark leaves behind.
    const file = w.state();
    file.jobs[0]!.codeTextAt = new Date(Date.parse(TUE.from) - 20 * MIN).toISOString();
    writeFixer(w.root, file);
    w.restart();
    w.at(Date.parse(TUE.from) - 15 * MIN);
    await w.desk().tick();
    await w.desk().tick();
    w.restart();
    await w.desk().tick();
    expect(w.sent.length).toBe(0);
    expect(w.notes.map((n) => n.text)).toEqual(["The door code text to Joe's Plumbing may not have gone out. Check with them, or let them in yourself."]);
    expect(w.job().codeNoteAt).toBeDefined();
  });

  it("a send that fails is never retried, and the host gets one note", async () => {
    let tries = 0;
    const w = await setup({
      send: async () => {
        tries += 1;
        return false;
      },
    });
    await book(w);
    w.at(TUE.from);
    await w.desk().tick();
    await w.desk().tick();
    expect(tries).toBe(1);
    expect(w.notes.map((n) => n.text)).toEqual(["The door code text to Joe's Plumbing may not have gone out. Check with them, or let them in yourself."]);
    expect(w.job().codeTextSent).toBeUndefined();
  });

  it("a hub refusal (no key after a restart) sends nothing and leaves one note", async () => {
    const w = await setup({ requestKeyOnly: true });
    await book(w);
    w.restart();
    w.at(Date.parse(TUE.from) - 10 * MIN);
    await w.desk().tick();
    await w.desk().tick();
    expect(w.sent.length).toBe(0);
    expect(w.notes.map((n) => n.text)).toEqual(["I couldn't open the door code for Joe's Plumbing's visit, so it wasn't sent. You'll need to let them in."]);
    // The mark was saved before the hub was asked, so the text is never tried again.
    expect(w.job().codeTextAt).toBe(new Date(Date.parse(TUE.from) - 10 * MIN).toISOString());
    expect(w.job().codeNoteAt).toBeDefined();
    expect(outcome(await w.desk().revealCode(w.job().id))).toBe("no-key");
    expect(w.notes.length).toBe(1);
  });

  it("texts only an opted-in pro who prefers text, while texts are allowed", async () => {
    const w = await setup({ textsAllowed: false });
    await book(w);
    w.at(TUE.from);
    await w.desk().tick();
    expect(w.sent.length).toBe(0);
    expect(w.job().codeTextAt).toBeUndefined();
    expect(w.job().state).toBe("in-progress");
  });

  it("never texts a pro who is also the property's cleaner: they use the visit page", async () => {
    const w = await setup();
    w.people().savePropertyPeople(PROPERTY_ID, HOST, [{ phone: JOE, role: "cleaner", name: "Joe" }]);
    expect(w.people().rolesOn(JOE, PROPERTY_ID)).toEqual(expect.arrayContaining(["pro", "cleaner"]));
    await book(w);
    w.at(TUE.from);
    await w.desk().tick();
    expect(w.sent.length).toBe(0);
    expect(w.job().codeTextAt).toBeUndefined();
    expect(outcome(await w.desk().revealCode(w.job().id))).toBe("opened");
  });

  it("never texts a pro who hasn't said YES", async () => {
    const w = await setup();
    await book(w, "Sam");
    w.at(TUE.from);
    await w.desk().tick();
    expect(w.sent.length).toBe(0);
    expect(w.job().codeTextAt).toBeUndefined();
  });
});

describe("the door code on the page", () => {
  it("is refused before the visit and after it", async () => {
    const w = await setup();
    await book(w, "Sam");
    w.at(Date.parse(TUE.from) - 31 * MIN);
    expect(outcome(await w.desk().revealCode(w.job().id))).toBe("before-visit");
    w.at(TUE.until);
    expect(outcome(await w.desk().revealCode(w.job().id))).toBe("after-visit");
    expect(w.job().booking!.revealedAt).toBeUndefined();
    expect(w.notes).toEqual([]);
  });

  it("is refused with access host", async () => {
    const w = await setup();
    await book(w, "Joe", TUE, { access: "host" });
    w.at(TUE.from);
    expect(outcome(await w.desk().revealCode(w.job().id))).toBe("host-access");
    await w.desk().tick();
    expect(w.sent.length).toBe(0);
  });

  it("waits on a checkout day until the guests have left", async () => {
    // Guests leave Tuesday at 11; the visit is 12 to 2.
    const span = { from: "2026-11-10T17:00:00.000Z", until: "2026-11-10T19:00:00.000Z" };
    const w = await setup({ stays: [["20261107", "20261110"]] });
    await book(w, "Sam", span);
    w.at(span.from);
    expect(outcome(await w.desk().revealCode(w.job().id))).toBe("guests-not-left");
    expect((await w.desk().guestsLeft({})).isError).toBe(true);
    expect((await w.desk().guestsLeft({ confirmed: true })).isError).toBe(false);
    expect(outcome(await w.desk().revealCode(w.job().id))).toBe("opened");
  });

  it("keeps the guests-left date for the property, so a job opened later that day sees it", async () => {
    const span = { from: "2026-11-10T17:00:00.000Z", until: "2026-11-10T19:00:00.000Z" };
    const w = await setup({ stays: [["20261107", "20261110"]] });
    w.at("2026-11-10T16:30:00.000Z");
    expect((await w.desk().guestsLeft({ confirmed: true })).isError).toBe(false);
    expect(w.state().clearedYmd).toBe("2026-11-10");
    expect((await w.desk().cancelJob({ jobId: w.job().id })).isError).toBe(false);
    await w.desk().openJob({ trade: "plumbing", what: "Toilet runs", urgency: "now", source: "host" });
    await book(w, "Sam", span);
    w.at(span.from);
    expect(outcome(await w.desk().revealCode(w.job().id))).toBe("opened");
  });

  it("counts Cleaner Core's clearance for the checkout day", async () => {
    const span = { from: "2026-11-10T17:00:00.000Z", until: "2026-11-10T19:00:00.000Z" };
    let cleared = false;
    const w = await setup({ stays: [["20261107", "20261110"]], cleanings: async () => ({ cleared }) });
    await book(w, "Sam", span, { cleaningOrder: "before" });
    w.at(span.from);
    expect(outcome(await w.desk().revealCode(w.job().id))).toBe("guests-not-left");
    cleared = true;
    expect(outcome(await w.desk().revealCode(w.job().id))).toBe("opened");
  });

  it("logs each reveal and tells the host in the exact words", async () => {
    const w = await setup();
    await book(w, "Sam");
    w.at("2026-11-10T15:04:00.000Z");
    expect(outcome(await w.desk().revealCode(w.job().id))).toBe("opened");
    await w.desk().revealCode(w.job().id);
    expect(w.job().booking!.revealedAt).toHaveLength(2);
    expect(w.notes.map((n) => n.text)).toEqual(["Sam Spigot opened the door code at 10:04.", "Sam Spigot opened the door code at 10:04."]);
    expect(w.job().news.filter((n) => n.kind === "revealed")).toHaveLength(2);
    expect(noCodeIn(readFileSync(join(w.root, "fixer.json"), "utf8"))).toBe(true);
  });
});

describe("price and cost", () => {
  it("holds a raised price over the cost line for the host's yes", async () => {
    const w = await setup({ costLine: 30_000 });
    await book(w);
    const raised = await w.desk().raisePrice(w.job().id, 42_000, "pro");
    expect(raised.structured).toMatchObject({ held: true, question: "Joe's Plumbing says the fix is $420.00, not $180.00. Go ahead?" });
    expect(w.job().booking!.revisedQuote).toMatchObject({ cents: 42_000 });
    expect(w.job().news.some((n) => n.kind === "raised-price")).toBe(false);
    const held = ((await w.desk().checkFixes({})).structured as { held: { jobId: string; revised?: unknown }[] }).held;
    expect(held).toEqual([expect.objectContaining({ jobId: w.job().id, revised: expect.objectContaining({ cents: 42_000 }) })]);
    const first = await w.desk().approveBooking({ jobId: w.job().id, revised: true });
    const yes = await w.desk().approveBooking({ jobId: w.job().id, revised: true, confirmation: codeOf(first) });
    expect(yes.isError).toBe(false);
    expect(w.job().booking!.revisedQuote!.hostYes).toBeDefined();
  });

  it("makes a raised price news, not a hold, with no cost line", async () => {
    const w = await setup();
    await book(w);
    const raised = await w.desk().raisePrice(w.job().id, 42_000, "pro");
    expect(raised.structured).toMatchObject({ held: false });
    const news = ((await w.desk().checkFixes({})).structured as { news: { kind: string; text?: string }[] }).news;
    expect(news).toEqual([expect.objectContaining({ kind: "raised-price", text: "Joe's Plumbing says the fix is $420.00, not $180.00." })]);
    expect((await w.desk().approveBooking({ jobId: w.job().id, revised: true })).isError).toBe(true);
  });

  it("refuses a raised price that isn't more than the estimate", async () => {
    const w = await setup();
    await book(w);
    expect((await w.desk().raisePrice(w.job().id, 18_000, "pro")).isError).toBe(true);
  });

  it("tells the host once when the cost is more than 20% over the estimate", async () => {
    const w = await setup();
    await book(w);
    await w.desk().recordDone({ jobId: w.job().id, cents: 21_000 });
    expect(w.job().news.some((n) => n.kind === "cost-over")).toBe(false);
    await w.desk().recordCost({ jobId: w.job().id, cents: 22_000, by: "host" });
    await w.desk().recordCost({ jobId: w.job().id, cents: 23_000, by: "host" });
    const over = w.job().news.filter((n) => n.kind === "cost-over");
    expect(over.map((n) => n.text)).toEqual(["Joe's Plumbing charged $220.00, more than 20% over the $180.00 estimate."]);
    expect(w.notes.filter((n) => n.text.includes("charged"))).toHaveLength(1);
    expect(w.job().cost).toMatchObject({ cents: 23_000, by: "host" });
  });

  it("tells the host when the job is done with no photos", async () => {
    const w = await setup();
    await book(w);
    await w.desk().recordDone({ jobId: w.job().id, by: "host" });
    expect(w.notes.map((n) => n.text)).toContain("Joe's Plumbing's job is marked done, but no photos came.");
    expect(w.job().done!.by).toBe("host");
  });
});

describe("turned off", () => {
  it("refuses the visit's tools while repairs are off", async () => {
    const w = await setup();
    await book(w);
    expect((await w.desk().turnOff(false)).isError).toBe(false);
    const id = w.job().id;
    const replies = [
      await w.desk().recordDone({ jobId: id }),
      await w.desk().recordCost({ jobId: id, cents: 100, by: "host" }),
      await w.desk().raisePrice(id, 42_000, "pro"),
      await w.desk().skipQuestion({ jobId: id, question: "preferred" }),
      await w.desk().changeDoorCode({ jobId: id }),
      await w.desk().guestsLeft({ confirmed: true }),
      await w.desk().extendVisit({ jobId: id, until: "2026-11-10T18:00:00.000Z" }),
    ];
    expect(replies.map((reply) => reply.text)).toEqual(Array(7).fill("Repairs aren't active yet. Call get_fixer_state."));
    expect(w.job().state).toBe("booked");
  });
});

describe("extending and delays", () => {
  it("extends with the host's yes and ends the visit link", async () => {
    const w = await setup();
    await book(w);
    const file = w.state();
    file.jobs[0]!.booking!.visitToken = "a".repeat(64);
    writeFixer(w.root, file);
    const until = "2026-11-10T18:00:00.000Z";
    const first = await w.desk().extendVisit({ jobId: w.job().id, until });
    expect(first.structured!.question).toBe("Give Joe's Plumbing until 1:00 to finish?");
    expect((await w.desk().extendVisit({ jobId: w.job().id, until: "2026-11-10T18:30:00.000Z", confirmation: codeOf(first) })).isError).toBe(true);
    const again = await w.desk().extendVisit({ jobId: w.job().id, until });
    expect((await w.desk().extendVisit({ jobId: w.job().id, until, confirmation: codeOf(again) })).isError).toBe(false);
    expect(w.job().booking!.extendedUntil).toBe(until);
    expect(w.job().booking!.visitToken).toBeUndefined();
  });

  it("refuses to extend past the next check-in minus the buffer", async () => {
    const span = { from: "2026-11-10T18:00:00.000Z", until: "2026-11-10T20:00:00.000Z" };
    const w = await setup({ stays: [["20261110", "20261113"]] });
    await book(w, "Joe", span);
    const reply = await w.desk().extendVisit({ jobId: w.job().id, until: "2026-11-10T20:30:00.000Z" });
    expect(reply.isError).toBe(true);
    expect(reply.structured?.confirmation).toBeUndefined();
    expect(w.job().booking!.extendedUntil).toBeUndefined();
  });

  it("tells the host once when the visit ends with no done", async () => {
    const w = await setup();
    await book(w, "Sam");
    w.at(TUE.until);
    await w.desk().tick();
    await w.desk().tick();
    expect(w.notes.map((n) => n.text)).toEqual(["Sam Spigot's visit was due to end at 12:00, and there's no done yet. Mark it done, give more time, rebook or cancel."]);
    const delays = ((await w.desk().checkFixes({})).structured as { delays: { jobId: string }[] }).delays;
    expect(delays).toEqual([expect.objectContaining({ jobId: w.job().id })]);
  });

  it("tells the host once when the visit ends within an hour of a check-in", async () => {
    const span = { from: "2026-11-10T18:00:00.000Z", until: "2026-11-10T20:00:00.000Z" };
    const w = await setup({ stays: [["20261110", "20261113"]] });
    await book(w, "Sam", span);
    w.at(span.until);
    await w.desk().tick();
    await w.desk().tick();
    expect(w.notes.map((n) => n.text)).toEqual(["Sam Spigot's visit was due to end at 3:00, and there's no done yet. Guests check in at 4:00."]);
  });
});

describe("after the visit", () => {
  async function doneWithReveal(w: World, name: "Joe" | "Sam") {
    await book(w, name);
    w.at(TUE.from);
    if (name === "Sam") await w.desk().revealCode(w.job().id);
    else await w.desk().tick();
    expect(w.job().booking!.revealedAt).toHaveLength(1);
    await w.desk().recordDone({ jobId: w.job().id });
  }
  const asks = async (desk: FixerDesk) => (await desk.checkFixes({})).structured as { preferredAsk: { jobId: string; question: string }[]; rotationAsk: { jobId: string; question: string }[] };

  it("asks the preferred question first, then the rotation question", async () => {
    const w = await setup();
    await doneWithReveal(w, "Sam");
    let now = await asks(w.desk());
    expect(now.preferredAsk).toEqual([{ jobId: w.job().id, question: "Add Sam Spigot to your preferred list for plumbing?" }]);
    expect(now.rotationAsk).toEqual([]);
    const skipped = await w.desk().skipQuestion({ jobId: w.job().id, question: "preferred" });
    expect(skipped.isError).toBe(false);
    now = await asks(w.desk());
    expect(now.preferredAsk).toEqual([]);
    expect(now.rotationAsk).toEqual([{ jobId: w.job().id, question: "Sam Spigot knows the door code. Want to change it? Set the new code on the lock, then save it here." }]);
    const change = await w.desk().changeDoorCode({ jobId: w.job().id });
    expect(change.isError).toBe(false);
    expect(String(change.structured!.uploadUrl).startsWith(BASE)).toBe(true);
    expect(noCodeIn(JSON.stringify(change))).toBe(true);
    expect(w.job().rotationAsked!.answer).toBe("yes");
    expect((await asks(w.desk())).rotationAsk).toEqual([]);
  });

  it("skips the rotation question on the host's no", async () => {
    const w = await setup();
    await doneWithReveal(w, "Sam");
    await w.desk().skipQuestion({ jobId: w.job().id, question: "preferred" });
    expect((await w.desk().skipQuestion({ jobId: w.job().id, question: "rotate" })).isError).toBe(false);
    expect(w.job().rotationAsked!.answer).toBe("no");
    expect((await asks(w.desk())).rotationAsk).toEqual([]);
  });

  it("asks no rotation question once the host adds the pro to the preferred list", async () => {
    const w = await setup();
    await doneWithReveal(w, "Sam");
    const input = { id: w.pro("Sam").id, name: "Sam Spigot", trades: ["plumbing" as const], reach: { phone: SAM }, preferredFor: [{ trade: "plumbing" as const, rank: 2 }], jobId: w.job().id };
    const first = await w.desk().savePro(input);
    expect((await w.desk().savePro({ ...input, confirmation: codeOf(first) })).isError).toBe(false);
    expect(w.job().preferredAsked!.answer).toBe("yes");
    const now = await asks(w.desk());
    expect(now.preferredAsk).toEqual([]);
    expect(now.rotationAsk).toEqual([]);
  });

  it("asks neither question for a preferred pro", async () => {
    const w = await setup();
    await doneWithReveal(w, "Joe");
    const now = await asks(w.desk());
    expect(now.preferredAsk).toEqual([]);
    expect(now.rotationAsk).toEqual([]);
  });

  it("drops a done job's photos 30 days after done", async () => {
    const w = await setup();
    await book(w);
    w.at(TUE.until);
    storePhoto(w.root, `fixer:${w.job().id}`, { bytes: Buffer.from("photo"), ext: "jpg" });
    await w.desk().recordDone({ jobId: w.job().id });
    const links = () => photoLinks(w.root, `fixer:${w.job().id}`, BASE, PHOTO_KEY, new Date(TUE.until));
    w.at(Date.parse(TUE.until) + 29 * 24 * 60 * MIN);
    await w.desk().tick();
    expect(links()).toHaveLength(1);
    w.at(Date.parse(TUE.until) + 30 * 24 * 60 * MIN);
    await w.desk().tick();
    expect(links()).toHaveLength(0);
  });
});

describe("final review fixes: new stays, the text path, candidates, photos", () => {
  const overlapNotes = (w: World) => w.notes.filter((n) => n.id.includes(":stay-over-booking"));

  it("re-checks a booked visit against a new stay: no code text, no code from the page, one host note", async () => {
    const w = await setup();
    await book(w);
    const tag = w.job().booking!.fingerprint;
    // A guest books Monday to Thursday after the Tuesday visit was booked.
    serve(ics(["20261109", "20261112"]));
    const fixes = await w.desk().checkFixes({});
    const held = (fixes.structured as { held: Record<string, unknown>[] }).held;
    expect(held).toEqual([expect.objectContaining({ jobId: w.job().id, overlapsStay: true, next: expect.stringContaining("reschedule_job or cancel_job") })]);
    expect(overlapNotes(w)).toHaveLength(1);
    expect(overlapNotes(w)[0]!.text).toBe(stayOverBookingNews({ proName: "Joe's Plumbing", from: TUE.from, timeZone: PROPERTY.timeZone }));
    expect(overlapNotes(w)[0]!.text).toBe("A stay on the calendar now overlaps Joe's Plumbing's repair visit Tuesday 10. The door code won't go out for it. Reschedule or cancel the visit?");
    expect(w.job().booking!.fingerprint).toBe(tag);
    w.at(Date.parse(TUE.from) - 10 * MIN);
    await w.desk().tick();
    await w.desk().tick();
    await w.desk().checkFixes({});
    expect(w.sent).toEqual([]);
    expect(w.job().codeTextAt).toBeUndefined();
    expect(outcome(await w.desk().revealCode(w.job().id))).toBe("overlaps-stay");
    expect(overlapNotes(w)).toHaveLength(1);
    expect(w.job().news.filter((n) => n.kind === "stay-over-booking")).toHaveLength(1);
  });

  it("the clock pass alone tells the host when another flow's read shows a stay over the visit", async () => {
    const w = await setup();
    await book(w);
    serve(ics(["20261109", "20261112"]));
    await hubFor(w.root, { now: () => NOW }).readCalendars({ tenantId: "cleaner" });
    w.at(Date.parse(TUE.from) - 10 * MIN);
    await w.desk().tick();
    await w.desk().tick();
    expect(w.sent).toEqual([]);
    expect(overlapNotes(w)).toHaveLength(1);
  });

  it("gives a text-path pro the visit page when texts can't go out here (host not confirmed)", async () => {
    const w = await setup({ textsAllowed: false });
    await book(w);
    const link = await w.desk().visitLink({ jobId: w.job().id });
    expect(link.isError, link.text).toBe(false);
    w.at(Date.parse(TUE.from) - 10 * MIN);
    await w.desk().tick();
    await w.desk().tick();
    expect(w.sent).toEqual([]);
    expect(outcome(await w.desk().revealCode(w.job().id))).toBe("opened");
  });

  it("tells the host once when the code would have gone by text but texts can't go out here", async () => {
    for (const deps of [{ textsAllowed: false }, { fixerOnly: true }]) {
      const w = await setup(deps.textsAllowed === false ? { textsAllowed: false } : {});
      if ("fixerOnly" in deps) delete w.deps.textsAllowed;
      await book(w);
      w.at(Date.parse(TUE.from) - 10 * MIN);
      await w.desk().tick();
      await w.desk().tick();
      expect(w.sent).toEqual([]);
      expect(w.notes.map((n) => n.text)).toEqual([codeTextOffNote({ proName: "Joe's Plumbing" })]);
      expect(w.notes[0]!.id).toMatch(/:code-text-off$/);
      expect((await w.desk().visitLink({ jobId: w.job().id })).isError).toBe(false);
      resetFixerDesks();
      resetHubs();
      resetPeople();
    }
    expect(codeTextOffNote({ proName: "Joe" })).toBe("Texts can't go out from this property yet, so Joe won't get the door code by text. Send them the visit link, or let them in yourself.");
  });

  /** Books a found candidate (Cara, with a phone) for the setup's job, with the host's yes. */
  async function bookCandidate(w: World) {
    const added = await w.desk().addCandidates({ jobId: w.job().id, candidates: [{ name: "Cara Pipes", reach: { phone: CARA } }] });
    const id = (added.structured!.candidates as { candidateId: string }[])[0]!.candidateId;
    const pick = await w.desk().pickPros({ jobId: w.job().id, ids: [id] });
    await w.desk().pickPros({ jobId: w.job().id, ids: [id], confirmation: codeOf(pick) });
    const token = (await w.desk().contactPro({ jobId: w.job().id, to: id, how: "call" })).structured!.contactToken as string;
    await w.desk().recordContact({ contactToken: token, outcome: "booked", ...TUE, estimateCents: 18000 });
    const first = await w.desk().approveBooking({ jobId: w.job().id });
    expect((await w.desk().approveBooking({ jobId: w.job().id, confirmation: codeOf(first) })).isError).toBe(false);
    return id;
  }

  it("lists a booked candidate with a phone as a pro in people.json while the booking is live", async () => {
    const w = await setup();
    expect(w.people().rolesOn(CARA, PROPERTY_ID)).toEqual([]);
    await bookCandidate(w);
    expect(w.people().rolesOn(CARA, PROPERTY_ID)).toEqual(["pro"]);
    const ask = await w.desk().cancelJob({ jobId: w.job().id });
    await w.desk().cancelJob({ jobId: w.job().id, confirmation: codeOf(ask) });
    expect(w.people().rolesOn(CARA, PROPERTY_ID)).toEqual([]);
  });

  it("asks no rotation question once the host adds a booked candidate to the preferred list", async () => {
    const w = await setup();
    await bookCandidate(w);
    w.at(Date.parse(TUE.from) - 10 * MIN);
    expect(outcome(await w.desk().revealCode(w.job().id))).toBe("opened");
    await w.desk().recordDone({ jobId: w.job().id });
    expect(w.people().rolesOn(CARA, PROPERTY_ID)).toEqual([]);
    const input = { name: "Cara Pipes", trades: ["plumbing" as const], reach: { phone: CARA }, preferredFor: [{ trade: "plumbing" as const, rank: 2 }], jobId: w.job().id };
    const first = await w.desk().savePro(input);
    const saved = await w.desk().savePro({ ...input, confirmation: codeOf(first) });
    expect(saved.isError, saved.text).toBe(false);
    expect(saved.structured!.rotationAsk).toBeUndefined();
    expect(((await w.desk().checkFixes({})).structured as { rotationAsk: unknown[] }).rotationAsk).toEqual([]);
  });

  it("drops a cancelled job's photos 30 days after the cancel", async () => {
    const w = await setup();
    storePhoto(w.root, `fixer:${w.job().id}`, { bytes: Buffer.from("photo"), ext: "jpg" });
    await w.desk().cancelJob({ jobId: w.job().id });
    const links = () => photoLinks(w.root, `fixer:${w.job().id}`, BASE, PHOTO_KEY, NOW);
    w.at(NOW.getTime() + 29 * 24 * 60 * MIN);
    await w.desk().tick();
    expect(links()).toHaveLength(1);
    w.at(NOW.getTime() + 30 * 24 * 60 * MIN);
    await w.desk().tick();
    expect(links()).toHaveLength(0);
  });

  it("keeps a held raised price in check_fixes' news for the job", async () => {
    const w = await setup({ costLine: 30_000 });
    await book(w);
    await w.desk().raisePrice(w.job().id, 42_000, "pro");
    const news = ((await w.desk().checkFixes({})).structured as { news: Record<string, unknown>[] }).news;
    expect(news).toEqual([expect.objectContaining({ jobId: w.job().id, kind: "raised-price-held", text: "Joe's Plumbing says the fix is $420.00, not $180.00. Go ahead?" })]);
  });
});

describe("residual fixes: the code goes one way only, unknown stays, the preferred alias", () => {
  it("never texts the code after the visit link was given, revoked, or ended by an extend", async () => {
    for (const end of ["revoke", "extend"] as const) {
      const w = await setup({ textsAllowed: false });
      await book(w);
      w.at(Date.parse(TUE.from) - 10 * MIN);
      await w.desk().tick();
      expect((await w.desk().visitLink({ jobId: w.job().id })).isError).toBe(false);
      expect(w.job().booking!.linkGivenAt).toBeDefined();
      if (end === "revoke") {
        expect((await w.desk().revokeVisit({ jobId: w.job().id })).isError).toBe(false);
      } else {
        const until = new Date(Date.parse(TUE.until) + 60 * MIN).toISOString();
        const ask = await w.desk().extendVisit({ jobId: w.job().id, until });
        expect((await w.desk().extendVisit({ jobId: w.job().id, until, confirmation: codeOf(ask) })).isError).toBe(false);
        expect(w.job().booking!.visitToken).toBeUndefined();
      }
      // Texts can go out now, and the pro is on the text path: still no text.
      w.deps.textsAllowed = async () => true;
      w.at(Date.parse(TUE.from) - 5 * MIN);
      await w.desk().tick();
      await w.desk().tick();
      expect(w.sent).toEqual([]);
      expect(w.job().codeTextAt).toBeUndefined();
      resetFixerDesks();
      resetHubs();
      resetPeople();
    }
  });

  it("sends no code text once the host was told it won't go by text, even when texts turn on", async () => {
    const w = await setup({ textsAllowed: false });
    await book(w);
    w.at(Date.parse(TUE.from) - 10 * MIN);
    await w.desk().tick();
    expect(w.notes.map((n) => n.id.split(":").at(-1))).toEqual(["code-text-off"]);
    w.deps.textsAllowed = async () => true;
    await w.desk().tick();
    expect(w.sent).toEqual([]);
    expect(w.notes).toHaveLength(1);
  });

  it("shows no code and texts none while the stays are unknown", async () => {
    const w = await setup();
    await book(w);
    // A hub.json from before stays were kept, and every read now fails.
    const hubPath = join(w.root, "hub.json");
    const hub = JSON.parse(readFileSync(hubPath, "utf8")) as Record<string, unknown>;
    delete hub.stays;
    writeFileSync(hubPath, JSON.stringify(hub));
    w.restart();
    setCalendarFetch(async (url) => ({ status: 500, url, async text() { return ""; } }));
    expect(hubFor(w.root, { now: () => NOW }).stays()).toBeUndefined();
    w.at(Date.parse(TUE.from) - 10 * MIN);
    await w.desk().tick();
    expect(w.sent).toEqual([]);
    expect(outcome(await w.desk().revealCode(w.job().id))).toBe("stays-unread");
  });

  it("still asks the rotation question for a booked saved pro when the host saves a different pro for the job", async () => {
    const w = await setup();
    await book(w, "Sam");
    w.at(Date.parse(TUE.from) - 10 * MIN);
    expect(outcome(await w.desk().revealCode(w.job().id))).toBe("opened");
    await w.desk().recordDone({ jobId: w.job().id });
    const input = { name: "Dana Drains", trades: ["plumbing" as const], reach: { phone: "+15555550147" }, preferredFor: [{ trade: "plumbing" as const, rank: 2 }], jobId: w.job().id };
    const first = await w.desk().savePro(input);
    const saved = first.structured?.confirmation ? await w.desk().savePro({ ...input, confirmation: codeOf(first) }) : first;
    expect(saved.isError, saved.text).toBe(false);
    expect(saved.structured!.rotationAsk).toBeDefined();
  });
});
