import { readFileSync } from "node:fs";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASSISTANT_PROFILES,
  assistantForRedirect,
  CHATGPT_INSTRUCTIONS,
  cleanerAssistant,
  MUSE_DESK_WORDING,
  MUSE_INSTRUCTIONS,
  MUSE_TASK,
  MUSE_TASK_CONNECTED,
  MUSE_TASK_PROMPT,
} from "../src/cleaner-core/assistant";
import { cleanerOptOutHold } from "../src/cleaner-core/cleanerTexts";
import { resetLiveDesks, setCleanerAlertFetch, type LiveDesk } from "../src/cleaner-core/liveDesk";
import { handleCleanerMcpMessage } from "../src/cleaner-core/mcp";
import { askNext } from "../src/cleaner-core/setupAsk";
import { DEFAULT_REDIRECT_HOSTS, redirectHostsFromEnv } from "../src/mcp/oauth/clients";
import { consentPage } from "../src/mcp/oauth/pages";
import { hashSecret, OAuthGrantStore } from "../src/mcp/oauth/store";
import { closeHostedApps } from "./cleanerOauthHarness";
import { PUBLIC } from "./fakeSendblue";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { ADDRESS, BUSINESS, CALENDAR_URL, CLEANER, CLEANER_AUTH, CLEANER_LINE, CLEANER_TOKEN, DOOR_CODE, FROZEN, HOST, startWiredApp, type WiredApp } from "./wiringProof";

/**
 * A Cleaner Core deployment for Meta's Muse. It is ChatGPT's polled task, at the frequency the host picks, with Muse's words, choice
 * cards as on Grok, and upload replies that only describe the host's private page: the live probe
 * showed Muse's safety check refuses a tool that tells it to send a value somewhere.
 */

const PATH = "/mcp/cleaner-core";
const ZONE = "America/New_York";
const HOUR = 60 * 60_000;
const MUSE_CALLBACK = "https://agent.meta.ai/api/hatch/oauth/callback";
/** A reply that tells the chat to move a value. Muse refuses these. */
const MOVES_A_VALUE = /\b(?:post|send|fill|paste|type|upload)\b|secure card|own computer|cloud computer/i;

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

const wiredApps: WiredApp[] = [];
let hosted: MultiTenantApp | undefined;

afterEach(async () => {
  setCleanerAlertFetch(undefined);
  hosted?.close();
  hosted = undefined;
  closeHostedApps();
  resetLiveDesks();
  while (wiredApps.length > 0) await wiredApps.pop()?.close();
});

/** A Muse deployment with a clock the test moves. */
async function app(): Promise<WiredApp & { advance: (ms: number) => void }> {
  let at = Date.parse(FROZEN);
  const started = await startWiredApp({ now: () => new Date(at) });
  wiredApps.push(started);
  started.setEnv({ CLEANER_CORE_ASSISTANT: "muse" });
  return Object.assign(started, { advance: (ms: number) => void (at += ms) });
}

function call(wired: WiredApp, name: string, args: Record<string, unknown> = {}) {
  return wired.tool(PATH, CLEANER_TOKEN, name, args);
}

/** A request as the public internet sends it: to the public host, not 127.0.0.1. */
function publicRequest(wired: WiredApp, method: string, path: string, body?: { type: string; text: string }): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: wired.port,
        path,
        method,
        headers: { Host: new URL(PUBLIC).host, ...(body ? { "Content-Type": body.type, "Content-Length": String(Buffer.byteLength(body.text)) } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body.text);
    req.end();
  });
}

const form = (fields: Record<string, string>) => ({ type: "application/x-www-form-urlencoded", text: new URLSearchParams(fields).toString() });

async function toSources(wired: WiredApp): Promise<void> {
  await call(wired, "get_state", { choice: "cleaners" });
  await call(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "10:30", checkInTime: "15:00" });
}

