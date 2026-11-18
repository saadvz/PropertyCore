# Remote Oversight: Expected Visits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expected visits saved from what the host says or a calendar invite, and a pure same-day check of one day's entry events against them, run on sample events, with add/list/cancel tools on the shared service behind `REMOTE_OVERSIGHT`.

**Architecture:** A new `src/oversight/` folder mirrors `src/stay-check/`: a JSON record in the property's folder, an invite reader, a pure `checkDay`, a desk per property, and tools listed by `src/hosted/oversight.ts` the way `src/hosted/stayCheck.ts` lists the house rules. Entry events use their own provider-neutral shape inside the folder; #180 fills it later.

**Tech Stack:** TypeScript (ESM), Node ≥ 22.13, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-17-remote-oversight-expected-visits-design.md`

## Global Constraints

- Off unless `REMOTE_OVERSIGHT` is exactly `1` or `true`.
- The check never texts anyone and never sends the alert. It returns the alert text.
- No visit the host didn't give. From an invite, nothing is saved without `confirm: true`.
- `who` and `note` refuse text with a run of 4+ digits (also split by spaces, dots or dashes; clock times like 22:00 aside) or text `redactBookingEmail` changes. The refusal names the field, never repeats the text.
- Limits: `who` 1–60 chars, `note` 1–200 chars, times `HH:MM` 24-hour with `to` after `from` (both or neither), 50 open visits per property.
- Counting window: 30 minutes before `from` to 1 hour after `to`, never past local midnight; all-day counts the whole local day. Flag time: 1 hour after `to`, capped at 23:59; all-day at 20:00.
- No guessed pronouns in any copy. Plain style: short sentences, no em dashes.
- Tests use made-up data only: 555 numbers, no real codes or addresses.

## Review Focus

- An entry event whose `person` differs only in case or spacing ("mike  doyle") must still match "Mike Doyle". → Task 3 test `matches names ignoring case and spacing`.
- A property outside New York (America/Los_Angeles) must read windows and entry times in its own zone. → Task 3 test `reads the day in the property's zone`.
- An invite whose `SUMMARY` holds a code must still save, with the title left out and never echoed. → Task 2 test `leaves out a title that may hold a code`.
- `oversight.json` that isn't valid JSON must refuse every desk call without being written over, including `runDay`. → Task 4 test `refuses an unreadable record and leaves it`.
- Running the same day twice must not put an already flagged visit in the second alert. → Task 4 test `a second run leaves already flagged visits out of the alert`.

---

### Task 1: The shared code-text rule, visits and the record

**Files:**
- Create: `src/hub/codeText.ts`, `src/oversight/visits.ts`, `src/oversight/store.ts`, `src/oversight/events.ts`
- Modify: `src/stay-check/rules.ts` (use `mayHoldCode`; behavior unchanged)
- Test: `test/oversightVisits.test.ts` (new); `test/stayCheckRules.test.ts` must stay green

**Interfaces:**
- Produces:
  - `mayHoldCode(text: string): boolean` in `src/hub/codeText.ts` (the long-number scan with clock times removed, or `redactBookingEmail(text) !== text`).
  - `interface EntryEvent { id: string; at: string; device: string; person?: string; method?: string }` in `events.ts`.
  - In `visits.ts`: `interface ExpectedVisit` exactly as the spec (with `flaggedAt?`); `type VisitInput = { who: string; date: string; from?: string; to?: string; note?: string }`; `MAX_WHO = 60`, `MAX_NOTE = 200`, `MAX_OPEN_VISITS = 50`; `visitProblem(input: unknown, today: string): string | undefined`; `cleanVisit(input: VisitInput): VisitInput` (trimmed, known fields only); `sameVisit(a: VisitInput, b: VisitInput): boolean` (same normalized who, date, from, to); `whoMatches(expected: string, person: string): boolean`; `newVisitId(): string` (`"v-"` + 8 hex from `randomBytes(4)`).
  - In `store.ts`: `OVERSIGHT_FILE = "oversight.json"`, `interface OversightFile { visits: ExpectedVisit[] }`, `class OversightFileError extends Error`, `readOversight(root): OversightFile` (missing file is `{ visits: [] }`), `writeOversight(root, file): void` via `writeJsonAtomic`.

