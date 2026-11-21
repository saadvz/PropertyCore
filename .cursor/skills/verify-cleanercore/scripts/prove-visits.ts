import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fixedCodePort } from "../../../../src/cleaner-core/doorPort";
import { openCleanerCore, type CleanerCore, type CleanerText } from "../../../../src/cleaner-core/core";
import { liveDeskFor, resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch, type ToolReply } from "../../../../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../../../../src/cleaner-core/liveSms";
import { SCRATCH_TENANTS } from "../../../../src/cleaner-core/tenants";
import { buildVisits } from "../../../../src/visits/derive";
import { resetVisitLogCache, VISIT_EVENTS_DIR, VisitLog } from "../../../../src/visits/store";
import { fakeConversations } from "../../../../test/fakeConversations";
import { deskFeatures } from "../../../../test/featureEnv";
import { ADDRESS, BUSINESS, CALENDAR_ICS, CALENDAR_URL, CLEANER, CLEANER_LINE, DOOR_CODE, FROZEN, HOST, TEST_PIN_KEY, fakeSms } from "../../../../test/wiringProof";

/**
 * Visit records (#237) on Scratch numbers only, with fake lock events. Part one drives the live desk with the
 * account's "visits" switch on and off, and checks a cleaning's window reaches the log either way: the log only
 * records. Part two drives Scratch Lane's same-day turnover (11 AM checkout, 4 PM check-in on 18 Oct 2026) through the
 * engine: a late cleaner gets one text and the host one at-risk note, a restart sends nothing new, a cleaner who came
 * in with their code gets nothing and a measured visit, a property with no lock gets nothing new, and with the switch
 * off the same late cleaner gets nothing at all. Nothing reaches a phone.
 */
const outPath = process.argv[2];
if (!outPath) throw new Error("prove-visits.ts needs an output path");

const SCRATCH = /^\+1(555\d{7}|\d{3}555(01\d\d))$/;
const LANE = SCRATCH_TENANTS[0]!;
const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
const temps: string[] = [];
const temp = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `prove-visits-${name}-`));
  temps.push(dir);
  return dir;
};

function ok(reply: ToolReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

/** Part one: the live desk writes the window with the account's "visits" switch on or off. */
async function wiring(switchOn: boolean): Promise<{ windows: { from: string; until: string; sameDay: boolean }[]; logWritten: boolean }> {
  const root = temp(switchOn ? "on" : "off");
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
    ...(switchOn ? deskFeatures("visits") : {}),
  };
  const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
  ok(await desk.getState("cleaners"));
  ok(await desk.saveProperty({ business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: "America/New_York", checkoutTime: "11:00", checkInTime: "16:00" }));
  ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
  ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" }));
  ok(await desk.saveDoorCode({ code: DOOR_CODE }, Buffer.from(TEST_PIN_KEY, "base64")));
  ok(await desk.setUpTexting());
  ok(await desk.runChecks());
  const logWritten = existsSync(join(root, VISIT_EVENTS_DIR));
  const windows = logWritten
    ? new VisitLog(root)
        .read()
        .flatMap((event) => (event.type === "visit-window" ? [{ from: event.from, until: event.until, sameDay: event.sameDay }] : []))
    : [];
  resetLiveDesks();
  return { windows, logWritten };
}

/**
 * Part two: one Scratch Lane engine with the visit log, a confirmed same-day turnover, and a clock to move. `notify`
 * is the account's "visits" switch, on unless a journey turns it off.
 */
