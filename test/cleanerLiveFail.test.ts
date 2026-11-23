import { approvedTool } from "./hostApproval";
import { afterEach, describe, expect, it } from "vitest";
import { liveDeskFor, resetLiveDesks, setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";
import {
  CALENDAR_URL,
  CLEANER_TOKEN,
  type ToolResult,
  type WiredApp,
  startWiredApp,
} from "./wiringProof";
import { codeSends, isTo, newTexts, outboxTexts, type OutboxText } from "./scratchOutbox";

const LANE = SCRATCH_TENANTS[0];
const HOST = "+15555550115";
const OBSERVER = "+15555550142";
const PIN_SENT = "I sent the door code to the cleaner. I'll tell you if it doesn't go through.";
const PIN_FAILED = "The door code didn't reach the cleaner. Tell your Grok Bot the guests have left and I'll resend it.";
const PIN_REPEAT = "I already sent the door code to the cleaner.";
const STOP_ACK = "You're opted out of cleaning texts for 12 Scratch Lane, Teaneck, NJ 07666. You won't get cleaning offers or the door code. Reply START to opt back in. Reply HELP for help.";
const HOST_STOP = "You're opted out of cleaning texts for 12 Scratch Lane, Teaneck, NJ 07666, and the cleaning there is on hold. Reply START to get texts again.";
const HOST_START = "You'll get cleaning texts for 12 Scratch Lane, Teaneck, NJ 07666 again. The cleaning is still on hold. Tell your Grok Bot to restart it.";
const INJURY_HOLD = "The cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is on hold because the cleaner reported an injury. Once everyone's okay, tell your Grok Bot to restart it.";
const OWNER_HOLD = "The cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is on hold because you opted out of texts. Tell your Grok Bot to restart it.";
const CLEANER_HOLD = "The cleaner opted out of cleaning texts for 12 Scratch Lane, Teaneck, NJ 07666, so the cleaning is on hold. Find another cleaner or reach them directly, then tell your Grok Bot to restart it.";

const open: WiredApp[] = [];

afterEach(async () => {
  setCleanerTwilioClient(undefined);
  setCleanerGroupFetch(undefined);
  setCleanerCalendarFetch(undefined);
  resetLiveDesks();
  while (open.length > 0) {
    const app = open.pop();
    if (app) await app.close();
  }
});

function nextOf(result: ToolResult): string {
  const next = result.structured?.next;
  if (typeof next !== "string") throw new Error(result.text);
  return next;
}

function notesOf(result: ToolResult): string[] {
  const notes = result.structured?.notes;
  if (notes === undefined) return [];
  if (!Array.isArray(notes) || notes.some((line) => typeof line !== "string")) throw new Error(result.text);
  return notes as string[];
}

function linesOf(result: ToolResult): string[] {
  const lines = result.structured?.lines;
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) throw new Error(result.text);
  return lines as string[];
}

async function scratchApp(): Promise<WiredApp> {
  if (!LANE) throw new Error("missing lane");
  const started = await startWiredApp({
    scratchTools: true,
    allowlist: `${HOST},${LANE.cleanerPhone},${OBSERVER}`,
  });
  open.push(started);
  return started;
}

async function call(wired: WiredApp, name: string, args?: Record<string, unknown>): Promise<ToolResult> {
  return wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, name, args);
}

async function saveLane(wired: WiredApp): Promise<void> {
  if (!LANE) throw new Error("missing lane");
  expect((await call(wired, "get_state", { choice: "cleaners" })).isError).toBe(false);
  expect((await call(wired, "save_property", { business: "Scratch", address: LANE.property.address, timeZone: "America/New_York" })).isError).toBe(false);
  expect((await call(wired, "save_people", { host: HOST, cleaner: LANE.cleanerPhone, observer: OBSERVER })).isError).toBe(false);
  expect((await call(wired, "save_calendar_link", { url: CALENDAR_URL })).isError).toBe(false);
  expect((await call(wired, "save_door_code", { code: LANE.pin })).isError).toBe(false);
  expect((await call(wired, "set_up_texting")).isError).toBe(false);
  expect((await call(wired, "run_checks")).isError).toBe(false);
}

