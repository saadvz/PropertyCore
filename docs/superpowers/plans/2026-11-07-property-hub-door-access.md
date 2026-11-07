# Property hub: door access — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The property hub owns the sealed door code and answers one door access request. Cleaner Core gets the code for a release only through that request, and the engine stores no code at rest.

**Architecture:** A new `src/hub/doorAccess.ts` owns `door-access.json` in each property folder: the seal, the lock location, the pending upload link, the key rule, and `request()` with one provider (`ownCode`). Cleaner Core plugs its save checks in through a new `HubGuards.codeRefused`. The engine gets a `DoorAccessPort` option. It asks the port for a grant in `deliverPin`, after all of its own checks. Existing seals move out of `cleaner-live.json` on first open.

**Tech Stack:** TypeScript, Node 22, vitest, `writeJsonAtomic` (`src/storage/atomicWrite.ts`), AES-256-GCM (`node:crypto`).

**Spec:** `docs/superpowers/specs/2026-11-07-property-hub-door-access-design.md`

## Global Constraints

- Tests use 555 numbers and made-up door codes only (`AGENTS.md`). Nothing texts a real phone. No live run.
- `src/hub/` imports nothing from `src/cleaner-core/` or `src/supply-core/`.
- No tool's name, input or reply changes, except the one new host note below.
- New host note, verbatim: `The cleaning's window has passed, so the door code didn't go out.`
- The door code, the key, the lock location and an upload code never appear in a reply, log, error or refusal. Only the sha256 of an upload code is stored.
- Upload links: 32 random bytes, base64url (43 characters), `UPLOAD_MINUTES` (10), and a new link replaces the last. The new path is `/door-code/<code>`. `/cleaner-core/door-code/<code>` still works.
- Door code: 4 to 8 digits (`/^\d{4,8}$/`). Lock location: at most 80 characters (`MAX_LOCK_LOCATION`), and no run of 4 or more digits once split digits are joined.
- Key rule: the request's key, else `serverPinKey(env)`. `pinKeyFor` is deleted.
- Cleaning window: `from` is the job's checkout instant. `until` is the start of the day after the next check-in date (`zonedInstant(addCalendarDays(nextCheckInDate, 1), "00:00", tz)`), or with no next booking, the start of the day two days after checkout. The window is over when `now >= until`.
- `doorCodeTo` stays in `cleaner-live.json`. `pinChannel`, opt-in, approval and the "guests have left" gate stay in Cleaner Core.
- These tests keep their assertions unchanged: `test/cleanerGroupFirst.test.ts`, `test/twoPropertiesEndToEnd.test.ts`, `test/lineRouting.test.ts`, `test/cleanerReplyDrafts.test.ts`, `test/cleanerSavedAnswers.test.ts`.

## Review Focus

