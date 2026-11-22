# Locks and who comes in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #280 items 17, 19, 20, 21 and 22 and the host's standing-code YES: a visitor's own code for an expected visit, guest codes for calendar stays, a door activity list, a reconnect note, and codes that survive the doors coming back with new ids.

**Architecture:** Every code stays on #180's grants (`src/hub/grants.ts`): a new `visit` flow for expected visits, and a `rehome` step that moves live grants to new device ids with their sealed digits. Reads stay pure functions over the visit log and the hub; desks own two-call yeses and texts; the hosted lock clock (`tickAllLocks`) runs the syncs.

**Tech Stack:** TypeScript on Node 22, vitest, the in-memory `FakeLockAdapter`.

**Spec:** `docs/superpowers/specs/2026-11-22-locks-who-comes-in-design.md`

## Global Constraints

- Tests use 555 numbers and made-up or runtime codes only. Nothing reaches the lock partner or a real phone.
- No code digits in a text other than the person's own code text, a tool reply, a note, a log or a JSON file other than the sealed grants.
- The partner webhook's `code` field is never read.
- No text before the host's phone is confirmed (`textsAllowed`) and the person's own YES; STOP wins account-wide (`stopped(phone)`).
- Every change of who gets a code takes the host's two-call yes (`ConfirmationBook`), except the automatic re-home, which keeps the same people and digits.
- Off means unchanged: without the account's switches (`locks`, `guest-codes`, `oversight`, visit records) every reply is as before.
- Host-facing wording: plain sentences, the property's time zone, no partner name ("lock account", never "Seam").

## Review Focus

- A visitor whose phone is the host's own confirmed phone: refused, pointing to a standing code (Task 9 test "refuses the host's own phone as a visitor").
- A calendar stay and an email booking for the same dates arriving in either order: one code, never two (Task 6 test "an email for a calendar stay that already has a code keeps that code").
- An unlock event whose body carries `code`: nothing stored holds the digits (Task 1 test "never reads the unlock's code field").
- Two saved doors with the same name, or a new account with two locks of that name: no automatic re-home, the host picks (Task 4 test "two locks with the same name are never guessed").
- A reconnect note arriving with no earlier disconnect (first connect): no note (Task 3 test "a first connect says nothing").

---

### Task 1: Adapter: disconnected accounts, removing a stuck one, the synced event

**Files:**
- Modify: `src/locks/adapter.ts`, `src/locks/seam.ts`, `src/locks/fake.ts`
- Test: `test/locksSeam.test.ts`, `test/locksFake.test.ts`

**Interfaces:**
- Produces: `LockAdapter.accounts()` returns `{ id: string; disconnected?: boolean }[]`; `LockAdapter.removeAccount(input: { customerKey: string; accountId: string }): Promise<void>`; `LockEventKind` gains `"account-synced"`.
- Fake: `disconnectAccount(customerKey: string, on = true): void`; `replaceDevice(oldId: string, newId: string): void` (same name, kind, account; codes on the old id are dropped); `removeAccount` empties that key's devices and accounts.

- [ ] **Step 1: Write the failing tests** in `test/locksSeam.test.ts`:
  - "maps a reconnect's first sync to account-synced": body `{ event_type: "connected_account.completed_first_sync_after_reconnection", connected_account_id: "ca_1" }` parses to `kind: "account-synced"`, `accountId: "ca_1"`.
  - "never reads the unlock's code field": a signed `lock.unlocked` body with `method: "remote"` and `code: "482913"`; `JSON.stringify(parsed)` does not contain `482913`; `parsed.method === "remote"`; `parsed.side` is undefined.
  - "flags an account the partner lists as disconnected": `connected_accounts/list` stub returns `errors: [{ error_code: "account_disconnected" }]`; `accounts()` gives `[{ id, disconnected: true }]`.
  - "removes a connection by its id": `removeAccount` posts `/connected_accounts/delete` with `{ connected_account_id }`, and only for an account `accounts()` lists under that customer key.
  - In `test/locksFake.test.ts`: "replaces a device with a new id and the same name" and "a disconnected account is flagged until it reconnects".
