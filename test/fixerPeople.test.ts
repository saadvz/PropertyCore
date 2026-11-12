import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixerDeskFor, resetFixerDesks, type FixerDeps } from "../src/fixer-core/desk";
import { proRoute } from "../src/fixer-core/proLine";
import { PRO_DONE_ACK, PRO_HURT, PRO_HURT_CALL, proHurtNews, proInvite, proTextFailed } from "../src/fixer-core/texts";
import { readFixer, writeFixer, type Job } from "../src/fixer-core/store";
import { randomBytes } from "node:crypto";
import { photoCount, setCleanerPhotoFetch } from "../src/cleaner-core/photos";
import type { Property } from "../src/cleaner-core/hosted/properties";
import { peopleFor, resetPeople } from "../src/hub/people";
import { hubFor, resetHubs } from "../src/hub/hub";

/** Saved pros are role "pro" in people.json. Only 555 numbers and made-up pros. */

const NOW = new Date("2026-11-08T15:00:00.000Z");
const A = "prp_aaaaaaaaaa";
const B = "prp_bbbbbbbbbb";
const HOST = "+15555550100";
const JOE = "+15555550142";

const dirs: string[] = [];
afterEach(() => {
  setCleanerPhotoFetch(undefined);
  resetFixerDesks();
  resetHubs();
  resetPeople();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(propertyId = A, account = mkdtempSync(join(tmpdir(), "fixer-people-")), extra: Partial<FixerDeps> = {}) {
  dirs.push(account);
  const root = mkdtempSync(join(tmpdir(), "fixer-prop-"));
  dirs.push(root);
  hubFor(root, { now: () => NOW }).saveProperty({ address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" });
  const people = () => peopleFor(account, { now: () => NOW });
  people().savePropertyPeople(propertyId, HOST, []);
  const desk = fixerDeskFor(root, { now: () => NOW, propertyId, people, ...extra });
  return { account, root, desk, people: people() };
}

const joe = { name: "Joe's Plumbing", trades: ["plumbing" as const], reach: { phone: JOE } };
const roles = (people: ReturnType<typeof setup>["people"], phone: string, propertyId = A) => people.rolesOn(phone, propertyId);

describe("pros in people.json", () => {
  it("lists a saved pro with a phone as role pro, with their name", () => {
    const { desk, people } = setup();
    return desk.savePro(joe).then(() => {
      expect(roles(people, JOE)).toEqual(["pro"]);
      expect(people.person(JOE)!.name).toBe("Joe's Plumbing");
    });
  });

  it("does not list a draft, or a pro with no phone", async () => {
    const { desk, people } = setup();
    await desk.savePro({ ...joe, draft: true });
    await desk.savePro({ name: "Ana Electric", trades: ["electrical"], reach: { email: "ana@example.com" } });
    expect(people.person(JOE)).toBeUndefined();
    expect(people.everyone()).toEqual([]);
  });

  it("lists a draft once the host confirms it", async () => {
    const { desk, people } = setup();
    const id = (await desk.savePro({ ...joe, draft: true })).structured!.proId as string;
    expect(roles(people, JOE)).toEqual([]);
    await desk.savePro({ confirm: [id] });
    expect(roles(people, JOE)).toEqual(["pro"]);
  });

  it("removes the role when the pro is removed, and keeps the other pros", async () => {
    const { desk, people } = setup();
    const id = (await desk.savePro(joe)).structured!.proId as string;
    await desk.savePro({ name: "Sam Handyman", trades: ["handyman"], reach: { phone: "+15555550143" } });
    await desk.removePro({ id });
    expect(roles(people, JOE)).toEqual([]);
    expect(roles(people, "+15555550143")).toEqual(["pro"]);
  });

  it("moves the role when a pro's phone changes", async () => {
    const { desk, people } = setup();
    const id = (await desk.savePro(joe)).structured!.proId as string;
    await desk.savePro({ ...joe, id, reach: { phone: "+15555550177" } });
    expect(roles(people, JOE)).toEqual([]);
    expect(roles(people, "+15555550177")).toEqual(["pro"]);
  });

  it("keeps id and addedAt when edited by id", async () => {
    const { root, desk } = setup();
    const id = (await desk.savePro(joe)).structured!.proId as string;
    const before = readFixer(root).pros[0]!;
    await desk.savePro({ ...joe, id, name: "Joe's Plumbing & Heating", trades: ["plumbing", "hvac"] });
    const [after] = readFixer(root).pros;
    expect(readFixer(root).pros).toHaveLength(1);
    expect(after).toMatchObject({ id, addedAt: before.addedAt, name: "Joe's Plumbing & Heating", trades: ["plumbing", "hvac"] });
  });

  it("does not take the property's cleaner role away, and the cleaner's save does not take the pro role", async () => {
    const { desk, people } = setup();
    people.savePropertyPeople(A, HOST, [{ phone: JOE, role: "cleaner", name: "Joe" }]);
    await desk.savePro(joe);
    expect(roles(people, JOE).sort()).toEqual(["cleaner", "pro"]);
    people.savePropertyPeople(A, HOST, []);
    expect(roles(people, JOE)).toEqual(["pro"]);
  });

  it("refuses the host's own number", async () => {
    const { desk } = setup();
    const reply = await desk.savePro({ ...joe, reach: { phone: HOST } });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("host's own");
  });

  it("needs shared: true for a number already on another property", async () => {
    const first = setup(A);
    await first.desk.savePro(joe);
    const second = setup(B, first.account);
    const refused = await second.desk.savePro(joe);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("shared: true");
    expect(roles(second.people, JOE, B)).toEqual([]);
    expect((await second.desk.savePro({ ...joe, shared: true })).isError).toBe(false);
    expect(roles(second.people, JOE, B)).toEqual(["pro"]);
    expect(roles(second.people, JOE, A)).toEqual(["pro"]);
  });

  it("works without a people list (a standalone desk)", async () => {
    const root = mkdtempSync(join(tmpdir(), "fixer-alone-"));
    dirs.push(root);
    const desk = fixerDeskFor(root, { now: () => NOW });
    expect((await desk.savePro(joe)).isError).toBe(false);
  });
});

/** The line part: a pro texts the shared line. Made-up pros, 555 numbers, example.com photos. */
const SAM = "+15555550143";
const MIN = 60_000;
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("made-up photo"), Buffer.from([0xff, 0xd9])]);
const ENV = { CLEANER_CORE_TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`, CLEANER_CORE_TWILIO_AUTH_TOKEN: "made-up-token", CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv;

function lineSetup(opts: { texts?: boolean; business?: string | undefined } = {}) {
  const sent: { to: string; body: string }[] = [];
  const notes: { id: string; text: string }[] = [];
  const base = setup(A, undefined, {
    env: () => ENV,
    textsAllowed: async () => opts.texts ?? true,
    business: async () => opts.business ?? "Scratch Rentals",
    send: async (to, body) => {
      sent.push({ to, body });
      return true;
    },
    notifyHost: async (id, text) => {
      notes.push({ id, text });
    },
  });
  return { ...base, sent, notes, hub: () => hubFor(base.root, { now: () => NOW }) };
}
type Line = ReturnType<typeof lineSetup>;

/** Joe saved, opted in, with a booked job whose visit has started. */
async function inProgress(w: Line, estimateCents = 18000, state: "in-progress" | "booked" = "in-progress") {
  await w.desk.savePro({ ...joe, prefersText: true });
  w.people.optIn(JOE, A);
  const file = readFixer(w.root);
  const job: Job = { id: "job_abcde12345", trade: "plumbing", what: "Sink leaks", source: "host", photos: [], urgency: "soon", state, candidates: [], picked: [], contacts: [], news: [], createdAt: NOW.toISOString() };
  file.jobs.push(job);
  job.booking = {
    proId: file.pros[0]!.id,
    from: new Date(NOW.getTime() - 10 * MIN).toISOString(),
    until: new Date(NOW.getTime() + 110 * MIN).toISOString(),
    estimateCents,
    access: "host",
    hostYes: { at: NOW.toISOString() },
    fingerprint: "fp",
  };
  file.settings.activatedAt = NOW.toISOString();
  writeFixer(w.root, file);
  return job.id;
}
const job0 = (w: Line) => readFixer(w.root).jobs[0]!;
let n = 0;
const text = (from: string, body: string, media?: { url: string; contentType: string }[]) => ({ id: `m${++n}`, from, text: body, ...(media ? { media } : {}) });

describe("the invite", () => {
  it("goes once, to a pro who asked for texts, after the host saved them and the host is confirmed", async () => {
    const w = lineSetup();
    await w.desk.savePro({ ...joe, prefersText: true });
    expect(w.sent).toEqual([{ to: JOE, body: proInvite({ proName: "Joe's Plumbing", business: "Scratch Rentals", street: "12 Scratch Lane" }) }]);
    await w.desk.savePro({ ...joe, prefersText: true, id: readFixer(w.root).pros[0]!.id, name: "Joe's Plumbing LLC" });
    expect(w.sent).toHaveLength(1);
  });

  it("is not sent to a pro who did not ask, to a draft, or before the host is confirmed", async () => {
    const w = lineSetup();
    await w.desk.savePro(joe);
    await w.desk.savePro({ name: "Sam", trades: ["handyman"], reach: { phone: SAM }, prefersText: true, draft: true });
    expect(w.sent).toEqual([]);
    const held = lineSetup({ texts: false });
    await held.desk.savePro({ ...joe, prefersText: true });
    expect(held.sent).toEqual([]);
  });

  it("is sent again when the saved pro's phone changes, and not to someone who said YES or STOP", async () => {
    const w = lineSetup();
    const id = (await w.desk.savePro({ ...joe, prefersText: true })).structured!.proId as string;
    await w.desk.savePro({ ...joe, prefersText: true, id, reach: { phone: SAM } });
    expect(w.sent.map((m) => m.to)).toEqual([JOE, SAM]);
    const yes = lineSetup();
    yes.people.optIn(JOE, A);
    await yes.desk.savePro({ ...joe, prefersText: true });
    expect(yes.sent).toEqual([]);
  });

  it("is not sent to a pro who is also the property's cleaner", async () => {
    const w = lineSetup();
    w.people.savePropertyPeople(A, HOST, [{ phone: JOE, role: "cleaner", name: "Joe" }]);
    await w.desk.savePro({ ...joe, prefersText: true });
    expect(w.sent).toEqual([]);
  });

  it("never lets a text contact reach a pro who has not said YES", async () => {
    const w = lineSetup();
    await w.desk.savePro({ ...joe, prefersText: true });
    const file = readFixer(w.root);
    file.jobs.push({ id: "job_abcde12345", trade: "plumbing", what: "Sink leaks", source: "host", photos: [], urgency: "soon", state: "shortlisted", candidates: [], picked: [], contacts: [], news: [], createdAt: NOW.toISOString() });
    writeFixer(w.root, file);
    const reply = await w.desk.contactPro({ jobId: file.jobs[0]!.id, to: file.pros[0]!.id, how: "text" });
    expect(reply.isError).toBe(true);
    expect(w.sent).toHaveLength(1);
  });
});

describe("proRoute", () => {
  const prop = (id: string, fixer: boolean): Property => ({ id, label: id, createdAt: "x", flows: { cleaning: { on: true }, supplies: { on: false }, fixer: { on: fixer } } }) as Property;
  it("lists the fixer properties where the sender is a pro", async () => {
    const w = setup();
    await w.desk.savePro(joe);
    w.people.savePropertyPeople(B, HOST, []);
    expect(proRoute({ properties: [prop(A, true), prop(B, true)] }, w.people, JOE)?.map((p) => p.id)).toEqual([A]);
    expect(proRoute({ properties: [prop(A, false)] }, w.people, JOE)).toBeUndefined();
    expect(proRoute({ properties: [prop(A, true)] }, w.people, SAM)).toBeUndefined();
  });

  it("sends a pro who is also a cleaner anywhere on the account to Cleaner Core", async () => {
    const w = setup();
    await w.desk.savePro(joe);
    w.people.savePropertyPeople(B, "+15555550101", [{ phone: JOE, role: "cleaner", name: "Joe" }]);
    expect(proRoute({ properties: [prop(A, true), prop(B, true)] }, w.people, JOE)).toBeUndefined();
    const cleaner = setup();
    cleaner.people.savePropertyPeople(A, HOST, [{ phone: JOE, role: "cleaner", name: "Joe" }]);
    await cleaner.desk.savePro(joe);
    expect(proRoute({ properties: [prop(A, true)] }, cleaner.people, JOE)).toBeUndefined();
  });
});

describe("a pro's text on the line", () => {
  it("YES opts in, STOP and START cover the whole account, HELP does nothing", async () => {
    const w = lineSetup();
    await w.desk.savePro({ ...joe, prefersText: true });
    await w.desk.proInbound(text(JOE, "YES"));
    expect(w.people.optedIn(JOE)).toBe(true);
    await w.desk.proInbound(text(JOE, "STOP"));
    expect(w.people.stopped(JOE)).toBe(true);
    await w.desk.proInbound(text(JOE, "HELP"));
    expect(w.people.stopped(JOE)).toBe(true);
    await w.desk.proInbound(text(JOE, "START"));
    expect(w.people.stopped(JOE)).toBe(false);
    expect(w.sent.filter((m) => m.body !== proInvite({ proName: "Joe's Plumbing", business: "Scratch Rentals", street: "12 Scratch Lane" }))).toEqual([]);
  });

  it("answers an injury with the 911 text and tells the host, naming no other property", async () => {
    const w = lineSetup();
    await inProgress(w);
    w.sent.length = 0;
    await w.desk.proInbound(text(JOE, "I fell off the ladder"));
    expect(w.sent).toEqual([{ to: JOE, body: PRO_HURT }]);
    expect(PRO_HURT).toBe("If someone is hurt, call 911 now. I've let the host know.");
    expect(w.notes).toHaveLength(1);
    expect(w.notes[0]!.text).toContain("12 Scratch Lane");
  });

  it("DONE with photos marks the job done by pro-text and saves the photos", async () => {
    const w = lineSetup();
    const id = await inProgress(w);
    const urls: string[] = [];
    setCleanerPhotoFetch(async (url) => {
      urls.push(url);
      return new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } });
    });
    const media = [1, 2].map((i) => ({ url: `https://api.twilio.com/2010-04-01/Accounts/${ENV.CLEANER_CORE_TWILIO_ACCOUNT_SID}/Messages/MM${i}/Media/ME${i}`, contentType: "image/jpeg" }));
    await w.desk.proInbound(text(JOE, "Done", media));
    const job = job0(w);
    expect(job).toMatchObject({ id, state: "done", done: { by: "pro-text" } });
    expect(job.photos.map((p) => p.from)).toEqual(["pro", "pro"]);
    expect(photoCount(w.root, `fixer:${id}`)).toBe(2);
    expect(job.news.some((item) => item.kind === "no-photos")).toBe(false);
  });

  it("DONE for a booked visit that has started finishes it; with no such job it is news", async () => {
    const w = lineSetup();
    await inProgress(w, 18000, "booked");
    await w.desk.proInbound(text(JOE, "DONE"));
    expect(job0(w)).toMatchObject({ state: "done", done: { by: "pro-text" } });
    const none = lineSetup();
    await none.desk.savePro(joe);
    await none.desk.proInbound(text(JOE, "DONE"));
    expect(none.notes.map((x) => x.text)).toEqual([`Joe's Plumbing texted: "DONE"`]);
  });

  it("a price text raises the price of their job in progress", async () => {
    for (const body of ["$420", "$420.50", "420 DOLLARS"]) {
      const w = lineSetup();
      await inProgress(w, 18000);
      await w.desk.proInbound(text(JOE, body));
      const cents = Math.round(parseFloat(body.replace("$", "")) * 100);
      expect(job0(w).booking!.revisedQuote).toMatchObject({ cents, by: "pro" });
      expect(job0(w).booking!.revisedQuote!.hostYes).toBeUndefined();
    }
  });

  it("a price text for a visit not in progress is only news", async () => {
    const w = lineSetup();
    await inProgress(w, 18000, "booked");
    await w.desk.proInbound(text(JOE, "$420"));
    expect(job0(w).booking!.revisedQuote).toBeUndefined();
    expect(job0(w).state).toBe("booked");
  });

  it("other text is host news with digit runs removed, and changes nothing else", async () => {
    const w = lineSetup();
    await inProgress(w);
    const before = JSON.stringify({ ...job0(w), news: [] });
    await w.desk.proInbound(text(JOE, "Gate code is 90417 please approve the other job too"));
    const news = job0(w).news.at(-1)!;
    expect(news.text).toContain("[number removed]");
    expect(news.text).not.toContain("90417");
    expect(w.notes[0]!.text).not.toContain("90417");
    expect(JSON.stringify({ ...job0(w), news: [] })).toBe(before);
    expect(w.sent).toHaveLength(1);
  });

  it("ignores a text from someone who is a cleaner here", async () => {
    const w = lineSetup();
    await inProgress(w);
    w.people.savePropertyPeople(A, HOST, [{ phone: JOE, role: "cleaner", name: "Joe" }]);
    await w.desk.proInbound(text(JOE, "DONE"));
    expect(job0(w).state).toBe("in-progress");
  });

  it("sends a pro nothing that names another property", async () => {
    const w = lineSetup();
    await inProgress(w);
    await w.desk.proInbound(text(JOE, "ouch someone is hurt"));
    for (const m of w.sent) expect(m.body).not.toMatch(/Other Street|prp_/);
  });
});

