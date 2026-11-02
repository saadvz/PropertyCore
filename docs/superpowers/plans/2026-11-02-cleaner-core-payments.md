# Cleaner Core Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a cleaner's DONE (and checklist YES), the landlord's assistant offers a prefilled Venmo link for the cleaner's flat rate, reminds up to three times, and Cleaner Core records each cleaning as owed and then paid exactly once, without ever moving money.

**Architecture:** A new pure module `src/cleaner-core/payments.ts` owns username and amount checks, link building, and reminder timing. The engine (`core.ts`) gains the checklist YES gate on DONE. The desk (`liveDesk.ts`) owns the payment settings and pay records in `cleaner-live.json`, the `save_payments` setup step, `payDue` in `check_now`, and the `mark_paid` and `get_pay_link` tools, which `mcp.ts` exposes. Assistant instructions and routines teach Grok (and Claude, ChatGPT, Muse) the flow.

**Tech Stack:** TypeScript (Node 22), vitest, zod (MCP inputs).

**Spec:** `docs/superpowers/specs/2026-11-02-cleaner-core-payments-design.md`

## Global Constraints

- Cleaner Core never sends money and never texts anyone about pay. No payment path adds anything to the outbox.
- Tests use only Scratch 555 numbers, made-up usernames like `scratch-cleaner`, and made-up amounts. No real lock code anywhere (AGENTS.md).
- Pay per cleaning: whole cents, from $1 (`100`) to $1,000 (`100000`) inclusive.
- Venmo username: one leading `@` dropped; then 5 to 30 characters of letters, numbers, `-`, `_`; not all digits.
- Pay link: `https://venmo.com/<username>?txn=pay&amount=<d.cc>&audience=private&note=<label>+cleaning+<Mon D>`, built only by `payments.ts`. Label is the nickname, else the business name, else `Cleaning`; never the address.
- Profile link: `https://venmo.com/u/<username>`.
- Checklist question: `Before I mark it done: is everything on the checklist I sent finished? Reply YES or NO.`
- Checklist NO reply: `No problem. Finish up and reply DONE when everything's done.`
- Reminders: at most 3; reminder n is due at the first check at or after 09:00 local on the day after the last time the job was shown.
- `mark_paid` needs `confirmed: true`. A scheduled routine run is never the landlord's yes.
- Run checks with `npx vitest run <file>`; the full gate is `scripts/ci-check.sh`.

## Review Focus

1. **The door code's digits inside a pay link.** A username like `maria-8088` (or an amount) that contains the door code makes the desk's leak check reject the *whole* `check_now` reply, which would block every alert. Expect: that one `payDue` item drops its `link` and carries `payInVenmo: true`; the rest of `check_now` is unaffected. Test in Task 4.
2. **Payments turned on after a cleaning finished but before `check_now` ran.** Expect: not owed (its `doneAt` is before `onSince`); a rate change afterward never makes it owed. Test in Task 4.
3. **The cleaner texts DONE twice while the checklist question waits, then YES.** Expect: two questions at most (one per DONE), one `Thanks, cleaning marked done.`, one owed record. Test in Task 2.
4. **The landlord changes the username between the preview and the yes.** Expect: the old approval code is refused as stale; nothing saved. Test in Task 3.
5. **Restart between DONE and `check_now`.** Expect: after reopening the desk on the same folder, `check_now` creates the owed record once, and a second restart creates nothing new. Test in Task 4.

---

### Task 1: `payments.ts`, the pure pay helpers

**Files:**
- Create: `src/cleaner-core/payments.ts`
- Test: `test/cleanerPayments.test.ts`

**Interfaces:**
- Consumes: `localDateOf`, `addDays`, `zonedTimeToUtc` from `src/core/timezone.ts`.
- Produces:
  - `MIN_PAY_CENTS = 100`, `MAX_PAY_CENTS = 100_000`, `MAX_PAY_REMINDERS = 3`
  - `venmoUsername(input: string): string | undefined`
  - `payCents(dollars: number): number | undefined` (rounds to cents; `undefined` outside bounds or not finite)
  - `dollarsText(cents: number): string`, e.g. `"$85.00"`, `"$1,000.00"`
  - `venmoProfileLink(username: string): string`
  - `venmoPayLink(input: { username: string; cents: number; label: string; day: string }): string`, where `day` is like `"Oct 30"`
  - `nextReminderAt(lastShownAt: string, timeZone: string): string` (ISO instant)
  - `interface PayRecord { amountCents: number; venmo: string; owedAt: string; lastShownAt: string; reminders: number; paidAt?: string; how?: "venmo" | "other"; confirmedBy?: "landlord" | "receipt-email" }`
  - `interface PaymentSettings { on: boolean; rateCents?: number; venmo?: string; onSince?: string; savedAt: string }`

