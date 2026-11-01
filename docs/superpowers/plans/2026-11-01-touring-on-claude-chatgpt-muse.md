# Touring on Claude, ChatGPT, and Muse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host on Claude, ChatGPT, or Muse sets up and runs Tour Core through the shared service at `/mcp`, the way Grok does today, with optional texts to the host's phone on every platform.

**Architecture:** The shared service (the front) owns everything that differs by platform: how tour updates connect (`save_alert_routine`), texts to the host (`save_host_texts`), and a per-connection "what's new" list for ChatGPT and Muse tasks (`get_updates`). The touring process stays platform-agnostic, except its tour-updates wording, which it picks from the chat name the front already passes in `x-tourcore-client`.

**Tech Stack:** TypeScript (Node 22, ESM), vitest, the existing `multiTenantApp` harness, `child_process.fork` IPC.

**Spec:** `docs/superpowers/specs/2026-11-01-touring-on-claude-chatgpt-muse-design.md`

## Global Constraints

- Tests and Scratch runs use only 555 numbers. Saad's phones and the Twilio number are never test targets (AGENTS.md).
- No live text without `CLEANER_CORE_LIVE_SMS` on and the number on `CLEANER_CORE_SMS_ALLOWLIST`. Host texts go through `sendLiveSms`, which enforces both.
- A host text never carries a visitor's name or number. Exact copy:
  - time request: `Tour Core: a visitor asked for a tour time. Open your chat to answer.`
  - issue (`exception.created`, `access.problem`, `verification.problem`): `Tour Core: something on a tour needs you. Open your chat.`
  - routine: `Tour Core: a tour was booked.` / `started.` / `finished.` / `cancelled.`
- Host's own text to the number gets, once: `This is your Tour Core number. Open your chat to manage tours.`
- Texts question: `Want tour updates texted to your phone too?` with choices **Urgent only**, **Everything**, **No texts**. Suggested **Urgent only** on ChatGPT and Muse, **No texts** on Grok and Claude.
- Platform limit lines: ChatGPT `ChatGPT checks for updates at most once an hour, so a text gets you there sooner.`; Muse `Muse checks for updates as often as you set its task, so a text gets you there sooner.`
- Stopped-task warning, after 2.5 hours with no `get_updates` once published: `Your Tour Core task hasn't checked in since {day} at {time}. Turn it back on in your chat's scheduled tasks.`
- Update list: last 7 days, at most 200 events per tenant. Read markers are per connection.
- Secrets never in chat, logs, or a reply. The Claude page never shows a value back.
- Never change the Grok flow beyond the texts question. Grok's alert link page stays "go back to your chat".
- Don't edit `AGENTS.md` or any `SETUP_PROMPT.md` that already exists.

## Review Focus

- A host phone saved as the tenant's own number would loop texts into touring: `save_host_texts` refuses it. Test in Task 1.
- A ChatGPT task and a Grok chat on one tenant must not share read markers: `get_updates` on one never empties the other's. Test in Task 3.
- `installation.test` must never reach a host's phone or the update list. Test in Tasks 1 and 3.
- The host's STOP must stop host texts even though the host isn't a visitor. Test in Task 2.
- A Claude form post with a non-Claude Fire URL must save nothing and show the form again, not the value. Test in Task 5.

---

### Task 1: Host texts

**Files:**
- Create: `src/hosted/hostTexts.ts`
- Modify: `src/hosted/serviceTools.ts` (new front tool), `src/web/server.ts:404-414` (`onEvent`), `src/hosted/touringScratch.ts` (`readScratchOutbox` merges host texts)
- Test: `test/hostTexts.test.ts`

