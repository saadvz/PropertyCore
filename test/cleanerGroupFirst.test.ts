import { fixedCodePort } from "../src/cleaner-core/doorPort";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostDoneLine, groupIntroBody, groupInviteBody, groupUnconfirmedLine, namedAsk, nameList, withoutStopAsk } from "../src/cleaner-core/cleanerTexts";
import { GroupNotConfirmed } from "../src/cleaner-core/groupThread";
import { openCleanerCore, type CleanerText } from "../src/cleaner-core/core";
import { outboxLabel } from "../src/cleaner-core/scratchQa";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";
import { setCleanerGroupFetch } from "../src/cleaner-core/liveSms";
import { twilioSignature } from "../src/messaging/twilio/signature";
import { fakeConversations } from "./fakeConversations";
import { PUBLIC } from "./fakeSendblue";
import { ADDRESS, BUSINESS, CALENDAR_URL, CLEANER, CLEANER_AUTH, CLEANER_LINE, CLEANER_TOKEN, DOOR_CODE, HOST, startWiredApp, type WiredApp } from "./wiringProof";

describe("group-first: copy", () => {
  it("builds the group invite", () => {
    expect(groupInviteBody("Saad", "145 Tenafly Road")).toBe(
      "Saad wants to set up a group chat with you for cleaner services at 145 Tenafly Road. Reply YES to join, or STOP to opt out.",
    );
  });

  it("joins names as A and B, or A, B and C", () => {
    expect(nameList(["Saad", "Mike"])).toBe("Saad and Mike");
    expect(nameList(["Saad", "Mike", "Ana"])).toBe("Saad, Mike and Ana");
    expect(nameList(["Saad"])).toBe("Saad");
  });

  it("builds the group intro", () => {
    expect(groupIntroBody(["Saad", "Mike"], "Saad", "145 Tenafly Road")).toBe(
      "Hi Saad and Mike! This is the cleaning group for 145 Tenafly Road. I'm Saad's cleaning assistant, and I'll post cleaning times and updates here. Reply STOP anytime to leave.",
    );
  });

  it("drops the extra s after a landlord name that ends in s", () => {
    expect(groupIntroBody(["Harbor Rentals", "Mike"], "Harbor Rentals", "145 Tenafly Road")).toContain("I'm Harbor Rentals' cleaning assistant,");
    expect(groupIntroBody(["Saad", "Mike"], "Saad", "145 Tenafly Road")).toContain("I'm Saad's cleaning assistant,");
  });

  it("names the cleaner in a Reply ask", () => {
    expect(
      namedAsk("Mike", "Update: checkout at X moved to Sunday at 10:00 AM. Reply YES to keep the cleaning, or STOP to opt out."),
    ).toBe("Update: checkout at X moved to Sunday at 10:00 AM. Mike, reply YES to keep the cleaning, or STOP to opt out.");
  });

  it("names the cleaner before a closing question", () => {
    expect(namedAsk("Mike", "Reminder: cleaning at X on Sunday. Checkout is 11:00 AM. What time do you plan to arrive?")).toBe(
      "Reminder: cleaning at X on Sunday. Checkout is 11:00 AM. Mike, what time do you plan to arrive?",
    );
  });

  it("keeps the pronoun I when it starts a closing question", () => {
    expect(namedAsk("Mike", "Checkout is 11:00 AM. I can arrive by 10:30, right?")).toBe(
      "Checkout is 11:00 AM. Mike, I can arrive by 10:30, right?",
    );
  });

  it("leaves a body without an ask unchanged", () => {
    expect(namedAsk("Mike", "Thanks, cleaning marked done.")).toBe("Thanks, cleaning marked done.");
  });

  it("keeps the host note at the end, untouched", () => {
    const body = "Turnover at 145 Tenafly Road on Sunday. Reply YES to schedule it, or STOP to opt out. Note from the host: Reply STOP to skip the lamp.";
    expect(namedAsk("Mike", body)).toBe(
      "Turnover at 145 Tenafly Road on Sunday. Mike, reply YES to schedule it, or STOP to opt out. Note from the host: Reply STOP to skip the lamp.",
    );
  });

  it("keeps the door code and the ready wording out of the copy", () => {
    const copy = [
      groupInviteBody("Saad", "145 Tenafly Road"),
      groupIntroBody(["Saad", "Mike", "Ana"], "Saad", "145 Tenafly Road"),
      namedAsk("Mike", "Reminder: cleaning at X on Sunday. What time do you plan to arrive?"),
    ];
    for (const text of copy) {
      expect(text).not.toContain("door code");
      expect(text).not.toContain("ready");
    }
  });
});

describe("group-first: invites", () => {
  const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
  const LANE = "12 Scratch Lane, Teaneck, NJ 07666";
  const OWNER = "+15555550100";
  const MIKE = "+15555550101";
  const ANA = "+15555550122";
  const PIN = SCRATCH_TENANTS[0]!.pin;

  function engine(sent: CleanerText[], extra: Partial<Parameters<typeof openCleanerCore>[0]> = {}) {
    return openCleanerCore({
      enabled: true,
      property: { id: "prop_12_scratch_lane", address: LANE, timeZone: "America/New_York" },
      ownerPhone: OWNER,
      cleaner: { phone: MIKE, approved: true },
      access: fixedCodePort(PIN),
      hostName: "Scratch",
      consented: true,
      sink: { send: async (text) => void sent.push(text) },
      now: () => new Date("2026-10-14T15:00:00.000Z"),
      groupChat: { hostName: "Saad", cleanerName: "Mike", extra: [{ phone: ANA, name: "Ana" }] },
      ...extra,
    });
  }
  const optIns = (sent: CleanerText[]) => sent.filter((text) => text.kind === "opt-in").map(({ to, kind, body }) => ({ to, kind, body }));

  it("invites the cleaner and each contact, and never the landlord", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent);
    await job.pollFeed(FEED);
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    expect(optIns(sent)).toEqual([
      { to: MIKE, kind: "opt-in", body: groupInviteBody("Saad", LANE) },
      { to: ANA, kind: "opt-in", body: groupInviteBody("Saad", LANE) },
    ]);
    expect(sent.some((text) => text.to === OWNER && text.kind === "opt-in")).toBe(false);
  });

  it("does not re-invite a cleaner who already said yes", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent, { cleanerConsent: "in" });
    await job.pollFeed(FEED);
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    expect(optIns(sent).some((text) => text.to === MIKE)).toBe(false);
  });

  it("test turn texts the owner nothing and keeps the owner seated", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent);
    await job.addTestTurn({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    expect(sent.some((text) => text.to === OWNER)).toBe(false);
    expect(optIns(sent).map((text) => text.to)).toEqual([MIKE]);
    expect(sent.find((text) => text.to === MIKE)?.body).toBe(groupInviteBody("Saad", LANE));
  });
});

