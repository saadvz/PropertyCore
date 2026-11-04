import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoopOperatorNotificationSink } from "../src/alerts/operatorEvents";
import { OperatorEventOutbox } from "../src/alerts/outbox";
import { zonedInstant } from "../src/cleaner-core/calendar";
import { privateCodeLine } from "../src/cleaner-core/cleanerTexts";
import type { CleanerCore } from "../src/cleaner-core/core";
import { drainCleanerAlerts, liveDeskFor, resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch, type LiveDesk, type ToolReply } from "../src/cleaner-core/liveDesk";
import { handleCleanerMcpMessage } from "../src/cleaner-core/mcp";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { fakeConversations } from "./fakeConversations";
import type { GoogleEventList } from "../src/cleaner-core/sources";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import {
  ADDRESS,
  BUSINESS,
  CALENDAR_ICS,
  CALENDAR_URL,
  CLEANER,
  CLEANER_AUTH,
  CLEANER_LINE,
  CLEANER_TOKEN,
  DOOR_CODE,
  FROZEN,
  fakeSms,
  HOST,
  OBSERVER,
  startWiredApp,
  TEST_PIN_KEY,
  type SentSms,
  type WiredApp,
} from "./wiringProof";
import { PUBLIC } from "./fakeSendblue";
import { filesUnder } from "./files";

const PATH = "/mcp/cleaner-core";
const open: WiredApp[] = [];

const UPDATE_HELD = "Times saved. I'll send the cleaner the new time in about a minute. If the time changes again before then, they get only the last one.";

afterEach(async () => {
  setCleanerTwilioClient(undefined);
  setCleanerGroupFetch(undefined);
  setCleanerCalendarFetch(undefined);
  setCleanerAlertFetch(undefined);
  resetLiveDesks();
  while (open.length > 0) {
    const app = open.pop();
    if (app) await app.close();
  }
});

function googleList(stays: { id: string; start: string; end: string }[]): GoogleEventList {
  return {
    timeZone: "America/New_York",
    items: stays.map((stay) => ({ id: stay.id, status: "confirmed", summary: "Guest", start: { date: stay.start }, end: { date: stay.end } })),
  };
}

async function app(options?: Parameters<typeof startWiredApp>[0]): Promise<WiredApp> {
  const started = await startWiredApp(options);
  open.push(started);
  return started;
}

function call(wired: WiredApp, name: string, args: Record<string, unknown> = {}) {
  return wired.tool(PATH, CLEANER_TOKEN, name, args);
}

async function setUpTo(wired: WiredApp, observer = false) {
  await call(wired, "get_state", { choice: "cleaners" });
  expect((await call(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" })).isError).toBe(false);
  expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER, ...(observer ? { observer: OBSERVER, doorCodeTo: "cleaner" } : {}) })).isError).toBe(false);
}

async function setUpGoogle(wired: WiredApp, observer = false) {
  await setUpTo(wired, observer);
  expect((await call(wired, "save_calendar_link", { google: true })).isError).toBe(false);
  expect((await call(wired, "save_door_code", { code: DOOR_CODE })).isError).toBe(false);
  expect((await call(wired, "set_up_texting")).isError).toBe(false);
}

async function done(wired: WiredApp): Promise<string[]> {
  const state = await call(wired, "get_state");
  return (state.structured?.done as string[] | undefined) ?? [];
}

describe("Cleaner Core Grok demo: booking sources at setup", () => {
  it("saves Google without a Guesty link", async () => {
    const wired = await app();
    await setUpTo(wired);
    const saved = await call(wired, "save_calendar_link", { google: true });
    expect(saved.isError).toBe(false);
    const lines = await done(wired);
    expect(lines).toContain("Google Calendar saved.");
    expect(lines).not.toContain("Calendar link saved.");
  });

  it("refuses a calendar step with neither source", async () => {
    const wired = await app();
    await setUpTo(wired);
    const refused = await call(wired, "save_calendar_link", {});
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe("Send the Guesty Lite link, or say you use Google Calendar.");
  });

  it("run_checks reads Google events", async () => {
    const wired = await app();
    await setUpGoogle(wired);
    const missing = await call(wired, "run_checks");
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe("Read Google Calendar and pass its events.");
    const checks = await call(wired, "run_checks", { googleEvents: googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-16" }]) });
    expect(checks.isError).toBe(false);
    const turns = checks.structured?.turns as { checkoutDate: string }[];
    expect(turns).toHaveLength(1);
    expect(turns[0]?.checkoutDate).toBe("2026-10-16");
    expect(wired.cleanerSent).toEqual([]);
  });

  it("run_checks with no stay yet", async () => {
    const wired = await app();
    await setUpGoogle(wired);
    const checks = await call(wired, "run_checks", { googleEvents: googleList([]) });
    expect(checks.isError).toBe(false);
    expect(checks.structured?.next).toBe("I read the calendar. There's no guest stay yet. I'll tell you when one shows up.");
    expect(await done(wired)).toContain("Checks finished.");
    expect(wired.cleanerSent).toEqual([]);
  });

  it("shows the group chat line only when group chat is on", async () => {
    const withObserver = await app({ groupChat: true });
    await setUpGoogle(withObserver, true);
    expect(await done(withObserver)).toContain("Group chat set up with you, the cleaner, and the observer.");

    const noObserver = await app({ groupChat: true });
    await setUpGoogle(noObserver);
    const lines = await done(noObserver);
    expect(lines).toContain("Group chat set up with you and the cleaner.");
    expect(lines.some((line) => line.includes("the observer"))).toBe(false);

    const off = await app({ groupChat: false });
    await setUpGoogle(off, true);
    expect((await done(off)).some((line) => line.startsWith("Group chat set up"))).toBe(false);
  });
});

const ZONE = "America/New_York";
const HOST_CHECKOUT = `Is checkout at ${ADDRESS} on `;

function oneStay(): string {
  return [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:stay-a",
    "DTSTART;VALUE=DATE:20261014",
    "DTEND;VALUE=DATE:20261018",
    "SUMMARY:Guest",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\n");
}

async function setUpBoth(wired: WiredApp) {
  await setUpTo(wired);
  expect((await call(wired, "save_calendar_link", { url: CALENDAR_URL, google: true })).isError).toBe(false);
  expect((await call(wired, "save_door_code", { code: DOOR_CODE })).isError).toBe(false);
  expect((await call(wired, "set_up_texting")).isError).toBe(false);
}

async function yes(wired: WiredApp, sid: string) {
  const res = await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, to: CLEANER_LINE, body: "YES", sid, token: CLEANER_AUTH });
  expect(res.status).toBe(200);
}

/** The next guest. A job needs a next check-in before the host can confirm times. */
const NEXT_STAY = { id: "g2", start: "2026-10-20", end: "2026-10-24" };

function withNext(stay: { id: string; start: string; end: string }): GoogleEventList {
  return googleList([stay, NEXT_STAY]);
}

/** Google-only setup, two stays read, times confirmed, and the cleaner's two YES texts. */
async function confirmedJob(wired: WiredApp, stay: { id: string; start: string; end: string }) {
  await setUpGoogle(wired);
  expect((await call(wired, "run_checks", { googleEvents: withNext(stay) })).isError).toBe(false);
  expect((await call(wired, "confirm_times", { checkout: "10:30", checkIn: "15:00" })).isError).toBe(false);
  await yes(wired, "SM-demo-yes-1");
  await yes(wired, "SM-demo-yes-2");
}

function textKind(item: { body: string }): string {
  if (/^Update: checkout at .* moved to /.test(item.body)) return "corrected";
  if (/^Update: the cleaning at .* is canceled/.test(item.body)) return "cancel-update";
  if (/^Reminder:/.test(item.body)) return "reminder";
  return "other";
}

function kindsSince(wired: WiredApp, from: number): string[] {
  return wired.cleanerSent.slice(from).map(textKind);
}

function reminders(wired: WiredApp): number {
  return wired.cleanerSent.filter((item) => textKind(item) === "reminder").length;
}

function alertsOf(reply: { structured: Record<string, unknown> | undefined }): string[] {
  return (reply.structured?.alerts as string[] | undefined) ?? [];
}

function turnsOf(reply: { structured: Record<string, unknown> | undefined }): { checkoutDate: string; status: string }[] {
  return (reply.structured?.turns as { checkoutDate: string; status: string }[] | undefined) ?? [];
}

describe("Cleaner Core Grok demo: check_now", () => {
  it("new booking alerts the host", async () => {
    const wired = await app();
    await setUpGoogle(wired);
    expect((await call(wired, "run_checks", { googleEvents: googleList([]) })).isError).toBe(false);
    const list = googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-15" }]);
    const first = await call(wired, "check_now", { googleEvents: list });
    expect(first.isError).toBe(false);
    const alerts = alertsOf(first);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.startsWith(HOST_CHECKOUT)).toBe(true);
    expect(turnsOf(first)).toHaveLength(1);
    expect(wired.cleanerSent).toEqual([]);
    const second = await call(wired, "check_now", { googleEvents: list });
    expect(second.isError).toBe(false);
    expect(alertsOf(second)).toEqual([]);
    expect(wired.cleanerSent).toEqual([]);
  });

  it("moved stay updates the job", async () => {
    let now = new Date(FROZEN);
    const wired = await app({ now: () => now });
    await confirmedJob(wired, { id: "g1", start: "2026-10-10", end: "2026-10-15" });
    const before = wired.cleanerSent.length;
    const moved = await call(wired, "check_now", { googleEvents: withNext({ id: "g1", start: "2026-10-10", end: "2026-10-16" }) });
    expect(moved.isError).toBe(false);
    expect(turnsOf(moved)[0]?.checkoutDate).toBe("2026-10-16");
    // The engine clears the host's checkout time when the date moves, so it asks the host again
    // and tells the cleaner nothing until the host confirms the new day.
    expect(alertsOf(moved).some((line) => line.startsWith(HOST_CHECKOUT) && line.includes("Oct 16"))).toBe(true);
    expect(kindsSince(wired, before)).toEqual([]);
    // The update waits a minute, so a quick second change would replace it.
    const timed = await call(wired, "confirm_times", { checkout: "10:30", checkIn: "15:00" });
    expect(timed.isError).toBe(false);
    expect(timed.structured?.next).toBe(UPDATE_HELD);
    expect(kindsSince(wired, before)).toEqual([]);
    now = new Date(now.getTime() + 60_000);
    expect((await call(wired, "check_now", { googleEvents: withNext({ id: "g1", start: "2026-10-10", end: "2026-10-16" }) })).isError).toBe(false);
    const got = wired.cleanerSent.slice(before);
    expect(got.map(textKind)).toEqual(["corrected"]);
    expect(got[0]?.body).toContain("Friday, Oct 16 at 10:30 AM");
    expect(got[0]?.body).not.toContain("3:00 PM");
    expect(got.some((item) => item.body.includes(DOOR_CODE))).toBe(false);
  });

  it("removed stay calls the job off", async () => {
    const wired = await app();
    await confirmedJob(wired, { id: "g1", start: "2026-10-10", end: "2026-10-15" });
    const before = wired.cleanerSent.length;
    const removed = await call(wired, "check_now", { googleEvents: googleList([]) });
    expect(removed.isError).toBe(false);
    expect(kindsSince(wired, before)).toEqual(["cancel-update"]);
    expect(turnsOf(removed).every((turn) => turn.status === "canceled")).toBe(true);
  });

  it("omitted googleEvents changes nothing", async () => {
    const wired = await app();
    await confirmedJob(wired, { id: "g1", start: "2026-10-10", end: "2026-10-15" });
    const jobs = await call(wired, "get_turns");
    const before = wired.cleanerSent.length;
    const checked = await call(wired, "check_now", {});
    expect(checked.isError).toBe(false);
    expect(turnsOf(checked)).toEqual(jobs.structured?.turns);
    expect(wired.cleanerSent).toHaveLength(before);
  });

  it("one job from both calendars", async () => {
    const wired = await app({ calendar: oneStay });
    await setUpBoth(wired);
    const list = googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-18" }]);
    expect((await call(wired, "run_checks", { googleEvents: list })).isError).toBe(false);
    const checked = await call(wired, "check_now", { googleEvents: list });
    expect(checked.isError).toBe(false);
    expect(turnsOf(checked)).toHaveLength(1);
    expect(turnsOf(checked)[0]?.checkoutDate).toBe("2026-10-18");
  });

  it("guesty failure still applies Google", async () => {
    const wired = await app({ calendar: oneStay });
    await setUpBoth(wired);
    const first = googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-18" }]);
    expect((await call(wired, "run_checks", { googleEvents: first })).isError).toBe(false);
    setCleanerCalendarFetch(async (url) => ({
      status: 500,
      url,
      async text() {
        return "";
      },
    }));
    const next = googleList([
      { id: "g1", start: "2026-10-14", end: "2026-10-18" },
      { id: "g2", start: "2026-10-20", end: "2026-10-24" },
    ]);
    const checked = await call(wired, "check_now", { googleEvents: next });
    expect(checked.isError).toBe(false);
    expect(checked.structured?.guestyUnread).toBe(true);
    expect(turnsOf(checked).map((turn) => turn.checkoutDate)).toContain("2026-10-24");
  });

  it("malformed events are skipped", async () => {
    const wired = await app();
    await setUpGoogle(wired);
    expect((await call(wired, "run_checks", { googleEvents: googleList([]) })).isError).toBe(false);
    const good = googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-16" }]).items[0];
    const checked = await call(wired, "check_now", {
      googleEvents: { timeZone: "America/New_York", items: [{ id: "bad" }, { id: "x", start: { date: "nope" }, end: {} }, good] },
    });
    expect(checked.isError).toBe(false);
    expect(turnsOf(checked)).toHaveLength(1);
  });

  it("refuses before setup", async () => {
    const wired = await app();
    const refused = await call(wired, "check_now", { googleEvents: googleList([]) });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe("Run the checks first.");
    expect(wired.cleanerSent).toEqual([]);
    expect(wired.tourSent).toEqual([]);
  });

  it("reminder fires once and a restart does not resend it", async () => {
    let now = new Date(FROZEN);
    const wired = await app({ now: () => now });
    const stay = { id: "g1", start: "2026-10-10", end: "2026-10-14" };
    const list = withNext(stay);
    await confirmedJob(wired, stay);
    expect(reminders(wired)).toBe(0);

    now = new Date(zonedInstant("2026-10-14", "07:59", ZONE));
    expect((await call(wired, "check_now", { googleEvents: list })).isError).toBe(false);
    expect(reminders(wired)).toBe(0);

    now = new Date(zonedInstant("2026-10-14", "08:00", ZONE));
    expect((await call(wired, "check_now", { googleEvents: list })).isError).toBe(false);
    expect(reminders(wired)).toBe(1);
    expect((await call(wired, "check_now", { googleEvents: list })).isError).toBe(false);
    expect(reminders(wired)).toBe(1);

    resetLiveDesks();
    expect((await call(wired, "check_now", { googleEvents: list })).isError).toBe(false);
    expect(reminders(wired)).toBe(1);
  });

  it("is off when Cleaner Core is off", async () => {
    const wired = await app({ enabled: false });
    const off = await call(wired, "check_now", { googleEvents: googleList([]) });
    expect(off.status).toBe(503);
    expect(wired.cleanerSent).toEqual([]);
    expect(wired.tourSent).toEqual([]);
  });
});

