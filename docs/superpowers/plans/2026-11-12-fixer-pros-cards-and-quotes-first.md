# Fixer Core Pros Cards and Quotes First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Fixer setup asks about the host's pros in two cards of at most five options each.
- A repair can be quotes-only: Grok collects prices, reports once, and books the pro the host picks.

**Architecture:**
- The pros step's `ask` becomes two questions.
- A job gets `quotesFirst` and `quotePick`.
- `record_contact` refuses `booked` while a job is quotes-only.
- `check_fixes` adds `quotesReady`.
- A new two-call tool, `pick_quote`, ends quotes-only, saves a cost line, and makes the picked pro `contactNext`.

**Tech Stack:** TypeScript, vitest, zod (existing Fixer Core desk and tools).

**Spec:** `docs/superpowers/specs/2026-11-12-fixer-pros-cards-and-quotes-first-design.md`

## Global Constraints

**Pros cards:** two questions, in this order.

| Card | Field | Options (value: label) |
| --- | --- | --- |
| 1 | `pros` | `plumbing`: Plumber, `hvac`: HVAC, `electrical`: Electrician, `handyman`: Handyman, `none`: None of these |
| 2 | `pros-more` | `gutters`: Gutters, `pest-control`: Pest control, `appliance`: Appliance repair, `locksmith`: Locksmith, `none`: None of these |

Both cards are `multiple: true`.

**Cost line card options, in order:** No cost line, Set a cost line, Get quotes first.

**Exact copy:**

| Where | Text |
| --- | --- |
| Confirmation, verbatim | `I'll call pros for quotes only and report back before anyone is booked. OK?` |
| Summary with quotes | `Quotes for {what}: {Pro} {$}[ ({note})], {Pro} {$}. Who should I book, and want a cost line?` |
| Summary with no quotes | `No quotes yet for {what}. Want me to find more pros?` |
| Booked refusal | `This repair is getting quotes first. Record what they quoted with outcome quoted, put any time they offered in the note, and tell them you'll call back.` |

**Rules:**
- A cost line is from $1 to $5,000 (existing `COST_LINE_RANGE`).
- Tests use only 555 numbers and made-up pros.

## Review Focus

1. **A host's job opened quotes-only with a cost line too.**
   - Expected: both are saved; the line applies once booking starts.
   - Test: in Task 2.
2. **The host asks for more options after the summary.**
   - Expected: new contacts after the summary give a fresh `quotesReady` once they all have outcomes.
   - Test: in Task 3.
3. **`pick_quote` for a pro who declined, or on a job that isn't quotes-only.**
   - Expected: refused, nothing changes.
   - Test: in Task 4.
4. **A cleaner's or upkeep job set quotes-only with the host's go.**
   - Expected: works the same as the host's own job.
   - Test: in Task 2.
5. **`pick_quote`'s code reused after the job changed.**
   - Expected: refused. The code is bound to job, pro and cost line.
   - Test: in Task 4.

---

### Task 1: Pros in two cards

**Files:**
- Modify: `src/fixer-core/setupAsk.ts` (`PROS_QUESTION` becomes `PROS_QUESTIONS: AskQuestion[]`; the pros step returns both)
- Modify: `FIXER_CORE_BOOTSTRAP.md` step 3, `muse-template/skills/fixer-core/SKILL.md` step 3
- Test: `test/fixerDesk.test.ts` (replace "asks the pros as one card: every trade and None yet, pick all that apply")

- [ ] **Step 1: Write the failing test.** Name it `"asks the pros as two cards of at most five, each with None of these"`. It asserts:
  - `questions.map(q => q.field)` equals `["pros", "pros-more"]`.
  - Each question has `multiple === true` and 5 options or fewer.
  - The option values are, in order, `["plumbing","hvac","electrical","handyman","none"]` and `["gutters","pest-control","appliance","locksmith","none"]`.
  - Together the two cards cover every value in `TRADES`.
  - The first question's `how` contains `"one card per message"`.
- [ ] **Step 2: Run** `npx vitest run test/fixerDesk.test.ts -t "two cards"`. Expected: FAIL.
- [ ] **Step 3: Implement** with the labels from Global Constraints. `how` on the first card says to ask the two cards one per message, then name and phone only for the trades picked. The rest of the current `how` text is kept.
- [ ] **Step 4: Run** `npx vitest run test/fixerDesk.test.ts test/fixerTemplate.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `"Ask Fixer Core's pros in two cards"`.

### Task 2: A repair can be quotes-only

**Files:**
- Modify: `src/fixer-core/store.ts` (`Job.quotesFirst?: true`)
- Modify: `src/fixer-core/desk.ts`:
  - `JobInput.quotesFirst?: true` and `ApproveJobInput.quotesFirst?: true`;
  - the same source rule as `costLineCents` (`open_job` on the host's own job only; on a cleaner's or upkeep job it comes with the go on `approve_job`, outside the code fingerprint, as the cost line is);
  - `recordContact` refuses `booked` on a job with `quotesFirst`, with the refusal copy.
- Modify: `src/fixer-core/tools.ts` (`quotesFirst: z.literal(true).optional()` on both tools; descriptions)
- Modify: `FIXER_CORE_BOOTSTRAP.md` and the Muse skill: the cost line bullet lists the three options in order, and gives the confirmation line verbatim before Grok opens the job or calls `approve_job`.
- Test: `test/fixerDesk.test.ts`, `test/fixerBooking.test.ts`

**Interfaces:**
- Produces: `Job.quotesFirst?: true`, set by `open_job` / `approve_job`.

- [ ] **Step 1: Write the failing tests.**
  - `"saves quotes-only and a cost line on the host's job, and with the go on a cleaner's job"`
  - `"refuses a booked outcome on a quotes-only job, and keeps the quote"`: `record_contact` booked is an error with the refusal text, and the job has no booking. `quoted` with `note: "Can come Tuesday"` saves the quote.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run test/fixer`. Expected: PASS.
