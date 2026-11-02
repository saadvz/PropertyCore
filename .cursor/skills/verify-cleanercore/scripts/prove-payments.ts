import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { liveDeskFor, resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch, type ToolReply } from "../../../../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../../../../src/cleaner-core/liveSms";
import { fakeConversations } from "../../../../test/fakeConversations";
import { ADDRESS, BUSINESS, CALENDAR_ICS, CALENDAR_URL, CLEANER, CLEANER_LINE, DOOR_CODE, FROZEN, HOST, TEST_PIN_KEY, fakeSms } from "../../../../test/wiringProof";

/**
 * Drives one Scratch cleaning through payments: setup with $85 to a made-up Venmo username, DONE,
 * the checklist YES, check_now's payDue, and mark_paid. Every text goes to a fake. Nothing reaches a phone.
 */
const outPath = process.argv[2];
if (!outPath) throw new Error("prove-payments.ts needs an output path");

const USERNAME = "scratch-cleaner";
const EXPECTED_LINK = `https://venmo.com/${USERNAME}?txn=pay&amount=85.00&audience=private&note=Lake+House+cleaning+Oct+18`;
const PIN_KEY = Buffer.from(TEST_PIN_KEY, "base64");
const ROUTINE = { url: "https://routine.example/hook", token: "k-test-routine-key" };

function ok(reply: ToolReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

function codeOf(result: Record<string, unknown>): string {
  const confirmation = result.confirmation as { code?: string } | string;
  return typeof confirmation === "string" ? confirmation : String(confirmation.code);
}

const root = mkdtempSync(join(tmpdir(), "prove-payments-"));
try {
  const sms = fakeSms();
  const groups = fakeConversations();
  setCleanerTwilioClient(sms);
  setCleanerGroupFetch(groups.impl);
  setCleanerAlertFetch(async () => ({ status: 200 }));
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

  ok(await desk.getState("cleaners"));
  ok(await desk.saveProperty({ business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: "America/New_York", checkoutTime: "11:00", checkInTime: "16:00" }));
  ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
  ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" }));
  ok(await desk.saveSchedule({ firstText: "when-confirmed" }));
  ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: "back door lockbox" }, PIN_KEY));
  ok(await desk.savePreferences({ checklist: ["Strip the beds", "Restock coffee"] }));
  const preview = ok(await desk.savePayments({ on: true, rate: 85, venmo: `@${USERNAME}` }));
  ok(await desk.savePayments({ on: true, rate: 85, venmo: USERNAME, confirmation: codeOf(preview) }));
  ok(await desk.saveAlertRoutine(ROUTINE, () => undefined));
  ok(await desk.activate());
  ok(await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" }));
  await desk.inbound({ id: "yes-opt-in", from: CLEANER, text: "YES" });
  await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
  ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));

  const toCleaner = () => sms.sent.filter((text) => text.to === CLEANER).map((text) => text.body);
  await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
  const checklistAsk = toCleaner().at(-1);
  await desk.inbound({ id: "checklist-yes", from: CLEANER, text: "YES" });
  const doneAck = toCleaner().at(-1);

  const before = sms.sent.length + groups.posts.length;
  const check = ok(await desk.checkNow());
  const payDue = (check.payDue ?? []) as { link?: string }[];
  const marked = ok(await desk.markPaid({ job: "2026-10-18", how: "venmo", confirmed: true }));
  const sentDuringPayments = [...sms.sent, ...groups.posts].slice(before).map((text) => text.body);

  const report = { checklistAsk, doneAck, payDue, marked: marked.next, sentDuringPayments };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  const passed =
    checklistAsk === "Before I mark it done: is everything on the checklist I sent finished? Reply YES or NO." &&
    doneAck === "Thanks, cleaning marked done." &&
    payDue[0]?.link === EXPECTED_LINK &&
    sentDuringPayments.length === 0;
  if (!passed) {
    console.error("payments proof failed", report);
    process.exitCode = 1;
  }
} finally {
  setCleanerTwilioClient(undefined);
  setCleanerGroupFetch(undefined);
  setCleanerAlertFetch(undefined);
  setCleanerCalendarFetch(undefined);
  resetLiveDesks();
  rmSync(root, { recursive: true, force: true });
}
