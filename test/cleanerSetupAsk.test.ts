import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { liveDeskFor, resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch, type ToolReply } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import type { SetupAsk } from "../src/cleaner-core/setupAsk";
import { fakeConversations } from "./fakeConversations";
import { PUBLIC } from "./fakeSendblue";
import {
  ADDRESS,
  BUSINESS,
  CALENDAR_ICS,
  CALENDAR_URL,
  CLEANER,
  CLEANER_LINE,
  CLEANER_TOKEN,
  DOOR_CODE,
  FROZEN,
  HOST,
  TEST_PIN_KEY,
  fakeSms,
  startWiredApp,
  type WiredApp,
} from "./wiringProof";
import { filesUnder } from "./files";

const PATH = "/mcp/cleaner-core";
const ZONE = "America/New_York";
const PIN_KEY = Buffer.from(TEST_PIN_KEY, "base64");
const CALENDAR_PREFIX = `${PUBLIC}/cleaner-core/calendar-link/`;
const GUESTY_LINK = "https://app.guesty.com/api/public/icalendar-dashboard-api/export/made-up-test-calendar";

const open: WiredApp[] = [];
const roots: string[] = [];

afterEach(async () => {
  setCleanerAlertFetch(undefined);
  setCleanerTwilioClient(undefined);
  setCleanerGroupFetch(undefined);
  setCleanerCalendarFetch(undefined);
  resetLiveDesks();
  while (open.length > 0) await open.pop()?.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function app(): Promise<WiredApp> {
  const started = await startWiredApp();
  open.push(started);
  return started;
}

function call(wired: WiredApp, name: string, args: Record<string, unknown> = {}) {
  return wired.tool(PATH, CLEANER_TOKEN, name, args);
}

function ok(reply: ToolReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

function askOf(result: Record<string, unknown> | undefined): SetupAsk {
  return result?.ask as SetupAsk;
}

function fields(ask: SetupAsk): string[] {
  return ask.questions.map((question) => question.field);
}

const PROPERTY = { business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "10:00", checkInTime: "16:00" };

describe("Cleaner Core setup asks: one question at a time", () => {
  it("offers the two jobs as options before anything is chosen", async () => {
    const wired = await app();
    const ask = askOf((await call(wired, "get_state")).structured);
    expect(ask.step).toBe("start");
    expect(ask.questions[0]?.options).toEqual([
      { value: "tours", label: "Letting renters tour a unit on their own" },
      { value: "cleaners", label: "Scheduling cleaners between guest stays" },
    ]);
  });

  it("returns each step's ask in order, with the step's tool, and no ask at the review", async () => {
    const wired = await app();
    const picked = (await call(wired, "get_state", { choice: "cleaners" })).structured;
    expect(String(picked?.next)).toMatch(/^That's Cleaner Core\. It schedules cleaners between guest stays\. Ask the host the questions in ask/);
    expect(askOf(picked).step).toBe("property");
    expect(fields(askOf(picked))).toEqual(["address", "business", "timeZone", "checkoutTime", "checkInTime"]);

    const steps: [string, Record<string, unknown>, string, string][] = [
      ["save_property", PROPERTY, "sources", "save_sources"],
      ["save_sources", { calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }, "sources", "save_sources"],
      ["save_sources", { done: true }, "people", "save_people"],
      ["save_people", { host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-and-host" }, "schedule", "save_schedule"],
      ["save_schedule", {}, "door-code", "save_door_code"],
    ];
    for (const [tool, args, step, next] of steps) {
      const saved = await call(wired, tool, args);
      expect(saved.isError, saved.text).toBe(false);
      expect(askOf(saved.structured).step).toBe(step);
      expect(askOf(saved.structured).tool).toBe(next);
      expect(saved.structured?.next).toBe(`Ask the host the questions in ask, in order, in your own short words. Each message asks exactly one question: never two in one message, even related ones like the checkout and check-in times, or a phone number and a name. Wait for the answer before the next one. When a question has options, show them as a choice card the host can tap, never as a list or a question in the text. Skip a question the host already answered. Then call ${next}.`);
    }
    expect((await call(wired, "save_door_code", { code: DOOR_CODE })).isError).toBe(false);
    expect(askOf((await call(wired, "get_state")).structured).step).toBe("preferences");
    expect(askOf((await call(wired, "save_preferences", {})).structured).step).toBe("payments");
    const routines = (await call(wired, "save_payments", { on: false })).structured;
    expect(routines?.ask).toBeUndefined();
    expect(String(routines?.next)).toMatch(/^Create the Cleaner Core Check and Cleaner Core Alerts routines\./);
    setCleanerAlertFetch(async () => ({ status: 200 }));
    const saved = (await call(wired, "save_alert_routine", { url: "https://routine.example/hook", token: "k-test-routine-key" })).structured;
    expect(saved?.next).toBe("Alerts are connected. I queued a test alert for the routine. Then call get_state for the review.");
    const review = (await call(wired, "get_state")).structured;
    expect(review?.ask).toBeUndefined();
    expect(review?.next).toBe("Summarize this setup for the host in your own words, then ask them to reply Activate.");
  });

  it("asks how far ahead the cleaner is offered each cleaning, with 1 day before checkout first", async () => {
    const wired = await app();
    await call(wired, "get_state", { choice: "cleaners" });
    await call(wired, "save_property", PROPERTY);
    await call(wired, "save_sources", { calendars: [{ name: "Airbnb", url: CALENDAR_URL }] });
    const ask = askOf((await call(wired, "save_people", { host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-and-host" })).structured);
    expect(ask.step).toBe("schedule");
    expect(fields(ask)).toEqual(["firstText", "firstTextDays", "timing"]);
    const first = ask.questions[0];
    expect(first?.default).toBe("1");
    expect(first?.options?.map((option) => option.value)).toEqual(["1", "3", "7", "custom", "when-confirmed"]);
  });

  it("always asks how many locks there are and where, before the door code", async () => {
    const wired = await app();
    await call(wired, "get_state", { choice: "cleaners" });
    await call(wired, "save_property", PROPERTY);
    await call(wired, "save_sources", { calendars: [{ name: "Airbnb", url: CALENDAR_URL }], done: true });
    await call(wired, "save_people", { host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-and-host" });
    const ask = askOf((await call(wired, "save_schedule", {})).structured);
    expect(ask.step).toBe("door-code");
    expect(fields(ask)).toEqual(["lockLocation", "code"]);
    expect(ask.questions[0]?.required).toBe(true);
  });

  it("offers who is in the texts as options, with the group of the host and the cleaner first", async () => {
    const wired = await app();
    await call(wired, "get_state", { choice: "cleaners" });
    await call(wired, "save_property", PROPERTY);
    const people = askOf((await call(wired, "save_sources", { calendars: [{ name: "Airbnb", url: CALENDAR_URL }], done: true })).structured);
    const group = people.questions.find((question) => question.field === "groupChat");
    expect(group?.default).toBe("cleaner-and-host");
    // The group greets the host by name, so the name is asked and the business name is never the default.
    const hostName = people.questions.find((question) => question.field === "hostName");
    expect(hostName?.required).toBe(true);
    expect(hostName?.default).toBeUndefined();
    expect(group?.options?.map((option) => option.value)).toEqual(["cleaner-and-host", "everyone", "cleaner-only"]);
  });

  it("shows the host's name in the review and greets the host by it in the group intro", async () => {
    const { desk, groups } = await activatedGroup({ hostName: "Saad" });
    expect(((ok(await desk.getState()).setup ?? {}) as Record<string, unknown>).people).toBeUndefined();
    ok(await desk.confirmTimes({ checkout: "10:00", checkIn: "16:00" }));
    await desk.inbound({ id: "join", from: CLEANER, text: "YES" });
    expect(groups.posts[0]?.body).toMatch(/^Hi Saad and Maria! .* I'm Saad's cleaning assistant,/);
  });

  it("keeps asking for the usual times until both are saved, then moves on", async () => {
    const wired = await app();
    await call(wired, "get_state", { choice: "cleaners" });
    const noTimes = await call(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE });
    expect(askOf(noTimes.structured).step).toBe("property");
    expect(fields(askOf(noTimes.structured))).toEqual(["checkoutTime", "checkInTime"]);
    const oneTime = await call(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "10:00" });
    expect(fields(askOf(oneTime.structured))).toEqual(["checkInTime"]);
    expect(askOf((await call(wired, "save_property", PROPERTY)).structured).step).toBe("sources");
  });
});

/** Grok's cloud computer posts to the link. The test server answers on 127.0.0.1 at the link's path. */
async function upload(wired: WiredApp, link: string, body: string, contentType = "application/json"): Promise<{ status: number; raw: string }> {
  const res = await fetch(`http://127.0.0.1:${wired.port}${new URL(link).pathname}`, { method: "POST", headers: { "Content-Type": contentType }, body });
  return { status: res.status, raw: await res.text() };
}

describe("Cleaner Core setup: a calendar link from Grok's secure card", () => {
  it("refuses a masked link and points Grok to the upload link", async () => {
    const wired = await app();
    await call(wired, "get_state", { choice: "cleaners" });
    await call(wired, "save_property", PROPERTY);
    for (const url of ["[REDACTED]", "https://app.guesty.com/••••••"]) {
      const masked = await call(wired, "save_sources", { calendars: [{ name: "Guesty Lite", url }] });
      expect(masked.isError).toBe(true);
      expect(masked.text).toContain("That link came through masked");
      expect(masked.text).toContain("uploadLink");
    }
    const legacy = await call(wired, "save_calendar_link", { url: "[REDACTED]" });
    expect(legacy.isError).toBe(true);
    expect(legacy.text).toContain("That link came through masked");
  });

  it("keeps asking for more booking calendars, keeps each one, and moves on only after done", async () => {
    const wired = await app();
    await call(wired, "get_state", { choice: "cleaners" });
    await call(wired, "save_property", PROPERTY);
    const first = String((await call(wired, "save_sources", { uploadLink: { name: "Guesty Lite" } })).structured?.uploadUrl);
    expect((await upload(wired, first, JSON.stringify({ url: GUESTY_LINK }))).status).toBe(200);
    const more = askOf((await call(wired, "get_state")).structured);
    expect(more.step).toBe("sources");
    expect(more.questions[0]?.options?.map((option) => option.value)).toEqual(["add", "done"]);
    expect(more.questions[0]?.ask).toContain("Guesty Lite");

    const second = String((await call(wired, "save_sources", { uploadLink: { name: "Vrbo direct" } })).structured?.uploadUrl);
    expect((await upload(wired, second, JSON.stringify({ url: CALENDAR_URL }))).status).toBe(200);
    const both = (await call(wired, "get_state")).structured;
    expect(both?.done).toContain("2 calendar links saved.");
    expect(askOf(both).questions[0]?.ask).toContain("Guesty Lite, Vrbo direct");

    const done = await call(wired, "save_sources", { done: true });
    expect(done.isError, done.text).toBe(false);
    expect(askOf(done.structured).step).toBe("people");
    expect((await call(wired, "get_state")).structured?.done).toContain("2 calendar links saved.");
  });

  it("saves a link posted to a one-time upload link, once, and never repeats or stores the code", async () => {
    const wired = await app();
    await call(wired, "get_state", { choice: "cleaners" });
    await call(wired, "save_property", PROPERTY);
    const issued = await call(wired, "save_sources", { uploadLink: { name: "Guesty Lite" } });
    expect(issued.isError, issued.text).toBe(false);
    const link = String(issued.structured?.uploadUrl);
    expect(link.startsWith(CALENDAR_PREFIX), link).toBe(true);
    const code = link.slice(CALENDAR_PREFIX.length);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.structured?.expiresInMinutes).toBe(10);
    // Nothing is saved until the link arrives, so setup still asks where bookings come from.
    expect(askOf((await call(wired, "get_state")).structured).step).toBe("sources");

    expect((await upload(wired, link, JSON.stringify({ url: "[REDACTED]" }))).status).toBe(400);
    expect((await upload(wired, link, JSON.stringify({ url: "http://app.guesty.com/plain" }))).status).toBe(400);
    expect((await upload(wired, link, "url=x", "text/plain")).status).toBe(415);
    const saved = await upload(wired, link, JSON.stringify({ url: GUESTY_LINK }));
    expect(saved.status).toBe(200);
    expect(JSON.parse(saved.raw)).toEqual({ ok: true, message: "Saved the calendar link." });
    expect((await upload(wired, link, JSON.stringify({ url: GUESTY_LINK }))).status).toBe(404);

    const state = (await call(wired, "get_state")).structured;
    expect(state?.done).toContain("Calendar link saved.");
    expect(askOf(state).step).toBe("sources");
    expect(fields(askOf(state))).toEqual(["more"]);
    const replies = JSON.stringify(state) + issued.raw + saved.raw;
    expect(replies.includes(GUESTY_LINK)).toBe(false);
    expect(wired.logs.join("\n").includes(GUESTY_LINK)).toBe(false);
    expect(wired.logs.join("\n").includes(code)).toBe(false);
    for (const path of filesUnder(wired.root)) expect(readFileSync(path, "utf8").includes(code), path).toBe(false);
  });

  it("replaces only the calendar with the same name and keeps the others", async () => {
    const wired = await app();
    await call(wired, "get_state", { choice: "cleaners" });
    await call(wired, "save_property", PROPERTY);
    await call(wired, "save_sources", { calendars: [{ name: "Airbnb", url: CALENDAR_URL }, { name: "Guesty Lite", url: "https://app.guesty.com/old" }] });
    const issued = await call(wired, "save_sources", { uploadLink: { name: "guesty lite" } });
    const saved = await upload(wired, String(issued.structured?.uploadUrl), JSON.stringify({ url: GUESTY_LINK }));
    expect(saved.status).toBe(200);
    expect((await call(wired, "get_state")).structured?.done).toContain("2 calendar links saved.");
  });

  it("refuses an expired upload link", async () => {
    let at = new Date(FROZEN);
    const started = await startWiredApp({ now: () => at });
    open.push(started);
    await call(started, "get_state", { choice: "cleaners" });
    await call(started, "save_property", PROPERTY);
    const issued = await call(started, "save_sources", { uploadLink: {} });
    at = new Date(at.getTime() + 11 * 60_000);
    expect((await upload(started, String(issued.structured?.uploadUrl), JSON.stringify({ url: GUESTY_LINK }))).status).toBe(404);
  });
});

/** A group setup with the two test stays, with the alert routine saved, then activated. Without the routine it stops before the review. */
async function activatedGroup(
  options: { uploadCode?: boolean; hostName?: string; schedule?: Parameters<ReturnType<typeof liveDeskFor>["saveSchedule"]>[0]; now?: () => Date; connectRoutine?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "cleaner-setup-ask-"));
  roots.push(root);
  const sms = fakeSms();
  const groups = fakeConversations();
  setCleanerTwilioClient(sms);
  setCleanerGroupFetch(groups.impl);
  setCleanerCalendarFetch(async (url) => ({ status: 200, url, async text() { return CALENDAR_ICS; } }));
  const env: NodeJS.ProcessEnv = {
    CLEANER_CORE_ENABLED: "1",
    CLEANER_CORE_LIVE_SMS: "1",
    CLEANER_CORE_GROUP_CHAT: "1",
    CLEANER_CORE_SMS_ALLOWLIST: [HOST, CLEANER].join(","),
    CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
    CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
    CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    CLEANER_CORE_ROUTINE_URL: "https://routine.example/hook",
    CLEANER_CORE_ROUTINE_KEY: "k-left-from-before",
    PUBLIC_BASE_URL: "https://cleaner.example",
  };
  const desk = liveDeskFor(root, () => env, options.now ?? (() => new Date(FROZEN)));
  ok(await desk.getState("cleaners"));
  ok(await desk.saveProperty(PROPERTY));
  ok(await desk.saveSources({ calendars: [{ name: "Guesty Lite", url: CALENDAR_URL }] }));
  ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Maria", groupChat: "cleaner-and-host", ...(options.hostName ? { hostName: options.hostName } : {}) }));
  ok(await desk.saveSchedule(options.schedule ?? { firstText: "when-confirmed" }));
  if (options.uploadCode) {
    const link = String(ok(await desk.saveDoorCode({}, PIN_KEY)).uploadUrl);
    const posted = await desk.uploadDoorCode(link.slice(link.lastIndexOf("/") + 1), { code: DOOR_CODE });
    expect(posted.status).toBe(200);
  } else ok(await desk.saveDoorCode({ code: DOOR_CODE }, PIN_KEY));
  ok(await desk.savePreferences({}));
  const preferences = ok(await desk.savePayments({ on: false }));
  // The routine counts only once this setup connects it. The env already holds its values.
  const posts: string[] = [];
  setCleanerAlertFetch(async (_url, init) => {
    posts.push(init.body);
    return { status: 200 };
  });
  // Stands in for the secret store.
  const save = (values: Record<string, string>) => Object.assign(env, values);
  if (options.connectRoutine === false) return { desk, sms, groups, posts, save, preferences };
  ok(await desk.saveAlertRoutine({ url: "https://routine.example/hook", token: "k-test-routine-key" }, save));
  if (options.hostName) {
    const review = ok(await desk.getState()).setup as { people: { host: Record<string, unknown> } };
    expect(review.people.host).toEqual({ name: options.hostName, phoneLast4: HOST.slice(-4) });
  }
  ok(await desk.activate());
  return { desk, sms, groups, posts, save, preferences };
}

describe("Cleaner Core routines: asked before the review", () => {
  it("save_preferences asks for the routines, and activate waits until this setup connects one", async () => {
    // The env holds a routine address from before, as after a new bot reuses the same server.
    const { desk, posts, save, preferences } = await activatedGroup({ connectRoutine: false });
    expect(String(preferences.next)).toMatch(/^Create the Cleaner Core Check and Cleaner Core Alerts routines\./);
    const state = ok(await desk.getState());
    expect(String(state.next)).toMatch(/^Create the Cleaner Core Check and Cleaner Core Alerts routines\./);
    expect(state.setup).toBeUndefined();
    const refused = await desk.activate();
    expect(refused.ok).toBe(false);
    expect(String(!refused.ok && refused.error)).toMatch(/^Create the Cleaner Core Check and Cleaner Core Alerts routines\./);
    await desk.drainAlerts();
    expect(posts).toEqual([]);

    const saved = ok(await desk.saveAlertRoutine({ url: "https://routine.example/hook", token: "k-test-routine-key" }, save));
    expect(saved.next).toBe("Alerts are connected. I queued a test alert for the routine. Then call get_state for the review.");
    await desk.drainAlerts();
    expect(posts.map((body) => JSON.parse(body).eventType)).toEqual(["installation.test"]);
    const review = ok(await desk.getState());
    expect(review.next).toBe("Summarize this setup for the host in your own words, then ask them to reply Activate.");
    expect(review.setup).toBeDefined();
    ok(await desk.activate());
    expect(askOf(ok(await desk.getState())).step).toBe("times");
  });

  it("the Check routine waking before Activate gets a quiet reply", async () => {
    const { desk, save } = await activatedGroup({ connectRoutine: false });
    ok(await desk.saveAlertRoutine({ url: "https://routine.example/hook", token: "k-test-routine-key" }, save));
    const early = ok(await desk.checkNow({}));
    expect(early).toMatchObject({ alerts: [], messages: [], next: "Cleaner Core isn't active yet. Post nothing." });
  });
});

describe("Cleaner Core times: the usual times for every turnover", () => {
  it("offers the usual times for all untimed turnovers, then times them in one call", async () => {
    const { desk, sms } = await activatedGroup();
    const state = ok(await desk.getState());
    const ask = askOf(state);
    expect(ask.step).toBe("times");
    expect(ask.tool).toBe("confirm_times");
    expect(ask.questions[0]?.options?.[0]).toEqual({ value: "all", label: "Use 10:00 AM checkout and 4:00 PM check-in for all 2" });

    const all = ok(await desk.confirmTimes({ checkout: "10:00", checkIn: "16:00", all: true }));
    // The reply says what went out: here the group invite.
    expect(all.next).toBe("Times saved for 2 turnovers. The cleaner got one text asking them to reply YES. Offers start after they do, one at a time.");
    const turns = all.turns as { checkoutTime?: string; nextCheckInDate: string | null; nextCheckInTime?: string }[];
    expect(turns).toHaveLength(2);
    for (const turn of turns) {
      expect(turn.checkoutTime).toBeTruthy();
      if (turn.nextCheckInDate) expect(turn.nextCheckInTime).toBeTruthy();
    }
    // The cleaner gets the group invite only, one text, before any offer.
    expect(sms.sent.filter((item) => item.to === CLEANER)).toHaveLength(1);
    expect(askOf(ok(await desk.getState()))).toBeUndefined();
    expect((await desk.confirmTimes({ checkout: "10:00", checkIn: "16:00", all: true })).ok).toBe(false);
  });

  it("still sends the cleaner one offer at a time after timing them all", async () => {
    const { desk, groups } = await activatedGroup();
    ok(await desk.confirmTimes({ checkout: "10:00", checkIn: "16:00", all: true }));
    await desk.inbound({ id: "join", from: CLEANER, text: "YES" });
    // The first offer follows the group's intro in the same post.
    const offers = () => groups.posts.filter((post) => /(^|\n\n)Turnover at /.test(post.body));
    expect(offers()).toHaveLength(1);
    await desk.inbound({ id: "take-1", from: CLEANER, text: "YES", channel: "group" });
    expect(offers()).toHaveLength(1);
    // The next offer goes on the next check, after the first one was taken.
    await desk.checkNow({});
    expect(offers()).toHaveLength(2);
    expect(offers()[0]?.body).not.toBe(offers()[1]?.body);
  });

  it("with days-before-checkout, holds each later offer until its own day, even after the first is taken", async () => {
    let at = new Date(FROZEN);
    const { desk, groups } = await activatedGroup({ schedule: { firstText: "days-before-checkout", firstTextDays: 2 }, now: () => at });
    ok(await desk.confirmTimes({ checkout: "10:00", checkIn: "16:00", all: true }));
    await desk.inbound({ id: "join", from: CLEANER, text: "YES" });
    // The first offer follows the group's intro in the same post.
    const offers = () => groups.posts.filter((post) => /(^|\n\n)Turnover at /.test(post.body));
    expect(offers()).toHaveLength(0);
    // Checkouts are Oct 18 and Oct 22. Two days before, at 9:00 AM New York time.
    at = new Date("2026-10-16T13:00:00.000Z");
    await desk.checkNow({});
    expect(offers()).toHaveLength(1);
    await desk.inbound({ id: "take-1", from: CLEANER, text: "YES", channel: "group" });
    await desk.checkNow({});
    expect(offers()).toHaveLength(1);
    at = new Date("2026-10-20T12:59:00.000Z");
    await desk.checkNow({});
    expect(offers()).toHaveLength(1);
    at = new Date("2026-10-20T13:00:00.000Z");
    await desk.checkNow({});
    expect(offers()).toHaveLength(2);
  });

  it("keeps a time the host already set and times only the rest", async () => {
    const { desk } = await activatedGroup();
    ok(await desk.confirmTimes({ checkout: "09:00", checkIn: "15:00" }));
    const all = ok(await desk.confirmTimes({ checkout: "10:00", checkIn: "16:00", all: true }));
    // The invite went with the first turnover's times, so this call sent nothing.
    expect(all.next).toBe("Times saved for 1 turnover. Nothing was sent yet. The cleaner gets one cleaning offer at a time, starting with the first.");
    const turns = all.turns as { checkoutTime?: string }[];
    expect(turns.map((turn) => turn.checkoutTime?.replace(/[  ]/g, " "))).toEqual(["9:00 AM", "10:00 AM"]);
  });
});

const DOOR_PREFIX = `${PUBLIC}/cleaner-core/door-code/`;

describe("Cleaner Core setup: the door code from Grok's secure card", () => {
  async function atDoor(wired: WiredApp) {
    await call(wired, "get_state", { choice: "cleaners" });
    await call(wired, "save_property", PROPERTY);
    await call(wired, "save_sources", { calendars: [{ name: "Airbnb", url: CALENDAR_URL }] });
    await call(wired, "save_people", { host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-and-host" });
    await call(wired, "save_schedule", {});
  }

  it("refuses a masked code and points Grok to the upload link", async () => {
    const wired = await app();
    await atDoor(wired);
    for (const code of ["[REDACTED]", "••••"]) {
      const masked = await call(wired, "save_door_code", { code });
      expect(masked.isError).toBe(true);
      expect(masked.text).toContain("That door code came through masked");
    }
    expect((await call(wired, "save_door_code", { code: "12ab" })).text).toContain("Send the door code as 4 to 8 digits.");
  });

  it("seals a code posted to a one-time upload link, once, with the lock location, and never repeats or stores it", async () => {
    const wired = await app();
    await atDoor(wired);
    const issued = await call(wired, "save_door_code", { lockLocation: "front door keypad" });
    expect(issued.isError, issued.text).toBe(false);
    const link = String(issued.structured?.uploadUrl);
    expect(link.startsWith(DOOR_PREFIX), link).toBe(true);
    const code = link.slice(DOOR_PREFIX.length);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(askOf((await call(wired, "get_state")).structured).step).toBe("door-code");

    expect((await upload(wired, link, JSON.stringify({ code: "[REDACTED]" }))).status).toBe(400);
    expect((await upload(wired, link, "code=1", "text/plain")).status).toBe(415);
    // A refused code keeps the link.
    const saved = await upload(wired, link, JSON.stringify({ code: DOOR_CODE }));
    expect(saved.status).toBe(200);
    expect(JSON.parse(saved.raw)).toEqual({ ok: true, message: expect.stringMatching(/^Saved the door code\. It goes only to the cleaner, in (the cleaning group|a private text), after you say the guests have left\.$/) });
    expect((await upload(wired, link, JSON.stringify({ code: DOOR_CODE }))).status).toBe(404);

    const state = (await call(wired, "get_state")).structured;
    expect(state?.done).toContain("Door code saved.");
    expect(askOf(state).step).toBe("preferences");
    await call(wired, "save_preferences", {});
    await call(wired, "save_payments", { on: false });
    setCleanerAlertFetch(async () => ({ status: 200 }));
    await call(wired, "save_alert_routine", { url: "https://routine.example/hook", token: "k-test-routine-key" });
    expect(JSON.stringify((await call(wired, "get_state")).structured?.setup)).toContain("front door keypad");
    for (const text of [JSON.stringify(state), issued.raw, saved.raw, wired.logs.join("\n")]) expect(text.includes(DOOR_CODE)).toBe(false);
    expect(wired.logs.join("\n").includes(code)).toBe(false);
    for (const path of filesUnder(wired.root)) {
      const text = readFileSync(path, "utf8");
      expect(text.includes(code), path).toBe(false);
      expect(new RegExp(`(^|\\D)${DOOR_CODE}(\\D|$)`).test(text), path).toBe(false);
    }
  });

  it("refuses an expired door code upload link", async () => {
    let at = new Date(FROZEN);
    const started = await startWiredApp({ now: () => at });
    open.push(started);
    await atDoor(started);
    const issued = await call(started, "save_door_code", {});
    at = new Date(at.getTime() + 11 * 60_000);
    expect((await upload(started, String(issued.structured?.uploadUrl), JSON.stringify({ code: DOOR_CODE }))).status).toBe(404);
  });

  it("sends the uploaded code to the cleaner after the guests leave", async () => {
    const { desk, groups } = await activatedGroup({ uploadCode: true });
    ok(await desk.confirmTimes({ checkout: "10:00", checkIn: "16:00" }));
    await desk.inbound({ id: "join", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "take", from: CLEANER, text: "YES", channel: "group" });
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    expect(groups.posts.filter((post) => post.body.includes(DOOR_CODE))).toHaveLength(1);
  });
});
