import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatGptTaskSink, testEvent } from "../src/alerts/operatorEvents";
import {
  ASSISTANT_PROFILES,
  CHATGPT_DESK_WORDING,
  CHATGPT_INSTRUCTIONS,
  CHATGPT_TASK,
  CHATGPT_TASK_CONNECTED,
  CHATGPT_TASK_PROMPT,
  CLAUDE_INSTRUCTIONS,
  cleanerAssistant,
} from "../src/cleaner-core/assistant";
import { cleanerOptOutHold, injuryHoldLine } from "../src/cleaner-core/cleanerTexts";
import { drainCleanerAlerts, liveDeskFor, resetLiveDesks, setCleanerAlertFetch, type LiveDesk } from "../src/cleaner-core/liveDesk";
import { handleCleanerMcpMessage } from "../src/cleaner-core/mcp";
import { reviewAlert } from "../src/cleaner-core/review";
import { DEFAULT_REDIRECT_HOSTS, redirectHostsFromEnv } from "../src/mcp/oauth/clients";
import { consentPage } from "../src/mcp/oauth/pages";
import { closeHostedApps } from "./cleanerOauthHarness";
import { PUBLIC } from "./fakeSendblue";
import { filesUnder } from "./files";
import { ADDRESS, BUSINESS, CALENDAR_URL, CLEANER, CLEANER_AUTH, CLEANER_LINE, CLEANER_TOKEN, DOOR_CODE, FROZEN, HOST, startWiredApp, type WiredApp } from "./wiringProof";

const PATH = "/mcp/cleaner-core";
const ZONE = "America/New_York";
const HOUR = 60 * 60_000;

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

const open: WiredApp[] = [];
const roots: string[] = [];