describe("group-first: STOP only in the intro", () => {
  it("drops Cleaner Core's STOP ask and keeps the host's note as it is", () => {
    expect(withoutStopAsk("Update: checkout moved to Monday. Mike, reply YES to keep the cleaning, or STOP to opt out.")).toBe(
      "Update: checkout moved to Monday. Mike, reply YES to keep the cleaning.",
    );
    expect(withoutStopAsk("Update: the cleaning on Monday is canceled, so no need to come. Reply STOP to opt out.")).toBe(
      "Update: the cleaning on Monday is canceled, so no need to come.",
    );
    expect(withoutStopAsk("Guests have left. Mike, reply DONE when the cleaning is finished. Note from the host: Reply STOP to skip the lamp.")).toBe(
      "Guests have left. Mike, reply DONE when the cleaning is finished. Note from the host: Reply STOP to skip the lamp.",
    );
  });
});

describe("group-first: intro", () => {
  const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
  const EMPTY = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//scratch//EN\r\nEND:VCALENDAR\r\n";
  const LANE = "12 Scratch Lane, Teaneck, NJ 07666";
  const OWNER = "+15555550100";
  const MIKE = "+15555550101";
  const ANA = "+15555550122";
  const PIN = SCRATCH_TENANTS[0]!.pin;

  function engine(sent: CleanerText[], extra: Partial<Parameters<typeof openCleanerCore>[0]> = {}) {
    return openCleanerCore({
      enabled: true,
      property: { id: "prop_12_scratch_lane", address: LANE, timeZone: "America/New_York" },
      ownerPhone: OWNER,
      cleaner: { phone: MIKE, approved: true },
      access: fixedCodePort(PIN),
      hostName: "Scratch",
      consented: true,
      sink: { send: async (text) => void sent.push(text) },
      now: () => new Date("2026-10-14T15:00:00.000Z"),
      groupChat: { hostName: "Saad", cleanerName: "Mike", extra: [{ phone: ANA, name: "Ana" }] },
      ...extra,
    });
  }
  const intros = (sent: CleanerText[]) => sent.filter((text) => text.kind === "intro");
  const yes = (job: ReturnType<typeof engine>, from: string) => job.receive({ id: `yes-${from}`, from, text: "YES" });

  it("posts one intro when Mike joins the seated landlord, with no job booked", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent);
    await job.pollFeed(EMPTY);
    expect(intros(sent)).toEqual([]);
    await yes(job, MIKE);
    expect(intros(sent)).toEqual([
      { to: MIKE, kind: "intro", channel: "group", audience: [OWNER, MIKE], body: groupIntroBody(["Saad", "Mike"], "Saad", LANE) },
    ]);
  });

  it("goes out in one text with the first offer, the intro first", async () => {
    // Two texts sent back to back into a new group can reach each phone in a different order.
    const sent: CleanerText[] = [];
    const job = engine(sent, { groupChat: { hostName: "Saad", cleanerName: "Mike" } });
    await job.pollFeed(FEED);
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await yes(job, MIKE);
    const group = sent.filter((text) => text.channel === "group");
    expect(group.map((text) => text.kind)).toEqual(["offer"]);
    const intro = groupIntroBody(["Saad", "Mike"], "Saad", LANE);
    expect(group[0]?.body).toBe(`${intro}\n\nTurnover at ${LANE} on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Mike, reply YES to schedule it.`);
    // The intro is on record, so it is not posted again.
    const rows = job.outbox().filter((item) => item.kind === "intro");
    expect(rows.map((item) => [item.status, item.body])).toEqual([["sent", intro]]);
    await job.receive({ id: "take-offer", from: MIKE, text: "YES" });
    expect(sent.filter((text) => text.channel === "group").map((text) => text.kind)).toEqual(["offer", "confirm"]);
    expect(sent.filter((text) => text.channel === "group")[1]?.body).not.toContain(intro);
  });

  it("posts a second intro naming all three when Ana joins after Mike", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent);
    await job.pollFeed(EMPTY);
    await yes(job, MIKE);
    await yes(job, ANA);
    expect(intros(sent).map(({ audience, body }) => ({ audience, body }))).toEqual([
      { audience: [OWNER, MIKE], body: groupIntroBody(["Saad", "Mike"], "Saad", LANE) },
      { audience: [OWNER, MIKE, ANA], body: groupIntroBody(["Saad", "Mike", "Ana"], "Saad", LANE) },
    ]);
    expect(intros(sent)[1]?.to).toBe(MIKE);
  });

  it("waits for Mike when Ana says yes first", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent);
    await job.pollFeed(EMPTY);
    await yes(job, ANA);
    expect(intros(sent)).toEqual([]);
    await yes(job, MIKE);
    expect(intros(sent).map(({ audience }) => audience)).toEqual([[OWNER, MIKE, ANA]]);
    expect(intros(sent)[0]?.body).toBe(groupIntroBody(["Saad", "Mike", "Ana"], "Saad", LANE));
  });

  it("sends nothing to the group after Mike says STOP, and Mike gets only the stop text", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent);
    await job.pollFeed(EMPTY);
    await job.receive({ id: "stop-mike", from: MIKE, text: "STOP" });
    expect(sent.filter((text) => text.channel === "group")).toEqual([]);
    expect(intros(sent)).toEqual([]);
    expect(sent.filter((text) => text.to === MIKE && text.kind !== "opt-in").map((text) => text.kind)).toEqual(["stop"]);
    await job.pollFeed(EMPTY);
    expect(sent.filter((text) => text.channel === "group")).toEqual([]);
  });

  it("does not repeat the intro for the same members after a reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-intro-"));
    const sent: CleanerText[] = [];
    const first = engine(sent, { dataDir: dir });
    await first.pollFeed(EMPTY);
    await yes(first, MIKE);
    expect(intros(sent)).toHaveLength(1);
    const again = engine(sent, { dataDir: dir });
    await again.pollFeed(EMPTY);
    expect(intros(sent)).toHaveLength(1);
  });

  it("sends nothing on open when both are already in, then one intro on the first step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-intro-"));
    const sent: CleanerText[] = [];
    const job = engine(sent, { dataDir: dir, cleanerConsent: "in" });
    expect(sent).toEqual([]);
    await job.pollFeed(EMPTY);
    await job.pollFeed(EMPTY);
    expect(intros(sent).map(({ audience }) => audience)).toEqual([[OWNER, MIKE]]);
    const reopened = engine(sent, { dataDir: dir, cleanerConsent: "in" });
    expect(intros(sent)).toHaveLength(1);
    await reopened.receive({ id: "noise", from: MIKE, text: "hello" });
    expect(intros(sent)).toHaveLength(1);
  });

  it("labels the intro in the outbox", () => {
    expect(outboxLabel("intro", "the cleaner")).toBe("Group intro to the cleaner");
  });

  it("still sends the offer and tells the host when the intro fails with a plain error", async () => {
    const sent: CleanerText[] = [];
    let failIntro = true;
    const job = engine(sent, {
      sink: {
        send: async (text) => {
          if (text.kind === "intro" && failIntro) throw new Error("boom");
          sent.push(text);
        },
      },
    });
    // With no job booked yet, the intro goes on its own when Mike joins.
    await job.pollFeed(EMPTY);
    await yes(job, MIKE);
    // The failed intro is kept for review, and it is not posted again.
    expect(job.reviews().filter((item) => item.kind === "failed-sms" && item.status === "open")).toHaveLength(1);
    failIntro = false;
    await job.pollFeed(FEED);
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    expect(sent.some((text) => text.kind === "offer" && text.to === MIKE && !text.body.startsWith("Hi "))).toBe(true);
    expect(intros(sent)).toEqual([]);
  });

  it("retries an intro the group couldn't confirm at the next step", async () => {
    const sent: CleanerText[] = [];
    let confirmed = false;
    const job = engine(sent, {
      sink: {
        send: async (text) => {
          if (text.channel === "group" && !confirmed) throw new GroupNotConfirmed();
          sent.push(text);
        },
      },
    });
    await job.pollFeed(EMPTY);
    await yes(job, MIKE);
    expect(intros(sent)).toEqual([]);
    confirmed = true;
    await job.pollFeed(EMPTY);
    expect(intros(sent)).toHaveLength(1);
  });
});

