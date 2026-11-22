import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { declinedLine, liveDeskFor, resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch, type LiveDesk, type ToolReply } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { fakeConversations } from "./fakeConversations";
import { ADDRESS, BUSINESS, CALENDAR_ICS, CALENDAR_URL, CLEANER, CLEANER_LINE, DOOR_CODE, FROZEN, HOST, TEST_PIN_KEY, fakeSms } from "./wiringProof";

/**
 * The host-facing words from the Nov 22 host test: a live change to when offers go says plainly what it did, and the
 * note after the cleaner declines says whoever cleans has until the next guests arrive. 555 numbers, made-up code.
 */

const ZONE = "America/New_York";
const PIN_KEY = Buffer.from(TEST_PIN_KEY, "base64");
const ROUTINE = { url: "https://routine.example/hook", token: "k-test-routine-key" };
const roots: string[] = [];

beforeEach(() => setCleanerAlertFetch(async () => ({ status: 200 })));
afterEach(() => {
  setCleanerTwilioClient(undefined);
  setCleanerGroupFetch(undefined);
  setCleanerCalendarFetch(undefined);
  setCleanerAlertFetch(undefined);
  resetLiveDesks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ok(reply: ToolReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

/** A live desk whose cleaner Ana opted in and has the first cleaning's offer, not yet answered. */
async function offerOut(): Promise<LiveDesk> {
  const root = mkdtempSync(join(tmpdir(), "cleaner-host-wording-"));
  roots.push(root);
  setCleanerTwilioClient(fakeSms());
  setCleanerGroupFetch(fakeConversations().impl);
  setCleanerCalendarFetch(async (url) => ({ status: url === CALENDAR_URL ? 200 : 404, url, async text() { return url === CALENDAR_URL ? CALENDAR_ICS : ""; } }));
  const env: NodeJS.ProcessEnv = {
    CLEANER_CORE_ENABLED: "1",
    CLEANER_CORE_LIVE_SMS: "1",
    CLEANER_CORE_GROUP_CHAT: "0",
    CLEANER_CORE_SMS_ALLOWLIST: [HOST, CLEANER].join(","),
    CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
    CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
    CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    CLEANER_CORE_ROUTINE_URL: ROUTINE.url,
    CLEANER_CORE_ROUTINE_KEY: ROUTINE.token,
  };
  const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
  ok(await desk.getState("cleaners", true));
  ok(await desk.saveProperty({ business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00", checkInTime: "16:00" }));
  ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
  ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" }));
  ok(await desk.saveSchedule({ firstText: "when-confirmed" }));
  ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: "back door lockbox" }, PIN_KEY));
  ok(await desk.savePreferences({}));
  ok(await desk.savePayments({ on: false }));
  ok(await desk.saveAlertRoutine(ROUTINE, () => undefined));
  ok(await desk.activate());
  ok(await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" }));
  await desk.inbound({ id: "yes-opt-in", from: CLEANER, text: "YES" });
  return desk;
}

describe("a live change to when offers go", () => {
  it("says plainly what changed and which offer the cleaner already has", async () => {
    const desk = await offerOut();
    const later = ok(await desk.saveSchedule({ firstText: "days-before-checkout", firstTextDays: 2 }));
    expect(String(later.changed)).toMatch(/^Done\. Each cleaning offer now goes to Ana 2 days before checkout\. Ana already has the offer for \w+day, \w+ \d+\. The next one goes out as soon as Ana answers it\.$/);
    expect(String(later.next)).toContain(String(later.changed));
    const sooner = ok(await desk.saveSchedule({ firstText: "when-confirmed" }));
    expect(String(sooner.changed)).toMatch(/^Done\. Each cleaning offer now goes to Ana as soon as its times are confirmed\./);
  });

  it("keeps the setup reply when nothing about the offer's timing changed", async () => {
    const desk = await offerOut();
    const same = ok(await desk.saveSchedule({ reminderTime: "07:30" }));
    expect(same.changed).toBeUndefined();
  });
});

describe("the note after the cleaner declines", () => {
  it("names who said no and never gives them the deadline", async () => {
    const desk = await offerOut();
    await desk.inbound({ id: "no-offer", from: CLEANER, text: "NO" });
    const notes = (ok(await desk.getState()).notes as string[] | undefined) ?? [];
    const note = notes.find((line) => line.startsWith("Ana said no to the "));
    expect(note).toBeDefined();
    expect(note).toContain("so nobody is booked for it yet.");
    expect(note).not.toMatch(/\bshe\b|\bhe\b|\bthey\b/i);
  });

  it("says whoever cleans has until the next guests check in", () => {
    const line = declinedLine("Maria", { checkoutDate: "2026-12-01", nextCheckInAt: "2026-12-06T21:00:00.000Z" }, ZONE);
    expect(line).toBe("Maria said no to the Tuesday, Dec 1 cleaning, so nobody is booked for it yet. The next guests check in Sunday, Dec 6 at 4:00 PM, so whoever cleans has until then.");
    expect(declinedLine("The cleaner", { checkoutDate: "2026-12-01", nextCheckInAt: null }, ZONE)).toBe("The cleaner said no to the Tuesday, Dec 1 cleaning, so nobody is booked for it yet.");
  });
});