interface GroupPost {
  to: string[];
  body: string;
}

/** A fake Twilio Conversations API. It records each group message and never leaves the machine. */
/** The Conversations fake for group texting. Each post lists the phones that got it. */
function groupStub(): { impl: typeof fetch; posts: GroupPost[] } {
  return fakeConversations();
}

/** A Guesty calendar that answers slowly and counts how many reads are open at once. */
function slowCalendar(): { peak: () => number } {
  let inFlight = 0;
  let peak = 0;
  setCleanerCalendarFetch(async (url) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 25));
    inFlight -= 1;
    return {
      status: 200,
      url,
      async text() {
        return oneStay();
      },
    };
  });
  return { peak: () => peak };
}

function deskEnv(): NodeJS.ProcessEnv {
  return { CLEANER_CORE_ENABLED: "1", CLEANER_CORE_GROUP_CHAT: "0", CLEANER_CORE_SMS_ALLOWLIST: `${HOST},${CLEANER}` };
}

function resultOf(reply: ToolReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

/** A desk with its own state folder and no live texting. */
async function openDesk(root: string, env: NodeJS.ProcessEnv): Promise<LiveDesk> {
  const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
  const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
  expect((await desk.getState("cleaners")).ok).toBe(true);
  expect((await desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE })).ok).toBe(true);
  expect((await desk.savePeople({ host: HOST, cleaner: CLEANER })).ok).toBe(true);
  expect((await desk.saveCalendarLink({ google: true })).ok).toBe(true);
  expect((await desk.saveDoorCode({ code: DOOR_CODE }, pinKey)).ok).toBe(true);
  expect((await desk.setUpTexting()).ok).toBe(true);
  expect((await desk.runChecks({ googleEvents: googleList([]) })).ok).toBe(true);
  return desk;
}

describe("Cleaner Core Grok demo: check_now follow-ups", () => {
  it("returns a held-back alert once it becomes visible", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-held-"));
    try {
      const env = deskEnv();
      const desk = await openDesk(root, env);
      const internals = desk as unknown as { engine: CleanerCore; file: { pinSend?: unknown } };
      // The private-code line is hidden until the door-code text is confirmed delivered.
      const line = privateCodeLine("Maria");
      internals.engine.keepHostNote("pin-private:held", line);
      const held = resultOf(await desk.checkNow({ googleEvents: googleList([]) }));
      expect(held.alerts).toEqual([]);
      internals.file.pinSend = { sid: "SM-held", outcome: "settled", notePending: false, delivered: true };
      const shown = resultOf(await desk.checkNow({ googleEvents: googleList([]) }));
      expect(shown.alerts).toEqual([line]);
      expect(resultOf(await desk.checkNow({ googleEvents: googleList([]) })).alerts).toEqual([]);
    } finally {
      resetLiveDesks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports Google as unread when the engine does not take the read", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-unread-"));
    try {
      const env = deskEnv();
      await openDesk(root, env);
      // The host's number is no longer approved, so the reopened engine refuses to read any source.
      env.CLEANER_CORE_SMS_ALLOWLIST = "+15555550199";
      resetLiveDesks();
      const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
      const reply = resultOf(await desk.checkNow({ googleEvents: googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-16" }]) }));
      expect(reply.googleUnread).toBe(true);
      expect(reply.turns).toEqual([]);
      expect(reply.guestyUnread).toBeUndefined();
    } finally {
      resetLiveDesks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks the alerts the host already saw at run_checks as shown", async () => {
    const wired = await app();
    const stay = { id: "g1", start: "2026-10-10", end: "2026-10-15" };
    await confirmedJob(wired, stay);
    const state = await call(wired, "get_state");
    const seen = (state.structured?.notes as string[] | undefined) ?? [];
    expect(seen.length).toBeGreaterThan(0);
    expect((await call(wired, "run_checks", { googleEvents: withNext(stay) })).isError).toBe(false);
    const checked = await call(wired, "check_now", { googleEvents: withNext(stay) });
    expect(checked.isError).toBe(false);
    expect(alertsOf(checked).filter((line) => seen.includes(line))).toEqual([]);
  });

  it("returns a new-booking alert again after reset_scratch", async () => {
    const lane = SCRATCH_TENANTS[0];
    if (!lane) throw new Error("missing tenant");
    const wired = await app({ scratchTools: true, allowlist: `${lane.ownerPhone},${lane.cleanerPhone}` });
    await call(wired, "get_state", { choice: "cleaners" });
    await call(wired, "save_property", { business: "Scratch", address: lane.property.address, timeZone: ZONE });
    await call(wired, "save_people", { host: lane.ownerPhone, cleaner: lane.cleanerPhone });
    await call(wired, "save_calendar_link", { google: true });
    await call(wired, "save_door_code", { code: DOOR_CODE });
    await call(wired, "set_up_texting");
    expect((await call(wired, "run_checks", { googleEvents: googleList([]) })).isError).toBe(false);
    const list = googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-15" }]);
    const first = await call(wired, "check_now", { googleEvents: list });
    expect(alertsOf(first)).toHaveLength(1);
    expect(alertsOf(await call(wired, "check_now", { googleEvents: list }))).toEqual([]);
    expect((await call(wired, "reset_scratch")).isError).toBe(false);
    const again = await call(wired, "check_now", { googleEvents: list });
    expect(again.isError).toBe(false);
    expect(alertsOf(again)).toEqual(alertsOf(first));
  });

  it("never runs two checks at once", async () => {
    const wired = await app({ calendar: oneStay });
    await setUpBoth(wired);
    const list = googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-18" }]);
    expect((await call(wired, "run_checks", { googleEvents: list })).isError).toBe(false);
    const slow = slowCalendar();
    const pair = await Promise.all([call(wired, "check_now", { googleEvents: list }), call(wired, "check_now", { googleEvents: list })]);
    expect(pair.map((reply) => reply.isError)).toEqual([false, false]);
    expect(slow.peak()).toBe(1);
    const mixed = await Promise.all([call(wired, "run_checks", { googleEvents: list }), call(wired, "check_now", { googleEvents: list })]);
    expect(mixed.map((reply) => reply.isError)).toEqual([false, false]);
    expect(slow.peak()).toBe(1);
  });

  it("with group chat on, a moved stay waits for the host and then sends one corrected text", async () => {
    const stub = groupStub();
    setCleanerGroupFetch(stub.impl);
    let now = new Date(FROZEN);
    const wired = await app({ groupChat: true, now: () => now });
    await confirmedJob(wired, { id: "g1", start: "2026-10-10", end: "2026-10-15" });
    const sms = wired.cleanerSent.length;
    const posts = stub.posts.length;
    const moved = await call(wired, "check_now", { googleEvents: withNext({ id: "g1", start: "2026-10-10", end: "2026-10-16" }) });
    expect(moved.isError).toBe(false);
    expect(turnsOf(moved)[0]?.checkoutDate).toBe("2026-10-16");
    expect((moved.structured?.turns as { checkoutTime: string | null }[])[0]?.checkoutTime).toBeNull();
    expect(wired.cleanerSent).toHaveLength(sms);
    expect(stub.posts).toHaveLength(posts);
    expect((await call(wired, "confirm_times", { checkout: "10:30", checkIn: "15:00" })).structured?.next).toBe(UPDATE_HELD);
    expect(stub.posts).toHaveLength(posts);
    now = new Date(now.getTime() + 60_000);
    expect((await call(wired, "check_now", { googleEvents: withNext({ id: "g1", start: "2026-10-10", end: "2026-10-16" }) })).isError).toBe(false);
    // The corrected text goes once into the group, naming the cleaner, and nothing goes one-to-one.
    expect(wired.cleanerSent).toHaveLength(sms);
    const got = stub.posts.slice(posts);
    expect(got.map(textKind)).toEqual(["corrected"]);
    expect(got[0]?.body).toContain("Friday, Oct 16 at 10:30 AM");
    expect(got[0]?.body).toMatch(/, reply YES to keep the cleaning/);
    expect(got[0]?.body).not.toContain("3:00 PM");
  });

  it("with group chat on, a removed stay posts one cancellation into the group", async () => {
    const stub = groupStub();
    setCleanerGroupFetch(stub.impl);
    const wired = await app({ groupChat: true });
    await confirmedJob(wired, { id: "g1", start: "2026-10-10", end: "2026-10-15" });
    const sms = wired.cleanerSent.length;
    const posts = stub.posts.length;
    const removed = await call(wired, "check_now", { googleEvents: googleList([]) });
    expect(removed.isError).toBe(false);
    expect(wired.cleanerSent).toHaveLength(sms);
    expect(stub.posts.slice(posts).map(textKind)).toEqual(["cancel-update"]);
    expect(turnsOf(removed).every((turn) => turn.status === "canceled")).toBe(true);
  });
});

const ROUTINE_URL = "https://routine.example/hook";
const ROUTINE_KEY = "k-test-123456";
const CONNECTED = "Alerts are connected. I queued a test alert for the routine.";
const YES_NOTE = `The cleaner said YES to the turnover at ${ADDRESS}.`;

interface AlertPost {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A fake routine webhook. It records each POST and answers with the status the test picks. */
function alertStub(status: () => number): AlertPost[] {
  const posts: AlertPost[] = [];
  setCleanerAlertFetch(async (url, init) => {
    posts.push({ url, headers: init.headers, body: init.body });
    return { status: status() };
  });
  return posts;
}

function drain(wired: WiredApp, now: () => Date = () => new Date(FROZEN)): Promise<void> {
  return drainCleanerAlerts(wired.root, wired.env, now);
}

function cleaningUpdates(wired: WiredApp) {
  const outbox = new OperatorEventOutbox(new FileRuntimeStore(join(wired.root, "cleaner-alerts")), () => new NoopOperatorNotificationSink());
  return outbox.records().filter((record) => record.event.eventType === "cleaning.update");
}

function liveFile(wired: WiredApp): string {
  const path = join(wired.root, "cleaner-live.json");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const WAKE_STAY = { id: "g1", start: "2026-10-10", end: "2026-10-15" };

/** Google setup, one stay and the next, times confirmed. The cleaner has not answered yet. */
async function readyForYes(wired: WiredApp) {
  await setUpGoogle(wired);
  expect((await call(wired, "run_checks", { googleEvents: withNext(WAKE_STAY) })).isError).toBe(false);
  expect((await call(wired, "confirm_times", { checkout: "10:30", checkIn: "15:00" })).isError).toBe(false);
}

describe("Cleaner Core Grok demo: instant alerts", () => {
  it("save_alert_routine stores without echoing", async () => {
    const wired = await app();
    const posts = alertStub(() => 200);
    await call(wired, "get_state", { choice: "cleaners" });
    const saved = await call(wired, "save_alert_routine", { url: ROUTINE_URL, token: ROUTINE_KEY });
    expect(saved.isError).toBe(false);
    expect(saved.structured?.next).toBe(CONNECTED);
    for (const secret of [ROUTINE_URL, ROUTINE_KEY]) {
      expect(saved.raw).not.toContain(secret);
      expect(liveFile(wired)).not.toContain(secret);
    }
    await drain(wired);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe(ROUTINE_URL);
    expect(posts[0]?.headers.Authorization).toBe(`Bearer ${ROUTINE_KEY}`);
    expect(JSON.parse(posts[0]?.body ?? "{}").eventType).toBe("installation.test");
    const logs = wired.logs.join("\n");
    expect(logs).not.toContain(ROUTINE_KEY);
    expect(logs).not.toContain(ROUTINE_URL);
  });

  it("refuses a non-https routine", async () => {
    const wired = await app();
    const posts = alertStub(() => 200);
    const refused = await call(wired, "save_alert_routine", { url: "http://x", token: ROUTINE_KEY });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(ROUTINE_NEEDED);
    const short = await call(wired, "save_alert_routine", { url: ROUTINE_URL, token: "short" });
    expect(short.isError).toBe(true);
    expect(short.text).toBe(ROUTINE_NEEDED);
    await drain(wired);
    expect(posts).toEqual([]);
    expect(wired.env().CLEANER_CORE_ROUTINE_URL).toBeUndefined();
  });

  it("re-saving sends the test alert to the new routine at once", async () => {
    const wired = await app();
    const posts = alertStub(() => 200);
    const secondUrl = "https://routine.example/second-hook";
    const secondToken = "k-test-second-7890";
    // No drain call here: the save itself sends the test alert, well before the retry timer.
    expect((await call(wired, "save_alert_routine", { url: ROUTINE_URL, token: ROUTINE_KEY })).isError).toBe(false);
    await vi.waitFor(() => expect(posts).toHaveLength(1), { timeout: 2_000, interval: 10 });
    expect(posts[0]?.url).toBe(ROUTINE_URL);
    expect((await call(wired, "save_alert_routine", { url: secondUrl, token: secondToken })).isError).toBe(false);
    await vi.waitFor(() => expect(posts).toHaveLength(2), { timeout: 2_000, interval: 10 });
    expect(posts[1]?.url).toBe(secondUrl);
    expect(posts[1]?.headers.Authorization).toBe(`Bearer ${secondToken}`);
    expect(JSON.parse(posts[1]?.body ?? "{}").eventType).toBe("installation.test");
    await drain(wired);
    expect(posts.filter((post) => post.url === ROUTINE_URL)).toHaveLength(1);
    expect(posts.filter((post) => post.url === secondUrl)).toHaveLength(1);
  });

  it("refuses the door-code key as the routine token", async () => {
    const wired = await app();
    const posts = alertStub(() => 200);
    const refused = await call(wired, "save_alert_routine", { url: ROUTINE_URL, token: TEST_PIN_KEY });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(ROUTINE_NEEDED);
    expect(refused.raw).not.toContain(TEST_PIN_KEY);
    await drain(wired);
    expect(posts).toEqual([]);
    expect(wired.env().CLEANER_CORE_ROUTINE_URL).toBeUndefined();
    expect(wired.env().CLEANER_CORE_ROUTINE_KEY).toBeUndefined();
  });

  it("cleaner YES wakes the routine", async () => {
    const wired = await app();
    const posts = alertStub(() => 200);
    expect((await call(wired, "save_alert_routine", { url: ROUTINE_URL, token: ROUTINE_KEY })).isError).toBe(false);
    await drain(wired);
    expect(posts).toHaveLength(1);
    await readyForYes(wired);
    await drain(wired);
    // Grok caused those steps and already heard the replies, so nothing wakes the routine for them.
    expect(posts).toHaveLength(1);
    await yes(wired, "SM-wake-yes-1");
    await drain(wired);
    // Grok reads every message, so the opt-in YES wakes it too.
    expect(posts).toHaveLength(2);
    await yes(wired, "SM-wake-yes-2");
    await drain(wired);
    const wakes = posts.slice(1);
    expect(wakes).toHaveLength(2);
    const raw = wakes[1]?.body ?? "";
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["schemaVersion", "eventId", "eventType", "occurredAt"]);
    expect(body.eventType).toBe("cleaning.update");
    expect(raw).not.toContain("+1");
    expect(raw).not.toContain(DOOR_CODE);
    const checked = await call(wired, "check_now", { googleEvents: withNext(WAKE_STAY) });
    expect(checked.isError).toBe(false);
    const alerts = alertsOf(checked);
    expect(alerts).toContain(YES_NOTE);
    for (const line of alerts) expect(raw).not.toContain(line);
    expect(liveFile(wired)).not.toContain(ROUTINE_KEY);
  });

  it("routine down keeps the event", async () => {
    let now = new Date(FROZEN);
    let status = 200;
    const wired = await app({ now: () => now });
    const posts = alertStub(() => status);
    expect((await call(wired, "save_alert_routine", { url: ROUTINE_URL, token: ROUTINE_KEY })).isError).toBe(false);
    await drain(wired, () => now);
    expect(posts).toHaveLength(1);
    status = 503;
    await readyForYes(wired);
    await yes(wired, "SM-down-yes-1");
    await yes(wired, "SM-down-yes-2");
    await drain(wired, () => now);
    expect(posts.length).toBeGreaterThan(1);
    const pending = cleaningUpdates(wired);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("pending");
    const checked = await call(wired, "check_now", { googleEvents: withNext(WAKE_STAY) });
    expect(alertsOf(checked)).toContain(YES_NOTE);
    status = 200;
    const tried = posts.length;
    now = new Date(now.getTime() + 60 * 60_000);
    await drain(wired, () => now);
    expect(posts).toHaveLength(tried + 1);
    expect(JSON.parse(posts[tried]?.body ?? "{}").eventType).toBe("cleaning.update");
    expect(cleaningUpdates(wired)[0]?.status).toBe("delivered");
  });

  it("no routine saved", async () => {
    const wired = await app();
    const posts = alertStub(() => 200);
    await readyForYes(wired);
    await yes(wired, "SM-none-yes-1");
    await yes(wired, "SM-none-yes-2");
    await expect(drain(wired)).resolves.toBeUndefined();
    expect(posts).toEqual([]);
    const queued = cleaningUpdates(wired);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.status).toBe("pending");
  });
});

async function rpc(method: string): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), "cleaner-rpc-"));
  try {
    const desk = liveDeskFor(root, () => deskEnv(), () => new Date(FROZEN));
    const reply = await handleCleanerMcpMessage(desk, { jsonrpc: "2.0", id: 1, method });
    return (reply.body as { result: Record<string, unknown> }).result;
  } finally {
    resetLiveDesks();
    rmSync(root, { recursive: true, force: true });
  }
}

