import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_ROUTINE_BETA, ClaudeRoutineFireSink, GrokRoutineWebhookSink, testEvent } from "../src/alerts/operatorEvents";
import { CLAUDE_DESK_WORDING, CLAUDE_INSTRUCTIONS, CLAUDE_TASK, CLAUDE_TASK_PROMPT, cleanerAssistant } from "../src/cleaner-core/assistant";
import { cleanerOptOutHold, hostStartReply, injuryHoldLine, ownerOptOutHoldNote } from "../src/cleaner-core/cleanerTexts";
import { drainCleanerAlerts, liveDeskFor, resetLiveDesks, setCleanerAlertFetch, type LiveDesk } from "../src/cleaner-core/liveDesk";
import { handleCleanerMcpMessage } from "../src/cleaner-core/mcp";
import { photoKey, photoLinks, storePhoto } from "../src/cleaner-core/photos";
import { reviewAlert } from "../src/cleaner-core/review";
import { DEFAULT_REDIRECT_HOSTS, redirectHostsFromEnv } from "../src/mcp/oauth/clients";
import { consentPage } from "../src/mcp/oauth/pages";
import { closeHostedApps } from "./cleanerOauthHarness";
import { PUBLIC } from "./fakeSendblue";
import { filesUnder } from "./files";
import { ADDRESS, BUSINESS, CALENDAR_URL, CLEANER, CLEANER_AUTH, CLEANER_LINE, CLEANER_TOKEN, DOOR_CODE, FROZEN, HOST, startWiredApp, type WiredApp } from "./wiringProof";

const PATH = "/mcp/cleaner-core";
const ZONE = "America/New_York";
const FIRE_URL = "https://api.anthropic.com/v1/claude_code/routines/trig_01MADEUPTESTTRIGGER/fire";
const FIRE_TOKEN = "made-up-claude-routine-token-for-tests";
/** The Grok deployment's initialize instructions, byte for byte, as they were before Claude. */
const GROK_INSTRUCTIONS_SHA256 = "38912ee86f75a69108891b2126ef95a3420fa943754bdebdced561d6802b07e3";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const open: WiredApp[] = [];
const roots: string[] = [];

