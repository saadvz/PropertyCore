import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NoopOperatorNotificationSink } from "../src/alerts/operatorEvents";
import { OperatorEventOutbox } from "../src/alerts/outbox";
import { cleanerOptOutHold, offerForOthers } from "../src/cleaner-core/cleanerTexts";
import { postToGroup } from "./hostApproval";
import type { CleanerCore } from "../src/cleaner-core/core";
import { DOOR_CODE_IN_CHAT, liveDeskFor, resetLiveDesks, setCleanerAlertFetch, setCleanerCalendarFetch, type LiveDesk, type ToolReply } from "../src/cleaner-core/liveDesk";
import { isScratchTestNumber } from "../src/cleaner-core/scratch";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { fakeConversations } from "./fakeConversations";
import { handleCleanerMcpMessage } from "../src/cleaner-core/mcp";
import { REPLY_INSTRUCTIONS } from "../src/cleaner-core/replyWording";
import { photoKey, servePhoto, setCleanerPhotoFetch } from "../src/cleaner-core/photos";
import { containsCodeToken } from "../src/cleaner-core/redact";
import type { GoogleEventList } from "../src/hub/sources";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";
import { CLEANER_SCOPE } from "../src/mcp/oauth/provider";
import { twilioSignature } from "../src/messaging/twilio/signature";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { BASE, CLEANER_RESOURCE, closeHostedApps, hostedApp } from "./cleanerOauthHarness";
import { propertyFolder } from "../src/cleaner-core/hosted/properties";
import { TenantRegistry, tenantFolder } from "../src/cleaner-core/hosted/registry";
import { drainAllTenants, hostedCleaner } from "../src/cleaner-core/hosted/router";
import { TenantSecrets } from "../src/cleaner-core/hosted/tenantSecrets";
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
  HOST,
  OBSERVER,
  OFF_LIST,
  TEST_PIN_KEY,
  fakeSms,
  startWiredApp,
  type SentSms,
  type WiredApp,
} from "./wiringProof";
import { filesUnder } from "./files";

const PATH = "/mcp/cleaner-core";
const ZONE = "America/New_York";
const PIN_KEY = Buffer.from(TEST_PIN_KEY, "base64");
const SECOND = "+15555550133";
const LOCK = "back door lockbox";
/** LiveDesk names the business when no host name is saved. */
/** A host message to the group: the probe for who is in it. */
const NOTE = "Please bring extra towels.";

/** The setup step get_state is asking about. */
function askStep(state: Record<string, unknown> | undefined): string | undefined {
  return (state?.ask as { step?: string } | undefined)?.step;
}
const REVIEW_NEXT = "Summarize this setup for the host in your own words, then ask them to reply Activate.";
const PRIVATE_PIN = `Guests have left ${ADDRESS}. Door code for the ${LOCK}: ${DOOR_CODE}. This code is only for you. Reply DONE when the cleaning is finished.`;

const open: WiredApp[] = [];
const roots: string[] = [];
/** The alert routine every setup connects before the review. Its wake-ups go to a stub. */
const ROUTINE = { url: "https://routine.example/hook", token: "k-test-routine-key" };

beforeEach(() => setCleanerAlertFetch(async () => ({ status: 200 })));

afterEach(async () => {
  setCleanerTwilioClient(undefined);
  setCleanerGroupFetch(undefined);
  setCleanerCalendarFetch(undefined);
  setCleanerAlertFetch(undefined);
  setCleanerPhotoFetch(undefined);
  resetLiveDesks();
  closeHostedApps();
  while (open.length > 0) await open.pop()?.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function app(options?: Parameters<typeof startWiredApp>[0]): Promise<WiredApp> {
  const started = await startWiredApp(options);
  open.push(started);
  return started;
}

function call(wired: WiredApp, name: string, args: Record<string, unknown> = {}) {
  return wired.tool(PATH, CLEANER_TOKEN, name, args);
}

async function state(wired: WiredApp): Promise<Record<string, unknown>> {
  return (await call(wired, "get_state")).structured ?? {};
}

/** Intl may put a narrow no-break space before AM or PM. */
function plain(text: string): string {
  return text.replace(/[\u202f\u00a0]/g, " ");
}

function googleList(stays: { id: string; start: string; end: string }[]): GoogleEventList {
  return {
    timeZone: ZONE,
    items: stays.map((stay) => ({ id: stay.id, status: "confirmed", summary: "Guest", start: { date: stay.start }, end: { date: stay.end } })),
  };
}

const PROPERTY = {
  business: BUSINESS,
  nickname: "Lake House",
  address: ADDRESS,
  propertyType: "Condo",
  timeZone: ZONE,
  checkoutTime: "10:30",
  checkInTime: "15:00",
};

const SCHEDULE = {
  firstText: "days-after-check-in",
  firstTextDays: 2,
  reminder: "days-before-checkout",
  reminderDays: 1,
  reminderTime: "18:00",
  quietFrom: "21:00",
  quietUntil: "08:00",
  escalateTo: "Sam",
};

const PREFERENCES = {
  checklist: ["Strip the beds", "Restock coffee"],
  photosRequired: true,
  supplyNotes: true,
  instructions: "Leave the porch light on.",
};

describe("Cleaner Core full setup: the diagram order", () => {
  it("saves each step, advances in diagram order, and reviews every choice without the code or a full phone", async () => {
    const wired = await app();
    await call(wired, "get_state", { choice: "cleaners" });
    expect(askStep((await state(wired)))).toBe("property");

    const property = await call(wired, "save_property", PROPERTY);
    expect(property.isError).toBe(false);
    expect(askStep(property.structured)).toBe("sources");
    expect(askStep((await state(wired)))).toBe("sources");

    const sources = await call(wired, "save_sources", { calendars: [{ name: "Airbnb", url: CALENDAR_URL }] });
    expect(sources.isError).toBe(false);
    // One calendar saved: the host is asked for any other place bookings come from.
    expect(askStep(sources.structured)).toBe("sources");
    const finished = await call(wired, "save_sources", { done: true });
    expect(finished.isError).toBe(false);
    expect(askStep(finished.structured)).toBe("people");
    expect(askStep((await state(wired)))).toBe("people");

    const people = await call(wired, "save_people", {
      host: HOST,
      cleaner: CLEANER,
      cleanerName: "Ana",
      contacts: [{ name: "Sam", role: "co-host", phone: OBSERVER }],
      groupChat: "everyone",
      doorCodeTo: "cleaner",
    });
    expect(people.isError).toBe(false);
    expect(askStep(people.structured)).toBe("schedule");
    expect(askStep((await state(wired)))).toBe("schedule");

    const schedule = await call(wired, "save_schedule", SCHEDULE);
    expect(schedule.isError).toBe(false);
    expect(askStep(schedule.structured)).toBe("door-code");
    expect(askStep((await state(wired)))).toBe("door-code");

    const door = await call(wired, "save_door_code", { code: DOOR_CODE, lockLocation: LOCK });
    expect(door.isError).toBe(false);
    const atPreferences = await state(wired);
    expect(askStep(atPreferences)).toBe("preferences");
    expect(atPreferences.setup).toBeUndefined();

    const early = await call(wired, "activate");
    expect(early.isError).toBe(true);

    const preferences = await call(wired, "save_preferences", PREFERENCES);
    expect(preferences.isError).toBe(false);
    // The optional Payments step comes next.
    expect(askStep(preferences.structured)).toBe("payments");
    const payments = await call(wired, "save_payments", { on: false });
    expect(payments.isError).toBe(false);
    // The routines come before the review, and activate waits for them.
    expect(String(payments.structured?.next)).toMatch(/^Create the Cleaner Core Check and Cleaner Core Alerts routines\./);
    expect((await state(wired)).setup).toBeUndefined();
    expect((await call(wired, "activate")).isError).toBe(true);
    expect((await call(wired, "save_alert_routine", ROUTINE)).isError).toBe(false);
    const review = await state(wired);
    expect(review.next).toBe(REVIEW_NEXT);
    expect(review.done).toContain("Preferences saved.");
    expect(review.setup).toEqual({
      property: {
        business: BUSINESS,
        nickname: "Lake House",
        address: ADDRESS,
        propertyType: "Condo",
        timeZone: ZONE,
        checkoutTime: "10:30 AM",
        checkInTime: "3:00 PM",
      },
      sources: { calendars: ["Airbnb"], google: false },
      people: {
        host: { phoneLast4: "0130" },
        cleaner: { name: "Ana", phoneLast4: "0131" },
        contacts: [{ name: "Sam", role: "co-host", phoneLast4: "0132" }],
        groupChat: "everyone",
        groupThread: false,
      },
      schedule: {
        firstText: "days-after-check-in",
        firstTextDays: 2,
        reminder: "days-before-checkout",
        reminderDays: 1,
        reminderTime: "6:00 PM",
        quietFrom: "9:00 PM",
        quietUntil: "8:00 AM",
        escalateTo: "Sam",
      },
      access: { lockLocation: LOCK },
      preferences: PREFERENCES,
    });
    const json = JSON.stringify(review);
    for (const secret of [DOOR_CODE, HOST, CLEANER, OBSERVER, "5555550130", "5555550131", "5555550132", CALENDAR_URL]) {
      expect(json.includes(secret), secret).toBe(false);
    }

    const activated = await call(wired, "activate");
    expect(activated.isError).toBe(false);
    expect((await state(wired)).done).toContain("Checks finished.");
    expect(wired.cleanerSent).toEqual([]);
  });

  it("takes save_preferences({}) as no preferences and moves to review", async () => {
    const wired = await app();
    await call(wired, "get_state", { choice: "cleaners" });
    expect((await call(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00", checkInTime: "16:00" })).isError).toBe(false);
    expect((await call(wired, "save_calendar_link", { url: CALENDAR_URL })).isError).toBe(false);
    expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER })).isError).toBe(false);
    expect((await call(wired, "save_schedule", {})).isError).toBe(false);
    expect((await call(wired, "save_door_code", { code: DOOR_CODE })).isError).toBe(false);
    expect(askStep((await state(wired)))).toBe("preferences");
    expect((await call(wired, "save_preferences", {})).isError).toBe(false);
    expect(askStep(await state(wired))).toBe("payments");
    expect((await call(wired, "save_payments", { on: false })).isError).toBe(false);
    expect((await call(wired, "save_alert_routine", ROUTINE)).isError).toBe(false);
    const review = await state(wired);
    expect(review.next).toBe(REVIEW_NEXT);
    const setup = review.setup as Record<string, unknown>;
    expect(setup.preferences).toEqual({ checklist: [], photosRequired: false, supplyNotes: false });
    expect(setup.access).toEqual({});
    expect(setup.schedule).toEqual({ firstText: "days-before-checkout", firstTextDays: 1, reminder: "morning-of", reminderTime: "8:00 AM", escalateTo: "host" });
    expect((setup.people as Record<string, unknown>).cleaner).toEqual({ phoneLast4: "0131" });
    expect(JSON.stringify(review).includes(DOOR_CODE)).toBe(false);
    expect((await call(wired, "activate")).isError).toBe(false);
    expect((await state(wired)).done).toContain("Checks finished.");
  });

  it("lists the new tools beside the old ones", async () => {
    const wired = await app();
    const listed = await wired.listTools(PATH, CLEANER_TOKEN);
    for (const name of [
      "get_state",
      "save_property",
      "save_people",
      "save_calendar_link",
      "save_sources",
      "save_schedule",
      "save_door_code",
      "save_preferences",
      "activate",
      "set_up_texting",
      "run_checks",
      "check_now",
      "confirm_times",
      "save_alert_routine",
    ]) {
      expect(listed.names, name).toContain(name);
    }
  });
});

describe("Cleaner Core full setup: refusals", () => {
  async function atDoor(wired: WiredApp) {
    await call(wired, "get_state", { choice: "cleaners" });
    expect((await call(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00", checkInTime: "16:00" })).isError).toBe(false);
    expect((await call(wired, "save_calendar_link", { url: CALENDAR_URL })).isError).toBe(false);
    expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER })).isError).toBe(false);
    expect((await call(wired, "save_schedule", {})).isError).toBe(false);
  }

  it("refuses a usual time that is not a clock time", async () => {
    const wired = await app();
    await call(wired, "get_state", { choice: "cleaners" });
    expect((await call(wired, "save_property", { ...PROPERTY, checkoutTime: "late morning" })).isError).toBe(true);
    expect((await call(wired, "save_property", { ...PROPERTY, checkInTime: "15" })).isError).toBe(true);
  });

  it("refuses more than four contacts, a repeated phone, and a bad group choice", async () => {
    const wired = await app();
    await call(wired, "get_state", { choice: "cleaners" });
    expect((await call(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE })).isError).toBe(false);
    const five = ["+15555550140", "+15555550141", "+15555550142", "+15555550143", "+15555550144"].map((phone, index) => ({ name: `C${index}`, role: "observer", phone }));
    expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER, contacts: five })).isError).toBe(true);
    expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER, contacts: [{ name: "Sam", role: "assistant", phone: CLEANER }] })).isError).toBe(true);
    expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER, contacts: [{ name: "", role: "assistant", phone: OBSERVER }] })).isError).toBe(true);
    expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER, groupChat: "nobody" })).isError).toBe(true);
    expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER, observer: OBSERVER, contacts: [{ name: "Sam", role: "co-host", phone: OBSERVER }] })).isError).toBe(true);
  });

  it("refuses a lock location with a number run or too long", async () => {
    const wired = await app();
    await atDoor(wired);
    expect((await call(wired, "save_door_code", { code: DOOR_CODE, lockLocation: "lockbox 4417" })).isError).toBe(true);
    expect((await call(wired, "save_door_code", { code: DOOR_CODE, lockLocation: "x".repeat(81) })).isError).toBe(true);
    expect((await call(wired, "save_door_code", { code: DOOR_CODE, lockLocation: "Unit 12 side gate" })).isError).toBe(false);
  });

  it("refuses preferences that are too long or carry the door code", async () => {
    const wired = await app();
    await atDoor(wired);
    expect((await call(wired, "save_door_code", { code: DOOR_CODE })).isError).toBe(false);
    const thirteen = Array.from({ length: 13 }, (_, index) => `Task ${index}`);
    expect((await call(wired, "save_preferences", { checklist: thirteen })).isError).toBe(true);
    expect((await call(wired, "save_preferences", { checklist: ["x".repeat(81)] })).isError).toBe(true);
    expect((await call(wired, "save_preferences", { instructions: "x".repeat(301) })).isError).toBe(true);
    const inItem = await call(wired, "save_preferences", { checklist: ["Strip the beds", `Door code is ${DOOR_CODE}`] });
    expect(inItem.isError).toBe(true);
    expect(inItem.raw.includes(DOOR_CODE)).toBe(false);
    expect((await call(wired, "save_preferences", { instructions: `Use ${DOOR_CODE} at the side door` })).isError).toBe(true);
    expect(askStep((await state(wired)))).toBe("preferences");
  });
});

describe("Cleaner Core full setup: usual times", () => {
  it("passes the usual times to the engine, so the new-booking alert names them", async () => {
    const wired = await app();
    await call(wired, "get_state", { choice: "cleaners" });
    expect((await call(wired, "save_property", PROPERTY)).isError).toBe(false);
    expect((await call(wired, "save_sources", { google: true })).isError).toBe(false);
    expect((await call(wired, "save_people", { host: HOST, cleaner: CLEANER })).isError).toBe(false);
    expect((await call(wired, "save_door_code", { code: DOOR_CODE })).isError).toBe(false);
    expect((await call(wired, "save_preferences", {})).isError).toBe(false);
    expect((await call(wired, "save_alert_routine", ROUTINE)).isError).toBe(false);
    expect((await call(wired, "activate", { googleEvents: googleList([]) })).isError).toBe(false);
    const checked = await call(wired, "check_now", { googleEvents: googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-15" }]) });
    const alerts = (checked.structured?.alerts as string[] | undefined) ?? [];
    expect(alerts).toHaveLength(1);
    expect(plain(alerts[0] ?? "")).toBe("New booking at Lake House: check-in Wednesday, Oct 14, checkout Thursday, Oct 15. Use the usual 10:30 AM checkout and 3:00 PM check-in?");
  });

  it("passes the usual check-in time to the engine", async () => {
    const { desk } = openDesk([HOST, CLEANER], "0");
    await setUp(desk, { groupChat: "cleaner-only" });
    const engine = (desk as unknown as { engine: CleanerCore & { defaultCheckout: number; defaultCheckIn: number } }).engine;
    expect(engine.defaultCheckout).toBe(10 * 60 + 30);
    expect(engine.defaultCheckIn).toBe(15 * 60);
  });
});

/** A fake Twilio Conversations API for group texting. It counts every call and never leaves the machine. */
function groupFetch() {
  const fake = fakeConversations();
  return {
    impl: fake.impl,
    calls: fake.calls,
    /** Each group post: who got it and what it said. */
    get posts() {
      return fake.posts.map((post) => ({ to: post.to, body: post.body }));
    },
  };
}

function openDesk(phones: string[], groupChat: "0" | "1", now: () => Date = () => new Date(FROZEN), extraEnv: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "cleaner-full-setup-"));
  roots.push(root);
  const sms = fakeSms();
  const groups = groupFetch();
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
    CLEANER_CORE_SMS_ALLOWLIST: phones.join(","),
    CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
    CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
    CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    PUBLIC_BASE_URL: PHOTO_BASE,
    CLEANER_CORE_ROUTINE_URL: ROUTINE.url,
    CLEANER_CORE_ROUTINE_KEY: ROUTINE.token,
    ...extraEnv,
  };
  const desk = liveDeskFor(root, () => env, now);
  return { desk, sms, groups, root, env };
}