**Interfaces:**
- Produces:
  - `type HostTextChoice = "urgent" | "all" | "off"`
  - `interface HostTexts { phone?: string; which: HostTextChoice; texted: string[]; repliedAt?: string }`
  - `readHostTexts(h: HostedCleaner, tenantId: string): HostTexts` (default `{ which: "off", texted: [] }`), stored in `<tenant folder>/host-texts.json`
  - `saveHostTexts(h, tenant: Tenant, input: { which: HostTextChoice; phone?: string }): { ok: true; text: string } | { ok: false; text: string }`
  - `hostTextBody(eventType: OperatorEventType, which: HostTextChoice): string | undefined`
  - `sendHostText(h, tenant: Tenant, event: OperatorEvent, options?: { scratch?: boolean }): Promise<void>` (never throws)
  - `HOST_TEXTS_QUESTION`, `HOST_TEXT_CHOICES` (labels **Urgent only** → `urgent`, **Everything** → `all`, **No texts** → `off`), and `hostTextsAsk(assistant: CleanerAssistant): { say: string; choices; suggested: HostTextChoice }`
  - Front tool `save_host_texts`, input `{ which: z.enum(["urgent","all","off"]), phone: z.string().max(40).optional() }`, listed in the touring state only.

- [ ] **Step 1: Write the failing tests** in `test/hostTexts.test.ts`:
  - `hostTextBody`: `tour.time_requested` + `urgent` gives the time-request line; `tour.booked` + `urgent` is `undefined`; `tour.booked` + `all` is `Tour Core: a tour was booked.`; `installation.test` and `cleaning.update` are `undefined` for every choice; any event + `off` is `undefined`.
  - `save_host_texts` through `/mcp` on a touring tenant (`+15555550150`, Scratch): `{ which: "urgent", phone: "+15555550151" }` is ok; the tenant's own number is refused; a non-phone is refused; `which: "urgent"` with no phone is refused; `which: "off"` with no phone is ok.
  - On a Scratch tenant, a 555 host phone is accepted and a `+12025550123` phone is refused. The live-tenant 555 refusal is unit-tested by calling `saveHostTexts` with a tenant object whose number isn't Scratch and a 555 phone.
  - `sendHostText` with `scratch: false`, env `CLEANER_CORE_LIVE_SMS=1` and `CLEANER_CORE_SMS_ALLOWLIST=+15555550151`, choice `urgent`: a time request sends one text through `m.sms` with the exact copy. A booking sends none. The same `eventId` twice sends once. The body never contains `+1555`.
  - On a Scratch tenant, a time request lands in `read_outbox` as `{ to: "+15555550151", text: <time-request line> }`, and `m.sms.sent` stays empty.

- [ ] **Step 2: Run, expect FAIL**

  Run: `npx vitest run test/hostTexts.test.ts`. Expected: FAIL, since `src/hosted/hostTexts.ts` doesn't exist yet.

- [ ] **Step 3: Implement `src/hosted/hostTexts.ts`.**
  - Validation: use `parsePhone`. On a Scratch tenant (`touringScratch(tenant)`), take only `isScratchTestNumber`. On a live tenant, refuse `isScratchTestNumber`. Always refuse the tenant's own number.
  - Sending: `sendLiveSms(tenantContext(h, tenant).env(), { to, body })`, inside try/catch. On failure, log `"${tenant.id}: a host text didn't go out."` and retry once.
  - Scratch: append `{ to, text }` to `<tenant folder>/scratch-host-texts.json`. `readScratchOutbox` returns the touring bubbles followed by these.
  - Record the `eventId` in `texted` before sending. Keep the last 500.
  - Skip if `TenantOptOuts(h.dataRoot).stopped(tenant.id, phone)`.

- [ ] **Step 4: Wire it in.**
  - In `server.ts` `onEvent`, call `void sendHostText(hostedCleanerService, tenant, event)` before the sink delivery, so it never affects the ack.
  - In `serviceTools.ts`, add `SAVE_HOST_TEXTS` to `BY_STATE.touring` and `FRONT_TOOL_NAMES`. Its handler calls `saveHostTexts` and returns `{ text, isError: !ok }`.

- [ ] **Step 5: Run, expect PASS**

  Run: `npx vitest run test/hostTexts.test.ts test/sharedServiceRouting.test.ts`. Expected: PASS. If the front tool lists are pinned elsewhere, update those expectations.

