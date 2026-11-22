import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { liveDeskFor, resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch, type ToolReply } from "../../../../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../../../../src/cleaner-core/liveSms";
import { isScratchTestNumber } from "../../../../src/cleaner-core/scratch";
import { hubFor } from "../../../../src/hub/hub";
import { FakeLockAdapter } from "../../../../src/locks/fake";
import { setLockAdapter } from "../../../../src/locks/registry";
import { emptyLocks, storedDevice } from "../../../../src/locks/settings";
import { fakeConversations } from "../../../../test/fakeConversations";
import { deskFeatures } from "../../../../test/featureEnv";
import { BUSINESS, CALENDAR_URL, CLEANER_LINE, DOOR_CODE, TEST_PIN_KEY, fakeSms } from "../../../../test/wiringProof";

/**
 * Findings #6 and #8 on Scratch Lane (+15555550100 host, +15555550101 cleaner), one desk drive:
 * the host hears the cleaner's opt-in and each YES or NO once, with one wake-up each; the cleaner
 * declines the Oct 18 turnover; the host moves it to Monday Oct 19 at 10:00 with move_cleaning (two
 * calls); the cleaner's YES puts them back on it; the reminder names the moved day; the door code and
 * the cleaner's own lock code start only at the moved start. Every text goes to a fake, the lock is the
 * in-memory fake adapter, and the door code is the made-up one. Nothing reaches a phone, a routine or Seam.
 */
const outPath = process.argv[2];
if (!outPath) throw new Error("prove-move-cleaning.ts needs an output path");

const HOST = "+15555550100";
const CLEANER = "+15555550101";
const ADDRESS = "12 Scratch Lane, Teaneck, NJ 07666";
const PIN_KEY = Buffer.from(TEST_PIN_KEY, "base64");
const ROUTINE = { url: "https://routine.example/hook", token: "k-test-routine-key" };
const MOVED_START = "2026-10-19T14:00:00.000Z";
// Checkout Sunday Oct 18; the next guests check in Thursday Oct 22.
const GAP_ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:stay-a",
  "DTSTART;VALUE=DATE:20261014",
  "DTEND;VALUE=DATE:20261018",
  "SUMMARY:Guest",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:stay-b",
  "DTSTART;VALUE=DATE:20261022",
  "DTEND;VALUE=DATE:20261026",
  "SUMMARY:Next guest",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\n");

