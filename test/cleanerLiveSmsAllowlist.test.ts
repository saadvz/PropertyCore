import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { liveDeskFor, resetLiveDesks, setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import { GroupNotConfirmed } from "../src/cleaner-core/groupThread";
import { isAllowlisted, landlordConfirmed, mayText, sendLiveGroup, sendLiveSms, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import {
  CALENDAR_ICS,
  CALENDAR_URL,
  CLEANER,
  CLEANER_LINE,
  FROZEN,
  HOST,
  OBSERVER,
  TEST_PIN_KEY,
  fakeSms,
} from "./wiringProof";

const ADDRESS = "12 Practice Lane, Teaneck, NJ 07666";
const BUSINESS = "Harbor";
const DOOR = "8088";
// Not one of the Scratch tenants' phones, so nothing but the consent rules can drop it.
const STRANGER = "+15555550177";
const TOUR_NUMBER = "+15555550123";
const HOST_UNCONFIRMED = "I can text only after the host's phone is confirmed. Save the phone you confirmed when you signed in as the host's number.";
const BLANK_LISTS: Array<string | undefined> = [undefined, "", "   ", ",", " , , "];

afterEach(() => {
  setCleanerTwilioClient(undefined);
  setCleanerCalendarFetch(undefined);
  resetLiveDesks();
});

function envFor(allowlist: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    CLEANER_CORE_ENABLED: "1",
    CLEANER_CORE_GROUP_CHAT: "0",
    CLEANER_CORE_LIVE_SMS: "1",
    CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
    CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
    CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
  };
  if (allowlist !== undefined) env.CLEANER_CORE_SMS_ALLOWLIST = allowlist;
  return env;
}

function calendar() {
  setCleanerCalendarFetch(async (url) => ({
    status: url === CALENDAR_URL ? 200 : 404,
    url,
    async text() {
      return url === CALENDAR_URL ? CALENDAR_ICS : "";
    },
  }));
}

async function readyDesk(env: NodeJS.ProcessEnv) {
  const root = mkdtempSync(join(tmpdir(), "cleaner-allow-"));
  const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
  const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
  expect((await desk.getState("cleaners")).ok).toBe(true);
  expect((await desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" })).ok).toBe(true);
  expect((await desk.savePeople({ host: HOST, cleaner: CLEANER, observer: OBSERVER })).ok).toBe(true);
  expect((await desk.saveCalendarLink({ url: CALENDAR_URL })).ok).toBe(true);
  expect((await desk.saveDoorCode({ code: DOOR }, pinKey)).ok).toBe(true);
  expect((await desk.setUpTexting()).ok).toBe(true);
  return {
    desk,
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("per-account texting consent (saadvz/TourCore#164)", () => {
  it.each(BLANK_LISTS)("texts nobody on an account whose host phone isn't confirmed, when the allowlist is %j", async (allowlist) => {
    const client = fakeSms();
    setCleanerTwilioClient(client);
    calendar();
    const { desk, close } = await readyDesk(envFor(allowlist));
    try {
      expect(await desk.runChecks()).toEqual({ ok: false, error: HOST_UNCONFIRMED });
      expect((await desk.confirmTimes({ checkout: "10:30", checkIn: "15:00" })).ok).toBe(false);
      expect(await desk.getTurns()).toEqual({ ok: true, result: { turns: [] } });
      await desk.inbound({ id: "blank-yes", from: CLEANER, text: "YES" });
      expect(await desk.getTurns()).toEqual({ ok: true, result: { turns: [] } });
      expect(client.sent).toEqual([]);
    } finally {
      close();
    }
  });

  it("needs no operator step once the landlord's phone is confirmed: the cleaner gets only the opt-in until their YES", async () => {
    const client = fakeSms();
    setCleanerTwilioClient(client);
    calendar();
    const { desk, close } = await readyDesk({ ...envFor(undefined), CLEANER_CORE_LANDLORD_PHONE: HOST });
    try {
      expect((await desk.runChecks()).ok).toBe(true);
      expect((await desk.confirmTimes({ checkout: "10:30", checkIn: "15:00" })).ok).toBe(true);
      const toCleaner = client.sent.filter((item) => item.to === CLEANER);
      expect(toCleaner.length).toBe(1);
      expect(toCleaner[0]?.body).toMatch(/Reply YES to get cleaning texts, or STOP to opt out\./);
      // The observer the host saved gets nothing before the cleaner's YES, and nobody gets the door code.
      expect(client.sent.filter((item) => item.to === OBSERVER)).toEqual([]);
      expect(client.sent.some((item) => item.body.includes(DOOR))).toBe(false);
      await desk.inbound({ id: "consent-yes", from: CLEANER, text: "YES" });
      const after = client.sent.filter((item) => item.to === CLEANER);
      expect(after.length).toBeGreaterThan(1);
      expect(after.some((item) => /Turnover at/.test(item.body))).toBe(true);
      expect(client.sent.some((item) => item.body.includes(DOOR))).toBe(false);
    } finally {
      close();
    }
  });

  it("on an account made in /admin with no confirmed phone, the old allowlist vouches for the host only", async () => {
    const client = fakeSms();
    setCleanerTwilioClient(client);
    calendar();
    const { desk, close } = await readyDesk(envFor(HOST));
    try {
      expect((await desk.runChecks()).ok).toBe(true);
      expect((await desk.confirmTimes({ checkout: "10:30", checkIn: "15:00" })).ok).toBe(true);
      // The cleaner isn't on the list, and still gets the opt-in: their own YES decides now.
      expect(client.sent.filter((item) => item.to === CLEANER).map((item) => item.body)).toEqual([expect.stringMatching(/Reply YES to get cleaning texts/)]);
    } finally {
      close();
    }
  });

  it("sends the cleaner nothing after their STOP, apart from the STOP reply", async () => {
    const client = fakeSms();
    setCleanerTwilioClient(client);
    calendar();
    const { desk, close } = await readyDesk({ ...envFor(undefined), CLEANER_CORE_LANDLORD_PHONE: HOST });
    try {
      expect((await desk.runChecks()).ok).toBe(true);
      expect((await desk.confirmTimes({ checkout: "10:30", checkIn: "15:00" })).ok).toBe(true);
      await desk.inbound({ id: "consent-stop", from: CLEANER, text: "STOP" });
      const sentBefore = client.sent.filter((item) => item.to === CLEANER).length;
      await desk.runChecks();
      const late = client.sent.filter((item) => item.to === CLEANER).slice(sentBefore);
      expect(late.some((item) => /Turnover at/.test(item.body) || item.body.includes(DOOR))).toBe(false);
    } finally {
      close();
    }
  });

  it("reads only the people the host saved: a stranger's STOP changes nothing and gets no reply", async () => {
    const client = fakeSms();
    setCleanerTwilioClient(client);
    calendar();
    const { desk, close } = await readyDesk({ ...envFor(undefined), CLEANER_CORE_LANDLORD_PHONE: HOST });
    try {
      // Before any engine exists, a stranger's STOP gets no reply carrying the address.
      await desk.inbound({ id: "stranger-stop-early", from: STRANGER, text: "STOP" });
      expect((await desk.runChecks()).ok).toBe(true);
      expect((await desk.confirmTimes({ checkout: "10:30", checkIn: "15:00" })).ok).toBe(true);
      await desk.inbound({ id: "stranger-stop", from: STRANGER, text: "STOP" });
      await desk.inbound({ id: "stranger-hurt", from: STRANGER, text: "someone is hurt" });
      expect(client.sent.filter((item) => item.to === STRANGER)).toEqual([]);
      expect(client.sent.some((item) => /hurt|911/i.test(item.body))).toBe(false);
      // The cleaner's own YES still schedules the turnover, and the host can still text them.
      await desk.inbound({ id: "cleaner-yes-after-stranger", from: CLEANER, text: "YES" });
      expect(client.sent.some((item) => item.to === CLEANER && /Turnover at/.test(item.body))).toBe(true);
      expect((await desk.sendMessage({ to: "cleaner", text: "Running late today?" })).ok).toBe(true);
    } finally {
      close();
    }
  });

  it("takes a saved cleaner's STOP even while the host's phone isn't confirmed, and holds every text meanwhile", async () => {
    const client = fakeSms();
    setCleanerTwilioClient(client);
    calendar();
    const env: NodeJS.ProcessEnv = { ...envFor(undefined), CLEANER_CORE_LANDLORD_PHONE: HOST };
    const root = mkdtempSync(join(tmpdir(), "cleaner-allow-"));
    try {
      const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
      const pinKey = Buffer.from(TEST_PIN_KEY, "base64");
      expect((await desk.getState("cleaners")).ok).toBe(true);
      expect((await desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" })).ok).toBe(true);
      expect((await desk.savePeople({ host: HOST, cleaner: CLEANER })).ok).toBe(true);
      expect((await desk.saveCalendarLink({ url: CALENDAR_URL })).ok).toBe(true);
      expect((await desk.saveDoorCode({ code: DOOR }, pinKey)).ok).toBe(true);
      expect((await desk.setUpTexting()).ok).toBe(true);
      expect((await desk.runChecks()).ok).toBe(true);
      expect((await desk.confirmTimes({ checkout: "10:30", checkIn: "15:00" })).ok).toBe(true);
      await desk.inbound({ id: "unconfirmed-yes", from: CLEANER, text: "YES" });
      expect((await desk.sendMessage({ to: "cleaner", text: "Running late today?" })).ok).toBe(true);
      // The landlord's confirmed phone changes, so the saved host no longer matches it.
      env.CLEANER_CORE_LANDLORD_PHONE = STRANGER;
      const sentBefore = client.sent.length;
      expect((await desk.sendMessage({ to: "cleaner", text: "Running late today?" })).ok).toBe(false);
      await desk.inbound({ id: "unconfirmed-stop", from: CLEANER, text: "STOP" });
      expect(client.sent.slice(sentBefore).filter((item) => item.to !== CLEANER)).toEqual([]);
      env.CLEANER_CORE_LANDLORD_PHONE = HOST;
      // The STOP was kept: the cleaner can't be texted again until they opt back in.
      expect((await desk.sendMessage({ to: "cleaner", text: "Running late today?" })).ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a host other than the phone confirmed at sign-up, even when the allowlist is *", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-allow-"));
    try {
      const desk = liveDeskFor(root, () => ({ ...envFor("*"), CLEANER_CORE_LANDLORD_PHONE: STRANGER }), () => new Date(FROZEN));
      expect((await desk.getState("cleaners")).ok).toBe(true);
      expect((await desk.saveProperty({ business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" })).ok).toBe(true);
      expect(await desk.savePeople({ host: HOST, cleaner: CLEANER })).toEqual({ ok: false, error: "The host's number has to be the phone you confirmed when you signed in." });
      expect((await desk.savePeople({ host: STRANGER, cleaner: CLEANER })).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never texts this service's own lines, and texts nothing with live texts off", async () => {
    const client = fakeSms();
    setCleanerTwilioClient(client);
    const env = { ...envFor(undefined), TOURCORE_TWILIO_PHONE_NUMBER: TOUR_NUMBER, CLEANER_CORE_SERVICE_LINES: STRANGER };
    expect(mayText(env, CLEANER)).toBe(true);
    expect(mayText(env, CLEANER_LINE)).toBe(false);
    expect(mayText(env, TOUR_NUMBER)).toBe(false);
    expect(mayText(env, STRANGER)).toBe(false);
    expect(mayText(env, "not a phone")).toBe(false);
    expect(await sendLiveSms(env, { to: CLEANER_LINE, body: "loop" })).toBeUndefined();
    expect(await sendLiveSms(env, { to: STRANGER, body: "loop" })).toBeUndefined();
    expect(await sendLiveSms({ ...env, CLEANER_CORE_LIVE_SMS: "0" }, { to: CLEANER, body: "off" })).toBeUndefined();
    expect(client.sent).toEqual([]);
    expect(await sendLiveSms(env, { to: CLEANER, body: "opt in" })).toBeTruthy();
    expect(client.sent.map((item) => item.to)).toEqual([CLEANER]);
  });

  it("confirms the landlord by the phone verified at sign-up first, then by the old allowlist", () => {
    expect(landlordConfirmed({ CLEANER_CORE_LANDLORD_PHONE: HOST }, HOST)).toBe(true);
    expect(landlordConfirmed({ CLEANER_CORE_LANDLORD_PHONE: HOST }, CLEANER)).toBe(false);
    // A confirmed phone wins over the allowlist.
    expect(landlordConfirmed({ CLEANER_CORE_LANDLORD_PHONE: HOST, CLEANER_CORE_SMS_ALLOWLIST: "*" }, CLEANER)).toBe(false);
    expect(landlordConfirmed({ CLEANER_CORE_SMS_ALLOWLIST: HOST }, HOST)).toBe(true);
    expect(landlordConfirmed({ CLEANER_CORE_SMS_ALLOWLIST: HOST }, CLEANER)).toBe(false);
    expect(landlordConfirmed({}, HOST)).toBe(false);
    expect(landlordConfirmed({ CLEANER_CORE_LANDLORD_PHONE: HOST }, undefined)).toBe(false);
    expect(landlordConfirmed({ CLEANER_CORE_LANDLORD_PHONE: CLEANER_LINE, CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE }, CLEANER_LINE)).toBe(false);
    // A landlord record that isn't a confirmed phone fails closed, even with the allowlist at *.
    expect(landlordConfirmed({ CLEANER_CORE_LANDLORD_PHONE: "unconfirmed", CLEANER_CORE_SMS_ALLOWLIST: "*" }, HOST)).toBe(false);
  });
});

describe("live texts when the allowlist is *", () => {
  it("allows any number except this service's own lines", () => {
    const env = { ...envFor("*"), TOURCORE_TWILIO_PHONE_NUMBER: TOUR_NUMBER };
    expect(isAllowlisted(env, HOST)).toBe(true);
    expect(isAllowlisted(env, STRANGER)).toBe(true);
    expect(isAllowlisted(env, CLEANER_LINE)).toBe(false);
    expect(isAllowlisted(env, TOUR_NUMBER)).toBe(false);
    expect(isAllowlisted(env, "not a phone")).toBe(false);
    expect(isAllowlisted(envFor(` ${HOST} , * `), STRANGER)).toBe(true);
  });

  it("texts a number nobody listed, but never the cleaning line", async () => {
    const client = fakeSms();
    setCleanerTwilioClient(client);
    const env = envFor("*");
    expect(await sendLiveSms(env, { to: STRANGER, body: "opt in" })).toBeTruthy();
    expect(await sendLiveSms(env, { to: CLEANER_LINE, body: "loop" })).toBeUndefined();
    expect(client.sent.map((item) => item.to)).toEqual([STRANGER]);
    await expect(sendLiveGroup(env, { audience: [STRANGER, CLEANER_LINE], body: "hello" })).rejects.toBeInstanceOf(GroupNotConfirmed);
    expect(await sendLiveGroup(env, { audience: [STRANGER], body: "hello" })).toEqual({ sid: "SM2" });
    expect(client.sent.map((item) => item.to)).toEqual([STRANGER, STRANGER]);
  });

  it("runs checks for unlisted host and cleaner, and a stranger's YES gets nothing", async () => {
    const client = fakeSms();
    setCleanerTwilioClient(client);
    calendar();
    const { desk, close } = await readyDesk(envFor("*"));
    try {
      expect((await desk.runChecks()).ok).toBe(true);
      await desk.inbound({ id: "stranger-yes", from: STRANGER, text: "YES" });
      expect(client.sent.filter((item) => item.to === STRANGER)).toEqual([]);
      expect(client.sent.some((item) => item.body.includes(DOOR))).toBe(false);
    } finally {
      close();
    }
  });
});