- [ ] **Step 2: Run** `npx vitest run test/locksSeam.test.ts test/locksFake.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Seam: map the event name in `EVENT_KINDS`; read `errors[].error_code === "account_disconnected"` in `accounts`; `removeAccount` checks the id is in `accounts({ customerKey })` before deleting (a foreign id is a no-op). Fake: as in Interfaces.
- [ ] **Step 4: Run** the same command — PASS. `npm run typecheck` — clean.
- [ ] **Step 5: Commit** "Locks: disconnected accounts, removing a stuck one, the reconnect sync event (#280 22)".

### Task 2: Door activity (item 20)

**Files:**
- Create: `src/visits/activity.ts`
- Modify: `src/visits/desk.ts`, `src/visits/tools.ts`
- Test: `test/visitsDoorActivity.test.ts`

**Interfaces:**
- Produces: `doorActivity(events: readonly VisitEvent[], codeNames: CodeNames, names: EntryNames, span: { from: number; until: number }): ActivityEntry[]` with `ActivityEntry = { at: string; door: string; action: "unlock" | "lock"; who?: string; party?: "host" | "guest"; withCode: boolean | "unknown-code"; how?: string }`; `activitySentence(entry: ActivityEntry, timeZone: string): string`; `VisitDesk.doorActivity(input: { from?: unknown; to?: unknown }): VisitReply`; tool `door_activity`.
- `how` from method: `remote`/`mobile_key` → "from the app"; `manual` → "by hand or with a key"; `automatic` → "on its own"; `card` → "with a card"; `keycode`/`unknown`/absent → none.

- [ ] **Step 1: Write the failing tests**:
  - "says an unlock without a code, and how": a `lock` line `{ action: "unlock", device: "Front door", method: "remote", at: 2026-11-22T06:13Z }` in America/New_York → sentence `"The Front door was unlocked at 1:13 AM, without a code (from the app)."`
  - "names whose code it was": code names `{ "Cleaning abcdefgh": { role: "cleaner" } }`, names `{ cleaner: "Maria" }` → `"The Front door was unlocked at 9:02 AM with Maria's code."`; the host's code → `"with your own code"`; a guest's → `"with the guest's code"`.
  - "a keypad code Property Core didn't make": `method: "keycode"`, `codeName: "Bob"` unnamed → `"with a code that isn't one of Property Core's"`.
  - "lists locks too, oldest first, only inside the days asked"; "at most 7 days"; "sends nothing and holds no digits or phone" (reply JSON has no run of 4+ digits except times and dates).
  - `visit_health`'s `next` names `door_activity`.
- [ ] **Step 2: Run** `npx vitest run test/visitsDoorActivity.test.ts` — FAIL.
- [ ] **Step 3: Implement** `activity.ts` (reuse `codePerson`, `codeKey`; names as `entryEventsFrom` resolves them), the desk method (default today in the property's zone, `from`/`to` local dates, max 7 days, `ok({ entries, sentences, next, sends: false })`), the tool with its description ("Who came in: every unlock and lock at the property's doors…"), listed with the other visit tools.
- [ ] **Step 4: Run** — PASS. Typecheck.
- [ ] **Step 5: Commit** "Visit records: door activity, with or without a code (#280 20)".

### Task 3: The reconnect note (item 21)

**Files:**
- Modify: `src/locks/settings.ts` (`DoorLocksFile.disconnectedAt?: string`, `pausedByDisconnect?: true`), `src/locks/inbound.ts`
- Test: `test/locksReconnect.test.ts`

**Interfaces:**
- Produces: on `account-disconnected`, `file.disconnectedAt = event.at` and `pausedByDisconnect: true` when it turned `release.cleaners` to ask. On `account-connected` with `disconnectedAt` set: one note id `lock:reconnected:<disconnectedAt>`; `release.cleaners` back to automatic when `pausedByDisconnect`; both fields cleared.

- [ ] **Step 1: Write the failing tests** (apply events with `applyLockEvent` on a fake-backed `DoorAccess`):
  - "tells the host once when the account is back": disconnect then connect → note text `"Your lock account is connected again, so I can make and change codes."`; a replayed connect event gives nothing.
  - "turns the checkout-time code back on if the disconnect paused it": the note adds `" The cleaner's code goes out at checkout again, like before."`; `locks().release.cleaners === "automatic"`.
  - "leaves ask as it was": with ask before the disconnect, still ask, no second sentence.
  - "a first connect says nothing".
- [ ] **Step 2: Run** `npx vitest run test/locksReconnect.test.ts` — FAIL.
- [ ] **Step 3: Implement** in `applyLockEvent`'s `account-disconnected` and a new `account-connected` case.
- [ ] **Step 4: Run** — PASS, plus `npx vitest run test/locksWebhook.test.ts`.
- [ ] **Step 5: Commit** "Locks: tell the host when the lock account is back (#280 21)".

### Task 4: Re-home live codes onto new door ids (item 22)

**Files:**
- Create: `src/locks/rehome.ts`
- Modify: `src/hub/grants.ts` (`GrantBook.rehome`), `src/hub/doorAccess.ts` (`DoorAccess.rehome`), `src/locks/inbound.ts` (`account-synced`), `src/locks/settings.ts` (`DoorLocksFile.rehomeNeeded?: string[]` old ids still unmatched)
- Test: `test/locksRehome.test.ts`

**Interfaces:**
- Produces: `matchDoors(saved: readonly StoredDevice[], listed: readonly LockDevice[]): { moves: Record<string, string>; missing: string[] }` — a saved device whose id isn't listed moves to the one listed lock with the same name (`codeKey`), not already saved, when exactly one matches and no other saved device has that name; else it's `missing`.
- `GrantBook.rehome(moves: Record<string, string>): Promise<void>` — in each live grant, a device on an old id gets the new id, no `codeId`, status `"programming"`; backups on old ids are dropped; then `retryDoors` puts the same digits on; writes.
- `DoorAccess.rehome(listed: LockDevice[]): Promise<{ moved: string[]; missing: string[]; notes: GrantNote[] }>` — updates `door-locks.json` (`devices`, `doors`, `rehomeNeeded`), calls `grants().rehome`, returns notes: moved → id `lock:rehomed:<sorted new ids>` text `"Your locks came back after the reconnect. Everyone's codes were put back on the Front door, so nobody needs a new one."` plus, when any standing grant moved, `" Codes named Standing from before may still be on the lock: remove those in the lock's own app."`; missing → urgent id `lock:rehome-missing:<sorted old ids>` text `"After the reconnect I can't find the Front door in your lock account. Until you pick the doors again, visits use your saved door code."`.
- While `rehomeNeeded` is non-empty, `connected()` is false (the saved door code answers), as with mixed doors.

- [ ] **Step 1: Write the failing tests**:
  - "moves every live code to the new door with the same digits": cleaning, repair, standing and guest grants on `dev-1`; `fake.replaceDevice("dev-1", "dev-9")`; `rehome(await fake.devices(...))` → `fake.liveCodes("dev-9")` holds the same code values as before (compare against values captured from the fake before replacing); `locks().doors` is `["dev-9"]`.
  - "nobody is texted and no reply holds a code" during a re-home.
  - "two locks with the same name are never guessed": two listed "Front door" locks → missing, urgent note, `connected()` false.
  - "a door that refuses the old digits gets a backup at release", via the fake's `refuseValues`.
  - "account-synced runs the re-home and tells the host once".
- [ ] **Step 2: Run** `npx vitest run test/locksRehome.test.ts` — FAIL.
- [ ] **Step 3: Implement** as in Interfaces. `inbound.ts` `account-synced`: `adapter.devices({ customerKey })`, then `door.rehome`.
- [ ] **Step 4: Run** — PASS. Run `npx vitest run test/locksGrants.test.ts test/locksStanding.test.ts test/guestCodesGrants.test.ts`.
- [ ] **Step 5: Commit** "Locks: put everyone's codes back on the doors after a reconnect (#280 22)".

### Task 5: Guide a stuck reconnect, and re-home from the host's tools (item 22)

**Files:**
- Modify: `src/locks/desk.ts` (`list`, `connectLink`, `saveLocks`), `src/locks/tools.ts` (`connect_lock` gains `fresh` and `confirmation`), `src/hosted/locks.ts` (`tickAllLocks` runs `rehome` while `rehomeNeeded` or `disconnectedAt`)
- Test: `test/locksReconnect.test.ts`

**Interfaces:**
- `LockDesk.list()` reports `account: "connected" | "disconnected" | "none" | "unknown"`; with `disconnected`, `next`: "The host's lock account is still disconnected. Send a fresh sign-in link with connect_lock. If they signed in and it still shows disconnected, call connect_lock with fresh: true: it removes the stuck connection, with the host's yes, and gives a new link." With `rehomeNeeded`, `list()` runs `rehome` first; still missing → `next` asks the host to pick the doors (save_locks).
- `LockDesk.connectLink({ kind, fresh, confirmation })`: `fresh: true` is two calls, question `"Remove the stuck connection to your lock account and start a new sign-in? Codes already made are put back on your doors once they show up again."`; on yes, `removeAccount` for each disconnected account, then a new link.
- `saveLocks` with new door ids while live grants sit on missing old ids: the same `GrantBook.rehome` with `moves` old→new in the order picked, only when the counts match; else live grants on missing doors are revoked and their flows re-sync.

- [ ] **Step 1: Write the failing tests**: "get_locks says the account is still disconnected and how to fix it"; "fresh: true takes the host's yes, removes only the stuck connection, and gives a new link"; "picking the new doors puts everyone's codes back on them"; "the lock clock re-homes once the doors show up".
- [ ] **Step 2: Run** `npx vitest run test/locksReconnect.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS, and `npx vitest run test/locksWebhook.test.ts test/locksStandingLive.test.ts`.
- [ ] **Step 5: Commit** "Locks: guide a stuck reconnect and re-home codes from get_locks and save_locks (#280 22)".

