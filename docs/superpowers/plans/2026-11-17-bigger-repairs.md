# Bigger Repairs Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pure, tested rules for repair blocks, crew workday windows, and urgent visits during a guest stay (#243), with nothing wired into the desk yet.

**Architecture:** Three new pure modules beside `gate.ts` and `window.ts` in `src/fixer-core/`. They take plain inputs (the hub's `Stay[]`, the property's time zone and check-in/checkout times) and return answers; no file reads, no clock reads. `window.ts` gains one exported helper so the busy-time rule lives in one place.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest.

**Spec:** `docs/superpowers/specs/2026-11-17-bigger-repairs-design.md`

## Global Constraints

- No change to `desk.ts`, `store.ts`, `tools.ts`, `gate.ts`, the Grok guide or any tool. Nothing the bot or host sees changes.
- Repair blocks and crew schedules: at most 92 days.
- Urgent visit: at most 240 minutes; code shows from the visit's start to its end, no early lead.
- Crew window: opens 30 minutes before its start.
- Timeline text: never a door code, phone number or cost. Runs of 4+ digits become `[number removed]` (reuse `joinSplitDigits` from `src/hub/digits.ts`, as `redactDigits` in desk.ts does).
- Local days are `YYYY-MM-DD`; times are 24-hour `HH:MM`; instants are ISO strings. All local-to-instant conversion goes through `zonedInstant` from `src/hub/calendar.ts`.
- Error text: short, plain, one sentence, in the repo's voice ("Give …").

## Review Focus

- A calendar block wider than the repair block: only the repair block's nights are freed for the crew; the rest stays busy. (Test in Task 1.)
- A crew window on a DST change day lands on the right UTC instant. (Test in Task 2.)
- A guest's "yes" for one window doesn't cover a longer or moved window. (Test in Task 3.)
- A visit that starts in a stay but runs past checkout isn't treated as fully urgent. (Test in Task 3.)
- Free text in the timeline that holds a code or phone comes out redacted. (Test in Task 3.)

---

### Task 1: Repair blocks

**Files:**
- Modify: `src/fixer-core/window.ts` (export `OccupyInput` and add `busyTimes`)
- Create: `src/fixer-core/repairBlock.ts`
- Test: `test/fixerRepairBlock.test.ts`

**Interfaces:**
- Produces in `window.ts`: `export type OccupyInput` (unchanged shape: `timeZone`, `checkoutTime?`, `checkInTime?`, `checkInBufferMinutes`); `export function busyTimes(stays: readonly Stay[], input: OccupyInput): { start: number; end: number }[]` (epoch ms, one per stay, same math as `occupiedOf`, unmerged).
- Produces in `repairBlock.ts`:
  - `export const MAX_BLOCK_DAYS = 92`
  - `export interface RepairBlock { id: string; firstDay: string; lastDay: string; jobIds: string[] }`
  - `export type BlockDays = Pick<RepairBlock, "firstDay" | "lastDay">`
  - `export function nightsOf(block: BlockDays): string[]` (firstDay..lastDay inclusive)
  - `export function repairBlockProblem(block: BlockDays, todayYmd: string): string | undefined`
  - `export interface RepairBlockStatus { onCalendar: boolean; openNights: string[]; collisions: Stay[] }`
  - `export function repairBlockStatus(block: BlockDays, stays: readonly Stay[]): RepairBlockStatus`
  - `export function staysForCrew(stays: readonly Stay[], blocks: readonly BlockDays[]): Stay[]`
  - `export type DoorFor = "guests" | "crew" | "none"`
  - `export function doorFor(at: Date, blocks: readonly BlockDays[], stays: readonly Stay[], times: OccupyInput): DoorFor`

