import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SUPPLY_DONE_ASK, SUPPLY_NOTED } from "../src/cleaner-core/cleanerTexts";
import { liveDeskFor, resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch, type LiveDesk, type ToolReply } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { emptySupply, writeSupply } from "../src/supply-core/store";
import { fakeConversations } from "./fakeConversations";
import { ADDRESS, BUSINESS, CALENDAR_ICS, CALENDAR_URL, CLEANER, CLEANER_LINE, DOOR_CODE, FROZEN, HOST, TEST_PIN_KEY, fakeSms } from "./wiringProof";

/** The live desk turns the supplies question on from supply.json. Only 555 numbers and a made-up code. */

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

function openDesk() {
  const root = mkdtempSync(join(tmpdir(), "cleaner-supply-desk-"));
  roots.push(root);
  const sms = fakeSms();
  setCleanerTwilioClient(sms);
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
  return { root, sms, desk: liveDeskFor(root, () => env, () => new Date(FROZEN)) };
}

async function live(desk: LiveDesk) {
  ok(await desk.getState("cleaners"));
  ok(await desk.saveProperty({ business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00", checkInTime: "16:00" }));
  ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
  ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" }));
  ok(await desk.saveSchedule({ firstText: "when-confirmed" }));
  ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: "back door" }, PIN_KEY));
  ok(await desk.savePreferences({}));
  ok(await desk.savePayments({ on: false }));
  ok(await desk.saveAlertRoutine(ROUTINE, () => undefined));
  ok(await desk.activate());
  ok(await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" }));
  await desk.inbound({ id: "yes-opt-in", from: CLEANER, text: "YES" });
  await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
  ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
}

function activate(root: string) {
  const file = emptySupply();
  file.settings.activatedAt = new Date(FROZEN).toISOString();
  writeSupply(root, file);
}

const bodies = (sms: ReturnType<typeof fakeSms>) => sms.sent.map((text) => text.body);

describe("the live desk and Supply Core", () => {
  it("keeps today's done text while Supply Core is off", async () => {
    const { desk, sms } = openDesk();
    await live(desk);
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    expect(bodies(sms)).toContain("Thanks, cleaning marked done.");
    expect(bodies(sms)).not.toContain(SUPPLY_DONE_ASK);
  });

  it("asks once supply.json is activated, picked up mid-cleaning by refreshSupplyAsk, and labels the answer", async () => {
    const { desk, sms, root } = openDesk();
    await live(desk);
    activate(root);
    desk.refreshSupplyAsk();
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    expect(bodies(sms)).toContain(SUPPLY_DONE_ASK);
    await desk.inbound({ id: "low", from: CLEANER, text: "out of paper towels, gate 4812" });
    expect(bodies(sms)).toContain(SUPPLY_NOTED);
    const messages = ok(await desk.checkNow()).messages as { handled: string; text: string }[];
    const report = messages.find((m) => m.handled === "supply-report");
    expect(report?.text).toContain("paper towels");
    expect(report?.text).not.toContain("4812");
  });
});
