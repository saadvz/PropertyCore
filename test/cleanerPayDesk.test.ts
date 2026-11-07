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
const CODE_IN_USERNAME = "That username has the door code in it, so I can't save it. Ask the host to pay the cleaner in Venmo themselves.";
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


const LINK = `https://venmo.com/${USERNAME}?txn=pay&amount=85.00&audience=private&note=Lake+House+cleaning+Oct+18`;

interface PayDue {
  job: string;
  cleaner: string;
  amount: string;
  link?: string;
  payInVenmo?: true;
  reminder: number;
}

/** A live setup that pays $85 to scratch-cleaner, with the cleaner's DONE taken on Wed Oct 14 at 11:00 AM. */
async function paidCleaning(options: { payments?: "before" | "none"; venmo?: string; root?: string; newCode?: string } = {}) {
  const time = testClock(FROZEN);
  const opened = openDesk(time.now, options.root);
  const { desk } = opened;
  await throughPreferences(desk);
  if (options.payments === "none") ok(await desk.savePayments({ on: false }));
  else await approvePayments(desk, 85, options.venmo ?? USERNAME);
  await goLive(desk);
  if (options.newCode) ok(await desk.saveDoorCode({ code: options.newCode, lockLocation: LOCK }, PIN_KEY));
  ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
  await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
  return { ...opened, time };
}

async function payDueAt(desk: LiveDesk, time: ReturnType<typeof testClock>, iso: string): Promise<PayDue[] | undefined> {
  time.set(iso);
  return ok(await desk.checkNow()).payDue as PayDue[] | undefined;
}