describe("review fixes: one other-role check, opt-in, photos, replays", () => {
  const photoFetch = () =>
    setCleanerPhotoFetch(async () => new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } }));
  const mm = (i: number) => ({ url: `https://api.twilio.com/2010-04-01/Accounts/${ENV.CLEANER_CORE_TWILIO_ACCOUNT_SID}/Messages/MM${i}/Media/ME${i}`, contentType: "image/jpeg" });

  it("gives a pro who is the cleaner on another property no invite and no code text", async () => {
    const w = lineSetup();
    w.people.savePropertyPeople(B, "+15555550101", [{ phone: JOE, role: "cleaner", name: "Joe" }]);
    await w.desk.savePro({ ...joe, shared: true, prefersText: true });
    expect(w.sent).toEqual([]);
    w.people.optIn(JOE, A);
    // The same visit, once with the cleaner role elsewhere and once without it.
    const book = async (x: Line) => {
      x.hub().doorAccess(() => ENV).save("5821", undefined, undefined);
      const file = readFixer(x.root);
      file.settings.activatedAt = NOW.toISOString();
      file.jobs.push({ id: "job_abcde12345", trade: "plumbing", what: "Sink", source: "host", photos: [], urgency: "soon", state: "booked", candidates: [], picked: [], contacts: [], news: [], createdAt: NOW.toISOString(), booking: { proId: file.pros[0]!.id, from: new Date(NOW.getTime() + 20 * MIN).toISOString(), until: new Date(NOW.getTime() + 140 * MIN).toISOString(), access: "code", hostYes: { at: NOW.toISOString() }, fingerprint: "fp" } });
      writeFixer(x.root, file);
      await x.desk.tick();
    };
    await book(w);
    expect(job0(w).codeTextAt).toBeUndefined();
    expect(w.sent).toEqual([]);
    const control = lineSetup();
    await control.desk.savePro({ ...joe, prefersText: true });
    control.people.optIn(JOE, A);
    await book(control);
    expect(job0(control).codeTextAt).toBeDefined();
  });

  it("invites each phone once even when the pro's phone goes A to B to A", async () => {
    const w = lineSetup();
    const id = (await w.desk.savePro({ ...joe, prefersText: true })).structured!.proId as string;
    await w.desk.savePro({ ...joe, prefersText: true, id, reach: { phone: SAM } });
    await w.desk.savePro({ ...joe, prefersText: true, id });
    expect(w.sent.map((m) => m.to)).toEqual([JOE, SAM]);
  });

  it("treats DONE and a price from a pro who has not said YES, or has stopped, as news", async () => {
    const w = lineSetup();
    await inProgress(w);
    w.people.stop(JOE);
    await w.desk.proInbound(text(JOE, "DONE"));
    await w.desk.proInbound(text(JOE, "$420"));
    expect(job0(w).state).toBe("in-progress");
    expect(job0(w).booking!.revisedQuote).toBeUndefined();
    expect(job0(w).news.filter((x) => x.kind === "pro-text")).toHaveLength(2);
    expect(w.sent.filter((m) => m.body === PRO_DONE_ACK)).toEqual([]);
  });

  it("keeps a photo-only text's photos for the job with no empty news, and a non-DONE text with photos is news too", async () => {
    const w = lineSetup();
    const id = await inProgress(w);
    photoFetch();
    await w.desk.proInbound(text(JOE, "", [mm(1)]));
    expect(photoCount(w.root, `fixer:${id}`)).toBe(1);
    expect(job0(w).photos).toHaveLength(1);
    expect(job0(w).news).toEqual([]);
    expect(w.notes).toEqual([]);
    await w.desk.proInbound(text(JOE, "under the sink", [mm(2)]));
    expect(photoCount(w.root, `fixer:${id}`)).toBe(2);
    expect(job0(w).news.map((x) => x.kind)).toEqual(["pro-text"]);
    expect(job0(w).state).toBe("in-progress");
  });

  it("thanks an opted-in pro for DONE, and says nothing back to a price", async () => {
    const w = lineSetup();
    await inProgress(w);
    w.sent.length = 0;
    await w.desk.proInbound(text(JOE, "$420"));
    expect(w.sent).toEqual([]);
    await w.desk.proInbound(text(JOE, "DONE"));
    expect(w.sent).toEqual([{ to: JOE, body: "Thanks, marked done." }]);
  });

  it("tells the host when a text could not be handled", async () => {
    const w = lineSetup();
    await inProgress(w);
    writeFileSync(join(w.root, "fixer.json"), "{ not json");
    await w.desk.proInbound(text(JOE, "hello"));
    expect(w.notes.map((x) => x.text)).toEqual([proTextFailed({ proName: "A pro" })]);
    expect(proTextFailed({ proName: "Joe" })).toBe("A text from Joe couldn't be handled. Check with them.");
  });

  it("ignores a replayed message id, and keeps only the last 200", async () => {
    const w = lineSetup();
    await inProgress(w);
    await w.desk.proInbound({ id: "SM1", from: JOE, text: "all good here" });
    await w.desk.proInbound({ id: "SM1", from: JOE, text: "all good here" });
    expect(job0(w).news.filter((x) => x.kind === "pro-text")).toHaveLength(1);
    for (let i = 0; i < 205; i++) await w.desk.proInbound({ id: `X${i}`, from: JOE, text: "HELP" });
    const seen = readFixer(w.root).seenInbound!;
    expect(seen).toHaveLength(200);
    expect(seen.at(-1)).toBe("X204");
  });

  it("lets an injury win over a text that is also DONE or a price", async () => {
    const w = lineSetup();
    await inProgress(w);
    await w.desk.proInbound(text(JOE, "DONE, my helper fell"));
    await w.desk.proInbound(text(JOE, "$420 and he is bleeding"));
    expect(job0(w).state).toBe("in-progress");
    expect(job0(w).booking!.revisedQuote).toBeUndefined();
    expect(w.sent.filter((m) => m.body === PRO_HURT)).toHaveLength(2);
  });

  it("STOP for a pro saved on two properties stops texts on both", async () => {
    const first = lineSetup();
    await first.desk.savePro({ ...joe, prefersText: true });
    const second = setup(B, first.account);
    await second.desk.savePro({ ...joe, shared: true });
    first.people.optIn(JOE, A);
    await first.desk.proInbound(text(JOE, "STOP"));
    expect(second.people.stopped(JOE)).toBe(true);
    expect(roles(second.people, JOE, B)).toEqual(["pro"]);
    expect(second.people.claimInvite(JOE, B)).toBe(false);
  });

  it("a YES while a booking approval is pending opts in and leaves the booking alone", async () => {
    const w = lineSetup();
    await inProgress(w, 18000, "booked");
    const file = readFixer(w.root);
    delete file.jobs[0]!.booking!.hostYes;
    file.jobs[0]!.state = "contacted";
    writeFixer(w.root, file);
    const before = JSON.stringify(readFixer(w.root).jobs);
    await w.desk.proInbound(text(JOE, "YES"));
    expect(JSON.stringify(readFixer(w.root).jobs)).toBe(before);
  });
});