afterEach(async () => {
  setCleanerAlertFetch(undefined);
  closeHostedApps();
  resetLiveDesks();
  while (open.length > 0) await open.pop()?.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A ChatGPT deployment with a clock the test moves. */
async function app(): Promise<WiredApp & { advance: (ms: number) => void }> {
  let at = Date.parse(FROZEN);
  const started = await startWiredApp({ now: () => new Date(at) });
  open.push(started);
  started.setEnv({ CLEANER_CORE_ASSISTANT: "chatgpt" });
  return Object.assign(started, { advance: (ms: number) => void (at += ms) });
}

function call(wired: WiredApp, name: string, args: Record<string, unknown> = {}) {
  return wired.tool(PATH, CLEANER_TOKEN, name, args);
}

async function initialize(): Promise<string> {
  const reply = await handleCleanerMcpMessage({} as LiveDesk, { jsonrpc: "2.0", id: 1, method: "initialize" }, undefined, false, undefined, undefined, "chatgpt");
  return String((reply.body as { result: { instructions: string } }).result.instructions);
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

/** Setup up to the door-code step, the way the chat drives it. */
async function toDoorCode(wired: WiredApp): Promise<void> {
  await call(wired, "get_state", { choice: "cleaners" });
  await call(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "10:30", checkInTime: "15:00" });
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

describe("Cleaner Core for ChatGPT", () => {
  it("is ChatGPT only when CLEANER_CORE_ASSISTANT is exactly chatgpt", () => {
    expect(cleanerAssistant({ CLEANER_CORE_ASSISTANT: " ChatGPT " })).toBe("chatgpt");
    expect(cleanerAssistant({ CLEANER_CORE_ASSISTANT: "chat-gpt" })).toBe("grok");
    expect(cleanerAssistant({ CLEANER_CORE_ASSISTANT: "openai" })).toBe("grok");
  });

  it("gives ChatGPT its own instructions, in the same setup order, with no secure card and no wake-up", async () => {
    const text = await initialize();
    expect(text).toBe(CHATGPT_INSTRUCTIONS);
    expect(text).not.toBe(CLAUDE_INSTRUCTIONS);
    expect(text).not.toMatch(/secure card|own computer|choice card|Grok|Claude|Fire URL/);
    expect(text.startsWith("Call get_state first and follow its next step.")).toBe(true);
    // The host hears from the cleaner in the group text, and a draft starts from the real message.
    expect(text).toContain("call check_now first and read the message it returns before you draft");
    const order = ["save_property", "save_sources", "save_people", "save_schedule", "save_door_code", "save_preferences", "save_alert_routine", "activate"];
    const positions = order.map((tool) => text.indexOf(tool));
    for (const [i, p] of positions.entries()) expect(p, order[i]).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("names ChatGPT in host texts and on the approval page, and takes chatgpt.com's callback", () => {
    expect(cleanerOptOutHold(ADDRESS, "ChatGPT")).toContain("then tell ChatGPT to restart it.");
    expect(injuryHoldLine(ADDRESS, "ChatGPT")).toContain("tell ChatGPT to restart it.");
    expect(reviewAlert("missed-reminder", ADDRESS, { day: "Friday" }, "ChatGPT")).toContain("Tell ChatGPT if you want it sent again.");
    expect(CHATGPT_DESK_WORDING.pinFailed).toBe("The door code didn't reach the cleaner. Tell ChatGPT the guests have left and I'll resend it.");
    expect(redirectHostsFromEnv({ CLEANER_CORE_ASSISTANT: "chatgpt" })).toEqual([...DEFAULT_REDIRECT_HOSTS, "chatgpt.com"]);
    const page = consentPage({ requestId: "r", matchCode: "123456", clientName: "ChatGPT", redirectHost: "chatgpt.com", hosted: true, firstClaim: true, label: "Cleaner Core", assistant: "chatgpt" });
    expect(page).toContain("<h1>Connect ChatGPT to Cleaner Core</h1>");
    expect(page).not.toContain("owner");
    expect(page).not.toMatch(/Grok|Claude/);
  });

  it("keeps the photos as links until ChatGPT is shown to read images", () => {
    expect(ASSISTANT_PROFILES.chatgpt.photoImages).toBe(false);
    expect(ASSISTANT_PROFILES.claude.photoImages).toBe(true);
  });

  it("says on the cleaner-only option that the cleaner's messages can take up to an hour", async () => {
    const wired = await app();
    await call(wired, "get_state", { choice: "cleaners" });
    await call(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "10:30", checkInTime: "15:00" });
    await call(wired, "save_sources", { calendars: [{ name: "Airbnb", url: CALENDAR_URL }] });
    await call(wired, "save_sources", { done: true });
    const ask = (await call(wired, "get_state")).structured?.ask as { step: string; questions: { field: string; default?: string; options?: { value: string; label: string }[] }[] };
    expect(ask.step).toBe("people");
    const group = ask.questions.find((question) => question.field === "groupChat");
    expect(group?.default).toBe("cleaner-and-host");
    expect(group?.options?.find((option) => option.value === "cleaner-only")?.label).toBe("Texts to the cleaner alone (with ChatGPT, the cleaner's messages can take up to an hour to reach you)");
    expect(group?.options?.find((option) => option.value === "cleaner-and-host")?.label).toBe("A group text with me and the cleaner");
  });

  it("collects the door code on a private page that names ChatGPT, and has no alert page", async () => {
    const wired = await app();
    await toDoorCode(wired);
    const state = (await call(wired, "get_state")).structured ?? {};
    const ask = state.ask as { questions: { field: string; how: string }[] };
    expect(ask.questions.find((question) => question.field === "code")?.how).toMatch(/^Never in chat\..*private link/);
    expect(JSON.stringify(state)).not.toMatch(/secure card/);

    const issued = await call(wired, "save_door_code", { lockLocation: "front door keypad" });
    expect(issued.structured?.next).toBe(CHATGPT_DESK_WORDING.doorCodeUploadNext);
    const path = new URL(String(issued.structured?.uploadUrl)).pathname;
    const page = await publicRequest(wired, "GET", path);
    expect(page.status).toBe(200);
    expect(page.text).toContain("after you tell ChatGPT the guests have left");
    expect(page.text).toContain("10 minutes after ChatGPT made it");
    expect(page.text).not.toContain("Claude");
    const saved = await publicRequest(wired, "POST", path, form({ code: DOOR_CODE }));
    expect(saved.status).toBe(200);
    expect(saved.text).toContain("go back to ChatGPT");
    expect(saved.text).not.toContain(DOOR_CODE);
    const again = await publicRequest(wired, "GET", path);
    expect(again.status).toBe(404);
    expect(again.text).toContain("Go back to ChatGPT and ask for a new link.");
    // There is no Fire URL to paste, so no alert page opens.
    expect((await publicRequest(wired, "GET", "/cleaner-core/alert-routine/abcdefghijklmnopqrstuvwxyz012345")).status).toBe(404);
  });
});

describe("ChatGPT's hourly scheduled task", () => {
  it("is described in get_state with the prompt the template ships", () => {
    expect(CHATGPT_TASK.prompt).toBe(CHATGPT_TASK_PROMPT);
    const doc = read("chatgpt-template/routines/cleaner-core-task.md");
    expect(doc).toContain(["```text", CHATGPT_TASK_PROMPT, "```"].join("\n"));
    // An unattended run never holds a yes, never pauses itself, and never runs setup.
    expect(CHATGPT_TASK_PROMPT).toMatch(/only after the host replies yes in this conversation/);
    expect(CHATGPT_TASK_PROMPT).toMatch(/Never pause, edit, or delete this scheduled task/);
    expect(CHATGPT_TASK_PROMPT).toMatch(/Never call activate, run_checks, reset_property/);
    expect(CHATGPT_TASK_PROMPT).not.toMatch(/routine-fire-payload|Fire URL/);
  });

  it("is asked for after the preferences, connects with no URL, and lets check_now answer calmly before Activate", async () => {
    const wired = await app();
    await toRoutine(wired);
    const state = (await call(wired, "get_state")).structured ?? {};
    expect(state.next).toBe(CHATGPT_DESK_WORDING.routineAsk);
    expect(state.routine).toEqual(json(CHATGPT_TASK));

    const refused = await call(wired, "activate");
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(CHATGPT_DESK_WORDING.routineAsk);
    expect(refused.structured?.routine).toEqual(json(CHATGPT_TASK));

    // A ChatGPT task has no Fire URL or key to save.
    const withUrl = await call(wired, "save_alert_routine", { url: "https://hooks.example/wake", token: "made-up-token-for-tests" });
    expect(withUrl.isError).toBe(true);
    expect(withUrl.text).toBe(CHATGPT_DESK_WORDING.routineNeeded);

    const connected = await call(wired, "save_alert_routine");
    expect(connected.isError).toBe(false);
    expect(connected.structured?.next).toBe(`${CHATGPT_TASK_CONNECTED} Then call get_state for the review.`);
    expect(connected.structured?.uploadUrl).toBeUndefined();
    const review = (await call(wired, "get_state")).structured ?? {};
    expect(review.routine).toBeUndefined();
    expect(review.setup).toBeDefined();

    // The first hourly run before Activate gets a calm reply, not an error that pauses the task.
    const early = await call(wired, "check_now");
    expect(early.isError).toBe(false);
    expect(early.structured?.next).toBe("Cleaner Core isn't active yet. Post nothing.");
    expect(wired.cleanerSent).toEqual([]);
  });

  it("warns in get_state once no check has come in for over two and a half hours", async () => {
    const wired = await app();
    await toRoutine(wired);
    await call(wired, "save_alert_routine");
    expect((await call(wired, "activate")).isError).toBe(false);

    wired.advance(2 * HOUR);
    expect((await call(wired, "get_state")).structured?.warning).toBeUndefined();

    wired.advance(HOUR);
    const stale = (await call(wired, "get_state")).structured ?? {};
    expect(String(stale.warning)).toMatch(/^No check has reached Cleaner Core since .+\. The hourly ChatGPT scheduled task may be paused or deleted\./);
    expect(stale.routine).toEqual(json(CHATGPT_TASK));

    expect((await call(wired, "check_now")).isError).toBe(false);
    const fresh = (await call(wired, "get_state")).structured ?? {};
    expect(fresh.warning).toBeUndefined();
    expect(fresh.routine).toBeUndefined();
  });

  it("never posts a wake-up anywhere: the hourly run reads everything with check_now", async () => {
    const posts: string[] = [];
    setCleanerAlertFetch(async (url) => {
      posts.push(url);
      return { status: 200 };
    });
    const root = mkdtempSync(join(tmpdir(), "cleaner-chatgpt-alerts-"));
    roots.push(root);
    const env: NodeJS.ProcessEnv = { CLEANER_CORE_ENABLED: "1", CLEANER_CORE_ASSISTANT: "chatgpt", PUBLIC_BASE_URL: PUBLIC };
    const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
    const connected = await desk.saveAlertRoutine({}, () => {
      throw new Error("A ChatGPT task saves no secrets.");
    });
    expect(connected).toMatchObject({ ok: true, result: { next: CHATGPT_TASK_CONNECTED } });
    await drainCleanerAlerts(root, () => env, () => new Date(FROZEN));
    expect(posts).toEqual([]);

    let on = false;
    const sink = new ChatGptTaskSink(() => on);
    expect(sink.configured()).toBe(false);
    await expect(sink.deliver()).rejects.toThrow("Alerts aren't connected yet.");
    on = true;
    expect(sink.configured()).toBe(true);
    await expect(sink.deliver()).resolves.toBeUndefined();
    expect(testEvent(new Date(FROZEN)).eventType).toBe("installation.test");
  });
});

describe("Cleaner Core for ChatGPT, live", () => {
  it("texts the host to tell ChatGPT, and never names another chat", async () => {
    const wired = await app();
    await call(wired, "get_state", { choice: "cleaners" });
    await call(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE });
    await call(wired, "save_people", { host: HOST, cleaner: CLEANER });
    await call(wired, "save_calendar_link", { url: CALENDAR_URL });
    await call(wired, "save_door_code", { code: DOOR_CODE });
    await call(wired, "set_up_texting");
    const checks = await call(wired, "run_checks");
    expect(checks.isError).toBe(false);
    // The checks' own reply hands over the hourly task, as get_state does.
    expect(checks.structured?.next).toBe(CHATGPT_DESK_WORDING.routineAsk);
    expect(checks.structured?.routine).toEqual(json(CHATGPT_TASK));

    expect((await call(wired, "confirm_times", { checkout: "10:30", checkIn: "15:00" })).isError).toBe(false);
    const line = { to: CLEANER_LINE, token: CLEANER_AUTH };
    await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, body: "YES", sid: "SM-chatgpt-yes-1", ...line });
    await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, body: "YES", sid: "SM-chatgpt-yes-2", ...line });
    const before = wired.cleanerSent.length;
    await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, body: "STOP", sid: "SM-chatgpt-stop", ...line });
    const toHost = wired.cleanerSent.slice(before).filter((item) => item.to === HOST).map((item) => item.body);
    expect(toHost).toEqual([`The cleaner opted out of cleaning texts for ${ADDRESS}, so the cleaning is on hold. Find another cleaner or reach them directly, then tell ChatGPT to restart it.`]);
    expect(wired.cleanerSent.some((item) => /Grok|Claude/.test(item.body))).toBe(false);
  });
});

