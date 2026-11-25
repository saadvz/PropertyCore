import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { liveDeskFor, resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch, type LiveDesk, type ToolReply } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { fakeConversations } from "./fakeConversations";
import { ADDRESS, BUSINESS, CALENDAR_URL, CLEANER, CLEANER_LINE, DOOR_CODE, HOST, TEST_PIN_KEY, fakeSms } from "./wiringProof";

/**
 * A month at one property with a group text (the default), checked every hour the way the hourly
 * Check routine does it, with the booking messes real hosts have had: times the host gave, times
 * nobody gave, a stay whose dates changed after it was timed (which wipes its times), an offer the
 * cleaner never answered, and a booking that shows up mid-month. Two live bugs were this shape: an
 * offer that never went (24 Nov), and a YES that landed on a different cleaning than the one
 * offered (25 Nov). It runs with both offer schedules and checks:
 *
 * - each cleaning gets exactly one offer (or one update when its checkout moved after the offer),
 *   by 9:00 AM on its offer day;
 * - the cleaner's YES schedules the cleaning that was just offered, for the same day;
 * - a YES never gets "already marked done" or a "reply YES" nudge back;
 * - each cleaning the cleaner took gets its door code once the host says the guests left, and DONE
 *   finishes that cleaning.
 */

const ZONE = "America/New_York";
const PIN_KEY = Buffer.from(TEST_PIN_KEY, "base64");
const ROUTINE = { url: "https://routine.example/hook", token: "k-test-routine-key" };
const HOUR = 60 * 60 * 1000;
const ALREADY = "This cleaning is already marked done.";
const NUDGES = [ALREADY, "Reply YES to schedule the cleaning", "I haven't sent the door code yet", "The door code comes after the guests leave"];

interface Stay {
  uid: string;
  start: string;
  end: string;
}

function ics(stays: Stay[]): string {
  const ymd = (day: string) => day.replace(/-/g, "");
  return [
    "BEGIN:VCALENDAR",
    ...stays.flatMap((stay) => ["BEGIN:VEVENT", `UID:${stay.uid}`, `DTSTART;VALUE=DATE:${ymd(stay.start)}`, `DTEND;VALUE=DATE:${ymd(stay.end)}`, "SUMMARY:Reserved", "END:VEVENT"]),
    "END:VCALENDAR",
    "",
  ].join("\n");
}

/** "Sunday, Oct 18" for a YYYY-MM-DD day, the way the cleaner's texts name it. */
function dayName(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** 9:00 AM New York (EDT through Nov 1, EST after) `days` days before a checkout. */
function offerDeadline(checkout: string, days: number): number {
  const [y, m, d] = checkout.split("-").map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d - days));
  const offset = day.getTime() < Date.UTC(2026, 10, 1, 6) ? 4 : 5;
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 9 + offset);
}

