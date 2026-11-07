# Accounts with several properties: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One account holds several properties on its one text line. Each property switches Cleaner Core, Supply Core and Fixer Core on or off, and existing tenants migrate without breaking.

**Architecture:** The account stays the `Tenant` record. Each property gets its own folder, `tenants/<id>/properties/<pid>/`, which is the root of an unchanged `LiveDesk` and `SupplyDesk`. A thin account layer:
- picks the property from a `property` tool argument, from the `/t/<id>/p/<pid>/` path, or from the sender of a one-to-one text;
- replaces the service switch with `add_property` and `set_flows`.

A one-time v2 → v3 migration at startup moves each tenant's files into its first property.

**Tech Stack:** TypeScript (ESM), Node 22, vitest, MCP over HTTP, Twilio (always faked in tests).

**Spec:** `docs/superpowers/specs/2026-11-06-property-core-accounts-properties-design.md`. Read it before starting any task. Section numbers below (§) refer to it.

## Global Constraints

- Tests use only 555 numbers. Door codes are made up. Twilio is always the fake client (`fakeSms()`, `fakeConversations()`). Nothing texts a real phone.
- `docs/cleaner-core-safety-gates.md` and `docs/supply-core-safety-gates.md` stay green. The door-code gate does not change.
- Secrets never go into code, logs, fixtures or errors.
- Tour Core is parked. Its tests keep passing. Build no new touring paths.
- `LiveDesk` and `SupplyDesk` keep one property per folder. Only the methods named in Task 7 are added to `LiveDesk`.
- Property ids are `prp_` + 10 characters of `[a-z0-9]`. A migrated property's id is `prp_` + the tenant id's 10 characters.
- Links: `/t/<id>/…` for a property with `legacyPaths`, `/t/<id>/p/<pid>/…` for every other.
- Exact copy (tests assert these strings):
  - `LANDLORD_USE_AGENT = "Please tell me in your agent chat so I know which property."`
  - `phoneTaken(label) = \`That number is already on ${label}. For now one person can be on only one property.\``
  - `flowOff(flow, label) = \`${flow} isn't on for ${label}.\``, with flow `"Cleaner Core"` or `"Supply Core"`
  - `FIXER_NOT_YET = "Fixer Core isn't available yet."`
  - `nameProperty(list) = \`Which property? Pass property as one of: ${list}.\``, where list is `prp_… (12 Scratch Lane), prp_… (8 Scratch Court)`
  - A text to the landlord when the account has 2+ properties: `${label}: ${body}`
- The landlord's "use your agent" reply goes out at most once every 12 hours per phone.
- Run `npx tsc --noEmit -p .` and `npx vitest run <files>` before each commit. End each commit message with the session's attribution lines.

## Review Focus

These cases are implied by the spec but no section names them. Each one has its test in the task shown.

1. **The agent passes the property's label instead of its id** ("12 Scratch Lane"). Expected: an exact, case-insensitive match on a label, unique within the account, resolves it. Anything else gets the `nameProperty` refusal. Test in Task 5.
2. **The same phone typed differently** ("(555) 555-0101" and "+15555550101") on two properties. Expected: the one-property-per-person check compares phones with `parsePhone`, so it refuses. Test in Task 8.
3. **A v2 cleaning tenant with the Supply Core add-on and both `cleaner-live.json` and `supply.json`**. Expected: both files move to the one property, which gets both flows on. Its Supply Core still reads Cleaner Core's turnovers. Test in Task 2.
4. **The landlord's STOP on a two-property account.** Expected: every property records it, and the landlord gets one confirmation per property, each starting with that property's label. No property keeps texting them. Test in Task 8.
5. **A desk opened before the migration ran.** It would be cached at the old root. Expected: migration runs before the server builds any desk. Startup refuses to serve while `tenants.json` is below v3. Test in Task 2.

---

### Task 1: Property model and registry v3

**Files:**
- Create: `src/cleaner-core/hosted/properties.ts`
- Modify: `src/cleaner-core/hosted/registry.ts`
- Test: `test/cleanerHostedRegistry.test.ts`

