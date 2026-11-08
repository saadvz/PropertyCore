# Fixer Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host's Grok Bot or Muse finds a pro for a repair or upkeep, books them between stays with the host's yes, lets them in for that visit only, and logs the done photos and the cost. Builds saadvz/PropertyCore#170 to #174.

**Architecture:** A new module `src/fixer-core/` holds pure helpers (`window.ts`, `gate.ts`), the record (`store.ts`, one `fixer.json` per property folder), copy (`texts.ts`), setup asks (`setupAsk.ts`), the desk that runs every tool and the clock pass (`desk.ts`), the visit page (`visitPage.ts`), pro texts on the line (`proLine.ts`) and the MCP tool table (`tools.ts`). The hosted layer (`src/hosted/fixer.ts`) opens one desk per property, lists the tools for Grok and Muse only, answers them in-process, routes the visit page and pro texts, and runs the clock pass on the service tick, all behind `FIXER_CORE=1`. The hub gains merged stays, `people.json` gains the `pro` role, and Cleaner Core gains the repair question after DONE (Decision 8).

**Tech Stack:** TypeScript (Node 22), vitest, zod 4.

**Spec:** `docs/superpowers/specs/2026-11-07-fixer-core-design.md` and `docs/fixer-core-safety-gates.md`. Issue comments on #170 to #174 add nothing beyond the spec's 12 decisions.

## Global Constraints

- Fixer Core never pays, never takes a card, and no tool or page field is for payment. Every tool schema is `.strict()`, and every tool input and visit page text field passes `refuseCards` (`src/hub/cards.ts`) before anything is saved or logged.
- No tool reply, log line, file other than `door-access.json`, or link ever holds the door code. The code leaves only through `hub.doorAccess(env).request({ person, window, purpose: "repair" })`, and only to the pro's own phone by text or on the visit page.
- Tests use only 555 numbers, made-up codes from Scratch, `example.com` addresses, made-up pros and networks. No test sends a real text, call or email. Calendar reads are stubbed.
- Trades: `plumbing`, `hvac`, `electrical`, `handyman`, `gutters`, `pest-control`, `appliance`, `locksmith`. No backup cleaning (Decision 1).
- Bounds: `costLineCents` 100 to 500_000 (optional); `checkInBufferMinutes` 0 to 240, default 60; `cleaningMinutes` 30 to 480, default 180; pros up to 60; upkeep up to 30, `what` under 120 characters, `leadDays` 0 to 60, default 14; job `what` under 300 characters; candidates up to 8 per job; `priceText` under 60 characters; visit photos up to 10, 5 MB each; estimates and costs 0 to 2_000_000 cents.
- Ids: pro `pro_` + 10 of `[a-z0-9]`; job `job_` + 10; upkeep `upk_` + 8; candidate `cand_` + 8; contact `con_` + 8. Tokens (`contactToken`, visit) are letters only.
- Times: contact unconfirmed after 2 hours; `waiting` follow-up default 24 hours; door code from 30 minutes before `from` to `until` (or `extendedUntil`); visit page address from 24 hours before `from`; visit page at most 30 requests an hour per link; approvals last 10 minutes; a raised price is "a lot more" when over 120% of the estimate.
- Windows: between checkout (`checkoutTime`, default `11:00`) and the next check-in (`checkInTime`, default `16:00`) minus `checkInBufferMinutes`; blocks count as occupied; latest date is `byDate`, else 14 days for `now` and `soon`, 30 for `flexible`.
- Exact copy (all in `src/fixer-core/texts.ts`, one constant or function each, so a design pass can swap them):
  - Host go question: `{What} ({photo from {Name}}). Want me to call {Pro}?`, or `... Want me to find someone?` with no preferred pro.
  - Booking question: `{Pro} can come {Weekday} {from} to {until}, about {$est}. Book it and let them in with the door code?`, with `about {$est}` left out when there is no estimate, and `let them in with the door code?` replaced by `you'll let them in?` for `access: "host"`.
  - Raised price: `{Pro} says the fix is {$new}, not {$old}. Go ahead?`
  - Reveal news: `{Pro} opened the door code at {h:mm}.`
  - Preferred question: `Add {Pro} to your preferred list for {trade}?`
  - Rotation question: `{Pro} knows the door code. Want to change it? Set the new code on the lock, then save it here.`
  - Code text: `Hi {first name}, the door code for {street} is {code}, at {lock location}. Reply DONE with photos when you finish.` (`, at {lock location}` left out when none is saved).
  - Pro invite (design pass): `Hi {first name}, this is {business} for repair visits at {street}. Reply YES to get visit details by text, or STOP to opt out.`
  - Cleaner DONE text (design pass, Decision 8): repair only `Thanks, cleaning marked done. Anything broken? Reply with what, or NONE.`; with supplies too `Thanks, cleaning marked done. Anything running low or broken? Reply with what, or NONE.` These two live in `src/cleaner-core/cleanerTexts.ts` as `REPAIR_DONE_ASK` and `SUPPLY_REPAIR_DONE_ASK`.
  - Plain chat: `Fixer Core works with Grok Bot and Muse for now: they find, call and book pros themselves. In this chat, Cleaner Core works without Fixer Core.`
