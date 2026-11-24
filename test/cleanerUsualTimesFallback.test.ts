import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { liveDeskFor, resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch, type LiveDesk, type ToolReply } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { fakeConversations } from "./fakeConversations";
import { ADDRESS, BUSINESS, CALENDAR_ICS, CALENDAR_URL, CLEANER, CLEANER_LINE, DOOR_CODE, HOST, TEST_PIN_KEY, fakeSms } from "./wiringProof";

/**
 * A real host's offer waited until he talked to Grok Bot (24 Nov): with a group text, a new booking's
 * offer waits for the host's times, and the one ask came in a single check_now reply. Now the ask comes
 * back each day, and on the offer day the usual times are used so the offer goes.
 */

const ZONE = "America/New_York";
const PIN_KEY = Buffer.from(TEST_PIN_KEY, "base64");
const ROUTINE = { url: "https://routine.example/hook", token: "k-test-routine-key" };
const ASK = "New booking at Lake House: check-in Wednesday, Oct 14, checkout Sunday, Oct 18. Use the usual 10:30 AM checkout and 3:00 PM check-in?";
const USED =
  "Nobody confirmed the times for the booking at Lake House checking out Sunday, Oct 18, so I'm offering the cleaner the cleaning with the usual times: checkout 10:30 AM, next check-in 3:00 PM. If either is different, tell your Grok Bot the right times and I'll update the cleaner.";

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

/** Intl may put a narrow no-break space before AM or PM. */
function plain(text: string): string {
  return text.replace(/ /g, " ");
}

function ok(reply: ToolReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

async function untimedDesk(groupChat: "1" | "0", people: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "cleaner-usual-times-"));
  roots.push(root);
  let at = new Date("2026-10-14T15:00:00.000Z");
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
    CLEANER_CORE_GROUP_CHAT: groupChat,
    CLEANER_CORE_SMS_ALLOWLIST: `${HOST},${CLEANER}`,
    CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
    CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
    CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    PUBLIC_BASE_URL: "https://cleaner.example",
    CLEANER_CORE_ROUTINE_URL: ROUTINE.url,
    CLEANER_CORE_ROUTINE_KEY: ROUTINE.token,
  };
  const desk: LiveDesk = liveDeskFor(root, () => env, () => at);
  ok(await desk.getState("cleaners", true));
  ok(await desk.saveProperty({ business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: ZONE, checkoutTime: "10:30", checkInTime: "15:00" }));
  ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
  ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", ...people }));
  ok(await desk.saveDoorCode({ code: DOOR_CODE }, PIN_KEY));
  ok(await desk.savePreferences({}));
  ok(await desk.saveAlertRoutine(ROUTINE, () => undefined));
  ok(await desk.activate());
  const checkAt = async (iso: string) => {
    at = new Date(iso);
    const result = ok(await desk.checkNow());
    return { ...result, alerts: ((result.alerts as string[] | undefined) ?? []).map(plain) };
  };
  const turns = async () => (ok(await desk.getTurns()).turns as { checkoutDate: string; checkoutTime: string | null; nextCheckInTime: string | null }[]);
  const toCleaner = () => [...sms.sent.filter((item) => item.to === CLEANER).map((item) => item.body), ...groups.posts.filter((post) => post.to.includes(CLEANER)).map((post) => post.body)];
  return { desk, checkAt, turns, toCleaner };
}

describe("Cleaner Core: a booking the host never timed", () => {
  it("asks again each day, then on the offer day uses the usual times and tells the host once", async () => {
    const { checkAt, turns, toCleaner } = await untimedDesk("1");
    // Activate's own read asked for the times. The same day's checks don't ask again.
    expect((await checkAt("2026-10-14T15:05:00.000Z")).alerts).not.toContain(ASK);
    expect((await checkAt("2026-10-14T16:05:00.000Z")).alerts).not.toContain(ASK);
    expect(toCleaner()).toEqual([]);
    // The next day the ask comes back. Still nothing to the cleaner.
    expect((await checkAt("2026-10-15T13:05:00.000Z")).alerts).toContain(ASK);
    expect((await checkAt("2026-10-17T12:59:00.000Z")).alerts).not.toContain(USED);
    expect(toCleaner()).toEqual([]);
    expect((await turns())[0]).toEqual(expect.objectContaining({ checkoutDate: "2026-10-18", checkoutTime: null }));

    // 9:00 AM the day before checkout: the usual times are used and the cleaner's texts start.
    const used = await checkAt("2026-10-17T13:00:00.000Z");
    expect(used.alerts).toContain(USED);
    expect(used.alerts).not.toContain(ASK);
    expect((await turns())[0]).toEqual(expect.objectContaining({ checkoutDate: "2026-10-18", checkoutTime: expect.stringMatching(/10:30/), nextCheckInTime: expect.stringMatching(/3:00/) }));
    expect(toCleaner().length).toBeGreaterThan(0);
    // Once: the next check neither repeats the note nor asks again.
    const after = await checkAt("2026-10-17T14:00:00.000Z");
    expect(after.alerts).not.toContain(USED);
    expect(after.alerts).not.toContain(ASK);
  });

  it("waits at least two hours after it first saw the booking", async () => {
    const { checkAt, turns } = await untimedDesk("1");
    // First seen on the offer day itself.
    expect((await checkAt("2026-10-17T13:30:00.000Z")).alerts).toContain(ASK);
    expect((await checkAt("2026-10-17T15:29:00.000Z")).alerts).not.toContain(USED);
    expect((await turns())[0]?.checkoutTime).toBeNull();
    expect((await checkAt("2026-10-17T15:30:00.000Z")).alerts).toContain(USED);
  });

  it("keeps the host's own times", async () => {
    const { desk, checkAt, turns } = await untimedDesk("1");
    await checkAt("2026-10-14T15:05:00.000Z");
    ok(await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" }));
    expect((await checkAt("2026-10-17T13:00:00.000Z")).alerts).not.toContain(USED);
    expect((await turns())[0]).toEqual(expect.objectContaining({ checkoutTime: expect.stringMatching(/11:00/) }));
  });

  it("leaves a setup without a group text to the host's own text", async () => {
    const { checkAt, turns } = await untimedDesk("0");
    await checkAt("2026-10-14T15:05:00.000Z");
    expect((await checkAt("2026-10-17T13:00:00.000Z")).alerts).not.toContain(USED);
    expect((await turns())[0]?.checkoutTime).toBeNull();
  });
});
