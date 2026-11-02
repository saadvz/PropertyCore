import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { liveDeskFor, resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch, type LiveDesk, type ToolReply } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { fakeConversations } from "./fakeConversations";
import { ADDRESS, BUSINESS, CALENDAR_ICS, CALENDAR_URL, CLEANER, CLEANER_LINE, DOOR_CODE, FROZEN, HOST, TEST_PIN_KEY, fakeSms } from "./wiringProof";

const ZONE = "America/New_York";
const PIN_KEY = Buffer.from(TEST_PIN_KEY, "base64");
const LOCK = "back door lockbox";
const ROUTINE = { url: "https://routine.example/hook", token: "k-test-routine-key" };
const USERNAME = "scratch-cleaner";
const STALE = "That approval has expired or doesn't match. Ask the host again.";
const RATE_HELP = "Tell me the pay per cleaning, from $1 to $1,000.";
const VENMO_HELP = "Tell me the cleaner's Venmo username, like @maria-cleans. A phone number or email won't work.";

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

/** A clock the test moves by hand. */
function testClock(start: string) {
  let at = new Date(start);
  return {
    now: () => at,
    set(iso: string) {
      at = new Date(iso);
    },
  };
}

function openDesk(now: () => Date, root = mkdtempSync(join(tmpdir(), "cleaner-pay-desk-"))) {
  if (!roots.includes(root)) roots.push(root);
  const sms = fakeSms();
  const groups = fakeConversations();
  setCleanerTwilioClient(sms);
  setCleanerGroupFetch(groups.impl);
  setCleanerCalendarFetch(async (url) => ({
    status: url === CALENDAR_URL ? 200 : 404,
    url,
    async text() {
      return url === CALENDAR_URL ? CALENDAR_ICS : "";
    },
  }));
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
  const desk = liveDeskFor(root, () => env, now);
  return { desk, sms, groups, root };
}

