# Cleaner Core: reply drafts, group replies, and saved answers

Date: 2026-11-05. Status: draft for Saad's review.

## Goal

When the cleaner texts something that needs an answer, the host's assistant
(Grok, Claude, ChatGPT, or Muse) drafts one short reply. The host sees the
cleaner's words and the draft, and taps Send if it's fine. Nothing goes to
the cleaner without that tap.

When the host answers in the group text instead, the assistant reads that
reply, understands the question is answered, and drops its draft.

Over time, the host's answers can be saved, so the next draft for the same
question uses the host's own words. There is no new setup step.

## What Saad said

- The main flow is the draft and the host's Send. The host stays in charge of
  every reply.
- No setup step that asks for a list of facts up front.
- The host may reply in the group text instead of through the assistant. The
  assistant has to read that and understand it.

## Not in this version

- Any reply sent without the host's tap, including saved answers.
- Gemini or any other model inside Cleaner Core. The host's own assistant
  writes the drafts.
- A setup step or a facts questionnaire.
- Replies about pay. The payments design keeps every pay text with the host.

## What exists today

- Cleaner Core sends nothing for a cleaner text that isn't a keyword. It keeps
  the message, and the assistant reads it with `check_now`
  (`quietOrGuide` in `src/cleaner-core/core.ts`).
- All four assistants' chat instructions already say to draft one short
  reply and send it with `send_message` only after the host says yes
  (`src/cleaner-core/mcp.ts` for Grok, `src/cleaner-core/assistant.ts` for
  the others). The ChatGPT and Muse routine prompts say it too. The Grok and
  Claude routine prompts, which run when a cleaner text wakes them, don't.
  Nothing says how to show the draft, what happens on a late yes, or what to
  do when the host answers in the group.
- `send_message` previews the exact text and returns an approval code. The
  second call, with the code, sends. The code is bound to the recipient and
  the exact text (and, for a group, its members), and expires after 10
  minutes (`ConfirmationBook` in `src/cleaner-core/liveDesk.ts`).
- With a group, `send_message` goes only to the group.
- The host's own texts in the group are already kept as messages with
  `from: "host"` and `channel: "group"` (`speaker` in `liveDesk.ts`). A host
  text to the Cleaner Core number one-to-one is not kept, and a text from the
  host's phone straight to the cleaner's phone never reaches Cleaner Core.
- `check_now` returns only the messages it hasn't returned before.
- Any newly kept message, the host's own group reply included, wakes the
  alert routine.

## 1. Which messages get a draft

The assistant drafts a reply for a cleaner message (or a saved contact's
message) that asks something or needs an answer: a question, running late,
supplies, "can't find the ...", an arrival time.

No draft, as today:

- Routine replies (YES, NO, DONE, "ok", "thanks", a photo with no words).
- Injury, STOP, HELP, and a text that looks like a door code. Cleaner Core
  already handles these before the assistant sees them.
- Pay or Venmo. The assistant tells the host and drafts nothing.

**A problem** (a broken lock, no access, damage, anything that could stop
the cleaning) keeps the existing flow: the assistant quotes it and asks
whether to pause. It may also offer a short draft, such as "Thanks, checking
with the owner now." The pause still needs its own yes through `hold_job`.

**Never in a draft:**

- A door code. `send_message` already refuses one.
- A promise the host hasn't made: pay, a new time, skipping part of the
  checklist, a pause.
- A guess at a fact the assistant doesn't know, such as where something is.
  Without a saved answer or something the host said, the draft says the host
  will check, or the assistant asks the host the question instead of
  drafting.

## 2. The draft and Send

For each message that needs one, the assistant's summary shows:

1. Who wrote and their words, quoted.
2. The draft. It is the exact text `send_message` previewed, so what the host
   approves is what gets sent.
3. A choice card: **Send**, **Edit**, **Skip**.

