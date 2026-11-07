import { fixedCodePort } from "../src/cleaner-core/doorPort";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MessagingLedger } from "../src/messaging/ledger";
import { handleProviderWebhook } from "../src/messaging/pipeline";
import { LocalMessagingProvider } from "../src/messaging/local/provider";
import { cleanerCoreEnabled, googleCalendarFixtureSource, notionFixtureSource, openCleanerCore, runDoctor, runSmoke, scratchTenant, type CleanerText } from "../src/cleaner-core";

const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const CHECKOUT_Q = "Is checkout at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.";
const CHECKIN_Q = "Is check-in at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18 still 4:00 PM? Reply YES or send the new time.";
const OFFER = "Turnover at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.";
const HOLD = "The cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is waiting for the cleaner to reply YES.";
const OFFER_1PM = "Turnover at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 1:00 PM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.";
const CONFIRM = "Cleaning is scheduled for Sunday, Oct 18 at 11:00 AM at 12 Scratch Lane, Teaneck, NJ 07666.";
const CONFIRM_1PM = "Cleaning is scheduled for Sunday, Oct 18 at 1:00 PM at 12 Scratch Lane, Teaneck, NJ 07666.";
const MONDAY_Q = "Is checkout at 12 Scratch Lane, Teaneck, NJ 07666 on Monday, Oct 19 still 11:00 AM? Reply YES or send the new time.";
const MONDAY_CHECKIN_Q = "Is check-in at 12 Scratch Lane, Teaneck, NJ 07666 on Monday, Oct 19 still 4:00 PM? Reply YES or send the new time.";
const CORRECTED = "Update: checkout at 12 Scratch Lane, Teaneck, NJ 07666 moved to Monday, Oct 19 at 11:00 AM. Reply YES to keep the cleaning, or STOP to opt out.";
const CANCEL = "Update: the cleaning at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18 is canceled, so no need to come. Reply STOP to opt out.";
const REMINDER = "Reminder: checkout at 12 Scratch Lane, Teaneck, NJ 07666 is Sunday, Oct 18 at 11:00 AM. Reply STOP to opt out.";
const STOP_ACK = "You're opted out and won't receive more messages. Reply START to opt back in. Reply HELP for help.";
const START_ACK = "You're opted back in. Reply YES if you still want this turnover. Reply STOP to opt out.";
const HOST_STOP_OPEN = `You're opted out of cleaning texts for ${ADDRESS}. Reply START to get texts again.`;
const HOST_STOP_HELD = `You're opted out of cleaning texts for ${ADDRESS}, and the cleaning there is on hold. Reply START to get texts again.`;
const HOST_START_OPEN = `You'll get cleaning texts for ${ADDRESS} again.`;
const HOST_DONE = `The cleaner marked the cleaning at ${ADDRESS} done.`;
const DECLINED = "Okay, that turnover is not scheduled.";
const EMERGENCY = "If someone is hurt, call 911 now.";
const HOST_HURT = "The cleaner at 12 Scratch Lane, Teaneck, NJ 07666 says someone is hurt. They've been told to call 911.";
const INJURY_HOLD = "The cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is on hold because the cleaner reported an injury. Once everyone's okay, tell your Grok Bot to restart it.";
const CLEANER_HURT = "If someone is hurt, call 911 now. I've let the host know.";
const CLEANER_HURT_MISSED = "If someone is hurt, call 911 now. I couldn't reach the host, so please call them too.";
const NOW = "2026-10-14T15:00:00.000Z";
const DUE = "2026-10-18T12:00:00.000Z";
const SMOKE_USAGE = "Usage: tsx src/cleaner-core/cli.ts smoke [--data <dir>] [--no-poll] [--feed <file>] [--then-feed <file>] [--google <file>] [--notion <file>] [--onboard] [--group-mode cleaner-only|native|mirrored] [--group-capable] [--participant <role>=<phone>] [--tenant scratch-lane|scratch-court] [--closed] [--now <iso>] [--remind] [--fail-sends <n>] [--with-pin] [--unapproved] [--group <phone>] [--group-chat] [--group-extra <phone>] [--group-reply <from>=<text>] [--confirm-times <checkout>|<check-in>] [--resume] [--reply <from>=<text> ...]";

const feed = (name: string) => readFileSync(join("src/cleaner-core/fixtures", name), "utf8");

afterEach(() => {
  delete process.env.CLEANER_CORE_ENABLED;
});

function said(from: string, text: string): string {
  return `${from}: ${text}`;
}

function sink() {
  const sent: CleanerText[] = [];
  return {
    sent,
    send(text: CleanerText) {
      sent.push(text);
    },
  };
}

function core(sent: ReturnType<typeof sink>, overrides: Partial<Parameters<typeof openCleanerCore>[0]> = {}) {
  return openCleanerCore({
    enabled: true,
    property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
    ownerPhone: OWNER,
    cleaner: { phone: CLEANER, approved: true },
    consented: true,
    sink: sent,
    now: () => new Date(NOW),
    ...overrides,
  });
}

