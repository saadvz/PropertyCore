# Hours log follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every host approval in Fixer Core, Cleaner Core and Supply Core leaves a record nothing replaces, the hours log reads it, the export goes to any spreadsheet, and the Property Core agents know the three hours tools.

**Architecture:** Each desk appends the host's approval to a list in its own file in the same write as the approval. `src/hours-log/sources.ts` turns those lists into the same facts the live fields give, and `rawFacts`' existing dedupe (kind, reference, time) keeps today's rows unchanged. Copy changes are text only.

**Tech Stack:** TypeScript, Node, vitest.

**Spec:** `docs/superpowers/specs/2026-11-17-hours-log-follow-ups-design.md`

## Global Constraints

- The record and the live field use the **same `at` string**: capture `now().toISOString()` once and use it for both.
- Records are written whether `HOURS_LOG` is on or off.
- A missing new field reads as empty in every store. No schema version bump.
- Caps: 40 `hostSteps` a job, 200 `clearedHostFacts`, 200 supply `approvals`; the oldest dropped first.
- `OWNER_RULES_VERSION` stays 1.
- No cart token is stored in an approval.
- Test data: made-up names, 555 numbers, made-up door codes only.
- Copy never ties the export to Google alone, never names a connector product as required, and never gives tax advice.
- The `sheet` setting keeps its name.

## Review Focus

1. A month confirmed under #247 with no replaced approval: same rows and fingerprint after this change. (Task 4: `unchanged fingerprint` test.)
2. A host step whose live field is still there: one row, not two. (Task 4.)
3. A Fixer job rescheduled after the host's yes, then approved again: both approvals are owner rows. (Task 1 and Task 4.)
4. An unconfirmed supply order removed after its month was confirmed: still one owner row. (Task 4: `removed order` test.)
5. An old `fixer.json` / `supply.json` / `cleaner-core.json` without the new fields: reads, saves, no crash. (Tasks 1–3.)

---

### Task 1: Fixer Core keeps the host's steps