function ok(reply: ToolReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

function refused(reply: ToolReply): string {
  if (reply.ok) throw new Error(`Expected a refusal, got ${JSON.stringify(reply.result)}`);
  return reply.error;
}

/** The approval code inside a preview's confirmation. */
function codeOf(result: Record<string, unknown>): string {
  const confirmation = result.confirmation as { code?: string } | string;
  return typeof confirmation === "string" ? confirmation : String(confirmation.code);
}

async function stepOf(desk: LiveDesk): Promise<string | undefined> {
  return ((ok(await desk.getState()).ask as { step?: string } | undefined) ?? {}).step;
}

async function doneLines(desk: LiveDesk): Promise<string[]> {
  return ok(await desk.getState()).done as string[];
}

/** Setup up to and including the preferences, with a checklist only when asked. */
async function throughPreferences(desk: LiveDesk, checklist: string[] = []) {
  ok(await desk.getState("cleaners"));
  ok(await desk.saveProperty({ business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00", checkInTime: "16:00" }));
  ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
  ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" }));
  ok(await desk.saveSchedule({ firstText: "when-confirmed" }));
  ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: LOCK }, PIN_KEY));
  ok(await desk.savePreferences(checklist.length > 0 ? { checklist } : {}));
}

/** Saves $rate per cleaning to `venmo` with the host's approval. */
async function approvePayments(desk: LiveDesk, rate = 85, venmo = USERNAME) {
  const preview = ok(await desk.savePayments({ on: true, rate, venmo }));
  return ok(await desk.savePayments({ on: true, rate, venmo, confirmation: codeOf(preview) }));
}

/** The rest of setup, activation, the first booking's times, and the cleaner's two YES replies. */
async function goLive(desk: LiveDesk) {
  ok(await desk.saveAlertRoutine(ROUTINE, () => undefined));
  ok(await desk.activate());
  ok(await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" }));
  await desk.inbound({ id: "yes-opt-in", from: CLEANER, text: "YES" });
  await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
}

describe("Payments setup step", () => {
  it("asks about payments after the preferences, and Not now moves on to the routines", async () => {
    const { desk } = openDesk(() => new Date(FROZEN));
    await throughPreferences(desk);
    expect(await stepOf(desk)).toBe("payments");
    const off = ok(await desk.savePayments({ on: false }));
    expect(off.saved).toBe("Payments are off.");
    expect(String(off.next)).toMatch(/^Create the Cleaner Core Check and Cleaner Core Alerts routines\./);
    expect(await stepOf(desk)).toBeUndefined();
    expect(await doneLines(desk)).toContain("Payments: off.");
  });

  it("saves only after the host approves the profile and the amount", async () => {
    const { desk } = openDesk(() => new Date(FROZEN));
    await throughPreferences(desk);
    const preview = ok(await desk.savePayments({ on: true, rate: 85, venmo: `@${USERNAME}` }));
    expect(preview.profile).toBe(`https://venmo.com/u/${USERNAME}`);
    expect(preview.question).toBe(`Save $85.00 per cleaning to @${USERNAME}?`);
    expect(codeOf(preview)).toMatch(/\S/);
    expect(await stepOf(desk)).toBe("payments");

    const saved = ok(await desk.savePayments({ on: true, rate: 85, venmo: USERNAME, confirmation: codeOf(preview) }));
    expect(saved.saved).toBe("Saved. After each cleaning I'll offer a Venmo link for $85.00.");
    expect(await doneLines(desk)).toContain(`Payments: $85.00 per cleaning to @${USERNAME}.`);
    expect(await stepOf(desk)).toBeUndefined();
  });

  it("refuses an approval code when the username changed before the yes", async () => {
    const { desk } = openDesk(() => new Date(FROZEN));
    await throughPreferences(desk);
    const preview = ok(await desk.savePayments({ on: true, rate: 85, venmo: USERNAME }));
    expect(refused(await desk.savePayments({ on: true, rate: 85, venmo: `${USERNAME}2`, confirmation: codeOf(preview) }))).toBe(STALE);
    expect(refused(await desk.savePayments({ on: true, rate: 90, venmo: USERNAME, confirmation: codeOf(preview) }))).toBe(STALE);
    expect(await stepOf(desk)).toBe("payments");
  });

  it("refuses a bad rate and a phone number for the username", async () => {
    const { desk } = openDesk(() => new Date(FROZEN));
    await throughPreferences(desk);
    expect(refused(await desk.savePayments({ on: true, rate: 850000, venmo: USERNAME }))).toBe(RATE_HELP);
    expect(refused(await desk.savePayments({ on: true, venmo: USERNAME }))).toBe(RATE_HELP);
    expect(refused(await desk.savePayments({ on: true, rate: 85, venmo: "5555550101" }))).toBe(VENMO_HELP);
  });

  it("doesn't ask a live setup, which can still turn payments on", async () => {
    const { desk } = openDesk(() => new Date(FROZEN));
    await throughPreferences(desk);
    // A setup that went live before the Payments step existed: it never saved payments.
    await goLive(desk);
    expect(await stepOf(desk)).not.toBe("payments");
    expect((await doneLines(desk)).some((line) => line.startsWith("Payments"))).toBe(false);
    await approvePayments(desk);
    expect(await doneLines(desk)).toContain(`Payments: $85.00 per cleaning to @${USERNAME}.`);
  });

  it("is removed by reset_property", async () => {
    const { desk, root } = openDesk(() => new Date(FROZEN));
    await throughPreferences(desk);
    await approvePayments(desk);
    const preview = ok(await desk.resetProperty({}, () => undefined));
    ok(await desk.resetProperty({ confirmation: codeOf(preview) }, () => undefined));
    let file = "";
    try {
      file = readFileSync(join(root, "cleaner-live.json"), "utf8");
    } catch {
      file = "";
    }
    expect(file.includes(USERNAME)).toBe(false);
  });
});

