import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_DESK_WORDING, CLAUDE_TASK } from "../src/cleaner-core/assistant";
import { resetLiveDesks, setCleanerAlertFetch } from "../src/cleaner-core/liveDesk";
import { closeHostedApps } from "./cleanerOauthHarness";
import { ADDRESS, BUSINESS, CALENDAR_URL, CLEANER, CLEANER_AUTH, CLEANER_LINE, CLEANER_TOKEN, DOOR_CODE, FROZEN, HOST, startWiredApp, type WiredApp } from "./wiringProof";

/**
 * On 2026-11-03 a Claude host saved a scheduled-task token the task refused. The test wake-up
 * failed, Activate went ahead anyway, and the cleaner's questions never woke the task. Nothing told
 * the host. Activate now waits for the test wake-up, and a wake-up that stops getting through is
 * named in get_state and check_now.
 */
const PATH = "/mcp/cleaner-core";
const ZONE = "America/New_York";
const FIRE_URL = "https://api.anthropic.com/v1/claude_code/routines/trig_01MADEUPWAKEHEALTH/fire";
const BAD_TOKEN = "made-up-refused-token-for-tests";
const GOOD_TOKEN = "made-up-accepted-token-for-tests";
const REFUSED = "The Claude scheduled task refused its token. Make a new token and save it again.";

const open: WiredApp[] = [];

afterEach(async () => {
  setCleanerAlertFetch(undefined);
  closeHostedApps();
  resetLiveDesks();
  while (open.length > 0) await open.pop()?.close();
});

/** The task's Fire URL: 200 for the accepted token, 401 for any other. Counts every wake-up. */
function fireEndpoint() {
  const wakes: { token: string; eventType: string }[] = [];
  let accepted = GOOD_TOKEN;
  setCleanerAlertFetch(async (_url, init) => {
    const token = init.headers.Authorization?.replace(/^Bearer /, "") ?? "";
    const event = JSON.parse((JSON.parse(init.body) as { text: string }).text) as { eventType: string };
    wakes.push({ token, eventType: event.eventType });
    return { status: token === accepted ? 200 : 401 };
  });
  return { wakes, accept: (token: string) => (accepted = token) };
}

/** A clock that moves a second each time it is read, so each wake-up has its own time. */
async function claudeApp(): Promise<WiredApp> {
  let at = new Date(FROZEN).getTime();
  const wired = await startWiredApp({ now: () => new Date((at += 1000)) });
  open.push(wired);
  wired.setEnv({ CLEANER_CORE_ASSISTANT: "claude" });
  return wired;
}

const call = (wired: WiredApp, name: string, args: Record<string, unknown> = {}) => wired.tool(PATH, CLEANER_TOKEN, name, args);

/** Setup up to Activate, the way Claude drives it, with the task saved under `token`. */
async function toActivate(wired: WiredApp, token: string): Promise<void> {
  await call(wired, "get_state", { choice: "cleaners" });
  await call(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: ZONE, checkoutTime: "10:30", checkInTime: "15:00" });
  await call(wired, "save_sources", { calendars: [{ name: "Airbnb", url: CALENDAR_URL }] });
  await call(wired, "save_sources", { done: true });
  await call(wired, "save_people", { host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-only" });
  await call(wired, "save_schedule", { firstText: "days-before-checkout", firstTextDays: 1 });
  await call(wired, "save_door_code", { code: DOOR_CODE, lockLocation: "front door keypad" });
  await call(wired, "save_preferences", {});
  await call(wired, "save_payments", { on: false });
  const saved = await call(wired, "save_alert_routine", { url: FIRE_URL, token });
  expect(saved.isError, saved.text).toBe(false);
}

describe("Activate waits for the test wake-up", () => {
  it("refuses while the task refuses its token, texts nobody, and goes ahead once a new token works", async () => {
    const fire = fireEndpoint();
    const wired = await claudeApp();
    await toActivate(wired, BAD_TOKEN);

    const refused = await call(wired, "activate");
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(REFUSED);
    expect(refused.text).toContain(CLAUDE_DESK_WORDING.routineNeeded);
    expect(refused.structured?.routine).toEqual(JSON.parse(JSON.stringify(CLAUDE_TASK)));
    expect(refused.text).not.toContain(BAD_TOKEN);
    expect(wired.cleanerSent).toEqual([]);
    expect(fire.wakes.some((wake) => wake.eventType === "installation.test" && wake.token === BAD_TOKEN)).toBe(true);

    // get_state says the same before Activate is tried again.
    const state = (await call(wired, "get_state")).structured ?? {};
    expect(String(state.warning)).toContain(REFUSED);

    expect((await call(wired, "save_alert_routine", { url: FIRE_URL, token: GOOD_TOKEN })).isError).toBe(false);
    const activated = await call(wired, "activate");
    expect(activated.isError, activated.text).toBe(false);
    expect(fire.wakes.some((wake) => wake.eventType === "installation.test" && wake.token === GOOD_TOKEN)).toBe(true);
    expect((await call(wired, "get_state")).structured?.warning).toBeUndefined();
  });

  it("goes ahead at once when the first token works", async () => {
    fireEndpoint();
    const wired = await claudeApp();
    await toActivate(wired, GOOD_TOKEN);
    const activated = await call(wired, "activate");
    expect(activated.isError, activated.text).toBe(false);
  });
});

describe("a wake-up that stops getting through", () => {
  it("is named in get_state and once in check_now, and clears when a wake-up gets through again", async () => {
    const fire = fireEndpoint();
    const wired = await claudeApp();
    await toActivate(wired, GOOD_TOKEN);
    expect((await call(wired, "activate")).isError).toBe(false);
    // Reads what Activate itself raised, so only the new problem is left.
    await call(wired, "check_now");

    // The host regenerates the token on the task's page and doesn't save the new one.
    fire.accept("");
    const line = { to: CLEANER_LINE, token: CLEANER_AUTH };
    await wired.postTwilio("/webhooks/twilio/cleaner-core", { from: CLEANER, body: "Will I need to bring paper towels?", sid: "SM-wake-health-1", ...line });
    await vi.waitFor(() => expect(fire.wakes.some((wake) => wake.eventType === "cleaning.update")).toBe(true));

    const state = (await call(wired, "get_state")).structured ?? {};
    expect(String(state.warning)).toContain(REFUSED);
    expect(state.routine).toEqual(JSON.parse(JSON.stringify(CLAUDE_TASK)));

    const first = (await call(wired, "check_now")).structured ?? {};
    const alerts = (first.alerts as string[]) ?? [];
    expect(alerts.filter((alert) => alert.includes(REFUSED))).toHaveLength(1);
    expect((first.messages as { text: string }[]).map((message) => message.text)).toEqual(["Will I need to bring paper towels?"]);
    const second = (await call(wired, "check_now")).structured ?? {};
    expect(((second.alerts as string[]) ?? []).some((alert) => alert.includes(REFUSED))).toBe(false);

    // Saving the new token sends a test that gets through, and the warning goes.
    fire.accept(GOOD_TOKEN);
    expect((await call(wired, "save_alert_routine", { url: FIRE_URL, token: GOOD_TOKEN })).isError).toBe(false);
    await vi.waitFor(async () => expect((await call(wired, "get_state")).structured?.warning).toBeUndefined());
  });
});
