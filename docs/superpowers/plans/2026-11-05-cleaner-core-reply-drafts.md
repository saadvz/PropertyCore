# Cleaner Core Reply Drafts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The host's assistant saves a short reply draft for a cleaner's message. The host taps Send, and only then does it go out. A host reply in the group voids the draft, and the host's answers can be saved for the next draft.

**Architecture:** Drafts and saved answers live in the tenant's live-desk file (`LiveFile` in `src/cleaner-core/liveDesk.ts`), next to the kept messages. A new pure module, `src/cleaner-core/replies.ts`, works out whether a message was answered and whether a draft is stale from the kept message list. `check_now` reports both. `send_message` sends a stored draft with a code from a confirmation book whose codes don't expire. The assistant wording lives once, in `src/cleaner-core/replyWording.ts`, and is spread into all four assistants' instructions and routine prompts.

**Tech Stack:** TypeScript, Node 22, vitest, zod, the existing MCP JSON-RPC route in `src/cleaner-core/mcp.ts`.

**Spec:** `docs/superpowers/specs/2026-11-05-cleaner-core-reply-drafts-design.md`

## Global Constraints

- Nothing new ever sends a text by itself. `save_draft` and `save_answer` send nothing. Only `send_message` sends, and only with a code.
- No routine holds `send_message` or `save_answer`. `save_draft` is the only new tool a routine may hold.
- A draft and a saved answer are at most 600 characters (`MAX_HOST_MESSAGE`). Either one is refused when it carries the door code (`DOOR_CODE_IN_CHAT`).
- A draft and its `send_message` code never expire. Every other approval keeps the 10-minute book.
- There is no limit on how many answers are saved. Saving a topic that already exists replaces its answer.
- Tests use only 555 numbers and the made-up `DOOR_CODE` from `test/wiringProof.ts`. A host fixture never texts the Cleaner Core number one-to-one. No test or proof texts a real phone.
- New ids use `messageId()` (letters only), so an id can never hold a run of digits.
- Grok's existing instruction and routine wording changes only where this plan replaces the one draft line.
- Commit messages end with the session's attribution lines and name no model.

## Review Focus

1. **A cleaner message falls off the 200-message list while its draft waits.** The draft leaves `drafts`, and a Send is refused with `DRAFT_GONE`. It is never sent. Test in Task 3.
2. **The group is switched on after a one-to-one draft was saved.** Send is refused with `GROUP_ONLY` and nothing goes one-to-one. Test in Task 4.
3. **The cleaner texts STOP after the draft.** Send is refused with "I can't text Ana right now." and nothing is sent. Test in Task 4.
4. **Two open messages from the cleaner, one draft against the newer.** After Send, both show `reply: "answered"`. Test in Task 4.
5. **The door code reaches `save_draft` or `save_answer` through MCP, split like `80-88`.** The call is refused with `DOOR_CODE_IN_CHAT`. Test in Task 7.

---

### Task 1: Confirmation codes that don't expire

**Files:**
- Modify: `src/operator/confirmations.ts`
- Test: `test/confirmationBook.test.ts` (create)

**Interfaces:**
- Produces: `new ConfirmationBook(Number.POSITIVE_INFINITY, now)` issues codes that never expire. `ConfirmationRequest.expiresInMinutes` becomes `expiresInMinutes?: number` and is left out when the book's TTL isn't finite.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { ConfirmationBook } from "../src/operator/confirmations";

