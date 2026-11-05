import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ALREADY_ANSWERED, DOOR_CODE_IN_CHAT, DRAFT_UNKNOWN, setCleanerAlertFetch, type LiveDesk } from "../src/cleaner-core/liveDesk";
import { approvedOnDesk } from "./hostApproval";
import { CLEANER, DOOR_CODE, HOST } from "./wiringProof";
import { cleanupDesks, idOf, liveGroup, ok, refused, type OutMessage } from "./cleanerDeskHarness";

afterEach(() => cleanupDesks());

describe("Reply state in check_now", () => {
  it("marks a cleaner question answered by the host's group reply, with the question as earlier context", async () => {
    const { desk } = await liveGroup();
    ok(await desk.checkNow());
    await desk.inbound({ id: "q", from: CLEANER, text: "Where are the spare towels?", channel: "group" });
    expect((ok(await desk.checkNow()).messages as OutMessage[]).at(-1)).toMatchObject({ text: "Where are the spare towels?", reply: "open" });
    await desk.inbound({ id: "h", from: HOST, text: "Hall closet, top shelf", channel: "group" });
    const now = ok(await desk.checkNow());
    expect(now.messages).toEqual([expect.objectContaining({ from: "host", text: "Hall closet, top shelf" })]);
    expect((now.messages as OutMessage[])[0]).not.toHaveProperty("reply");
    expect(now.earlier).toEqual(expect.arrayContaining([expect.objectContaining({ text: "Where are the spare towels?", reply: "answered", by: "group" })]));
  });

  it("leaves earlier out when nothing is new", async () => {
    const { desk } = await liveGroup();
    await desk.inbound({ id: "q", from: CLEANER, text: "Where are the spare towels?", channel: "group" });
    ok(await desk.checkNow());
    expect(ok(await desk.checkNow())).not.toHaveProperty("earlier");
  });

  it("wakes the routine for the host's own group text", async () => {
    const posts: string[] = [];
    const { desk } = await liveGroup();
    setCleanerAlertFetch(async (_url, init) => {
      posts.push(init.body);
      return { status: 200 };
    });
    await desk.drainAlerts();
    const started = posts.length;
    await desk.inbound({ id: "h", from: HOST, text: "Hall closet, top shelf", channel: "group" });
    await desk.drainAlerts();
    expect(posts).toHaveLength(started + 1);
  });

  it("does nothing in Cleaner Core for a host group text that sounds like a decision", async () => {
    const { desk, sms, groups } = await liveGroup();
    const before = JSON.stringify(ok(await desk.getTurns()));
    const sentBefore = sms.sent.length + groups.posts.length;
    const decisions: [string, string][] = [
      ["d1", "Don't come today"],
      ["d2", "Come at 2 instead"],
      ["d3", "Guests are out"],
    ];
    for (const [id, text] of decisions)
      await desk.inbound({ id, from: HOST, text, channel: "group" });
    expect(JSON.stringify(ok(await desk.getTurns()))).toBe(before);
    expect(sms.sent.length + groups.posts.length).toBe(sentBefore);
    expect([...sms.sent.map((s) => s.body), ...groups.posts.map((p) => p.body)].some((b) => b.includes(DOOR_CODE))).toBe(false);
  });
});

const QUESTION = "Where are the spare towels?";
const ANSWER = "Hall closet, top shelf";
type DraftOut = { id: string; replyTo: string; to: string; text: string; status: string };

async function asked(desk: LiveDesk, text = QUESTION, id = "q"): Promise<string> {
  await desk.inbound({ id, from: CLEANER, text, channel: "group" });
  return idOf(desk, text);
}

async function draftsOf(desk: LiveDesk): Promise<DraftOut[] | undefined> {
  return ok(await desk.checkNow()).drafts as DraftOut[] | undefined;
}