const ROUTINE_NEXT =
  "Create the Cleaner Core Check and Cleaner Core Alerts routines. Only the host can see the Alerts routine's webhook address and key. Right after you create it, without waiting to be asked, send the host a link that opens the Alerts routine's Webhook URL field directly and one that opens its Webhook key field directly, with one secure card for each, the address first. Never send a link to the Routines page, and never tell the host to open Routines and pick the routine: opening the routine from there doesn't show its Webhook URL. Keep it to three short steps: open the link, copy the value, paste it in the card. Then call save_alert_routine with no arguments to get a one-time upload link, and send both values to that link from your own computer. Never put them in chat.";
const TIMES_NEXT = "Tell me the checkout time and the next check-in time before I text the cleaner.";

describe("Cleaner Core Grok demo: Grok guidance", () => {
  it("lists check_now and save_alert_routine, and names the upload link", async () => {
    const wired = await app();
    const listed = await wired.listTools(PATH, CLEANER_TOKEN);
    expect(listed.names).toEqual(expect.arrayContaining(["check_now", "save_alert_routine"]));
    const tools = ((await rpc("tools/list")).tools as { name: string; description: string }[]) ?? [];
    const alerts = tools.find((tool) => tool.name === "save_alert_routine");
    expect(alerts?.description).toContain("with no arguments to get a one-time upload link");
    expect(alerts?.description).toContain("webhook address and key to that link from your computer");
    expect(alerts?.description).toContain("Never put them in chat");
    expect(alerts?.description).toContain("never repeats them");
  });

  it("initialize tells Grok when to check, post alerts, and collect secrets", async () => {
    const text = String((await rpc("initialize")).instructions);
    expect(text.startsWith("Call get_state first and follow its next step.")).toBe(true);
    for (const line of [
      "Use check_now when a routine wakes you or the host says check my calendars. Read Google Calendar with your own connector first when the host uses it, only the calendar the host named for bookings. Post each alert in your own short words. Collect the door code only with your secure card, then send it from your own computer to the one-time upload link its setup step gives you. Never put a secret in chat. For the alert routine, send its webhook address and key from your own computer to the one-time upload link that save_alert_routine gives you.",
      "When check_now returns needsTimes, ask the host for the checkout time and the next check-in time, then call confirm_times with each as 24-hour HH:MM. You turn the host's words into clock times; Cleaner Core does not read words.",
      "The door code goes only after the host tells you the guests have left: ask them, then call mark_guests_left with confirmed true. When an alert says a text may not have gone out, ask the host whether to send it again, then call retry_send with confirmed true.",
      "confirm_times keeps a check-in time already saved. To change only the check-in time, tell the host it can't be changed by text yet.",
    ]) {
      expect(text).toContain(line);
    }
  });

  it("asks where bookings come from at the calendar step, with Guesty Lite, Google Calendar, and other links as options", async () => {
    const wired = await app();
    await call(wired, "get_state", { choice: "cleaners" });
    await call(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00", checkInTime: "16:00" });
    const people = await call(wired, "save_people", { host: HOST, cleaner: CLEANER });
    const ask = people.structured?.ask as { step: string; tool: string; questions: { field: string; options?: { value: string }[]; example?: string }[] };
    expect(ask.step).toBe("sources");
    expect(ask.tool).toBe("save_sources");
    expect(ask.questions[0]?.options?.map((option) => option.value)).toEqual(["guesty", "google", "other"]);
    expect(ask.questions.find((question) => question.field === "google")?.example).toBe("Harbor bookings");
    expect(people.structured?.next).toBe("Ask the host the questions in ask, in order, in your own short words. Each message asks exactly one question: never two in one message, even related ones like the checkout and check-in times, or a phone number and a name. Wait for the answer before the next one. When a question has options, show them as a choice card the host can tap, never as a list or a question in the text. Skip a question the host already answered. Then call save_sources.");
    expect((await call(wired, "get_state")).structured?.ask).toEqual(ask);
  });

  it("get_state asks for the routines after the checks, until one is saved", async () => {
    const wired = await app();
    alertStub(() => 200);
    await setUpGoogle(wired);
    expect((await call(wired, "run_checks", { googleEvents: googleList([]) })).isError).toBe(false);
    expect(await done(wired)).toContain("Checks finished.");
    expect((await call(wired, "get_state")).structured?.next).toBe(ROUTINE_NEXT);
    expect((await call(wired, "save_alert_routine", { url: ROUTINE_URL, token: ROUTINE_KEY })).isError).toBe(false);
    expect((await call(wired, "get_state")).structured?.next).toBe(TIMES_NEXT);
  });
});

describe("Cleaner Core Grok demo: needsTimes", () => {
  it("is omitted for a fresh job and set once a released job loses its times", async () => {
    setCleanerGroupFetch(groupStub().impl);
    const wired = await app({ groupChat: true });
    await setUpGoogle(wired);
    const fresh = await call(wired, "run_checks", { googleEvents: withNext(WAKE_STAY) });
    expect(fresh.isError).toBe(false);
    const beforeConfirm = await call(wired, "check_now", { googleEvents: withNext(WAKE_STAY) });
    expect(beforeConfirm.structured?.needsTimes).toBeUndefined();
    expect((await call(wired, "confirm_times", { checkout: "10:30", checkIn: "15:00" })).isError).toBe(false);
    await yes(wired, "SM-needs-yes-1");
    await yes(wired, "SM-needs-yes-2");
    const steady = await call(wired, "check_now", { googleEvents: withNext(WAKE_STAY) });
    // The next guest's own job was never timed, so there is nothing to ask for.
    expect(turnsOf(steady)).toHaveLength(2);
    expect(steady.structured?.needsTimes).toBeUndefined();
    const moved = await call(wired, "check_now", { googleEvents: withNext({ id: "g1", start: "2026-10-10", end: "2026-10-16" }) });
    expect(moved.isError).toBe(false);
    expect((moved.structured?.turns as { checkoutTime: string | null }[])[0]?.checkoutTime).toBeNull();
    expect(moved.structured?.needsTimes).toBe(true);
    expect((await call(wired, "confirm_times", { checkout: "10:30", checkIn: "15:00" })).isError).toBe(false);
    const settled = await call(wired, "check_now", { googleEvents: withNext({ id: "g1", start: "2026-10-10", end: "2026-10-16" }) });
    expect(settled.structured?.needsTimes).toBeUndefined();
  });

  it("ignores a later job the host has not timed, and clears once the moved job is timed again", async () => {
    setCleanerGroupFetch(groupStub().impl);
    const wired = await app({ groupChat: true });
    const stays = [
      { id: "g1", start: "2026-10-10", end: "2026-10-15" },
      { id: "g2", start: "2026-10-20", end: "2026-10-24" },
      { id: "g3", start: "2026-10-28", end: "2026-11-01" },
    ];
    const list = (first: { id: string; start: string; end: string }) => googleList([first, ...stays.slice(1)]);
    await setUpGoogle(wired);
    expect((await call(wired, "run_checks", { googleEvents: list(stays[0]!) })).isError).toBe(false);
    expect((await call(wired, "confirm_times", { checkout: "10:30", checkIn: "15:00" })).isError).toBe(false);
    await yes(wired, "SM-three-yes-1");
    await yes(wired, "SM-three-yes-2");
    const steady = await call(wired, "check_now", { googleEvents: list(stays[0]!) });
    expect(turnsOf(steady).length).toBeGreaterThanOrEqual(3);
    const later = steady.structured?.turns as { checkoutDate: string; checkoutTime: string | null; nextCheckInDate: string | null }[];
    expect(later.some((turn) => turn.nextCheckInDate !== null && turn.checkoutTime === null)).toBe(true);
    expect(steady.structured?.needsTimes).toBeUndefined();
    const again = await call(wired, "check_now", { googleEvents: list(stays[0]!) });
    expect(again.structured?.needsTimes).toBeUndefined();
    const moved = await call(wired, "check_now", { googleEvents: list({ id: "g1", start: "2026-10-10", end: "2026-10-16" }) });
    expect(moved.structured?.needsTimes).toBe(true);
    expect((await call(wired, "confirm_times", { checkout: "10:30", checkIn: "15:00" })).isError).toBe(false);
    const settled = await call(wired, "check_now", { googleEvents: list({ id: "g1", start: "2026-10-10", end: "2026-10-16" }) });
    expect(settled.structured?.needsTimes).toBeUndefined();
  });

  it("with group chat on, a new booking alerts once and leaves get_state notes alone", async () => {
    setCleanerGroupFetch(groupStub().impl);
    const wired = await app({ groupChat: true });
    await setUpGoogle(wired);
    expect((await call(wired, "run_checks", { googleEvents: googleList([]) })).isError).toBe(false);
    const line = `New booking at ${ADDRESS}, checking out Thursday, Oct 15. What are the checkout time and the next check-in time?`;
    const first = await call(wired, "check_now", { googleEvents: withNext(WAKE_STAY) });
    expect(alertsOf(first)).toEqual([line]);
    expect(first.structured?.needsTimes).toBeUndefined();
    expect(alertsOf(await call(wired, "check_now", { googleEvents: withNext(WAKE_STAY) }))).toEqual([]);
    expect(((await call(wired, "get_state")).structured?.notes as string[] | undefined) ?? []).not.toContain(line);
    expect(wired.cleanerSent).toEqual([]);

    // A booking run_checks already reported is not announced again.
    const seen = await app({ groupChat: true });
    await setUpGoogle(seen);
    expect((await call(seen, "run_checks", { googleEvents: withNext(WAKE_STAY) })).isError).toBe(false);
    expect(alertsOf(await call(seen, "check_now", { googleEvents: withNext(WAKE_STAY) }))).not.toContain(line);
  });

  it("is omitted when the open job's stay was removed", async () => {
    setCleanerGroupFetch(groupStub().impl);
    const wired = await app({ groupChat: true });
    await confirmedJob(wired, WAKE_STAY);
    const removed = await call(wired, "check_now", { googleEvents: googleList([]) });
    expect(turnsOf(removed).every((turn) => turn.status === "canceled")).toBe(true);
    expect(removed.structured?.needsTimes).toBeUndefined();
  });
});

/** A stay that checks out on the frozen test day, 2026-10-14. */
const TODAY_STAY = { id: "g1", start: "2026-10-10", end: "2026-10-14" };
/** A stay added after the first job is done. Its own checkout is Oct 28. */
const LATER_STAY = { id: "g3", start: "2026-10-26", end: "2026-10-28" };
const GUESTY_JOBS = ["2026-10-18", "2026-10-22"];
const GOOGLE_STAYS = [
  { id: "g9", start: "2026-10-25", end: "2026-10-27" },
  { id: "g10", start: "2026-10-29", end: "2026-10-31" },
];

async function cleanerSays(wired: WiredApp, body: string, sid: string) {
  const res = await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, to: CLEANER_LINE, body, sid, token: CLEANER_AUTH });
  expect(res.status).toBe(200);
}