describe("final review fixes: notes with no job", () => {
  type News = { jobId?: string; kind: string; text?: string; urgent?: boolean };
  const news = async (w: { desk: ReturnType<typeof setup>["desk"] }) => ((await w.desk.checkFixes({})).structured as { news: News[] }).news;

  it("keeps an injury and a text with no visit as check_fixes news, the injury first, told once", async () => {
    // A Fixer-only property: no note reaches the host by itself.
    const w = setup(A, undefined, { env: () => ENV, send: async () => true });
    await w.desk.savePro(joe);
    const file = readFixer(w.root);
    file.settings.activatedAt = NOW.toISOString();
    writeFixer(w.root, file);
    await w.desk.proInbound(text(JOE, "can you call me back"));
    await w.desk.proInbound(text(JOE, "my helper fell off the ladder"));
    const told = await news(w);
    expect(told).toEqual([
      expect.objectContaining({ kind: "pro-hurt", urgent: true, text: proHurtNews({ proName: "Joe's Plumbing", street: "12 Scratch Lane" }) }),
      expect.objectContaining({ kind: "pro-text", text: `Joe's Plumbing texted: "can you call me back"` }),
    ]);
    expect(told[0]!.jobId).toBeUndefined();
    expect(await news(w)).toEqual([]);
  });

  it("says the host knows only when a note was kept or sent", async () => {
    const sent: string[] = [];
    const kept = setup(A, undefined, { send: async (_to, body) => (sent.push(body), true) });
    await kept.desk.savePro(joe);
    await kept.desk.proInbound(text(JOE, "someone is hurt"));
    expect(sent).toEqual([PRO_HURT]);
    // The record can't be read and the host can't be reached: only the 911 line.
    writeFileSync(join(kept.root, "fixer.json"), "{ not json");
    await kept.desk.proInbound(text(JOE, "someone is hurt"));
    expect(sent).toEqual([PRO_HURT, PRO_HURT_CALL]);
    expect(PRO_HURT_CALL).toBe("If someone is hurt, call 911 now.");
    // The record can't be read, but Cleaner Core took the note.
    const reached = setup(A, undefined, { send: async (_to, body) => (sent.push(body), true), notifyHost: async () => true });
    await reached.desk.savePro(joe);
    writeFileSync(join(reached.root, "fixer.json"), "{ not json");
    await reached.desk.proInbound(text(JOE, "someone is hurt"));
    expect(sent.at(-1)).toBe(PRO_HURT);
  });
});

