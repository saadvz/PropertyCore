import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveDeskFor, resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch, type LiveDesk, type ToolReply } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { fakeConversations } from "./fakeConversations";
import { ADDRESS, BUSINESS, CALENDAR_ICS, CALENDAR_URL, CLEANER, CLEANER_LINE, DOOR_CODE, FROZEN, HOST, TEST_PIN_KEY, fakeSms } from "./wiringProof";

/** A live desk on 555 numbers for the reply-draft and saved-answer tests. Nothing here texts a real phone. */

export const ZONE = "America/New_York";
export const PIN_KEY = Buffer.from(TEST_PIN_KEY, "base64");
export const LOCK = "back door lockbox";
export const ROUTINE = { url: "https://routine.example/hook", token: "k-test-routine-key" };

const roots: string[] = [];

/** Call in afterEach. */
export function cleanupDesks(): void {
  setCleanerTwilioClient(undefined);
  setCleanerGroupFetch(undefined);
  setCleanerCalendarFetch(undefined);
  setCleanerAlertFetch(undefined);
  resetLiveDesks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

/** A clock the test moves by hand. */
export function testClock(start = FROZEN) {
  let at = new Date(start);
  return {
    now: () => at,
    advance(ms: number) {
      at = new Date(at.getTime() + ms);
    },
  };
}

export function openDesk(phones: string[], groupChat: "0" | "1", now: () => Date = () => new Date(FROZEN)) {
  const root = mkdtempSync(join(tmpdir(), "cleaner-replies-"));
  roots.push(root);
  const sms = fakeSms();
  const groups = fakeConversations();
  setCleanerTwilioClient(sms);
  setCleanerGroupFetch(groups.impl);
  setCleanerAlertFetch(async () => ({ status: 200 }));
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
    CLEANER_CORE_GROUP_CHAT: groupChat,
    CLEANER_CORE_SMS_ALLOWLIST: phones.join(","),
    CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
    CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
    CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    CLEANER_CORE_ROUTINE_URL: ROUTINE.url,
    CLEANER_CORE_ROUTINE_KEY: ROUTINE.token,
  };
  const desk = liveDeskFor(root, () => env, now);
  return { desk, sms, groups, root, env, now, reopen: () => (resetLiveDesks(), liveDeskFor(root, () => env, now)) };
}

export function ok(reply: ToolReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

export function refused(reply: ToolReply): { error: string; result?: Record<string, unknown> } {
  if (reply.ok) throw new Error(`Expected a refusal, got ${JSON.stringify(reply.result)}`);
  return { error: reply.error, ...(reply.result ? { result: reply.result } : {}) };
}

type PeopleInput = Parameters<LiveDesk["savePeople"]>[0];

export async function setUp(desk: LiveDesk, people: Partial<PeopleInput>, preferences: Parameters<LiveDesk["savePreferences"]>[0] = {}) {
  ok(await desk.getState("cleaners"));
  ok(await desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "10:30", checkInTime: "15:00" }));
  ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
  ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", ...people }));
  ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: LOCK }, PIN_KEY));
  ok(await desk.savePreferences(preferences));
  ok(await desk.saveAlertRoutine(ROUTINE, () => undefined));
  ok(await desk.activate());
  ok(await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" }));
}

/** A group of the host and Ana, both opted in. */
export async function liveGroup(now?: () => Date, preferences: Parameters<LiveDesk["savePreferences"]>[0] = {}) {
  const opened = openDesk([HOST, CLEANER], "1", now);
  await setUp(opened.desk, { groupChat: "cleaner-and-host" }, preferences);
  await opened.desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
  await opened.desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
  return opened;
}

/** Ana one-to-one, opted in, with no group. */
export async function liveOneToOne(now?: () => Date) {
  const opened = openDesk([HOST, CLEANER], "0", now);
  await setUp(opened.desk, { groupChat: "cleaner-only" });
  await opened.desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
  return opened;
}

export type OutMessage = { id: string; from: string; name: string; text: string; reply?: string; by?: string; channel?: string };

/** The id of the newest kept message with this text. Calls check_now, which marks messages shown. */
export async function idOf(desk: LiveDesk, text: string): Promise<string> {
  const now = ok(await desk.checkNow());
  const all = [...((now.earlier as OutMessage[] | undefined) ?? []), ...((now.messages as OutMessage[]) ?? [])];
  const found = all.filter((message) => message.text === text).at(-1);
  if (!found) throw new Error(`No kept message "${text}"`);
  return found.id;
}