function ok(reply: ToolReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

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

async function season(stays: Stay[], schedule?: Parameters<LiveDesk["saveSchedule"]>[0]) {
  const root = mkdtempSync(join(tmpdir(), "cleaner-season-"));
  roots.push(root);
  const clock = { at: new Date("2026-10-14T15:00:00.000Z") };
  const calendar = { stays };
  const sms = fakeSms();
  const groups = fakeConversations();
  setCleanerTwilioClient(sms);
  setCleanerGroupFetch(groups.impl);
  setCleanerCalendarFetch(async (url) => ({
    status: url === CALENDAR_URL ? 200 : 404,
    url,
    async text() {
      return url === CALENDAR_URL ? ics(calendar.stays) : "";
    },
  }));
  const env: NodeJS.ProcessEnv = {
    CLEANER_CORE_ENABLED: "1",
    CLEANER_CORE_LIVE_SMS: "1",
    CLEANER_CORE_GROUP_CHAT: "1",
    CLEANER_CORE_SMS_ALLOWLIST: `${HOST},${CLEANER}`,
    CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
    CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
    CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    PUBLIC_BASE_URL: "https://cleaner.example",
    CLEANER_CORE_ROUTINE_URL: ROUTINE.url,
    CLEANER_CORE_ROUTINE_KEY: ROUTINE.token,
  };
  const desk: LiveDesk = liveDeskFor(root, () => env, () => clock.at);
  ok(await desk.getState("cleaners", true));
  ok(await desk.saveProperty({ business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: ZONE, checkoutTime: "10:30", checkInTime: "15:00" }));
  ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
  ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana" }));
  ok(await desk.saveDoorCode({ code: DOOR_CODE }, PIN_KEY));
  ok(await desk.savePreferences({}));
  if (schedule) ok(await desk.saveSchedule(schedule));
  ok(await desk.saveAlertRoutine(ROUTINE, () => undefined));
  ok(await desk.activate());
  const texts = (phone: string) => [...sms.sent.filter((item) => item.to === phone).map((item) => item.body), ...groups.posts.filter((post) => post.to.includes(phone)).map((post) => post.body)];
  return { desk, clock, calendar, toCleaner: () => texts(CLEANER) };
}

interface Ledger {
  /** Offer texts by the cleaning day they name, with when each went. */
  offers: Map<string, number[]>;
  /** Days whose offer was an update for a moved checkout. */
  updates: Set<string>;
  /** The cleaner's YES to each offer, and what came back. */
  answers: { offeredFor: string; replies: string[] }[];
  codes: string[];
  done: string[];
}

/**
 * Checks every hour until `until`. The cleaner answers every opt-in and every offer with YES,
 * except offers for `ignored` days. The host says the guests left at 1:00 PM on each checkout day
 * the cleaner took, and the cleaner texts DONE two hours later.
 */
async function runSeason(
  setup: Awaited<ReturnType<typeof season>>,
  until: string,
  options: { ignored?: string[]; events?: Record<string, () => Promise<void> | void> } = {},
): Promise<Ledger> {
  const { desk, clock, toCleaner } = setup;
  const ledger: Ledger = { offers: new Map(), updates: new Set(), answers: [], codes: [], done: [] };
  const taken = new Set<string>();
  let seen = 0;
  let inbound = 0;
  const end = Date.parse(until);
  const say = async (text: string) => {
    const before = toCleaner().length;
    await desk.inbound({ id: `cleaner-${inbound++}`, from: CLEANER, text });
    return toCleaner().slice(before);
  };
  for (let at = clock.at.getTime(); at <= end; at += HOUR) {
    clock.at = new Date(at);
    const iso = clock.at.toISOString();
    await options.events?.[iso]?.();
    ok(await desk.checkNow());
    while (seen < toCleaner().length) {
      const body = toCleaner()[seen++]!;
      if (body.includes("Reply YES to join") || body.includes("Reply YES to get cleaning texts")) {
        await say("YES");
        continue;
      }
      // A new offer, or an update for a cleaning whose checkout moved: both wait for the cleaner's YES.
      const moved = /moved to (\w+, \w+ \d+) at .+ reply YES/.exec(body)?.[1];
      const offered = /Turnover at .+? on (\w+, \w+ \d+)\./.exec(body)?.[1] ?? moved;
      if (moved) {
        ledger.updates.add(moved);
        // The cleaning it moved from is no longer on that day.
        const from = ledger.answers.at(-1)?.offeredFor;
        if (from) taken.delete(from);
      }
      if (!offered) continue;
      ledger.offers.set(offered, [...(ledger.offers.get(offered) ?? []), at]);
      if (options.ignored?.includes(offered)) continue;
      const replies = await say("YES");
      seen += replies.length;
      ledger.answers.push({ offeredFor: offered, replies });
      taken.add(offered);
    }
    // 1:00 PM New York on a checkout day the cleaner took: the guests left. DONE two hours later.
    const local = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, weekday: "long", month: "short", day: "numeric", hour: "numeric", hour12: false }).formatToParts(clock.at);
    const hour = Number(local.find((part) => part.type === "hour")?.value);
    const today = `${local.find((part) => part.type === "weekday")?.value}, ${local.find((part) => part.type === "month")?.value} ${local.find((part) => part.type === "day")?.value}`;
    if (taken.has(today) && hour === 13) {
      const before = toCleaner().length;
      // A refusal shows up below as a missing door code.
      await desk.markGuestsLeft({ confirmed: true }, PIN_KEY);
      if (toCleaner().slice(before).some((body) => body.includes(`Door code: ${DOOR_CODE}`))) ledger.codes.push(today);
      seen = toCleaner().length;
    }
    if (taken.has(today) && hour === 15) {
      const replies = await say("DONE");
      seen += replies.length;
      if (replies.some((body) => body.includes("marked done") && body !== ALREADY)) ledger.done.push(today);
    }
  }
  return ledger;
}

