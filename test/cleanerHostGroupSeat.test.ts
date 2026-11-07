import { fixedCodePort } from "../src/cleaner-core/doorPort";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { groupInviteBody, groupIntroBody } from "../src/cleaner-core/cleanerTexts";
import { openCleanerCore, type CleanerCoreOptions, type CleanerText } from "../src/cleaner-core/core";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";

const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const EXTRA = "+15555550122";
const NOW = "2026-10-14T15:00:00.000Z";
const lane = SCRATCH_TENANTS[0];
if (!lane) throw new Error("Scratch Lane is missing");
const PIN = lane.pin;
const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
const OFFER_COPY = "Turnover at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. The cleaner will reply to confirm.";
/** The offer goes once into the group, asking the cleaner by name. */
const GROUP_OFFER = "Turnover at 12 Scratch Lane, Teaneck, NJ 07666 on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Maria, reply YES to schedule it.";
/** The first group text: the intro, then the offer, in one post. */
const introThenOffer = (names: string[]) => `${groupIntroBody(names, "Cory", ADDRESS)}\n\n${GROUP_OFFER}`;
const READY = "The cleaner marked the cleaning at 12 Scratch Lane, Teaneck, NJ 07666 done.";
const PRIVATE_PIN = `Guests have left ${ADDRESS}. Door code: ${PIN}. This code is only for you. Reply DONE when the cleaning is finished.`;
const SOLO_OPT = "Hi, this is Scratch's cleaning scheduler for 12 Scratch Lane, Teaneck, NJ 07666. Reply YES to get cleaning texts, or STOP to opt out.";
const CLEANER_OPT = groupInviteBody("Cory", "12 Scratch Lane, Teaneck, NJ 07666");
const EXTRA_OPT = CLEANER_OPT;
const HOST_HURT = "The cleaner at 12 Scratch Lane, Teaneck, NJ 07666 says someone is hurt. They've been told to call 911.";
const INJURY_HOLD = "The cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is on hold because the cleaner reported an injury. Once everyone's okay, tell your Grok Bot to restart it.";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function box() {
  const sent: CleanerText[] = [];
  return { sent, async send(text: CleanerText) { sent.push(text); } };
}

function options(
  sent: { send(text: CleanerText): void | Promise<void> },
  dataDir?: string,
  group = true,
  consented = true,
  extra = false,
): CleanerCoreOptions {
  return {
    enabled: true,
    property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
    ownerPhone: OWNER,
    cleaner: { phone: CLEANER, approved: true },
    access: fixedCodePort(PIN),
    hostName: "Scratch",
    consented,
    sink: sent,
    now: () => new Date(NOW),
    ...(dataDir ? { dataDir } : {}),
    ...(group ? { groupChat: { hostName: "Cory", cleanerName: "Maria", ...(extra ? { extra: [{ phone: EXTRA, name: "Alex" }] } : {}) } } : {}),
  };
}

function markSavedHostPending(root: string): void {
  const file = join(root, "cleaner-core.json");
  const saved = JSON.parse(readFileSync(file, "utf8")) as { hostGroup?: string };
  saved.hostGroup = "pending";
  writeFileSync(file, `${JSON.stringify(saved)}\n`);
}

