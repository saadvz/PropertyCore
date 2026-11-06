import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfirmationBook } from "../src/operator/confirmations";
import { ALREADY_ANSWERED, DOOR_CODE_IN_CHAT, DRAFT_GONE, DRAFT_NEW_SINCE, DRAFT_NOT_IN_GROUP, DRAFT_RECIPIENT_CHANGED, DRAFT_UNKNOWN, setCleanerAlertFetch, type LiveDesk } from "../src/cleaner-core/liveDesk";
import { approvedOnDesk } from "./hostApproval";
import { handleCleanerMcpMessage } from "../src/cleaner-core/mcp";
import { CLEANER, DOOR_CODE, HOST, OBSERVER } from "./wiringProof";
import { PIN_KEY, cleanupDesks, idOf, liveGroup, liveOneToOne, ok, openDesk, refused, setUp, testClock, type OutMessage } from "./cleanerDeskHarness";

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

/** A kept message's id, read from the desk's saved file, so nothing is marked shown. */
function idOfKept(root: string, text: string): string {
  const file = JSON.parse(readFileSync(join(root, "cleaner-live.json"), "utf8")) as { messages?: { id: string; text: string }[] };
  const found = (file.messages ?? []).filter((message) => message.text === text).at(-1);
  if (!found) throw new Error(`No kept message "${text}"`);
  return found.id;
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

const STALE = "That approval has expired or doesn't match. Ask the host again.";

/** Asks for the draft's preview, as Send does, and returns the code. */
async function previewCode(desk: LiveDesk, draft: string): Promise<string> {
  const preview = ok(await desk.sendMessage({ draft }));
  return String((preview.confirmation as { code: string }).code);
}

async function savedDraft(desk: LiveDesk, replyTo: string, text = ANSWER): Promise<string> {
  return String((ok(await desk.saveDraft({ replyTo, text })).draft as { id: string }).id);
}

function sentCount(opened: { sms: { sent: unknown[] }; groups: { posts: unknown[] } }): number {
  return opened.sms.sent.length + opened.groups.posts.length;
}

describe("send_message with a draft", () => {
  it("sends the saved draft to the group with the host's code, then marks the question answered", async () => {
    const { desk, groups, root } = await liveGroup();
    const id = await savedDraft(desk, await asked(desk));
    const preview = ok(await desk.sendMessage({ draft: id }));
    expect(preview.preview).toEqual({ to: "the group", text: ANSWER });
    expect(preview.confirmation).not.toHaveProperty("expiresInMinutes");
    const sent = ok(await desk.sendMessage({ draft: id, confirmation: String((preview.confirmation as { code: string }).code) }));
    expect(sent.next).toBe("Sent to the group.");
    expect(groups.posts.at(-1)?.body).toContain(ANSWER);
    expect(ok(await desk.checkNow()).drafts).toBeUndefined();
    // Nothing is new after the send, so earlier is left out; a new draft shows the question is answered.
    expect(refused(await desk.saveDraft({ replyTo: idOfKept(root, QUESTION), text: "again" }))).toEqual({ error: ALREADY_ANSWERED, result: { alreadyAnswered: true, by: "assistant" } });
  });

  it("sends a draft a day after its preview", async () => {
    const clock = testClock();
    const { desk, groups } = await liveGroup(clock.now);
    const id = await savedDraft(desk, await asked(desk));
    const code = await previewCode(desk, id);
    clock.advance(24 * 60 * 60_000);
    expect(ok(await desk.sendMessage({ draft: id, confirmation: code })).next).toBe("Sent to the group.");
    expect(groups.posts.at(-1)?.body).toContain(ANSWER);
  });

  it("still expires a to and text code after 10 minutes", async () => {
    const clock = testClock();
    const { desk } = await liveGroup(clock.now);
    const preview = ok(await desk.sendMessage({ to: "group", text: "Running 10 minutes late" }));
    clock.advance(10 * 60_000);
    expect(refused(await desk.sendMessage({ to: "group", text: "Running 10 minutes late", confirmation: String((preview.confirmation as { code: string }).code) })).error).toBe(STALE);
  });

  it("refuses a code from before the host's group reply with alreadyAnswered", async () => {
    const opened = await liveGroup();
    const { desk } = opened;
    const id = await savedDraft(desk, await asked(desk));
    const code = await previewCode(desk, id);
    await desk.inbound({ id: "h", from: HOST, text: ANSWER, channel: "group" });
    const before = sentCount(opened);
    expect(refused(await desk.sendMessage({ draft: id, confirmation: code }))).toEqual({ error: ALREADY_ANSWERED, result: { alreadyAnswered: true, by: "group" } });
    expect(sentCount(opened)).toBe(before);
  });

  it("refuses a code from before a second cleaner text with newSince", async () => {
    const opened = await liveGroup();
    const { desk } = opened;
    const id = await savedDraft(desk, await asked(desk));
    const code = await previewCode(desk, id);
    await desk.inbound({ id: "q2", from: CLEANER, text: "Never mind, found them", channel: "group" });
    const before = sentCount(opened);
    expect(refused(await desk.sendMessage({ draft: id, confirmation: code }))).toEqual({ error: DRAFT_NEW_SINCE, result: { newSince: true } });
    expect(refused(await desk.sendMessage({ draft: id }))).toEqual({ error: DRAFT_NEW_SINCE, result: { newSince: true } });
    expect(sentCount(opened)).toBe(before);
  });

  it("refuses a code from before a group member change", async () => {
    const opened = await liveGroup();
    const { desk } = opened;
    const id = await savedDraft(desk, await asked(desk));
    const code = await previewCode(desk, id);
    await desk.inbound({ id: "stop-host", from: HOST, text: "STOP", channel: "group" });
    const before = sentCount(opened);
    expect(refused(await desk.sendMessage({ draft: id, confirmation: code })).error).toBeTruthy();
    expect(sentCount(opened)).toBe(before);
  });

  it("sends a draft after a restart with a new code", async () => {
    const opened = await liveGroup();
    const id = await savedDraft(opened.desk, await asked(opened.desk));
    const old = await previewCode(opened.desk, id);
    const desk = opened.reopen();
    expect(refused(await desk.sendMessage({ draft: id, confirmation: old })).error).toBe(STALE);
    expect(ok(await approvedOnDesk((confirmation) => desk.sendMessage({ draft: id, ...(confirmation ? { confirmation } : {}) }))).next).toBe("Sent to the group.");
  });

  it("refuses a draft that is gone", async () => {
    const { desk } = await liveGroup();
    expect(refused(await desk.sendMessage({ draft: "nosuchdraft" })).error).toBe(DRAFT_GONE);
  });

  it("sends one-to-one to the cleaner without a group", async () => {
    const { desk, sms } = await liveOneToOne();
    await desk.inbound({ id: "q", from: CLEANER, text: QUESTION });
    const id = await savedDraft(desk, await idOf(desk, QUESTION));
    expect(ok(await approvedOnDesk((confirmation) => desk.sendMessage({ draft: id, ...(confirmation ? { confirmation } : {}) }))).next).toBe("Sent to Ana.");
    expect(sms.sent.at(-1)).toMatchObject({ to: CLEANER });
    expect(sms.sent.at(-1)?.body).toContain(ANSWER);
  });

  it("won't send one-to-one once the group is on", async () => {
    const opened = openDesk([HOST, CLEANER], "1");
    const { desk } = opened;
    await setUp(desk, { groupChat: "cleaner-only" });
    await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "q", from: CLEANER, text: QUESTION });
    const id = await savedDraft(desk, await idOf(desk, QUESTION));
    ok(await desk.savePeople({ host: HOST, cleaner: CLEANER, cleanerName: "Ana", groupChat: "cleaner-and-host" }));
    await desk.inbound({ id: "yes-host-2", from: HOST, text: "YES" });
    await desk.inbound({ id: "yes-cleaner-2", from: CLEANER, text: "YES" });
    const before = sentCount(opened);
    expect(refused(await approvedOnDesk((confirmation) => desk.sendMessage({ draft: id, ...(confirmation ? { confirmation } : {}) }))).error).toBeTruthy();
    expect(sentCount(opened)).toBe(before);
  });

  it("won't send after the cleaner texts STOP", async () => {
    const opened = await liveOneToOne();
    const { desk } = opened;
    await desk.inbound({ id: "q", from: CLEANER, text: QUESTION });
    const id = await savedDraft(desk, await idOf(desk, QUESTION));
    await desk.inbound({ id: "stop", from: CLEANER, text: "STOP" });
    const before = sentCount(opened);
    expect(refused(await approvedOnDesk((confirmation) => desk.sendMessage({ draft: id, ...(confirmation ? { confirmation } : {}) }))).error).toBeTruthy();
    expect(sentCount(opened)).toBe(before);
  });

  it("answers both open messages with one draft against the newer", async () => {
    const { desk, root } = await liveGroup();
    await desk.inbound({ id: "q1", from: CLEANER, text: QUESTION, channel: "group" });
    await desk.inbound({ id: "q2", from: CLEANER, text: "And the vacuum?", channel: "group" });
    const first = idOfKept(root, QUESTION);
    const id = await savedDraft(desk, idOfKept(root, "And the vacuum?"), "Both in the hall closet");
    ok(await approvedOnDesk((confirmation) => desk.sendMessage({ draft: id, ...(confirmation ? { confirmation } : {}) })));
    for (const replyTo of [first, idOfKept(root, "And the vacuum?")])
      expect(refused(await desk.saveDraft({ replyTo, text: "again" })).result).toEqual({ alreadyAnswered: true, by: "assistant" });
  });
});

