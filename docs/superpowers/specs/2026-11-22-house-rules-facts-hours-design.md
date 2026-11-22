# One house rules list, facts learned as guests ask, and the host's own steps in the hours log (#15, #16, #18)

Three findings from Saad's end-to-end test as a new host on Grok (22 Nov).

| Finding | What Saad saw | What changes |
| --- | --- | --- |
| #15 | House rules were asked twice and kept twice: as a house fact ("No smoking, parties or pets") and as the nightly stay check's rules. | One list of house rules. |
| #16 | Setup asked seven fact topics in a row. | Setup asks only about house rules, and facts are learned as guests ask. |
| #18 | `review_hours` for November showed one owner row. | Owner rows for the host's own approvals and actions in the newer features. |

## Goals

- One house rules list. A camera check goes on a rule only after the host agrees to its read-back, exactly as #253 built it: rule text that looks like a door code is refused, and an allowed number is never raised. Every rule can be used to draft guest replies.
- Saved data moves over without losing anything.
- Setup asks about the house only with the rules question, starting with what the cameras can check. A guest's question that has no saved fact comes to the host, and the host's answer is kept for the next guest, with the host's okay.
- An owner row for each of the host's own approvals and actions in the newer features, each from that feature's own record of the host's yes. Nothing Property Core did on its own becomes an owner row.
- A month the host already confirmed keeps its rows and fingerprint.

## Non-goals

