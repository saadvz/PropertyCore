import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupIntroBody, groupInviteBody, groupOfferBody } from "../src/cleaner-core/cleanerTexts";
import { openCleanerCore, type CleanerText } from "../src/cleaner-core/core";
import { GroupNotConfirmed } from "../src/cleaner-core/groupThread";
import { CLEANER_GROUP_IDENTITY, sendLiveGroup, setCleanerGroupFetch, setCleanerGroupPause, setCleanerTwilioClient } from "../src/cleaner-core/liveSms";
import { setCleanerPhotoFetch } from "../src/cleaner-core/photos";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";
import { twilioSignature } from "../src/messaging/twilio/signature";
import { fakeConversations, type FakeConversations } from "./fakeConversations";
import { PUBLIC } from "./fakeSendblue";
import { ADDRESS, BUSINESS, CALENDAR_URL, CLEANER, CLEANER_AUTH, CLEANER_LINE, CLEANER_TOKEN, DOOR_CODE, fakeSms, HOST, OBSERVER, startWiredApp, type WiredApp } from "./wiringProof";

const MCP = "/mcp/cleaner-core";
const HOOK_PATH = "/webhooks/twilio/cleaner-core/conversation";
const SMS_PATH = "/webhooks/twilio/cleaner-core";
const HOOK_URL = `${PUBLIC}${HOOK_PATH}`;
const ENV: NodeJS.ProcessEnv = {
  CLEANER_CORE_LIVE_SMS: "1",
  CLEANER_CORE_SMS_ALLOWLIST: `${HOST},${CLEANER},${OBSERVER}`,
  CLEANER_CORE_TWILIO_ACCOUNT_SID: "ACfake",
  CLEANER_CORE_TWILIO_AUTH_TOKEN: "token",
  CLEANER_CORE_TWILIO_PHONE_NUMBER: CLEANER_LINE,
  PUBLIC_BASE_URL: PUBLIC,
};

const open: WiredApp[] = [];

afterEach(async () => {
  setCleanerGroupFetch(undefined);
  setCleanerGroupPause(undefined);
  setCleanerTwilioClient(undefined);
  setCleanerPhotoFetch(undefined);
  while (open.length > 0) await open.pop()?.close();
});

function useFake(options?: Parameters<typeof fakeConversations>[0]): FakeConversations {
  const fake = fakeConversations(options);
  setCleanerGroupFetch(fake.impl);
  return fake;
}