### Task 6: Guest codes for calendar stays (item 19)

**Files:**
- Modify: `src/locks/guestCodes.ts` (`guestStays`, `GuestStay.source`, `GuestCodesFile.aliases?: Record<string, string>`), `src/locks/guestDesk.ts` (status, setMode replies, pass `hub.stays()`)
- Test: `test/guestCodesCalendar.test.ts`

**Interfaces:**
- `WantedInput` gains `calendar?: readonly Stay[]`. `guestStays(root, input)` adds each `kind: "stay"` from `calendar` that no email stay overlaps, key `cal:<checkIn>:<checkout>`, `source: "calendar"`, window from the property's times (else `DEFAULT_CHECK_IN`/`DEFAULT_CHECKOUT`), late checkout as for email stays. Email stays get `source: "email"`.
- Alias: when an email stay overlaps a calendar key that already has a live guest grant or a stay state with a link, the email stay uses the calendar key (recorded in `aliases[emailKey] = calKey`), so the same grant and link carry on. `make_guest_code` accepts either key.
- `status()` stays carry `source`; `next` always ends with `"Every booking from the calendar and the booking emails gets a code. Blocked dates don't."`. `setMode` automatic/ask replies add `" That's N upcoming stays."` (or "No stays are on the calendar yet.").

- [ ] **Step 1: Write the failing tests**: "a calendar-only stay gets a code on the property's usual times"; "blocked dates never get a code"; "an email booking for the same dates is one stay, with the email's times"; "an email for a calendar stay that already has a code keeps that code" (same live grant id and page link before and after); "says plainly which stays get a code"; "under ask, make_guest_code takes the calendar key".
- [ ] **Step 2: Run** `npx vitest run test/guestCodesCalendar.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS, and `npx vitest run test/guestCodesDesk.test.ts test/guestCodesGrants.test.ts test/guestCodesHosted.test.ts test/guestCodesWanted.test.ts`.
- [ ] **Step 5: Commit** "Guest codes: calendar stays get a code too (#280 19)".

### Task 7: The host's own standing code skips the YES

**Files:**
- Modify: `src/locks/desk.ts` (`addStanding`)
- Test: `test/locksStandingLive.test.ts`

**Interfaces:**
- For role `owner` with no typed phone and `hostPhone()` on file: on the host's yes the person is saved with `yesAt` at once; no invite text; the code is made and one text with the single-use link goes to that phone (the same `sendLink` path as after a YES). Question: `"Give you your own standing door code at <street>? I'll text a private link to your number ending <last4>."`. A typed phone, a co-owner or a co-host still get the invite and wait for YES.

- [ ] **Step 1: Write the failing tests**: "the host's own code needs no YES: the private link goes to the confirmed number at once"; "a co-host still gets the YES invite first"; "an owner code on a typed number still asks for YES". Update the existing test that expected the host's invite.
- [ ] **Step 2: Run** `npx vitest run test/locksStandingLive.test.ts test/locksStanding.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** "Standing codes: the host's own code skips the YES on their confirmed phone".

