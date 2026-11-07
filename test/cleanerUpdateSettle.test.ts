import { fixedCodePort } from "../src/cleaner-core/doorPort";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCleanerCore, type CleanerText } from "../src/cleaner-core/core";
import { setCleanerUpdateSettle } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch } from "../src/cleaner-core/liveSms";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";
import { fakeConversations } from "./fakeConversations";
import { ADDRESS as WIRED_ADDRESS, BUSINESS, CALENDAR_URL, CLEANER as CLEANER_PHONE, CLEANER_AUTH, CLEANER_LINE, CLEANER_TOKEN, DOOR_CODE, FROZEN, HOST, startWiredApp, type WiredApp } from "./wiringProof";

/**
 * On 2026-11-03 the host's assistant moved checkout 10 AM -> 12 PM -> 10 AM within a minute, and
 * the cleaner got two "Update" texts in a burst. A held update lets a quick second change replace
 * the first, so the cleaner gets one text, or none when the time is back where it was.
 */
const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const CLEANER = "+15555550101";
const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
const START = "2026-10-14T15:00:00.000Z";
const SETTLE_MS = 60_000;
const TEN = 10 * 60;
const NOON = 12 * 60;
const FOUR_PM = 16 * 60;

async function offered(settle?: number) {
  const clock = { ms: Date.parse(START) };
  const sent: CleanerText[] = [];
  const job = openCleanerCore({
    enabled: true,
    property: { id: "prop_12_scratch_lane", address: ADDRESS, timeZone: "America/New_York" },
    ownerPhone: OWNER,
    cleaner: { phone: CLEANER, approved: true },
    access: fixedCodePort(SCRATCH_TENANTS[0]!.pin),
    hostName: "Scratch",
    consented: true,
    grokReadsMessages: true,
    ...(settle !== undefined ? { updateSettleMs: settle } : {}),
    sink: { async send(text: CleanerText) { sent.push(text); } },
    now: () => new Date(clock.ms),
    groupChat: { hostName: "Cory", cleanerName: "Maria" },
  });
  await job.pollFeed(FEED);
  await job.receive({ id: "host-yes", from: OWNER, text: "YES" });
  await job.receive({ id: "cleaner-yes", from: CLEANER, text: "YES" });
  await job.setHostTimes({ checkout: TEN, checkIn: FOUR_PM });
  expect(sent.filter((text) => text.kind === "offer")).toHaveLength(1);
  const since = sent.length;
  return { job, sent, clock, since: () => sent.slice(since) };
}

const later = (clock: { ms: number }, ms: number) => {
  clock.ms += ms;
};

describe("a checkout change after the offer", () => {
  it("is sent at once when no hold is set", async () => {
    const { job, since } = await offered();
    await job.setHostTimes({ checkout: NOON, checkIn: FOUR_PM, keepCheckIn: true });
    expect(since().map((text) => text.kind)).toEqual(["corrected"]);
  });

  it("waits out the hold, then goes once", async () => {
    const { job, since, clock } = await offered(SETTLE_MS);
    expect(await job.setHostTimes({ checkout: NOON, checkIn: FOUR_PM, keepCheckIn: true })).toEqual([]);
    expect(job.updateDueAt()).toBe(new Date(Date.parse(START) + SETTLE_MS).toISOString());
    later(clock, SETTLE_MS - 1);
    expect(await job.sendDueUpdates()).toEqual([]);
    later(clock, 1);
    const due = await job.sendDueUpdates();
    expect(due.map((text) => [text.kind, text.body])).toEqual([["corrected", expect.stringContaining("moved to Sunday, Oct 18 at 12:00 PM")]]);
    expect(since()).toEqual(due);
    expect(job.updateDueAt()).toBeUndefined();
    expect(await job.sendDueUpdates()).toEqual([]);
  });

  it("sends nothing when the time goes back before the hold ends", async () => {
    const { job, since, clock } = await offered(SETTLE_MS);
    await job.setHostTimes({ checkout: NOON, checkIn: FOUR_PM, keepCheckIn: true });
    later(clock, 20_000);
    expect(await job.setHostTimes({ checkout: TEN, checkIn: FOUR_PM, keepCheckIn: true })).toEqual([]);
    expect(job.updateDueAt()).toBeUndefined();
    later(clock, SETTLE_MS);
    expect(await job.sendDueUpdates()).toEqual([]);
    expect(since()).toEqual([]);
  });

  it("sends only the last time when it changes twice", async () => {
    const { job, since, clock } = await offered(SETTLE_MS);
    await job.setHostTimes({ checkout: NOON, checkIn: FOUR_PM, keepCheckIn: true });
    later(clock, 20_000);
    await job.setHostTimes({ checkout: 11 * 60, checkIn: FOUR_PM, keepCheckIn: true });
    // The hold starts again from the second change.
    later(clock, SETTLE_MS - 1);
    expect(await job.sendDueUpdates()).toEqual([]);
    later(clock, 1);
    await job.sendDueUpdates();
    expect(since().map((text) => [text.kind, text.body])).toEqual([["corrected", expect.stringContaining("at 11:00 AM")]]);
  });

  it("goes out on the next reminder check when nothing else sends it", async () => {
    const { job, since, clock } = await offered(SETTLE_MS);
    await job.setHostTimes({ checkout: NOON, checkIn: FOUR_PM, keepCheckIn: true });
    later(clock, SETTLE_MS);
    await job.runReminders();
    expect(since().map((text) => text.kind)).toEqual(["corrected"]);
  });

  it("goes out at once, without confirming, when the cleaner says YES during the hold", async () => {
    const { job, since } = await offered(SETTLE_MS);
    await job.setHostTimes({ checkout: NOON, checkIn: FOUR_PM, keepCheckIn: true });
    const reply = await job.receive({ id: "yes-old-time", from: CLEANER, text: "Yes", channel: "group" });
    expect(reply.sent.map((text) => [text.kind, text.body])).toEqual([["corrected", expect.stringContaining("at 12:00 PM. Maria, reply YES to keep the cleaning")]]);
    expect(since().map((text) => text.kind)).toEqual(["corrected"]);
    expect(job.jobs()[0]?.status).toBe("offered");
    // The cleaner's next YES takes the new time.
    const yes = await job.receive({ id: "yes-new-time", from: CLEANER, text: "Yes", channel: "group" });
    expect(yes.sent.map((text) => [text.kind, text.body])).toEqual([["confirm", expect.stringContaining("at 12:00 PM")]]);
  });
});