describe("group-first: routing", () => {
  const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
  const MOVED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-date-moved.ics"), "utf8");
  const LANE = "12 Scratch Lane, Teaneck, NJ 07666";
  const OWNER = "+15555550100";
  const MIKE = "+15555550101";
  const ANA = "+15555550122";
  const PIN = SCRATCH_TENANTS[0]!.pin;
  const DUE = "2026-10-18T12:00:00.000Z";
  const TIMES = { checkout: "11:00 AM", checkIn: "4:00 PM" };

  function engine(sent: CleanerText[], clock: { at: string }, extra: Partial<Parameters<typeof openCleanerCore>[0]> = {}) {
    return openCleanerCore({
      enabled: true,
      property: { id: "prop_12_scratch_lane", address: LANE, timeZone: "America/New_York" },
      ownerPhone: OWNER,
      cleaner: { phone: MIKE, approved: true },
      access: fixedCodePort(PIN),
      hostName: "Scratch",
      consented: true,
      cleanerConsent: "in",
      sink: { send: async (text) => void sent.push(text) },
      now: () => new Date(clock.at),
      groupChat: { hostName: "Saad", cleanerName: "Mike" },
      reminderAsksArrival: true,
      ...extra,
    });
  }
  const say = (job: ReturnType<typeof engine>, id: string, from: string, text: string) => job.receive({ id, from, text });
  const slim = (text: CleanerText) => ({ to: text.to, kind: text.kind, channel: text.channel, audience: text.audience });

  async function fullRun(sent: CleanerText[], extra: Partial<Parameters<typeof openCleanerCore>[0]> = {}) {
    const clock = { at: "2026-10-14T15:00:00.000Z" };
    const job = engine(sent, clock, extra);
    await job.pollFeed(FEED);
    await job.confirmHostTimes(TIMES);
    await say(job, "yes", MIKE, "YES");
    clock.at = DUE;
    await job.runReminders();
    await job.pollFeed(MOVED);
    await job.confirmHostTimes(TIMES);
    await say(job, "yes-again", MIKE, "YES");
    await say(job, "left", OWNER, "guests have left");
    await say(job, "start", MIKE, "START");
    await say(job, "done", MIKE, "DONE");
    return job;
  }

  it("posts the offer, time change, reminder, confirmation, start and done into the group", async () => {
    const sent: CleanerText[] = [];
    await fullRun(sent);
    for (const kind of ["offer", "corrected", "reminder", "confirm", "started", "done"] as const) {
      const texts = sent.filter((text) => text.kind === kind && (kind !== "done" || text.to === MIKE || text.channel === "group"));
      expect(texts.length, kind).toBeGreaterThan(0);
      for (const text of texts) {
        expect(text.channel, `${kind} channel`).toBe("group");
        expect(text.audience, `${kind} audience`).toEqual([OWNER, MIKE]);
      }
    }
    // The group holds only the landlord and Mike, so the door code goes into it.
    const pinTexts = sent.filter((text) => text.kind === "pin");
    expect(pinTexts).toHaveLength(1);
    expect(pinTexts[0]).toMatchObject({ channel: "group", audience: [OWNER, MIKE] });
    expect(sent.filter((text) => text.channel === "group" && text.kind !== "pin").some((text) => text.body.includes(PIN))).toBe(false);
  });

  it("names Mike in the time change and the reminder", async () => {
    const sent: CleanerText[] = [];
    await fullRun(sent);
    expect(sent.find((text) => text.kind === "corrected")?.body).toContain("Mike, reply YES to keep the cleaning");
    expect(sent.find((text) => text.kind === "reminder")?.body.endsWith("Mike, what time do you plan to arrive?")).toBe(true);
  });

  it("posts the intro first, and each text only once", async () => {
    const sent: CleanerText[] = [];
    await fullRun(sent);
    const group = sent.filter((text) => text.channel === "group");
    expect(group[0]?.kind).toBe("intro");
    const bodies = group.map((text) => `${text.kind}|${text.body}`);
    expect(new Set(bodies).size).toBe(bodies.length);
    expect(sent.filter((text) => text.to === MIKE && text.channel === undefined && ["offer", "corrected", "reminder", "confirm", "started"].includes(text.kind))).toEqual([]);
  });

  it("keeps the host's questions out of the group", async () => {
    const sent: CleanerText[] = [];
    await fullRun(sent);
    for (const text of sent.filter((item) => item.channel === "group")) {
      expect(["host-checkout", "host-checkin", "review", "pin-notice", "pin-failed", "pin-held", "resume"]).not.toContain(text.kind);
    }
  });

  it("sends Mike's STOP reply to Mike alone", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent, { at: "2026-10-14T15:00:00.000Z" });
    await job.pollFeed(FEED);
    await job.confirmHostTimes(TIMES);
    const before = sent.length;
    await say(job, "stop", MIKE, "STOP");
    const after = sent.slice(before);
    expect(after.filter((text) => text.channel === "group")).toEqual([]);
    expect(after.filter((text) => text.kind === "stop").map(slim)).toEqual([{ to: MIKE, kind: "stop", channel: undefined, audience: undefined }]);
  });

  it("sends the HELP reply to Mike alone", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent, { at: "2026-10-14T15:00:00.000Z" });
    await job.pollFeed(FEED);
    const before = sent.length;
    await say(job, "help", MIKE, "HELP");
    const after = sent.slice(before);
    expect(after.filter((text) => text.channel === "group")).toEqual([]);
    for (const text of after.filter((item) => item.kind === "help")) expect(text.channel).toBeUndefined();
  });

  it("posts the 911 line to the group when Mike reports an injury", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent, { at: "2026-10-14T15:00:00.000Z" });
    await job.pollFeed(FEED);
    const before = sent.length;
    await say(job, "hurt", MIKE, "someone got hurt, I need an ambulance");
    const emergencies = sent.slice(before).filter((text) => text.kind === "emergency");
    expect(emergencies.length).toBeGreaterThan(0);
    expect(emergencies.some((text) => text.body.includes("911"))).toBe(true);
    for (const text of emergencies.filter((item) => item.body.includes("911"))) {
      expect(text.channel).toBe("group");
      expect(text.audience).toEqual([OWNER, MIKE]);
    }
    expect(emergencies.filter((text) => text.channel === "group").some((text) => text.body.includes("Grok Bot"))).toBe(false);
    expect(emergencies.filter((text) => text.body.includes("Grok Bot")).every((text) => text.to === OWNER && text.channel === undefined)).toBe(true);
  });

  it("falls back to Mike one-to-one when the group can't be confirmed, with a note for the host", async () => {
    const sent: CleanerText[] = [];
    const job = await fullRun(sent, {
      sink: {
        send: async (text) => {
          if (text.channel === "group") throw new GroupNotConfirmed();
          sent.push(text);
        },
      },
    });
    expect(sent.filter((text) => text.channel === "group")).toEqual([]);
    for (const kind of ["offer", "corrected", "reminder", "confirm", "started"] as const) {
      expect(sent.some((text) => text.kind === kind && text.to === MIKE && text.channel === undefined), kind).toBe(true);
    }
    expect(job.hostNotes()).toContain(groupUnconfirmedLine("offer"));
    expect(job.hostNotes()).toContain(groupUnconfirmedLine("corrected"));
    expect(job.hostNotes()).toContain(groupUnconfirmedLine("started"));
  });

  it("never sends one-to-one when a group post fails outright", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent, { at: "2026-10-14T15:00:00.000Z" }, {
      sink: {
        send: async (text) => {
          if (text.channel === "group" && text.kind === "offer") throw new Error("boom");
          sent.push(text);
        },
      },
    });
    await job.pollFeed(FEED);
    await job.confirmHostTimes(TIMES);
    await job.pollFeed(FEED);
    expect(sent.some((text) => text.kind === "offer")).toBe(false);
    expect(job.reviews().some((item) => item.kind === "failed-sms" && item.status === "open")).toBe(true);
  });

  it("puts the intro first in the same text when a reply is routed from a receive, with both already in", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent, { at: "2026-10-14T15:00:00.000Z" });
    expect(sent).toEqual([]);
    const result = await say(job, "hello", MIKE, "what do I do next?");
    const group = sent.filter((text) => text.channel === "group");
    expect(group.map((text) => text.kind)).toEqual(["next"]);
    expect(group[0]?.body.startsWith(`${groupIntroBody(["Saad", "Mike"], "Saad", LANE)}\n\n`)).toBe(true);
    expect(result.sent.map((text) => text.kind)).toEqual(["next"]);
    expect(group.every((text) => text.audience?.join() === [OWNER, MIKE].join())).toBe(true);
  });

  it("posts to whoever is in the group at the time, contacts included", async () => {
    const sent: CleanerText[] = [];
    const clock = { at: "2026-10-14T15:00:00.000Z" };
    const job = engine(sent, clock, { groupChat: { hostName: "Saad", cleanerName: "Mike", extra: [{ phone: ANA, name: "Ana" }] }, cleanerConsent: undefined });
    await job.pollFeed(FEED);
    await job.confirmHostTimes(TIMES);
    await say(job, "yes-mike", MIKE, "YES");
    await say(job, "yes-ana", ANA, "YES");
    await say(job, "yes-offer", MIKE, "YES");
    const jobTexts = sent.filter((text) => text.channel === "group" && text.kind !== "intro");
    expect(jobTexts.map((text) => text.kind)).toEqual(["offer", "confirm"]);
    // The offer went out when two were in. The confirmation goes to all three.
    expect(jobTexts.map((text) => text.audience)).toEqual([[OWNER, MIKE], [OWNER, MIKE, ANA]]);
    expect(sent.filter((text) => text.to === ANA && text.channel === undefined && text.kind !== "opt-in")).toEqual([]);
  });
});

