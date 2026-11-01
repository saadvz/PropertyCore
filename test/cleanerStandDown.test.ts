import { afterEach, describe, expect, it } from "vitest";
import { liveDeskFor } from "../src/cleaner-core/liveDesk";
import { ADDRESS, BUSINESS, CALENDAR_URL, CLEANER, CLEANER_AUTH, CLEANER_LINE, CLEANER_TOKEN, DOOR_CODE, HOST, startWiredApp, type WiredApp } from "./wiringProof";

/** What's live on a cleaning desk, and standing it down so the number can switch. Only 555 numbers. */

const MCP = "/mcp/cleaner-core";
const SMS_PATH = "/webhooks/twilio/cleaner-core";
const open: WiredApp[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

async function must(wired: WiredApp, name: string, args: Record<string, unknown> = {}) {
  const reply = await wired.tool(MCP, CLEANER_TOKEN, name, args);
  expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
  return reply.structured ?? {};
}

let sid = 0;
const sms = (wired: WiredApp, from: string, body: string) => wired.postTwilio(SMS_PATH, { from, to: CLEANER_LINE, body, sid: `SMstand${++sid}`, token: CLEANER_AUTH });

/** A desk with one cleaning offered to a cleaner who said YES to cleaning texts. */
async function confirmed() {
  const wired = await startWiredApp();
  open.push(wired);
  await must(wired, "get_state", { choice: "cleaners" });
  await must(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
  await must(wired, "save_people", { host: HOST, cleaner: CLEANER, cleanerName: "Mike", groupChat: "cleaner-only" });
  await must(wired, "save_calendar_link", { url: CALENDAR_URL });
  await must(wired, "save_door_code", { code: DOOR_CODE });
  await must(wired, "set_up_texting");
  await must(wired, "run_checks");
  await must(wired, "confirm_times", { checkout: "11:00", checkIn: "16:00" });
  await sms(wired, HOST, "YES");
  await sms(wired, CLEANER, "YES");
  const desk = liveDeskFor(wired.root, wired.env, () => new Date());
  return { wired, desk };
}

describe("what's live on cleaning", () => {
  it("lists a cleaning the cleaner said YES to", async () => {
    const { desk } = await confirmed();
    const work = await desk.liveWork();
    expect(work.inProgress).toBe(false);
    expect(work.live.length).toBeGreaterThan(0);
    expect(work.live[0]).toMatch(/^The cleaning for checkout on .+ is (offered|confirmed)\.$/);
  });
});

describe("standing cleaning down", () => {
  it("previews the cleaner's text, then sends exactly that once and leaves nothing live", async () => {
    const { wired, desk } = await confirmed();
    const asked = await desk.standDown({});
    expect(asked.ok).toBe(true);
    const result = asked.ok ? (asked.result as { next: string; confirmation: { code: string }; texts: { to: string; body: string }[] }) : undefined;
    expect(result!.texts).toEqual([{ to: "Mike", body: expect.stringMatching(new RegExp(`^Update: the cleaning at ${ADDRESS} on .+ is canceled, so no need to come\\. Reply STOP to opt out\\.$`)) }]);
    expect(result!.next).toContain("Reply yes to stand down.");
    const before = wired.cleanerSent.length;
    const done = await desk.standDown({ confirmation: result!.confirmation.code });
    expect(done.ok).toBe(true);
    const sent = wired.cleanerSent.slice(before);
    expect(sent.map((s) => s.body)).toEqual([result!.texts[0]!.body]);
    expect(sent[0]!.to).toBe(CLEANER);
    expect((await desk.liveWork()).live).toEqual([]);
  });

  it("refuses a stale code", async () => {
    const { desk } = await confirmed();
    const done = await desk.standDown({ confirmation: "not-a-real-code" });
    expect(done.ok).toBe(false);
  });

  it("refuses while a cleaning is under way", async () => {
    const { wired, desk } = await confirmed();
    await sms(wired, CLEANER, "YES");
    await must(wired, "mark_guests_left", { confirmed: true });
    const asked = await desk.standDown({});
    expect(asked.ok).toBe(false);
    expect(asked.ok ? "" : asked.error).toBe("A cleaning is under way. Stand down after it's done.");
  });
});