function ok(reply: ToolReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

const root = mkdtempSync(join(tmpdir(), "prove-move-cleaning-"));
let at = Date.parse("2026-10-14T15:00:00.000Z");
const now = () => new Date(at);
const advanceTo = (iso: string) => {
  at = Date.parse(iso);
};
try {
  const sms = fakeSms();
  const groups = fakeConversations();
  let wakes = 0;
  setCleanerTwilioClient(sms);
  setCleanerGroupFetch(groups.impl);
  setCleanerAlertFetch(async () => {
    wakes += 1;
    return { status: 200 };
  });
  setCleanerCalendarFetch(async (url) => ({ status: url === CALENDAR_URL ? 200 : 404, url, async text() { return url === CALENDAR_URL ? GAP_ICS : ""; } }));
  const fake = new FakeLockAdapter();
  setLockAdapter(fake);
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
    CLEANER_CORE_PIN_KEY: randomBytes(32).toString("base64"),
    ...deskFeatures("locks"),
  };
  const devices = [fake.addDevice("acct-scratch", { id: "dev-front", name: "Front door" })];
  hubFor(root, { now }).doorAccess(() => env).saveLocks({ ...emptyLocks(), customerKey: "acct-scratch", devices: devices.map((device) => storedDevice(device)), doors: devices.map((device) => device.id), activeAt: now().toISOString() });
  const desk = liveDeskFor(root, () => env, now);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  const alerts = async () => (ok(await desk.checkNow()).alerts as string[]) ?? [];

  ok(await desk.getState("cleaners"));
  ok(await desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: "America/New_York", checkoutTime: "11:00", checkInTime: "16:00" }));
  ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
  ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" }));
  ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: "back door lockbox" }, PIN_KEY));
  ok(await desk.savePreferences({}));
  ok(await desk.saveAlertRoutine(ROUTINE, () => undefined));
  ok(await desk.activate());
  const timed = ok(await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" }));
  await alerts();
  await settle();

  // #6: the opt-in and the NO each wake the routine once and are told once.
  const wakesBefore = wakes;
  await desk.inbound({ id: "opt-in", from: CLEANER, text: "YES" });
  await settle();
  const optInAlerts = await alerts();
  await desk.inbound({ id: "no", from: CLEANER, text: "NO" });
  await settle();
  const noAlerts = await alerts();
  const wakesForProgress = wakes - wakesBefore;

  // #8: the host's move, in two calls, and the cleaner's YES.
  const preview = ok(await desk.moveCleaning({ checkout: "2026-10-18", date: "2026-10-19", time: "10:00" }, PIN_KEY));
  const sentBeforeYes = sms.sent.length;
  const moved = ok(await desk.moveCleaning({ checkout: "2026-10-18", date: "2026-10-19", time: "10:00", confirmation: (preview.confirmation as { code: string }).code }, PIN_KEY));
  const movedText = sms.sent.slice(sentBeforeYes).map((text) => text.body);
  await desk.lockClock();
  const codesBeforeYes = fake.liveCodes("dev-front").length;
  await desk.inbound({ id: "yes-moved", from: CLEANER, text: "YES" });
  await settle();
  const yesAlerts = await alerts();
  const lockWindow = fake.liveCodes("dev-front").map((code) => code.window);

  // Checkout day: the host says the guests left; the code waits for the moved start.
  advanceTo("2026-10-18T16:00:00.000Z");
  const left = ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
  await desk.checkNow();
  // On connected locks the cleaner gets their own code, never the saved one: count the door-code texts.
  const isCodeText = (body: string) => /Door code/.test(body);
  const codeBeforeStart = sms.sent.some((text) => text.to === CLEANER && isCodeText(text.body));
  advanceTo("2026-10-19T12:30:00.000Z");
  await desk.checkNow();
  const reminder = sms.sent.filter((text) => text.to === CLEANER && text.body.startsWith("Reminder:")).map((text) => text.body);
  advanceTo("2026-10-19T14:01:00.000Z");
  await desk.lockClock();
  await desk.checkNow();
  const codeTexts = sms.sent.filter((text) => text.to === CLEANER && isCodeText(text.body)).length;
  const ownCodes = fake.liveCodes("dev-front").map((code) => code.code);
  const savedCodeSent = sms.sent.some((text) => text.body.includes(DOOR_CODE));

  const recipients = [...new Set(sms.sent.map((text) => text.to))];
  const redact = (value: unknown) => JSON.parse([DOOR_CODE, ...ownCodes].reduce((json, code) => json.split(code).join("[redacted]"), JSON.stringify(value))) as unknown;
  const report = redact({
    timed: timed.next,
    optInAlerts,
    noAlerts,
    wakesForProgress,
    preview: preview.next,
    previewTexts: preview.texts,
    moved: moved.next,
    movedText,
    codesBeforeYes,
    yesAlerts,
    lockWindow,
    left: left.next,
    codeBeforeStart,
    reminder,
    codeTexts,
    recipients,
  });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  const saved = readFileSync(outPath, "utf8");
  const checks: Record<string, boolean> = {
    "the offer promises a post here": String(timed.next).endsWith("I'll post here when the cleaner replies."),
    "the opt-in is told once": optInAlerts.filter((line) => line === `Ana said YES to cleaning texts for ${ADDRESS}.`).length === 1,
    "the NO is told once, with the move as its next step": noAlerts.some((line) => line.startsWith("Ana said no to the Sunday, Oct 18 cleaning, so nobody is booked for it yet.") && line.endsWith("It can also move to another day or time before then, if Ana can do it.")),
    "one wake-up per event": wakesForProgress === 2,
    "the preview shows the cleaner's exact text": JSON.stringify(preview.texts) === JSON.stringify([{ to: "cleaner", body: `Update: the cleaning at ${ADDRESS} is now Monday, Oct 19 at 10:00 AM. Reply YES to take it, or NO if you can't.` }]),
    "the move sends only the update": movedText.length === 1 && movedText[0]!.startsWith("Update: the cleaning"),
    "no lock code before the cleaner's YES": codesBeforeYes === 0,
    "the YES is told once, naming the moved day": yesAlerts.includes(`Ana said YES to the Monday, Oct 19 at 10:00 AM cleaning at ${ADDRESS}.`),
    "the lock code starts at the moved start": lockWindow.length === 1 && lockWindow[0]!.from === MOVED_START,
    "no door code before the moved start": codeBeforeStart === false,
    "the reminder names the moved day": reminder.length === 1 && reminder[0]!.includes("Monday, Oct 19"),
    "the door code goes once, from the moved start": codeTexts === 1,
    "the cleaner got their own code, never the saved one": !savedCodeSent,
    "only Scratch numbers were texted": recipients.every((phone) => isScratchTestNumber(phone)),
    "the evidence holds no door code": [DOOR_CODE, ...ownCodes].every((code) => !saved.includes(code)),
  };
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  if (failed.length > 0) {
    console.error("move-cleaning proof failed:", failed.join("; "));
    process.exitCode = 1;
  } else console.log(`move-cleaning proof passed (${Object.keys(checks).length} checks): ${outPath}`);
} finally {
  setCleanerTwilioClient(undefined);
  setCleanerGroupFetch(undefined);
  setCleanerAlertFetch(undefined);
  setCleanerCalendarFetch(undefined);
  setLockAdapter(undefined);
  resetLiveDesks();
  rmSync(root, { recursive: true, force: true });
}