- `FIXER_CORE=1` (`fixerCoreOn(env)` in `src/cleaner-core/flag.ts`) lets `set_flows` turn `fixer` on. Without it `FIXER_NOT_YET` stays, and nothing about any property changes. Fixer Core's tools are listed only for `grok` and `muse`.
- `docs/cleaner-core-safety-gates.md` and `docs/supply-core-safety-gates.md` stay green. A property with Fixer Core off behaves exactly as today.
- Run one file with `npx vitest run <file>`. The full gate is `scripts/ci-check.sh`, then `scripts/ci-proofs.sh`.

## Review Focus

1. **A pro who is also the property's cleaner texts the line.** Expect: the text goes to Cleaner Core as today (their cleaner role wins), and Fixer Core reaches them by the visit page only, never by its own text path. Test in Task 10.
2. **Cleaner Core's `save_people` after pros were saved.** Expect: the pros stay on the property in `people.json`; Cleaner Core's save only replaces its own roles. Test in Task 1.
3. **The host's yes arrives after the pro's offered time has passed or the stays changed.** Expect: `approve_booking` with the code runs the window check again and refuses with a plain reason; nothing is booked. Test in Task 7.
4. **A restart between the tick marking the code text sent and the send.** Expect: no second code text; the host gets one note that the text may not have gone out. Test in Task 8.
5. **A visit link opened from a second device or a link preview bot.** Expect: GET shows no code; only the POST behind "I'm at the door" inside the visit shows it, and each reveal is told to the host. Test in Task 9.

---

### Task 1: Hub groundwork: pros in `people.json`, merged stays, photo copy, the flag

**Files:**
- Modify: `src/hub/people.ts`, `src/hub/store.ts`, `src/hub/calendar.ts`, `src/hub/sources.ts`, `src/hub/hub.ts`, `src/cleaner-core/photos.ts`, `src/cleaner-core/flag.ts`, `src/hosted/sharedPeople.ts` (draftPeople skips `pro`)
- Test: `test/hubPros.test.ts`, `test/hubStays.test.ts`