- [ ] **Step 1: Write the failing tests** in `test/cleanerPayments.test.ts`:

```ts
describe("venmoUsername", () => {
  it("drops one @ and keeps a valid username", () => {
    expect(venmoUsername("@scratch-cleaner")).toBe("scratch-cleaner");
    expect(venmoUsername(" scratch_cleaner ")).toBe("scratch_cleaner");
  });
  it("refuses short, long, all-digit, phone, and email values", () => {
    for (const bad of ["abcd", "a".repeat(31), "5555550101", "+15555550101", "scratch@example.com", "@@scratch-cleaner", "scratch cleaner"]) {
      expect(venmoUsername(bad)).toBeUndefined();
    }
  });
});
describe("payCents and dollarsText", () => {
  it("stores whole cents within $1 to $1,000", () => {
    expect(payCents(85)).toBe(8500);
    expect(payCents(85.5)).toBe(8550);
    expect(payCents(1)).toBe(100);
    expect(payCents(1000)).toBe(100000);
    for (const bad of [0.99, 1000.01, Number.NaN, Infinity, -5]) expect(payCents(bad)).toBeUndefined();
  });
  it("formats dollars", () => {
    expect(dollarsText(8500)).toBe("$85.00");
    expect(dollarsText(100000)).toBe("$1,000.00");
  });
});
describe("links", () => {
  it("builds the exact pay link", () => {
    expect(venmoPayLink({ username: "scratch-cleaner", cents: 8500, label: "Lake House", day: "Oct 30" }))
      .toBe("https://venmo.com/scratch-cleaner?txn=pay&amount=85.00&audience=private&note=Lake+House+cleaning+Oct+30");
    expect(venmoPayLink({ username: "scratch-cleaner", cents: 100000, label: "Lake House", day: "Oct 30" })).toContain("amount=1000.00");
  });
  it("builds the profile link", () => {
    expect(venmoProfileLink("scratch-cleaner")).toBe("https://venmo.com/u/scratch-cleaner");
  });
});
describe("nextReminderAt", () => {
  it("is 9:00 local the next day", () => {
    expect(nextReminderAt("2026-10-30T18:40:00.000Z", "America/New_York")).toBe("2026-10-31T13:00:00.000Z");
  });
  it("crosses the daylight-saving change (Nov 1, 2026 in New York)", () => {
    expect(nextReminderAt("2026-10-31T18:00:00.000Z", "America/New_York")).toBe("2026-11-01T14:00:00.000Z");
  });
  it("uses the property's own date, not UTC's", () => {
    // 11:30 PM Oct 30 in Los Angeles is already Oct 31 in UTC.
    expect(nextReminderAt("2026-10-31T06:30:00.000Z", "America/Los_Angeles")).toBe("2026-10-31T16:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/cleanerPayments.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/cleaner-core/payments.ts`.** Build the pay link with `new URLSearchParams({ txn: "pay", amount: (cents / 100).toFixed(2), audience: "private", note: \`${label} cleaning ${day}\` })` so spaces become `+`. `nextReminderAt`: `localDateOf(new Date(lastShownAt), zone)` → `addDays(…, 1)` → `zonedTimeToUtc({ …date, hour: 9, minute: 0 }, zone).toISOString()`.