describe("group-first: door code", () => {
  const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
  const LANE = "12 Scratch Lane, Teaneck, NJ 07666";
  const OWNER = "+15555550100";
  const MIKE = "+15555550101";
  const ANA = "+15555550122";
  const PIN = SCRATCH_TENANTS[0]!.pin;
  const TIMES = { checkout: "11:00 AM", checkIn: "4:00 PM" };
  const ANA_SEAT = { phone: ANA, name: "Ana" };

  const clock = { at: "2026-10-14T15:00:00.000Z" };
  const DUE = "2026-10-18T12:00:00.000Z";
  function engine(sent: CleanerText[], extra: Partial<Parameters<typeof openCleanerCore>[0]> = {}) {
    return openCleanerCore({
      enabled: true,
      property: { id: "prop_12_scratch_lane", address: LANE, timeZone: "America/New_York" },
      ownerPhone: OWNER,
      cleaner: { phone: MIKE, approved: true },
      access: fixedCodePort(PIN),
      hostName: "Scratch",
      consented: true,
      cleanerConsent: "in",
      sink: { send: async (text) => void sent.push(text) },
      now: () => new Date(clock.at),
      groupChat: { hostName: "Saad", cleanerName: "Mike" },
      ...extra,
    });
  }
  const say = (job: ReturnType<typeof engine>, id: string, from: string, text: string) => job.receive({ id, from, text });
  const pins = (sent: CleanerText[]) => sent.filter((text) => text.kind === "pin");
  const withCode = (sent: CleanerText[]) => sent.filter((text) => text.body.includes(PIN));

  async function toYes(sent: CleanerText[], extra: Partial<Parameters<typeof openCleanerCore>[0]> = {}, ana?: "yes") {
    clock.at = "2026-10-14T15:00:00.000Z";
    const job = engine(sent, extra);
    await job.pollFeed(FEED);
    await job.confirmHostTimes(TIMES);
    await say(job, "yes-mike", MIKE, "YES");
    if (ana) await say(job, "yes-ana", ANA, "YES");
    return job;
  }
  const noLeak = (job: ReturnType<typeof engine>) => {
    expect(JSON.stringify(job.outbox())).not.toContain(PIN);
    expect(JSON.stringify(job.transcript())).not.toContain(PIN);
  };

  it("posts the code into the group when it holds only the landlord and Mike", async () => {
    const sent: CleanerText[] = [];
    const job = await toYes(sent);
    expect(withCode(sent)).toEqual([]);
    clock.at = DUE;
    await say(job, "left", OWNER, "guests have left");
    expect(pins(sent)).toHaveLength(1);
    expect(pins(sent)[0]).toMatchObject({ kind: "pin", channel: "group", audience: [OWNER, MIKE] });
    expect(pins(sent)[0]?.body).toContain(PIN);
    expect(sent.filter((text) => text.kind === "pin" && !text.channel)).toEqual([]);
    expect(withCode(sent).every((text) => text.kind === "pin")).toBe(true);
    noLeak(job);
  });

  it("sends the code to Mike alone when Ana is in and the landlord chose cleaner", async () => {
    const sent: CleanerText[] = [];
    const job = await toYes(sent, { groupChat: { hostName: "Saad", cleanerName: "Mike", extra: [ANA_SEAT], doorCodeTo: "cleaner" } }, "yes");
    clock.at = DUE;
    await say(job, "left", OWNER, "guests have left");
    expect(pins(sent)).toHaveLength(1);
    expect(pins(sent)[0]).toMatchObject({ to: MIKE, kind: "pin" });
    expect(pins(sent)[0]?.channel).toBeUndefined();
    expect(withCode(sent)).toEqual(pins(sent));
    noLeak(job);
  });

  it("posts the code to the whole group when Ana is in and the landlord chose group", async () => {
    const sent: CleanerText[] = [];
    const job = await toYes(sent, { groupChat: { hostName: "Saad", cleanerName: "Mike", extra: [ANA_SEAT], doorCodeTo: "group" } }, "yes");
    clock.at = DUE;
    await say(job, "left", OWNER, "guests have left");
    expect(pins(sent)).toHaveLength(1);
    expect(pins(sent)[0]).toMatchObject({ channel: "group", audience: [OWNER, MIKE, ANA] });
    expect(withCode(sent)).toEqual(pins(sent));
    noLeak(job);
  });

  it("checks the group when the code is sent: Ana's STOP before the guests leave puts it in the group for the two", async () => {
    const sent: CleanerText[] = [];
    const job = await toYes(sent, { groupChat: { hostName: "Saad", cleanerName: "Mike", extra: [ANA_SEAT], doorCodeTo: "cleaner" } }, "yes");
    await say(job, "stop-ana", ANA, "STOP");
    clock.at = DUE;
    await say(job, "left", OWNER, "guests have left");
    expect(pins(sent)).toHaveLength(1);
    expect(pins(sent)[0]).toMatchObject({ channel: "group", audience: [OWNER, MIKE] });
    expect(sent.filter((text) => text.to === ANA && text.body.includes(PIN))).toEqual([]);
    noLeak(job);
  });

  it("checks the group when the code is sent: Ana joining before the guests leave follows the landlord's choice", async () => {
    const sent: CleanerText[] = [];
    const job = await toYes(sent, { groupChat: { hostName: "Saad", cleanerName: "Mike", extra: [ANA_SEAT], doorCodeTo: "cleaner" } });
    await say(job, "yes-ana", ANA, "YES");
    clock.at = DUE;
    await say(job, "left", OWNER, "guests have left");
    expect(pins(sent)).toHaveLength(1);
    expect(pins(sent)[0]).toMatchObject({ to: MIKE });
    expect(pins(sent)[0]?.channel).toBeUndefined();
  });

  it("sends the code one-to-one to Mike alone when the group can't be made", async () => {
    const sent: CleanerText[] = [];
    const job = await toYes(sent, {
      groupChat: { hostName: "Saad", cleanerName: "Mike", extra: [ANA_SEAT], doorCodeTo: "group" },
      sink: {
        send: async (text) => {
          if (text.channel === "group") throw new GroupNotConfirmed();
          sent.push(text);
        },
      },
    });
    clock.at = DUE;
    await say(job, "left", OWNER, "guests have left");
    expect(pins(sent)).toHaveLength(1);
    expect(pins(sent)[0]).toMatchObject({ to: MIKE, kind: "pin" });
    expect(pins(sent)[0]?.channel).toBeUndefined();
    expect(sent.filter((text) => text.body.includes(PIN) && text.to !== MIKE)).toEqual([]);
    noLeak(job);
  });

  it("falls back to Mike alone with just the landlord and Mike when the group can't be made", async () => {
    const sent: CleanerText[] = [];
    const job = await toYes(sent, {
      sink: {
        send: async (text) => {
          if (text.channel === "group") throw new GroupNotConfirmed();
          sent.push(text);
        },
      },
    });
    clock.at = DUE;
    await say(job, "left", OWNER, "guests have left");
    expect(pins(sent)).toHaveLength(1);
    expect(pins(sent)[0]).toMatchObject({ to: MIKE });
    expect(pins(sent)[0]?.channel).toBeUndefined();
    expect(sent.filter((text) => text.body.includes(PIN) && text.to !== MIKE)).toEqual([]);
  });

  it("sends the code nowhere before the guests have left", async () => {
    const sent: CleanerText[] = [];
    const job = await toYes(sent, { groupChat: { hostName: "Saad", cleanerName: "Mike", extra: [ANA_SEAT], doorCodeTo: "group" } }, "yes");
    expect(withCode(sent)).toEqual([]);
    noLeak(job);
  });

  it("holds a split code in a group checklist and opens a review, and the step still succeeds", async () => {
    const sent: CleanerText[] = [];
    const split = PIN.split("").join(" ");
    const job = await toYes(sent, { checklist: { name: "Turnover", items: [`lock box ${split}`] } });
    const result = await say(job, "left", OWNER, "guests have left");
    expect(result.handled).toBe(true);
    expect(sent.filter((text) => text.kind === "checklist")).toEqual([]);
    expect(pins(sent)).toHaveLength(1);
    expect(withCode(sent).filter((text) => text.kind !== "pin")).toEqual([]);
    expect(sent.some((text) => joinDigits(text.body).includes(PIN) && text.kind !== "pin")).toBe(false);
    expect(job.reviews().some((item) => item.kind === "possible-code-exposure" && item.status === "open")).toBe(true);
    noLeak(job);
  });
});

