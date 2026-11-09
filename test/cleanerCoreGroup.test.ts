import { fixedCodePort } from "../src/cleaner-core/doorPort";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jobHoldLine, groupInviteBody, groupOfferBody, groupUnconfirmedLine, holdNote, waitingForYesNote, privateCodeLine, resumeNote } from "../src/cleaner-core/cleanerTexts";
import { openCleanerCore, type CleanerText } from "../src/cleaner-core/core";
import { GroupNotConfirmed } from "../src/cleaner-core/groupThread";
import { liveDeskFor, resetLiveDesks, setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import { sendLiveGroup, sendLiveSms, setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";
import { fakeConversations } from "./fakeConversations";
import { PUBLIC } from "./fakeSendblue";
import { ADDRESS as PRACTICE, CALENDAR_ICS, CALENDAR_URL, CLEANER as LIVE_CLEANER, CLEANER_LINE, DOOR_CODE, fakeSms, FROZEN, HOST as LIVE_HOST, OBSERVER, TEST_PIN_KEY } from "./wiringProof";
import { approvedOnDesk, postToGroup, resumeApproved } from "./hostApproval";

const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const EXTRA = "+15555550122";
const NOW = "2026-10-14T15:00:00.000Z";
const lane = SCRATCH_TENANTS[0];
if (!lane) throw new Error("Scratch Lane is missing");
const PIN = lane.pin;
const OPT_CLEANER = groupInviteBody("Cory", ADDRESS);
const OPT_EXTRA = groupInviteBody("Cory", ADDRESS);
const OFFER_COPY = "Turnover at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. The cleaner will reply to confirm.";
const PRIVATE_PIN = `Guests have left ${ADDRESS}. Door code: ${PIN}. This code is only for you. Reply DONE when the cleaning is finished.`;
const GROUP_PIN = `Guests have left ${ADDRESS}. Door code: ${PIN}. Maria, reply DONE when the cleaning is finished.`;
const PRIVATE_LINE = privateCodeLine("Maria");
const TIME_LINE = "Cory will confirm that time.";
/** LiveDesk names the business when no host name is saved. */
const PRACTICE_TIME_LINE = "Harbor will confirm that time.";
/** A host message to the group: the probe for who is in it. */
const NOTE = "Please bring extra towels.";
const HOLD = holdNote(ADDRESS);
const JOB_HOLD = jobHoldLine(ADDRESS);
const RESUME = resumeNote(ADDRESS);
const ON_HOLD = "The cleaning is on hold. I'll send an update when it can start again.";
const READY = `The cleaner marked the cleaning at ${ADDRESS} done.`;
const OFFER = "Turnover at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.";
/** The offer as the group gets it, once, asking the cleaner by name. */
const GROUP_OFFER = groupOfferBody("Maria", OFFER);
const CONFIRM = "Cleaning is scheduled for Sunday, Oct 18 at 11:00 AM at 12 Scratch Lane, Teaneck, NJ 07666.";
const HURT = "If someone is hurt, call 911 now. I've let the host know.";
const HOST_HURT = "The cleaner at 12 Scratch Lane, Teaneck, NJ 07666 says someone is hurt. They've been told to call 911.";
const HOST_HURT_SELF = "If someone is hurt, call 911 now.";
const STOP_ACK = "You're opted out and won't receive more messages. Reply START to opt back in. Reply HELP for help.";
const STOP_HOLD = `The cleaner opted out of cleaning texts for ${ADDRESS}, so the cleaning is on hold. Find another cleaner or reach them directly, then tell your Grok Bot to restart it.`;
const ALREADY = "I already sent the door code to the cleaner.";
const PIN_SENT = "I sent the door code to the cleaner. I'll tell you if it doesn't go through.";
const PIN_SENT_GROUP = "I posted the door code in the cleaning group for the cleaner. I'll tell you if it doesn't go through.";
const PIN_FAILED = "The door code didn't reach the cleaner. Tell your Grok Bot the guests have left and I'll resend it.";
/** With no alert routine saved, the step after the checks asks Grok to create the routines first. */
const AFTER_CHECKS = "Create the Cleaner Core Check and Cleaner Core Alerts routines. Only the host can see the Alerts routine's webhook address and key. Right after you create it, without waiting to be asked, send the host a link that opens the Alerts routine's Webhook URL field directly and one that opens its Webhook key field directly, with one secure card for each, the address first. Never send a link to the Routines page, and never tell the host to open Routines and pick the routine: opening the routine from there doesn't show its Webhook URL. Keep it to three short steps: open the link, copy the value, paste it in the card. Then call save_alert_routine with no arguments to get a one-time upload link, and send both values to that link from your own computer. Never put them in chat.";
const PRACTICE_HOLD = waitingForYesNote(PRACTICE);
const PRACTICE_SETUP = [PRACTICE_HOLD];
const PRACTICE_YES = `The cleaner said YES to the turnover at ${PRACTICE}.`;
/** After the cleaner's YES, LiveDesk keeps one host note for the newly confirmed job. */
const PRACTICE_CONFIRMED = [PRACTICE_HOLD, PRACTICE_YES];
const PRACTICE_OFFER = "Turnover at 12 Practice Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. The cleaner will reply to confirm.";
const PRACTICE_GROUP_OFFER = "Turnover at 12 Practice Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Maria, reply YES to schedule it.";
const PRACTICE_CONFIRM = "Cleaning is scheduled for Sunday, Oct 18 at 11:00 AM at 12 Practice Lane, Teaneck, NJ 07666.";
const PRACTICE_STOP = `The cleaner opted out of cleaning texts for ${PRACTICE}, so the cleaning is on hold. Find another cleaner or reach them directly, then tell your Grok Bot to restart it.`;
const PRACTICE_PIN_HELD = "The cleaner opted out, so the door code wasn't sent. Please reach them directly.";
const PIN_MISSING = "I can't send the door code yet. Let's finish setting up Cleaner Core first.";
const FAILED_ONCE = "A text failed to send. I saved it for your review and did not count it as delivered.";
const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");

function plainFour(forbidden: readonly string[]): string {
  for (let n = 1000; n <= 9999; n += 1) {
    const value = String(n);
    if (forbidden.some((secret) => secret.includes(value))) continue;
    return value;
  }
  throw new Error("no 4-digit marker was free of the scratch codes");
}

function box() {
  const sent: CleanerText[] = [];
  return { sent, async send(text: CleanerText) { sent.push(text); } };
}

function open(sent: { send(text: CleanerText): void | Promise<void> }, extra = false) {
  return openCleanerCore({
    enabled: true,
    property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
    ownerPhone: OWNER,
    cleaner: { phone: CLEANER, approved: true },
    access: fixedCodePort(PIN),
    hostName: "Scratch",
    consented: true,
    sink: sent,
    now: () => new Date(NOW),
    groupChat: {
      hostName: "Cory",
      cleanerName: "Maria",
      ...(extra ? { extra: [{ phone: EXTRA, name: "Alex" }] } : {}),
    },
  });
}

async function joined(sent: ReturnType<typeof box>, extra = false) {
  const job = open(sent, extra);
  await job.pollFeed(FEED);
  await job.receive({ id: "host-yes", from: OWNER, text: "YES" });
  await job.receive({ id: "cleaner-yes", from: CLEANER, text: "YES" });
  if (extra) await job.receive({ id: "extra-yes", from: EXTRA, text: "YES" });
  await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
  await job.receive({ id: "schedule", from: CLEANER, text: "YES" });
  return job;
}

async function afterCode(label: string) {
  const sent = box();
  const job = await joined(sent);
  await job.receive({ id: `${label}-left`, from: OWNER, text: "guests have left" });
  return { sent, job };
}

function hostReady(sent: CleanerText[]): CleanerText[] {
  // The landlord's ready line is a group post when both are in the group, so it is found by its words.
  return sent.filter((text) => text.body === READY);
}

function doneHost(job: { outbox(): { to: string; body: string; kind: string; status: string }[] }) {
  return job.outbox().filter((item) => item.kind === "done" && item.body === READY).map((item) => ({
    to: item.to,
    body: item.body,
    kind: item.kind,
    status: item.status,
  }));
}

function groupTexts(sent: CleanerText[]): CleanerText[] {
  return sent.filter((text) => text.channel === "group");
}

describe("group thread", () => {
  it("opts the cleaner in one-on-one and seats the host without a YES text", async () => {
    const sent = box();
    const job = open(sent);
    await job.pollFeed(FEED);
    expect(groupTexts(sent.sent)).toEqual([]);
    expect(sent.sent.filter((text) => text.kind === "opt-in")).toEqual([
      { to: CLEANER, body: OPT_CLEANER, kind: "opt-in" },
    ]);
    await job.receive({ id: "host-yes", from: OWNER, text: "YES" });
    expect(groupTexts(sent.sent)).toEqual([]);
    expect(sent.sent.filter((text) => text.to === CLEANER && text.channel === "group")).toEqual([]);
  });

  it("posts the door code in the group when it holds only Cory and the approved cleaner", async () => {
    const sent = box();
    const job = await joined(sent);
    const before = sent.sent.length;
    const left = await job.receive({ id: "left-1", from: OWNER, text: "guests have left" });
    expect(left.sent.filter((text) => text.kind === "pin")).toEqual([
      { to: CLEANER, body: GROUP_PIN, kind: "pin", channel: "group", audience: [OWNER, CLEANER] },
    ]);
    expect(sent.sent.slice(before).filter((text) => text.kind === "pin")).toEqual(left.sent.filter((text) => text.kind === "pin"));
    expect(job.transcript().join("\n").includes(PIN)).toBe(false);
    expect(job.outbox().map((item) => item.body).join("\n").includes(PIN)).toBe(false);
    expect(JSON.stringify(job.jobs()).includes(PIN)).toBe(false);
    expect(JSON.stringify(job.reviews()).includes(PIN)).toBe(false);
    expect(sent.sent.filter((text) => text.to === OWNER && text.channel !== "group").some((text) => text.body.includes(PIN))).toBe(false);
    expect(sent.sent.filter((text) => text.body.includes(PIN)).every((text) => text.kind === "pin" && text.channel === "group")).toBe(true);
    const again = await job.receive({ id: "left-2", from: OWNER, text: "guests have left" });
    expect(again.sent.filter((text) => text.kind === "pin")).toEqual([]);
    expect(sent.sent.filter((text) => text.kind === "pin")).toHaveLength(1);
  });

  it("sends the code one-on-one when someone else is in the group, and tells the group it went privately", async () => {
    const sent = box();
    const job = await joined(sent, true);
    expect(sent.sent.filter((text) => text.kind === "opt-in" && text.to === EXTRA)).toEqual([
      { to: EXTRA, body: OPT_EXTRA, kind: "opt-in" },
    ]);
    const left = await job.receive({ id: "left-extra", from: OWNER, text: "guests have left" });
    expect(left.sent.filter((text) => text.kind === "pin")).toEqual([
      { to: CLEANER, body: PRIVATE_PIN, kind: "pin" },
    ]);
    expect(left.sent.filter((text) => text.body === PRIVATE_LINE || text.channel === "group")).toEqual([]);
    expect(job.hostNotes()).toEqual([]);
    job.notePrivateCodeDelivered();
    expect(job.hostNotes()).toEqual([PRIVATE_LINE]);
    expect(left.sent.filter((text) => text.channel === "group").some((text) => text.body.includes(PIN))).toBe(false);
    expect(sent.sent.filter((text) => text.to === EXTRA).every((text) => !text.body.includes(PIN))).toBe(true);
  });

  it("holds the code when the cleaner has not opted in or has opted out", async () => {
    const waiting = box();
    const held = open(waiting);
    await held.pollFeed(FEED);
    await held.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    const early = await held.receive({ id: "left-early", from: OWNER, text: "guests have left" });
    expect(early.sent.filter((text) => text.kind === "pin" || text.body.includes(PIN))).toEqual([]);
    expect(held.jobOnHold()).toBe(false);

    const sent = box();
    const job = await joined(sent);
    const stopped = await job.receive({ id: "stop-cleaner", from: CLEANER, text: "STOP", channel: "group" });
    expect(stopped.sent).toEqual([
      { to: CLEANER, body: STOP_ACK, kind: "stop" },
      { to: OWNER, body: STOP_HOLD, kind: "held" },
    ]);
    expect(job.jobOnHold()).toBe(true);
    const left = await job.receive({ id: "left-out", from: OWNER, text: "guests have left" });
    expect(left.sent.filter((text) => text.kind === "pin" || text.body.includes(PIN) || text.channel === "group")).toEqual([]);
    expect(sent.sent.filter((text) => text.to === CLEANER).every((text) => text.kind === "opt-in" || text.kind === "intro" || text.kind === "offer" || text.kind === "confirm" || text.kind === "stop" || text.body === OFFER || text.body === CONFIRM || text.body === STOP_ACK)).toBe(true);
    expect(sent.sent.filter((text) => text.body.includes(PIN))).toEqual([]);
  });

  it("sends the door code privately after Cory opts out", async () => {
    const sent = box();
    const job = await joined(sent);
    await job.receive({ id: "stop-cory", from: OWNER, text: "STOP", channel: "group" });
    const blocked = await job.receive({ id: "left-cory-held", from: OWNER, text: "guests have left" });
    expect(blocked.sent.filter((text) => text.kind === "pin")).toEqual([]);
    expect(job.jobOnHold()).toBe(true);
    await job.resumeJob();
    const left = await job.receive({ id: "left-cory-out", from: OWNER, text: "guests have left" });
    expect(left.sent.filter((text) => text.kind === "pin")).toEqual([{ to: CLEANER, body: PRIVATE_PIN, kind: "pin" }]);
    expect(left.sent.filter((text) => text.body === PRIVATE_LINE || text.channel === "group")).toEqual([]);
    const ownerHold = `The cleaning at ${ADDRESS} is on hold because you opted out of texts. Tell your Grok Bot to restart it.`;
    expect(job.hostNotes()).toEqual([ownerHold, RESUME]);
    job.notePrivateCodeDelivered();
    expect(job.hostNotes()).toEqual([ownerHold, RESUME, PRIVATE_LINE]);
  });

  it("files the private line for Cory only after a delivery report, and the group never gets it", async () => {
    const sent = box();
    const job = await joined(sent, true);
    const left = await job.receive({ id: "left-private-note", from: OWNER, text: "guests have left" });
    expect(left.sent.filter((text) => text.kind === "pin")).toEqual([{ to: CLEANER, body: PRIVATE_PIN, kind: "pin" }]);
    expect(sent.sent.filter((text) => text.body === PRIVATE_LINE)).toEqual([]);
    expect(sent.sent.filter((text) => text.channel === "group" && text.kind === "pin-notice")).toEqual([]);
    expect(job.hostNotes()).toEqual([]);
    job.notePrivateCodeDelivered();
    expect(job.hostNotes()).toEqual([PRIVATE_LINE]);
    job.notePrivateCodeDelivered();
    expect(job.hostNotes()).toEqual([PRIVATE_LINE]);
  });

  it("removes only the person who sent STOP, and only Cory can resume", async () => {
    const sent = box();
    const job = await joined(sent);
    await job.receive({ id: "stop-host", from: OWNER, text: "STOP", channel: "group" });
    const afterHost = await job.receive({ id: "time-after-host", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    const afterHostMembers = job.groupMembers();
    expect(afterHost.sent.filter((text) => text.kind !== "next")).toEqual([]);
    expect(afterHostMembers).toEqual([CLEANER].sort());
    expect(sent.sent.filter((text) => text.to === OWNER && text.body === TIME_LINE)).toEqual([]);

    const fresh = box();
    const held = await joined(fresh);
    await held.receive({ id: "stop-cleaner", from: CLEANER, text: "STOP" });
    expect(held.jobOnHold()).toBe(true);
    const ignored = await held.receive({ id: "start-again", from: CLEANER, text: "START" });
    expect(ignored.sent).toEqual([]);
    expect(held.jobOnHold()).toBe(true);
    const resumed = await held.resumeJob();
    expect(resumed).toEqual({ to: OWNER, body: RESUME, kind: "resume" });
    expect(held.jobOnHold()).toBe(false);
    const second = await held.resumeJob();
    expect(second).toBeNull();
    expect(fresh.sent.filter((text) => text.body === RESUME)).toEqual([resumed]);
    expect(fresh.sent.filter((text) => text.to === CLEANER && text.body === RESUME)).toEqual([]);
    const after = await held.receive({ id: "after-stop", from: OWNER, text: "Are you on the way?", channel: "group" });
    expect(after.sent.filter((text) => text.audience?.includes(CLEANER))).toEqual([]);
  });

  it("does not move a time texted in the group, and retries a failed door code in the group", async () => {
    const sent = box();
    const job = await joined(sent);
    const clock = job.jobs().find((item) => item.checkoutTime === "11:00 AM");
    expect(clock?.checkoutTime).toBe("11:00 AM");
    const timed = await job.receive({ id: "group-time", from: CLEANER, text: "Let's say 2:00 PM", channel: "group" });
    const timedMembers = job.groupMembers();
    expect(timed.sent.filter((text) => text.kind !== "next")).toEqual([]);
    expect(timedMembers).toEqual([OWNER, CLEANER].sort());
    expect(job.jobs().find((item) => item.id === clock?.id)?.checkoutTime).toBe("11:00 AM");
    const quiet = await job.receive({ id: "cory-quiet", from: OWNER, text: "Sounds good", channel: "group" });
    expect(quiet.sent).toEqual([]);

    let failedPins = 0;
    const retried: CleanerText[] = [];
    const once = {
      sent: retried,
      async send(text: CleanerText) {
        if (text.kind === "pin" && failedPins === 0) {
          failedPins += 1;
          throw new Error("send failed");
        }
        retried.push(text);
      },
    };
    const broken = await joined(once);
    const first = await broken.receive({ id: "left-fail", from: OWNER, text: "guests have left" });
    expect(first.sent.filter((text) => text.kind === "pin")).toEqual([]);
    expect(broken.groupPinSettled()).toBe(false);
    const reminded = await broken.runReminders();
    expect(reminded.sent.filter((text) => text.kind === "pin")).toEqual([{ to: CLEANER, body: GROUP_PIN, kind: "pin", channel: "group", audience: [OWNER, CLEANER] }]);
    // The retry posts the code once, in the group, and never one-to-one as well.
    expect(retried.filter((text) => text.body.includes(PIN))).toHaveLength(1);
    expect(retried.filter((text) => text.body.includes(PIN) && !text.channel)).toEqual([]);
  });

  it("names a dropped group text from the fixed list when that text contains a 4-digit number", async () => {
    const marker = plainFour(SCRATCH_TENANTS.map((tenant) => tenant.pin));
    const sent: CleanerText[] = [];
    const job = openCleanerCore({
      enabled: true,
      property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
      ownerPhone: OWNER,
      cleaner: { phone: CLEANER, approved: true },
      access: fixedCodePort(PIN),
      hostName: "Scratch",
      consented: true,
      sink: {
        async send(text) {
          if (text.channel === "group") throw new GroupNotConfirmed();
          sent.push(text);
        },
      },
      now: () => new Date(NOW),
      groupChat: { hostName: `Gate ${marker}`, cleanerName: "Maria" },
    });
    await job.pollFeed(FEED);
    await job.receive({ id: "host-yes-marker", from: OWNER, text: "YES" });
    await job.receive({ id: "cleaner-yes-marker", from: CLEANER, text: "YES" });
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await job.receive({ id: "schedule-marker", from: CLEANER, text: "YES" });
    // The offer fell back to the cleaner alone, so the note says it reached them. The checkout time went nowhere.
    expect(job.hostNotes().filter((line) => line.startsWith("I couldn't send") || line.startsWith("The group text"))).toEqual([
      "The group text couldn't start, so I texted the cleaner the cleaning offer directly.",
      "I couldn't send the checkout time to the group.",
    ]);
    expect(sent.some((text) => text.kind === "offer" && text.to === CLEANER)).toBe(true);
    expect(job.hostNotes().join("\n").includes(marker)).toBe(false);
    expect(job.hostNotes().join("\n").includes("Gate")).toBe(false);
    expect(sent.filter((text) => text.channel === "group")).toEqual([]);
  });

  it("names a dropped group text in plain words, and keeps the old line when none fit", () => {
    expect(groupUnconfirmedLine("confirm")).toBe("I couldn't send the checkout time to the group.");
    expect(groupUnconfirmedLine("offer")).toBe("I couldn't send the cleaning offer to the group.");
    expect(groupUnconfirmedLine("reminder")).toBe("I couldn't send the reminder to the group.");
    expect(groupUnconfirmedLine("opt-in")).toBe("I couldn't send the invitation to the group.");
    expect(groupUnconfirmedLine("pin")).toBe("I couldn't send that to the group.");
    expect(groupUnconfirmedLine("confirm").includes("confirm")).toBe(false);
    expect(groupUnconfirmedLine("opt-in").includes("opt-in")).toBe(false);
  });

  it("files a resume note when Cory's number is missing and sends nothing", async () => {
    const sent: CleanerText[] = [];
    const job = openCleanerCore({
      enabled: true,
      property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
      ownerPhone: "",
      cleaner: { phone: CLEANER, approved: true },
      access: fixedCodePort(PIN),
      hostName: "Scratch",
      consented: true,
      sink: { async send(text) { sent.push(text); } },
      now: () => new Date(NOW),
      groupChat: { hostName: "Cory", cleanerName: "Maria" },
    });
    const resumed = await job.resumeJob();
    const sentence = `The cleaning at ${ADDRESS} is back on.`;
    expect(sent).toEqual([]);
    expect(job.hostNotes()).toEqual([sentence]);
    expect(resumed?.body).toBe(sentence);
    expect(job.outbox()).toEqual([expect.objectContaining({ to: "", kind: "resume", status: "unsent", body: sentence })]);
    const again = await job.resumeJob();
    expect(again?.body).toBe(sentence);
    expect(job.hostNotes()).toEqual([sentence]);
    expect(job.outbox()).toEqual([expect.objectContaining({ to: "", kind: "resume", status: "unsent", body: sentence })]);
    expect(sent).toEqual([]);
  });

  it("posts a group injury's 911 line into the group and keeps the restart note one-to-one", async () => {
    const sent = box();
    const job = await joined(sent);
    const before = sent.sent.length;
    const hurt = await job.receive({ id: "fell", from: CLEANER, text: "I fell at 2:00 PM and I'm hurt", channel: "group" });
    expect(hurt.sent).toEqual([
      { to: CLEANER, body: HOST_HURT, kind: "emergency", channel: "group", audience: [OWNER, CLEANER] },
      { to: OWNER, body: `The cleaning at ${ADDRESS} is on hold because the cleaner reported an injury. Once everyone's okay, tell your Grok Bot to restart it.`, kind: "emergency" },
      { to: CLEANER, body: HURT, kind: "emergency", channel: "group", audience: [OWNER, CLEANER] },
    ]);
    // The restart note mentions Grok, so it stays with the landlord. No other line goes to the group.
    expect(sent.sent.slice(before).some((text) => text.body === TIME_LINE || text.body === HOLD)).toBe(false);
    expect(sent.sent.slice(before).filter((text) => text.channel === "group").every((text) => text.kind === "emergency")).toBe(true);
    const host = await job.receive({ id: "host-fell", from: OWNER, text: "someone is hurt", channel: "group" });
    expect(host.sent).toEqual([{ to: CLEANER, body: HOST_HURT_SELF, kind: "emergency", channel: "group", audience: [OWNER, CLEANER] }]);
  });

  it("never holds on how a group message sounds, and holds once when Cory says to", async () => {
    const sent = box();
    const job = await joined(sent);
    // A problem, or a friendly "no problem", is Grok's to read and Cory's to decide. Cleaner Core changes nothing.
    for (const [id, text] of [["problem", "The lock is broken"], ["no-problem", "No problem, see you Sunday!"]]) {
      const reply = await job.receive({ id: id!, from: CLEANER, text: text!, channel: "group" });
      expect(reply.sent.filter((item) => item.kind !== "next")).toEqual([]);
      expect(job.jobOnHold()).toBe(false);
    }
    expect(job.reviews().some((item) => item.kind === "group-problem")).toBe(false);
    const held = await job.hostHold("cory-hold");
    expect(held).toEqual({ handled: true, reason: "held", sent: [{ to: CLEANER, body: JOB_HOLD, kind: "held", channel: "group", audience: [OWNER, CLEANER] }] });
    expect(job.jobOnHold()).toBe(true);
    expect((await job.hostHold("cory-hold-again")).sent).toEqual([]);
    expect((await job.hostHold("cory-hold")).reason).toBe("duplicate");
    const left = await job.receive({ id: "left-held", from: OWNER, text: "guests have left" });
    expect(left.sent.filter((text) => text.kind === "pin")).toEqual([]);
    const resumed = await job.resumeJob();
    expect(resumed?.body).toBe(RESUME);
    expect(job.jobOnHold()).toBe(false);
  });

  it("leaves the job unfinished when DONE follows Cory's hold, with or without START", async () => {
    const plain = await afterCode("problem-plain");
    await plain.job.hostHold("problem-plain");
    expect(await plain.job.receive({ id: "problem-plain-done", from: CLEANER, text: "DONE", channel: "group" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [{ to: CLEANER, body: ON_HOLD, kind: "next", channel: "group", audience: [OWNER, CLEANER] }],
    });
    expect(plain.job.jobs().some((item) => item.status === "done")).toBe(false);
    expect(hostReady(plain.sent.sent)).toEqual([]);
    expect(doneHost(plain.job)).toEqual([]);

    const started = await afterCode("problem-start");
    await started.job.hostHold("problem-start");
    await started.job.receive({ id: "problem-start-start", from: CLEANER, text: "START", channel: "group" });
    expect(await started.job.receive({ id: "problem-start-done", from: CLEANER, text: "DONE", channel: "group" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [{ to: CLEANER, body: ON_HOLD, kind: "next", channel: "group", audience: [OWNER, CLEANER] }],
    });
    expect(started.job.jobs().some((item) => item.status === "done")).toBe(false);
    expect(hostReady(started.sent.sent)).toEqual([]);
    expect(doneHost(started.job)).toEqual([]);

    const resumed = await afterCode("problem-resume");
    await resumed.job.hostHold("problem-resume-hold");
    await resumed.job.resumeJob();
    expect(await resumed.job.receive({ id: "problem-resume-done", from: CLEANER, text: "DONE", channel: "group" })).toEqual({
      handled: true,
      reason: "done",
      sent: [{ to: CLEANER, body: "Thanks, cleaning marked done.", kind: "done", channel: "group", audience: [OWNER, CLEANER] }],
    });
    expect(resumed.job.jobs().some((item) => item.status === "done")).toBe(true);
    // The landlord's ready line is a group post now, not a text to the landlord.
    expect(hostReady(resumed.sent.sent)).toEqual([{ to: CLEANER, body: READY, kind: "done", channel: "group", audience: [OWNER, CLEANER] }]);
    expect(doneHost(resumed.job)).toEqual([{ to: CLEANER, body: READY, kind: "done", status: "sent" }]);
  });

  it("leaves the job unfinished when DONE follows a host STOP after the code, with or without START", async () => {
    // The landlord left the group, so only the cleaner is in it and the replies stay one-to-one.
    const plain = await afterCode("owner-plain");
    await plain.job.receive({ id: "owner-plain-stop", from: OWNER, text: "STOP", channel: "group" });
    expect(await plain.job.receive({ id: "owner-plain-done", from: CLEANER, text: "DONE", channel: "group" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [{ to: CLEANER, body: ON_HOLD, kind: "next" }],
    });
    expect(plain.job.jobs().some((item) => item.status === "done")).toBe(false);
    expect(hostReady(plain.sent.sent)).toEqual([]);
    expect(doneHost(plain.job)).toEqual([]);

    const started = await afterCode("owner-start");
    await started.job.receive({ id: "owner-start-stop", from: OWNER, text: "STOP", channel: "group" });
    await started.job.receive({ id: "owner-start-start", from: CLEANER, text: "START", channel: "group" });
    expect(await started.job.receive({ id: "owner-start-done", from: CLEANER, text: "DONE", channel: "group" })).toEqual({
      handled: true,
      reason: "ignored",
      sent: [{ to: CLEANER, body: ON_HOLD, kind: "next" }],
    });
    expect(started.job.jobs().some((item) => item.status === "done")).toBe(false);
    expect(hostReady(started.sent.sent)).toEqual([]);
    expect(doneHost(started.job)).toEqual([]);

    const resumed = await afterCode("owner-resume");
    await resumed.job.receive({ id: "owner-resume-stop", from: OWNER, text: "STOP", channel: "group" });
    await resumed.job.resumeJob();
    expect(await resumed.job.receive({ id: "owner-resume-done", from: CLEANER, text: "DONE", channel: "group" })).toEqual({
      handled: true,
      reason: "done",
      sent: [{ to: CLEANER, body: "Thanks, cleaning marked done.", kind: "done" }],
    });
    expect(resumed.job.jobs().some((item) => item.status === "done")).toBe(true);
    expect(hostReady(resumed.sent.sent)).toEqual([{ to: OWNER, body: READY, kind: "done" }]);
    expect(doneHost(resumed.job)).toEqual([{ to: OWNER, body: READY, kind: "done", status: "sent" }]);
  });

  it("reaches done from the cleaner's replies after the code is out", async () => {
    const sent = box();
    const job = await joined(sent);
    await job.receive({ id: "left-done", from: OWNER, text: "guests have left" });
    const started = await job.receive({ id: "start-work", from: CLEANER, text: "START", channel: "group" });
    expect(started.sent).toEqual([{ to: CLEANER, body: "Got it, cleaning started.", kind: "started", channel: "group", audience: [OWNER, CLEANER] }]);
    const done = await job.receive({ id: "done-work", from: CLEANER, text: "DONE", channel: "group" });
    expect(done.sent).toEqual([{ to: CLEANER, body: "Thanks, cleaning marked done.", kind: "done", channel: "group", audience: [OWNER, CLEANER] }]);
    expect(job.jobs().some((item) => item.status === "done")).toBe(true);
    // The landlord's done line is its own group post, not a text to the landlord.
    expect(done.sent.some((text) => text.to === OWNER)).toBe(false);
  });

  it("keeps group wording aimed at the group", async () => {
    const sent = box();
    const job = await joined(sent);
    await job.receive({ id: "group-time-2", from: OWNER, text: "2:00 PM", channel: "group" });
    await job.receive({ id: "left-words", from: OWNER, text: "guests have left" });
    const groups = groupTexts(sent.sent);
    expect(groups.length).toBeGreaterThan(0);
    for (const text of groups) {
      expect(text.body).not.toMatch(/\byou\b/i);
      expect(text.body).not.toMatch(/grok bot|twilio|engine|cleaner_core/i);
    }
    // Cory's own group message gets no reply from Cleaner Core.
    expect(groups.some((text) => text.body === TIME_LINE)).toBe(false);
    expect(groups.some((text) => text.body === GROUP_PIN && text.kind === "pin")).toBe(true);
    expect(sent.sent.some((text) => text.body === PRIVATE_PIN)).toBe(false);
    expect(sent.sent.some((text) => text.body === OFFER)).toBe(false);
    expect(sent.sent.some((text) => text.body === GROUP_OFFER && text.channel === "group")).toBe(true);
    expect(sent.sent.some((text) => text.body === CONFIRM && text.channel === "group")).toBe(true);
    expect(sent.sent.some((text) => text.body === CONFIRM && !text.channel)).toBe(false);
  });

  it("drops the checkout question in group mode and sets times only through confirm_times", async () => {
    const sent = box();
    const job = open(sent);
    const checkout = `Is checkout at ${ADDRESS} on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.`;
    const checkin = `Is check-in at ${ADDRESS} on Sunday, Oct 18 still 4:00 PM? Reply YES or send the new time.`;
    const poll = await job.pollFeed(FEED);
    expect(poll.sent.filter((text) => text.body === checkout || text.body === checkin)).toEqual([]);
    expect(sent.sent.filter((text) => text.body === checkout || text.body === checkin)).toEqual([]);
    expect(groupTexts(sent.sent).filter((text) => text.body === checkout || text.body === checkin)).toEqual([]);
    await job.receive({ id: "yes-not-the-clock", from: OWNER, text: "YES" });
    expect(job.jobs().filter((item) => item.checkoutTime === "11:00 AM")).toEqual([]);
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    expect(job.jobs().filter((item) => item.checkoutTime === "11:00 AM").map((item) => item.nextCheckInTime)).toEqual(["4:00 PM"]);
    expect(sent.sent.filter((text) => text.body === checkout || text.body === checkin)).toEqual([]);
    expect(groupTexts(sent.sent).filter((text) => text.body === checkout || text.body === checkin)).toEqual([]);
  });
});

describe("group thread on the desk", () => {
  afterEach(() => {
    setCleanerTwilioClient(undefined);
    setCleanerGroupFetch(undefined);
    setCleanerCalendarFetch(undefined);
    resetLiveDesks();
  });

  it("keeps the missing key note and does not retry a failed group send", async () => {
    const calls: string[] = [];
    const fetchBox = groupFetch({ failMessages: true });
    setCleanerGroupFetch(async (url, init) => {
      calls.push(String(url));
      return fetchBox.impl(url, init);
    });
    const sms = fakeSms();
    setCleanerTwilioClient(sms);
    setCleanerCalendarFetch(async (url) => ({
      status: url === CALENDAR_URL ? 200 : 404,
      url,
      async text() {
        return url === CALENDAR_URL ? CALENDAR_ICS : "";
      },
    }));
    const root = mkdtempSync(join(tmpdir(), "cleaner-group-"));
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_GROUP_CHAT: "1",
      CLEANER_CORE_SMS_ALLOWLIST: `${LIVE_HOST},${LIVE_CLEANER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
      PUBLIC_BASE_URL: PUBLIC,
    };
    const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
    const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
    expect((await desk.getState("cleaners")).ok).toBe(true);
    expect((await desk.saveProperty({ business: "Harbor", address: "12 Practice Lane, Teaneck, NJ 07666", timeZone: "America/New_York" })).ok).toBe(true);
    expect((await desk.savePeople({ host: LIVE_HOST, cleaner: LIVE_CLEANER, cleanerName: "Maria", observer: OBSERVER, doorCodeTo: "cleaner" })).ok).toBe(true);
    expect((await desk.saveCalendarLink({ url: CALENDAR_URL })).ok).toBe(true);
    expect((await desk.saveDoorCode({ code: DOOR_CODE }, pinKey)).ok).toBe(true);
    expect((await desk.setUpTexting()).ok).toBe(true);
    expect((await desk.runChecks()).ok).toBe(true);
    const missing = await desk.markGuestsLeft({ confirmed: true }, undefined);
    expect(missing).toEqual({ ok: false, error: PIN_MISSING });
    expect(calls).toEqual([]);

    await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" });
    await desk.inbound({ id: "yes-host", from: LIVE_HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner", from: LIVE_CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-schedule", from: LIVE_CLEANER, text: "YES" });
    // The group was made, but the offer's post failed. It may still have reached the group, so it
    // goes to review and is not sent again one-to-one, and the group is not tried again.
    const posts = calls.filter((url) => url.endsWith("/Messages"));
    // One post for the intro with the offer, and one for the confirmation after Mike's YES. None is tried again,
    // and none goes one-to-one.
    expect(posts).toHaveLength(2);
    expect(sms.sent.filter((text) => text.body.startsWith("Turnover at"))).toEqual([]);
    const state = await desk.getState();
    expect(state.ok && (state.result.turns as { status: string }[])[0]?.status).toBe("host_confirmed");
    const failed = await desk.markGuestsLeft({ confirmed: true }, pinKey);
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed).includes(DOOR_CODE)).toBe(false);
    expect(sms.sent.some((text) => text.body.includes(DOOR_CODE))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("drops the checkout question on the desk and sets times only through confirm_times", async () => {
    const sms = fakeSms();
    const fetchBox = groupFetch();
    setCleanerTwilioClient(sms);
    setCleanerGroupFetch(fetchBox.impl);
    let feed = CALENDAR_ICS;
    setCleanerCalendarFetch(async (url) => ({
      status: url === CALENDAR_URL ? 200 : 404,
      url,
      async text() {
        return url === CALENDAR_URL ? feed : "";
      },
    }));
    const root = mkdtempSync(join(tmpdir(), "cleaner-host-clock-"));
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_GROUP_CHAT: "1",
      CLEANER_CORE_SMS_ALLOWLIST: `${LIVE_HOST},${LIVE_CLEANER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
      PUBLIC_BASE_URL: PUBLIC,
    };
    const checkout = `Is checkout at ${PRACTICE} on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.`;
    const checkin = `Is check-in at ${PRACTICE} on Monday, Oct 19 still 4:00 PM? Reply YES or send the new time.`;
    const clockBodies = () => sms.sent.filter((text) => text.body === checkout || text.body === checkin);
    const open = () => liveDeskFor(root, () => env, () => new Date(FROZEN));
    const desk = open();
    const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
    expect((await desk.getState("cleaners")).ok).toBe(true);
    expect((await desk.saveProperty({ business: "Harbor", address: PRACTICE, timeZone: "America/New_York" })).ok).toBe(true);
    expect((await desk.savePeople({ host: LIVE_HOST, cleaner: LIVE_CLEANER, cleanerName: "Maria", observer: OBSERVER, doorCodeTo: "cleaner" })).ok).toBe(true);
    expect((await desk.saveCalendarLink({ url: CALENDAR_URL })).ok).toBe(true);
    expect((await desk.saveDoorCode({ code: DOOR_CODE }, pinKey)).ok).toBe(true);
    expect((await desk.setUpTexting()).ok).toBe(true);
    expect((await desk.runChecks()).ok).toBe(true);
    expect(clockBodies()).toEqual([]);
    expect(fetchBox.posts.filter((text) => text.body === checkout || text.body === checkin)).toEqual([]);
    await desk.inbound({ id: "yes-not-the-clock", from: LIVE_HOST, text: "YES" });
    const early = await desk.getTurns();
    expect(early.ok).toBe(true);
    if (early.ok) {
      const turns = early.result.turns as { checkoutTime: string | null }[];
      expect(turns.filter((turn) => turn.checkoutTime === "11:00 AM")).toEqual([]);
    }
    env.CLEANER_CORE_LIVE_SMS = "1";
    expect((await desk.runChecks()).ok).toBe(true);
    expect(clockBodies()).toEqual([]);
    await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" });
    const saved = await desk.getTurns();
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      const turns = saved.result.turns as { checkoutTime: string | null; nextCheckInTime: string | null }[];
      expect(turns.filter((turn) => turn.checkoutTime === "11:00 AM").map((turn) => turn.nextCheckInTime)).toEqual(["4:00 PM"]);
    }
    expect(clockBodies()).toEqual([]);
    feed = CALENDAR_ICS.replace("DTSTART;VALUE=DATE:20261018", "DTSTART;VALUE=DATE:20261019");
    expect((await desk.runChecks()).ok).toBe(true);
    expect(clockBodies()).toEqual([]);
    expect(fetchBox.posts.filter((text) => text.body === checkout || text.body === checkin)).toEqual([]);
    const read = await desk.getState();
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.result.notes).toEqual(PRACTICE_SETUP);
      expect(JSON.stringify(read.result.notes).includes(checkout)).toBe(false);
      expect(JSON.stringify(read.result.notes).includes(checkin)).toBe(false);
    }
    rmSync(root, { recursive: true, force: true });
  });
});

describe("live group send", () => {
  afterEach(() => {
    setCleanerGroupFetch(undefined);
  });

  it("texts nobody when live texts are off", async () => {
    const calls: string[] = [];
    setCleanerGroupFetch(async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ sid: "CH1" }) } as Response;
    });
    const env = {
      CLEANER_CORE_LIVE_SMS: "0",
      CLEANER_CORE_SMS_ALLOWLIST: "*",
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
      PUBLIC_BASE_URL: PUBLIC,
    };
    expect(await sendLiveGroup(env, { audience: [OWNER, CLEANER], body: "Hello the group" })).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

/** The Conversations fake for group texting, with the posts each phone received. */
/** The group posts without the intro, so a test can look at the offer and the texts after it. */
/** The group's job texts. An intro alone is left out, and an intro posted ahead of a job text is cut off it. */
function offerPosts<T extends { body: string }>(posts: T[]): T[] {
  const intro = (body: string) => body.startsWith("Hi ") && body.includes("This is the cleaning group for");
  return posts.flatMap((post) => {
    if (!intro(post.body)) return [post];
    const at = post.body.indexOf("\n\n");
    return at < 0 ? [] : [{ ...post, body: post.body.slice(at + 2) }];
  });
}

function groupFetch(options?: { failMessages?: boolean }) {
  const fake = fakeConversations(options);
  return { impl: fake.impl, posts: fake.posts, blockMembership: fake.blockMembership, people: fake.people };
}

describe("live group membership", () => {
  const roots: string[] = [];

  afterEach(() => {
    setCleanerTwilioClient(undefined);
    setCleanerGroupFetch(undefined);
    setCleanerCalendarFetch(undefined);
    resetLiveDesks();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function liveGroup(extra: boolean) {
    const root = mkdtempSync(join(tmpdir(), "cleaner-group-live-"));
    roots.push(root);
    const store = join(root, "conversation.json");
    const readSid = () => {
      if (!existsSync(store)) return undefined;
      const parsed = JSON.parse(readFileSync(store, "utf8")) as { conversationSid?: string };
      return parsed.conversationSid;
    };
    const sms = fakeSms();
    const fetchBox = groupFetch();
    setCleanerTwilioClient(sms);
    setCleanerGroupFetch(fetchBox.impl);
    const allow = extra ? [OWNER, CLEANER, EXTRA] : [OWNER, CLEANER];
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_SMS_ALLOWLIST: allow.join(","),
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
      PUBLIC_BASE_URL: PUBLIC,
    };
    const job = openCleanerCore({
      enabled: true,
      property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
      ownerPhone: OWNER,
      cleaner: { phone: CLEANER, approved: true },
      access: fixedCodePort(PIN),
      hostName: "Scratch",
      consented: true,
      allowlist: allow,
      sink: {
        async send(text: CleanerText) {
          if (text.channel === "group" && text.audience && text.audience.length > 0) {
            const sent = await sendLiveGroup(env, { audience: [...text.audience], body: text.body, conversationSid: readSid() });
            if (sent?.conversationSid) writeFileSync(store, `${JSON.stringify({ conversationSid: sent.conversationSid })}\n`);
            return;
          }
          await sendLiveSms(env, { to: text.to, body: text.body });
        },
      },
      now: () => new Date(NOW),
      groupChat: {
        hostName: "Cory",
        cleanerName: "Maria",
        ...(extra ? { extra: [{ phone: EXTRA, name: "Alex" }] } : {}),
      },
    });
    return { job, sms, posts: fetchBox.posts, blockMembership: fetchBox.blockMembership, people: fetchBox.people, readSid };
  }

  async function ready(extra: boolean) {
    const live = liveGroup(extra);
    await live.job.pollFeed(FEED);
    await live.job.receive({ id: "host-yes", from: OWNER, text: "YES" });
    await live.job.receive({ id: "cleaner-yes", from: CLEANER, text: "YES" });
    if (extra) await live.job.receive({ id: "extra-yes", from: EXTRA, text: "YES" });
    await live.job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await live.job.receive({ id: "schedule", from: CLEANER, text: "YES" });
    await live.job.sendHostMessage({ to: "group", body: NOTE });
    return live;
  }

  it("keeps Alex out of a saved conversation after STOP, including the next group text and the door code", async () => {
    const live = await ready(true);
    const sid = live.readSid();
    expect(offerPosts(live.posts)).toEqual([
      { conversationSid: sid, to: [OWNER, CLEANER, EXTRA], body: GROUP_OFFER },
      { conversationSid: sid, to: [OWNER, CLEANER, EXTRA], body: CONFIRM },
      { conversationSid: sid, to: [OWNER, CLEANER, EXTRA], body: NOTE },
    ]);
    await live.job.receive({ id: "stop-alex", from: EXTRA, text: "STOP", channel: "group" });
    await live.job.sendHostMessage({ to: "group", body: NOTE });
    const left = await live.job.receive({ id: "left-alex", from: OWNER, text: "guests have left" });
    // Alex left, so the next group text starts a new group and the old one is emptied.
    const next = live.readSid();
    expect(next).not.toBe(sid);
    expect(live.people(sid ?? "")).toEqual([]);
    expect(offerPosts(live.posts)).toEqual([
      { conversationSid: sid, to: [OWNER, CLEANER, EXTRA], body: GROUP_OFFER },
      { conversationSid: sid, to: [OWNER, CLEANER, EXTRA], body: CONFIRM },
      { conversationSid: sid, to: [OWNER, CLEANER, EXTRA], body: NOTE },
      { conversationSid: next, to: [OWNER, CLEANER], body: NOTE },
      // Alex is out, so the group holds only Cory and the cleaner and the code goes into it, never to Alex.
      { conversationSid: next, to: [OWNER, CLEANER], body: GROUP_PIN },
    ]);
    expect(left.sent.filter((text) => text.kind === "pin")).toEqual([
      { to: CLEANER, body: GROUP_PIN, kind: "pin", channel: "group", audience: [OWNER, CLEANER] },
    ]);
    expect(live.posts.filter((post) => post.body.includes(PIN) && post.to.includes(EXTRA))).toEqual([]);
  });

  it("sends nothing to the group when the saved conversation's members cannot be confirmed", async () => {
    const live = await ready(false);
    const sid = live.readSid();
    expect(offerPosts(live.posts)).toEqual([
      { conversationSid: sid, to: [OWNER, CLEANER], body: GROUP_OFFER },
      { conversationSid: sid, to: [OWNER, CLEANER], body: CONFIRM },
      { conversationSid: sid, to: [OWNER, CLEANER], body: NOTE },
    ]);
    live.blockMembership();
    const left = await live.job.receive({ id: "left-unsynced", from: OWNER, text: "guests have left" });
    expect(offerPosts(live.posts)).toEqual([
      { conversationSid: sid, to: [OWNER, CLEANER], body: GROUP_OFFER },
      { conversationSid: sid, to: [OWNER, CLEANER], body: CONFIRM },
      { conversationSid: sid, to: [OWNER, CLEANER], body: NOTE },
    ]);
    expect(live.sms.sent.filter((text) => text.body === PRIVATE_PIN).map((text) => ({ to: text.to, body: text.body }))).toEqual([
      { to: CLEANER, body: PRIVATE_PIN },
    ]);
    expect(left.sent.filter((text) => text.channel === "group")).toEqual([]);
    expect(left.sent.filter((text) => text.kind === "pin")).toEqual([{ to: CLEANER, body: PRIVATE_PIN, kind: "pin" }]);
  });

  it("tells Cory once in get_state when a group text is dropped, including a retry and a restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-group-alert-"));
    roots.push(root);
    const fetchBox = groupFetch();
    const sms = fakeSms();
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_GROUP_CHAT: "1",
      CLEANER_CORE_SMS_ALLOWLIST: `${LIVE_HOST},${LIVE_CLEANER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
      PUBLIC_BASE_URL: PUBLIC,
    };
    const line = "I couldn't send your message to the group.";
    const checkout = `Is checkout at ${PRACTICE} on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.`;
    const privateLine = "Maria got the door code privately.";
    setCleanerTwilioClient(sms);
    setCleanerGroupFetch(fetchBox.impl);
    setCleanerCalendarFetch(async (url) => ({
      status: url === CALENDAR_URL ? 200 : 404,
      url,
      async text() {
        return url === CALENDAR_URL ? CALENDAR_ICS : "";
      },
    }));
    const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
    const boot = () => {
      const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
      return desk;
    };
    const desk = boot();
    expect((await desk.getState("cleaners")).ok).toBe(true);
    expect((await desk.saveProperty({ business: "Harbor", address: PRACTICE, timeZone: "America/New_York" })).ok).toBe(true);
    expect((await desk.savePeople({ host: LIVE_HOST, cleaner: LIVE_CLEANER, cleanerName: "Maria", observer: OBSERVER, doorCodeTo: "cleaner" })).ok).toBe(true);
    expect((await desk.saveCalendarLink({ url: CALENDAR_URL })).ok).toBe(true);
    expect((await desk.saveDoorCode({ code: DOOR_CODE }, pinKey)).ok).toBe(true);
    expect((await desk.setUpTexting()).ok).toBe(true);
    expect((await desk.runChecks()).ok).toBe(true);
    await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" });
    await desk.inbound({ id: "yes-host", from: LIVE_HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner", from: LIVE_CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-schedule", from: LIVE_CLEANER, text: "YES" });
    const quiet = await desk.getState();
    expect(quiet.ok).toBe(true);
    if (quiet.ok) expect(quiet.result.notes).toEqual(PRACTICE_CONFIRMED);
    fetchBox.blockMembership();
    await postToGroup(desk, NOTE);
    await postToGroup(desk, NOTE);
    const read = await desk.getState();
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.result.notes).toEqual([...PRACTICE_CONFIRMED, line]);
    expect(line).not.toMatch(/twilio|grok|door code|cleaner_core|\d/);
    expect(sms.sent.filter((text) => text.body === line || text.body === privateLine || text.body === checkout)).toEqual([]);
    expect(offerPosts(fetchBox.posts).map((text) => text.body)).toEqual([PRACTICE_GROUP_OFFER, PRACTICE_CONFIRM]);
    const reread = await desk.getState();
    expect(reread.ok).toBe(true);
    if (reread.ok) expect(reread.result.notes).toEqual([...PRACTICE_CONFIRMED, line]);

    resetLiveDesks();
    const restarted = boot();
    expect((await restarted.saveDoorCode({ code: DOOR_CODE }, pinKey)).ok).toBe(true);
    const afterRestart = await restarted.getState();
    expect(afterRestart.ok).toBe(true);
    if (afterRestart.ok) expect(afterRestart.result.notes).toEqual([...PRACTICE_CONFIRMED, line]);
    await postToGroup(restarted, NOTE);
    const still = await restarted.getState();
    expect(still.ok).toBe(true);
    if (still.ok) expect(still.result.notes).toEqual([...PRACTICE_CONFIRMED, line]);
    expect(offerPosts(fetchBox.posts).map((text) => text.body)).toEqual([PRACTICE_GROUP_OFFER, PRACTICE_CONFIRM]);
    expect(sms.sent.filter((text) => text.body === line)).toEqual([]);
  });

  it("shows the private line in get_state after a failed member check and posts nothing to the group", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-group-private-note-"));
    roots.push(root);
    const fetchBox = groupFetch();
    const sms = fakeSms();
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_GROUP_CHAT: "1",
      CLEANER_CORE_SMS_ALLOWLIST: `${LIVE_HOST},${LIVE_CLEANER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
      PUBLIC_BASE_URL: PUBLIC,
    };
    const line = "Maria got the door code privately.";
    const alert = "I couldn't send the checkout time to the group.";
    const checkout = `Is checkout at ${PRACTICE} on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.`;
    const groupPin = `Maria, guests have left ${PRACTICE}. Door code: ${DOOR_CODE}.`;
    const privatePin = `Guests have left ${PRACTICE}. Door code: ${DOOR_CODE}. This code is only for you. Reply DONE when the cleaning is finished.`;
    setCleanerTwilioClient(sms);
    setCleanerGroupFetch(fetchBox.impl);
    setCleanerCalendarFetch(async (url) => ({
      status: url === CALENDAR_URL ? 200 : 404,
      url,
      async text() {
        return url === CALENDAR_URL ? CALENDAR_ICS : "";
      },
    }));
    const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
    const boot = () => liveDeskFor(root, () => env, () => new Date(FROZEN));
    const desk = boot();
    expect((await desk.getState("cleaners")).ok).toBe(true);
    expect((await desk.saveProperty({ business: "Harbor", address: PRACTICE, timeZone: "America/New_York" })).ok).toBe(true);
    expect((await desk.savePeople({ host: LIVE_HOST, cleaner: LIVE_CLEANER, cleanerName: "Maria", observer: OBSERVER, doorCodeTo: "cleaner" })).ok).toBe(true);
    expect((await desk.saveCalendarLink({ url: CALENDAR_URL })).ok).toBe(true);
    expect((await desk.saveDoorCode({ code: DOOR_CODE }, pinKey)).ok).toBe(true);
    expect((await desk.setUpTexting()).ok).toBe(true);
    expect((await desk.runChecks()).ok).toBe(true);
    await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" });
    await desk.inbound({ id: "yes-host", from: LIVE_HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner", from: LIVE_CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-schedule", from: LIVE_CLEANER, text: "YES" });
    fetchBox.blockMembership();
    const left = await desk.markGuestsLeft({ confirmed: true }, pinKey);
    const again = await desk.markGuestsLeft({ confirmed: true }, pinKey);
    expect(left).toEqual({ ok: true, result: { next: PIN_SENT } });
    expect(again).toEqual({ ok: true, result: { next: ALREADY } });
    expect(fetchBox.posts.filter((text) => text.body === line || text.body === alert || text.body === checkout || text.body === groupPin || text.body === PRACTICE_TIME_LINE)).toEqual([]);
    expect(sms.sent.filter((text) => text.body === privatePin).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(sms.sent.filter((text) => text.body === line || text.body === alert || text.body === checkout || text.body === groupPin)).toEqual([]);
    const waiting = await desk.getState();
    expect(waiting.ok).toBe(true);
    if (waiting.ok) {
      expect(waiting.result.next).toBe(AFTER_CHECKS);
      expect(waiting.result.notes).toEqual(PRACTICE_CONFIRMED);
    }
    const pinText = sms.sent.find((text) => text.body === privatePin);
    await desk.notePinDelivery({ sid: pinText?.sid ?? "", status: "sent" });
    const pendingNote = await desk.getState();
    expect(pendingNote.ok).toBe(true);
    if (pendingNote.ok) expect(pendingNote.result.notes).toEqual(PRACTICE_CONFIRMED);
    await desk.notePinDelivery({ sid: pinText?.sid ?? "", status: "delivered" });
    const read = await desk.getState();
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.result.notes).toEqual([...PRACTICE_CONFIRMED, line]);
      expect(read.result.next).toBe(AFTER_CHECKS);
      expect(JSON.stringify(read.result.notes).includes(DOOR_CODE)).toBe(false);
      expect(JSON.stringify(read.result.notes).includes(groupPin)).toBe(false);
    }
    resetLiveDesks();
    const restarted = boot();
    expect((await restarted.saveDoorCode({ code: DOOR_CODE }, pinKey)).ok).toBe(true);
    const afterRestart = await restarted.getState();
    expect(afterRestart.ok).toBe(true);
    if (afterRestart.ok) expect(afterRestart.result.notes).toEqual([...PRACTICE_CONFIRMED, line]);
    expect(fetchBox.posts.filter((text) => text.body === line || text.body === alert || text.body === groupPin || text.body === PRACTICE_TIME_LINE)).toEqual([]);

    const heldRoot = mkdtempSync(join(tmpdir(), "cleaner-group-private-held-"));
    roots.push(heldRoot);
    const heldFetch = groupFetch();
    const heldSms = fakeSms();
    setCleanerTwilioClient(heldSms);
    setCleanerGroupFetch(heldFetch.impl);
    const held = liveDeskFor(heldRoot, () => env, () => new Date(FROZEN));
    expect((await held.getState("cleaners")).ok).toBe(true);
    expect((await held.saveProperty({ business: "Harbor", address: PRACTICE, timeZone: "America/New_York" })).ok).toBe(true);
    expect((await held.savePeople({ host: LIVE_HOST, cleaner: LIVE_CLEANER, cleanerName: "Maria", observer: OBSERVER, doorCodeTo: "cleaner" })).ok).toBe(true);
    expect((await held.saveCalendarLink({ url: CALENDAR_URL })).ok).toBe(true);
    expect((await held.saveDoorCode({ code: DOOR_CODE }, pinKey)).ok).toBe(true);
    expect((await held.setUpTexting()).ok).toBe(true);
    expect((await held.runChecks()).ok).toBe(true);
    await held.confirmTimes({ checkout: "11:00", checkIn: "16:00" });
    await held.inbound({ id: "yes-host-held", from: LIVE_HOST, text: "YES" });
    await held.inbound({ id: "yes-cleaner-held", from: LIVE_CLEANER, text: "YES" });
    await held.inbound({ id: "yes-schedule-held", from: LIVE_CLEANER, text: "YES" });
    heldFetch.blockMembership();
    await held.inbound({ id: "stop-before-sync", from: LIVE_CLEANER, text: "STOP" });
    const stayed = await held.markGuestsLeft({ confirmed: true }, pinKey);
    expect(stayed.ok).toBe(true);
    expect(heldFetch.posts.filter((text) => text.body === line || text.body === groupPin || text.body === alert || text.body === PRACTICE_TIME_LINE)).toEqual([]);
    expect(heldSms.sent.filter((text) => text.body === privatePin || text.body === line || text.body === groupPin)).toEqual([]);
    const heldRead = await held.getState();
    expect(heldRead.ok).toBe(true);
    if (heldRead.ok) expect(heldRead.result.notes).toEqual([...PRACTICE_CONFIRMED, PRACTICE_STOP, PRACTICE_PIN_HELD]);
    expect(heldSms.sent.filter((text) => text.to === LIVE_HOST).map((text) => text.body)).toEqual([PRACTICE_STOP]);
  });

  it("shows the failed-send alert when the private door-code text fails and never the private note", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-group-private-fail-"));
    roots.push(root);
    const fetchBox = groupFetch();
    const sms = fakeSms((body) => (body.includes("Door code:") ? "failed" : "queued"));
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_GROUP_CHAT: "1",
      CLEANER_CORE_SMS_ALLOWLIST: `${LIVE_HOST},${LIVE_CLEANER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
      PUBLIC_BASE_URL: PUBLIC,
    };
    const line = "Maria got the door code privately.";
    const failedAlert = "The door code didn't reach the cleaner. Tell your Grok Bot the guests have left and I'll resend it.";
    const groupPin = `Maria, guests have left ${PRACTICE}. Door code: ${DOOR_CODE}.`;
    setCleanerTwilioClient(sms);
    setCleanerGroupFetch(fetchBox.impl);
    setCleanerCalendarFetch(async (url) => ({
      status: url === CALENDAR_URL ? 200 : 404,
      url,
      async text() {
        return url === CALENDAR_URL ? CALENDAR_ICS : "";
      },
    }));
    const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
    const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
    expect((await desk.getState("cleaners")).ok).toBe(true);
    expect((await desk.saveProperty({ business: "Harbor", address: PRACTICE, timeZone: "America/New_York" })).ok).toBe(true);
    expect((await desk.savePeople({ host: LIVE_HOST, cleaner: LIVE_CLEANER, cleanerName: "Maria", observer: OBSERVER, doorCodeTo: "cleaner" })).ok).toBe(true);
    expect((await desk.saveCalendarLink({ url: CALENDAR_URL })).ok).toBe(true);
    expect((await desk.saveDoorCode({ code: DOOR_CODE }, pinKey)).ok).toBe(true);
    expect((await desk.setUpTexting()).ok).toBe(true);
    expect((await desk.runChecks()).ok).toBe(true);
    await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" });
    await desk.inbound({ id: "yes-host-fail", from: LIVE_HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner-fail", from: LIVE_CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-schedule-fail", from: LIVE_CLEANER, text: "YES" });
    fetchBox.blockMembership();
    const left = await desk.markGuestsLeft({ confirmed: true }, pinKey);
    expect(left).toEqual({ ok: true, result: { next: failedAlert } });
    await desk.notePinDelivery({ sid: "SM-none", status: "sent" });
    const read = await desk.getState();
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.result.next).toBe(failedAlert);
      expect(JSON.stringify(read.result.notes ?? [])).not.toContain(line);
      expect(JSON.stringify(read.result).includes(DOOR_CODE)).toBe(false);
    }
    expect(fetchBox.posts.filter((text) => text.body === line || text.body === groupPin)).toEqual([]);
    expect(sms.sent.filter((text) => text.to === LIVE_HOST && text.body === line)).toEqual([]);
  });

  it("keeps the job on hold when STOP comes before a dropped group text and sends no code", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-group-stop-drop-"));
    roots.push(root);
    const fetchBox = groupFetch();
    const sms = fakeSms();
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_GROUP_CHAT: "1",
      CLEANER_CORE_SMS_ALLOWLIST: `${LIVE_HOST},${LIVE_CLEANER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
      PUBLIC_BASE_URL: PUBLIC,
    };
    const hold = `The cleaner opted out of cleaning texts for ${PRACTICE}, so the cleaning is on hold. Find another cleaner or reach them directly, then tell your Grok Bot to restart it.`;
    const line = "Maria got the door code privately.";
    setCleanerTwilioClient(sms);
    setCleanerGroupFetch(fetchBox.impl);
    setCleanerCalendarFetch(async (url) => ({
      status: url === CALENDAR_URL ? 200 : 404,
      url,
      async text() {
        return url === CALENDAR_URL ? CALENDAR_ICS : "";
      },
    }));
    const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
    const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
    expect((await desk.getState("cleaners")).ok).toBe(true);
    expect((await desk.saveProperty({ business: "Harbor", address: PRACTICE, timeZone: "America/New_York" })).ok).toBe(true);
    expect((await desk.savePeople({ host: LIVE_HOST, cleaner: LIVE_CLEANER, cleanerName: "Maria", observer: OBSERVER, doorCodeTo: "cleaner" })).ok).toBe(true);
    expect((await desk.saveCalendarLink({ url: CALENDAR_URL })).ok).toBe(true);
    expect((await desk.saveDoorCode({ code: DOOR_CODE }, pinKey)).ok).toBe(true);
    expect((await desk.setUpTexting()).ok).toBe(true);
    expect((await desk.runChecks()).ok).toBe(true);
    await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" });
    await desk.inbound({ id: "yes-host-stop", from: LIVE_HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner-stop", from: LIVE_CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-schedule-stop", from: LIVE_CLEANER, text: "YES" });
    await desk.inbound({ id: "stop-first", from: LIVE_CLEANER, text: "STOP" });
    fetchBox.blockMembership();
    await desk.inbound({ id: "time-after-stop", from: LIVE_CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    const read = await desk.getState();
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.result.next).toBe(hold);
    const turns = await desk.getTurns();
    expect(turns.ok).toBe(true);
    if (turns.ok) expect(turns.result.held).toBe(true);
    const left = await desk.markGuestsLeft({ confirmed: true }, pinKey);
    expect(left.ok).toBe(true);
    expect(sms.sent.filter((text) => text.body.includes("Door code:"))).toEqual([]);
    expect(fetchBox.posts.filter((text) => text.body.includes("Door code:") || text.body === line)).toEqual([]);
    expect(sms.sent.filter((text) => text.body === "You're opted back in to cleaning texts. Reply YES if you still want this turnover. Reply STOP to opt out.")).toEqual([]);
    const after = await desk.getState();
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.result.next).toBe(hold);
  });

  async function privateSendWithoutHost(contactIn = true) {
    const root = mkdtempSync(join(tmpdir(), "cleaner-private-accept-"));
    roots.push(root);
    const fetchBox = groupFetch();
    const sms = fakeSms();
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_GROUP_CHAT: "1",
      CLEANER_CORE_SMS_ALLOWLIST: `${LIVE_HOST},${LIVE_CLEANER},${OBSERVER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
      PUBLIC_BASE_URL: PUBLIC,
    };
    setCleanerTwilioClient(sms);
    setCleanerGroupFetch(fetchBox.impl);
    setCleanerCalendarFetch(async (url) => ({
      status: url === CALENDAR_URL ? 200 : 404,
      url,
      async text() {
        return url === CALENDAR_URL ? CALENDAR_ICS : "";
      },
    }));
    const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
    const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
    expect((await desk.getState("cleaners")).ok).toBe(true);
    expect((await desk.saveProperty({ business: "Harbor", address: PRACTICE, timeZone: "America/New_York" })).ok).toBe(true);
    expect((await desk.savePeople({ host: LIVE_HOST, cleaner: LIVE_CLEANER, cleanerName: "Maria", observer: OBSERVER, doorCodeTo: "cleaner" })).ok).toBe(true);
    expect((await desk.saveCalendarLink({ url: CALENDAR_URL })).ok).toBe(true);
    expect((await desk.saveDoorCode({ code: DOOR_CODE }, pinKey)).ok).toBe(true);
    expect((await desk.setUpTexting()).ok).toBe(true);
    expect((await desk.runChecks()).ok).toBe(true);
    await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" });
    await desk.inbound({ id: "yes-cleaner-only", from: LIVE_CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-schedule-only", from: LIVE_CLEANER, text: "YES" });
    // A contact is in the group, and the landlord has not chosen the whole group, so the code stays private.
    if (contactIn) await desk.inbound({ id: "yes-contact-only", from: OBSERVER, text: "YES" });
    const privatePin = `Guests have left ${PRACTICE}. Door code: ${DOOR_CODE}. This code is only for you. Reply DONE when the cleaning is finished.`;
    return { desk, sms, posts: fetchBox.posts, pinKey, privatePin };
  }

  it("returns the sent sentence when Twilio accepts a private door code", async () => {
    const { desk, sms, posts, pinKey, privatePin } = await privateSendWithoutHost();
    const left = await desk.markGuestsLeft({ confirmed: true }, pinKey);
    expect(left).toEqual({ ok: true, result: { next: PIN_SENT } });
    expect(sms.sent.filter((text) => text.body === privatePin).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(sms.sent.filter((text) => text.to === LIVE_HOST && text.body === privatePin).map((text) => text.to)).toEqual([]);
    expect(posts.filter((text) => text.body === privatePin).map((text) => text.body)).toEqual([]);
    const state = await desk.getState();
    expect(state.ok).toBe(true);
    if (state.ok) {
      expect(state.result.next).toBe(AFTER_CHECKS);
      expect(state.result.notes).toEqual(PRACTICE_CONFIRMED);
    }
  });

  it("posts the door code in the group and returns the sent sentence when only the landlord and the cleaner are in it", async () => {
    const { desk, sms, posts, pinKey, privatePin } = await privateSendWithoutHost(false);
    const left = await desk.markGuestsLeft({ confirmed: true }, pinKey);
    expect(left).toEqual({ ok: true, result: { next: PIN_SENT_GROUP } });
    const groupPin = `Guests have left ${PRACTICE}. Door code: ${DOOR_CODE}. Maria, reply DONE when the cleaning is finished.`;
    expect(posts.filter((text) => text.body === groupPin)).toHaveLength(1);
    expect(sms.sent.filter((text) => text.body === privatePin || text.body.includes(DOOR_CODE))).toEqual([]);
    const again = await desk.markGuestsLeft({ confirmed: true }, pinKey);
    expect(again).toEqual({ ok: true, result: { next: ALREADY } });
    expect(posts.filter((text) => text.body === groupPin)).toHaveLength(1);
    expect(JSON.stringify(await desk.getState())).not.toContain(DOOR_CODE);
  });

  it("returns the already-sent sentence while a private delivery report is pending", async () => {
    const { desk, sms, posts, pinKey, privatePin } = await privateSendWithoutHost();
    const left = await desk.markGuestsLeft({ confirmed: true }, pinKey);
    expect(left).toEqual({ ok: true, result: { next: PIN_SENT } });
    const again = await desk.markGuestsLeft({ confirmed: true }, pinKey);
    expect(again).toEqual({ ok: true, result: { next: ALREADY } });
    expect(sms.sent.filter((text) => text.body === privatePin).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(posts.filter((text) => text.body === privatePin).map((text) => text.body)).toEqual([]);
    expect(sms.sent.filter((text) => text.to === LIVE_HOST && text.body === privatePin).map((text) => text.to)).toEqual([]);
    const state = await desk.getState();
    expect(state.ok).toBe(true);
    if (state.ok) {
      expect(state.result.next).toBe(AFTER_CHECKS);
      expect(state.result.notes).toEqual(PRACTICE_CONFIRMED);
    }
  });

  it("returns the failed-send sentence after a failed private delivery report", async () => {
    const { desk, sms, posts, pinKey, privatePin } = await privateSendWithoutHost();
    const line = "Maria got the door code privately.";
    const left = await desk.markGuestsLeft({ confirmed: true }, pinKey);
    expect(left).toEqual({ ok: true, result: { next: PIN_SENT } });
    const pending = await desk.getState();
    expect(pending.ok).toBe(true);
    if (pending.ok) {
      expect(pending.result.next).toBe(AFTER_CHECKS);
      expect(pending.result.notes).toEqual(PRACTICE_CONFIRMED);
    }
    const pinText = sms.sent.find((text) => text.body === privatePin);
    await desk.notePinDelivery({ sid: pinText?.sid ?? "", status: "failed" });
    const after = await desk.getState();
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.result.next).toBe(PIN_FAILED);
      expect(after.result.notes).toEqual(PRACTICE_CONFIRMED);
    }
    expect(sms.sent.filter((text) => text.body === privatePin).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(posts.filter((text) => text.body === privatePin).map((text) => text.body)).toEqual([]);
    expect(sms.sent.filter((text) => text.to === LIVE_HOST && (text.body === privatePin || text.body === PIN_FAILED || text.body === line)).map((text) => text.body)).toEqual([PIN_FAILED]);
  });

  it("hides the private note after an undelivered report and returns the failed-send sentence", async () => {
    const { desk, sms, posts, pinKey, privatePin } = await privateSendWithoutHost();
    const line = "Maria got the door code privately.";
    const left = await desk.markGuestsLeft({ confirmed: true }, pinKey);
    expect(left).toEqual({ ok: true, result: { next: PIN_SENT } });
    const pinText = sms.sent.find((text) => text.body === privatePin);
    await desk.notePinDelivery({ sid: pinText?.sid ?? "", status: "sent" });
    const pendingNote = await desk.getState();
    expect(pendingNote.ok).toBe(true);
    if (pendingNote.ok) expect(pendingNote.result.notes).toEqual(PRACTICE_CONFIRMED);
    await desk.notePinDelivery({ sid: pinText?.sid ?? "", status: "delivered" });
    const shown = await desk.getState();
    expect(shown.ok).toBe(true);
    if (shown.ok) {
      expect(shown.result.notes).toEqual([...PRACTICE_CONFIRMED, line]);
      expect(shown.result.next).toBe(AFTER_CHECKS);
    }
    await desk.notePinDelivery({ sid: pinText?.sid ?? "", status: "undelivered" });
    const hidden = await desk.getState();
    expect(hidden.ok).toBe(true);
    if (hidden.ok) {
      expect(hidden.result.notes).toEqual(PRACTICE_CONFIRMED);
      expect(hidden.result.next).toBe(PIN_FAILED);
    }
    expect(sms.sent.filter((text) => text.body === privatePin).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(posts.filter((text) => text.body === privatePin).map((text) => text.body)).toEqual([]);
    expect(sms.sent.filter((text) => text.to === LIVE_HOST && (text.body === privatePin || text.body === line || text.body === PIN_FAILED)).map((text) => text.body)).toEqual([PIN_FAILED]);
  });

  function notesOf(reply: { ok: boolean; result?: Record<string, unknown> }): string[] {
    if (!reply.ok || !reply.result) return [];
    const notes = reply.result.notes;
    return Array.isArray(notes) ? notes.filter((line): line is string => typeof line === "string") : [];
  }

  function hostBodies(sent: { to: string; body: string }[]): string[] {
    return sent.filter((text) => text.to === LIVE_HOST).map((text) => text.body);
  }

  async function readyPractice(group: boolean, decide?: (body: string) => string, withContact = false) {
    const root = mkdtempSync(join(tmpdir(), "cleaner-host-notes-"));
    roots.push(root);
    const sms = fakeSms(decide);
    const fetchBox = groupFetch();
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      ...(group ? { CLEANER_CORE_GROUP_CHAT: "1" } : { CLEANER_CORE_GROUP_CHAT: "0" }),
      CLEANER_CORE_SMS_ALLOWLIST: withContact ? `${LIVE_HOST},${LIVE_CLEANER},${OBSERVER}` : `${LIVE_HOST},${LIVE_CLEANER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
      PUBLIC_BASE_URL: PUBLIC,
    };
    setCleanerTwilioClient(sms);
    setCleanerGroupFetch(fetchBox.impl);
    setCleanerCalendarFetch(async (url) => ({
      status: url === CALENDAR_URL ? 200 : 404,
      url,
      async text() {
        return url === CALENDAR_URL ? CALENDAR_ICS : "";
      },
    }));
    const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
    const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
    expect((await desk.getState("cleaners")).ok).toBe(true);
    expect((await desk.saveProperty({ business: "Harbor", address: PRACTICE, timeZone: "America/New_York" })).ok).toBe(true);
    expect((await desk.savePeople({ host: LIVE_HOST, cleaner: LIVE_CLEANER, cleanerName: "Maria", observer: OBSERVER, doorCodeTo: "cleaner" })).ok).toBe(true);
    expect((await desk.saveCalendarLink({ url: CALENDAR_URL })).ok).toBe(true);
    expect((await desk.saveDoorCode({ code: DOOR_CODE }, pinKey)).ok).toBe(true);
    expect((await desk.setUpTexting()).ok).toBe(true);
    expect((await desk.runChecks()).ok).toBe(true);
    await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" });
    return { desk, sms, posts: fetchBox.posts, pinKey, root };
  }

  it("texts the injury alert and the cleaner opt-out note, and keeps every other host line off SMS", async () => {
    const pinHeld = "The cleaner opted out, so the door code wasn't sent. Please reach them directly.";
    const stopHold = `The cleaner opted out of cleaning texts for ${PRACTICE}, so the cleaning is on hold. Find another cleaner or reach them directly, then tell your Grok Bot to restart it.`;
    const hostHurt = `The cleaner at ${PRACTICE} says someone is hurt. They've been told to call 911.`;
    const cleanerHurt = "If someone is hurt, call 911 now. I've let the host know.";
    const direct = "Got it. To send the door code, tell your Grok Bot the guests have left. The cleaner is still waiting for the OK.";
    const resume = resumeNote(PRACTICE);
    const hold = waitingForYesNote(PRACTICE);
    const solo = await readyPractice(false);
    await solo.desk.inbound({ id: "solo-yes-offer", from: LIVE_CLEANER, text: "YES" });
    await solo.desk.inbound({ id: "solo-yes-schedule", from: LIVE_CLEANER, text: "YES" });
    const hurt = await solo.desk.inbound({ id: "solo-hurt", from: LIVE_CLEANER, text: "I fell at 2:00 PM and I'm hurt" });
    expect(hurt.sent.filter((text) => text.to === LIVE_CLEANER).map((text) => text.body)).toEqual([cleanerHurt]);
    expect(notesOf(await solo.desk.getState())).toContain(hostHurt);
    await solo.desk.inbound({ id: "solo-stop", from: LIVE_CLEANER, text: "STOP" });
    expect(notesOf(await solo.desk.getState())).toContain(stopHold);
    const held = await solo.desk.markGuestsLeft({ confirmed: true }, solo.pinKey);
    expect(held).toEqual({ ok: true, result: { next: pinHeld } });
    expect(notesOf(await solo.desk.getState())).toContain(pinHeld);
    expect(solo.sms.sent.filter((text) => text.body.includes("Door code:"))).toEqual([]);
    const started = await solo.desk.inbound({ id: "solo-start", from: LIVE_CLEANER, text: "START" });
    expect(started.sent.map((text) => text.body)).toEqual([
      "You're opted back in. Reply YES if you still want this turnover. Reply STOP to opt out.",
    ]);
    expect(solo.sms.sent.filter((text) => text.body.includes("Door code:"))).toEqual([]);
    await solo.desk.inbound({ id: "solo-direct", from: LIVE_HOST, text: "guests left" });
    expect(notesOf(await solo.desk.getState())).toContain(direct);
    const injuryHold = `The cleaning at ${PRACTICE} is on hold because the cleaner reported an injury. Once everyone's okay, tell your Grok Bot to restart it.`;
    expect(hostBodies(solo.sms.sent)).toEqual([hostHurt, injuryHold, stopHold]);
    expect(solo.sms.sent.filter((text) => text.body === pinHeld || text.body === direct || text.body === hold || text.body === resume)).toEqual([]);
    expect(solo.posts.map((text) => text.body)).toEqual([]);

    const waiting = await readyPractice(false);
    expect(notesOf(await waiting.desk.getState())).toContain(hold);
    expect(hostBodies(waiting.sms.sent)).toEqual([]);

    const failed = await readyPractice(false, (body) => (body.includes("Door code:") ? "failed" : "queued"));
    await failed.desk.inbound({ id: "fail-yes-offer", from: LIVE_CLEANER, text: "YES" });
    await failed.desk.inbound({ id: "fail-yes-schedule", from: LIVE_CLEANER, text: "YES" });
    const missed = await failed.desk.markGuestsLeft({ confirmed: true }, failed.pinKey);
    expect(missed).toEqual({ ok: true, result: { next: PIN_FAILED } });
    expect(notesOf(await failed.desk.getState()).join("\n").includes("Door code")).toBe(false);
    expect(hostBodies(failed.sms.sent)).toEqual([PIN_FAILED]);
    expect(failed.sms.sent.filter((text) => text.to === LIVE_HOST && text.body.includes("Door code:"))).toEqual([]);

    const grouped = await readyPractice(true);
    await grouped.desk.inbound({ id: "group-yes-offer", from: LIVE_CLEANER, text: "YES" });
    await grouped.desk.inbound({ id: "group-yes-schedule", from: LIVE_CLEANER, text: "YES" });
    expect(notesOf(await grouped.desk.getState())).toEqual([hold, PRACTICE_YES]);
    // A problem from the cleaner goes to Grok, which asks Cory. Only Cory's yes holds the cleaning.
    await grouped.desk.inbound({ id: "group-problem", from: LIVE_CLEANER, text: "The lock is broken", channel: "group" });
    const notHeld = await grouped.desk.getTurns();
    expect(notHeld.ok && notHeld.result.held).toBeFalsy();
    const problemHold = jobHoldLine(PRACTICE);
    const paused = await approvedOnDesk((confirmation) => grouped.desk.holdJob(confirmation ? { confirmation } : {}));
    expect(paused).toEqual({ ok: true, result: expect.objectContaining({ next: problemHold }) });
    // The hold line to the cleaner is a group post. The landlord's resume, opt-out and door-code notes never are.
    expect(grouped.posts.filter((text) => text.body === problemHold)).toHaveLength(1);
    expect(grouped.posts.filter((text) => text.body === resume || text.body === stopHold || text.body === pinHeld)).toEqual([]);
    const resumed = await resumeApproved(grouped.desk);
    expect(resumed).toEqual({ ok: true, result: { next: resume } });
    expect(notesOf(await grouped.desk.getState())).toContain(resume);
    const groupHurt = await grouped.desk.inbound({ id: "group-hurt", from: LIVE_CLEANER, text: "I fell at 2:00 PM and I'm hurt", channel: "group" });
    // Both 911 lines go into the group. The time the cleaner mentioned does not.
    expect(groupHurt.sent.filter((text) => text.kind === "emergency" && text.to === LIVE_CLEANER).map((text) => text.body)).toEqual([hostHurt, cleanerHurt]);
    expect(grouped.posts.filter((text) => text.body === hostHurt)).toHaveLength(1);
    expect(grouped.posts.filter((text) => /2:00 PM/.test(text.body))).toEqual([]);
    expect(notesOf(await grouped.desk.getState())).toContain(hostHurt);
    await grouped.desk.inbound({ id: "group-stop", from: LIVE_CLEANER, text: "STOP" });
    expect(notesOf(await grouped.desk.getState())).toContain(stopHold);
    const groupHeld = await grouped.desk.markGuestsLeft({ confirmed: true }, grouped.pinKey);
    expect(groupHeld).toEqual({ ok: true, result: { next: pinHeld } });
    expect(notesOf(await grouped.desk.getState())).toContain(pinHeld);
    expect(hostBodies(grouped.sms.sent)).toEqual([injuryHold, stopHold]);
    expect(grouped.posts.filter((text) => text.body.includes("Door code:") || text.body === PRIVATE_LINE)).toEqual([]);
    expect(grouped.sms.sent.filter((text) => text.to === LIVE_HOST && (text.body.includes("Door code:") || text.body === pinHeld || text.body === resume || text.body === hold))).toEqual([]);
  });

  it("shows the private line only after a delivered report and never posts it to the group", async () => {
    const { desk, sms, posts, pinKey, privatePin } = await privateSendWithoutHost();
    const line = "Maria got the door code privately.";
    const before = notesOf(await desk.getState());
    expect(before.filter((item) => item === line)).toEqual([]);
    const left = await desk.markGuestsLeft({ confirmed: true }, pinKey);
    expect(left).toEqual({ ok: true, result: { next: PIN_SENT } });
    const pinText = sms.sent.find((text) => text.body === privatePin);
    expect(sms.sent.filter((text) => text.body === privatePin).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(posts.map((text) => text.body).filter((body) => body === line)).toEqual([]);
    expect(hostBodies(sms.sent)).toEqual([]);
    await desk.notePinDelivery({ sid: pinText?.sid ?? "", status: "sent" });
    expect(notesOf(await desk.getState())).toEqual(before);
    const again = await desk.markGuestsLeft({ confirmed: true }, pinKey);
    expect(again).toEqual({ ok: true, result: { next: ALREADY } });
    expect(sms.sent.filter((text) => text.body === privatePin)).toHaveLength(1);
    await desk.notePinDelivery({ sid: pinText?.sid ?? "", status: "delivered" });
    expect(notesOf(await desk.getState())).toEqual([...before, line]);
    expect(posts.map((text) => text.body).filter((body) => body === line || body.includes("Door code:"))).toEqual([]);
    await desk.notePinDelivery({ sid: pinText?.sid ?? "", status: "undelivered" });
    const hidden = await desk.getState();
    expect(hidden.ok).toBe(true);
    if (hidden.ok) {
      expect(hidden.result.next).toBe(PIN_FAILED);
      expect(notesOf(hidden)).toEqual(before);
    }
    expect(sms.sent.filter((text) => text.body === privatePin)).toHaveLength(1);
  });

  it("names a dropped group text with a fixed topic and does not quote it", async () => {
    const { desk, posts } = await readyPractice(true);
    await desk.inbound({ id: "topic-yes-offer", from: LIVE_CLEANER, text: "YES" });
    await desk.inbound({ id: "topic-yes-schedule", from: LIVE_CLEANER, text: "YES" });
    const fetchBoxPosts = posts;
    const blocked = groupFetch();
    blocked.blockMembership();
    setCleanerGroupFetch(blocked.impl);
    const marker = plainFour([DOOR_CODE, ...SCRATCH_TENANTS.map((tenant) => tenant.pin)]);
    await postToGroup(desk, `Unit ${marker} is ready for you.`);
    await postToGroup(desk, `Unit ${marker} is ready for you now.`);
    expect(notesOf(await desk.getState()).filter((line) => line.startsWith("I couldn't send"))).toEqual(["I couldn't send your message to the group."]);
    const alert = notesOf(await desk.getState()).find((line) => line.startsWith("I couldn't send")) ?? "";
    expect(alert).toBe("I couldn't send your message to the group.");
    expect(alert.includes(marker)).toBe(false);
    expect(alert.includes("2:00")).toBe(false);
    expect(alert.includes("unit")).toBe(false);
    expect(alert.includes("Can we do")).toBe(false);
    expect(alert.includes("Door code")).toBe(false);
    expect(notesOf(await desk.getState()).join("\n").includes(marker)).toBe(false);
    expect(blocked.posts.map((text) => text.body)).toEqual([]);
    expect(fetchBoxPosts.map((text) => text.body).filter((body) => body.includes("2:00"))).toEqual([]);
  });

  async function clocks(desk: { getTurns(): Promise<{ ok: boolean; result?: Record<string, unknown> }> }): Promise<string[]> {
    const reply = await desk.getTurns();
    if (!reply.ok || !Array.isArray(reply.result?.turns)) return [];
    return reply.result.turns.flatMap((turn) => {
      if (!turn || typeof turn !== "object" || !("checkoutTime" in turn)) return [];
      const time = (turn as { checkoutTime?: unknown }).checkoutTime;
      return typeof time === "string" ? [time] : [];
    });
  }

  it("texts Cory one injury alert and one STOP confirmation when he is opted in", async () => {
    const hostHurt = `The cleaner at ${PRACTICE} says someone is hurt. They've been told to call 911.`;
    const hostStop = `You're opted out of cleaning texts for ${PRACTICE}, and the cleaning there is on hold. Reply START to get texts again.`;
    const hostStart = `You'll get cleaning texts for ${PRACTICE} again. The cleaning is still on hold. Tell your Grok Bot to restart it.`;
    const checkout = `Is checkout at ${PRACTICE} on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.`;
    const checkin = `Is check-in at ${PRACTICE} on Sunday, Oct 18 still 4:00 PM? Reply YES or send the new time.`;
    const pinHeld = "The cleaner opted out, so the door code wasn't sent. Please reach them directly.";
    const dropped = "I couldn't send your message to the group.";
    const resume = resumeNote(PRACTICE);
    const hold = waitingForYesNote(PRACTICE);
    const grouped = await readyPractice(true);
    await grouped.desk.inbound({ id: "safety-offer", from: LIVE_CLEANER, text: "YES" });
    await grouped.desk.inbound({ id: "safety-host", from: LIVE_HOST, text: "YES" });
    await grouped.desk.inbound({ id: "safety-schedule", from: LIVE_CLEANER, text: "YES" });
    const blocked = groupFetch();
    blocked.blockMembership();
    setCleanerGroupFetch(blocked.impl);
    await postToGroup(grouped.desk, NOTE);
    expect(notesOf(await grouped.desk.getState())).toContain(dropped);
    const hurt = await grouped.desk.inbound({ id: "safety-hurt", from: LIVE_CLEANER, text: "I fell at 2:00 PM and I'm hurt", channel: "group" });
    const injuryHold = `The cleaning at ${PRACTICE} is on hold because the cleaner reported an injury. Once everyone's okay, tell your Grok Bot to restart it.`;
    expect(hurt.sent.filter((text) => text.to === LIVE_HOST).map((text) => text.body)).toEqual([hostHurt, injuryHold]);
    const repeat = await grouped.desk.inbound({ id: "safety-hurt-again", from: LIVE_CLEANER, text: "I fell at 2:00 PM and I'm hurt", channel: "group" });
    expect(repeat.sent).toEqual([]);
    await grouped.desk.inbound({ id: "safety-stop", from: LIVE_HOST, text: "STOP" });
    const started = await grouped.desk.inbound({ id: "safety-start", from: LIVE_HOST, text: "START" });
    expect(started.sent.map((text) => text.body)).toEqual([hostStart]);
    expect(hostBodies(grouped.sms.sent)).toEqual([hostHurt, injuryHold, hostStop, hostStart]);
    await grouped.desk.inbound({ id: "safety-cleaner-stop", from: LIVE_CLEANER, text: "STOP" });
    expect(await grouped.desk.getTurns()).toEqual({ ok: true, result: expect.objectContaining({ held: true }) });
    const ignored = await grouped.desk.inbound({ id: "safety-cleaner-start", from: LIVE_CLEANER, text: "START" });
    expect(ignored.sent).toEqual([]);
    expect(await grouped.desk.getTurns()).toEqual({ ok: true, result: expect.objectContaining({ held: true }) });
    const held = await grouped.desk.markGuestsLeft({ confirmed: true }, grouped.pinKey);
    expect(held).toEqual({ ok: true, result: { next: pinHeld } });
    const resumed = await resumeApproved(grouped.desk);
    expect(resumed).toEqual({ ok: true, result: { next: resume } });
    expect(notesOf(await grouped.desk.getState())).toContain(resume);
    expect(await grouped.desk.getTurns()).toEqual({ ok: true, result: expect.objectContaining({ held: true }) });
    expect(grouped.sms.sent.filter((text) => text.to === LIVE_HOST && text.body === hostHurt)).toHaveLength(1);
    expect(grouped.sms.sent.filter((text) => text.to === LIVE_HOST && text.body === hostStop)).toHaveLength(1);
    expect(grouped.sms.sent.filter((text) => text.to === LIVE_HOST && text.body === hostStart)).toHaveLength(1);
    expect(grouped.sms.sent.filter((text) => text.to === LIVE_HOST && (text.body === checkout || text.body === checkin || text.body === resume || text.body === pinHeld || text.body === PIN_FAILED || text.body === dropped || text.body === hold))).toEqual([]);
    expect(grouped.sms.sent.filter((text) => text.body.includes("Door code:") || (text.to === LIVE_HOST && text.body === pinHeld))).toEqual([]);
    expect(blocked.posts.filter((text) => text.body === hostHurt || text.body === hostStop || text.body === hostStart || text.body.includes("Door code:"))).toEqual([]);

    const failed = await readyPractice(false, (body) => (body.includes("Door code:") ? "failed" : "queued"));
    await failed.desk.inbound({ id: "safety-fail-offer", from: LIVE_CLEANER, text: "YES" });
    await failed.desk.inbound({ id: "safety-fail-schedule", from: LIVE_CLEANER, text: "YES" });
    const missed = await failed.desk.markGuestsLeft({ confirmed: true }, failed.pinKey);
    expect(missed).toEqual({ ok: true, result: { next: PIN_FAILED } });
    expect(failed.sms.sent.filter((text) => text.to === LIVE_HOST).map((text) => text.body)).toEqual([PIN_FAILED]);

    const solo = await readyPractice(false);
    expect(notesOf(await solo.desk.getState())).not.toContain(checkin);
    expect(solo.sms.sent.filter((text) => text.body === checkout || text.body === checkin)).toEqual([]);
  });

  it("gives Cory every host-only kind through get_state and texts only safety lines", async () => {
    const pinHeld = "The cleaner opted out, so the door code wasn't sent. Please reach them directly.";
    const hostHurt = `The cleaner at ${PRACTICE} says someone is hurt. They've been told to call 911.`;
    const cleanerHurt = "If someone is hurt, call 911 now. I've let the host know.";
    const direct = "Got it. To send the door code, tell your Grok Bot the guests have left. The cleaner is still waiting for the OK.";
    const resume = resumeNote(PRACTICE);
    const hold = waitingForYesNote(PRACTICE);
    const review = `I saved a manual Airbnb booking exception for ${PRACTICE}. I did not change the cleaning until you confirm it.`;
    const hostStop = `You're opted out of cleaning texts for ${PRACTICE}, and the cleaning there is on hold. Reply START to get texts again.`;
    const checkin = `Is check-in at ${PRACTICE} on Sunday, Oct 18 still 4:00 PM? Reply YES or send the new time.`;

    const solo = await readyPractice(false);
    expect(notesOf(await solo.desk.getState())).toEqual([hold]);
    await solo.desk.inbound({ id: "kinds-solo-yes-offer", from: LIVE_CLEANER, text: "YES" });
    await solo.desk.inbound({ id: "kinds-solo-yes-schedule", from: LIVE_CLEANER, text: "YES" });
    const hurt = await solo.desk.inbound({ id: "kinds-solo-hurt", from: LIVE_CLEANER, text: "I fell at 2:00 PM and I'm hurt" });
    expect(hurt.sent.filter((text) => text.to === LIVE_CLEANER).map((text) => text.body)).toEqual([cleanerHurt]);
    expect(notesOf(await solo.desk.getState())).toContain(hostHurt);
    await solo.desk.inbound({ id: "kinds-solo-stop", from: LIVE_CLEANER, text: "STOP" });
    expect(notesOf(await solo.desk.getState())).toContain(PRACTICE_STOP);
    expect(await solo.desk.getTurns()).toEqual({ ok: true, result: expect.objectContaining({ held: true }) });
    const held = await solo.desk.markGuestsLeft({ confirmed: true }, solo.pinKey);
    expect(held).toEqual({ ok: true, result: { next: pinHeld } });
    expect(notesOf(await solo.desk.getState())).toContain(pinHeld);
    const started = await solo.desk.inbound({ id: "kinds-solo-start", from: LIVE_CLEANER, text: "START" });
    expect(started.sent.map((text) => text.body)).toEqual([
      "You're opted back in. Reply YES if you still want this turnover. Reply STOP to opt out.",
    ]);
    expect(solo.sms.sent.filter((text) => text.body.includes("Door code:"))).toEqual([]);
    await solo.desk.inbound({ id: "kinds-solo-direct", from: LIVE_HOST, text: "guests left" });
    expect(notesOf(await solo.desk.getState())).toContain(direct);
    const injuryHold = `The cleaning at ${PRACTICE} is on hold because the cleaner reported an injury. Once everyone's okay, tell your Grok Bot to restart it.`;
    expect(hostBodies(solo.sms.sent)).toEqual([hostHurt, injuryHold, PRACTICE_STOP]);
    expect(solo.sms.sent.filter((text) => text.body === checkin || text.body === pinHeld || text.body === direct || text.body === hold)).toEqual([]);

    const failed = await readyPractice(false, (body) => (body.includes("Door code:") ? "failed" : "queued"));
    await failed.desk.inbound({ id: "kinds-fail-yes-offer", from: LIVE_CLEANER, text: "YES" });
    await failed.desk.inbound({ id: "kinds-fail-yes-schedule", from: LIVE_CLEANER, text: "YES" });
    const missed = await failed.desk.markGuestsLeft({ confirmed: true }, failed.pinKey);
    expect(missed).toEqual({ ok: true, result: { next: PIN_FAILED } });
    expect(notesOf(await failed.desk.getState()).join("\n").includes("Door code")).toBe(false);
    expect(hostBodies(failed.sms.sent)).toEqual([PIN_FAILED]);

    const sentPin = await readyPractice(false);
    await sentPin.desk.inbound({ id: "kinds-pin-yes-offer", from: LIVE_CLEANER, text: "YES" });
    await sentPin.desk.inbound({ id: "kinds-pin-yes-schedule", from: LIVE_CLEANER, text: "YES" });
    const left = await sentPin.desk.markGuestsLeft({ confirmed: true }, sentPin.pinKey);
    expect(left).toEqual({ ok: true, result: { next: PIN_SENT } });
    const again = await sentPin.desk.markGuestsLeft({ confirmed: true }, sentPin.pinKey);
    expect(again).toEqual({ ok: true, result: { next: ALREADY } });
    expect(sentPin.sms.sent.filter((text) => text.body.includes("Door code:")).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(notesOf(await sentPin.desk.getState()).join("\n").includes("Door code")).toBe(false);
    expect(hostBodies(sentPin.sms.sent)).toEqual([]);

    const grouped = await readyPractice(true);
    expect(notesOf(await grouped.desk.getState())).toEqual([hold]);
    await grouped.desk.inbound({ id: "kinds-group-yes-offer", from: LIVE_CLEANER, text: "YES" });
    await grouped.desk.inbound({ id: "kinds-host-yes", from: LIVE_HOST, text: "YES" });
    await grouped.desk.inbound({ id: "kinds-group-yes-schedule", from: LIVE_CLEANER, text: "YES" });
    expect(await clocks(grouped.desk)).toEqual(["11:00 AM"]);
    await grouped.desk.inbound({ id: "kinds-group-time", from: LIVE_CLEANER, text: "Let's say 2:00 PM", channel: "group" });
    expect(await clocks(grouped.desk)).toEqual(["11:00 AM"]);
    await grouped.desk.inbound({ id: "kinds-group-problem", from: LIVE_CLEANER, text: "The lock is broken", channel: "group" });
    expect((await approvedOnDesk((confirmation) => grouped.desk.holdJob(confirmation ? { confirmation } : {}))).ok).toBe(true);
    expect(notesOf(await grouped.desk.getState())).toContain(hold);
    const ignored = await grouped.desk.inbound({ id: "kinds-group-start", from: LIVE_CLEANER, text: "START" });
    expect(ignored.sent.map((text) => text.body)).toEqual([
      "The cleaning is on hold. I'll send an update when it can start again.",
    ]);
    expect(notesOf(await grouped.desk.getState()).includes(resume)).toBe(false);
    const groupHurt = await grouped.desk.inbound({ id: "kinds-group-hurt", from: LIVE_CLEANER, text: "I fell at 2:00 PM and I'm hurt", channel: "group" });
    // Both 911 lines go into the group.
    expect(groupHurt.sent.filter((text) => text.to === LIVE_CLEANER).map((text) => text.body)).toEqual([hostHurt, cleanerHurt]);
    expect(notesOf(await grouped.desk.getState())).toContain(hostHurt);
    await grouped.desk.inbound({ id: "kinds-group-review", from: LIVE_HOST, text: "booked on airbnb" });
    expect(notesOf(await grouped.desk.getState())).toContain(review);
    await grouped.desk.inbound({ id: "kinds-group-stop", from: LIVE_CLEANER, text: "STOP" });
    expect(notesOf(await grouped.desk.getState())).toContain(PRACTICE_STOP);
    expect(await grouped.desk.getTurns()).toEqual({ ok: true, result: expect.objectContaining({ held: true }) });
    const stillHeld = await grouped.desk.inbound({ id: "kinds-group-start-again", from: LIVE_CLEANER, text: "START" });
    expect(stillHeld.sent.map((text) => text.body)).toEqual([]);
    expect(await grouped.desk.getTurns()).toEqual({ ok: true, result: expect.objectContaining({ held: true }) });
    const groupHeld = await grouped.desk.markGuestsLeft({ confirmed: true }, grouped.pinKey);
    expect(groupHeld).toEqual({ ok: true, result: { next: pinHeld } });
    expect(notesOf(await grouped.desk.getState())).toContain(pinHeld);
    const resumed = await resumeApproved(grouped.desk);
    expect(resumed).toEqual({ ok: true, result: { next: resume } });
    expect(notesOf(await grouped.desk.getState())).toContain(resume);
    await grouped.desk.inbound({ id: "kinds-host-stop", from: LIVE_HOST, text: "STOP" });
    expect(notesOf(await grouped.desk.getState())).toContain(hostStop);
    // The injury alert for the landlord is a group post now, not a text to the landlord.
    expect(grouped.sms.sent.filter((text) => text.to === LIVE_HOST && text.body === hostHurt)).toEqual([]);
    expect(grouped.posts.filter((text) => text.body === hostHurt)).toHaveLength(1);
    expect(grouped.sms.sent.filter((text) => text.to === LIVE_HOST && text.body === hostStop)).toHaveLength(1);
    expect(hostBodies(grouped.sms.sent)).toEqual([injuryHold, PRACTICE_STOP, hostStop]);
    // The hold note for the cleaner is a group post now. The landlord's own lines never are.
    expect(grouped.posts.filter((text) => text.body === resume || text.body === pinHeld || text.body === review || text.body === hostStop || text.body === PRIVATE_LINE || text.body.includes("Door code:"))).toEqual([]);
    expect(grouped.sms.sent.filter((text) => text.to === LIVE_HOST && (text.body === checkin || text.body === resume || text.body === pinHeld || text.body === PIN_FAILED || text.body === hold || text.body === review || text.body.includes("Door code:")))).toEqual([]);
  });

  it("keeps the private line out of the group on the private route, a failed member check, and an opted-out hold", async () => {
    const line = "Maria got the door code privately.";
    const privatePin = `Guests have left ${PRACTICE}. Door code: ${DOOR_CODE}. This code is only for you. Reply DONE when the cleaning is finished.`;

    // A contact is in the group and the landlord has not chosen the whole group, so the code stays private.
    const pending = await readyPractice(true, undefined, true);
    await pending.desk.inbound({ id: "route-pending-offer", from: LIVE_CLEANER, text: "YES" });
    await pending.desk.inbound({ id: "route-pending-contact", from: OBSERVER, text: "YES" });
    await pending.desk.inbound({ id: "route-pending-schedule", from: LIVE_CLEANER, text: "YES" });
    const pendingLeft = await pending.desk.markGuestsLeft({ confirmed: true }, pending.pinKey);
    expect(pendingLeft).toEqual({ ok: true, result: { next: PIN_SENT } });
    const pendingAgain = await pending.desk.markGuestsLeft({ confirmed: true }, pending.pinKey);
    expect(pendingAgain).toEqual({ ok: true, result: { next: ALREADY } });
    expect(pending.sms.sent.filter((text) => text.body === privatePin).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(pending.posts.filter((text) => text.body === line || text.body.includes("Door code:"))).toEqual([]);
    expect(hostBodies(pending.sms.sent)).toEqual([]);
    const pendingSid = pending.sms.sent.find((text) => text.body === privatePin)?.sid ?? "";
    const before = notesOf(await pending.desk.getState());
    await pending.desk.notePinDelivery({ sid: pendingSid, status: "sent" });
    expect(notesOf(await pending.desk.getState())).toEqual(before);
    await pending.desk.notePinDelivery({ sid: pendingSid, status: "delivered" });
    expect(notesOf(await pending.desk.getState())).toEqual([...before, line]);
    await pending.desk.notePinDelivery({ sid: pendingSid, status: "failed" });
    const failedNote = await pending.desk.getState();
    expect(failedNote).toEqual({ ok: true, result: expect.objectContaining({ next: PIN_FAILED }) });
    expect(notesOf(failedNote)).toEqual(before);
    expect(pending.posts.filter((text) => text.body === line || text.body.includes("Door code:"))).toEqual([]);

    const blocked = await readyPractice(true);
    await blocked.desk.inbound({ id: "route-block-offer", from: LIVE_CLEANER, text: "YES" });
    await blocked.desk.inbound({ id: "route-block-host", from: LIVE_HOST, text: "YES" });
    await blocked.desk.inbound({ id: "route-block-schedule", from: LIVE_CLEANER, text: "YES" });
    const blockedFetch = groupFetch();
    blockedFetch.blockMembership();
    setCleanerGroupFetch(blockedFetch.impl);
    const blockedLeft = await blocked.desk.markGuestsLeft({ confirmed: true }, blocked.pinKey);
    expect(blockedLeft).toEqual({ ok: true, result: { next: PIN_SENT } });
    expect(blocked.sms.sent.filter((text) => text.body === privatePin).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(blockedFetch.posts.filter((text) => text.body === line || text.body.includes("Door code:"))).toEqual([]);
    expect(blocked.posts.filter((text) => text.body === line || text.body.includes("Door code:"))).toEqual([]);
    const blockedSid = blocked.sms.sent.find((text) => text.body === privatePin)?.sid ?? "";
    await blocked.desk.notePinDelivery({ sid: blockedSid, status: "sent" });
    expect(notesOf(await blocked.desk.getState()).includes(line)).toBe(false);
    await blocked.desk.notePinDelivery({ sid: blockedSid, status: "undelivered" });
    const undelivered = await blocked.desk.getState();
    expect(undelivered).toEqual({ ok: true, result: expect.objectContaining({ next: PIN_FAILED }) });
    expect(notesOf(undelivered).includes(line)).toBe(false);
    expect(hostBodies(blocked.sms.sent)).toEqual([PIN_FAILED]);

    const hostOut = await readyPractice(true);
    await hostOut.desk.inbound({ id: "route-out-offer", from: LIVE_CLEANER, text: "YES" });
    await hostOut.desk.inbound({ id: "route-out-host", from: LIVE_HOST, text: "YES" });
    await hostOut.desk.inbound({ id: "route-out-schedule", from: LIVE_CLEANER, text: "YES" });
    await hostOut.desk.inbound({ id: "route-out-stop", from: LIVE_HOST, text: "STOP" });
    const hostHeld = await hostOut.desk.markGuestsLeft({ confirmed: true }, hostOut.pinKey);
    expect(hostHeld).toEqual({ ok: true, result: { next: `The cleaning at ${PRACTICE} is on hold because you opted out of texts. Tell your Grok Bot to restart it.` } });
    expect(hostOut.sms.sent.filter((text) => text.body === privatePin)).toEqual([]);
    await resumeApproved(hostOut.desk);
    const hostLeft = await hostOut.desk.markGuestsLeft({ confirmed: true }, hostOut.pinKey);
    expect(hostLeft).toEqual({ ok: true, result: { next: PIN_SENT } });
    expect(hostOut.sms.sent.filter((text) => text.body === privatePin).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(hostOut.posts.filter((text) => text.body === line || text.body.includes("Door code:"))).toEqual([]);
    const hostSid = hostOut.sms.sent.find((text) => text.body === privatePin)?.sid ?? "";
    await hostOut.desk.notePinDelivery({ sid: hostSid, status: "sent" });
    expect(notesOf(await hostOut.desk.getState()).includes(line)).toBe(false);
    await hostOut.desk.notePinDelivery({ sid: hostSid, status: "delivered" });
    expect(notesOf(await hostOut.desk.getState())).toContain(line);
    expect(hostBodies(hostOut.sms.sent)).toEqual([
      `You're opted out of cleaning texts for ${PRACTICE}, and the cleaning there is on hold. Reply START to get texts again.`,
    ]);
    expect(hostOut.posts.filter((text) => text.body === line)).toEqual([]);
  });

  it("texts Cory his STOP confirmation and a later injury alert, and keeps the other notes off SMS", async () => {
    const pinHeld = "The cleaner opted out, so the door code wasn't sent. Please reach them directly.";
    const resume = `The cleaning at ${PRACTICE} is back on.`;
    const review = `I saved a manual Airbnb booking exception for ${PRACTICE}. I did not change the cleaning until you confirm it.`;
    const hostHurt = `The cleaner at ${PRACTICE} says someone is hurt. They've been told to call 911.`;
    const hostStop = `You're opted out of cleaning texts for ${PRACTICE}, and the cleaning there is on hold. Reply START to get texts again.`;
    const grouped = await readyPractice(true);
    await grouped.desk.inbound({ id: "out-offer", from: LIVE_CLEANER, text: "YES" });
    await grouped.desk.inbound({ id: "out-host", from: LIVE_HOST, text: "YES" });
    await grouped.desk.inbound({ id: "out-schedule", from: LIVE_CLEANER, text: "YES" });
    await grouped.desk.inbound({ id: "out-host-stop", from: LIVE_HOST, text: "STOP" });
    await grouped.desk.inbound({ id: "out-cleaner-stop", from: LIVE_CLEANER, text: "STOP" });
    const held = await grouped.desk.markGuestsLeft({ confirmed: true }, grouped.pinKey);
    expect(held).toEqual({ ok: true, result: { next: pinHeld } });
    expect(notesOf(await grouped.desk.getState())).toContain(pinHeld);
    const resumed = await resumeApproved(grouped.desk);
    expect(resumed).toEqual({ ok: true, result: { next: resume } });
    expect(notesOf(await grouped.desk.getState())).toContain(resume);
    const hurt = await grouped.desk.inbound({ id: "out-hurt", from: LIVE_CLEANER, text: "I fell and I'm hurt" });
    expect(hurt.sent.filter((text) => text.to === LIVE_CLEANER).map((text) => text.body)).toEqual([
      "If someone is hurt, call 911 now. I've let the host know.",
    ]);
    expect(notesOf(await grouped.desk.getState())).toContain(hostHurt);
    await grouped.desk.inbound({ id: "out-review", from: LIVE_HOST, text: "booked on airbnb" });
    expect(notesOf(await grouped.desk.getState())).toContain(review);
    const notes = notesOf(await grouped.desk.getState());
    expect(notes.filter((line) => line === pinHeld || line === resume).join("\n").includes("SMS")).toBe(false);
    expect(notes.filter((line) => line === pinHeld || line === resume).join("\n").includes("texted you")).toBe(false);
    expect(notes.filter((line) => line === pinHeld || line === resume).join("\n").includes("routing")).toBe(false);
    const injuryHold = `The cleaning at ${PRACTICE} is on hold because the cleaner reported an injury. Once everyone's okay, tell your Grok Bot to restart it.`;
    expect(notesOf(await grouped.desk.getState())).toContain(PRACTICE_STOP);
    expect(hostBodies(grouped.sms.sent)).toEqual([hostStop, hostHurt, injuryHold]);
    expect(grouped.sms.sent.filter((text) => text.body === pinHeld || text.body === resume || text.body === review || text.body.includes("Door code:"))).toEqual([]);
    expect(grouped.posts.filter((text) => text.body === pinHeld || text.body === resume || text.body === review || text.body === hostHurt)).toEqual([]);
  });

  it("keeps the door code out of get_state through a failed send, a retry, and delivery", async () => {
    let doorSends = 0;
    const { desk, sms, posts, pinKey } = await readyPractice(true, (body) => {
      if (!body.includes("Door code:")) return "queued";
      doorSends += 1;
      return doorSends === 1 ? "failed" : "queued";
    });
    const got = "Maria got the door code privately.";
    const view = async () => JSON.stringify(await desk.getState());
    await desk.inbound({ id: "code-offer", from: LIVE_CLEANER, text: "YES" });
    await desk.inbound({ id: "code-schedule", from: LIVE_CLEANER, text: "YES" });
    const blocked = groupFetch();
    blocked.blockMembership();
    setCleanerGroupFetch(blocked.impl);
    await postToGroup(desk, NOTE);
    expect(notesOf(await desk.getState()).filter((line) => line.startsWith("I couldn't send"))).toEqual([
      "I couldn't send your message to the group.",
    ]);
    expect((await view()).includes(DOOR_CODE)).toBe(false);
    const failed = await desk.markGuestsLeft({ confirmed: true }, pinKey);
    expect(failed).toEqual({ ok: true, result: { next: PIN_FAILED } });
    expect(JSON.stringify(failed).includes(DOOR_CODE)).toBe(false);
    expect((await view()).includes(DOOR_CODE)).toBe(false);
    expect((await view()).includes("got the door code")).toBe(false);
    const retried = await desk.markGuestsLeft({ confirmed: true }, pinKey);
    expect(retried).toEqual({ ok: true, result: { next: PIN_SENT } });
    expect(JSON.stringify(retried).includes(DOOR_CODE)).toBe(false);
    expect((await view()).includes(DOOR_CODE)).toBe(false);
    expect((await view()).includes("got the door code")).toBe(false);
    const sid = sms.sent.find((text) => text.body.includes("Door code:") && text.status !== "failed")?.sid ?? "";
    await desk.notePinDelivery({ sid, status: "sent" });
    expect((await view()).includes("got the door code")).toBe(false);
    expect((await view()).includes(DOOR_CODE)).toBe(false);
    const pending = await desk.getState();
    expect(pending.ok).toBe(true);
    if (pending.ok) expect(pending.result.next).not.toBe(got);
    await desk.notePinDelivery({ sid, status: "delivered" });
    const shown = await desk.getState();
    expect(shown.ok).toBe(true);
    if (shown.ok) {
      expect(shown.result.notes).toContain(got);
      expect(JSON.stringify(shown.result).includes(DOOR_CODE)).toBe(false);
      expect(JSON.stringify(shown.result.next).includes("got")).toBe(false);
    }
    expect(sms.sent.filter((text) => text.body.includes("Door code:")).map((text) => text.to)).toEqual([LIVE_CLEANER, LIVE_CLEANER]);
    expect(hostBodies(sms.sent)).toEqual([PIN_FAILED]);
    expect(posts.filter((text) => text.body.includes(DOOR_CODE) || text.body.includes("got the door code"))).toEqual([]);
    expect(blocked.posts.filter((text) => text.body.includes(DOOR_CODE))).toEqual([]);
  });

  it("seats the host from the texting setup step and not from the calendar or the contacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-texting-seat-"));
    roots.push(root);
    const sms = fakeSms();
    const fetchBox = groupFetch();
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_GROUP_CHAT: "1",
      CLEANER_CORE_SMS_ALLOWLIST: `${LIVE_HOST},${LIVE_CLEANER}`,
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
      PUBLIC_BASE_URL: PUBLIC,
    };
    setCleanerTwilioClient(sms);
    setCleanerGroupFetch(fetchBox.impl);
    setCleanerCalendarFetch(async (url) => ({
      status: url === CALENDAR_URL ? 200 : 404,
      url,
      async text() {
        return url === CALENDAR_URL ? CALENDAR_ICS : "";
      },
    }));
    const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
    const invite = groupInviteBody("Harbor", PRACTICE);
    const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
    expect((await desk.getState("cleaners")).ok).toBe(true);
    expect((await desk.saveProperty({ business: "Harbor", address: PRACTICE, timeZone: "America/New_York" })).ok).toBe(true);
    expect((await desk.savePeople({ host: LIVE_HOST, cleaner: LIVE_CLEANER, cleanerName: "Maria", observer: OBSERVER, doorCodeTo: "cleaner" })).ok).toBe(true);
    expect((await desk.saveCalendarLink({ url: CALENDAR_URL })).ok).toBe(true);
    expect((await desk.saveDoorCode({ code: DOOR_CODE }, pinKey)).ok).toBe(true);
    expect(await desk.runChecks()).toEqual({ ok: false, error: "Set up texting first." });
    expect(sms.sent).toEqual([]);
    expect(fetchBox.posts).toEqual([]);

    expect((await desk.setUpTexting()).ok).toBe(true);
    expect((await desk.runChecks()).ok).toBe(true);
    expect((await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" })).ok).toBe(true);
    await desk.inbound({ id: "texting-seat-yes", from: LIVE_CLEANER, text: "YES" });
    const sid = fetchBox.posts[0]?.conversationSid;
    expect(sms.sent.filter((text) => text.to === LIVE_HOST)).toEqual([]);
    // The observer the host saved gets the same invite (saadvz/PropertyCore#164), and stays out of the group until their YES.
    expect(sms.sent.filter((text) => text.body === invite)).toEqual([
      expect.objectContaining({ to: LIVE_CLEANER, body: invite }),
      expect.objectContaining({ to: OBSERVER, body: invite }),
    ]);
    expect(offerPosts(fetchBox.posts)).toEqual([{ conversationSid: sid, to: [LIVE_HOST, LIVE_CLEANER], body: PRACTICE_GROUP_OFFER }]);
    // The intro starts the group, before the offer.
    expect(fetchBox.posts[0]?.body).toContain("This is the cleaning group for");

    forgetHostSeat(root);
    resetLiveDesks();
    const stillSeated = liveDeskFor(root, () => env, () => new Date(FROZEN));
    await postToGroup(stillSeated, NOTE);
    expect(offerPosts(fetchBox.posts).slice(1)).toEqual([{ conversationSid: sid, to: [LIVE_HOST, LIVE_CLEANER], body: NOTE }]);

    forgetHostSeat(root);
    setSavedTexting(root, false);
    resetLiveDesks();
    const unseated = liveDeskFor(root, () => env, () => new Date(FROZEN));
    await postToGroup(unseated, `${NOTE} Thanks!`);
    // A group of one is a plain text, so no group captures the cleaner's own texts.
    expect(offerPosts(fetchBox.posts).slice(2)).toEqual([]);
    expect(sms.sent.filter((text) => text.body === `${NOTE} Thanks!`).map((text) => text.to)).toEqual([LIVE_CLEANER]);
    expect(sms.sent.filter((text) => text.to === LIVE_HOST)).toEqual([]);
  });
});

function forgetHostSeat(root: string): void {
  const file = join(root, "cleaner-job", "cleaner-core.json");
  const saved = JSON.parse(readFileSync(file, "utf8")) as { hostGroup?: string; tenants?: Record<string, { hostGroup?: string }> };
  delete saved.hostGroup;
  for (const slice of Object.values(saved.tenants ?? {})) delete slice.hostGroup;
  writeFileSync(file, `${JSON.stringify(saved)}\n`);
}

function setSavedTexting(root: string, on: boolean): void {
  const file = join(root, "cleaner-live.json");
  const saved = JSON.parse(readFileSync(file, "utf8")) as { texting?: boolean };
  saved.texting = on;
  writeFileSync(file, `${JSON.stringify(saved)}\n`);
}
