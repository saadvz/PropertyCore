import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixerDeskFor, resetFixerDesks, type FixerDeps, type FixerReply } from "../src/fixer-core/desk";
import { readFixer, tokenHash, writeFixer } from "../src/fixer-core/store";
import { FIXER_VISIT_PREFIX, handleVisitRequest, stripPhotoMetadata } from "../src/fixer-core/visitPage";
import { photoFolder } from "../src/cleaner-core/photos";
import { setCalendarFetch } from "../src/hub/calendarFetch";
import { hubFor, resetHubs } from "../src/hub/hub";
import { peopleFor, resetPeople } from "../src/hub/people";

/**
 * The pro's visit page: one link, the code only on the POST behind "I'm at the door" inside the
 * visit, photos without their location data, done, the amount and a raised price. Made-up pros,
 * 555 numbers, and a made-up door code that no assertion prints.
 */

const NOW = new Date("2026-11-08T15:00:00.000Z");
const PROPERTY = { nickname: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" };
const LANE = "https://calendar.example/lane.ics";
const CODE = ["4", "8", "1", "9", "2"].join("");
const SERVER_KEY = randomBytes(32).toString("base64");
const BASE = "https://fixer.example.com";
const HOST = "+15555550100";
const PROPERTY_ID = "prop_scratch";
const JOE = "+15555550142";
const SAM = "+15555550145";
/** Tuesday 10 to 12 local. */
const TUE = { from: "2026-11-10T15:00:00.000Z", until: "2026-11-10T17:00:00.000Z" };
const MIN = 60_000;
const HOUR = 60 * MIN;

const dirs: string[] = [];
afterEach(() => {
  setCalendarFetch(undefined);
  resetFixerDesks();
  resetHubs();
  resetPeople();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const serve = () =>
  setCalendarFetch(async (url) => ({
    status: 200,
    url,
    async text() {
      return ["BEGIN:VCALENDAR", "END:VCALENDAR"].join("\r\n");
    },
  }));
const codeOf = (reply: { structured?: Record<string, unknown> }): string => (reply.structured!.confirmation as { code: string }).code;

/** An activated property with Joe (preferred) and Sam (saved, not preferred, never texted), and one host job. */
async function setup(opts: { costLine?: number; lockLocation?: string; requestKeyOnly?: boolean; what?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fixer-page-"));
  const account = mkdtempSync(join(tmpdir(), "fixer-page-acct-"));
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
  const notes: { id: string; text: string }[] = [];
  const sent: { to: string; body: string }[] = [];
  let base: string | undefined = BASE;
  const deps: FixerDeps = {
    now,
    env,
    propertyId: PROPERTY_ID,
    people,
    publicBase: () => base,
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
  /** Every tool reply in the test, searched for the code at the end. */
  const replies: FixerReply[] = [];
  const keep = async (reply: Promise<FixerReply>) => {
    const done = await reply;
    replies.push(done);
    return done;
  };
  await desk().savePro({ name: "Joe's Plumbing", trades: ["plumbing"], reach: { phone: JOE }, prefersText: true, preferredFor: [{ trade: "plumbing", rank: 1 }] });
  await desk().savePro({ name: "Sam Spigot", trades: ["plumbing"], reach: { phone: SAM } });
  await desk().saveSettings({ prosDone: true });
  await desk().saveSettings(opts.costLine ? { costLineCents: opts.costLine } : { costLineCents: null });
  await desk().saveSettings({ upkeepDone: true });
  expect((await desk().activate()).isError).toBe(false);
  serve();
  await keep(desk().openJob({ trade: "plumbing", what: opts.what ?? "Sink leaks", urgency: "soon", source: "host" }));
  const state = () => readFixer(root);
  const job = () => state().jobs.at(-1)!;
  const pro = (name: string) => state().pros.find((p) => p.name.startsWith(name))!;
  const at = (iso: string | number) => {
    clock = new Date(iso);
  };
  const restart = () => {
    resetFixerDesks();
    resetHubs();
  };
  return { root, desk, deps, state, job, pro, at, restart, notes, sent, replies, keep, setBase: (value: string | undefined) => (base = value) };
}
type World = Awaited<ReturnType<typeof setup>>;

/** Books Sam with the host's yes and gives back the contact token. */
async function book(w: World, span = TUE, extra: Record<string, unknown> = {}): Promise<string> {
  const id = w.pro("Sam").id;
  const pick = await w.keep(w.desk().pickPros({ jobId: w.job().id, ids: [id] }));
  expect((await w.keep(w.desk().pickPros({ jobId: w.job().id, ids: [id], confirmation: codeOf(pick) }))).isError).toBe(false);
  const token = (await w.keep(w.desk().contactPro({ jobId: w.job().id, to: id, how: "call" }))).structured!.contactToken as string;
  expect((await w.keep(w.desk().recordContact({ contactToken: token, outcome: "booked", ...span, estimateCents: 18000 }))).isError).toBe(false);
  const first = await w.keep(w.desk().approveBooking({ jobId: w.job().id, ...extra }));
  expect((await w.keep(w.desk().approveBooking({ jobId: w.job().id, ...extra, confirmation: codeOf(first) }))).isError).toBe(false);
  expect(w.job().state).toBe("booked");
  return token;
}

/** The visit link's token, from the url visit_link gave. */
async function link(w: World): Promise<{ url: string; token: string }> {
  const reply = await w.keep(w.desk().visitLink({ jobId: w.job().id }));
  expect(reply.isError).toBe(false);
  const url = reply.structured!.url as string;
  expect(url.startsWith(`${BASE}${FIXER_VISIT_PREFIX}`)).toBe(true);
  return { url, token: url.slice(`${BASE}${FIXER_VISIT_PREFIX}`.length) };
}

type Res = { status: number; headers: Record<string, string>; body: string | Buffer };
const all: Res[] = [];
async function call(w: World, token: string, sub = "", method = sub ? "POST" : "GET", contentType = sub && sub !== "photo" ? "application/json" : "", body: Buffer | string = sub && sub !== "photo" ? "{}" : ""): Promise<Res> {
  const res = await handleVisitRequest(w.desk(), { method, sub, token, contentType, body: Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8") });
  all.push(res);
  return res;
}
const text = (res: Res) => (Buffer.isBuffer(res.body) ? res.body.toString("utf8") : res.body);
const json = (res: Res) => JSON.parse(text(res)) as Record<string, unknown>;
/** True when the response holds the code, checked without printing it. */
const holdsCode = (res: Res) => text(res).includes(CODE);
/** The door answer as a word, so a failing assertion never prints a code. */
const doorWord = (res: Res) => (res.status === 200 && json(res).code === CODE ? "opened" : res.status === 200 ? "wrong code" : `refused ${res.status}`);

function expectStrictHeaders(res: Res): void {
  expect(res.headers["Cache-Control"]).toBe("no-store");
  expect(res.headers["Referrer-Policy"]).toBe("no-referrer");
  expect(res.headers["X-Robots-Tag"]).toBe("noindex, nofollow");
  expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
  const csp = res.headers["Content-Security-Policy"]!;
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toMatch(/https?:|\*|data:|'unsafe-inline'|'unsafe-eval'/);
}

/** A JPEG with an APP0, an EXIF APP1 holding GPS, an IPTC APP13, a scan, and a trailer after the end. */
function jpegWithGps(): Buffer {
  const seg = (marker: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    seg(0xe1, Buffer.from("Exif\0\0GPSLatitude 40.88 GPSLongitude -74.01", "latin1")),
    seg(0xed, Buffer.from("Photoshop 3.0\0IPTC GPS city Teaneck", "latin1")),
    seg(0xdb, Buffer.alloc(65, 1)),
    seg(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]),
    Buffer.from([0xff, 0xd9]),
    Buffer.from("TRAILER GPS second image", "latin1"),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
}

function pngWithGps(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.alloc(13, 1)),
    pngChunk("eXIf", Buffer.from("MM\0*GPS 40.88", "latin1")),
    pngChunk("tEXt", Buffer.from("Comment\0GPS here", "latin1")),
    pngChunk("iTXt", Buffer.from("XML:com.adobe.xmp\0\0\0\0\0GPS xmp", "latin1")),
    pngChunk("IDAT", Buffer.from("pixels", "latin1")),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function webpChunk(type: string, data: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length);
  return Buffer.concat([Buffer.from(type, "latin1"), size, data, data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function webpWithGps(): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x0c | 0x10;
  const body = Buffer.concat([
    Buffer.from("WEBP", "latin1"),
    webpChunk("VP8X", vp8x),
    webpChunk("VP8 ", Buffer.from("frame", "latin1")),
    webpChunk("EXIF", Buffer.from("MM\0*GPS 40.88", "latin1")),
    webpChunk("XMP ", Buffer.from("<x>GPS</x>", "latin1")),
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), size, body]);
}

function savedPhotos(w: World): Buffer[] {
  const dir = join(w.root, "cleaner-job", "photos", photoFolder(`fixer:${w.job().id}`));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((file) => readFileSync(join(dir, file)));
}

describe("the visit link", () => {
  it("is refused before the host's yes, then given once, holding only letters and no code", async () => {
    const w = await setup();
    expect((await w.keep(w.desk().visitLink({ jobId: w.job().id }))).isError).toBe(true);
    await book(w);
    w.setBase(undefined);
    expect((await w.keep(w.desk().visitLink({ jobId: w.job().id }))).isError).toBe(true);
    w.setBase(BASE);
    const { url, token } = await link(w);
    expect(token).toMatch(/^[a-p]{64}$/);
    expect(url.includes(CODE)).toBe(false);
    expect(w.job().booking!.visitToken).toBe(tokenHash(token));
    const raw = readFileSync(join(w.root, "fixer.json"), "utf8");
    expect(raw.includes(token)).toBe(false);
    expect(raw.includes(CODE)).toBe(false);
    const again = await w.keep(w.desk().visitLink({ jobId: w.job().id }));
    expect(again.isError).toBe(true);
    expect(again.text.includes(token)).toBe(false);
  });

  it("ends on revoke_visit, and a new link can then be given", async () => {
    const w = await setup();
    await book(w);
    const first = await link(w);
    expect((await call(w, first.token)).status).toBe(200);
    expect((await w.keep(w.desk().revokeVisit({ jobId: w.job().id }))).isError).toBe(false);
    expect(w.job().booking!.visitToken).toBeUndefined();
    const gone = await call(w, first.token);
    expect(gone.status).toBe(404);
    expect(text(gone)).toContain("This visit has ended.");
    expect((await w.keep(w.desk().revokeVisit({ jobId: w.job().id }))).isError).toBe(true);
    const second = await link(w);
    expect(second.token).not.toBe(first.token);
    expect((await call(w, second.token)).status).toBe(200);
  });

  it("gets a new token on an extend: the old one ends", async () => {
    const w = await setup();
    await book(w);
    const first = await link(w);
    const until = new Date(Date.parse(TUE.until) + HOUR).toISOString();
    const ask = await w.keep(w.desk().extendVisit({ jobId: w.job().id, until }));
    expect((await w.keep(w.desk().extendVisit({ jobId: w.job().id, until, confirmation: codeOf(ask) }))).isError).toBe(false);
    expect((await call(w, first.token)).status).toBe(404);
    const second = await link(w);
    expect(second.token).not.toBe(first.token);
    // The extension counts: the page is live after the booked end.
    w.at(Date.parse(TUE.until) + 30 * MIN);
    expect((await call(w, second.token)).status).toBe(200);
  });

  it("gets a new token on a rebook: approve_booking clears the old one", async () => {
    const w = await setup();
    const contact = await book(w);
    const first = await link(w);
    // The reschedule path: the job goes back to contacted, the pro offers a new time and the host says yes.
    const file = w.state();
    file.jobs.at(-1)!.state = "contacted";
    writeFixer(w.root, file);
    const wed = { from: "2026-11-11T15:00:00.000Z", until: "2026-11-11T17:00:00.000Z" };
    expect((await w.keep(w.desk().recordContact({ contactToken: contact, outcome: "booked", ...wed, estimateCents: 18000 }))).isError).toBe(false);
    const ask = await w.keep(w.desk().approveBooking({ jobId: w.job().id }));
    expect((await w.keep(w.desk().approveBooking({ jobId: w.job().id, confirmation: codeOf(ask) }))).isError).toBe(false);
    expect(w.job().booking!.from).toBe(wed.from);
    expect(w.job().booking!.visitToken).toBeUndefined();
    expect((await call(w, first.token)).status).toBe(404);
    const second = await link(w);
    expect(second.token).not.toBe(first.token);
  });

  it("ends on a cancel, and none is given for a cancelled job", async () => {
    const w = await setup();
    await book(w);
    const first = await link(w);
    const ask = await w.keep(w.desk().cancelJob({ jobId: w.job().id }));
    expect((await w.keep(w.desk().cancelJob({ jobId: w.job().id, confirmation: codeOf(ask) }))).isError).toBe(false);
    const gone = await call(w, first.token);
    expect(gone.status).toBe(404);
    expect(text(gone)).toContain("This visit has ended.");
    expect((await w.keep(w.desk().visitLink({ jobId: w.job().id }))).isError).toBe(true);
  });

  it("answers an unknown or malformed token with 404", async () => {
    const w = await setup();
    await book(w);
    for (const token of ["a".repeat(64), "abc", "A".repeat(64), `${"a".repeat(63)}1`]) {
      const res = await call(w, token);
      expect(res.status).toBe(404);
      expect(text(res)).toContain("This visit has ended.");
    }
  });
});

describe("the page before, during and after the visit", () => {
  it("shows the time and job before, with the address only from 24 hours before, and never the code", async () => {
    const w = await setup({ what: "Sink <b>leaks</b> & drips" });
    await book(w);
    const { token } = await link(w);
    const early = await call(w, token);
    expect(early.status).toBe(200);
    expect(early.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    const page = text(early);
    expect(page).toContain("Sam Spigot");
    expect(page).toContain("Tuesday");
    expect(page).toContain("10:00 AM");
    expect(page).toContain("Sink &lt;b&gt;leaks&lt;/b&gt; &amp; drips");
    expect(page).not.toContain("<b>leaks");
    expect(page).not.toContain("12 Scratch Lane");
    expect(page).toContain("The door code shows here from 30 minutes before the visit.");
    expect(page).not.toContain("I'm at the door");
    expect(holdsCode(early)).toBe(false);
    w.at(Date.parse(TUE.from) - 24 * HOUR);
    const day = await call(w, token);
    expect(text(day)).toContain("12 Scratch Lane, Teaneck, NJ 07666");
    expect(text(day)).not.toContain("I'm at the door");
    // A door POST before the visit gets the reason and no code.
    const door = await call(w, token, "door");
    expect(doorWord(door)).toBe("refused 409");
    expect(json(door).error).toBe("The door code shows from 30 minutes before the visit.");
    expect(holdsCode(door)).toBe(false);
    expect(w.job().booking!.revealedAt).toBeUndefined();
    // Photos, done and a raised price wait for the visit too.
    expect((await call(w, token, "done")).status).toBe(409);
    expect((await call(w, token, "quote", "POST", "application/json", JSON.stringify({ cents: 30000 }))).status).toBe(409);
    expect((await call(w, token, "photo", "POST", "image/jpeg", jpegWithGps())).status).toBe(409);
    expect(w.job().state).toBe("booked");
  });

  it("shows the door button during the visit; GET never holds the code, only the door POST does", async () => {
    const w = await setup({ lockLocation: "side door keypad" });
    await book(w);
    const { token } = await link(w);
    w.at(Date.parse(TUE.from) - 30 * MIN);
    const during = await call(w, token);
    expect(during.status).toBe(200);
    expect(text(during)).toContain("I'm at the door");
    expect(text(during)).toContain("12 Scratch Lane");
    expect(holdsCode(during)).toBe(false);
    expect(text(during)).not.toContain("side door keypad");
    // A second device or a link preview: any number of GETs, still no code and no reveal.
    for (let i = 0; i < 3; i++) expect(holdsCode(await call(w, token))).toBe(false);
    expect(w.job().booking!.revealedAt).toBeUndefined();
    expect(w.notes).toEqual([]);
    // A GET to the door path is refused.
    const getDoor = await call(w, token, "door", "GET", "", "");
    expect(getDoor.status).toBe(405);
    expect(holdsCode(getDoor)).toBe(false);
    // A form post from another site can't send JSON: it is refused before any reveal.
    const form = await call(w, token, "door", "POST", "application/x-www-form-urlencoded", "");
    expect(form.status).toBe(415);
    expect(holdsCode(form)).toBe(false);
    expect(w.notes).toEqual([]);
    w.at("2026-11-10T15:04:00.000Z");
    const door = await call(w, token, "door");
    expect(doorWord(door)).toBe("opened");
    expect(door.headers["Content-Type"]).toBe("application/json; charset=utf-8");
    expect(json(door).lockLocation).toBe("side door keypad");
    expect(doorWord(await call(w, token, "door"))).toBe("opened");
    expect(w.job().booking!.revealedAt).toHaveLength(2);
    expect(w.notes.map((n) => n.text)).toEqual(["Sam Spigot opened the door code at 10:04.", "Sam Spigot opened the door code at 10:04."]);
    expect(holdsCode(await call(w, token))).toBe(false);
    expect(readFileSync(join(w.root, "fixer.json"), "utf8").includes(CODE)).toBe(false);
  });

  it("says the host will let them in for access host, and never shows a code", async () => {
    const w = await setup();
    await book(w, TUE, { access: "host" });
    const { token } = await link(w);
    w.at(TUE.from);
    const page = await call(w, token);
    expect(text(page)).toContain("The host will let you in.");
    expect(text(page)).not.toContain("I'm at the door");
    const door = await call(w, token, "door");
    expect(doorWord(door)).toBe("refused 409");
    expect(json(door).error).toBe("The host will let you in.");
    expect(holdsCode(door)).toBe(false);
  });

  it("a refused hub request (no key after a restart) shows no code and leaves one note", async () => {
    const w = await setup({ requestKeyOnly: true });
    await book(w);
    const { token } = await link(w);
    w.restart();
    w.at(TUE.from);
    const door = await call(w, token, "door");
    expect(doorWord(door)).toBe("refused 409");
    expect(json(door).error).toBe("The door code can't be shown. Ask the host to let you in.");
    expect(holdsCode(door)).toBe(false);
    expect(doorWord(await call(w, token, "door"))).toBe("refused 409");
    expect(w.notes.map((n) => n.text)).toEqual(["I couldn't open the door code for Sam Spigot's visit, so it wasn't sent. You'll need to let them in."]);
    expect(w.job().booking!.revealedAt).toBeUndefined();
  });

  it("takes the amount and done, then shows only that the visit has ended", async () => {
    const w = await setup();
    await book(w);
    const { token } = await link(w);
    w.at(Date.parse(TUE.from) + 60 * MIN);
    const photo = await call(w, token, "photo", "POST", "image/jpeg", jpegWithGps());
    expect(photo.status).toBe(200);
    const card = await call(w, token, "done", "POST", "application/json", JSON.stringify({ cents: 19000, note: "Paid with 4111 1111 1111 1111" }));
    expect(card.status).toBe(400);
    expect(w.job().state).toBe("booked");
    const extra = await call(w, token, "done", "POST", "application/json", JSON.stringify({ cents: 19000, tip: 5 }));
    expect(extra.status).toBe(400);
    const done = await call(w, token, "done", "POST", "application/json", JSON.stringify({ cents: 19000, note: "Replaced the trap, ref 99887766" }));
    expect(done.status).toBe(200);
    expect(w.job()).toMatchObject({ state: "done", done: { by: "pro-page", note: "Replaced the trap, ref [number removed]" }, cost: { cents: 19000, by: "pro" } });
    expect(w.job().news.some((n) => n.kind === "no-photos")).toBe(false);
    const after = await call(w, token);
    expect(after.status).toBe(404);
    expect(text(after)).toContain("This visit has ended.");
    expect(text(after)).not.toContain("Sam Spigot");
    expect((await call(w, token, "door")).status).toBe(404);
  });

  it("ends at the visit's end", async () => {
    const w = await setup();
    await book(w);
    const { token } = await link(w);
    w.at(TUE.until);
    const res = await call(w, token);
    expect(res.status).toBe(404);
    expect(text(res)).toContain("This visit has ended.");
  });

  it("takes a raised price, held for the host with a cost line", async () => {
    const w = await setup({ costLine: 30_000 });
    await book(w);
    const { token } = await link(w);
    w.at(TUE.from);
    const bad = await call(w, token, "quote", "POST", "application/json", JSON.stringify({ cents: "lots" }));
    expect(bad.status).toBe(400);
    const res = await call(w, token, "quote", "POST", "application/json", JSON.stringify({ cents: 42_000, note: "The trap is cracked" }));
    expect(res.status).toBe(200);
    expect(json(res).held).toBe(true);
    expect(w.job().booking!.revisedQuote).toMatchObject({ cents: 42_000, by: "pro" });
    expect(w.notes.map((n) => n.text)).toEqual(["Sam Spigot says the fix is $420.00, not $180.00. Go ahead?"]);
    expect(text(await call(w, token))).toContain("$420.00");
  });
});

describe("photos", () => {
  it("saves a JPEG with its GPS segments removed, from the pro", async () => {
    const w = await setup();
    await book(w);
    const { token } = await link(w);
    w.at(TUE.from);
    const res = await call(w, token, "photo", "POST", "image/jpeg", jpegWithGps());
    expect(res.status).toBe(200);
    const [saved] = savedPhotos(w);
    expect(saved).toBeDefined();
    const raw = saved!.toString("latin1");
    expect(raw.startsWith("\xff\xd8")).toBe(true);
    expect(raw.endsWith("\xff\xd9")).toBe(true);
    expect(raw).not.toContain("GPS");
    expect(raw).not.toContain("Exif");
    expect(raw).not.toContain("Photoshop");
    expect(raw).toContain("JFIF");
    expect(saved!.includes(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]))).toBe(true);
    expect(w.job().photos).toEqual([expect.objectContaining({ id: "1", from: "pro" })]);
  });

  it("removes eXIf, tEXt and iTXt from a PNG and EXIF and XMP from a WebP", () => {
    const png = stripPhotoMetadata(pngWithGps(), "png")!;
    expect(png.toString("latin1")).not.toContain("GPS");
    for (const kept of ["IHDR", "IDAT", "IEND"]) expect(png.toString("latin1")).toContain(kept);
    const webp = stripPhotoMetadata(webpWithGps(), "webp")!;
    const raw = webp.toString("latin1");
    expect(raw).not.toContain("GPS");
    expect(raw).not.toContain("EXIF");
    expect(raw).not.toContain("XMP ");
    expect(raw).toContain("VP8 ");
    expect(webp.readUInt32LE(4)).toBe(webp.length - 8);
    // The VP8X flags no longer claim EXIF or XMP; the alpha flag stays.
    expect(webp[20]! & 0x0c).toBe(0);
    expect(webp[20]! & 0x10).toBe(0x10);
  });

  it("refuses HEIC and HEIF, other types, a mismatched body, a broken JPEG and anything over 5 MB", async () => {
    const w = await setup();
    await book(w);
    const { token } = await link(w);
    w.at(TUE.from);
    expect((await call(w, token, "photo", "POST", "image/heic", Buffer.from("....ftypheic"))).status).toBe(415);
    expect((await call(w, token, "photo", "POST", "image/heif", Buffer.from("....ftypheif"))).status).toBe(415);
    expect((await call(w, token, "photo", "POST", "image/svg+xml", Buffer.from("<svg/>"))).status).toBe(415);
    expect((await call(w, token, "photo", "POST", "image/png", jpegWithGps())).status).toBe(415);
    expect((await call(w, token, "photo", "POST", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 0x01]))).status).toBe(415);
    const big = Buffer.concat([jpegWithGps(), Buffer.alloc(5 * 1024 * 1024)]);
    expect((await call(w, token, "photo", "POST", "image/jpeg", big)).status).toBe(413);
    expect(savedPhotos(w)).toEqual([]);
    expect(w.job().photos).toEqual([]);
    // PNG, WebP and GIF are kept.
    expect((await call(w, token, "photo", "POST", "image/png", pngWithGps())).status).toBe(200);
    expect((await call(w, token, "photo", "POST", "image/webp", webpWithGps())).status).toBe(200);
    expect((await call(w, token, "photo", "POST", "image/gif", Buffer.from("GIF89a....;", "latin1"))).status).toBe(200);
    expect(w.job().photos.map((p) => p.from)).toEqual(["pro", "pro", "pro"]);
  });

  it("keeps up to 10 photos", async () => {
    const w = await setup();
    await book(w);
    const { token } = await link(w);
    w.at(TUE.from);
    for (let i = 0; i < 10; i++) expect((await call(w, token, "photo", "POST", "image/jpeg", jpegWithGps())).status).toBe(200);
    expect((await call(w, token, "photo", "POST", "image/jpeg", jpegWithGps())).status).toBe(409);
    expect(w.job().photos).toHaveLength(10);
  });
});

describe("limits and headers", () => {
  it("answers 30 requests an hour per link, then 429, counting GETs and 404s", async () => {
    const w = await setup();
    await book(w);
    const { token } = await link(w);
    w.at(TUE.from);
    for (let i = 0; i < 15; i++) expect((await call(w, token)).status).toBe(200);
    // Done ends the page, but its requests still count.
    expect((await call(w, token, "done")).status).toBe(200);
    for (let i = 0; i < 14; i++) expect((await call(w, token)).status).toBe(404);
    const limited = await call(w, token);
    expect(limited.status).toBe(429);
    expect(holdsCode(limited)).toBe(false);
    w.at(Date.parse(TUE.from) + 61 * MIN);
    expect((await call(w, token)).status).toBe(404);
  });

  it("the 31st door POST is 429 and reveals nothing", async () => {
    const w = await setup();
    await book(w);
    const { token } = await link(w);
    w.at(TUE.from);
    for (let i = 0; i < 30; i++) await call(w, token);
    const door = await call(w, token, "door");
    expect(door.status).toBe(429);
    expect(holdsCode(door)).toBe(false);
    expect(w.job().booking!.revealedAt).toBeUndefined();
  });

  it("puts the strict headers on every response, and the page loads nothing from outside", async () => {
    const w = await setup();
    await book(w);
    const { token } = await link(w);
    w.at(TUE.from);
    const page = await call(w, token);
    const html = text(page);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    const nonce = /script-src 'nonce-([A-Za-z0-9+/=]+)'/.exec(page.headers["Content-Security-Policy"]!)?.[1];
    expect(nonce).toBeDefined();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect((await call(w, token)).headers["Content-Security-Policy"]).not.toContain(nonce!);
    await call(w, token, "door");
    await call(w, token, "nope");
    await call(w, "b".repeat(64));
    expect(all.length).toBeGreaterThan(0);
    for (const res of all) expectStrictHeaders(res);
  });

  it("never puts the code in a tool reply", async () => {
    const w = await setup();
    await book(w);
    await link(w);
    w.at(TUE.from);
    await w.keep(w.desk().state());
    await w.keep(w.desk().checkFixes({}));
    await w.keep(w.desk().revokeVisit({ jobId: w.job().id }));
    expect(w.replies.length).toBeGreaterThan(5);
    expect(w.replies.some((reply) => JSON.stringify(reply).includes(CODE))).toBe(false);
  });
});