/** Setup up to the door-code step, the way the chat drives it. */
async function toDoorCode(wired: WiredApp): Promise<void> {
  await toSources(wired);
  await call(wired, "save_sources", { calendars: [{ name: "Airbnb", url: CALENDAR_URL }] });
  await call(wired, "save_sources", { done: true });
  await call(wired, "save_people", { host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-and-host" });
  await call(wired, "save_schedule", { firstText: "days-before-checkout", firstTextDays: 1 });
}

/** Setup through the preferences, so the routine step is next. */
async function toRoutine(wired: WiredApp): Promise<void> {
  await toDoorCode(wired);
  await call(wired, "save_door_code", { code: DOOR_CODE, lockLocation: "front door keypad" });
  await call(wired, "save_preferences", {});
  await call(wired, "save_payments", { on: false });
}

describe("Cleaner Core for Muse", () => {
  it("is Muse only when CLEANER_CORE_ASSISTANT is exactly muse, or the callback is agent.meta.ai", () => {
    expect(cleanerAssistant({ CLEANER_CORE_ASSISTANT: " Muse " })).toBe("muse");
    expect(cleanerAssistant({ CLEANER_CORE_ASSISTANT: "meta" })).toBe("grok");
    expect(assistantForRedirect(MUSE_CALLBACK)).toBe("muse");
    expect(assistantForRedirect("https://meta.ai/api/hatch/oauth/callback")).toBe("grok");
    expect(assistantForRedirect("https://agent.meta.ai.example.com/callback")).toBe("grok");
    expect(redirectHostsFromEnv({ CLEANER_CORE_ASSISTANT: "muse" })).toEqual([...DEFAULT_REDIRECT_HOSTS, "agent.meta.ai"]);
    expect(redirectHostsFromEnv({ CLEANER_CORE_MULTI_TENANT: "1" })).toContain("agent.meta.ai");
    expect(ASSISTANT_PROFILES.muse).toMatchObject({ helper: "Muse", privatePages: true, photoImages: false, polledTask: true });
  });

  it("gives Muse its own instructions: the skill, choice cards, the private page in its browser, and no wake-up", async () => {
    const reply = await handleCleanerMcpMessage({} as LiveDesk, { jsonrpc: "2.0", id: 1, method: "initialize" }, undefined, false, undefined, undefined, "muse");
    const text = String((reply.body as { result: { instructions: string } }).result.instructions);
    expect(text).toBe(MUSE_INSTRUCTIONS);
    expect(text).not.toBe(CHATGPT_INSTRUCTIONS);
    expect(text.startsWith("Follow your Cleaner Core skill. Call get_state first and follow its next step.")).toBe(true);
    expect(text).toContain("show them as a choice card the host can tap");
    expect(text).toContain("Open it in your own browser and hand the browser to the host, who types the value there. You never type on that page yourself.");
    expect(text).not.toMatch(/secure card|own computer|POST|Grok|Claude|ChatGPT|Fire URL/);
    const order = ["save_property", "save_sources", "save_people", "save_schedule", "save_door_code", "save_preferences", "save_alert_routine", "activate"];
    const positions = order.map((tool) => text.indexOf(tool));
    for (const [i, p] of positions.entries()) expect(p, order[i]).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("names Muse in host texts and on the approval page", () => {
    expect(cleanerOptOutHold(ADDRESS, "Muse")).toContain("then tell Muse to restart it.");
    expect(MUSE_DESK_WORDING.pinFailed).toBe("The door code didn't reach the cleaner. Tell Muse the guests have left and I'll resend it.");
    const page = consentPage({ requestId: "r", matchCode: "123456", clientName: "Muse", redirectHost: "agent.meta.ai", hosted: true, firstClaim: true, label: "Cleaner Core", assistant: "muse" });
    expect(page).toContain("<h1>Connect Muse to Cleaner Core</h1>");
    expect(page).not.toMatch(/Grok|Claude|ChatGPT/);
  });

  it("asks with choice cards, and says on the cleaner-only option that messages wait for Muse's next check", async () => {
    const wired = await app();
    await toSources(wired);
    await call(wired, "save_sources", { calendars: [{ name: "Airbnb", url: CALENDAR_URL }] });
    await call(wired, "save_sources", { done: true });
    const state = (await call(wired, "get_state")).structured ?? {};
    const ask = state.ask as { step: string; tool: string; questions: { field: string; options?: { value: string; label: string }[] }[] };
    expect(ask.step).toBe("people");
    expect(state.next).toBe(askNext(ask.tool));
    const group = ask.questions.find((question) => question.field === "groupChat");
    expect(group?.options?.find((option) => option.value === "cleaner-only")?.label).toBe("Texts to the cleaner alone (with Muse, the cleaner's messages reach you only at Muse's next check)");
  });

  it("never tells Muse to move a value: each upload reply and ask only describes the host's private page", async () => {
    for (const line of [MUSE_DESK_WORDING.calendarUploadNext, MUSE_DESK_WORDING.doorCodeUploadNext, MUSE_DESK_WORDING.maskedCode, MUSE_DESK_WORDING.maskedLink]) {
      expect(line).not.toMatch(MOVES_A_VALUE);
    }
    const wired = await app();
    await toSources(wired);
    const sourcesAsk = (await call(wired, "get_state")).structured ?? {};
    expect(JSON.stringify(sourcesAsk)).not.toMatch(MOVES_A_VALUE);
    const calendar = await call(wired, "save_sources", { uploadLink: { name: "Guesty Lite" } });
    expect(calendar.isError).toBe(false);
    expect(calendar.structured?.next).toBe(MUSE_DESK_WORDING.calendarUploadNext);
    expect(String(calendar.structured?.next)).not.toMatch(MOVES_A_VALUE);

    const fresh = await app();
    await toDoorCode(fresh);
    const doorAsk = (await call(fresh, "get_state")).structured ?? {};
    expect(JSON.stringify(doorAsk)).not.toMatch(MOVES_A_VALUE);
    const door = await call(fresh, "save_door_code", { lockLocation: "front door keypad" });
    expect(door.structured?.next).toBe(MUSE_DESK_WORDING.doorCodeUploadNext);
    expect(door.structured?.uploadUrl).toMatch(/^https:\/\//);
  });

  it("opens the private pages for Muse, keeps the calendar link in a password field, and has no alert page", async () => {
    const wired = await app();
    await toSources(wired);
    const calendar = await call(wired, "save_sources", { uploadLink: { name: "Guesty Lite" } });
    const calendarPage = await publicRequest(wired, "GET", new URL(String(calendar.structured?.uploadUrl)).pathname);
    expect(calendarPage.status).toBe(200);
    expect(calendarPage.text).toContain('<input id="url" name="url" type="password"');
    expect(calendarPage.text).toContain("10 minutes after Muse made it");

    const fresh = await app();
    await toDoorCode(fresh);
    const door = await call(fresh, "save_door_code", { lockLocation: "front door keypad" });
    const path = new URL(String(door.structured?.uploadUrl)).pathname;
    const page = await publicRequest(fresh, "GET", path);
    expect(page.status).toBe(200);
    expect(page.text).toContain("after you tell Muse the guests have left");
    expect(page.text).not.toMatch(/Grok|Claude|ChatGPT/);
    const saved = await publicRequest(fresh, "POST", path, form({ code: DOOR_CODE }));
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain(DOOR_CODE);
    expect(((await call(fresh, "get_state")).structured?.ask as { step?: string } | undefined)?.step).not.toBe("door-code");
    expect((await publicRequest(fresh, "GET", "/cleaner-core/alert-routine/abcdefghijklmnopqrstuvwxyz012345")).status).toBe(404);
  });
});

describe("Muse's recurring task", () => {
  it("is the prompt the template ships, at the frequency the host picks", () => {
    expect(MUSE_TASK.prompt).toBe(MUSE_TASK_PROMPT);
    // The host trades speed for Muse usage: the ask offers each frequency and says what a check costs.
    for (const choice of ["every minute", "every 5 minutes", "every 15 minutes", "every hour"]) {
      expect(MUSE_DESK_WORDING.routineAsk).toContain(choice);
      expect(MUSE_TASK.schedule).toContain(choice);
    }
    expect(MUSE_DESK_WORDING.routineAsk).toContain("every check uses Muse's usage");
    expect(MUSE_TASK_PROMPT).not.toMatch(/hour's|hourly/);
    const doc = read("muse-template/skills/cleaner-core/references/cleaner-core-task.md");
    expect(doc).toContain(["```text", MUSE_TASK_PROMPT, "```"].join("\n"));
  });

  it("is asked for after the preferences, connects with no URL, and lets check_now answer calmly before Activate", async () => {
    const wired = await app();
    await toRoutine(wired);
    const state = (await call(wired, "get_state")).structured ?? {};
    expect(state.next).toBe(MUSE_DESK_WORDING.routineAsk);
    expect(state.routine).toEqual(json(MUSE_TASK));
    expect((await call(wired, "activate")).isError).toBe(true);

    const withUrl = await call(wired, "save_alert_routine", { url: "https://hooks.example/wake", token: "made-up-token-for-tests" });
    expect(withUrl.isError).toBe(true);
    expect(withUrl.text).toBe(MUSE_DESK_WORDING.routineNeeded);

    const connected = await call(wired, "save_alert_routine");
    expect(connected.isError).toBe(false);
    expect(connected.structured?.next).toBe(`${MUSE_TASK_CONNECTED} Then call get_state for the review.`);
    expect(connected.structured?.uploadUrl).toBeUndefined();

    const early = await call(wired, "check_now");
    expect(early.isError).toBe(false);
    expect(early.structured?.next).toBe("Cleaner Core isn't active yet. Post nothing.");
    expect(wired.cleanerSent).toEqual([]);
  });

  it("warns in get_state, in Muse's words, once no check has come in for over two and a half hours", async () => {
    const wired = await app();
    await toRoutine(wired);
    await call(wired, "save_alert_routine");
    expect((await call(wired, "activate")).isError).toBe(false);
    wired.advance(3 * HOUR);
    const stale = (await call(wired, "get_state")).structured ?? {};
    expect(String(stale.warning)).toMatch(/^No check has reached Cleaner Core since .+\. The Muse recurring task may be paused or cancelled\./);
    expect(stale.routine).toEqual(json(MUSE_TASK));
  });
});

describe("Cleaner Core for Muse, live", () => {
  it("texts the host to tell Muse, and never names another chat", async () => {
    const wired = await app();
    await call(wired, "get_state", { choice: "cleaners" });
    await call(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE });
    await call(wired, "save_people", { host: HOST, cleaner: CLEANER });
    await call(wired, "save_calendar_link", { url: CALENDAR_URL });
    await call(wired, "save_door_code", { code: DOOR_CODE });
    await call(wired, "set_up_texting");
    const checks = await call(wired, "run_checks");
    expect(checks.structured?.routine).toEqual(json(MUSE_TASK));
    expect((await call(wired, "confirm_times", { checkout: "10:30", checkIn: "15:00" })).isError).toBe(false);
    const line = { to: CLEANER_LINE, token: CLEANER_AUTH };
    await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, body: "YES", sid: "SM-muse-yes-1", ...line });
    await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, body: "YES", sid: "SM-muse-yes-2", ...line });
    const before = wired.cleanerSent.length;
    await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, body: "STOP", sid: "SM-muse-stop", ...line });
    const toHost = wired.cleanerSent.slice(before).filter((item) => item.to === HOST).map((item) => item.body);
    expect(toHost).toEqual([`The cleaner opted out of cleaning texts for ${ADDRESS}, so the cleaning is on hold. Find another cleaner or reach them directly, then tell Muse to restart it.`]);
    expect(wired.cleanerSent.some((item) => /Grok|Claude|ChatGPT/.test(item.body))).toBe(false);
  });
});

describe("Cleaner Core for Muse, hosted", () => {
  it("connects Muse from agent.meta.ai with no extra config, and its private page speaks as Muse", async () => {
    hosted = await multiTenantApp();
    const lane = hosted.registry.create({ label: "Lane", twilioNumber: "+15555550150" }).tenant;
    const token = await hosted.join(lane.id, "muse");
    const grant = new OAuthGrantStore(hosted.app.inst.runtime).findByAccessHash(hashSecret(token));
    expect(grant?.assistant).toBe("muse");
    await hosted.tool(token, "get_state", { choice: "cleaners" });
    await hosted.tool(token, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "10:30", checkInTime: "15:00" });
    const link = await hosted.tool(token, "save_sources", { uploadLink: { name: "Guesty Lite" } });
    expect(link.structured?.next).toBe(MUSE_DESK_WORDING.calendarUploadNext);
    const page = await hosted.app.http(new URL(String(link.structured?.uploadUrl)).pathname);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Muse");
    expect(html).not.toMatch(/Grok|Claude|ChatGPT/);
  });
});