- [ ] **Step 5: Commit** `"Let a repair be quotes-only"`.

### Task 3: Report the quotes once

**Files:**
- Modify: `src/fixer-core/desk.ts` (`checkFixes` body gains `quotesReady`; `Job.quotesToldAt?: string` in `store.ts`)
- Modify: `src/fixer-core/texts.ts` (`quotesQuestion(f: { what: string; quotes: { name: string; cents: number; note?: string }[] }): string`, both copies from Global Constraints)
- Modify: both guides (`quotesReady` added to `check_fixes`' keys, with a bullet), `fixer-template/routines/fixer-core-check.md` and the Muse task (post the question as given), and `CHECK_FIXES_KEYS` in `test/fixerTemplate.test.ts`.
- Test: `test/fixerDesk.test.ts`

**Interfaces:**
- Produces: `check_fixes().quotesReady: { jobId, quotes: { proId, name, cents, note? }[], question }[]`.
- A job is listed when:
  - it is open with `quotesFirst`, and has at least one non-cancelled contact;
  - every non-cancelled contact's outcome is `quoted`, `declined` or `no-answer`;
  - no contact is newer than `quotesToldAt`.
- Listing it sets `quotesToldAt` to now.

- [ ] **Step 1: Write the failing tests.**
  - `"reports the quotes once every contacted pro answered"`:
    - With two contacts pending, it is not listed.
    - Once one is quoted at 15000 and one declined, it is listed once with question `Quotes for Kitchen sink leaks: Joe's Plumbing $150. Who should I book, and want a cost line?`.
    - The next `check_fixes` has no `quotesReady`.
  - `"says no quotes yet when everyone declined"`.
  - `"reports again after more pros are contacted"`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run test/fixer`. Expected: PASS.
- [ ] **Step 5: Commit** `"Report a quotes-only repair's quotes once"`.

### Task 4: pick_quote

**Files:**
- Modify: `src/fixer-core/desk.ts`:
  - `pickQuote(input: { jobId?: string; proId?: string; costLineCents?: number; confirmation?: string }): Promise<FixerReply>`;
  - `Job.quotePick?: { proId: string; at: string }`;
  - `contactNext` returns the picked pro first while `quotePick` is set and no contact to them is newer than `quotePick.at`.
- Modify: `src/fixer-core/tools.ts` (`pick_quote`, strict input, `TWO_CALL` description, dispatch), `test/fixerTools.test.ts` (`SAMPLES` and the extras list)
- Modify: both guides (`pick_quote` after the summary), `docs/fixer-core-safety-gates.md` (one sentence in "Cost line and window in code": a quotes-only job takes no booking until `pick_quote`'s code, bound to job, pro and line)
- Test: `test/fixerDesk.test.ts`

**Interfaces:**
- Consumes: `Job.quotesFirst` (Task 2).
- `pickQuote` refuses:
  - a job that isn't quotes-only;
  - a pro without a `quoted` contact on the job;
  - a line outside the range.
- First call: question `Book {Pro} for {what}[ with a {$line} cost line]?` and a code. The fingerprint holds `{ jobId, proId, costLineCents }`.
- Second call:
  - clears `quotesFirst` and `quotesToldAt`;
  - sets `costLineCents` if given;
  - sets `quotePick`;
  - replies `next: "Call check_fixes: contactNext names {Pro} to book."`

- [ ] **Step 1: Write the failing tests.**
  - `"pick_quote books the picked pro next, with the host's yes and a cost line"`: after the code, the job has no `quotesFirst` and `costLineCents` 20000; `contactNext[0].proId` is the pro; `record_contact` booked now works.
  - `"refuses a pro who didn't quote, a job that isn't quotes-only, and a stale code"`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** For a picked candidate, `contactNext` gives the candidate's name and reach. `contactAllowed` already allows a picked candidate.
- [ ] **Step 4: Run** `bash scripts/ci-check.sh`. Expected: exit 0.
- [ ] **Step 5: Commit** `"Add pick_quote"` and push `claude/ecstatic-einstein-mbyqqs`.