- [ ] **Step 6: Commit**

  ```bash
  git add src/hosted/hostTexts.ts src/hosted/serviceTools.ts src/web/server.ts src/hosted/touringScratch.ts test/hostTexts.test.ts
  git commit -m "Touring: texts to the host's phone, urgent only or everything"
  ```

### Task 2: The host's own texts to the number

**Files:**
- Modify: `src/hosted/crossService.ts` (`screenText`)
- Test: `test/hostTexts.test.ts` (new `describe`)

**Interfaces:**
- Consumes: `readHostTexts`, `HostTexts.repliedAt` (Task 1).
- Produces: `screenText` returns `"drop"` for the saved host phone on a touring tenant. HELP and injury still return `"route"`.

- [ ] **Step 1: Write the failing tests** (touring Scratch tenant, host phone `+15555550151` saved with `urgent`):
  - `m.text(LANE, "+15555550151", "Hi", "SMh1")`: the touring process never logs `SMh1`. The host gets one reply in `read_outbox` with the exact copy. A second text gets no second reply.
  - `STOP` from the host phone, then a time-request event through `sendHostText`: no host text.
  - `START`, then another event: a host text goes out again.
  - `HELP` from the host phone still reaches touring.

- [ ] **Step 2: Run, expect FAIL**

  Run: `npx vitest run test/hostTexts.test.ts -t "own number"`. Expected: FAIL.

- [ ] **Step 3: Implement it in `screenText`.**
  - Keep the current order. After STOP and START are recorded, if `tenant.service === "touring"` and `from` matches the saved host phone, return `"drop"`.
  - Before dropping, if `repliedAt` is unset, send the reply (through `sendLiveSms`, or the Scratch host-text file on a Scratch tenant) and set `repliedAt`.
  - `saveHostTexts` clears `repliedAt` when the phone changes.

- [ ] **Step 4: Run, expect PASS**

  Run: `npx vitest run test/hostTexts.test.ts test/crossService.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git commit -am "Touring: the host's own texts to the number never reach touring"
  ```

### Task 3: ChatGPT and Muse connections, and `get_updates`

**Files:**
- Create: `src/hosted/touringUpdates.ts`
- Modify:
  - `src/hosted/touringAlerts.ts` (`routineConnection`, `touringSinkFor`)
  - `src/hosted/serviceTools.ts` (`save_alert_routine` by platform; new `get_updates`)
  - `src/hosted/ipc.ts` (`alerts` message gains `polled: boolean`)
  - `src/hosted/touringSupervisor.ts` (`setAlerts(tenantId, connected, polled)`)
  - `src/hosted/touringWorker.ts` (no test event when polled)
  - `src/alerts/operatorEvents.ts` (`RelaySink.polled()`)
  - `src/install/status.ts` (worker branch: polled counts as tested)
  - `src/web/server.ts` (`setAlerts` call sites)
  - `src/cleaner-core/hosted/admin.ts` (`refreshTouringAlerts` call sites)
- Test: `test/touringUpdates.test.ts`

**Interfaces:**
- Produces:
  - `TOURING_TASK_NAME = "TOURING_ROUTINE_TASK"`. A connection's secret `"1"` means its recurring task is connected.
  - `touringAlertsPolled(h, tenant): boolean`: true when the chosen connection is ChatGPT or Muse.
  - `class UpdateFeedSink implements OperatorNotificationSink` (in `touringUpdates.ts`, `kind = "GROK_ROUTINE"`). `deliver(event)` appends to the feed. `installation.test` is skipped.
  - `appendUpdate(h, tenantId, event)`
  - `takeUpdates(h, tenantId, grantId): { eventType: OperatorEventType; occurredAt: string; line: string }[]`. It records `lastCheckAt` per grant. The feed lives at `<tenant folder>/touring-updates.json`, keeps 7 days and 200 events, and stores read markers per grant.
  - `updateLine(eventType)`: `A visitor asked for a tour time.` / `Something on a tour needs you.` / `A tour was booked.` and so on.
  - `ToWorker` alerts becomes `{ type: "alerts"; connected: boolean; polled: boolean }`.
  - Front tool `get_updates`, input `{}`, listed in the touring state.