describe("the host's assistant changing checkout twice through confirm_times", () => {
  const MCP = "/mcp/cleaner-core";
  const HELD = "Times saved. I'll send the cleaner the new time in about a minute. If the time changes again before then, they get only the last one.";
  const opened: WiredApp[] = [];
  let seq = 0;

  afterEach(async () => {
    setCleanerGroupFetch(undefined);
    setCleanerUpdateSettle(undefined);
    while (opened.length > 0) await opened.pop()?.close();
  });

  async function offeredDesk(now: () => Date) {
    const fake = fakeConversations();
    setCleanerGroupFetch(fake.impl);
    const wired = await startWiredApp({ groupChat: true, allowlist: `${HOST},${CLEANER_PHONE}`, now });
    opened.push(wired);
    const must = async (name: string, args: Record<string, unknown> = {}) => {
      const reply = await wired.tool(MCP, CLEANER_TOKEN, name, args);
      expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
      return reply.structured ?? {};
    };
    const sms = (from: string, body: string) => wired.postTwilio("/webhooks/twilio/cleaner-core", { from, to: CLEANER_LINE, body, sid: `SMsettle${++seq}`, token: CLEANER_AUTH });
    await must("get_state", { choice: "cleaners" });
    await must("save_property", { business: BUSINESS, address: WIRED_ADDRESS, timeZone: "America/New_York" });
    await must("save_people", { host: HOST, cleaner: CLEANER_PHONE, cleanerName: "Mike" });
    await must("save_calendar_link", { url: CALENDAR_URL });
    await must("save_door_code", { code: DOOR_CODE });
    await must("set_up_texting");
    await must("run_checks");
    await must("confirm_times", { checkout: "11:00", checkIn: "16:00" });
    await sms(HOST, "YES");
    await sms(CLEANER_PHONE, "YES");
    expect(fake.posts.some((post) => post.body.includes("Mike, reply YES to schedule it"))).toBe(true);
    return { fake, must, since: fake.posts.length };
  }

  it("sends nothing when the time goes back within the minute", async () => {
    let now = new Date(FROZEN);
    const { fake, must, since } = await offeredDesk(() => now);
    expect((await must("confirm_times", { checkout: "12:00", checkIn: "16:00" })).next).toBe(HELD);
    now = new Date(now.getTime() + 20_000);
    expect((await must("confirm_times", { checkout: "11:00", checkIn: "16:00" })).next).toBe("Times saved. Nothing was sent.");
    now = new Date(now.getTime() + 120_000);
    await must("check_now");
    expect(fake.posts.slice(since)).toEqual([]);
  });

  it("sends the held update on its own once the minute is up", async () => {
    setCleanerUpdateSettle(50);
    const started = Date.now();
    const { fake, must, since } = await offeredDesk(() => new Date(Date.parse(FROZEN) + (Date.now() - started)));
    expect((await must("confirm_times", { checkout: "12:00", checkIn: "16:00" })).next).toBe(HELD);
    expect(fake.posts.slice(since)).toEqual([]);
    await vi.waitFor(() => expect(fake.posts.slice(since).map((post) => post.body)).toEqual([expect.stringContaining("moved to Sunday, Oct 18 at 12:00 PM. Mike, reply YES to keep the cleaning")]), { timeout: 4000, interval: 50 });
  });
});