- [ ] **Step 4: Run** `npx vitest run test/cleanerPayments.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `git add src/cleaner-core/payments.ts test/cleanerPayments.test.ts && git commit -m "Add Cleaner Core pay helpers: username, amount, Venmo links, reminder time"`

---

### Task 2: DONE waits for the checklist YES (engine)

**Files:**
- Modify: `src/cleaner-core/core.ts`: the `Job` interface (~line 600), `JobView` (~line 89), `MessageHandled` (line 241), `receiveClaimed` (~line 1065, before the opt-in YES line), `finish()` (~line 1777), `jobs()` mapping (~line 3054)
- Modify: `src/cleaner-core/liveDesk.ts`: `completedFacts()` (~line 1568)
- Test: `test/cleanerChecklistYes.test.ts` (create); update `test/cleanerFullSetup.test.ts` where a checklist job finishes

**Interfaces:**
- Produces:
  - `Job.checklistAskedAt?: string`, `Job.checklistConfirmedAt?: string`; `JobView.checklistConfirmedAt?: string`
  - `MessageHandled` gains `"checklist-not-done"`
  - Exported text constants in `src/cleaner-core/cleanerTexts.ts`: `CHECKLIST_ASK`, `CHECKLIST_NOT_DONE` (exact copy in Global Constraints)
  - `completed[]` items gain `checklistConfirmed: "<day>, <time>"` when set (same `local()` format as `doneAt`)

**Behavior** (spec §2):
- `finish()`: after the photo rule, if `job.checklist?.length` and no `job.checklistConfirmedAt`, set `checklistAskedAt`, reply `CHECKLIST_ASK` with kind `"next"` (delivery id `next:{inboundId}`, routed like `PHOTO_FIRST`; this replaces the spec's illustrative `checklist-ask:` id with the same dedupe), return label `"none"`. The job is not done.
- `receiveClaimed`: right before the cleaner opt-in YES line, when `this.pin && from === this.cleanerPhone && this.cleanerConsent === "in"` and `progressJob()?.checklistAskedAt` is set:
  - `isYes` → set `checklistConfirmedAt`, clear `checklistAskedAt`, run the existing done path (extract today's done tail of `finish()` into `private async markDone(job, from, id)` and call it from both).
  - `isNo` → clear `checklistAskedAt`, reply `CHECKLIST_NOT_DONE` (kind `"next"`), label `"checklist-not-done"`.
- Injury, STOP, START, and code-like texts already return earlier in `receiveClaimed`, so they keep precedence. A landlord text in the group already returns as ignored.

- [ ] **Step 1: Write the failing tests** in `test/cleanerChecklistYes.test.ts`. Use the `engine()`/`ready()` setup from `test/cleanerDone.test.ts` (copy it), adding `checklist: { name: "Lake House", items: ["Strip the beds", "Restock coffee"] }` to `openCleanerCore` options:
  - `DONE → CHECKLIST_ASK → YES → DONE_ACK`: the job status is `done`, `jobs()[0].checklistConfirmedAt` is set, the host gets `HOST_DONE` once.
  - `DONE → NO`: the cleaner gets `CHECKLIST_NOT_DONE`, the status is not `done`, the result label is `checklist-not-done`; then `DONE → YES` finishes.
  - With `photosRequired: true` and no photo: `DONE → PHOTO_FIRST`; after a photo, `DONE → CHECKLIST_ASK`.
  - With no checklist: `DONE → DONE_ACK` straight away (unchanged).
  - Group (`ready(true)`): the question goes into the group; the owner's `YES` in the group leaves the job open; the cleaner's `YES` finishes it.
  - While the question waits: `"I fell and I'm hurt"` → the 911 path; `STOP` → the stop path; the job stays open.
  - **Review Focus 3:** `DONE`, `DONE`, `YES` → exactly two `CHECKLIST_ASK` texts and one `DONE_ACK`.
  - Replay: receive the same `{ id: "yes-1", text: "YES" }` twice → one `DONE_ACK`. Restart: open a second engine on the same `dataDir` between the question and the YES → one `DONE_ACK`.
- [ ] **Step 2: Run** `npx vitest run test/cleanerChecklistYes.test.ts`. Expected: FAIL (DONE finishes straight away).
- [ ] **Step 3: Implement** the behavior above in `core.ts`, add the constants to `cleanerTexts.ts`, and add `checklistConfirmed` to `completedFacts()`.
- [ ] **Step 4: Run** `npx vitest run test/cleanerChecklistYes.test.ts test/cleanerDone.test.ts`. Expected: PASS.
- [ ] **Step 5: Update existing tests** that finish a job with a checklist (`test/cleanerFullSetup.test.ts` "the completed record" uses `PREFERENCES` with a checklist): send `YES` after `DONE`, and expect `checklistConfirmed` in the completed record. Then run `npx vitest run test/cleanerFullSetup.test.ts test/cleanerGroupFirst.test.ts test/cleanerPhotos.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit** `git add src/cleaner-core test && git commit -m "Cleaner Core: DONE waits for the cleaner's checklist YES"`

