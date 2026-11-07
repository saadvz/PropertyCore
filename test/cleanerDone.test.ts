import { fixedCodePort } from "../src/cleaner-core/doorPort";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openCleanerCore, type CleanerText } from "../src/cleaner-core/core";
import { groupInviteBody } from "../src/cleaner-core/cleanerTexts";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";
import { liveDeskFor, resetLiveDesks, setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import { setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { CALENDAR_ICS, CALENDAR_URL, CLEANER_LINE, TEST_PIN_KEY, fakeSms } from "./wiringProof";

const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const OBSERVER = "+15555550102";
const lane = SCRATCH_TENANTS[0];
if (!lane) throw new Error("Scratch Lane is missing");
const PIN = lane.pin;
const NOW = "2026-10-14T15:00:00.000Z";
const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
const GROUP_PIN_TEXT = `Guests have left 12 Scratch Lane, Teaneck, NJ 07666. Door code: ${PIN}. Maria, reply DONE when the cleaning is finished.`;
const PIN_TEXT = `Guests have left 12 Scratch Lane, Teaneck, NJ 07666. Door code: ${PIN}. This code is only for you. Reply DONE when the cleaning is finished.`;
const DONE_ACK = "Thanks, cleaning marked done.";
const HOST_DONE = "The cleaner marked the cleaning at 12 Scratch Lane, Teaneck, NJ 07666 done.";
const STARTED = "Got it, cleaning started.";
const BEFORE_CODE = "The door code comes after the guests leave.";
const ALREADY = "This cleaning is already marked done.";
const NEXT_DONE = "Reply DONE when the cleaning is finished.";
const ON_HOLD = "The cleaning is on hold. I'll send an update when it can start again.";
const HOST_HURT = "The cleaner at 12 Scratch Lane, Teaneck, NJ 07666 says someone is hurt. They've been told to call 911.";
const INJURY_HOLD = "The cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is on hold because the cleaner reported an injury. Once everyone's okay, tell your Grok Bot to restart it.";
const CLEANER_HURT = "If someone is hurt, call 911 now. I've let the host know.";
const GROUP_INVITE = groupInviteBody("Scratch", "12 Scratch Lane, Teaneck, NJ 07666");
const OBSERVER_INVITE = GROUP_INVITE;
const SOLO_INVITE = "Hi, this is Scratch at 12 Scratch Lane, Teaneck, NJ 07666. You're getting this because you clean between guest stays. Reply YES to get cleaning texts, or STOP to opt out.";

function sink() {
  const sent: CleanerText[] = [];
  return { sent, async send(text: CleanerText) { sent.push(text); } };
}

function engine(box: ReturnType<typeof sink>, group = false) {
  return openCleanerCore({
    enabled: true,
    property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
    ownerPhone: OWNER,
    cleaner: { phone: CLEANER, approved: true },
    access: fixedCodePort(PIN),
    hostName: "Scratch",
    consented: true,
    sink: box,
    now: () => new Date(NOW),
    ...(group ? { groupChat: { hostName: "Cory", cleanerName: "Maria" } } : {}),
  });
}

async function ready(group = false) {
  const box = sink();
  const job = engine(box, group);
  await job.pollFeed(FEED);
  if (group) {
    await job.receive({ id: "host-yes", from: OWNER, text: "YES" });
    await job.receive({ id: "cleaner-yes", from: CLEANER, text: "YES" });
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
  } else {
    await job.receive({ id: "opt-yes", from: CLEANER, text: "YES" });
    await job.receive({ id: "y-out", from: OWNER, text: "YES" });
    await job.receive({ id: "y-in", from: OWNER, text: "YES" });
  }
  await job.receive({ id: "y-offer", from: CLEANER, text: "YES" });
  return { box, job };
}

function hostReady(sent: CleanerText[]): CleanerText[] {
  return sent.filter((text) => text.to === OWNER && text.body === HOST_DONE);
}

describe("DONE after the door code", () => {
  it("finishes the job when the opted-in cleaner texts DONE without START", async () => {
    const { box, job } = await ready();
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    const done = await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    expect(done).toEqual({
      handled: true,
      reason: "done",
      sent: [{ to: CLEANER, body: DONE_ACK, kind: "done" }],
    });
    expect(job.jobs()[0]?.status).toBe("done");
    expect(hostReady(box.sent)).toEqual([{ to: OWNER, body: HOST_DONE, kind: "done" }]);
    expect(box.sent.filter((text) => text.kind === "pin")).toEqual([{ to: CLEANER, body: PIN_TEXT, kind: "pin" }]);
    expect(box.sent.filter((text) => text.to === OWNER).every((text) => !text.body.includes(PIN))).toBe(true);
  });

  it("leaves the job unfinished and sends the host no ready text when DONE follows an injury", async () => {
    const { box, job } = await ready();
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    expect(job.jobs()[0]?.status).toBe("cleared");
    expect(await job.receive({ id: "hurt", from: CLEANER, text: "I fell and I'm hurt" })).toEqual({
      handled: true,
      reason: "emergency",
      sent: [
        { to: OWNER, body: HOST_HURT, kind: "emergency" },
        { to: OWNER, body: INJURY_HOLD, kind: "emergency" },
        { to: CLEANER, body: CLEANER_HURT, kind: "emergency" },
      ],
    });
    expect(await job.receive({ id: "done-held", from: CLEANER, text: "DONE" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [{ to: CLEANER, body: ON_HOLD, kind: "next" }],
    });
    expect(await job.receive({ id: "done-held-2", from: CLEANER, text: "DONE" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [{ to: CLEANER, body: ON_HOLD, kind: "next" }],
    });
    expect(job.jobs()[0]?.status).toBe("cleared");
    expect(hostReady(box.sent)).toEqual([]);
  });

  it("leaves the job unfinished and sends the host no ready text when START and DONE follow an injury", async () => {
    const { box, job } = await ready();
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    expect(job.jobs()[0]?.status).toBe("cleared");
    await job.receive({ id: "hurt", from: CLEANER, text: "I fell and I'm hurt" });
    expect(await job.receive({ id: "start-held", from: CLEANER, text: "START" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [{ to: CLEANER, body: ON_HOLD, kind: "next" }],
    });
    expect(await job.receive({ id: "done-held", from: CLEANER, text: "DONE" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [{ to: CLEANER, body: ON_HOLD, kind: "next" }],
    });
    expect(job.jobs()[0]?.status).toBe("cleared");
    expect(hostReady(box.sent)).toEqual([]);
    expect(box.sent.filter((text) => text.body === STARTED || text.body === DONE_ACK)).toEqual([]);
  });

  it("sends the host one ready text when DONE arrives twice", async () => {
    const { box, job } = await ready();
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    await job.receive({ id: "done-1", from: CLEANER, text: "DONE" });
    const again = await job.receive({ id: "done-2", from: CLEANER, text: "DONE" });
    expect(again).toEqual({
      handled: true,
      reason: "ignored",
      sent: [{ to: CLEANER, body: ALREADY, kind: "next" }],
    });
    expect(hostReady(box.sent)).toEqual([{ to: OWNER, body: HOST_DONE, kind: "done" }]);
    expect(job.jobs()[0]?.status).toBe("done");
  });

  it("tells the cleaner what to do when DONE arrives before the door code", async () => {
    const { box, job } = await ready();
    const early = await job.receive({ id: "done-early", from: CLEANER, text: "DONE" });
    expect(early).toEqual({
      handled: true,
      reason: "ignored",
      sent: [{ to: CLEANER, body: BEFORE_CODE, kind: "next" }],
    });
    expect(job.jobs()[0]?.status).not.toBe("done");
    expect(hostReady(box.sent)).toEqual([]);
    expect(box.sent.filter((text) => text.kind === "pin")).toEqual([]);
    expect(early.sent.every((text) => !text.body.includes(PIN))).toBe(true);
  });

  it("still finishes after START and then DONE", async () => {
    const { box, job } = await ready();
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    expect(await job.receive({ id: "start-1", from: CLEANER, text: "START" })).toEqual({
      handled: true,
      reason: "start",
      sent: [{ to: CLEANER, body: STARTED, kind: "started" }],
    });
    expect(await job.receive({ id: "done-1", from: CLEANER, text: "DONE" })).toEqual({
      handled: true,
      reason: "done",
      sent: [{ to: CLEANER, body: DONE_ACK, kind: "done" }],
    });
    expect(job.jobs()[0]?.status).toBe("done");
    expect(hostReady(box.sent)).toHaveLength(1);
  });

  it("puts the DONE instruction on the cleaner's door code and not on the host text", async () => {
    const { box: sent, job } = await ready();
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    expect(sent.sent.find((text) => text.kind === "pin")).toEqual({ to: CLEANER, body: PIN_TEXT, kind: "pin" });
    expect(sent.sent.find((text) => text.kind === "pin-notice")).toEqual({
      to: OWNER,
      body: "Door code sent to the cleaner.",
      kind: "pin-notice",
    });
    expect(sent.sent.filter((text) => text.to === OWNER).some((text) => text.body.includes("Reply DONE"))).toBe(false);
  });

  it("answers an unknown text from the opted-in cleaner and stays quiet for HELP", async () => {
    const { box, job } = await ready();
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    expect(await job.receive({ id: "huh", from: CLEANER, text: "Where are the towels?" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [{ to: CLEANER, body: NEXT_DONE, kind: "next" }],
    });
    const before = box.sent.length;
    expect(await job.receive({ id: "help-1", from: CLEANER, text: "HELP" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [],
    });
    expect(box.sent).toHaveLength(before);
    expect(job.jobs()[0]?.status).toBe("cleared");
  });

  it("stays quiet when DONE comes from a cleaner who has not opted in or who opted out", async () => {
    const waiting = sink();
    const pending = engine(waiting);
    await pending.pollFeed(FEED);
    await pending.receive({ id: "y-out", from: OWNER, text: "YES" });
    await pending.receive({ id: "y-in", from: OWNER, text: "YES" });
    const before = waiting.sent.length;
    expect(await pending.receive({ id: "done-pending", from: CLEANER, text: "DONE" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [],
    });
    expect(waiting.sent).toHaveLength(before);

    const { box, job } = await ready();
    await job.receive({ id: "stop-1", from: CLEANER, text: "STOP" });
    const afterStop = box.sent.length;
    expect(await job.receive({ id: "done-out", from: CLEANER, text: "DONE" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [],
    });
    expect(box.sent).toHaveLength(afterStop);
    expect(hostReady(box.sent)).toEqual([]);
  });
});

describe("door code in the group", () => {
  it("finishes from a group DONE and posts the code once, in the group of the landlord and the cleaner", async () => {
    const { box, job } = await ready(true);
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    const groups = box.sent.filter((text) => text.channel === "group");
    expect(groups.filter((text) => text.body.includes(PIN) || text.body.includes("Door code")).map((text) => text.kind)).toEqual(["pin"]);
    expect(box.sent.filter((text) => text.kind === "pin")).toEqual([{ to: CLEANER, body: GROUP_PIN_TEXT, kind: "pin", channel: "group", audience: [OWNER, CLEANER] }]);
    expect(box.sent.filter((text) => text.body.includes(PIN) && !text.channel)).toEqual([]);
    const done = await job.receive({ id: "done-group", from: CLEANER, text: "DONE", channel: "group" });
    // Both done lines go into the group now, one post each, and nothing one-to-one.
    const groupDone = (sent: CleanerText[]) => sent.filter((text) => text.kind === "done");
    expect(done.sent).toEqual([{ to: CLEANER, body: DONE_ACK, kind: "done", channel: "group", audience: [OWNER, CLEANER] }]);
    expect(job.jobs()[0]?.status).toBe("done");
    expect(groupDone(box.sent).map(({ to, body, channel, audience }) => ({ to, body, channel, audience }))).toEqual([
      { to: CLEANER, body: DONE_ACK, channel: "group", audience: [OWNER, CLEANER] },
      { to: CLEANER, body: HOST_DONE, channel: "group", audience: [OWNER, CLEANER] },
    ]);
    await job.receive({ id: "done-group-2", from: CLEANER, text: "DONE", channel: "group" });
    expect(box.sent.filter((text) => text.body === HOST_DONE)).toHaveLength(1);
    expect(box.sent.filter((text) => text.channel === "group" && text.kind !== "pin").some((text) => text.body.includes("Door code") || text.body.includes(PIN))).toBe(false);
  });
});

describe("group chat flag", () => {
  const roots: string[] = [];

  afterEach(() => {
    setCleanerTwilioClient(undefined);
    setCleanerCalendarFetch(undefined);
    resetLiveDesks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function invite(env: NodeJS.ProcessEnv): Promise<string[]> {
    const sms = fakeSms();
    setCleanerTwilioClient(sms);
    setCleanerCalendarFetch(async () => ({
      status: 200,
      url: CALENDAR_URL,
      async text() {
        return CALENDAR_ICS;
      },
    }));
    const root = mkdtempSync(join(tmpdir(), "cleaner-group-default-"));
    roots.push(root);
    const desk = liveDeskFor(root, () => env, () => new Date(NOW));
    const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
    expect((await desk.getState("cleaners")).ok).toBe(true);
    expect((await desk.saveProperty({ business: "Scratch", address: ADDRESS, timeZone: "America/New_York" })).ok).toBe(true);
    expect((await desk.savePeople({ host: OWNER, cleaner: CLEANER, observer: OBSERVER, doorCodeTo: "cleaner" })).ok).toBe(true);
    expect((await desk.saveCalendarLink({ url: CALENDAR_URL })).ok).toBe(true);
    expect((await desk.saveDoorCode({ code: PIN }, pinKey)).ok).toBe(true);
    expect((await desk.setUpTexting()).ok).toBe(true);
    expect((await desk.runChecks()).ok).toBe(true);
    expect((await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" })).ok).toBe(true);
    return sms.sent.map((text) => text.body);
  }

  it("uses the group thread unless the flag is 0 or false", async () => {
    const base: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_SCRATCH_TOOLS: "1",
      CLEANER_CORE_SMS_ALLOWLIST: `${OWNER},${CLEANER},${OBSERVER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    };
    expect(await invite(base)).toEqual([GROUP_INVITE, OBSERVER_INVITE]);
    expect(await invite({ ...base, CLEANER_CORE_GROUP_CHAT: "0" })).toEqual([SOLO_INVITE]);
    expect(await invite({ ...base, CLEANER_CORE_GROUP_CHAT: "false" })).toEqual([SOLO_INVITE]);
  });
});
