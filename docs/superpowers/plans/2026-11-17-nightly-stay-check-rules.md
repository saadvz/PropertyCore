# Nightly Stay Check Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The host's own house rules, and a pure check of one night's events against the booking and those rules, run on sample events, with save/read tools on the shared service behind `STAY_CHECK`.

**Architecture:** A new `src/stay-check/` folder mirrors `src/hours-log/`: a JSON record in the property's folder, a pure `checkNight`, a desk per property, and tools listed by `src/hosted/stayCheck.ts` the way `src/hosted/hours.ts` lists the hours log. Events use a provider-neutral shape; the camera connection fills it later.

**Tech Stack:** TypeScript (ESM), Node ≥ 22.13, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-17-nightly-stay-check-rules-design.md`

## Global Constraints

- Off unless `STAY_CHECK` is exactly `1` or `true`.
- The check never texts anyone and never sends the alert.
- A false flag only raises needed sightings (unset = 1, cap 3); it never raises an allowed number.
- No rule the host didn't give; no checkable rule means the night is skipped.
- Rule text with a run of 4+ digits (also split by spaces, dots or dashes), or that `redactBookingEmail` changes, is refused.
- Limits: 20 rules, text 1–200 chars, one check per kind, `people.max` 1–50, `vehicles.max` 0–20, `noiseLimit` 30–120, times `HH:MM` 24-hour.
- Tests use made-up data only: 555 numbers, no real codes or addresses.
- Copy in the repo's plain style: short sentences, no em dashes.

## Review Focus

- A camera event with no `counts` (Ring's raw label only) must count as nothing, not crash. → Task 2 test `ignores camera events without counts`.
- A quiet window that crosses midnight, with the property in a non-New-York zone, must read event times in the property's zone. → Task 2 test `quiet window across midnight in the property's zone`.
- A stay one night long (check-in night is also the last night) needs both window exceptions at once. → Task 3 test `one-night stay starts at check-in and ends at checkout`.
- A `stay-check.json` that isn't valid JSON must refuse without being overwritten. → Task 1 test `refuses an unreadable record and leaves it`.
- `save_house_rules` with `rules: []` clears the rules and later nights skip. → Task 4 test `an empty list clears the rules`.

---

### Task 1: Rules and the record

**Files:**
- Create: `src/stay-check/rules.ts`, `src/stay-check/store.ts`
- Test: `test/stayCheckRules.test.ts`

**Interfaces:**
- Produces (`rules.ts`): `type CheckKind = "people" | "pets" | "vehicles" | "quiet"`; `const CHECK_KINDS: readonly CheckKind[]`; `type RuleCheck` and `interface HouseRule` exactly as the spec; `MAX_RULES = 20`, `MAX_RULE_TEXT = 200`, `MAX_SIGHTINGS = 3`; `rulesProblem(rules: unknown): string | undefined`; `checkTimeProblem(time: unknown): string | undefined`; `needed(sightings: Partial<Record<CheckKind, number>>, kind: CheckKind): number`; `markFalse(file: StayCheckFile, kind: CheckKind): StayCheckFile` (returns a new object).
- Produces (`store.ts`): `STAY_CHECK_FILE = "stay-check.json"`; `interface StayCheckFile` exactly as the spec; `class StayCheckFileError extends Error`; `readStayCheck(root: string): StayCheckFile` (missing file → `{ rules: [], sightings: {}, allowances: [] }`); `writeStayCheck(root: string, file: StayCheckFile): void` via `writeJsonAtomic`.