- [ ] **Step 1: Write the failing tests** in `test/oversightVisits.test.ts`:
  - `accepts a timed visit and an all-day visit`: `visitProblem({ who: "Mike Doyle", date: "2026-11-19", from: "13:00", to: "17:00", note: "walk-through" }, "2026-11-17")` and `{ who: "Mike", date: "2026-11-17" }` are `undefined`.
  - `refuses a past date`: date `2026-11-16` with today `2026-11-17` returns a string containing "today or later".
  - `refuses a half window or a backwards one`: only `from`; `from: "17:00", to: "13:00"`; `from: "25:00"` each return a string.
  - `refuses codes in who and note without repeating them`: note `"door 6150"` and who `"Mike 61-50"` return a string that names the field ("note"/"who") and does not contain `6150`; note `"Quiet 22:00-07:00 check"` passes.
  - `checks lengths`: who of 61 chars, note of 201 chars, empty who are refused.
  - `matches names ignoring case and spacing`: `whoMatches("Mike Doyle", "mike  doyle")`, `whoMatches("Mike", "Mike Doyle")`, `whoMatches("Mike Doyle", "Mike")` are true; `whoMatches("Mike Doyle", "Sam Ortiz")` and `whoMatches("Mike Doyle", "Mike Ortiz")` are false.
  - `sameVisit` true for `{who:"Mike", date, from, to}` vs `{who:" mike ", ...}`; false when `to` differs.
  - `refuses an unreadable record and leaves it`: write `"{nope"` to `oversight.json` in a temp dir; `readOversight` throws `OversightFileError`; the file content is still `"{nope"`.
- [ ] **Step 2: Run** `npx vitest run test/oversightVisits.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the files above. `whoMatches`: lowercase, collapse whitespace, trim; true when equal, or when the shorter has one word and equals the longer's first word. Move `LONG_NUMBER`/`CLOCK_TIME` from `stay-check/rules.ts` into `codeText.ts`, and have `rulesProblem` call `mayHoldCode`.
- [ ] **Step 4: Run** `npx vitest run test/oversightVisits.test.ts test/stayCheckRules.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `Oversight: expected visits, the record and the shared code-text rule (#240)`.

### Task 2: Reading a calendar invite

**Files:**
- Create: `src/oversight/invite.ts`, `test/fixtures/oversight/*.ics`
- Test: `test/oversightInvite.test.ts`

**Interfaces:**
- Consumes: `mayHoldCode`, `MAX_NOTE`, `MAX_WHO`.
- Produces: `type InviteRead = { ok: true; visit: Partial<VisitInput> & { date: string }; titleLeftOut?: true } | { ok: false; reason: string }` and `visitFromInvite(ics: string, timeZone: string): InviteRead`.