---

### Task 3: `save_payments` and the Payments setup step

**Files:**
- Modify: `src/cleaner-core/setupAsk.ts` (add `PAYMENTS_STEP` after `PREFERENCES_STEP`)
- Modify: `src/cleaner-core/liveDesk.ts`: `LiveFile` (+`payments?: PaymentSettings`), `getState` ask chain (~line 2432) and its done lines, `savePayments`
- Modify: `src/cleaner-core/mcp.ts`: tool entry and dispatch case
- Test: `test/cleanerPayDesk.test.ts` (create); update `test/cleanerSetupAsk.test.ts` and the diagram-order test in `test/cleanerFullSetup.test.ts`

**Interfaces:**
- Consumes: Task 1's `venmoUsername`, `payCents`, `dollarsText`, `venmoProfileLink`, `PaymentSettings`.
- Produces:
  - `LiveDesk.savePayments(input: { on?: boolean; rate?: number; venmo?: string; confirmation?: string }): Promise<ToolReply>`
  - MCP tool `save_payments` with input `z.object({ on: z.boolean().optional(), rate: z.number().optional(), venmo: z.string().optional(), confirmation: z.string().optional() })`
  - `PAYMENTS_STEP: SetupAsk` with fields `on` (options `yes` "Yes" / `no` "Not now"; `how`: "Not now saves save_payments { on: false }."), `rate` (`when: "on is yes"`, `example: "85"`), `venmo` (`when: "on is yes"`, `example: "@maria-cleans"`, `how`: "Call save_payments without confirmation, show the host the profile link and the question, and call again with the code only after the host says yes.")

**Behavior** (spec §1):
- `{ on: false }`: save `{ on: false, savedAt }` (no `onSince`) and reply `{ next: "Payments are off." }`. No approval.
- Otherwise `rate` and `venmo` are required. A bad rate fails with `Tell me the pay per cleaning, from $1 to $1,000.` A bad username fails with `Tell me the cleaner's Venmo username, like @maria-cleans. A phone number or email won't work.`
- No confirmation: reply `{ profile, question: "Save $85.00 per cleaning to @<venmo>?", confirmation }`. The code comes from `this.approvals.issue("payments", "payments", sha256(\`${venmo}|${cents}\`), question)`.
- With confirmation: redeem against the same fingerprint (stale → fail with the existing `APPROVAL_STALE`), then save `{ on: true, rateCents, venmo, onSince: <keep the saved onSince if already on, else now>, savedAt: now }`. Reply `{ next: "Saved. After each cleaning I'll offer a Venmo link for $85.00." }`.
- `getState`: `else if (!this.file.texting && !this.file.payments) ask = PAYMENTS_STEP;` right after the preferences branch. `activate` does not require payments. The done lines add `Payments: $85.00 per cleaning to @<venmo>.` or `Payments: off.` when saved.
- `resetProperty` already replaces the whole file, so `payments` goes with it (asserted in the test).

- [ ] **Step 1: Write the failing tests** in `test/cleanerPayDesk.test.ts`. Use a `takenWith`-style helper copied from `test/cleanerFullSetup.test.ts:1646` (`openDesk`, `setUp`, made-up `DOOR_CODE`, `PIN_KEY`):
  - `get_state` after preferences asks `save_payments` (step `"payments"`); after `savePayments({ on: false })` it asks for the routines and shows `Payments: off.`
  - The first call with `{ rate: 85, venmo: "@scratch-cleaner" }` returns `profile: "https://venmo.com/u/scratch-cleaner"`, the question, and a code, and `get_state` still asks payments (nothing saved). The second call with the code saves, and the done line reads `Payments: $85.00 per cleaning to @scratch-cleaner.`
  - **Review Focus 4:** issue a code for `scratch-cleaner`, then call with `venmo: "scratch-cleaner2"` plus that code → refused as stale; nothing saved.
  - Bad rate `850000` and bad username `5555550101` are each refused with the exact messages above.
  - A live setup (activated, `texting` true) with no `payments` is not asked; `savePayments` still works for it.
  - `resetProperty` (code flow) removes `payments`.