describe("group texting: how the group is made", () => {
  it("adds each phone with its address only, plus one chat participant projected on the Twilio number, and posts as that identity", async () => {
    const fake = useFake();
    const sent = await sendLiveGroup(ENV, { audience: [HOST, CLEANER], body: "Hello the group" });
    const sid = fake.created[0];
    expect(sent?.conversationSid).toBe(sid);
    expect(fake.participantPosts.map((post) => post.params)).toEqual([
      { Identity: CLEANER_GROUP_IDENTITY, "MessagingBinding.ProjectedAddress": CLEANER_LINE },
      { "MessagingBinding.Address": HOST },
      { "MessagingBinding.Address": CLEANER },
    ]);
    expect(JSON.stringify(fake.participantPosts)).not.toContain("ProxyAddress");
    expect(fake.messages).toEqual([{ conversationSid: sid, params: { Body: "Hello the group", Author: CLEANER_GROUP_IDENTITY } }]);
  });

  it("registers the reply webhook when it makes the group", async () => {
    const fake = useFake();
    await sendLiveGroup(ENV, { audience: [HOST, CLEANER], body: "Hello the group" });
    expect(fake.webhooks).toEqual([
      {
        conversationSid: fake.created[0],
        params: { Target: "webhook", "Configuration.Url": HOOK_URL, "Configuration.Method": "POST", "Configuration.Filters": "onMessageAdded" },
      },
    ]);
  });

  it("reuses its own group when the people are the same", async () => {
    const fake = useFake();
    const first = await sendLiveGroup(ENV, { audience: [HOST, CLEANER], body: "One" });
    const second = await sendLiveGroup(ENV, { audience: [CLEANER, HOST], body: "Two", conversationSid: first?.conversationSid });
    expect(second?.conversationSid).toBe(first?.conversationSid);
    expect(fake.created).toHaveLength(1);
    expect(fake.participantPosts).toHaveLength(3);
    expect(fake.webhooks).toHaveLength(1);
    expect(fake.posts.map((post) => post.body)).toEqual(["One", "Two"]);
  });

  it("waits after the first text in a new group, so the next one reaches phones after it, and not after a text to the same group", async () => {
    useFake();
    setCleanerGroupPause(80);
    let started = Date.now();
    const first = await sendLiveGroup(ENV, { audience: [HOST, CLEANER], body: "Intro" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
    started = Date.now();
    await sendLiveGroup(ENV, { audience: [HOST, CLEANER], body: "Offer", conversationSid: first?.conversationSid });
    expect(Date.now() - started).toBeLessThan(75);
  });

  it("replaces an old proxy-style conversation, and frees its numbers for one-to-one texts", async () => {
    const fake = useFake();
    const old = fake.seedProxy([HOST, CLEANER], CLEANER_LINE);
    const sent = await sendLiveGroup(ENV, { audience: [HOST, CLEANER], body: "Hello the group", conversationSid: old });
    expect(sent?.conversationSid).toBeDefined();
    expect(sent?.conversationSid).not.toBe(old);
    expect(fake.people(old)).toEqual([]);
    expect(fake.posts).toEqual([{ conversationSid: sent?.conversationSid, to: [HOST, CLEANER].sort(), body: "Hello the group" }]);
    expect(JSON.stringify(fake.participantPosts)).not.toContain("ProxyAddress");
  });

  it("starts a new group when the people change, and empties the old one", async () => {
    const fake = useFake();
    const first = await sendLiveGroup(ENV, { audience: [HOST, CLEANER], body: "One" });
    const second = await sendLiveGroup(ENV, { audience: [HOST, CLEANER, OBSERVER], body: "Two", conversationSid: first?.conversationSid });
    expect(second?.conversationSid).not.toBe(first?.conversationSid);
    expect(fake.people(first?.conversationSid ?? "")).toEqual([]);
    expect(fake.posts.map((post) => ({ to: post.to, body: post.body }))).toEqual([
      { to: [HOST, CLEANER].sort(), body: "One" },
      { to: [HOST, CLEANER, OBSERVER].sort(), body: "Two" },
    ]);
    expect(fake.webhooks.map((hook) => hook.conversationSid)).toEqual([first?.conversationSid, second?.conversationSid]);
  });

  it("makes no group without a public https address for the replies", async () => {
    const fake = useFake();
    const env = { ...ENV, PUBLIC_BASE_URL: "" };
    await expect(sendLiveGroup(env, { audience: [HOST, CLEANER], body: "Hello" })).rejects.toBeInstanceOf(GroupNotConfirmed);
    expect(fake.calls()).toBe(0);
  });

  it("makes no group of more than 9 phones, since group texting allows 10 participants", async () => {
    const fake = useFake();
    const phones = Array.from({ length: 10 }, (_, index) => `+1555555014${index}`);
    const env = { ...ENV, CLEANER_CORE_SMS_ALLOWLIST: phones.join(",") };
    await expect(sendLiveGroup(env, { audience: phones, body: "Hello" })).rejects.toBeInstanceOf(GroupNotConfirmed);
    expect(fake.calls()).toBe(0);
  });

  it("texts a group of one one-to-one, so no group captures that person's own texts", async () => {
    const fake = useFake();
    const sms = fakeSms();
    setCleanerTwilioClient(sms);
    const sent = await sendLiveGroup(ENV, { audience: [CLEANER], body: "Just you" });
    expect(sent?.sid).toBe("SM1");
    expect(sms.sent.map((item) => ({ to: item.to, body: item.body }))).toEqual([{ to: CLEANER, body: "Just you" }]);
    expect(fake.calls()).toBe(0);
  });

  it("keeps an old group it couldn't empty, so the next send tries again", async () => {
    const fake = useFake();
    const old = fake.seedProxy([HOST, CLEANER], CLEANER_LINE);
    fake.blockMembership();
    const failed = await sendLiveGroup(ENV, { audience: [HOST, CLEANER], body: "Hello", conversationSid: old }).catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(GroupNotConfirmed);
    expect((failed as GroupNotConfirmed).conversationSid).toBe(old);
    expect(fake.created).toEqual([]);
    expect(fake.posts).toEqual([]);
  });

  it("treats a failed post into a confirmed group as a plain failure, never as a group to fall back from", async () => {
    useFake({ failMessages: true });
    const failed = await sendLiveGroup(ENV, { audience: [HOST, CLEANER], body: "Hello" }).catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(GroupNotConfirmed);
  });

  it("starts a new group when Twilio closed the saved one", async () => {
    const fake = useFake();
    const first = await sendLiveGroup(ENV, { audience: [HOST, CLEANER], body: "One" });
    fake.close(first?.conversationSid ?? "");
    const second = await sendLiveGroup(ENV, { audience: [HOST, CLEANER], body: "Two", conversationSid: first?.conversationSid });
    expect(second?.conversationSid).not.toBe(first?.conversationSid);
    expect(fake.people(first?.conversationSid ?? "")).toEqual([]);
    expect(fake.posts.map((post) => post.body)).toEqual(["One", "Two"]);
  });

  it("empties the old group when only one person is left, then texts that person one-to-one", async () => {
    const fake = useFake();
    const sms = fakeSms();
    setCleanerTwilioClient(sms);
    const old = fake.seedProxy([HOST, CLEANER], CLEANER_LINE);
    const sent = await sendLiveGroup(ENV, { audience: [CLEANER], body: "Just you" });
    expect(sent?.sid).toBe("SM1");
    expect(fake.people(old)).toHaveLength(2);
    await sendLiveGroup(ENV, { audience: [CLEANER], body: "Just you again", conversationSid: old });
    expect(fake.people(old)).toEqual([]);
    expect(sms.sent.map((item) => item.body)).toEqual(["Just you", "Just you again"]);
  });

  it("refuses the group when someone in it is off the allowlist, so the offer can fall back", async () => {
    const fake = useFake();
    await expect(sendLiveGroup(ENV, { audience: [HOST, "+15555550199"], body: "Hello" })).rejects.toBeInstanceOf(GroupNotConfirmed);
    expect(fake.calls()).toBe(0);
  });

  it("names the phone and Twilio's code when Twilio won't add it to the group", async () => {
    const fake = useFake({ refusePhone: HOST });
    const failed = await sendLiveGroup(ENV, { audience: [HOST, CLEANER], body: "Hello" }).catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(GroupNotConfirmed);
    expect((failed as GroupNotConfirmed).refused).toEqual({ phone: HOST, code: 50407, message: "Invalid messaging binding address" });
    expect(fake.posts).toEqual([]);
    for (const sid of fake.created) expect(fake.people(sid)).toEqual([]);
  });

  it("names no phone when the group fails for another reason", async () => {
    useFake({ failWebhooks: true });
    const failed = await sendLiveGroup(ENV, { audience: [HOST, CLEANER], body: "Hello" }).catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(GroupNotConfirmed);
    expect((failed as GroupNotConfirmed).refused).toBeUndefined();
  });

  it("leaves no half-made group when the reply webhook can't be added", async () => {
    const fake = useFake({ failWebhooks: true });
    await expect(sendLiveGroup(ENV, { audience: [HOST, CLEANER], body: "Hello" })).rejects.toBeInstanceOf(GroupNotConfirmed);
    expect(fake.posts).toEqual([]);
    for (const sid of fake.created) expect(fake.people(sid)).toEqual([]);
  });
});

const lane = SCRATCH_TENANTS[0];
if (!lane) throw new Error("Scratch Lane is missing");
const PIN = lane.pin;
const LANE = "12 Scratch Lane, Teaneck, NJ 07666";
const OWNER = "+15555550100";
const MIKE = "+15555550101";
const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
const OFFER = `Turnover at ${LANE} on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.`;
const GROUP_OFFER = `Turnover at ${LANE} on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Mike, reply YES to schedule it.`;

function engine(send: (text: CleanerText) => Promise<void>) {
  return openCleanerCore({
    enabled: true,
    property: { id: "prop_12_scratch_lane", address: LANE, timeZone: "America/New_York" },
    ownerPhone: OWNER,
    cleaner: { phone: MIKE, approved: true },
    pin: PIN,
    hostName: "Scratch",
    consented: true,
    sink: { send },
    now: () => new Date("2026-10-14T15:00:00.000Z"),
    groupChat: { hostName: "Dana", cleanerName: "Mike" },
  });
}

async function offered(send: (text: CleanerText) => Promise<void>) {
  const job = engine(send);
  await job.pollFeed(FEED);
  await job.receive({ id: "host-yes", from: OWNER, text: "YES" });
  await job.receive({ id: "mike-yes", from: MIKE, text: "YES" });
  await job.confirmHostTimes({ checkout: "11:00 AM", checkIn: "4:00 PM" });
  return job;
}

describe("group texting: the offer goes to the cleaner once", () => {
  it("names the cleaner in the YES ask and keeps the host's note last", () => {
    const body = `${OFFER} Note from the host: Leave the porch light on.`;
    expect(groupOfferBody("Mike", body)).toBe(`${GROUP_OFFER} Note from the host: Leave the porch light on.`);
    expect(groupOfferBody("Mike", "Something else.")).toBe("Something else.");
  });

  it("posts the offer once into the group, addressed to the cleaner by name, with no one-to-one offer and no host copy", async () => {
    const sent: CleanerText[] = [];
    const job = await offered(async (text) => {
      sent.push(text);
    });
    expect(sent.filter((text) => text.kind === "offer")).toEqual([{ to: MIKE, body: GROUP_OFFER, kind: "offer", channel: "group", audience: [OWNER, MIKE] }]);
    expect(sent.filter((text) => text.body.includes("The cleaner will reply to confirm"))).toEqual([]);
    const yes = await job.receive({ id: "mike-group-yes", from: MIKE, text: "YES", channel: "group" });
    expect(yes.reason).toBe("scheduled");
    expect(job.jobs()[0]?.status).toBe("confirmed");
    expect(sent.filter((text) => text.kind === "offer")).toHaveLength(1);
  });

  it("falls back to the one-to-one offer when the group can't be confirmed", async () => {
    const sent: CleanerText[] = [];
    const tried: CleanerText[] = [];
    const job = await offered(async (text) => {
      tried.push(text);
      if (text.channel === "group") throw new GroupNotConfirmed();
      sent.push(text);
    });
    expect(sent.filter((text) => text.kind === "offer")).toEqual([{ to: MIKE, body: OFFER, kind: "offer" }]);
    expect(job.hostNotes()).toContain("I couldn't send the cleaning offer to the group.");
    // The group just failed, so no host copy tries it again.
    expect(tried.filter((text) => text.channel === "group" && text.kind === "offer")).toHaveLength(1);
    await job.receive({ id: "mike-yes-direct", from: MIKE, text: "YES" });
    expect(job.jobs()[0]?.status).toBe("confirmed");
  });

  it("posts the door code into the group of the landlord and Mike, once, with no one-to-one copy", async () => {
    const sent: CleanerText[] = [];
    const job = await offered(async (text) => {
      sent.push(text);
    });
    await job.receive({ id: "mike-group-yes", from: MIKE, text: "YES", channel: "group" });
    const left = await job.receive({ id: "left", from: OWNER, text: "guests have left" });
    expect(left.sent.filter((text) => text.kind === "pin")).toEqual([expect.objectContaining({ to: MIKE, kind: "pin", channel: "group", audience: [OWNER, MIKE] })]);
    expect(sent.filter((text) => text.body.includes(PIN) && (text.channel !== "group" || text.kind !== "pin"))).toEqual([]);
  });
});

async function app(allowlist = `${HOST},${CLEANER}`): Promise<WiredApp> {
  const started = await startWiredApp({ groupChat: true, allowlist });
  open.push(started);
  return started;
}

function call(wired: WiredApp, name: string, args: Record<string, unknown> = {}) {
  return wired.tool(MCP, CLEANER_TOKEN, name, args);
}

async function must(wired: WiredApp, name: string, args: Record<string, unknown> = {}) {
  const reply = await call(wired, name, args);
  expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
  return reply.structured ?? {};
}

let smsSid = 0;

function sms(wired: WiredApp, from: string, body: string) {
  return wired.postTwilio(SMS_PATH, { from, to: CLEANER_LINE, body, sid: `SMgroup${++smsSid}`, token: CLEANER_AUTH });
}

async function hook(wired: WiredApp, fields: Record<string, string>, options: { token?: string; signed?: boolean } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (options.signed !== false) headers["X-Twilio-Signature"] = twilioSignature(options.token ?? CLEANER_AUTH, HOOK_URL, fields);
  const res = await fetch(`http://127.0.0.1:${wired.port}${HOOK_PATH}`, { method: "POST", headers, body: new URLSearchParams(fields).toString() });
  return { status: res.status, raw: await res.text() };
}

let groupSid = 0;

function groupText(conversationSid: string, author: string, body: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    EventType: "onMessageAdded",
    ConversationSid: conversationSid,
    MessageSid: `IMreply${(++groupSid).toString(16).padStart(26, "0")}`,
    Index: String(groupSid),
    Author: author,
    Body: body,
    Source: "SMS",
    ...extra,
  };
}

/** Saved through Grok's tools, the host and Mike joined, and the offer posted to the group. */
async function groupReady(people: Record<string, unknown> = { hostName: "Dana" }, allowlist?: string) {
  const fake = useFake();
  const wired = await app(allowlist);
  await must(wired, "get_state", { choice: "cleaners" });
  await must(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
  await must(wired, "save_people", { host: HOST, cleaner: CLEANER, cleanerName: "Mike", groupChat: "cleaner-and-host", ...people });
  await must(wired, "save_calendar_link", { url: CALENDAR_URL });
  await must(wired, "save_door_code", { code: DOOR_CODE });
  await must(wired, "set_up_texting");
  await must(wired, "run_checks");
  await must(wired, "confirm_times", { checkout: "11:00", checkIn: "16:00" });
  expect((await sms(wired, HOST, "YES")).status).toBe(200);
  expect((await sms(wired, CLEANER, "YES")).status).toBe(200);
  const conversationSid = fake.posts[0]?.conversationSid ?? "";
  return { fake, wired, conversationSid };
}

async function turnStatus(wired: WiredApp): Promise<string | undefined> {
  const turns = (await must(wired, "get_turns")).turns as { status: string }[];
  return turns[0]?.status;
}

interface Kept {
  from: string;
  name: string;
  text: string;
  handled: string;
  channel?: string;
}

async function messages(wired: WiredApp): Promise<Kept[]> {
  return ((await must(wired, "check_now")).messages as Kept[] | undefined) ?? [];
}

describe("group texting: the conversation webhook", () => {
  it("takes Mike's YES in the group, confirms the job, and shows it to Grok as a group message", async () => {
    const { wired, conversationSid, fake } = await groupReady();
    // The first group text is the intro, then the offer, in one post.
    expect(fake.posts.filter((post) => post.body.includes("Turnover at"))).toEqual([
      {
        conversationSid,
        to: [HOST, CLEANER].sort(),
        body: `${groupIntroBody(["Dana", "Mike"], "Dana", ADDRESS)}\n\nTurnover at ${ADDRESS} on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Mike, reply YES to schedule it.`,
      },
    ]);
    expect(wired.cleanerSent.filter((item) => item.body.startsWith("Turnover at"))).toEqual([]);
    expect(await turnStatus(wired)).toBe("offered");
    const reply = await hook(wired, groupText(conversationSid, CLEANER, "YES"));
    expect(reply.status).toBe(200);
    expect(await turnStatus(wired)).toBe("confirmed");
    expect((await messages(wired)).filter((item) => item.channel === "group")).toEqual([
      expect.objectContaining({ from: "cleaner", name: "Mike", text: "YES", handled: "confirmed", channel: "group" }),
    ]);
  });

  it("refuses a bad signature with 403 and takes nothing", async () => {
    const { wired, conversationSid } = await groupReady();
    expect((await hook(wired, groupText(conversationSid, CLEANER, "YES"), { token: "not-the-token" })).status).toBe(403);
    expect((await hook(wired, groupText(conversationSid, CLEANER, "YES"), { signed: false })).status).toBe(403);
    expect(await turnStatus(wired)).toBe("offered");
  });

  it("ignores its own messages", async () => {
    const { wired, conversationSid } = await groupReady();
    expect((await hook(wired, groupText(conversationSid, CLEANER_GROUP_IDENTITY, "YES"))).status).toBe(200);
    expect(await turnStatus(wired)).toBe("offered");
    expect((await messages(wired)).filter((item) => item.channel === "group")).toEqual([]);
  });

  it("ignores a phone that isn't saved, even when it is on the allowlist, and a message from another conversation", async () => {
    const { wired, conversationSid } = await groupReady({ hostName: "Dana" }, `${HOST},${CLEANER},${OBSERVER}`);
    expect((await hook(wired, groupText(conversationSid, OBSERVER, "YES"))).status).toBe(200);
    expect((await hook(wired, groupText("CH" + "f".repeat(32), CLEANER, "YES"))).status).toBe(200);
    expect(await turnStatus(wired)).toBe("offered");
    expect((await messages(wired)).filter((item) => item.channel === "group")).toEqual([]);
  });

  it("answers 404 with Cleaner Core off", async () => {
    const { wired, conversationSid } = await groupReady();
    wired.setEnv({ CLEANER_CORE_ENABLED: undefined });
    expect((await hook(wired, groupText(conversationSid, CLEANER, "YES"))).status).toBe(404);
    wired.setEnv({ CLEANER_CORE_ENABLED: "1" });
    expect(await turnStatus(wired)).toBe("offered");
  });

  it("takes the same MessageSid once", async () => {
    const { wired, conversationSid } = await groupReady();
    const fields = groupText(conversationSid, CLEANER, "Running a little behind");
    expect((await hook(wired, fields)).status).toBe(200);
    expect((await hook(wired, fields)).status).toBe(200);
    expect((await messages(wired)).filter((item) => item.text === "Running a little behind")).toHaveLength(1);
  });

  it("posts the door code in the group of Dana and Mike after a YES in the group, and never one-to-one", async () => {
    const { wired, conversationSid, fake } = await groupReady();
    await hook(wired, groupText(conversationSid, CLEANER, "YES"));
    await must(wired, "mark_guests_left", { confirmed: true });
    expect(wired.cleanerSent.filter((item) => item.body.includes(DOOR_CODE))).toEqual([]);
    expect(fake.posts.filter((post) => post.body.includes(DOOR_CODE)).map((post) => [...post.to].sort())).toEqual([[HOST, CLEANER].sort()]);
  });

  it("keeps a group photo from Mike during the cleaning, read through the Conversations media service", async () => {
    const { wired, conversationSid } = await groupReady();
    await hook(wired, groupText(conversationSid, CLEANER, "YES"));
    await must(wired, "mark_guests_left", { confirmed: true });
    const service = `IS${"a".repeat(32)}`;
    const media = `ME${"b".repeat(32)}`;
    const temporary = "https://media.us1.twilio.com/temporary/made-up";
    const fetched: { url: string; auth: boolean }[] = [];
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("made-up photo"), Buffer.from([0xff, 0xd9])]);
    setCleanerPhotoFetch(async (url, init) => {
      fetched.push({ url, auth: Boolean(init.headers.Authorization) });
      if (url.startsWith("https://mcs.us1.twilio.com/")) {
        return new Response(JSON.stringify({ sid: media, links: { content_direct_temporary: temporary } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } });
    });
    const photo = groupText(conversationSid, CLEANER, "", {
      ChatServiceSid: service,
      Media: JSON.stringify([{ Sid: media, ContentType: "image/jpeg", Filename: "rooms.jpg", Size: jpeg.length }]),
    });
    expect((await hook(wired, photo)).status).toBe(200);
    expect((await messages(wired)).at(-1)).toEqual(expect.objectContaining({ from: "cleaner", text: "[photo]", channel: "group" }));
    expect(fetched).toEqual([
      { url: `https://mcs.us1.twilio.com/v1/Services/${service}/Media/${media}`, auth: true },
      { url: temporary, auth: false },
    ]);
    expect(((await must(wired, "get_job_photos")).photos as unknown[] | undefined) ?? []).toHaveLength(1);
  });
});

describe("group texting: when the group can't be made", () => {
  it("sends the one-to-one offer, tells the host, and takes Mike's YES by text", async () => {
    const fake = useFake({ failWebhooks: true });
    const wired = await app();
    await must(wired, "get_state", { choice: "cleaners" });
    await must(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
    await must(wired, "save_people", { host: HOST, cleaner: CLEANER, cleanerName: "Mike", hostName: "Dana", groupChat: "cleaner-and-host" });
    await must(wired, "save_calendar_link", { url: CALENDAR_URL });
    await must(wired, "save_door_code", { code: DOOR_CODE });
    await must(wired, "set_up_texting");
    await must(wired, "run_checks");
    await must(wired, "confirm_times", { checkout: "11:00", checkIn: "16:00" });
    expect((await sms(wired, HOST, "YES")).status).toBe(200);
    expect((await sms(wired, CLEANER, "YES")).status).toBe(200);
    expect(fake.posts).toEqual([]);
    for (const sid of fake.created) expect(fake.people(sid)).toEqual([]);
    expect(wired.cleanerSent.filter((item) => item.body.startsWith("Turnover at")).map((item) => ({ to: item.to, body: item.body }))).toEqual([
      { to: CLEANER, body: `Turnover at ${ADDRESS} on Sunday, Oct 18. Checkout 11:00 AM, next guest 4:00 PM. Reply YES to schedule it, or STOP to opt out.` },
    ]);
    expect((await must(wired, "get_state")).notes).toContain("I couldn't send the cleaning offer to the group.");
    expect((await sms(wired, CLEANER, "YES")).status).toBe(200);
    expect(await turnStatus(wired)).toBe("confirmed");
  });
});

describe("group texting: when Twilio refuses a phone", () => {
  it("tells the host which number and Twilio's code, and logs only its last four digits", async () => {
    useFake({ refusePhone: HOST });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const wired = await app();
      await must(wired, "get_state", { choice: "cleaners" });
      await must(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
      await must(wired, "save_people", { host: HOST, cleaner: CLEANER, cleanerName: "Mike", hostName: "Dana", groupChat: "cleaner-and-host" });
      await must(wired, "save_calendar_link", { url: CALENDAR_URL });
      await must(wired, "save_door_code", { code: DOOR_CODE });
      await must(wired, "set_up_texting");
      await must(wired, "run_checks");
      await must(wired, "confirm_times", { checkout: "11:00", checkIn: "16:00" });
      expect((await sms(wired, HOST, "YES")).status).toBe(200);
      expect((await sms(wired, CLEANER, "YES")).status).toBe(200);
      const last4 = HOST.slice(-4);
      expect((await must(wired, "get_state")).notes).toContain(
        `Twilio wouldn't add the number ending in ${last4} to the group text (Twilio error 50407). Check that number with Twilio support, or use another mobile number for that person.`,
      );
      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(lines).toContain(`  Cleaner Core: Twilio refused ***${last4} for the group text (error 50407: Invalid messaging binding address).`);
      expect(lines.join("\n")).not.toContain(HOST);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("group texting: what the webhook reads", () => {
  it("shows the host's own text in the group to Grok as the host, and it moves no job", async () => {
    const { wired, conversationSid } = await groupReady();
    expect((await hook(wired, groupText(conversationSid, HOST, "Thanks Mike"))).status).toBe(200);
    expect(await turnStatus(wired)).toBe("offered");
    expect((await messages(wired)).filter((item) => item.channel === "group")).toEqual([
      expect.objectContaining({ from: "host", text: "Thanks Mike", channel: "group" }),
    ]);
  });

  it("reads only new messages, not other conversation events", async () => {
    const { wired, conversationSid } = await groupReady();
    expect((await hook(wired, groupText(conversationSid, CLEANER, "YES", { EventType: "onMessageUpdated" }))).status).toBe(200);
    expect(await turnStatus(wired)).toBe("offered");
  });

  it("skips a group photo whose media ids or temporary link look wrong", async () => {
    const { wired, conversationSid } = await groupReady();
    await hook(wired, groupText(conversationSid, CLEANER, "YES"));
    await must(wired, "mark_guests_left", { confirmed: true });
    const fetched: string[] = [];
    setCleanerPhotoFetch(async (url) => {
      fetched.push(url);
      return new Response(JSON.stringify({ links: { content_direct_temporary: "http://media.us1.twilio.com/plain-http" } }), { status: 200 });
    });
    const service = `IS${"a".repeat(32)}`;
    const badSid = groupText(conversationSid, CLEANER, "", { ChatServiceSid: service, Media: JSON.stringify([{ Sid: "../../Accounts", ContentType: "image/jpeg" }]) });
    expect((await hook(wired, badSid)).status).toBe(200);
    expect(fetched).toEqual([]);
    const badLink = groupText(conversationSid, CLEANER, "", { ChatServiceSid: service, Media: JSON.stringify([{ Sid: `ME${"c".repeat(32)}`, ContentType: "image/jpeg" }]) });
    expect((await hook(wired, badLink)).status).toBe(200);
    expect(fetched).toEqual([`https://mcs.us1.twilio.com/v1/Services/${service}/Media/ME${"c".repeat(32)}`]);
    expect((await must(wired, "get_job_photos")).photos ?? []).toEqual([]);
  });
});

describe("group texting: a Scratch reset", () => {
  const scratch = SCRATCH_TENANTS[0];
  if (!scratch) throw new Error("Scratch Lane is missing");
  const scratchAddress = scratch.property.address;
  const lane = { ownerPhone: scratch.ownerPhone, cleanerPhone: scratch.cleanerPhone };

  /** Scratch Lane set up through Grok's tools, both phones joined, and the offer posted to the group. */
  async function scratchGroup(fake: FakeConversations) {
    const wired = await startWiredApp({ groupChat: true, scratchTools: true, allowlist: `${lane.ownerPhone},${lane.cleanerPhone}` });
    open.push(wired);
    await must(wired, "get_state", { choice: "cleaners" });
    await must(wired, "save_property", { business: "Scratch", address: scratchAddress, timeZone: "America/New_York" });
    await must(wired, "save_people", { host: lane.ownerPhone, cleaner: lane.cleanerPhone, cleanerName: "Mike", groupChat: "cleaner-and-host" });
    await must(wired, "save_calendar_link", { url: CALENDAR_URL });
    await must(wired, "save_door_code", { code: DOOR_CODE });
    await must(wired, "set_up_texting");
    await must(wired, "run_checks");
    await must(wired, "confirm_times", { checkout: "11:00", checkIn: "16:00" });
    expect((await sms(wired, lane.ownerPhone, "YES")).status).toBe(200);
    expect((await sms(wired, lane.cleanerPhone, "YES")).status).toBe(200);
    const conversationSid = fake.posts[0]?.conversationSid ?? "";
    expect(conversationSid).toMatch(/^CH/);
    return { wired, conversationSid };
  }

  function savedSid(wired: WiredApp): string | undefined {
    return (JSON.parse(readFileSync(join(wired.root, "cleaner-live.json"), "utf8")) as { conversationSid?: string }).conversationSid;
  }

  it("deletes the Scratch group on Twilio, so the next run starts a new one", async () => {
    const fake = useFake();
    const { wired, conversationSid } = await scratchGroup(fake);
    expect(savedSid(wired)).toBe(conversationSid);
    expect((await must(wired, "reset_scratch")).next).toBe("Scratch is reset. No jobs, notes or test texts are left.");
    expect(fake.removed).toEqual([conversationSid]);
    expect(fake.people(conversationSid)).toBeUndefined();
    expect(savedSid(wired)).toBeUndefined();
    // A second reset has nothing left to remove on Twilio.
    const calls = fake.calls();
    await must(wired, "reset_scratch");
    expect(fake.calls()).toBe(calls);
  });

  it("empties the group when Twilio refuses the delete", async () => {
    const fake = useFake({ failConversationDeletes: true });
    const { wired, conversationSid } = await scratchGroup(fake);
    expect((await must(wired, "reset_scratch")).next).toBe("Scratch is reset. No jobs, notes or test texts are left.");
    expect(fake.removed).toEqual([]);
    expect(fake.people(conversationSid)).toEqual([]);
    expect(savedSid(wired)).toBeUndefined();
  });

  it("keeps the group's id and says so when Twilio can't remove it, so the next group text replaces it", async () => {
    const fake = useFake({ failConversationDeletes: true });
    const { wired, conversationSid } = await scratchGroup(fake);
    fake.blockMembership();
    const reset = await must(wired, "reset_scratch");
    expect(reset.next).toBe("Scratch is reset. No jobs, notes or test texts are left. I couldn't remove the old group text on Twilio, so the next group text will replace it.");
    expect(savedSid(wired)).toBe(conversationSid);
    expect(JSON.stringify(reset)).not.toContain(conversationSid);
  });

  it("calls Twilio for nothing when live texts are off", async () => {
    const fake = useFake();
    const { wired, conversationSid } = await scratchGroup(fake);
    wired.setEnv({ CLEANER_CORE_LIVE_SMS: undefined });
    const calls = fake.calls();
    expect((await must(wired, "reset_scratch")).next).toContain("I couldn't remove the old group text on Twilio");
    expect(fake.calls()).toBe(calls);
    expect(savedSid(wired)).toBe(conversationSid);
  });
});

describe("group texting: the host's name", () => {
  it("refuses a host name that is too long", async () => {
    useFake();
    const wired = await app();
    await must(wired, "get_state", { choice: "cleaners" });
    await must(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
    const reply = await call(wired, "save_people", { host: HOST, cleaner: CLEANER, hostName: "D".repeat(41) });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("Keep the host's name under 40 characters.");
  });

  it("names the saved host in the invite", async () => {
    const fake = useFake();
    const wired = await app();
    await must(wired, "get_state", { choice: "cleaners" });
    await must(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
    await must(wired, "save_people", { host: HOST, cleaner: CLEANER, cleanerName: "Mike", hostName: "Dana", groupChat: "cleaner-and-host" });
    await must(wired, "save_calendar_link", { url: CALENDAR_URL });
    await must(wired, "save_door_code", { code: DOOR_CODE });
    await must(wired, "set_up_texting");
    await must(wired, "run_checks");
    await must(wired, "confirm_times", { checkout: "11:00", checkIn: "16:00" });
    const invite = wired.cleanerSent.find((item) => item.to === CLEANER)?.body;
    expect(invite).toBe(groupInviteBody("Dana", ADDRESS));
    expect(wired.cleanerSent.some((item) => item.body.includes("Cory"))).toBe(false);
    expect(fake.posts.some((post) => post.body.includes("Cory"))).toBe(false);
  });

  it("names the business when no host name is saved, never Cory", async () => {
    useFake();
    const wired = await app();
    await must(wired, "get_state", { choice: "cleaners" });
    await must(wired, "save_property", { business: BUSINESS, address: ADDRESS, timeZone: "America/New_York" });
    await must(wired, "save_people", { host: HOST, cleaner: CLEANER, cleanerName: "Mike", groupChat: "cleaner-and-host" });
    await must(wired, "save_calendar_link", { url: CALENDAR_URL });
    await must(wired, "save_door_code", { code: DOOR_CODE });
    await must(wired, "set_up_texting");
    await must(wired, "run_checks");
    await must(wired, "confirm_times", { checkout: "11:00", checkIn: "16:00" });
    expect(wired.cleanerSent.find((item) => item.to === CLEANER)?.body).toBe(groupInviteBody(BUSINESS, ADDRESS));
    expect(wired.cleanerSent.some((item) => item.body.includes("Cory"))).toBe(false);
  });
});
