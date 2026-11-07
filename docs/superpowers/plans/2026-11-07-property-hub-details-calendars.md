# Property hub: property details and calendars — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One hub per property holds its details and booking calendars. Cleaner Core and Supply Core both read it, Supply Core imports nothing from Cleaner Core, and there is one calendar upload flow.

**Architecture:** A new `src/hub/` module owns `hub.json` in each property folder. The calendar parsing and fetching code moves there. Cleaner Core plugs in two guards (door code, would-cancel) without the hub importing it. Existing data moves into `hub.json` the first time a folder is opened, and on the shared service at startup.

**Tech Stack:** TypeScript, Node 22, vitest, `writeJsonAtomic` (`src/storage/atomicWrite.ts`).

**Spec:** `docs/superpowers/specs/2026-11-07-property-hub-details-calendars-design.md`

## Global Constraints

- Tests use 555 numbers and made-up door codes only (`AGENTS.md`). Nothing texts a real phone, and there is no live run.
- `src/hub/` imports nothing from `src/cleaner-core/` or `src/supply-core/`. `src/supply-core/` imports nothing from `src/cleaner-core/`.
- No tool's name or input shape changes. Replies read as they do today, except where this plan quotes new copy.
- A calendar link, upload code or door code never appears in a reply, log or error. Only the sha256 of an upload code is stored.
- Upload links: 32 random bytes, base64url (43 characters), 10 minutes, and a new one replaces the last.
- At most 8 calendars (`MAX_CALENDARS`, today's value in both desks).
- The set-aside line, verbatim, with names joined by ", ": `Supply Core had its own calendars (<names>) that aren't in this property's list. Ask the host whether to add them.`
- Hub reads and writes are synchronous on an in-memory copy, saved with `writeJsonAtomic`. The only awaits are calendar fetches and the `wouldCancel` guard. After an await, re-read hub state before writing.
- `hub.setCalendars` never calls `wouldCancel`. Cleaner Core checks it itself before saving. Only the upload path calls the guard. Otherwise a save from inside `LiveDesk.serial` deadlocks on its own queue.

## Review Focus

1. **A migrated legacy Guesty Lite link must keep the source id `guesty-lite`.** If it became `ical:guesty-lite`, the engine would think the calendar was replaced and call off every cleaning from it. Task 2 pins this with `keeps the legacy link's source id`.
2. **A desk built before the move must not write the old fields back.** `LiveDesk` loads `cleaner-live.json` once in its constructor and later writes the whole object. Task 5 pins this with `a desk opened after the move never writes calendars back`.
3. **A Supply-only property's calendar link must work end to end** while its env has `CLEANER_CORE_ENABLED=0`: the page opens, a POST saves, and no Cleaner Core guard calls off anything. Task 8 pins this with `supply-only property: the calendar page opens and saves`.
4. **Two upload links issued from different flows**: only the newest works. Task 3 pins this with `a second link replaces the first, from either flow`.
5. **A Google-only property with no events passed to `check_supplies`** keeps its last good checkout dates and counts as a failed read, never as zero stays. Task 4 pins this with `google saved but no events keeps the last dates`.

---

## File map

| File | Responsibility |
|---|---|
| `src/hub/calendar.ts`, `src/hub/sources.ts`, `src/hub/fetchLimits.ts` | Moved from `src/cleaner-core/` with no changes beyond import paths |
| `src/hub/ask.ts` | `AskQuestion` and `askNext`, moved from `src/cleaner-core/setupAsk.ts` |
| `src/hub/calendarFetch.ts` | `setCalendarFetch`, `calendarFetch` (the test override) |
| `src/hub/calendars.ts` | `SavedCalendar`, `CalendarClaim`, `savedCalendars`, `claimsOf`, `calendarSlug`, `originOf`, `LEGACY_CALENDAR`, link checks |
| `src/hub/store.ts` | `HubFile`, `readHubFile`, `HUB_FILE = "hub.json"` |
| `src/hub/hub.ts` | `Hub` class, `hubFor`, `forgetHub`, `resetHubs`, guards, upload flow, `readCalendars` |
| `src/hub/migrate.ts` | Moving data from `cleaner-live.json` and `supply.json` into `hub.json` |
| `src/hub/paths.ts` | `HUB_CALENDAR_PREFIX` and `hubCalendarCode(path)`, which accepts all three prefixes |
| `src/hosted/supplies.ts` | Moved from `src/supply-core/hosted.ts` |

---

### Task 1: Move the shared calendar code into `src/hub/`

**Files:**
- Move: `src/cleaner-core/{calendar,sources,fetchLimits}.ts` → `src/hub/` (`git mv`)
- Create: `src/hub/ask.ts`, `src/hub/calendarFetch.ts`
- Modify: every importer (`grep -rln "cleaner-core/\(calendar\|sources\|fetchLimits\)" src test`), `src/cleaner-core/setupAsk.ts`, `src/supply-core/setupAsk.ts`, `src/cleaner-core/liveDesk.ts:487-497`
- Test: `test/hubBoundaries.test.ts`

**Interfaces:**
- Produces: `setCalendarFetch(fetch: CalendarFetch | undefined): void` and `calendarFetch(): CalendarFetch` in `src/hub/calendarFetch.ts`. `calendarFetch()` returns the override, else the platform `fetch`.
- Produces: `AskQuestion` and `askNext` exported from `src/hub/ask.ts`. `src/cleaner-core/setupAsk.ts` re-exports both, so Cleaner Core's own importers don't change.
- `setCleanerCalendarFetch` and `cleanerCalendarFetch` stay exported from `liveDesk.ts` as one-line aliases of the hub's. 22 test files use them.

- [ ] **Step 1: Write the failing test** `test/hubBoundaries.test.ts` → `src/hub imports neither flow`. Walk `src/hub/**/*.ts`, collect every `from "…"` and `import("…")` specifier, resolve it against the file, and assert no path contains `/cleaner-core/` or `/supply-core/`. Also assert that `src/hub/calendar.ts` exists, so the test fails before the move.
- [ ] **Step 2:** Run `npx vitest run test/hubBoundaries.test.ts`. Expected: FAIL (no `src/hub/`).
- [ ] **Step 3:** `git mv` the three files, create `ask.ts` and `calendarFetch.ts`, and fix every import, touring's `formatWhen` included. Supply Core imports `calendarFetch` from `src/hub/calendarFetch.ts`, not from `liveDesk`.
- [ ] **Step 4:** Run `npm run typecheck && npx vitest run`. Expected: PASS, and the same number of tests as before plus the new one.
- [ ] **Step 5: Commit** `Move the calendar reader and ask shape into src/hub (#165)`.

### Task 2: Hub store, property details and calendars

**Files:**
- Create: `src/hub/calendars.ts`, `src/hub/store.ts`, `src/hub/hub.ts`
- Test: `test/hub.test.ts`

**Interfaces:**
- Produces, in `src/hub/calendars.ts`:
  - `LEGACY_CALENDAR = "Guesty Lite"`
  - `interface StoredCalendar { name: string; url: string; legacy?: true }`. `legacy` marks the migrated single link.
  - `interface SavedCalendar { name: string; url: string; sourceId: string; origin: string }`
  - `interface CalendarClaim { id: string; origin?: string }`
  - `savedCalendars(list: StoredCalendar[]): SavedCalendar[]`. A `legacy` entry gets `sourceId: "guesty-lite"`. Others get `ical:<slug>`, from today's `calendarSlug` (`liveDesk.ts:553`) over the non-legacy entries in order.
  - `claimsOf(list: StoredCalendar[], google: boolean): CalendarClaim[]`
  - `originOf(url): string` (16 hex characters of sha256)
  - `maskedLink(url): boolean`
  - `calendarRefusal(name, url): string | undefined`. Checks masked links, `calendarUrlAllowed`, and `refuseCards` (move `src/supply-core/cards.ts` to `src/hub/cards.ts` and have Supply Core import it from there).
- Produces, in `src/hub/store.ts`: `HubFile`, exactly as in the spec, with `calendars: StoredCalendar[]` and `calendarUpload.by?: HubCaller`, where `type HubCaller = { assistant: string; connectionId?: string }`. `CleanerCaller` fits it.
- Produces, in `src/hub/hub.ts`:
  - `hubFor(root: string, deps: { now(): Date; migrate?: { cleaningInUse: boolean } }): Hub`, cached per root
  - `forgetHub(root)`, `resetHubs()`. `resetLiveDesks()` calls `resetHubs()`, and `forgetLiveDesk(root)` calls `forgetHub(root)` (`liveDesk.ts:539-546`), so the existing tests and `src/cleaner-core/hosted/admin.ts:326-327` drop both without further changes.
  - `class Hub` with:
    - `property(): HubFile["property"]`
    - `saveProperty(p: Partial<HubFile["property"]>): void`
    - `calendars(): SavedCalendar[]`, `stored(): StoredCalendar[]`, `google(): boolean`, `calendarsDone(): boolean`
    - `claims(list?: StoredCalendar[], google?: boolean): CalendarClaim[]`
    - `setCalendars(input: { calendars?: StoredCalendar[]; google?: boolean; done?: boolean }): { ok: true } | { ok: false; error: string }`
    - `useGuards(provider: () => HubGuards | undefined): void`
    - `setAside(): string[]` (names only)
    - `clearSetAside(): void`
  - `HubGuards` as in the spec. `setCalendars` checks `calendarRefusal`, then `carriesCode` on every name and link when guards are connected, else refuses a name with `/\d{4,}/`. It enforces the 8-calendar limit and clears `calendarsSetAside` on success. It never calls `wouldCancel`.
- The refusal copy is today's Cleaner Core copy (`liveDesk.ts:1248-1255`) and `DOOR_CODE_IN_CHAT`. Move the strings to `src/hub/calendars.ts`, and have Cleaner Core import them.

- [ ] **Step 1: Write the failing tests** in `test/hub.test.ts`:
  - `saves and reloads property details` (a new `hubFor` after `resetHubs()` reads them back)
  - `keeps the legacy link's source id`: `savedCalendars([{name:"Guesty Lite",url:A,legacy:true},{name:"Airbnb",url:B}])` → source ids `["guesty-lite","ical:airbnb"]`
  - `slugs match Cleaner Core's`: two calendars named `Airbnb` and `airbnb!` → `ical:airbnb`, `ical:airbnb-2`
  - `refuses masked, private and card links`
  - `refuses more than 8 calendars`
  - `with guards, carriesCode refuses a name or link`
  - `without guards, a name with 4 digits is refused`
  - `setCalendars never calls wouldCancel`: the guard's `wouldCancel` throws, and the save still succeeds
- [ ] **Step 2:** Run `npx vitest run test/hub.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement the three files. A missing `hub.json` reads as `{ schemaVersion: 1, property: {}, calendars: [] }`.
- [ ] **Step 4:** Run `npx vitest run test/hub.test.ts test/hubBoundaries.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `Hub store: property details and calendars (#165)`.

### Task 3: The hub's upload flow

**Files:**
- Create: `src/hub/paths.ts`
- Modify: `src/hub/hub.ts`
- Test: `test/hub.test.ts`

**Interfaces:**
- Produces, in `src/hub/paths.ts`:
  - `HUB_CALENDAR_PREFIX = "/calendar-link/"`
  - `hubCalendarCode(path: string): string | undefined`, which accepts `/calendar-link/`, `/cleaner-core/calendar-link/` and `/supply/calendar/` followed by `^[A-Za-z0-9_-]{43}$`
- Produces, on `Hub`:
  - `issueCalendarUpload(input: { name: string; google?: boolean; base: string; by?: HubCaller }): { uploadUrl: string; expiresInMinutes: 10 } | { error: string }`. The `uploadUrl` is `${base}${HUB_CALENDAR_PREFIX}${code}`. Callers pass their own base: Cleaner Core `publicBaseUrl(env)`, Supply Core `uploadBase()`. The name is checked like a calendar name.
  - `uploadLinkOpen(code: string): { open: boolean; name?: string; by?: HubCaller }`, which only reads
  - `uploadCalendarLink(code: string, body: Record<string, unknown>): Promise<{ status: 200 | 400 | 404 | 409; body: { ok: boolean; message?: string; error?: string } }>`
- `uploadCalendarLink` flow:
  1. Check the hash and expiry. An expired link is deleted, then 404.
  2. Check the link (400).
  3. Build the next list: replace the entry with the same name, case-insensitive, and keep the others. Replacing the legacy entry drops its `legacy` flag.
  4. `await guards?.wouldCancel(claims(next))`. A non-empty result → 409 with today's copy.
  5. Re-read state. If the pending hash changed meanwhile, return 404.
  6. Save, delete the pending link, 200.
  
  The copy is Cleaner Core's `UPLOAD_GONE`, `CALENDAR_UPLOAD_REFUSED`, `CALENDAR_UPLOAD_SAVED`, moved to the hub.

- [ ] **Step 1: Write the failing tests:**
  - `issues a link whose code is stored only as its hash`: assert `hub.json` doesn't contain the code
  - `a second link replaces the first, from either flow`: issue with base A, then with base B. Code A → 404, code B → 200.
  - `expired after 10 minutes`: advance the fake clock 10 minutes → 404, and the pending link is removed
  - `refuses a private link with 400 and keeps the link usable`
  - `409 when wouldCancel names cleanings, and nothing saved`
  - `same name replaces only that calendar`
  - `hubCalendarCode accepts all three prefixes`
  - `no reply or thrown error contains the link`: run every path with a link holding `secret-token-xyz` and assert it's absent from each JSON body
- [ ] **Step 2:** Run `npx vitest run test/hub.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run test/hub.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `Hub upload flow for calendar links (#165)`.

### Task 4: Reading the calendars and checkout dates

**Files:**
- Modify: `src/hub/hub.ts`
- Test: `test/hub.test.ts`

**Interfaces:**
- Produces: `Hub.readCalendars(input: { googleEvents?: GoogleEventList; tenantId: string }): Promise<HubRead>` where
  ```ts
  interface HubRead {
    links: { calendar: SavedCalendar; read: { ok: true; body: string } | { ok: false; reason: string } }[];
    /** Undefined when Google isn't saved or no events were passed. */
    google?: SourceSnapshot;
    googleUnread: boolean;
  }
  ```
  `googleUnread` follows today's rule (`liveDesk.ts:1715-1723`): events present, but none reads as a stay or a block. Links are fetched with `readPublicCalendar(url, calendarFetch())`, all at once.
- After the reads, `checkouts.dates` is the sorted, de-duplicated set of `interpretFeed(body).turnovers[].checkoutDate` plus Google's turnovers, and `checkouts.at` is now. That happens only when every link read ok, and Google (if saved) has a snapshot that isn't unread. Otherwise `checkouts.failedAt` is set and the dates stay as they were. With no calendars and no Google, nothing changes.
- Produces: `Hub.checkouts(): { dates: string[]; at?: string; failedAt?: string } | undefined`

- [ ] **Step 1: Write the failing tests:**
  - `reads every link and returns results per calendar`
  - `stores checkout dates only when every calendar read`
  - `a failed read keeps the last dates and sets failedAt`
  - `google saved but no events keeps the last dates` (`failedAt` is set)
  - `two calendars listing the same checkout count it once`
  - `google events ignored when google isn't saved`
- [ ] **Step 2:** Run `npx vitest run test/hub.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run test/hub.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `Hub reads the calendars and keeps checkout dates (#165)`.

### Task 5: Moving existing data into `hub.json`

**Files:**
- Create: `src/hub/migrate.ts`
- Modify: `src/hub/hub.ts` (`hubFor` calls it), `src/web/server.ts:395` (after `migrateRegistry`, call `migrateHubs`), `src/cleaner-core/hosted/migrate.ts:15` (add `"hub.json"` to `PROPERTY_FILES`)
- Test: `test/hubMigration.test.ts`

**Interfaces:**
- Produces:
  - `migrateFolder(root: string, cleaningInUse: boolean): void`. It's idempotent and runs inside `hubFor` when `hub.json` is missing or either old file still has a moved field.
  - `migrateHubs(dataRoot: string, accounts: Tenant[], now: () => Date): void` in `src/hosted/hubStartup.ts`, because it needs the property model. For every property of every account, it calls `hubFor(propertyFolder(dataRoot, tenant.id, property), { now, migrate: { cleaningInUse: property.flows.cleaning.on } })`. `server.ts` calls it once the registry is loaded, with `registry.list()`.
- `hubFor` with no `migrate` option uses `cleaningInUse: true`. That's the single-folder rule, and every hosted folder has already been moved at startup.
- Fields moved out of `cleaner-live.json`: `nickname, address, propertyType, timeZone, checkoutTime, checkInTime, calendarLink, calendars, google, sourcesDone, calendarUpload`. Out of `supply.json`: `settings.property, sources, calendarUpload, checkouts, setup.sourcesDone`.
- Mapping from `supply.json`:
  - `settings.property.name` → `nickname`, and its address and time zone fill whatever Cleaner Core never saved
  - an ical source → `{ name, url }`
  - a `google-calendar` source → `google: true`
- Cleaner Core's `calendarLink` → `{ name: "Guesty Lite", url, legacy: true }`, placed first.
- Write order and the rules are the spec's "Moving existing data", word for word: write `hub.json`, then strip `cleaner-live.json`, then strip `supply.json`.

- [ ] **Step 1: Write the failing tests:**
  - `moves Cleaner Core's details and calendars`
  - `Cleaner Core's details win; Supply Core fills the gaps`
  - `only Supply Core has calendars: the hub takes them`
  - `both have calendars, cleaning on: Cleaner Core's list, Supply's extra set aside`: `setAside()` returns `["Airbnb"]`, and `calendars()` doesn't include it
  - `both have calendars, cleaning off: Supply Core's list wins`
  - `the legacy link moves with legacy: true`
  - `Cleaner Core's pending upload moves; Supply Core's is dropped`
  - `Supply Core's last checkouts move`
  - `a crash after hub.json is written is finished by the next open`: write `hub.json` by hand with the old files untouched, then `hubFor` strips both
  - `a desk opened after the move never writes calendars back`: migrate, open `liveDeskFor`, save people, and assert `cleaner-live.json` has no `calendars` key
  - `migrateHubs uses each property's cleaning switch`
- [ ] **Step 2:** Run `npx vitest run test/hubMigration.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Leave the "desk never writes back" test failing until Task 6 makes `LiveDesk` open the hub first. Mark it `it.todo` here and turn it into `it` in Task 6.
- [ ] **Step 4:** Run `npx vitest run test/hubMigration.test.ts test/propertyMigration.test.ts`. Expected: PASS, with one todo.
- [ ] **Step 5: Commit** `Move property details and calendars into hub.json on first open (#165)`.

### Task 6: Cleaner Core reads its property and calendars from the hub

**Files:**
- Modify: `src/cleaner-core/liveDesk.ts`:
  - `LiveFile` (366-456): drop the moved fields, and add them to a `LegacyMovedFields` type used only by tests
  - the constructor (691): `this.hub = hubFor(root, { now })` before `this.load()`
  - `saveProperty`
  - `saveSourcesNow` (1241)
  - `issueCalendarUpload` (1282), `uploadCalendarLink` (1305)
  - `readCalendars` (1706)
  - `uploadLinkOpen` (3639)
  - `propertyForSupplies` and `turnoverDates` (1951-1962): delete both
  - `calendarsOf`, `claimsOf`, `hasSources`, `calendarSlug`, `originOf`, `maskedLink`: delete, and use the hub's
- Modify: `src/cleaner-core/http.ts`: `handleCleanerCalendarUpload` calls `hubFor(root, { now }).uploadCalendarLink`
- Modify: `src/cleaner-core/setupAsk.ts`: the property and sources steps read from the hub
- Test: `test/hubCleaner.test.ts`, plus the existing suite

**Interfaces:**
- Consumes: Tasks 2–4's `Hub`.
- `LiveDesk` reads every moved field through `private place(): HubFile["property"]` and `this.hub.calendars()` / `.google()` / `.calendarsDone()`. A mechanical replacement of `this.file.<field>`: about 90 reads (`grep -c "file\.\(address\|timeZone\|nickname\|propertyType\|checkoutTime\|checkInTime\|calendars\|calendarLink\|google\|sourcesDone\|calendarUpload\)\b" src/cleaner-core/liveDesk.ts`). `business` stays in `LiveFile`.
- The constructor calls `this.hub.useGuards(() => ({ carriesCode: (t) => this.carriesCode(t), wouldCancel: (claims) => cleanerCoreEnabledOrUnset(this.env()) ? this.serial(async () => { this.resume(); return this.engine?.wouldCancel(claims) ?? []; }) : Promise.resolve([]) }))`. Here `cleanerCoreEnabledOrUnset` is `env.CLEANER_CORE_ENABLED?.trim() !== "0"`: the hosted env sets `"0"` when cleaning is off for the property (`router.ts:133`). The single-folder env leaves it unset during setup.
- `saveSourcesNow` builds the next `StoredCalendar[]`, keeps its own `wouldCancel` check with `dropJobs`, then calls `this.hub.setCalendars`. Calling it with anything clears `calendarsSetAside` (Task 2).
- `get_state` and `check_now` add `setAsideLine` when `this.hub.setAside()` isn't empty, using the copy in Global Constraints.

- [ ] **Step 1: Write the failing tests** in `test/hubCleaner.test.ts`. Reuse `openDesk` from `test/cleanerSupplyDesk.test.ts:34`, the 555 numbers from `test/wiringProof.ts`, and `DOOR_CODE`.
  - `save_property writes hub.json and cleaner-live.json has no address`
  - `save_sources saves to the hub; dropJobs still guards`
  - `an upload that would call off a cleaning gets 409`
  - `an upload whose link holds the door code is refused`
  - `with CLEANER_CORE_ENABLED=0, wouldCancel is empty`
  - `get_state carries the set-aside line, and a save clears it`
  - Turn Task 5's `todo` into a real test.
- [ ] **Step 2:** Run `npx vitest run test/hubCleaner.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Change existing tests only where they *set up* moved fields in `cleaner-live.json` or read them back (`grep -rln "calendarLink\|\"calendars\"\|calendarUpload" test`). Those tests write `hub.json` instead. No assertion on behavior changes.
- [ ] **Step 4:** Run `npm run typecheck && npx vitest run`. Expected: everything passes, `test/cleanerCoreStepG.test.ts` included.
- [ ] **Step 5: Commit** `Cleaner Core reads property details and calendars from the hub (#165)`.

### Task 7: Calendar links on the shared service go to the hub

**Files:**
- Modify: `src/cleaner-core/hosted/router.ts`:
  - 228-229: path recognition uses `hubCalendarCode`
  - 316-318: the gate
  - 357-366: `supplyCalendar` branch removed; calendar POSTs go to the hub
- Modify: `src/cleaner-core/http.ts:98-118`: `uploadPageOf` uses `hubCalendarCode`. The page handler's `calendar-link` kind reads `hub.uploadLinkOpen` and saves through `hub.uploadCalendarLink`.
- Test: `test/cleanerHostedRouter.test.ts`

**Interfaces:**
- Consumes: `hubCalendarCode`, `Hub.uploadLinkOpen`, `Hub.uploadCalendarLink`.
- The gate: a calendar-link path (page or POST) is served while `property.flows.cleaning.on || property.flows.supplies.on`. Every other path keeps `cleaning.on`.

- [ ] **Step 1: Write the failing tests:**
  - `new /calendar-link/ path saves to the hub`
  - `old /cleaner-core/calendar-link/ and /supply/calendar/ paths still save`
  - `supply-only property: the calendar page opens and saves` (Review Focus 3)
  - `a property with no flow on: 404`
- [ ] **Step 2:** Run `npx vitest run test/cleanerHostedRouter.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement. If the page handler refuses because the property's env has the Cleaner Core flag off, pass the hub's open state to the page instead of the desk's. The page renders the same.
- [ ] **Step 4:** Run `npx vitest run test/cleanerHostedRouter.test.ts test/twoPropertiesEndToEnd.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `One calendar link for every flow on the shared service (#165)`.

### Task 8: Supply Core on the hub, and off Cleaner Core

**Files:**
- Move: `src/supply-core/hosted.ts` → `src/hosted/supplies.ts` (`git mv`), and fix importers (`src/hosted/frontMcp.ts:15`, `src/hosted/service.ts`, `src/cleaner-core/hosted/router.ts`, tests)
- Modify: `src/supply-core/desk.ts`:
  - `SupplyDeps` (28-37): remove `standalone` and `cleaning`, and add `hub(): Hub`
  - `property()` (175)
  - `checkoutDates` (436-442)
  - `readCalendars` (445): delete
  - `saveSources` (468-495) and `uploadCalendarLink` (497-516): delegate to the hub
  - `adoptProperty` (546): delete
  - `check_supplies` (669)
  - `SUPPLY_CALENDAR_PREFIX` and `supplyCalendarCode`: delete
- Modify: `src/supply-core/store.ts`: drop `sources`, `calendarUpload`, `checkouts`, `setup.sourcesDone`, `settings.property` from `SupplyFile`
- Modify: `src/supply-core/setupAsk.ts`: `supplySetupAsk(file: SupplyFile, hub: Hub)`
- Modify: `src/hosted/service.ts:106`: remove the `adoptProperty` call
- Test: `test/hubBoundaries.test.ts`, `test/supplyDesk.test.ts`, `test/supplyHosted.test.ts`, `test/supplyProperty.test.ts`

**Interfaces:**
- Consumes: `Hub.property`, `Hub.saveProperty`, `Hub.setCalendars`, `Hub.issueCalendarUpload`, `Hub.readCalendars`, `Hub.checkouts`, `Hub.setAside`.
- `property()`: when the hub has an address and a time zone, `{ name: nickname ?? address.split(",")[0].trim(), address, timeZone }`, else undefined.
- `save_supply_settings` with `property` → `hub.saveProperty({ nickname: name, address, timeZone })`. It no longer refuses when Cleaner Core is on.
- `check_supplies`: when the hub has any calendar or Google, `await hub.readCalendars({ googleEvents, tenantId: "supply" })` first. A failed read still sets `sourcesFailed` and the same `next` copy.
- `get_supply_state` carries the set-aside line too.

- [ ] **Step 1: Write the failing tests:**
  - In `test/hubBoundaries.test.ts`: `src/supply-core imports nothing from src/cleaner-core`
  - In `test/supplyDesk.test.ts`: `with cleaning on, checkouts come from the calendars`, and `a cleaning the host called off still counts while the booking is on the calendar`: Cleaner Core desk with a job called off, the calendar still lists the stay, and a by-bookings item with `stays: 1` is due.
  - `save_supply_sources saves to the shared calendars when Cleaner Core is on`
  - `Supply Core's setup skips the property and calendar steps that Cleaner Core already finished`
- [ ] **Step 2:** Run `npx vitest run test/hubBoundaries.test.ts test/supplyDesk.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement. Existing Supply tests change their setup from `standalone: true` / `cleaning: {...}` to a hub in the same folder. Their assertions stay, except where a test asserted Cleaner Core's turnovers were used: that test now asserts the calendar's dates.
- [ ] **Step 4:** Run `npm run typecheck && npx vitest run`. Expected: everything passes.
- [ ] **Step 5: Commit** `Supply Core reads the hub and imports nothing from Cleaner Core (#165)`.

### Task 9: Gates, docs and the full proof

**Files:**
- Modify: `docs/cleaner-core-safety-gates.md`: the "Fetch limits" row, and the new "Shared calendars" row (wording in the spec's Safety gates section)
- Modify: `docs/supply-core-safety-gates.md`: the new row
- Modify: `SUPPLY_CORE_BOOTSTRAP.md`, `supply-template/`, `docs/superpowers/specs/2026-11-04-supply-core-design.md` (lines 95, 142, 162, 237), wherever text says Supply Core's calendars or property come from Cleaner Core (`grep -rn "from Cleaner Core\|Cleaner Core's turnovers" *.md docs supply-template cleaner-template muse-template`)

- [ ] **Step 1:** Make the doc edits.
- [ ] **Step 2:** Run `npm run typecheck`. Expected: no errors.
- [ ] **Step 3:** Run `npx vitest run`. Expected: everything passes, with the count printed.
- [ ] **Step 4:** Run `bash scripts/ci-check.sh`. Expected: exit 0, and the secret scan clean.
- [ ] **Step 5:** Run the verify-cleanercore skill's offline proof, `.cursor/skills/verify-cleanercore/scripts/prove-step-g.sh`. Expected: every gate green. Nothing is sent to a real phone.
- [ ] **Step 6: Commit** `Gates and docs for the property hub (#165)`.