describe("ConfirmationBook", () => {
  it("keeps a code from a book with no expiry", () => {
    let at = 0;
    const book = new ConfirmationBook(Number.POSITIVE_INFINITY, () => at);
    const issued = book.issue("a", "t", "f", "q?");
    expect(issued).not.toHaveProperty("expiresInMinutes");
    at = 365 * 24 * 60 * 60_000;
    expect(() => book.redeem(issued.code, "a", "t", "f")).not.toThrow();
  });

  it("still expires a code from the 10-minute book", () => {
    let at = 0;
    const book = new ConfirmationBook(10 * 60_000, () => at);
    const issued = book.issue("a", "t", "f", "q?");
    expect(issued.expiresInMinutes).toBe(10);
    at = 10 * 60_000;
    expect(() => book.redeem(issued.code, "a", "t", "f")).toThrow(/expired/);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/confirmationBook.test.ts`
Expected: FAIL on `not.toHaveProperty("expiresInMinutes")`.

- [ ] **Step 3: Make `issue` leave out `expiresInMinutes` when `!Number.isFinite(this.ttlMs)`**

An infinite `expiresAt` already never sweeps.

- [ ] **Step 4: Run the test and the typecheck**

Run: `npx vitest run test/confirmationBook.test.ts && npm run typecheck`
Expected: PASS, and no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/operator/confirmations.ts test/confirmationBook.test.ts
git commit -m "ConfirmationBook: a book whose codes don't expire"
```

---

### Task 2: Reply state and earlier context in `check_now`

**Files:**
- Create: `src/cleaner-core/replies.ts`
- Create: `test/cleanerDeskHarness.ts` (shared by Tasks 2 to 7)
- Modify: `src/cleaner-core/liveDesk.ts` (`checkNowSerial`, `messagesOut`)
- Test: `test/cleanerReplies.test.ts` (create), `test/cleanerReplyDrafts.test.ts` (create)

**Interfaces:**
- Produces, in `replies.ts`:
  - `interface ThreadMessage { id: string; from: "cleaner" | "host" | "contact"; name: string; to?: string; channel?: "group"; handled: string }`. `liveDesk.ts`'s `Message` fits it structurally.
  - `type ReplyState = { reply: "open" } | { reply: "answered"; by: "group" | "assistant" }`
  - `replyStateAt(messages: readonly ThreadMessage[], index: number): ReplyState | undefined`. It returns undefined for a host message. A cleaner or contact message is answered by the first later message that has `from: "host"` and either:
    - `channel: "group"`, which counts as `by: "group"`; or
    - `handled: "sent"` and `to` equal to `"the group"` or the message's `name`, which counts as `by: "assistant"`.
  - `earlierThan(messages: readonly ThreadMessage[], firstNew: number, max = 6): ThreadMessage[]` returns up to `max` messages just before `firstNew`, oldest first.
- Produces, in `check_now`'s reply:
  - each cleaner or contact message in `messages` gets `reply`, and `by` when it is answered;
  - `earlier` holds the same shape without photos, and is left out when empty or when there are no new messages.
- Produces, in `test/cleanerDeskHarness.ts`:
  - `openDesk(phones, groupChat: "0" | "1", now?)`, which returns `{ desk, sms, groups, root, env }`. Move it, with `ok`, `refused`, `setUp`, and `connectRoutine`, from `test/cleanerFullSetup.test.ts:379-428`, and import them back there.
  - `liveGroup(now?)`: `setUp` with `groupChat: "cleaner-and-host"`, then YES from `HOST` and from `CLEANER`.
  - `liveOneToOne(now?)`: `setUp` with `groupChat: "cleaner-only"` on `"0"`, then YES from `CLEANER`.
  - `idOf(desk, text)`: the id of the kept message with that text, found through `ok(await desk.checkNow())`. Take it before the assertion under test, since `check_now` marks messages shown.

- [ ] **Step 1: Write the failing pure tests in `test/cleanerReplies.test.ts`**

```ts
const ana = (id: string) => ({ id, from: "cleaner" as const, name: "Ana", handled: "none" });
it("answers by the host's group text", () => {
  const list = [ana("a"), { id: "h", from: "host" as const, name: "Host", channel: "group" as const, handled: "none" }];
  expect(replyStateAt(list, 0)).toEqual({ reply: "answered", by: "group" });
});
it("answers by an assistant send to that person", () => {
  const list = [ana("a"), { id: "s", from: "host" as const, name: "Host", to: "Ana", handled: "sent" }];
  expect(replyStateAt(list, 0)).toEqual({ reply: "answered", by: "assistant" });
});
it("stays open for a send to someone else", () => {
  const list = [ana("a"), { id: "s", from: "host" as const, name: "Host", to: "Sam", handled: "sent" }];
  expect(replyStateAt(list, 0)).toEqual({ reply: "open" });
});
it("has no reply state for a host message", () => {
  expect(replyStateAt([{ id: "h", from: "host", name: "Host", channel: "group", handled: "none" }], 0)).toBeUndefined();
});
it("gives at most six earlier messages, oldest first", () => {
  const list = Array.from({ length: 9 }, (_, i) => ana(`m${i}`));
  expect(earlierThan(list, 8).map((m) => m.id)).toEqual(["m2", "m3", "m4", "m5", "m6", "m7"]);
});
```

- [ ] **Step 2: Write the failing desk tests in `test/cleanerReplyDrafts.test.ts`**

```ts
it("marks a cleaner question answered by the host's group reply, with the question as earlier context", async () => {
  const { desk } = await liveGroup();
  ok(await desk.checkNow());
  await desk.inbound({ id: "q", from: CLEANER, text: "Where are the spare towels?", channel: "group" });
  expect((ok(await desk.checkNow()).messages as any[]).at(-1)).toMatchObject({ text: "Where are the spare towels?", reply: "open" });
  await desk.inbound({ id: "h", from: HOST, text: "Hall closet, top shelf", channel: "group" });
  const now = ok(await desk.checkNow());
  expect(now.messages).toEqual([expect.objectContaining({ from: "host", text: "Hall closet, top shelf" })]);
  expect(now.earlier).toEqual(expect.arrayContaining([expect.objectContaining({ text: "Where are the spare towels?", reply: "answered", by: "group" })]));
});

it("wakes the routine for the host's own group text", async () => {
  // Same pattern as cleanerFullSetup's "wakes the routine for each new message".
  // After draining, one inbound from HOST in the group adds exactly one post.
});

it("does nothing in Cleaner Core for a host group text that sounds like a decision", async () => {
  const { desk, sms, groups } = await liveGroup();
  const before = JSON.stringify(ok(await desk.getTurns()));
  for (const [id, text] of [["d1", "Don't come today"], ["d2", "Come at 2 instead"], ["d3", "Guests are out"]])
    await desk.inbound({ id, from: HOST, text, channel: "group" });
  expect(JSON.stringify(ok(await desk.getTurns()))).toBe(before);
  expect([...sms.sent.map((s) => s.body), ...groups.posts.map((p) => p.body)].some((b) => b.includes(DOOR_CODE))).toBe(false);
});
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `npx vitest run test/cleanerReplies.test.ts test/cleanerReplyDrafts.test.ts`
Expected:
- the pure tests FAIL because the module is missing;
- the first desk test FAILS because `reply` and `earlier` are missing;
- the wake and "does nothing" tests may already PASS, since they pin today's behaviour. Keep them.

- [ ] **Step 4: Implement `replies.ts`, then add `reply`, `by`, and `earlier` in `checkNowSerial` and `messagesOut`**

Work out the state against the full kept list, `this.file.messages`, not just the new messages.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/cleanerReplies.test.ts test/cleanerReplyDrafts.test.ts test/cleanerFullSetup.test.ts`
Expected: PASS. Update any `toEqual` in `cleanerFullSetup` that now sees `reply` on a message to expect it.

- [ ] **Step 6: Commit**

```bash
git add src/cleaner-core/replies.ts src/cleaner-core/liveDesk.ts test/cleanerReplies.test.ts test/cleanerReplyDrafts.test.ts test/cleanerDeskHarness.ts test/cleanerFullSetup.test.ts
git commit -m "Cleaner Core: check_now says which messages are answered, with earlier context"
```

---

### Task 3: `save_draft` and `drafts` in `check_now`

**Files:**
- Modify: `src/cleaner-core/liveDesk.ts` (`LiveFile`, a new `saveDraft`, `checkNowSerial`, `resetPropertyNow`)
- Modify: `src/cleaner-core/replies.ts`
- Test: `test/cleanerReplyDrafts.test.ts`

**Interfaces:**
- Consumes: `replyStateAt` from Task 2.
- Produces:
  - `interface StoredDraft { id: string; replyTo: string; to: string; text: string; base: string }`.
    - `to` is the name `recipientOf` takes: `"group"`, or the sender's name.
    - `base` is the id of the newest kept message at save time.
  - `LiveFile.drafts?: StoredDraft[]`.
  - `draftStatus(draft: StoredDraft, messages: readonly ThreadMessage[]): "ready" | "stale" | "answered" | "gone"`, in `replies.ts`:
    - `gone`: `replyTo` or `base` is no longer kept;
    - `answered`: `replyStateAt` of `replyTo` is answered;
    - `stale`: a message after `base` is anything but `from: "host"` with `handled: "sent"`;
    - otherwise `ready`.
  - `LiveDesk.saveDraft(input: { replyTo?: string; text?: string; drop?: boolean }, pinKey?: Buffer): Promise<ToolReply>`.
    - A save returns `{ draft: { id, replyTo, to: <recipient display name>, text, status: "ready" } }`.
    - A drop returns `{ dropped: true }`.
  - `check_now` returns `drafts: { id, replyTo, to, text, status: "ready" | "stale" }[]`, left out when empty. Before returning, it removes drafts that are `answered` or `gone` from the file.
  - `resetPropertyNow` deletes `this.file.drafts`.
- Copy (exported constants in `liveDesk.ts`):
  - `DRAFT_UNKNOWN = "I don't have that message. Call check_now and use a message id it returned."`
  - `DRAFT_GONE = "That draft was sent, dropped, or already answered. Call check_now for the drafts still waiting."`
  - `ALREADY_ANSWERED = "The host already answered that message. Drop the draft and tell the host nothing more about it."`, sent with `failWith(..., { alreadyAnswered: true, by })`.
  - An empty or over-600 text uses `MESSAGE_NEEDED`. Door code: `DOOR_CODE_IN_CHAT`.

- [ ] **Step 1: Write the failing tests**

```ts
it("saves a draft against the cleaner's question, to the group, and lists it as ready", async () => {
  const { desk, sms, groups } = await liveGroup();
  await desk.inbound({ id: "q", from: CLEANER, text: "Where are the spare towels?", channel: "group" });
  const replyTo = await idOf(desk, "Where are the spare towels?");
  const sentBefore = sms.sent.length + groups.posts.length;
  const saved = ok(await desk.saveDraft({ replyTo, text: "Hall closet, top shelf" }));
  expect(saved.draft).toMatchObject({ replyTo, to: "the group", text: "Hall closet, top shelf", status: "ready" });
  expect(ok(await desk.checkNow()).drafts).toEqual([expect.objectContaining({ replyTo, status: "ready" })]);
  expect(sms.sent.length + groups.posts.length).toBe(sentBefore);
});
it("replaces the draft for the same message", async () => {
  // Two saveDraft calls with the same replyTo leave one draft, holding the second text.
});
it("marks a draft stale when the cleaner writes again", async () => {
  // Save a draft, then inbound "Never mind, found them": drafts[0].status === "stale".
});
it("removes a draft the host answered in the group", async () => {
  // Save a draft, then inbound from HOST in the group: check_now has no drafts.
});
it("refuses an unknown id, a host message, an answered message, the door code, and 601 characters", async () => {
  // refused(...) equals DRAFT_UNKNOWN, DRAFT_UNKNOWN, ALREADY_ANSWERED, DOOR_CODE_IN_CHAT, MESSAGE_NEEDED.
  // The answered refusal's result has { alreadyAnswered: true, by: "group" }.
});
it("drops a draft", async () => {
  // saveDraft({ replyTo, drop: true }) returns { dropped: true }, and check_now has no drafts.
});
it("keeps a draft across a restart", async () => {
  // resetLiveDesks(); liveDeskFor(root, () => env, now).checkNow() still lists it.
});
it("forgets a draft whose message fell off the kept list", async () => {
  // Review Focus 1. Push 200 more inbound messages from CLEANER, then check_now has no drafts.
});
it("reset_property removes drafts", async () => {});
```

Write each commented test out in full, using the assertions in its comment.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run test/cleanerReplyDrafts.test.ts -t draft`
Expected: FAIL, since `desk.saveDraft` is not a function.

- [ ] **Step 3: Implement `draftStatus`, `saveDraft`, the `drafts` output and pruning, and the reset**

`saveDraft` runs inside `this.serial`, calls `this.openSeal(pinKey)` before `carriesCode`, and sets `to` with `this.groupOn() ? "group" : message.name`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/cleanerReplyDrafts.test.ts test/cleanerReplies.test.ts test/cleanerResetProperty.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cleaner-core/liveDesk.ts src/cleaner-core/replies.ts test/cleanerReplyDrafts.test.ts test/cleanerReplies.test.ts
git commit -m "Cleaner Core: save_draft keeps a reply draft that sends nothing"
```

---

### Task 4: `send_message` sends a stored draft

**Files:**
- Modify: `src/cleaner-core/liveDesk.ts` (`sendMessage`, `sendMessageNow`, the constructor)
- Test: `test/cleanerReplyDrafts.test.ts`

**Interfaces:**
- Consumes: `StoredDraft`, `draftStatus` (Task 3); `ConfirmationBook` with an infinite TTL (Task 1).
- Produces:
  - `sendMessage(input: { to?: string; text?: string; draft?: string; confirmation?: string }, pinKey?)`.
  - With `draft`, `to` and `text` are ignored, and the recipient and text come from the stored draft.
  - The preview returns `{ preview: { to, text }, confirmation }`, issued from a new `draftApprovals = new ConfirmationBook(Number.POSITIVE_INFINITY, now)`.
  - The action is `SEND_ACTION`, and the target is the recipient key. The fingerprint is sha256 of `${bound}|draft:${id}|${text}`, where `bound` is the existing group-member binding.
  - The send, after the existing reach and rate checks, calls `keepSent` and removes the draft.
- Refusals, checked at both the preview and the send:
  - `gone` → `DRAFT_GONE`;
  - `answered` → `ALREADY_ANSWERED` with `{ alreadyAnswered: true, by }`;
  - `stale` → `DRAFT_NEW_SINCE = "Something new came in since this draft. Read it with check_now, then save a new draft or drop this one."`, with `{ newSince: true }`.
  - A code that doesn't match → `APPROVAL_STALE`, as today.

- [ ] **Step 1: Write the failing tests**

```ts
it("sends the saved draft to the group with the host's code, then marks the question answered", async () => {
  const { desk, groups } = await liveGroup();
  // inbound question, then save a draft
  const sent = ok(await approvedOnDesk((confirmation) => desk.sendMessage({ draft: id, ...(confirmation ? { confirmation } : {}) })));
  expect(sent.next).toBe("Sent to the group.");
  expect(groups.posts.at(-1)?.body).toContain("Hall closet, top shelf");
  const now = ok(await desk.checkNow());
  expect(now.drafts).toBeUndefined();
  expect(now.earlier).toEqual(expect.arrayContaining([expect.objectContaining({ text: "Where are the spare towels?", reply: "answered", by: "assistant" })]));
});
it("sends a draft a day after its preview", async () => {
  // testClock; preview, move the clock 24 h, send with the same code: ok.
});
it("still expires a to/text code after 10 minutes", async () => {
  // Preview with to: "group", move the clock 10 min, send: refused APPROVAL_STALE.
});
it("refuses a code from before the host's group reply with alreadyAnswered", async () => {
  // Preview, inbound from HOST in the group, send with the code.
  // Refused ALREADY_ANSWERED, { alreadyAnswered: true, by: "group" }.
});
it("refuses a code from before a second cleaner text with newSince", async () => {});
it("refuses a code from before a group member change", async () => {
  // As cleanerFullSetup's group tests change members, e.g. a savePeople that adds a contact.
  // Refused APPROVAL_STALE.
});
it("sends a draft after a restart with a new code", async () => {
  // Preview; resetLiveDesks(); reopen; the old code → APPROVAL_STALE; approvedOnDesk again → sent.
});
it("sends one-to-one to the cleaner without a group", async () => {
  // liveOneToOne(): sms.sent.at(-1) is { to: CLEANER, body contains the text }.
});
it("won't send one-to-one once the group is on", async () => {
  // Review Focus 2. A one-to-one draft, then savePeople with groupChat "cleaner-and-host" and the YES replies.
  // Refused GROUP_ONLY, and nothing is sent.
});
it("won't send after the cleaner texts STOP", async () => {
  // Review Focus 3. "I can't text Ana right now.", and nothing is sent.
});
it("answers both open messages with one draft against the newer", async () => {
  // Review Focus 4.
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run test/cleanerReplyDrafts.test.ts -t send`
Expected: FAIL, because a `draft` argument is refused with `MESSAGE_NEEDED`.

- [ ] **Step 3: Implement the `draft` branch in `sendMessageNow`**

Look the draft up by id, then:
1. check `draftStatus`;
2. resolve with `recipientOf(draft.to)`;
3. do the existing `carriesCode`, reach, and rate checks;
4. issue or redeem on `draftApprovals`.

Leave the `to` and `text` path byte for byte as it is.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/cleanerReplyDrafts.test.ts test/cleanerGroupFirst.test.ts test/cleanerFullSetup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cleaner-core/liveDesk.ts test/cleanerReplyDrafts.test.ts
git commit -m "Cleaner Core: send_message sends a saved draft on the host's yes, with no time limit"
```

---

### Task 5: `save_answer` and `savedAnswers`

**Files:**
- Modify: `src/cleaner-core/liveDesk.ts` (`LiveFile`, a new `saveAnswer`, `checkNowSerial`, `resetPropertyNow`)
- Test: `test/cleanerSavedAnswers.test.ts` (create)

**Interfaces:**
- Produces:
  - `interface SavedAnswer { topic: string; answer: string }` and `LiveFile.savedAnswers?: SavedAnswer[]`.
  - `LiveDesk.saveAnswer(input: { topic?: string; answer?: string; remove?: boolean; confirmation?: string }, pinKey?: Buffer): Promise<ToolReply>`. It uses the 10-minute `approvals` book with `SAVE_ANSWER_ACTION = "cleaner-saved-answer"` and target `"answers"`. The fingerprint is sha256 of `${topicKey}|${answer}|${remove ? 1 : 0}`, where `topicKey` is the topic trimmed and lower-cased.
    - The save question is ``Save for next time, ${topic}: "${answer}"?``.
    - The remove question is `Forget the saved answer for ${topic}?`.
    - The first call returns `{ preview: { topic, answer }, confirmation }`. The second call saves (replacing the same `topicKey`) or removes, and returns `{ next: "Saved." }` or `{ next: "Forgotten." }`.
  - `check_now` returns `savedAnswers`, left out when empty: the host's answers, then `{ topic: "Checklist", answer: items.join("; ") }` when a checklist is saved, then `{ topic: "Cleaning note", answer: instructions }` when a note is saved.
  - `resetPropertyNow` deletes `this.file.savedAnswers`.
- Copy:
  - `ANSWER_NEEDED = "Tell me the topic and the answer, in the host's words."`
  - `ANSWER_TOO_LONG = \`Keep the answer to ${MAX_HOST_MESSAGE} characters.\``
  - `TOPIC_TOO_LONG = "Keep the topic to a few words."`, for a topic over 60 characters.
  - `NO_SUCH_ANSWER = "There's no saved answer for that topic."`
  - Door code: `DOOR_CODE_IN_CHAT`.

- [ ] **Step 1: Write the failing tests**

```ts
it("saves an answer on the host's yes and returns it from check_now", async () => {
  const { desk, sms, groups } = await liveGroup();
  const sentBefore = sms.sent.length + groups.posts.length;
  const asked = ok(await desk.saveAnswer({ topic: "Trash day", answer: "Bins go out Tuesday night." }));
  expect((asked.confirmation as { question: string }).question).toBe('Save for next time, Trash day: "Bins go out Tuesday night."?');
  ok(await approvedOnDesk((confirmation) => desk.saveAnswer({ topic: "Trash day", answer: "Bins go out Tuesday night.", ...(confirmation ? { confirmation } : {}) })));
  expect(ok(await desk.checkNow()).savedAnswers).toEqual([{ topic: "Trash day", answer: "Bins go out Tuesday night." }]);
  expect(sms.sent.length + groups.posts.length).toBe(sentBefore);
});
it("replaces an answer for the same topic, ignoring case", async () => {
  // "trash day", then "Trash Day" → one entry, holding the second answer.
});
it("saves without a count limit", async () => {
  // 100 approved saves → 100 entries.
});
it("removes an answer, and refuses a topic that isn't saved", async () => {});
it("refuses the door code, 601 characters, a 61-character topic, and an empty answer", async () => {});
it("refuses a changed answer under an old code", async () => {
  // APPROVAL_STALE.
});
it("lists the checklist and the cleaning note after the host's answers", async () => {});
it("never sends a saved answer by itself", async () => {
  // Save one, inbound a matching cleaner question, check_now: no new sms or group post.
});
it("reset_property removes saved answers", async () => {});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run test/cleanerSavedAnswers.test.ts`
Expected: FAIL, since `desk.saveAnswer` is not a function.

- [ ] **Step 3: Implement `saveAnswer`, the `savedAnswers` output, and the reset**

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/cleanerSavedAnswers.test.ts test/cleanerResetProperty.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cleaner-core/liveDesk.ts test/cleanerSavedAnswers.test.ts
git commit -m "Cleaner Core: save_answer keeps the host's answers for the next draft"
```

---

### Task 6: The assistant wording and the templates

**Files:**
- Create: `src/cleaner-core/replyWording.ts`
- Modify:
  - `src/cleaner-core/mcp.ts` (`GROK_INSTRUCTIONS`, at the line starting "When a message needs a reply Cleaner Core doesn't send itself");
  - `src/cleaner-core/assistant.ts` (the same line in `CLAUDE_INSTRUCTIONS`, `CHATGPT_INSTRUCTIONS`, and `MUSE_INSTRUCTIONS`, and step 3 of `CLAUDE_TASK_PROMPT`, `CHATGPT_TASK_PROMPT`, and `MUSE_TASK_PROMPT`);
  - `cleaner-template/bot-profile.md`;
  - `cleaner-template/routines/cleaner-core-alerts.md` and `cleaner-core-check.md` (the summary step);
  - `claude-template/routines/cleaner-core-task.md` and `chatgpt-template/routines/cleaner-core-task.md`;
  - `cleaner-template/template.json` (both routines' `allowedTools` gain `"save_draft"`).
- Test: `test/cleanerTemplate.test.ts`, plus whichever of `test/cleanerClaude.test.ts`, `test/cleanerChatGpt.test.ts`, `test/cleanerMuseDeployment.test.ts`, and `test/cleanerPayInstructions.test.ts` pin these prompts.

**Interfaces:**
- Produces, in `replyWording.ts`:
  - `REPLY_INSTRUCTIONS: readonly string[]` holds exactly these three lines. Each chat instruction array spreads it in place of the old draft line.
  - `ROUTINE_REPLY_SENTENCE: string` holds the copy below. In the ChatGPT and Muse task prompts it replaces "When a message needs a reply, draft one short reply and offer it.". In Claude's task prompt and the Grok routine docs it goes after the pause sentence in step 3.

Lines in `REPLY_INSTRUCTIONS`:

```
When a cleaner or contact message has reply open and needs an answer, write one short reply and save it with save_draft against that message. Show the host who wrote, their words quoted, and the draft exactly as saved, with a choice card: Send, Edit, Skip. On Send, call send_message with the draft's id, then again with the code it returns: the host's Send was the yes to that exact text. On Edit, save the new text with save_draft and show the card again. On Skip, call save_draft with drop true. A draft may come from a routine run; check_now's drafts list has its id. When the host tells you what to reply, save it with save_draft against the cleaner's message and send it the same way. Never draft about pay, and never promise a time, a pause, or anything the host hasn't said. When you don't know a fact, say the host will check, or ask the host.
Read the host's own group messages too. When a message has reply answered, or a draft comes back alreadyAnswered, the host already replied: drop it and say nothing more about it. When a draft is stale or comes back newSince, read the new messages, then save a new draft or drop it. A host group text changes nothing in Cleaner Core: when it sounds like a decision (don't come today, come at 2, the guests are out), ask the host whether to do it with hold_job, confirm_times, or mark_guests_left. You can't see texts the host sends from their own phone outside the group; when the host says they already answered, drop the draft.
After a reply goes out, through Send or the host's own group text, and it answers something likely to be asked again (supplies, linens, trash, parking, Wi-Fi, house quirks), ask once whether to save it for next time, and call save_answer with the host's own words only after the host's yes. Never offer to save a time, a problem, or pay. When an answer in savedAnswers answers a new message, draft that answer word for word.
```

`ROUTINE_REPLY_SENTENCE`:

```
When a message has reply open and needs an answer, save one short reply with save_draft and show the host the message, the draft exactly as saved, and Send, Edit, Skip. When a draft is stale, read the new messages, then save a new draft or drop it. When a message has reply answered, the host already replied: say nothing more about it, and if the reply answers something likely to be asked again, ask once whether to save it for next time.
```

- [ ] **Step 1: Write the failing template tests in `test/cleanerTemplate.test.ts`**

```ts
it("lets routines draft but never send or save an answer", () => {
  for (const routine of manifest().routines) {
    expect(routine.allowedTools).toContain("save_draft");
    expect(routine.allowedTools).not.toContain("save_answer");
  }
});
it("carries the reply wording in every assistant and routine doc", () => {
  for (const lines of [GROK_INSTRUCTIONS, CLAUDE_INSTRUCTIONS, CHATGPT_INSTRUCTIONS, MUSE_INSTRUCTIONS])
    for (const line of REPLY_INSTRUCTIONS) expect(lines).toContain(line);
  for (const prompt of [CLAUDE_TASK_PROMPT, CHATGPT_TASK_PROMPT, MUSE_TASK_PROMPT]) expect(prompt.join("\n")).toContain(ROUTINE_REPLY_SENTENCE);
  for (const doc of ["cleaner-template/routines/cleaner-core-alerts.md", "cleaner-template/routines/cleaner-core-check.md", "claude-template/routines/cleaner-core-task.md", "chatgpt-template/routines/cleaner-core-task.md"])
    expect(read(join(ROOT, doc)).replace(/\s+/g, " ")).toContain(ROUTINE_REPLY_SENTENCE);
  for (const line of REPLY_INSTRUCTIONS) expect(read(join(TEMPLATE, "bot-profile.md")).replace(/\s+/g, " ")).toContain(line);
});
```

Also add `"save_answer"` to `NEEDS_HOST_YES` in that file.

Adjust the prompt types if they aren't arrays (`CLAUDE_TASK_PROMPT` is an array of lines).

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run test/cleanerTemplate.test.ts`
Expected: FAIL, because `replyWording` is missing.

- [ ] **Step 3: Write `replyWording.ts`, spread it into the four instruction arrays and three task prompts, and update the markdown files and `template.json`**

The markdown files may wrap lines. The test compares with whitespace collapsed. Update the `GROK_INSTRUCTIONS` comment "unchanged" to say that only the reply lines changed.

- [ ] **Step 4: Run the wording tests**

Run: `npx vitest run test/cleanerTemplate.test.ts test/cleanerClaude.test.ts test/cleanerChatGpt.test.ts test/cleanerMuse.test.ts test/cleanerMuseDeployment.test.ts test/cleanerPayInstructions.test.ts`
Expected: PASS. Where a test pins a task prompt file against its constant, update the pinned file, not the test's check.

- [ ] **Step 5: Commit**

```bash
git add src/cleaner-core/replyWording.ts src/cleaner-core/mcp.ts src/cleaner-core/assistant.ts cleaner-template claude-template chatgpt-template test
git commit -m "Cleaner Core: teach the assistants to draft, read group replies, and save answers"
```

---

### Task 7: The MCP tools

**Files:**
- Modify: `src/cleaner-core/mcp.ts` (the tool list, `chatCarriesDoorCode`, `callTool`)
- Test: `test/cleanerReplyDrafts.test.ts` and `test/cleanerSavedAnswers.test.ts`, through the MCP route with `startWiredApp` and `call` from `test/wiringProof.ts`. Use the pattern in `test/cleanerFullSetup.test.ts:312`.

**Interfaces:**
- Consumes: `LiveDesk.saveDraft` (Task 3), the `draft` option of `sendMessage` (Task 4), and `LiveDesk.saveAnswer` (Task 5).
- Produces:
  - **`save_draft`**: title "Save a reply draft".
    - Input: `z.object({ replyTo: z.string(), text: z.string().optional(), drop: z.boolean().optional() })`.
    - Description: "Saves one short reply draft for a cleaner or contact message, by its id from check_now. It sends nothing. Cleaner Core works out who it goes to. A new draft for the same message replaces the old one; drop true removes it. Show the host the draft exactly as returned, with Send, Edit, Skip."
  - **`save_answer`**: title "Save an answer for next time".
    - Input: `z.object({ topic: z.string(), answer: z.string().optional(), remove: z.boolean().optional(), confirmation: z.string().optional() })`.
    - Description: "Saves the host's own answer to a question the cleaner is likely to ask again, so the next draft can use it word for word. It sends nothing. Call once without confirmation to get the question and a code, ask the host, and call again with the code only after the host says yes. remove true forgets the topic."
  - **`send_message`**: the input gains `draft: z.string().optional()`, and `to` and `text` become optional. The description adds: "To send a saved draft, pass draft with its id instead of to and text."
  - **`chatCarriesDoorCode`**: skips the `confirmation` key for `save_answer` as well.

- [ ] **Step 1: Write the failing MCP tests**

```ts
it("lists save_draft and save_answer, and sends a draft through the MCP route", async () => {
  // tools/list contains both names; save_draft → send_message { draft } → approvedTool → sent.
});
it("refuses the door code split like 80-88 in save_draft and save_answer", async () => {
  // Review Focus 5. Both are isError with DOOR_CODE_IN_CHAT. Split DOOR_CODE the way the existing chatCarriesDoorCode tests do.
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run test/cleanerReplyDrafts.test.ts test/cleanerSavedAnswers.test.ts -t MCP`
Expected: FAIL, because the tools aren't listed.

- [ ] **Step 3: Register both tools, add the `callTool` cases, and widen the `send_message` input and the door-code skip**

- [ ] **Step 4: Run the whole suite and the typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS. Update any test that pins the full tool list to include the two new names.

- [ ] **Step 5: Commit**

```bash
git add src/cleaner-core/mcp.ts test
git commit -m "Cleaner Core: save_draft and save_answer tools, and send_message draft"
```

---

### Task 8: Safety gates and the full check

**Files:**
- Modify: `docs/cleaner-core-safety-gates.md`

- [ ] **Step 1: Add the four gate rows from spec section 6 to the table, word for word, above "Secret scan"**

- [ ] **Step 2: Run the CI check**

Run: `bash scripts/ci-check.sh`
Expected: these lines, in order:
- `typecheck ok`
- `build ok`
- `test-default ok`
- `secret-scan ok`
- `tracked-scan ok`

- [ ] **Step 3: Run the Scratch proof with the verify-cleanercore skill, without its live steps**

Follow `.cursor/skills/verify-cleanercore/SKILL.md` on a Scratch tenant with 555 numbers:
1. the cleaner asks a question;
2. `save_draft`;
3. `send_message` with the draft;
4. a host group reply;
5. a second draft, which comes back `alreadyAnswered` or `newSince`.

Expected: every reply matches, and no text goes to a real phone. A live run waits for Saad's okay.

- [ ] **Step 4: Commit**

```bash
git add docs/cleaner-core-safety-gates.md
git commit -m "Cleaner Core: safety gates for reply drafts and saved answers"
```