- [ ] **Step 1: Write the failing tests** in `test/stayCheckRules.test.ts`:
  - `accepts the host's words with and without checks`: `rulesProblem([{ text: "No more than 6 guests", check: { kind: "people", max: 6 } }, { text: "No smoking" }])` is `undefined`.
  - `refuses a second check of the same kind`: two `vehicles` checks → a string containing `"vehicles"`.
  - `refuses out-of-range values`: `people.max` 0 and 51, `vehicles.max` 21, `noiseLimit` 29 and 121, `start: "25:00"` → each a string.
  - `refuses rule text that may hold a door code`: a lockbox with four made-up digits, the same digits split by a space, and a gate code of three digits (built from parts in the test, so the repo's door-code scan passes) → string; `"Quiet after 10 PM"`, `"6 guests"`, `"Quiet 22:00 to 08:00"` → `undefined`.
  - `refuses more than 20 rules and empty or long text`.
  - `markFalse raises needed sightings to 3 and stops`: from `{}` → people 2, then 3, then 3; `needed({}, "pets")` is 1.
  - `refuses an unreadable record and leaves it`: write `"{not json"` to `stay-check.json`; `readStayCheck` throws `StayCheckFileError`; the file's bytes are unchanged.

- [ ] **Step 2: Run** `npx vitest run test/stayCheckRules.test.ts` — Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `rules.ts` and `store.ts`.** Digit rule: `/\d(?:[\s.-]?\d){3,}/`. Also refuse when `redactBookingEmail(text) !== text` (import from `src/hub/airbnbEmail.ts`). Refusal messages say what to change, e.g. `"Keep door codes out of house rules. Give the rule without the number."`. Read mirrors `readHours` in `src/hours-log/store.ts`.

- [ ] **Step 4: Run** the test file — Expected: PASS. Run `npm run typecheck` — Expected: no errors.

- [ ] **Step 5: Commit** `git add src/stay-check test/stayCheckRules.test.ts && git commit -m "Stay check: house rules and their record (#239)"`

---

### Task 2: Events, the night's check, and the alert text

**Files:**
- Create: `src/stay-check/events.ts`, `src/stay-check/check.ts`, `src/stay-check/alert.ts`
- Create: `test/fixtures/stay-check/` sample event files (JSON arrays of `StayEvent`)
- Test: `test/stayCheckNight.test.ts`

**Interfaces:**
- Consumes: `CheckKind`, `HouseRule`, `RuleCheck`, `needed` from Task 1.
- Produces (`events.ts`): `MediaRef`, `StayEvent` exactly as the spec.
- Produces (`check.ts`):
  ```ts
  interface NightBooking { guests?: number; infants?: number }
  interface NightInput { label: string; rules: HouseRule[]; sightings: Partial<Record<CheckKind, number>>; allow: CheckKind[]; booking?: NightBooking; timeZone: string; window: { from: string; to: string }; events: StayEvent[] }
  interface Flag { kind: CheckKind; rule: string; peak: number; allowed?: number; sightings: number; at: string; device: string; evidence?: MediaRef }
  interface Unchecked { kind: CheckKind; why: string }
  type NightResult = { status: "skipped"; reason: string } | { status: "clean"; unchecked: Unchecked[] } | { status: "flags"; flags: Flag[]; unchecked: Unchecked[]; alert: string; evidence?: MediaRef };
  function checkNight(input: NightInput): NightResult
  ```
  `peak` is the most people/cars in one event, the animal count for pets, and the loudest dB (or 0 when only `loud`) for quiet. `allowed` is absent for pets and quiet. Flags in kind order people, pets, vehicles, quiet.
- Produces (`alert.ts`): `alertText(label: string, flags: Flag[], timeZone: string): string`.

- [ ] **Step 1: Write the failing tests** in `test/stayCheckNight.test.ts`, with `timeZone: "America/New_York"` unless noted and a window of `2026-11-20T21:00:00Z`–`2026-11-21T04:00:00Z`:
  - `no checkable rule is skipped`: rules `[{ text: "No smoking" }]` → `status: "skipped"`.
  - `a clean night`: people max 6, events peaking at 6 → `{ status: "clean", unchecked: [] }`.
  - `most in one event, not a sum`: three events of 4 people, rule max 6 → clean.
  - `more people than booked`: no `max`, booking guests 6, an event of 8 → one flag `{ kind: "people", peak: 8, allowed: 6, sightings: 1 }`.
  - `smaller of max and booked`: max 6, booked 8, event of 7 → flag, `allowed: 6`.
  - `infants add one`: booked 4, infants 1, event of 5 → clean; event of 6 → flag `allowed: 5`.
  - `no guest count leaves a booked-only rule unchecked`: no `max`, no booking → clean with `unchecked: [{ kind: "people", why: <string> }]`.
  - `an animal on a no-pet stay`: pets rule, event `counts.animals: 1` → flag `kind: "pets"`.
  - `cars over the limit`: vehicles max 2, event of 3 → flag.
  - `quiet window across midnight in the property's zone`: `timeZone: "America/Chicago"`, quiet 22:00–07:00, `loud` noise at 03:30Z (21:30 Chicago) → clean; at 05:00Z (23:00 Chicago) → flag `kind: "quiet"`.
  - `noise limit`: limit 70, events at 65 and 75 dB inside quiet hours → flag `peak: 75`.
  - `no noise events leave quiet unchecked`.
  - `needed sightings after false flags`: sightings `{ people: 2 }`, one over-limit event → clean; two → flag `sightings: 2`.
  - `an allowance skips that kind`: `allow: ["pets"]`, animal seen → clean with pets in `unchecked`.
  - `events outside the window are ignored`.
  - `ignores camera events without counts`: an event `{ source: "camera", label: "human" }` only, people max 1 → clean.
  - `evidence is the peak event's clip, else its snapshot`.
  - `the alert names every flag in the property's time`: people 8 of 6 at 02:14Z and an animal at 03:02Z, label `"Lake House"` → `alert` equals `"Tonight at Lake House: 8 people on camera at 9:14 PM, booked for 6. An animal on camera at 10:02 PM, and the house rules say no pets. Clip: Front door camera, 9:14 PM."` (with `device: "Front door"`).

- [ ] **Step 2: Run** `npx vitest run test/stayCheckNight.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Local time-of-day via `zonedParts` from `src/core/timezone.ts`. Quiet window membership: `start <= end ? t >= start && t < end : t >= start || t < end` on `HH:MM` strings. Alert copy per kind, after `"Tonight at {label}: "`:
  - people with `max` only: `"{peak} people on camera at {time}, and the house rules allow {allowed}."`; with booking: `"{peak} people on camera at {time}, booked for {allowed}."`
  - pets: `"An animal on camera at {time}, and the house rules say no pets."` (`"{n} animals"` when peak > 1)
  - vehicles: `"{peak} cars on camera at {time}, and the house rules allow {allowed}."`
  - quiet: `"Noise at {time} during quiet hours ({start} to {end})."` with times through `formatClockTime`.
  - Then `"Clip: {device} camera, {time}."` from the first flag that has evidence; omitted when none. Sentence-case the first word after the colon.

- [ ] **Step 4: Run** the test file — Expected: PASS. `npm run typecheck` — no errors.

- [ ] **Step 5: Commit** `git commit -m "Stay check: the night's check on sample events, and the alert text (#239)"`

---

### Task 3: The desk: which night, which booking, which window

**Files:**
- Modify: `src/hub/bookingEmails.ts` (`EmailStay` gains `infants?: number`; `stayForNight` sets it from `guestBreakdown.infants` when > 0)
- Create: `src/stay-check/desk.ts`
- Test: `test/stayCheckDesk.test.ts`; extend the existing `stayForNight` test file with one infants case

**Interfaces:**
- Consumes: Tasks 1–2; `readHubFile` (`src/hub/store.ts`: `property.timeZone`, `property.checkInTime`, `property.checkoutTime`, `stays`); `stayForNight`; `zonedInstant`, `addCalendarDays` (`src/hub/calendar.ts`).
- Produces:
  ```ts
  interface StayCheckReply { text: string; structured?: Record<string, unknown>; isError: boolean }
  class StayCheckDesk {
    constructor(root: string, deps: { now: () => Date });
    getRules(): StayCheckReply;                                   // structured: { rules, checkTime, allowances } or { rules: [], ask: string }
    saveRules(input: { rules?: unknown; checkTime?: unknown }): StayCheckReply;
    allowForStay(input: { checkIn?: unknown; allow?: unknown }): StayCheckReply;
    runNight(date: string, events: StayEvent[], label: string): NightResult;
    nightWindow(date: string): { from: string; to: string } | undefined; // undefined: no stay or no time zone
  }
  function stayCheckDeskFor(root: string, deps: { now: () => Date }): StayCheckDesk;
  ```

- [ ] **Step 1: Write the failing tests.** Fixture: a temp folder with `hub.json` (`timeZone: "America/New_York"`, `checkInTime: "15:00"`, `checkoutTime: "10:00"`, `stays: [{ checkIn: "2026-11-20", checkout: "2026-11-23", kind: "stay" }]`) and, where needed, a `booking-emails.jsonl` line built like the existing booking email tests do.
  - `skips with no rules`, `skips with no stay that night` (date `2026-11-23`), `skips with no time zone`, `skips a block` (`kind: "block"`).
  - `the window runs check time to check time`: night `2026-11-21`, default 23:00 → from `2026-11-21T04:00:00.000Z` to `2026-11-22T04:00:00.000Z`.
  - `check-in night starts at check-in`: night `2026-11-20` → from `2026-11-20T20:00:00.000Z` (hub 15:00); with an email `checkInTime` of `"16:30"` → `2026-11-20T21:30:00.000Z`.
  - `the last night ends at checkout`: night `2026-11-22` → to `2026-11-23T15:00:00.000Z` (hub 10:00).
  - `one-night stay starts at check-in and ends at checkout`: stay 20th–21st, night 20th → from 15:00 local on the 20th to 10:00 local on the 21st.
  - `a check time before noon belongs to the night before`: `checkTime: "02:00"`, night `2026-11-21` → to `2026-11-22T07:00:00.000Z`.
  - `the booking's guests and infants reach the check`: email with 2 adults, 1 infant; booked-only people rule; event of 3 → clean; 4 → flag `allowed: 3`.
  - `getRules asks with examples when none are saved`: `structured.ask` contains `"No more than 6 guests"` and `"No pets"`.
  - `allowForStay saves and removes`: `allow: ["pets"]` then `allow: []`.
  - In the `stayForNight` test file: `stayForNight carries infants`.

- [ ] **Step 2: Run** `npx vitest run test/stayCheckDesk.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Run instant for night `d`: `zonedInstant(time < "12:00" ? addCalendarDays(d, 1) : d, time, tz)`. `from` = check-in night ? check-in instant : run instant of `d - 1`; `to` = last night (`addCalendarDays(d, 1) === stay.checkout`) ? checkout instant on checkout day : run instant of `d`. Check-in time: email `checkInTime` ?? hub `checkInTime` ?? `"16:00"`; checkout: email ?? hub ?? `"11:00"`. Allowances match on the calendar stay's `checkIn`. Writes go through `readStayCheck`/`writeStayCheck`; a `StayCheckFileError` becomes `{ text: error.message, isError: true }` as in `HoursDesk.guarded`.

- [ ] **Step 4: Run** the desk and booking email tests — Expected: PASS. `npm run typecheck`.

- [ ] **Step 5: Commit** `git commit -m "Stay check: the desk picks the night, the booking and the window (#239)"`

---

### Task 4: Tools on the shared service, behind STAY_CHECK

**Files:**
- Create: `src/stay-check/tools.ts`, `src/hosted/stayCheck.ts`
- Modify: `src/cleaner-core/flag.ts` (add `stayCheckOn(env = process.env): boolean`), `src/hosted/frontMcp.ts` (list after the hours tools; dispatch like `HOURS_FRONT_NAMES`), `docs/environment-variables.md` (a `STAY_CHECK` row beside `HOURS_LOG`)
- Test: `test/stayCheckHosted.test.ts`

**Interfaces:**
- Consumes: `StayCheckDesk` (Task 3); `resolveProperty`, `withPropertyArg` (`src/hosted/propertyTools.ts`); `propertyFolder`.
- Produces: `STAY_CHECK_TOOLS` (`get_house_rules`, `save_house_rules`, `allow_for_stay`), `STAY_CHECK_TOOL_NAMES`, `handleStayCheckTool(desk, name, args): StayCheckReply | undefined`; `listedStayCheckFront(h, tenant)`, `stayCheckCall(h, tenant, property, name, args)`, `STAY_CHECK_FRONT_NAMES`.

- [ ] **Step 1: Write the failing tests**, modeled on `test/hoursHosted.test.ts` (same harness, `SUPPLY_CORE: "1"`, one property with supplies on and a `hub.json`):
  - `isn't listed or answered without STAY_CHECK`.
  - `is listed with STAY_CHECK=1, saves and reads the host's rules`: save `[{ text: "No more than 6 guests", check: { kind: "people", max: 6 } }, { text: "No smoking" }]` with `checkTime: "22:30"`; `get_house_rules` returns them; `readStayCheck(root).rules` has 2.
  - `refuses a rule with a door code, and keeps the saved rules`.
  - `an empty list clears the rules`.
  - `allow_for_stay takes a check-in date and kinds`.

- [ ] **Step 2: Run** `npx vitest run test/stayCheckHosted.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement.** Tool descriptions carry the spec's guidance: `get_house_rules` says to ask in the host's own words with the five examples, and to read back each rule the cameras can watch before saving its `check`; `save_house_rules` says `rules` replaces the list, a `check` only after the host agreed to the read-back, other rules as text only, and that nothing is sent to anyone; `allow_for_stay` says only after the host says so. Input schemas spell out `RuleCheck` as a `oneOf` by `kind`. Env doc row: off unless `1` or `true`; lists the three tools; `stay-check.json` holds the rules, check time, allowances and needed sightings; it texts nobody; events and alerts come with the camera connection and #250.

- [ ] **Step 4: Run** the hosted test, then the full suite `npm test` and `npm run typecheck` — Expected: all PASS.

- [ ] **Step 5: Commit** `git commit -m "Stay check: house rules tools on the shared service, behind STAY_CHECK (#239)"`