function joinDigits(text: string): string {
  return text.replace(/(\d)[\s.\-_/]+(?=\d)/g, "$1");
}

describe("group-first: host messages in the engine", () => {
  const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
  const LANE = "12 Scratch Lane, Teaneck, NJ 07666";
  const OWNER = "+15555550100";
  const MIKE = "+15555550101";
  const PIN = SCRATCH_TENANTS[0]!.pin;
  const DUE = "2026-10-18T12:00:00.000Z";
  const clock = { at: "2026-10-14T15:00:00.000Z" };

  function open(sent: CleanerText[]) {
    clock.at = "2026-10-14T15:00:00.000Z";
    return openCleanerCore({
      enabled: true,
      property: { id: "prop_12_scratch_lane", address: LANE, timeZone: "America/New_York" },
      ownerPhone: OWNER,
      cleaner: { phone: MIKE, approved: true },
      access: fixedCodePort(PIN),
      hostName: "Scratch",
      consented: true,
      cleanerConsent: "in",
      sink: { send: async (text) => void sent.push(text) },
      now: () => new Date(clock.at),
      groupChat: { hostName: "Saad", cleanerName: "Mike" },
    });
  }

  it("posts the intro before a host message to the group", async () => {
    const sent: CleanerText[] = [];
    const job = open(sent);
    await job.sendHostMessage({ to: "group", body: "Running late today." });
    expect(sent.map((text) => text.kind)).toEqual(["intro", "host-message"]);
  });

  it("posts the landlord's approved words exactly, with no name added to an ask", async () => {
    const sent: CleanerText[] = [];
    const job = open(sent);
    const words = "Can you come by 10? Reply yes if that works, or tell me what time you can do.";
    await job.sendHostMessage({ to: "group", body: words });
    expect(sent.find((text) => text.kind === "host-message")?.body).toBe(words);
  });

  it("writes no private-delivery note for a code posted to the group", async () => {
    const sent: CleanerText[] = [];
    const job = open(sent);
    await job.pollFeed(FEED);
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await job.receive({ id: "yes", from: MIKE, text: "YES" });
    clock.at = DUE;
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    const pin = job.outbox().find((item) => item.kind === "pin");
    expect(sent.find((text) => text.kind === "pin")?.channel).toBe("group");
    await job.reportPin(pin?.id ?? "", "delivered");
    expect(job.hostNotes().filter((note) => note.includes("got the door code privately"))).toEqual([]);
  });

  it("still writes the note for a code sent one-to-one", async () => {
    const sent: CleanerText[] = [];
    const job = openCleanerCore({
      enabled: true,
      property: { id: "prop_12_scratch_lane", address: LANE, timeZone: "America/New_York" },
      ownerPhone: OWNER,
      cleaner: { phone: MIKE, approved: true },
      access: fixedCodePort(PIN),
      hostName: "Scratch",
      consented: true,
      cleanerConsent: "in",
      sink: { send: async (text) => void sent.push(text) },
      now: () => new Date(clock.at),
      groupChat: { hostName: "Saad", cleanerName: "Mike", extra: [{ phone: "+15555550122", name: "Ana" }], doorCodeTo: "cleaner" },
    });
    clock.at = "2026-10-14T15:00:00.000Z";
    await job.pollFeed(FEED);
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await job.receive({ id: "yes", from: MIKE, text: "YES" });
    await job.receive({ id: "yes-ana", from: "+15555550122", text: "YES" });
    clock.at = DUE;
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    const pin = job.outbox().find((item) => item.kind === "pin");
    expect(sent.find((text) => text.kind === "pin")?.channel).toBeUndefined();
    await job.reportPin(pin?.id ?? "", "delivered");
    expect(job.hostNotes().some((note) => note.includes("got the door code privately"))).toBe(true);
  });
});