async function confirmJob(wired: WiredApp): Promise<void> {
  if (!LANE) throw new Error("missing lane");
  expect((await call(wired, "confirm_times", { checkout: "10:30", checkIn: "15:00" })).isError).toBe(false);
  expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "YES" }))).toBe("The test text went through.");
  expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "YES" }))).toBe("The test text went through.");
}

/** What went out so far. A Scratch property's texts stay in the outbox and never reach Twilio. */
async function out(wired: WiredApp): Promise<OutboxText[]> {
  return outboxTexts(await call(wired, "read_outbox"));
}

async function codeTexts(wired: WiredApp): Promise<OutboxText[]> {
  return (await out(wired)).filter((item) => item.body.includes("Door code:"));
}

async function count(wired: WiredApp, body: string): Promise<number> {
  return (await out(wired)).filter((item) => item.body === body).length;
}

function pairs(texts: OutboxText[]): [string, string][] {
  return texts.map((item) => [item.label, item.body]);
}

const CODE_TEXT = "Guests have left 12 Scratch Lane, Teaneck, NJ 07666. Door code: [redacted]. This code is only for you. Reply DONE when the cleaning is finished.";

describe("failed reports, holds, and STOP on the live Scratch lane", () => {
  // A Scratch property's texts stay in the outbox and never reach Twilio, so these read what went out from it.
  afterEach(() => {
    for (const wired of open) expect(wired.cleanerSent).toEqual([]);
  });

  it("a failed or undelivered report tells Cory once and the next guests left sends the code once", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp();
    await saveLane(wired);
    await confirmJob(wired);
    const left = await call(wired, "mark_guests_left", { confirmed: true });
    expect(nextOf(left)).toBe(PIN_SENT);
    expect(pairs(await codeTexts(wired))).toEqual([["Door code text to the cleaner", CODE_TEXT]]);
    expect(codeSends(wired.root)).toBe(1);

    expect(nextOf(await call(wired, "report_delivery", { which: "Door code text to the cleaner", status: "failed" }))).toBe("Door code text to the cleaner: failed.");
    const failed = await call(wired, "get_state");
    expect(nextOf(failed)).toBe(PIN_FAILED);
    expect(failed.text).not.toContain(PIN_SENT);
    expect((await codeTexts(wired)).map((item) => item.status)).toEqual(["failed"]);
    expect((await out(wired)).filter((item) => item.body === PIN_FAILED).map((item) => item.label)).toEqual(["Door code problem to the host"]);
    const turns = await call(wired, "get_turns");
    expect(turns.text).not.toContain("\"status\":\"cleared\"");

    const late = await call(wired, "report_delivery", { which: "Door code text to the cleaner", status: "delivered" });
    expect(nextOf(late)).toBe("Door code text to the cleaner: failed.");
    expect(nextOf(await call(wired, "get_state"))).not.toBe(PIN_SENT);
    expect((await codeTexts(wired)).map((item) => item.status)).toEqual(["failed"]);
    expect(await count(wired, PIN_FAILED)).toBe(1);

    const resent = await call(wired, "mark_guests_left", { confirmed: true });
    expect(nextOf(resent)).toBe(PIN_SENT);
    // The resent code takes the same outbox line, back to sent. The saved transcript counts the sends themselves.
    expect((await codeTexts(wired)).map((item) => item.status)).toEqual(["sent"]);
    expect(codeSends(wired.root)).toBe(2);

    expect(nextOf(await call(wired, "report_delivery", { which: "Door code text to the cleaner", status: "undelivered" }))).toBe("Door code text to the cleaner: undelivered.");
    expect(nextOf(await call(wired, "get_state"))).toBe(PIN_FAILED);
    expect(await count(wired, PIN_FAILED)).toBe(2);
    expect(nextOf(await call(wired, "report_delivery", { which: "Door code text to the cleaner", status: "undelivered" }))).toBe("Door code text to the cleaner: undelivered.");
    expect(await count(wired, PIN_FAILED)).toBe(2);
    expect(nextOf(await call(wired, "report_delivery", { which: "Door code text to the cleaner", status: "delivered" }))).toBe("Door code text to the cleaner: undelivered.");
    const again = await call(wired, "mark_guests_left", { confirmed: true });
    expect(nextOf(again)).toBe(PIN_SENT);
    expect((await codeTexts(wired)).map((item) => item.status)).toEqual(["sent"]);
    expect(codeSends(wired.root)).toBe(3);
    expect(nextOf(await call(wired, "report_delivery", { which: "Door code text to the cleaner", status: "delivered" }))).toBe("Door code text to the cleaner: delivered.");
    expect(nextOf(await call(wired, "mark_guests_left", { confirmed: true }))).toBe(PIN_REPEAT);
    expect((await codeTexts(wired)).map((item) => item.status)).toEqual(["delivered"]);
    expect(codeSends(wired.root)).toBe(3);
    expect(JSON.stringify(await out(wired))).not.toContain(LANE.pin);
  }, 40_000);

  it("holds the job after an injury and sends no code until Cory resumes", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp();
    await saveLane(wired);
    await confirmJob(wired);
    const before = await out(wired);
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "I fell and I'm hurt" }))).toBe("The test text went through.");
    const state = await call(wired, "get_state");
    expect(nextOf(state)).toBe(INJURY_HOLD);
    expect(state.text).toContain("\"held\":true");
    const blocked = await call(wired, "mark_guests_left", { confirmed: true });
    expect(nextOf(blocked)).toBe(INJURY_HOLD);
    expect(blocked.text).not.toContain("I sent the door code");
    expect(await codeTexts(wired)).toEqual([]);
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "START" }))).toBe("The test text went through.");
    expect((await call(wired, "get_state")).text).toContain(INJURY_HOLD);
    expect(nextOf(await call(wired, "mark_guests_left", { confirmed: true }))).toBe(INJURY_HOLD);
    expect(await codeTexts(wired)).toEqual([]);
    const resumed = await approvedTool((args) => call(wired, "resume_job", args));
    expect(resumed.text).toContain("The cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is back on.");
    expect(nextOf(await call(wired, "get_state"))).not.toBe(INJURY_HOLD);
    expect((await call(wired, "get_turns")).text).not.toContain("\"held\":true");
    expect(nextOf(await call(wired, "mark_guests_left", { confirmed: true }))).toBe(PIN_SENT);
    expect(await codeTexts(wired)).toHaveLength(1);
    const added = newTexts(before, await out(wired));
    expect(added.filter((item) => item.body === PIN_FAILED || item.body === PIN_REPEAT)).toEqual([]);
    expect(added.some((item) => isTo(item, "host") && item.body.includes("someone is hurt"))).toBe(true);
  }, 40_000);

  it("handles host STOP and START before the departure return, and a repeat sends nothing", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp();
    await saveLane(wired);
    await confirmJob(wired);
    const before = await out(wired);
    expect(nextOf(await call(wired, "send_test_text", { from: HOST, text: "don't stop by early" }))).toBe("The test text went through.");
    expect(newTexts(before, await out(wired))).toEqual([]);
    expect((await call(wired, "get_turns")).text).not.toContain("\"held\":true");

    const spellings = ["STOP", "Stop.", "stop", "UNSUBSCRIBE"];
    for (const text of spellings) {
      const sentBefore = await out(wired);
      expect(nextOf(await call(wired, "send_test_text", { from: HOST, text }))).toBe("The test text went through.");
      expect(pairs(newTexts(sentBefore, await out(wired)))).toEqual([["Hold note to the host", HOST_STOP]]);
      const state = await call(wired, "get_state");
      expect(state.text).toContain(OWNER_HOLD);
      expect(state.text).toContain("\"held\":true");
      expect(nextOf(await call(wired, "mark_guests_left", { confirmed: true }))).toBe(OWNER_HOLD);
      expect(await codeTexts(wired)).toEqual([]);
      const repeatBefore = await out(wired);
      const notesBefore = ((await call(wired, "get_state")).structured?.notes as string[] | undefined)?.length ?? 0;
      expect(nextOf(await call(wired, "send_test_text", { from: HOST, text }))).toBe("The test text went through.");
      expect(newTexts(repeatBefore, await out(wired))).toEqual([]);
      const notesAfter = ((await call(wired, "get_state")).structured?.notes as string[] | undefined)?.length ?? 0;
      expect(notesAfter).toBe(notesBefore);
      if (text !== "UNSUBSCRIBE") {
        expect(nextOf(await call(wired, "send_test_text", { from: HOST, text: "START" }))).toBe("The test text went through.");
        expect((await call(wired, "get_state")).text).toContain(OWNER_HOLD);
      }
    }
    expect(linesOf(await call(wired, "read_inbox"))).toContain("Text from the host: STOP.");

    const startBefore = await out(wired);
    expect(nextOf(await call(wired, "send_test_text", { from: HOST, text: "START" }))).toBe("The test text went through.");
    expect(pairs(newTexts(startBefore, await out(wired)))).toEqual([["Start note to the host", HOST_START]]);
    const afterStart = await call(wired, "get_state");
    expect(afterStart.text).toContain(OWNER_HOLD);
    expect(afterStart.text).toContain(HOST_START);
    expect(afterStart.text).toContain(HOST_STOP);
    expect(nextOf(await call(wired, "mark_guests_left", { confirmed: true }))).toBe(OWNER_HOLD);
    expect(await codeTexts(wired)).toEqual([]);
    expect((await approvedTool((args) => call(wired, "resume_job", args))).text).toContain("is back on");
    expect(nextOf(await call(wired, "mark_guests_left", { confirmed: true }))).toBe(PIN_SENT);
    expect(await codeTexts(wired)).toHaveLength(1);
  }, 40_000);

  it("a second STOP from the cleaner sends nothing and adds no note", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp();
    await saveLane(wired);
    await confirmJob(wired);
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "STOP" }))).toBe("The test text went through.");
    expect((await out(wired)).filter((item) => item.body === STOP_ACK).map((item) => item.label)).toEqual(["Opt-out text to the cleaner"]);
    const notesOnce = linesOf(await call(wired, "read_outbox")).filter((line) => line.startsWith("Hold note") || line.startsWith("Opt-out"));
    const sentOnce = await out(wired);
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "STOP" }))).toBe("The test text went through.");
    expect(newTexts(sentOnce, await out(wired))).toEqual([]);
    expect(linesOf(await call(wired, "read_outbox")).filter((line) => line.startsWith("Hold note") || line.startsWith("Opt-out"))).toEqual(notesOnce);
    const state = await call(wired, "get_state");
    expect(state.text).toContain(CLEANER_HOLD);
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "START" }))).toBe("The test text went through.");
    expect((await call(wired, "get_state")).text).toContain("on hold");
    expect(nextOf(await call(wired, "mark_guests_left", { confirmed: true }))).toBe(CLEANER_HOLD);
    expect(await codeTexts(wired)).toEqual([]);
    expect((await approvedTool((args) => call(wired, "resume_job", args))).isError).toBe(false);
    expect(nextOf(await call(wired, "mark_guests_left", { confirmed: true }))).toBe(PIN_SENT);
    expect(await codeTexts(wired)).toHaveLength(1);
  }, 40_000);

  it("runs offer, confirm, guests left, the private code, START, and DONE with no extra texts", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp();
    await saveLane(wired);
    await confirmJob(wired);
    expect(nextOf(await call(wired, "mark_guests_left", { confirmed: true }))).toBe(PIN_SENT);
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "START" }))).toBe("The test text went through.");
    expect((await call(wired, "get_turns")).text).toContain("\"status\":\"in_progress\"");
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "DONE" }))).toBe("The test text went through.");
    expect((await call(wired, "get_turns")).text).toContain("\"status\":\"done\"");
    const texts = await out(wired);
    const bodies = texts.map((item) => item.body);
    expect(bodies.filter((body) => body.includes("Reply YES to schedule it"))).toHaveLength(1);
    expect(bodies.filter((body) => body.startsWith("Cleaning is scheduled for "))).toHaveLength(1);
    expect(bodies.filter((body) => body.includes("Door code:"))).toHaveLength(1);
    expect(bodies.filter((body) => body === "Got it, cleaning started.")).toHaveLength(1);
    expect(bodies.filter((body) => body === "Thanks, cleaning marked done.")).toHaveLength(1);
    expect(bodies.filter((body) => body === PIN_FAILED || body === INJURY_HOLD || body === OWNER_HOLD || body === CLEANER_HOLD)).toEqual([]);
    expect(texts.filter((item) => !isTo(item, "cleaner") && !isTo(item, "host"))).toEqual([]);
  }, 40_000);

  it("sends Cory nothing after STOP when the door code fails, and get_state still shows the failed line", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp();
    await saveLane(wired);
    await confirmJob(wired);
    expect(nextOf(await call(wired, "mark_guests_left", { confirmed: true }))).toBe(PIN_SENT);
    expect(pairs(await codeTexts(wired))).toEqual([["Door code text to the cleaner", CODE_TEXT]]);
    const beforeStop = await out(wired);
    expect(nextOf(await call(wired, "send_test_text", { from: HOST, text: "STOP" }))).toBe("The test text went through.");
    expect(pairs(newTexts(beforeStop, await out(wired)))).toEqual([["Hold note to the host", HOST_STOP]]);
    const afterStop = await out(wired);
    expect(nextOf(await call(wired, "report_delivery", { which: "Door code text to the cleaner", status: "failed" }))).toBe("Door code text to the cleaner: failed.");
    expect(newTexts(afterStop, await out(wired)).filter((item) => isTo(item, "host") && item.status !== "unsent")).toEqual([]);
    expect(nextOf(await call(wired, "get_state"))).toBe(PIN_FAILED);
    expect(await codeTexts(wired)).toHaveLength(1);
    expect(JSON.stringify(await out(wired))).not.toContain(LANE.pin);
  }, 40_000);

  it("keeps the other host lines in get_state and off Twilio after Cory opts out", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp();
    await saveLane(wired);
    await confirmJob(wired);
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "STOP" }))).toBe("The test text went through.");
    const beforeStop = await out(wired);
    expect(nextOf(await call(wired, "send_test_text", { from: HOST, text: "STOP" }))).toBe("The test text went through.");
    expect(pairs(newTexts(beforeStop, await out(wired)))).toEqual([["Hold note to the host", HOST_STOP]]);
    const afterStop = await out(wired);
    const resumed = await approvedTool((args) => call(wired, "resume_job", args));
    const backOn = "The cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is back on.";
    const held = "The cleaner opted out, so the door code wasn't sent. Please reach them directly.";
    expect(resumed.text).toContain(backOn);
    // Lines to an opted-out host are kept, marked unsent.
    expect(newTexts(afterStop, await out(wired)).filter((item) => item.status !== "unsent")).toEqual([]);
    expect(notesOf(await call(wired, "get_state"))).toContain(backOn);
    expect(nextOf(await call(wired, "mark_guests_left", { confirmed: true }))).toBe(held);
    expect(newTexts(afterStop, await out(wired)).filter((item) => item.status !== "unsent")).toEqual([]);
    expect(await codeTexts(wired)).toEqual([]);
    const notes = notesOf(await call(wired, "get_state"));
    expect(notes).toContain(backOn);
    expect(notes).toContain(held);
    expect(JSON.stringify(await out(wired))).not.toContain(LANE.pin);
  }, 40_000);

  it("after STOP, a reminder and DONE text Cory nothing and the job stays unfinished", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp();
    await saveLane(wired);
    await confirmJob(wired);
    expect(nextOf(await call(wired, "mark_guests_left", { confirmed: true }))).toBe(PIN_SENT);
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "START" }))).toBe("The test text went through.");
    expect((await call(wired, "get_turns")).text).toContain("\"status\":\"in_progress\"");
    const beforeStop = await out(wired);
    expect(nextOf(await call(wired, "send_test_text", { from: HOST, text: "STOP" }))).toBe("The test text went through.");
    expect(pairs(newTexts(beforeStop, await out(wired)))).toEqual([["Hold note to the host", HOST_STOP]]);
    const afterStop = await out(wired);
    await liveDeskFor(wired.root, () => process.env, () => new Date()).runReminders();
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "DONE" }))).toBe("The test text went through.");
    const after = newTexts(afterStop, await out(wired));
    expect(after.filter((item) => isTo(item, "host") && item.status !== "unsent")).toEqual([]);
    expect(pairs(after)).toEqual([["Next step to the cleaner", "The cleaning is on hold. I'll send an update when it can start again."]]);
    expect((await call(wired, "get_turns")).text).toContain("\"status\":\"in_progress\"");
    expect((await call(wired, "get_turns")).text).not.toContain("\"status\":\"done\"");
    expect(nextOf(await call(wired, "get_state"))).toBe(OWNER_HOLD);
    expect(JSON.stringify(await out(wired))).not.toContain(LANE.pin);
    const repeat = await out(wired);
    expect(nextOf(await call(wired, "send_test_text", { from: HOST, text: "STOP" }))).toBe("The test text went through.");
    expect(newTexts(repeat, await out(wired))).toEqual([]);
  }, 40_000);
});
