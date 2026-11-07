import { fixedCodePort } from "../src/cleaner-core/doorPort";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCleanerCore, SAFETY, type CleanerCore, type CleanerText, type TextKind } from "../src/cleaner-core/core";
import { liveDeskFor, resetLiveDesks, setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import { setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";
import { CALENDAR_ICS, CALENDAR_URL, fakeSms, FROZEN, TEST_PIN_KEY } from "./wiringProof";

const LANE = SCRATCH_TENANTS[0];
const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const HOST = "+15555550115";
const NOW = "2026-10-14T15:00:00.000Z";
const DUE = "2026-10-18T12:00:00.000Z";
const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
const CLEANER_HOLD = `The cleaner opted out of cleaning texts for ${ADDRESS}, so the cleaning is on hold. Find another cleaner or reach them directly, then tell your Grok Bot to restart it.`;
const INJURY_HOLD = `The cleaning at ${ADDRESS} is on hold because the cleaner reported an injury. Once everyone's okay, tell your Grok Bot to restart it.`;
const OWNER_HOLD = `The cleaning at ${ADDRESS} is on hold because you opted out of texts. Tell your Grok Bot to restart it.`;
const HOST_HURT = `The cleaner at ${ADDRESS} says someone is hurt. They've been told to call 911.`;
const HOST_START_HELD = `You'll get cleaning texts for ${ADDRESS} again. The cleaning is still on hold. Tell your Grok Bot to restart it.`;
const ON_HOLD = "The cleaning is on hold. I'll send an update when it can start again.";

const HOST_KIND_RULE = {
  "host-checkout": "blocked",
  "host-checkin": "blocked",
  offer: "blocked",
  corrected: "blocked",
  "cancel-update": "blocked",
  reminder: "blocked",
  confirm: "blocked",
  declined: "blocked",
  stop: "safety",
  help: "blocked",
  start: "safety",
  emergency: "safety",
  "opt-in": "blocked",
  pin: "blocked",
  "pin-notice": "blocked",
  "pin-failed": "blocked",
  "pin-held": "blocked",
  started: "blocked",
  done: "blocked",
  held: "blocked",
  review: "blocked",
  resume: "blocked",
  next: "blocked",
  "host-message": "blocked",
  checklist: "blocked",
  intro: "blocked",
} as const satisfies Record<TextKind, "safety" | "blocked">;

function hostRule(kind: TextKind): "safety" | "blocked" {
  switch (kind) {
    case "stop":
    case "start":
    case "emergency":
      return "safety";
    case "host-checkout":
    case "host-checkin":
    case "offer":
    case "corrected":
    case "cancel-update":
    case "reminder":
    case "confirm":
    case "declined":
    case "help":
    case "opt-in":
    case "pin":
    case "pin-notice":
    case "pin-failed":
    case "pin-held":
    case "started":
    case "done":
    case "held":
    case "review":
    case "resume":
    case "next":
    case "host-message":
    case "checklist":
    case "intro":
      return "blocked";
    default: {
      const uncovered: never = kind;
      throw new Error(`No opt-out rule for ${String(uncovered)}`);
    }
  }
}

const roots: string[] = [];

afterEach(() => {
  setCleanerTwilioClient(undefined);
  setCleanerCalendarFetch(undefined);
  resetLiveDesks();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function sink() {
  const sent: CleanerText[] = [];
  return { sent, async send(text: CleanerText) { sent.push(text); } };
}

function engine(box: ReturnType<typeof sink>, now: () => Date): CleanerCore {
  if (!LANE) throw new Error("missing lane");
  return openCleanerCore({
    enabled: true,
    property: LANE.property,
    ownerPhone: OWNER,
    cleaner: { phone: CLEANER, approved: true },
    access: fixedCodePort(LANE.pin),
    hostName: "Scratch",
    consented: true,
    noteHostOnStop: true,
    sink: box,
    now,
  });
}

async function confirm(job: CleanerCore): Promise<void> {
  await job.pollFeed(FEED);
  await job.receive({ id: "opt-yes", from: CLEANER, text: "YES" });
  await job.receive({ id: "y-out", from: OWNER, text: "YES" });
  await job.receive({ id: "y-in", from: OWNER, text: "YES" });
  await job.receive({ id: "y-offer", from: CLEANER, text: "YES" });
}

describe("one opt-out check for every text to Cory", () => {
  it("names a safety or blocked rule for every host text kind", () => {
    const kinds = Object.keys(HOST_KIND_RULE) as TextKind[];
    for (const kind of kinds) expect(hostRule(kind)).toBe(HOST_KIND_RULE[kind]);
    expect([...SAFETY].sort()).toEqual(kinds.filter((kind) => HOST_KIND_RULE[kind] === "safety").sort());
    for (const sentence of [CLEANER_HOLD, INJURY_HOLD, OWNER_HOLD]) {
      expect(sentence.toLowerCase()).toContain("tell your grok bot to restart it");
      expect(sentence.toLowerCase().includes("reply")).toBe(false);
      expect(sentence.toLowerCase().includes("text back")).toBe(false);
      expect(sentence.toLowerCase().includes("door code")).toBe(false);
    }
  });

  it("blocks non-safety host texts after STOP and still sends stop, start, and the injury hold", async () => {
    const box = sink();
    let now = NOW;
    const job = engine(box, () => new Date(now));
    await confirm(job);
    now = DUE;
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    await job.receive({ id: "clean-start", from: CLEANER, text: "START" });
    expect(job.jobs().some((item) => item.status === "in_progress")).toBe(true);
    if (!LANE) throw new Error("missing lane");
    const pinToCleaner = box.sent.filter((text) => text.kind === "pin");
    expect(pinToCleaner.map((text) => text.to)).toEqual([CLEANER]);
    expect(pinToCleaner.every((text) => text.body.includes("Door code:"))).toBe(true);
    for (const text of box.sent.filter((text) => text.to === OWNER)) expect(text.body.includes(LANE.pin)).toBe(false);

    const marked = box.sent.length;
    await job.receive({ id: "owner-stop", from: OWNER, text: "STOP" });
    expect(box.sent.slice(marked).filter((text) => text.to === OWNER).map((text) => text.kind)).toEqual(["stop"]);
    expect(box.sent.slice(marked).some((text) => text.body === OWNER_HOLD || text.body === CLEANER_HOLD || text.body === INJURY_HOLD)).toBe(false);
    expect(job.hostNotes()).toContain(OWNER_HOLD);
    expect(job.jobOnHold()).toBe(true);
    expect(job.holdNotice()).toBe(OWNER_HOLD);

    const repeat = box.sent.length;
    await job.receive({ id: "owner-stop-again", from: OWNER, text: "STOP" });
    expect(box.sent.length).toBe(repeat);

    const beforeReview = box.sent.length;
    const review = await job.fileReview("airbnb-exception");
    expect(box.sent.length).toBe(beforeReview);
    expect(review.sent.map((text) => text.kind)).toEqual(["review"]);
    expect(job.hostNotes()).toContain(review.sent[0]?.body ?? "");

    await job.runReminders();
    expect(box.sent.length).toBe(beforeReview);

    const beforeHurt = box.sent.length;
    await job.receive({ id: "hurt", from: CLEANER, text: "I fell and I'm hurt" });
    expect(box.sent.slice(beforeHurt).filter((text) => text.to === OWNER).map((text) => text.body)).toEqual([HOST_HURT, INJURY_HOLD]);
    const hurtAgain = box.sent.length;
    await job.receive({ id: "hurt-again", from: CLEANER, text: "I fell and I'm hurt" });
    expect(box.sent.length).toBe(hurtAgain);

    const beforeStart = box.sent.length;
    await job.receive({ id: "owner-start", from: OWNER, text: "START" });
    expect(box.sent.slice(beforeStart)).toEqual([{ to: OWNER, body: HOST_START_HELD, kind: "start" }]);
    expect(job.jobOnHold()).toBe(true);
    expect(job.holdNotice()).toBe(OWNER_HOLD);
    const startAgain = box.sent.length;
    await job.receive({ id: "owner-start-again", from: OWNER, text: "START" });
    expect(box.sent.length).toBe(startAgain);

    await job.receive({ id: "owner-stop-2", from: OWNER, text: "STOP" });
    const beforeDone = box.sent.length;
    await job.receive({ id: "done", from: CLEANER, text: "DONE" });
    expect(box.sent.slice(beforeDone).filter((text) => text.to === OWNER)).toEqual([]);
    expect(box.sent.slice(beforeDone)).toEqual([{ to: CLEANER, body: ON_HOLD, kind: "next" }]);
    expect(job.jobs().some((item) => item.status === "done")).toBe(false);

    const beforeCleanerStop = box.sent.length;
    await job.receive({ id: "cleaner-stop", from: CLEANER, text: "STOP" });
    expect(box.sent.slice(beforeCleanerStop).filter((text) => text.to === OWNER)).toEqual([]);
    expect(box.sent.slice(beforeCleanerStop).some((text) => text.to === CLEANER && text.kind === "stop")).toBe(true);
    expect(job.hostNotes()).toContain(CLEANER_HOLD);
    expect(job.holdNotice()).toBe(CLEANER_HOLD);

    const resumed = await job.resumeJob();
    expect(job.jobOnHold()).toBe(false);
    expect(job.cleanerHasOptedOut()).toBe(true);
    expect(job.holdNotice()).toBe(CLEANER_HOLD);
    expect(box.sent.some((text) => text.kind === "resume")).toBe(false);
    expect(resumed?.body).toContain("is back on");
    expect(job.hostNotes().some((line) => line.includes("is back on"))).toBe(true);
    expect(job.outbox().find((item) => item.kind === "resume")?.status).toBe("unsent");
    expect(job.outbox().filter((item) => item.to === OWNER && item.kind === "done")).toEqual([]);
    expect(job.outbox().find((item) => item.kind === "review")?.status).toBe("unsent");

    const ownerKinds = new Set(box.sent.slice(marked).filter((text) => text.to === OWNER).map((text) => text.kind));
    for (const kind of ownerKinds) expect(HOST_KIND_RULE[kind]).toBe("safety");
  });

  it("holds a due reminder until resume, then texts only the cleaner", async () => {
    const heldBox = sink();
    const openBox = sink();
    let now = DUE;
    const held = engine(heldBox, () => new Date(now));
    const open = engine(openBox, () => new Date(now));
    await confirm(held);
    await confirm(open);
    await held.receive({ id: "stop", from: OWNER, text: "STOP" });
    expect((await held.runReminders()).sent).toEqual([]);
    expect(heldBox.sent.filter((text) => text.kind === "reminder")).toEqual([]);
    await held.resumeJob();
    const reminded = await held.runReminders();
    expect(reminded.sent.map((text) => ({ to: text.to, kind: text.kind }))).toEqual([{ to: CLEANER, kind: "reminder" }]);
    expect(heldBox.sent.filter((text) => text.to === OWNER && text.kind === "reminder")).toEqual([]);
    const due = await open.runReminders();
    expect(due.sent.some((text) => text.to === CLEANER && text.kind === "reminder")).toBe(true);
  });

  it("still sends the private door code to the cleaner after Cory opts out, and blocks it after the cleaner opts out", async () => {
    const box = sink();
    const job = engine(box, () => new Date(DUE));
    await confirm(job);
    await job.receive({ id: "stop", from: OWNER, text: "STOP" });
    await job.resumeJob();
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    const pins = box.sent.filter((text) => text.kind === "pin");
    expect(pins.map((text) => text.to)).toEqual([CLEANER]);
    expect(box.sent.filter((text) => text.to === OWNER && (text.kind === "pin" || text.kind === "pin-notice" || text.kind === "pin-failed"))).toEqual([]);
    for (const text of box.sent.filter((item) => item.to === OWNER)) expect(text.body.includes(LANE?.pin ?? "")).toBe(false);
    const pin = job.outbox().find((item) => item.kind === "pin");
    const beforeFail = box.sent.length;
    await job.reportPin(pin?.id ?? "", "failed");
    expect(box.sent.length).toBe(beforeFail);

    const blocked = sink();
    const cleanerOut = engine(blocked, () => new Date(DUE));
    await confirm(cleanerOut);
    await cleanerOut.receive({ id: "cleaner-stop", from: CLEANER, text: "STOP" });
    expect(blocked.sent.some((text) => text.to === OWNER && text.body === CLEANER_HOLD)).toBe(true);
    await cleanerOut.receive({ id: "left", from: OWNER, text: "guests have left" });
    expect(blocked.sent.filter((text) => text.kind === "pin")).toEqual([]);
  });
});

describe("ordered STOP, reminder, and DONE on the Twilio log", () => {
  it("texts Cory nothing after STOP, leaves DONE unfinished, and shows the owner hold line", async () => {
    if (!LANE) throw new Error("missing lane");
    const root = mkdtempSync(join(tmpdir(), "cleaner-opt-out-"));
    roots.push(root);
    const sms = fakeSms();
    let now = FROZEN;
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_GROUP_CHAT: "0",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_SMS_ALLOWLIST: `${HOST},${LANE.cleanerPhone}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: "+15555550124",
    };
    setCleanerTwilioClient(sms);
    setCleanerCalendarFetch(async (url) => ({
      status: url === CALENDAR_URL ? 200 : 404,
      url,
      async text() {
        return url === CALENDAR_URL ? CALENDAR_ICS : "";
      },
    }));
    const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
    const desk = liveDeskFor(root, () => env, () => new Date(now));
    expect((await desk.getState("cleaners")).ok).toBe(true);
    expect((await desk.saveProperty({ business: "Scratch", address: ADDRESS, timeZone: "America/New_York" })).ok).toBe(true);
    expect((await desk.savePeople({ host: HOST, cleaner: LANE.cleanerPhone, observer: "+15555550142" })).ok).toBe(true);
    expect((await desk.saveCalendarLink({ url: CALENDAR_URL })).ok).toBe(true);
    expect((await desk.saveDoorCode({ code: LANE.pin }, pinKey)).ok).toBe(true);
    expect((await desk.setUpTexting()).ok).toBe(true);
    expect((await desk.runChecks()).ok).toBe(true);
    expect((await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" })).ok).toBe(true);
    await desk.inbound({ id: "yes-opt", from: LANE.cleanerPhone, text: "YES" });
    await desk.inbound({ id: "yes-job", from: LANE.cleanerPhone, text: "YES" });
    const left = await desk.markGuestsLeft({ confirmed: true }, pinKey);
    expect(left.ok).toBe(true);
    await desk.inbound({ id: "start", from: LANE.cleanerPhone, text: "START" });
    const beforeStop = sms.sent.length;
    await desk.inbound({ id: "stop", from: HOST, text: "STOP" });
    const stopAck = sms.sent.slice(beforeStop).map((item) => ({ to: item.to, body: item.body.split(LANE.pin).join("[redacted]") }));
    expect(stopAck).toEqual([{
      to: HOST,
      body: `You're opted out of cleaning texts for ${ADDRESS}, and the cleaning there is on hold. Reply START to get texts again.`,
    }]);
    const afterStop = sms.sent.length;
    now = DUE;
    await desk.runReminders();
    await desk.inbound({ id: "done", from: LANE.cleanerPhone, text: "DONE" });
    const after = sms.sent.slice(afterStop).map((item) => ({ to: item.to, body: item.body.split(LANE.pin).join("[redacted]") }));
    expect(after.filter((item) => item.to === HOST)).toEqual([]);
    expect(after).toEqual([{ to: LANE.cleanerPhone, body: "The cleaning is on hold. I'll send an update when it can start again." }]);
    const state = await desk.getState();
    if (!state.ok) throw new Error("missing state");
    expect(state.result.next).toBe(OWNER_HOLD);
    const turns = await desk.getTurns();
    if (!turns.ok) throw new Error("missing turns");
    expect(turns.result.turns && JSON.stringify(turns.result.turns).includes("\"status\":\"done\"")).toBe(false);
    expect(JSON.stringify(turns.result.turns).includes("\"status\":\"in_progress\"")).toBe(true);
    expect(JSON.stringify(sms.sent.map((item) => item.body.split(LANE.pin).join("[redacted]"))).includes(LANE.pin)).toBe(false);
    const again = sms.sent.length;
    await desk.inbound({ id: "stop-again", from: HOST, text: "STOP" });
    expect(sms.sent.length).toBe(again);
  });
});
