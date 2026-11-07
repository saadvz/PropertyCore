import { afterEach, describe, expect, it } from "vitest";
import { cleanerNextStep } from "../src/cleaner-core/cleanerTexts";
import { setCleanerGroupFetch } from "../src/cleaner-core/liveSms";
import { twilioSignature } from "../src/messaging/twilio/signature";
import { fakeConversations } from "./fakeConversations";
import { PUBLIC } from "./fakeSendblue";
import { ADDRESS, BUSINESS, CALENDAR_URL, CLEANER, CLEANER_AUTH, CLEANER_LINE, CLEANER_TOKEN, DOOR_CODE, HOST, startWiredApp, type WiredApp } from "./wiringProof";

/**
 * Twilio hands a group reply to Cleaner Core twice: once through the group conversation's
 * webhook (an IM sid), and once through the cleaning number's own SMS webhook (an MM sid).
 * On 2026-11-03 one "Yes" got the confirmation and then "The door code comes after the guests
 * leave." from the second copy.
 */
describe("a group reply that Twilio delivers through both webhooks", () => {
  const MCP = "/mcp/cleaner-core";
  const HOOK_PATH = "/webhooks/twilio/cleaner-core/conversation";
  const SMS_PATH = "/webhooks/twilio/cleaner-core";
  const HOOK_URL = `${PUBLIC}${HOOK_PATH}`;
  const CONFIRMED = /^Cleaning is scheduled for /;
  const WAIT_FOR_GUESTS = cleanerNextStep("waiting-for-guests");
  const opened: WiredApp[] = [];
  let seq = 0;

  afterEach(async () => {
    setCleanerGroupFetch(undefined);
    while (opened.length > 0) await opened.pop()?.close();
  });

  async function start() {
    const fake = fakeConversations();
    setCleanerGroupFetch(fake.impl);
    const wired = await startWiredApp({ groupChat: true, allowlist: `${HOST},${CLEANER}` });
    opened.push(wired);
    return { fake, wired };
  }
  async function must(wired: WiredApp, name: string, args: Record<string, unknown> = {}) {
    const reply = await wired.tool(MCP, CLEANER_TOKEN, name, args);
    expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
    return reply.structured ?? {};
  }
  /** A one-to-one text, or a group reply as the number's SMS webhook sees it. */
  const sms = (wired: WiredApp, from: string, body: string, prefix = "SM") =>
    wired.postTwilio(SMS_PATH, { from, to: CLEANER_LINE, body, sid: `${prefix}double${++seq}`, token: CLEANER_AUTH });
  async function inGroup(wired: WiredApp, conversationSid: string, author: string, body: string) {
    const fields = {
      EventType: "onMessageAdded",
      ConversationSid: conversationSid,
      MessageSid: `IMdouble${(++seq).toString(16).padStart(24, "0")}`,
      Index: String(seq),
      Author: author,
      Body: body,
      Source: "SMS",
    };
    const headers = { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": twilioSignature(CLEANER_AUTH, HOOK_URL, fields) };
    const res = await fetch(`http://127.0.0.1:${wired.port}${HOOK_PATH}`, { method: "POST", headers, body: new URLSearchParams(fields).toString() });
    expect(res.status).toBe(200);
  }
  /** Setup through the offer in the group. The cleaner's join YES comes one-to-one, before the group exists. */
  async function offered() {
    const { fake, wired } = await start();
    await must(wired, "get_state", { choice: "cleaners" });
    await must(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
    await must(wired, "save_people", { host: HOST, cleaner: CLEANER, cleanerName: "Mike" });
    await must(wired, "save_calendar_link", { url: CALENDAR_URL });
    await must(wired, "save_door_code", { code: DOOR_CODE });
    await must(wired, "set_up_texting");
    await must(wired, "run_checks");
    await must(wired, "confirm_times", { checkout: "11:00", checkIn: "16:00" });
    expect((await sms(wired, HOST, "YES")).status).toBe(200);
    expect((await sms(wired, CLEANER, "YES")).status).toBe(200);
    expect(fake.created).toHaveLength(1);
    expect(fake.posts.some((post) => post.body.includes("Mike, reply YES to schedule it"))).toBe(true);
    return { fake, wired, sid: fake.created[0] ?? "" };
  }
  const bodiesSince = (fake: ReturnType<typeof fakeConversations>, from: number) => fake.posts.slice(from).map((post) => post.body);

  it("answers the cleaner's YES once when the group copy comes first", async () => {
    const { fake, wired, sid } = await offered();
    const before = fake.posts.length;
    await inGroup(wired, sid, CLEANER, "Yes");
    expect((await sms(wired, CLEANER, "Yes", "MM")).status).toBe(200);
    expect(bodiesSince(fake, before)).toEqual([expect.stringMatching(CONFIRMED)]);
  });

  it("answers the cleaner's YES once when the SMS copy comes first", async () => {
    const { fake, wired, sid } = await offered();
    const before = fake.posts.length;
    expect((await sms(wired, CLEANER, "Yes", "MM")).status).toBe(200);
    await inGroup(wired, sid, CLEANER, "Yes");
    expect(bodiesSince(fake, before)).toEqual([expect.stringMatching(CONFIRMED)]);
  });

  it("still answers a second YES the cleaner sends in the group", async () => {
    const { fake, wired, sid } = await offered();
    const before = fake.posts.length;
    await inGroup(wired, sid, CLEANER, "Yes");
    await inGroup(wired, sid, CLEANER, "Yes");
    expect(bodiesSince(fake, before)).toEqual([expect.stringMatching(CONFIRMED), WAIT_FOR_GUESTS]);
  });

  it("keeps the cleaner's question once for the assistant to read", async () => {
    const { wired, sid } = await offered();
    await inGroup(wired, sid, CLEANER, "Yes");
    const question = "Will I need to bring paper towels?";
    await inGroup(wired, sid, CLEANER, question);
    expect((await sms(wired, CLEANER, question, "MM")).status).toBe(200);
    const state = await must(wired, "check_now");
    const messages = (state.messages as { text: string }[] | undefined) ?? [];
    expect(messages.filter((message) => message.text === question)).toHaveLength(1);
  });
});