afterEach(async () => {
  setCleanerAlertFetch(undefined);
  closeHostedApps();
  resetLiveDesks();
  while (open.length > 0) await open.pop()?.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function app(claude: boolean): Promise<WiredApp> {
  const started = await startWiredApp();
  open.push(started);
  if (claude) started.setEnv({ CLEANER_CORE_ASSISTANT: "claude" });
  return started;
}

function call(wired: WiredApp, name: string, args: Record<string, unknown> = {}) {
  return wired.tool(PATH, CLEANER_TOKEN, name, args);
}

async function initialize(assistant?: "grok" | "claude"): Promise<string> {
  // initialize never touches the desk.
  const reply = await handleCleanerMcpMessage({} as LiveDesk, { jsonrpc: "2.0", id: 1, method: "initialize" }, undefined, false, undefined, undefined, assistant);
  return String((reply.body as { result: { instructions: string } }).result.instructions);
}

/** A request as the public internet sends it: to the public host, not 127.0.0.1. */
function publicRequest(wired: WiredApp, method: string, path: string, body?: { type: string; text: string }): Promise<{ status: number; text: string; headers: Record<string, string | string[] | undefined> }> {
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
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
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
  await call(wired, "save_people", { host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
  await call(wired, "save_schedule", { firstText: "days-before-checkout", firstTextDays: 1 });
}

describe("Cleaner Core for Grok stays as it was", () => {
  it("is Grok unless CLEANER_CORE_ASSISTANT is exactly claude", () => {
    expect(cleanerAssistant({})).toBe("grok");
    expect(cleanerAssistant({ CLEANER_CORE_ASSISTANT: "grok" })).toBe("grok");
    expect(cleanerAssistant({ CLEANER_CORE_ASSISTANT: "claude-ish" })).toBe("grok");
    expect(cleanerAssistant({ CLEANER_CORE_ASSISTANT: " Claude " })).toBe("claude");
  });

  it("keeps the Grok initialize instructions byte for byte", async () => {
    const text = await initialize();
    expect(createHash("sha256").update(text).digest("hex")).toBe(GROK_INSTRUCTIONS_SHA256);
    expect(await initialize("grok")).toBe(text);
  });

  it("keeps every host text naming the Grok Bot", () => {
    expect(cleanerOptOutHold(ADDRESS)).toContain("then tell your Grok Bot to restart it.");
    expect(injuryHoldLine(ADDRESS)).toContain("tell your Grok Bot to restart it.");
    expect(ownerOptOutHoldNote(ADDRESS)).toContain("Tell your Grok Bot to restart it.");
    expect(hostStartReply(ADDRESS, true)).toContain("Tell your Grok Bot to restart it.");
    expect(reviewAlert("uncertain-sms", ADDRESS, { day: "Friday" })).toContain("Tell your Grok Bot if you want it sent again.");
  });

  it("keeps Grok's redirect hosts and approval page", () => {
    expect(redirectHostsFromEnv({})).toEqual(DEFAULT_REDIRECT_HOSTS);
    const page = consentPage({ requestId: "r", matchCode: "123456", clientName: "Grok", redirectHost: "grok.com", hosted: true, firstClaim: true, label: "Cleaner Core" });
    expect(page).toContain("<h1>Connect your Grok Bot to Cleaner Core</h1>");
    expect(page).not.toContain("owner");
    expect(page).not.toContain("Claude");
  });

  it("asks Grok for its secure card and gives no upload page", async () => {
    const wired = await app(false);
    await toDoorCode(wired);
    const ask = (await call(wired, "get_state")).structured?.ask as { questions: { field: string; how: string }[] };
    expect(ask.questions.find((question) => question.field === "code")?.how).toMatch(/^Only on your secure card\./);
    const issued = await call(wired, "save_door_code", { lockLocation: "front door keypad" });
    expect(String(issued.structured?.next)).toMatch(/^From your own cloud computer, POST JSON/);
    const path = new URL(String(issued.structured?.uploadUrl)).pathname;
    // A browser can't open the link, and a form post is refused before it is read.
    expect((await publicRequest(wired, "GET", path)).status).toBe(404);
    expect((await publicRequest(wired, "POST", path, form({ code: DOOR_CODE }))).status).toBe(415);
  });
});

describe("Cleaner Core for Claude", () => {
  it("gives Claude its own instructions, in the same setup order, with no secure card", async () => {
    const text = await initialize("claude");
    expect(text).toBe(CLAUDE_INSTRUCTIONS);
    expect(text).not.toMatch(/secure card|own computer|choice card|Grok/);
    expect(text.startsWith("Call get_state first and follow its next step.")).toBe(true);
    const order = ["save_property", "save_sources", "save_people", "save_schedule", "save_door_code", "save_preferences", "activate"];
    const positions = order.map((tool) => text.indexOf(tool));
    for (const [i, p] of positions.entries()) expect(p, order[i]).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("names Claude in host texts and on the approval page, and takes claude.ai's callback", () => {
    expect(cleanerOptOutHold(ADDRESS, "Claude")).toContain("then tell Claude to restart it.");
    expect(reviewAlert("missed-reminder", ADDRESS, { day: "Friday" }, "Claude")).toContain("Tell Claude if you want it sent again.");
    expect(CLAUDE_DESK_WORDING.pinFailed).toBe("The door code didn't reach the cleaner. Tell Claude the guests have left and I'll resend it.");
    expect(redirectHostsFromEnv({ CLEANER_CORE_ASSISTANT: "claude" })).toEqual([...DEFAULT_REDIRECT_HOSTS, "claude.ai"]);
    const page = consentPage({ requestId: "r", matchCode: "123456", clientName: "Claude", redirectHost: "claude.ai", hosted: true, firstClaim: true, label: "Cleaner Core", assistant: "claude" });
    expect(page).toContain("<h1>Connect Claude to Cleaner Core</h1>");
    expect(page).not.toContain("owner");
    expect(page).not.toContain("Grok");
  });

  it("collects the door code on a private page the host opens, never in chat", async () => {
    const wired = await app(true);
    await toDoorCode(wired);
    const state = (await call(wired, "get_state")).structured ?? {};
    expect(String(state.next)).toContain("Show any options as a short list of choices.");
    const ask = state.ask as { questions: { field: string; how: string }[] };
    expect(ask.questions.find((question) => question.field === "code")?.how).toMatch(/^Never in chat\..*private link/);
    expect(JSON.stringify(state)).not.toMatch(/secure card/);

    const issued = await call(wired, "save_door_code", { lockLocation: "front door keypad" });
    expect(issued.structured?.next).toBe(CLAUDE_DESK_WORDING.doorCodeUploadNext);
    const path = new URL(String(issued.structured?.uploadUrl)).pathname;

    const page = await publicRequest(wired, "GET", path);
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toMatch(/^text\/html/);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.text).toContain('name="code"');
    // Opening the page doesn't use the link up.
    expect((await publicRequest(wired, "GET", path)).status).toBe(200);

    const wrong = await publicRequest(wired, "POST", path, form({ code: "12" }));
    expect(wrong.status).toBe(400);
    expect(wrong.text).toContain("Type the door code as 4 to 8 digits.");

    const saved = await publicRequest(wired, "POST", path, form({ code: DOOR_CODE }));
    expect(saved.status).toBe(200);
    expect(saved.text).toContain("Saved the door code.");
    expect(saved.text).not.toContain(DOOR_CODE);
    expect((await call(wired, "get_state")).structured?.done).toContain("Door code saved.");

    // Used once.
    const again = await publicRequest(wired, "GET", path);
    expect(again.status).toBe(404);
    expect(again.text).toContain("It was already used, or it expired");
    // Nothing on disk holds the code in the clear.
    for (const file of filesUnder(wired.root)) expect(readFileSync(file, "utf8").includes(`"${DOOR_CODE}"`), file).toBe(false);
  });

  it("saves a calendar link from its private page, named on the page", async () => {
    const wired = await app(true);
    await call(wired, "get_state", { choice: "cleaners" });
    await call(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "10:30", checkInTime: "15:00" });
    const ask = (await call(wired, "get_state")).structured?.ask as { questions: { field: string; how: string }[] };
    expect(ask.questions.find((question) => question.field === "calendars")?.how).toMatch(/^Never in chat\./);
    const issued = await call(wired, "save_sources", { uploadLink: { name: "Guesty Lite" } });
    expect(issued.structured?.next).toBe(CLAUDE_DESK_WORDING.calendarUploadNext);
    const path = new URL(String(issued.structured?.uploadUrl)).pathname;
    expect((await publicRequest(wired, "GET", path)).text).toContain("Paste the export link for Guesty Lite.");
    expect((await publicRequest(wired, "POST", path, form({ url: "http://calendar.example/not-https.ics" }))).status).toBe(400);
    const saved = await publicRequest(wired, "POST", path, form({ url: CALENDAR_URL }));
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain(CALENDAR_URL);
    expect((await call(wired, "get_state")).structured?.done).toContain("Calendar link saved.");
  });

  it("still takes a JSON upload, for Claude Code posting from its own computer", async () => {
    const wired = await app(true);
    await toDoorCode(wired);
    const issued = await call(wired, "save_door_code", { lockLocation: "front door keypad" });
    const path = new URL(String(issued.structured?.uploadUrl)).pathname;
    const posted = await publicRequest(wired, "POST", path, { type: "application/json", text: JSON.stringify({ code: DOOR_CODE }) });
    expect(posted.status).toBe(200);
    expect(JSON.parse(posted.text)).toMatchObject({ ok: true });
  });
});

describe("Cleaner Core for Claude, live", () => {
  it("hands Claude the scheduled task and texts the host to tell Claude", async () => {
    const wired = await app(true);
    await call(wired, "get_state", { choice: "cleaners" });
    await call(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE });
    await call(wired, "save_people", { host: HOST, cleaner: CLEANER });
    await call(wired, "save_calendar_link", { url: CALENDAR_URL });
    await call(wired, "save_door_code", { code: DOOR_CODE });
    await call(wired, "set_up_texting");
    const checks = await call(wired, "run_checks");
    expect(checks.isError).toBe(false);
    // The checks' own reply hands over the scheduled task, as get_state does.
    expect(checks.structured?.next).toBe(CLAUDE_DESK_WORDING.routineAsk);
    expect(checks.structured?.routine).toEqual(JSON.parse(JSON.stringify(CLAUDE_TASK)));
    const state = (await call(wired, "get_state")).structured ?? {};
    expect(state.next).toBe(CLAUDE_DESK_WORDING.routineAsk);
    expect(state.routine).toEqual(JSON.parse(JSON.stringify(CLAUDE_TASK)));

    expect((await call(wired, "confirm_times", { checkout: "10:30", checkIn: "15:00" })).isError).toBe(false);
    const line = { to: CLEANER_LINE, token: CLEANER_AUTH };
    await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, body: "YES", sid: "SM-claude-yes-1", ...line });
    await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, body: "YES", sid: "SM-claude-yes-2", ...line });
    const before = wired.cleanerSent.length;
    await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, body: "STOP", sid: "SM-claude-stop", ...line });
    const toHost = wired.cleanerSent.slice(before).filter((item) => item.to === HOST).map((item) => item.body);
    expect(toHost).toEqual([`The cleaner opted out of cleaning texts for ${ADDRESS}, so the cleaning is on hold. Find another cleaner or reach them directly, then tell Claude to restart it.`]);
    expect(wired.cleanerSent.some((item) => item.body.includes("Grok"))).toBe(false);
  });
});