describe("flag off leaves touring inbound unchanged", () => {
  it("accepts only 1 or true", () => {
    expect(cleanerCoreEnabled({})).toBe(false);
    expect(cleanerCoreEnabled({ CLEANER_CORE_ENABLED: "" })).toBe(false);
    expect(cleanerCoreEnabled({ CLEANER_CORE_ENABLED: "yes" })).toBe(false);
    expect(cleanerCoreEnabled({ CLEANER_CORE_ENABLED: "0" })).toBe(false);
    expect(cleanerCoreEnabled({ CLEANER_CORE_ENABLED: "1" })).toBe(true);
    expect(cleanerCoreEnabled({ CLEANER_CORE_ENABLED: "true" })).toBe(true);
    expect(cleanerCoreEnabled({ CLEANER_CORE_ENABLED: "TRUE" })).toBe(true);
  });

  it("delivers STOP, HELP, an injury, and YES through the shared pipeline with the flag off and on", async () => {
    for (const flag of [undefined, "1"] as const) {
      if (flag) process.env.CLEANER_CORE_ENABLED = flag;
      else delete process.env.CLEANER_CORE_ENABLED;
      for (const text of ["STOP", "HELP", "I fell and I'm hurt", "YES"]) {
        const ledger = new MessagingLedger();
        const received: string[] = [];
        const raw = Buffer.from(JSON.stringify({ id: `pipe-${text}`, from: "+15555550199", to: "+15555550123", text }));
        const result = await handleProviderWebhook(
          new LocalMessagingProvider(),
          { rawBody: raw, headers: {}, url: "http://127.0.0.1/webhooks/local" },
          { ledger, receive: async (message) => { received.push(message.text); } },
        );
        expect({ status: result.status, body: result.body, received }).toEqual({
          status: 200,
          body: { ok: true },
          received: [text],
        });
        const again = await handleProviderWebhook(
          new LocalMessagingProvider(),
          { rawBody: raw, headers: {}, url: "http://127.0.0.1/webhooks/local" },
          { ledger, receive: async (message) => { received.push(message.text); } },
        );
        expect({ status: again.status, body: again.body, received }).toEqual({
          status: 200,
          body: { duplicate: true },
          received: [text],
        });
      }
    }
  });

  it("sends nothing when the flag is off, and asks the host when it is on", async () => {
    const off = sink();
    const disabled = await core(off, { enabled: false }).pollFeed(feed("guesty-lite-scratch.ics"));
    expect(disabled).toEqual({ polled: false, reason: "disabled", sent: [], jobs: [], blocks: [] });
    expect(off.sent).toEqual([]);

    const on = sink();
    const asked = await core(on).pollFeed(feed("guesty-lite-scratch.ics"));
    expect(asked.sent).toEqual([{ to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" }]);
    expect(on.sent).toEqual([{ to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" }]);
  });
});

describe("Guesty Lite feed", () => {
  it("reads a same-day turn and a free night, and does not treat a block as a departure", async () => {
    const box = sink();
    const job = core(box);
    const read = await job.pollFeed(feed("guesty-lite-scratch.ics"));
    expect(read.blocks).toEqual([
      { uid: "block-owner@guesty.com", summary: "Blocked" },
      { uid: "block-date@guesty.com", summary: "Not available" },
    ]);
    expect(read.jobs.map((item) => ({
      id: item.id,
      checkoutDate: item.checkoutDate,
      nextCheckInDate: item.nextCheckInDate,
      sameDay: item.sameDay,
      live: item.live,
      checkoutTime: item.checkoutTime,
    }))).toEqual([
      { id: "stay-anita@guesty.com", checkoutDate: "2026-10-18", nextCheckInDate: "2026-10-18", sameDay: true, live: true, checkoutTime: null },
      { id: "stay-same-day@guesty.com", checkoutDate: "2026-10-20", nextCheckInDate: "2026-10-22", sameDay: false, live: true, checkoutTime: null },
      { id: "stay-after-gap@guesty.com", checkoutDate: "2026-10-24", nextCheckInDate: null, sameDay: false, live: true, checkoutTime: null },
    ]);
    expect(read.jobs.some((item) => item.id.startsWith("block-"))).toBe(false);
    expect(box.sent).toEqual([{ to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" }]);
    expect(CHECKOUT_Q).not.toContain("10:00");
  });

  it("creates no job and sends no offer for an owner block or a blocked date", async () => {
    const box = sink();
    const read = await core(box).pollFeed(feed("guesty-lite-blocks-only.ics"));
    expect(read.jobs).toEqual([]);
    expect(read.sent).toEqual([]);
    expect(box.sent).toEqual([]);
    expect(read.blocks.map((block) => block.uid)).toEqual(["block-owner@guesty.com", "block-date@guesty.com"]);
  });

  it("asks 11:00 AM when the feed says 10:00, then keeps the host's later time", async () => {
    const box = sink();
    const job = core(box);
    await job.pollFeed(feed("guesty-lite-clock-bait.ics"));
    expect(box.sent.map((text) => text.body)).toEqual([CHECKOUT_Q]);
    await job.receive({ id: "host-1", from: OWNER, text: "1:00 PM" });
    await job.pollFeed(feed("guesty-lite-clock-bait.ics"));
    await job.receive({ id: "host-2", from: OWNER, text: "YES" });
    expect(job.jobs()[0]).toMatchObject({
      checkoutTime: "1:00 PM",
      checkoutAt: "2026-10-18T17:00:00.000Z",
      nextCheckInTime: "4:00 PM",
      hostCheckoutVersion: 1,
      status: "host_confirmed",
    });
    expect(box.sent.map((text) => text.body)).toEqual([CHECKOUT_Q, CHECKIN_Q, HOLD]);
    expect(box.sent.map((text) => text.body).join("\n")).not.toContain("10:00");
  });
});

describe("one Scratch turnover", () => {
  it("confirms the cleaning after the host agrees, and does not send a door code", async () => {
    const box = sink();
    const job = core(box);
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    await job.receive({ id: "yes-checkout", from: OWNER, text: "YES" });
    await job.receive({ id: "yes-checkin", from: OWNER, text: "YES" });
    const booked = await job.receive({ id: "yes-offer", from: OWNER, text: "YES" });
    expect(booked).toEqual({ handled: true, reason: "ignored", sent: [] });
    expect(box.sent.map((text) => text.body)).toEqual([CHECKOUT_Q, CHECKIN_Q, HOLD]);
    expect(box.sent.map((text) => text.kind)).toEqual(["host-checkout", "host-checkin", "held"]);
    expect(job.jobs().some((item) => item.status === "offered")).toBe(false);
    expect(job.transcript()).toEqual([
      CHECKOUT_Q, said(OWNER, "YES"), CHECKIN_Q, said(OWNER, "YES"), HOLD, said(OWNER, "YES"),
    ]);
    const again = await job.receive({ id: "yes-offer", from: OWNER, text: "YES" });
    expect(again).toEqual({ handled: true, reason: "duplicate", sent: [] });
    expect(job.transcript()).toEqual([
      CHECKOUT_Q, said(OWNER, "YES"), CHECKIN_Q, said(OWNER, "YES"), HOLD, said(OWNER, "YES"),
    ]);
  });

  it("asks the host again when the checkout date changes, and sends the update only after that answer", async () => {
    const box = sink();
    const job = core(box);
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    await job.receive({ id: "t1", from: OWNER, text: "1:00 PM" });
    await job.receive({ id: "t2", from: OWNER, text: "YES" });
    await job.receive({ id: "t3", from: OWNER, text: "YES" });
    await job.pollFeed(feed("guesty-lite-date-moved.ics"));
    expect(box.sent.map((text) => text.body)).toEqual([CHECKOUT_Q, CHECKIN_Q, HOLD, MONDAY_Q]);
    expect(box.sent.map((text) => text.body).some((body) => body.startsWith("Update:"))).toBe(false);
    expect(job.jobs().find((item) => item.id === "stay-anita@guesty.com")).toMatchObject({
      live: true,
      status: "discovered",
      asking: "checkout",
      checkoutDate: "2026-10-19",
      checkoutTime: null,
      nextCheckInTime: null,
      hostCheckoutVersion: 0,
      hostCheckInVersion: 0,
    });
    await job.receive({ id: "t4", from: OWNER, text: "YES" });
    expect(box.sent.at(-1)?.body).toBe(MONDAY_CHECKIN_Q);
    expect(box.sent.map((text) => text.body).some((body) => body.startsWith("Update:"))).toBe(false);
    await job.receive({ id: "t5", from: OWNER, text: "YES" });
    const bodies = box.sent.map((text) => text.body);
    expect(bodies.at(-1)).toBe(HOLD);
    expect(bodies.filter((body) => body === HOLD)).toHaveLength(2);
    expect(bodies.filter((body) => body.startsWith("Turnover at"))).toEqual([]);
    const anita = job.jobs().filter((item) => item.id === "stay-anita@guesty.com");
    expect(anita).toEqual([expect.objectContaining({
      live: true,
      status: "host_confirmed",
      checkoutDate: "2026-10-19",
      checkoutTime: "11:00 AM",
      version: 2,
      hostCheckoutVersion: 1,
    })]);
    expect(job.jobs().filter((item) => item.live && item.id === "stay-anita@guesty.com")).toHaveLength(1);
    const due = sink();
    const reminded = core(due, { now: () => new Date(DUE) });
    await reminded.pollFeed(feed("guesty-lite-date-moved.ics"));
    expect(await reminded.runReminders()).toEqual({ sent: [], failed: [] });
    expect(due.sent.map((text) => text.body)).toEqual([
      "Is checkout at 12 Scratch Lane, Teaneck, NJ 07666 on Monday, Oct 19 still 11:00 AM? Reply YES or send the new time.",
    ]);
  });

  it("cancels the old job when the stay leaves the feed", async () => {
    const box = sink();
    const job = core(box);
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    await job.receive({ id: "c1", from: OWNER, text: "YES" });
    await job.receive({ id: "c2", from: OWNER, text: "YES" });
    await job.pollFeed(feed("guesty-lite-stay-removed.ics"));
    expect(box.sent.map((text) => text.body)).toEqual([CHECKOUT_Q, CHECKIN_Q, HOLD, CANCEL]);
    await job.pollFeed(feed("guesty-lite-stay-removed.ics"));
    await job.pollFeed(feed("guesty-lite-stay-removed.ics"));
    expect(box.sent.map((text) => text.body)).toEqual([
      CHECKOUT_Q,
      CHECKIN_Q,
      HOLD,
      CANCEL,
      "Is checkout at 12 Scratch Lane, Teaneck, NJ 07666 on Tuesday, Oct 20 still 11:00 AM? Reply YES or send the new time.",
    ]);
    expect(job.jobs().map((item) => ({ id: item.id, live: item.live, status: item.status }))).toEqual([
      { id: "stay-anita@guesty.com", live: false, status: "canceled" },
      { id: "stay-same-day@guesty.com", live: true, status: "discovered" },
      { id: "stay-after-gap@guesty.com", live: true, status: "discovered" },
    ]);
    expect(job.jobs().filter((item) => item.live && item.id === "stay-anita@guesty.com")).toEqual([]);
  });

  it("sends each reminder once across a second poll, a failed send, and a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-core-"));
    try {
      let fail = true;
      const firstSink = sink();
      const first = pinned(firstSink, {
        dataDir: dir,
        now: () => new Date(DUE),
        sink: {
          send(text: CleanerText) {
            if (fail && text.kind === "reminder") {
              fail = false;
              throw new Error("send failed");
            }
            firstSink.sent.push(text);
          },
        },
      });
      await first.pollFeed(feed("guesty-lite-scratch.ics"));
      await first.pollFeed(feed("guesty-lite-scratch.ics"));
      expect(first.transcript()).toEqual([CHECKOUT_Q, OPT_IN]);
      await first.receive({ id: "opt", from: CLEANER, text: "YES" });
      await first.receive({ id: "m1", from: OWNER, text: "YES" });
      await first.receive({ id: "m2", from: OWNER, text: "YES" });
      await first.receive({ id: "m3", from: CLEANER, text: "YES" });
      expect(await first.runReminders()).toEqual({
        sent: [],
        failed: ["reminder:stay-anita@guesty.com:morning-of:2026-10-18:1:660"],
      });
      expect(first.outbox().find((item) => item.kind === "reminder")).toMatchObject({ status: "failed", body: CLEANER_REMINDER, to: CLEANER });
      expect(first.transcript()).not.toContain(CLEANER_REMINDER);

      const secondSink = sink();
      const second = pinned(secondSink, { dataDir: dir, now: () => new Date(DUE) });
      expect(await second.runReminders()).toEqual({ sent: [{ to: CLEANER, body: CLEANER_REMINDER, kind: "reminder" }], failed: [] });
      expect(second.transcript().filter((line) => line === CLEANER_REMINDER)).toEqual([CLEANER_REMINDER]);
      expect(second.outbox().find((item) => item.kind === "reminder")?.status).toBe("sent");

      const third = pinned(sink(), { dataDir: dir, now: () => new Date(DUE) });
      expect(await third.runReminders()).toEqual({ sent: [], failed: [] });
      expect(third.transcript().filter((line) => line === CLEANER_REMINDER)).toEqual([CLEANER_REMINDER]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends nothing more to the owner after STOP, including a feed change and a reminder", async () => {
    const box = sink();
    const job = core(box, { now: () => new Date(DUE) });
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    await job.receive({ id: "stop-a", from: OWNER, text: "YES" });
    await job.receive({ id: "stop-b", from: OWNER, text: "YES" });
    expect(await job.receive({ id: "stop-1", from: OWNER, text: "STOP" })).toEqual({
      handled: true,
      reason: "stop",
      sent: [{ to: OWNER, body: HOST_STOP_OPEN, kind: "stop" }],
    });
    const before = box.sent.length;
    await job.pollFeed(feed("guesty-lite-date-moved.ics"));
    expect(await job.runReminders()).toEqual({ sent: [], failed: [] });
    expect(box.sent.slice(before)).toEqual([]);
    expect(box.sent.filter((text) => text.body === CORRECTED || text.body === REMINDER || text.kind === "offer")).toEqual([]);
    expect(box.sent.filter((text) => text.body === HOLD)).toEqual([{ to: OWNER, body: HOLD, kind: "held" }]);
    expect(job.jobs().every((item) => item.textsBlocked)).toBe(true);
  });

  it("answers STOP and an injury before step C in every new state", async () => {
    const phrases = [
      { text: "STOP", body: HOST_STOP_OPEN, kind: "stop" as const, reason: "stop" as const },
      { text: "I fell and I'm hurt", body: EMERGENCY, kind: "emergency" as const, reason: "emergency" as const },
    ];
    for (const phrase of phrases) {
      const waiting = sink();
      const waitingJob = core(waiting);
      await waitingJob.pollFeed(feed("guesty-lite-scratch.ics"));
      const waitingStatus = waitingJob.jobs()[0]?.status;
      expect(await waitingJob.receive({ id: `w-${phrase.kind}`, from: OWNER, text: phrase.text })).toEqual({
        handled: true,
        reason: phrase.reason,
        sent: [{ to: OWNER, body: phrase.body, kind: phrase.kind }],
      });
      expect(waitingJob.jobs()[0]?.status).toBe(waitingStatus);
      expect(waiting.sent.map((text) => text.body)).toEqual([CHECKOUT_Q, phrase.body]);

      const offered = sink();
      const offeredJob = core(offered);
      await offeredJob.pollFeed(feed("guesty-lite-scratch.ics"));
      await offeredJob.receive({ id: `o1-${phrase.kind}`, from: OWNER, text: "YES" });
      await offeredJob.receive({ id: `o2-${phrase.kind}`, from: OWNER, text: "YES" });
      expect(offeredJob.jobs()[0]?.status).toBe("host_confirmed");
      expect(await offeredJob.receive({ id: `o3-${phrase.kind}`, from: OWNER, text: phrase.text })).toEqual({
        handled: true,
        reason: phrase.reason,
        sent: [{ to: OWNER, body: phrase.body, kind: phrase.kind }],
      });
      expect(offeredJob.jobs()[0]?.status).toBe("host_confirmed");
      expect(offered.sent.at(-1)?.body).toBe(phrase.body);
      expect(offered.sent.map((text) => text.body)).not.toContain(CONFIRM);

      const corrected = sink();
      const correctedJob = core(corrected);
      await correctedJob.pollFeed(feed("guesty-lite-scratch.ics"));
      await correctedJob.receive({ id: `c1-${phrase.kind}`, from: OWNER, text: "YES" });
      await correctedJob.receive({ id: `c2-${phrase.kind}`, from: OWNER, text: "YES" });
      await correctedJob.receive({ id: `c3-${phrase.kind}`, from: OWNER, text: "YES" });
      await correctedJob.pollFeed(feed("guesty-lite-date-moved.ics"));
      const before = corrected.sent.length;
      expect(await correctedJob.receive({ id: `c4-${phrase.kind}`, from: OWNER, text: phrase.text })).toEqual({
        handled: true,
        reason: phrase.reason,
        sent: [{ to: OWNER, body: phrase.body, kind: phrase.kind }],
      });
      expect(corrected.sent.slice(before)).toEqual([{ to: OWNER, body: phrase.body, kind: phrase.kind }]);
      expect(correctedJob.jobs()[0]?.status).not.toBe("confirmed");
    }
  });

  it("sends the emergency reply once per sender per job", async () => {
    const box = sink();
    const job = core(box);
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    expect(await job.receive({ id: "hurt-owner-1", from: OWNER, text: "I fell and I'm hurt" })).toEqual({
      handled: true,
      reason: "emergency",
      sent: [{ to: OWNER, body: EMERGENCY, kind: "emergency" }],
    });
    expect(await job.receive({ id: "hurt-owner-2", from: OWNER, text: "I fell and I'm hurt" })).toEqual({
      handled: true,
      reason: "emergency",
      sent: [],
    });
    expect(await job.receive({ id: "hurt-cleaner-1", from: CLEANER, text: "I fell and I'm hurt" })).toEqual({
      handled: true,
      reason: "emergency",
      sent: [
        { to: OWNER, body: HOST_HURT, kind: "emergency" },
        { to: OWNER, body: INJURY_HOLD, kind: "emergency" },
        { to: CLEANER, body: CLEANER_HURT, kind: "emergency" },
      ],
    });
    expect(await job.receive({ id: "hurt-cleaner-2", from: CLEANER, text: "I fell and I'm hurt" })).toEqual({
      handled: true,
      reason: "emergency",
      sent: [],
    });
    await job.pollFeed(feed("guesty-lite-stay-removed.ics"));
    expect(await job.receive({ id: "hurt-owner-3", from: OWNER, text: "I fell and I'm hurt" })).toEqual({
      handled: true,
      reason: "emergency",
      sent: [{ to: OWNER, body: EMERGENCY, kind: "emergency" }],
    });
    expect(box.sent.filter((text) => text.kind === "emergency")).toEqual([
      { to: OWNER, body: EMERGENCY, kind: "emergency" },
      { to: OWNER, body: HOST_HURT, kind: "emergency" },
      { to: OWNER, body: INJURY_HOLD, kind: "emergency" },
      { to: CLEANER, body: CLEANER_HURT, kind: "emergency" },
      { to: OWNER, body: EMERGENCY, kind: "emergency" },
    ]);
  });

  it("opts back in on START and still does not send a door code", async () => {
    const box = sink();
    const job = core(box);
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    await job.receive({ id: "stop-2", from: OWNER, text: "please stop texting me" });
    expect(await job.receive({ id: "start-1", from: OWNER, text: "START" })).toEqual({
      handled: true,
      reason: "start",
      sent: [{ to: OWNER, body: HOST_START_OPEN, kind: "start" }],
    });
    const next = await job.receive({ id: "yes-3", from: OWNER, text: "Yes please" });
    expect(next.sent).toEqual([{ to: OWNER, body: CHECKIN_Q, kind: "host-checkin" }]);
    expect(box.sent.map((text) => text.kind)).toEqual(["host-checkout", "stop", "start", "host-checkin"]);
  });

  it("does not schedule a no, a stranger's yes, a non-scratch number, or a missing consent", async () => {
    const declined = sink();
    const noJob = core(declined);
    await noJob.pollFeed(feed("guesty-lite-scratch.ics"));
    await noJob.receive({ id: "no-a", from: OWNER, text: "YES" });
    await noJob.receive({ id: "no-b", from: OWNER, text: "YES" });
    expect(await noJob.receive({ id: "no-1", from: OWNER, text: "NO" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [],
    });
    expect((await noJob.pollFeed(feed("guesty-lite-scratch.ics"))).sent).toEqual([]);
    expect(noJob.jobs()[0]?.status).toBe("host_confirmed");
    expect(declined.sent.filter((text) => text.kind === "offer")).toEqual([]);
    expect(declined.sent.filter((text) => text.body === HOLD)).toEqual([{ to: OWNER, body: HOLD, kind: "held" }]);
    expect(declined.sent.map((text) => text.body)).not.toContain(DECLINED);

    const stranger = sink();
    const strangerJob = core(stranger);
    await strangerJob.pollFeed(feed("guesty-lite-scratch.ics"));
    expect(await strangerJob.receive({ id: "stranger-1", from: CLEANER, text: "YES" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [],
    });
    expect(stranger.sent).toEqual([{ to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" }]);

    const real = sink();
    const blocked = await core(real, { ownerPhone: "+10000000000" }).pollFeed(feed("guesty-lite-scratch.ics"));
    expect(blocked).toEqual({ polled: false, reason: "scratch-only", sent: [], jobs: [], blocks: [] });
    expect(real.sent).toEqual([]);

    const quiet = sink();
    const unconsented = await core(quiet, { consented: false }).pollFeed(feed("guesty-lite-scratch.ics"));
    expect(unconsented).toEqual({ polled: false, reason: "not-consented", sent: [], jobs: [], blocks: [] });
    expect(quiet.sent).toEqual([]);
  });

  it("runs the doctor and the Scratch smoke command without opening a socket", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      throw new Error("network");
    }) as typeof fetch;
    try {
      expect(runDoctor({})).toEqual({
        ok: true,
        enabled: false,
        sends: false,
        note: "Cleaner Core is off. Touring texts are unchanged.",
      });
      expect(runDoctor({ CLEANER_CORE_ENABLED: "1" })).toEqual({
        ok: true,
        enabled: true,
        sends: false,
        note: "Cleaner Core is on. doctor does not send texts.",
      });
      const smoke = await runSmoke({ CLEANER_CORE_ENABLED: "1" });
      expect(smoke.transcript).toEqual([
        CHECKOUT_Q, said(OWNER, "YES"), CHECKIN_Q, said(OWNER, "YES"), HOLD, said(OWNER, "YES"),
      ]);
      expect(smoke.pinRecipients).toEqual([]);
      expect(smoke.checkout).toBe("2026-10-18T15:00:00.000Z");
      expect(smoke.nextArrival).toBe("2026-10-18T20:00:00.000Z");
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("the smoke command exits 2 when the flag is off and prints the host questions when it is on", () => {
    const env = { ...process.env };
    delete env.CLEANER_CORE_ENABLED;
    const stopped = cleanerCli(["smoke"], undefined);
    expect(stopped.status).toBe(2);
    expect(JSON.parse(stopped.stdout)).toEqual({ ok: false, reason: "disabled", sent: [], pinRecipients: [] });

    const on = cleanerCli(["smoke"], "1");
    expect(on.status).toBe(0);
    const report = JSON.parse(on.stdout) as { ok: boolean; pinRecipients: string[]; transcript: string[]; sent: CleanerText[] };
    expect(report.ok).toBe(true);
    expect(report.pinRecipients).toEqual([]);
    expect(report.transcript).toEqual([
      CHECKOUT_Q, said(OWNER, "YES"), CHECKIN_Q, said(OWNER, "YES"), HOLD, said(OWNER, "YES"),
    ]);
    expect(report.sent.map((text) => text.kind)).toEqual(["host-checkout", "host-checkin", "held"]);

    const doctor = cleanerCli(["doctor"], undefined);
    expect(JSON.parse(doctor.stdout)).toEqual({
      ok: true,
      enabled: false,
      sends: false,
      note: "Cleaner Core is off. Touring texts are unchanged.",
    });
  });

  it("injects the given Scratch replies and does not add YES", () => {
    const stop = cleanerCli(["smoke", "--reply", `${OWNER}=STOP`, "--reply", `${OWNER}=YES`], "1");
    expect(stop.status).toBe(0);
    expect(JSON.parse(stop.stdout).transcript).toEqual([
      CHECKOUT_Q, said(OWNER, "STOP"), HOST_STOP_OPEN, said(OWNER, "YES"),
    ]);

    const help = cleanerCli(["smoke", "--reply", `${OWNER}=HELP`], "1");
    const helpReport = JSON.parse(help.stdout) as { transcript: string[]; sent: CleanerText[]; jobs: Array<{ status: string }> };
    expect(helpReport.transcript).toEqual([CHECKOUT_Q, said(OWNER, "HELP")]);
    expect(helpReport.sent.map((text) => text.kind)).toEqual(["host-checkout"]);
    expect(helpReport.jobs[0]?.status).toBe("discovered");

    const hurt = "I fell and I'm hurt";
    const injury = cleanerCli([
      "smoke",
      "--reply", `${OWNER}=${hurt}`,
      "--reply", `${OWNER}=${hurt}`,
      "--reply", `${CLEANER}=${hurt}`,
      "--reply", `${CLEANER}=${hurt}`,
    ], "1");
    expect(JSON.parse(injury.stdout).transcript).toEqual([
      CHECKOUT_Q,
      said(OWNER, hurt),
      EMERGENCY,
      said(OWNER, hurt),
      said(CLEANER, hurt),
      HOST_HURT,
      INJURY_HOLD,
      CLEANER_HURT,
      said(CLEANER, hurt),
    ]);
    expect(JSON.parse(injury.stdout).sent.filter((text: CleanerText) => text.kind === "emergency")).toEqual([
      { to: OWNER, body: EMERGENCY, kind: "emergency" },
      { to: OWNER, body: HOST_HURT, kind: "emergency" },
      { to: OWNER, body: INJURY_HOLD, kind: "emergency" },
      { to: CLEANER, body: CLEANER_HURT, kind: "emergency" },
    ]);

    const stranger = cleanerCli(["smoke", "--reply", "+15555550199=YES"], "1");
    expect(JSON.parse(stranger.stdout).transcript).toEqual([CHECKOUT_Q, said("+15555550199", "YES")]);
    expect(JSON.parse(stranger.stdout).pinRecipients).toEqual([]);
  });

  it("sends nothing when the flag is off, including when a Scratch reply is injected", () => {
    const quiet = cleanerCli(["smoke", "--reply", `${OWNER}=YES`], undefined);
    expect(quiet.status).toBe(2);
    expect(JSON.parse(quiet.stdout)).toEqual({
      ok: false,
      reason: "disabled",
      sent: [],
      pinRecipients: [],
    });
    expect(quiet.stderr).toBe("");
  });

  it("refuses an extra argument or a non-Scratch reply and prints no turnover", () => {
    const extra = cleanerCli(["smoke", "STOP"], "1");
    expect(extra.status).toBe(1);
    expect(extra.stdout).toBe("");
    expect(extra.stderr).toBe(`Unexpected argument STOP. ${SMOKE_USAGE}\n`);

    const real = cleanerCli(["smoke", "--reply", "+10000000000=YES"], "1");
    expect(real.status).toBe(1);
    expect(real.stdout).toBe("");
    expect(real.stderr).toBe("Cleaner Core only texts Scratch test numbers. Refusing +10000000000.\n");

    const realOff = cleanerCli(["smoke", "--reply", "+10000000000=YES"], undefined);
    expect(realOff.status).toBe(1);
    expect(realOff.stdout).toBe("");
    expect(realOff.stderr).toBe("Cleaner Core only texts Scratch test numbers. Refusing +10000000000.\n");

    const doctor = cleanerCli(["doctor", "--reply", `${OWNER}=YES`], undefined);
    expect(doctor.status).toBe(1);
    expect(doctor.stdout).toBe("");
    expect(doctor.stderr).toBe("Unexpected argument --reply. Usage: tsx src/cleaner-core/cli.ts doctor\n");
  });
});

const PIN = "4821";
const OPT_IN = "Hi, this is Scratch's cleaning scheduler for 12 Scratch Lane, Teaneck, NJ 07666. Reply YES to get cleaning texts, or STOP to opt out.";
const PIN_TEXT = "Guests have left 12 Scratch Lane, Teaneck, NJ 07666. Door code: 4821. This code is only for you. Reply DONE when the cleaning is finished.";
const PIN_REDACTED = "Guests have left 12 Scratch Lane, Teaneck, NJ 07666. Door code: [redacted]. This code is only for you. Reply DONE when the cleaning is finished.";
const PIN_NOTICE = "Door code sent to the cleaner.";
const CLEANER_REMINDER = "Reminder: cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is Sunday, Oct 18 at 11:00 AM.";
const PIN_FAIL = "The door code didn't reach the cleaner. We'll try again in a few minutes.";
const PIN_HELD = "The cleaner opted out, so the door code wasn't sent. Please reach them directly.";
const STARTED = "Got it, cleaning started.";
const DONE_ACK = "Thanks, cleaning marked done.";
const CORRECTED_2PM = "Update: checkout at 12 Scratch Lane, Teaneck, NJ 07666 moved to Sunday, Oct 18 at 2:00 PM. Reply YES to keep the cleaning, or STOP to opt out.";
const CONFIRM_2PM = "Cleaning is scheduled for Sunday, Oct 18 at 2:00 PM at 12 Scratch Lane, Teaneck, NJ 07666.";
const AFTER = "2026-10-18T15:30:00.000Z";
const UNAPPROVED = "+15555550199";

function pinned(box: ReturnType<typeof sink>, overrides: Partial<Parameters<typeof openCleanerCore>[0]> = {}) {
  return core(box, { access: fixedCodePort(PIN), hostName: "Scratch", ...overrides });
}

async function confirmAnita(job: ReturnType<typeof pinned>, cleanerYes = true): Promise<void> {
  await job.pollFeed(feed("guesty-lite-scratch.ics"));
  if (cleanerYes) await job.receive({ id: "opt-yes", from: CLEANER, text: "YES" });
  await job.receive({ id: "y-out", from: OWNER, text: "YES" });
  await job.receive({ id: "y-in", from: OWNER, text: "YES" });
  if (cleanerYes) await job.receive({ id: "y-offer", from: CLEANER, text: "YES" });
}

describe("step D private door code", () => {
  it("holds the door code until the host confirms departure, then sends it once", async () => {
    const box = sink();
    let now = NOW;
    const job = pinned(box, { now: () => new Date(now) });
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    await job.receive({ id: "opt-yes", from: CLEANER, text: "YES" });
    await job.receive({ id: "y-out", from: OWNER, text: "YES" });
    await job.receive({ id: "y-in", from: OWNER, text: "YES" });
    expect(await job.receive({ id: "owner-offer", from: OWNER, text: "YES" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [],
    });
    expect(job.jobs()[0]?.status).toBe("offered");
    expect(await job.receive({ id: "y-offer", from: CLEANER, text: "YES" })).toEqual({
      handled: true,
      reason: "scheduled",
      sent: [{ to: CLEANER, body: CONFIRM, kind: "confirm" }],
    });
    expect(box.sent).toEqual([
      { to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" },
      { to: CLEANER, body: OPT_IN, kind: "opt-in" },
      { to: OWNER, body: CHECKIN_Q, kind: "host-checkin" },
      { to: CLEANER, body: OFFER, kind: "offer" },
      { to: CLEANER, body: CONFIRM, kind: "confirm" },
    ]);
    now = AFTER;
    expect(job.jobs().map((item) => item.status)).toEqual(["awaiting_departure", "discovered", "discovered"]);
    const released = await job.receive({ id: "left-1", from: OWNER, text: "guests have left" });
    expect(released).toEqual({
      handled: true,
      reason: "departure",
      sent: [
        { to: CLEANER, body: PIN_TEXT, kind: "pin" },
        { to: OWNER, body: PIN_NOTICE, kind: "pin-notice" },
      ],
    });
    expect(await job.receive({ id: "left-2", from: OWNER, text: "guests have left" })).toEqual({
      handled: true,
      reason: "departure",
      sent: [],
    });
    expect(box.sent.filter((text) => text.kind === "pin")).toEqual([{ to: CLEANER, body: PIN_TEXT, kind: "pin" }]);
    expect(job.jobs()[0]?.status).toBe("cleared");
  });

  it("sends the door code only to an approved cleaner who opted in", async () => {
    const quiet = sink();
    const skipped = pinned(quiet);
    await confirmAnita(skipped, false);
    expect(await skipped.receive({ id: "left-skip", from: OWNER, text: "guests have left" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [],
    });
    const onHold = `The cleaning at ${ADDRESS} is waiting for the cleaner to reply YES.`;
    expect(quiet.sent).toEqual([
      { to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" },
      { to: CLEANER, body: OPT_IN, kind: "opt-in" },
      { to: OWNER, body: CHECKIN_Q, kind: "host-checkin" },
      { to: OWNER, body: onHold, kind: "held" },
    ]);

    const stranger = sink();
    const strangerJob = pinned(stranger);
    await strangerJob.pollFeed(feed("guesty-lite-scratch.ics"));
    expect(await strangerJob.receive({ id: "stranger-yes", from: UNAPPROVED, text: "YES" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [],
    });
    await strangerJob.receive({ id: "s1", from: OWNER, text: "YES" });
    await strangerJob.receive({ id: "s2", from: OWNER, text: "YES" });
    await strangerJob.receive({ id: "s3", from: OWNER, text: "YES" });
    expect(await strangerJob.receive({ id: "left-stranger", from: OWNER, text: "guests have left" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [],
    });
    expect(stranger.sent).toEqual([
      { to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" },
      { to: CLEANER, body: OPT_IN, kind: "opt-in" },
      { to: OWNER, body: CHECKIN_Q, kind: "host-checkin" },
      { to: OWNER, body: onHold, kind: "held" },
    ]);

    const unapproved = sink();
    const blocked = pinned(unapproved, { cleaner: { phone: CLEANER, approved: false } });
    await blocked.pollFeed(feed("guesty-lite-scratch.ics"));
    await blocked.receive({ id: "no-app", from: CLEANER, text: "YES" });
    await blocked.receive({ id: "n1", from: OWNER, text: "YES" });
    await blocked.receive({ id: "n2", from: OWNER, text: "YES" });
    await blocked.receive({ id: "n3", from: OWNER, text: "YES" });
    expect(await blocked.receive({ id: "left-unapproved", from: OWNER, text: "guests have left" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [],
    });
    expect(unapproved.sent).toEqual([
      { to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" },
      { to: OWNER, body: CHECKIN_Q, kind: "host-checkin" },
      { to: OWNER, body: onHold, kind: "held" },
    ]);
  });

  it("holds the door code when the host moves checkout later, until the host confirms again", async () => {
    const box = sink();
    const job = pinned(box);
    await confirmAnita(job);
    expect(await job.receive({ id: "later", from: OWNER, text: "2:00 PM" })).toEqual({
      handled: true,
      reason: "host-time",
      sent: [{ to: CLEANER, body: CORRECTED_2PM, kind: "corrected" }],
    });
    expect(await job.receive({ id: "left-early", from: OWNER, text: "guests have left" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [],
    });
    expect(await job.receive({ id: "owner-keep", from: OWNER, text: "YES" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [],
    });
    expect(await job.receive({ id: "keep", from: CLEANER, text: "YES" })).toEqual({
      handled: true,
      reason: "scheduled",
      sent: [{ to: CLEANER, body: CONFIRM_2PM, kind: "confirm" }],
    });
    expect(await job.receive({ id: "left-again", from: OWNER, text: "guests have left" })).toEqual({
      handled: true,
      reason: "departure",
      sent: [
        { to: CLEANER, body: PIN_TEXT, kind: "pin" },
        { to: OWNER, body: PIN_NOTICE, kind: "pin-notice" },
      ],
    });
    expect(box.sent.filter((text) => text.kind === "pin")).toEqual([{ to: CLEANER, body: PIN_TEXT, kind: "pin" }]);
  });

  it("walks one turn from the offer through a private door code to done", async () => {
    const box = sink();
    let now = NOW;
    const job = pinned(box, { now: () => new Date(now) });
    await confirmAnita(job);
    now = DUE;
    expect(await job.runReminders()).toEqual({ sent: [{ to: CLEANER, body: CLEANER_REMINDER, kind: "reminder" }], failed: [] });
    expect(await job.runReminders()).toEqual({ sent: [], failed: [] });
    now = AFTER;
    expect(job.jobs()[0]?.status).toBe("awaiting_departure");
    await job.receive({ id: "left-full", from: OWNER, text: "guests have left" });
    expect(await job.receive({ id: "start-clean", from: CLEANER, text: "START" })).toEqual({
      handled: true,
      reason: "start",
      sent: [{ to: CLEANER, body: STARTED, kind: "started" }],
    });
    expect(await job.receive({ id: "done-clean", from: CLEANER, text: "DONE" })).toEqual({
      handled: true,
      reason: "done",
      sent: [{ to: CLEANER, body: DONE_ACK, kind: "done" }],
    });
    expect(box.sent.map((text) => ({ to: text.to, body: text.body, kind: text.kind }))).toEqual([
      { to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" },
      { to: CLEANER, body: OPT_IN, kind: "opt-in" },
      { to: OWNER, body: CHECKIN_Q, kind: "host-checkin" },
      { to: CLEANER, body: OFFER, kind: "offer" },
      { to: CLEANER, body: CONFIRM, kind: "confirm" },
      { to: CLEANER, body: CLEANER_REMINDER, kind: "reminder" },
      { to: CLEANER, body: PIN_TEXT, kind: "pin" },
      { to: OWNER, body: PIN_NOTICE, kind: "pin-notice" },
      { to: CLEANER, body: STARTED, kind: "started" },
      { to: CLEANER, body: DONE_ACK, kind: "done" },
      { to: OWNER, body: HOST_DONE, kind: "done" },
    ]);
    expect(job.jobs().map((item) => item.status)).toEqual(["done", "discovered", "discovered"]);
    expect(job.transcript()).toEqual([
      CHECKOUT_Q,
      OPT_IN,
      said(CLEANER, "YES"),
      said(OWNER, "YES"),
      CHECKIN_Q,
      said(OWNER, "YES"),
      OFFER,
      said(CLEANER, "YES"),
      CONFIRM,
      CLEANER_REMINDER,
      said(OWNER, "guests have left"),
      PIN_REDACTED,
      PIN_NOTICE,
      said(CLEANER, "START"),
      STARTED,
      said(CLEANER, "DONE"),
      DONE_ACK,
      HOST_DONE,
    ]);
  });

  it("stores the door code encrypted and keeps plaintext out of the record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-core-pin-"));
    const box = sink();
    try {
      const job = pinned(box, { dataDir: dir });
      await confirmAnita(job);
      await job.receive({ id: "left-store", from: OWNER, text: "guests have left" });
      const stored = readFileSync(join(dir, "cleaner-core.json"), "utf8");
      expect(stored.includes(PIN)).toBe(false);
      expect(box.sent.find((text) => text.kind === "pin")).toEqual({ to: CLEANER, body: PIN_TEXT, kind: "pin" });
      expect(job.transcript().join("\n").includes(PIN)).toBe(false);
      expect(job.outbox().map((item) => item.body).join("\n").includes(PIN)).toBe(false);
      expect(job.transcript()).toContain(PIN_REDACTED);
      expect(job.outbox().find((item) => item.kind === "pin")).toEqual({
        id: "pin:stay-anita@guesty.com:2026-10-18:660:1",
        to: CLEANER,
        body: PIN_REDACTED,
        kind: "pin",
        status: "sent",
        jobId: "stay-anita@guesty.com",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tells the host when STOP holds the door code, and START does not send it", async () => {
    const box = sink();
    const job = pinned(box);
    await confirmAnita(job);
    expect(await job.receive({ id: "cleaner-stop", from: CLEANER, text: "STOP" })).toEqual({
      handled: true,
      reason: "stop",
      sent: [{ to: CLEANER, body: STOP_ACK, kind: "stop" }],
    });
    expect(await job.receive({ id: "left-stopped", from: OWNER, text: "guests have left" })).toEqual({
      handled: true,
      reason: "departure",
      sent: [{ to: OWNER, body: PIN_HELD, kind: "pin-held" }],
    });
    expect(await job.receive({ id: "cleaner-start", from: CLEANER, text: "START" })).toEqual({
      handled: true,
      reason: "start",
      sent: [{ to: CLEANER, body: START_ACK, kind: "start" }],
    });
    expect(box.sent.filter((text) => text.kind === "pin")).toEqual([]);
    expect(box.sent.map((text) => text.body)).toContain(PIN_HELD);
    expect(job.transcript()).toContain(PIN_HELD);
  });

  it("answers HELP and an injury while waiting, after the door code, and in progress", async () => {
    const phases = ["waiting", "cleared", "progress"] as const;
    for (const phase of phases) {
      const box = sink();
      let now = NOW;
      const job = pinned(box, { now: () => new Date(now) });
      await confirmAnita(job);
      now = AFTER;
      if (phase !== "waiting") await job.receive({ id: `${phase}-left`, from: OWNER, text: "guests have left" });
      if (phase === "progress") await job.receive({ id: `${phase}-start`, from: CLEANER, text: "START" });
      const before = box.sent.length;
      expect(await job.receive({ id: `${phase}-help`, from: CLEANER, text: "HELP" })).toEqual({
        handled: true,
        reason: "ignored",
        sent: [],
      });
      expect(await job.receive({ id: `${phase}-hurt`, from: OWNER, text: "I fell and I'm hurt" })).toEqual({
        handled: true,
        reason: "emergency",
        sent: [{ to: OWNER, body: EMERGENCY, kind: "emergency" }],
      });
      expect(await job.receive({ id: `${phase}-cleaner-hurt`, from: CLEANER, text: "I fell and I'm hurt" })).toEqual({
        handled: true,
        reason: "emergency",
        sent: [
          { to: OWNER, body: HOST_HURT, kind: "emergency" },
          { to: OWNER, body: INJURY_HOLD, kind: "emergency" },
          { to: CLEANER, body: CLEANER_HURT, kind: "emergency" },
        ],
      });
      expect(await job.receive({ id: `${phase}-cleaner-hurt-again`, from: CLEANER, text: "I fell and I'm hurt" })).toEqual({
        handled: true,
        reason: "emergency",
        sent: [],
      });
      expect(box.sent.slice(before)).toEqual([
        { to: OWNER, body: EMERGENCY, kind: "emergency" },
        { to: OWNER, body: HOST_HURT, kind: "emergency" },
        { to: OWNER, body: INJURY_HOLD, kind: "emergency" },
        { to: CLEANER, body: CLEANER_HURT, kind: "emergency" },
      ]);
      expect(box.sent.slice(before).map((text) => text.body).join("\n").includes(PIN)).toBe(false);
      const pinTexts = box.sent.filter((text) => text.kind === "pin");
      expect(pinTexts).toEqual(phase === "waiting" ? [] : [{ to: CLEANER, body: PIN_TEXT, kind: "pin" }]);
      expect(job.jobs()[0]?.status).toBe(phase === "waiting" ? "awaiting_departure" : phase === "cleared" ? "cleared" : "in_progress");
    }
  });

  it("leaves every job state unchanged when the cleaner texts HELP", async () => {
    let helpN = 0;
    const unchanged = async (job: ReturnType<typeof core>, box: ReturnType<typeof sink>, from: string, text = "HELP") => {
      const jobs = job.jobs();
      const outbox = job.outbox();
      const optedOut = job.cleanerHasOptedOut();
      const sent = box.sent.length;
      expect(await job.receive({ id: `plain-help-${helpN++}`, from, text })).toEqual({ handled: true, reason: "ignored", sent: [] });
      expect(job.jobs()).toEqual(jobs);
      expect(job.outbox()).toEqual(outbox);
      expect(job.cleanerHasOptedOut()).toBe(optedOut);
      expect(box.sent).toHaveLength(sent);
      expect(box.sent.filter((item) => item.kind === "help")).toEqual([]);
      expect(box.sent.some((item) => item.body.includes("I've let Cory know"))).toBe(false);
      expect(job.health().counters.help).toBe(0);
      expect(await job.receive({ id: `plain-help-${helpN++}`, from, text })).toEqual({ handled: true, reason: "ignored", sent: [] });
      expect(job.jobs()).toEqual(jobs);
      expect(job.cleanerHasOptedOut()).toBe(optedOut);
      expect(box.sent).toHaveLength(sent);
    };

    const discovered = sink();
    const discoveredJob = pinned(discovered);
    await discoveredJob.pollFeed(feed("guesty-lite-scratch.ics"));
    expect(discoveredJob.jobs()[0]?.status).toBe("discovered");
    await unchanged(discoveredJob, discovered, CLEANER);
    await unchanged(discoveredJob, discovered, OWNER, "INFO");

    const waiting = sink();
    const waitingJob = pinned(waiting);
    await waitingJob.pollFeed(feed("guesty-lite-scratch.ics"));
    await waitingJob.receive({ id: "help-state-out", from: OWNER, text: "YES" });
    expect(waitingJob.jobs()[0]?.status).toBe("awaiting_checkin");
    await unchanged(waitingJob, waiting, CLEANER);
    await unchanged(waitingJob, waiting, OWNER);

    const heldTimes = sink();
    const heldTimesJob = pinned(heldTimes);
    await heldTimesJob.pollFeed(feed("guesty-lite-scratch.ics"));
    await heldTimesJob.receive({ id: "help-state-h1", from: OWNER, text: "YES" });
    await heldTimesJob.receive({ id: "help-state-h2", from: OWNER, text: "YES" });
    expect(heldTimesJob.jobs()[0]?.status).toBe("host_confirmed");
    await unchanged(heldTimesJob, heldTimes, CLEANER);

    const offered = sink();
    const offeredJob = pinned(offered);
    await offeredJob.pollFeed(feed("guesty-lite-scratch.ics"));
    await offeredJob.receive({ id: "help-state-opt", from: CLEANER, text: "YES" });
    await offeredJob.receive({ id: "help-state-o1", from: OWNER, text: "YES" });
    await offeredJob.receive({ id: "help-state-o2", from: OWNER, text: "YES" });
    expect(offeredJob.jobs()[0]?.status).toBe("offered");
    await unchanged(offeredJob, offered, CLEANER);

    const declined = sink();
    const declinedJob = pinned(declined);
    await declinedJob.pollFeed(feed("guesty-lite-scratch.ics"));
    await declinedJob.receive({ id: "help-state-dopt", from: CLEANER, text: "YES" });
    await declinedJob.receive({ id: "help-state-d1", from: OWNER, text: "YES" });
    await declinedJob.receive({ id: "help-state-d2", from: OWNER, text: "YES" });
    await declinedJob.receive({ id: "help-state-no", from: CLEANER, text: "NO" });
    expect(declinedJob.jobs()[0]?.status).toBe("declined");
    await unchanged(declinedJob, declined, CLEANER);

    const confirmed = sink();
    const confirmedJob = pinned(confirmed);
    await confirmAnita(confirmedJob);
    expect(confirmedJob.jobs()[0]?.status).toBe("confirmed");
    await unchanged(confirmedJob, confirmed, CLEANER);

    let now = NOW;
    const departing = sink();
    const departingJob = pinned(departing, { now: () => new Date(now) });
    await confirmAnita(departingJob);
    now = AFTER;
    expect(departingJob.jobs()[0]?.status).toBe("awaiting_departure");
    await unchanged(departingJob, departing, CLEANER);

    const cleared = sink();
    let clearedNow = NOW;
    const clearedJob = pinned(cleared, { now: () => new Date(clearedNow) });
    await confirmAnita(clearedJob);
    clearedNow = AFTER;
    await clearedJob.receive({ id: "help-state-left", from: OWNER, text: "guests have left" });
    expect(clearedJob.jobs()[0]?.status).toBe("cleared");
    await unchanged(clearedJob, cleared, CLEANER);

    const started = sink();
    let startedNow = NOW;
    const startedJob = pinned(started, { now: () => new Date(startedNow) });
    await confirmAnita(startedJob);
    startedNow = AFTER;
    await startedJob.receive({ id: "help-state-left-2", from: OWNER, text: "guests have left" });
    await startedJob.receive({ id: "help-state-start", from: CLEANER, text: "START" });
    expect(startedJob.jobs()[0]?.status).toBe("in_progress");
    await unchanged(startedJob, started, CLEANER);

    const finished = sink();
    let finishedNow = NOW;
    const finishedJob = pinned(finished, { now: () => new Date(finishedNow) });
    await confirmAnita(finishedJob);
    finishedNow = AFTER;
    await finishedJob.receive({ id: "help-state-left-3", from: OWNER, text: "guests have left" });
    await finishedJob.receive({ id: "help-state-start-2", from: CLEANER, text: "START" });
    await finishedJob.receive({ id: "help-state-done", from: CLEANER, text: "DONE" });
    expect(finishedJob.jobs()[0]?.status).toBe("done");
    await unchanged(finishedJob, finished, CLEANER);

    const canceled = sink();
    const canceledJob = pinned(canceled);
    await confirmAnita(canceledJob);
    await canceledJob.pollFeed(feed("guesty-lite-stay-removed.ics"));
    expect(canceledJob.jobs()[0]?.status).toBe("canceled");
    await unchanged(canceledJob, canceled, CLEANER);

    const paused = sink();
    let pausedNow = NOW;
    const pausedJob = pinned(paused, { now: () => new Date(pausedNow) });
    await confirmAnita(pausedJob);
    pausedNow = AFTER;
    await pausedJob.receive({ id: "help-state-stop", from: CLEANER, text: "STOP" });
    await pausedJob.receive({ id: "help-state-held", from: OWNER, text: "guests have left" });
    expect(pausedJob.cleanerHasOptedOut()).toBe(true);
    expect(paused.sent.filter((text) => text.kind === "pin")).toEqual([]);
    await unchanged(pausedJob, paused, CLEANER);
    expect(pausedJob.cleanerHasOptedOut()).toBe(true);
    expect(paused.sent.filter((text) => text.kind === "pin")).toEqual([]);

    const silenced = sink();
    const silencedJob = core(silenced);
    await silencedJob.pollFeed(feed("guesty-lite-scratch.ics"));
    await silencedJob.receive({ id: "help-state-owner-stop", from: OWNER, text: "STOP" });
    expect(silencedJob.jobs().every((item) => item.textsBlocked)).toBe(true);
    await unchanged(silencedJob, silenced, OWNER);
    expect(silencedJob.jobs().every((item) => item.textsBlocked)).toBe(true);
  });

  it("does not call a failed door-code send delivered, then retries it once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-core-pin-fail-"));
    try {
      let fail = true;
      const firstBox = sink();
      let now = NOW;
      const first = pinned(firstBox, {
        dataDir: dir,
        now: () => new Date(now),
        sink: {
          send(text: CleanerText) {
            if (fail && text.kind === "pin") {
              fail = false;
              throw new Error("send failed");
            }
            firstBox.sent.push(text);
          },
        },
      });
      await confirmAnita(first);
      now = AFTER;
      expect(await first.receive({ id: "left-fail", from: OWNER, text: "guests have left" })).toEqual({
        handled: true,
        reason: "departure",
        sent: [{ to: OWNER, body: PIN_FAIL, kind: "pin-failed" }],
      });
      expect(first.jobs()[0]?.status).toBe("awaiting_departure");
      expect(first.outbox().find((item) => item.kind === "pin")).toEqual({
        id: "pin:stay-anita@guesty.com:2026-10-18:660:1",
        to: CLEANER,
        body: PIN_REDACTED,
        kind: "pin",
        status: "failed",
        jobId: "stay-anita@guesty.com",
      });
      expect(first.transcript()).toContain(PIN_FAIL);
      expect(first.transcript().join("\n").includes(PIN)).toBe(false);

      const secondBox = sink();
      const second = pinned(secondBox, { dataDir: dir });
      expect(await second.runReminders()).toEqual({
        sent: [
          { to: CLEANER, body: PIN_TEXT, kind: "pin" },
          { to: OWNER, body: PIN_NOTICE, kind: "pin-notice" },
        ],
        failed: [],
      });
      expect(second.jobs()[0]?.status).toBe("cleared");
      expect(secondBox.sent.filter((text) => text.kind === "pin")).toEqual([{ to: CLEANER, body: PIN_TEXT, kind: "pin" }]);

      const third = pinned(sink(), { dataDir: dir });
      expect(await third.runReminders()).toEqual({ sent: [], failed: [] });
      expect(third.outbox().find((item) => item.kind === "pin")).toEqual({
        id: "pin:stay-anita@guesty.com:2026-10-18:660:1",
        to: CLEANER,
        body: PIN_REDACTED,
        kind: "pin",
        status: "sent",
        jobId: "stay-anita@guesty.com",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps host-direct lines for an opted-out owner and does not text them", async () => {
    const asked = sink();
    const questions = pinned(asked);
    await questions.receive({ id: "questions-stop", from: OWNER, text: "STOP" });
    expect(asked.sent.filter((text) => text.to === OWNER).map((text) => text.body)).toEqual([HOST_STOP_HELD]);
    await questions.resumeJob();
    await questions.pollFeed(feed("guesty-lite-scratch.ics"));
    await questions.receive({ id: "questions-yes", from: OWNER, text: "YES" });
    expect(asked.sent.filter((text) => text.to === OWNER).map((text) => text.body)).toEqual([HOST_STOP_HELD]);
    expect(questions.hostNotes()).toEqual([
      "The cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is on hold because you opted out of texts. Tell your Grok Bot to restart it.",
      "The cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is back on.",
      CHECKOUT_Q,
      CHECKIN_Q,
    ]);

    const failed = sink();
    let failedNow = NOW;
    const failedJob = pinned(failed, { now: () => new Date(failedNow) });
    await confirmAnita(failedJob);
    failedNow = AFTER;
    await failedJob.receive({ id: "failed-left", from: OWNER, text: "guests have left" });
    const pin = failedJob.outbox().find((item) => item.kind === "pin");
    expect(pin).toEqual(expect.objectContaining({ kind: "pin", status: "sent", to: CLEANER }));
    await failedJob.receive({ id: "failed-stop", from: OWNER, text: "STOP" });
    const afterStop = failed.sent.length;
    await failedJob.reportPin(pin?.id ?? "", "failed");
    await failedJob.reportPin(pin?.id ?? "", "undelivered");
    expect(failed.sent.slice(afterStop)).toEqual([]);
    expect(failedJob.pullPinFailure()).toBe(true);
    expect(failedJob.pinAccepted()).toBe(false);

    const held = sink();
    let heldNow = NOW;
    const heldJob = pinned(held, { now: () => new Date(heldNow) });
    await confirmAnita(heldJob);
    heldNow = AFTER;
    await heldJob.receive({ id: "held-cleaner-stop", from: CLEANER, text: "STOP" });
    await heldJob.receive({ id: "held-owner-stop", from: OWNER, text: "STOP" });
    const marked = held.sent.length;
    await heldJob.resumeJob();
    const left = await heldJob.receive({ id: "held-left", from: OWNER, text: "guests have left" });
    expect(held.sent.slice(marked).filter((text) => text.to === OWNER)).toEqual([]);
    expect(left.sent.filter((text) => text.kind === "pin")).toEqual([]);
    expect(heldJob.hostNotes()).toEqual([
      "The cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is on hold because you opted out of texts. Tell your Grok Bot to restart it.",
      "The cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is back on.",
      PIN_HELD,
    ]);
  });

  it("keeps the door code off the group and off Cory's copy", async () => {
    const box = sink();
    const job = pinned(box, { groupPhones: [UNAPPROVED] });
    await confirmAnita(job);
    await job.receive({ id: "left-group", from: OWNER, text: "guests have left" });
    expect(box.sent.filter((text) => text.to === UNAPPROVED)).toEqual([]);
    expect(box.sent.filter((text) => text.kind === "pin")).toEqual([{ to: CLEANER, body: PIN_TEXT, kind: "pin" }]);
    expect(box.sent.filter((text) => text.kind === "pin-notice")).toEqual([{ to: OWNER, body: PIN_NOTICE, kind: "pin-notice" }]);
    expect(box.sent.filter((text) => text.kind !== "pin").map((text) => text.body).join("\n").includes(PIN)).toBe(false);
  });

  it("prints the private door code redacted and leaves it out of the smoke log", () => {
    const drive = cleanerCli([
      "smoke",
      "--with-pin",
      "--feed", "src/cleaner-core/fixtures/guesty-lite-scratch.ics",
      "--reply", `${CLEANER}=YES`,
      "--reply", `${OWNER}=YES`,
      "--reply", `${OWNER}=YES`,
      "--reply", `${CLEANER}=YES`,
      "--reply", `${OWNER}=guests have left`,
    ], "1");
    expect(drive.status).toBe(0);
    expect(drive.stderr).toBe("");
    expect(drive.stdout.includes(PIN)).toBe(false);
    const report = JSON.parse(drive.stdout) as { pinRecipients: string[]; sent: CleanerText[]; transcript: string[]; jobs: { status: string }[] };
    expect(report.pinRecipients).toEqual([CLEANER]);
    expect(report.sent.find((text) => text.kind === "pin")).toEqual({ to: CLEANER, body: PIN_REDACTED, kind: "pin" });
    expect(report.sent.find((text) => text.kind === "pin-notice")).toEqual({ to: OWNER, body: PIN_NOTICE, kind: "pin-notice" });
    expect(report.transcript).toContain(PIN_REDACTED);
    expect(report.jobs[0]?.status).toBe("cleared");
  });

  it("tells the cleaner to call the host when the injury alert fails once", () => {
    const hurt = "I fell and I'm hurt";
    const drive = cleanerCli([
      "smoke",
      "--with-pin",
      "--feed", "src/cleaner-core/fixtures/guesty-lite-scratch.ics",
      "--reply", `${CLEANER}=YES`,
      "--reply", `${OWNER}=YES`,
      "--reply", `${OWNER}=YES`,
      "--reply", `${CLEANER}=YES`,
      "--fail-sends", "1",
      "--reply", `${CLEANER}=${hurt}`,
      "--reply", `${CLEANER}=${hurt}`,
    ], "1");
    expect(drive.status).toBe(0);
    expect(drive.stderr).toBe("");
    expect(drive.stdout.includes(PIN)).toBe(false);
    const report = JSON.parse(drive.stdout) as {
      sent: CleanerText[];
      transcript: string[];
      outbox: { to: string; body: string; kind: string; status: string }[];
    };
    expect(report.sent.filter((text) => text.kind === "emergency")).toEqual([
      { to: OWNER, body: INJURY_HOLD, kind: "emergency" },
      { to: CLEANER, body: CLEANER_HURT_MISSED, kind: "emergency" },
    ]);
    expect(report.outbox.find((item) => item.body === HOST_HURT)).toEqual(expect.objectContaining({
      to: OWNER,
      kind: "emergency",
      status: "failed",
    }));
    expect(report.transcript.filter((line) => line === CLEANER_HURT_MISSED)).toEqual([CLEANER_HURT_MISSED]);
    expect(report.transcript.includes(HOST_HURT)).toBe(false);
    expect(report.transcript.includes(CLEANER_HURT)).toBe(false);
    expect(report.sent.some((text) => text.kind === "pin")).toBe(false);
  });
});

describe("step E second source and second tenant", () => {
  const COURT = scratchTenant("scratch-court");
  const LANE_Q = "Is checkout at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.";
  const COURT_MONDAY = "Is checkout at 8 Scratch Court, Teaneck, NJ 07666 on Monday, Oct 19 still 11:00 AM? Reply YES or send the new time.";
  const COURT_WEDNESDAY = "Is checkout at 8 Scratch Court, Teaneck, NJ 07666 on Wednesday, Oct 21 still 11:00 AM? Reply YES or send the new time.";
  const COURT_CANCEL = "Update: the cleaning at 8 Scratch Court, Teaneck, NJ 07666 on Monday, Oct 19 is canceled, so no need to come. Reply STOP to opt out.";
  if (!COURT) throw new Error("Scratch Court is missing.");
  const google = (name: string) => googleCalendarFixtureSource(feed(name));

  it("reads a Google Calendar fixture with the conversation closed and ignores the event clock", async () => {
    const box = sink();
    const job = core(box, { tenantId: "scratch-lane" });
    const read = await job.readSource(google("google-lane-read.json"), { conversation: "closed" });
    expect(read.conversation).toBe("closed");
    expect(read.sources).toEqual(["google-calendar"]);
    expect(read.sent).toEqual([{ to: OWNER, body: LANE_Q, kind: "host-checkout" }]);
    expect(read.jobs.map((item) => ({ id: item.id, checkoutDate: item.checkoutDate, live: item.live }))).toEqual([
      { id: "google:evt-anita", checkoutDate: "2026-10-18", live: true },
    ]);
    expect(read.sent.some((text) => text.body.includes("10:00"))).toBe(false);
    expect(box.sent.some((text) => text.to === "+15555550110" || text.body.includes("4821") || text.body.includes("7392"))).toBe(false);
    expect(job.transcript().some((line) => line.startsWith("+1"))).toBe(false);
  });

  it("applies a checkout change on a closed sync, and a second sync sends nothing", async () => {
    const box = sink();
    const job = core(box, { tenantId: "scratch-court", property: COURT?.property, ownerPhone: COURT?.ownerPhone, cleaner: { phone: COURT?.cleanerPhone ?? "", approved: true } });
    const first = await job.readSource(google("google-court-stay.json"), { conversation: "closed" });
    const changed = await job.readSource(google("google-court-stay-moved.json"), { conversation: "closed" });
    const again = await job.readSource(google("google-court-stay-moved.json"), { conversation: "closed" });
    expect(first.sent).toEqual([{ to: "+15555550110", body: COURT_MONDAY, kind: "host-checkout" }]);
    expect(changed.sent).toEqual([{ to: "+15555550110", body: COURT_WEDNESDAY, kind: "host-checkout" }]);
    expect(again.sent).toEqual([]);
    expect(again.conversation).toBe("closed");
    expect(job.jobs()).toEqual([
      expect.objectContaining({ id: "google:evt-court", checkoutDate: "2026-10-21", status: "discovered", live: true }),
    ]);
    expect(job.jobs()).toHaveLength(1);
    expect(job.transcript().filter((line) => line.startsWith("+1"))).toEqual([]);
  });

  it("retries a failed closed-sync text once and does not send it a third time", async () => {
    const sent: CleanerText[] = [];
    let fail = true;
    const job = core({
      sent,
      send(text: CleanerText) {
        if (fail) {
          fail = false;
          throw new Error("send failed");
        }
        sent.push(text);
      },
    }, { tenantId: "scratch-lane" });
    await job.readSource(google("google-lane-read.json"), { conversation: "closed" });
    expect(sent).toEqual([]);
    expect(job.outbox()).toEqual([expect.objectContaining({ to: OWNER, body: LANE_Q, kind: "host-checkout", status: "failed" })]);
    await job.readSource(google("google-lane-read.json"), { conversation: "closed" });
    expect(sent).toEqual([{ to: OWNER, body: LANE_Q, kind: "host-checkout" }]);
    await job.readSource(google("google-lane-read.json"), { conversation: "closed" });
    expect(sent).toEqual([{ to: OWNER, body: LANE_Q, kind: "host-checkout" }]);
  });

  it("cancels a removed Google event with the existing cancel text", async () => {
    const box = sink();
    const job = core(box, { tenantId: "scratch-court", property: COURT?.property, ownerPhone: COURT?.ownerPhone, cleaner: { phone: COURT?.cleanerPhone ?? "", approved: true } });
    await job.readSource(google("google-court-stay.json"), { conversation: "closed" });
    const removed = await job.readSource(google("google-court-empty.json"), { conversation: "closed" });
    expect(removed.sent).toEqual([{ to: "+15555550110", body: COURT_CANCEL, kind: "cancel-update" }]);
    expect(removed.jobs).toEqual([
      expect.objectContaining({ id: "google:evt-court", status: "canceled", live: false, textsBlocked: true }),
    ]);
    const repeat = await job.readSource(google("google-court-empty.json"), { conversation: "closed" });
    expect(repeat.sent).toEqual([]);
  });

  it("keeps one job when Guesty Lite and Google Calendar describe the same stay", async () => {
    const box = sink();
    const job = core(box, { tenantId: "scratch-lane" });
    await job.pollFeed(feed("guesty-lite-scratch.ics"), { conversation: "closed" });
    const merged = await job.readSource(google("google-lane-overlap.json"), { conversation: "closed" });
    expect(merged.sent).toEqual([]);
    expect(merged.conflicts).toEqual([{ jobId: "stay-anita@guesty.com", checkoutDate: "2026-10-18", otherCheckoutDate: "2026-10-19" }]);
    expect(merged.sources).toEqual(["guesty-lite", "google-calendar"]);
    expect(job.jobs().map((item) => item.id)).toEqual([
      "stay-anita@guesty.com",
      "stay-same-day@guesty.com",
      "stay-after-gap@guesty.com",
    ]);
    expect(job.jobs().filter((item) => item.checkoutDate === "2026-10-18")).toHaveLength(1);
    expect(job.jobs().some((item) => item.id.startsWith("google:"))).toBe(false);
    expect(box.sent).toEqual([{ to: OWNER, body: LANE_Q, kind: "host-checkout" }]);
  });

  it("does not turn a Google block into a departure", async () => {
    const box = sink();
    const job = core(box, { tenantId: "scratch-lane" });
    const read = await job.readSource(google("google-lane-block.json"), { conversation: "closed" });
    expect(read.blocks).toEqual([{ uid: "google:evt-block", summary: "Owner block" }]);
    expect(read.jobs.map((item) => ({ id: item.id, checkoutDate: item.checkoutDate }))).toEqual([
      { id: "google:evt-stay", checkoutDate: "2026-10-18" },
    ]);
    expect(read.sent).toEqual([{ to: OWNER, body: LANE_Q, kind: "host-checkout" }]);
  });

  it("refuses the other tenant's calendar and does not text their phones", async () => {
    const laneBox = sink();
    const lane = core(laneBox, { tenantId: "scratch-lane" });
    const refused = await lane.readSource(google("google-court-stay.json"), { conversation: "closed" });
    expect(refused).toMatchObject({ polled: false, reason: "wrong-tenant", sent: [], conversation: "closed" });
    expect(lane.jobs()).toEqual([]);
    expect(laneBox.sent).toEqual([]);

    await lane.readSource(google("google-lane-read.json"), { conversation: "closed" });
    const stopped = await lane.receive({ id: "court-stop", from: "+15555550110", text: "STOP" });
    expect(stopped).toEqual({ handled: true, reason: "wrong-tenant", sent: [] });
    expect(lane.jobs()[0]?.textsBlocked).toBe(false);
    expect(laneBox.sent.map((text) => text.to)).toEqual([OWNER]);

    const courtBox = sink();
    const court = core(courtBox, {
      tenantId: "scratch-court",
      property: COURT?.property,
      ownerPhone: COURT?.ownerPhone,
      cleaner: { phone: COURT?.cleanerPhone ?? "", approved: true },
    });
    await court.readSource(google("google-court-stay.json"), { conversation: "closed" });
    const laneYes = await court.receive({ id: "lane-yes", from: OWNER, text: "YES" });
    expect(laneYes).toEqual({ handled: true, reason: "wrong-tenant", sent: [] });
    expect(court.jobs()[0]?.status).toBe("discovered");
    expect(courtBox.sent).toEqual([{ to: "+15555550110", body: COURT_MONDAY, kind: "host-checkout" }]);
    expect(JSON.stringify(laneBox.sent).includes("+15555550110")).toBe(false);
    expect(JSON.stringify(courtBox.sent).includes(OWNER)).toBe(false);
    expect(JSON.stringify(courtBox.sent).includes("12 Scratch Lane")).toBe(false);
    expect(JSON.stringify(laneBox.sent).includes("8 Scratch Court")).toBe(false);
  });

  it("keeps each tenant's sealed door code and texts in that tenant's store", async () => {
    const laneDir = mkdtempSync(join(tmpdir(), "cleaner-lane-"));
    const courtDir = mkdtempSync(join(tmpdir(), "cleaner-court-"));
    const lane = pinned(sink(), { tenantId: "scratch-lane", dataDir: laneDir });
    const court = pinned(sink(), {
      tenantId: "scratch-court",
      property: COURT?.property,
      ownerPhone: COURT?.ownerPhone,
      cleaner: { phone: COURT?.cleanerPhone ?? "", approved: true },
      access: fixedCodePort(COURT?.pin),
      dataDir: courtDir,
    });
    await lane.pollFeed(feed("guesty-lite-scratch.ics"));
    await court.readSource(google("google-court-stay.json"), { conversation: "closed" });
    const laneStore = readFileSync(join(laneDir, "cleaner-core.json"), "utf8");
    const courtStore = readFileSync(join(courtDir, "cleaner-core.json"), "utf8");
    expect(laneStore.includes("4821")).toBe(false);
    expect(laneStore.includes("7392")).toBe(false);
    expect(laneStore.includes("+15555550110")).toBe(false);
    expect(laneStore.includes("8 Scratch Court")).toBe(false);
    expect(courtStore.includes("4821")).toBe(false);
    expect(courtStore.includes("7392")).toBe(false);
    expect(courtStore.includes("+15555550100")).toBe(false);
    expect(courtStore.includes("+15555550101")).toBe(false);
    expect(courtStore.includes("12 Scratch Lane")).toBe(false);
    expect(court.outbox().every((item) => item.to === "+15555550110" || item.to === "+15555550111")).toBe(true);
    expect(lane.outbox().every((item) => item.to === OWNER || item.to === CLEANER)).toBe(true);
    rmSync(laneDir, { recursive: true, force: true });
    rmSync(courtDir, { recursive: true, force: true });
  });

  it("sends each Scratch door code once, only to that house's cleaner, from one folder", async () => {
    if (!COURT) throw new Error("Scratch Court is missing.");
    const dir = mkdtempSync(join(tmpdir(), "cleaner-both-"));
    const laneBox = sink();
    const courtBox = sink();
    const courtOpt = "Hi, this is Scratch's cleaning scheduler for 8 Scratch Court, Teaneck, NJ 07666. Reply YES to get cleaning texts, or STOP to opt out.";
    const courtOffer = "Turnover at 8 Scratch Court, Teaneck, NJ 07666 on Monday, Oct 19. Checkout 11:00 AM. Reply YES to schedule it, or STOP to opt out.";
    const courtConfirm = "Cleaning is scheduled for Monday, Oct 19 at 11:00 AM at 8 Scratch Court, Teaneck, NJ 07666.";
    const courtPin = "Guests have left 8 Scratch Court, Teaneck, NJ 07666. Door code: 7392. This code is only for you. Reply DONE when the cleaning is finished.";
    const courtPinRedacted = "Guests have left 8 Scratch Court, Teaneck, NJ 07666. Door code: [redacted]. This code is only for you. Reply DONE when the cleaning is finished.";
    try {
      const lane = pinned(laneBox, { tenantId: "scratch-lane", dataDir: dir });
      const court = pinned(courtBox, {
        tenantId: "scratch-court",
        property: COURT.property,
        ownerPhone: COURT.ownerPhone,
        cleaner: { phone: COURT.cleanerPhone, approved: true },
        access: fixedCodePort("7392"),
        hostName: "Scratch",
        dataDir: dir,
      });
      await lane.pollFeed(feed("guesty-lite-scratch.ics"));
      await lane.receive({ id: "lane-wrong-yes", from: "+15555550111", text: "YES" });
      await lane.receive({ id: "lane-opt", from: CLEANER, text: "YES" });
      await lane.receive({ id: "lane-out", from: OWNER, text: "YES" });
      await lane.receive({ id: "lane-in", from: OWNER, text: "YES" });
      await lane.receive({ id: "lane-offer", from: CLEANER, text: "YES" });
      expect(lane.jobs().map((item) => ({ id: item.id, status: item.status }))).toEqual([
        { id: "stay-anita@guesty.com", status: "confirmed" },
        { id: "stay-same-day@guesty.com", status: "discovered" },
        { id: "stay-after-gap@guesty.com", status: "discovered" },
      ]);
      expect(await lane.receive({ id: "lane-wrong-left", from: "+15555550110", text: "guests have left" })).toEqual({
        handled: true,
        reason: "wrong-tenant",
        sent: [],
      });
      expect(laneBox.sent.filter((text) => text.kind === "pin")).toEqual([]);

      await court.readSource(google("google-court-stay.json"));
      await court.receive({ id: "court-wrong-yes", from: CLEANER, text: "YES" });
      await court.receive({ id: "court-opt", from: "+15555550111", text: "YES" });
      await court.receive({ id: "court-out", from: "+15555550110", text: "YES" });
      expect(court.jobs()).toEqual([
        expect.objectContaining({ id: "google:evt-court", status: "offered", live: true }),
      ]);
      await court.receive({ id: "court-offer", from: "+15555550111", text: "YES" });
      expect(court.jobs()).toEqual([
        expect.objectContaining({ id: "google:evt-court", status: "confirmed", live: true }),
      ]);
      expect(await court.receive({ id: "court-wrong-left", from: OWNER, text: "guests have left" })).toEqual({
        handled: true,
        reason: "wrong-tenant",
        sent: [],
      });
      expect(courtBox.sent.filter((text) => text.kind === "pin")).toEqual([]);
      expect(courtBox.sent).toEqual([
        { to: "+15555550110", body: COURT_MONDAY, kind: "host-checkout" },
        { to: "+15555550111", body: courtOpt, kind: "opt-in" },
        { to: "+15555550111", body: courtOffer, kind: "offer" },
        { to: "+15555550111", body: courtConfirm, kind: "confirm" },
      ]);

      expect(await lane.receive({ id: "lane-left", from: OWNER, text: "guests have left" })).toEqual({
        handled: true,
        reason: "departure",
        sent: [
          { to: CLEANER, body: PIN_TEXT, kind: "pin" },
          { to: OWNER, body: PIN_NOTICE, kind: "pin-notice" },
        ],
      });
      expect(await court.receive({ id: "court-left", from: "+15555550110", text: "guests have left" })).toEqual({
        handled: true,
        reason: "departure",
        sent: [
          { to: "+15555550111", body: courtPin, kind: "pin" },
          { to: "+15555550110", body: PIN_NOTICE, kind: "pin-notice" },
        ],
      });
      expect(laneBox.sent).toEqual([
        { to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" },
        { to: CLEANER, body: OPT_IN, kind: "opt-in" },
        { to: OWNER, body: CHECKIN_Q, kind: "host-checkin" },
        { to: CLEANER, body: OFFER, kind: "offer" },
        { to: CLEANER, body: CONFIRM, kind: "confirm" },
        { to: CLEANER, body: PIN_TEXT, kind: "pin" },
        { to: OWNER, body: PIN_NOTICE, kind: "pin-notice" },
      ]);
      expect(courtBox.sent.filter((text) => text.kind === "pin")).toEqual([
        { to: "+15555550111", body: courtPin, kind: "pin" },
      ]);
      expect(lane.jobs()[0]).toEqual(expect.objectContaining({ id: "stay-anita@guesty.com", status: "cleared" }));
      expect(court.jobs()).toEqual([
        expect.objectContaining({ id: "google:evt-court", status: "cleared", live: true }),
      ]);

      const laneAgain = pinned(sink(), { tenantId: "scratch-lane", dataDir: dir });
      const courtAgain = pinned(sink(), {
        tenantId: "scratch-court",
        property: COURT.property,
        ownerPhone: COURT.ownerPhone,
        cleaner: { phone: COURT.cleanerPhone, approved: true },
        access: fixedCodePort("7392"),
        hostName: "Scratch",
        dataDir: dir,
      });
      expect(laneAgain.jobs().map((item) => ({ id: item.id, status: item.status }))).toEqual([
        { id: "stay-anita@guesty.com", status: "cleared" },
        { id: "stay-same-day@guesty.com", status: "discovered" },
        { id: "stay-after-gap@guesty.com", status: "discovered" },
      ]);
      expect(courtAgain.jobs().map((item) => ({ id: item.id, status: item.status }))).toEqual([
        { id: "google:evt-court", status: "cleared" },
      ]);
      expect(laneAgain.outbox().filter((item) => item.kind === "pin")).toEqual([
        {
          id: "pin:stay-anita@guesty.com:2026-10-18:660:1",
          to: CLEANER,
          body: PIN_REDACTED,
          kind: "pin",
          status: "sent",
          jobId: "stay-anita@guesty.com",
        },
      ]);
      expect(courtAgain.outbox().filter((item) => item.kind === "pin")).toEqual([
        {
          id: "pin:google:evt-court:2026-10-19:660:1",
          to: "+15555550111",
          body: courtPinRedacted,
          kind: "pin",
          status: "sent",
          jobId: "google:evt-court",
        },
      ]);
      const stored = readFileSync(join(dir, "cleaner-core.json"), "utf8");
      expect(stored.includes("4821")).toBe(false);
      expect(stored.includes("7392")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drives the closed sync and the court tenant from the smoke command", () => {
    const read = cleanerCli(["smoke", "--closed", "--google", "src/cleaner-core/fixtures/google-lane-read.json"], "1");
    expect(read.status).toBe(0);
    const readReport = JSON.parse(read.stdout) as { sent: CleanerText[]; sync: { conversation: string; sources: string[] }; tenant: string; jobs: { id: string }[] };
    expect(readReport.tenant).toBe("scratch-lane");
    expect(readReport.sync).toEqual({ conversation: "closed", sources: ["google-calendar"], reason: "read", conflicts: [] });
    expect(readReport.sent).toEqual([{ to: OWNER, body: LANE_Q, kind: "host-checkout" }]);
    expect(readReport.jobs.map((item) => item.id)).toEqual(["google:evt-anita"]);
    expect(read.stdout.includes("4821")).toBe(false);
    expect(read.stdout.includes("+15555550110")).toBe(false);

    const court = cleanerCli(["smoke", "--tenant", "scratch-court", "--closed", "--google", "src/cleaner-core/fixtures/google-court-stay.json"], "1");
    expect(court.status).toBe(0);
    const courtReport = JSON.parse(court.stdout) as { property: string; sent: CleanerText[]; jobs: { id: string }[] };
    expect(courtReport.property).toBe("8 Scratch Court, Teaneck, NJ 07666");
    expect(courtReport.sent).toEqual([{ to: "+15555550110", body: COURT_MONDAY, kind: "host-checkout" }]);
    expect(courtReport.jobs.map((item) => item.id)).toEqual(["google:evt-court"]);
    expect(court.stdout.includes("12 Scratch Lane")).toBe(false);
    expect(court.stdout.includes("+15555550100")).toBe(false);

    const missing = cleanerCli(["smoke", "--tenant", "scratch-court"], "1");
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("does not read Scratch Lane's calendar");
  });
});

describe("step F Notion, onboarding, and group delivery", () => {
  const NOTION_MISSING = "I can't read that Notion database. Permission is missing, so I did not sync bookings and I did not send a cleaning text.";
  const NOTION_INSUFFICIENT = "I can't read that Notion database. Permission is not enough to read it, so I did not sync bookings and I did not send a cleaning text.";
  const OBSERVER = "+15555550122";
  const ANNEX_HOST = "+15555550120";
  const ANNEX_CLEANER = "+15555550121";
  const ANNEX = "9 Scratch Annex, Teaneck, NJ 07666";
  const OPT_ANNEX = `Hi, this is Annex's cleaning scheduler for ${ANNEX}. Reply YES to get cleaning texts, or STOP to opt out.`;
  const GROUP = "Group text: ";
  const MIRROR = "Copy of the group text: ";
  const notion = (name: string) => notionFixtureSource(feed(name));

  it("tells the host when Notion permission is missing or insufficient and sends nothing", async () => {
    const missingBox = sink();
    const missing = core(missingBox, { tenantId: "scratch-lane" });
    const denied = await missing.readSource(notion("notion-lane-denied.json"), { conversation: "closed" });
    expect(denied.reason).toBe("permission-denied");
    expect(denied.fallback).toBe(NOTION_MISSING);
    expect(denied.sent).toEqual([]);
    expect(denied.jobs).toEqual([]);
    expect(missingBox.sent).toEqual([]);

    const shortBox = sink();
    const short = core(shortBox, { tenantId: "scratch-lane" });
    const insufficient = await short.readSource(notion("notion-lane-insufficient.json"), { conversation: "closed" });
    expect(insufficient.fallback).toBe(NOTION_INSUFFICIENT);
    expect(insufficient.sent).toEqual([]);
    expect(short.jobs()).toEqual([]);
    expect(shortBox.sent).toEqual([]);
  });

  it("reads a Notion stay in the tenant time zone and does not turn a block into a departure", async () => {
    const box = sink();
    const job = core(box, { tenantId: "scratch-lane" });
    const read = await job.readSource(notion("notion-lane-read.json"), { conversation: "closed" });
    expect(read.sent).toEqual([{ to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" }]);
    expect(read.blocks).toEqual([{ uid: "notion:row-block", summary: "Owner block" }]);
    expect(read.jobs.map((item) => ({ id: item.id, checkoutDate: item.checkoutDate }))).toEqual([
      { id: "notion:row-anita", checkoutDate: "2026-10-18" },
    ]);
    expect(read.freshness).toEqual([{ kind: "notion", fetchedAt: "2026-10-14T15:00:00.000Z", stale: false }]);
    expect(read.provenance).toEqual([{ jobId: "notion:row-anita", sources: [{ kind: "notion", uid: "notion:row-anita" }] }]);
    expect(read.sent.some((text) => text.body.includes("10:00"))).toBe(false);
    expect(job.jobs().some((item) => item.id === "notion:row-block")).toBe(false);
  });

  it("marks a Notion read stale when it is older than three hours", async () => {
    const box = sink();
    const job = core(box, { tenantId: "scratch-lane" });
    const body = feed("notion-lane-read.json").replace("2026-10-14T15:00:00.000Z", "2026-10-14T10:00:00.000Z");
    const read = await job.readSource(notionFixtureSource(body), { conversation: "closed" });
    expect(read.freshness).toEqual([{ kind: "notion", fetchedAt: "2026-10-14T10:00:00.000Z", stale: true }]);
    expect(read.sent).toEqual([{ to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" }]);
  });

  it("sends nothing when the same Notion snapshot is read again, including after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-notion-"));
    try {
      const first = core(sink(), { tenantId: "scratch-lane", dataDir: dir });
      const opened = await first.readSource(notion("notion-lane-read.json"), { conversation: "closed" });
      const again = await first.readSource(notion("notion-lane-read.json"), { conversation: "closed" });
      expect(opened.sent).toEqual([{ to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" }]);
      expect(again.sent).toEqual([]);
      expect(first.jobs()).toHaveLength(1);
      const restarted = core(sink(), { tenantId: "scratch-lane", dataDir: dir });
      const third = await restarted.readSource(notion("notion-lane-read.json"), { conversation: "closed" });
      expect(third.sent).toEqual([]);
      expect(restarted.jobs().map((item) => item.id)).toEqual(["notion:row-anita"]);
      expect(restarted.outbox().filter((item) => item.kind === "host-checkout")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancels a removed Notion row and does not send another reminder", async () => {
    const box = sink();
    const clock = { at: NOW };
    const timed = openCleanerCore({
      enabled: true,
      tenantId: "scratch-lane",
      property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
      ownerPhone: OWNER,
      cleaner: { phone: CLEANER, approved: true },
      access: fixedCodePort(PIN),
      hostName: "Scratch",
      consented: true,
      sink: box,
      now: () => new Date(clock.at),
    });
    await timed.readSource(notion("notion-lane-read.json"));
    await timed.receive({ id: "opt", from: CLEANER, text: "YES" });
    await timed.receive({ id: "out", from: OWNER, text: "YES" });
    await timed.receive({ id: "yes", from: CLEANER, text: "YES" });
    expect(timed.jobs()[0]?.status).toBe("confirmed");
    clock.at = DUE;
    const reminded = await timed.runReminders();
    expect(reminded.sent).toEqual([{ to: CLEANER, body: CLEANER_REMINDER, kind: "reminder" }]);
    const removed = await timed.readSource(notion("notion-lane-removed.json"), { conversation: "closed" });
    expect(removed.sent).toEqual([{ to: CLEANER, body: CANCEL, kind: "cancel-update" }]);
    expect(removed.jobs[0]).toEqual(expect.objectContaining({ id: "notion:row-anita", status: "canceled", live: false }));
    const after = await timed.runReminders();
    expect(after.sent).toEqual([]);
    expect(timed.outbox().filter((item) => item.kind === "reminder" && item.status === "sent")).toHaveLength(1);
    const repeat = await timed.readSource(notion("notion-lane-removed.json"), { conversation: "closed" });
    expect(repeat.sent).toEqual([]);
  });

  it("keeps one job when Guesty Lite and Notion describe the same stay", async () => {
    const box = sink();
    const job = core(box, { tenantId: "scratch-lane" });
    await job.pollFeed(feed("guesty-lite-scratch.ics"), { conversation: "closed" });
    const merged = await job.readSource(notion("notion-lane-overlap.json"), { conversation: "closed" });
    expect(merged.sent).toEqual([]);
    expect(merged.conflicts).toEqual([]);
    expect(merged.provenance).toEqual([
      {
        jobId: "stay-anita@guesty.com",
        sources: [
          { kind: "guesty-lite", uid: "stay-anita@guesty.com" },
          { kind: "notion", uid: "notion:row-anita" },
        ],
      },
      { jobId: "stay-same-day@guesty.com", sources: [{ kind: "guesty-lite", uid: "stay-same-day@guesty.com" }] },
      { jobId: "stay-after-gap@guesty.com", sources: [{ kind: "guesty-lite", uid: "stay-after-gap@guesty.com" }] },
    ]);
    expect(job.jobs().map((item) => item.id)).toEqual([
      "stay-anita@guesty.com",
      "stay-same-day@guesty.com",
      "stay-after-gap@guesty.com",
    ]);
    expect(job.jobs().some((item) => item.id.startsWith("notion:"))).toBe(false);
    expect(box.sent).toEqual([{ to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" }]);
  });

  it("activates a new tenant only after the cleaner opts in and the owner approves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-onboard-"));
    const lock = readFileSync("src/cleaner-core/fixtures/annex-lock.txt", "utf8").trim();
    try {
      const box = sink();
      const draft = openCleanerCore({
        enabled: true,
        tenantId: "onboarding-draft",
        property: { id: "onboarding-draft", address: "Scratch setup", timeZone: "America/New_York" },
        ownerPhone: ANNEX_HOST,
        cleaner: { phone: ANNEX_CLEANER, approved: true },
        consented: false,
        isolate: true,
        sink: box,
        now: () => new Date(NOW),
        dataDir: dir,
      });
      draft.beginOnboarding();
      draft.attachPreview("notion", feed("notion-annex.json"));
      await draft.answerOnboarding({ id: "p", from: ANNEX_HOST, text: `Annex | ${ANNEX} | America/New_York | 11:00 AM | 4:00 PM | ${ANNEX_HOST}` });
      await draft.answerOnboarding({ id: "s", from: ANNEX_HOST, text: "Guesty Lite and Notion. Yes, early check-ins and late checkouts are agreed on Airbnb, outside that calendar." });
      const preview = await draft.answerOnboarding({ id: "ok", from: ANNEX_HOST, text: "OK" });
      expect(preview.setup.prompt).toBe("Who should get texts? Send the cleaner's phone, then each other person's role and phone. Roles are owner, manager, or observer. I won't text anyone until they reply YES.");
      expect(preview.setup.prompts.some((line) => line.startsWith("Preview for Annex: 1 stay, 1 block."))).toBe(true);
      await draft.answerOnboarding({ id: "people", from: ANNEX_HOST, text: `Cleaner ${ANNEX_CLEANER}. Observer Cory ${OBSERVER}.` });
      await draft.answerOnboarding({ id: "c-yes", from: ANNEX_CLEANER, text: "YES" });
      await draft.answerOnboarding({ id: "o-yes", from: OBSERVER, text: "YES" });
      await draft.answerOnboarding({ id: "sched", from: ANNEX_HOST, text: "Morning of checkout, and after you say the guests have left. Quiet hours 9:00 PM to 8:00 AM. Escalate to the host." });
      await draft.answerOnboarding({ id: "pin", from: ANNEX_HOST, text: lock });
      await draft.answerOnboarding({ id: "opt", from: ANNEX_HOST, text: "SKIP" });
      const approved = await draft.answerOnboarding({ id: "go", from: ANNEX_HOST, text: "APPROVE" });
      const again = await draft.answerOnboarding({ id: "go-2", from: ANNEX_HOST, text: "APPROVE" });
      expect(approved.setup.activated).toBe(true);
      expect(approved.setup.tenantId).toBe("annex");
      expect(approved.setup.prompt).toBe("Activated Annex. I will text only the numbers that opted in. I will not infer consent, a vacancy, or a lock-code change.");
      expect(again.setup.activated).toBe(true);
      expect(box.sent).toEqual([
        { to: ANNEX_CLEANER, body: OPT_ANNEX, kind: "opt-in" },
        { to: OBSERVER, body: OPT_ANNEX, kind: "opt-in" },
      ]);
      const stored = readFileSync(join(dir, "cleaner-core.json"), "utf8");
      expect(stored.includes(lock.match(/\d{4,8}/)?.[0] ?? "no-code")).toBe(false);
      expect(stored.includes("+15555550100")).toBe(false);
      expect(stored.includes("12 Scratch Lane")).toBe(false);
      const annex = openCleanerCore({
        enabled: true,
        tenantId: "annex",
        property: { id: "prop_annex", address: ANNEX, timeZone: "America/New_York" },
        ownerPhone: ANNEX_HOST,
        cleaner: { phone: ANNEX_CLEANER, approved: true },
        access: fixedCodePort(lock.match(/\d{4,8}/)?.[0]),
        consented: true,
        sink: sink(),
        dataDir: dir,
      });
      expect(annex.jobs()).toEqual([]);
      const crossed = await annex.receive({ id: "lane", from: OWNER, text: "YES" });
      expect(crossed).toEqual({ handled: true, reason: "wrong-tenant", sent: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not activate or send a cleaning text when the cleaner has not opted in", async () => {
    const box = sink();
    const draft = openCleanerCore({
      enabled: true,
      tenantId: "onboarding-draft",
      property: { id: "onboarding-draft", address: "Scratch setup", timeZone: "America/New_York" },
      ownerPhone: ANNEX_HOST,
      cleaner: { phone: ANNEX_CLEANER, approved: true },
      consented: false,
      isolate: true,
      sink: box,
      now: () => new Date(NOW),
    });
    draft.beginOnboarding();
    draft.attachPreview("notion", feed("notion-annex.json"));
    await draft.answerOnboarding({ id: "p", from: ANNEX_HOST, text: `Annex | ${ANNEX} | America/New_York | 11:00 AM | 4:00 PM | ${ANNEX_HOST}` });
    await draft.answerOnboarding({ id: "s", from: ANNEX_HOST, text: "Notion. Yes, late checkouts are agreed on Airbnb, outside that calendar." });
    await draft.answerOnboarding({ id: "ok", from: ANNEX_HOST, text: "OK" });
    await draft.answerOnboarding({ id: "people", from: ANNEX_HOST, text: `Cleaner ${ANNEX_CLEANER}. Observer Cory ${OBSERVER}.` });
    await draft.answerOnboarding({ id: "sched", from: ANNEX_HOST, text: "Morning of checkout. Quiet hours 9:00 PM to 8:00 AM. Escalate to the host." });
    await draft.answerOnboarding({ id: "pin", from: ANNEX_HOST, text: readFileSync("src/cleaner-core/fixtures/annex-lock.txt", "utf8").trim() });
    await draft.answerOnboarding({ id: "opt", from: ANNEX_HOST, text: "SKIP" });
    const refused = await draft.answerOnboarding({ id: "go", from: ANNEX_HOST, text: "APPROVE" });
    expect(refused.setup.activated).toBe(false);
    expect(refused.setup.prompt).toBe("Not activated. The cleaner has not opted in, so I did not send a cleaning text.");
    expect(box.sent.map((text) => text.kind)).toEqual(["opt-in", "opt-in"]);
    expect(box.sent.some((text) => text.kind === "offer" || text.kind === "pin" || text.kind === "reminder" || text.kind === "host-checkout")).toBe(false);
  });

  it("refuses a second Airbnb feed when Guesty Lite is already named", async () => {
    const draft = openCleanerCore({
      enabled: true,
      tenantId: "onboarding-draft",
      property: { id: "onboarding-draft", address: "Scratch setup", timeZone: "America/New_York" },
      ownerPhone: ANNEX_HOST,
      cleaner: { phone: ANNEX_CLEANER, approved: true },
      consented: false,
      isolate: true,
      sink: sink(),
      now: () => new Date(NOW),
    });
    draft.beginOnboarding();
    await draft.answerOnboarding({ id: "p", from: ANNEX_HOST, text: `Annex | ${ANNEX} | America/New_York | 11:00 AM | 4:00 PM | ${ANNEX_HOST}` });
    const dup = await draft.answerOnboarding({ id: "s", from: ANNEX_HOST, text: "Guesty Lite and a separate Airbnb feed." });
    expect(dup.setup.step).toBe("sources");
    expect(dup.setup.prompt).toBe("Guesty Lite already includes Airbnb and Vrbo stays. I did not add a second feed. Name the sources again, without a separate Airbnb or Vrbo feed.");
  });

  it("holds a reminder during quiet hours and sends it once the window ends", async () => {
    const box = sink();
    const clock = { at: "2026-10-18T02:00:00.000Z" };
    const job = openCleanerCore({
      enabled: true,
      tenantId: "scratch-lane",
      property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
      ownerPhone: OWNER,
      cleaner: { phone: CLEANER, approved: true },
      access: fixedCodePort(PIN),
      hostName: "Scratch",
      consented: true,
      sink: box,
      now: () => new Date(clock.at),
      quietHours: { from: "21:00", until: "08:00" },
    });
    await job.readSource(notion("notion-lane-read.json"));
    await job.receive({ id: "opt", from: CLEANER, text: "YES" });
    await job.receive({ id: "out", from: OWNER, text: "YES" });
    await job.receive({ id: "yes", from: CLEANER, text: "YES" });
    const held = await job.runReminders();
    expect(held.sent).toEqual([]);
    clock.at = DUE;
    const sent = await job.runReminders();
    expect(sent.sent).toEqual([{ to: CLEANER, body: CLEANER_REMINDER, kind: "reminder" }]);
    const twice = await job.runReminders();
    expect(twice.sent).toEqual([]);
  });

  it("uses a native group only when every participant has opted in", async () => {
    const box = sink();
    const job = pinned(box, {
      messaging: {
        requested: "group",
        capable: true,
        participants: [{ phone: OBSERVER, role: "observer" }],
      },
    });
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    await job.receive({ id: "c", from: CLEANER, text: "YES" });
    await job.receive({ id: "o", from: OBSERVER, text: "YES" });
    await job.receive({ id: "out", from: OWNER, text: "YES" });
    await job.receive({ id: "in", from: OWNER, text: "YES" });
    const offer = `Turnover at ${ADDRESS} on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.`;
    const copy = offer.replace("Reply YES to schedule it, or STOP to opt out.", "The cleaner will reply to confirm.");
    expect(box.sent.filter((text) => text.kind === "offer")).toEqual([
      { to: CLEANER, body: offer, kind: "offer" },
      { to: OWNER, body: `${GROUP}${copy}`, kind: "offer", channel: "group" },
      { to: OBSERVER, body: `${GROUP}${copy}`, kind: "offer", channel: "group" },
    ]);
    expect(job.messagingView()).toEqual({ requested: "group", actual: "native", excluded: [], note: "This is a group text." });
  });

  it("mirrors cleaner texts when group texting is not available", async () => {
    const box = sink();
    const job = pinned(box, {
      messaging: {
        requested: "group",
        capable: false,
        participants: [{ phone: OBSERVER, role: "observer" }],
      },
    });
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    await job.receive({ id: "c", from: CLEANER, text: "YES" });
    await job.receive({ id: "o", from: OBSERVER, text: "YES" });
    await job.receive({ id: "out", from: OWNER, text: "YES" });
    await job.receive({ id: "in", from: OWNER, text: "YES" });
    const offer = `Turnover at ${ADDRESS} on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.`;
    const copy = offer.replace("Reply YES to schedule it, or STOP to opt out.", "The cleaner will reply to confirm.");
    expect(box.sent.filter((text) => text.kind === "offer")).toEqual([
      { to: CLEANER, body: offer, kind: "offer" },
      { to: OWNER, body: `${MIRROR}${copy}`, kind: "offer", channel: "mirror" },
      { to: OBSERVER, body: `${MIRROR}${copy}`, kind: "offer", channel: "mirror" },
    ]);
    expect(job.messagingView()?.actual).toBe("mirrored");
    expect(job.messagingView()?.note).toBe("Group texting isn't available on this number, so I mirrored the cleaner texts instead of starting a group.");
  });

  it("leaves a participant out until that number opts in", async () => {
    const box = sink();
    const job = pinned(box, {
      messaging: {
        requested: "group",
        capable: true,
        participants: [{ phone: OBSERVER, role: "observer" }],
      },
    });
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    await job.receive({ id: "c", from: CLEANER, text: "YES" });
    await job.receive({ id: "out", from: OWNER, text: "YES" });
    await job.receive({ id: "in", from: OWNER, text: "YES" });
    expect(box.sent.filter((text) => text.to === OBSERVER).map((text) => text.kind)).toEqual(["opt-in"]);
    expect(box.sent.some((text) => text.kind === "offer" && text.to === OBSERVER)).toBe(false);
    expect(job.messagingView()).toEqual({
      requested: "group",
      actual: "mirrored",
      excluded: [OBSERVER],
      note: `I left ${OBSERVER} out because that number has not opted in.`,
    });
    const stopped = await job.receive({ id: "stop-o", from: OBSERVER, text: "STOP" });
    expect(stopped.sent).toEqual([{ to: OBSERVER, body: STOP_ACK, kind: "stop" }]);
    const help = await job.receive({ id: "help-o", from: OBSERVER, text: "HELP" });
    expect(help).toEqual({ handled: true, reason: "ignored", sent: [] });
    expect(job.messagingView()?.excluded).toEqual([OBSERVER]);
  });

  it("sends the door code only to the approved cleaner, never to the group, the observer, or a mirror", async () => {
    const box = sink();
    const job = pinned(box, {
      groupPhones: [UNAPPROVED],
      messaging: {
        requested: "group",
        capable: true,
        participants: [{ phone: OBSERVER, role: "observer" }],
      },
    });
    await job.pollFeed(feed("guesty-lite-scratch.ics"));
    await job.receive({ id: "c", from: CLEANER, text: "YES" });
    await job.receive({ id: "o", from: OBSERVER, text: "YES" });
    await job.receive({ id: "out", from: OWNER, text: "YES" });
    await job.receive({ id: "in", from: OWNER, text: "YES" });
    await job.receive({ id: "offer", from: CLEANER, text: "YES" });
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    expect(box.sent.filter((text) => text.kind === "pin")).toEqual([{ to: CLEANER, body: PIN_TEXT, kind: "pin" }]);
    expect(box.sent.filter((text) => text.to === UNAPPROVED)).toEqual([]);
    const shared = box.sent.filter((text) => text.channel === "group" || text.channel === "mirror" || text.to === OBSERVER);
    expect(shared.some((text) => text.body.includes(PIN) || text.kind === "pin")).toBe(false);
    expect(box.sent.find((text) => text.kind === "pin-notice")).toEqual({ to: OWNER, body: PIN_NOTICE, kind: "pin-notice" });
  });

  it("keeps Notion bookings and an onboarded tenant apart in one folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-f-iso-"));
    const court = scratchTenant("scratch-court");
    if (!court) throw new Error("Scratch Court is missing.");
    try {
      const lane = core(sink(), { tenantId: "scratch-lane", dataDir: dir });
      const courtCore = openCleanerCore({
        enabled: true,
        tenantId: "scratch-court",
        property: court.property,
        ownerPhone: court.ownerPhone,
        cleaner: { phone: court.cleanerPhone, approved: true },
        consented: true,
        sink: sink(),
        now: () => new Date(NOW),
        dataDir: dir,
      });
      await lane.readSource(notion("notion-lane-read.json"), { conversation: "closed" });
      await courtCore.readSource(notion("notion-court-stay.json"), { conversation: "closed" });
      const draft = openCleanerCore({
        enabled: true,
        tenantId: "onboarding-draft",
        property: { id: "onboarding-draft", address: "Scratch setup", timeZone: "America/New_York" },
        ownerPhone: ANNEX_HOST,
        cleaner: { phone: ANNEX_CLEANER, approved: true },
        consented: false,
        isolate: true,
        sink: sink(),
        now: () => new Date(NOW),
        dataDir: dir,
      });
      const ignored = await draft.answerOnboarding({ id: "lane-yes", from: OWNER, text: "YES" });
      expect(ignored).toEqual(expect.objectContaining({ reason: "wrong-tenant", sent: [] }));
      expect(lane.jobs().map((item) => item.id)).toEqual(["notion:row-anita"]);
      expect(courtCore.jobs().map((item) => item.id)).toEqual(["notion:row-court"]);
      expect(lane.outbox().every((item) => item.to === OWNER)).toBe(true);
      expect(courtCore.outbox().every((item) => item.to === court.ownerPhone)).toBe(true);
      const stored = readFileSync(join(dir, "cleaner-core.json"), "utf8");
      expect(stored.includes("4821")).toBe(false);
      expect(stored.includes("7392")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends each source's offer, confirmation, reminder, and cancel only to the opted-in cleaner", async () => {
    const MANAGER = "+15555550123";
    const YES_LINE = "Reply YES to schedule it, or STOP to opt out.";
    const WAIT_LINE = "The cleaner will reply to confirm.";
    const SOLO_OFFER = `Turnover at ${ADDRESS} on Sunday, Oct 18. Checkout 11:00 AM. ${YES_LINE}`;
    const googleGone = JSON.stringify({ tenantId: "scratch-lane", timeZone: "America/New_York", items: [] });
    const sources = [
      {
        name: "guesty",
        offer: OFFER,
        nextGuest: true,
        read: async (job: ReturnType<typeof pinned>, removed = false) => {
          await job.pollFeed(feed(removed ? "guesty-lite-stay-removed.ics" : "guesty-lite-scratch.ics"));
        },
      },
      {
        name: "google",
        offer: SOLO_OFFER,
        nextGuest: false,
        read: async (job: ReturnType<typeof pinned>, removed = false) => {
          await job.readSource(googleCalendarFixtureSource(removed ? googleGone : feed("google-lane-read.json")));
        },
      },
      {
        name: "notion",
        offer: SOLO_OFFER,
        nextGuest: false,
        read: async (job: ReturnType<typeof pinned>, removed = false) => {
          await job.readSource(notion(removed ? "notion-lane-removed.json" : "notion-lane-read.json"));
        },
      },
    ] as const;
    const modes = ["direct", "native", "mirrored"] as const;
    for (const source of sources) {
      for (const mode of modes) {
        const box = sink();
        const clock = { at: NOW };
        const job = pinned(box, {
          tenantId: "scratch-lane",
          now: () => new Date(clock.at),
          ...(mode === "direct"
            ? {}
            : {
                messaging: {
                  requested: "group" as const,
                  capable: mode === "native",
                  participants: [
                    { phone: OBSERVER, role: "observer" as const },
                    { phone: MANAGER, role: "manager" as const },
                  ],
                },
              }),
        });
        await source.read(job);
        await job.receive({ id: `${source.name}-${mode}-opt`, from: CLEANER, text: "YES" });
        if (mode !== "direct") {
          await job.receive({ id: `${source.name}-${mode}-obs`, from: OBSERVER, text: "YES" });
          await job.receive({ id: `${source.name}-${mode}-mgr`, from: MANAGER, text: "YES" });
        }
        await job.receive({ id: `${source.name}-${mode}-out`, from: OWNER, text: "YES" });
        if (source.nextGuest) await job.receive({ id: `${source.name}-${mode}-in`, from: OWNER, text: "YES" });
        const copy = source.offer.replace(YES_LINE, WAIT_LINE);
        const prefix = mode === "native" ? GROUP : "Copy of the group text: ";
        const offers = mode === "direct"
          ? [{ to: CLEANER, body: source.offer, kind: "offer" as const }]
          : [
              { to: CLEANER, body: source.offer, kind: "offer" as const },
              { to: OWNER, body: `${prefix}${copy}`, kind: "offer" as const, channel: mode === "native" ? "group" as const : "mirror" as const },
              { to: OBSERVER, body: `${prefix}${copy}`, kind: "offer" as const, channel: mode === "native" ? "group" as const : "mirror" as const },
              { to: MANAGER, body: `${prefix}${copy}`, kind: "offer" as const, channel: mode === "native" ? "group" as const : "mirror" as const },
            ];
        expect(box.sent.filter((text) => text.kind === "offer"), `${source.name} ${mode} offer`).toEqual(offers);
        expect(await job.receive({ id: `${source.name}-${mode}-host`, from: OWNER, text: "YES" }), `${source.name} ${mode} host`).toEqual({
          handled: true,
          reason: "ignored",
          sent: [],
        });
        if (mode !== "direct") {
          expect(await job.receive({ id: `${source.name}-${mode}-obs-yes`, from: OBSERVER, text: "YES" }), `${source.name} ${mode} observer`).toEqual({
            handled: true,
            reason: "ignored",
            sent: [],
          });
        }
        expect(job.jobs()[0]?.status, `${source.name} ${mode} still offered`).toBe("offered");
        expect(await job.receive({ id: `${source.name}-${mode}-book`, from: CLEANER, text: "YES" }), `${source.name} ${mode} book`).toEqual({
          handled: true,
          reason: "scheduled",
          sent: [{ to: CLEANER, body: CONFIRM, kind: "confirm" }],
        });
        expect(box.sent.filter((text) => text.kind === "confirm"), `${source.name} ${mode} confirm`).toEqual([
          { to: CLEANER, body: CONFIRM, kind: "confirm" },
        ]);
        clock.at = DUE;
        expect(await job.runReminders(), `${source.name} ${mode} reminder`).toEqual({
          sent: [{ to: CLEANER, body: CLEANER_REMINDER, kind: "reminder" }],
          failed: [],
        });
        expect(await job.runReminders(), `${source.name} ${mode} reminder again`).toEqual({ sent: [], failed: [] });
        await source.read(job, true);
        expect(box.sent.filter((text) => text.kind === "cancel-update"), `${source.name} ${mode} cancel`).toEqual([
          { to: CLEANER, body: CANCEL, kind: "cancel-update" },
        ]);
        await source.read(job, true);
        expect(box.sent.filter((text) => text.kind === "cancel-update"), `${source.name} ${mode} cancel again`).toEqual([
          { to: CLEANER, body: CANCEL, kind: "cancel-update" },
        ]);
      }
    }
    const held = sink();
    const waiting = core(held, {
      tenantId: "scratch-lane",
      messaging: { requested: "group", capable: true, participants: [{ phone: OBSERVER, role: "observer" }] },
    });
    await waiting.pollFeed(feed("guesty-lite-scratch.ics"));
    await waiting.receive({ id: "held-out", from: OWNER, text: "YES" });
    await waiting.receive({ id: "held-in", from: OWNER, text: "YES" });
    await waiting.receive({ id: "held-again", from: OWNER, text: "YES" });
    expect(waiting.jobs()[0]?.status).toBe("host_confirmed");
    expect(held.sent).toEqual([
      { to: OWNER, body: CHECKOUT_Q, kind: "host-checkout" },
      { to: OBSERVER, body: OPT_IN, kind: "opt-in" },
      { to: OWNER, body: CHECKIN_Q, kind: "host-checkin" },
      { to: OWNER, body: HOLD, kind: "held" },
    ]);
    await waiting.pollFeed(feed("guesty-lite-stay-removed.ics"));
    expect(held.sent.filter((text) => text.kind === "cancel-update")).toEqual([
      { to: OWNER, body: CANCEL, kind: "cancel-update" },
    ]);
    expect(held.sent.some((text) => text.kind === "offer" || text.kind === "confirm")).toBe(false);
  });

  it("answers an injury from the owner, the cleaner, and an observer in and out of a group", async () => {
    const MANAGER = "+15555550123";
    const HURT = "I fell and I'm hurt";
    const HOST_LINE = "If someone is hurt, call 911 now.";
    const TOLD = "If someone is hurt, call 911 now. I've let the host know.";
    const MISSED = "If someone is hurt, call 911 now. I couldn't reach the host, so please call them too.";
    const alertFor = (role: "cleaner" | "observer" | "manager") => {
      if (role === "cleaner") return `The cleaner at ${ADDRESS} says someone is hurt. They've been told to call 911.`;
      if (role === "observer") return `An observer at ${ADDRESS} says someone is hurt. They've been told to call 911.`;
      return `A manager at ${ADDRESS} says someone is hurt. They've been told to call 911.`;
    };
    const people = [
      { role: "owner" as const, phone: OWNER },
      { role: "cleaner" as const, phone: CLEANER },
      { role: "observer" as const, phone: OBSERVER },
      { role: "manager" as const, phone: MANAGER },
    ];
    for (const grouped of [false, true]) {
      for (const person of people) {
        const box = sink();
        const job = pinned(box, {
          tenantId: "scratch-lane",
          messaging: {
            requested: grouped ? "group" : "cleaner-only",
            capable: grouped,
            participants: [
              { phone: OBSERVER, role: "observer" },
              { phone: MANAGER, role: "manager" },
            ],
          },
        });
        await job.pollFeed(feed("guesty-lite-scratch.ics"));
        if (grouped) {
          await job.receive({ id: `${person.role}-c`, from: CLEANER, text: "YES" });
          await job.receive({ id: `${person.role}-o`, from: OBSERVER, text: "YES" });
          await job.receive({ id: `${person.role}-m`, from: MANAGER, text: "YES" });
        }
        const first = await job.receive({ id: `${person.role}-${grouped}-1`, from: person.phone, text: HURT });
        const again = await job.receive({ id: `${person.role}-${grouped}-2`, from: person.phone, text: HURT });
        expect(again, `${person.role} ${grouped ? "group" : "solo"} repeat`).toEqual({ handled: true, reason: "emergency", sent: [] });
        if (person.role === "owner") {
          expect(first, `${person.role} ${grouped ? "group" : "solo"}`).toEqual({
            handled: true,
            reason: "emergency",
            sent: [{ to: OWNER, body: HOST_LINE, kind: "emergency" }],
          });
          expect(box.sent.filter((text) => text.kind === "emergency")).toEqual([
            { to: OWNER, body: HOST_LINE, kind: "emergency" },
          ]);
        } else {
          expect(first, `${person.role} ${grouped ? "group" : "solo"}`).toEqual({
            handled: true,
            reason: "emergency",
            sent: [
              { to: OWNER, body: alertFor(person.role), kind: "emergency" },
              { to: OWNER, body: INJURY_HOLD, kind: "emergency" },
              { to: person.phone, body: TOLD, kind: "emergency" },
            ],
          });
        }
      }
    }
    const failing = sink();
    let failNext = false;
    const missed = pinned(failing, {
      tenantId: "scratch-lane",
      sink: {
        send(text: CleanerText) {
          if (failNext) {
            failNext = false;
            throw new Error("send failed");
          }
          failing.sent.push(text);
        },
      },
      messaging: {
        requested: "cleaner-only",
        capable: false,
        participants: [{ phone: OBSERVER, role: "observer" }],
      },
    });
    await missed.pollFeed(feed("guesty-lite-scratch.ics"));
    failNext = true;
    const failed = await missed.receive({ id: "obs-miss", from: OBSERVER, text: HURT });
    expect(failed).toEqual({
      handled: true,
      reason: "emergency",
      sent: [
        { to: OWNER, body: INJURY_HOLD, kind: "emergency" },
        { to: OBSERVER, body: MISSED, kind: "emergency" },
      ],
    });
    expect(missed.outbox().filter((item) => item.kind === "emergency").map((item) => ({
      to: item.to,
      body: item.body,
      kind: item.kind,
      status: item.status,
    }))).toEqual([
      {
        to: OWNER,
        body: `An observer at ${ADDRESS} says someone is hurt. They've been told to call 911.`,
        kind: "emergency",
        status: "failed",
      },
      { to: OWNER, body: INJURY_HOLD, kind: "emergency", status: "sent" },
      { to: OBSERVER, body: MISSED, kind: "emergency", status: "sent" },
    ]);
  });

  it("treats hurt, injury, blood, and fall wordings as an injury from the cleaner and the observer", async () => {
    const told = "If someone is hurt, call 911 now. I've let the host know.";
    const phrases = [
      "she's hurt",
      "Cleaner fell down the stairs, she's hurt",
      "there's blood everywhere",
      "someone got hurt",
      "I'm injured",
      "she fell and can't get up",
      "I fell and I'm hurt",
    ];
    const senders = [
      {
        name: "cleaner",
        phone: CLEANER,
        alert: `The cleaner at ${ADDRESS} says someone is hurt. They've been told to call 911.`,
      },
      {
        name: "observer",
        phone: OBSERVER,
        alert: `An observer at ${ADDRESS} says someone is hurt. They've been told to call 911.`,
      },
    ] as const;
    let n = 0;
    for (const phrase of phrases) {
      for (const sender of senders) {
        for (const grouped of [false, true]) {
          const mode = grouped ? "group" : "one-to-one";
          const box = sink();
          const job = pinned(box, {
            tenantId: "scratch-lane",
            messaging: {
              requested: grouped ? "group" : "cleaner-only",
              capable: grouped,
              participants: [{ phone: OBSERVER, role: "observer" }],
            },
          });
          await job.pollFeed(feed("guesty-lite-scratch.ics"));
          if (grouped) {
            await job.receive({ id: `word-opt-c-${n}`, from: CLEANER, text: "YES" });
            await job.receive({ id: `word-opt-o-${n}`, from: OBSERVER, text: "YES" });
          }
          const first = await job.receive({ id: `word-${n}`, from: sender.phone, text: phrase });
          const again = await job.receive({ id: `word-${n}-again`, from: sender.phone, text: phrase });
          n += 1;
          expect(first, `${sender.name} ${mode}: ${phrase}`).toEqual({
            handled: true,
            reason: "emergency",
            sent: [
              { to: OWNER, body: sender.alert, kind: "emergency" },
              { to: OWNER, body: INJURY_HOLD, kind: "emergency" },
              { to: sender.phone, body: told, kind: "emergency" },
            ],
          });
          expect(again, `${sender.name} ${mode} repeat: ${phrase}`).toEqual({
            handled: true,
            reason: "emergency",
            sent: [],
          });
          expect(box.sent.filter((text) => text.kind === "emergency"), `${sender.name} ${mode} outbox: ${phrase}`).toEqual([
            { to: OWNER, body: sender.alert, kind: "emergency" },
            { to: OWNER, body: INJURY_HOLD, kind: "emergency" },
            { to: sender.phone, body: told, kind: "emergency" },
          ]);
        }
      }
    }
  });
});

function cleanerCli(args: string[], flag: "1" | undefined): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  if (flag) env.CLEANER_CORE_ENABLED = flag;
  else delete env.CLEANER_CORE_ENABLED;
  const result = spawnSync("node_modules/.bin/tsx", ["src/cleaner-core/cli.ts", ...args], {
    encoding: "utf8",
    env,
    cwd: process.cwd(),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