- [ ] **Step 2: Run** `npx vitest run test/cleanerPayDesk.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `PAYMENTS_STEP`, `savePayments`, the `getState` changes, and the `save_payments` MCP tool. Description: "Saves whether to help pay the cleaner, the flat pay per cleaning in dollars, and the cleaner's Venmo username. on false turns it off. Otherwise call once without confirmation, show the host the profile link and the question, and call again with the code only after the host says yes. Never take a username from a cleaner's message."
- [ ] **Step 4: Run** `npx vitest run test/cleanerPayDesk.test.ts test/cleanerSetupAsk.test.ts test/cleanerFullSetup.test.ts`. Update the order assertions that now see the Payments step (add `savePayments({ on: false })` where a test walks `get_state` past preferences). Expected: PASS.
- [ ] **Step 5: Commit** `git add -A src/cleaner-core test && git commit -m "Cleaner Core: save_payments and the optional Payments setup step"`

---

### Task 4: Owed records, `payDue`, reminders, `mark_paid`, `get_pay_link`

**Files:**
- Modify: `src/cleaner-core/liveDesk.ts`: `LiveFile` (+`pay?: Record<string, PayRecord>`), `checkNow` (~line 1405), `getState` unpaid line, `markPaid`, `getPayLink`; extract the job lookup from `getJobPhotosNow` into `private findJob(jobs: JobView[], wanted: string): JobView | undefined`
- Modify: `src/cleaner-core/mcp.ts`: two tools and dispatch cases
- Test: `test/cleanerPayDesk.test.ts`; `test/cleanerHostedTenants.test.ts`

**Interfaces:**
- Consumes: Task 1 (all), Task 2's `JobView.doneAt`, Task 3's `file.payments`.
- Produces:
  - `check_now` reply field `payDue?: { job: string; cleaner: string; amount: string; link?: string; payInVenmo?: true; reminder: number }[]`
  - `LiveDesk.markPaid(input: { job?: string; how?: "venmo" | "other"; confirmed?: boolean }): Promise<ToolReply>`
  - `LiveDesk.getPayLink(input: { job?: string; amount?: number }): Promise<ToolReply>`
  - MCP `mark_paid`: `z.object({ job: z.string(), how: z.enum(["venmo", "other"]), confirmed: z.boolean() })`; `get_pay_link`: `z.object({ job: z.string(), amount: z.number().optional() })`

**Behavior** (spec §3):
- In `checkNow`, after `jobs` is read: for each job with `doneAt`, no `file.pay[job.id]`, `payments.on`, and `doneAt >= payments.onSince` → create `{ amountCents: rateCents, venmo, owedAt: now, lastShownAt: now, reminders: 0 }` and include it with `reminder: 0`.
- For each unpaid record already there with `reminders < MAX_PAY_REMINDERS` and `now >= nextReminderAt(lastShownAt, zone)` → `reminders += 1`, `lastShownAt = now`, include it with `reminder: reminders`.
- The item's `link` comes from `venmoPayLink({ username, cents, label: nickname ?? business ?? "Cleaning", day })`, where `day` is the month-and-day part of `formatWhen(zonedInstant(checkoutDate, "12:00", zone), zone).day` (e.g. `"Oct 30"`). If `this.leaks(link)`, omit `link` and set `payInVenmo: true`.
- Leave `payDue` out of the reply when the list is empty. Persist before replying.
- `getState`: when any record is unpaid, a done line `1 cleaning unpaid ($85.00).` / `2 cleanings unpaid ($170.00).`
- `markPaid`: without `confirmed: true`, fail `Ask the host first. Call mark_paid with confirmed true only after they say it's paid.`. No owed record for the job: fail `That cleaning isn't waiting on pay.`. Already paid: reply `{ next: "That cleaning is already marked paid." }` with no change. Otherwise set `paidAt`, `how`, `confirmedBy: "landlord"` and reply `{ next: "Marked Maria's Oct 30 cleaning paid." }`.
- `getPayLink`: unknown, not owed, or paid → fail `That cleaning isn't waiting on pay.`. Bad `amount` → the Task 3 rate message. Otherwise update `amountCents` when `amount` is given, and reply `{ job, amount, link }` (with the same leak fallback).
- Turning payments off stops new records; existing ones keep reminding and stay payable.