describe("Claude's scheduled task comes before Activate", () => {
  it("asks for the task after the preferences, and Activate hands it over until it is connected", async () => {
    const wired = await app(true);
    await toDoorCode(wired);
    await call(wired, "save_door_code", { code: DOOR_CODE, lockLocation: "front door keypad" });
    await call(wired, "save_preferences", {});
    await call(wired, "save_payments", { on: false });
    const state = (await call(wired, "get_state")).structured ?? {};
    expect(state.next).toBe(CLAUDE_DESK_WORDING.routineAsk);
    expect(state.routine).toEqual(JSON.parse(JSON.stringify(CLAUDE_TASK)));
    const refused = await call(wired, "activate");
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(CLAUDE_DESK_WORDING.routineAsk);
    expect(refused.structured?.routine).toEqual(JSON.parse(JSON.stringify(CLAUDE_TASK)));
    expect(wired.cleanerSent).toEqual([]);
  });
});

describe("Claude's scheduled task", () => {
  it("is described in get_state with the prompt the template ships", () => {
    expect(CLAUDE_TASK.prompt).toBe(CLAUDE_TASK_PROMPT);
    const doc = read("claude-template/routines/cleaner-core-task.md");
    expect(doc).toContain(["```text", CLAUDE_TASK_PROMPT, "```"].join("\n"));
    // An unattended run never holds a yes.
    expect(CLAUDE_TASK_PROMPT).toMatch(/only after the host replies yes in this session/);
    expect(CLAUDE_TASK_PROMPT).toMatch(/routine-fire-payload/);
  });

  it("connects from its private page and wakes the task with { text } at its Fire URL", async () => {
    const posts: { url: string; headers: Record<string, string>; body: string }[] = [];
    setCleanerAlertFetch(async (url, init) => {
      posts.push({ url, headers: init.headers, body: init.body });
      return { status: 200 };
    });
    const root = mkdtempSync(join(tmpdir(), "cleaner-claude-alerts-"));
    roots.push(root);
    const env: NodeJS.ProcessEnv = { CLEANER_CORE_ENABLED: "1", CLEANER_CORE_ASSISTANT: "claude", PUBLIC_BASE_URL: PUBLIC };
    const saved: Record<string, string> = {};
    const save = (values: Record<string, string>) => {
      Object.assign(saved, values);
      Object.assign(env, values);
    };
    const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
    const issued = await desk.saveAlertRoutine({}, save);
    if (!issued.ok) throw new Error(issued.error);
    expect(issued.result.next).toBe(CLAUDE_DESK_WORDING.alertUploadNext);
    const code = new URL(String(issued.result.uploadUrl)).pathname.split("/").pop() ?? "";
    // A Claude deployment wakes only a scheduled task's Fire URL.
    expect((await desk.uploadAlertRoutine(code, { url: "https://hooks.example/wake", token: FIRE_TOKEN }, save)).status).toBe(400);
    expect((await desk.uploadAlertRoutine(code, { url: FIRE_URL, token: FIRE_TOKEN }, save)).status).toBe(200);
    expect(saved).toEqual({ CLEANER_CORE_ROUTINE_URL: FIRE_URL, CLEANER_CORE_ROUTINE_KEY: FIRE_TOKEN });
    await drainCleanerAlerts(root, () => env, () => new Date(FROZEN));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe(FIRE_URL);
    expect(posts[0]?.headers).toMatchObject({ Authorization: `Bearer ${FIRE_TOKEN}`, "anthropic-beta": CLAUDE_ROUTINE_BETA, "anthropic-version": "2023-06-01" });
    const text = (JSON.parse(posts[0]?.body ?? "{}") as { text: string }).text;
    expect(JSON.parse(text)).toMatchObject({ schemaVersion: 1, eventType: "installation.test" });
  });

  it("sends the Grok Routine the bare event and the Claude task { text }", async () => {
    const bodies: string[] = [];
    const fetch = async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return { status: 200 };
    };
    const settings = { url: () => FIRE_URL, key: () => FIRE_TOKEN };
    const event = testEvent(new Date(FROZEN));
    await new GrokRoutineWebhookSink(settings, { fetch }).deliver(event);
    await new ClaudeRoutineFireSink(settings, { fetch }).deliver(event);
    expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({ eventType: "installation.test" });
    expect(JSON.parse(String((JSON.parse(bodies[1] ?? "{}") as { text: string }).text))).toEqual(JSON.parse(bodies[0] ?? "{}"));
  });
});