**Interfaces:**
- Produces, in `properties.ts`:
  - `type FlowName = "cleaning" | "supplies" | "fixer"`
  - `interface Flow { on: boolean; changedAt?: string }`
  - `interface Property { id; label; createdAt; flows: Record<FlowName, Flow>; legacyPaths?: true }`
  - `isPropertyId(v: string): boolean`
  - `newPropertyId(taken: (id: string) => boolean): string`
  - `migratedPropertyId(tenantId: string): string`
  - `propertyFolder(dataRoot: string, tenantId: string, property: Property): string` returns `join(tenantFolder(…), "properties", property.id)`
  - `propertyBasePath(tenantId: string, property: Property): string` returns `/t/<id>` or `/t/<id>/p/<pid>`
  - `findProperty(tenant: Tenant, ref: string): Property | undefined` matches an id, or an exact case-insensitive label that is unique within the account
- Produces, in `registry.ts`:
  - `Tenant.service?: "touring"` and `Tenant.properties: Property[]`. The `supplies` field is removed.
  - The document is `schemaVersion: 3`.
  - `read()` throws `RegistryError("needs-migration")` on a file older than 3.
  - New methods: `addProperty(tenantId, label): Property`, `setFlow(tenantId, propertyId, flow: FlowName, on: boolean): Property`, `setTouring(tenantId): void` (refused when the account has properties).
  - `setService` and `setSupplies` are removed.
  - `RegistryError` reasons gain `"needs-migration" | "unknown-property" | "bad-label" | "has-properties" | "fixer-not-yet"`.

- [ ] **Step 1: Write failing tests** in `test/cleanerHostedRegistry.test.ts`:
  - `"adds a property with every flow off"`: `addProperty(id, "12 Scratch Lane")` gives `flows.cleaning.on === false` (same for supplies and fixer), and `isPropertyId(p.id)`.
  - `"switches one flow on one property"`: `setFlow(…, "cleaning", true)` leaves the other property's flows unchanged and sets `changedAt`.
  - `"refuses fixer"`: `setFlow(…, "fixer", true)` throws `RegistryError` with reason `fixer-not-yet`.
  - `"refuses a v2 file"`: write `{schemaVersion: 2, tenants: []}`; `list()` throws reason `needs-migration`.
  - `"setTouring refuses an account with properties"`.
  - `"findProperty takes an id or a unique label, in any case"`: `findProperty(t, "12 scratch lane")` resolves; with two properties labeled the same, it returns `undefined`.
- [ ] **Step 2: Run** `npx vitest run test/cleanerHostedRegistry.test.ts`. Expected: FAIL (no exports).
- [ ] **Step 3: Implement** `properties.ts` and the registry changes. Until Task 6 the project won't type-check and hosted tests outside each task's own files may fail; each task runs only the test files it names, and Task 6 restores `tsc`, Task 9 the full suite. Existing v1 → v2 handling in `read()` is replaced by the `needs-migration` refusal (Task 2 migrates v1 too). Fix every compile error that removing `setService`/`setSupplies`/`supplies` causes by leaving a `// Task N` marker only where a later task rewrites that code. `npx tsc` will fail until Task 6; run only this test file here.
- [ ] **Step 4: Run** the test file. Expected: PASS.
- [ ] **Step 5: Commit** `Property model and registry v3 (#161)`.

### Task 2: Migration v2 → v3 at startup

**Files:**
- Create: `src/cleaner-core/hosted/migrate.ts`
- Modify: `src/web/server.ts` (before `new TenantRegistry`, around line 391)
- Test: `test/propertyMigration.test.ts`

**Interfaces:**
- Consumes: `migratedPropertyId`, `propertyFolder` (Task 1)
- Produces:
  - `PROPERTY_FILES: readonly string[]` = `["cleaner-live.json", "cleaner-job", "cleaner-alerts", "photos", "supply.json", "cleaner-approvals.json", "cleaner-draft-approvals.json", "supply-approvals.json", "supply-approvals-front.json"]`
  - `migrateRegistry(dataRoot: string, now: () => Date, rename?: typeof renameSync): { migrated: number }`. It throws `MigrationError(tenantId, file)` when a rename fails for any reason but "already moved". `rename` is injectable so a test can fail one rename.

