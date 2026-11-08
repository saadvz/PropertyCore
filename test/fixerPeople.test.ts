import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixerDeskFor, resetFixerDesks, type FixerDeps } from "../src/fixer-core/desk";
import { proRoute } from "../src/fixer-core/proLine";
import { PRO_HURT, proInvite } from "../src/fixer-core/texts";
import { readFixer, writeFixer, type Job } from "../src/fixer-core/store";
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
const ENV = { CLEANER_CORE_TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`, CLEANER_CORE_TWILIO_AUTH_TOKEN: "made-up-token" } as NodeJS.ProcessEnv;

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
  return { ...base, sent, notes };
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