function expectOffersOnTime(ledger: Ledger, checkouts: string[], days: number): void {
  for (const checkout of checkouts) {
    const sent = ledger.offers.get(dayName(checkout));
    expect(sent, `offer for ${checkout}`).toBeDefined();
    expect(sent, `one offer for ${checkout}`).toHaveLength(1);
    // An update for a moved checkout waits out the engine's short settle hold, so it gets the next hourly check.
    const slack = ledger.updates.has(dayName(checkout)) ? HOUR : 0;
    expect(sent![0]!, `offer for ${checkout} by 9:00 AM ${days} days before`).toBeLessThanOrEqual(offerDeadline(checkout, days) + slack);
  }
}

function expectYesMatchesOffer(ledger: Ledger): void {
  for (const answer of ledger.answers) {
    const scheduled = answer.replies.filter((body) => body.startsWith("Cleaning is scheduled for"));
    expect(scheduled, `YES to the ${answer.offeredFor} offer: ${JSON.stringify(answer.replies)}`).toHaveLength(1);
    expect(scheduled[0]).toContain(`Cleaning is scheduled for ${answer.offeredFor} at`);
    for (const nudge of NUDGES) expect(answer.replies.some((body) => body.includes(nudge)), `YES to ${answer.offeredFor} got "${nudge}"`).toBe(false);
  }
}

const SCHEDULES = [
  { name: "offer once the times are set", schedule: undefined, days: 1 },
  { name: "offer 3 days before checkout", schedule: { firstText: "days-before-checkout", firstTextDays: 3 } as const, days: 3 },
];

describe("Cleaner Core: a month of bookings with a group text, checked hourly", () => {
  for (const { name, schedule, days } of SCHEDULES) {
    it(`offers every cleaning on time and schedules the one the cleaner said YES to (${name})`, async () => {
      const setup = await season([
        { uid: "s1", start: "2026-10-14", end: "2026-10-18" },
        { uid: "s2", start: "2026-10-18", end: "2026-10-22" },
        { uid: "s3", start: "2026-10-24", end: "2026-10-27" },
        { uid: "s4", start: "2026-10-28", end: "2026-10-30" },
        { uid: "s6", start: "2026-11-04", end: "2026-11-08" },
      ], schedule);
      const { desk, calendar } = setup;
      const ledger = await runSeason(setup, "2026-11-09T02:00:00.000Z", {
        // The cleaner never answers the Oct 30 offer, so that cleaning stays open after its day.
        ignored: [dayName("2026-10-30")],
        events: {
          // The host gives the first cleaning's times. Nobody times the Oct 27 or later ones.
          "2026-10-14T16:00:00.000Z": async () => {
            ok(await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" }));
          },
          // After the first cleaning, the host times the next one (checkout Oct 22).
          "2026-10-18T22:00:00.000Z": async () => {
            ok(await desk.confirmTimes({ checkout: "10:00", checkIn: "15:00" }));
          },
          // That stay now leaves a day later, before its offer went. The date change wipes its times.
          "2026-10-18T23:00:00.000Z": () => {
            calendar.stays = calendar.stays.map((stay) => (stay.uid === "s2" ? { ...stay, end: "2026-10-23" } : stay));
          },
          // A new booking shows up between two others.
          "2026-10-25T15:00:00.000Z": () => {
            calendar.stays = [...calendar.stays, { uid: "s5", start: "2026-11-01", end: "2026-11-03" }];
          },
        },
      });

      const cleanings = ["2026-10-18", "2026-10-23", "2026-10-27", "2026-10-30", "2026-11-03", "2026-11-08"];
      expectOffersOnTime(ledger, cleanings, days);
      expectYesMatchesOffer(ledger);
      const taken = cleanings.filter((day) => day !== "2026-10-30").map(dayName);
      for (const day of taken) expect(ledger.answers.some((answer) => answer.offeredFor === day), `YES to ${day}`).toBe(true);
      // Nothing else was offered, except the Oct 22 cleaning when its offer went before it moved.
      const moved = schedule ? [] : [dayName("2026-10-22")];
      expect([...ledger.offers.keys()].sort()).toEqual([...cleanings.map(dayName), ...moved].sort());
      expect(ledger.codes).toEqual(taken);
      expect(ledger.done).toEqual(taken);
    }, 60_000);
  }
});