- **Send** calls `send_message` again with the code.
- **Edit**: the host says what to change, the assistant previews the new
  text, and shows the card again.
- **Skip** sends nothing. Ignoring the card sends nothing either.

One draft per open message. Several open messages from the same person get
one combined draft.

**Drafting means a preview call.** The assistant calls `send_message` with
`to`, `text`, and a new `replyTo` (section 3) and no confirmation. That call
sends nothing and returns the preview and code.

**A late Send.** A routine run often drafts while the host is away, and the
code expires after 10 minutes. When the host taps Send later, the assistant
calls `send_message` for a new preview. If the new preview's text and
recipient are word for word what the host approved, it sends with the new
code. If anything differs, or the preview is refused (section 3), it shows
the host what changed and asks again.

**Wording by assistant.** Grok and Claude are woken by the routine, so a
draft can be ready within a minute or so. Cleaner Core can't wake ChatGPT or
Muse: ChatGPT checks once an hour, and Muse as often as the host picked.
Their wording keeps telling the host that the cleaner's texts show up
right away in the group text, and that the host can ask for a draft at any
time.

## 3. When the host replies in the group

### What the assistant reads

`check_now` gives the assistant enough to understand a reply without the
earlier messages being returned again:

- **`earlier`**: up to 6 messages, already shown, from just before the first
  new message, oldest first. It is read as context only; nothing in it is new.
- **`reply` on each cleaner or contact message**: `open`, or `answered` when
  a later host message reached the same person. A later host message is the
  host's own group text, or a `send_message` to the group or to that person.
  `answered` includes `by: "group"` or `by: "assistant"`.

Each host group message stays a message with `from: "host"`, so the
assistant reads the host's actual words.

### What the assistant does

- **The host answered in the group.** The assistant drops its draft and says
  nothing more about that question. If the host's words answer something the
  cleaner will likely ask again, it may offer to save them (section 4).
- **The host's group reply answers only part of it.** The assistant drafts
  only the rest, or asks the host about the rest.
- **The host's group words sound like a decision Cleaner Core has to act
  on**, such as "don't come today", "come at 2 instead", or "guests are out".
  A group text changes nothing in Cleaner Core, so the assistant asks the
  host whether to do it: `hold_job`, `confirm_times`, or `mark_guests_left`,
  each with its own yes as today. It never acts on the group text alone.
- **Only the host's own reply is new.** When nothing else needs the host, the
  routine summary stays "Nothing new.", apart from any save offer.

### What the server enforces

`send_message` gains an optional `replyTo`: the id of the message being
answered, as `check_now` returned it.

- With `replyTo`, the approval is also bound to the newest kept message at
  preview time. If anything new arrives before the Send (a host group text,
  or another text from the cleaner), the code no longer matches, and the
  send is refused with `newSince: true`. The assistant reads the new
  messages, then drafts again or drops the draft.
- A preview with `replyTo` for a message that is already `answered` is
  refused with `alreadyAnswered: true` and its `by`. The assistant tells the
  host it was already answered and offers nothing.
- Without `replyTo`, `send_message` works as today. That covers a message
  the host writes from scratch.

### What the assistant can't see

The host may reply from their own phone straight to the cleaner, outside the
group and outside Cleaner Core. When the host says "I already answered", the
assistant drops the draft. The setup review and the bot profile say once
that only group replies and replies sent through the assistant can be seen.

## 4. Saving an answer for next time

After a reply goes out, the assistant may ask once: "Save this as the answer
for next time someone asks about ...?" This applies to a draft the host sent,
or the host's own group reply. It asks only when the question is likely to
come up again: supplies, linens, trash, parking, Wi-Fi for the cleaner's
phone, or house quirks. It never asks about time-bound or one-off replies
("I'll be there at 2"), problems, or pay.

**`save_answer`**, a new host tool:

- Input: `topic` (a few words, such as "trash day"), `answer` (the host's
  words, unchanged), an optional `remove`, and `confirmation`.