**Interfaces:**
- Produces:
  - `type Role = "cleaner" | "co-host" | "assistant" | "observer" | "pro"`. A person's `where` may hold one entry per (property, role).
  - `People.savePropertyPeople(...)` keeps every `pro` entry; it replaces only non-pro roles. `roleOn` returns the first non-pro role, else `"pro"`.
  - `People.rolesOn(phone, propertyId): Role[]`
  - `People.saveRolePeople(propertyId: string, role: "pro", people: { phone: string; name?: string }[]): void` (replaces exactly that role's entries on that property)
  - `interface Stay { checkIn: string; checkout: string; kind: "stay" | "block" }` (local `YYYY-MM-DD`), `HubFile.stays?: Stay[]`, `Hub.stays(): Stay[] | undefined` (from the last clean read; kept after a failed read)
  - `FeedBlock` gains `checkInDate?: string; checkoutDate?: string`; Google `blocks` get the same.
  - `copyPhotos(root: string, fromId: string, toId: string): number` in `photos.ts`
  - `fixerCoreOn(env?: NodeJS.ProcessEnv): boolean` (`FIXER_CORE`)

- [ ] **Step 1: Write the failing tests.** `test/hubPros.test.ts`: `saveRolePeople("prp_…", "pro", [{ phone: "+15555550111", name: "Joe" }])` then `savePropertyPeople` with only a cleaner keeps Joe as `pro`; a phone saved as cleaner and as pro gets `rolesOn → ["cleaner", "pro"]` and `roleOn → "cleaner"`; `saveRolePeople` with `[]` removes only the pro entry; STOP on a pro covers both properties (`stop().properties` lists both); `draftPeople` leaves out a person who is only a pro. `test/hubStays.test.ts`: two stubbed iCal feeds (one with a block event) → `hub.stays()` merged, sorted by `checkIn`, the block as `kind: "block"` with its dates; a failed read keeps the last stays; Google events' blocks carry dates.
- [ ] **Step 2: Run them** (`npx vitest run test/hubPros.test.ts test/hubStays.test.ts`). Expect FAIL.
- [ ] **Step 3: Implement.** In `readCalendars`, build `stays` from every stay event (check-in date of the departing stay and its checkout) and every block, de-duplicated by `checkIn|checkout|kind`, alongside `checkouts`, only when every calendar read. `copyPhotos` copies files in order while the target has room.
- [ ] **Step 4: Run them, plus `test/sharedPeople*.test.ts`, `test/hub*.test.ts`.** Expect PASS.
- [ ] **Step 5: Commit** `feat(hub): pros in people.json and merged stays for Fixer Core (#170, #171)`.

### Task 2: `store.ts` and `texts.ts`

**Files:**
- Create: `src/fixer-core/store.ts`, `src/fixer-core/texts.ts`
- Test: `test/fixerStore.test.ts`

**Interfaces:**
- Produces (types exactly as the spec's Part 2, plus):
  - `TRADES: readonly Trade[]`, `isTrade(v): v is Trade`
  - `Job` adds `doorLock?: true` (a locksmith job on the lock the code opens), `photos: PhotoRef[]` where `PhotoRef = { id: string; from: "cleaner" | "pro"; at: string }` and `id` is the photo store key `fixer:<jobId>`, `preferredAsked?: { at; answer?: "yes" | "no" }`, `rotationAsked?: { at; answer?: "yes" | "no" }`, `codeTextAt?: string`, `codeNoteAt?: string`, `cleared?: string` (local date the host said guests left)
  - `Booking` adds `fingerprint: string`, `cleaningOrder?: "before" | "after"`
  - `Contact.token` is a letters-only string; `Contact` adds `cancelled?: true`
  - `FixerSettings` as the spec; `FixerFile = { settings; setup: { prosDone?: true; costAsked?: true; cleanerAsked?: true; upkeepDone?: true }; pros; upkeep; jobs; offAt?: string }`
  - `emptyFixer()`, `readFixer(root)`, `writeFixer(root, file)`, `FIXER_FILE = "fixer.json"`, `fixerAskOn(root): boolean` (activated, not off, `askCleaner`)
  - `newId(prefix, length)`, `letterToken(bytes = 32): string` (letters a to p), `tokenHash(token): string` (sha256 hex)
  - `texts.ts`: one export per Global Constraints copy line, as functions of their fields, plus `dollars(cents)`.

- [ ] **Step 1: Failing tests:** `readFixer` of a missing file is `emptyFixer()` with defaults 60 and 180; a partial file is filled in; `writeFixer` → `readFixer` round-trips; `fixerAskOn` false until activated, false when `offAt`; `letterToken()` matches `/^[a-p]{64}$/`; each text function gives the exact copy above for a sample.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(fixer-core): the fixer.json record and copy (#170, #171)`.

### Task 3: `window.ts`, the visit windows

**Files:**
- Create: `src/fixer-core/window.ts`
- Test: `test/fixerWindow.test.ts`

**Interfaces:**
- Consumes: `Stay` (Task 1), `zonedInstant` and `addCalendarDays` from `src/hub/calendar.ts`.
- Produces:
  - `interface WindowInput { stays: readonly Stay[]; timeZone: string; checkoutTime?: string; checkInTime?: string; checkInBufferMinutes: number; cleaningMinutes: number; cleanings: ReadonlyMap<string, { doneAt?: string }>; cleaningOrder?: "before" | "after"; now: Date; lastYmd: string }`
  - `interface VisitWindow { from: string; until: string; checkoutYmd?: string; cleaning?: { order?: "before" | "after"; doneKnown: boolean } }` (ISO instants)
  - `visitWindows(input: WindowInput): VisitWindow[]`
  - `latestYmd(job: Pick<Job, "urgency" | "byDate">, todayYmd: string): string`
  - `insideWindow(span: { from: string; until: string }, windows: readonly VisitWindow[]): boolean`
  - `overlapsStay(span, stays, input): boolean` (any stay or block, in local check-in/checkout times)

  A window with `cleaning` and no `cleaningOrder` is the whole gap; with `after` it starts at `doneAt`, else checkout + `cleaningMinutes`; with `before` it ends at checkout + `cleaningMinutes` (or earlier at the buffer).

- [ ] **Step 1: Failing tests** (the spec's list): merged stays from two calendars; a block as occupied; buffer 60 before a 16:00 check-in (`until` 15:00); open all day with no stay; same-day turnover 11:00 to 15:00; cleaning after with DONE known (starts at DONE) and not (11:00 + 180 = 14:00); cleaning before (11:00 to 14:00); `America/New_York` on 2026-11-01 (DST end) gives instants an hour apart from the day before; windows end at `lastYmd`'s end of day; `now` mid-window clips `from`.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(fixer-core): visit windows between stays (#171)`.

### Task 4: `gate.ts`, go or hold in code

**Files:**
- Create: `src/fixer-core/gate.ts`
- Test: `test/fixerGate.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces:
  - `contactAllowed(job: Job, to: string, pros: readonly Pro[]): { ok: true } | { ok: false; reason: "no-go" | "not-approved" | "unknown" }` (a `saved` pro preferred for the trade on a job with the host's go, or an id in `job.picked`; a draft pro is never allowed)
  - `type BookingHold = "outside-window" | "overlaps-stay" | "cost" | "no-estimate"`
  - `bookingHolds(input: { span: { from: string; until: string }; windows: readonly VisitWindow[]; overlaps: boolean; costLineCents?: number; estimateCents?: number }): BookingHold[]`
  - `bookingFingerprint(b: { proId: string; from: string; until: string; estimateCents?: number; access: "code" | "host"; cleaningOrder?: string }): string`
  - `defaultAccess(job: Job, pro: Pro | undefined, codeSaved: boolean): "code" | "host"` (`host` for `doorLock`, no phone, or no saved code)
  - `type AccessRefusal = "not-booked" | "no-yes" | "host-access" | "no-phone" | "before-visit" | "after-visit" | "guests-not-left"`
  - `accessCheck(input: { job: Job; pro: Pro | undefined; now: Date; checkoutDay: boolean; cleared: boolean }): { ok: true; window: { from: string; until: string } } | { ok: false; reason: AccessRefusal }` (window is `from − 30 min` to `extendedUntil ?? until`)
  - `raisedPriceHeld(costLineCents: number | undefined, estimateCents: number | undefined, cents: number): boolean` (only with a line: over it, or over 120% of the estimate)
  - `costNews(costLineCents, estimateCents, cents): boolean` (over the line, or over 120% of the estimate)
  - `liveBooking(job: Job): boolean` (state `booked` or `in-progress`)
- [ ] **Step 1: Failing tests** (the spec's `fixerGate` list): contact for a preferred saved pro with go, refused without go and for a draft, allowed for a picked candidate, refused for anyone else; each hold alone; cost at, below and above a line; no estimate with a line holds, without a line nothing holds; fingerprint changes with each field; access refused before `from − 30m`, after `until`, without `hostYes`, with `access: "host"`, for a `doorLock` locksmith (via `defaultAccess`), on a checkout day before clearance, and allowed for a locksmith on another lock; raised price held over a line and only news without one.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(fixer-core): the contact, booking and access gates (#172, #173, #174)`.

### Task 5: The desk: setup, pros, upkeep, activate, state (#170)

**Files:**
- Create: `src/fixer-core/setupAsk.ts`, `src/fixer-core/desk.ts`
- Test: `test/fixerDesk.test.ts` (setup part), `test/fixerPeople.test.ts` (people part)

**Interfaces:**
- Consumes: Tasks 1, 2; `ConfirmationBook` (`src/operator/confirmations.ts`), `hubFor`, `scheduleProblem`/`nextDates` from `src/supply-core/schedule.ts` (only `every` and `custom` kinds are accepted).
- Produces:
  - `interface FixerDeps { now(): Date; propertyId?: string; people?(): People | undefined; cleaningOn?(): boolean; cleanings?(checkoutYmd: string): Promise<{ doneAt?: string; cleared: boolean } | undefined>; env?(): NodeJS.ProcessEnv; publicBase?(): string | undefined; send?(to: string, body: string): Promise<boolean>; textsAllowed?(): Promise<boolean>; business?(): Promise<string | undefined>; notifyHost?(id: string, text: string): Promise<void>; photoKey?(): Buffer | undefined }`
  - `type FixerReply = { text: string; structured?: Record<string, unknown>; isError: boolean }`
  - `class FixerDesk` with `serial`/`guarded` like `SupplyDesk`, approvals in `fixer-approvals.json`, and: `state()`, `saveSettings(input)`, `savePro(input)`, `removePro(input)`, `saveUpkeep(input)`, `removeUpkeep(input)`, `previewSchedule(input)`, `activate()`, `summaryLine()`, `turnOn()`, `turnOff(cancel: boolean)`
  - `fixerDeskFor(root, deps)`, `resetFixerDesks()`
  - `fixerSetupAsk(file, hub, cleaningOn): FixerAsk | undefined` with steps `"pros" | "cost-line" | "ask-cleaner" | "upkeep" | "review"` (`ask-cleaner` only with cleaning on)
  - `savePro` input: `{ id?, name, trades, preferredFor?, reach, prefersText?, draft?: true, confirm?: string[], jobId?, shared?: true, confirmation? }`. `draft: true` saves `status: "draft"`, `source: "drafted"`. `confirm: [ids]` turns drafts `saved`. After Activate every change is two-call. A `saved` pro with a phone is synced with `people.saveRolePeople(propertyId, "pro", …)`. A saved pro with `prefersText` and a phone gets the invite once (Task 10 sends it; here `savePro` calls `this.inviteIfAsked(pro)`, a no-op until Task 10).
  - `state()` gives `ask` + `next` during setup, else `summary` with pros by trade, upkeep, open jobs and the cost log for this month and year by trade, and `line` (`Repairs: on, 4 pros, 1 job open.` or `Repairs: setup not finished.`).
  - Activate refuses without the hub's address and time zone, or without a booking calendar (`hub.calendars().length + google` > 0) or `hub.calendarsDone()`.
- [ ] **Step 1: Failing tests.** Setup asks in order with drafts (`pros` first, its ask carries the drafts by trade with gaps `needsYou`); draft pros aren't counted as saved until `confirm`; ranks per trade; `ask-cleaner` skipped with cleaning off; upkeep refuses a `bookings` schedule and reads back `nextDates`; activate refusals; two-call after Activate (question + code, wrong code refused, right code saves); remove; card-like input refused on every method. `fixerPeople`: a saved pro with a phone is role `pro` in `people.json`; a draft isn't; removing a pro removes the role; edit-by-id keeps id and `addedAt`.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(fixer-core): setup, preferred pros and upkeep (#170)`.

### Task 6: Jobs and what starts them (#171)

**Files:**
- Modify: `src/fixer-core/desk.ts`
- Test: `test/fixerDesk.test.ts` (jobs part)

**Interfaces:**
- Produces on `FixerDesk`:
  - `openJob(input: { trade; what; urgency; byDate?; source: "host" | "cleaner" | "upkeep"; sourceRef?; photoMessageIds?: string[]; cleanerName?: string; doorLock?: true })`: redacts digit runs of 4+ in `what` (`joinSplitDigits` first), copies cleaner photos with `copyPhotos(root, messagePhotoId(id), "fixer:"+jobId)`, sets `hostGo` for `host`. An `upkeep` job needs `sourceRef` naming an upkeep item and no open job for it.
  - `approveJob(input: { jobId; no?: true; confirmation? })`: two-call go; `no` cancels with `cancelReason: "host-said-no"`.
  - `checkFixes(input: { googleEvents? })`: reads calendars through the hub when cleaning and supplies are off (as Supply Core), sweeps (Task 7), and returns `{ needsGo: [{ jobId, question }], upkeepDue: [{ upkeepId, trade, what, nextDate, proId? }], contactNext: [{ jobId, proId, name, reach, rank }], windows: { [jobId]: VisitWindow[] }, unconfirmed, followUps, held, delays, preferredAsk, rotationAsk, news }`, each list empty when nothing; news is marked told once returned.
  - `windowsFor(job): Promise<VisitWindow[]>` (hub stays, hub check-in/out times, settings, Cleaner Core cleanings via `deps.cleanings`)
- [ ] **Step 1: Failing tests:** each start makes a job (host started at once with `hostGo`; cleaner and upkeep `requested` with a `needsGo` question in the exact copy, photo copied); a cleaner job's `what` with `4812` saved as redacted; upkeep due `leadDays` before its next date and not again while its job is open; `contactNext` names the rank-1 saved pro only after go; windows respect the next check-in; `approveJob` `no` cancels.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(fixer-core): jobs from the host, the cleaner and upkeep (#171)`.

### Task 7: Shortlist, pick, contact, booking (#172, #173)

**Files:**
- Modify: `src/fixer-core/desk.ts`
- Test: `test/fixerDesk.test.ts` (contact part), `test/fixerBooking.test.ts`

**Interfaces:**
- Produces on `FixerDesk`:
  - `addCandidates(input: { jobId; candidates: CandidateInput[]; options?: true })` → state `shortlisted` (also from `requested`/`contacted` when the host asks for options); up to 8; `https` links only.
  - `pickPros(input: { jobId; ids: string[]; confirmation? })` two-call; sets `picked` in order.
  - `contactPro(input: { jobId; to; how })` → `{ contactToken, reach, next }` or a refusal with `tellHost: true`; `how: "text"` only for an opted-in pro (`people.optedIn && !stopped`).
  - `recordContact(input: { contactToken; outcome; from?; until?; estimateCents?; quoteCents?; note?; followUpAt? })`: refuses without a live token; `booked` runs `bookingHolds` and stores a pending `booking` (no `hostYes`) with `access: defaultAccess(...)` and `fingerprint`; a second `booked` while one is pending is kept on its contact and listed under `held` for the host to choose; `declined`/`no-answer` offers the next pick or rank; all gone → `shortlisted` or `requested`.
  - `approveBooking(input: { jobId; access?: "code" | "host"; cleaningOrder?: "before" | "after"; revised?: true; confirmation? })` two-call bound to the booking's fingerprint plus `access` and `cleaningOrder`; re-runs windows and holds at redeem (refuses if the span is now outside or overlaps); `cleaningOrder` required when the window shares a cleaning; sets `hostYes`, state `booked`. With `revised: true` it approves a held raised price instead (Task 8 records it).
  - `cancelJob(input: { jobId; reason?; confirmation? })`, two-call when a booking is live; ends the visit token; a cancel after a reveal adds the rotation question.
  - Sweep inside `checkFixes`: a contact with no outcome after 2 hours is `unconfirmed` (told once); `waiting` past `followUpAt` is a follow-up offering the next pick.
- [ ] **Step 1: Failing tests:** add, pick (two-call), contact refused for anyone not picked and not preferred (refusal text shown to the host); each outcome recorded; `declined` and `no-answer` offer the next pick; the 2-hour sweep and 24-hour follow-up; a booking outside the window waits for the host with `outside-window`; the booking question in exact copy; a yes after the stays changed is refused; one live booking per job; `cleaningOrder` asked when a cleaning shares the turnover; locksmith `doorLock` books `access: "host"`.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(fixer-core): shortlist, the host's pick, contact and booking (#172, #173)`.

### Task 8: The visit: clock pass, door code by text, done, cost, delays (#174)

**Files:**
- Modify: `src/fixer-core/desk.ts`
- Test: `test/fixerVisit.test.ts`

**Interfaces:**
- Produces on `FixerDesk`:
  - `tick(): Promise<void>`: per job: `booked` → `in-progress` at `from`; for an opted-in pro who prefers text, once `accessCheck` passes, sets `codeTextAt` and saves before asking the hub, then texts the code (exact copy) by `deps.send`; a hub refusal sends nothing and adds one host note per job (`codeNoteAt`); the visit ends with no done → one news item and `notifyHost`; end within 1 hour of a check-in with no done → one news item and `notifyHost`.
  - `revealCode(jobId): { ok: true; code: string; lockLocation?: string } | { ok: false; reason }` (used only by the visit page and the tick, never by a tool): `accessCheck`, then the hub's `request`. Logs `revealedAt` and adds the reveal news (exact copy) with `notifyHost`.
  - `guestsLeft(input: { confirmed?: true })`: records today as cleared for Fixer Core's own checkout-day check (Cleaner Core's clearance also counts through `deps.cleanings`).
  - `recordDone(input: { jobId; note?; by?: "agent" | "host"; cents? })`, `recordCost(input: { jobId; cents; by; note? })`, `raisePrice(jobId, cents, by)` (stores `revisedQuote`; held for `approveBooking({ revised: true })` when `raisedPriceHeld`, else news), `extendVisit(input: { jobId; until; confirmation? })` two-call, never past the next check-in buffer, new visit token.
  - After done: `preferredAsk` for a pro not saved or not preferred for the trade; `rotationAsk` after the preferred answer when the code was shown or texted and the pro isn't preferred; `skipQuestion({ jobId, question: "preferred" | "rotate" })`; `changeDoorCode({ jobId })` returns the hub's one-time upload link (`issueUpload`) and records `rotationAsked.answer = "yes"`; `savePro({ jobId })` answers the preferred question.
  - `jobPhotos(jobId)` → photo links via `photoLinks(root, "fixer:"+jobId, base, key, now)`; photos of a done job are dropped 30 days after done in `tick`.
- [ ] **Step 1: Failing tests:** a full job booked → in-progress → code text once (a second tick and a fresh desk send nothing more) → done with a photo → cost; code refused before the visit, after it, with `access: "host"`, and on a checkout day before guests left; a hub refusal (no key after a restart: a code saved with only a request key and a fresh `DoorAccess`) sends nothing and leaves one note; the restart case of Review Focus 4; reveal news; raised price held with a line and news without one; cost news over 120%; extend refused past the buffer; preferred question then rotation question, none for a preferred pro; photos pruned after 30 days.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(fixer-core): door access for the visit, done, cost and delays (#174)`.

### Task 9: The visit page (#174)

**Files:**
- Create: `src/fixer-core/visitPage.ts`
- Modify: `src/fixer-core/desk.ts` (`visitLink`, `revokeVisit`, `visitByToken`), `src/cleaner-core/hosted/router.ts` (route `FIXER_VISIT_PREFIX` on a property path while its fixer flow is on)
- Test: `test/fixerVisitPage.test.ts`

**Interfaces:**
- Produces:
  - `FIXER_VISIT_PREFIX = "/fixer-core/visit/"`
  - `FixerDesk.visitLink({ jobId })` → `{ url }` once per token (a second call refuses until a rebook, extend or cancel issues a new one); refuses before `hostYes`. Stores only `tokenHash`.
  - `FixerDesk.revokeVisit({ jobId })`
  - `handleVisitRequest(desk: FixerDesk, req: { method: string; sub: string; token: string; contentType: string; body: Buffer }): Promise<{ status: number; headers: Record<string, string>; body: string | Buffer }>`, with `sub` one of `""` (GET page), `"door"` (POST, JSON `{ code, lockLocation? }` answer), `"photo"` (POST raw image bytes, `Content-Type` an MMS photo type except HEIC/HEIF, at most 5 MB; JPEG APP1/APP13, PNG `eXIf`/`tEXt`/`iTXt`, WebP `EXIF`/`XMP ` removed before saving), `"done"` (POST JSON `{ cents?, note? }`), `"quote"` (POST JSON `{ cents, note? }` → `raisePrice`).
  - Every response: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff`, a CSP with no outside sources. 30 requests an hour per token, then 429. Unknown or ended token: 404 with `This visit has ended.`
  - The page before the visit shows the time and job, the address only from 24 hours before; during it, the "I'm at the door" button (or "The host will let you in" for `access: "host"`), photos, amount, and a raised price; after done only `This visit has ended.`
- [ ] **Step 1: Failing tests:** before/during/after; the code only from POST `door` inside the visit; GET never contains the code (search the body for the Scratch code); the link and every tool reply never contain it; a new token on rebook, extend and cancel; `revokeVisit`; the 31st request is 429; a photo saved with its GPS segment removed; amount and done; a host note on each reveal; a refused hub request shows no code and leaves one note; HEIC refused.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(fixer-core): the visit page (#174)`.

### Task 10: Pros on the text line (#170, #174)

**Files:**
- Create: `src/fixer-core/proLine.ts`
- Modify: `src/fixer-core/desk.ts` (`inviteIfAsked`, `proInbound`), `src/hosted/lineRouter.ts` (pro route before `routeLineText`)
- Test: `test/fixerPeople.test.ts` (line part)

**Interfaces:**
- Produces:
  - `proRoute(tenant, people, from): Property[] | undefined` in `proLine.ts`: the properties with the fixer flow on where `from` is a `pro` and holds no other role on any of the account's properties (Review Focus 1). Undefined otherwise, and the text routes as today.
  - `FixerDesk.proInbound(input: { id; from; text; media? }): Promise<void>`: STOP/HELP/injury first (STOP → `people.stop` + relay; HELP → nothing, Twilio answers; injury → the reply `If someone is hurt, call 911 now. I've let the host know.` and a host note); YES → `people.optIn`; START → `people.start`; DONE (with or without photos, `isDone` from Cleaner Core's intent helpers) → done by `pro-text` for their job in progress, photos downloaded with `downloadPhotos` and `storePhotos`; a price (`$420`, `420 dollars`) for their job in progress → `raisePrice`; anything else → host news, digit runs redacted. A pro's text never approves, books or changes anything else.
  - `inviteIfAsked(pro)`: only a saved pro with `prefersText` and a phone, after `textsAllowed()`, when `people.claimInvite(phone, propertyId)`; sends the invite once.
  - In `handleLineText`: with `proRoute` defined, pick the property whose job is in progress or booked with that pro, else the first; call `proInbound`; answer `EMPTY_TWIML`.
- [ ] **Step 1: Failing tests:** the invite only to a pro who asked, after the host saved them and the host is confirmed; no text to a pro without YES (contact `how: "text"` refused before it); STOP covers every property; DONE with photos marks done and saves them; a price text raises; other text is news with digits redacted; nothing a pro receives names another property; a cleaner who is also a pro routes to Cleaner Core.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(fixer-core): pros on the text line (#170, #174)`.

### Task 11: The cleaner's repair question (Decision 8)

**Files:**
- Modify: `src/cleaner-core/cleanerTexts.ts`, `src/cleaner-core/core.ts` (`repairAsk` option, `MessageHandled` gains `"repair-report"`), `src/cleaner-core/liveDesk.ts` (`preferenceOptions` reads `fixerAskOn(root)`; new `cleaningFor(checkoutYmd)`), `src/cleaner-core/assistant.ts` (the check_now step for Grok and Muse names `repair-report` and `open_job`), `docs/cleaner-core-safety-gates.md` (the supplies question gate covers the repair question)
- Test: `test/cleanerRepairAsk.test.ts`

**Interfaces:**
- Produces: `CleanerOptions.repairAsk?: boolean`; the DONE text is `SUPPLY_REPAIR_DONE_ASK` with both, `REPAIR_DONE_ASK` with repair only, unchanged otherwise; the answer is labeled `repair-report` whenever `repairAsk` is on, else `supply-report`; `LiveDesk.cleaningFor(checkoutYmd): Promise<{ id: string; doneAt?: string; cleared: boolean } | undefined>` (`cleared` for status `cleared`, `in_progress` or `done`).
- [ ] **Step 1: Failing tests:** the new words only with Fixer Core activated and `askCleaner` on; a reply that names a supply and a repair is one `repair-report`; STOP, HELP, injury and code-like texts still win; `cleaningFor` reports DONE and clearance.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS), plus `test/cleanerSupplyAsk.test.ts` and the pinned assistant text tests.
- [ ] **Step 5: Commit** `feat(cleaner-core): ask the cleaner about repairs after DONE when the host chose it (#171)`.

### Task 12: Tools and the hosted service (#170 to #174)

**Files:**
- Create: `src/fixer-core/tools.ts`, `src/hosted/fixer.ts`
- Modify: `src/cleaner-core/hosted/registry.ts` (no `fixer-not-yet` when the caller passes the flag check), `src/hosted/service.ts`, `src/hosted/propertyTools.ts`, `src/hosted/frontMcp.ts`, `src/hosted/crossService.ts` (`cleaningForCheckout`), `src/cleaner-core/hosted/router.ts` (`tickAllFixers` beside `drainAllTenants`), `src/web/server.ts` (the tick calls it), `src/cleaner-core/assistant.ts` (`fixer` profile flag, `runsFixer`, `FIXER_AGENTS_ONLY`)
- Test: `test/fixerHosted.test.ts`, `test/fixerTools.test.ts`; update `test/cleanerHostedRegistry.test.ts`, `test/propertyFlows.test.ts`, `test/propertyClientMatrix.test.ts`

**Interfaces:**
- Produces:
  - `FIXER_TOOLS` with strict zod inputs for every tool in the spec's Part 5 table, plus `guests_left`, `skip_question` and `change_door_code`; `FIXER_TOOL_NAMES`; `handleFixerTool(desk, name, args)`; `listedFixerTools(names)`. `get_job_photos` and `preview_schedule` are not in `FIXER_TOOLS`: the front answers them (a `job_` id goes to Fixer Core; `preview_schedule` to whichever of Supply or Fixer is on).
  - `fixerDesk(h, tenant, property)` wiring every `FixerDeps` field: people from `accountPeople`, `cleanings` from `cleaningForCheckout`, `send` with `sendLiveSms(ctx.env(), …)`, `textsAllowed`/`business` from the cleaning desk when cleaning is on (else false/undefined), `notifyHost` with the cleaning desk's `noteForHost` when cleaning is on, `photoKey` with `photoKey(ctx.env(), ctx.saveSecrets)`.
  - `set_flows` `fixer: true` refused with `FIXER_NOT_YET` unless `fixerCoreOn(h.baseEnv())`, and with `FIXER_AGENTS_ONLY` for Claude and ChatGPT; `fixer: false` with a live booking returns the jobs that will be cancelled and stops with a code, like Supply Core's off.
  - Tool list: Fixer Core's tools with `property` for `grok` and `muse` when any property has fixer on; `get_state` for a property with only fixer on gives Fixer's state; Cleaner Core's and Supply Core's `get_state` carry `repairs: <line>`; `save_pro` with a phone on another property needs `shared: true` (refusal through `sharedRefusal`).
  - `PROPERTY_INSTRUCTIONS` names Fixer Core.
- [ ] **Step 1: Failing tests:** `set_flows fixer: true` behind `FIXER_CORE=1`; tool lists with Fixer Core on and off; Grok and Muse only; two accounts apart (no pros, jobs, costs or visit pages across); `fixer: false` with a booked job asks first; the tick moves a booked job to in-progress; an end-to-end drive on a 555 Scratch line: open job → contact → booked → yes → visit page → door → done with a photo → cost.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS), plus the three updated tests.
- [ ] **Step 5: Commit** `feat(hosted): Fixer Core on the shared service behind FIXER_CORE=1 (#170 to #174)`.

### Task 13: Docs and the agents' instructions

**Files:**
- Modify: `docs/client-matrix.md` (Fixer Core `Yes | Yes | No | No`, the `fixer` profile column), `docs/fixer-core-safety-gates.md` (each gate's proof names the real tests), `docs/environment-variables.md` (`FIXER_CORE`), `README.md`, `docs/hosted-multitenancy.md`
- Create: `FIXER_CORE_BOOTSTRAP.md`, `muse-template/skills/fixer-core/SKILL.md`
- Test: `test/fixerTemplate.test.ts` (every tool name the docs name exists; the bootstrap carries the rules word for word: "Contact only a pro the host approved.", "Never confirm a held time to the pro before the host's yes.", "Send the visit link only to the pro's own email or phone.", "Never pass a card number to Fixer Core.")
- [ ] **Step 1–4:** write the test, run (FAIL), write the docs, run (PASS).
- [ ] **Step 5: Commit** `docs(fixer-core): agent instructions, client matrix and gates (#174)`.

### Task 14: Verify

- [ ] `npm run typecheck`, `npm run build`, `npm test`, `scripts/ci-check.sh`, `scripts/ci-proofs.sh`. All pass, with the counts in the PR.
- [ ] Each gate in `docs/fixer-core-safety-gates.md` names a test that exists and passes.
