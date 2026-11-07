import { fixedCodePort } from "../src/cleaner-core/doorPort";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { groupInviteBody, hostDoneLine, hostStopReply } from "../src/cleaner-core/cleanerTexts";
import { openCleanerCore, type CleanerText } from "../src/cleaner-core/core";
import { setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { isScratchTestNumber } from "../src/cleaner-core/scratch";
import { SCRATCH_TENANTS, type ScratchTenant } from "../src/cleaner-core/tenants";
import type { TwilioClient } from "../src/messaging/twilio/client";
import { ADDRESS, CLEANER_AUTH, CLEANER_LINE, CLEANER_TOKEN, DOOR_CODE, type ToolResult, type WiredApp, startWiredApp } from "./wiringProof";

const laneTenant = SCRATCH_TENANTS[0];
const courtTenant = SCRATCH_TENANTS[1];
if (!laneTenant || !courtTenant) throw new Error("missing tenant");
const LANE: ScratchTenant = laneTenant;
const COURT: ScratchTenant = courtTenant;

const HOST = LANE.ownerPhone;
const CLEANER = LANE.cleanerPhone;
const CHECKOUT = "9:00 AM";
const CHECK_IN = "4:00 PM";
const SAVED = "Test turnover saved. Anyone who has not replied YES got only the opt-in text.";
const ALREADY = "That test turnover is already saved.";
const NOTHING = "Test turnover saved. Nothing was sent.";
const WENT = "The test text went through.";
const PROPERTY_REFUSAL = "That only works on the Scratch test property.";
const NUMBER_REFUSAL = "That only works with 555 test numbers.";
// No host name is saved, so the invite names the business. The host gets no invite in group mode.
const CLEANER_OPT = groupInviteBody("Scratch", LANE.property.address);
const READY = hostDoneLine(LANE.property.address);
const HOST_STOP = hostStopReply(LANE.property.address, true);
const HOST_STOP_OPEN = hostStopReply(LANE.property.address, false);
const CLEANER_STOP = `You're opted out of cleaning texts for ${LANE.property.address}. You won't get cleaning offers or the door code. Reply START to opt back in. Reply HELP for help.`;
const REAL_NUMBER = ["+1", "212", "555", "1234"].join("");
/** Fixture phones just outside the scratch 555-0100–0199 block. Joined so they are not a real person's number. */
const SAVED_HOST = ["+1", "201", "555", "0200"].join("");
const SAVED_CLEANER = ["+1", "201", "555", "0201"].join("");

const open: WiredApp[] = [];
const engineRoots: string[] = [];
let calendarReads = 0;
let groupCalls = 0;
let twilioCalls = 0;

afterEach(async () => {
  setCleanerTwilioClient(undefined);
  setCleanerGroupFetch(undefined);
  setCleanerCalendarFetch(undefined);
  calendarReads = 0;
  groupCalls = 0;
  twilioCalls = 0;
  while (open.length > 0) {
    const app = open.pop();
    if (app) await app.close();
  }
  for (const root of engineRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function throwingClient(): TwilioClient {
  return {
    async getAccount() {
      twilioCalls += 1;
      throw new Error("twilio called");
    },
    async findNumber() {
      twilioCalls += 1;
      throw new Error("twilio called");
    },
    async setSmsUrl() {
      twilioCalls += 1;
      throw new Error("twilio called");
    },
    async sendSms() {
      twilioCalls += 1;
      throw new Error("twilio called");
    },
  };
}

async function scratchApp(options?: { groupChat?: boolean; allowlist?: string; scratchTools?: boolean; blockSms?: boolean }): Promise<WiredApp> {
  const started = await startWiredApp({
    scratchTools: options?.scratchTools !== false,
    allowlist: options?.allowlist,
    groupChat: options?.groupChat,
  });
  open.push(started);
  setCleanerCalendarFetch(async () => {
    calendarReads += 1;
    throw new Error("calendar read");
  });
  setCleanerGroupFetch(async () => {
    groupCalls += 1;
    throw new Error("group send");
  });
  if (options?.blockSms) setCleanerTwilioClient(throwingClient());
  return started;
}

function nextOf(result: ToolResult): string {
  const next = result.structured?.next;
  if (typeof next !== "string") throw new Error("missing next");
  return next;
}

function turnsOf(result: ToolResult): Record<string, unknown>[] {
  const turns = result.structured?.turns;
  if (!Array.isArray(turns)) throw new Error("missing turns");
  return turns as Record<string, unknown>[];
}

function linesOf(result: ToolResult): string[] {
  const lines = result.structured?.lines;
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) throw new Error("missing lines");
  return lines as string[];
}

async function call(wired: WiredApp, name: string, args?: Record<string, unknown>): Promise<ToolResult> {
  return wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, name, args);
}

function containsCode(text: string): boolean {
  return text.includes(LANE.pin) || text.includes(COURT.pin);
}

/**
 * A scratch code standing alone as a number. Saved files also hold random ids (event ids, hashes,
 * secrets) that can contain the same four digits by chance, so a match inside a longer token is not
 * a leak. A leaked code is always set apart, as in `Door code: <code>.` or a quoted JSON value.
 */
function containsStandaloneCode(text: string): boolean {
  return [LANE.pin, COURT.pin].some((pin) => new RegExp(`(?<![A-Za-z0-9_-])${pin}(?![A-Za-z0-9_-])`).test(text));
}

function treeContainsCode(dir: string): boolean {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (treeContainsCode(path)) return true;
      continue;
    }
    if (containsStandaloneCode(readFileSync(path, "utf8"))) return true;
  }
  return false;
}

