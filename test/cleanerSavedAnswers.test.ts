import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ANSWER_NEEDED, ANSWER_TOO_LONG, CODE_IN_DRAFT, CODE_IN_SAVED_ANSWER, DOOR_CODE_IN_CHAT, NO_SUCH_ANSWER, TOPIC_TOO_LONG, type LiveDesk } from "../src/cleaner-core/liveDesk";
import { approvedOnDesk } from "./hostApproval";
import { CLEANER, DOOR_CODE } from "./wiringProof";
import { PIN_KEY, cleanupDesks, idOf, liveGroup, ok, refused } from "./cleanerDeskHarness";

afterEach(() => cleanupDesks());

const STALE = "That approval has expired or doesn't match. Ask the host again.";

function save(desk: LiveDesk, input: Parameters<LiveDesk["saveAnswer"]>[0]) {
  return approvedOnDesk((confirmation) => desk.saveAnswer({ ...input, ...(confirmation ? { confirmation } : {}) }));
}

async function savedOf(desk: LiveDesk) {
  return ok(await desk.checkNow()).savedAnswers as { topic: string; answer: string }[] | undefined;
}

describe("save_answer", () => {
  it("saves an answer on the host's yes and returns it from check_now", async () => {
    const { desk, sms, groups } = await liveGroup();
    const sentBefore = sms.sent.length + groups.posts.length;
    const asked = ok(await desk.saveAnswer({ topic: "Trash day", answer: "Bins go out Tuesday night." }));
    expect(asked.preview).toEqual({ topic: "Trash day", answer: "Bins go out Tuesday night." });
    expect((asked.confirmation as { question: string }).question).toBe('Save for next time, Trash day: "Bins go out Tuesday night."?');
    expect(ok(await save(desk, { topic: "Trash day", answer: "Bins go out Tuesday night." })).next).toBe("Saved.");
    expect(await savedOf(desk)).toEqual([{ topic: "Trash day", answer: "Bins go out Tuesday night." }]);
    expect(sms.sent.length + groups.posts.length).toBe(sentBefore);
  });

  it("saves nothing without the code", async () => {
    const { desk } = await liveGroup();
    ok(await desk.saveAnswer({ topic: "Trash day", answer: "Bins go out Tuesday night." }));
    expect(await savedOf(desk)).toBeUndefined();
  });

  it("replaces an answer for the same topic, ignoring case", async () => {
    const { desk } = await liveGroup();
    ok(await save(desk, { topic: "trash day", answer: "Tuesday." }));
    ok(await save(desk, { topic: "Trash Day", answer: "Wednesday now." }));
    expect(await savedOf(desk)).toEqual([{ topic: "Trash Day", answer: "Wednesday now." }]);
  });

  it("saves without a count limit", async () => {
    const { desk } = await liveGroup();
    for (let i = 0; i < 100; i++) ok(await save(desk, { topic: `topic ${String.fromCharCode(97 + (i % 26))}${i}`, answer: "An answer." }));
    expect(await savedOf(desk)).toHaveLength(100);
  });

  it("removes an answer, and refuses a topic that isn't saved", async () => {
    const { desk } = await liveGroup();
    ok(await save(desk, { topic: "Trash day", answer: "Tuesday." }));
    const asked = ok(await desk.saveAnswer({ topic: "trash day", remove: true }));
    expect((asked.confirmation as { question: string }).question).toBe("Forget the saved answer for trash day?");
    expect(ok(await save(desk, { topic: "trash day", remove: true })).next).toBe("Forgotten.");
    expect(await savedOf(desk)).toBeUndefined();
    expect(refused(await desk.saveAnswer({ topic: "Parking", remove: true })).error).toBe(NO_SUCH_ANSWER);
  });

  it("refuses the door code, 601 characters, a 61-character topic, and an empty answer", async () => {
    const { desk } = await liveGroup();
    expect(refused(await desk.saveAnswer({ topic: "Lock", answer: `The code is ${DOOR_CODE}` })).error).toBe(DOOR_CODE_IN_CHAT);
    expect(refused(await desk.saveAnswer({ topic: `Code ${DOOR_CODE}`, answer: "x" })).error).toBe(DOOR_CODE_IN_CHAT);
    expect(refused(await desk.saveAnswer({ topic: "Long", answer: "a".repeat(601) })).error).toBe(ANSWER_TOO_LONG);
    expect(ANSWER_TOO_LONG).toBe("Keep the answer to 600 characters.");
    expect(refused(await desk.saveAnswer({ topic: "t".repeat(61), answer: "x" })).error).toBe(TOPIC_TOO_LONG);
    expect(refused(await desk.saveAnswer({ topic: "Trash", answer: "  " })).error).toBe(ANSWER_NEEDED);
    expect(refused(await desk.saveAnswer({ topic: " ", answer: "x" })).error).toBe(ANSWER_NEEDED);
  });

  it("refuses a changed answer under an old code", async () => {
    const { desk } = await liveGroup();
    const asked = ok(await desk.saveAnswer({ topic: "Trash day", answer: "Tuesday." }));
    const code = String((asked.confirmation as { code: string }).code);
    expect(refused(await desk.saveAnswer({ topic: "Trash day", answer: "Friday.", confirmation: code })).error).toBe(STALE);
  });

  it("lists the checklist and the cleaning note after the host's answers", async () => {
    const { desk } = await liveGroup(undefined, { checklist: ["Strip beds", "Empty trash"], instructions: "Linens are in the hall closet." });
    ok(await save(desk, { topic: "Parking", answer: "Park in the driveway." }));
    expect(await savedOf(desk)).toEqual([
      { topic: "Parking", answer: "Park in the driveway." },
      { topic: "Checklist", answer: "Strip beds; Empty trash" },
      { topic: "Cleaning note", answer: "Linens are in the hall closet." },
    ]);
  });

  it("never sends a saved answer by itself", async () => {
    const { desk, sms, groups } = await liveGroup();
    ok(await save(desk, { topic: "Trash day", answer: "Bins go out Tuesday night." }));
    const sentBefore = sms.sent.length + groups.posts.length;
    await desk.inbound({ id: "q", from: CLEANER, text: "When is trash day?", channel: "group" });
    ok(await desk.checkNow());
    expect(sms.sent.length + groups.posts.length).toBe(sentBefore);
  });

  it("reset_property removes saved answers", async () => {
    const { desk, root } = await liveGroup();
    ok(await save(desk, { topic: "Trash day", answer: "Bins go out Tuesday night." }));
    ok(await approvedOnDesk((confirmation) => desk.resetProperty(confirmation ? { confirmation } : {}, () => undefined)));
    const file = join(root, "cleaner-live.json");
    expect(existsSync(file) ? readFileSync(file, "utf8") : "").not.toContain("Bins go out");
  });
});