- [ ] **Step 1: Write the failing tests** (`joinAt(tenant.id, "chatgpt", "/mcp")`, choose touring):
  - `save_alert_routine` with no arguments returns `structured.connected === true` and no `uploadUrl`. Its `next` contains the ChatGPT limit line and `Want tour updates texted to your phone too?`.
  - `publish` then no longer returns `Connect the touring alert routine first.`
  - `m.wakes` stays empty: no test event.
  - A `tour.time_requested` event delivered through `touringSinkFor(...).deliver` appears once in `get_updates`, with line `A visitor asked for a tour time.`. A second `get_updates` returns `[]`.
  - Two connections on one tenant (ChatGPT primary, plus Grok): ChatGPT's `get_updates` doesn't empty Grok's.
  - `installation.test` never appears in `get_updates`.
  - The same assertions with `"muse"`, using the Muse limit line.
  - A Grok connection's `save_alert_routine` still returns `uploadUrl` (unchanged).

- [ ] **Step 2: Run, expect FAIL**

  Run: `npx vitest run test/touringUpdates.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement it.**
  - `routineConnection` also accepts a connection with `TOURING_ROUTINE_TASK === "1"` whose assistant has `ASSISTANT_PROFILES[a].polledTask`. `touringSinkFor` returns an `UpdateFeedSink` for it.
  - The front's `save_alert_routine` for a polled assistant sets the secret, calls `supervisor.setAlerts(id, true, true)`, and returns `done({ connected: true, next })`. `next` is the limit line plus the texts question from `hostTextsAsk`.
  - For Grok and Claude, add the same texts question to the `next` text after the post or form step.
  - The worker stores `polled` and skips the test event when it's set. `RelaySink.polled()` returns it.
  - In `status.ts`'s worker branch, `polled` counts as tested, so the outbox check is skipped.

- [ ] **Step 4: Run, expect PASS**

  Run: `npx vitest run test/touringUpdates.test.ts test/touringAlerts.test.ts test/touringWorkerMode.test.ts test/touringSupervisor.test.ts test/cleanerHostedAdmin.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add -A src test/touringUpdates.test.ts
  git commit -m "Touring: ChatGPT and Muse tasks connect without a link and read get_updates"
  ```

### Task 4: Stopped-task warning

**Files:**
- Modify: `src/hosted/frontMcp.ts` (touring `get_state` path, next to `withNotices`), `src/hosted/touringUpdates.ts` (`lastCheckAt` lookup)
- Test: `test/touringUpdates.test.ts`

**Interfaces:**
- Consumes: `takeUpdates` records `lastCheckAt` (Task 3).
- Produces: `taskWarning(h, tenant, timeZone: string): string | undefined`. The warning goes into touring `get_state`'s structured content as `warning`.

- [ ] **Step 1: Write the failing test.** On a ChatGPT touring tenant with a published property (seed it as in `test/touringScratch.test.ts`), call `get_updates`, then advance the harness clock 2 hours: `get_state` has no `warning`. Advance to 3 hours: `warning` matches `^Your Tour Core task hasn't checked in since .+ at .+\. Turn it back on in your chat's scheduled tasks\.$`. A Grok tenant never gets `warning`.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement it.**
  - Add the warning only when the primary connection is polled, `lastCheckAt` is set, and the gap is over `2.5 * 3_600_000` ms.
  - "Published" means the reply's `milestones` has `id: "publish"` with `status: "done"`.
  - Format the day and time with `formatWhen` from Cleaner Core, in the reply's `setup.timezone`, falling back to UTC.

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

  ```bash
  git commit -am "Touring: warn when a ChatGPT or Muse task stops checking in"
  ```

### Task 5: Claude's private page

**Files:**
- Modify: `src/hosted/touringAlerts.ts` (form page, Claude validation), `src/cleaner-core/hosted/router.ts` (touring upload route: GET by platform, form POST)
- Test: `test/touringAlerts.test.ts`

**Interfaces:**
- Produces:
  - `touringAlertPage(h, tenant, code): { status: number; html: string }`. A Claude upload shows a form with `Fire URL` and `Token` fields, posting to the same path. Any other platform gets the existing go-back page.
  - `handleTouringAlertUpload` refuses a Claude connection's URL that fails `CLAUDE_FIRE_URL`, or a token under 8 characters.

- [ ] **Step 1: Write the failing tests** (`joinAt(..., "claude", "/mcp")`, touring):
  - A GET on the link shows `name="url"` and `name="token"`, and the HTML has no stored value.
  - A form POST (`application/x-www-form-urlencoded`) with `https://api.anthropic.com/v1/claude_code/routines/r1/fire` and a 16-character token returns 200 HTML containing `Saved`, and `m.wakes` gets one wake to that URL.
  - A form POST with `https://evil.example/fire` returns 400 with the form again, the response doesn't contain `evil.example`, and nothing is saved.
  - A Grok link's GET is unchanged (`Go back to your chat`).

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement it.**
  - Reuse `isFormPost` from `src/cleaner-core/uploadPage.ts`. The page carries the same security headers as `TOURING_ALERT_LINK_HEADERS`, plus `form-action 'self'`.
  - The platform comes from the upload's `grantId` → `tenant.connections[].assistant`.

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

  ```bash
  git commit -am "Touring: Claude saves its Fire URL and token on a private page"
  ```