describe("group-first: Grok's tools", () => {
  const MCP = "/mcp/cleaner-core";
  const HOOK_PATH = "/webhooks/twilio/cleaner-core/conversation";
  const SMS_PATH = "/webhooks/twilio/cleaner-core";
  const HOOK_URL = `${PUBLIC}${HOOK_PATH}`;
  const PIN_SENT_GROUP = "I posted the door code in the cleaning group for the cleaner. I'll tell you if it doesn't go through.";
  const QUESTION = "You added other people to the group. Should the door code go to the whole group, or only privately to the cleaner?";
  const REFUSAL = "Messages go to the group. Send it with to: group.";
  const ANA = "+15555550133";
  const opened: WiredApp[] = [];
  let seq = 0;

  afterEach(async () => {
    setCleanerGroupFetch(undefined);
    while (opened.length > 0) await opened.pop()?.close();
  });

  async function start() {
    const fake = fakeConversations();
    setCleanerGroupFetch(fake.impl);
    const wired = await startWiredApp({ groupChat: true, allowlist: `${HOST},${CLEANER},${ANA}` });
    opened.push(wired);
    return { fake, wired };
  }
  const call = (wired: WiredApp, name: string, args: Record<string, unknown> = {}) => wired.tool(MCP, CLEANER_TOKEN, name, args);
  async function must(wired: WiredApp, name: string, args: Record<string, unknown> = {}) {
    const reply = await call(wired, name, args);
    expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
    return reply.structured ?? {};
  }
  const sms = (wired: WiredApp, from: string, body: string) =>
    wired.postTwilio(SMS_PATH, { from, to: CLEANER_LINE, body, sid: `SMtools${++seq}`, token: CLEANER_AUTH });
  async function hook(wired: WiredApp, fields: Record<string, string>) {
    const headers = { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": twilioSignature(CLEANER_AUTH, HOOK_URL, fields) };
    const res = await fetch(`http://127.0.0.1:${wired.port}${HOOK_PATH}`, { method: "POST", headers, body: new URLSearchParams(fields).toString() });
    return res.status;
  }
  const inGroup = (sid: string, author: string, body: string) => ({
    EventType: "onMessageAdded",
    ConversationSid: sid,
    MessageSid: `IMtools${(++seq).toString(16).padStart(26, "0")}`,
    Index: String(seq),
    Author: author,
    Body: body,
    Source: "SMS",
  });
  async function setup(wired: WiredApp, people: Record<string, unknown>) {
    await must(wired, "get_state", { choice: "cleaners" });
    await must(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
    await must(wired, "save_people", { host: HOST, cleaner: CLEANER, cleanerName: "Mike", ...people });
    await must(wired, "save_calendar_link", { url: CALENDAR_URL });
    await must(wired, "save_door_code", { code: DOOR_CODE });
    await must(wired, "set_up_texting");
    await must(wired, "run_checks");
    await must(wired, "confirm_times", { checkout: "11:00", checkIn: "16:00" });
  }

  it("asks the door-code question when contacts are in the group and no choice is saved", async () => {
    const { wired } = await start();
    await must(wired, "get_state", { choice: "cleaners" });
    await must(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
    const contacts = [{ name: "Ana", role: "co-host", phone: ANA }];
    const refused = await call(wired, "save_people", { host: HOST, cleaner: CLEANER, groupChat: "everyone", contacts });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(QUESTION);
    expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER, contacts, doorCodeTo: "cleaner" })).isError).toBe(false);
  });

  it("counts the legacy observer as a contact for the question", async () => {
    const { wired } = await start();
    await must(wired, "get_state", { choice: "cleaners" });
    await must(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
    const refused = await call(wired, "save_people", { host: HOST, cleaner: CLEANER, observer: ANA });
    expect(refused.text).toBe(QUESTION);
    expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER, observer: ANA, doorCodeTo: "group" })).isError).toBe(false);
  });

  it("needs no choice for cleaner-and-host, or for no contacts", async () => {
    const { wired } = await start();
    await must(wired, "get_state", { choice: "cleaners" });
    await must(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
    const contacts = [{ name: "Ana", role: "co-host", phone: ANA }];
    expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER, groupChat: "cleaner-and-host", contacts })).isError).toBe(false);
    expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER })).isError).toBe(false);
  });

  it("refuses a message to anyone but the group, and posts a group message only after the confirmation", async () => {
    const { wired, fake } = await start();
    await setup(wired, {});
    await sms(wired, HOST, "YES");
    await sms(wired, CLEANER, "YES");
    const refused = await call(wired, "send_message", { to: "Mike", text: "Running late" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(REFUSAL);
    expect((await call(wired, "send_message", { to: "cleaner", text: "Running late" })).text).toBe(REFUSAL);
    const before = fake.posts.length;
    const preview = await must(wired, "send_message", { to: "group", text: "Running late" });
    expect(preview.confirmation).toBeTruthy();
    expect(fake.posts).toHaveLength(before);
    await must(wired, "send_message", { to: "group", text: "Running late", confirmation: (preview.confirmation as { code: string }).code });
    expect(fake.posts.at(-1)?.body).toBe("Running late");
  });

  it("runs end to end: one group, the intro first, and the code once, in the group", async () => {
    const { wired, fake } = await start();
    await setup(wired, {});
    expect((await sms(wired, HOST, "YES")).status).toBe(200);
    expect((await sms(wired, CLEANER, "YES")).status).toBe(200);
    expect(fake.created).toHaveLength(1);
    const sid = fake.created[0] ?? "";
    // The first group text is the intro with the offer after it, in one post.
    expect(fake.posts[0]?.body.startsWith(`${groupIntroBody([BUSINESS, "Mike"], BUSINESS, ADDRESS)}\n\nTurnover at `)).toBe(true);
    expect(await hook(wired, inGroup(sid, CLEANER, "YES"))).toBe(200);
    const left = await must(wired, "mark_guests_left", { confirmed: true });
    expect(left.next).toBe(PIN_SENT_GROUP);
    const withCode = fake.posts.filter((post) => post.body.includes(DOOR_CODE));
    expect(withCode).toHaveLength(1);
    expect([...(withCode[0]?.to ?? [])].sort()).toEqual([HOST, CLEANER].sort());
    // Only the intro says how to leave. No later group text ends on STOP.
    expect(fake.posts.filter((post) => /\bSTOP\b/.test(post.body)).map((post) => post.body)).toEqual([fake.posts[0]?.body]);
    expect(wired.cleanerSent.filter((item) => item.body.includes(DOOR_CODE))).toEqual([]);
  });
});