- [ ] **Step 1: Write the failing tests** in `test/fixerRepairBlock.test.ts` (today `2026-12-01`, UTC, buffer 60, `stay(checkIn, checkout, kind)` helper as in `fixerWindow.test.ts`; block `{ firstDay: "2026-12-05", lastDay: "2026-12-09" }`):
  - `repairBlockProblem`: valid → `undefined`; `"2026-13-01"` → defined; firstDay `2026-11-30` → defined; lastDay before firstDay → defined; 92 days (`2026-12-01`..`2027-03-02`) → `undefined`; 93 days → defined.
  - `repairBlockStatus`, no stays → `{ onCalendar: false, openNights: [5 nights], collisions: [] }`.
  - one calendar block `2026-12-05`→`2026-12-10` → `onCalendar: true, openNights: []`.
  - two blocks `05→07` and `07→10` (two calendars) → `onCalendar: true`.
  - block `05→08` only → `openNights: ["2026-12-08", "2026-12-09"]`.
  - guest stay `2026-12-08`→`2026-12-12` → `collisions` holds it; stay checking out `2026-12-05` and stay checking in `2026-12-10` → no collisions.
  - `staysForCrew`: block `05→10` → removed; wider block `03→12` → `[block 03→05, block 10→12]`; guest stay and an unrelated block `20→22` unchanged.
  - Plugging in: `visitWindows({ ...base, stays: staysForCrew([block 05→10], [repair]), lastYmd: "2026-12-09" })` has one window from now through `2026-12-10T00:00Z`; with the raw stays it has a gap from `2026-12-05T15:00Z`.
  - `doorFor` with the block on the calendar: `2026-12-06T12:00Z` → `"crew"`; same time with no calendar block → `"none"`; a guest stay `06→07` inside the block, at `2026-12-06T18:00Z` → `"guests"`; `2026-12-15T12:00Z` → `"none"`; inside a plain guest stay outside any block → `"guests"`.

- [ ] **Step 2: Run** `npx vitest run test/fixerRepairBlock.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement.** In `window.ts`, export `OccupyInput` and make `busyTimes` the body of `occupiedOf` (keep `occupiedOf` calling it). In `repairBlock.ts`: nights compare as `YYYY-MM-DD` strings; a calendar entry covers night `n` when `checkIn <= n < checkout`; `staysForCrew` trims a `kind: "block"` entry overlapping `[firstDay, lastDay+1)` to the parts before `firstDay` and from `lastDay+1`, dropping empty parts; `doorFor` checks guest stays (`kind: "stay"`) with `busyTimes` first, then crew when the instant is in `[zonedInstant(firstDay,"00:00"), zonedInstant(lastDay+1,"00:00"))` and `repairBlockStatus(...).onCalendar`.

- [ ] **Step 4: Run** `npx vitest run test/fixerRepairBlock.test.ts test/fixerWindow.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "Add repair-block rules for Fixer Core (#243)"`.

### Task 2: Crew workday windows

**Files:**
- Create: `src/fixer-core/crewDays.ts`
- Test: `test/fixerCrewDays.test.ts`

**Interfaces:**
- Consumes: `busyTimes`, `OccupyInput` (Task 1); `MAX_BLOCK_DAYS` (Task 1); `Weekday`, `WEEKDAYS`, `weekdayOf` from `src/core/timezone.ts`.
- Produces:
  - `export interface CrewSchedule { firstDay: string; lastDay: string; workdays: Weekday[]; start: string; end: string; skipDays?: string[] }`
  - `export interface CrewWindow { day: string; from: string; until: string }`
  - `export interface CrewConflict { day: string; why: "clipped" | "dropped" }`
  - `export function crewScheduleProblem(schedule: CrewSchedule, todayYmd: string): string | undefined`
  - `export function crewWindows(schedule: CrewSchedule, input: OccupyInput & { stays: readonly Stay[] }): { windows: CrewWindow[]; conflicts: CrewConflict[] }`
  - `export function crewWindowAt(windows: readonly CrewWindow[], now: Date, earlyMinutes?: number): CrewWindow | undefined` (default 30)

- [ ] **Step 1: Write the failing tests** (UTC unless said; schedule MON–FRI `08:00`–`17:00`, `2026-12-07`..`2026-12-13`):
  - `crewScheduleProblem`: valid → `undefined`; `workdays: []`; `start "17:00", end "08:00"`; `start "8:00"`; equal start and end; a skip day outside the range; 93 days; firstDay before today → each defined.
  - `crewWindows` with no stays → 5 windows, days `2026-12-07`..`2026-12-11`, first `{ day: "2026-12-07", from: "2026-12-07T08:00:00.000Z", until: "2026-12-07T17:00:00.000Z" }`, no conflicts.
  - `skipDays: ["2026-12-09"]` → 4 windows, no `2026-12-09`.
  - `America/New_York`, FRI and MON, `2027-03-12`..`2027-03-15` → Fri from `2027-03-12T13:00:00.000Z`, Mon from `2027-03-15T12:00:00.000Z`.
  - Stay checking out `2026-12-08` (11:00) → that day's window `11:00Z`–`17:00Z`, conflict `{ day: "2026-12-08", why: "clipped" }`.
  - Stay checking in `2026-12-10` (16:00, buffer 60) → that day `08:00Z`–`15:00Z`, clipped.
  - Stay `2026-12-08`→`2026-12-10` → `2026-12-09` dropped (conflict `dropped`); `2026-12-08` clipped to `08:00`–`15:00`; `2026-12-10` clipped to `11:00`–`17:00`.
  - `crewWindowAt` on the first window: `07:29Z` → `undefined`; `07:30Z` → the window; `16:59Z` → the window; `17:00Z` → `undefined`; with `earlyMinutes: 0`, `07:59Z` → `undefined`.

- [ ] **Step 2: Run** `npx vitest run test/fixerCrewDays.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Walk days with `addCalendarDays`; weekday via `weekdayOf`; each window is `[zonedInstant(day,start), zonedInstant(day,end))` minus every busy span from `busyTimes(input.stays, input)`; each leftover piece is a window (same `day`); a day with pieces that changed is `clipped`, a day with none is `dropped`.

