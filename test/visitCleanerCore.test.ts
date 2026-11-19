import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixedCodePort } from "../src/cleaner-core/doorPort";
import { openCleanerCore, type CleanerCore, type CleanerText } from "../src/cleaner-core/core";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";
import { buildVisits } from "../src/visits/derive";
import { messageEventId, resetVisitLogCache, VISIT_EVENTS_DIR, VisitLog } from "../src/visits/store";

/**
 * #237 through Cleaner Core's engine, on Scratch Lane: 555 numbers, its made-up door code, fake lock events. The
 * 18 Oct 2026 turnover is same-day: checkout 11 AM (15:00Z), check-in 4 PM (20:00Z).
 */

const LANE = SCRATCH_TENANTS[0]!;
const OWNER = LANE.ownerPhone;
const CLEANER = LANE.cleanerPhone;
const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
const START = "2026-10-14T15:00:00.000Z";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  resetVisitLogCache();
});

function setup(opts: { visits?: boolean; lock?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "visit-engine-"));
  roots.push(root);
  const data = join(root, "cleaner-job");
  let now = new Date(START);
  const sent: CleanerText[] = [];
  const log = new VisitLog(root, () => now);
  if (opts.lock !== false) log.append({ type: "lock-connection", id: "conn", at: "2026-10-01T00:00:00.000Z", connected: true });
  const open = (): CleanerCore =>
    openCleanerCore({
      enabled: true,
      property: LANE.property,
      ownerPhone: OWNER,
      cleaner: { phone: CLEANER, approved: true },
      access: fixedCodePort(LANE.pin),
      hostName: "Scratch",
      consented: true,
      sink: { async send(text) { sent.push(text); } },
      now: () => now,
      dataDir: data,
      ...(opts.visits === false ? {} : { visits: { log: new VisitLog(root, () => now), cleanerName: "Maria Lopez" } }),
    });
  return { root, log, sent, open, at: (iso: string) => (now = new Date(iso)) };
}

async function confirm(job: CleanerCore): Promise<void> {
  await job.pollFeed(FEED);
  await job.receive({ id: "opt-yes", from: CLEANER, text: "YES" });
  await job.receive({ id: "y-out", from: OWNER, text: "YES" });
  await job.receive({ id: "y-in", from: OWNER, text: "YES" });
  await job.receive({ id: "y-offer", from: CLEANER, text: "YES" });
}

const logText = (root: string) =>
  existsSync(join(root, VISIT_EVENTS_DIR))
    ? readdirSync(join(root, VISIT_EVENTS_DIR))
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => readFileSync(join(root, VISIT_EVENTS_DIR, name), "utf8"))
        .join("")
    : "";

const lateAsks = (sent: CleanerText[]) => sent.filter((text) => text.kind === "late-ask");
const notes = (sent: CleanerText[]) => sent.filter((text) => text.kind === "visit-note");

