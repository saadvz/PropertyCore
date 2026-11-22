import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GrantNote } from "../src/hub/doorAccess";
import { hubFor, resetHubs } from "../src/hub/hub";
import { FakeLockAdapter } from "../src/locks/fake";
import { setLockAdapter } from "../src/locks/registry";
import { emptyLocks, storedDevice } from "../src/locks/settings";
import { OversightDesk, type OversightReply } from "../src/oversight/desk";
import { readOversight } from "../src/oversight/store";
import { VisitCodeDesk } from "../src/oversight/visitCodeDesk";
import { deskFeatures } from "./featureEnv";

/**
 * #280 item 17 end to end on the fake lock adapter: the visitor's one opt-in text, their YES, their own code on the
 * lock for the visit, one code text from 30 minutes before, and the code coming off on STOP or a cancel. 555 numbers
 * only; the code is read back from the fake lock, never written in a test.
 */

const NOW = new Date("2026-11-17T14:00:00.000Z");
const HOST = "+15555550130";
const MIKE = "+15555550161";
const roots: string[] = [];
/** Local New York time on a day in Nov 2026. */
const ny = (local: string, day = "19") => new Date(`2026-11-${day}T${local}:00.000-05:00`);

afterEach(() => {
  resetHubs();
  setLockAdapter(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world(options: { textsAllowed?: boolean; sendWorks?: boolean; optedIn?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "visit-live-"));
  roots.push(root);
  let clock = new Date(NOW);
  const env: NodeJS.ProcessEnv = { ...deskFeatures("locks"), CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64") };
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
  fake.addDevice("acct", { id: "dev-front", name: "Front door" });
  const hub = hubFor(root, { now: () => clock });
  hub.saveProperty({ address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York", checkInTime: "16:00", checkoutTime: "11:00" });
  const door = hub.doorAccess(() => env);
  door.saveLocks({ ...emptyLocks(), customerKey: "acct", devices: [storedDevice({ id: "dev-front", accountId: "acct-acct", name: "Front door", kind: "lock", online: true })], doors: ["dev-front"], activeAt: NOW.toISOString() });
  const sent: { to: string; body: string }[] = [];
  const stopped = new Set<string>();
  const state = { textsAllowed: options.textsAllowed ?? true, sendWorks: options.sendWorks ?? true };
  const codes = new VisitCodeDesk(root, {
    now: () => clock,
    door: () => door,
    textsAllowed: async () => state.textsAllowed,
    stopped: (phone) => stopped.has(phone),
    send: async (to, body) => {
      if (!state.sendWorks) return false;
      sent.push({ to, body });
      return true;
    },
    optedInHere: (phone) => (options.optedIn ?? []).includes(phone),
  });
  const visits = new OversightDesk(root, { now: () => clock, codes: () => true, hostPhone: () => HOST, codeStatus: (visit) => codes.codeStatus(visit) });
  const told: GrantNote[] = [];
  const tick = async () => {
    const notes = await codes.sync();
    told.push(...notes);
    return notes;
  };
  return { root, fake, door, sent, told, state, stopped, codes, visits, tick, at: (when: Date) => (clock = new Date(when)) };
}

function approved(call: (confirmation?: string) => OversightReply): OversightReply {
  const first = call();
  const code = (first.structured?.confirmation as { code?: string } | undefined)?.code;
  return code ? call(code) : first;
}

function addMike(w: ReturnType<typeof world>, extra: Record<string, unknown> = {}): string {
  const reply = approved((confirmation) => w.visits.addVisit({ who: "Mike Doyle", date: "2026-11-19", from: "12:00", to: "17:00", phone: MIKE, ...extra, ...(confirmation ? { confirmation } : {}) }));
  expect(reply.structured?.saved).toBe(true);
  return (reply.structured!.visit as { id: string }).id;
}

const INVITE = "This is the text line for 12 Scratch Lane. The host is expecting you and wants to give you your own door code. Reply YES to get it by text before your visit, or STOP to opt out.";

describe("the visitor's own door code (#280 17)", () => {
  it("texts the visitor once for YES, and nothing on the lock before it", async () => {
    const w = world();
    addMike(w);
    await w.tick();
    await w.tick();
    expect(w.sent).toEqual([{ to: MIKE, body: INVITE }]);
    expect(w.fake.liveCodes("dev-front")).toEqual([]);
    expect(await w.codes.visitorText(MIKE, "hello")).toBe(false);
    expect(w.sent).toHaveLength(1);
  });

  it("after YES, the code is on the lock for the window and texted once from 30 minutes before", async () => {
    const w = world();
    const id = addMike(w);
    await w.tick();
    expect(await w.codes.visitorText(MIKE, "YES")).toBe(true);
    const live = w.fake.liveCodes("dev-front");
    expect(live).toHaveLength(1);
    expect(live[0]!.window).toEqual({ from: ny("11:30").toISOString(), until: ny("17:00").toISOString() });
    expect(live[0]!.name).toMatch(/^Visit /);
    // Not texted before 11:30 on the day.
    w.at(ny("11:29"));
    await w.tick();
    expect(w.sent).toHaveLength(1);
    w.at(ny("11:30"));
    const notes = await w.tick();
    const code = live[0]!.code;
    expect(w.sent[1]).toEqual({ to: MIKE, body: `Hi Mike, your door code at 12 Scratch Lane is ${code}. It works until 5:00 PM today.` });
    expect(notes.map((note) => note.text)).toContain("Mike Doyle has their door code for today's visit.");
    expect(JSON.stringify(notes)).not.toContain(code);
    expect(JSON.stringify(readOversight(w.root))).not.toContain(code);
    await w.tick();
    expect(w.sent).toHaveLength(2);
    const listed = w.visits.listVisits().structured?.open as { id: string; code: string }[];
    expect(listed.find((visit) => visit.id === id)?.code).toBe("texted");
  });

  it("a replay or restart never texts the code twice", async () => {
    const w = world({ sendWorks: true });
    addMike(w);
    await w.tick();
    await w.codes.visitorText(MIKE, "YES");
    w.at(ny("11:45"));
    // The send dies after the mark was saved: whether it went is unknown, so it's never sent again.
    w.state.sendWorks = false;
    const first = await w.tick();
    expect(first.map((note) => note.text)).toContain("I'm not sure Mike Doyle's code text went out. Check with them before their visit.");
    w.state.sendWorks = true;
    const fresh = new VisitCodeDesk(w.root, { now: () => ny("11:50"), door: () => w.door, textsAllowed: async () => true, stopped: () => false, send: async (to, body) => (w.sent.push({ to, body }), true), optedInHere: () => false });
    const again = await fresh.sync();
    expect(w.sent.filter((text) => text.body.startsWith("Hi Mike"))).toEqual([]);
    expect(again.filter((note) => note.id.includes(":unsure:"))).toEqual([]);
  });

  it("STOP takes the code off", async () => {
    const w = world();
    addMike(w);
    await w.tick();
    await w.codes.visitorText(MIKE, "YES");
    expect(w.fake.liveCodes("dev-front")).toHaveLength(1);
    expect(await w.codes.visitorText(MIKE, "STOP")).toBe(false);
    expect(w.fake.liveCodes("dev-front")).toEqual([]);
    w.at(ny("11:45"));
    await w.tick();
    expect(w.sent).toHaveLength(1);
  });

  it("a cancel takes the code off", async () => {
    const w = world();
    const id = addMike(w);
    await w.tick();
    await w.codes.visitorText(MIKE, "YES");
    expect(w.visits.cancelVisit({ id }).text).toContain("Mike Doyle's door code for it comes off the lock.");
    await w.tick();
    expect(w.fake.liveCodes("dev-front")).toEqual([]);
  });

  it("doesn't text while the property's texts aren't on, and tells the host once", async () => {
    const w = world({ textsAllowed: false });
    addMike(w);
    await w.tick();
    await w.tick();
    expect(w.sent).toEqual([]);
    expect(w.told.filter((note) => note.text === "I can't text Mike Doyle yet, so they don't have their door code. Let them in another way.")).toHaveLength(1);
    w.state.textsAllowed = true;
    await w.tick();
    expect(w.sent).toEqual([{ to: MIKE, body: INVITE }]);
  });

  it("a person already opted in on the property needs no new invite", async () => {
    const w = world({ optedIn: [MIKE] });
    addMike(w);
    await w.tick();
    expect(w.sent).toEqual([]);
    expect(w.fake.liveCodes("dev-front")).toHaveLength(1);
  });

  it("a visit during a guest's stay gets no code, and the host is told once", async () => {
    const w = world({ optedIn: [MIKE] });
    const hub = JSON.parse(readFileSync(join(w.root, "hub.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(w.root, "hub.json"), JSON.stringify({ ...hub, stays: [{ checkIn: "2026-11-18", checkout: "2026-11-21", kind: "stay" }] }));
    addMike(w);
    await w.tick();
    await w.tick();
    expect(w.fake.liveCodes("dev-front")).toEqual([]);
    expect(w.told.filter((note) => note.text === "Mike Doyle's visit falls during a guest's stay, so they get no door code. You'll need to let them in.")).toHaveLength(1);
  });

  it("a visitor's later visit needs no second invite", async () => {
    const w = world();
    addMike(w);
    await w.tick();
    await w.codes.visitorText(MIKE, "YES");
    addMike(w, { date: "2026-11-20" });
    await w.tick();
    expect(w.sent.filter((text) => text.body === INVITE)).toHaveLength(1);
    expect(w.fake.liveCodes("dev-front")).toHaveLength(2);
  });

  it("two passes at once still text the code once (final review)", async () => {
    const w = world();
    addMike(w);
    await w.tick();
    await w.codes.visitorText(MIKE, "YES");
    w.at(ny("11:45"));
    await Promise.all([w.tick(), w.tick(), w.codes.sync()]);
    expect(w.sent.filter((text) => text.body.startsWith("Hi Mike"))).toHaveLength(1);
  });

  it("a visit cancelled after the pass read it gets no code text (final review)", async () => {
    const w = world();
    const id = addMike(w);
    await w.tick();
    await w.codes.visitorText(MIKE, "YES");
    w.at(ny("11:45"));
    const pass = w.tick();
    w.visits.cancelVisit({ id });
    await pass;
    expect(w.sent.filter((text) => text.body.startsWith("Hi Mike"))).toEqual([]);
  });
});