- [ ] **Step 4: Run** `npx vitest run test/fixerCrewDays.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "Add crew workday windows for Fixer Core (#243)"`.

### Task 3: Urgent visit during a stay

**Files:**
- Create: `src/fixer-core/urgentVisit.ts`
- Test: `test/fixerUrgentVisit.test.ts`

**Interfaces:**
- Consumes: `busyTimes`, `OccupyInput` (Task 1); `formatWhen`, `zonedInstant` from `src/hub/calendar.ts`; `joinSplitDigits` from `src/hub/digits.ts`.
- Produces:
  - `export const MAX_URGENT_MINUTES = 240`
  - `export interface Span { from: string; until: string }`
  - `export interface GuestAnswer { stay: string; answer: "yes" | "no"; window?: Span; at: string; via: "text" | "platform" | "host" }` (`stay` is `stayKey(...)`; the caller passes the guest's latest answer)
  - `export function stayKey(stay: Pick<Stay, "checkIn" | "checkout">): string` (`"checkIn|checkout"`)
  - `export function urgentStay(window: Span, stays: readonly Stay[], times: OccupyInput): Stay | undefined` (first `kind: "stay"` the window touches)
  - `export type UrgentHold = "not-during-stay" | "spans-checkout" | "too-long" | "no-guest-ok" | "guest-declined" | "guest-ok-other-stay" | "guest-ok-other-window" | "no-host-yes"`
  - `export interface UrgentVisitInput { window: Span; stays: readonly Stay[]; times: OccupyInput; guest?: GuestAnswer; hostYes?: { at: string } }`
  - `export function urgentVisitHolds(input: UrgentVisitInput): UrgentHold[]`
  - `export type UrgentRefusal = UrgentHold | "door-lock" | "no-phone" | "before-visit" | "after-visit"`
  - `export function urgentAccessCheck(input: UrgentVisitInput & { now: Date; proPhone?: string; doorLock?: boolean }): { ok: true; window: Span } | { ok: false; reason: UrgentRefusal }`
  - `export type TimelineKind = "reported" | "guest-asked" | "guest-agreed" | "guest-declined" | "host-yes" | "code-shown" | "visit-done" | "photo"`
  - `export interface TimelineEntry { at: string; kind: TimelineKind; text: string }`
  - `export interface TimelineInput { timeZone: string; reportedAt: string; what: string; proName: string; guestAskedAt?: string[]; guestAnswers?: GuestAnswer[]; hostYesAt?: string; codeShownAt?: string[]; done?: { at: string; note?: string }; photos?: { at: string; from: "cleaner" | "pro" }[] }`
  - `export function urgentTimeline(input: TimelineInput): TimelineEntry[]`

- [ ] **Step 1: Write the failing tests** (UTC; stay `2026-12-01`→`2026-12-08`; visit `2026-12-04T14:00Z`–`16:00Z`; guest yes for `13:00Z`–`17:00Z` on that stay; host yes):
  - all present → `urgentVisitHolds` is `[]`.
  - visit `2026-12-10T14:00Z`–`16:00Z` → `["not-during-stay"]` only.
  - visit `2026-12-08T10:00Z`–`12:00Z` (checkout 11:00) → includes `"spans-checkout"`.
  - visit 4h01m → includes `"too-long"`; exactly 4h → not.
  - no guest → `"no-guest-ok"`; guest `"no"` → `"guest-declined"`; guest yes for another stay key → `"guest-ok-other-stay"`; guest yes `14:30Z`–`17:00Z` → `"guest-ok-other-window"`.
  - no host yes → `"no-host-yes"`; holds come in the order of `UrgentHold`.
  - `urgentAccessCheck`: `now 13:59:59Z` → `before-visit` (no early lead); `14:00Z` → ok with window `14:00Z`–`16:00Z`; `16:00Z` → `after-visit`; `doorLock: true` → `door-lock`; no phone → `no-phone`; guest `"no"` at `14:30Z` → `guest-declined`.
  - `urgentTimeline`: entries sorted by `at`, kinds in order for a full run; a `what` holding a made-up gate code and a 555 phone number comes out with no run of 4 or more digits; a done note with a dollar amount keeps no amount (strip `$` amounts too); no entry text contains the pro's phone.

- [ ] **Step 2: Run** `npx vitest run test/fixerUrgentVisit.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** `urgentVisitHolds` returns `["not-during-stay"]` alone when `urgentStay` finds none; `spans-checkout` when `window.until` is after `zonedInstant(stay.checkout, checkoutTime ?? "11:00")`; guest holds are one of the four; `urgentAccessCheck` runs the holds first, then door-lock, phone, then the time window. Timeline text uses `formatWhen` for the agreed window and redacts with `joinSplitDigits(text).replace(/\d{4,}/g, "[number removed]")` then `/\$\s?\d[\d,.]*/g` → `"[amount removed]"`.

- [ ] **Step 4: Run** `npx vitest run test/fixerUrgentVisit.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "Add urgent mid-stay visit rules for Fixer Core (#243)"`.

## Wiring (approach 3, chosen in the thread after Tasks 1-3)

Global constraints for Tasks 4-7, from the spec's "Wiring" section:

- Every new tool is strict zod in `tools.ts`, routed in `handleFixerTool`, has a `SAMPLES` entry in `test/fixerTools.test.ts`, and is named in backticks in both `FIXER_CORE_BOOTSTRAP.md` and `muse-template/skills/fixer-core/SKILL.md` (`test/fixerTemplate.test.ts` enforces all three). Add each task's tools to the `extras` list in `fixerTools.test.ts`.
- The guides keep the exact phrase "overlaps a guest stay is never booked".
- Host-facing wording lives in `texts.ts`.
- Desk tests go in `test/fixerBiggerRepairs.test.ts`, built on the `setup()` harness copied from `test/fixerBooking.test.ts` (America/New_York, `NOW` 2026-11-08T15:00Z, stubbed calendar). A calendar block is an event with `SUMMARY:Blocked`.

### Task 4: Repair blocks in the desk

**Files:** Modify `src/fixer-core/store.ts`, `desk.ts`, `texts.ts`, `tools.ts`, both guides; Test `test/fixerBiggerRepairs.test.ts`, `test/fixerTools.test.ts`.

**Interfaces:**
- `store.ts`: `export interface SavedBlock extends RepairBlock { savedAt: string; told?: string[] }`; `FixerFile.repairBlocks?: SavedBlock[]`; `export const MAX_REPAIR_BLOCKS = 10`.
- `desk.ts`: `saveRepairBlock(input: { firstDay?: string; lastDay?: string; jobIds?: string[]; confirmation?: string }): Promise<FixerReply>`; `removeRepairBlock(input: { blockId?: string; confirmation?: string }): Promise<FixerReply>`; private `crewStays(file: FixerFile): Stay[]` = `staysForCrew(hub.stays() ?? [], file.repairBlocks ?? [])`, used by `windowsFor`, `holdsFor`, `staysOver`, `extendVisit`'s overlap check.
- Tools `save_repair_block { firstDay: Ymd, lastDay: Ymd, jobIds?: Id[] (max 10), confirmation? }`, `remove_repair_block { blockId: Id, confirmation? }`. Both take the host's yes even before Activate (use `confirm`, not `approved`), refused while repairs are off.

- [ ] **Step 1: Failing tests:** two calls save a block (`blockId` starts `blk_`, `onCalendar: false`, `openNights` the 5 nights, `next` contains "booking calendar"); refused for bad days, 93 days, an unknown jobId, and an 11th block; a job's booked time inside a saved block that is on the calendar has no `heldFor`, and the same time with no saved block holds `overlaps-stay`; `check_fixes` gives `repair-block-open` news once, and a guest stay inside the block gives one `urgent` `repair-block-collision` news; `get_fixer_state` lists `repairBlocks` with status and `doorNow`; `remove_repair_block` in two calls removes it.
- [ ] **Step 2: Run** `npx vitest run test/fixerBiggerRepairs.test.ts` → FAIL.
- [ ] **Step 3: Implement** as the spec's Wiring section says; news keys `open:<openNights joined>` and `stay:<stayKey>` in `told`, only for blocks whose `lastDay` is today or later.
- [ ] **Step 4: Run** `npx vitest run test/fixerBiggerRepairs.test.ts test/fixerTools.test.ts test/fixerTemplate.test.ts test/fixerBooking.test.ts test/fixerVisit.test.ts` → PASS.
- [ ] **Step 5: Commit.**

### Task 5: Urgent visits in booking and code access

**Interfaces:**
- `store.ts`: `Job.guest?: { asked: string[]; answers: GuestAnswer[] }`; `Booking.urgentStay?: string`.
- `gate.ts`: `AccessRefusal` gains `"guest-not-agreed"`.
- `desk.ts`: `recordGuestAnswer(input: { jobId?: string; answer?: "asked" | "yes" | "no"; from?: string; until?: string; via?: GuestAnswer["via"] }): Promise<FixerReply>`; `urgentTimeline(input: { jobId?: string }): Promise<FixerReply>`.
- Tools `record_guest_answer { jobId, answer: enum, from?: Instant, until?: Instant, via: enum }`, `urgent_timeline { jobId }`.

- [ ] **Step 1: Failing tests** (job `urgency: "now"`, a guest stay over Tuesday): `record_contact` booked in the stay has no `question`, `next` names `record_guest_answer`; `record_guest_answer` yes for a window holding the visit gives the host question ending in the booking question with "It's during the guest's stay, and the guest agreed to this time."; `approve_booking` two calls saves `urgentStay`; the same with urgency `soon` is still refused; a 5-hour visit and one past checkout are refused with their reasons; `revealCode` 10 minutes before the start → `before-visit`, at the start → opened, after a guest "no" → `guest-not-agreed` and one urgent host news; after `extend_visit` past the guest's window, the code is refused after the agreed end; `check_fixes` `held` doesn't list the urgent visit; `urgent_timeline` lists reported → guest-agreed → host-yes → code-shown with no code or phone in its text.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the Task 4 command → PASS. **Step 5: Commit.**

### Task 6: Crew schedules in booking

**Interfaces:** `store.ts`: `Job.crew?: CrewSchedule`. `desk.ts`: `saveCrewSchedule(input: Partial<CrewSchedule> & { jobId?: string; confirmation?: string }): Promise<FixerReply>`. Tool `save_crew_schedule { jobId, firstDay, lastDay, workdays: enum[] (1-7), start, end, skipDays?: Ymd[] (max 31), confirmation? }`.

- [ ] **Step 1: Failing tests:** two calls save it and answer `windows` (count and first) and `conflicts`; refused with a live booking; a booked time that isn't the schedule's span is refused naming the span; the right span gives the host question ending "you'll let them in?"; `approve_booking` with `access: "code"` on a crew job is refused; a guest stay on a workday refuses the booking as an overlap.
- [ ] **Step 2-5:** as Task 5.

### Task 7: Gates doc and whole suite

- [ ] Add an "Urgent visit during a stay" row and a "Repair blocks" row to `docs/fixer-core-safety-gates.md`, each naming tests from Tasks 3-5 by their exact names.
- [ ] `npx tsc --noEmit` → no errors; `npm test` → all pass but the 4 `test/cleanerCoreWiring.test.ts` failures already on `main`.