function redact(text: string): string {
  return text.split(LANE.pin).join("[redacted]").split(COURT.pin).join("[redacted]");
}

function shown(sent: { to: string; body: string }[]): { to: string; body: string }[] {
  return sent.map((item) => ({ to: item.to, body: redact(item.body) }));
}

async function saveLane(wired: WiredApp, people?: { host?: string; cleaner?: string }): Promise<void> {
  const host = people?.host ?? HOST;
  const cleaner = people?.cleaner ?? CLEANER;
  await call(wired, "get_state", { choice: "cleaners" });
  await call(wired, "save_property", { business: "Scratch", address: LANE.property.address, timeZone: LANE.property.timeZone });
  await call(wired, "save_people", { host, cleaner });
  const saved = await call(wired, "save_door_code", { code: LANE.pin });
  expect(saved.isError).toBe(false);
  await call(wired, "set_up_texting");
}

let inboundSid = 0;

async function textIn(wired: WiredApp, from: string, body: string): Promise<void> {
  inboundSid += 1;
  const result = await wired.postTwilio("/webhooks/twilio/cleaner-core", {
    from,
    to: CLEANER_LINE,
    body,
    sid: `SM-saved-${inboundSid}`,
    token: CLEANER_AUTH,
  });
  expect(result.status).toBe(200);
  expect(containsCode(result.raw)).toBe(false);
}