describe("MCP route for reply drafts and saved answers", () => {
  async function mcp(desk: LiveDesk, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reply = await handleCleanerMcpMessage(desk, { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }, PIN_KEY);
    return (reply.body as { result: Record<string, unknown> }).result;
  }
  const tool = (desk: LiveDesk, name: string, args: Record<string, unknown>) => mcp(desk, "tools/call", { name, arguments: args });
  const structured = (result: Record<string, unknown>) => result.structuredContent as Record<string, unknown>;

  it("lists save_draft and save_answer, and sends a draft through the MCP route", async () => {
    const { desk, groups } = await liveGroup();
    const names = ((await mcp(desk, "tools/list")).tools as { name: string }[]).map((item) => item.name);
    expect(names).toEqual(expect.arrayContaining(["save_draft", "save_answer"]));
    const replyTo = await asked(desk);
    const saved = await tool(desk, "save_draft", { replyTo, text: ANSWER });
    expect(saved.isError).toBe(false);
    const draft = (structured(saved).draft as { id: string }).id;
    const preview = await tool(desk, "send_message", { draft });
    expect(structured(preview).preview).toEqual({ to: "the group", text: ANSWER });
    const code = (structured(preview).confirmation as { code: string }).code;
    const sent = await tool(desk, "send_message", { draft, confirmation: code });
    expect(sent.isError).toBe(false);
    expect(groups.posts.at(-1)?.body).toContain(ANSWER);
  });

  it("refuses the door code split like 80-88 in save_draft and save_answer", async () => {
    const { desk } = await liveGroup();
    const replyTo = await asked(desk);
    for (const split of ["80-88", "8 0 8 8"]) {
      const draft = await tool(desk, "save_draft", { replyTo, text: `Lockbox is ${split}` });
      expect(draft.isError).toBe(true);
      expect((draft.content as { text: string }[])[0]?.text).toBe(DOOR_CODE_IN_CHAT);
      const answer = await tool(desk, "save_answer", { topic: "Lockbox", answer: `It opens with ${split}` });
      expect(answer.isError).toBe(true);
      expect((answer.content as { text: string }[])[0]?.text).toBe(DOOR_CODE_IN_CHAT);
    }
    expect(ok(await desk.checkNow()).drafts).toBeUndefined();
  });

  it("saves an answer through the MCP route only with the code", async () => {
    const { desk } = await liveGroup();
    const asked = await tool(desk, "save_answer", { topic: "Trash day", answer: "Tuesday night." });
    const code = (structured(asked).confirmation as { code: string }).code;
    expect((await tool(desk, "save_answer", { topic: "Trash day", answer: "Tuesday night.", confirmation: code })).isError).toBe(false);
    expect(ok(await desk.checkNow()).savedAnswers).toEqual([{ topic: "Trash day", answer: "Tuesday night." }]);
  });
});