- Changing how a camera check works, or the nightly check itself (#253).
- Sending anything to a guest. The host still pastes each approved reply into Airbnb.
- Turning a feature switch on.
- Owner rows for Cleaner Core actions that keep no time of their own: hold, stand-down, resume, saved answers, pay settings. The Cleaner Core session (a declined cleaning moved to another day) adds host approvals. Their rows plug in the same way; see "For the other sessions".

## #15: one list of house rules

**The list is `stay-check.json`'s `rules`.** Each rule is the host's words, with a camera `check` only after the read-back (#253). `guest-facts.json` no longer keeps a `rules` fact.

- `save_guest_facts` no longer lists `rules` as a topic. A call with it is refused and pointed to `save_house_rules`. Nothing is written.
- `save_house_rules` takes `add`: one rule put at the end, with the same checks as a full list: it's refused when it looks like a door code (the refusal never repeats the number), and only one check of each kind is allowed. This is how a rule the host gives while answering a guest goes on the list.
- `read_guest_message` drafts from every rule:
  - All of them when the guest's words are about the rules (pets, smoking, parties, quiet, visitors, how many guests or cars).
  - One rule alone when it shares a word with the message, like "Two cars max" for "room for our two cars?".
  - Only the rule's text is returned, never its check.
- `get_guest_facts` returns `houseRules` beside the facts.

**Where it's listed.** The house rules tools are listed while either the account's Nightly stay check or Guest messages switch is on. `allow_for_stay` and `mark_flag_false` still need Nightly stay check. With Nightly stay check off, a rule can't carry a check ("save the rule as text only"), and the question leaves cameras out.

**Moving saved data (`src/house-rules/merge.ts`).** The first `get_house_rules`, `save_house_rules`, `get_guest_facts`, `save_guest_facts` or `read_guest_message` moves an older `rules` fact onto the list:

1. The fact is split into rules, in the host's words:
   - one rule per line, with list marks taken off;
   - a line over 200 characters split by its sentences;
   - only a sentence over 200 characters cut at a space.

   "No smoking, parties or pets" stays one rule.
2. A rule already on the list (the same words) isn't added twice. No check is ever added, because the host never agreed to a read-back for these rules.
3. The list is written first, then the fact is taken out of `guest-facts.json`. A crash between the two writes leaves both. The next call finds every rule already on the list and only takes the fact out.
4. The host's original save stays in `guest-facts.json`'s new `history`, so the hours log keeps that row.
5. `stay-check.json` gets `rulesMergedAt`, Property Core's mark. `rulesSavedAt` (the host's save) and the host-steps record are untouched.

A fact that can't move whole stays exactly where it was, and drafts still read it:

- a piece that looks like a door code by the house rules' own test;
- more than 20 rules in all;
- an unreadable `stay-check.json`.

A guest's "Max 4 guests" saved under `other` stays a fact. Nothing guesses which other facts are rules.

## #16: facts are learned as guests ask

- `get_guest_facts` no longer returns `ask`. Its `next` says facts are learned as guests ask, and that a fact the host gives on their own can be saved.
- When `read_guest_message` finds nothing saved for the guest's question, it returns `learn: { messageId, topics }`. Its `next` tells the agent three things:
  - Ask the host what to say.
  - Then ask whether to keep the answer for the next guest.
  - Only on the host's okay, call `save_guest_facts` with the topic, the host's words and that `messageId`. A rules question goes to `save_house_rules` with `add` instead.
- `save_guest_facts` takes `messageId`. It must be a message Property Core took, and it's kept in the save's `history` entry as `learnedFrom`.
- **The setup step.** `get_house_rules` with no rules returns `ask`, the rules question.
  - It starts with what the cameras can check (how many guests, pets, how many cars, quiet hours), then asks whether there's any other rule.
  - It suggests no rule the host didn't give.
  - `rulesAsk({ checks, guestReplies })` builds it. The setup session's house rules offer calls `get_house_rules` and asks this.
- **Instructions.** Updated in four places:
  - the hosted `initialize` guest line (`GUEST_MESSAGES_INSTRUCTION`);
  - `CLEANER_CORE_BOOTSTRAP.md`;
  - the Property Core Muse skill;
  - the Claude skill and the Grok bot profile (a short "Guests and house rules" section, only when the tools are listed).

Nothing reaches a guest without the host's yes, and no guest is ever texted. That's unchanged.

## #18: the host's own steps in the hours log

### Where each row comes from

Each row comes from the feature's own record of the host's yes, written in the same call after its own save.

| Row kind | Task, for example | Record |
| --- | --- | --- |
| `approve-text` | Approved a text to the cleaner | Visit log: an outgoing `message` labelled `host-message`, which only `send_message` writes after the host's code |
| `approve-guest-reply` | Approved a reply to a guest's message | `guest-messages.jsonl` `reply-approved` |
| `allow-late-checkout` | Allowed a late checkout until 13:00 on … | `guest-messages.jsonl` `late-checkout` |
| `house-facts` | Saved the wifi house fact / Answered a guest's question and kept it as the wifi fact | `guest-facts.json` `history` (new), and each saved fact's own `savedAt` |
| `house-rules` | Saved the house rules (3 rules); Set the nightly check time to 22:30 | `host-steps.jsonl` (new), and `stay-check.json` `rulesSavedAt` |
| `lock-setup` | Connected the locks (Front door) and approved them …; Approved how door codes go out | `host-steps.jsonl`, and `door-locks.json` `activeAt` |
| `standing-code` | Approved a standing code for Robin | `host-steps.jsonl`, and the person's `addedAt` / `removedAt` |
| `guest-codes` | Chose how guest door codes work: ask first | `host-steps.jsonl`, and `guest-codes.json` `modeAt`, a lease's `addedAt` / `removedAt` |
| `expected-visit` | Logged an expected visit: Pat on 2026-11-24 | `oversight.json` `savedAt` / `cancelledAt` |
| `approve-booking-email` | Approved a booking from Vrbo, … | `booking-emails.jsonl`, only lines with `hostConfirmed: true` or `called-off` |
| `save-upkeep` | Saved the upkeep schedule: Clean the gutters | `host-steps.jsonl` |
| `setup` | Turned on Cleaner Core for the property / Activated Fixer Core | the account's `service-audit.jsonl` (`actor: "host"`, `on: true`, this property only); Fixer Core's and Supply Core's `activatedAt`; `host-steps.jsonl` for Cleaner Core's first Activate |

### The new record: `host-steps.jsonl`

This record (`src/hours-log/hostSteps.ts`) is for features whose own record is overwritten or keeps no time:

- lock settings, locks on and off, and standing codes;
- guest-code choices, codes, links and leases;
- house rules saves and adds, the check time, a stay's allowance and a false flag;
- upkeep saves and removals;
- Cleaner Core's first Activate.

How it's written and read:

- **Appended only after the save.** The line goes in after the feature's own save succeeded, so a question, a stale code or a refusal writes nothing.
- **Append-only.** Each line is one JSON object, and a torn line is skipped.
- **No codes or phones.** Lines hold a name and an id, never a phone or a code. Any text with four or more digits in a row (dates and clock times aside) is left out of the line.
- **A failure doesn't block the host.** A failed write never undoes or blocks the host's action. It loses only that row.

We considered one shared approach for every feature, as #258 did, but the locks and guest-code desks are being changed in another session. One append right after each save is the smallest additive change there.

### Steps saved before #18

A record from before #18, such as `activeAt`, `addedAt`, `modeAt` or `rulesSavedAt`, gives the same kind, reference and time as the step that now accompanies it. `rawFacts` keeps one of the two, so one action is one row.

### Never the system's work

None of these produce an owner row:

- the lock partner's disconnect;
- the `yesAt` Property Core stamps when guest codes go from automatic to ask;
- an Airbnb email its own reader applied;
- a guest message it took or refused;
- a skipped reply;
- an expected visit it flagged;
- rules it moved (`rulesMergedAt`);
- its own texts (offers, reminders);
- an admin turning a flow on.

`ownerRules.ts` keeps routing anything else away from the owner log. The tests extend the existing "the system never writes owner time for its own work" check.

### Setup is one switch

Whether setup and onboarding time counts toward the owner's hours is a tax question. `setup` is its own row kind, and `KINDS_OFF` in `ownerRules.ts` leaves a kind out of every log. It ships empty (setup rows on), as 0-hour rows until the host saves minutes for `SET-1`. **Saad to confirm the default.** Changing `KINDS_OFF` changes months' rows, so bump `OWNER_RULES_VERSION` with it.

### Codes

New placeholder codes, each with its own minutes (unset is 0, so each kind's first row asks how long it usually takes; this is by design):

| Code | Activity |
| --- | --- |
| `CLN-3` | Approve a text to the cleaner |
| `GST-1` | Approve a guest reply or late checkout |
| `GST-2` | House rules and house facts |
| `GST-3` | Approve a booking or a cancellation |
| `ACC-1` | Lock settings and door codes |
| `ACC-2` | Expected visits |
| `REP-4` | Upkeep schedule |
| `SET-1` | Setup and onboarding |

### A confirmed month keeps its fingerprint

The new rows would otherwise change a month confirmed before #18 that holds any of these records, for example Fixer Core's Activate in an earlier month.

- `MonthMark.kindSet` records the set of row kinds a month was confirmed with (`ROW_KIND_SET = 2`).
- A mark without it was confirmed before #18. That month is built with the kinds it had (`V1_ROW_KINDS`), so its rows and fingerprint are exactly as confirmed and it still exports.
- A month confirmed again keeps its first set. A new confirmation gets every kind.

`OWNER_RULES_VERSION` stays 1, because no rule for an existing row changed. **Saad to confirm.** A bump would instead make every confirmed month be reviewed again, with the new rows in it.

## For the other sessions

- **Setup wording and offers.** The house rules offer calls `get_house_rules` and asks its `ask` (`rulesAsk`). That question is the only one setup asks about the house.
- **Cleaner Core, a declined cleaning moved to another day.** Record the host's yes with `recordHostStep(root, { at, kind, about, ref })` right after the engine's own save. Add the kind to `HOST_STEP_KINDS`, give it a task in `stepFact` (`src/hours-log/hostSources.ts`), and give it a row kind and code. Alternatively, keep it on the engine's own record, as `clearedHostFacts` does, and read it in `readRecords`.
- **Standing codes (`src/locks/`).** This change adds only a `recordHostStep` line after each save in `addStanding`, `removeStanding`, `newLink`, `saveLocks` and `settings`. Keep those lines when you rebase.