function toTheCleaner(wired: WiredApp, from = 0): SentSms[] {
  return wired.cleanerSent.slice(from).filter((item) => item.to === CLEANER);
}

function turnOn(reply: { structured: Record<string, unknown> | undefined }, checkoutDate: string) {
  return (reply.structured?.turns as { checkoutDate: string; status: string; checkoutTime: string | null; nextCheckInTime: string | null }[] | undefined)?.find(
    (turn) => turn.checkoutDate === checkoutDate,
  );
}

/** Google-only setup, the first job confirmed, the code sent, and the cleaner's DONE. */
async function finishedJob(wired: WiredApp) {
  await confirmedJob(wired, TODAY_STAY);
  expect((await call(wired, "mark_guests_left", { confirmed: true })).isError).toBe(false);
  await cleanerSays(wired, "DONE", "SM-first-done");
  expect(turnOn(await call(wired, "get_turns"), "2026-10-14")?.status).toBe("done");
}

/** The Guesty calendar the wired app serves, or a failure when `up` is false. */
function guestyCalendar(up: boolean) {
  setCleanerCalendarFetch(async (url) => ({
    status: up && url === CALENDAR_URL ? 200 : 500,
    url,
    async text() {
      return up && url === CALENDAR_URL ? CALENDAR_ICS : "";
    },
  }));
}

describe("Cleaner Core Grok demo: final review fixes", () => {
  it("a done stay missing from the next day's read sends nothing and stays done", async () => {
    let now = new Date(FROZEN);
    const wired = await app({ now: () => now });
    await finishedJob(wired);
    const before = wired.cleanerSent.length;
    now = new Date(zonedInstant("2026-10-15", "09:00", ZONE));
    const next = await call(wired, "check_now", { googleEvents: googleList([NEXT_STAY]) });
    expect(next.isError).toBe(false);
    expect(toTheCleaner(wired, before)).toEqual([]);
    expect(turnOn(next, "2026-10-14")?.status).toBe("done");
  });

  it("a stay checking out today whose code was sent stays active when it leaves the read", async () => {
    const wired = await app();
    await confirmedJob(wired, TODAY_STAY);
    expect((await call(wired, "mark_guests_left", { confirmed: true })).isError).toBe(false);
    const before = wired.cleanerSent.length;
    const missing = await call(wired, "check_now", { googleEvents: googleList([NEXT_STAY]) });
    expect(missing.isError).toBe(false);
    expect(toTheCleaner(wired, before)).toEqual([]);
    expect(turnOn(missing, "2026-10-14")?.status).not.toBe("canceled");
  });

  it("a stay from an earlier day is not called off when it leaves the read", async () => {
    let now = new Date(FROZEN);
    const wired = await app({ now: () => now });
    await confirmedJob(wired, TODAY_STAY);
    const before = wired.cleanerSent.length;
    now = new Date(zonedInstant("2026-10-15", "09:00", ZONE));
    const missing = await call(wired, "check_now", { googleEvents: googleList([NEXT_STAY]) });
    expect(toTheCleaner(wired, before).map(textKind)).not.toContain("cancel-update");
    expect(turnOn(missing, "2026-10-14")?.status).not.toBe("canceled");
  });

  it("a same-day stay that has not started is still called off once when it is removed", async () => {
    const wired = await app();
    await confirmedJob(wired, TODAY_STAY);
    const before = wired.cleanerSent.length;
    const removed = await call(wired, "check_now", { googleEvents: googleList([NEXT_STAY]) });
    expect(toTheCleaner(wired, before).map(textKind)).toEqual(["cancel-update"]);
    expect(turnOn(removed, "2026-10-14")?.status).toBe("canceled");
    await call(wired, "check_now", { googleEvents: googleList([NEXT_STAY]) });
    expect(toTheCleaner(wired, before).map(textKind)).toEqual(["cancel-update"]);
  });

  for (const groupChat of [false, true]) {
    it(`a second booking after the first job is done is reported and timed (group chat ${groupChat ? "on" : "off"})`, async () => {
      const group = groupChat ? groupStub() : undefined;
      if (group) setCleanerGroupFetch(group.impl);
      const wired = await app({ groupChat });
      await finishedJob(wired);
      const before = wired.cleanerSent.length;
      const postsBefore = group?.posts.length ?? 0;
      const checked = await call(wired, "check_now", { googleEvents: googleList([TODAY_STAY, NEXT_STAY, LATER_STAY]) });
      expect(checked.isError).toBe(false);
      expect(alertsOf(checked).some((line) => line.includes("Saturday, Oct 24"))).toBe(true);
      const times = await call(wired, "confirm_times", { checkout: "11:00", checkIn: "16:00" });
      expect(times.isError).toBe(false);
      expect(times.structured?.next).not.toContain("asking them to reply YES");
      const got = toTheCleaner(wired, before);
      expect(got.some((item) => item.body.includes("Oct 14"))).toBe(false);
      expect(got.map(textKind)).not.toContain("corrected");
      // With group chat on, the offer goes once into the group instead of one-to-one.
      const posted = (group?.posts.slice(postsBefore) ?? []).map((post) => ({ body: post.body }));
      const offers = [...got, ...posted].filter((item) => /reply YES to schedule it/i.test(item.body));
      expect(offers).toHaveLength(1);
      expect(offers[0]?.body).toContain("Saturday, Oct 24");
      expect(offers[0]?.body).toContain("11:00 AM");
      const turns = await call(wired, "get_turns");
      expect(turnOn(turns, "2026-10-14")?.status).toBe("done");
      expect(turnOn(turns, "2026-10-24")).toMatchObject({ checkoutTime: "11:00 AM", nextCheckInTime: "4:00 PM", status: "offered" });
      await cleanerSays(wired, "YES", "SM-second-yes");
      // With group chat on, the confirmation is a group post instead of a one-to-one text.
      const confirmed = [...toTheCleaner(wired, before), ...(group?.posts.slice(postsBefore) ?? [])].filter((item) => item.body.startsWith("Cleaning is scheduled for"));
      expect(confirmed.map((item) => item.body)).toEqual([`Cleaning is scheduled for Saturday, Oct 24 at 11:00 AM at ${ADDRESS}.`]);
    });

    it(`confirm_times works for a stay with no next stay (group chat ${groupChat ? "on" : "off"})`, async () => {
      const group = groupChat ? groupStub() : undefined;
      if (group) setCleanerGroupFetch(group.impl);
      const wired = await app({ groupChat });
      await setUpGoogle(wired);
      expect((await call(wired, "run_checks", { googleEvents: googleList([TODAY_STAY]) })).isError).toBe(false);
      const times = await call(wired, "confirm_times", { checkout: "10:30", checkIn: "15:00" });
      expect(times.isError, times.text).toBe(false);
      const turns = await call(wired, "get_turns");
      expect(turnOn(turns, "2026-10-14")).toMatchObject({ checkoutTime: "10:30 AM", nextCheckInTime: null });
      expect((await call(wired, "check_now", { googleEvents: googleList([TODAY_STAY]) })).structured?.needsTimes).toBeUndefined();
      await yes(wired, "SM-single-yes-1");
      await yes(wired, "SM-single-yes-2");
      const confirmed = [...toTheCleaner(wired), ...(group?.posts ?? [])].filter((item) => item.body.startsWith("Cleaning is scheduled for"));
      expect(confirmed.map((item) => item.body)).toEqual([`Cleaning is scheduled for Wednesday, Oct 14 at 10:30 AM at ${ADDRESS}.`]);
    });
  }

  it("a finished job with no next stay stays done when a later stay is added", async () => {
    const wired = await app();
    await setUpGoogle(wired);
    expect((await call(wired, "run_checks", { googleEvents: googleList([TODAY_STAY]) })).isError).toBe(false);
    expect((await call(wired, "confirm_times", { checkout: "10:30", checkIn: "15:00" })).isError).toBe(false);
    await yes(wired, "SM-lone-yes-1");
    await yes(wired, "SM-lone-yes-2");
    expect((await call(wired, "mark_guests_left", { confirmed: true })).isError).toBe(false);
    await cleanerSays(wired, "DONE", "SM-lone-done");
    const before = wired.cleanerSent.length;
    const added = await call(wired, "check_now", { googleEvents: googleList([TODAY_STAY, NEXT_STAY]) });
    expect(added.isError).toBe(false);
    expect(turnOn(added, "2026-10-14")?.status).toBe("done");
    expect(added.structured?.needsTimes).toBeUndefined();
    // The host is asked about the new turnover, not about the finished one.
    expect(alertsOf(added).some((line) => line.includes("Saturday, Oct 24"))).toBe(true);
    expect(alertsOf(added).some((line) => line.includes("Oct 20"))).toBe(false);
    expect(toTheCleaner(wired, before)).toEqual([]);
  });

  it("after a restart with both calendars, check_now without events keeps the Google jobs", async () => {
    const wired = await app();
    await setUpBoth(wired);
    const list = googleList(GOOGLE_STAYS);
    expect((await call(wired, "run_checks", { googleEvents: list })).isError).toBe(false);
    expect((await call(wired, "check_now", { googleEvents: list })).isError).toBe(false);
    const before = wired.cleanerSent.length;
    resetLiveDesks();
    const bare = await call(wired, "check_now", {});
    expect(bare.isError).toBe(false);
    expect(turnsOf(bare).every((turn) => turn.status !== "canceled")).toBe(true);
    const again = await call(wired, "check_now", { googleEvents: list });
    expect(again.isError).toBe(false);
    expect(turnsOf(again).map((turn) => turn.checkoutDate)).toEqual([...GUESTY_JOBS, "2026-10-27", "2026-10-31"]);
    expect(turnsOf(again).every((turn) => turn.status !== "canceled")).toBe(true);
    expect(kindsSince(wired, before)).not.toContain("cancel-update");
  });

  it("after a restart with Guesty down, Google is applied beside the saved Guesty snapshot", async () => {
    const wired = await app();
    await setUpBoth(wired);
    const list = googleList(GOOGLE_STAYS);
    expect((await call(wired, "run_checks", { googleEvents: list })).isError).toBe(false);
    resetLiveDesks();
    guestyCalendar(false);
    const down = await call(wired, "check_now", { googleEvents: list });
    expect(down.isError).toBe(false);
    expect(down.structured?.guestyUnread).toBe(true);
    expect(turnsOf(down).every((turn) => turn.status !== "canceled")).toBe(true);
    guestyCalendar(true);
    const up = await call(wired, "check_now", { googleEvents: list });
    expect(up.structured?.guestyUnread).toBeUndefined();
    expect(turnsOf(up).map((turn) => turn.checkoutDate)).toEqual([...GUESTY_JOBS, "2026-10-27", "2026-10-31"]);
    expect(turnsOf(up).every((turn) => turn.status !== "canceled")).toBe(true);
  });

  it("ignores Google events when only Guesty is saved", async () => {
    const wired = await app();
    await setUpTo(wired);
    expect((await call(wired, "save_calendar_link", { url: CALENDAR_URL })).isError).toBe(false);
    expect((await call(wired, "save_door_code", { code: DOOR_CODE })).isError).toBe(false);
    expect((await call(wired, "set_up_texting")).isError).toBe(false);
    expect((await call(wired, "run_checks")).isError).toBe(false);
    const checked = await call(wired, "check_now", { googleEvents: googleList(GOOGLE_STAYS) });
    expect(checked.isError).toBe(false);
    expect(turnsOf(checked).map((turn) => turn.checkoutDate)).toEqual(GUESTY_JOBS);
  });

  it("treats a Google list with no readable event as unread", async () => {
    const wired = await app();
    await setUpGoogle(wired);
    expect((await call(wired, "run_checks", { googleEvents: withNext(TODAY_STAY) })).isError).toBe(false);
    const odd = await call(wired, "check_now", { googleEvents: { timeZone: ZONE, items: [{ id: "x", when: "2026-10-14" }, { title: "Guest" }] } });
    expect(odd.isError).toBe(false);
    expect(odd.structured?.googleUnread).toBe(true);
    expect(turnsOf(odd)).toHaveLength(2);
    expect(turnsOf(odd).every((turn) => turn.status !== "canceled")).toBe(true);
    // An empty list is still a read: every stay was removed.
    const empty = await call(wired, "check_now", { googleEvents: googleList([]) });
    expect(empty.structured?.googleUnread).toBeUndefined();
    expect(turnsOf(empty).every((turn) => turn.status === "canceled")).toBe(true);
  });

  it("a check that runs while the door code is sending opens no review", async () => {
    const wired = await app();
    await confirmedJob(wired, TODAY_STAY);
    const slow = fakeSms();
    let sending: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      sending = resolve;
    });
    setCleanerTwilioClient({
      ...slow,
      async sendSms(input) {
        sending();
        await new Promise((resolve) => setTimeout(resolve, 150));
        return slow.sendSms(input);
      },
    });
    const left = call(wired, "mark_guests_left", { confirmed: true });
    // The check starts while the door-code text is still on its way.
    await started;
    const checked = call(wired, "check_now", { googleEvents: withNext(TODAY_STAY) });
    const [leftReply, checkReply] = await Promise.all([left, checked]);
    expect(leftReply.isError).toBe(false);
    expect(leftReply.text).toContain(PIN_SENT);
    expect(checkReply.isError).toBe(false);
    const desk = liveDeskFor(wired.root, wired.env, () => new Date(FROZEN)) as unknown as { engine: CleanerCore };
    expect(desk.engine.reviews().map((item) => item.kind)).not.toContain("uncertain-sms");
    const notes = ((await call(wired, "get_state")).structured?.notes as string[] | undefined) ?? [];
    for (const line of [...alertsOf(checkReply), ...notes]) expect(line).not.toMatch(/may not have gone out|didn't go out/);
    expect(slow.sent.filter((item) => item.body.includes(DOOR_CODE)).map((item) => item.to)).toEqual([CLEANER]);
  });

  it("queues one wake while an earlier one is still waiting", async () => {
    const wired = await app();
    const posts = alertStub(() => 200);
    await readyForYes(wired);
    await yes(wired, "SM-backlog-yes-1");
    await yes(wired, "SM-backlog-yes-2");
    expect(cleaningUpdates(wired).map((record) => record.status)).toEqual(["pending"]);
    expect((await call(wired, "mark_guests_left", { confirmed: true })).isError).toBe(false);
    await cleanerSays(wired, "DONE", "SM-backlog-done");
    expect(cleaningUpdates(wired).map((record) => record.status)).toEqual(["pending"]);
    expect((await call(wired, "save_alert_routine", { url: ROUTINE_URL, token: ROUTINE_KEY })).isError).toBe(false);
    await drain(wired);
    expect(posts.map((post) => JSON.parse(post.body).eventType).filter((type) => type === "cleaning.update")).toHaveLength(1);
    const checked = await call(wired, "check_now", { googleEvents: withNext(WAKE_STAY) });
    expect(alertsOf(checked)).toEqual(expect.arrayContaining([YES_NOTE, `The cleaner marked the cleaning at ${ADDRESS} done.`]));
  });
});