describe("save_draft", () => {
  it("saves a draft against the cleaner's question, to the group, and lists it as ready", async () => {
    const { desk, sms, groups } = await liveGroup();
    const replyTo = await asked(desk);
    const sentBefore = sms.sent.length + groups.posts.length;
    const saved = ok(await desk.saveDraft({ replyTo, text: ANSWER }));
    expect(saved.draft).toMatchObject({ replyTo, to: "the group", text: ANSWER, status: "ready" });
    expect(await draftsOf(desk)).toEqual([expect.objectContaining({ replyTo, text: ANSWER, status: "ready" })]);
    expect(sms.sent.length + groups.posts.length).toBe(sentBefore);
  });

  it("replaces the draft for the same message", async () => {
    const { desk } = await liveGroup();
    const replyTo = await asked(desk);
    ok(await desk.saveDraft({ replyTo, text: "First try" }));
    ok(await desk.saveDraft({ replyTo, text: ANSWER }));
    expect((await draftsOf(desk))?.map((draft) => draft.text)).toEqual([ANSWER]);
  });

  it("marks a draft stale when the cleaner writes again", async () => {
    const { desk } = await liveGroup();
    const replyTo = await asked(desk);
    ok(await desk.saveDraft({ replyTo, text: ANSWER }));
    await desk.inbound({ id: "q2", from: CLEANER, text: "Never mind, found them", channel: "group" });
    expect((await draftsOf(desk))?.map((draft) => draft.status)).toEqual(["stale"]);
  });

  it("removes a draft the host answered in the group", async () => {
    const { desk } = await liveGroup();
    const replyTo = await asked(desk);
    ok(await desk.saveDraft({ replyTo, text: ANSWER }));
    await desk.inbound({ id: "h", from: HOST, text: ANSWER, channel: "group" });
    expect(await draftsOf(desk)).toBeUndefined();
  });

  it("refuses an unknown id, a host message, an answered message, the door code, and 601 characters", async () => {
    const { desk } = await liveGroup();
    const replyTo = await asked(desk);
    expect(refused(await desk.saveDraft({ replyTo: "nosuchmessage", text: ANSWER })).error).toBe(DRAFT_UNKNOWN);
    expect(refused(await desk.saveDraft({ replyTo, text: `Code is ${DOOR_CODE}` })).error).toBe(DOOR_CODE_IN_CHAT);
    expect(refused(await desk.saveDraft({ replyTo, text: "a".repeat(601) })).error).toBe("Write the message in 1 to 600 characters.");
    expect(refused(await desk.saveDraft({ replyTo, text: "   " })).error).toBe("Write the message in 1 to 600 characters.");
    await desk.inbound({ id: "h", from: HOST, text: ANSWER, channel: "group" });
    const hostId = await idOf(desk, ANSWER);
    expect(refused(await desk.saveDraft({ replyTo: hostId, text: "x" })).error).toBe(DRAFT_UNKNOWN);
    expect(refused(await desk.saveDraft({ replyTo, text: ANSWER }))).toEqual({ error: ALREADY_ANSWERED, result: { alreadyAnswered: true, by: "group" } });
  });

  it("drops a draft", async () => {
    const { desk } = await liveGroup();
    const replyTo = await asked(desk);
    ok(await desk.saveDraft({ replyTo, text: ANSWER }));
    expect(ok(await desk.saveDraft({ replyTo, drop: true }))).toEqual({ dropped: true });
    expect(await draftsOf(desk)).toBeUndefined();
  });

  it("keeps a draft across a restart", async () => {
    const opened = await liveGroup();
    const replyTo = await asked(opened.desk);
    ok(await opened.desk.saveDraft({ replyTo, text: ANSWER }));
    expect(await draftsOf(opened.reopen())).toEqual([expect.objectContaining({ replyTo, text: ANSWER, status: "ready" })]);
  });

  it("forgets a draft whose message fell off the kept list", async () => {
    const { desk } = await liveGroup();
    const replyTo = await asked(desk);
    ok(await desk.saveDraft({ replyTo, text: ANSWER }));
    for (let i = 0; i < 200; i++) await desk.inbound({ id: `more-${i}`, from: CLEANER, text: `note number ${String.fromCharCode(97 + (i % 26))}${i}`, channel: "group" });
    expect(await draftsOf(desk)).toBeUndefined();
  });

  it("reset_property removes drafts", async () => {
    const { desk, root } = await liveGroup();
    const replyTo = await asked(desk);
    ok(await desk.saveDraft({ replyTo, text: ANSWER }));
    ok(await approvedOnDesk((confirmation) => desk.resetProperty(confirmation ? { confirmation } : {}, () => undefined)));
    const file = join(root, "cleaner-live.json");
    expect(existsSync(file) ? readFileSync(file, "utf8") : "").not.toContain(ANSWER);
  });
});