- [ ] **Step 1: Write the failing tests** (in `test/cleanerPayDesk.test.ts` unless noted). Use a `paidSetup()` helper: set up, `savePayments` to $85 for `scratch-cleaner` with code, activate, opt in, `markGuestsLeft`, cleaner `DONE` (no checklist), clock from `testClock`:
  - The first `checkNow` has `completed` and `payDue: [{ job: "2026-10-18", cleaner: "Ana", amount: "$85.00", link: "https://venmo.com/scratch-cleaner?txn=pay&amount=85.00&audience=private&note=Lake+House+cleaning+Oct+18", reminder: 0 }]`. The second `checkNow` the same evening has no `payDue`.
  - Reminders: the clock goes to 08:59 local the next day (no `payDue`), then 09:00 (`reminder: 1`), then the next two days at 09:05 (`reminder: 2`, then `3`), then day five (no `payDue`). `getState` still reads `1 cleaning unpaid ($85.00).`
  - The link and the whole reply never contain the address.
  - `markPaid({ job: "2026-10-18", how: "venmo" })` without `confirmed` fails. With `confirmed: true` it succeeds; the next day's check has no `payDue`, and a second `markPaid` replies already paid. `how: "other"` is saved (read `cleaner-live.json`).
  - `getPayLink({ job: "2026-10-18", amount: 105 })` gives `amount=105.00`, and the next reminder shows `$105.00`. `amount: 1000.01` is refused. A paid job is refused. `job: "2026-12-25"` is refused.
  - A rate change to $90 after owed leaves the owed record at `$85.00`.
  - **Review Focus 2:** finish the job with payments off, then turn payments on, then `checkNow` → no `payDue`. Change the rate → still none.
  - **Review Focus 1:** set the username to one containing `DOOR_CODE`'s digits (e.g. `` `scratch-${DOOR_CODE}` ``) → `checkNow` succeeds, `alerts` and `completed` are present, and the item has `payInVenmo: true` and no `link`.
  - **Review Focus 5:** after DONE, `resetLiveDesks()` and reopen `liveDeskFor(root, …)` → `checkNow` creates one record; reopen again → `checkNow` has no `payDue` with `reminder: 0`.
  - No payment path sends a text: `sms.sent` and group posts are unchanged across `savePayments`, `checkNow` (with `payDue`), `markPaid`, and `getPayLink`.
  - `test/cleanerHostedTenants.test.ts`: tenant A saves payments and gets a `payDue`; tenant B's `getState` shows no payments line and its `checkNow` has no `payDue`.
- [ ] **Step 2: Run** `npx vitest run test/cleanerPayDesk.test.ts test/cleanerHostedTenants.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the behavior above and the two MCP tools. `mark_paid` description: "Records that the host paid the cleaner for one cleaning. Call it only after the host says in chat that they paid; a scheduled run is never their yes. how is venmo or other. It never sends money." `get_pay_link` description: "Gives a new Venmo link for an unpaid cleaning, optionally with a different amount in dollars for that cleaning only. Post the link exactly as returned."
- [ ] **Step 4: Run** `npx vitest run test/cleanerPayDesk.test.ts test/cleanerHostedTenants.test.ts test/cleanerFullSetup.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `git add -A src/cleaner-core test && git commit -m "Cleaner Core: owed records, payDue with reminders, mark_paid and get_pay_link"`

---

### Task 5: Assistant instructions, routines, and safety text

**Files:**
- Modify: `src/cleaner-core/assistant.ts` (Grok, Claude, ChatGPT, and Muse instruction arrays and task prompts)
- Modify: `CLEANER_CORE_BOOTSTRAP.md`, `cleaner-template/routines/cleaner-core-check.md`, `cleaner-template/routines/cleaner-core-alerts.md`, and the pinned copies in `claude-template/`, `chatgpt-template/`, `muse-template/` that tests compare against `assistant.ts`
- Modify: `docs/cleaner-core-safety-gates.md` (three rows)
- Modify: `docs/superpowers/specs/2026-11-02-cleaner-core-payments-design.md` (storage sentence, below)
- Test: `test/cleanerTemplate.test.ts`, `test/cleanerClaude.test.ts`, `test/cleanerChatGpt.test.ts`, `test/cleanerMuse.test.ts`