describe("Owed cleanings and payDue", () => {
  it("returns the pay link with the finished cleaning, once", async () => {
    const { desk, time } = await paidCleaning();
    const first = ok(await desk.checkNow());
    expect(first.completed).toBeDefined();
    expect(first.payDue).toEqual([{ job: "2026-10-18", cleaner: "Ana", amount: "$85.00", link: LINK, reminder: 0 }]);
    expect(JSON.stringify(first.payDue).includes("Practice Lane")).toBe(false);
    expect(await payDueAt(desk, time, "2026-10-14T22:00:00.000Z")).toBeUndefined();
    expect(await doneLines(desk)).toContain("1 cleaning unpaid ($85.00).");
  });

  it("reminds at 9:00 the next three mornings, then stops but stays unpaid", async () => {
    const { desk, time } = await paidCleaning();
    ok(await desk.checkNow());
    expect(await payDueAt(desk, time, "2026-10-15T12:59:00.000Z")).toBeUndefined();
    expect((await payDueAt(desk, time, "2026-10-15T13:00:00.000Z"))?.map((item) => item.reminder)).toEqual([1]);
    expect(await payDueAt(desk, time, "2026-10-15T20:00:00.000Z")).toBeUndefined();
    expect((await payDueAt(desk, time, "2026-10-16T13:05:00.000Z"))?.map((item) => item.reminder)).toEqual([2]);
    expect((await payDueAt(desk, time, "2026-10-17T13:05:00.000Z"))?.map((item) => item.reminder)).toEqual([3]);
    expect(await payDueAt(desk, time, "2026-10-18T13:05:00.000Z")).toBeUndefined();
    expect(await doneLines(desk)).toContain("1 cleaning unpaid ($85.00).");
  });

  it("marks paid only with confirmed true, once, and stops the reminders", async () => {
    const { desk, time, root } = await paidCleaning();
    ok(await desk.checkNow());
    expect(refused(await desk.markPaid({ job: "2026-10-18", how: "venmo" }))).toBe("Ask the host first. Call mark_paid with confirmed true only after they say it's paid.");
    expect(ok(await desk.markPaid({ job: "2026-10-18", how: "other", confirmed: true })).next).toBe("Marked Ana's Oct 18 cleaning paid.");
    expect(ok(await desk.markPaid({ job: "2026-10-18", how: "venmo", confirmed: true })).next).toBe("That cleaning is already marked paid.");
    expect(await payDueAt(desk, time, "2026-10-15T13:00:00.000Z")).toBeUndefined();
    expect((await doneLines(desk)).some((line) => line.includes("unpaid"))).toBe(false);
    const saved = JSON.parse(readFileSync(join(root, "cleaner-live.json"), "utf8")) as { pay: Record<string, { how?: string; confirmedBy?: string }> };
    expect(Object.values(saved.pay)).toEqual([expect.objectContaining({ how: "other", confirmedBy: "landlord" })]);
    expect(refused(await desk.markPaid({ job: "2026-12-25", how: "venmo", confirmed: true }))).toBe("That cleaning isn't waiting on pay.");
  });

  it("gives a new link for a different amount, within bounds, for an unpaid cleaning only", async () => {
    const { desk, time } = await paidCleaning();
    ok(await desk.checkNow());
    const more = ok(await desk.getPayLink({ job: "2026-10-18", amount: 105 }));
    expect(more).toEqual({ job: "2026-10-18", amount: "$105.00", link: LINK.replace("amount=85.00", "amount=105.00") });
    expect((await payDueAt(desk, time, "2026-10-15T13:00:00.000Z"))?.[0]?.amount).toBe("$105.00");
    expect(refused(await desk.getPayLink({ job: "2026-10-18", amount: 1000.01 }))).toBe(RATE_HELP);
    expect(refused(await desk.getPayLink({ job: "2026-12-25" }))).toBe("That cleaning isn't waiting on pay.");
    ok(await desk.markPaid({ job: "2026-10-18", how: "venmo", confirmed: true }));
    expect(refused(await desk.getPayLink({ job: "2026-10-18" }))).toBe("That cleaning isn't waiting on pay.");
  });

  it("leaves the address out of the note when the nickname is the street address", async () => {
    const { desk } = await paidCleaning();
    ok(await desk.saveProperty({ business: BUSINESS, nickname: "12 Practice Lane", address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00", checkInTime: "16:00" }));
    ok(await desk.checkNow());
    const reply = ok(await desk.getPayLink({ job: "2026-10-18" }));
    expect(String(reply.link)).toContain("note=Cleaning+cleaning+Oct+18");
    expect(String(reply.link).toLowerCase()).not.toContain("practice");
  });

  it("keeps the owed amount when the rate changes", async () => {
    const { desk, time } = await paidCleaning();
    ok(await desk.checkNow());
    await approvePayments(desk, 90);
    expect((await payDueAt(desk, time, "2026-10-15T13:00:00.000Z"))?.[0]?.amount).toBe("$85.00");
  });

  it("never owes a cleaning finished before payments were turned on", async () => {
    const { desk, time } = await paidCleaning({ payments: "none" });
    time.set("2026-10-14T16:00:00.000Z");
    await approvePayments(desk);
    expect(ok(await desk.checkNow()).payDue).toBeUndefined();
    await approvePayments(desk, 90);
    expect(await payDueAt(desk, time, "2026-10-15T13:00:00.000Z")).toBeUndefined();
  });

  it("refuses to save a username that holds the door code", async () => {
    const { desk } = openDesk(() => new Date(FROZEN));
    await throughPreferences(desk);
    expect(refused(await desk.savePayments({ on: true, rate: 85, venmo: `scratch-${DOOR_CODE}` }))).toBe(CODE_IN_USERNAME);
  });

  it("withholds a link that would hold a door code saved later, and the rest of check_now still answers", async () => {
    const { desk } = await paidCleaning({ venmo: "scratch-4242", newCode: "4242" });
    const reply = ok(await desk.checkNow());
    expect(reply.completed).toBeDefined();
    expect(reply.payDue).toEqual([{ job: "2026-10-18", cleaner: "Ana", amount: "$85.00", payInVenmo: true, reminder: 0 }]);
  });

  it("owes the cleaning once across restarts", async () => {
    const { root, time } = await paidCleaning();
    resetLiveDesks();
    const second = openDesk(time.now, root).desk;
    expect((ok(await second.checkNow()).payDue as PayDue[]).map((item) => item.reminder)).toEqual([0]);
    resetLiveDesks();
    const third = openDesk(time.now, root).desk;
    expect(ok(await third.checkNow()).payDue).toBeUndefined();
  });

  it("sends no text on any payment path", async () => {
    const { desk, sms, groups } = await paidCleaning();
    const texts = sms.sent.length;
    const posts = groups.posts.length;
    ok(await desk.checkNow());
    ok(await desk.getPayLink({ job: "2026-10-18", amount: 100 }));
    ok(await desk.markPaid({ job: "2026-10-18", how: "venmo", confirmed: true }));
    await approvePayments(desk, 95);
    ok(await desk.savePayments({ on: false }));
    expect(sms.sent).toHaveLength(texts);
    expect(groups.posts).toHaveLength(posts);
  });

  it("keeps each property's payments in its own folder", async () => {
    const lane = await paidCleaning();
    ok(await lane.desk.checkNow());
    const court = openDesk(lane.time.now).desk;
    expect((await doneLines(court)).some((line) => line.startsWith("Payments") || line.includes("unpaid"))).toBe(false);
    expect(readFileSync(join(lane.root, "cleaner-live.json"), "utf8")).toContain(USERNAME);
  });
});

describe("payments approval across a restart", () => {
  it("a code issued before a restart still saves once, and an expired one is refused", async () => {
    const clock = testClock(FROZEN);
    const first = openDesk(clock.now);
    const code = codeOf(ok(await first.desk.savePayments({ rate: 80, venmo: USERNAME })));
    resetLiveDesks();
    const restarted = openDesk(clock.now, first.root);
    expect(restarted.desk).not.toBe(first.desk);
    ok(await restarted.desk.savePayments({ rate: 80, venmo: USERNAME, confirmation: code }));
    expect(JSON.parse(readFileSync(join(first.root, "cleaner-live.json"), "utf8")).payments).toMatchObject({ on: true, rateCents: 8000, venmo: USERNAME });
    resetLiveDesks();
    expect(refused(await openDesk(clock.now, first.root).desk.savePayments({ rate: 80, venmo: USERNAME, confirmation: code }))).toBe(STALE);

    const late = codeOf(ok(await openDesk(clock.now, first.root).desk.savePayments({ rate: 90, venmo: USERNAME })));
    resetLiveDesks();
    clock.set(new Date(new Date(FROZEN).getTime() + 10 * 60_000).toISOString());
    expect(refused(await openDesk(clock.now, first.root).desk.savePayments({ rate: 90, venmo: USERNAME, confirmation: late }))).toBe(STALE);
  });
});