const AIRBNB_URL = "https://calendar.example/airbnb.ics";
const VRBO_URL = "https://calendar.example/vrbo.ics";

function icsOf(events: { uid: string; start: string; end: string }[]): string {
  const lines = ["BEGIN:VCALENDAR"];
  for (const event of events) {
    lines.push("BEGIN:VEVENT", `UID:${event.uid}`, `DTSTART;VALUE=DATE:${event.start}`, `DTEND;VALUE=DATE:${event.end}`, "SUMMARY:Guest", "END:VEVENT");
  }
  lines.push("END:VCALENDAR", "");
  return lines.join("\n");
}

/** Airbnb has one stay. Vrbo has a later stay and the same Airbnb stay under its own UID. */
const AIRBNB_ICS = icsOf([{ uid: "air-1", start: "20261014", end: "20261018" }]);
const VRBO_ICS = icsOf([
  { uid: "vrbo-1", start: "20261020", end: "20261024" },
  { uid: "vrbo-dup", start: "20261014", end: "20261018" },
]);

/** Vrbo with only its own stay. */
const VRBO_ONLY = icsOf([{ uid: "vrbo-1", start: "20261020", end: "20261024" }]);

/** Serves each link's calendar. `null` makes that link fail. */
function serveCalendars(bodies: { airbnb: string | null; vrbo: string | null; guesty?: string | null }) {
  setCleanerCalendarFetch(async (url) => {
    const body = url === AIRBNB_URL ? bodies.airbnb : url === VRBO_URL ? bodies.vrbo : url === CALENDAR_URL ? (bodies.guesty ?? null) : null;
    return {
      status: body === null ? 500 : 200,
      url,
      async text() {
        return body ?? "";
      },
    };
  });
}

async function setUpSources(wired: WiredApp, google: boolean) {
  await setUpTo(wired);
  const saved = await call(wired, "save_sources", {
    calendars: [
      { name: "Airbnb", url: AIRBNB_URL },
      { name: "Vrbo", url: VRBO_URL },
    ],
    ...(google ? { google: true } : {}),
  });
  expect(saved.isError, saved.text).toBe(false);
  expect((await call(wired, "save_door_code", { code: DOOR_CODE })).isError).toBe(false);
  expect((await call(wired, "set_up_texting")).isError).toBe(false);
}