1. **A property already moved to `hub.json` (by #191) still has `pinSeal` in `cleaner-live.json`.** The door move must not depend on `hub.json` being new. Task 4 pins this with `moves the seal even when hub.json already exists`.
2. **A crash after clearance, then a restart with only the server's key.** The next reminder pass must still send the code once, through the port. Task 6 pins this with `after a restart the reminder pass sends the code once through the hub`.
3. **A late "guests have left" on a same-day turnover** (the next check-in is today, and the host answers in the evening). The code must still go out. Task 6 pins this with `a same-day turnover released in the evening still sends`.
4. **A code posted to the upload link whose digits are in a waiting draft.** Refused with `CODE_IN_DRAFT`, never the digits, and the link stays usable. Task 5 pins this with `upload refuses digits in a waiting draft and keeps the link`.
5. **Two requests read through the hub before and after a re-save with a new code.** The grant carries the new code, and `codeForChecks` doesn't serve the old one. Task 3 pins this with `a re-saved code replaces the open one`.

---

## File map

| File | Responsibility |
|---|---|
| `src/hub/pinSeal.ts` | Moved from `src/cleaner-core/pinSeal.ts`. `sealPin`, `openPin`, `serverPinKey`, `pinKeyFromHeader`. `pinKeyFor` is removed in Task 7. |
| `src/hub/digits.ts` | `joinSplitDigits`, moved from `src/cleaner-core/core.ts` (which re-exports it), and `holdsCodeToken(text, code)` |
| `src/hub/doorAccess.ts` | `DoorAccessFile`, `DoorAccess` (save, upload, `codeForChecks`, `request`), `AccessProvider`, `ownCode`, `DOOR_ACCESS_FILE` |
| `src/hub/hub.ts` | `Hub.doorAccess(env)`, and `HubGuards.codeRefused` |
| `src/hub/paths.ts` | `HUB_DOOR_CODE_PREFIX`, `hubDoorCode(path)` |
| `src/hub/migrate.ts` | Moves `pinSeal`, `lockLocation` and `doorCodeUpload` into `door-access.json` |
| `src/cleaner-core/doorPort.ts` | `DoorAccessPort`, `fixedCodePort(code, lockLocation?)` for the CLI, scratch and tests |
| `test/hubDoorAccess.test.ts` | New tests for the hub's door access |

---

### Task 1: The hub holds the sealed code

**Files:**
- Move: `src/cleaner-core/pinSeal.ts` → `src/hub/pinSeal.ts` (`git mv`). Update every importer: `grep -rln "pinSeal\"" src test scripts`.
- Create: `src/hub/digits.ts`, `src/hub/doorAccess.ts`
- Modify: `src/hub/hub.ts` (`doorAccess`, `HubGuards.codeRefused`), `src/cleaner-core/core.ts:557` (re-export `joinSplitDigits` from `../hub/digits`)
- Test: `test/hubDoorAccess.test.ts`

**Interfaces:**
- Produces:
  - `holdsCodeToken(text: string, code: string): boolean`, the same rule as `containsCodeToken` in `src/cleaner-core/redact.ts:34`. Copy its rule. The hub can't import it.
  - `DOOR_ACCESS_FILE = "door-access.json"`
  - `interface DoorAccessFile { schemaVersion: 1; pinSeal?: PinSeal; lockLocation?: string; upload?: { hash: string; expiresAt: string; lockLocation?: string; by?: HubCaller } }`
  - `type DoorSave = { ok: true } | { ok: false; error: string; reason: "code" | "lock" | "key" | "guard" | "seal" }`
  - `class DoorAccess`:
    - `save(code: string, lockLocation: string | undefined, key: Buffer | undefined): DoorSave`. A `lockLocation` of `undefined` keeps the saved one, and `""` clears it.
    - `saved(): boolean`
    - `lockLocation(): string | undefined`
    - `codeForChecks(key?: Buffer): string | undefined`
  - `Hub.doorAccess(env: () => NodeJS.ProcessEnv): DoorAccess`. It returns the hub's one `DoorAccess` and sets its env provider.
  - `HubGuards.codeRefused?(code: string, lockLocation?: string): string | undefined`

- [ ] **Step 1: Write failing tests in `test/hubDoorAccess.test.ts`.** Reuse the `folder()` and `open()` helpers from `test/hub.test.ts`. Use `KEY = randomBytes(32)`, `SERVER = randomBytes(32).toString("base64")`, and the made-up code `"4821"`.
  - `seals the code and opens it with the same key`: `save("4821", "back door", KEY)` returns ok. `door-access.json` holds `pinSeal` and doesn't contain `"4821"`. After `resetHubs()`, `codeForChecks(KEY)` is `"4821"` and `lockLocation()` is `"back door"`.
  - `uses the server's key when the request has none`: with env `{ CLEANER_CORE_PIN_KEY: SERVER }`, `save("4821", undefined, undefined)` returns ok, and `codeForChecks()` after a reset is `"4821"`.
  - `another key leaves the seal shut`: after saving with `KEY`, `codeForChecks(randomBytes(32))` is `undefined` and `saved()` is `true`.
  - `refuses without any key`: empty env, no key. Returns `{ ok: false, reason: "key" }`, and no file is written.
  - `refuses a code that isn't 4 to 8 digits`, for `"12"`, `"123456789"` and `"12a4"`. Reason `"code"`.
  - `refuses a lock location with a long number or over 80 characters`, for `"gate 80 88"` and `"x".repeat(81)`. Reason `"lock"`.
  - `asks the guard and returns its refusal without the digits`: a guard `codeRefused: () => "No."` gives `{ ok: false, reason: "guard", error: "No." }`.
  - `"" clears the lock location, and undefined keeps it`.
- [ ] **Step 2:** Run `npx vitest run test/hubDoorAccess.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement it.** `git mv` the seal file and update its importers. Move `joinSplitDigits` into `src/hub/digits.ts`. Build `DoorAccess` on its own in-memory copy of `door-access.json`, written with `writeJsonAtomic`. Before each write, the save loop is the one in `saveDoorCodeNow` (`liveDesk.ts:1315-1320`): up to 8 seals, skipping any whose JSON holds the code as a token (`holdsCodeToken`) or the key in base64. The open code is cached in memory, the way LiveDesk's `pin` is today. `forgetHub` and `resetHubs` drop it with the hub.
- [ ] **Step 4:** Run `npx vitest run test/hubDoorAccess.test.ts test/hub.test.ts` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `Hub door access: the sealed code in door-access.json (#165)`.

---

### Task 2: The door code upload link in the hub

**Files:**
- Modify: `src/hub/doorAccess.ts`, `src/hub/paths.ts`, `src/cleaner-core/http.ts:105-110` (`doorCodeUploadCode` returns `hubDoorCode(pathname)`)
- Test: `test/hubDoorAccess.test.ts`, `test/hub.test.ts` (the paths test)

**Interfaces:**
- Consumes: `DoorAccess.save` (Task 1).
- Produces:
  - `HUB_DOOR_CODE_PREFIX = "/door-code/"`
  - `hubDoorCode(pathname: string): string | undefined`, which accepts `/door-code/` and `/cleaner-core/door-code/`
  - `DoorAccess.issueUpload(lockLocation: string | undefined, key: Buffer | undefined, base: string | undefined, by?: HubCaller): { ok: true; uploadUrl: string; expiresInMinutes: number } | { ok: false; error: string }`. `base` is `publicBaseUrl(env)`. Without one, the refusal is the `UPLOAD_LINK_OFF` copy, which moves here from `liveDesk.ts:118`.
  - `DoorAccess.upload(code: string, body: Record<string, unknown>): { status: 200 | 400 | 404; body: { ok: boolean; error?: string } }`. A 200 carries no message. LiveDesk's `uploadDoorCode` adds today's "Saved the door code…" reply (Task 5).
  - `DOOR_CODE_UPLOAD_REFUSED` moves here from `liveDesk.ts:95`. `UPLOAD_GONE` is reused from `hub.ts`.

- [ ] **Step 1: Write failing tests.**
  - `issues a 43-character link under /door-code/ and keeps only its hash`: `door-access.json` doesn't contain the link code.
  - `a second link replaces the first`: the first link's code now returns 404 with `UPLOAD_GONE`.
  - `an expired link is gone`: with `now` 10 minutes later, the result is 404 and the pending upload is removed.
  - `a refused code keeps the link`: posting `{ code: "12" }` gives 400 `DOOR_CODE_UPLOAD_REFUSED`, and then `{ code: "4821" }` gives 200.
  - `the upload seals with the key of the call that made the link`: issue with `KEY`, upload, and `codeForChecks(KEY)` is `"4821"`.
  - `no reply holds the code`: `JSON.stringify` of every result doesn't contain `"4821"`.
  - In `test/hub.test.ts`: `hubDoorCode reads both prefixes and rejects a short code`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement it, following today's `issueDoorCodeUpload` and `uploadDoorCode` (`liveDesk.ts:1337-1392`). A generated link that `HubGuards.leaks` flags is drawn again, up to 8 times. The key of the call that made the link stays in memory only.
- [ ] **Step 4:** Run `npx vitest run test/hubDoorAccess.test.ts test/hub.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `Hub door code upload link at /door-code/ (#165)`.

---

### Task 3: The door access request

**Files:**
- Modify: `src/hub/doorAccess.ts`
- Test: `test/hubDoorAccess.test.ts`

**Interfaces:**
- Consumes: `DoorAccess` (Task 1).
- Produces:
  - `interface AccessRequest { person: string; window: { from: string; until: string }; purpose: "cleaning" | "repair"; key?: Buffer }`
  - `type AccessGrant = { ok: true; kind: "code"; code: string; lockLocation?: string; until: string } | { ok: false; reason: "no-code" | "no-key" | "sealed" | "window-over" }`
  - `interface SavedCode { code: string; lockLocation?: string }`
  - `interface AccessProvider { grant(request: AccessRequest, saved: SavedCode): AccessGrant }`
  - `const ownCode: AccessProvider`, which grants the saved code until `window.until`
  - `DoorAccess.request(request: AccessRequest): AccessGrant`
  - `DoorAccess.useProvider(provider: AccessProvider): void`, for tests and #180

- [ ] **Step 1: Write failing tests.** Use `PERSON = "+15555550123"` and the window `{ from: "2026-11-07T15:00:00Z", until: "2026-11-09T05:00:00Z" }`.
  - `grants the saved code and lock location`: `{ ok: true, kind: "code", code: "4821", lockLocation: "back door", until }`.
  - `refuses no-code before anything is saved`.
  - `refuses no-key with an empty env and no key`.
  - `refuses sealed when the key doesn't open the seal`.
  - `refuses window-over when now is at or past until`. Exactly `until` is over.
  - `a fake second provider answers behind request()`: a provider returning `{ ok: true, kind: "code", code: "7392", until }` is the one used.
  - `a re-saved code replaces the open one`: save `"4821"`, call `request`, save `"7392"`. `request` and `codeForChecks` now give `"7392"`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement it. Check in this order: `no-code`, `no-key`, `sealed`, `window-over`, then the provider. The hub doesn't read `person` or `purpose`. They are for the provider.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `Hub door access request with the landlord's own code (#165)`.

---

### Task 4: Move existing seals into `door-access.json`

**Files:**
- Modify: `src/hub/migrate.ts`, `src/cleaner-core/hosted/migrate.ts:15-27` (add `"door-access.json"` to `PROPERTY_FILES`)
- Test: `test/hubMigration.test.ts`

**Interfaces:**
- Produces: `folderNeedsMove(root)` is also true when `cleaner-live.json` holds `pinSeal`, `lockLocation` or `doorCodeUpload`.

- [ ] **Step 1: Write failing tests.**
  - `moves the seal byte for byte`: a `cleaner-live.json` with `pinSeal` (sealed with a test key), `lockLocation`, `doorCodeUpload` and `doorCodeTo: "cleaner"`. After `hubFor(root, …)`, `door-access.json` has the same `pinSeal` object and lock location, and `upload` equals the old `doorCodeUpload`. `cleaner-live.json` has none of the three fields and still has `doorCodeTo`.
  - `moves the seal even when hub.json already exists`: write a `hub.json` first, then the same check.
  - `a crash after door-access.json is written: the next open finishes`: write both files as if mid-move. The next open removes the old fields and leaves `door-access.json` as it is.
  - `door-access.json is the record`: when both hold a `pinSeal`, the one in `door-access.json` stays.
- [ ] **Step 2:** Run `npx vitest run test/hubMigration.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement it as a separate step from the `hub.json` move, with the same order: write `door-access.json` (only when it doesn't exist), then remove the fields from `cleaner-live.json`.
- [ ] **Step 4:** Run `npx vitest run test/hubMigration.test.ts test/hub.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `Move door code seals into door-access.json on first open (#165)`.

---

### Task 5: LiveDesk keeps the code in the hub

**Files:**
- Modify: `src/cleaner-core/liveDesk.ts`:
  - `LiveFile` (drop `pinSeal`, `lockLocation`, `doorCodeUpload` at :386-411)
  - `openSeal` and `unlock` (:951, :3687)
  - `saveDoorCodeNow` and `issueDoorCodeUpload` (:1291-1392)
  - `useGuards` (:657)
  - `DOOR_CODE_UPLOAD_PREFIX` (:92, now `HUB_DOOR_CODE_PREFIX`)
- Modify: `src/cleaner-core/http.ts` (key helpers imported from `../hub/pinSeal`)
- Test: `test/cleanerScratchTools.test.ts`, `test/cleanerFullSetup.test.ts`, `test/cleanerCoreWiring.test.ts`, `test/propertyMigration.test.ts`, `test/cleanerCoreStepG.test.ts`, `test/hubCleaner.test.ts`

**Interfaces:**
- Consumes: `Hub.doorAccess(env)`, `DoorAccess.save`, `issueUpload`, `upload`, `codeForChecks`, `saved`, `lockLocation` (Tasks 1 and 2).
- Produces: LiveDesk's `pin` is filled only from `codeForChecks(key)`. `codeSaved()` is `doorAccess.saved()`. The engine still gets `pin` and `lockLocation` in its options until Task 6.

- [ ] **Step 1: Write failing tests in `test/hubCleaner.test.ts`.**
  - `save_door_code seals into door-access.json, not cleaner-live.json`.
  - `upload refuses digits in a waiting draft and keeps the link`: save a draft whose text holds `"4821"`, issue the link, and post `{ code: "4821" }`. The result is 400 with `CODE_IN_DRAFT`, and the body doesn't contain `"4821"`. Drop the draft, post again, and get 200.
  - `upload refuses digits in a saved answer`, with `CODE_IN_SAVED_ANSWER`.
  - `a link from save_door_code opens at /door-code/ and the old /cleaner-core/door-code/ path`.
- [ ] **Step 2:** Run `npx vitest run test/hubCleaner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.** Add the guard `codeRefused(code, lockLocation)` with today's checks: `carriesCode(lockLocation, code)`, `CODE_IN_SAVED_ANSWER` and `CODE_IN_DRAFT` (`liveDesk.ts:1301-1308`). `saveDoorCodeNow` keeps its own ordering checks (cleaner and calendar saved), then calls the hub, and keeps its reply and the `stale` flag when the lock location changed. `uploadDoorCode` keeps today's ordering refusal (cleaner and calendar saved), then delegates to `doorAccess.upload` inside `this.serial`, and adds today's success message to a 200. Update the five test files that read `pinSeal` from `cleaner-live.json` to read `door-access.json`. Change nothing else in them.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck`. Expected: PASS, with the five tests in Global Constraints unchanged.
- [ ] **Step 5:** Commit: `Cleaner Core saves and opens the door code through the hub (#165)`.

---

### Task 6: The engine asks the hub at release

**Files:**
- Create: `src/cleaner-core/doorPort.ts`
- Modify: `src/cleaner-core/core.ts`:
  - `CleanerCoreOptions` (:290-370) gets `access` and `accessRefused`
  - `deliverPin` (:2068-2135)
  - a new private `cleaningWindow(job)`
- Modify: `src/cleaner-core/liveDesk.ts`:
  - `openEngine` (:3413-3450) builds the port
  - `markGuestsLeftNow` (:2058) replies with the refusal line
- Test: `test/cleanerDoorPort.test.ts`

**Interfaces:**
- Consumes: `AccessGrant` (Task 3).
- Produces:
  - `interface DoorAccessPort { request(input: { person: string; window: { from: string; until: string }; purpose: "cleaning"; jobId: string }): Promise<AccessGrant>; codeForChecks(): string | undefined }`
  - `fixedCodePort(code: string, lockLocation?: string): DoorAccessPort`. It grants `code` for any window. It is for the CLI, scratch and tests.
  - `CleanerCoreOptions.access?: DoorAccessPort`
  - `CleanerCoreOptions.accessRefused?: Partial<Record<"no-code" | "no-key" | "sealed" | "window-over", string>>`. LiveDesk passes `PIN_KEY_MISSING`, `PIN_KEY_MISSING`, `PIN_REENTER`, and the new window line.
  - While this task is in progress, `options.pin` without `access` acts as `fixedCodePort(options.pin, options.lockLocation)`.

- [ ] **Step 1: Write failing tests in `test/cleanerDoorPort.test.ts`.** Copy the engine setup from `test/cleanerGroupFirst.test.ts`.
  - `the code text uses the grant's code and lock location`: a port whose `codeForChecks` returns `"4821"` and whose grant returns `"7392"` and `"side gate"`. After departure, the `pin` text's body holds `"7392"` and `"side gate"`.
  - `a refused grant sends the cleaner nothing and notes the host once`: the port refuses with `sealed`. No `pin` text, one host note equal to `accessRefused.sealed`. A second departure for the same job adds no note.
  - `the window runs from checkout to the end of the next check-in day`: the request's `window` for a job with checkout `2026-11-07 10:00` (America/New_York) and next check-in `2026-11-10` is `{ from: "2026-11-07T15:00:00.000Z", until: "2026-11-11T05:00:00.000Z" }`.
  - `with no next booking the window ends two days after checkout`: `until` is `"2026-11-09T05:00:00.000Z"` for checkout `2026-11-07`.
  - `a same-day turnover released in the evening still sends`: checkout and next check-in are both `2026-11-07`, the host says the guests left at `2026-11-07T23:30:00Z`, and the `pin` text goes out through a hub-backed port (a real `hubFor` on a temp folder with a saved code).
  - `after a restart the reminder pass sends the code once through the hub`: follow the step-G `recovery-after-restart` journey with only `CLEANER_CORE_PIN_KEY` in env. Exactly one `pin` text.
  - In `test/hubCleaner.test.ts`: `mark_guests_left replies with the window line when the window is over`.
- [ ] **Step 2:** Run `npx vitest run test/cleanerDoorPort.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it.** In `deliverPin`, keep every existing check. Replace `const pin = this.pin` with an awaited `access.request`, made only at the point where the text would be built. A refusal returns `sent` after `keepHostNote(`host:access-refused:${job.id}:${reason}`, line)`. `cleaningWindow` uses `checkoutReached`'s instant (the latest `checkout` fact) and the window rule in Global Constraints. LiveDesk's port:
  - `request` calls `hub.doorAccess(env).request({ ...input, key: this.lastKey })`, and records the reason for `markGuestsLeftNow`.
  - `codeForChecks` returns `this.pin`.
  - `this.lastKey` is the key of the tool call being served, and `undefined` on a tick, which falls back to the server's key.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `Cleaner Core releases the door code through the hub's request (#165)`.

---

### Task 7: The engine stores no code

**Files:**
- Modify: `src/cleaner-core/core.ts`:
  - remove `pin` and `lockLocation` from the options, plus `sealPinAtRest`, `pinKeyMaterial`, and `pinSeal` in `Stored` and `StoreFile` (:734, :775, :3552, :3617-3622, :3650)
  - `this.pin` comes from `access.codeForChecks()` at construction
  - `publishSetup` (:1485) passes `fixedCodePort(this.pin)`
- Modify: `src/hub/pinSeal.ts` (delete `pinKeyFor`), `src/cleaner-core/cli.ts:161,244,660` (`access: fixedCodePort(tenant.pin)`), `src/cleaner-core/liveDesk.ts` (drop the `pin`, `lockLocation` and `sealPinAtRest` options)
- Test: every test passing `pin:` or `lockLocation:` to `openCleanerCore` (`grep -rln "openCleanerCore" test | xargs grep -ln "pin:"`). Change only `pin: X, lockLocation: Y` to `access: fixedCodePort(X, Y)`. Also `test/cleanerCoreWiring.test.ts` (drop `pinKeyFor`).

**Interfaces:**
- Consumes: `fixedCodePort`, `DoorAccessPort` (Task 6).

- [ ] **Step 1: Write failing tests in `test/cleanerDoorPort.test.ts`.**
  - `the engine store never holds a seal`: run the CLI smoke with its made-up code. The engine's store JSON has no `pinSeal` key.
  - `an old store's pinSeal is ignored and dropped on the next save`: seed a store with `pinSeal`, open, tick, and the saved store has no `pinSeal`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Remove the options and the seal, and convert the callers and tests.
- [ ] **Step 4:** Run `npm test`, `npm run typecheck` and `scripts/ci-check.sh`. Expected: PASS, with the five tests in Global Constraints unchanged.
- [ ] **Step 5:** Commit: `The engine stores no door code; the CLI passes its made-up code (#165)`.

---

### Task 8: Boundaries, gates and the full proof

**Files:**
- Modify: `test/hubBoundaries.test.ts`, `docs/cleaner-core-safety-gates.md` (the "Door code" row)
- Test: `test/cleanerCoreWiring.test.ts` (scanner)

- [ ] **Step 1: Write the tests.**
  - `test/hubBoundaries.test.ts`, `only the hub reads pinSeal`: no `.ts` file outside `src/hub/` contains the token `pinSeal`, or imports `hub/pinSeal`, except for `pinKeyFromHeader` and `serverPinKey`, which `src/cleaner-core/http.ts` imports through `src/hub/doorAccess.ts`. Re-export them there, and point `http.ts` at it.
  - `the secret scan catches a code sealed in door-access.json`: write a `door-access.json` sealed with `TEST_SEAL_KEY` (`scripts/cleaner-seal-test-key.mjs`) into a temp folder, run `scripts/scan-cleaner-secrets.mjs` on it, and expect it to report the code.
- [ ] **Step 2:** Run them. Expected: PASS after the re-export. Any other offender is a bug from an earlier task, to fix there.
- [ ] **Step 3: Update the "Door code" row.** Append: `The sealed code lives in the property hub's door-access.json. Cleaner Core gets it only through the hub's door access request, after its own approval, opt-in, channel and release checks.` Add `test/hubDoorAccess.test.ts` and `test/cleanerDoorPort.test.ts` to its proof.
- [ ] **Step 4:** Run `npm run typecheck`, `npm test` and `scripts/ci-check.sh`, then the verify-cleanercore skill's offline proof, `.cursor/skills/verify-cleanercore/scripts/prove-step-g.sh`. Expected: every step passes. `evidence/step-g/permanent-code` passes, and nothing texts a real phone.
- [ ] **Step 5:** Commit: `Gates and boundaries for door access in the hub (#165)`.
