# Cleaner Core: reply drafts, group replies, and saved answers

Date: 2026-11-05. Status: draft; the open questions were decided in review with Saad on 2026-11-05.

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
  alert routine. This stays: everything in the text wakes the assistant.

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
2. The draft, exactly as Cleaner Core saved it, so what the host approves is
   what gets sent.
3. A choice card: **Send**, **Edit**, **Skip**.

- **Send**: the assistant calls `send_message` with the draft's id. It shows
  the host the saved text and returns a code. The host's Send was the yes to
  that exact text, so the assistant then calls again with the code in the
  same turn.
- **Edit**: the host says what to change, the assistant saves the new text
  as the draft for the same message, and shows the card again.
- **Skip** drops the draft and sends nothing. Ignoring the card sends nothing
  either.

One draft per open message. Several open messages from the same person get
one combined draft, saved against the newest of them.

**Drafts are saved on the server.** The routine that a cleaner text wakes
can't hold `send_message`, because a routine runs with no one watching (the
template test holds routines to tools that need no yes). So drafting uses a
new tool, **`save_draft`**, that sends nothing:

- Input: `replyTo` (the message id from `check_now`), `text`, or
  `drop: true`.
- It works out who the reply goes to from `replyTo`: the group when there is
  one, otherwise the person who wrote.
- It's refused when the text carries the door code, is longer than a
  `send_message` text (600 characters), or when `replyTo` isn't an open
  cleaner or contact message.
- A new draft for the same `replyTo` replaces the old one.

`check_now` returns the drafts waiting for the host as `drafts`, so any chat
with the host sees them, even when a routine made them.

**A draft doesn't expire.** It is kept in the live-desk file, so a restart
doesn't lose it, and it has no time limit. The host can tap Send an hour or a
day later. The approval code for a draft has no time limit either. A code
lost to a restart is just asked for again: the saved text hasn't changed.
Only these stop a draft from going out:

- something new in the thread (section 3);
- a change to who is in the group;
- the message being answered some other way.

Other approvals, such as `hold_job`, `mark_paid`, or a `send_message` with
`to` and `text`, keep today's 10 minutes.

**When the host writes the reply in chat** ("tell her the bins are out
back"), the assistant saves it with `save_draft` against the cleaner's
message, then sends it the same way. That keeps the answered tracking and
the staleness check for every reply.

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
- **Only the host's own reply is new.** Every text in the group wakes the
  assistant, the host's own included, so it can drop a draft the host
  already answered and offer to save the answer. When nothing else needs the
  host, the routine summary stays "Nothing new.", apart from any save offer.

### What the server enforces

Each draft has a `status` in `check_now`:

- **`ready`**: nothing has happened in the thread since it was saved.
- **`stale`**: a new message was kept after it was saved (a host group text,
  or another text from the cleaner or a contact). The assistant reads the new
  messages, then saves a new draft or drops this one.
- A draft whose message became `answered` is removed by Cleaner Core and
  isn't returned.

`send_message` gains `draft`: a draft's id, in place of `to` and `text`.

- A stale draft is refused with `newSince: true`, both for the preview and
  for the send.
- A draft whose message was answered is refused with `alreadyAnswered: true`
  and its `by`. The assistant tells the host it was already answered and
  offers nothing.
- The code is bound to the draft, its text, and, for a group, who is in it,
  like every `send_message` code.
- Once a draft is sent, it is removed.
- `send_message` with `to` and `text` works as today. That covers a message
  that answers nothing, such as "Running 10 minutes late, sorry".

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
  `save_preferences` does), or when it's longer than a `send_message` text
  (600 characters), since a saved answer is sent as one.
- There's no limit on how many are saved. Each save needs the host's yes, so
  the list only grows as fast as the host answers. Saving a topic that
  already exists replaces its answer, so the list doesn't fill with old
  copies.
- The assistant saves the host's words. It may cut the reply down to the
  sentence that answers the question, but it never rewrites it.

**How saved answers are used:**

- `check_now` returns `savedAnswers` (topic and answer) whenever any are
  saved, so the assistant can draft from them and answer "what have you
  saved?".
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

- `src/operator/confirmations.ts`: a book whose codes don't expire.
- `src/cleaner-core/liveDesk.ts`: `save_draft`, `draft` on `send_message`,
  `earlier`, `reply` and `drafts` on `check_now`, `savedAnswers`, and
  `save_answer`.
- `src/cleaner-core/mcp.ts`: the `save_draft`, `send_message`, and
  `save_answer` tool descriptions and the instructions.
- `cleaner-template/template.json`: `save_draft` joins both Grok routines'
  tools. It sends nothing, so a routine may hold it. `save_answer` needs the
  host's yes, so it doesn't.
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
| Draft needs Send | `save_draft` sends nothing, and no routine holds `send_message`. A draft goes out only with the code from the preview of its saved text. A draft the host never answers sends nothing. A draft and its code have no time limit; something new in the thread or a group change stops it. | `test/cleanerReplyDrafts.test.ts`, `test/cleanerTemplate.test.ts` |
| Group reply wins | After the host's group text, a draft for the message it answered is removed and refused with `alreadyAnswered`, and any other draft saved before it is refused with `newSince`. | `test/cleanerReplyDrafts.test.ts` |
| Group text acts on nothing | A host group text never holds, resumes, sets times, or releases the door code. | `test/cleanerReplyDrafts.test.ts` |
| Saved answers | A saved answer can't hold the door code. Saving and removing need the host's code. A saved answer is never sent by itself. | `test/cleanerSavedAnswers.test.ts` |

## 7. Testing and verification

- Unit tests on a 555 Scratch tenant, with a 555 host number:
  - `save_draft`, then preview and Send;
  - a draft and its code still send a day later, while a `send_message` code
    with `to` and `text` still expires after 10 minutes;
  - a draft survives a restart and sends with a new code;
  - `newSince` after a host group text, after a second cleaner text, and
    after a group change;
  - `alreadyAnswered`;
  - `earlier` and `reply` in `check_now`;
  - the host's own group text wakes the alert routine;
  - `save_answer`'s approval, the door-code refusal, the 600-character limit,
    and a repeated topic replacing its answer;
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

## Decided in review

1. A draft's approval has no time limit. Something new in the thread or a
   group change stops it, and a restart only means asking for a new code
   (section 2).
2. Everything in the text wakes the assistant, the host's own group replies
   included (section 3).
3. No limit on how many answers are saved. A repeated topic replaces its
   answer (section 4).