- [ ] **Step 1: Write failing tests** in `test/propertyMigration.test.ts`. Write v2 `tenants.json` and folders by hand, with 555 numbers only:
  - `"a cleaning tenant becomes one property with cleaning on"`: the property label is the `address` from `cleaner-live.json`, `legacyPaths: true`, and the files are under `properties/prp_<10>/`.
  - `"a cleaning tenant with the add-on gets both flows and keeps both files"` (Review Focus 3).
  - `"a supplies tenant gets supplies on, labeled from supply.json's property name"`.
  - `"an unchosen tenant gets no properties; a touring tenant is untouched"`: the touring tenant's `tour-core/` stays in the account folder, and it keeps `service: "touring"`.
  - `"a v1 file migrates as cleaning"`.
  - `"a failed rename leaves v2 and the next run finishes"`: make the injected `rename` throw on `cleaner-job` once. Expected: `MigrationError`, and `tenants.json` still says `schemaVersion: 2`. Run again with the real rename: v3, and every file is moved exactly once.
  - `"secrets.json and service files stay in the account folder"`.
  - `"a sealed door code still opens after the migration"`: build a v2 tenant through the old desk path (`liveDeskFor(tenantRoot, …)` with `TEST_PIN_KEY`, saving a made-up code). Call `resetLiveDesks()`, migrate, open `liveDeskFor(propertyRoot, …)`, and check the code is still saved (`getState` reports the door code step as done).