/** A pro found for a job and called, who was given the line as the number to reach the host back. Made-up pros, 555 numbers. */
describe("the line as the number to reach the host back", () => {
  const LINE = "+15555550199";
  const PIPE = "+15555550188";

  /** An active desk with one host job, and Pipe One found, picked and called on it. */
  async function called(w: Line, how: "call" | "email" | "text" = "call") {
    const file = readFixer(w.root);
    const job: Job = {
      id: "job_callback123",
      trade: "plumbing",
      what: "Sink leaks",
      source: "host",
      photos: [],
      urgency: "soon",
      state: "shortlisted",
      hostGo: { at: NOW.toISOString() },
      candidates: [{ id: "cand_pipeone1", name: "Pipe One", source: "search", reach: { phone: PIPE, email: "pipe@example.com" } } as Job["candidates"][number]],
      picked: ["cand_pipeone1"],
      contacts: [],
      news: [],
      createdAt: NOW.toISOString(),
    };
    file.jobs.push(job);
    file.settings.activatedAt = NOW.toISOString();
    writeFixer(w.root, file);
    return w.desk.contactPro({ jobId: job.id, to: "cand_pipeone1", how });
  }

  function lineWith(number: string | undefined) {
    const notes: { id: string; text: string }[] = [];
    const base = setup(A, undefined, { lineNumber: () => number, notifyHost: async (id, text) => void notes.push({ id, text }) });
    return { ...base, sent: [] as { to: string; body: string }[], notes, hub: () => hubFor(base.root, { now: () => NOW }) };
  }

  it("gives the line as callbackNumber on a call or email, never the host's phone, and none on a text", async () => {
    const w = lineWith(LINE);
    const reply = await called(w);
    expect(reply.structured!.callbackNumber).toBe(LINE);
    expect(reply.structured!.callbackNext).toContain("texts, not calls");
    expect(JSON.stringify(reply.structured)).not.toContain(HOST);
    const none = lineWith(undefined);
    expect((await called(none)).structured!.callbackNumber).toBeUndefined();
  });

  it("puts a called candidate on the line while the job is open, and takes them off when it's cancelled", async () => {
    const w = lineWith(LINE);
    await called(w);
    expect(roles(w.people, PIPE)).toEqual(["pro"]);
    expect(proRoute({ properties: [{ id: A, flows: { fixer: { on: true } } } as Property] }, w.people, PIPE)!.map((p) => p.id)).toEqual([A]);
    // With no booking yet, the host's cancel is one call.
    expect((await w.desk.cancelJob({ jobId: job0(w).id })).isError).toBe(false);
    expect(roles(w.people, PIPE)).toEqual([]);
  });

  it("hangs a called candidate's text on the job they were called about, by name, with digit runs removed", async () => {
    const w = lineWith(LINE);
    await called(w);
    await w.desk.proInbound(text(PIPE, "Can do Tuesday for $350, call me at 5551234567"));
    const news = job0(w).news.at(-1)!;
    expect(news.kind).toBe("pro-text");
    expect(news.text).toContain("Pipe One texted");
    expect(news.text).toContain("$350");
    expect(news.text).not.toContain("5551234567");
    expect(w.notes.at(-1)!.text).toBe(news.text);
    // Their text changes nothing on the job: Grok records what they said.
    expect(job0(w).contacts[0]!.outcome).toBeUndefined();
    expect(job0(w).booking).toBeUndefined();
  });

  it("ignores a text from a number nobody called", async () => {
    const w = lineWith(LINE);
    await called(w);
    await w.desk.proInbound(text("+15555550177", "Hi, returning your call"));
    expect(job0(w).news).toEqual([]);
    expect(w.notes).toEqual([]);
  });
});