async function lane(opts: { lock: boolean; notify?: boolean }) {
  const root = temp("lane");
  let now = new Date(FROZEN);
  const sent: CleanerText[] = [];
  const log = new VisitLog(root, () => now);
  if (opts.lock) log.append({ type: "lock-connection", id: "conn", at: "2026-10-01T00:00:00.000Z", connected: true });
  log.nameCode("Cleaner", { role: "cleaner" });
  const open = (): CleanerCore =>
    openCleanerCore({
      enabled: true,
      property: LANE.property,
      ownerPhone: LANE.ownerPhone,
      cleaner: { phone: LANE.cleanerPhone, approved: true },
      access: fixedCodePort(LANE.pin),
      hostName: "Scratch",
      consented: true,
      sink: { async send(text) { sent.push(text); } },
      now: () => now,
      dataDir: join(root, "cleaner-job"),
      visits: { log: new VisitLog(root, () => now), cleanerName: "Ana", notify: opts.notify !== false },
    });
  const job = open();
  await job.pollFeed(FEED);
  await job.receive({ id: "opt-yes", from: LANE.cleanerPhone, text: "YES" });
  await job.receive({ id: "y-out", from: LANE.ownerPhone, text: "YES" });
  await job.receive({ id: "y-in", from: LANE.ownerPhone, text: "YES" });
  await job.receive({ id: "y-offer", from: LANE.cleanerPhone, text: "YES" });
  const visitTexts = () => sent.filter((text) => text.kind === "late-ask" || text.kind === "visit-note").map((text) => ({ to: text.to, kind: text.kind, body: text.body }));
  return { root, log, sent, job, open, visitTexts, at: (iso: string) => (now = new Date(iso)) };
}

async function lateJourney() {
  const w = await lane({ lock: true });
  for (const at of ["2026-10-18T15:14:00.000Z", "2026-10-18T15:15:00.000Z", "2026-10-18T16:00:00.000Z", "2026-10-18T16:30:00.000Z", "2026-10-18T17:00:00.000Z"]) {
    w.at(at);
    await w.job.runReminders();
  }
  const before = w.sent.length;
  resetVisitLogCache();
  const again = w.open();
  await again.replay();
  await again.runReminders();
  return { texts: w.visitTexts(), newAfterRestart: w.sent.length - before, allRecipients: w.sent.map((text) => text.to) };
}

async function arrivedJourney() {
  const w = await lane({ lock: true });
  w.log.append({ type: "lock", id: "u1", at: "2026-10-18T15:08:00.000Z", device: "Front door", action: "unlock", side: "outside", codeName: "Cleaner" });
  w.at("2026-10-18T15:05:00.000Z");
  await w.job.receive({ id: "left", from: LANE.ownerPhone, text: "guests have left" });
  for (const at of ["2026-10-18T15:20:00.000Z", "2026-10-18T16:40:00.000Z"]) {
    w.at(at);
    await w.job.runReminders();
  }
  w.at("2026-10-18T17:25:00.000Z");
  await w.job.receive({ id: "done", from: LANE.cleanerPhone, text: "DONE" });
  w.log.append({ type: "lock", id: "l1", at: "2026-10-18T17:29:00.000Z", device: "Front door", action: "lock", side: "outside" });
  w.at("2026-10-18T19:10:00.000Z");
  await w.job.runReminders();
  const visit = buildVisits(w.log.read(), { timeZone: LANE.property.timeZone, codeNames: w.log.codeNames(), now: new Date("2026-10-18T21:00:00.000Z") }).visits.find((entry) => entry.window.from === "2026-10-18T15:00:00.000Z");
  const logText = readdirSync(join(w.root, VISIT_EVENTS_DIR))
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => readFileSync(join(w.root, VISIT_EVENTS_DIR, name), "utf8"))
    .join("");
  return {
    texts: w.visitTexts(),
    visit: visit ? { arrival: visit.arrival, departure: visit.departure, minutes: visit.minutes, flags: visit.flags } : undefined,
    logHoldsCode: logText.includes(LANE.pin),
    logHoldsPhone: /555\D?555/.test(logText),
    allRecipients: w.sent.map((text) => text.to),
  };
}

async function noLockJourney() {
  const w = await lane({ lock: false });
  for (const at of ["2026-10-18T15:20:00.000Z", "2026-10-18T16:40:00.000Z", "2026-10-18T19:10:00.000Z", "2026-10-18T20:10:00.000Z"]) {
    w.at(at);
    await w.job.runReminders();
  }
  return { texts: w.visitTexts(), allRecipients: w.sent.map((text) => text.to) };
}