- It uses the same two-call approval as `send_message`: the first call
  returns the exact topic and answer with a code, and the second call saves.
- It is refused when the answer carries the door code (`carriesCode`, as
  `save_preferences` does), when it is over 300 characters, or when 40 are
  already saved.
- The assistant saves the host's words. It may cut the reply down to the
  sentence that answers the question, but it never rewrites it.

**How saved answers are used:**

- `check_now` returns `savedAnswers` (topic and answer) beside any message
  that's open.
- When one answers the cleaner's question, the assistant's draft is that
  answer word for word, maybe with the cleaner's name in front. The host still
  taps Send.
- The saved checklist and the cleaning note (`save_preferences`) count as
  saved answers too, so day one isn't empty.
- The host can list, change, or remove them in chat ("what answers have you
  saved?", "forget the trash one").

The saved answers are stored in the tenant's live-desk file, so they're part
of the backup and are reset by `reset_property`.

## 5. Where it changes

- `src/cleaner-core/liveDesk.ts`: `replyTo` on `send_message`, `earlier` and
  `reply` on `check_now`, `savedAnswers`, and `save_answer`.
- `src/cleaner-core/mcp.ts`: the `send_message` and `save_answer` tool
  descriptions and the instructions.
- `src/cleaner-core/assistant.ts`: the routine prompt and the
  message-reading lines for all four assistants. Grok's wording changes only
  by the added draft lines.
- `cleaner-template/bot-profile.md` and each template's
  `routines/cleaner-core-*.md`, kept in step with `assistant.ts` by
  `test/cleanerTemplate.test.ts`.
- `docs/cleaner-core-safety-gates.md`: the new rows below.

## 6. Safety gates

| Gate | What it holds | Proof |
| --- | --- | --- |
| Draft needs Send | No reply goes to anyone without the host's code from the preview of that exact text. A draft the host never answers sends nothing. | `test/cleanerReplyDrafts.test.ts` |
| Group reply wins | After the host's group text, a preview with `replyTo` for the message it answered is refused with `alreadyAnswered`, and a code issued before it is refused with `newSince`. | `test/cleanerReplyDrafts.test.ts` |
| Group text acts on nothing | A host group text never holds, resumes, sets times, or releases the door code. | `test/cleanerReplyDrafts.test.ts` |
| Saved answers | A saved answer can't hold the door code. Saving and removing need the host's code. A saved answer is never sent by itself. | `test/cleanerSavedAnswers.test.ts` |

## 7. Testing and verification

- Unit tests on a 555 Scratch tenant, with a 555 host number:
  - preview and Send;
  - a late Send with an identical text;
  - `newSince` after a host group text and after a second cleaner text;
  - `alreadyAnswered`;
  - `earlier` and `reply` in `check_now`;
  - `save_answer`'s approval, the door-code refusal, and the 40-answer limit;
  - a saved answer shows up in `savedAnswers` and is never sent on its own.
- Template tests: the four prompts carry the draft, group-reply, and save
  wording.
- The verify-cleanercore skill on Scratch: a cleaner question, a draft, a
  Send, then a host group reply that makes the next draft stale. Nothing goes
  to a real phone. Saad approves any live run first.

## Later

- **Sending a saved answer automatically**: off by default, turned on by the
  host for each answer, still only word for word. It needs its own safety
  gate and Saad's okay.
- **Gemini as the matcher** for that automatic path, so ChatGPT and Muse
  hosts get an instant answer without waiting for the next scheduled check.

## Open questions

1. Is 10 minutes the right lifetime for a draft's code? The late-Send rule
   covers it, but a longer one for drafts with `replyTo` would mean fewer new
   previews.
2. Should the host's own group reply wake the routine at all? It does today.
   Waking is what lets the assistant drop a draft and offer to save, at the
   cost of an extra run.
3. Is 40 saved answers per property enough?