function storeFile(wired: WiredApp): string {
  const path = join(wired.root, "cleaner-job", "cleaner-core.json");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

describe("Cleaner Core Grok demo: several calendar links", () => {
  it("two iCal links and Google make one job per stay", async () => {
    const wired = await app();
    serveCalendars({ airbnb: AIRBNB_ICS, vrbo: VRBO_ICS });
    await setUpSources(wired, true);
    const list = googleList([
      { id: "g1", start: "2026-10-14", end: "2026-10-18" },
      { id: "g5", start: "2026-10-26", end: "2026-10-28" },
    ]);
    const checks = await call(wired, "run_checks", { googleEvents: list });
    expect(checks.isError, checks.text).toBe(false);
    expect(turnsOf(checks).map((turn) => turn.checkoutDate)).toEqual(["2026-10-18", "2026-10-24", "2026-10-28"]);
    const checked = await call(wired, "check_now", { googleEvents: list });
    expect(checked.isError).toBe(false);
    expect(turnsOf(checked).map((turn) => turn.checkoutDate)).toEqual(["2026-10-18", "2026-10-24", "2026-10-28"]);
    expect(turnsOf(checked).every((turn) => turn.status !== "canceled")).toBe(true);
    expect(checked.structured?.unread).toBeUndefined();
    expect(wired.cleanerSent).toEqual([]);
  });

  it("a restart keeps every source", async () => {
    const wired = await app();
    serveCalendars({ airbnb: AIRBNB_ICS, vrbo: VRBO_ICS });
    await setUpSources(wired, false);
    expect((await call(wired, "run_checks")).isError).toBe(false);
    const before = wired.cleanerSent.length;
    expect(storeFile(wired)).not.toContain(AIRBNB_URL);
    expect(storeFile(wired)).not.toContain(VRBO_URL);

    // After a restart, Vrbo fails. Airbnb's new stay is applied, and Vrbo's jobs stay.
    resetLiveDesks();
    serveCalendars({ airbnb: icsOf([{ uid: "air-1", start: "20261014", end: "20261018" }, { uid: "air-2", start: "20261026", end: "20261028" }]), vrbo: null });
    const checked = await call(wired, "check_now", {});
    expect(checked.isError).toBe(false);
    expect(checked.structured?.unread).toEqual(["Vrbo"]);
    expect(checked.structured?.guestyUnread).toBeUndefined();
    expect(checked.text).not.toContain(VRBO_URL);
    expect(turnsOf(checked).map((turn) => turn.checkoutDate)).toEqual(["2026-10-18", "2026-10-24", "2026-10-28"]);
    expect(turnsOf(checked).every((turn) => turn.status !== "canceled")).toBe(true);

    // Another restart with Airbnb down keeps Airbnb's jobs.
    resetLiveDesks();
    serveCalendars({ airbnb: null, vrbo: VRBO_ICS });
    const other = await call(wired, "check_now", {});
    expect(other.isError).toBe(false);
    expect(other.structured?.unread).toEqual(["Airbnb"]);
    expect(turnsOf(other).map((turn) => turn.checkoutDate)).toEqual(["2026-10-18", "2026-10-24", "2026-10-28"]);
    expect(turnsOf(other).every((turn) => turn.status !== "canceled")).toBe(true);
    expect(kindsSince(wired, before)).not.toContain("cancel-update");
  });

  it("save_sources refuses a private or http link", async () => {
    const wired = await app();
    await setUpTo(wired);
    for (const url of ["http://calendar.example/airbnb.ics", "https://192.168.1.20/airbnb.ics", "https://10.0.0.5/airbnb.ics", "https://localhost/airbnb.ics"]) {
      const refused = await call(wired, "save_sources", { calendars: [{ name: "Airbnb", url }] });
      expect(refused.isError).toBe(true);
      expect(refused.text).not.toContain(url);
    }
    // One bad link refuses the whole list.
    const mixed = await call(wired, "save_sources", {
      calendars: [
        { name: "Airbnb", url: AIRBNB_URL },
        { name: "Vrbo", url: "http://calendar.example/vrbo.ics" },
      ],
    });
    expect(mixed.isError).toBe(true);
    expect((await call(wired, "save_sources", { calendars: [] })).isError).toBe(true);
    const nine = Array.from({ length: 9 }, (_, index) => ({ name: `Calendar ${index + 1}`, url: `https://calendar.example/${index}.ics` }));
    expect((await call(wired, "save_sources", { calendars: nine })).isError).toBe(true);
    expect(liveFile(wired)).not.toContain("calendar.example");
    expect((await done(wired)).some((line) => /calendar/i.test(line))).toBe(false);
    // Google alone is enough.
    expect((await call(wired, "save_sources", { google: true })).isError).toBe(false);
    expect(await done(wired)).toContain("Google Calendar saved.");
  });

  it("two links with the same name stay two sources", async () => {
    const wired = await app();
    serveCalendars({ airbnb: AIRBNB_ICS, vrbo: icsOf([{ uid: "vrbo-1", start: "20261020", end: "20261024" }]) });
    await setUpTo(wired);
    const saved = await call(wired, "save_sources", {
      calendars: [
        { name: "Airbnb", url: AIRBNB_URL },
        { name: "airbnb!", url: VRBO_URL },
      ],
    });
    expect(saved.isError).toBe(false);
    expect(await done(wired)).toContain("2 calendar links saved.");
    expect((await call(wired, "save_door_code", { code: DOOR_CODE })).isError).toBe(false);
    expect((await call(wired, "set_up_texting")).isError).toBe(false);
    const checks = await call(wired, "run_checks");
    expect(turnsOf(checks).map((turn) => turn.checkoutDate)).toEqual(["2026-10-18", "2026-10-24"]);
  });

  it("save_calendar_link still saves one link", async () => {
    const wired = await app();
    await setUpTo(wired);
    expect((await call(wired, "save_calendar_link", { url: CALENDAR_URL })).isError).toBe(false);
    expect(await done(wired)).toContain("Calendar link saved.");
    expect(JSON.parse(liveFile(wired)).calendarLink).toBe(CALENDAR_URL);
    expect((await call(wired, "save_door_code", { code: DOOR_CODE })).isError).toBe(false);
    expect((await call(wired, "set_up_texting")).isError).toBe(false);
    const checks = await call(wired, "run_checks");
    expect(checks.isError).toBe(false);
    expect(turnsOf(checks).map((turn) => turn.checkoutDate)).toEqual(GUESTY_JOBS);
    guestyCalendar(false);
    const down = await call(wired, "check_now", {});
    expect(down.structured?.guestyUnread).toBe(true);
    expect(down.structured?.unread).toEqual(["Guesty Lite"]);
    expect(turnsOf(down).every((turn) => turn.status !== "canceled")).toBe(true);
  });
});

const AIRBNB = { name: "Airbnb", url: AIRBNB_URL };
const VRBO = { name: "Vrbo", url: VRBO_URL };

function engineOf(wired: WiredApp): CleanerCore {
  return (liveDeskFor(wired.root, wired.env, () => new Date(FROZEN)) as unknown as { engine: CleanerCore }).engine;
}

function offersTo(wired: WiredApp): number {
  return toTheCleaner(wired).filter((item) => /Reply YES to schedule it/.test(item.body)).length;
}

describe("Cleaner Core Grok demo: editing calendars never silently cancels a cleaning", () => {
  it("removing a calendar that alone holds an upcoming job is refused until dropJobs", async () => {
    const wired = await app();
    serveCalendars({ airbnb: AIRBNB_ICS, vrbo: VRBO_ONLY });
    await setUpSources(wired, false);
    expect((await call(wired, "run_checks")).isError).toBe(false);
    const saved = liveFile(wired);
    const refused = await call(wired, "save_sources", { calendars: [AIRBNB] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe("Removing that calendar would call off 1 upcoming cleaning. Ask the host, then save again with dropJobs: true.");
    expect(refused.structured?.wouldCancel).toEqual([{ checkoutDate: "2026-10-24" }]);
    expect(liveFile(wired)).toBe(saved);
    const still = await call(wired, "check_now", {});
    expect(turnsOf(still).map((turn) => turn.checkoutDate)).toEqual(["2026-10-18", "2026-10-24"]);
    expect(turnsOf(still).every((turn) => turn.status !== "canceled")).toBe(true);
    const dropped = await call(wired, "save_sources", { calendars: [AIRBNB], dropJobs: true });
    expect(dropped.isError, dropped.text).toBe(false);
    const after = await call(wired, "check_now", {});
    expect(turnOn(after, "2026-10-24")?.status).toBe("canceled");
    expect(turnOn(after, "2026-10-18")?.status).not.toBe("canceled");
  });

  it("omitting google keeps Google, and turning it off asks first", async () => {
    const wired = await app();
    serveCalendars({ airbnb: AIRBNB_ICS, vrbo: VRBO_ONLY });
    await setUpSources(wired, true);
    expect((await call(wired, "run_checks", { googleEvents: googleList([{ id: "g5", start: "2026-10-26", end: "2026-10-28" }]) })).isError).toBe(false);
    expect((await call(wired, "save_sources", { calendars: [AIRBNB, VRBO] })).isError).toBe(false);
    expect(await done(wired)).toContain("Google Calendar saved.");
    const off = await call(wired, "save_sources", { calendars: [AIRBNB, VRBO], google: false });
    expect(off.isError).toBe(true);
    expect(off.structured?.wouldCancel).toEqual([{ checkoutDate: "2026-10-28" }]);
    expect(await done(wired)).toContain("Google Calendar saved.");
  });

  it("save_calendar_link keeps the other calendars", async () => {
    const wired = await app();
    serveCalendars({ airbnb: AIRBNB_ICS, vrbo: VRBO_ONLY, guesty: CALENDAR_ICS });
    await setUpTo(wired);
    expect((await call(wired, "save_sources", { calendars: [AIRBNB, VRBO] })).isError).toBe(false);
    expect((await call(wired, "save_calendar_link", { url: CALENDAR_URL })).isError).toBe(false);
    expect(await done(wired)).toContain("3 calendar links saved.");
    const file = JSON.parse(liveFile(wired)) as { calendarLink?: string; calendars?: unknown[] };
    expect(file.calendarLink).toBe(CALENDAR_URL);
    expect(file.calendars).toEqual([AIRBNB, VRBO]);
    expect((await call(wired, "save_door_code", { code: DOOR_CODE })).isError).toBe(false);
    expect((await call(wired, "set_up_texting")).isError).toBe(false);
    const checks = await call(wired, "run_checks");
    expect(checks.isError, checks.text).toBe(false);
    expect(turnsOf(checks).map((turn) => turn.checkoutDate)).toEqual(["2026-10-18", "2026-10-22", "2026-10-24"]);
  });

  it("reordering or removing a duplicate calendar keeps the job, its times, and the cleaner's YES", async () => {
    const wired = await app();
    serveCalendars({ airbnb: AIRBNB_ICS, vrbo: VRBO_ICS });
    await setUpSources(wired, false);
    expect((await call(wired, "run_checks")).isError).toBe(false);
    expect((await call(wired, "confirm_times", { checkout: "10:30", checkIn: "15:00" })).isError).toBe(false);
    await yes(wired, "SM-dup-yes-1");
    await yes(wired, "SM-dup-yes-2");
    const job = engineOf(wired).jobs().find((item) => item.checkoutDate === "2026-10-18");
    expect(job?.status).not.toBe("discovered");
    const before = wired.cleanerSent.length;
    const offered = offersTo(wired);

    expect((await call(wired, "save_sources", { calendars: [VRBO, AIRBNB] })).isError).toBe(false);
    const reordered = await call(wired, "check_now", {});
    expect(turnOn(reordered, "2026-10-18")).toMatchObject({ checkoutTime: "10:30 AM", nextCheckInTime: "3:00 PM", status: job?.status });
    expect(engineOf(wired).jobs().find((item) => item.checkoutDate === "2026-10-18")?.id).toBe(job?.id);

    // Vrbo still lists the stay, so removing Airbnb calls nothing off and needs no dropJobs.
    const removed = await call(wired, "save_sources", { calendars: [VRBO] });
    expect(removed.isError, removed.text).toBe(false);
    const after = await call(wired, "check_now", {});
    expect(turnOn(after, "2026-10-18")).toMatchObject({ checkoutTime: "10:30 AM", nextCheckInTime: "3:00 PM", status: job?.status });
    expect(engineOf(wired).jobs().find((item) => item.checkoutDate === "2026-10-18")?.id).toBe(job?.id);
    expect(kindsSince(wired, before)).not.toContain("cancel-update");
    expect(offersTo(wired)).toBe(offered);
    expect(toTheCleaner(wired, before)).toEqual([]);
  });

  it("a different guest on the same checkout day is a new job", async () => {
    const wired = await app();
    const guestA = { id: "gA", start: "2026-10-14", end: "2026-10-18" };
    const guestB = { id: "gB", start: "2026-10-16", end: "2026-10-18" };
    await confirmedJob(wired, guestA);
    expect(engineOf(wired).jobs().find((job) => job.id === "google:gA")?.checkoutTime).toBe("10:30 AM");
    const before = wired.cleanerSent.length;
    const first = await call(wired, "check_now", { googleEvents: withNext(guestB) });
    expect(first.isError).toBe(false);
    const second = await call(wired, "check_now", { googleEvents: withNext(guestB) });
    const jobs = engineOf(wired).jobs();
    // Guest A's job is called off the usual way. The cleaner hears once, and nothing carries over.
    expect(jobs.find((job) => job.id === "google:gA")?.status).toBe("canceled");
    expect(toTheCleaner(wired, before).map(textKind)).toEqual(["cancel-update"]);
    // Guest B is a new job with no time and no YES, and the host is asked its checkout time.
    expect(jobs.find((job) => job.id === "google:gB")).toMatchObject({ status: "discovered", checkoutTime: null, nextCheckInTime: null });
    const asked = [...alertsOf(first), ...alertsOf(second)].filter((line) => line.startsWith(HOST_CHECKOUT));
    expect(asked.some((line) => line.includes("Oct 18"))).toBe(true);
    expect(toTheCleaner(wired, before).some((item) => item.body.startsWith("Cleaning is scheduled for"))).toBe(false);
  });

  it("swapping labels on two links never cancels a stay when one then fails", async () => {
    const wired = await app();
    serveCalendars({ airbnb: AIRBNB_ICS, vrbo: VRBO_ONLY });
    await setUpSources(wired, false);
    expect((await call(wired, "run_checks")).isError).toBe(false);
    const swapped = await call(wired, "save_sources", {
      calendars: [
        { name: "Airbnb", url: VRBO_URL },
        { name: "Vrbo", url: AIRBNB_URL },
      ],
    });
    expect(swapped.isError, swapped.text).toBe(false);
    serveCalendars({ airbnb: null, vrbo: VRBO_ONLY });
    const checked = await call(wired, "check_now", {});
    expect(checked.isError).toBe(false);
    expect(checked.structured?.unread).toEqual(["Vrbo"]);
    expect(turnsOf(checked).map((turn) => turn.checkoutDate)).toEqual(["2026-10-18", "2026-10-24"]);
    expect(turnsOf(checked).every((turn) => turn.status !== "canceled")).toBe(true);
  });

  it("a store saved before snapshots were kept applies nothing when a link fails", async () => {
    const wired = await app();
    serveCalendars({ airbnb: AIRBNB_ICS, vrbo: VRBO_ONLY });
    await setUpSources(wired, false);
    expect((await call(wired, "run_checks")).isError).toBe(false);
    resetLiveDesks();
    const path = join(wired.root, "cleaner-job", "cleaner-core.json");
    const store = JSON.parse(readFileSync(path, "utf8")) as { snapshots?: unknown; tenants?: Record<string, { snapshots?: unknown }> };
    const slices = store.tenants ? Object.values(store.tenants) : [store];
    expect(slices.some((slice) => slice.snapshots !== undefined)).toBe(true);
    for (const slice of slices) delete slice.snapshots;
    writeFileSync(path, `${JSON.stringify(store)}\n`);
    serveCalendars({ airbnb: icsOf([{ uid: "air-1", start: "20261014", end: "20261018" }, { uid: "air-2", start: "20261026", end: "20261028" }]), vrbo: null });
    const checked = await call(wired, "check_now", {});
    expect(checked.isError).toBe(false);
    expect(checked.structured?.unread).toEqual(["Vrbo"]);
    expect(turnsOf(checked).map((turn) => turn.checkoutDate)).toEqual(["2026-10-18", "2026-10-24"]);
    expect(turnsOf(checked).every((turn) => turn.status !== "canceled")).toBe(true);
  });
});

const LANE = SCRATCH_TENANTS[0];
const PIN_SENT = "I sent the door code to the cleaner. I'll tell you if it doesn't go through.";
const PIN_SENT_GROUP = "I posted the door code in the cleaning group for the cleaner. I'll tell you if it doesn't go through.";

interface OutText {
  label: string;
  status: string;
  body: string;
}

/**
 * The plain door code as its own token. Saved files hold random hex ids (event ids, sids), and a bare
 * substring check would fail now and then when one of them happens to contain the four digits.
 */
const PLAIN_CODE = new RegExp(`(?<![0-9A-Za-z])${DOOR_CODE}(?![0-9A-Za-z])`);

describe("Cleaner Core Grok demo: Scratch rehearsal", () => {
  it("demo script", async () => {
    if (!LANE) throw new Error("missing tenant");
    const address = LANE.property.address;
    const scratchNumbers = new Set([LANE.ownerPhone, LANE.cleanerPhone]);
    const yesNote = `The cleaner said YES to the turnover at ${address}.`;
    const readyNote = `The cleaner marked the cleaning at ${address} done.`;
    const today = { id: "g1", start: "2026-10-10", end: "2026-10-14" };
    const group = groupStub();
    setCleanerGroupFetch(group.impl);
    const routine = alertStub(() => 200);
    let now = new Date(zonedInstant("2026-10-14", "06:00", ZONE));
    const clock = () => now;
    const wired = await app({ scratchTools: true, groupChat: true, allowlist: `${LANE.ownerPhone},${LANE.cleanerPhone}`, now: clock });
    const replies: string[] = [];

    const say = async (name: string, args: Record<string, unknown> = {}) => {
      const reply = await call(wired, name, args);
      replies.push(reply.raw);
      expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
      return reply;
    };
    const texts = async (): Promise<OutText[]> => ((await say("read_outbox")).structured?.texts as OutText[] | undefined) ?? [];
    const labelled = async (label: string) => (await texts()).filter((item) => item.label === label);
    const fromCleaner = async (text: string) => {
      expect((await say("send_test_text", { from: LANE.cleanerPhone, text })).structured?.next).toBe("The test text went through.");
    };
    const notesNow = async () => ((await say("get_state")).structured?.notes as string[] | undefined) ?? [];

    /** The checks the rehearsal makes after every step. */
    const safe = async (step: string) => {
      await drain(wired, clock);
      for (const sms of [...wired.cleanerSent, ...wired.tourSent]) expect(scratchNumbers.has(sms.to), `${step}: text to ${sms.to}`).toBe(true);
      // The door code goes to the cleaner, in a private text or in a group of only the host and the cleaner.
      for (const sms of wired.cleanerSent) if (sms.body.includes(DOOR_CODE)) expect(sms.to, step).toBe(LANE.cleanerPhone);
      for (const post of group.posts) {
        for (const to of post.to) expect(scratchNumbers.has(to), `${step}: group post to ${to}`).toBe(true);
        if (post.body.includes(DOOR_CODE)) expect([...post.to].sort(), step).toEqual([LANE.ownerPhone, LANE.cleanerPhone].sort());
      }
      for (const post of routine) {
        expect(post.url, step).toBe(ROUTINE_URL);
        expect(post.body, step).not.toContain("+1");
        expect(post.body, step).not.toMatch(PLAIN_CODE);
      }
      const files = filesUnder(wired.root);
      expect(files.some((path) => path.endsWith("cleaner-live.json")), step).toBe(true);
      for (const path of files) expect(PLAIN_CODE.test(readFileSync(path, "utf8")), `${step}: ${path}`).toBe(false);
      expect(replies.join("\n"), step).not.toMatch(PLAIN_CODE);
      expect(wired.logs.join("\n"), step).not.toMatch(PLAIN_CODE);
    };

    // 1. Setup with Google, then the routines.
    await say("get_state", { choice: "cleaners" });
    await say("save_property", { business: "Scratch", address, timeZone: ZONE });
    await say("save_people", { host: LANE.ownerPhone, cleaner: LANE.cleanerPhone });
    await say("save_calendar_link", { google: true });
    await say("save_door_code", { code: DOOR_CODE });
    await say("set_up_texting");
    await say("run_checks", { googleEvents: googleList([]) });
    const lines = await done(wired);
    expect(lines).toContain("Group chat set up with you and the cleaner.");
    expect(lines).toContain("Checks finished.");
    expect((await say("get_state")).structured?.next).toBe(ROUTINE_NEXT);
    await say("save_alert_routine", { url: ROUTINE_URL, token: ROUTINE_KEY });
    expect((await say("get_state")).structured?.next).toBe(TIMES_NEXT);
    await safe("1 setup");

    // 2. Saad adds one stay that checks out today. No next stay is needed.
    const booked = await say("check_now", { googleEvents: googleList([today]) });
    // With group chat on, Grok collects the times, so the alert names the booking and asks for both.
    expect(alertsOf(booked)).toContain(`New booking at ${address}, checking out Wednesday, Oct 14. What are the checkout time and the next check-in time?`);
    expect(await labelled("Cleaning offer to the cleaner")).toEqual([]);
    await safe("2 new booking");

    // 3. The host's times. With no next stay, only the checkout time is saved.
    await say("confirm_times", { checkout: "10:00", checkIn: "15:00" });
    const optIn = await labelled("Opt-in text to the cleaner");
    expect(optIn).toHaveLength(1);
    // With group chat on, the opt-in is the invitation to the cleaning group.
    expect(optIn[0]?.body).toContain(`wants to set up a group chat with you for cleaner services at ${address}`);
    expect(optIn[0]?.body).toContain("Reply YES");
    await safe("3 times");

    // 4. The cleaner replies YES twice. The first YES accepts the group invite and brings the offer.
    // The second YES takes the offer.
    await fromCleaner("YES");
    // The offer goes once, into the group, and asks the cleaner by name. There is no one-to-one copy.
    // It is the group's first text, so the intro leads it in the same post.
    const offers = await labelled("Cleaning offer to the group");
    expect(offers.map((item) => item.body.startsWith("Hi ") && item.body.includes(`\n\nTurnover at ${address} on Wednesday, Oct 14. Checkout 10:00 AM`))).toEqual([true]);
    await fromCleaner("YES");
    expect(await labelled("Confirmation to the group")).toHaveLength(1);
    const heard = alertsOf(await say("check_now", { googleEvents: googleList([today]) }));
    expect([...heard, ...(await notesNow())]).toContain(yesNote);
    await safe("4 cleaner YES");
    // The YES woke the routine with an event that carries no text, number, or code.
    expect(routine.map((post) => JSON.parse(post.body).eventType)).toContain("cleaning.update");

    // 5. The reminder goes out on the first check at or after 8 AM on the cleaning day.
    expect(await labelled("Reminder to the group")).toEqual([]);
    now = new Date(zonedInstant("2026-10-14", "08:00", ZONE));
    await say("check_now", { googleEvents: googleList([today]) });
    expect(await labelled("Reminder to the group")).toHaveLength(1);
    await say("check_now", { googleEvents: googleList([today]) });
    expect(await labelled("Reminder to the group")).toHaveLength(1);
    await safe("5 reminder");

    // 6. The guests leave. The code goes into the group of the host and the cleaner, shown redacted.
    expect((await say("mark_guests_left", { confirmed: true })).text).toContain(PIN_SENT_GROUP);
    const door = await labelled("Door code text to the group");
    expect(door).toHaveLength(1);
    expect(door[0]?.body).toContain("Door code: [redacted].");
    expect(door[0]?.body).not.toContain(DOOR_CODE);
    expect(wired.cleanerSent.filter((sms) => sms.body.includes(DOOR_CODE))).toEqual([]);
    expect(group.posts.filter((post) => post.body.includes(DOOR_CODE)).map((post) => [...post.to].sort())).toEqual([[LANE.ownerPhone, LANE.cleanerPhone].sort()]);
    await safe("6 guests left");

    // 7. The cleaner says DONE. The host's ready note comes back to Grok.
    await fromCleaner("DONE");
    const ready = alertsOf(await say("check_now", { googleEvents: googleList([today]) }));
    expect([...ready, ...(await notesNow())]).toContain(readyNote);
    // Both done lines are group posts now, so the outbox shows both as posts to the group.
    expect(await labelled("Done note to the host")).toEqual([]);
    expect(await labelled("Done note to the cleaner")).toEqual([]);
    expect(await labelled("Done note to the group")).toHaveLength(2);
    await safe("7 done");

    // Booking changes run on the same property, with no reset, as on the real phones.
    const firstDone = async () => {
      const turns = (await say("get_turns")).structured?.turns as { checkoutDate: string; status: string }[];
      expect(turns.find((turn) => turn.checkoutDate === "2026-10-14")?.status).toBe("done");
    };
    const aboutFirstJob = async () => (await texts()).filter((item) => item.body.includes("Oct 14")).length;
    const firstJobTexts = await aboutFirstJob();

    // 8. Saad adds a later stay. Grok reports it and asks for the times. The finished job stays done.
    const second = { id: "g2", start: "2026-10-20", end: "2026-10-24" };
    const secondBooked = await say("check_now", { googleEvents: googleList([today, second]) });
    expect(alertsOf(secondBooked)).toContain(`New booking at ${address}, checking out Saturday, Oct 24. What are the checkout time and the next check-in time?`);
    expect(secondBooked.structured?.needsTimes).toBeUndefined();
    await firstDone();
    await safe("8 second booking");

    // 9. The host's times. The cleaner already joined, so the offer goes out at once with no second invite.
    const secondTimes = await say("confirm_times", { checkout: "11:00", checkIn: "16:00" });
    expect(secondTimes.structured?.next).toBe("Times saved. I sent the cleaner the cleaning offer. They reply YES to take it.");
    expect(await labelled("Opt-in text to the cleaner")).toHaveLength(1);
    const secondOffers = (await labelled("Cleaning offer to the group")).filter((item) => item.body.includes("Oct 24"));
    expect(secondOffers.map((item) => item.body.startsWith(`Turnover at ${address} on Saturday, Oct 24. Checkout 11:00 AM`))).toEqual([true]);
    await fromCleaner("YES");
    const confirmations = (await labelled("Confirmation to the group")).map((item) => item.body);
    expect(confirmations).toEqual([expect.stringContaining("Wednesday, Oct 14 at 10:00 AM"), expect.stringContaining("Saturday, Oct 24 at 11:00 AM")]);
    await firstDone();
    await safe("9 second times and YES");

    // 10. Saad moves the second stay. Grok asks again, and the cleaner gets one correction.
    const moved = { id: "g2", start: "2026-10-20", end: "2026-10-25" };
    const movedCheck = await say("check_now", { googleEvents: googleList([today, moved]) });
    expect(movedCheck.structured?.needsTimes).toBe(true);
    expect(await labelled("Time correction to the group")).toEqual([]);
    expect((await say("confirm_times", { checkout: "11:00", checkIn: "16:00" })).structured?.next).toBe(UPDATE_HELD);
    expect(await labelled("Time correction to the group")).toEqual([]);
    // A minute later the next check sends the one update.
    now = new Date(now.getTime() + 60_000);
    await say("check_now", { googleEvents: googleList([today, moved]) });
    const corrected = await labelled("Time correction to the group");
    expect(corrected).toHaveLength(1);
    expect(corrected[0]?.body).toContain("Oct 25 at 11:00 AM");
    await firstDone();
    await safe("10 moved");

    // 11. Saad deletes the second stay. The cleaner gets one cancellation, and the finished job stays done.
    await say("check_now", { googleEvents: googleList([today]) });
    const canceled = await labelled("Cancellation to the group");
    expect(canceled).toHaveLength(1);
    expect(canceled[0]?.body).toContain("Oct 25");
    expect(await labelled("Time correction to the group")).toHaveLength(1);
    await firstDone();
    // Nothing more went out about the first job after it was done.
    expect(await aboutFirstJob()).toBe(firstJobTexts);
    await safe("11 removed");

    // 12. Reset Scratch clears the jobs and the test texts.
    expect((await say("reset_scratch")).structured?.next).toBe("Scratch is reset. No jobs, notes or test texts are left.");
    expect(await texts()).toEqual([]);
    await safe("12 reset");
  }, 60_000);
});

const UPLOAD_URL = "https://routine.example/upload-hook";
const UPLOAD_KEY = "k-test-upload-key-abcdef";
const UPLOAD_PREFIX = `${PUBLIC}/cleaner-core/alert-routine/`;
const UPLOADED = { ok: true, message: "Alerts are connected." };
const UPLOAD_REFUSED = "Send the routine's https webhook address as url and its key as token.";
const UPLOAD_NEXT =
  'From your own cloud computer, POST JSON {"url": "<webhook address>", "token": "<webhook key>"} to uploadUrl with Content-Type: application/json, using the webhook address and key you already hold. Never put them in chat or in a tool argument. Then call get_state to confirm.';
const ROUTINE_NEEDED = "Send the routine's https address and its key. If your secure card can't pass them to a tool, call save_alert_routine with no arguments to get a one-time upload link.";

/** Grok asks for a one-time link. The reply holds only the link, the expiry, and plain instructions. */
async function issueLink(wired: WiredApp): Promise<{ link: string; code: string; raw: string }> {
  const issued = await call(wired, "save_alert_routine", {});
  expect(issued.isError, issued.text).toBe(false);
  const link = String(issued.structured?.uploadUrl);
  expect(link.startsWith(UPLOAD_PREFIX), link).toBe(true);
  const code = link.slice(UPLOAD_PREFIX.length);
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(issued.structured?.expiresInMinutes).toBe(10);
  expect(issued.structured?.next).toBe(UPLOAD_NEXT);
  return { link, code, raw: issued.raw };
}

/** Grok's cloud computer posts to the link. The test server answers on 127.0.0.1 at the link's path. */
async function upload(wired: WiredApp, link: string, body: string, contentType = "application/json"): Promise<{ status: number; raw: string }> {
  const res = await fetch(`http://127.0.0.1:${wired.port}${new URL(link).pathname}`, { method: "POST", headers: { "Content-Type": contentType }, body });
  return { status: res.status, raw: await res.text() };
}

/** The code and the values: in no log, no reply, and no file but the secret store (the values only). */
function expectNoTrace(wired: WiredApp, code: string, replies: string[]) {
  const logs = wired.logs.join("\n");
  for (const secret of [code, UPLOAD_URL, UPLOAD_KEY]) {
    expect(logs.includes(secret), "logs").toBe(false);
    for (const reply of replies) expect(reply.includes(secret), reply).toBe(false);
  }
  for (const path of filesUnder(wired.root)) {
    const text = readFileSync(path, "utf8");
    expect(text.includes(code), path).toBe(false);
    if (text.includes('"CLEANER_CORE_ROUTINE_KEY"')) continue;
    expect(text.includes(UPLOAD_URL), path).toBe(false);
    expect(text.includes(UPLOAD_KEY), path).toBe(false);
  }
}

describe("Cleaner Core Grok demo: alert upload link", () => {
  it("issues a link on the app origin and saves nothing yet", async () => {
    const wired = await app();
    const posts = alertStub(() => 200);
    await call(wired, "get_state", { choice: "cleaners" });
    const { code } = await issueLink(wired);
    expect(wired.env().CLEANER_CORE_ROUTINE_URL).toBeUndefined();
    expect(wired.env().CLEANER_CORE_ROUTINE_KEY).toBeUndefined();
    // Only the code's hash is kept.
    const live = liveFile(wired);
    expect(live).not.toContain(code);
    expect(live).toContain(createHash("sha256").update(code).digest("hex"));
    await drain(wired);
    expect(posts).toEqual([]);
  });

  it("saves the routine from the upload, sends the test alert, and moves get_state past the routine step", async () => {
    const wired = await app();
    const posts = alertStub(() => 200);
    await setUpGoogle(wired);
    expect((await call(wired, "run_checks", { googleEvents: googleList([]) })).isError).toBe(false);
    const before = await call(wired, "get_state");
    expect(before.structured?.next).toBe(ROUTINE_NEXT);
    const { link, code } = await issueLink(wired);
    const posted = await upload(wired, link, JSON.stringify({ url: UPLOAD_URL, token: UPLOAD_KEY }));
    expect(posted.status).toBe(200);
    expect(JSON.parse(posted.raw)).toEqual(UPLOADED);
    expect(wired.env().CLEANER_CORE_ROUTINE_URL).toBe(UPLOAD_URL);
    expect(wired.env().CLEANER_CORE_ROUTINE_KEY).toBe(UPLOAD_KEY);
    await vi.waitFor(() => expect(posts).toHaveLength(1), { timeout: 2_000, interval: 10 });
    expect(posts[0]?.url).toBe(UPLOAD_URL);
    expect(posts[0]?.headers.Authorization).toBe(`Bearer ${UPLOAD_KEY}`);
    expect(JSON.parse(posts[0]?.body ?? "{}").eventType).toBe("installation.test");
    const after = await call(wired, "get_state");
    expect(after.structured?.next).toBe(TIMES_NEXT);
    // Used once. A second post with the same code finds nothing.
    const again = await upload(wired, link, JSON.stringify({ url: UPLOAD_URL, token: UPLOAD_KEY }));
    expect(again.status).toBe(404);
    expectNoTrace(wired, code, [posted.raw, again.raw, before.raw, after.raw]);
  });

  it("accepts key as the token's other name", async () => {
    const wired = await app();
    alertStub(() => 200);
    const { link } = await issueLink(wired);
    const posted = await upload(wired, link, JSON.stringify({ url: UPLOAD_URL, key: UPLOAD_KEY }));
    expect(posted.status).toBe(200);
    expect(wired.env().CLEANER_CORE_ROUTINE_KEY).toBe(UPLOAD_KEY);
  });

  it("expires after 10 minutes", async () => {
    let now = new Date(FROZEN);
    const wired = await app({ now: () => now });
    const posts = alertStub(() => 200);
    const { link, code } = await issueLink(wired);
    now = new Date(now.getTime() + 10 * 60_000 + 1_000);
    const late = await upload(wired, link, JSON.stringify({ url: UPLOAD_URL, token: UPLOAD_KEY }));
    expect(late.status).toBe(404);
    expect(wired.env().CLEANER_CORE_ROUTINE_URL).toBeUndefined();
    await drain(wired, () => now);
    expect(posts).toEqual([]);
    expectNoTrace(wired, code, [late.raw]);
  });

  it("a new link makes the earlier one stop working", async () => {
    const wired = await app();
    alertStub(() => 200);
    const first = await issueLink(wired);
    const second = await issueLink(wired);
    expect(second.code).not.toBe(first.code);
    expect((await upload(wired, first.link, JSON.stringify({ url: UPLOAD_URL, token: UPLOAD_KEY }))).status).toBe(404);
    expect(wired.env().CLEANER_CORE_ROUTINE_URL).toBeUndefined();
    expect((await upload(wired, second.link, JSON.stringify({ url: UPLOAD_URL, token: UPLOAD_KEY }))).status).toBe(200);
  });

  it("refuses a bad address or key with 400 and keeps the link usable", async () => {
    const wired = await app();
    const posts = alertStub(() => 200);
    const { link, code } = await issueLink(wired);
    const replies: string[] = [];
    for (const body of [
      { url: "http://routine.example/upload-hook", token: UPLOAD_KEY },
      { url: UPLOAD_URL, token: "short" },
      { url: UPLOAD_URL, token: TEST_PIN_KEY },
      { url: UPLOAD_URL },
      { token: UPLOAD_KEY },
    ]) {
      const refused = await upload(wired, link, JSON.stringify(body));
      expect(refused.status, JSON.stringify(body)).toBe(400);
      const parsed = JSON.parse(refused.raw) as { ok: boolean; error: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toBe(UPLOAD_REFUSED);
      expect(refused.raw).not.toContain(TEST_PIN_KEY);
      replies.push(refused.raw);
    }
    expect(wired.env().CLEANER_CORE_ROUTINE_URL).toBeUndefined();
    await drain(wired);
    expect(posts).toEqual([]);
    const good = await upload(wired, link, JSON.stringify({ url: UPLOAD_URL, token: UPLOAD_KEY }));
    expect(good.status).toBe(200);
    expectNoTrace(wired, code, [...replies, good.raw]);
  });

  it("refuses a body that isn't JSON with 415, and one over 4 KB, without using up the link", async () => {
    const wired = await app();
    alertStub(() => 200);
    const { link } = await issueLink(wired);
    expect((await upload(wired, link, `url=${UPLOAD_URL}&token=${UPLOAD_KEY}`, "application/x-www-form-urlencoded")).status).toBe(415);
    expect((await upload(wired, link, "not json")).status).toBe(415);
    const big = await upload(wired, link, JSON.stringify({ url: UPLOAD_URL, token: UPLOAD_KEY, pad: "x".repeat(5_000) }));
    expect(big.status).toBe(413);
    expect(wired.env().CLEANER_CORE_ROUTINE_URL).toBeUndefined();
    expect((await upload(wired, link, JSON.stringify({ url: UPLOAD_URL, token: UPLOAD_KEY }))).status).toBe(200);
  });

  it("answers 404 for an unknown code, and saves nothing while Cleaner Core is off", async () => {
    const wired = await app();
    alertStub(() => 200);
    const made = `${UPLOAD_PREFIX}${"A".repeat(43)}`;
    expect((await upload(wired, made, JSON.stringify({ url: UPLOAD_URL, token: UPLOAD_KEY }))).status).toBe(404);
    const { link } = await issueLink(wired);
    wired.setEnv({ CLEANER_CORE_ENABLED: undefined });
    const off = await upload(wired, link, JSON.stringify({ url: UPLOAD_URL, token: UPLOAD_KEY }));
    expect(off.status).toBe(404);
    expect(wired.env().CLEANER_CORE_ROUTINE_URL).toBeUndefined();
    expect(wired.env().CLEANER_CORE_ROUTINE_KEY).toBeUndefined();
  });

  it("keeps the old call with url and token working", async () => {
    const wired = await app();
    const posts = alertStub(() => 200);
    const saved = await call(wired, "save_alert_routine", { url: UPLOAD_URL, token: UPLOAD_KEY });
    expect(saved.isError).toBe(false);
    expect(saved.structured?.next).toBe(CONNECTED);
    expect(saved.structured?.uploadUrl).toBeUndefined();
    await drain(wired);
    expect(posts[0]?.headers.Authorization).toBe(`Bearer ${UPLOAD_KEY}`);
  });

  it("points a masked placeholder at the upload link", async () => {
    const wired = await app();
    const refused = await call(wired, "save_alert_routine", { url: "**********", token: "**********" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(ROUTINE_NEEDED);
  });

  it("refuses a real address with a masked key, and a masked address, on both paths", async () => {
    const wired = await app();
    const posts = alertStub(() => 200);
    const masked = [
      { url: UPLOAD_URL, token: "**********" },
      { url: UPLOAD_URL, token: "••••••••••" },
      { url: UPLOAD_URL, token: "●●●●●●●●●●" },
      { url: UPLOAD_URL, token: "xxxxxxxxxx" },
      { url: UPLOAD_URL, token: "XXXXXXXXXX" },
      { url: UPLOAD_URL, token: "aaaaaaaaaa" },
      { url: UPLOAD_URL, token: "k-test-****-key" },
      { url: "https://routine.example/****", token: UPLOAD_KEY },
      { url: "https://routine.example/••••", token: UPLOAD_KEY },
    ];
    for (const args of masked) {
      const refused = await call(wired, "save_alert_routine", args);
      expect(refused.isError, JSON.stringify(args)).toBe(true);
      expect(refused.text).toBe(ROUTINE_NEEDED);
    }
    const { link } = await issueLink(wired);
    for (const body of masked) expect((await upload(wired, link, JSON.stringify(body))).status, JSON.stringify(body)).toBe(400);
    expect(wired.env().CLEANER_CORE_ROUTINE_URL).toBeUndefined();
    expect(wired.env().CLEANER_CORE_ROUTINE_KEY).toBeUndefined();
    await drain(wired);
    expect(posts).toEqual([]);
  });

  it("refuses a key that holds the door code, or is the door-code key in base64url, on both paths", async () => {
    const wired = await app();
    const posts = alertStub(() => 200);
    // A door-code key whose base64 and base64url spellings differ.
    const pinKey = Buffer.alloc(32, 0xfb);
    const asBase64 = pinKey.toString("base64");
    const asBase64Url = pinKey.toString("base64url");
    expect(asBase64Url).not.toBe(asBase64);
    const withKey = (name: string, args: Record<string, unknown> = {}) => wired.tool(PATH, CLEANER_TOKEN, name, args, { pinKey: asBase64 });
    await withKey("get_state", { choice: "cleaners" });
    expect((await withKey("save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE })).isError).toBe(false);
    expect((await withKey("save_people", { host: HOST, cleaner: CLEANER })).isError).toBe(false);
    expect((await withKey("save_calendar_link", { google: true })).isError).toBe(false);
    const code = await withKey("save_door_code", { code: DOOR_CODE });
    expect(code.isError, code.text).toBe(false);
    const holding = `k-test-${DOOR_CODE}-key`;
    for (const token of [holding, asBase64, asBase64Url]) {
      const refused = await withKey("save_alert_routine", { url: UPLOAD_URL, token });
      expect(refused.isError, token).toBe(true);
      expect(refused.raw).not.toContain(DOOR_CODE);
    }
    const issued = await withKey("save_alert_routine", {});
    expect(issued.isError, issued.text).toBe(false);
    const link = String(issued.structured?.uploadUrl);
    for (const token of [holding, asBase64, asBase64Url]) {
      const refused = await upload(wired, link, JSON.stringify({ url: UPLOAD_URL, token }));
      expect(refused.status, token).toBe(400);
      expect(refused.raw).not.toContain(DOOR_CODE);
    }
    // After a restart the issuing key is gone from memory, and the saved code still catches base64url.
    resetLiveDesks();
    expect((await upload(wired, link, JSON.stringify({ url: UPLOAD_URL, token: asBase64Url }))).status).toBe(400);
    expect(wired.env().CLEANER_CORE_ROUTINE_URL).toBeUndefined();
    await drain(wired);
    expect(posts).toEqual([]);
  });

  it("refuses to make a link without the server's public address, even on Railway", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-upload-"));
    try {
      const desk = liveDeskFor(root, () => ({ ...deskEnv(), RAILWAY_PUBLIC_DOMAIN: "cleaner.example" }), () => new Date(FROZEN));
      const saved: unknown[] = [];
      const reply = await desk.saveAlertRoutine({}, (values) => saved.push(values), undefined);
      expect(reply.ok).toBe(false);
      expect(reply.ok ? "" : reply.error).toBe("I can't make an upload link until the server's public address is saved.");
      expect(saved).toEqual([]);
      expect(existsSync(join(root, "cleaner-live.json")) ? readFileSync(join(root, "cleaner-live.json"), "utf8") : "").not.toContain("alertUpload");
    } finally {
      resetLiveDesks();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