describe("group-first: final review fixes", () => {
  const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
  const EMPTY = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//scratch//EN\r\nEND:VCALENDAR\r\n";
  const LANE = "12 Scratch Lane, Teaneck, NJ 07666";
  const OWNER = "+15555550100";
  const MIKE = "+15555550101";
  const ANA = "+15555550122";
  const PIN = SCRATCH_TENANTS[0]!.pin;
  const TIMES = { checkout: "11:00 AM", checkIn: "4:00 PM" };
  const DUE = "2026-10-18T12:00:00.000Z";
  const clock = { at: "2026-10-14T15:00:00.000Z" };

  function engine(sent: CleanerText[], extra: Partial<Parameters<typeof openCleanerCore>[0]> = {}) {
    return openCleanerCore({
      enabled: true,
      property: { id: "prop_12_scratch_lane", address: LANE, timeZone: "America/New_York" },
      ownerPhone: OWNER,
      cleaner: { phone: MIKE, approved: true },
      access: fixedCodePort(PIN),
      hostName: "Scratch",
      consented: true,
      cleanerConsent: "in",
      sink: { send: async (text) => void sent.push(text) },
      now: () => new Date(clock.at),
      groupChat: { hostName: "Saad", cleanerName: "Mike" },
      reminderAsksArrival: true,
      ...extra,
    });
  }
  const say = (job: ReturnType<typeof engine>, id: string, from: string, text: string) => job.receive({ id, from, text });
  const intros = (sent: CleanerText[]) => sent.filter((text) => text.kind === "intro");

  async function toDone(job: ReturnType<typeof engine>) {
    clock.at = "2026-10-14T15:00:00.000Z";
    await job.pollFeed(FEED);
    await job.confirmHostTimes(TIMES);
    await say(job, "yes", MIKE, "YES");
    await say(job, "left", OWNER, "guests have left");
    await say(job, "start", MIKE, "START");
    await say(job, "done", MIKE, "DONE");
  }

  it("replay after a group flow sends nothing new", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent);
    await toDone(job);
    const before = sent.length;
    const replayed = await job.replay();
    expect(replayed.sent).toEqual([]);
    expect(sent).toHaveLength(before);
  });

  it("does not post a one-to-one text again into the group after a reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-oneonone-"));
    const sent: CleanerText[] = [];
    // The earlier run had no group: every text went one-to-one.
    clock.at = "2026-10-14T15:00:00.000Z";
    const base = engine(sent, { dataDir: dir, groupChat: undefined, cleanerConsent: undefined, reminderAsksArrival: undefined });
    await base.pollFeed(FEED);
    await say(base, "opt-yes", MIKE, "YES");
    await say(base, "y-out", OWNER, "YES");
    await say(base, "y-in", OWNER, "YES");
    await say(base, "y-offer", MIKE, "YES");
    await say(base, "left", OWNER, "guests have left");
    await say(base, "start", MIKE, "START");
    await say(base, "done", MIKE, "DONE");
    const oneToOne = sent.filter((text) => text.channel === undefined && ["offer", "confirm", "started", "done"].includes(text.kind));
    expect(oneToOne.map((text) => text.kind)).toEqual(expect.arrayContaining(["offer", "confirm", "started", "done"]));
    expect(sent.some((text) => text.channel === "group")).toBe(false);
    const before = sent.length;
    const reopened = engine(sent, { dataDir: dir });
    await say(reopened, "done-again", MIKE, "DONE");
    await reopened.replay();
    await reopened.runReminders();
    expect(sent.slice(before).filter((text) => text.channel === "group" && ["offer", "confirm", "started", "done", "corrected", "reminder"].includes(text.kind))).toEqual([]);
  });

  it("posts a cancellation into the group, not one-to-one", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent);
    await job.pollFeed(FEED);
    await job.confirmHostTimes(TIMES);
    await say(job, "yes", MIKE, "YES");
    const before = sent.length;
    await job.pollFeed(EMPTY);
    const cancels = sent.slice(before).filter((text) => text.kind === "cancel-update");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatchObject({ to: MIKE, channel: "group", audience: [OWNER, MIKE] });
  });

  it("keeps the landlord's injury alert out of the group when the landlord has left it", async () => {
    const sent: CleanerText[] = [];
    // The landlord has left the group, so it is Mike and Ana.
    const job = engine(sent, { cleanerConsent: undefined, groupChat: { hostName: "Saad", cleanerName: "Mike", extra: [{ phone: ANA, name: "Ana" }] } });
    clock.at = "2026-10-14T15:00:00.000Z";
    await job.pollFeed(EMPTY);
    await say(job, "yes-mike", MIKE, "YES");
    await say(job, "yes-ana", ANA, "YES");
    await say(job, "stop-owner", OWNER, "STOP");
    const before = sent.length;
    const result = await say(job, "hurt", MIKE, "someone got hurt, I need an ambulance");
    const after = sent.slice(before);
    const groupHost = after.filter((text) => text.channel === "group" && text.kind === "emergency" && text.body.includes("says someone is hurt"));
    expect(groupHost).toEqual([]);
    expect(after.some((text) => text.kind === "emergency" && text.to === OWNER && text.channel === undefined && text.body.includes("says someone is hurt"))).toBe(true);
    for (const text of after.filter((item) => item.channel === "group")) expect(text.audience).not.toContain(OWNER);
    expect(result.sent.every((text) => text.channel !== "group" || !text.audience?.includes(OWNER))).toBe(true);
  });

  it("retries a failed group reminder and lists it as failed", async () => {
    const sent: CleanerText[] = [];
    let fail = true;
    const job = engine(sent, {
      sink: {
        send: async (text) => {
          if (fail && text.channel === "group" && text.kind === "reminder") throw new Error("boom");
          sent.push(text);
        },
      },
    });
    await job.pollFeed(FEED);
    await job.confirmHostTimes(TIMES);
    await say(job, "yes", MIKE, "YES");
    clock.at = DUE;
    const first = await job.runReminders();
    expect(first.failed).toHaveLength(1);
    expect(first.failed[0]).toMatch(/^reminder:/);
    expect(sent.some((text) => text.kind === "reminder")).toBe(false);
    fail = false;
    const second = await job.runReminders();
    expect(second.sent.filter((text) => text.kind === "reminder")).toHaveLength(1);
    const third = await job.runReminders();
    expect(third.sent.filter((text) => text.kind === "reminder")).toEqual([]);
  });

  it("labels group posts as posts to the group", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent);
    await toDone(job);
    const groupRows = job.outbox().filter((item) => item.kind === "done");
    expect(groupRows.length).toBeGreaterThan(0);
    for (const row of groupRows) expect(row.group).toBe(true);
    expect(outboxLabel("done", "the group")).toBe("Done note to the group");
    expect(outboxLabel("intro", "the group")).toBe("Group intro");
  });

  it("posts a fresh intro after a STOP shrinks the group to a membership that was introduced before", async () => {
    const sent: CleanerText[] = [];
    const job = engine(sent, { groupChat: { hostName: "Saad", cleanerName: "Mike", extra: [{ phone: ANA, name: "Ana" }] }, cleanerConsent: undefined });
    clock.at = "2026-10-14T15:00:00.000Z";
    await job.pollFeed(EMPTY);
    await say(job, "yes-mike", MIKE, "YES");
    await say(job, "yes-ana", ANA, "YES");
    expect(intros(sent).map((text) => text.audience)).toEqual([[OWNER, MIKE], [OWNER, MIKE, ANA]]);
    await say(job, "stop-ana", ANA, "STOP");
    await job.pollFeed(EMPTY);
    expect(intros(sent).map((text) => text.audience)).toEqual([[OWNER, MIKE], [OWNER, MIKE, ANA], [OWNER, MIKE]]);
    expect(intros(sent)[2]?.body).toBe(groupIntroBody(["Saad", "Mike"], "Saad", LANE));
    // The same membership is not introduced again.
    await job.pollFeed(EMPTY);
    expect(intros(sent)).toHaveLength(3);
  });

  it("keeps the last introduced membership across a reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaner-lastintro-"));
    const sent: CleanerText[] = [];
    const extra = { dataDir: dir, groupChat: { hostName: "Saad", cleanerName: "Mike", extra: [{ phone: ANA, name: "Ana" }] } };
    const first = engine(sent, { ...extra, cleanerConsent: undefined });
    await first.pollFeed(EMPTY);
    await say(first, "yes-mike", MIKE, "YES");
    await say(first, "yes-ana", ANA, "YES");
    await say(first, "stop-ana", ANA, "STOP");
    await first.pollFeed(EMPTY);
    expect(intros(sent)).toHaveLength(3);
    const again = engine(sent, { ...extra, cleanerConsent: "in" });
    await again.pollFeed(EMPTY);
    expect(intros(sent)).toHaveLength(3);
  });
});