- [ ] **Step 2: Run** `npx vitest run test/propertyMigration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `migrateRegistry`. Order: read raw JSON. If `schemaVersion >= 3`, return. For each tenant, rename each `PROPERTY_FILES` entry that exists in the account folder and not yet in the property folder. Build v3 tenants as in §2. Write `tenants.json` once, at the end, with `writeJsonAtomic`.
- [ ] **Step 4: Call it** in `server.ts` before the registry is built, only when `cleanerMultiTenant(installation.env())`. On `MigrationError`, log `Migration stopped at <tenantId>/<file>.` and throw, so the server doesn't start (Review Focus 5). Add the test `"the hosted app won't start on a half-migrated folder"` to `test/propertyMigration.test.ts`: use `hostedApp` from `test/cleanerOauthHarness.ts` with a pre-written v2 folder whose rename is forced to fail through a test hook `setMigrationRename(fn)` exported from `migrate.ts`.
- [ ] **Step 5: Run** the test file. Expected: PASS.
- [ ] **Step 6: Commit** `Migrate tenants into their first property at startup (#161)`.

### Task 3: Property context, env and paths

**Files:**
- Modify: `src/cleaner-core/hosted/router.ts` (`tenantContext` → `propertyContext`, `splitTenantPath`, `handleHostedCleaner`'s `/t/` branch, `drainAllTenants`, `promoteRoutineOwner`)
- Modify: `src/cleaner-core/hosted/tenantEnv.ts`
- Test: `test/cleanerHostedTenantEnv.test.ts`, `test/cleanerHostedRouter.test.ts`

**Interfaces:**
- Consumes: `Property`, `propertyFolder`, `propertyBasePath`, `findProperty` (Task 1)
- Produces:
  - `propertyContext(h: HostedCleaner, tenant: Tenant, property: Property): TenantContext`. `root` is the property folder; `env`, `saveSecrets` and `deleteSecrets` are per account as today.
  - `buildTenantEnv(input & { property?: Property; propertyCount?: number })` sets `PUBLIC_BASE_URL` to the origin + `propertyBasePath`, plus `CLEANER_CORE_PROPERTY_ID`, `CLEANER_CORE_PROPERTY_LABEL` and `CLEANER_CORE_PROPERTY_COUNT`. All three are added to `PER_TENANT_NAMES`.
  - `splitTenantPath(pathname)` returns `{ tenantId: string; propertyId?: string; rest: string }`. `/t/<id>/p/<pid>/rest` sets `propertyId`. `/t/<id>/rest` leaves it unset, meaning the account's `legacyPaths` property.
  - `tenantContext` is deleted. Every caller moves to `propertyContext` or to `tenantFolder` for account files.

- [ ] **Step 1: Write failing tests:**
  - Env: `"a legacy property's links stay under /t/<id>"` and `"a new property's links are under /t/<id>/p/<pid>"`. Also `"the property's id, label and count reach the desk, and the process values for them never do"`.
  - Router: `"a group webhook on /t/<id>/p/<pid>/ reaches that property's desk"` (signed with `MULTI_AUTH`; check the desk folder that got the message). `"an old /t/<id>/ group webhook reaches the migrated property"`. `"a path naming another account's property, or a property whose cleaning is off, answers 404 and sends nothing"`.
  - Drain: `"drainAllTenants delivers each property with cleaning on, and one property's failure doesn't stop the next"`.
- [ ] **Step 2: Run** those two test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The `/t/` branch resolves the property (legacy, or by id). A Cleaner Core path needs `flows.cleaning.on`; a `supplyCalendarCode` path needs `flows.supplies.on`. Otherwise `notFound()`.
  - `promoteRoutineOwner` takes the union of `routineConnectionIds()` over the account's cleaning properties.
- [ ] **Step 4: Run** the two test files. Expected: PASS.
- [ ] **Step 5: Commit** `Each property gets its own folder, env and links (#161)`.

### Task 4: Supply Core per property

**Files:**
- Modify: `src/supply-core/hosted.ts`
- Test: `test/supplyHosted.test.ts`

**Interfaces:**
- Consumes: `propertyContext` (Task 3)
- Produces:
  - `supplyDesk(h, tenant, property): SupplyDesk`. `standalone` is `!property.flows.cleaning.on`. `cleaning` comes from the same property's `LiveDesk` when cleaning is on.
  - `uploadBase` is the origin + `propertyBasePath`.
  - `frontApprovals` uses the property folder.
  - `TURN_ON`, `TURN_OFF` and `CHOOSE` are deleted (`set_flows` replaces them in Task 6). `choose_supplies` in Cleaner Core's setup ask becomes "turn Supply Core on for this property with set_flows". Change the ask text in `liveDesk.ts` where `suppliesAsked` is read.

- [ ] **Step 1: Rewrite** the `turn_on_supplies`/`turn_off_supplies` tests in `test/supplyHosted.test.ts` as desk-level tests:
  - `"a property with cleaning on reads Cleaner Core's property and turnovers"`.
  - `"a property with only supplies on uses its own calendars"`.
  - `"two properties keep separate supply lists"`.

  Leave the hosted tool-surface tests for Task 6.
- [ ] **Step 2: Run** `npx vitest run test/supplyHosted.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5: Commit** `Supply Core runs per property (#161)`.

### Task 5: The front: property argument, tool list, get_state, add_property

**Files:**
- Create: `src/hosted/propertyTools.ts`
- Modify: `src/hosted/frontMcp.ts`, `src/hosted/serviceTools.ts`, `src/hosted/serviceChoice.ts`, `src/mcp/oauth/provider.ts` and `src/mcp/oauth/pages.ts` (drop the service pick from the Allow page; the invite code stays)
- Test: `test/propertyTools.test.ts` (new), `test/sharedServiceRouting.test.ts`, `test/sharedServiceTenants.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3 and 4
- Produces, in `propertyTools.ts`:
  - `resolveProperty(tenant: Tenant, args: unknown): { property: Property; args: Record<string, unknown> } | { refusal: string }`. It strips `property` from `args`. It is optional only when `tenant.properties.length === 1`. It refuses with `nameProperty(list)` when the property is missing or unknown.
  - `withPropertyArg(tool: { inputSchema: Record<string, unknown> }, required: boolean)` adds `property: { type: "string", description: "The property's id from get_state, like prp_…" }` to the input schema.
  - `accountTools(tenant)`: `get_state` and `add_property { label: string }`, in the same listed-tool shape `listedFrontTools` returns.
  - `accountState(h, tenant, caller): Promise<FrontReply>`:
    - no properties: the text "Ask the host for the property's address, then call add_property with it.";
    - one property: that property's Cleaner Core `get_state` reply (or Supply Core's `get_supply_state` when only supplies are on), plus `properties`;
    - more than one: `{ properties: [{ id, label, flows: { cleaning, supplies, fixer }, next }] }`, where `next` is each on-flow's `ask.step`.
  - `addProperty(h, tenant, args)`: refuses an empty label or one over 120 characters. Creates the folder.
- Front behavior:
  - `tools/list` returns `accountTools` + `set_flows` (Task 6) + every Cleaner Core tool when any property has cleaning on (each with `withPropertyArg`) + every Supply Core tool when any property has supplies on and the chat is Grok.
  - A `tools/call` of a property tool:
    1. runs `resolveProperty`;
    2. refuses with `flowOff(...)` when that flow is off;
    3. sends Cleaner Core calls to `handleCleanerMcpHttp`, with a raw body rebuilt from the stripped `args` and `propertyContext`'s root;
    4. sends Supply Core calls to `handleSupplyTool` with `supplyDesk(h, tenant, property)`.
  - The `state === "unset" | "cleaning" | "supplies"` branches are deleted. A touring account (`tenant.service === "touring"`) keeps its current path unchanged.
  - `choose_service`, `switch_service` and `stand_down_service` are no longer listed for property accounts. `serviceChoices` no longer offers touring to new accounts.

- [ ] **Step 1: Write failing tests** in `test/propertyTools.test.ts`, using `multiTenantApp`:
  - `"a new account's get_state asks for the first property"`.
  - `"add_property then get_state lists it with every flow off"`.
  - `"with one property a Cleaner Core call needs no property argument"`: an existing chat's `save_property` works without `property`.
  - `"with two properties a call without property is refused with the list"`: assert the exact `nameProperty` text with both ids and labels.
  - `"a label works in place of the id"` (Review Focus 1).
  - `"a property whose flow is off is refused"`: exact `flowOff("Cleaner Core", "8 Scratch Court")`.
  - `"tools/list carries property on every property tool, and no choose_service"`.
  - `"Supply Core tools are listed for Grok only"`.
  - `"the Allow page asks for the invite code and no service"`.
- [ ] **Step 2: Run** `npx vitest run test/propertyTools.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Update `test/sharedServiceRouting.test.ts` and `test/sharedServiceTenants.test.ts` so cleaning accounts are set up with `addProperty` + `setFlow`, and touring accounts with `setTouring`.
- [ ] **Step 4: Run** the three test files. Expected: PASS.
- [ ] **Step 5: Commit** `Property tools: a property argument on every call, add_property, account get_state (#161)`.

### Task 6: set_flows, stand-down per property, and /admin

**Files:**
- Modify: `src/hosted/service.ts` (replace `switchService` and `standDownService` with `setFlows`), `src/hosted/serviceTools.ts`, `src/cleaner-core/hosted/admin.ts`
- Delete: `test/serviceSwitching.test.ts` (the touring ↔ cleaning switch is gone). Its live-check and force cases move to the new file.
- Test: `test/propertyFlows.test.ts` (new), `test/cleanerHostedAdmin.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4 and 5
- Produces:
  - `setFlows(ctx: { h; tenant; actor: "host" | "admin"; noteToolsChanged(): void }, input: { property: string; cleaning?: boolean; supplies?: boolean; fixer?: boolean; confirmation?: string; force?: boolean }): Promise<FrontReply>`
  - Approval codes come from a persisted `ConfirmationBook` at `join(propertyFolder, "flow-approvals.json")`, 10 minutes. Add that file to `PROPERTY_FILES` (Task 2).
- Behavior (§4):
  - `fixer: true` → `FIXER_NOT_YET`.
  - Turning on → `setFlow`, then `noteToolsChanged()`. Turning on supplies also calls `supplyDesk(...).turnOn()`.
  - Turning cleaning off with `liveWork().live` not empty → the first call returns the preview from `LiveDesk.standDown({})`, and the second call with the code runs `standDown({ confirmation })`, then `setFlow(off)`. With nothing live, one call.
  - Turning supplies off → `clearCarts()` and `turnOff()`, then `setFlow(off)`. No texts.
  - `actor: "admin"` with `force` turns the flow off with no texts and no code.
  - Every change appends `{ at, actor, property, flow, on, forced }` to `service-audit.jsonl`.
  - `/admin` lists each account's properties with their flows and a health line per property. It gets a "Turn off" button per on-flow (force), and "Make touring" for an account with no properties.

- [ ] **Step 1: Write failing tests** in `test/propertyFlows.test.ts`:
  - `"turning cleaning on starts its setup and lists its tools"`.
  - `"turning cleaning off with a confirmed job previews the texts and needs the code"`: the first call returns `confirmation.code` and `texts`; the job is untouched and no SMS goes out.
  - `"a wrong or expired code changes nothing and sends nothing"`.
  - `"the right code stands down, sends exactly the previewed texts, then turns cleaning off"`.
  - `"the setup is kept and picks up when turned back on"`.
  - `"turning supplies off closes open carts and texts nobody"`.
  - `"fixer is refused"`.
  - `"an approval survives a restart"`: `resetLiveDesks()` between the two calls.
  - Admin, in `test/cleanerHostedAdmin.test.ts`: `"admin force-off sends nothing"`, `"admin page lists properties and never shows a phone or door code"`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** `npx tsc --noEmit -p .` must now pass with no `// Task N` markers left.
- [ ] **Step 4: Run** `npx vitest run test/propertyFlows.test.ts test/cleanerHostedAdmin.test.ts test/supplyHosted.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `set_flows replaces the service switch; admin shows properties (#161)`.

### Task 7: LiveDesk additions for a shared line

**Files:**
- Modify: `src/cleaner-core/liveDesk.ts`
- Test: `test/cleanerLineDesk.test.ts` (new, using `test/cleanerDeskHarness.ts`)

**Interfaces:**
- Produces, on `LiveDesk`:
  - `phonesOnProperty(): { host?: string; people: string[] }`: the saved host, and the cleaner, legacy observer and contacts as E.164.
  - `markOptedOut(phone: string): Promise<void>`: records the opt-out exactly as an inbound STOP from that phone does, with no reply text.
  - `noteUnusedHostText(text: string): Promise<void>`: keeps a host message flagged `unused`, which `check_now` returns as "The host texted the line: \"…\". It wasn't used, because this account has several properties. Ask them in chat which property." It also queues a `cleaningUpdateEvent`.
  - `markRoutineConnected(connectionIds: string[]): void`: sets `routineConnected` and merges `routineConnections`, so the routine step counts as done.
  - The host-label prefix: when `Number(env.CLEANER_CORE_PROPERTY_COUNT) >= 2` and `CLEANER_CORE_PROPERTY_LABEL` is set, every one-to-one text to the saved host, and every group text, is sent as `${label}: ${body}`. That covers the sink near `sendLiveGroup`/`sendLiveSms` (around lines 3420–3441), the keyword reply (around line 3037) and the scratch capture. A text to anyone else one-to-one is unchanged.

- [ ] **Step 1: Write failing tests:**
  - `"phonesOnProperty lists the host and the people"`.
  - `"markOptedOut keeps the cleaner from the next offer and START brings them back"`: no SMS goes to the cleaner after `markOptedOut`, and none is sent by the call itself.
  - `"an unused host text shows in check_now and wakes the routine"`.
  - `"markRoutineConnected skips the routine step"`.
  - `"with two properties, texts to the host and group texts start with the label"` and `"…the door code text to the cleaner one-to-one does not"`.
  - `"with one property, texts are unchanged"`.
- [ ] **Step 2: Run** `npx vitest run test/cleanerLineDesk.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it, plus `test/cleanerSafetyGates*.test.ts` (whatever `docs/cleaner-core-safety-gates.md` names). Expected: PASS.
- [ ] **Step 5: Commit** `LiveDesk: phones, silent opt-out, unused host texts, routine sharing, label on host texts (#161)`.

### Task 8: Routing one-to-one texts on the line, and one property per person

**Files:**
- Create: `src/hosted/lineRouter.ts`
- Modify: `src/cleaner-core/hosted/router.ts` (the `CLEANER_TWILIO_PATH` branch), `src/hosted/propertyTools.ts` (the `save_people` check, the opt-out on save, sharing the routine on save), `src/hosted/crossService.ts` (`TenantOptOuts` is reused as the account's line opt-outs)
- Test: `test/lineRouting.test.ts` (new)

**Interfaces:**
- Consumes: `phonesOnProperty`, `markOptedOut`, `noteUnusedHostText`, `markRoutineConnected` (Task 7); `propertyContext` (Task 3); `TenantOptOuts`, `isStopText`, `isStartText` (`crossService.ts`)
- Produces:
  - `routeLineText(tenant: Tenant, from: string, text: string, phones: (p: Property) => { host?: string; people: string[] }): LineRoute`, where `LineRoute = { kind: "property"; property: Property } | { kind: "host-all"; properties: Property[] } | { kind: "host-unused"; property: Property } | { kind: "unknown" }`. It is a pure function and holds the §3 table:
    - one cleaning property → `property` for any sender;
    - several → a person on exactly one property → `property`;
    - the landlord's STOP or START → `host-all` (every property where they're the host);
    - the landlord's other text → `host-unused` (the oldest property where they're the host);
    - anything else → `unknown`.
  - `handleLineText(h, r, tenant, rawBody, signedUrl): Promise<void>`. It checks the signature first, then routes:
    - `property` → `handleCleanerTwilioWebhook` with that property's context;
    - `host-all` → the same call once per property;
    - `host-unused` → `noteUnusedHostText`, plus `LANDLORD_USE_AGENT` through `sendLiveSms` with that property's env, at most once every 12 hours per phone. The time is kept in `tenants/<id>/line-replies.json`;
    - `unknown` → log, and on STOP add the phone to `TenantOptOuts`.

    Twilio always gets an empty TwiML reply.
  - In `propertyTools.ts`, before a `save_people` call is forwarded, every phone in `host`, `cleaner`, `observer` and `contacts[].phone` is normalized with `parsePhone`.
    - Refuse with `phoneTaken(otherLabel)` when a phone is a person on another property.
    - Refuse when the landlord's phone (a host on any property) is given as a person.
    - Refuse when a person's phone is a host elsewhere.
    - After a successful save, call `markOptedOut` for each saved person in `TenantOptOuts`, and `markRoutineConnected` with the account's connected routine ids taken from the other properties. `addProperty` (Task 5) also calls `markRoutineConnected` on the new property's desk with those ids; add that here, with the test `"a new property starts with the account's routine connected"`.

- [ ] **Step 1: Write failing tests** in `test/lineRouting.test.ts`. Use two properties, cleaners `+15555550101` and `+15555550111`, landlord `+15555550100`, unknown `+15555550199`:
  - `routeLineText` table tests, one per row of §3.
  - `"each cleaner's YES, DONE and STOP reach only their own property"`: check each desk's messages and the fake SMS log.
  - `"the landlord's STOP reaches both properties; one confirmation per property, each starting with its label"` (Review Focus 4).
  - `"the landlord's one-to-one departure text releases nothing and gets the one reply, once in 12 hours"`: no `pin` text; a second text within 12 hours gets no reply.
  - `"an unknown sender gets nothing; their STOP holds when the phone is later saved"`.
  - `"saving one property's cleaner on the other is refused"`, including `"(555) 555-0101"` vs `"+15555550101"` (Review Focus 2).
  - `"no text to a cleaner contains the other property's label or address"`: scan every fake SMS body sent to each cleaner.
  - `"a one-property account routes as before"`: the existing `test/sharedServiceConsent.test.ts` passes unchanged except for setup.
- [ ] **Step 2: Run** `npx vitest run test/lineRouting.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run test/lineRouting.test.ts test/sharedServiceConsent.test.ts test/crossService.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `Route texts on the shared line by sender; one property per person (#161)`.

### Task 9: Touring and remaining callers

**Files:**
- Modify: every remaining test in `test/` that calls `setService` or `setSupplies` or uses `choose_service` (listed by `grep -l "setService\|setSupplies\|choose_service\|switch_service\|stand_down_service" test/*.ts`). Touring ones use `setTouring`, cleaning ones `addProperty` + `setFlow`.
- Modify: `src/hosted/crossService.ts`, `src/hosted/hostTexts.ts`, `src/web/server.ts` (the touring hand-over check `current.service !== "touring"` keeps working), and `test/multiTenantHarness.ts` (add `propertyFor(tenantId, label, flows)`, which creates a property and turns the given flows on).

- [ ] **Step 1: Run** `npx vitest run`. Expected: failures only in files that use the removed calls.
- [ ] **Step 2: Fix each.** Change the setup only, never what a test asserts about touring behavior. A test whose subject was the removed switch is deleted, and its replacement is named in the commit message.
- [ ] **Step 3: Run** `npx vitest run`. Expected: all PASS.
- [ ] **Step 4: Commit** `Move touring and shared-service tests to the property model (#161)`.

### Task 10: Two properties end to end, gates, docs

**Files:**
- Test: `test/twoPropertiesEndToEnd.test.ts` (new)
- Modify: `docs/cleaner-core-safety-gates.md` (new row), `docs/hosted-multitenancy.md`, `CLEANER_CORE_BOOTSTRAP.md`, `SUPPLY_CORE_BOOTSTRAP.md`, `cleaner-template/bot-profile.md`, `supply-template/bot-profile.md`, `muse-template/skills/cleaner-core/SKILL.md`, the server instructions in `src/cleaner-core/mcp.ts` and `src/supply-core/hosted.ts`

- [ ] **Step 1: Write the done-when test** `"one account runs Cleaner Core and Supply Core on two properties at once"`. Use the Grok chat, two properties, Cleaner Core on both and Supply Core on the first. Set both up through tool calls with `property`. Run one turnover on each: offer, YES, the host's "guests left" through the agent (the departure tool, with `property`), the door code to that property's cleaner only, and DONE. Then run one supply reorder on the first property. Assert:
  - each cleaner got only their own property's texts;
  - the door code went out once per property, each time to that property's cleaner;
  - the landlord's texts start with labels.
- [ ] **Step 2: Run** it. Expected: PASS (it exercises Tasks 1–9; fix whatever it exposes in the owning file).
- [ ] **Step 3: Add the gate row** to `docs/cleaner-core-safety-gates.md`: "A cleaner gets texts about their own property only | Each property's people are its own; a phone can be a person on only one of the account's properties; one-to-one texts route by sender; texts to the landlord name the property | `test/lineRouting.test.ts`, `test/twoPropertiesEndToEnd.test.ts`".
- [ ] **Step 4: Update the docs and instructions.** Say: call `get_state` first; name the property in every property tool call; use `set_flows` to turn a flow on or off; the host runs everything from the agent. Delete the service-choice and switch wording. In `docs/hosted-multitenancy.md`, replace the "Services" section with accounts and properties per the spec. Update `test/cleanerTemplate.test.ts` and `test/supplyTemplate.test.ts` where they assert the old wording.
- [ ] **Step 5: Verify everything:**
  - `npx tsc --noEmit -p .` → no output;
  - `npx vitest run` → all pass;
  - `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` matches `.cursor/skills/verify-cleanercore/scripts/expected/doctor-on.json`;
  - `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke` matches `scripts/expected/smoke-turnover.json` in that skill.
- [ ] **Step 6: Commit** `Two properties end to end; gates and guides for properties (#161)`.