/** The late journey's clock with the account's "visits" switch off: the log is written, and nothing is sent. */
async function switchOffJourney() {
  const w = await lane({ lock: true, notify: false });
  for (const at of ["2026-10-18T15:15:00.000Z", "2026-10-18T16:00:00.000Z", "2026-10-18T16:30:00.000Z", "2026-10-18T17:00:00.000Z"]) {
    w.at(at);
    await w.job.runReminders();
  }
  const windows = w.log.read().filter((event) => event.type === "visit-window").length;
  return { texts: w.visitTexts(), windows, allRecipients: w.sent.map((text) => text.to) };
}

try {
  const switchOn = await wiring(true);
  const switchOff = await wiring(false);
  const late = await lateJourney();
  const arrived = await arrivedJourney();
  const noLock = await noLockJourney();
  const off = await switchOffJourney();
  const recipients = [...new Set([...late.allRecipients, ...arrived.allRecipients, ...noLock.allRecipients, ...off.allRecipients])];
  const evidence = {
    switchOn: { logWritten: switchOn.logWritten, windows: switchOn.windows },
    switchOff: { logWritten: switchOff.logWritten, windows: switchOff.windows },
    late: { texts: late.texts, newAfterRestart: late.newAfterRestart },
    arrived: { texts: arrived.texts, visit: arrived.visit, logHoldsCode: arrived.logHoldsCode, logHoldsPhone: arrived.logHoldsPhone },
    noLock: { texts: noLock.texts },
    switchOffLate: { texts: off.texts, windows: off.windows },
    recipients,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  const expectedLate = [
    { to: LANE.cleanerPhone, kind: "late-ask", body: `Hi Ana, checking in on today's clean at ${LANE.property.address}. Are you on your way?` },
    { to: LANE.ownerPhone, kind: "visit-note", body: `Ana hasn't arrived at ${LANE.property.address} yet. The next guests check in at 4 PM.` },
  ];
  const text = JSON.stringify(evidence);
  function sameDayWindow(part: { logWritten: boolean; windows: { from: string; until: string; sameDay: boolean }[] }): boolean {
    return part.logWritten && part.windows.some((w) => w.from === "2026-10-18T15:00:00.000Z" && w.until === "2026-10-18T20:00:00.000Z" && w.sameDay);
  }
  const failures = [
    sameDayWindow(switchOn) ? "" : "switch on: no same-day window in the log",
    sameDayWindow(switchOff) ? "" : "switch off: no same-day window in the log",
    JSON.stringify(late.texts) === JSON.stringify(expectedLate) ? "" : "late: not exactly one late text and one at-risk note",
    late.newAfterRestart === 0 ? "" : "late: a restart sent something new",
    arrived.texts.length === 0 ? "" : "arrived: a visit text went to a cleaner who came in",
    arrived.visit?.arrival?.source === "lock" && arrived.visit.departure?.lockCheck === "matched" && arrived.visit.minutes === 141 ? "" : "arrived: the visit wasn't measured from the lock",
    !arrived.logHoldsCode && !arrived.logHoldsPhone ? "" : "arrived: the log holds the door code or a phone",
    noLock.texts.length === 0 ? "" : "no lock: something new was sent",
    off.texts.length === 0 ? "" : "switch off: a late text or a visit note was sent",
    off.windows > 0 ? "" : "switch off: the engine wrote no window",
    recipients.every((to) => SCRATCH.test(to)) ? "" : "a recipient isn't a Scratch number",
    !text.includes(LANE.pin) && !text.includes(DOOR_CODE) ? "" : "the evidence holds a door code",
  ].filter(Boolean);
  if (failures.length > 0) {
    console.error("visit records proof failed:", failures);
    process.exitCode = 1;
  }
} finally {
  setCleanerTwilioClient(undefined);
  setCleanerGroupFetch(undefined);
  setCleanerAlertFetch(undefined);
  setCleanerCalendarFetch(undefined);
  resetLiveDesks();
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}