describe("A draft goes only to the person it answers", () => {
  const SECOND = "+15555550133";
  const send = (desk: LiveDesk, draft: string) => approvedOnDesk((confirmation) => desk.sendMessage({ draft, ...(confirmation ? { confirmation } : {}) }));

  it("sends a reply to a contact named like the cleaner to the contact, not the cleaner", async () => {
    const opened = openDesk([HOST, CLEANER, OBSERVER], "0");
    const { desk, sms } = opened;
    await setUp(desk, { groupChat: "cleaner-only", contacts: [{ name: "Ana", role: "co-host", phone: OBSERVER }] });
    await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "yes-contact", from: OBSERVER, text: "YES" });
    await desk.inbound({ id: "q", from: OBSERVER, text: "Is the pool open?" });
    const draft = await savedDraft(desk, await idOf(desk, "Is the pool open?"), "Yes, until 9");
    const result = await send(desk, draft);
    // The contact may not be reachable one-to-one; then it's refused. Either way the cleaner never gets it.
    if (result.ok) expect(sms.sent.at(-1)).toMatchObject({ to: OBSERVER, body: expect.stringContaining("Yes, until 9") });
    else expect(result.error).toBe("I can't text Ana right now.");
    expect(sms.sent.filter((item) => item.to === CLEANER && item.body.includes("Yes, until 9"))).toEqual([]);
  });

  it("won't send a draft for the old cleaner after the cleaner is replaced", async () => {
    const opened = openDesk([HOST, CLEANER, SECOND], "0");
    const { desk } = opened;
    await setUp(desk, { groupChat: "cleaner-only", cleanerName: undefined });
    await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "q", from: CLEANER, text: QUESTION });
    const draft = await savedDraft(desk, await idOf(desk, QUESTION));
    ok(await desk.savePeople({ host: HOST, cleaner: SECOND, groupChat: "cleaner-only" }));
    const before = sentCount(opened);
    expect(refused(await desk.sendMessage({ draft })).error).toBe(DRAFT_RECIPIENT_CHANGED);
    expect(sentCount(opened)).toBe(before);
  });

  it("marks both questions answered when the cleaner has no saved name", async () => {
    const opened = openDesk([HOST, CLEANER], "0");
    const { desk, root } = opened;
    await setUp(desk, { groupChat: "cleaner-only", cleanerName: undefined });
    await desk.inbound({ id: "yes-cleaner", from: CLEANER, text: "YES" });
    await desk.inbound({ id: "q1", from: CLEANER, text: QUESTION });
    await desk.inbound({ id: "q2", from: CLEANER, text: "And the vacuum?" });
    const draft = await savedDraft(desk, idOfKept(root, "And the vacuum?"), "Both in the hall closet");
    ok(await send(desk, draft));
    expect(refused(await desk.saveDraft({ replyTo: idOfKept(root, QUESTION), text: "again" })).result).toEqual({ alreadyAnswered: true, by: "assistant" });
  });

  it("won't draft for a contact who texted one-to-one outside the group, and a host group text leaves it open", async () => {
    const { desk, root } = await liveGroup();
    await desk.inbound({ id: "sam", from: OBSERVER, text: "Is the cleaning still on?" });
    const samId = idOfKept(root, "Is the cleaning still on?");
    expect(refused(await desk.saveDraft({ replyTo: samId, text: "Yes" })).error).toBe(DRAFT_NOT_IN_GROUP);
    await desk.inbound({ id: "h", from: HOST, text: "Thanks Ana!", channel: "group" });
    const now = ok(await desk.checkNow());
    const all = [...((now.earlier as OutMessage[]) ?? []), ...((now.messages as OutMessage[]) ?? [])];
    expect(all.find((message) => message.id === samId)).toMatchObject({ reply: "open" });
  });
});

