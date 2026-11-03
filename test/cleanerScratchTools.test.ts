import { approvedTool } from "./hostApproval";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetLiveDesks, setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";
import { setCleanerGroupFetch, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";
import type { TwilioClient } from "../src/messaging/twilio/client";
import {
  ADDRESS,
  CALENDAR_URL,
  CLEANER_TOKEN,
  DOOR_CODE,
  type ToolResult,
  type WiredApp,
  startWiredApp,
} from "./wiringProof";

const LANE = SCRATCH_TENANTS[0];
const COURT = SCRATCH_TENANTS[1];
const LANE_OBSERVER = "+15555550142";
const COURT_OBSERVER = "+15555550152";
const REAL_NUMBER = ["+1", "212", "555", "1234"].join("");
const PIN_SENT = "I sent the door code to the cleaner. I'll tell you if it doesn't go through.";
const PIN_FAILED = "The door code didn't reach the cleaner. Tell your Grok Bot the guests have left and I'll resend it.";
const PIN_REPEAT = "I already sent the door code to the cleaner.";
const PROPERTY_REFUSAL = "That only works on the Scratch test property.";
const NUMBER_REFUSAL = "That only works with 555 test numbers.";
const RESET_LINE = "Scratch is reset. No jobs, notes or test texts are left.";
const WENT_THROUGH = "The test text went through.";

const open: WiredApp[] = [];
let twilioCalls = 0;

afterEach(async () => {
  setCleanerTwilioClient(undefined);
  setCleanerGroupFetch(undefined);
  setCleanerCalendarFetch(undefined);
  resetLiveDesks();
  twilioCalls = 0;
  while (open.length > 0) {
    const app = open.pop();
    if (app) await app.close();
  }
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
  if (options?.blockSms) setCleanerTwilioClient(throwingClient());
  return started;
}

function linesOf(result: ToolResult): string[] {
  const lines = result.structured?.lines;
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) throw new Error(result.text);
  return lines as string[];
}

function nextOf(result: ToolResult): string {
  const next = result.structured?.next;
  if (typeof next !== "string") throw new Error(result.text);
  return next;
}

async function call(wired: WiredApp, name: string, args?: Record<string, unknown>): Promise<ToolResult> {
  return wired.tool("/mcp/cleaner-core", CLEANER_TOKEN, name, args);
}

async function saveScratch(
  wired: WiredApp,
  property: { address: string; host: string; cleaner: string; observer: string; pin: string },
  business: string,
): Promise<string> {
  const seen: string[] = [];
  const remember = async (result: Promise<ToolResult>) => {
    const done = await result;
    seen.push(done.text, done.raw);
    return done;
  };
  await remember(call(wired, "get_state", { choice: "cleaners" }));
  await remember(call(wired, "save_property", { business, address: property.address, timeZone: "America/New_York" }));
  await remember(call(wired, "save_people", { host: property.host, cleaner: property.cleaner, observer: property.observer, doorCodeTo: "cleaner" }));
  await remember(call(wired, "save_calendar_link", { url: CALENDAR_URL }));
  const saved = await remember(call(wired, "save_door_code", { code: property.pin }));
  expect(saved.isError).toBe(false);
  await remember(call(wired, "set_up_texting"));
  const checks = await remember(call(wired, "run_checks"));
  expect(checks.isError).toBe(false);
  return seen.join("\n");
}

describe("Scratch test tools", () => {
  it("runs a full Scratch job from the tools, records delivery, and resets", async () => {
    if (!LANE || !COURT) throw new Error("missing tenant");
    const wired = await scratchApp({ allowlist: `${LANE.ownerPhone},${LANE.cleanerPhone},${LANE_OBSERVER}` });
    const seen: string[] = [];
    const remember = async (result: Promise<ToolResult>) => {
      const done = await result;
      seen.push(done.text, done.raw);
      return done;
    };
    seen.push(await saveScratch(wired, { address: LANE.property.address, host: LANE.ownerPhone, cleaner: LANE.cleanerPhone, observer: LANE_OBSERVER, pin: LANE.pin }, "Scratch"));

    const listed = await wired.listTools("/mcp/cleaner-core", CLEANER_TOKEN);
    expect(listed.names).toEqual([
      "get_state",
      "save_property",
      "save_people",
      "save_calendar_link",
      "save_sources",
      "save_schedule",
      "save_door_code",
      "save_preferences",
      "save_payments",
      "mark_paid",
      "get_pay_link",
      "activate",
      "set_up_texting",
      "get_turns",
      "confirm_times",
      "mark_guests_left",
      "run_checks",
      "check_now",
      "save_arrival",
      "get_job_photos",
      "save_alert_routine",
      "send_message",
      "retry_send",
      "hold_job",
      "resume_job",
      "reset_property",
      "reset_scratch",
      "read_inbox",
      "read_outbox",
      "send_test_text",
      "report_delivery",
      "add_test_turn",
    ]);
    expect(listed.raw).toContain("Clears Scratch jobs, notes, and test texts, and removes the Scratch group text on Twilio. The door code and texting setup stay. It only works on the Scratch test property.");
    expect(listed.raw).toContain("Lists test texts that came in, in everyday words. It never includes a door code.");
    expect(listed.raw).toContain("Lists test texts that went out. Each line names who it went to and whether it was delivered. It never includes a door code.");
    expect(listed.raw).toContain("Sends a test text as the host, the cleaner, or the observer. It follows the same path as a real text. It only works with 555 test numbers on the Scratch test property.");
    expect(listed.raw).toContain("Records that a test text was sent, delivered, failed, or undelivered. It does not text anyone.");

    const confirmed = await remember(call(wired, "confirm_times", { checkout: "10:30", checkIn: "15:00" }));
    expect(confirmed.isError).toBe(false);
    expect(nextOf(await remember(call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "YES" })))).toBe(WENT_THROUGH);
    expect(linesOf(await remember(call(wired, "read_outbox")))).toContain("Cleaning offer to the cleaner: sent.");
    expect(nextOf(await remember(call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "YES" })))).toBe(WENT_THROUGH);
    const left = await remember(call(wired, "mark_guests_left", { confirmed: true }));
    expect(left.text).toContain(PIN_SENT);
    expect(nextOf(await remember(call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "START" })))).toBe(WENT_THROUGH);
    const started = await remember(call(wired, "get_turns"));
    expect(started.text).toContain("\"status\":\"in_progress\"");
    expect(nextOf(await remember(call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "DONE" })))).toBe(WENT_THROUGH);
    const finished = await remember(call(wired, "get_turns"));
    expect(finished.text).toContain("\"status\":\"done\"");

    // Times and "guests have left" come from Grok's tools, not texts, so only the cleaner's texts are listed.
    expect(linesOf(await remember(call(wired, "read_inbox")))).toEqual([
      "Text from the cleaner: YES.",
      "Text from the cleaner: YES.",
      "Text from the cleaner: START.",
      "Text from the cleaner: DONE.",
    ]);
    expect(linesOf(await remember(call(wired, "read_outbox")))).toEqual([
      "Opt-in text to the cleaner: sent.",
      "Hold note to the host: sent.",
      "Cleaning offer to the cleaner: sent.",
      "Confirmation to the cleaner: sent.",
      "Door code text to the cleaner: sent.",
      "Door code notice to the host: sent.",
      "Start note to the cleaner: sent.",
      "Done note to the cleaner: sent.",
      "Done note to the host: sent.",
    ]);

    const again = await remember(call(wired, "mark_guests_left", { confirmed: true }));
    expect(again.text).toContain(PIN_REPEAT);
    expect(nextOf(await remember(call(wired, "report_delivery", { which: "Door code text to the cleaner", status: "failed" })))).toBe("Door code text to the cleaner: failed.");
    const failed = await remember(call(wired, "get_state"));
    expect(failed.text).toContain(PIN_FAILED);
    const resent = await remember(call(wired, "mark_guests_left", { confirmed: true }));
    expect(resent.text).toContain(PIN_SENT);
    const ambiguous = await remember(call(wired, "report_delivery", { which: "door code", status: "undelivered" }));
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toBe("Say which test text you mean.");
    expect(nextOf(await remember(call(wired, "report_delivery", { which: "Door code text to the cleaner", status: "undelivered" })))).toBe("Door code text to the cleaner: undelivered.");
    const undelivered = await remember(call(wired, "get_state"));
    expect(undelivered.text).toContain(PIN_FAILED);
    const resentAgain = await remember(call(wired, "mark_guests_left", { confirmed: true }));
    expect(resentAgain.text).toContain(PIN_SENT);
    expect(nextOf(await remember(call(wired, "report_delivery", { which: "Door code text to the cleaner", status: "delivered" })))).toBe("Door code text to the cleaner: delivered.");
    expect(nextOf(await remember(call(wired, "report_delivery", { which: "Door code text to the cleaner", status: "delivered" })))).toBe("Door code text to the cleaner: delivered.");
    const repeat = await remember(call(wired, "mark_guests_left", { confirmed: true }));
    expect(repeat.text).toContain(PIN_REPEAT);
    const doorLines = linesOf(await remember(call(wired, "read_outbox"))).filter((line) => line.startsWith("Door code text"));
    expect(doorLines).toEqual(["Door code text to the cleaner: delivered."]);

    const beforeHelp = linesOf(await remember(call(wired, "read_outbox"))).length;
    for (const text of ["HELP", "info", "Help"]) {
      expect(nextOf(await remember(call(wired, "send_test_text", { from: LANE.cleanerPhone, text })))).toBe(WENT_THROUGH);
    }
    expect(linesOf(await remember(call(wired, "read_outbox"))).length).toBe(beforeHelp);
    expect(linesOf(await remember(call(wired, "read_outbox"))).some((line) => line.startsWith("Help reply"))).toBe(false);
    const stillDone = await remember(call(wired, "get_turns"));
    expect(stillDone.text).toContain("\"status\":\"done\"");

    expect(nextOf(await remember(call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "The guest left a nice note." })))).toBe(WENT_THROUGH);
    const afterFalse = await remember(call(wired, "get_state"));
    expect(afterFalse.text).not.toContain("opted out");
    expect(linesOf(await remember(call(wired, "read_outbox"))).some((line) => line.startsWith("Injury"))).toBe(false);

    expect(nextOf(await remember(call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "I fell and I'm hurt" })))).toBe(WENT_THROUGH);
    expect(nextOf(await remember(call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "someone is hurt" })))).toBe(WENT_THROUGH);
    expect(nextOf(await remember(call(wired, "send_test_text", { from: LANE_OBSERVER, text: "I'm bleeding" })))).toBe(WENT_THROUGH);
    const injury = linesOf(await remember(call(wired, "read_outbox")));
    expect(injury.filter((line) => line === "Injury alert to the host: sent.")).toHaveLength(4);
    expect(injury).toContain("Injury reply to the cleaner: sent.");
    expect(injury).toContain("Injury reply to the observer: sent.");

    expect(nextOf(await remember(call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "STOP" })))).toBe(WENT_THROUGH);
    const stopped = await remember(call(wired, "get_state"));
    expect(stopped.text).toContain(`The cleaner opted out of cleaning texts for ${LANE.property.address}, so the cleaning is on hold. Find another cleaner or reach them directly, then tell your Grok Bot to restart it.`);
    expect(linesOf(await remember(call(wired, "read_outbox")))).toContain("Opt-out text to the cleaner: sent.");
    expect(linesOf(await remember(call(wired, "read_outbox")))).toContain("Hold note to the host: sent.");
    expect(nextOf(await remember(call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "START" })))).toBe(WENT_THROUGH);
    expect(nextOf(await remember(call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "stop texting me" })))).toBe(WENT_THROUGH);
    expect((await remember(call(wired, "get_state"))).text).toContain("opted out");
    expect(nextOf(await remember(call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "START" })))).toBe(WENT_THROUGH);
    expect(nextOf(await remember(call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "unsubscribe" })))).toBe(WENT_THROUGH);
    expect(linesOf(await remember(call(wired, "read_outbox"))).filter((line) => line === "Opt-out text to the cleaner: sent.")).toHaveLength(3);

    const sealBefore = readFileSync(join(wired.root, "cleaner-live.json"), "utf8");
    expect(sealBefore).toContain("\"texting\":true");
    const pinSeal = JSON.parse(sealBefore).pinSeal;
    const firstReset = await remember(call(wired, "reset_scratch"));
    expect(nextOf(firstReset)).toBe(RESET_LINE);
    const cleared = await remember(call(wired, "get_state"));
    expect(cleared.text).not.toContain("opted out");
    expect(cleared.text).toContain("Door code saved.");
    expect(cleared.text).toContain("Texting saved.");
    expect(linesOf(await remember(call(wired, "read_inbox")))).toEqual([]);
    expect(linesOf(await remember(call(wired, "read_outbox")))).toEqual([]);
    const fileOnce = readFileSync(join(wired.root, "cleaner-live.json"), "utf8");
    expect(JSON.parse(fileOnce).pinSeal).toEqual(pinSeal);
    const secondReset = await remember(call(wired, "reset_scratch"));
    expect(nextOf(secondReset)).toBe(RESET_LINE);
    expect(readFileSync(join(wired.root, "cleaner-live.json"), "utf8")).toBe(fileOnce);
    expect(linesOf(await remember(call(wired, "read_outbox")))).toEqual([]);

    const checks = await remember(call(wired, "run_checks"));
    expect(checks.isError).toBe(false);
    const reconfirmed = await remember(call(wired, "confirm_times", { checkout: "10:30", checkIn: "15:00" }));
    expect(reconfirmed.isError).toBe(false);
    expect(linesOf(await remember(call(wired, "read_outbox")))).toEqual([
      "Opt-in text to the cleaner: sent.",
      "Hold note to the host: sent.",
    ]);

    const blob = seen.join("\n");
    expect(blob.includes(LANE.pin)).toBe(false);
    expect(blob.includes(COURT.pin)).toBe(false);
    expect(blob).not.toMatch(/PIN_SENT|PIN_REPEAT|PIN_FAILED|CLEANER_CORE_SCRATCH_TOOLS/);
    expect(twilioCalls).toBe(0);
    const sentBodies = wired.cleanerSent.map((item) => item.body.split(LANE.pin).join("[redacted]").split(COURT.pin).join("[redacted]"));
    expect(sentBodies.join("\n")).not.toContain(LANE.pin);
    expect(sentBodies.join("\n")).not.toContain(COURT.pin);
    expect(sentBodies.filter((body) => body.includes("Door code:"))).toHaveLength(3);
  }, 40_000);

  it("outbox shows the wording with the code redacted", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp({ allowlist: `${LANE.ownerPhone},${LANE.cleanerPhone},${LANE_OBSERVER}` });
    await saveScratch(wired, { address: LANE.property.address, host: LANE.ownerPhone, cleaner: LANE.cleanerPhone, observer: LANE_OBSERVER, pin: LANE.pin }, "Scratch");
    await call(wired, "confirm_times", { checkout: "10:30", checkIn: "15:00" });
    await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "YES" });
    await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "YES" });
    const left = await call(wired, "mark_guests_left", { confirmed: true });
    expect(left.text).toContain(PIN_SENT);
    await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "STOP" });

    const outbox = await call(wired, "read_outbox");
    const lines = linesOf(outbox);
    const texts = outbox.structured?.texts as { label: string; status: string; body: string }[];
    expect(Array.isArray(texts)).toBe(true);
    expect(texts).toHaveLength(lines.length);
    const door = texts.find((item) => item.label === "Door code text to the cleaner");
    expect(door?.status).toBe("sent");
    expect(door?.body).toContain("[redacted]");
    expect(door?.body).not.toContain(LANE.pin);
    expect(door?.body).not.toContain(DOOR_CODE);
    const optIn = texts.find((item) => item.label === "Opt-in text to the cleaner");
    expect(optIn?.body.startsWith("Hi, this is ")).toBe(true);
    const offer = texts.find((item) => item.label === "Cleaning offer to the cleaner");
    expect(offer?.body).toContain("Reply YES to schedule it");
    const optOut = texts.find((item) => item.label === "Opt-out text to the cleaner");
    expect(optOut?.body).toContain("You're opted out of cleaning texts");
    expect(texts.map((item) => `${item.label}: ${item.status}.`)).toEqual(lines);
    expect(JSON.stringify(outbox.structured)).not.toContain(LANE.pin);
    expect(readFileSync(join(wired.root, "cleaner-live.json"), "utf8")).not.toContain(LANE.pin);
    expect(twilioCalls).toBe(0);
  }, 40_000);

  it("hides both Scratch door codes and never calls Twilio for a Court code text", async () => {
    if (!COURT || !LANE) throw new Error("missing tenant");
    const wired = await scratchApp({ allowlist: `${COURT.ownerPhone},${COURT.cleanerPhone},${COURT_OBSERVER}` });
    const seen: string[] = [];
    const remember = async (result: Promise<ToolResult>) => {
      const done = await result;
      seen.push(done.text, done.raw);
      return done;
    };
    seen.push(await saveScratch(wired, { address: COURT.property.address, host: COURT.ownerPhone, cleaner: COURT.cleanerPhone, observer: COURT_OBSERVER, pin: COURT.pin }, "Scratch Court"));
    await remember(call(wired, "confirm_times", { checkout: "10:30", checkIn: "15:00" }));
    await remember(call(wired, "send_test_text", { from: COURT.cleanerPhone, text: "YES" }));
    await remember(call(wired, "send_test_text", { from: COURT.cleanerPhone, text: "YES" }));
    const left = await remember(call(wired, "mark_guests_left", { confirmed: true }));
    expect(left.text).toContain(PIN_SENT);
    const outbox = linesOf(await remember(call(wired, "read_outbox")));
    expect(outbox).toContain("Door code text to the cleaner: sent.");
    const blob = seen.join("\n");
    expect(blob.includes(COURT.pin)).toBe(false);
    expect(blob.includes(LANE.pin)).toBe(false);
    expect(twilioCalls).toBe(0);
    const courtSent = wired.cleanerSent.map((item) => item.body.split(COURT.pin).join("[redacted]").split(LANE.pin).join("[redacted]"));
    expect(courtSent.join("\n")).not.toContain(COURT.pin);
    expect(courtSent.filter((body) => body.includes("Door code:"))).toEqual([
      "Guests have left 8 Scratch Court, Teaneck, NJ 07666. Door code: [redacted]. This code is only for you. Reply DONE when the cleaning is finished.",
    ]);
  }, 40_000);

  it("refuses a real number and a property that is not Scratch, and stores nothing", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp({ blockSms: true, allowlist: `${LANE.ownerPhone},${LANE.cleanerPhone},${LANE_OBSERVER}` });
    await saveScratch(wired, { address: LANE.property.address, host: LANE.ownerPhone, cleaner: LANE.cleanerPhone, observer: LANE_OBSERVER, pin: LANE.pin }, "Scratch");
    const refused = await call(wired, "send_test_text", { from: REAL_NUMBER, text: "YES please come now" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(NUMBER_REFUSAL);
    expect(refused.text).not.toMatch(/CLEANER_CORE|token|SCRATCH_TOOLS/);
    expect(linesOf(await call(wired, "read_inbox"))).toEqual([]);
    expect(linesOf(await call(wired, "read_outbox"))).toEqual([]);
    expect(twilioCalls).toBe(0);

    const mixed = await scratchApp({ blockSms: true, allowlist: `${LANE.ownerPhone},${REAL_NUMBER},${LANE_OBSERVER}` });
    await call(mixed, "get_state", { choice: "cleaners" });
    await call(mixed, "save_property", { business: "Scratch", address: LANE.property.address, timeZone: "America/New_York" });
    await call(mixed, "save_people", { host: LANE.ownerPhone, cleaner: REAL_NUMBER, observer: LANE_OBSERVER, doorCodeTo: "cleaner" });
    await call(mixed, "save_calendar_link", { url: CALENDAR_URL });
    await call(mixed, "save_door_code", { code: LANE.pin });
    await call(mixed, "set_up_texting");
    const before = readFileSync(join(mixed.root, "cleaner-live.json"), "utf8");
    const reset = await call(mixed, "reset_scratch");
    expect(reset.isError).toBe(true);
    expect(reset.text).toBe(NUMBER_REFUSAL);
    expect(readFileSync(join(mixed.root, "cleaner-live.json"), "utf8")).toBe(before);
    const sent = await call(mixed, "send_test_text", { from: LANE.ownerPhone, text: "YES" });
    expect(sent.isError).toBe(true);
    expect(sent.text).toBe(NUMBER_REFUSAL);
    expect(twilioCalls).toBe(0);

    const practice = await scratchApp({ blockSms: true, allowlist: `${LANE.ownerPhone},${LANE.cleanerPhone},${LANE_OBSERVER}` });
    await call(practice, "get_state", { choice: "cleaners" });
    await call(practice, "save_property", { business: "Harbor", address: ADDRESS, timeZone: "America/New_York" });
    await call(practice, "save_people", { host: LANE.ownerPhone, cleaner: LANE.cleanerPhone, observer: LANE_OBSERVER, doorCodeTo: "cleaner" });
    await call(practice, "save_calendar_link", { url: CALENDAR_URL });
    await call(practice, "save_door_code", { code: DOOR_CODE });
    await call(practice, "set_up_texting");
    const practiceBefore = readFileSync(join(practice.root, "cleaner-live.json"), "utf8");
    const practiceReset = await call(practice, "reset_scratch");
    expect(practiceReset.isError).toBe(true);
    expect(practiceReset.text).toBe(PROPERTY_REFUSAL);
    expect(practiceReset.text).not.toMatch(/CLEANER_CORE|token|SCRATCH_TOOLS/);
    expect(readFileSync(join(practice.root, "cleaner-live.json"), "utf8")).toBe(practiceBefore);
    expect(JSON.parse(practiceBefore).texting).toBe(true);
    expect(JSON.parse(practiceBefore).pinSeal.iv).toEqual(JSON.parse(readFileSync(join(practice.root, "cleaner-live.json"), "utf8")).pinSeal.iv);
    expect(twilioCalls).toBe(0);
  }, 40_000);

  it("hides the tools when the setting is off and refuses a call", async () => {
    const wired = await scratchApp({ scratchTools: false });
    const listed = await wired.listTools("/mcp/cleaner-core", CLEANER_TOKEN);
    expect(listed.names).not.toContain("reset_scratch");
    expect(listed.names).not.toContain("read_inbox");
    expect(listed.names).not.toContain("read_outbox");
    expect(listed.names).not.toContain("send_test_text");
    expect(listed.names).not.toContain("report_delivery");
    expect(listed.names).not.toContain("add_test_turn");
    const refused = await call(wired, "reset_scratch");
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe("I can't do that from this chat.");
    const missing = await call(wired, "send_test_text", { from: "+15555550101", text: "YES" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe("I can't do that from this chat.");
  });

  it("refuses Scratch tool calls that omit the cleaning login", async () => {
    const wired = await scratchApp();
    const res = await fetch(`http://127.0.0.1:${wired.port}/mcp/cleaner-core`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reset_scratch", arguments: {} } }),
    });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("Missing or wrong cleaning scheduler credential.");
    expect(body).not.toContain(RESET_LINE);
    const wrong = await fetch(`http://127.0.0.1:${wired.port}/mcp/cleaner-core`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer not-the-cleaning-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_outbox", arguments: {} } }),
    });
    expect(wrong.status).toBe(401);
  });

  it("keeps an injury alert in the outbox when group texts are on, and does not call Twilio", async () => {
    if (!LANE) throw new Error("missing lane");
    let groupCalls = 0;
    setCleanerGroupFetch(async () => {
      groupCalls += 1;
      return new Response("no", { status: 500 });
    });
    const wired = await scratchApp({ groupChat: true, allowlist: `${LANE.ownerPhone},${LANE.cleanerPhone},${LANE_OBSERVER}` });
    await saveScratch(wired, { address: LANE.property.address, host: LANE.ownerPhone, cleaner: LANE.cleanerPhone, observer: LANE_OBSERVER, pin: LANE.pin }, "Scratch");
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.cleanerPhone, text: "I fell and I'm hurt" }))).toBe(WENT_THROUGH);
    const lines = linesOf(await call(wired, "read_outbox"));
    expect(lines).toContain("Injury alert to the host: sent.");
    expect(lines).toContain("Injury reply to the cleaner: sent.");
    expect(lines.join("\n").includes(LANE.pin)).toBe(false);
    expect(groupCalls).toBe(0);
    expect(twilioCalls).toBe(0);
    expect(wired.cleanerSent.map((item) => item.body).join("\n").includes(LANE.pin)).toBe(false);
    expect(wired.cleanerSent.some((item) => item.body.includes("someone is hurt"))).toBe(true);
  }, 40_000);

  it("records an opted-out host note in the outbox and does not call Twilio", async () => {
    if (!LANE) throw new Error("missing lane");
    const wired = await scratchApp({ groupChat: true, allowlist: `${LANE.ownerPhone},${LANE.cleanerPhone},${LANE_OBSERVER}` });
    await saveScratch(wired, { address: LANE.property.address, host: LANE.ownerPhone, cleaner: LANE.cleanerPhone, observer: LANE_OBSERVER, pin: LANE.pin }, "Scratch");
    expect(nextOf(await call(wired, "send_test_text", { from: LANE.ownerPhone, text: "STOP" }))).toBe(WENT_THROUGH);
    const resumed = await approvedTool((args) => call(wired, "resume_job", args));
    const sentence = `The cleaning at ${LANE.property.address} is back on.`;
    expect(resumed.isError).toBe(false);
    expect(resumed.text).toContain(sentence);
    const lines = linesOf(await call(wired, "read_outbox"));
    expect(lines).toContain("Hold note to the host: sent.");
    expect(lines).toContain("Resume note to the host: unsent.");
    expect(lines.join("\n").includes(LANE.pin)).toBe(false);
    const state = await call(wired, "get_state");
    expect(state.text).toContain(sentence);
    expect(state.text.includes(LANE.pin)).toBe(false);
    expect(twilioCalls).toBe(0);
    const stopAck = `You're opted out of cleaning texts for ${LANE.property.address}, and the cleaning there is on hold. Reply START to get texts again.`;
    expect(wired.cleanerSent.map((item) => item.body)).toContain(stopAck);
    expect(wired.cleanerSent.some((item) => item.body.includes("is back on"))).toBe(false);
    expect(wired.cleanerSent.map((item) => item.body).join("\n").includes(LANE.pin)).toBe(false);
  }, 40_000);
});
