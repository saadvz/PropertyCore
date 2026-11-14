import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openCleanerCore, type CleanerText } from "../src/cleaner-core/core";
import { fixedCodePort } from "../src/cleaner-core/doorPort";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";

/**
 * Times for one named cleaning, as an Airbnb email gives them (#244), and calling off one cleaning
 * with the host's yes. Only 555 numbers and the Scratch Lane made-up code.
 */

const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const PIN = SCRATCH_TENANTS[0]!.pin;
const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
const ANITA = "stay-anita@guesty.com";
const SAME_DAY = "stay-same-day@guesty.com";

async function cleaning(group = true) {
  const sent: CleanerText[] = [];
  const job = openCleanerCore({
    enabled: true,
    property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
    ownerPhone: OWNER,
    cleaner: { phone: CLEANER, approved: true },
    access: fixedCodePort(PIN),
    hostName: "Scratch",
    consented: true,
    sink: { send: async (text: CleanerText) => void sent.push(text) },
    now: () => new Date("2026-10-14T15:00:00.000Z"),
    grokReadsMessages: true,
    ...(group ? { groupChat: { hostName: "Cory", cleanerName: "Maria" } } : {}),
  });
  await job.pollFeed(FEED);
  if (group) {
    await job.receive({ id: "host-yes", from: OWNER, text: "YES" });
    await job.receive({ id: "cleaner-yes", from: CLEANER, text: "YES" });
  } else {
    await job.receive({ id: "opt-yes", from: CLEANER, text: "YES" });
  }
  return { job, sent };
}

const view = (job: Awaited<ReturnType<typeof cleaning>>["job"], id: string) => job.jobs().find((item) => item.id === id)!;

describe("times for one cleaning", () => {
  it("times the named cleaning, which is then offered with those times", async () => {
    const { job, sent } = await cleaning();
    const before = sent.length;
    const result = await job.setJobTimes({ jobId: ANITA, checkout: 11 * 60, checkIn: 16 * 60 });
    expect(result.applied).toBe(true);
    expect(view(job, ANITA)).toMatchObject({ checkoutTime: "11:00 AM", nextCheckInTime: "4:00 PM", checkInDate: "2026-10-16" });
    expect(sent.slice(before).some((text) => text.kind === "offer" && text.body.includes("Checkout 11:00 AM, next guest 4:00 PM"))).toBe(true);
  });

  it("times only the side it's given, and a later cleaning without touching the first", async () => {
    const { job } = await cleaning();
    await job.setJobTimes({ jobId: SAME_DAY, checkout: 12 * 60 });
    expect(view(job, SAME_DAY).checkoutTime).toBe("12:00 PM");
    expect(view(job, SAME_DAY).nextCheckInTime).toBeNull();
    expect(view(job, ANITA).checkoutTime).toBeNull();
  });

  it("moves a confirmed cleaning's window through the existing update", async () => {
    const { job, sent } = await cleaning();
    await job.setJobTimes({ jobId: ANITA, checkout: 11 * 60, checkIn: 16 * 60 });
    await job.receive({ id: "take-it", from: CLEANER, text: "YES" });
    expect(view(job, ANITA).status).toBe("confirmed");
    const before = sent.length;
    const moved = await job.setJobTimes({ jobId: ANITA, checkout: 12 * 60 });
    expect(moved.applied).toBe(true);
    expect(view(job, ANITA).checkoutTime).toBe("12:00 PM");
    expect(sent.slice(before).filter((text) => text.to === CLEANER && text.body.includes("12:00 PM")).length).toBeGreaterThan(0);
  });

  it("changes nothing when the times are the ones already saved, or the cleaning is unknown", async () => {
    const { job, sent } = await cleaning();
    await job.setJobTimes({ jobId: ANITA, checkout: 11 * 60, checkIn: 16 * 60 });
    const before = sent.length;
    expect((await job.setJobTimes({ jobId: ANITA, checkout: 11 * 60, checkIn: 16 * 60 })).sent).toEqual([]);
    expect(sent.length).toBe(before);
    expect(await job.setJobTimes({ jobId: "no-such-stay", checkout: 600 })).toEqual({ applied: false, reason: "unknown", sent: [] });
  });

  it("leaves a cleaning alone once its door code went out", async () => {
    const { job } = await cleaning(false);
    await job.receive({ id: "y-out", from: OWNER, text: "YES" });
    await job.receive({ id: "y-in", from: OWNER, text: "YES" });
    await job.receive({ id: "y-offer", from: CLEANER, text: "YES" });
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    const first = job.jobs()[0]!;
    expect(first.status).toBe("cleared");
    const result = await job.setJobTimes({ jobId: first.id, checkout: 13 * 60 });
    expect(result).toMatchObject({ applied: false, reason: "code-sent" });
    expect(job.jobs()[0]!.checkoutTime).toBe(first.checkoutTime);
  });
});

describe("calling off one cleaning", () => {
  it("calls off an offered cleaning with the existing cancel text, once, and the calendar doesn't bring it back", async () => {
    const { job, sent } = await cleaning();
    await job.setJobTimes({ jobId: ANITA, checkout: 11 * 60, checkIn: 16 * 60 });
    const before = sent.length;
    const off = await job.callOffJob(ANITA);
    expect(off.calledOff).toBe(true);
    expect(off.sent.map((text) => text.kind)).toContain("cancel-update");
    expect(view(job, ANITA).status).toBe("canceled");
    expect(await job.callOffJob(ANITA)).toEqual({ calledOff: false, sent: [] });
    await job.pollFeed(FEED);
    expect(view(job, ANITA).status).toBe("canceled");
    expect(sent.slice(before).filter((text) => text.kind === "cancel-update")).toHaveLength(1);
    expect(view(job, SAME_DAY).status).not.toBe("canceled");
  });

  it("stays called off when the calendar still shows the stay and only the next booking changes", async () => {
    const { job, sent } = await cleaning();
    expect((await job.callOffJob(ANITA)).calledOff).toBe(true);
    const before = sent.length;
    // The next guest now arrives a day later, so the cleaning's window is different, but it's the same cancelled stay.
    await job.pollFeed(FEED.replace("DTSTART;VALUE=DATE:20261018", "DTSTART;VALUE=DATE:20261019"));
    expect(view(job, ANITA).status).toBe("canceled");
    expect(sent.slice(before).filter((text) => text.kind === "offer")).toEqual([]);
  });

  it("never calls off a cleaning under way", async () => {
    const { job } = await cleaning(false);
    await job.receive({ id: "y-out", from: OWNER, text: "YES" });
    await job.receive({ id: "y-in", from: OWNER, text: "YES" });
    await job.receive({ id: "y-offer", from: CLEANER, text: "YES" });
    await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    const first = job.jobs()[0]!;
    expect(await job.callOffJob(first.id)).toEqual({ calledOff: false, sent: [] });
    expect(job.jobs()[0]!.status).toBe("cleared");
  });
});