describe("Draft approvals and group members", () => {
  const book = (desk: LiveDesk) => (desk as unknown as { draftApprovals: ConfirmationBook }).draftApprovals;

  it("forgets a draft's codes once it is sent, dropped, replaced, or answered", async () => {
    const { desk } = await liveGroup();
    const replyTo = await asked(desk);
    const sent = await savedDraft(desk, replyTo);
    await previewCode(desk, sent);
    await previewCode(desk, sent);
    expect(book(desk).size).toBe(2);
    ok(await approvedOnDesk((confirmation) => desk.sendMessage({ draft: sent, ...(confirmation ? { confirmation } : {}) })));
    expect(book(desk).size).toBe(0);

    const next = await asked(desk, "And the vacuum?", "q2");
    const dropped = await savedDraft(desk, next);
    await previewCode(desk, dropped);
    ok(await desk.saveDraft({ replyTo: next, drop: true }));
    expect(book(desk).size).toBe(0);

    const replaced = await savedDraft(desk, next);
    await previewCode(desk, replaced);
    await savedDraft(desk, next, "Something else");
    expect(book(desk).size).toBe(0);

    const answered = await savedDraft(desk, next);
    await previewCode(desk, answered);
    await desk.inbound({ id: "h-ans", from: HOST, text: "Under the stairs", channel: "group" });
    ok(await desk.checkNow());
    expect(book(desk).size).toBe(0);
  });

  it("reset_property clears draft approvals", async () => {
    const { desk } = await liveGroup();
    const id = await savedDraft(desk, await asked(desk));
    await previewCode(desk, id);
    ok(await approvedOnDesk((confirmation) => desk.resetProperty(confirmation ? { confirmation } : {}, () => undefined)));
    expect(book(desk).size).toBe(0);
  });

  it("stops a group draft saved before the group's members changed", async () => {
    const opened = await liveGroup();
    const { desk } = opened;
    const id = await savedDraft(desk, await asked(desk));
    await desk.inbound({ id: "stop-host", from: HOST, text: "STOP", channel: "group" });
    const before = sentCount(opened);
    const preview = await desk.sendMessage({ draft: id });
    expect(preview.ok).toBe(false);
    // A host STOP is kept as a host group message, so it answers the question as well as changing the group.
    if (!preview.ok) expect([DRAFT_RECIPIENT_CHANGED, DRAFT_NEW_SINCE, ALREADY_ANSWERED]).toContain(preview.error);
    expect(sentCount(opened)).toBe(before);
  });
});