### Task 8: The `visit` flow on the grants, and its names (item 17)

**Files:**
- Modify: `src/hub/grants.ts` (`GrantFlow` + `"visit"`, prefix `"Visit"`, default who `{ role: "visitor" }`, `whoOf` "the visitor"), `src/hub/doorAccess.ts` (`purpose` + `"visit"`), `src/visits/events.ts` (`CodePerson` + `{ role: "visitor" }`; `entryEventsFrom` names it from `names.codes`), `src/visits/store.ts` (`validPerson`), `src/oversight/evidence.ts` (`standingNames` reads `visit` grants), `src/locks/inbound.ts` (`who`), `src/hours-log/codes.ts` and `sources.ts` only if the compiler asks
- Create: `src/oversight/visitorCodes.ts`
- Test: `test/visitorCodesWanted.test.ts`

**Interfaces:**
- `ExpectedVisit` gains `phone?: string` and `code?: { textAt?: string; sent?: boolean; told?: string[] }`. `OversightFile` gains `visitors?: Visitor[]` with `Visitor = { phone: string; name: string; addedAt: string; invitedAt?: string; inviteTriedAt?: string; yesAt?: string; stoppedAt?: string }`.
- `visitorWindow(visit: ExpectedVisit, input: { timeZone: string; stays: readonly Stay[]; occupy: OccupyInput }): CodeWindow | "during-stay"` — from `from` minus 30 minutes to `to`, or 08:00–20:00 for all-day; cut at the next busy time; `"during-stay"` when it starts inside one.
- `wantedVisitorCodes(file: OversightFile, input: { now: Date; timeZone: string; stays: readonly Stay[]; occupy: OccupyInput; mayHaveCode(phone: string): boolean }): { wanted: WantedCode[]; duringStay: string[] }` — job id the visit id, person its phone, label its `who`, `who: { role: "visitor" }`; not cancelled, window not over, `mayHaveCode` true.