describe("host group seat", () => {
  it("sends the group offer and the ready text to the host when he never texts YES", async () => {
    const sent = box();
    const job = openCleanerCore(options(sent));
    await job.pollFeed(FEED);
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await job.receive({ id: "cleaner-yes", from: CLEANER, text: "YES" });
    await job.receive({ id: "schedule", from: CLEANER, text: "YES" });
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    await job.receive({ id: "done", from: CLEANER, text: "DONE" });

    expect(job.transcript().filter((line) => line.startsWith(`${OWNER}:`) && /\bYES\b/.test(line))).toEqual([]);
    expect(sent.sent.filter((text) => text.kind === "opt-in")).toEqual([
      { to: CLEANER, body: CLEANER_OPT, kind: "opt-in" },
    ]);
    expect(sent.sent.filter((text) => text.kind === "offer")).toEqual([
      { to: CLEANER, body: introThenOffer(["Cory", "Maria"]), kind: "offer", channel: "group", audience: [OWNER, CLEANER] },
    ]);
    expect(sent.sent.filter((text) => text.body === READY)).toEqual([
      { to: CLEANER, body: READY, kind: "done", channel: "group", audience: [OWNER, CLEANER] },
    ]);
    // The group holds only the host and the cleaner, so the code goes into it, once.
    expect(sent.sent.filter((text) => text.kind === "pin")).toEqual([
      expect.objectContaining({ to: CLEANER, kind: "pin", channel: "group", audience: [OWNER, CLEANER] }),
    ]);
    expect(sent.sent.filter((text) => text.body.includes(PIN)).map((text) => text.kind)).toEqual(["pin"]);
    expect(job.jobs().some((item) => item.status === "done")).toBe(true);
  });

  it("keeps the host and the opted-in cleaner seated when an existing install turns group mode on", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-host-seat-"));
    roots.push(root);
    const soloSent = box();
    const solo = openCleanerCore(options(soloSent, root, false));
    await solo.pollFeed(FEED);
    expect(soloSent.sent.filter((text) => text.kind === "opt-in")).toEqual([
      { to: CLEANER, body: SOLO_OPT, kind: "opt-in" },
    ]);
    await solo.receive({ id: "solo-yes", from: CLEANER, text: "YES" });

    const sent = box();
    const grouped = openCleanerCore(options(sent, root, true));
    const poll = await grouped.pollFeed(FEED);
    const time = await grouped.receive({ id: "group-time", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    const timeMembers = grouped.groupMembers();

    expect(poll.sent.filter((text) => text.kind === "opt-in" || /Reply YES/.test(text.body))).toEqual([]);
    expect(sent.sent.filter((text) => text.kind === "opt-in" || /Reply YES/.test(text.body))).toEqual([]);
    // Without Grok reading messages the cleaner may get the usual next-step guide. No time line, no hold.
    expect(time.sent.filter((text) => text.kind !== "next")).toEqual([]);
    expect(timeMembers).toEqual([OWNER, CLEANER].sort());
  });

  it("keeps a host who already opted out off the group when group mode turns on", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-host-out-"));
    roots.push(root);
    const soloSent = box();
    const solo = openCleanerCore(options(soloSent, root, false));
    await solo.pollFeed(FEED);
    await solo.receive({ id: "solo-yes", from: CLEANER, text: "YES" });
    await solo.receive({ id: "solo-stop", from: OWNER, text: "STOP" });

    const sent = box();
    const grouped = openCleanerCore(options(sent, root, true));
    const poll = await grouped.pollFeed(FEED);
    const time = await grouped.receive({ id: "group-time", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    const timeMembers = grouped.groupMembers();

    expect(poll.sent.filter((text) => text.to === OWNER || text.kind === "opt-in")).toEqual([]);
    expect(time.sent.filter((text) => text.kind !== "next")).toEqual([]);
    expect(timeMembers).toEqual([CLEANER].sort());
  });

  it("sends the host no group text after he replies STOP", async () => {
    const sent = box();
    const job = openCleanerCore(options(sent));
    await job.pollFeed(FEED);
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await job.receive({ id: "cleaner-yes", from: CLEANER, text: "YES" });
    const before = await job.receive({ id: "before-stop", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    const beforeMembers = job.groupMembers();
    const mark = sent.sent.length;
    const stopped = await job.receive({ id: "host-stop", from: OWNER, text: "STOP" });
    const after = await job.receive({ id: "after-stop", from: CLEANER, text: "Can we do 3:00 PM?", channel: "group" });
    const afterMembers = job.groupMembers();
    expect(before.sent.filter((text) => text.kind !== "next")).toEqual([]);
    expect(beforeMembers).toEqual([OWNER, CLEANER].sort());
    expect(stopped.sent.filter((text) => text.channel === "group")).toEqual([]);
    expect(after.sent.filter((text) => text.kind !== "next")).toEqual([]);
    expect(afterMembers).toEqual([CLEANER].sort());
    expect(sent.sent.slice(mark).filter((text) => text.channel === "group" && (text.to === OWNER || text.audience?.includes(OWNER)))).toEqual([]);
  });

  it("carries a saved in consent into the group and leaves pending and opted-out people out", async () => {
    const optedIn = mkdtempSync(join(tmpdir(), "cleaner-carry-in-"));
    roots.push(optedIn);
    const soloIn = box();
    const solo = openCleanerCore(options(soloIn, optedIn, false));
    await solo.pollFeed(FEED);
    await solo.receive({ id: "carry-yes", from: CLEANER, text: "YES" });
    const carried = box();
    const grouped = openCleanerCore(options(carried, optedIn, true));
    const carriedPoll = await grouped.pollFeed(FEED);
    const carriedTime = await grouped.receive({ id: "carry-time", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    const carriedTimeMembers = grouped.groupMembers();
    expect(carriedPoll.sent.filter((text) => text.kind === "opt-in")).toEqual([]);
    expect(carriedTime.sent.filter((text) => text.kind !== "next")).toEqual([]);
    expect(carriedTimeMembers).toEqual([OWNER, CLEANER].sort());

    const pendingHost = mkdtempSync(join(tmpdir(), "cleaner-carry-pending-host-"));
    roots.push(pendingHost);
    const pendingHostSolo = box();
    const pendingSolo = openCleanerCore(options(pendingHostSolo, pendingHost, false));
    await pendingSolo.pollFeed(FEED);
    await pendingSolo.receive({ id: "pending-host-yes", from: CLEANER, text: "YES" });
    markSavedHostPending(pendingHost);
    const pendingHostSent = box();
    const pendingHostGroup = openCleanerCore(options(pendingHostSent, pendingHost, true));
    const pendingHostTime = await pendingHostGroup.receive({ id: "pending-host-time", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    const pendingHostTimeMembers = pendingHostGroup.groupMembers();
    expect(pendingHostSent.sent.filter((text) => text.to === OWNER)).toEqual([]);
    expect(pendingHostTime.sent.filter((text) => text.kind !== "next")).toEqual([]);
    expect(pendingHostTimeMembers).toEqual([CLEANER].sort());

    const pendingCleaner = mkdtempSync(join(tmpdir(), "cleaner-carry-pending-"));
    roots.push(pendingCleaner);
    const pendingSoloSent = box();
    const waiting = openCleanerCore(options(pendingSoloSent, pendingCleaner, false));
    await waiting.pollFeed(FEED);
    const pendingSent = box();
    const pendingGroup = openCleanerCore(options(pendingSent, pendingCleaner, true));
    const pendingPoll = await pendingGroup.pollFeed(FEED);
    const pendingTime = await pendingGroup.receive({ id: "pending-time", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    const pendingTimeMembers = pendingGroup.groupMembers();
    expect(pendingPoll.sent.filter((text) => text.to === OWNER || text.audience?.includes(CLEANER))).toEqual([]);
    expect(pendingTime.sent.filter((text) => text.kind !== "next")).toEqual([]);
    expect(pendingTimeMembers).toEqual([OWNER].sort());

    const optedOut = mkdtempSync(join(tmpdir(), "cleaner-carry-out-"));
    roots.push(optedOut);
    const outSolo = box();
    const stopped = openCleanerCore(options(outSolo, optedOut, false));
    await stopped.pollFeed(FEED);
    await stopped.receive({ id: "out-yes", from: CLEANER, text: "YES" });
    await stopped.receive({ id: "out-stop", from: CLEANER, text: "STOP" });
    const outSent = box();
    const outGroup = openCleanerCore(options(outSent, optedOut, true));
    const outPoll = await outGroup.pollFeed(FEED);
    const outTime = await outGroup.receive({ id: "out-time", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    const outTimeMembers = outGroup.groupMembers();
    expect(outPoll.sent.filter((text) => text.kind === "opt-in" || text.to === CLEANER)).toEqual([]);
    expect(outTime.sent.filter((text) => text.kind !== "next")).toEqual([]);
    expect(outTimeMembers).toEqual([OWNER].sort());
  });

  it("seats the host from his setup opt-in and not from the calendar or the contacts", async () => {
    const contacts = box();
    const bare = openCleanerCore(options(contacts, undefined, true, false));
    await bare.pollFeed(FEED);
    const bareTime = await bare.receive({ id: "bare-time", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    const bareTimeMembers = bare.groupMembers();
    expect(bareTime.sent).toEqual([]);
    expect(contacts.sent.filter((text) => text.to === OWNER || text.body === OFFER_COPY || text.body.includes(GROUP_OFFER))).toEqual([]);

    const sent = box();
    const job = openCleanerCore(options(sent));
    await job.pollFeed(FEED);
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await job.receive({ id: "setup-cleaner-yes", from: CLEANER, text: "YES" });
    expect(job.transcript().filter((line) => line.startsWith(`${OWNER}:`))).toEqual([]);
    expect(sent.sent.filter((text) => text.kind === "offer")).toEqual([
      { to: CLEANER, body: introThenOffer(["Cory", "Maria"]), kind: "offer", channel: "group", audience: [OWNER, CLEANER] },
    ]);
  });

  it("sends the door code only privately to the approved cleaner while the host is receive-only", async () => {
    const sent = box();
    const job = openCleanerCore(options(sent, undefined, true, true, true));
    await job.pollFeed(FEED);
    await job.receive({ id: "extra-yes", from: EXTRA, text: "YES" });
    await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await job.receive({ id: "cleaner-yes", from: CLEANER, text: "YES" });
    await job.receive({ id: "schedule", from: CLEANER, text: "YES" });
    const left = await job.receive({ id: "left", from: OWNER, text: "guests have left" });

    expect(job.transcript().filter((line) => line.startsWith(`${OWNER}:`) && /\bYES\b/.test(line))).toEqual([]);
    expect(sent.sent.filter((text) => text.kind === "opt-in")).toEqual([
      { to: CLEANER, body: CLEANER_OPT, kind: "opt-in" },
      { to: EXTRA, body: EXTRA_OPT, kind: "opt-in" },
    ]);
    expect(sent.sent.filter((text) => text.kind === "offer")).toEqual([
      { to: CLEANER, body: introThenOffer(["Cory", "Maria", "Alex"]), kind: "offer", channel: "group", audience: [OWNER, CLEANER, EXTRA] },
    ]);
    expect(left.sent.filter((text) => text.kind === "pin")).toEqual([
      { to: CLEANER, body: PRIVATE_PIN, kind: "pin" },
    ]);
    expect(sent.sent.filter((text) => text.kind === "pin")).toEqual([
      { to: CLEANER, body: PRIVATE_PIN, kind: "pin" },
    ]);
    expect(sent.sent.filter((text) => text.channel === "group" && (text.body.includes(PIN) || text.body.includes("Door code")))).toEqual([]);
    expect(sent.sent.filter((text) => text.to === OWNER || text.to === EXTRA).filter((text) => text.body.includes(PIN))).toEqual([]);
  });

  it("drops a person after STOP, still alerts the host to an injury, and does not restore either seat", async () => {
    const hostRoot = mkdtempSync(join(tmpdir(), "cleaner-stop-host-"));
    roots.push(hostRoot);
    const hostSent = box();
    const hostJob = openCleanerCore(options(hostSent, hostRoot, true));
    await hostJob.pollFeed(FEED);
    await hostJob.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await hostJob.receive({ id: "host-seat-yes", from: CLEANER, text: "YES" });
    const hostBefore = await hostJob.receive({ id: "host-before", from: CLEANER, text: "Can we do 2:00 PM?", channel: "group" });
    const hostBeforeMembers = hostJob.groupMembers();
    expect(hostBefore.sent.filter((text) => text.kind !== "next")).toEqual([]);
    expect(hostBeforeMembers).toEqual([OWNER, CLEANER].sort());
    const hostStop = await hostJob.receive({ id: "host-stop", from: OWNER, text: "STOP" });
    const hostAfter = await hostJob.receive({ id: "host-after", from: CLEANER, text: "Can we do 3:00 PM?", channel: "group" });
    const hostAfterMembers = hostJob.groupMembers();
    const hurt = await hostJob.receive({ id: "host-hurt", from: CLEANER, text: "I fell and I'm hurt" });
    expect(hostStop.sent.filter((text) => text.channel === "group")).toEqual([]);
    expect(hostAfter.sent.filter((text) => text.kind !== "next")).toEqual([]);
    expect(hostAfterMembers).toEqual([CLEANER].sort());
    expect(hurt.sent.filter((text) => text.to === OWNER)).toEqual([
      { to: OWNER, body: HOST_HURT, kind: "emergency" },
      { to: OWNER, body: INJURY_HOLD, kind: "emergency" },
    ]);
    expect(hurt.sent.filter((text) => text.channel === "group")).toEqual([]);
    const hostAgain = box();
    const hostReopened = openCleanerCore(options(hostAgain, hostRoot, true));
    const hostRestored = await hostReopened.receive({ id: "host-restored", from: CLEANER, text: "Can we do 4:00 PM?", channel: "group" });
    const hostRestoredMembers = hostReopened.groupMembers();
    expect(hostAgain.sent.filter((text) => text.kind === "opt-in" || text.to === OWNER)).toEqual([]);
    expect(hostRestored.sent.filter((text) => text.kind !== "next")).toEqual([]);
    expect(hostRestoredMembers).toEqual([CLEANER].sort());

    const cleanerRoot = mkdtempSync(join(tmpdir(), "cleaner-stop-cleaner-"));
    roots.push(cleanerRoot);
    const cleanerSent = box();
    const cleanerJob = openCleanerCore(options(cleanerSent, cleanerRoot, true));
    await cleanerJob.pollFeed(FEED);
    await cleanerJob.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
    await cleanerJob.receive({ id: "cleaner-seat-yes", from: CLEANER, text: "YES" });
    await cleanerJob.receive({ id: "cleaner-schedule", from: CLEANER, text: "YES" });
    await cleanerJob.receive({ id: "cleaner-stop", from: CLEANER, text: "STOP" });
    const cleanerAfter = await cleanerJob.receive({ id: "cleaner-after", from: OWNER, text: "Can we do 2:00 PM?", channel: "group" });
    const cleanerAfterMembers = cleanerJob.groupMembers();
    const left = await cleanerJob.receive({ id: "cleaner-left", from: OWNER, text: "guests have left" });
    expect(cleanerAfter.sent.filter((text) => text.kind !== "next")).toEqual([]);
    expect(cleanerAfterMembers).toEqual([OWNER].sort());
    expect(left.sent.filter((text) => text.kind === "pin" || text.to === CLEANER)).toEqual([]);
    const cleanerAgain = box();
    const cleanerReopened = openCleanerCore(options(cleanerAgain, cleanerRoot, true));
    const cleanerPoll = await cleanerReopened.pollFeed(FEED);
    const cleanerRestored = await cleanerReopened.receive({ id: "cleaner-restored", from: OWNER, text: "Can we do 3:00 PM?", channel: "group" });
    const cleanerRestoredMembers = cleanerReopened.groupMembers();
    expect(cleanerPoll.sent.filter((text) => text.kind === "opt-in" || text.to === CLEANER)).toEqual([]);
    expect(cleanerRestored.sent.filter((text) => text.kind !== "next")).toEqual([]);
    expect(cleanerRestoredMembers).toEqual([OWNER].sort());
  });
});