describe("Scratch test turnover", () => {
  it("finds a door code saved in a file, and not four matching digits inside a random id", () => {
    for (const pin of [LANE.pin, COURT.pin]) {
      expect(containsStandaloneCode(`Door code: ${pin}. Reply DONE.`)).toBe(true);
      expect(containsStandaloneCode(`{"pin":"${pin}"}`)).toBe(true);
      expect(containsStandaloneCode(`evt_f5060a${pin}b9d1`)).toBe(false);
      expect(containsStandaloneCode(`9${pin}0`)).toBe(false);
    }
  });

  it("refuses any property that is not Scratch", async () => {
    const practice = await scratchApp({
      blockSms: true,
      groupChat: true,
      allowlist: `${HOST},${CLEANER}`,
    });
    await call(practice, "get_state", { choice: "cleaners" });
    await call(practice, "save_property", { business: "Harbor", address: ADDRESS, timeZone: "America/New_York" });
    await call(practice, "save_people", { host: HOST, cleaner: CLEANER });
    await call(practice, "save_calendar_link", { url: "https://calendar.example/harbor.ics" });
    await call(practice, "save_door_code", { code: DOOR_CODE });
    await call(practice, "set_up_texting");
    const refused = await call(practice, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(PROPERTY_REFUSAL);
    expect(containsCode(refused.text)).toBe(false);
    expect(containsCode(refused.raw)).toBe(false);
    const savedOffScratch = await scratchApp({
      blockSms: true,
      groupChat: true,
      allowlist: `${SAVED_HOST},${SAVED_CLEANER}`,
    });
    await call(savedOffScratch, "get_state", { choice: "cleaners" });
    await call(savedOffScratch, "save_property", { business: "Harbor", address: ADDRESS, timeZone: "America/New_York" });
    await call(savedOffScratch, "save_people", { host: SAVED_HOST, cleaner: SAVED_CLEANER });
    await call(savedOffScratch, "save_calendar_link", { url: "https://calendar.example/harbor.ics" });
    await call(savedOffScratch, "save_door_code", { code: DOOR_CODE });
    await call(savedOffScratch, "set_up_texting");
    const refusedSaved = await call(savedOffScratch, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN });
    expect(refusedSaved.isError).toBe(true);
    expect(refusedSaved.text).toBe(PROPERTY_REFUSAL);
    expect(containsCode(refusedSaved.text)).toBe(false);
    expect(savedOffScratch.cleanerSent).toEqual([]);
    expect(calendarReads).toBe(0);
    expect(groupCalls).toBe(0);
    expect(twilioCalls).toBe(0);
  });

  it("on Scratch, creates one turnover for the saved host and cleaner when they are not 555 numbers", async () => {
    expect(isScratchTestNumber(SAVED_HOST)).toBe(false);
    expect(isScratchTestNumber(SAVED_CLEANER)).toBe(false);
    expect(SAVED_HOST).not.toBe(REAL_NUMBER);
    expect(SAVED_CLEANER).not.toBe(REAL_NUMBER);

    const waiting = await scratchApp({ groupChat: true, allowlist: `${SAVED_HOST},${SAVED_CLEANER}` });
    await saveLane(waiting, { host: SAVED_HOST, cleaner: SAVED_CLEANER });
    const created = await call(waiting, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN });
    expect(created.isError).toBe(false);
    expect(nextOf(created)).toBe(SAVED);
    expect(turnsOf(created)).toEqual([
      expect.objectContaining({
        checkoutDate: "2026-10-14",
        nextCheckInDate: "2026-10-14",
        checkoutTime: "9:00 AM",
        nextCheckInTime: "4:00 PM",
        status: "host_confirmed",
      }),
    ]);
    expect(shown(waiting.cleanerSent)).toEqual([
      { to: SAVED_CLEANER, body: CLEANER_OPT },
    ]);
    expect(waiting.cleanerSent.some((item) => item.body.startsWith("Turnover at"))).toBe(false);
    const again = await call(waiting, "add_test_turn", { checkout: "10:00 AM", checkIn: "5:00 PM" });
    expect(nextOf(again)).toBe(ALREADY);
    expect(turnsOf(again)).toHaveLength(1);
    expect(turnsOf(again)[0]).toMatchObject({ checkoutTime: "9:00 AM", nextCheckInTime: "4:00 PM" });
    expect(shown(waiting.cleanerSent)).toEqual([
      { to: SAVED_CLEANER, body: CLEANER_OPT },
    ]);
    const injected = await call(waiting, "send_test_text", { from: SAVED_CLEANER, text: "YES" });
    expect(injected.isError).toBe(true);
    expect(injected.text).toBe(NUMBER_REFUSAL);
    expect(waiting.cleanerSent.filter((item) => item.body.startsWith("Turnover at"))).toEqual([]);

    const cleanerOut = await scratchApp({ groupChat: true, allowlist: `${SAVED_HOST},${SAVED_CLEANER}` });
    await saveLane(cleanerOut, { host: SAVED_HOST, cleaner: SAVED_CLEANER });
    expect(nextOf(await call(cleanerOut, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN }))).toBe(SAVED);
    const cleanerStopAt = cleanerOut.cleanerSent.length;
    await textIn(cleanerOut, SAVED_CLEANER, "STOP");
    expect(shown(cleanerOut.cleanerSent.slice(cleanerStopAt)).filter((item) => item.to === SAVED_CLEANER)).toEqual([
      { to: SAVED_CLEANER, body: CLEANER_STOP },
    ]);
    const cleanerAfterStop = cleanerOut.cleanerSent.length;
    await textIn(cleanerOut, SAVED_CLEANER, "YES");
    expect(nextOf(await call(cleanerOut, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN }))).toBe(ALREADY);
    expect(cleanerOut.cleanerSent.slice(cleanerAfterStop).filter((item) => item.to === SAVED_CLEANER)).toEqual([]);
    expect(turnsOf(await call(cleanerOut, "get_turns"))).toHaveLength(1);
    expect(cleanerOut.cleanerSent.some((item) => item.body.startsWith("Turnover at") || item.body.includes("Door code:"))).toBe(false);

    const hostOut = await scratchApp({ groupChat: true, allowlist: `${SAVED_HOST},${SAVED_CLEANER}` });
    await saveLane(hostOut, { host: SAVED_HOST, cleaner: SAVED_CLEANER });
    expect(nextOf(await call(hostOut, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN }))).toBe(SAVED);
    const hostStopAt = hostOut.cleanerSent.length;
    await textIn(hostOut, SAVED_HOST, "STOP");
    expect(shown(hostOut.cleanerSent.slice(hostStopAt)).filter((item) => item.to === SAVED_HOST)).toEqual([
      { to: SAVED_HOST, body: HOST_STOP },
    ]);
    const hostAfterStop = hostOut.cleanerSent.length;
    await textIn(hostOut, SAVED_CLEANER, "YES");
    expect(nextOf(await call(hostOut, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN }))).toBe(ALREADY);
    expect(hostOut.cleanerSent.slice(hostAfterStop).filter((item) => item.to === SAVED_HOST)).toEqual([]);
    expect(turnsOf(await call(hostOut, "get_turns"))).toHaveLength(1);
    expect(hostOut.cleanerSent.some((item) => item.body.startsWith("Turnover at") || item.body.includes("Door code:"))).toBe(false);

    const cleanerNever = await scratchApp({ groupChat: true, allowlist: `${SAVED_HOST},${SAVED_CLEANER}` });
    await saveLane(cleanerNever, { host: SAVED_HOST, cleaner: SAVED_CLEANER });
    await textIn(cleanerNever, SAVED_CLEANER, "STOP");
    expect(nextOf(await call(cleanerNever, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN }))).toBe(NOTHING);
    expect(shown(cleanerNever.cleanerSent)).toEqual([
      { to: SAVED_CLEANER, body: CLEANER_STOP },
    ]);
    expect(cleanerNever.cleanerSent.some((item) => item.body.startsWith("Turnover at"))).toBe(false);

    const hostNever = await scratchApp({ groupChat: true, allowlist: `${SAVED_HOST},${SAVED_CLEANER}` });
    await saveLane(hostNever, { host: SAVED_HOST, cleaner: SAVED_CLEANER });
    await textIn(hostNever, SAVED_HOST, "STOP");
    expect(nextOf(await call(hostNever, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN }))).toBe(SAVED);
    expect(shown(hostNever.cleanerSent)).toEqual([
      { to: SAVED_HOST, body: HOST_STOP_OPEN },
      { to: SAVED_CLEANER, body: CLEANER_OPT },
    ]);
    expect(hostNever.cleanerSent.some((item) => item.body.startsWith("Turnover at"))).toBe(false);

    const bothOut = await scratchApp({ groupChat: true, allowlist: `${SAVED_HOST},${SAVED_CLEANER}` });
    await saveLane(bothOut, { host: SAVED_HOST, cleaner: SAVED_CLEANER });
    await textIn(bothOut, SAVED_CLEANER, "STOP");
    await textIn(bothOut, SAVED_HOST, "STOP");
    expect(nextOf(await call(bothOut, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN }))).toBe(NOTHING);
    expect(shown(bothOut.cleanerSent)).toEqual([
      { to: SAVED_CLEANER, body: CLEANER_STOP },
      { to: SAVED_HOST, body: HOST_STOP },
    ]);
    expect(turnsOf(await call(bothOut, "get_turns"))).toHaveLength(1);
    expect(bothOut.cleanerSent.some((item) => item.body.startsWith("Turnover at") || item.body.includes("you're invited"))).toBe(false);

    for (const app of [waiting, cleanerOut, hostOut, cleanerNever, hostNever, bothOut]) {
      expect(app.cleanerSent.every((item) => item.to === SAVED_HOST || item.to === SAVED_CLEANER)).toBe(true);
      expect(app.cleanerSent.every((item) => !containsCode(item.body))).toBe(true);
      expect(app.logs.some(containsCode)).toBe(false);
      expect(treeContainsCode(app.root)).toBe(false);
    }
    expect(calendarReads).toBe(0);
    expect(groupCalls).toBe(0);
    expect(twilioCalls).toBe(0);
  }, 40_000);

  it("hides the tool unless scratch tools are on", async () => {
    const wired = await scratchApp({ scratchTools: false, groupChat: true });
    const listed = await wired.listTools("/mcp/cleaner-core", CLEANER_TOKEN);
    expect(listed.names).not.toContain("add_test_turn");
    const refused = await call(wired, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe("I can't do that from this chat.");
    expect(calendarReads).toBe(0);
  });

  it("creates one turnover without a calendar, waits for guests to leave, and does not duplicate", async () => {
    const wired = await scratchApp({ groupChat: true, allowlist: `${HOST},${CLEANER}` });
    const seen: string[] = [];
    const remember = async (result: Promise<ToolResult>) => {
      const done = await result;
      seen.push(done.text, done.raw);
      return done;
    };
    await saveLane(wired);
    const listed = await wired.listTools("/mcp/cleaner-core", CLEANER_TOKEN);
    expect(listed.raw).toContain("Creates one test turnover from a checkout time and the next check-in. It does not read a calendar. It only works on the Scratch test property.");

    const created = await remember(call(wired, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN }));
    expect(created.isError).toBe(false);
    expect(nextOf(created)).toBe(SAVED);
    expect(turnsOf(created)).toEqual([
      expect.objectContaining({
        checkoutDate: "2026-10-14",
        nextCheckInDate: "2026-10-14",
        checkoutTime: "9:00 AM",
        nextCheckInTime: "4:00 PM",
        status: "host_confirmed",
      }),
    ]);
    const again = await remember(call(wired, "add_test_turn", { checkout: "10:00 AM", checkIn: "5:00 PM" }));
    expect(nextOf(again)).toBe(ALREADY);
    expect(turnsOf(again)).toHaveLength(1);
    expect(turnsOf(again)[0]).toMatchObject({ checkoutTime: "9:00 AM", nextCheckInTime: "4:00 PM" });
    expect(shown(wired.cleanerSent)).toEqual([
      { to: CLEANER, body: CLEANER_OPT },
    ]);
    expect(linesOf(await call(wired, "read_outbox"))).toEqual([
      "Opt-in text to the cleaner: sent.",
    ]);
    expect(wired.cleanerSent.every((item) => isScratchTestNumber(item.to))).toBe(true);

    expect(nextOf(await remember(call(wired, "send_test_text", { from: CLEANER, text: "YES" })))).toBe(WENT);
    expect(wired.cleanerSent.filter((item) => item.body.startsWith("Turnover at")).map((item) => item.to)).toEqual([CLEANER]);
    expect(wired.cleanerSent.filter((item) => item.to === HOST).map((item) => item.body)).toEqual([]);
    expect(nextOf(await remember(call(wired, "send_test_text", { from: CLEANER, text: "YES" })))).toBe(WENT);
    const waiting = await remember(call(wired, "get_turns"));
    expect(turnsOf(waiting)).toEqual([expect.objectContaining({ status: "awaiting_departure" })]);
    expect(wired.cleanerSent.some((item) => item.body.includes("Door code:"))).toBe(false);

    expect(nextOf(await remember(call(wired, "send_test_text", { from: HOST, text: "YES" })))).toBe(WENT);
    const left = await remember(call(wired, "mark_guests_left", { confirmed: true }));
    expect(left.isError).toBe(false);
    expect(left.text).toContain("I sent the door code to the cleaner.");
    const pins = wired.cleanerSent.filter((item) => item.body.includes("Door code:"));
    expect(pins.map((item) => item.to)).toEqual([CLEANER]);
    expect(shown(pins)).toEqual([
      {
        to: CLEANER,
        body: `Guests have left ${LANE.property.address}. Door code: [redacted]. This code is only for you. Reply DONE when the cleaning is finished.`,
      },
    ]);

    expect(nextOf(await remember(call(wired, "send_test_text", { from: CLEANER, text: "START" })))).toBe(WENT);
    expect(turnsOf(await remember(call(wired, "get_turns")))[0]).toMatchObject({ status: "in_progress" });
    expect(nextOf(await remember(call(wired, "send_test_text", { from: CLEANER, text: "DONE" })))).toBe(WENT);
    expect(turnsOf(await remember(call(wired, "get_turns")))[0]).toMatchObject({ status: "done" });
    expect(wired.cleanerSent.filter((item) => item.to === HOST && item.body === READY).map((item) => item.to)).toEqual([HOST]);

    const after = wired.cleanerSent.length;
    expect(nextOf(await remember(call(wired, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN })))).toBe(ALREADY);
    expect(wired.cleanerSent).toHaveLength(after);
    expect(wired.cleanerSent.filter((item) => item.body.startsWith("Turnover at"))).toHaveLength(1);
    expect(turnsOf(await remember(call(wired, "get_turns")))).toHaveLength(1);
    expect(wired.cleanerSent.every((item) => isScratchTestNumber(item.to))).toBe(true);
    expect(wired.cleanerSent.filter((item) => !item.body.includes("Door code:")).every((item) => !containsCode(item.body))).toBe(true);
    expect(seen.some(containsCode)).toBe(false);
    expect(wired.logs.some(containsCode)).toBe(false);
    expect(treeContainsCode(wired.root)).toBe(false);
    expect(linesOf(await call(wired, "read_outbox")).some(containsCode)).toBe(false);
    expect(calendarReads).toBe(0);
    // The host is seated by the test turn, so the engine tries the group (the intro, then the offer) and falls back to a one-to-one text.
    expect(groupCalls).toBeGreaterThanOrEqual(1);
    expect(twilioCalls).toBe(0);
  }, 40_000);

  it("gives the cleaner and the host only an opt-in before YES, and nothing after STOP", async () => {
    const waiting = await scratchApp({ groupChat: true, allowlist: `${HOST},${CLEANER}` });
    await saveLane(waiting);
    expect(nextOf(await call(waiting, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN }))).toBe(SAVED);
    expect(shown(waiting.cleanerSent)).toEqual([
      { to: CLEANER, body: CLEANER_OPT },
    ]);
    expect(waiting.cleanerSent.some((item) => item.body.startsWith("Turnover at"))).toBe(false);

    const cleanerOut = await scratchApp({ groupChat: true, allowlist: `${HOST},${CLEANER}` });
    await saveLane(cleanerOut);
    expect(nextOf(await call(cleanerOut, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN }))).toBe(SAVED);
    const cleanerStopAt = cleanerOut.cleanerSent.length;
    expect(nextOf(await call(cleanerOut, "send_test_text", { from: CLEANER, text: "STOP" }))).toBe(WENT);
    expect(shown(cleanerOut.cleanerSent.slice(cleanerStopAt)).filter((item) => item.to === CLEANER)).toEqual([
      { to: CLEANER, body: CLEANER_STOP },
    ]);
    const cleanerAfterStop = cleanerOut.cleanerSent.length;
    expect(nextOf(await call(cleanerOut, "send_test_text", { from: CLEANER, text: "YES" }))).toBe(WENT);
    expect(nextOf(await call(cleanerOut, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN }))).toBe(ALREADY);
    expect(cleanerOut.cleanerSent.slice(cleanerAfterStop).filter((item) => item.to === CLEANER)).toEqual([]);
    expect(cleanerOut.cleanerSent.some((item) => item.body.startsWith("Turnover at") || item.body.includes("Door code:"))).toBe(false);

    const hostOut = await scratchApp({ groupChat: true, allowlist: `${HOST},${CLEANER}` });
    await saveLane(hostOut);
    expect(nextOf(await call(hostOut, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN }))).toBe(SAVED);
    const hostStopAt = hostOut.cleanerSent.length;
    expect(nextOf(await call(hostOut, "send_test_text", { from: HOST, text: "STOP" }))).toBe(WENT);
    expect(shown(hostOut.cleanerSent.slice(hostStopAt)).filter((item) => item.to === HOST)).toEqual([
      { to: HOST, body: HOST_STOP },
    ]);
    const hostAfterStop = hostOut.cleanerSent.length;
    expect(nextOf(await call(hostOut, "send_test_text", { from: CLEANER, text: "YES" }))).toBe(WENT);
    expect(nextOf(await call(hostOut, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN }))).toBe(ALREADY);
    expect(hostOut.cleanerSent.slice(hostAfterStop).filter((item) => item.to === HOST)).toEqual([]);
    expect(hostOut.cleanerSent.some((item) => item.body.startsWith("Turnover at") || item.body.includes("Door code:"))).toBe(false);

    const cleanerNever = await scratchApp({ groupChat: true, allowlist: `${HOST},${CLEANER}` });
    await saveLane(cleanerNever);
    expect(nextOf(await call(cleanerNever, "send_test_text", { from: CLEANER, text: "STOP" }))).toBe(WENT);
    expect(nextOf(await call(cleanerNever, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN }))).toBe(NOTHING);
    expect(cleanerNever.cleanerSent.filter((item) => item.to === CLEANER)).toEqual([]);
    expect(shown(cleanerNever.cleanerSent)).toEqual([]);
    expect(linesOf(await call(cleanerNever, "read_outbox"))).toContain("Opt-out text to the cleaner: sent.");
    expect(linesOf(await call(cleanerNever, "read_outbox")).some((line) => line.startsWith("Opt-in text to the cleaner") || line.startsWith("Cleaning offer"))).toBe(false);

    const hostNever = await scratchApp({ groupChat: true, allowlist: `${HOST},${CLEANER}` });
    await saveLane(hostNever);
    expect(nextOf(await call(hostNever, "send_test_text", { from: HOST, text: "STOP" }))).toBe(WENT);
    const hostSaved = await call(hostNever, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN });
    expect(nextOf(hostSaved)).toBe(SAVED);
    expect(hostNever.cleanerSent.filter((item) => item.to === HOST)).toEqual([]);
    expect(shown(hostNever.cleanerSent)).toEqual([{ to: CLEANER, body: CLEANER_OPT }]);
    expect(linesOf(await call(hostNever, "read_outbox"))).toContain("Hold note to the host: sent.");
    expect(linesOf(await call(hostNever, "read_outbox")).some((line) => line.startsWith("Opt-in text to the host") || line.startsWith("Cleaning offer"))).toBe(false);

    const bothOut = await scratchApp({ groupChat: true, allowlist: `${HOST},${CLEANER}` });
    await saveLane(bothOut);
    expect(nextOf(await call(bothOut, "send_test_text", { from: CLEANER, text: "STOP" }))).toBe(WENT);
    expect(nextOf(await call(bothOut, "send_test_text", { from: HOST, text: "STOP" }))).toBe(WENT);
    expect(nextOf(await call(bothOut, "add_test_turn", { checkout: CHECKOUT, checkIn: CHECK_IN }))).toBe(NOTHING);
    expect(bothOut.cleanerSent).toEqual([]);
    expect(linesOf(await call(bothOut, "read_outbox")).some((line) => line.startsWith("Cleaning offer") || line.startsWith("Opt-in"))).toBe(false);

    for (const app of [waiting, cleanerOut, hostOut, cleanerNever, hostNever, bothOut]) {
      expect(app.cleanerSent.every((item) => isScratchTestNumber(item.to))).toBe(true);
      expect(app.cleanerSent.every((item) => !containsCode(item.body))).toBe(true);
      expect(app.logs.some(containsCode)).toBe(false);
      expect(treeContainsCode(app.root)).toBe(false);
    }
    expect(calendarReads).toBe(0);
    expect(groupCalls).toBe(0);
    expect(twilioCalls).toBe(0);
  }, 40_000);

  it("still waits to send the door code when a reminder runs after the checkout time", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-test-turn-"));
    engineRoots.push(root);
    const sent: CleanerText[] = [];
    const job = openCleanerCore({
      enabled: true,
      property: { id: LANE.property.id, address: LANE.property.address, timeZone: LANE.property.timeZone },
      ownerPhone: HOST,
      cleaner: { phone: CLEANER, approved: true },
      access: fixedCodePort(LANE.pin),
      hostName: "Scratch",
      consented: true,
      sink: { async send(text) { sent.push(text); } },
      now: () => new Date("2026-10-14T15:00:00.000Z"),
      dataDir: root,
      groupChat: { hostName: "Cory", cleanerName: "Maria" },
    });
    expect(await job.addTestTurn({ checkout: CHECKOUT, checkIn: CHECK_IN })).toEqual({ created: true });
    expect(await job.addTestTurn({ checkout: "10:00 AM", checkIn: "5:00 PM" })).toEqual({ created: false, reason: "exists" });
    expect(sent.map((item) => ({ to: item.to, kind: item.kind }))).toEqual([
      { to: CLEANER, kind: "opt-in" },
    ]);
    await job.receive({ id: "yes-opt", from: CLEANER, text: "YES" });
    await job.receive({ id: "yes-offer", from: CLEANER, text: "YES" });
    expect(job.jobs().map((item) => item.status)).toEqual(["awaiting_departure"]);
    const reminded = await job.runReminders();
    expect(reminded.sent.some((item) => item.kind === "pin")).toBe(false);
    expect(sent.some((item) => item.kind === "pin")).toBe(false);
    await job.receive({ id: "left", from: HOST, text: "guests have left" });
    expect(sent.filter((item) => item.kind === "pin").map((item) => item.to)).toEqual([CLEANER]);
    // The group holds only the host and the cleaner, so the code goes into it.
    expect(sent.filter((item) => item.kind === "pin").every((item) => item.channel === "group" && item.audience?.length === 2)).toBe(true);
    expect(sent.filter((item) => item.kind !== "pin").every((item) => !containsCode(item.body))).toBe(true);
    expect(treeContainsCode(root)).toBe(false);
    expect(job.jobs()).toHaveLength(1);
  });
});