**Files:**
- Modify: `src/fixer-core/store.ts` (`Job`), `src/fixer-core/desk.ts` (lines ~945, ~977, ~1394, ~1430, ~1671, `logCost` ~2049, `finishJob` ~2058)
- Test: `test/fixerHostSteps.test.ts` (setup copied from `test/fixerBooking.test.ts`'s `setup`, `booked`, `yes`)

**Interfaces:**
- Produces: `export interface HostStep { kind: "approve-repair" | "pick-quote" | "approve-booking" | "approve-price" | "record-cost" | "confirm-repair"; at: string; proId?: string; cents?: number }` and `Job.hostSteps?: HostStep[]` in `store.ts`; `export const MAX_HOST_STEPS = 40`.

- [ ] **Step 1: Write the failing tests**

```ts
it("the host's yes to a booking stays after the visit is moved", async () => {
  const w = await setup(); await booked(w); await yes(w);
  const yesAt = w.job().booking!.hostYes!.at;
  const first = await w.desk.rescheduleJob({ jobId: w.job().id });
  await w.desk.rescheduleJob({ jobId: w.job().id, confirmation: codeOf(first) });
  expect(w.job().booking).toBeUndefined();
  expect(w.job().hostSteps).toEqual(expect.arrayContaining([
    { kind: "approve-repair", at: w.job().hostGo!.at },
    { kind: "approve-booking", at: yesAt, proId: w.pro("Joe").id },
  ]));
});
it("a raised price the host approved stays after a second raise", ...)   // approve-price with proId and cents 25000
it("a host's cost saved twice keeps both", ...)                           // two record-cost steps, cents 18000 then 19000
it("the agent's cost and done leave no step", ...)                        // record_done by agent with cents: hostSteps has no record-cost / confirm-repair
it("record_done by the host with an amount gives confirm-repair and record-cost at the live fields' times", ...) // step.at === job.done.at, job.cost.at
it("an old job with no hostSteps reads and saves", ...)                   // writeFixer a job without the field, call check_fixes, no error
it("keeps at most 40 steps a job, newest last", ...)                      // seed 40 steps, one more approval: length 40, last is the new one
```

- [ ] **Step 2: Run** `npx vitest run test/fixerHostSteps.test.ts` — Expected: FAIL (`hostSteps` undefined).

- [ ] **Step 3: Implement** a private `step(job: Job, step: HostStep): void` in `desk.ts` that pushes and trims to `MAX_HOST_STEPS`. Call it beside each live field with the same `at` variable: `hostGo` (open_job from the host, approve_job), `quotePick` (proId), approve_booking's new booking `hostYes` (proId), `approveRevised` (proId, cents), `logCost` when `by === "host"` (cents, `job.cost.at`), `finishJob` when `by === "host"` (`job.done.at`). Where today's code calls `now()` inline for the live field, hoist it to one `at`.

- [ ] **Step 4: Run** `npx vitest run test/fixerHostSteps.test.ts test/fixerBooking.test.ts test/fixerDesk.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** `Fixer Core keeps a record of the host's approvals (#238)`.

### Task 2: Cleaner Core keeps the cleaning times it clears

**Files:**
- Modify: `src/cleaner-core/core.ts` (`HostFact` ~739, `Stored` ~767, field ~834, `clearHostTime` ~3530, load ~3844, save ~3900)
- Test: `test/cleanerHostTimeLog.test.ts` (harness from `test/cleanerCore.test.ts`: `core`, `sink`, `feed`, with a `dataDir`)

**Interfaces:**
- Produces: `Stored.clearedHostFacts?: ClearedHostFact[]` where `interface ClearedHostFact extends HostFact { checkoutDate: string }`; `MAX_CLEARED_HOST_FACTS = 200`. Saved in `cleaner-core.json` (one tenant: top level; several: under `tenants[id]`).

- [ ] **Step 1: Write the failing tests**

```ts
it("a host's checkout time cleared by a moved date is kept with the old checkout date", async () => {
  // poll guesty-lite-scratch.ics, owner answers "1:00 PM", YES, YES; poll guesty-lite-date-moved.ics
  const stored = JSON.parse(readFileSync(join(dir, "cleaner-core.json"), "utf8"));
  expect(stored.hostFacts.filter((f) => f.field === "checkout")).toEqual([]);
  expect(stored.clearedHostFacts).toEqual(expect.arrayContaining([
    expect.objectContaining({ jobId: "stay-anita@guesty.com", field: "checkout", version: 1, minutes: 780, checkoutDate: "2026-10-18", at: NOW }),
  ]));
});
it("the engine still asks for the new time, as before", ...)     // same texts as the existing "asks the host again" test
it("a store with no clearedHostFacts loads and saves", ...)
it("keeps at most 200, oldest dropped", ...)
```

- [ ] **Step 2: Run** `npx vitest run test/cleanerHostTimeLog.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**: in `clearHostTime`, before filtering, push each matching fact that has `at` with the job's current `checkoutDate` (read the job before its date is overwritten: move the `clearHostTime` calls in the feed update above the `existing.checkoutDate = …` assignment, or pass the old date in). Load with `?? []`; save the list.

- [ ] **Step 4: Run** `npx vitest run test/cleanerHostTimeLog.test.ts test/cleanerCore.test.ts test/cleanerUpdateSettle.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** `Cleaner Core keeps the cleaning times a moved date clears (#238)`.

### Task 3: Supply Core keeps each cart approval

**Files:**
- Modify: `src/supply-core/store.ts` (`Cart`, `SupplyFile`, `readSupply`), `src/supply-core/desk.ts` (`approveCart` ~819, `sweep` ~604, `recordOrder` ~862)
- Test: `test/supplyApprovals.test.ts` (harness from `test/supplyOrdering.test.ts`: `activated({ mode: "checkout" })`, `cartOf`, `code`)

**Interfaces:**
- Produces: `export interface CartApproval { id: string; at: string; store: string; items: { itemId: string; qty: number }[]; totalCents: number; orderId?: string; orderAt?: string }`, `SupplyFile.approvals?: CartApproval[]`, `Cart.approvalId?: string`, `MAX_APPROVALS = 200`. Ids `newId("apv_", 10)` (same helper the store uses for orders).

- [ ] **Step 1: Write the failing tests**

```ts
it("approve_cart records the host's yes, and record_order links it to the order", async () => {
  // held cart, approveCart twice with the code, recordOrder
  const file = readSupply(root);
  expect(file.approvals).toEqual([{ id: expect.stringMatching(/^apv_/), at: START.toISOString(), store: "Example Mart", items: [{ itemId: ids.towels, qty: 2 }], totalCents: 4800, orderId: file.orders[0]!.id, orderAt: file.orders[0]!.at }]);
  expect(JSON.stringify(file.approvals)).not.toContain("cart_");
});
it("an approved cart that expires becomes an unconfirmed order linked to the approval, at the approval's time", ...) // orderAt === at
it("an approved cart closed with record_problem keeps the approval with no order", ...)
it("removing the unconfirmed order as not-placed keeps the approval", ...)
it("a go cart (no approval) records none", ...)
it("an old supply.json with no approvals reads and saves", ...)
```

- [ ] **Step 2: Run** `npx vitest run test/supplyApprovals.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**: in `approveCart` after the gate, one `at`, push the approval (trim to 200), set `cart.approvalId`, and use the same `at` for `expiresAt`'s base. In `recordOrder` and `sweep`, when the cart has `approvalId`, set that approval's `orderId` and `orderAt` from the new order. `readSupply` leaves `approvals` absent when missing (callers use `?? []`).

- [ ] **Step 4: Run** `npx vitest run test/supplyApprovals.test.ts test/supplyOrdering.test.ts test/supplyDesk.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** `Supply Core keeps a record of each cart the host approved (#238)`.

### Task 4: The hours log reads the records

**Files:**
- Modify: `src/hours-log/sources.ts` (`HostTime`, `readRecords`, `cleanerRows`, `fixerRows`, `supplyRows`)
- Test: `test/hoursRows.test.ts` (new `describe("a replaced approval is still the host's (#238 follow-up)")`), fixture data from `test/hoursFixture.ts`

**Interfaces:**
- Consumes: `HostStep` (Task 1), `ClearedHostFact` shape (Task 2), `CartApproval` (Task 3).
- Produces: `HostTime.checkoutDate?: string`; an exported `orderTask(store: string, lines: string, cents: number): string` helper used for both the order row and the removed order's row.

- [ ] **Step 1: Write the failing tests**

```ts
it("a booking yes, a raised-price yes and a quote pick lost to a reschedule come back as owner rows", ...)
  // fixer job with hostSteps but no booking / quotePick: owner facts approve-booking, approve-price, pick-quote at the steps' times, reference "Fixer Core job job_x"
it("a step whose live field is still there adds nothing", ...)
  // october fixture + hostSteps mirroring every live field: factsFrom(...) equals factsFrom(...) without them
it("unchanged fingerprint: the October fixture builds the same month as before", ...)
  // buildMonth fingerprint equals a hard-coded value computed from master before any change (record it in Step 2)
it("a cleaning time cleared by a moved date is still the host's, for the checkout it was given for", ...)
  // engine.clearedHostFacts with checkoutDate "2026-10-03": task "Gave the cleaner's checkout time for the 2026-10-03 checkout", reference "Cleaner Core job job_oct4, host time checkout v1"
it("removed order: an approval whose unconfirmed order was removed gives back that order's owner fact exactly", ...)
  // build facts with the order, keep its owner facts as a confirmed month would, remove the order, build again with kept: one owner row, same reference "Supply Core order ord_x", same task
it("an approval that never became an order is an owner row that says it wasn't placed", ...)
  // task "Approved a supply order from Example Mart: Paper towels x2, $48.00. It wasn't placed.", reference "Supply Core approval apv_x"
it("an approval whose order is still there adds nothing", ...)
```

- [ ] **Step 2: Run** `npx vitest run test/hoursRows.test.ts` — Expected: FAIL on the new tests. Before writing any source change, record the October fingerprint from `master` for the `unchanged fingerprint` test.

- [ ] **Step 3: Implement**: `readRecords` appends `slice.clearedHostFacts` to `hostTimes`; `cleanerRows` uses `time.checkoutDate ?? checkoutOf(...)`; `fixerRows` emits each `hostSteps` entry through the existing `host(kind, at, task)` with the same task text the live field uses (pro name from `proId`, price from `cents`); `supplyRows` emits approvals per the spec (skip when the order exists; removed order → `approve-order` at `orderAt`, reference `Supply Core order {orderId}`, `orderTask(store, lines, totalCents)`; no order → `approve-order` at `at`, reference `Supply Core approval {id}`). The order row's task goes through `orderTask` too, with unchanged output.

- [ ] **Step 4: Run** `npx vitest run test/hoursRows.test.ts test/hoursMonth.test.ts test/hoursDesk.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** `Hours log: rows from each flow's record of the host's approvals (#238)`.

### Task 5: The export goes to any spreadsheet

**Files:**
- Modify: `src/hours-log/tools.ts` (EXPORT title and description, SETTINGS description), `src/hours-log/desk.ts` (header comment, `NOT_EXPORTED`, confirm `next`, export `next`, stored `next`), `src/hours-log/store.ts` (`sheet` comment and refusal text), `src/hours-log/sheet.ts` (comment), `README.md:18`, `docs/environment-variables.md:32`
- Test: `test/hoursDesk.test.ts` (new `it`)

- [ ] **Step 1: Write the failing test**

```ts
it("the tools and replies write to the host's own spreadsheet, not only Google", async () => {
  const text = JSON.stringify(HOURS_TOOLS) + (await exportReply()).text; // a confirmed month's export reply
  expect(text).not.toMatch(/Google Sheets connector|Google Sheet\b/);
  expect(text).toMatch(/Google Sheets, Excel/);
  expect(text).toContain("ask the host where");
});
```

- [ ] **Step 2: Run** `npx vitest run test/hoursDesk.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** the copy. Export `next` (exact):
`Write each log to the host's spreadsheet${sheet ? `, ${sheet}` : ""}, with the spreadsheet connector they already use with you: Google Sheets, Excel, or another. Its rows as given, header first, one tab per log unless the host keeps them elsewhere. If none is connected, or you don't know which spreadsheet, ask the host where they want the log written, and save it with save_hours_settings. Change no cell. Then call export_hours with this month and stored: true.`
"Sheet" elsewhere becomes "spreadsheet". README and the env doc say "their spreadsheet (Google Sheets, Excel or another)".

- [ ] **Step 4: Run** `npx vitest run test/hoursDesk.test.ts test/hoursHosted.test.ts test/propertyCoreReadme.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** `Hours log: export to the host's own spreadsheet, not only Google Sheets (#238)`.

### Task 6: The agents' hours log copy

**Files:**
- Modify: `property-core-template/bot-profile.md` (new "Hours log:" block before "Always:"), `property-core-template/muse/skills/property-core/SKILL.md` and `property-core-template/claude/plugin/skills/property-core/SKILL.md` (new `## Hours log` before `## Always`), `property-core-template/chatgpt/SETUP_GUIDE.md` (new section after Step 3, "ChatGPT's instructions:" voice)
- Test: `test/propertyCoreTemplate.test.ts` (new `it`)

- [ ] **Step 1: Write the failing test**

```ts
it("each agent's instructions cover the hours log only when review_hours is listed", () => {
  for (const path of [BOT_PROFILE, MUSE_SKILL, CLAUDE_SKILL, CHATGPT_GUIDE]) {
    const text = read(join(TEMPLATE, path)).replace(/\s+/g, " ");
    for (const tool of ["`review_hours`", "`export_hours`", "`save_hours_settings`"]) expect(text, path).toContain(tool);
    expect(text, path).toMatch(/only when `review_hours` is (among|in) your tools/);
    expect(text, path).toContain("Never give tax advice");
    expect(text, path).toContain("ask the host where");
    expect(text, path).not.toMatch(/Google Sheets connector/);
  }
});
```

- [ ] **Step 2: Run** `npx vitest run test/propertyCoreTemplate.test.ts` — Expected: FAIL.

- [ ] **Step 3: Write the copy** (same content in each, fitted to the file's voice):
  - Only when `review_hours` is among your tools.
  - When the host asks for their hours or a month's log, call `review_hours` with the property and the month. Show each log's rows and every line in `needs`, ask its question, and call it again with the code only after their yes.
  - Then call `export_hours` and write each log, exactly as given, to the spreadsheet the host already uses with you: Google Sheets, Excel, or another. If none is connected, ask the host where they want the log written. Then call `export_hours` again with `stored: true`.
  - Save their codes, minutes, columns, owner name and spreadsheet with `save_hours_settings`, only as the host says.
  - Never give tax advice, or say what counts toward any tax test.

- [ ] **Step 4: Run** `npx vitest run test/propertyCoreTemplate.test.ts test/fixerTemplate.test.ts test/cleanerTemplate.test.ts test/setupEntryPoint.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** `Property Core agents: the hours log tools (#238)`.

### Task 7: Docs and the whole check

**Files:**
- Modify: `docs/superpowers/specs/2026-11-14-hours-log-design.md:69` (the follow-up sentence now points to this design), `docs/environment-variables.md:32` (records are kept in each flow's file)

- [ ] **Step 1:** Edit the two lines.
- [ ] **Step 2: Run** `npm run typecheck && npm run build && npm test` — Expected: all pass. Record the file and test counts for the PR.
- [ ] **Step 3: Commit** `Docs: the hours log follow-ups (#238)`.