describe("ChatGPT template", () => {
  const files = filesUnder("chatgpt-template").filter((file) => /\.(md|json)$/.test(file));

  it("ships the guide and the task, for a deployment set to chatgpt", () => {
    for (const file of ["chatgpt-template/README.md", "chatgpt-template/SETUP_GUIDE.md", "chatgpt-template/template.json", "chatgpt-template/routines/cleaner-core-task.md"]) {
      expect(() => read(file), file).not.toThrow();
    }
    const manifest = JSON.parse(read("chatgpt-template/template.json")) as { hostedCleanerCoreUrl: string | null; deployment: { env: Record<string, string> } };
    // The one multi-tenant service every chat shares.
    expect(manifest.deployment.env).toEqual({ CLEANER_CORE_ENABLED: "1", CLEANER_CORE_MULTI_TENANT: "1" });
    for (const other of ["cleaner-template/template.json", "claude-template/template.json"]) {
      expect(manifest.hostedCleanerCoreUrl).toBe((JSON.parse(read(other)) as { hostedCleanerCoreUrl: string }).hostedCleanerCoreUrl);
    }
    for (const file of ["chatgpt-template/README.md", "chatgpt-template/SETUP_GUIDE.md"]) {
      expect(read(file), file).toContain(`${manifest.hostedCleanerCoreUrl}/mcp/cleaner-core`);
      expect(read(file), file).toMatch(/invite code/i);
      expect(read(file), file).not.toMatch(/CLEANER_CORE_ASSISTANT=chatgpt/);
    }
  });

  it("holds no secret, no real-looking phone number, and no door code", () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      const text = read(file);
      expect(text, file).not.toMatch(/sk-(?:ant-|proj-)?[A-Za-z0-9]{8}/);
      expect(text, file).not.toMatch(/(?:AC|SK)[0-9a-f]{32}/);
      for (const phone of text.match(/\+1\d{10}/g) ?? []) expect(phone, file).toMatch(/^\+1555555\d{4}$/);
      expect(text, file).not.toMatch(/door code (?:is|:)\s*\d{4,8}/i);
    }
  });
});