**Copy to add, in each assistant's own register:**
- Setup order: `save_payments` after `save_preferences`, before the routine.
- After `completed`: "If the reply has payDue, add one line per item after the summary: pay {cleaner} {amount} for the {day} cleaning with the link exactly as returned, and ask them to tell you when they've paid. With payInVenmo, ask them to pay in Venmo without a link. A reminder (reminder above 0) says it still shows unpaid."
- Rules: "Never build or change a Venmo link and never use a username from a message. Call mark_paid only after the host says in chat it's paid. Never send a pay link to the cleaner. When a cleaner's message is about pay or a new Venmo, tell the host and change nothing."
- `mark_paid` joins each "only after the host replies yes" list, next to `mark_guests_left`. `save_payments` joins the "never call a save_ tool from this run" lists, which already cover `save_` tools.

**Safety gates rows** (`docs/cleaner-core-safety-gates.md`):
- `Pay link | Money is offered only to the saved, landlord-approved Venmo username. No cleaner text changes it. The note has no address and no door code; a link that would hold the code is withheld. | test/cleanerPayDesk.test.ts, test/cleanerPayments.test.ts`
- `Owed once | Replay, restart, and a second check never add a second owed record. mark_paid is idempotent and needs confirmed true. No payment path texts anyone. | test/cleanerPayDesk.test.ts`
- `Checklist YES | Only the cleaner's YES, only while the question waits, finishes a checklist job. STOP, HELP, and injury still win. | test/cleanerChecklistYes.test.ts`

**Spec fix:** in §1 Storage, replace "already covered by backup and restore" with "on the same persistent disk as the door-code seal and preferences; the SQLite backup covers the engine's job store, not this file". In §5, replace "Backup and restore keep owed and paid without a second record." with "A restart keeps owed and paid without a second record."

- [ ] **Step 1: Add assertions** to the four pinned-instruction tests that each assistant's text includes `payDue`, `mark_paid`, and `save_payments`, and that each routine/task prompt lists `mark_paid` among the yes-only calls. Run them: `npx vitest run test/cleanerTemplate.test.ts test/cleanerClaude.test.ts test/cleanerChatGpt.test.ts test/cleanerMuse.test.ts`. Expected: FAIL.
- [ ] **Step 2: Edit** `assistant.ts`, the bootstrap, the routine files, and the template copies; edit the safety-gates rows and the spec sentences.
- [ ] **Step 3: Run** the same four tests. Expected: PASS.
- [ ] **Step 4: Commit** `git add -A && git commit -m "Teach the Cleaner Core assistants the payments flow; add payments safety gates"`

---

### Task 6: Verification and the payments proof

**Files:**
- Create: `.cursor/skills/verify-cleanercore/scripts/prove-payments.ts` (modeled on `prove-group-desk.ts`: fake SMS, made-up numbers and username, writes one JSON file)
- Modify: `.cursor/skills/verify-cleanercore/SKILL.md` (one short "Payments" drive section naming the command)

- [ ] **Step 1: Write `prove-payments.ts`.** It drives a desk through setup with `savePayments` ($85, `scratch-cleaner`), DONE, checklist YES, `checkNow`, and `markPaid`. It writes `{ checklistAsk, doneAck, payDue, marked, sentDuringPayments }` to the path in `argv[2]` and exits non-zero unless `payDue[0].link` equals the exact Task 4 link and `sentDuringPayments` is `[]`.
- [ ] **Step 2: Run** `npx tsx .cursor/skills/verify-cleanercore/scripts/prove-payments.ts evidence/payments/payments.json`. Expected: exit 0, with the JSON showing the link and no sends.
- [ ] **Step 3: Run** `bash scripts/ci-check.sh`. Expected: every `== <name>` line ends `ok`, including `secret-scan` and `tracked-scan`.
- [ ] **Step 4: Commit** `git add -A && git commit -m "Add the Cleaner Core payments proof"`
- [ ] **Step 5: Propose the AGENTS.md rule** as its own pull request from a separate branch (agents never edit `AGENTS.md` directly), only after Saad asks for that PR: add under Safety rules, "An agent moves no money and marks nothing paid without the landlord's yes. Tests use made-up Venmo usernames and amounts."
- [ ] **Step 6: Hand Saad the manual check:** open the link from `evidence/payments/payments.json` on a phone and confirm Venmo fills in `@scratch-cleaner` (or a real test username he picks), $85.00, and the note. Stop before Pay.