- [ ] **Step 1: Write fixtures and failing tests.** Fixtures (made-up organizer `Mike Doyle`, `mailto:mike@example.com`): `timed-tzid.ics` (`DTSTART;TZID=America/Chicago:20261119T120000`, `DTEND;TZID=America/Chicago:20261119T160000`, `SUMMARY:Walk-through`), `timed-utc.ics` (`20261119T180000Z`–`20261119T220000Z`), `all-day.ics` (`DTSTART;VALUE=DATE:20261120`, `DTEND;VALUE=DATE:20261121`), `cancelled.ics` (STATUS:CANCELLED only), `multi-day.ics` (Nov 19 10:00 to Nov 20 10:00), `windows-zone.ics` (`TZID=Eastern Standard Time`), `repeating.ics` (`RRULE:FREQ=WEEKLY`), `code-title.ics` (`SUMMARY:Door 6150 check`), `floating.ics` (`DTSTART:20261119T090000`, `DTEND:20261119T100000`, no organizer). Tests with property zone `America/New_York`:
  - `reads a TZID invite in the property's zone`: timed-tzid → `{ who: "Mike Doyle", date: "2026-11-19", from: "13:00", to: "17:00", note: "Walk-through" }`.
  - `converts a UTC invite`: timed-utc → `from: "13:00", to: "17:00"`.
  - `reads an all-day invite`: → `{ date: "2026-11-20" }` with no `from`/`to`.
  - `takes a floating time as local and leaves who unset`: floating → `from: "09:00", to: "10:00"`, `who` undefined.
  - `refuses` cancelled, multi-day, windows-zone and repeating, each with `ok: false` and a reason (windows-zone's reason contains "time zone"; repeating's contains "repeat").
  - `leaves out a title that may hold a code`: code-title → `ok: true`, no `note`, `titleLeftOut: true`, and `JSON.stringify(result)` does not contain `6150`.
  - `reads the day in the property's zone`: timed-utc with `America/Los_Angeles` → `from: "10:00", to: "14:00"`.