### Task 6: Tour-updates wording by platform

**Files:**
- Create: `src/playbooks/sharedAlerts.ts`
- Modify: `src/playbooks/compose.ts` (`PlaybookPlace` gains `platform`), `src/playbooks/grok.ts` (move `GROK_ALERTS_SHARED` into `sharedAlerts.ts`), `src/install/stateView.ts` (pass `platform` from `input.client`), `src/install/status.ts` (`TOURING_ROUTINE_SETUP` by platform)
- Test: `test/touringAlerts.test.ts` (rework the existing `renderPlaybook` test), `test/touringWorkerMode.test.ts`

**Interfaces:**
- Produces:
  - `type SharedPlatform = "grok" | "claude" | "chatgpt" | "muse"`
  - `sharedPlatformOf(client?: ReportedClient): SharedPlatform` maps names containing `grok` or `cursor` to `grok`, `claude`, `chatgpt`, and `muse`, defaulting to `grok`.
  - `sharedAlertsStep(platform: SharedPlatform): string`
  - `PlaybookPlace { sharedService?: boolean; platform?: SharedPlatform }`

- [ ] **Step 1: Write the failing tests.**
  - `renderPlaybook({ name: "Claude" }, "alerts", undefined, { sharedService: true, platform: "claude" }).text` contains `API trigger` and `private page`, and not `cloud computer`.
  - `"chatgpt"` contains `save_alert_routine with no arguments` and `once an hour`.
  - `"muse"` contains `save_alert_routine with no arguments`.
  - `"grok"` still contains `Never send that link to the landlord`.
  - A worker tenant joined as `chatgpt` gets `get_state` whose `playbook.text` mentions no `cloud computer`.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement it.** Each text ends with the texts question from Global Constraints. `status.ts` picks its tour-updates instructions by `sharedPlatformOf(options.client)`. `readState` passes `{ readOnly: true, client: input.client }`.

- [ ] **Step 4: Run, expect PASS.**

  Run: `npx vitest run test/touringAlerts.test.ts test/touringWorkerMode.test.ts test/playbooksAndSetupHelp.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git commit -am "Touring: tour-updates setup worded for each platform"
  ```

### Task 7: Templates for Claude, ChatGPT, and Muse

**Files:**
- Create:
  - `property-core-template/claude/{template.json,SETUP_GUIDE.md,routines/tour-core-task.md,plugin/.claude-plugin/plugin.json,plugin/skills/property-core/SKILL.md}`
  - `property-core-template/chatgpt/{template.json,SETUP_GUIDE.md,routines/tour-core-task.md}`
  - `property-core-template/muse/{template.json,SETUP_PROMPT.md,skills/property-core/SKILL.md,skills/property-core/references/tour-core-task.md}`