describe("Claude sees the cleaning photos", () => {
  it("turns signed photo links into images, and leaves HEIC as a link", async () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-claude-photos-"));
    roots.push(root);
    const env: NodeJS.ProcessEnv = { CLEANER_CORE_ENABLED: "1", CLEANER_CORE_ASSISTANT: "claude", CLEANER_CORE_PHOTO_KEY: "made-up-photo-key-for-claude-tests-0123", PUBLIC_BASE_URL: PUBLIC };
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    storePhoto(root, "job-claude", { bytes: jpeg, ext: "jpg" });
    storePhoto(root, "job-claude", { bytes: Buffer.from("heic-bytes"), ext: "heic" });
    const links = photoLinks(root, "job-claude", PUBLIC, photoKey(env)!, new Date(FROZEN));
    expect(links).toHaveLength(2);
    const desk = liveDeskFor(root, () => env, () => new Date(FROZEN));
    expect(desk.photoImages(links)).toEqual([{ type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" }]);
    // A link that isn't signed by this key shows nothing.
    expect(desk.photoImages([{ url: `${PUBLIC}/cleaner-core/photos/not-a-real-token` }])).toEqual([]);
  });
});

describe("Claude template", () => {
  const files = filesUnder("claude-template").filter((file) => /\.(md|json)$/.test(file));

  it("ships the guide, the task, and the plugin", () => {
    for (const file of ["claude-template/README.md", "claude-template/SETUP_GUIDE.md", "claude-template/images/how-it-connects.png", "claude-template/images/setup-path.png", "claude-template/template.json", "claude-template/routines/cleaner-core-task.md", "claude-template/plugin/.claude-plugin/plugin.json", "claude-template/plugin/skills/cleaner-core/SKILL.md", ".claude-plugin/marketplace.json"]) {
      expect(() => read(file), file).not.toThrow();
    }
    const manifest = JSON.parse(read("claude-template/template.json")) as { hostedCleanerCoreUrl: string; deployment: { env: Record<string, string> } };
    // The one multi-tenant service every chat shares. Its chat comes from the connection, not the deployment.
    expect(manifest.deployment.env).toEqual({ CLEANER_CORE_ENABLED: "1", CLEANER_CORE_MULTI_TENANT: "1" });
    const grok = (JSON.parse(read("cleaner-template/template.json")) as { hostedCleanerCoreUrl: string }).hostedCleanerCoreUrl;
    expect(manifest.hostedCleanerCoreUrl).toBe(grok);
    expect(read("claude-template/plugin/skills/cleaner-core/SKILL.md")).toContain(`${manifest.hostedCleanerCoreUrl}/mcp/cleaner-core`);
    for (const file of ["claude-template/README.md", "claude-template/SETUP_GUIDE.md"]) {
      expect(read(file), file).toContain(`${manifest.hostedCleanerCoreUrl}/mcp/cleaner-core`);
      expect(read(file), file).toMatch(/invite code/i);
      expect(read(file), file).not.toMatch(/tourcore-production-1056|CLEANER_CORE_ASSISTANT=claude/);
    }
  });

  it("holds no secret, no real-looking phone number, and no door code", () => {
    for (const file of [...files, ".claude-plugin/marketplace.json"]) {
      const text = read(file);
      expect(text, file).not.toMatch(/sk-ant-[A-Za-z0-9]/);
      expect(text, file).not.toMatch(/(?:AC|SK)[0-9a-f]{32}/);
      for (const phone of text.match(/\+1\d{10}/g) ?? []) expect(phone, file).toMatch(/^\+1555555\d{4}$/);
      expect(text, file).not.toMatch(/door code (?:is|:)\s*\d{4,8}/i);
    }
  });
});