function ok(reply: ToolReply): Record<string, unknown> {
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

type PeopleInput = Parameters<LiveDesk["savePeople"]>[0];

/** Connects the alert routine, as Grok does before the review. openDesk's env already holds its values. */
async function connectRoutine(desk: LiveDesk) {
  ok(await desk.saveAlertRoutine(ROUTINE, () => undefined));
}

async function setUp(desk: LiveDesk, people: Partial<PeopleInput>) {
  ok(await desk.getState("cleaners"));
  ok(await desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "10:30", checkInTime: "15:00" }));
  ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
  ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", ...people }));
  ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: LOCK }, PIN_KEY));
  ok(await desk.savePreferences({}));
  await connectRoutine(desk);
  ok(await desk.activate());
  ok(await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" }));
}

function codeRecipients(sent: SentSms[]): string[] {
  return sent.filter((item) => item.body.includes(DOOR_CODE)).map((item) => item.to);
}

describe("Cleaner Core full setup: who gets the texts", () => {
  it("cleaner-only with group chat on sends one-to-one texts and makes no Conversations call", async () => {
    const { desk, sms, groups } = openDesk([HOST, CLEANER, OBSERVER], "1");
    await setUp(desk, { contacts: [{ name: "Sam", role: "co-host", phone: OBSERVER }], groupChat: "cleaner-only" });
    expect((ok(await desk.getState()).done as string[]).some((line) => line.startsWith("Group chat set up"))).toBe(false);
    await desk.inbound({ id: "yes-1", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-2", from: CLEANER, text: "YES" });
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    expect(groups.calls()).toBe(0);
    expect(sms.sent.some((item) => item.to === CLEANER)).toBe(true);
    expect(sms.sent.some((item) => item.to === OBSERVER)).toBe(false);
    expect(codeRecipients(sms.sent)).toEqual([CLEANER]);
    expect(sms.sent.find((item) => item.body.includes(DOOR_CODE))?.body).toBe(PRIVATE_PIN);
  });

  it("everyone puts the contacts in the group, uses the cleaner's name, and sends the code with the lock privately to the cleaner only", async () => {
    const { desk, sms, groups } = openDesk([HOST, CLEANER, OBSERVER, SECOND], "1");
    await setUp(desk, {
      contacts: [
        { name: "Sam", role: "co-host", phone: OBSERVER },
        { name: "Lee", role: "assistant", phone: SECOND },
      ],
      groupChat: "everyone",
      doorCodeTo: "cleaner",
    });
    expect(sms.sent.find((item) => item.to === OBSERVER)?.body).toContain("wants to set up a group chat with you for cleaner services at");
    expect(sms.sent.find((item) => item.to === CLEANER)?.body).toContain("wants to set up a group chat with you for cleaner services at");
    await desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-sam", from: OBSERVER, text: "YES" });
    await desk.inbound({ id: "yes-lee", from: SECOND, text: "YES" });
    await desk.inbound({ id: "yes-schedule", from: CLEANER, text: "YES" });
    expect(ok(await postToGroup(desk, NOTE)).next).toBe("Sent to the group.");
    expect(groups.posts.find((post) => post.body === NOTE)?.to).toEqual([HOST, CLEANER, OBSERVER, SECOND].sort());

    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    expect(codeRecipients(sms.sent)).toEqual([CLEANER]);
    expect(sms.sent.find((item) => item.body.includes(DOOR_CODE))?.body).toBe(PRIVATE_PIN);
    expect(groups.posts.some((post) => post.body.includes(DOOR_CODE))).toBe(false);
    const notes = JSON.stringify(ok(await desk.getState()));
    expect(notes.includes(DOOR_CODE)).toBe(false);
  });

  it("says where the door code goes when it is saved: the group, or a private text when the host kept it private", async () => {
    const grouped = openDesk([HOST, CLEANER], "1").desk;
    ok(await grouped.getState("cleaners"));
    ok(await grouped.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "10:30", checkInTime: "15:00" }));
    ok(await grouped.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
    ok(await grouped.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-and-host" }));
    expect(ok(await grouped.saveDoorCode({ code: DOOR_CODE, lockLocation: LOCK }, PIN_KEY)).next).toBe(
      "Saved the door code. It goes only to the cleaner, in the cleaning group, after you say the guests have left.",
    );
    resetLiveDesks();
    const kept = openDesk([HOST, CLEANER, OBSERVER], "1").desk;
    ok(await kept.getState("cleaners"));
    ok(await kept.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "10:30", checkInTime: "15:00" }));
    ok(await kept.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
    ok(await kept.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", contacts: [{ name: "Sam", role: "co-host", phone: OBSERVER }], groupChat: "everyone", doorCodeTo: "cleaner" }));
    expect(ok(await kept.saveDoorCode({ code: DOOR_CODE, lockLocation: LOCK }, PIN_KEY)).next).toBe(
      "Saved the door code. It goes only to the cleaner, in a private text, after you say the guests have left.",
    );
  });

  it("cleaner-and-host leaves the contacts out of the group", async () => {
    const { desk, sms, groups } = openDesk([HOST, CLEANER, OBSERVER], "1");
    await setUp(desk, { contacts: [{ name: "Sam", role: "observer", phone: OBSERVER }], groupChat: "cleaner-and-host" });
    await desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-schedule", from: CLEANER, text: "YES" });
    expect(ok(await postToGroup(desk, NOTE)).next).toBe("Sent to the group.");
    expect(groups.posts.find((post) => post.body === NOTE)?.to).toEqual([HOST, CLEANER].sort());
    expect(sms.sent.some((item) => item.to === OBSERVER)).toBe(false);
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    // The group holds only the host and the cleaner, so the code goes into it. The contact is never in it.
    expect(codeRecipients(sms.sent)).toEqual([]);
    expect(groups.posts.filter((post) => post.body.includes(DOOR_CODE)).map((post) => post.to)).toEqual([[HOST, CLEANER].sort()]);
  });
});

describe("Cleaner Core full setup: the MCP door-code guard", () => {
  it("refuses a door code hidden in a checklist item or a contact name", async () => {
    const { desk } = openDesk([HOST, CLEANER], "0");
    ok(await desk.getState("cleaners"));
    ok(await desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE }));
    ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
    ok(await desk.savePeople({ host: HOST, cleaner: CLEANER }));
    ok(await desk.saveDoorCode({ code: DOOR_CODE }, PIN_KEY));
    const send = async (name: string, args: Record<string, unknown>) => {
      const res = await handleCleanerMcpMessage(desk, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, PIN_KEY);
      return res.body as { result?: { isError?: boolean; content?: { text?: string }[] } };
    };
    const item = await send("save_preferences", { checklist: [DOOR_CODE] });
    expect(item.result?.isError).toBe(true);
    expect(item.result?.content?.[0]?.text).toBe("Please don't send the door code in chat. Use the private box instead.");
    const contact = await send("save_people", { host: HOST, cleaner: CLEANER, contacts: [{ name: `Sam ${DOOR_CODE}`, role: "co-host", phone: OBSERVER }] });
    expect(contact.result?.isError).toBe(true);
    expect(contact.result?.content?.[0]?.text).toBe("Please don't send the door code in chat. Use the private box instead.");
  });
});

describe("Cleaner Core door-code check: every host free text", () => {
  const REFUSED = { ok: false, error: DOOR_CODE_IN_CHAT };

  /** Lake House up to the door code, saved as `code` (made up) when one is given. */
  async function atDoorCode(code?: string) {
    const opened = openDesk([HOST, CLEANER], "0");
    const { desk } = opened;
    ok(await desk.getState("cleaners"));
    ok(await desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE }));
    ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
    ok(await desk.savePeople({ host: HOST, cleaner: CLEANER }));
    if (code) ok(await desk.saveDoorCode({ code }, PIN_KEY));
    return opened;
  }

  const savedFile = (root: string) => readFileSync(join(root, "cleaner-live.json"), "utf8");

  it("refuses instructions that hold the code after a restart, with the code sealed and with it opened", async () => {
    const { root, env } = await atDoorCode("4827");
    resetLiveDesks();
    const restarted = liveDeskFor(root, () => env, () => new Date(FROZEN));
    const instructions = "Lockbox opens with 4827";
    // No key opens the seal, so any run of 4 digits might be the code.
    expect(await restarted.savePreferences({ instructions })).toEqual(REFUSED);
    const viaChat = await handleCleanerMcpMessage(restarted, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "save_preferences", arguments: { instructions } } });
    expect((viaChat.body as { result: { isError: boolean; content: { text: string }[] } }).result).toEqual(
      expect.objectContaining({ isError: true, content: [{ type: "text", text: DOOR_CODE_IN_CHAT }] }),
    );
    // With the key, save_preferences opens the seal and finds the code itself.
    expect(await restarted.savePreferences({ instructions }, PIN_KEY)).toEqual(REFUSED);
    expect(savedFile(root).includes("4827")).toBe(false);
    ok(await restarted.savePreferences({ instructions: "Leave the porch light on." }, PIN_KEY));
  });

  it("refuses a split code in instructions or a checklist item with the code in memory", async () => {
    const { desk, root } = await atDoorCode("4827");
    for (const text of ["Lockbox opens with 48 27", "Code 4-8-2-7 at the back", "It's 4.8.2.7 today"]) {
      expect(await desk.savePreferences({ instructions: text }), text).toEqual(REFUSED);
      expect(await desk.savePreferences({ checklist: ["Strip the beds", text] }), text).toEqual(REFUSED);
    }
    expect(JSON.parse(savedFile(root)).preferences).toBeUndefined();
    ok(await desk.savePreferences({ checklist: ["Unit 12 towels"], instructions: "Gate 3 sticks." }));
  });

  it("refuses a lock location like 80 88 on the first save", async () => {
    const { desk, root } = await atDoorCode();
    for (const lockLocation of ["80 88", "lockbox 8-0-8-8", "box 4 4 1 7"]) {
      expect((await desk.saveDoorCode({ code: DOOR_CODE, lockLocation }, PIN_KEY)).ok, lockLocation).toBe(false);
    }
    expect(savedFile(root)).not.toContain("pinSeal");
    expect(savedFile(root)).not.toContain("80 88");
    ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: "Unit 12 side gate" }, PIN_KEY));
  });

  it("refuses the code in a cleaner, contact, or calendar name, a calendar link, or who hears about problems", async () => {
    const { desk, root, env } = await atDoorCode(DOOR_CODE);
    const split = "80 88";
    expect(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: `Ana ${split}` })).toEqual(REFUSED);
    expect(await desk.savePeople({ host: HOST, cleaner: CLEANER, contacts: [{ name: `Sam ${split}`, role: "co-host", phone: OBSERVER }] })).toEqual(REFUSED);
    expect(await desk.saveSchedule({ escalateTo: `Sam ${split}` })).toEqual(REFUSED);
    expect(await desk.saveSources({ calendars: [{ name: `Airbnb ${split}`, url: CALENDAR_URL }] })).toEqual(REFUSED);
    expect(await desk.saveSources({ calendars: [{ name: "Airbnb", url: `${CALENDAR_URL}?k=${DOOR_CODE}` }] })).toEqual(REFUSED);
    expect(await desk.saveCalendarLink({ url: `${CALENDAR_URL}?k=${split}` })).toEqual(REFUSED);
    // Sealed after a restart with no key: a run of 4 digits is refused, a name without one is kept.
    resetLiveDesks();
    const restarted = liveDeskFor(root, () => env, () => new Date(FROZEN));
    expect(await restarted.saveSchedule({ escalateTo: "Sam 4417" })).toEqual(REFUSED);
    ok(await restarted.saveSchedule({ escalateTo: "Sam" }));
    for (const form of [split, DOOR_CODE, "4417"]) expect(savedFile(root).includes(form), form).toBe(false);
  });

  it("stores and returns a cleaner's split door code redacted", async () => {
    const { desk, root } = await confirmedCleaner();
    await desk.inbound({ id: "split-code", from: CLEANER, text: "the code 80-88 isn't working" });
    await desk.inbound({ id: "spaced-code", from: CLEANER, text: "is it 8 0 8 8?" });
    const reply = ok(await desk.checkNow());
    expect(brief((reply.messages as Message[] | undefined) ?? []).slice(-2).map((message) => message.text)).toEqual([
      "the code [redacted] isn't working",
      "is it [redacted]?",
    ]);
    for (const form of ["80-88", "8 0 8 8", DOOR_CODE]) {
      expect(JSON.stringify(reply).includes(form), form).toBe(false);
      expect(savedFile(root).includes(form), form).toBe(false);
    }
  });
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

type ScheduleInput = Parameters<LiveDesk["saveSchedule"]>[0];

/**
 * Sets up Lake House with a schedule and confirms the first stay's times. The calendar has a stay
 * from Wed Oct 14 to Sun Oct 18 and the next one from Oct 18. The clock starts Oct 14 at 11:00 AM.
 */