- [ ] **Step 1: Write the failing tests**: "a timed visit's code runs from 30 minutes before to its end"; "an all-day visit's code runs 8 AM to 8 PM"; "no code inside a guest stay, and the end is cut at the next check-in"; "none for a cancelled visit, a visit with no phone, or a person who can't have one"; "an unlock with a visit code names the visitor for the same-day check" (via `entryEventsFrom` + `standingNames`, and `checkDay` marks the visit seen).
- [ ] **Step 2: Run** `npx vitest run test/visitorCodesWanted.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** "Expected visits: the visit code flow and its names (#280 17)".

### Task 9: A visitor saved with the visit, with the host's yes (item 17)

**Files:**
- Modify: `src/oversight/desk.ts` (`addVisit`, `listVisits`), `src/oversight/tools.ts` (`phone`, `confirmation`), `src/oversight/visits.ts`
- Test: `test/visitorCodesDesk.test.ts`

**Interfaces:**
- `OversightDeps` gains `codes?: () => boolean` (locks on and the property on connected locks) and `hostPhone?: () => string | undefined`.
- `addVisit` with `phone` (needs `codes()`): normalized +1; refused for the host's own phone ("That's your own number. Ask for a standing code with add_standing_code instead."); first call returns `question` `"<who>, <day> <window>, with their own door code? They get one text asking them to reply YES first."` (no "YES first" when the phone already said YES as a visitor) and a confirmation code; the second call with `confirmation` saves the visit and adds or updates the `Visitor`. Without `codes()`, a phone is refused: "Door codes for visitors need connected locks here."
- `listVisits` visits carry `code`: `"none" | "waiting-for-yes" | "on-lock" | "texted" | "none-during-stay" | "failed"`, never digits, never the phone (`phoneLast4` only).

- [ ] **Step 1: Write the failing tests**: "a visit with a phone takes the host's yes, naming the person and their code"; "refuses the host's own phone as a visitor"; "without connected locks, a phone is refused and the visit still saves without one"; "list shows the code's state, never a phone or digits".
- [ ] **Step 2: Run** `npx vitest run test/visitorCodesDesk.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS, and `npx vitest run test/oversight*.test.ts`.
- [ ] **Step 5: Commit** "Expected visits: save the visitor with the host's yes (#280 17)".

