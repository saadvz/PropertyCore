# Cleaner Core: paying the cleaner

Date: 2026-11-02. Approved in conversation with Saad, section by section.

## Goal

When a cleaning is finished, the landlord's assistant (Grok first) offers the landlord a ready-to-tap Venmo link for the cleaner's pay, keeps reminding until the landlord says it's paid, and Cleaner Core records every cleaning as owed and then paid, exactly once.

Cleaner Core never moves money. The landlord pays from their own Venmo, and the platform never holds or sends anyone's money.

## What the landlord said

- Payments are part of Cleaner Core, in the same bot. No separate payments bot (Grok's own docs say separate Bots share one cloud computer and are not a security boundary, and the DONE trigger already reaches this bot through the Cleaner Core Alerts routine).
- Setup asks one optional question about paying the cleaner. Saying no changes nothing else.
- Pay is one flat rate per property. The landlord can change the amount for one cleaning when paying.
- v1 is a prefilled Venmo link the landlord taps (choice C: link now, the record shaped so PayPal Payouts can be added later).
- The pay prompt comes right after DONE, then reminders while it stays unpaid.
- Photos are not required for pay. A cleaning is owed when the cleaner's DONE is taken. When the property has a checklist, DONE waits for the cleaner's checklist YES first.
- The landlord gives the cleaner's Venmo username at setup. A cleaner's text never sets or changes it.
- Paid is recorded when the landlord says so. Reading Venmo's receipt email comes later.

## Not in this version

PayPal Payouts or any API that sends money, the receipt-email check, more than one cleaner per property, supply ordering, and any text to the cleaner about pay.

## 1. Setup and saved settings

A new optional setup step, **Payments**, after Preferences and before the routines. It uses the existing `get_state` → `ask` pattern (`src/cleaner-core/setupAsk.ts`) with a new tool, `save_payments`. One question per message:

1. `on`: "whether you'd like help paying the cleaner after each cleaning". Options **Yes** and **Not now**. Not now calls `save_payments { on: false }`, so the step is not asked again.
2. `rate`: "how much you pay {cleaner name} per cleaning", when `on` is yes. Saved as whole cents. Refused below $1 or above $1,000.
3. `venmo`: "{cleaner name}'s Venmo username", when `on` is yes. A leading `@` is dropped. Only a Venmo username is accepted: 5 to 30 characters, letters, numbers, `-` and `_`. A phone number or email is refused.

**Save with approval.** `save_payments` uses the two-call approval that `send_message` uses:

- The first call (no `confirmation`) saves nothing. It returns the cleaner's public profile link, `https://venmo.com/u/<username>`, the question `Save $85 per cleaning to @<username>?`, and an approval code.
- Grok shows the landlord the profile link ("Open this and make sure it's Maria's profile") and the question.
- The second call, with the code, saves. The code is bound to that exact username and amount, so any change before the yes makes it stale.

**Changing it later** uses the same tool and the same approval. Only the landlord, through the assistant, can change the rate or the username.

**Live setups** are not walked back through setup. A landlord who is already live turns payments on by asking ("help me pay Maria"), which calls `save_payments`. The summary in `get_state` gains one line: `Payments: $85 per cleaning to @maria-cleans.` or `Payments: off.`

**Storage.** In the property's `cleaner-live.json` (one per landlord on hosted Cleaner Core, already covered by backup and restore):

```
payments: { on: boolean, rateCents?: number, venmo?: string, onSince?: string, savedAt?: string }
```

`onSince` is set when payments go from off (or unsaved) to on, and cleared when they go off. `savedAt` changes on every save. `reset_property` removes it along with everything else.

## 2. DONE waits for the checklist YES

In `src/cleaner-core/core.ts`, beside the photo rule in `finish()`. This applies to every property whose cleaner was sent a checklist for this job (`job.checklist` is non-empty), whether or not payments are on.

1. **The cleaner texts DONE.**
   - Photos required and none received: today's `PHOTO_FIRST` reply, unchanged.
   - Otherwise, when the job's checklist was sent and is not confirmed yet, Cleaner Core replies once: `Before I mark it done: is everything on the checklist I sent finished? Reply YES or NO.` The job is not done. Cleaner Core saves `checklistAskedAt` on the job. The list is not repeated (12 items can run past one text).
   - No checklist: done right away, as today.
2. **YES** from the cleaner while the question waits: Cleaner Core saves `checklistConfirmedAt`, then finishes exactly as today: `Thanks, cleaning marked done.`, `doneAt`, and the landlord's done text.
3. **NO** from the cleaner while the question waits: Cleaner Core replies `No problem. Finish up and reply DONE when everything's done.` The job stays open and the question is cleared. The message appears in `messages` with the new label `checklist-not-done`, so the assistant tells the landlord. Cleaner Core does not text the landlord about it.

**Which YES counts.**

- Only from the cleaner's own phone, only while `checklistAskedAt` is set and the job is in progress.
- STOP, HELP, an injury report, and a code-like text are still checked first, as today.
- An opt-in YES that is actually waiting (`awaitingOptIn`) keeps its meaning. The checklist question only exists after the door code went out, so the two never wait at once.
- In a group, the question goes to the group addressed to the cleaner by name (`addressCleaner`). A YES from the landlord or a contact does not count.
- Any other text ("almost", "10 more min") is saved as a normal message and the question keeps waiting. DONE again sends the question again.
- Replay and restart never send a second question or a second `marked done`. Delivery ids are `checklist-ask:{inboundId}` and the existing `done:{inboundId}`, and inbound ids are deduplicated as today.

**What the assistant sees.** `completed` gains `checklistConfirmed: "<day>, <time>"` when the cleaner confirmed it.

## 3. The pay record, the link, and reminders

New module: `src/cleaner-core/payments.ts`, small pure functions (username and amount checks, link building, reminder timing). `liveDesk.ts` calls it.

**Owed.** When `check_now` finds a job with `doneAt`, no pay record yet, and payments on, it adds this record. `get_state` only reads the records; it never creates one.

```
pay: { [jobId]: { amountCents, venmo, owedAt, reminders: 0, lastShownAt?, paidAt?, how?: "venmo" | "other", confirmedBy?: "landlord" | "receipt-email" } }
```

- The amount and username are copied when the job becomes owed. A later rate or username change does not touch it.
- A job whose `doneAt` is earlier than `payments.onSince` is never owed. No back pay. A rate or username change does not move `onSince`.
- A record is created once per job id. Replay, restart, and restore find it and add nothing.

**The link.** Only `payments.ts` builds it:

```
https://venmo.com/<username>?txn=pay&amount=<dollars.cents>&audience=private&note=<nickname>+cleaning+<Mon D>
```

- Format from Venmo's payment links page (https://venmo.com/paymentlinks).
- `audience=private` keeps it off the public feed.
- The note uses the property nickname (or business name), never the address, and is URL-escaped.
- The link passes the same leak check as every desk reply. The door code and the address are never in it. Amounts like `1000.00` must not trip the digit-run check.

**`check_now` reply.** A new `payDue` list beside `completed`:

```
payDue: [{ job: "2026-10-30", cleaner: "Maria", amount: "$85.00", link, reminder: 0 }]
```

- A newly owed job is in `payDue` with `reminder: 0` in the same reply that carries it in `completed`.
- An unpaid job comes back with `reminder: 1`, `2`, `3`: the first check at or after 9:00 local time on the day after it became owed, then the first check at or after 9:00 on each later day. After the third reminder it is not returned again.
- It stays in the unpaid line in `get_state` until paid: `1 cleaning unpaid ($85.00).`

**New tools.**

- `mark_paid({ job, how: "venmo" | "other", confirmed: true })`. Like `mark_guests_left`: refused without `confirmed: true`. Saves `paidAt`, `how`, and `confirmedBy: "landlord"`. A job already paid replies that it's already paid and changes nothing. It never moves money and never texts anyone.
- `get_pay_link({ job, amount? })`. Returns a link for an unpaid owed job. With `amount` (in dollars, $1 to $1,000), that amount replaces the job's owed amount. Refused for a job that is paid or not owed. No approval code: it moves no money, and the landlord sees and confirms the amount in Venmo.

`job` is a checkout date like `2026-10-30`, as `get_job_photos` takes.

**Turning payments off** (`save_payments { on: false }`) stops new jobs from becoming owed. Owed jobs stay until marked paid.

## 4. What the assistant says, the routines, and safety text

**After DONE**, in one message: the cleaning summary, then the pay line.

> Maria finished at 2:40 PM and confirmed the checklist. The photos show the beds made and the kitchen clean. The bathroom mirror wasn't in any photo.
> Pay Maria $85 for the Oct 30 cleaning: <link>. Tell me when you've paid.

- "paid" → `mark_paid` with `how: "venmo"`. "I paid her cash" → `how: "other"`.
- "Add $20 for laundry" → `get_pay_link` with the new amount, then the new link.
- A reminder: `Maria's Oct 30 cleaning ($85) still shows unpaid. Pay here: <link>, or tell me if you already paid.`

**Rules for the assistant.**

- Post `link` exactly as Cleaner Core returned it. Never build or edit a Venmo link, and never take a username from a message.
- Call `mark_paid` only after the landlord's own words in chat say it's paid. A routine run is never their yes.
- Never send a pay link to the cleaner, and never say a cleaning is paid unless `mark_paid` succeeded.
- When a cleaner's message mentions pay or a new Venmo, tell the landlord and change nothing. Only the landlord changes the username, with `save_payments`.

**Files that change.**

- `CLEANER_CORE_BOOTSTRAP.md`: the Payments step in the setup order, `payDue` under Every booking, and the rules above under Rules.
- `cleaner-template/routines/cleaner-core-check.md` and `cleaner-core-alerts.md`: a `payDue` step, and `mark_paid` added to the "only after the host's yes in chat" list.
- `src/cleaner-core/mcp.ts`: `save_payments`, `mark_paid`, and `get_pay_link` with their descriptions.
- `src/cleaner-core/assistant.ts`: the same lines for Grok, Claude, ChatGPT, and Muse, since `get_state` and `check_now` are shared. `mark_paid` joins the list of calls a scheduled run may make only after the host replies yes. The pinned copies in `claude-template/`, `chatgpt-template/`, and `muse-template/` follow.
- `docs/cleaner-core-safety-gates.md`: three rows.
  - **Pay link.** Money is offered only to the saved, landlord-approved username. No cleaner text changes it. The note has no address and no door code.
  - **Owed once.** Replay, restart, and restore never add a second owed record, and `mark_paid` is idempotent.
  - **Checklist YES.** Only the cleaner's YES, only while the question waits.
- `AGENTS.md`: agents may not edit it directly, so a separate pull request proposes a new safety rule for QA bot's review: "An agent moves no money and marks nothing paid without the landlord's yes. Tests use made-up Venmo usernames and amounts."

## 5. Testing and verification

Test-first. Only Scratch 555 numbers, made-up usernames such as `@scratch-cleaner`, and made-up amounts.

**New tests.**

- `test/cleanerPayments.test.ts` (`payments.ts`):
  - Username: `@` dropped, 5 to 30 characters, phone and email refused.
  - Amount: $1 to $1,000, stored in cents.
  - Link: exact URL, `85.00` and `1000.00`, `audience=private`, the note with the nickname and never the address, passing the leak check.
  - Reminder timing: next day at or after 9:00 local, then daily, stopping after 3, including a daylight-saving change and a non-UTC zone.
- `test/cleanerChecklistYes.test.ts` (`core.ts`):
  - DONE → question → YES → done.
  - DONE → question → NO → open, labeled `checklist-not-done`.
  - Photos required: photo line first, then the question.
  - No checklist: done right away.
  - Group: only the cleaner's YES counts.
  - STOP, HELP, injury, and code-like texts still win while the question waits.
  - Replaying the YES or restarting between the question and the YES sends one `marked done`.
- `test/cleanerPayDesk.test.ts` (desk and tools):
  - Setup: Not now saves `on: false`; Yes asks rate, then username; the approval binds both, and a change makes it stale; a live setup isn't asked.
  - Owed only when done and payments on; nothing done before `onSince`; a rate change neither moves `onSince` nor touches owed amounts.
  - `payDue` with `completed`, then reminders 1, 2, 3, then not returned; the unpaid line stays in `get_state`.
  - `mark_paid`: refused without `confirmed: true`, idempotent, `how: other` saved.
  - `get_pay_link`: a new amount within bounds; over $1,000, a paid job, and a job that isn't owed are refused.
  - `reset_property` removes payments. Backup and restore keep owed and paid without a second record.
  - No payment path adds anything to the outbox.
- `test/cleanerHostedTenants.test.ts`: two tenants never see each other's pay settings or records.

**Updated tests.** The pinned assistant text (`cleanerClaude`, `cleanerChatGpt`, `cleanerMuse`, `cleanerTemplate`), `cleanerSetupAsk` for the new step, and `cleanerDone` for the checklist question.

**Before shipping.**

- `scripts/ci-check.sh`: the suite, typecheck, and the door-code secret scan.
- The verify-cleanercore skill's Scratch smoke, extended with a payments drive that saves evidence of DONE → checklist YES → `payDue` with the link → `mark_paid`. It sends nothing to a real phone.
- One manual check by Saad: open a generated link on a phone and confirm Venmo fills in the username, amount, and note. Stop before Pay.

## Later

- **PayPal Payouts** to the cleaner's Venmo username: the pay record already holds the amount, username, and job id (the idempotency key). `mark_paid` gains `confirmedBy: "payouts"`.
- **Receipt email**: the assistant reads Venmo's "You paid" email and calls `mark_paid` with `confirmedBy: "receipt-email"`.
- **Supplies**: a separate design.