/** With no schedule, the engine keeps its defaults (the 8:00 AM morning-of reminder). */
async function withSchedule(schedule: ScheduleInput | undefined, groupChat: "0" | "1") {
  const time = testClock(FROZEN);
  const opened = openDesk([HOST, CLEANER], groupChat, time.now);
  const { desk } = opened;
  ok(await desk.getState("cleaners"));
  ok(await desk.saveProperty({ business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00", checkInTime: "16:00" }));
  ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
  ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana" }));
  // These tests time the offer only when they say so. Otherwise it goes once the times are confirmed.
  if (schedule) ok(await desk.saveSchedule({ firstText: "when-confirmed", ...schedule }));
  ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: LOCK }, PIN_KEY));
  ok(await desk.savePreferences({}));
  await connectRoutine(desk);
  ok(await desk.activate());
  ok(await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" }));
  return { ...opened, time };
}

/** The cleaner (and in a group, the host) opts in. */
async function optIn(desk: LiveDesk, groupChat: "0" | "1") {
  if (groupChat === "1") await desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
  await desk.inbound({ id: "yes-opt-in", from: CLEANER, text: "YES" });
}

function offers(sent: SentSms[]): SentSms[] {
  return sent.filter((item) => item.to === CLEANER && item.body.startsWith("Turnover at"));
}

/** Offers to the cleaner, one-to-one or in the group. */
function offersAnywhere(sent: SentSms[], posts: { to: string[]; body: string }[]): string[] {
  return [...offers(sent).map((item) => item.body), ...posts.filter((post) => post.to.includes(CLEANER) && post.body.startsWith("Turnover at")).map((post) => post.body)];
}

function reminders(sent: SentSms[]): SentSms[] {
  return sent.filter((item) => item.to === CLEANER && item.body.startsWith("Reminder:"));
}

async function alertsAt(desk: LiveDesk, time: ReturnType<typeof testClock>, iso: string): Promise<string[]> {
  time.set(iso);
  return ((ok(await desk.checkNow()).alerts as string[] | undefined) ?? []).map(plain);
}

const REMINDER_ARRIVAL = `Reminder: cleaning at ${ADDRESS} on Sunday, Oct 18. Checkout is 11:00 AM. What time do you plan to arrive?`;
const NUDGE = "Checkout time at Lake House. Have the guests left?";

describe("Cleaner Core schedule: the first cleaning text", () => {
  for (const groupChat of ["0", "1"] as const) {
    it(`days-after-check-in 2 holds the offer until check-in + 2 days at 9:00 AM, then sends it once (group ${groupChat})`, async () => {
      const { desk, sms, groups, time } = await withSchedule({ firstText: "days-after-check-in", firstTextDays: 2 }, groupChat);
      await optIn(desk, groupChat);
      expect(offersAnywhere(sms.sent, groups.posts)).toEqual([]);
      await alertsAt(desk, time, "2026-10-16T12:59:00.000Z");
      expect(offersAnywhere(sms.sent, groups.posts)).toEqual([]);
      await alertsAt(desk, time, "2026-10-16T13:00:00.000Z");
      expect(offersAnywhere(sms.sent, groups.posts)).toHaveLength(1);
      await alertsAt(desk, time, "2026-10-16T13:05:00.000Z");
      expect(offersAnywhere(sms.sent, groups.posts)).toHaveLength(1);
      expect(codeRecipients(sms.sent)).toEqual([]);
    });
  }

  it("sends a timed offer no later than 9:00 AM the day before checkout", async () => {
    const { desk, sms, time } = await withSchedule({ firstText: "days-after-check-in", firstTextDays: 14 }, "0");
    await optIn(desk, "0");
    await alertsAt(desk, time, "2026-10-17T12:59:00.000Z");
    expect(offers(sms.sent)).toEqual([]);
    await alertsAt(desk, time, "2026-10-17T13:00:00.000Z");
    expect(offers(sms.sent)).toHaveLength(1);
  });

  for (const groupChat of ["0", "1"] as const) {
    it(`days-before-checkout 2 holds the offer until checkout - 2 days at 9:00 AM, then sends it once (group ${groupChat})`, async () => {
      const { desk, sms, groups, time } = await withSchedule({ firstText: "days-before-checkout", firstTextDays: 2 }, groupChat);
      await optIn(desk, groupChat);
      expect(offersAnywhere(sms.sent, groups.posts)).toEqual([]);
      await alertsAt(desk, time, "2026-10-16T12:59:00.000Z");
      expect(offersAnywhere(sms.sent, groups.posts)).toEqual([]);
      await alertsAt(desk, time, "2026-10-16T13:00:00.000Z");
      expect(offersAnywhere(sms.sent, groups.posts)).toHaveLength(1);
      await alertsAt(desk, time, "2026-10-16T13:05:00.000Z");
      expect(offersAnywhere(sms.sent, groups.posts)).toHaveLength(1);
      expect(codeRecipients(sms.sent)).toEqual([]);
    });
  }

  it("days-before-checkout already past sends the offer on the next check", async () => {
    const { desk, sms } = await withSchedule({ firstText: "days-before-checkout", firstTextDays: 7 }, "0");
    await optIn(desk, "0");
    expect(offers(sms.sent)).toHaveLength(1);
  });

  it("the default holds the offer until 9:00 AM the day before checkout", async () => {
    const time = testClock(FROZEN);
    const { desk, sms } = openDesk([HOST, CLEANER], "0", time.now);
    ok(await desk.getState("cleaners"));
    ok(await desk.saveProperty({ business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00", checkInTime: "16:00" }));
    ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
    ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana" }));
    ok(await desk.saveSchedule({}));
    ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: LOCK }, PIN_KEY));
    ok(await desk.savePreferences({}));
    await connectRoutine(desk);
    ok(await desk.activate());
    ok(await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" }));
    await optIn(desk, "0");
    expect(offers(sms.sent)).toEqual([]);
    await alertsAt(desk, time, "2026-10-17T12:59:00.000Z");
    expect(offers(sms.sent)).toEqual([]);
    await alertsAt(desk, time, "2026-10-17T13:00:00.000Z");
    expect(offers(sms.sent)).toHaveLength(1);
  });

  it("when-confirmed sends the offer right after the cleaner opts in", async () => {
    const { desk, sms } = await withSchedule({ firstText: "when-confirmed" }, "0");
    await optIn(desk, "0");
    expect(offers(sms.sent)).toHaveLength(1);
  });

  it("never sends a timed offer before the host confirmed the times", async () => {
    const time = testClock(FROZEN);
    const { desk, sms } = openDesk([HOST, CLEANER], "0", time.now);
    ok(await desk.getState("cleaners"));
    ok(await desk.saveProperty({ business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00", checkInTime: "16:00" }));
    ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
    ok(await desk.savePeople({ host: HOST, cleaner: CLEANER }));
    ok(await desk.saveSchedule({ firstText: "days-after-check-in", firstTextDays: 1 }));
    ok(await desk.saveDoorCode({ code: DOOR_CODE }, PIN_KEY));
    ok(await desk.savePreferences({}));
    await connectRoutine(desk);
    ok(await desk.activate());
    await alertsAt(desk, time, "2026-10-16T13:00:00.000Z");
    expect(sms.sent.filter((item) => item.to === CLEANER)).toEqual([]);
  });
});

describe("Cleaner Core schedule: the reminder", () => {
  it("days-before-checkout 1 at 6:00 PM sends one reminder that asks for an arrival time", async () => {
    const { desk, sms, time } = await withSchedule({ reminder: "days-before-checkout", reminderDays: 1, reminderTime: "18:00" }, "0");
    await optIn(desk, "0");
    expect(offers(sms.sent)).toHaveLength(1);
    await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
    await alertsAt(desk, time, "2026-10-17T21:59:00.000Z");
    expect(reminders(sms.sent)).toEqual([]);
    await alertsAt(desk, time, "2026-10-17T22:00:00.000Z");
    expect(reminders(sms.sent).map((item) => plain(item.body))).toEqual([REMINDER_ARRIVAL]);
    await alertsAt(desk, time, "2026-10-17T22:30:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
    expect(codeRecipients(sms.sent)).toEqual([]);
  });

  it("quiet hours hold both the timed offer and the reminder", async () => {
    const { desk, sms, time } = await withSchedule(
      {
        firstText: "days-after-check-in",
        firstTextDays: 2,
        reminder: "days-before-checkout",
        reminderDays: 1,
        reminderTime: "18:00",
        quietFrom: "17:00",
        quietUntil: "10:00",
      },
      "0",
    );
    await optIn(desk, "0");
    await alertsAt(desk, time, "2026-10-16T13:00:00.000Z");
    expect(offers(sms.sent)).toEqual([]);
    await alertsAt(desk, time, "2026-10-16T14:00:00.000Z");
    expect(offers(sms.sent)).toHaveLength(1);
    await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
    await alertsAt(desk, time, "2026-10-17T22:00:00.000Z");
    expect(reminders(sms.sent)).toEqual([]);
    await alertsAt(desk, time, "2026-10-18T13:59:00.000Z");
    expect(reminders(sms.sent)).toEqual([]);
    await alertsAt(desk, time, "2026-10-18T14:00:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
  });
});

describe("Cleaner Core schedule: changing the schedule", () => {
  it("clearing quiet hours takes effect, so a reminder inside the old window is sent", async () => {
    const { desk, sms, time } = await withSchedule(
      { reminder: "days-before-checkout", reminderDays: 1, reminderTime: "18:00", quietFrom: "17:00", quietUntil: "10:00" },
      "0",
    );
    await optIn(desk, "0");
    await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
    await alertsAt(desk, time, "2026-10-17T21:30:00.000Z");
    expect(reminders(sms.sent)).toEqual([]);
    ok(await desk.saveSchedule({ quietFrom: "", quietUntil: "" }));
    const reviewed = ok(await desk.getState());
    expect(JSON.stringify(reviewed).includes("quietFrom")).toBe(false);
    await alertsAt(desk, time, "2026-10-17T22:00:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
  });

  it("a reminder already sent is not sent again when the schedule is saved or its kind changes", async () => {
    const { desk, sms, time } = await withSchedule(undefined, "0");
    await optIn(desk, "0");
    await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
    await alertsAt(desk, time, "2026-10-18T12:00:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
    ok(await desk.saveSchedule({}));
    await alertsAt(desk, time, "2026-10-18T12:10:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
    ok(await desk.saveSchedule({ reminder: "days-before-checkout", reminderDays: 1, reminderTime: "18:00" }));
    await alertsAt(desk, time, "2026-10-18T12:20:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
  });

  it("changing the saved reminder's kind after it went out does not send a second one", async () => {
    const { desk, sms, time } = await withSchedule({ reminder: "days-before-checkout", reminderDays: 1, reminderTime: "18:00" }, "0");
    await optIn(desk, "0");
    await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
    await alertsAt(desk, time, "2026-10-17T22:00:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
    ok(await desk.saveSchedule({ reminder: "morning-of", reminderTime: "08:00" }));
    await alertsAt(desk, time, "2026-10-18T12:00:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
  });
});

describe("Cleaner Core: one step at a time", () => {
  it("check_now with a slow calendar read beside save_schedule and save_arrival loses nothing, sends nothing twice, and doesn't crash", async () => {
    const { desk, sms, time, root, env } = await withSchedule({ reminder: "days-before-checkout", reminderDays: 1, reminderTime: "18:00" }, "0");
    await optIn(desk, "0");
    await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
    let started = (): void => undefined;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The calendar read hangs until the test lets it go.
    setCleanerCalendarFetch(async (url) => {
      started();
      await held;
      return { status: url === CALENDAR_URL ? 200 : 404, url, text: async () => (url === CALENDAR_URL ? CALENDAR_ICS : "") };
    });
    time.set("2026-10-17T22:00:00.000Z");
    const checking = desk.checkNow();
    await reading;
    const schedule = desk.saveSchedule({ quietFrom: "21:00", quietUntil: "08:00" });
    const arrival = desk.saveArrival({ time: "11:30" });
    const state = desk.getState();
    const turns = desk.getTurns();
    release();
    const replies = await Promise.all([checking, schedule, arrival, state, turns]);
    for (const reply of replies) ok(reply);
    expect(reminders(sms.sent).map((item) => plain(item.body))).toEqual([REMINDER_ARRIVAL]);

    // Every later step, and a restart, sees the reminder as sent, the arrival time, and the schedule.
    const arrived = (reply: ToolReply) => (ok(reply).turns as { arrivalTime?: string }[]).map((turn) => turn.arrivalTime);
    await alertsAt(desk, time, "2026-10-17T22:30:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
    expect(arrived(await desk.getTurns())[0]).toBe("11:30 AM");
    resetLiveDesks();
    const restarted = liveDeskFor(root, () => env, time.now);
    await alertsAt(restarted, time, "2026-10-17T23:00:00.000Z");
    expect(reminders(sms.sent)).toHaveLength(1);
    expect(arrived(await restarted.getTurns())[0]).toBe("11:30 AM");
    const saved = JSON.parse(readFileSync(join(root, "cleaner-live.json"), "utf8")) as { schedule?: { quietFrom?: string; reminderTime?: string } };
    expect(saved.schedule).toEqual(expect.objectContaining({ quietFrom: "21:00", reminderTime: "18:00" }));
    expect(codeRecipients(sms.sent)).toEqual([]);
  });
});

describe("Cleaner Core schedule: the new-booking alert", () => {
  async function bookingAlert(groupChat: "0" | "1", usual: boolean): Promise<string[]> {
    const { desk } = openDesk([HOST, CLEANER], groupChat);
    ok(await desk.getState("cleaners"));
    ok(
      await desk.saveProperty({
        business: BUSINESS,
        nickname: "Lake House",
        address: ADDRESS,
        timeZone: ZONE,
        ...(usual ? { checkoutTime: "10:30", checkInTime: "15:00" } : {}),
      }),
    );
    ok(await desk.saveSources({ google: true }));
    ok(await desk.savePeople({ host: HOST, cleaner: CLEANER }));
    ok(await desk.saveSchedule({}));
    ok(await desk.saveDoorCode({ code: DOOR_CODE }, PIN_KEY));
    ok(await desk.savePreferences({}));
    await connectRoutine(desk);
    ok(await desk.activate({ googleEvents: googleList([]) }));
    const checked = ok(await desk.checkNow({ googleEvents: googleList([{ id: "g1", start: "2026-10-14", end: "2026-10-18" }]) }));
    return ((checked.alerts as string[] | undefined) ?? []).map(plain);
  }

  for (const groupChat of ["0", "1"] as const) {
    it(`names the usual times when they are saved (group ${groupChat})`, async () => {
      expect(await bookingAlert(groupChat, true)).toEqual([
        "New booking at Lake House: check-in Wednesday, Oct 14, checkout Sunday, Oct 18. Use the usual 10:30 AM checkout and 3:00 PM check-in?",
      ]);
    });
  }

  it("keeps the existing copy without usual times", async () => {
    expect(await bookingAlert("1", false)).toEqual([`New booking at ${ADDRESS}, checking out Sunday, Oct 18. What are the checkout time and the next check-in time?`]);
    resetLiveDesks();
    expect(await bookingAlert("0", false)).toEqual([`Is checkout at ${ADDRESS} on Sunday, Oct 18 still 11:00 AM? Reply YES or send the new time.`]);
  });
});

describe("Cleaner Core schedule: the checkout-time nudge", () => {
  for (const groupChat of ["0", "1"] as const) {
    it(`asks the host once after the confirmed checkout time, and the code still waits for "guests have left" (group ${groupChat})`, async () => {
      const { desk, sms, groups, time } = await withSchedule({}, groupChat);
      await optIn(desk, groupChat);
      await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
      expect((await alertsAt(desk, time, "2026-10-18T14:59:00.000Z")).includes(NUDGE)).toBe(false);
      expect((await alertsAt(desk, time, "2026-10-18T15:00:00.000Z")).filter((alert) => alert === NUDGE)).toHaveLength(1);
      expect((await alertsAt(desk, time, "2026-10-18T15:30:00.000Z")).includes(NUDGE)).toBe(false);
      expect(codeRecipients(sms.sent)).toEqual([]);
      expect(groups.posts.filter((post) => post.body.includes(DOOR_CODE))).toEqual([]);
      ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
      // With the group on and only the host and the cleaner in it, the code goes into the group.
      expect(codeRecipients(sms.sent)).toEqual(groupChat === "1" ? [] : [CLEANER]);
      expect(groups.posts.filter((post) => post.body.includes(DOOR_CODE)).map((post) => post.to)).toEqual(groupChat === "1" ? [[HOST, CLEANER].sort()] : []);
      expect((await alertsAt(desk, time, "2026-10-18T16:00:00.000Z")).includes(NUDGE)).toBe(false);
    });
  }
});

describe("Cleaner Core schedule: save_schedule", () => {
  it("refuses days outside 1 to 14, a bad time, one-sided quiet hours, and a door code", async () => {
    const { desk } = openDesk([HOST, CLEANER], "0");
    ok(await desk.getState("cleaners"));
    ok(await desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00", checkInTime: "16:00" }));
    expect((await desk.saveSchedule({})).ok).toBe(false);
    ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
    ok(await desk.savePeople({ host: HOST, cleaner: CLEANER }));
    ok(await desk.saveDoorCode({ code: DOOR_CODE }, PIN_KEY));
    expect((await desk.saveSchedule({ firstText: "days-after-check-in" })).ok).toBe(false);
    expect((await desk.saveSchedule({ firstText: "days-after-check-in", firstTextDays: 0 })).ok).toBe(false);
    expect((await desk.saveSchedule({ firstText: "days-after-check-in", firstTextDays: 15 })).ok).toBe(false);
    expect((await desk.saveSchedule({ firstText: "days-after-check-in", firstTextDays: 1.5 })).ok).toBe(false);
    expect((await desk.saveSchedule({ reminder: "days-before-checkout", reminderTime: "18:00" })).ok).toBe(false);
    expect((await desk.saveSchedule({ reminderTime: "18" })).ok).toBe(false);
    expect((await desk.saveSchedule({ quietFrom: "21:00" })).ok).toBe(false);
    expect((await desk.saveSchedule({ escalateTo: `Sam ${DOOR_CODE}` })).ok).toBe(false);
    expect((await desk.saveSchedule({ firstText: "never" as never })).ok).toBe(false);
    expect(askStep(ok(await desk.getState()))).toBe("schedule");
    expect(askStep(ok(await desk.saveSchedule({ reminder: "days-before-checkout", reminderDays: 14, reminderTime: "07:30" })))).toBe("preferences");
  });

  it("does not carry the saved days over when the first text changes between after check-in and before checkout", async () => {
    const { desk } = openDesk([HOST, CLEANER], "0");
    ok(await desk.getState("cleaners"));
    ok(await desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00", checkInTime: "16:00" }));
    ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
    ok(await desk.savePeople({ host: HOST, cleaner: CLEANER }));
    ok(await desk.saveSchedule({ firstText: "days-after-check-in", firstTextDays: 5 }));
    expect((await desk.saveSchedule({ firstText: "days-before-checkout" })).ok).toBe(false);
    ok(await desk.saveSchedule({ firstText: "days-before-checkout", firstTextDays: 3 }));
    // The same kind keeps its saved days.
    ok(await desk.saveSchedule({ reminderTime: "07:00" }));
    expect((await desk.saveSchedule({ firstText: "days-after-check-in" })).ok).toBe(false);
  });
});

interface Message {
  id: string;
  from: string;
  name: string;
  text: string;
  at: string;
  handled: string;
}

async function messagesNow(desk: LiveDesk): Promise<Message[]> {
  return (ok(await desk.checkNow()).messages as Message[] | undefined) ?? [];
}

function brief(messages: Message[]): { from: string; name: string; text: string; handled: string }[] {
  return messages.map(({ from, name, text, handled }) => ({ from, name, text, handled }));
}

function wakes(root: string) {
  const outbox = new OperatorEventOutbox(new FileRuntimeStore(join(root, "cleaner-alerts")), () => new NoopOperatorNotificationSink());
  return outbox.records().filter((record) => record.event.eventType === "cleaning.update");
}

async function mcp(desk: LiveDesk, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reply = await handleCleanerMcpMessage(desk, { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }, PIN_KEY);
  return (reply.body as { result: Record<string, unknown> }).result;
}

/** Cleaner-only Lake House with the cleaner opted in and the offer taken. */
async function confirmedCleaner(extraEnv: NodeJS.ProcessEnv = {}) {
  const opened = openDesk([HOST, CLEANER], "0", () => new Date(FROZEN), extraEnv);
  await setUp(opened.desk, { groupChat: "cleaner-only" });
  await opened.desk.inbound({ id: "yes-opt-in", from: CLEANER, text: "YES" });
  await opened.desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
  return opened;
}

const GROUP_ONLY = "Messages go to the group. Send it with to: group.";
const ARRIVAL_TEXT = "Yes I'll be there around 11:30";

describe("Cleaner Core messages: Grok reads every message", () => {
  it("records a non-keyword text with handled none and sends the cleaner no reply", async () => {
    const { desk, sms } = await confirmedCleaner();
    const before = sms.sent.filter((item) => item.to === CLEANER).length;
    await desk.inbound({ id: "arrival", from: CLEANER, text: ARRIVAL_TEXT });
    expect(sms.sent.filter((item) => item.to === CLEANER)).toHaveLength(before);
    expect(brief(await messagesNow(desk))).toEqual([
      { from: "cleaner", name: "Ana", text: "YES", handled: "opted-in" },
      { from: "cleaner", name: "Ana", text: "YES", handled: "confirmed" },
      { from: "cleaner", name: "Ana", text: ARRIVAL_TEXT, handled: "none" },
    ]);
  });

  it("records DONE as done", async () => {
    const { desk } = await confirmedCleaner();
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    expect(brief(await messagesNow(desk)).at(-1)).toEqual({ from: "cleaner", name: "Ana", text: "DONE", handled: "done" });
  });

  it("still guides a near-miss YES on an offer to reply YES, and records it", async () => {
    const { desk, sms } = openDesk([HOST, CLEANER], "0");
    await setUp(desk, { groupChat: "cleaner-only" });
    await desk.inbound({ id: "yes-opt-in", from: CLEANER, text: "YES" });
    expect((ok(await desk.getTurns()).turns as { status: string }[])[0]?.status).toBe("offered");
    await desk.inbound({ id: "near-yes", from: CLEANER, text: ARRIVAL_TEXT });
    expect(sms.sent.at(-1)).toEqual(expect.objectContaining({ to: CLEANER, body: "Reply YES to schedule the cleaning, or STOP to opt out." }));
    expect(brief(await messagesNow(desk)).at(-1)).toEqual({ from: "cleaner", name: "Ana", text: ARRIVAL_TEXT, handled: "none" });
  });

  it("still guides a near-miss DONE during the cleaning to reply DONE, and records it", async () => {
    const { desk, sms } = await confirmedCleaner();
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    await desk.inbound({ id: "all-done", from: CLEANER, text: "All done!" });
    expect(sms.sent.at(-1)).toEqual(expect.objectContaining({ to: CLEANER, body: "Reply DONE when the cleaning is finished." }));
    expect(brief(await messagesNow(desk)).at(-1)).toEqual({ from: "cleaner", name: "Ana", text: "All done!", handled: "none" });
  });

  it("sends no reply to free text while the cleaner waits for the guests to leave", async () => {
    const { desk, sms } = await confirmedCleaner();
    const before = sms.sent.length;
    await desk.inbound({ id: "free", from: CLEANER, text: "Do you want me to bring extra towels?" });
    expect(sms.sent).toHaveLength(before);
    expect(brief(await messagesNow(desk)).at(-1)?.handled).toBe("none");
  });

  it("labels a DONE none when its acknowledgement didn't go out, and the job stays open", async () => {
    const { desk, sms } = await confirmedCleaner();
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    setCleanerTwilioClient({
      ...sms,
      async sendSms(input) {
        if (input.body === "Thanks, cleaning marked done.") throw new Error("carrier down");
        return sms.sendSms(input);
      },
    });
    await desk.inbound({ id: "done-failed", from: CLEANER, text: "DONE" });
    expect(brief(await messagesNow(desk)).at(-1)).toEqual({ from: "cleaner", name: "Ana", text: "DONE", handled: "none" });
    expect((ok(await desk.getTurns()).turns as { status: string }[]).map((turn) => turn.status)).not.toContain("done");
  });

  it("records STOP as stop and still sends the host the existing note", async () => {
    const { desk, sms } = await confirmedCleaner();
    await desk.inbound({ id: "stop", from: CLEANER, text: "STOP" });
    expect(sms.sent.filter((item) => item.to === HOST).map((item) => item.body)).toContain(cleanerOptOutHold(ADDRESS));
    expect(brief(await messagesNow(desk)).at(-1)).toEqual({ from: "cleaner", name: "Ana", text: "STOP", handled: "stop" });
  });

  it("records an injury and still sends the host the direct injury text", async () => {
    const { desk, sms } = await confirmedCleaner();
    await desk.inbound({ id: "hurt", from: CLEANER, text: "I fell and I'm hurt" });
    expect(sms.sent.filter((item) => item.to === HOST).map((item) => item.body)).toContain(`The cleaner at ${ADDRESS} says someone is hurt. They've been told to call 911.`);
    expect(brief(await messagesNow(desk)).at(-1)).toEqual({ from: "cleaner", name: "Ana", text: "I fell and I'm hurt", handled: "injury" });
  });

  it("redacts the door code from a message, and holds a code-only text", async () => {
    const { desk, root } = await confirmedCleaner();
    await desk.inbound({ id: "code-only", from: CLEANER, text: DOOR_CODE });
    await desk.inbound({ id: "code-in", from: CLEANER, text: `Is the code ${DOOR_CODE}?` });
    const reply = ok(await desk.checkNow());
    const messages = brief((reply.messages as Message[] | undefined) ?? []).slice(-2);
    expect(messages[0]).toEqual({ from: "cleaner", name: "Ana", text: "[redacted]", handled: "code-held" });
    expect(messages[1]?.text).toBe("Is the code [redacted]?");
    expect(JSON.stringify(reply).includes(DOOR_CODE)).toBe(false);
    expect(readFileSync(join(root, "cleaner-live.json"), "utf8").includes(DOOR_CODE)).toBe(false);
  });

  it("keeps a message to 300 characters", async () => {
    const { desk } = await confirmedCleaner();
    await desk.inbound({ id: "long", from: CLEANER, text: `  ${"a".repeat(400)}  ` });
    expect((await messagesNow(desk)).at(-1)?.text).toBe("a".repeat(300));
  });

  it("records group messages from the cleaner and a saved contact", async () => {
    const { desk } = openDesk([HOST, CLEANER, OBSERVER], "1");
    await setUp(desk, { contacts: [{ name: "Sam", role: "co-host", phone: OBSERVER }], groupChat: "everyone", doorCodeTo: "cleaner" });
    await desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-sam", from: OBSERVER, text: "YES" });
    await desk.inbound({ id: "g-cleaner", from: CLEANER, text: "Running a little behind today", channel: "group" });
    await desk.inbound({ id: "g-sam", from: OBSERVER, text: "See you all tomorrow", channel: "group" });
    const messages = brief(await messagesNow(desk));
    expect(messages).toEqual(
      expect.arrayContaining([
        { from: "cleaner", name: "Ana", text: "Running a little behind today", handled: "none" },
        { from: "contact", name: "Sam", text: "See you all tomorrow", handled: "none" },
      ]),
    );
  });

  it("wakes the routine for each new message, with one pending wake", async () => {
    const posts: string[] = [];
    let status = 200;
    setCleanerAlertFetch(async (_url, init) => {
      posts.push(init.body);
      return { status };
    });
    const { desk, root } = await confirmedCleaner({ CLEANER_CORE_ROUTINE_URL: "https://routine.example/hook", CLEANER_CORE_ROUTINE_KEY: "k-test-routine-key" });
    ok(await desk.saveAlertRoutine({ url: "https://routine.example/hook", token: "k-test-routine-key" }, () => undefined));
    await desk.drainAlerts();
    const started = posts.length;
    await desk.inbound({ id: "m1", from: CLEANER, text: "On my way" });
    await desk.drainAlerts();
    expect(posts).toHaveLength(started + 1);
    await desk.inbound({ id: "m2", from: CLEANER, text: ARRIVAL_TEXT });
    await desk.drainAlerts();
    expect(posts).toHaveLength(started + 2);
    status = 503;
    await desk.inbound({ id: "m3", from: CLEANER, text: "Out of paper towels" });
    await desk.inbound({ id: "m4", from: CLEANER, text: "Never mind, found some" });
    expect(wakes(root).filter((record) => record.status === "pending")).toHaveLength(1);
  });

  it("does not repeat messages on a second check_now", async () => {
    const { desk } = await confirmedCleaner();
    await desk.inbound({ id: "arrival", from: CLEANER, text: ARRIVAL_TEXT });
    expect(await messagesNow(desk)).toHaveLength(3);
    expect(await messagesNow(desk)).toEqual([]);
    await desk.inbound({ id: "late", from: CLEANER, text: "Running late" });
    expect(brief(await messagesNow(desk))).toEqual([{ from: "cleaner", name: "Ana", text: "Running late", handled: "none" }]);
  });
});

describe("Cleaner Core messages: save_arrival", () => {
  it("saves a 24-hour arrival time on the open job and shows it in turns", async () => {
    const { desk } = await confirmedCleaner();
    expect((await desk.saveArrival({ time: "11:30 AM" })).ok).toBe(false);
    const saved = ok(await desk.saveArrival({ time: "11:30" }));
    const turns = (saved.turns as { arrivalTime?: string }[] | undefined) ?? [];
    expect(plain(turns[0]?.arrivalTime ?? "")).toBe("11:30 AM");
    const listed = (ok(await desk.getTurns()).turns as { arrivalTime?: string }[] | undefined) ?? [];
    expect(plain(listed[0]?.arrivalTime ?? "")).toBe("11:30 AM");
  });

  it("fails with no open cleaning", async () => {
    const { desk } = openDesk([HOST, CLEANER], "0");
    ok(await desk.getState("cleaners"));
    ok(await desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: ZONE }));
    ok(await desk.saveSources({ google: true }));
    ok(await desk.savePeople({ host: HOST, cleaner: CLEANER }));
    ok(await desk.saveDoorCode({ code: DOOR_CODE }, PIN_KEY));
    ok(await desk.savePreferences({}));
    await connectRoutine(desk);
    ok(await desk.activate({ googleEvents: googleList([]) }));
    expect(await desk.saveArrival({ time: "11:30" })).toEqual({ ok: false, error: "There's no open cleaning to save an arrival time for." });
  });

  it("lists save_arrival and tells Grok to read every message", async () => {
    const { desk } = await confirmedCleaner();
    const tools = ((await mcp(desk, "tools/list")).tools as { name: string; description: string }[]) ?? [];
    expect(tools.find((tool) => tool.name === "save_arrival")?.description).toBe("Saves the cleaner's arrival time after you read it in their message, as a 24-hour HH:MM time like 11:30.");
    const text = String((await mcp(desk, "initialize")).instructions);
    expect(text).toContain(
      "Read every message check_now returns. Tell the host in your own words when a message needs them: running late, a question, a problem, supplies, an arrival time, a decline, STOP, or an injury. Stay quiet on routine replies. If a message gives an arrival time, call save_arrival.",
    );
    const called = await mcp(desk, "tools/call", { name: "save_arrival", arguments: { time: "13:15" } });
    expect(called.isError).toBe(false);
  });
});

describe("Cleaner Core tools take Grok's structured answers", () => {
  const callTool = (desk: LiveDesk, name: string, args: Record<string, unknown>) => mcp(desk, "tools/call", { name, arguments: args });
  const textOf = (result: Record<string, unknown>) => ((result.content as { text: string }[] | undefined) ?? [])[0]?.text ?? "";

  it("refuses words and 12-hour times where a tool takes a choice or a 24-hour time", async () => {
    const { desk } = await confirmedCleaner();
    expect((await callTool(desk, "get_state", { choice: "2" })).isError).toBe(true);
    expect((await callTool(desk, "save_arrival", { time: "11:30 AM" })).isError).toBe(true);
    expect((await callTool(desk, "save_arrival", { time: "around noon" })).isError).toBe(true);
    expect((await callTool(desk, "confirm_times", { checkout: "10:30 AM", checkIn: "3:00 PM" })).isError).toBe(true);
    expect((await callTool(desk, "save_schedule", { reminderTime: "6 pm" })).isError).toBe(true);
    expect((await callTool(desk, "mark_guests_left", { said: "the guests have left" })).isError).toBe(true);
  });

  it("sends the door code only on the host's confirmed yes, whatever words the host used", async () => {
    const { desk, sms } = await confirmedCleaner();
    const refused = await callTool(desk, "mark_guests_left", { confirmed: false });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^Ask the host whether the guests have left/);
    expect(codeRecipients(sms.sent)).toEqual([]);
    const sent = await callTool(desk, "mark_guests_left", { confirmed: true });
    expect(sent.isError).toBe(false);
    expect(codeRecipients(sms.sent)).toEqual([CLEANER]);
  });

  it("retries only on the host's confirmed yes, and says so when nothing is waiting", async () => {
    const { desk } = await confirmedCleaner();
    const refused = await callTool(desk, "retry_send", { confirmed: false });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^Ask the host whether to send it again/);
    const nothing = await callTool(desk, "retry_send", { confirmed: true });
    expect(nothing.isError).toBe(false);
    expect(textOf(nothing)).toContain("Nothing is waiting to be sent again.");
  });
});

describe("Cleaner Core pauses only on the host's yes", () => {
  const callTool = (desk: LiveDesk, name: string, args: Record<string, unknown> = {}) => mcp(desk, "tools/call", { name, arguments: args });
  const structuredOf = (result: Record<string, unknown>) => (result.structuredContent ?? {}) as { next?: string; confirmation?: { code: string; question: string } };
  const heldNow = async (desk: LiveDesk) => Boolean(ok(await desk.getTurns()).held);

  it("does not pause on a cleaner's problem text, and pauses and resumes only with the host's approval code", async () => {
    const { desk, sms } = await confirmedCleaner();
    await desk.inbound({ id: "problem", from: CLEANER, text: "The lock is broken, I can't get in" });
    await desk.inbound({ id: "no-problem", from: CLEANER, text: "No problem, see you then" });
    expect(await heldNow(desk)).toBe(false);

    const asked = await callTool(desk, "hold_job");
    expect(asked.isError).toBe(false);
    const question = structuredOf(asked);
    expect(question.next).toMatch(/^Pause the cleaning at .+\? .+ Reply yes to pause\.$/);
    expect(question.confirmation?.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(await heldNow(desk)).toBe(false);
    expect((await callTool(desk, "hold_job", { confirmation: "WRONG1" })).isError).toBe(true);
    expect(await heldNow(desk)).toBe(false);

    const before = sms.sent.length;
    const paused = await callTool(desk, "hold_job", { confirmation: question.confirmation?.code });
    expect(paused.isError).toBe(false);
    expect(await heldNow(desk)).toBe(true);
    expect(sms.sent.slice(before).map((text) => text.to)).toEqual([CLEANER]);
    expect(structuredOf(await callTool(desk, "hold_job")).next).toMatch(/already on hold/);
    expect(codeRecipients(sms.sent)).toEqual([]);
    expect(ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY)).next).toMatch(/on hold/);
    expect(codeRecipients(sms.sent)).toEqual([]);

    const resumeAsked = structuredOf(await callTool(desk, "resume_job"));
    expect(resumeAsked.next).toMatch(/^Resume the cleaning at .+ Reply yes to resume\.$/);
    expect(await heldNow(desk)).toBe(true);
    expect((await callTool(desk, "resume_job", { confirmation: question.confirmation?.code })).isError).toBe(true);
    expect((await callTool(desk, "resume_job", { confirmation: resumeAsked.confirmation?.code })).isError).toBe(false);
    expect(await heldNow(desk)).toBe(false);
    expect(ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY)).next).toBe("I sent the door code to the cleaner. I'll tell you if it doesn't go through.");
    expect(codeRecipients(sms.sent)).toEqual([CLEANER]);
  });

  it("tells Grok to ask the host before it pauses or resumes", async () => {
    const tools = ((await mcp(openDesk([HOST, CLEANER], "0").desk, "tools/list")).tools as { name: string; description: string }[]) ?? [];
    expect(tools.find((tool) => tool.name === "hold_job")?.description).toMatch(/Never pause on your own/);
    expect(tools.find((tool) => tool.name === "resume_job")?.description).toMatch(/only after the host says yes/);
    const text = String((await mcp(openDesk([HOST, CLEANER], "0").desk, "initialize")).instructions);
    expect(text).toContain("Cleaner Core never pauses a cleaning because of how a message sounds.");
  });
});

const LATE = "Guests are running late today. Please start at 12:30 PM instead.";
const APPROVAL_STALE = "That approval has expired or doesn't match. Ask the host again.";

interface Approval {
  code: string;
  question: string;
  expiresInMinutes: number;
}

async function preview(desk: LiveDesk, to: string, text: string): Promise<Approval> {
  const reply = ok(await desk.sendMessage({ to, text }));
  return reply.confirmation as Approval;
}

function hostOutbox(desk: LiveDesk) {
  const engine = (desk as unknown as { engine: CleanerCore }).engine;
  return engine.outbox().filter((item) => item.kind === "host-message");
}

/** Group chat everyone with the host, the cleaner, and Sam in the group. */
async function groupEveryone() {
  const opened = openDesk([HOST, CLEANER, OBSERVER], "1");
  await setUp(opened.desk, { contacts: [{ name: "Sam", role: "co-host", phone: OBSERVER }], groupChat: "everyone", doorCodeTo: "cleaner" });
  await opened.desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
  await opened.desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
  await opened.desk.inbound({ id: "yes-sam", from: OBSERVER, text: "YES" });
  return opened;
}

describe("Cleaner Core send_message: the host approves first", () => {
  it("a preview returns a code and the exact question, and sends nothing", async () => {
    const { desk, sms } = await confirmedCleaner();
    const before = sms.sent.length;
    const reply = ok(await desk.sendMessage({ to: "cleaner", text: LATE }));
    expect(reply.preview).toEqual({ to: "Ana", text: LATE });
    const approval = reply.confirmation as Approval;
    expect(approval.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(approval.question).toBe(`Send to Ana: "${LATE}"?`);
    expect(approval.expiresInMinutes).toBe(10);
    expect(sms.sent).toHaveLength(before);
    expect(hostOutbox(desk)).toEqual([]);
  });

  it("redeeming with the same to and text sends exactly one text to the cleaner, and records it", async () => {
    const { desk, sms, root } = await confirmedCleaner();
    const approval = await preview(desk, "cleaner", LATE);
    await messagesNow(desk);
    const before = sms.sent.length;
    expect(ok(await desk.sendMessage({ to: "cleaner", text: LATE, confirmation: approval.code }))).toEqual({ next: "Sent to Ana." });
    expect(sms.sent.slice(before)).toEqual([expect.objectContaining({ to: CLEANER, body: LATE })]);
    expect(hostOutbox(desk)).toEqual([expect.objectContaining({ to: CLEANER, body: LATE, kind: "host-message", status: "sent" })]);
    const file = JSON.parse(readFileSync(join(root, "cleaner-live.json"), "utf8")) as { messages: Message[] };
    expect(file.messages.at(-1)).toEqual(expect.objectContaining({ from: "host", name: "Host", to: "Ana", text: LATE, handled: "sent" }));
    // Grok sent it, so check_now doesn't hand it back as new.
    expect(await messagesNow(desk)).toEqual([]);
  });

  it("refuses the same code with a changed text or recipient, and sends nothing", async () => {
    const { desk, sms, groups } = await groupEveryone();
    const sentBefore = sms.sent.length;
    const postsBefore = groups.posts.length;
    const changedText = await preview(desk, "group", LATE);
    expect(await desk.sendMessage({ to: "group", text: `${LATE} Thanks!`, confirmation: changedText.code })).toEqual({ ok: false, error: APPROVAL_STALE });
    // With the group on, a changed recipient is refused as not the group, and the code stays good for the group.
    expect(await desk.sendMessage({ to: "Sam", text: LATE, confirmation: changedText.code })).toEqual({ ok: false, error: GROUP_ONLY });
    // A refused code is used up, so the original text can't go with it either.
    expect(await desk.sendMessage({ to: "group", text: LATE, confirmation: changedText.code })).toEqual({ ok: false, error: APPROVAL_STALE });
    expect(sms.sent).toHaveLength(sentBefore);
    expect(groups.posts).toHaveLength(postsBefore);
    expect(hostOutbox(desk)).toEqual([]);
  });

  it("refuses a reused code", async () => {
    const { desk, sms } = await confirmedCleaner();
    const approval = await preview(desk, "cleaner", LATE);
    ok(await desk.sendMessage({ to: "cleaner", text: LATE, confirmation: approval.code }));
    const after = sms.sent.length;
    expect(await desk.sendMessage({ to: "cleaner", text: LATE, confirmation: approval.code })).toEqual({ ok: false, error: APPROVAL_STALE });
    expect(sms.sent).toHaveLength(after);
    expect(hostOutbox(desk)).toHaveLength(1);
  });

  it("refuses an expired code", async () => {
    let clock = new Date(FROZEN);
    const { desk } = openDesk([HOST, CLEANER], "0", () => clock);
    await setUp(desk, { groupChat: "cleaner-only" });
    await desk.inbound({ id: "yes-opt-in", from: CLEANER, text: "YES" });
    const approval = await preview(desk, "cleaner", LATE);
    clock = new Date(clock.getTime() + 11 * 60_000);
    expect(await desk.sendMessage({ to: "cleaner", text: LATE, confirmation: approval.code })).toEqual({ ok: false, error: APPROVAL_STALE });
    expect(hostOutbox(desk)).toEqual([]);
  });

  it("refuses a text holding the door code at preview, also after a restart with the code sealed", async () => {
    const { desk, root } = await confirmedCleaner();
    expect(await desk.sendMessage({ to: "cleaner", text: `The code is ${DOOR_CODE}` })).toEqual({ ok: false, error: DOOR_CODE_IN_CHAT });
    resetLiveDesks();
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_SMS_ALLOWLIST: [HOST, CLEANER].join(","),
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    };
    const restarted = liveDeskFor(root, () => env, () => new Date(FROZEN));
    expect(await restarted.sendMessage({ to: "cleaner", text: `Use ${DOOR_CODE} at the back` })).toEqual({ ok: false, error: DOOR_CODE_IN_CHAT });
    expect(await restarted.sendMessage({ to: "cleaner", text: `Use ${DOOR_CODE} at the back` }, PIN_KEY)).toEqual({ ok: false, error: DOOR_CODE_IN_CHAT });
    const res = await handleCleanerMcpMessage(
      restarted,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { to: "cleaner", text: `Use ${DOOR_CODE} at the back` } } },
      PIN_KEY,
    );
    const body = res.body as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toBe(DOOR_CODE_IN_CHAT);
  });

  it("refuses a door code split by spaces, dashes, or dots, with the code known and with it sealed", async () => {
    const split = (code: string) => [
      `Code ${code.split("").join(" ")}`,
      `Use ${code.slice(0, 2)}-${code.slice(2)} at the back`,
      `It's ${code.split("").join(".")} today`,
    ];
    const { desk, root, sms } = await confirmedCleaner();
    const before = sms.sent.length;
    for (const text of split(DOOR_CODE)) {
      expect(await desk.sendMessage({ to: "cleaner", text }), text).toEqual({ ok: false, error: DOOR_CODE_IN_CHAT });
    }
    // The engine's host-message path refuses it too, even if a caller skipped the desk.
    const engine = (desk as unknown as { engine: CleanerCore }).engine;
    for (const body of split(DOOR_CODE)) await expect(engine.sendHostMessage({ to: CLEANER, body })).rejects.toThrow();
    expect(sms.sent).toHaveLength(before);
    expect(hostOutbox(desk)).toEqual([]);
    resetLiveDesks();
    const env: NodeJS.ProcessEnv = {
      CLEANER_CORE_ENABLED: "1",
      CLEANER_CORE_LIVE_SMS: "1",
      CLEANER_CORE_SMS_ALLOWLIST: [HOST, CLEANER].join(","),
      CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
      CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
      CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
    };
    const restarted = liveDeskFor(root, () => env, () => new Date(FROZEN));
    for (const text of split(DOOR_CODE)) {
      expect(await restarted.sendMessage({ to: "cleaner", text }), `sealed: ${text}`).toEqual({ ok: false, error: DOOR_CODE_IN_CHAT });
      expect(await restarted.sendMessage({ to: "cleaner", text }, PIN_KEY), `opened: ${text}`).toEqual({ ok: false, error: DOOR_CODE_IN_CHAT });
    }
    expect(sms.sent).toHaveLength(before);
  });

  it("voids a group approval when someone joins or leaves the group before the yes", async () => {
    const { desk, groups } = openDesk([HOST, CLEANER, OBSERVER], "1");
    await setUp(desk, { contacts: [{ name: "Sam", role: "co-host", phone: OBSERVER }], groupChat: "everyone", doorCodeTo: "cleaner" });
    await desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
    const beforeJoin = await preview(desk, "group", LATE);
    await desk.inbound({ id: "yes-sam", from: OBSERVER, text: "YES" });
    expect(await desk.sendMessage({ to: "group", text: LATE, confirmation: beforeJoin.code })).toEqual({ ok: false, error: APPROVAL_STALE });
    const beforeLeave = await preview(desk, "group", LATE);
    await desk.inbound({ id: "stop-sam", from: OBSERVER, text: "STOP" });
    expect(await desk.sendMessage({ to: "group", text: LATE, confirmation: beforeLeave.code })).toEqual({ ok: false, error: APPROVAL_STALE });
    expect(groups.posts.filter((post) => post.body === LATE)).toEqual([]);
    expect(hostOutbox(desk)).toEqual([]);
    // Asked again with the group as it is now, it goes to the people still in it.
    const now = await preview(desk, "group", LATE);
    ok(await desk.sendMessage({ to: "group", text: LATE, confirmation: now.code }));
    expect(groups.posts.filter((post) => post.body === LATE)).toEqual([{ to: [HOST, CLEANER].sort(), body: LATE }]);
  });

  it("refuses an empty or too long text, and an unknown recipient", async () => {
    const { desk } = await confirmedCleaner();
    expect((await desk.sendMessage({ to: "cleaner", text: "  " })).ok).toBe(false);
    expect((await desk.sendMessage({ to: "cleaner", text: "a".repeat(601) })).ok).toBe(false);
    expect((await desk.sendMessage({ to: "cleaner", text: "a".repeat(600) })).ok).toBe(true);
    expect(await desk.sendMessage({ to: "Jordan", text: LATE })).toEqual({ ok: false, error: "I can't text Jordan right now." });
  });

  it("refuses group with group chat off or set to cleaner-only", async () => {
    const off = openDesk([HOST, CLEANER], "0");
    await setUp(off.desk, {});
    expect(await off.desk.sendMessage({ to: "group", text: LATE })).toEqual({ ok: false, error: "There's no group chat for this property." });
    const only = openDesk([HOST, CLEANER], "1");
    await setUp(only.desk, { groupChat: "cleaner-only" });
    expect(await only.desk.sendMessage({ to: "group", text: LATE })).toEqual({ ok: false, error: "There's no group chat for this property." });
  });

  it("refuses an opted-out cleaner, even with a code issued before the STOP", async () => {
    const { desk, sms } = await confirmedCleaner();
    const approval = await preview(desk, "cleaner", LATE);
    await desk.inbound({ id: "stop", from: CLEANER, text: "STOP" });
    const before = sms.sent.length;
    expect(await desk.sendMessage({ to: "cleaner", text: LATE })).toEqual({ ok: false, error: "I can't text Ana right now." });
    expect(await desk.sendMessage({ to: "cleaner", text: LATE, confirmation: approval.code })).toEqual({ ok: false, error: "I can't text Ana right now." });
    expect(sms.sent).toHaveLength(before);
    expect(hostOutbox(desk)).toEqual([]);
  });

  it("refuses a cleaner who hasn't opted in yet", async () => {
    const { desk } = openDesk([HOST, CLEANER], "0");
    await setUp(desk, { groupChat: "cleaner-only" });
    expect(await desk.sendMessage({ to: "cleaner", text: LATE })).toEqual({ ok: false, error: "I can't text Ana right now." });
  });

  it("refuses the 11th message in an hour, and allows one after the hour", async () => {
    let clock = new Date(FROZEN);
    const { desk, sms } = openDesk([HOST, CLEANER], "0", () => clock);
    await setUp(desk, { groupChat: "cleaner-only" });
    await desk.inbound({ id: "yes-opt-in", from: CLEANER, text: "YES" });
    for (let count = 1; count <= 10; count++) {
      const text = `Note number ${count}`;
      const approval = await preview(desk, "cleaner", text);
      ok(await desk.sendMessage({ to: "cleaner", text, confirmation: approval.code }));
      clock = new Date(clock.getTime() + 60_000);
    }
    const tooMany = "That's a lot of messages this hour. Try again later.";
    expect(await desk.sendMessage({ to: "cleaner", text: "Note number 11" })).toEqual({ ok: false, error: tooMany });
    expect(hostOutbox(desk)).toHaveLength(10);
    const before = sms.sent.length;
    clock = new Date(new Date(FROZEN).getTime() + 61 * 60_000);
    const approval = await preview(desk, "cleaner", "Note number 11");
    ok(await desk.sendMessage({ to: "cleaner", text: "Note number 11", confirmation: approval.code }));
    expect(sms.sent).toHaveLength(before + 1);
  });

  it("sends a host message that says ready, and the job's status doesn't change", async () => {
    const { desk, sms } = await confirmedCleaner();
    const statuses = async () => (ok(await desk.getTurns()).turns as { status: string }[]).map((turn) => turn.status);
    const before = await statuses();
    const text = "The unit is ready for you whenever you arrive.";
    const approval = await preview(desk, "Ana", text);
    ok(await desk.sendMessage({ to: "cleaner", text, confirmation: approval.code }));
    expect(sms.sent.at(-1)).toEqual(expect.objectContaining({ to: CLEANER, body: text }));
    expect(await statuses()).toEqual(before);
  });

  it("is not held by quiet hours", async () => {
    let clock = new Date(FROZEN);
    const { desk, sms } = openDesk([HOST, CLEANER], "0", () => clock);
    await setUp(desk, { groupChat: "cleaner-only" });
    ok(await desk.saveSchedule({ quietFrom: "21:00", quietUntil: "08:00" }));
    await desk.inbound({ id: "yes-opt-in", from: CLEANER, text: "YES" });
    // 10:00 PM in New York.
    clock = new Date("2026-10-15T02:00:00.000Z");
    const approval = await preview(desk, "cleaner", LATE);
    const before = sms.sent.length;
    ok(await desk.sendMessage({ to: "cleaner", text: LATE, confirmation: approval.code }));
    expect(sms.sent.slice(before)).toEqual([expect.objectContaining({ to: CLEANER, body: LATE })]);
  });

  it("sends to the group thread and to a saved contact who opted in", async () => {
    const { desk, sms, groups } = await groupEveryone();
    const group = await preview(desk, "group", LATE);
    expect(group.question).toBe(`Send to the group: "${LATE}"?`);
    expect(ok(await desk.sendMessage({ to: "group", text: LATE, confirmation: group.code }))).toEqual({ next: "Sent to the group." });
    expect(groups.posts.filter((post) => post.body === LATE)).toEqual([{ to: [HOST, CLEANER, OBSERVER].sort(), body: LATE }]);
    // With the group on, a message for a saved contact is refused. Nothing goes to Sam one-to-one.
    const note = "Sam, the spare towels are in the hall closet.";
    expect(await desk.sendMessage({ to: "sam", text: note })).toEqual({ ok: false, error: GROUP_ONLY });
    expect(sms.sent.filter((item) => item.body === note)).toEqual([]);
    expect(groups.posts.filter((post) => post.body === note)).toEqual([]);
    expect(hostOutbox(desk).map((item) => item.kind)).toEqual(["host-message"]);
  });

  it("sends only to Scratch numbers on the allowlist, and refuses a contact who isn't on it", async () => {
    const { desk, sms, groups } = openDesk([HOST, CLEANER, OBSERVER], "1");
    await setUp(desk, {
      contacts: [
        { name: "Sam", role: "co-host", phone: OBSERVER },
        { name: "Lee", role: "assistant", phone: OFF_LIST },
      ],
      groupChat: "cleaner-and-host",
    });
    await desk.inbound({ id: "yes-host", from: HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-lee", from: OFF_LIST, text: "YES" });
    expect(await desk.sendMessage({ to: "Lee", text: LATE })).toEqual({ ok: false, error: GROUP_ONLY });
    expect(await desk.sendMessage({ to: "cleaner", text: LATE })).toEqual({ ok: false, error: GROUP_ONLY });
    const approval = await preview(desk, "group", LATE);
    ok(await desk.sendMessage({ to: "group", text: LATE, confirmation: approval.code }));
    const recipients = [...sms.sent.map((item) => item.to), ...groups.posts.flatMap((post) => post.to)];
    expect(recipients.length).toBeGreaterThan(0);
    expect(recipients.every((phone) => isScratchTestNumber(phone))).toBe(true);
    expect(recipients).not.toContain(OFF_LIST);
    expect(hostOutbox(desk).every((item) => isScratchTestNumber(item.to))).toBe(true);
  });

  it("lists send_message and tells Grok to draft replies for the host to approve", async () => {
    const { desk, sms } = await confirmedCleaner();
    const tools = ((await mcp(desk, "tools/list")).tools as { name: string; description: string }[]) ?? [];
    expect(tools.find((tool) => tool.name === "send_message")?.description).toBe(
      "Sends the host's own message. With a group, messages go only to the group (to: group). Without one, to is the cleaner or a saved contact. Call once without confirmation to get a preview and code, show the host the exact text, and call again with the code only after the host says yes. To send a saved draft, pass draft with its id instead of to and text.",
    );
    const text = String((await mcp(desk, "initialize")).instructions);
    for (const line of REPLY_INSTRUCTIONS) expect(text).toContain(line);
    const first = await mcp(desk, "tools/call", { name: "send_message", arguments: { to: "cleaner", text: LATE } });
    expect(first.isError).toBe(false);
    const code = (first.structuredContent as { confirmation: Approval }).confirmation.code;
    const before = sms.sent.length;
    const second = await mcp(desk, "tools/call", { name: "send_message", arguments: { to: "cleaner", text: LATE, confirmation: code } });
    expect(second.isError).toBe(false);
    expect(second.structuredContent).toEqual({ next: "Sent to Ana." });
    expect(sms.sent).toHaveLength(before + 1);
  });
});

/** Made-up bytes that start and end like a JPEG. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("made-up photo for a test"), Buffer.from([0xff, 0xd9])]);
const PHOTO_BASE = "https://cleaner.example";
const CHECKLIST_TEXT = "Checklist for Lake House: Strip the beds; Restock coffee. Send photos, then reply DONE when finished.";
const PHOTO_FIRST = "Please send a photo of the finished rooms, then reply DONE.";
const OFFER = `Turnover at ${ADDRESS} on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.`;
const PHOTOS_TOOL = "Gets expiring links to the cleaner's photos for a job. Look at them, compare with the checklist, and show them to the host.";
const PHOTOS_INSTRUCTION =
  "When check_now returns completed, call get_job_photos, look at the photos, and give the host a short summary in your own words: arrival, start and done times, checklist, what the photos show, and any notes.";

let mediaCount = 0;

/** A fake Twilio media download. It never leaves the machine. */
function stubPhotos(): string[] {
  const calls: string[] = [];
  setCleanerPhotoFetch(async (url) => {
    calls.push(url);
    return new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
  });
  return calls;
}

function photo(): { url: string; contentType: string } {
  mediaCount += 1;
  return { url: `https://api.twilio.com/2010-04-01/Accounts/ACfake/Messages/MMfull${mediaCount}/Media/MEfull${mediaCount}`, contentType: "image/jpeg" };
}

type PreferencesInput = Parameters<LiveDesk["savePreferences"]>[0];

/**
 * Cleaner-only Lake House with these preferences, the cleaner opted in, and the offer taken. The
 * clock starts Wed Oct 14 at 11:00 AM. The cleaning's checkout day is Sun Oct 18.
 */
async function takenWith(preferences: PreferencesInput, extraEnv: NodeJS.ProcessEnv = { PUBLIC_BASE_URL: PHOTO_BASE, CLEANER_CORE_PHOTO_KEY: "made-up-photo-key-for-tests-abcd" }) {
  const time = testClock(FROZEN);
  const opened = openDesk([HOST, CLEANER], "0", time.now, extraEnv);
  const { desk } = opened;
  ok(await desk.getState("cleaners"));
  ok(await desk.saveProperty({ business: BUSINESS, nickname: "Lake House", address: ADDRESS, timeZone: ZONE, checkoutTime: "11:00", checkInTime: "16:00" }));
  ok(await desk.saveSources({ calendars: [{ name: "Airbnb", url: CALENDAR_URL }] }));
  ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" }));
  ok(await desk.saveDoorCode({ code: DOOR_CODE, lockLocation: LOCK }, PIN_KEY));
  ok(await desk.savePreferences(preferences));
  await connectRoutine(desk);
  ok(await desk.activate());
  ok(await desk.confirmTimes({ checkout: "11:00", checkIn: "16:00" }));
  await desk.inbound({ id: "yes-opt-in", from: CLEANER, text: "YES" });
  await desk.inbound({ id: "yes-offer", from: CLEANER, text: "YES" });
  return { ...opened, time };
}

function toCleanerBodies(sent: SentSms[]): string[] {
  return sent.filter((item) => item.to === CLEANER).map((item) => item.body);
}

async function statuses(desk: LiveDesk): Promise<string[]> {
  return (ok(await desk.getTurns()).turns as { status: string }[]).map((turn) => turn.status);
}

describe("Cleaner Core cleaning: the checklist", () => {
  it("sends the saved checklist right after the private code, once", async () => {
    const { desk, sms } = await takenWith({ checklist: ["Strip the beds", "Restock coffee."] });
    expect(toCleanerBodies(sms.sent)).not.toContain(CHECKLIST_TEXT);
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    const bodies = toCleanerBodies(sms.sent);
    expect(bodies.slice(-2)).toEqual([PRIVATE_PIN, CHECKLIST_TEXT]);
    await desk.markGuestsLeft({ confirmed: true }, PIN_KEY);
    ok(await desk.checkNow());
    await desk.inbound({ id: "start", from: CLEANER, text: "START" });
    expect(toCleanerBodies(sms.sent).filter((body) => body === CHECKLIST_TEXT)).toHaveLength(1);
    expect(CHECKLIST_TEXT.includes(DOOR_CODE)).toBe(false);
  });

  it("sends no checklist when none is saved", async () => {
    const { desk, sms } = await takenWith({});
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    expect(toCleanerBodies(sms.sent).at(-1)).toBe(PRIVATE_PIN);
    expect(toCleanerBodies(sms.sent).some((body) => body.startsWith("Checklist for"))).toBe(false);
  });

  it("sends a checklist that says ready, and the code still goes", async () => {
    const { desk, sms } = await takenWith({ checklist: ["Get the guest room ready"] });
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    expect(toCleanerBodies(sms.sent).slice(-2)).toEqual([PRIVATE_PIN, "Checklist for Lake House: Get the guest room ready. Send photos, then reply DONE when finished."]);
  });
});

describe("Cleaner Core cleaning: photos and notes", () => {
  it("a photo-only MMS gets no guide reply and reaches Grok as [photo]", async () => {
    stubPhotos();
    const { desk, sms } = await takenWith({ checklist: ["Strip the beds"] });
    const waiting = sms.sent.length;
    await desk.inbound({ id: "mms-waiting", from: CLEANER, text: "", media: [photo()] });
    expect(sms.sent).toHaveLength(waiting);
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    const before = sms.sent.length;
    await desk.inbound({ id: "mms-1", from: CLEANER, text: "", media: [photo()] });
    await desk.inbound({ id: "mms-2", from: CLEANER, text: "Kitchen", media: [photo()] });
    expect(sms.sent).toHaveLength(before);
    expect(brief(await messagesNow(desk)).slice(-3)).toEqual([
      { from: "cleaner", name: "Ana", text: "[photo]", handled: "none" },
      { from: "cleaner", name: "Ana", text: "[photo]", handled: "none" },
      { from: "cleaner", name: "Ana", text: "Kitchen [photo]", handled: "none" },
    ]);
  });

  it("DONE waits for a photo when photos are required", async () => {
    stubPhotos();
    const { desk, sms } = await takenWith({ photosRequired: true });
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    await desk.inbound({ id: "done-early", from: CLEANER, text: "DONE" });
    expect(toCleanerBodies(sms.sent).at(-1)).toBe(PHOTO_FIRST);
    expect(await statuses(desk)).not.toContain("done");
    expect(brief(await messagesNow(desk)).at(-1)).toEqual({ from: "cleaner", name: "Ana", text: "DONE", handled: "none" });
    await desk.inbound({ id: "mms", from: CLEANER, text: "", media: [photo()] });
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    expect(toCleanerBodies(sms.sent).at(-1)).toBe("Thanks, cleaning marked done.");
    expect((await statuses(desk))[0]).toBe("done");
  });

  it("DONE goes through without a photo when photos aren't required", async () => {
    const { desk, sms } = await takenWith({ photosRequired: false });
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    expect(toCleanerBodies(sms.sent).at(-1)).toBe("Thanks, cleaning marked done.");
  });

  it("keeps at most 5 notes of 200 characters, and none with supply notes off", async () => {
    const on = await takenWith({ supplyNotes: true });
    ok(await on.desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    for (let index = 1; index <= 6; index++) await on.desk.inbound({ id: `note-${index}`, from: CLEANER, text: `Note ${index} ${"x".repeat(250)}` });
    await on.desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    const completed = (ok(await on.desk.checkNow()).completed as { notes: string[] }[])[0];
    expect(completed?.notes).toHaveLength(5);
    expect(completed?.notes[0]?.startsWith("Note 2 ")).toBe(true);
    expect(completed?.notes.every((note) => note.length === 200)).toBe(true);

    resetLiveDesks();
    const off = await takenWith({ supplyNotes: false });
    ok(await off.desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    await off.desk.inbound({ id: "note", from: CLEANER, text: "Need more paper towels" });
    await off.desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    expect((ok(await off.desk.checkNow()).completed as { notes: string[] }[])[0]?.notes).toEqual([]);
  });
});

describe("Cleaner Core cleaning: the completed record", () => {
  it("check_now returns the finished cleaning once, with exact counts and times, and no door code", async () => {
    stubPhotos();
    const { desk, time, root } = await takenWith(PREFERENCES);
    ok(await desk.saveArrival({ time: "11:30" }));
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    time.set("2026-10-14T15:32:00.000Z");
    await desk.inbound({ id: "start", from: CLEANER, text: "START" });
    time.set("2026-10-14T16:00:00.000Z");
    await desk.inbound({ id: "towels", from: CLEANER, text: "Need more paper towels" });
    await desk.inbound({ id: "code", from: CLEANER, text: `The lockbox code ${DOOR_CODE} stuck` });
    await desk.inbound({ id: "spaced", from: CLEANER, text: "Is it 8 0 8 8 again?" });
    await desk.inbound({ id: "mms-1", from: CLEANER, text: "", media: [photo(), photo()] });
    await desk.inbound({ id: "mms-2", from: CLEANER, text: "", media: [photo()] });
    time.set("2026-10-14T18:10:00.000Z");
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    time.set("2026-10-14T18:11:00.000Z");
    await desk.inbound({ id: "checklist-yes", from: CLEANER, text: "YES" });

    const reply = ok(await desk.checkNow());
    expect(JSON.parse(plain(JSON.stringify(reply.completed)))).toEqual([
      {
        nickname: "Lake House",
        day: "Sunday, Oct 18",
        arrivalTime: "11:30 AM",
        startedAt: "Wednesday, Oct 14, 11:32 AM",
        doneAt: "Wednesday, Oct 14, 2:11 PM",
        checklistConfirmed: "Wednesday, Oct 14, 2:11 PM",
        checklist: ["Strip the beds", "Restock coffee"],
        photos: 3,
        notes: ["Need more paper towels", "The lockbox code [redacted] stuck", "Is it [redacted] again?"],
      },
    ]);
    expect(JSON.stringify(reply).includes(DOOR_CODE)).toBe(false);
    expect(readFileSync(join(root, "cleaner-live.json"), "utf8").includes(DOOR_CODE)).toBe(false);
    expect(readFileSync(join(root, "cleaner-job", "cleaner-core.json"), "utf8").includes(DOOR_CODE)).toBe(false);
    expect(ok(await desk.checkNow()).completed).toBeUndefined();
  });

  it("sets the start time from the first message during the cleaning when START never came", async () => {
    const { desk, time } = await takenWith({});
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    time.set("2026-10-14T15:45:00.000Z");
    await desk.inbound({ id: "here", from: CLEANER, text: "Here now" });
    time.set("2026-10-14T16:45:00.000Z");
    await desk.inbound({ id: "later", from: CLEANER, text: "Halfway" });
    time.set("2026-10-14T17:00:00.000Z");
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    const completed = (ok(await desk.checkNow()).completed as Record<string, unknown>[])[0] ?? {};
    expect(plain(String(completed.startedAt))).toBe("Wednesday, Oct 14, 11:45 AM");
    expect(plain(String(completed.doneAt))).toBe("Wednesday, Oct 14, 1:00 PM");
    expect(completed.arrivalTime).toBeNull();
    expect(completed.photos).toBe(0);
    expect(completed.checklist).toEqual([]);
  });
});

describe("Cleaner Core cleaning: get_job_photos", () => {
  it("returns working links, and makes its key once when none is set", async () => {
    stubPhotos();
    const { desk, env, root, time } = await takenWith({}, { PUBLIC_BASE_URL: PHOTO_BASE });
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    await desk.inbound({ id: "mms", from: CLEANER, text: "", media: [photo(), photo()] });
    const saves: string[] = [];
    const save = (values: Record<string, string | undefined>) => {
      saves.push(Object.keys(values).join(","));
      Object.assign(env, values);
    };
    const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_job_photos", arguments: {} } };
    const first = ((await handleCleanerMcpMessage(desk, request, PIN_KEY, false, save)).body as { result: { structuredContent: { photos: { url: string; expiresAt: string }[] } } }).result;
    const photos = first.structuredContent.photos;
    expect(photos).toHaveLength(2);
    expect(saves).toEqual(["CLEANER_CORE_PHOTO_KEY"]);
    const key = photoKey(env);
    expect(key).toBeDefined();
    for (const link of photos) {
      expect(link.url).toMatch(/^https:\/\/cleaner\.example\/cleaner-core\/photos\/[a-p]+$/);
      const token = link.url.slice(`${PHOTO_BASE}/cleaner-core/photos/`.length);
      const served = servePhoto(root, token, key, time.now());
      expect(served.status).toBe(200);
      expect(served.status === 200 && served.body.equals(JPEG)).toBe(true);
    }
    await handleCleanerMcpMessage(desk, request, PIN_KEY, false, save);
    expect(saves).toEqual(["CLEANER_CORE_PHOTO_KEY"]);
    const byDay = ok(await desk.getJobPhotos({ job: "2026-10-18" }));
    expect((byDay.photos as unknown[]).length).toBe(2);
    expect((await desk.getJobPhotos({ job: "2026-12-25" })).ok).toBe(false);
  });

  it("lists get_job_photos and tells Grok to summarize a completed cleaning", async () => {
    const { desk } = await takenWith({});
    const tools = ((await mcp(desk, "tools/list")).tools as { name: string; description: string }[]) ?? [];
    expect(tools.find((tool) => tool.name === "get_job_photos")?.description).toBe(PHOTOS_TOOL);
    expect(String((await mcp(desk, "initialize")).instructions)).toContain(PHOTOS_INSTRUCTION);
  });
});

describe("Cleaner Core cleaning: the host's other instructions", () => {
  it("keeps the offer without the note and puts the saved instructions at the end of the door code text", async () => {
    const { desk, sms } = await takenWith({ instructions: "Leave the porch light on." });
    expect(offers(sms.sent).map((item) => plain(item.body))).toEqual([OFFER]);
    expect(sms.sent.some((item) => item.body.includes("Note from the host"))).toBe(false);
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    expect(sms.sent.filter((item) => item.body.includes(DOOR_CODE)).map((item) => item.body)).toEqual([`${PRIVATE_PIN} Note from the host: Leave the porch light on.`]);
  });

  it("keeps the offer and the door code copy without saved instructions", async () => {
    const { desk, sms } = await takenWith({});
    expect(offers(sms.sent).map((item) => plain(item.body))).toEqual([OFFER]);
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    expect(sms.sent.filter((item) => item.body.includes(DOOR_CODE)).map((item) => item.body)).toEqual([PRIVATE_PIN]);
  });

  it("copies for others still drop only the YES ask and keep a note", () => {
    const body = `${OFFER} Note from the host: Get the guest room ready.`;
    expect(offerForOthers(body)).toBe(
      `Turnover at ${ADDRESS} on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. The cleaner will reply to confirm. Note from the host: Get the guest room ready.`,
    );
  });
});

describe("Cleaner Core cleaning: a photo download can't crash or trap the cleaner", () => {
  it("takes, counts, and records an MMS whose download is still open while the host saves preferences", async () => {
    let started = (): void => undefined;
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    setCleanerPhotoFetch(async () => {
      started();
      await held;
      return new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
    });
    const { desk, sms } = await takenWith({ photosRequired: true });
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    const pending = desk.inbound({ id: "mms-held", from: CLEANER, text: "", media: [photo()] });
    await fetching;
    // The save waits its turn behind the text, so it can't drop the engine the text is using.
    const saved = desk.savePreferences({ photosRequired: true, supplyNotes: true });
    finish();
    await expect(pending).resolves.toEqual({ sent: [] });
    ok(await saved);
    expect(brief(await messagesNow(desk)).at(-1)).toEqual({ from: "cleaner", name: "Ana", text: "[photo]", handled: "none" });
    // The same text again is a duplicate: the id was seen.
    await desk.inbound({ id: "mms-held", from: CLEANER, text: "", media: [photo()] });
    expect(await messagesNow(desk)).toEqual([]);
    // The photo counted, so DONE goes through, and the new preferences apply.
    await desk.inbound({ id: "note", from: CLEANER, text: "Out of trash bags" });
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    expect(toCleanerBodies(sms.sent).at(-1)).toBe("Thanks, cleaning marked done.");
    const completed = (ok(await desk.checkNow()).completed as Record<string, unknown>[])[0] ?? {};
    expect(completed.photos).toBe(1);
    expect(completed.photosMissing).toBeUndefined();
    expect(completed.notes).toEqual(["Out of trash bags"]);
  });

  it("a photo whose download failed still satisfies the photo rule, and completed reports it missing", async () => {
    setCleanerPhotoFetch(async () => new Response("nope", { status: 500 }));
    const { desk, sms } = await takenWith({ photosRequired: true });
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    await desk.inbound({ id: "mms-failed", from: CLEANER, text: "", media: [photo(), photo()] });
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    expect(toCleanerBodies(sms.sent).at(-1)).toBe("Thanks, cleaning marked done.");
    expect((await statuses(desk))[0]).toBe("done");
    const completed = (ok(await desk.checkNow()).completed as Record<string, unknown>[])[0] ?? {};
    expect(completed.photos).toBe(2);
    expect(completed.photosMissing).toBe(2);
    expect(ok(await desk.getJobPhotos({ job: "2026-10-18" })).photos).toEqual([]);
  });

  it("a photo sent without a Twilio login still counts", async () => {
    stubPhotos();
    const { desk, sms } = await takenWith({ photosRequired: true }, { PUBLIC_BASE_URL: PHOTO_BASE, CLEANER_CORE_TWILIO_ACCOUNT_SID: undefined });
    ok(await desk.markGuestsLeft({ confirmed: true }, PIN_KEY));
    await desk.inbound({ id: "mms-nologin", from: CLEANER, text: "", media: [photo()] });
    await desk.inbound({ id: "done", from: CLEANER, text: "DONE" });
    expect(toCleanerBodies(sms.sent).at(-1)).toBe("Thanks, cleaning marked done.");
    expect((ok(await desk.checkNow()).completed as Record<string, unknown>[])[0]?.photosMissing).toBe(1);
  });
});

const LANE = SCRATCH_TENANTS[0]!;
const REHEARSAL_TWILIO_SID = "ACscratchrehearsal";
const REHEARSAL_TWILIO_AUTH = "cleaner-twilio-auth-token-rehearsal";
const REHEARSAL_ROUTINE = "https://routine.example/hook";
const PARKING = "Parking is on the street today.";
/** The plain door code as its own token, so a random id that happens to hold the digits doesn't count. */
const PLAIN_CODE = new RegExp(`(?<![0-9A-Za-z])${DOOR_CODE}(?![0-9A-Za-z])`);

/** Scratch Lane as a tenant of the multi-tenant service, on the rehearsal's Twilio number. */
function laneTenant(hosted: Awaited<ReturnType<typeof hostedApp>>, clock: () => Date) {
  const registry = new TenantRegistry(hosted.root, clock);
  const created = registry.create({ label: "Scratch Lane", twilioNumber: CLEANER_LINE }).tenant;
  // An existing cleaning host: one property, with Cleaner Core on.
  const property = registry.addProperty(created.id, "Scratch Lane");
  registry.setFlow(created.id, property.id, "cleaning", true);
  const tenant = registry.get(created.id)!;
  const secrets = new TenantSecrets(hosted.root);
  const h = hostedCleaner({
    registry,
    secrets,
    dataRoot: hosted.root,
    origin: () => BASE,
    baseEnv: () => hosted.inst.env(),
    grantLive: () => true,
    now: clock,
    log: () => undefined,
  });
  return { tenant, room: propertyFolder(hosted.root, tenant.id, property), secrets, drain: () => drainAllTenants(h) };
}

describe("Cleaner Core full diagram", () => {
  it("diagram rehearsal", async () => {
    const address = LANE.property.address;
    const host = LANE.ownerPhone;
    const cleaner = LANE.cleanerPhone;
    const scratch = new Set([host, cleaner]);
    let at = new Date("2026-10-14T14:00:00.000Z");
    const clock = () => at;
    const sms = fakeSms();
    setCleanerTwilioClient(sms);
    const groups = groupFetch();
    setCleanerGroupFetch(groups.impl);
    const routine: { url: string; body: string }[] = [];
    setCleanerAlertFetch(async (url, init) => {
      routine.push({ url, body: init.body });
      return { status: 200 };
    });
    const mediaFetched = stubPhotos();
    const hosted = await hostedApp(
      {
        PUBLIC_BASE_URL: BASE,
        CLEANER_CORE_LIVE_SMS: "1",
        CLEANER_CORE_GROUP_CHAT: "1",
        CLEANER_CORE_SMS_ALLOWLIST: `${host},${cleaner}`,
        CLEANER_CORE_TWILIO_ACCOUNT_SID: REHEARSAL_TWILIO_SID,
        CLEANER_CORE_TWILIO_AUTH_TOKEN: REHEARSAL_TWILIO_AUTH,
        CLEANER_CORE_MULTI_TENANT: "1",
      },
      undefined,
      undefined,
      clock,
    );
    const replies: string[] = [];
    const stay = googleList([{ id: "g-scratch", start: "2026-10-14", end: "2026-10-17" }]);

    // 1. Grok connects through OAuth with one Allow.
    expect((await hosted.rpc(PATH, "tools/list")).status).toBe(401);
    const { tenant, room, secrets, drain } = laneTenant(hosted, clock);
    const clientId = await hosted.register("Grok");
    const { access, scope } = await hosted.connect(clientId, CLEANER_RESOURCE, CLEANER_SCOPE, CLEANER_RESOURCE, { inviteCode: new TenantRegistry(hosted.root, clock).invite(tenant.id) });
    expect(scope).toBe(CLEANER_SCOPE);
    const listed = await hosted.rpc(PATH, "tools/list", access);
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain("send_message");

    let rpcId = 0;
    // Like a real Grok Bot connected by OAuth: the bearer token only, no door-code key header.
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await hosted.http(PATH, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      });
      const raw = await res.text();
      replies.push(raw);
      expect(res.status, `${name}: ${raw}`).toBe(200);
      const result = (JSON.parse(raw) as { result: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text?: string }[] } }).result;
      return { isError: result.isError === true, text: result.content?.[0]?.text ?? "", structured: result.structuredContent ?? {} };
    };
    const say = async (name: string, args: Record<string, unknown> = {}) => {
      const reply = await tool(name, args);
      expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
      return reply.structured;
    };
    let smsId = 0;
    const fromCleaner = async (body: string, extra: Record<string, string> = {}) => {
      const path = "/webhooks/twilio/cleaner-core";
      const fields: Record<string, string> = { MessageSid: `SMrehearsal${++smsId}`, From: cleaner, To: CLEANER_LINE, Body: body, SmsStatus: "received", ...extra };
      const res = await hosted.http(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(REHEARSAL_TWILIO_AUTH, `${BASE}${path}`, fields) },
        body: new URLSearchParams(fields).toString(),
      });
      expect(res.status, body).toBe(200);
    };
    const checkAt = async (iso: string): Promise<Record<string, unknown> & { alerts: string[] }> => {
      at = new Date(iso);
      const reply = await say("check_now", { googleEvents: stay });
      return { ...reply, alerts: ((reply.alerts as string[] | undefined) ?? []).map(plain) };
    };
    const toCleaner = () => sms.sent.filter((item) => item.to === cleaner).map((item) => plain(item.body));
    const offersSent = () => [...toCleaner(), ...groups.posts.filter((post) => post.to.includes(cleaner)).map((post) => plain(post.body))].filter((body) => body.startsWith("Turnover at"));
    const inGroup = () => groups.posts.filter((post) => post.to.includes(cleaner)).map((post) => plain(post.body));
    const remindersSent = () => [...toCleaner(), ...inGroup()].filter((body) => body.startsWith("Reminder:"));

    /** The checks after every step: Scratch numbers only, and the door code nowhere but the cleaner's private text or the group of the host and the cleaner. */
    const safe = async (step: string) => {
      await drain();
      for (const item of sms.sent) {
        expect(scratch.has(item.to), `${step}: text to ${item.to}`).toBe(true);
        expect(isScratchTestNumber(item.to), step).toBe(true);
        if (PLAIN_CODE.test(item.body)) expect(item.to, `${step}: door code`).toBe(cleaner);
      }
      for (const post of groups.posts) {
        for (const to of post.to) expect(scratch.has(to), `${step}: group post to ${to}`).toBe(true);
        // The code may be in the group only while it holds just the host and the cleaner.
        if (PLAIN_CODE.test(post.body)) expect([...post.to].sort(), `${step}: group post`).toEqual([host, cleaner].sort());
      }
      for (const post of routine) {
        expect(post.url, step).toBe(REHEARSAL_ROUTINE);
        expect(post.body, step).not.toContain("+1");
        expect(PLAIN_CODE.test(post.body), `${step}: routine`).toBe(false);
      }
      for (const path of filesUnder(hosted.root)) expect(PLAIN_CODE.test(readFileSync(path, "latin1")), `${step}: ${path}`).toBe(false);
      expect(PLAIN_CODE.test(replies.join("\n")), `${step}: replies`).toBe(false);
      expect(PLAIN_CODE.test(hosted.logs.join("\n")), `${step}: logs`).toBe(false);
      expect(hosted.logs.join("\n").includes(access), `${step}: token in logs`).toBe(false);
      // The server's door-code key stays in the secret store: never in a reply, a log, or the desk's file.
      const serverKey = secrets.tenant(tenant.id).CLEANER_CORE_PIN_KEY;
      if (serverKey) {
        expect(replies.join("\n").includes(serverKey), `${step}: key in replies`).toBe(false);
        expect(hosted.logs.join("\n").includes(serverKey), `${step}: key in logs`).toBe(false);
        const live = join(room, "cleaner-live.json");
        if (existsSync(live)) expect(readFileSync(live, "utf8").includes(serverKey), `${step}: key in cleaner-live.json`).toBe(false);
      }
    };
    await safe("1 connect");

    // 2. Setup steps 2 to 8 through the new tools.
    await say("get_state", { choice: "cleaners" });
    await say("save_property", { business: LANE.hostName, nickname: "Scratch Lane", address, propertyType: "House", timeZone: ZONE, checkoutTime: "11:00", checkInTime: "16:00" });
    await say("save_sources", { google: true });
    await say("save_people", { host, cleaner, cleanerName: "Ana", groupChat: "cleaner-and-host" });
    await say("save_schedule", { firstText: "days-after-check-in", firstTextDays: 1, reminder: "days-before-checkout", reminderDays: 1, reminderTime: "18:00" });
    await say("save_door_code", { code: DOOR_CODE, lockLocation: LOCK });
    await say("save_preferences", PREFERENCES);
    await say("save_payments", { on: false });
    // On Grok on the shared service, setup asks once whether to set up Supply Core too.
    await say("choose_supplies", { on: false });
    await safe("2 setup");

    // 3. The alert routine, before the review, with a stubbed webhook. A Grok Bot's secure card can't
    // fill a tool argument, so Grok gets a one-time link and posts the address and key to it from its own computer.
    const issued = await say("save_alert_routine");
    const uploadLink = new URL(String(issued.uploadUrl));
    expect(uploadLink.origin).toBe(BASE);
    const uploaded = await hosted.http(uploadLink.pathname, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: REHEARSAL_ROUTINE, token: "k-test-rehearsal-key" }),
    });
    const uploadReply = await uploaded.text();
    expect(uploaded.status, uploadReply).toBe(200);
    replies.push(uploadReply);
    expect(uploadReply).not.toContain("k-test-rehearsal-key");
    expect(hosted.logs.join("\n")).not.toContain(uploadLink.pathname);
    expect((await say("get_state")).next).not.toMatch(/upload link/);
    await safe("3 alert routine");
    expect(routine.length).toBeGreaterThan(0);

    // Then the review and Activate.
    expect((await say("get_state")).next).toBe(REVIEW_NEXT);
    await say("activate", { googleEvents: googleList([]) });
    expect((await say("get_state")).done).toContain("Checks finished.");
    expect(sms.sent).toEqual([]);
    expect(Buffer.from(secrets.tenant(tenant.id).CLEANER_CORE_PIN_KEY ?? "", "base64")).toHaveLength(32);
    await safe("3 activate");

    // 4. A booking appears in Google. The alert names the usual times, and the host says yes.
    const booked = await checkAt("2026-10-14T14:05:00.000Z");
    expect(booked.alerts).toContain("New booking at Scratch Lane: check-in Wednesday, Oct 14, checkout Saturday, Oct 17. Use the usual 11:00 AM checkout and 4:00 PM check-in?");
    await say("confirm_times", { checkout: "11:00", checkIn: "16:00" });
    expect(toCleaner().filter((body) => body.includes("wants to set up a group chat with you for cleaner services at"))).toHaveLength(1);
    await safe("4 booking and times");

    // 5 and 6. The cleaner's first YES takes the invite. The offer waits for check-in + 1 day at 9:00 AM, then the second YES takes it.
    await fromCleaner("YES");
    expect(offersSent()).toEqual([]);
    await checkAt("2026-10-15T12:59:00.000Z");
    expect(offersSent()).toEqual([]);
    await checkAt("2026-10-15T13:00:00.000Z");
    expect(offersSent()).toHaveLength(1);
    await checkAt("2026-10-15T13:05:00.000Z");
    expect(offersSent()).toHaveLength(1);
    await fromCleaner("YES");
    expect((await say("get_turns")).turns).toEqual([expect.objectContaining({ checkoutDate: "2026-10-17", status: "confirmed" })]);
    await safe("5-6 offer and YES");

    // 7. The reminder 1 day before asks for an arrival time. Grok reads the reply, saves it, and the host approves a message.
    await checkAt("2026-10-16T21:59:00.000Z");
    expect(remindersSent()).toEqual([]);
    await checkAt("2026-10-16T22:00:00.000Z");
    expect(remindersSent()).toEqual([`Reminder: cleaning at ${address} on Saturday, Oct 17. Checkout is 11:00 AM. Ana, what time do you plan to arrive?`]);
    at = new Date("2026-10-16T22:10:00.000Z");
    const quietBefore = sms.sent.length;
    await fromCleaner("I'll be there around 11:30");
    expect(sms.sent).toHaveLength(quietBefore);
    const read = await checkAt("2026-10-16T22:11:00.000Z");
    expect((read.messages as { from: string; text: string; handled: string }[]).at(-1)).toEqual(
      expect.objectContaining({ from: "cleaner", text: "I'll be there around 11:30", handled: "none" }),
    );
    await say("save_arrival", { time: "11:30" });
    // With the group on, a message to Ana alone is refused. It goes to the group.
    expect((await tool("send_message", { to: "cleaner", text: PARKING })).text).toBe("Messages go to the group. Send it with to: group.");
    const asked = await say("send_message", { to: "group", text: PARKING });
    expect(asked.preview).toEqual({ to: "the group", text: PARKING });
    const code = (asked.confirmation as { code: string }).code;
    expect(sms.sent.filter((item) => item.body === PARKING)).toEqual([]);
    expect(await say("send_message", { to: "group", text: PARKING, confirmation: code })).toEqual({ next: "Sent to the group." });
    // The message goes into the group once. Nothing goes to Ana one-to-one.
    expect(sms.sent.filter((item) => item.body.includes(PARKING))).toEqual([]);
    expect(groups.posts.filter((post) => post.body.includes(PARKING))).toEqual([expect.objectContaining({ body: PARKING, to: expect.arrayContaining([cleaner]) })]);
    const again = await tool("send_message", { to: "group", text: PARKING, confirmation: code });
    expect(again.isError).toBe(true);
    expect(again.text).toBe("That approval has expired or doesn't match. Ask the host again.");
    expect(groups.posts.filter((post) => post.body.includes(PARKING))).toHaveLength(1);
    await safe("7 reminder, arrival, and message");

    // 8. The checkout nudge, then "guests have left", and the code with the lock in the group of the host and the cleaner.
    const nudge = "Checkout time at Scratch Lane. Have the guests left?";
    expect((await checkAt("2026-10-17T14:59:00.000Z")).alerts).not.toContain(nudge);
    expect((await checkAt("2026-10-17T15:00:00.000Z")).alerts.filter((alert) => alert === nudge)).toHaveLength(1);
    expect((await checkAt("2026-10-17T15:05:00.000Z")).alerts).not.toContain(nudge);
    expect(sms.sent.filter((item) => PLAIN_CODE.test(item.body))).toEqual([]);
    at = new Date("2026-10-17T15:10:00.000Z");
    await say("mark_guests_left", { confirmed: true });
    // The group holds only the host and the cleaner, so the code with the lock goes into it. Nothing goes one-to-one.
    const groupCode = `Guests have left ${address}. Door code for the ${LOCK}: ${DOOR_CODE}. Ana, reply DONE when the cleaning is finished. Note from the host: ${PREFERENCES.instructions}`;
    expect(sms.sent.filter((item) => PLAIN_CODE.test(item.body))).toEqual([]);
    expect(groups.posts.filter((post) => PLAIN_CODE.test(post.body))).toEqual([expect.objectContaining({ body: groupCode, to: [host, cleaner].sort() })]);
    await safe("8 nudge and guests left");

    // 9. The checklist, one photo, a note, and DONE.
    // The checklist is a group post now. Its "then reply DONE" is mid-sentence, so namedAsk leaves it as it is.
    expect(inGroup().at(-1)).toBe("Checklist for Scratch Lane: Strip the beds; Restock coffee. Send photos, then reply DONE when finished.");
    at = new Date("2026-10-17T15:30:00.000Z");
    const mediaUrl = `https://api.twilio.com/2010-04-01/Accounts/${REHEARSAL_TWILIO_SID}/Messages/MMrehearsal/Media/MErehearsal`;
    await fromCleaner("", { NumMedia: "1", MediaUrl0: mediaUrl, MediaContentType0: "image/jpeg" });
    expect(mediaFetched).toEqual([mediaUrl]);
    await fromCleaner("need paper towels");
    at = new Date("2026-10-17T17:00:00.000Z");
    await fromCleaner("DONE");
    expect(inGroup().at(-1)).toBe("Before I mark it done: is everything on the checklist I sent finished? Ana, reply YES or NO.");
    expect(inGroup().filter((body) => body === "Thanks, cleaning marked done.")).toHaveLength(0);
    await fromCleaner("YES");
    expect(inGroup().filter((body) => body === "Thanks, cleaning marked done.")).toHaveLength(1);
    await safe("9 checklist, photo, note, DONE, checklist YES");

    // 10. check_now returns the finished cleaning, and get_job_photos returns a link that works.
    const finished = await checkAt("2026-10-17T17:05:00.000Z");
    const completed = JSON.parse(plain(JSON.stringify(finished.completed))) as Record<string, unknown>[];
    expect(completed).toEqual([
      expect.objectContaining({
        nickname: "Scratch Lane",
        day: "Saturday, Oct 17",
        arrivalTime: "11:30 AM",
        checklist: PREFERENCES.checklist,
        checklistConfirmed: "Saturday, Oct 17, 1:00 PM",
        photos: 1,
        notes: ["need paper towels"],
      }),
    ]);
    const photos = (await say("get_job_photos", { job: completed[0]?.day })).photos as { url: string }[];
    expect(photos).toHaveLength(1);
    const link = new URL(photos[0]?.url ?? "");
    expect(link.origin).toBe(BASE);
    const served = await hosted.http(link.pathname);
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toBe("image/jpeg");
    expect(served.bytes().equals(JPEG)).toBe(true);
    expect((await checkAt("2026-10-17T17:10:00.000Z")).completed).toBeUndefined();
    await safe("10 completed and photos");
  }, 60_000);

  it("an OAuth Grok Bot with no key header saves and sends the door code, and a restart doesn't ask for it again", async () => {
    const address = LANE.property.address;
    const host = LANE.ownerPhone;
    const cleaner = LANE.cleanerPhone;
    let at = new Date("2026-10-14T14:00:00.000Z");
    const sms = fakeSms();
    setCleanerTwilioClient(sms);
    const hosted = await hostedApp(
      {
        PUBLIC_BASE_URL: BASE,
        CLEANER_CORE_LIVE_SMS: "1",
        CLEANER_CORE_GROUP_CHAT: "0",
        CLEANER_CORE_SMS_ALLOWLIST: `${host},${cleaner}`,
        CLEANER_CORE_TWILIO_ACCOUNT_SID: REHEARSAL_TWILIO_SID,
        CLEANER_CORE_TWILIO_AUTH_TOKEN: REHEARSAL_TWILIO_AUTH,
        CLEANER_CORE_MULTI_TENANT: "1",
      },
      undefined,
      undefined,
      () => at,
    );
    const { tenant, room, secrets } = laneTenant(hosted, () => at);
    const { access } = await hosted.connect(await hosted.register("Grok"), CLEANER_RESOURCE, CLEANER_SCOPE, CLEANER_RESOURCE, { inviteCode: new TenantRegistry(hosted.root, () => at).invite(tenant.id) });
    const replies: string[] = [];
    let rpcId = 0;
    // The bearer token only: no door-code key header.
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await hosted.http(PATH, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      });
      const raw = await res.text();
      replies.push(raw);
      const result = (JSON.parse(raw) as { result: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text?: string }[] } }).result;
      return { isError: result.isError === true, text: result.content?.[0]?.text ?? "", structured: result.structuredContent ?? {} };
    };
    const say = async (name: string, args: Record<string, unknown> = {}) => {
      const reply = await tool(name, args);
      expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
      return reply.structured;
    };
    let smsId = 0;
    const fromCleaner = async (body: string) => {
      const path = "/webhooks/twilio/cleaner-core";
      const fields: Record<string, string> = { MessageSid: `SMoauthkey${++smsId}`, From: cleaner, To: CLEANER_LINE, Body: body, SmsStatus: "received" };
      const res = await hosted.http(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(REHEARSAL_TWILIO_AUTH, `${BASE}${path}`, fields) },
        body: new URLSearchParams(fields).toString(),
      });
      expect(res.status, body).toBe(200);
    };
    const codeTexts = () => sms.sent.filter((item) => PLAIN_CODE.test(item.body));

    await say("get_state", { choice: "cleaners" });
    await say("save_property", { business: LANE.hostName, address, timeZone: ZONE, checkoutTime: "11:00", checkInTime: "16:00" });
    await say("save_sources", { google: true });
    await say("save_people", { host, cleaner, cleanerName: "Ana", groupChat: "cleaner-only" });
    await say("save_schedule", { firstText: "when-confirmed" });
    expect(String((await say("save_door_code", { code: DOOR_CODE, lockLocation: LOCK })).next)).toContain("Saved the door code.");
    expect(askStep((await say("get_state")))).toBe("preferences");
    await say("save_preferences", {});
    await say("save_alert_routine", ROUTINE);
    await say("activate", { googleEvents: googleList([{ id: "g-oauth", start: "2026-10-14", end: "2026-10-17" }]) });
    await say("confirm_times", { checkout: "11:00", checkIn: "16:00" });
    await fromCleaner("YES");
    await fromCleaner("YES");
    expect((await say("get_turns")).turns).toEqual([expect.objectContaining({ checkoutDate: "2026-10-17", status: "confirmed" })]);
    expect(codeTexts()).toEqual([]);

    at = new Date("2026-10-17T15:10:00.000Z");
    expect(await say("mark_guests_left", { confirmed: true })).toEqual({ next: "I sent the door code to the cleaner. I'll tell you if it doesn't go through." });
    const privateCode = `Guests have left ${address}. Door code for the ${LOCK}: ${DOOR_CODE}. This code is only for you. Reply DONE when the cleaning is finished.`;
    expect(codeTexts()).toEqual([expect.objectContaining({ to: cleaner, body: privateCode })]);

    // A redeploy: the desk opens the seal with the server's key, so it doesn't ask for the code again.
    resetLiveDesks();
    const after = await say("get_state");
    expect(askStep(after)).not.toBe("door-code");
    expect(after.done).toContain("Door code saved.");
    const again = await tool("mark_guests_left", { confirmed: true });
    expect(again.text).toContain("I already sent the door code to the cleaner.");
    expect(codeTexts()).toHaveLength(1);

    const serverKey = secrets.tenant(tenant.id).CLEANER_CORE_PIN_KEY ?? "";
    expect(Buffer.from(serverKey, "base64")).toHaveLength(32);
    const live = readFileSync(join(room, "cleaner-live.json"), "utf8");
    expect(live.includes(serverKey)).toBe(false);
    expect(PLAIN_CODE.test(live)).toBe(false);
    expect(replies.join("\n").includes(serverKey)).toBe(false);
    expect(PLAIN_CODE.test(replies.join("\n"))).toBe(false);
    expect(hosted.logs.join("\n").includes(serverKey)).toBe(false);
  }, 60_000);
});