/** A pro's voicemail, as Twilio's transcript. It is news and nothing else. Made-up pros, 555 numbers. */
describe("a pro's voicemail", () => {
  const PIPE = "+15555550188";
  const voicemail = (text: string, extra: Record<string, unknown> = {}) => ({ id: `RE${++n}`, from: PIPE, text, status: "completed" as const, ...extra });

  /** Pipe One found, picked and called on an open job. */
  async function calledPipe(w: Line) {
    const file = readFixer(w.root);
    const job: Job = {
      id: "job_voicemail1",
      trade: "plumbing",
      what: "Sink leaks",
      source: "host",
      photos: [],
      urgency: "soon",
      state: "shortlisted",
      hostGo: { at: NOW.toISOString() },
      candidates: [{ id: "cand_pipeone1", name: "Pipe One", source: "search", reach: { phone: PIPE } } as Job["candidates"][number]],
      picked: ["cand_pipeone1"],
      contacts: [],
      news: [],
      createdAt: NOW.toISOString(),
    };
    file.jobs.push(job);
    file.settings.activatedAt = NOW.toISOString();
    writeFixer(w.root, file);
    await w.desk.contactPro({ jobId: job.id, to: "cand_pipeone1", how: "call" });
  }

  it("puts a contacted pro's voicemail on their job, by name", async () => {
    const w = lineSetup();
    await calledPipe(w);
    await w.desk.proVoicemail(voicemail("I can come Tuesday morning"));
    const news = job0(w).news.at(-1)!;
    expect(news).toMatchObject({ kind: "pro-voicemail", text: 'Pipe One left a voicemail: "I can come Tuesday morning"' });
    expect(w.notes.at(-1)!.text).toBe(news.text);
  });

  it("a transcript of yes, stop, done or $300 changes nothing but news", async () => {
    const w = lineSetup();
    await calledPipe(w);
    const before = JSON.stringify({ ...job0(w), news: [] });
    for (const words of ["Yes", "STOP", "Done", "$300"]) await w.desk.proVoicemail(voicemail(words));
    expect(w.people.optedIn(PIPE)).toBe(false);
    expect(w.people.stopped(PIPE)).toBe(false);
    expect(JSON.stringify({ ...job0(w), news: [] })).toBe(before);
    expect(job0(w).news.filter((item) => item.kind === "pro-voicemail")).toHaveLength(4);
    expect(w.sent).toEqual([]);
  });

  it("an injury voicemail is urgent", async () => {
    const w = lineSetup();
    await calledPipe(w);
    await w.desk.proVoicemail(voicemail("Someone is hurt, the ceiling fell on him"));
    expect(readFixer(w.root).news?.find((item) => item.kind === "pro-voicemail")).toMatchObject({ urgent: true, jobId: "job_voicemail1" });
  });

  it("digits are redacted and the text is cut to 600", async () => {
    const w = lineSetup();
    await calledPipe(w);
    await w.desk.proVoicemail(voicemail(`Call me at 5551234567 ${"a".repeat(800)}`));
    const text = job0(w).news.at(-1)!.text!;
    expect(text).not.toContain("5551234567");
    expect(text.length).toBeLessThanOrEqual('Pipe One left a voicemail: ""'.length + 600);
  });

  it("empty or under 2 seconds says they left no message", async () => {
    const w = lineSetup();
    await calledPipe(w);
    await w.desk.proVoicemail(voicemail(""));
    await w.desk.proVoicemail(voicemail("Hi", { seconds: 1 }));
    expect(job0(w).news.slice(-2).map((item) => item.text)).toEqual(["Pipe One called and left no message.", "Pipe One called and left no message."]);
  });

  it("failed says it couldn't be transcribed", async () => {
    const w = lineSetup();
    await calledPipe(w);
    await w.desk.proVoicemail(voicemail("", { status: "failed" }));
    expect(job0(w).news.at(-1)!.text).toBe("Pipe One left a voicemail that couldn't be transcribed. Call them back.");
  });

  it("the same recording twice makes one news item", async () => {
    const w = lineSetup();
    await calledPipe(w);
    const once = voicemail("I can come Tuesday");
    await w.desk.proVoicemail(once);
    await w.desk.proVoicemail(once);
    expect(job0(w).news.filter((item) => item.kind === "pro-voicemail")).toHaveLength(1);
  });
});