describe("visit records in Cleaner Core", () => {
  it("logs the cleaning's window when its times are confirmed", async () => {
    const { open, log, at } = setup();
    const job = open();
    await confirm(job);
    at("2026-10-18T13:00:00.000Z");
    await job.runReminders();
    const windows = log.read().filter((event) => event.type === "visit-window" && event.visit === `cleaning:${job.jobs()[0]!.id}`);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ kind: "cleaning", from: "2026-10-18T15:00:00.000Z", until: "2026-10-18T20:00:00.000Z", checkIn: "2026-10-18T20:00:00.000Z", sameDay: true, who: { role: "cleaner", name: "Maria Lopez" } });
  });

  it("texts the late cleaner once, 15 minutes after a same-day expected time, never with the code", async () => {
    const { open, sent, at } = setup();
    const job = open();
    await confirm(job);
    at("2026-10-18T15:14:00.000Z");
    await job.runReminders();
    expect(lateAsks(sent)).toEqual([]);
    at("2026-10-18T15:15:00.000Z");
    await job.runReminders();
    await job.runReminders();
    expect(lateAsks(sent)).toEqual([{ to: CLEANER, kind: "late-ask", body: "Hi Maria, checking in on today's clean at 12 Scratch Lane, Teaneck, NJ 07666. Are you on your way?" }]);
    expect(lateAsks(sent)[0]?.body).not.toContain(LANE.pin);
    expect(notes(sent)).toEqual([]);
  });

  it("tells the host once, only when the next check-in is at risk", async () => {
    const { open, sent, at } = setup();
    const job = open();
    await confirm(job);
    at("2026-10-18T16:29:00.000Z");
    await job.runReminders();
    expect(notes(sent)).toEqual([]);
    at("2026-10-18T16:30:00.000Z");
    await job.runReminders();
    at("2026-10-18T17:00:00.000Z");
    await job.runReminders();
    expect(notes(sent)).toEqual([{ to: OWNER, kind: "visit-note", body: "Maria Lopez hasn't arrived at 12 Scratch Lane, Teaneck, NJ 07666. The next guests check in at 4 PM." }]);
    // The window's end brings no second note: the at-risk note already went.
    at("2026-10-18T20:05:00.000Z");
    await job.runReminders();
    expect(notes(sent).filter((text) => text.body.startsWith("No one came in"))).toEqual([]);
  });

  it("sends nothing new after a restart", async () => {
    const { open, sent, at } = setup();
    const first = open();
    await confirm(first);
    at("2026-10-18T16:40:00.000Z");
    await first.runReminders();
    const count = sent.length;
    expect(lateAsks(sent)).toHaveLength(1);
    expect(notes(sent)).toHaveLength(1);
    resetVisitLogCache();
    const again = open();
    await again.runReminders();
    await again.replay();
    await again.runReminders();
    expect(sent.length).toBe(count);
  });

  it("asks nothing when the cleaner's code opened the door", async () => {
    const { open, sent, at, log } = setup();
    const job = open();
    await confirm(job);
    log.nameCode("Cleaner", { role: "cleaner" });
    log.append({ type: "lock", id: "u1", at: "2026-10-18T15:10:00.000Z", device: "Front door", action: "unlock", side: "outside", codeName: "Cleaner" });
    at("2026-10-18T17:00:00.000Z");
    await job.runReminders();
    expect(lateAsks(sent)).toEqual([]);
    expect(notes(sent)).toEqual([]);
  });

  it("without a connected lock, sends nothing new: today's behavior", async () => {
    const { open, sent, at } = setup({ lock: false });
    const job = open();
    await confirm(job);
    const before = sent.length;
    for (const now of ["2026-10-18T15:20:00.000Z", "2026-10-18T16:40:00.000Z", "2026-10-18T19:10:00.000Z", "2026-10-18T20:10:00.000Z"]) {
      at(now);
      await job.runReminders();
    }
    expect(sent.slice(before).filter((text) => text.kind === "late-ask" || text.kind === "visit-note")).toEqual([]);
  });

  it("with the flag off, writes no log and sends nothing new", async () => {
    const { open, sent, at, root } = setup({ visits: false });
    const job = open();
    await confirm(job);
    at("2026-10-18T16:40:00.000Z");
    await job.runReminders();
    expect(lateAsks(sent)).toEqual([]);
    expect(notes(sent)).toEqual([]);
    // Only the test's own connection line is there: the engine wrote nothing.
    expect(logText(root).trim().split("\n")).toHaveLength(1);
  });

  it("doesn't text a cleaner who said STOP", async () => {
    const { open, sent, at } = setup();
    const job = open();
    await confirm(job);
    await job.receive({ id: "stop", from: CLEANER, text: "STOP" });
    at("2026-10-18T15:20:00.000Z");
    await job.runReminders();
    expect(lateAsks(sent)).toEqual([]);
  });

  it("logs DONE with its cleaning, the door code text with no body, and never the code", async () => {
    const { open, at, root, log } = setup();
    const job = open();
    await confirm(job);
    at("2026-10-18T15:05:00.000Z");
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    await job.runReminders();
    at("2026-10-18T15:20:00.000Z");
    await job.receive({ id: "here", from: CLEANER, text: `here now, the ${LANE.pin} worked` });
    at("2026-10-18T17:30:00.000Z");
    await job.receive({ id: "done", from: CLEANER, text: "DONE" });
    const events = log.read();
    const jobId = job.jobs()[0]!.id;
    expect(events.find((event) => event.id === messageEventId("in", "done"))).toMatchObject({ type: "message", direction: "in", role: "cleaner", label: "done", visit: `cleaning:${jobId}` });
    expect(events.find((event) => event.id === messageEventId("in", "here"))).toMatchObject({ label: "start", visit: `cleaning:${jobId}` });
    const doorCode = events.find((event) => event.type === "message" && event.label === "door-code");
    expect(doorCode).toBeDefined();
    expect(doorCode).not.toHaveProperty("body");
    const text = logText(root);
    expect(text).not.toContain(LANE.pin);
    expect(text).not.toContain(CLEANER);
    expect(text).not.toContain(OWNER.slice(2));
    expect(text).not.toMatch(/555\D?555/);
    // With no unlock, the arrival is the cleaner's own text; the departure is DONE, with no lock near it.
    const [visit] = buildVisits(events, { timeZone: LANE.property.timeZone, codeNames: {}, now: new Date("2026-10-18T21:00:00.000Z") }).visits;
    expect(visit).toMatchObject({ arrival: { source: "cleaner-text", at: "2026-10-18T15:20:00.000Z" }, departure: { source: "done-text", lockCheck: "none", at: "2026-10-18T17:30:00.000Z" }, minutes: 130 });
  });
});