describe("Cleaner Core door-code write guard: ids that only hold the digits", () => {
  /** A Twilio-format SID (SM + 32 hex) that holds the made-up code 8088. */
  const PROBE_SID = "SM00808800000000000000000000000000";
  /** The code as its own token. Letters, digits, `_`, and `-` around it make it part of an id. */
  const STANDALONE = new RegExp(`(?<![A-Za-z0-9_-])${DOOR_CODE}(?![A-Za-z0-9_-])`);
  const WEBHOOK = "/webhooks/twilio/cleaner-core";

  async function setUpWired(wired: WiredApp, stays: { id: string; start: string; end: string }[]) {
    const steps: [string, Record<string, unknown>][] = [
      ["get_state", { choice: "cleaners" }],
      ["save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "10:30", checkInTime: "15:00" }],
      ["save_sources", { google: true }],
      ["save_people", { host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" }],
      ["save_schedule", { firstText: "when-confirmed" }],
      ["save_door_code", { code: DOOR_CODE, lockLocation: LOCK }],
      ["save_preferences", {}],
      ["save_alert_routine", ROUTINE],
      ["activate", { googleEvents: googleList(stays) }],
    ];
    for (const [name, args] of steps) {
      const reply = await call(wired, name, args);
      expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
    }
  }

  function savedFiles(wired: WiredApp): { path: string; text: string }[] {
    return filesUnder(wired.root).map((path) => ({ path, text: readFileSync(path, "latin1") }));
  }

  it("takes and saves a cleaner YES whose Twilio SID holds the code, and save_arrival still works", async () => {
    expect(PROBE_SID).toMatch(/^SM[0-9a-f]{32}$/);
    expect(PROBE_SID).toContain(DOOR_CODE);
    const wired = await app();
    await setUpWired(wired, [{ id: "g-probe", start: "2026-10-14", end: "2026-10-17" }]);
    expect((await call(wired, "confirm_times", { checkout: "11:00", checkIn: "16:00" })).isError).toBe(false);

    const optIn = await wired.postTwilio(WEBHOOK, { from: CLEANER, to: CLEANER_LINE, body: "YES", sid: PROBE_SID, token: CLEANER_AUTH });
    expect(optIn.status).toBe(200);
    const offer = await wired.postTwilio(WEBHOOK, { from: CLEANER, to: CLEANER_LINE, body: "YES", sid: "SM-guard-offer", token: CLEANER_AUTH });
    expect(offer.status).toBe(200);
    expect((await call(wired, "get_turns")).structured?.turns).toEqual([expect.objectContaining({ checkoutDate: "2026-10-17", status: "confirmed" })]);
    const arrival = await call(wired, "save_arrival", { time: "11:30" });
    expect(arrival.isError, arrival.text).toBe(false);

    const files = savedFiles(wired);
    const live = files.find((file) => file.path.endsWith("cleaner-live.json"));
    const engine = files.find((file) => file.path.endsWith("cleaner-core.json"));
    expect((JSON.parse(live?.text ?? "{}") as { seenInbound?: string[] }).seenInbound).toContain(PROBE_SID);
    expect(engine?.text).toContain(PROBE_SID);
    for (const file of files) expect(STANDALONE.test(file.text), file.path).toBe(false);
  });

  it("applies and saves a booking whose UID holds the code", async () => {
    const wired = await app();
    const stay = { id: `ev${DOOR_CODE}xyz`, start: "2026-10-14", end: "2026-10-17" };
    await setUpWired(wired, [stay]);
    const checked = await call(wired, "check_now", { googleEvents: googleList([stay]) });
    expect(checked.isError, checked.text).toBe(false);
    expect((await call(wired, "confirm_times", { checkout: "11:00", checkIn: "16:00" })).isError).toBe(false);
    expect((await call(wired, "get_turns")).structured?.turns).toEqual([expect.objectContaining({ checkoutDate: "2026-10-17" })]);
    const files = savedFiles(wired);
    expect(files.some((file) => file.text.includes(stay.id))).toBe(true);
    for (const file of files) expect(STANDALONE.test(file.text), file.path).toBe(false);
  });

  it("counts the code only as its own token", () => {
    for (const text of [DOOR_CODE, `x ${DOOR_CODE} y`, `code:${DOOR_CODE}.`, `"${DOOR_CODE}"`, `{"body":"Code\\n${DOOR_CODE}"}`, `{"body":"x\\u001f${DOOR_CODE}"}`]) {
      expect(containsCodeToken(text, DOOR_CODE), text).toBe(true);
    }
    for (const text of [`SM00${DOOR_CODE}ab`, `ev${DOOR_CODE}xyz`, `1${DOOR_CODE}`, `${DOOR_CODE}a`, `a1b2-${DOOR_CODE}-c3d4`, `x_${DOOR_CODE}`, "", "80 88"]) {
      expect(containsCodeToken(text, DOOR_CODE), text).toBe(false);
    }
    expect(containsCodeToken("a+b 1.5 c", "1.5")).toBe(true);
    expect(containsCodeToken("a 125 c", "1.5")).toBe(false);
  });

  it("still refuses to write a file that holds the plain code as its own token", async () => {
    const { desk } = openDesk([HOST, CLEANER], "0");
    await setUp(desk, { groupChat: "cleaner-only" });
    const inside = desk as unknown as {
      file: { preferences?: { checklist: string[]; photosRequired: boolean; supplyNotes: boolean; instructions?: string } };
      persist(): void;
      engine: CleanerCore;
    };
    for (const instructions of [` ${DOOR_CODE} `, `Code\n${DOOR_CODE}`]) {
      inside.file.preferences = { checklist: [], photosRequired: false, supplyNotes: false, instructions };
      expect(() => inside.persist()).toThrow("Could not seal the door code.");
    }
    inside.file.preferences = { checklist: [], photosRequired: false, supplyNotes: false };
    const engine = inside.engine as unknown as { hostNoteState: { id: string; body: string }[]; save(): void };
    engine.hostNoteState.push({ id: "probe", body: `lockbox: ${DOOR_CODE}.` });
    expect(() => engine.save()).toThrow("The door code cannot be stored in plaintext.");
    engine.hostNoteState.pop();
  });

  it("refuses a split code in save_property's business, nickname, or property type", async () => {
    const wired = await app();
    await setUpWired(wired, []);
    const base = { business: BUSINESS, address: ADDRESS, timeZone: ZONE };
    for (const extra of [{ business: "Unit 80 88 Cleaning" }, { nickname: "Lake 80.88" }, { propertyType: "Condo 8-0-8-8" }]) {
      const refused = await call(wired, "save_property", { ...base, ...extra });
      expect(refused.isError, JSON.stringify(extra)).toBe(true);
      expect(refused.text).toBe(DOOR_CODE_IN_CHAT);
    }
    const live = JSON.parse(savedFiles(wired).find((file) => file.path.endsWith("cleaner-live.json"))?.text ?? "{}") as { business?: string };
    expect(live.business).toBe(BUSINESS);
    // The address keeps its house number and ZIP code.
    expect((await call(wired, "save_property", base)).isError).toBe(false);
  });
});