describe("Saved answers and the door code", () => {
  it("refuses a long number in an answer while the door code is sealed and can't be checked", async () => {
    const opened = await liveGroup();
    const desk = opened.reopen();
    expect(refused(await desk.saveAnswer({ topic: "Gate", answer: "The gate code is 4417." })).error).toBe(DOOR_CODE_IN_CHAT);
    expect(ok(await desk.saveAnswer({ topic: "Gate", answer: "The gate code is 4417." }, PIN_KEY)).preview).toEqual({ topic: "Gate", answer: "The gate code is 4417." });
  });

  it("says a new door code's digits are in a saved answer, without repeating them", async () => {
    const { desk } = await liveGroup();
    ok(await approvedOnDesk((confirmation) => desk.saveAnswer({ topic: "Gate", answer: "The side gate opens with 4417.", ...(confirmation ? { confirmation } : {}) }, PIN_KEY)));
    const error = refused(await desk.saveDoorCode({ code: "4417" }, PIN_KEY)).error;
    expect(error).toBe(CODE_IN_SAVED_ANSWER("Gate"));
    expect(error).not.toContain("4417");
  });

  it("names no topic when the topic itself holds the digits", async () => {
    const { desk } = await liveGroup();
    ok(await approvedOnDesk((confirmation) => desk.saveAnswer({ topic: "Box 4417", answer: "By the back door.", ...(confirmation ? { confirmation } : {}) }, PIN_KEY)));
    const error = refused(await desk.saveDoorCode({ code: "4417" }, PIN_KEY)).error;
    expect(error).toBe(CODE_IN_SAVED_ANSWER());
    expect(error).not.toContain("4417");
  });

  it("says a new door code's digits are in a waiting draft", async () => {
    const { desk } = await liveGroup();
    await desk.inbound({ id: "q", from: CLEANER, text: "How do I get in the side gate?", channel: "group" });
    ok(await desk.saveDraft({ replyTo: await idOf(desk, "How do I get in the side gate?"), text: "It opens with 4417." }, PIN_KEY));
    const error = refused(await desk.saveDoorCode({ code: "4417" }, PIN_KEY)).error;
    expect(error).toBe(CODE_IN_DRAFT);
    expect(error).not.toContain("4417");
  });
});