- Modify: `property-core-template/README.md` and `template.json` (add `"templateLink": "https://x.ai/bot/rfmREJxrfqNuTiOs2VqYQ"`), `docs/hosted-multitenancy.md` (open tasks), `README.md` (folder list)
- Test: `test/propertyCoreTemplate.test.ts` (extend over the three platforms)

**Interfaces:**
- Consumes: `SERVICE_QUESTION`, `SERVICE_CHOICES` (from `serviceTools.ts`).
- Produces: each platform's `template.json` with `hostedPropertyCoreUrl`, a single `custom-mcp-server` integration `hostedPropertyCoreUrl/mcp`, `services[]`, and a touring `routines[]` entry whose `doc` is its task doc. The cleaning entries point at the existing `claude-template/`, `chatgpt-template/`, and `muse-template/` task docs.

- [ ] **Step 1: Extend the test** to loop over `["claude", "chatgpt", "muse"]`:
  - every path exists;
  - the MCP integration is exactly `hostedPropertyCoreUrl/mcp`;
  - the skill or guide contains `ask the host exactly "${SERVICE_QUESTION}"` and both choice labels, and says not to connect `/mcp/cleaner-core`;
  - the ChatGPT and Muse task docs' prompts contain `get_updates` and `get_inbox`;
  - the Claude task doc contains `API trigger` and `Fire URL`;
  - each touring task doc says how to answer the texts question;
  - the no-secrets scan from the Grok test applies to every file;
  - the Grok `template.json` has `templateLink`.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Write the files.**
  - Model each on its Cleaner Core counterpart.
  - The task prompts follow the spec, section 3: call `get_updates`; for urgent ones call `get_inbox` and post details in your own short words; post a one-line summary of routine updates; say nothing if there's nothing new.
  - The plugin manifest copies `claude-template/plugin/.claude-plugin/plugin.json` with name `property-core`.
  - In `docs/hosted-multitenancy.md`, mark Claude, ChatGPT, and Muse touring as done.

- [ ] **Step 4: Run, expect PASS.**

  Run: `npx vitest run test/propertyCoreTemplate.test.ts test/landlordFacingTools.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add property-core-template docs/hosted-multitenancy.md README.md test/propertyCoreTemplate.test.ts
  git commit -m "Property Core templates for Claude, ChatGPT, and Muse"
  ```

### Task 8: End to end per platform, then CI

**Files:**
- Create: `test/touringPlatforms.test.ts`

- [ ] **Step 1: Write one test per platform** (Scratch tenant `+15555550150`, `CLEANER_CORE_SCRATCH_TOOLS=1`, a seeded published property as in `test/touringScratch.test.ts`), each joined at `/mcp`:
  - Choose touring.
  - Connect tour updates: Claude by the form post from Task 5; ChatGPT and Muse by `save_alert_routine` with no arguments.
  - `save_host_texts` with `urgent` and host phone `+15555550151`.
  - `send_test_text` from `+15555550177` with `TOUR`.
  - Then:
    - `read_outbox` has a reply to the visitor.
    - Claude: the test update reached `m.wakes` at the Fire URL.
    - ChatGPT and Muse: `publish` isn't refused for tour updates, and `get_updates` answers (an empty list is fine; Task 3 pins event delivery).
    - On every platform, the host texts question appeared in `save_alert_routine`'s reply, and nothing reached `m.sms.sent`.

- [ ] **Step 2: Run, expect PASS.**

  Run: `npx vitest run test/touringPlatforms.test.ts`. Any failure here is a gap in Tasks 1-6: fix it in the owning file, not in the test.

- [ ] **Step 3: Run the full check.**

  Run: `bash scripts/ci-check.sh`. Expected: typecheck, build, test-default, secret-scan, tracked-scan, test-eval, and SETUP_PROMPT all `ok`.

- [ ] **Step 4: Commit and push**

  ```bash
  git add test/touringPlatforms.test.ts
  git commit -m "Touring end to end on Claude, ChatGPT, and Muse"
  git push -u origin claude/tender-bardeen-oid5hr
  ```