### Task 10: The visitor's invite, YES, code and text (item 17)

**Files:**
- Create: `src/oversight/visitorDesk.ts`, `src/oversight/visitorTexts.ts`
- Modify: `src/hosted/locks.ts` (`visitorDesk`, `tickAllLocks`, `visitorLineText`), `src/hosted/lineRouter.ts` (call `visitorLineText` after `guestLineText`), `src/hosted/oversight.ts` (deps)
- Test: `test/visitorCodesDesk.test.ts`, `test/visitorCodesHosted.test.ts`

**Interfaces:**
- `VisitorCodeDesk(root, deps: { now(); env(); textsAllowed(): Promise<boolean>; stopped(phone): boolean; send(to, body): Promise<boolean>; optedInHere(phone): boolean })` with `sync(): Promise<GrantNote[]>`, `visitorText(from: string, text: string): Promise<boolean>`, `hasVisitor(phone): boolean`.
- `sync()`: invites each visitor with an upcoming visit who hasn't said YES (one text, marked only once sent, retried every 10 minutes up to 6 times; skipped when `optedInHere`, which counts as YES); `syncGrants("visit", wanted)`; for each wanted visit from 30 minutes before its window, one code text (mark saved before the send; unsure → one host note); `duringStay` → one host note; texts not allowed → one host note.
- Texts (`visitorTexts.ts`): invite `"This is the text line for <street>. The host is expecting you and wants to give you your own door code. Reply YES to get it by text before your visit, or STOP to opt out."`; code `"Hi <name>, your door code at <street> is <code>. It works until <time> today."` (per-door lines when `doors`).
- Host notes: during a stay `"<who>'s visit falls during a guest's stay, so they get no code. You'll need to let them in."`; texts off `"I can't text <who> yet, so they don't have their code. Let them in another way."`; unsure `"I'm not sure <who>'s code text went out. Check with them before their visit."`; texted `"<who> has their door code for today's visit."`.
- `visitorText`: YES from an invited visitor sets `yesAt` and runs `sync`; STOP sets `stoppedAt` (the code comes off on that sync) and returns false so the usual routing still records it.

- [ ] **Step 1: Write the failing tests**: "texts the visitor once for YES, and nothing on the lock before it"; "after YES, the code is on the lock for the window and texted once from 30 minutes before"; "a replay or restart never texts the code twice"; "STOP takes the code off"; "a cancel takes the code off"; "doesn't text before the host's phone is confirmed, and tells the host"; "a person already opted in on the property needs no new invite"; hosted: "takes a visitor's YES on the shared line for their own property only" and "the lock clock makes and texts the code".
- [ ] **Step 2: Run** `npx vitest run test/visitorCodesDesk.test.ts test/visitorCodesHosted.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** "Expected visits: the visitor's own door code, by text after their YES (#280 17)".

### Task 11: Guides, safety gates, full verification

**Files:**
- Modify: `docs/cleaner-core-safety-gates.md` (Connected locks, Standing codes, Guest codes rows; a new "Visitor codes (#240)" section), `test/cleanerSafetyGatesProgress.test.ts` or the gate-doc test that checks named tests exist, the Grok and Muse guides that describe locks, guest codes and expected visits (`FIXER_CORE_BOOTSTRAP.md`, `CLEANER_CORE_BOOTSTRAP.md`, `muse-template/` skills, `property-core-template/` where they name these tools)
- Test: the existing doc tests (`test/grokSkills.test.ts`, `test/cleanerTemplate.test.ts`, gate-doc tests)

- [ ] **Step 1:** Add the gate rows from the spec's "Safety gates" section, each naming the tests above by file and title.
- [ ] **Step 2:** Add `door_activity`, `connect_lock`'s `fresh`, and `add_expected_visit`'s `phone` to the guides where the neighbouring tools are described.
- [ ] **Step 3: Run** `npm run typecheck && npm run build && npx vitest run` — all pass; then `npm run test:eval`.
- [ ] **Step 4: Commit** "Docs: safety gates and guides for visitor codes, calendar guest codes, door activity and reconnects".