- [ ] **Step 2: Run** `npx vitest run test/oversightInvite.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `visitFromInvite`.** Unfold lines like `src/hub/calendar.ts`. Skip `STATUS:CANCELLED` events; refuse `RRULE`, `RDATE` or `RECURRENCE-ID`. Timed instants: `Z` as UTC; IANA `TZID` (checked with `isValidTimeZone`) via `zonedInstant` in that zone; any other `TZID` refused; floating is local to the property. Convert to the property's local date and `HH:MM`. Start and end must fall on one local date (an end of exactly 00:00 the next day becomes `23:59`); no `DTEND` is refused. All-day: `DTEND` absent or the next date. `ORGANIZER` `CN` (quotes stripped) is `who` unless over `MAX_WHO` or `mayHoldCode`. `SUMMARY` unescaped (`\,` `\;` `\n`), trimmed, cut to `MAX_NOTE`; left out with `titleLeftOut` when `mayHoldCode`. Never read `DESCRIPTION`, `LOCATION` or `ATTENDEE`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `Oversight: read an expected visit from a calendar invite (#240)`.

### Task 3: The same-day check and the alert

**Files:**
- Create: `src/oversight/check.ts`, `src/oversight/alert.ts`, `test/fixtures/oversight/entries.json`
- Test: `test/oversightCheck.test.ts`

**Interfaces:**
- Consumes: `ExpectedVisit`, `EntryEvent`, `whoMatches`; `zonedInstant`, `addCalendarDays` from `src/hub/calendar.ts`; `formatVisitorClock` from `src/core/timezone.ts`.
- Produces:
  - `interface VisitResult { id: string; who: string; date: string; from?: string; to?: string; note?: string; outcome: "came" | "waiting" | "missed"; flagAt: string; entry?: { at: string; device: string; person?: string; unnamed?: true }; late?: true; alreadyFlagged?: true; others: { at: string; person: string }[] }`
  - `type DayResult = { status: "none"; reason: string } | { status: "ok"; visits: VisitResult[] } | { status: "flags"; visits: VisitResult[]; missed: VisitResult[]; alert?: string }`
  - `checkDay(input: { label: string; visits: ExpectedVisit[]; entries: EntryEvent[]; date: string; timeZone: string; now: Date }): DayResult`
  - `alertText(label: string, missed: VisitResult[], timeZone: string): string`

- [ ] **Step 1: Write failing tests** (zone `America/New_York`, date `2026-11-19`, visit Mike Doyle 13:00–17:00 "walk-through", label "Lake House"):
  - `came`: entry by "Mike Doyle" at 14:10 local → `outcome: "came"`, `entry.person` "Mike Doyle"; status `ok`.
  - `waiting before the flag time`: no entries, now 17:30 local → `waiting`, `flagAt` is 18:00 local as ISO.
  - `missed after the flag time`: now 18:01 → status `flags`, `alert` equals `"Today at Lake House: Mike Doyle was expected between 1 PM and 5 PM (walk-through). No one came in by 6 PM."`
  - `counts 30 minutes early and 1 hour late`: entries at 12:30 and 18:00 each count; 12:29 does not (now 18:01 → missed).
  - `all-day visits flag at 8 PM`: all-day visit, now 19:59 → `waiting`; now 20:01 → missed, alert `"Today at Lake House: Mike Doyle was expected today. No one came in by 8 PM."`
  - `an unnamed entry counts and is marked`: entry with no person at 14:00 → came with `entry.unnamed: true`.
  - `someone else's entry doesn't count and is named in the alert`: entry by "Sam Ortiz" at 14:10, now 18:01 → missed, `others` has Sam, alert ends `"The door was opened at 2:10 PM by Sam Ortiz."`
  - `a late arrival before midnight turns missed into came late`: entry by Mike at 21:00 → `came`, `late: true`; entry at 00:05 the next day → still missed.
  - `cancelled visits and other days aren't checked`: only a cancelled visit, or a visit on 2026-11-20 → status `none`.
  - `already flagged visits stay out of the alert`: visit with `flaggedAt` set, missed → status `flags`, `missed[0].alreadyFlagged` true, `alert` undefined; with a second, new missed visit the alert holds only the new one.
  - `matches names ignoring case and spacing`: entry person "mike  doyle" counts.
  - `reads the day in the property's zone`: zone `America/Los_Angeles`, entry at `2026-11-19T22:10:00Z` (2:10 PM Pacific) counts for 13:00–17:00.
  - `a window ending near midnight flags by 23:59`: visit 22:30–23:30, `flagAt` is 23:59 local.
- [ ] **Step 2: Run** `npx vitest run test/oversightCheck.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per the spec and Global Constraints. First matching entry in time order from window start to local midnight wins; `late` when it is after `flagAt`. `others` are entries in the counting window whose `person` is set and doesn't match. Sort `visits` by `from` (all-day first), then `who`. Alert: `Today at ${label}: ` + one sentence pair per new missed visit, joined by spaces; times via `formatVisitorClock`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `Oversight: the same-day check and its alert (#240)`.

### Task 4: The desk

**Files:**
- Create: `src/oversight/desk.ts`
- Test: `test/oversightDesk.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `readHubFile` from `src/hub/store.ts`; `localDateOf` from `src/core/timezone.ts`.
- Produces: `interface OversightReply { text: string; structured?: Record<string, unknown>; isError: boolean }`; `class OversightDesk` with `addVisit(input: { who?: unknown; date?: unknown; from?: unknown; to?: unknown; note?: unknown; invite?: unknown; confirm?: unknown }): OversightReply`, `listVisits(): OversightReply`, `cancelVisit(input: { id?: unknown }): OversightReply`, `runDay(date: string, entries: EntryEvent[], label: string): DayResult`; `oversightDeskFor(root: string, deps: { now: () => Date }): OversightDesk`.

- [ ] **Step 1: Write failing tests** over a temp folder with `hub.json` (`property: { nickname: "Lake House", timeZone: "America/New_York" }`, `calendars: []`, `stays: []`), now `2026-11-17T15:00:00Z`:
  - `adds a visit from a text and lists it`: `structured.saved` true, id matches `/^v-[0-9a-f]{8}$/`, `source: "text"`; `listVisits().structured.open` has it.
  - `saving the same visit again returns the existing one`: `duplicate: true`, same id, one visit on file.
  - `an invite is read back first and saved with confirm`: `invite` from `timed-tzid.ics` without `confirm` → `saved: false`, the visit, nothing written; with `confirm: true` → saved with `source: "invite"`.
  - `an invite with no organizer needs who`: floating.ics → error mentioning "who"; with `who: "Mike"` and `confirm: true` → saved.
  - `refuses an invite with details`: `invite` plus `date` → error.
  - `refuses without a time zone`: hub without `timeZone` → `addVisit` is an error mentioning "time zone".
  - `refuses past the open limit`: 50 open visits on file → the 51st is refused.
  - `cancels a visit`: `cancelVisit({ id })` sets `cancelledAt`; listing no longer shows it as open; unknown id is an error.
  - `refuses an unreadable record and leaves it`: `oversight.json` = `"{nope"` → `addVisit`, `listVisits`, `cancelVisit` are errors, `runDay` is `status: "none"` with the reason; the file is unchanged.
  - `runDay records flaggedAt once`: missed visit → result `flags` with an alert; `flaggedAt` saved as now.
  - `a second run leaves already flagged visits out of the alert`: run again → `flags`, no `alert`, `flaggedAt` unchanged.
- [ ] **Step 2: Run** `npx vitest run test/oversightDesk.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Mirror `StayCheckDesk`'s `guarded`/`ok`/`fail`. Today is `localDateOf(now, timeZone)`. `listVisits` returns `{ open, recent }`: `open` not cancelled with date ≥ today, sorted; `recent` the last 7 days before today, with `flaggedAt`/`cancelledAt`. Each reply says nothing is sent to anyone.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `Oversight: one property's desk for expected visits (#240)`.

### Task 5: Tools on the shared service

**Files:**
- Create: `src/oversight/tools.ts`, `src/hosted/oversight.ts`
- Modify: `src/cleaner-core/flag.ts` (add `remoteOversightOn`), `src/hosted/frontMcp.ts` (list and route, next to the stay check), `docs/environment-variables.md` (a `REMOTE_OVERSIGHT` row after `STAY_CHECK`)
- Test: `test/oversightHosted.test.ts`

**Interfaces:**
- Consumes: `OversightDesk`, `oversightDeskFor`.
- Produces: `OVERSIGHT_TOOLS`, `OVERSIGHT_TOOL_NAMES`, `handleOversightTool(desk, name, args): OversightReply | undefined`; `OVERSIGHT_FRONT_NAMES`, `listedOversightFront(h, tenant)`, `oversightCall(h, tenant, property, name, args): FrontReply`; `remoteOversightOn(env): boolean`.

- [ ] **Step 1: Write failing tests** modeled on `test/stayCheckHosted.test.ts` (same harness, lane `+15555550152`):
  - `isn't listed or answered without REMOTE_OVERSIGHT`: none of `add_expected_visit`, `list_expected_visits`, `cancel_expected_visit` listed; a call is an error.
  - `is listed with REMOTE_OVERSIGHT=1, adds, lists and cancels`: add Mike for `2026-11-19` 13:00–17:00 with `property`; list shows it; cancel by id; `readOversight(root).visits[0].cancelledAt` set.
  - `tools describe the read-back`: `add_expected_visit`'s description contains "read" and "back" and "never".
- [ ] **Step 2: Run** `npx vitest run test/oversightHosted.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Tool schemas: `add_expected_visit` properties `who` (string, max 60), `date` (`^\d{4}-\d{2}-\d{2}$`), `from`/`to` (24-hour clock pattern), `note` (max 200), `invite` (string, max 20000), `confirm` (boolean); `list_expected_visits` no properties; `cancel_expected_visit` `id` required. Descriptions: read the visit back to the host and save only after they agree; never create a visit the host didn't give; loose words get the suggested windows (morning 08:00–12:00, afternoon 12:00–17:00, evening 17:00–20:00); nothing is sent to anyone. Gate like `src/hosted/stayCheck.ts` (flag on and any flow on).
- [ ] **Step 4: Run** the test, then `npm run typecheck`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `Oversight: expected visit tools on the shared service behind REMOTE_OVERSIGHT (#240)`.

### Task 6: Whole-branch verification

- [ ] **Step 1: Run** `npm run typecheck && npm run build && npm test`. Expected: all pass (record the file and test counts for the PR).
- [ ] **Step 2: Fix** anything a repo-wide test flags (docs tests, tool lists), then re-run only what failed.
- [ ] **Step 3: Commit** any fixes.
