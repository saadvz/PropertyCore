# Touring and Cleaning on One Shared Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The multi-tenant Cleaner Core service also hosts Tour Core: each tenant has one number and one active service (touring or cleaning), chosen and switched through one MCP address.

**Architecture:**
- The front of the service is today's multi-tenant Cleaner Core (registry, invite codes, `/admin`, `/t/<id>/` links), plus a `service` field per tenant.
- A touring tenant runs today's Tour Core server as a child process (`child_process.fork`) in a new `TENANT_WORKER` deployment mode, listening on `127.0.0.1` and gated by a per-process key. Its settings come from the parent's environment, built per tenant.
- The front forwards that tenant's MCP calls, `/t/<id>/` links, and texts (re-signed with the shared Twilio token) to it. Landlord alerts cross the IPC channel and go out through the tenant's routine with the existing sinks in `src/alerts/operatorEvents.ts`.

**Tech Stack:** TypeScript (Node ≥ 22.13), `node:http`, `node:child_process` (`fork`, IPC), `@modelcontextprotocol/sdk` OAuth, vitest, esbuild.

**Spec:** `docs/superpowers/specs/2026-10-30-shared-service-touring-design.md`

## Global Constraints

- Everything new runs only when `CLEANER_CORE_MULTI_TENANT=1` on `TOURCORE_DEPLOYMENT_MODE=HOSTED_RAILWAY_P0`. Without it, every route keeps today's code path, and every existing test stays green unchanged.
- `choose_service` offers `touring`, and touring processes start, only when `TOUR_CORE_TENANTS` is `1` or `true`.
- Existing tenants become `cleaning` on first read. New tenants start with no service.
- Tests use only 555 numbers and made-up door codes (`DOOR_CODE` in `test/wiringProof.ts`). Never spell a code out in docs: `scripts/scan-cleaner-secrets.mjs` fails CI on one. Never Saad's phones or the real Twilio number.
- No live text to a real person. Twilio REST and routine wakes are faked in every test (`fakeSms()`, `setCleanerAlertFetch`, an injected `fetch`).
- Secrets never appear in logs, tool replies, IPC messages to the front's log, the registry, or `/admin`: routine URLs and keys, worker keys, Twilio credentials, door codes, invite codes after first shown.
- Logs carry `tnt_…` and never a full phone number.
- A touring process never sees another tenant's value or any `CLEANER_CORE_*` per-tenant name (`PER_TENANT_NAMES` in `src/cleaner-core/hosted/tenantEnv.ts`).
- Door access stays `DURIN_DEMO`.
- `AGENTS.md` and `docs/cleaner-core-safety-gates.md` are not edited.
- Before every commit: `npm run typecheck` and the task's tests. Before the final push: `npm test` and `bash scripts/ci-check.sh`.

## Review Focus

1. **The touring process is down when the host asks to switch or stand down.** The blockers can't be read, so the switch is refused ("Touring isn't answering right now. Try again in a minute."), never allowed by default. Saad's force on `/admin` still works. Test: Task 8.
2. **Twilio retries nothing, and the worker crashes between receiving a text and answering.** The text was queued before forwarding and is removed only after the worker answered 2xx, so a crash replays it once. The worker's inbound ledger drops the duplicate by `MessageSid`. Test: Task 5.
3. **A host connected before the switch keeps an old tool list** (the chat ignores `tools/list_changed`). A call to a tool of the inactive service is refused with "This number is set up for {service} now. Start a new chat to see its tools.", never forwarded. Test: Task 6.
4. **A switch lands while a text for the old service is mid-flight.** Routing reads `service` per text, after the queue write. A text that arrives after the switch goes to the new service's cross-service rule (Task 9), not to the old desk. Test: Task 9.
5. **Saad deletes a touring tenant while its process is running.** The process is stopped before the folder is removed. No restart is scheduled for a deleted tenant, and a late IPC event from it is dropped. Test: Task 4.

---

### Task 1: The `service` field, migration, and flag

**Files:**
- Modify: `src/cleaner-core/hosted/registry.ts`
- Modify: `src/cleaner-core/flag.ts`
- Test: `test/cleanerHostedRegistry.test.ts`

**Interfaces:**
- Produces:
  - `type TenantService = "cleaning" | "touring"`
  - `Tenant.service?: TenantService` and `Tenant.serviceChangedAt?: string`
  - `TenantRegistry.setService(id: string, service: TenantService): void`: sets both fields. Throws `RegistryError("unknown-tenant")`.
  - `Doc.schemaVersion: 2`. Reading a version-1 file sets `service: "cleaning"` on every tenant and writes version 2 once.
  - `tourCoreTenants(env?: NodeJS.ProcessEnv): boolean`: true only for `"1"` or `"true"`.

- [ ] **Step 1: Write the failing tests**

```ts
it("turns every tenant in a version-1 file into a cleaning tenant, once", () => {
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ schemaVersion: 1, tenants: [laneTenant()] }));
  const registry = new TenantRegistry(root, clock);
  expect(registry.get(laneTenant().id)?.service).toBe("cleaning");
  expect(JSON.parse(readFileSync(join(root, "tenants.json"), "utf8")).schemaVersion).toBe(2);
});
it("creates a new tenant with no service", () => {
  const { tenant } = registry.create({ label: "Lane", twilioNumber: "+15555550150" });
  expect(tenant.service).toBeUndefined();
});
it("records a service change and when it happened", () => {
  registry.setService(id, "touring");
  expect(registry.get(id)).toMatchObject({ service: "touring", serviceChangedAt: clock().toISOString() });
});
it("reads TOUR_CORE_TENANTS as on only for 1 or true", () => {
  expect(tourCoreTenants({ TOUR_CORE_TENANTS: "1" })).toBe(true);
  expect(tourCoreTenants({ TOUR_CORE_TENANTS: "yes" })).toBe(false);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/cleanerHostedRegistry.test.ts`
Expected: FAIL (`setService` and `tourCoreTenants` are not defined).

- [ ] **Step 3: Implement** the field, the migration inside `read()` (write back only when the version was 1), `setService`, and `tourCoreTenants` beside `cleanerMultiTenant`.

- [ ] **Step 4: Run the registry and hosted tests**

Run: `npx vitest run test/cleanerHostedRegistry.test.ts test/cleanerHosted*.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cleaner-core/hosted/registry.ts src/cleaner-core/flag.ts test/cleanerHostedRegistry.test.ts
git commit -m "Hosted: a service per tenant, existing tenants become cleaning"
```

---

### Task 2: `TENANT_WORKER` mode in Tour Core's server

**Files:**
- Modify: `src/install/deployment.ts`
- Modify: `src/web/server.ts`
- Modify: `src/install/status.ts` (installation steps the worker skips)
- Test: `test/touringWorkerMode.test.ts`

**Interfaces:**
- Produces:
  - `"TENANT_WORKER"` in `DEPLOYMENT_MODES`, alias `tenant_worker`, label "Touring for one host on the shared service".
  - `WORKER_KEY_HEADER = "x-tourcore-worker-key"`, exported from `src/web/server.ts`.
  - In this mode `createSetupServer` reads `TOURCORE_WORKER_KEY`. Every request without that header value (compared with `timingSafeEqual`) gets 404 "Not found". `/mcp` runs as static auth, with the same key as its bearer.
  - Answered 404 in this mode even with the key: `/`, `/grok`, `/install`, `/api/install/*`, `/connect`, `/api/connect*`, OAuth paths, `/mcp/ops`, `/mcp/qa`.
  - Gone in this mode: the tool `reset_hosted_demo`, the hosted owner binding, and `TOURCORE_HOSTED_TENANT_RESET` / `TOURCORE_HOSTED_OWNER_RESET`.
  - `get_state` (and the QA status tool) report the public address, messaging, and storage as provided by the host. They never ask for a messaging provider, Sendblue, or the Grok Routine.

- [ ] **Step 1: Write the failing tests.** Start `createSetupServer` with `TOURCORE_DEPLOYMENT_MODE=TENANT_WORKER`, `TOURCORE_WORKER_KEY=k-test-worker-key`, a temp `TOURCORE_HOME`, and `PUBLIC_BASE_URL=https://shared.up.railway.app/t/tnt_aaaaaaaaaa`.

```ts
it("answers nothing without the worker key", async () => {
  expect((await w.http("/healthz")).status).toBe(404);
  expect((await w.mcp("tools/list", {}, { key: undefined })).status).toBe(404);
});
it("serves the landlord tools to the key, without the hosted-demo tools", async () => {
  const names = (await w.mcpJson("tools/list")).result.tools.map((t: { name: string }) => t.name);
  expect(names).toContain("get_state");
  expect(names).not.toContain("reset_hosted_demo");
});
it.each(["/", "/grok", "/install", "/connect", "/mcp/ops", "/mcp/qa", "/authorize"])("hides %s even with the key", async (path) => {
  expect((await w.http(path)).status).toBe(404);
});
it("never asks for a texting provider or the Grok Routine", async () => {
  const state = await w.tool("get_state");
  expect(JSON.stringify(state)).not.toMatch(/Sendblue|Photon|Grok Routine|choose.*provider/i);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/touringWorkerMode.test.ts`
Expected: FAIL (the mode is unknown and the routes answer).

- [ ] **Step 3: Implement.** Gate at the top of the request handler. Pick `mcpAuth: "static"` with `operatorToken: () => env.TOURCORE_WORKER_KEY`. Filter the two tools out of the landlord list. Mark the provider, Sendblue, and routine steps as host-provided in `status.ts` when the mode is `TENANT_WORKER`.

- [ ] **Step 4: Run the new test and the existing modes' tests**

Run: `npx vitest run test/touringWorkerMode.test.ts test/hostedRailway.test.ts test/installation.test.ts test/oauth.test.ts test/hostedOauth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/install/deployment.ts src/web/server.ts src/install/status.ts test/touringWorkerMode.test.ts
git commit -m "Tour Core: a TENANT_WORKER mode behind a per-process key"
```

---

### Task 3: The worker's texting, alerts relay, and entry point

**Files:**
- Create: `src/hosted/touringWorker.ts` (entry)
- Create: `src/hosted/ipc.ts` (message types)
- Modify: `src/alerts/operatorEvents.ts` (`RelaySink`)
- Modify: `src/install/installation.ts` (`sink()` in worker mode)
- Modify: `src/messaging/twilio/provider.ts` (live-text gate in worker mode)
- Modify: `src/operator/milestones.ts` (`publish` waits on alerts in worker mode)
- Modify: `scripts/build.mjs` (second entry, `dist/touringWorker.js`)
- Test: `test/touringWorkerEntry.test.ts`

**Interfaces:**
- Produces, in `src/hosted/ipc.ts`:
  - `type ToParent = { type: "ready"; port: number } | { type: "event"; id: string; event: OperatorEvent } | { type: "log"; line: string }`
  - `type ToWorker = { type: "event-ack"; id: string; ok: true } | { type: "event-ack"; id: string; ok: false; retryable: boolean; message: string } | { type: "alerts"; connected: boolean }`
- Produces `class RelaySink implements OperatorNotificationSink` (`kind: "GROK_ROUTINE"`):
  - `constructor(send: (m: ToParent) => void, connected: () => boolean)`.
  - `deliver(event)` sends `{type:"event", id, event}` and resolves on `ok: true`. On `ok: false` it throws `DeliveryError(message, retryable)`. With no ack in 30 s it throws a retryable error. The worker's own outbox keeps the event until a delivery resolves.
- Produces `startTouringWorker(): Promise<void>` in `src/hosted/touringWorker.ts`, run when the file is the entry:
  - Builds the workspace and `Installation` on `TOURCORE_HOME`, and sets the manifest's messaging provider to `TWILIO`, or to `LOCAL` when `TOURCORE_TOURING_SCRATCH=1`.
  - Listens on `127.0.0.1` port 0 and sends `{type:"ready", port}`. Applies `{type:"alerts"}` to the sink's `connected` flag, and enqueues one `testEvent(now)` (`src/alerts/operatorEvents.ts`) on its outbox each time that flag goes from false to true. Exits when the IPC channel closes.
- In worker mode the Twilio provider's `send` returns an unsent receipt, without calling Twilio, unless `liveSmsOn(env) && isAllowlisted(env, to)` (from `src/cleaner-core/liveSms.ts`).
- In worker mode `publish` is refused with `ALERTS_NEEDED: "Connect the touring alert routine first. Call save_alert_routine."` while the sink isn't connected.

- [ ] **Step 1: Write the failing tests.** Fork the entry with `execArgv: ["--import", "tsx"]`, a temp home, a key, and a 555 number in the env.

```ts
it("starts on loopback and reports its port", async () => {
  const w = await forkWorker();
  expect(w.ready.port).toBeGreaterThan(0);
  expect((await fetch(`http://127.0.0.1:${w.ready.port}/healthz`, { headers: { [WORKER_KEY_HEADER]: KEY } })).status).toBe(200);
});
it("relays a landlord alert to the parent and keeps it until acked", async () => {
  const w = await forkWorker();
  w.child.send({ type: "alerts", connected: true });
  const first = await w.nextMessage("event");
  expect(first.event.eventType).toBe("installation.test");
  w.child.send({ type: "event-ack", id: first.id, ok: false, retryable: true, message: "busy" });
  const retry = await w.nextMessage("event");
  expect(retry.event.eventId).toBe(first.event.eventId);
});
it("refuses publish until alerts are connected", async () => {
  const w = await forkWorker();
  await w.setUpPropertyThroughPractice();
  expect((await w.tool("publish", { property: "Hillside" })).text).toContain("Connect the touring alert routine first");
});
it("sends no text when live texts are off", async () => {
  const w = await forkWorker({ CLEANER_CORE_LIVE_SMS: "0" });
  expect(await w.twilioCallsAfterVisitorText("+15555550177", "Tour")).toBe(0);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/touringWorkerEntry.test.ts`
Expected: FAIL (no entry file).

- [ ] **Step 3: Implement** the files above. Add the second entry point in `build.mjs`, using the same options as `dist/server.js`.

- [ ] **Step 4: Run the test and the build**

Run: `npx vitest run test/touringWorkerEntry.test.ts && npm run build && ls dist/touringWorker.js`
Expected: PASS, and the file exists.

- [ ] **Step 5: Commit**

```bash
git add src/hosted src/alerts/operatorEvents.ts src/install/installation.ts src/messaging/twilio/provider.ts src/operator/milestones.ts scripts/build.mjs test/touringWorkerEntry.test.ts
git commit -m "Tour Core worker: Twilio behind the live-text gate, alerts over IPC, its own entry"
```

---

### Task 4: The touring supervisor

**Files:**
- Create: `src/hosted/touringEnv.ts`
- Create: `src/hosted/touringSupervisor.ts`
- Test: `test/touringSupervisor.test.ts`

**Interfaces:**
- Consumes: `Tenant`, `tenantFolder` (Task 1), `ToParent` / `ToWorker` (Task 3), `PER_TENANT_NAMES`.
- Produces `buildTouringEnv(input: { base: NodeJS.ProcessEnv; tenant: Tenant; dataRoot: string; origin: string; key: string; scratch: boolean }): NodeJS.ProcessEnv`:
  - Removes every `PER_TENANT_NAMES` entry and every `TOURCORE_*` name from `base`.
  - Then sets `TOURCORE_DEPLOYMENT_MODE=TENANT_WORKER`, `TOURCORE_HOME=<tenantFolder>/tour-core`, `TOURCORE_WORKER_KEY`, `PUBLIC_BASE_URL=<origin>/t/<id>`, `TOURCORE_TWILIO_ACCOUNT_SID` / `TOURCORE_TWILIO_AUTH_TOKEN` from `CLEANER_CORE_TWILIO_ACCOUNT_SID` / `CLEANER_CORE_TWILIO_AUTH_TOKEN`, `TOURCORE_TWILIO_PHONE_NUMBER=tenant.twilioNumber`, and `TOURCORE_TOURING_SCRATCH=1` when `scratch`.
- Produces `type SpawnWorker = (env: NodeJS.ProcessEnv) => WorkerHandle`, with `interface WorkerHandle { send(m: ToWorker): void; onMessage(cb: (m: ToParent) => void): void; onExit(cb: (code: number | null) => void): void; kill(): void }`.
- Produces `forkTouringWorker: SpawnWorker`. It forks `dist/touringWorker.js`, or `src/hosted/touringWorker.ts` with tsx when `dist` is missing.
- Produces `class TouringSupervisor`:
  - `constructor(opts: { spawn: SpawnWorker; env: (tenant: Tenant, key: string) => NodeJS.ProcessEnv; onEvent: (tenantId: string, id: string, event: OperatorEvent) => Promise<ToWorker>; log: (line: string) => void; now: () => number; setTimer?: typeof setTimeout })`
  - `ensure(tenant: Tenant): Promise<void>`: starts the tenant's worker when none is running, and resolves once it is ready.
  - `stop(tenantId: string): void`: kills the worker, cancels any pending restart, and forgets the tenant. A later message from that worker is dropped.
  - `target(tenantId: string): { port: number; key: string } | undefined`: undefined while starting, down, or stopped.
  - `setAlerts(tenantId: string, connected: boolean): void`
  - `health(tenantId: string): { up: boolean; restartsLastDay: number }`
  - `syncAll(tenants: Tenant[]): Promise<void>`: ensures every enabled touring tenant and stops every other.
- Restart delays after an unexpected exit: 1 s, 2 s, 4 s, … capped at 60 s. The delay resets after 10 minutes up. Each worker gets a fresh 32-byte key per start (`randomBytes(32).toString("base64url")`). Worker log lines go to `log` prefixed with `[tnt_…]`.

- [ ] **Step 1: Write the failing tests** with a fake `SpawnWorker` that records envs and lets the test emit `ready` and `exit`.

```ts
it("gives a worker only its own tenant's values", () => {
  const env = buildTouringEnv({ base: { ...process.env, CLEANER_CORE_ROUTINE_KEY: "other", TOURCORE_HOME: "/elsewhere", CLEANER_CORE_TWILIO_AUTH_TOKEN: "shared" }, tenant: lane, dataRoot: "/data", origin: "https://s.up.railway.app", key: "k", scratch: false });
  expect(env.CLEANER_CORE_ROUTINE_KEY).toBeUndefined();
  expect(env.TOURCORE_HOME).toBe(`/data/tenants/${lane.id}/tour-core`);
  expect(env.TOURCORE_TWILIO_PHONE_NUMBER).toBe(lane.twilioNumber);
  expect(env.PUBLIC_BASE_URL).toBe(`https://s.up.railway.app/t/${lane.id}`);
});
it("restarts after a crash with a growing delay", async () => { /* exits at t=0, 1s, 3s → spawns at 1s, 3s, 7s */ });
it("never restarts a stopped tenant, and drops its late messages", async () => { /* stop, then emit exit and an event → no spawn, onEvent not called */ });
it("starts touring tenants and stops the rest on sync", async () => { /* lane touring, court cleaning, mill touring+disabled → only lane runs */ });
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/touringSupervisor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** both files.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/touringSupervisor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hosted/touringEnv.ts src/hosted/touringSupervisor.ts test/touringSupervisor.test.ts
git commit -m "Hosted: start, restart, and stop one touring process per tenant"
```

---

### Task 5: Forwarding and the saved-text queue

**Files:**
- Create: `src/hosted/touringForward.ts`
- Test: `test/touringForward.test.ts`

**Interfaces:**
- Consumes: `TouringSupervisor.target` (Task 4), `twilioSignature` from `src/messaging/twilio/signature.ts`, `WORKER_KEY_HEADER` (Task 2).
- Produces:
  - `forwardMcp(target: {port:number;key:string}, r: HostedRequest, caller: { grantId: string; assistant: CleanerAssistant }): Promise<void>`. It POSTs or GETs to the worker's `/mcp` with `authorization: Bearer <key>`, the worker key header, `mcp-session-id` passed both ways, and the body unchanged. It streams the reply back, including SSE.
  - `forwardTenantPath(target, r: HostedRequest, rest: string): Promise<void>`. It sends `rest` (the path after `/t/<id>`), the query, method, body and headers to the worker, with hop-by-hop headers and `authorization` dropped and the worker key added.
  - `class TouringInbox`, with `constructor(dataRoot: string, now: () => Date)`:
    - `save(tenantId: string, raw: Buffer): string` writes `tenants/<id>/tour-core-inbound/<ms>-<sid>.form` atomically and returns its path.
    - `done(path: string): void`
    - `pending(tenantId: string): string[]` lists them oldest first.
  - `deliverText(target, origin: string, tenantId: string, raw: Buffer, authToken: string): Promise<boolean>`. It POSTs to the worker's `/webhooks/twilio` with `x-twilio-signature` computed over `${origin}/t/${tenantId}/webhooks/twilio`, and returns true on 2xx.
  - `replayInbox(inbox, target, origin, tenantId, authToken): Promise<void>`. It delivers the pending texts in order, stops at the first failure, and calls `done` on each success.
- Rule: the text is saved before forwarding and removed only after a 2xx. When the worker is down, the front answers Twilio with `EMPTY_TWIML` and leaves the file.

- [ ] **Step 1: Write the failing tests** against a real worker from Task 3 where the path matters (signature, `/verify/<token>`), and against a stub HTTP server for crash cases.

```ts
it("hands a text to the worker with a signature the worker accepts", async () => {
  expect(await deliverText(target, ORIGIN, LANE, form({ From: "+15555550177", To: LANE_NUMBER, Body: "Tour", MessageSid: "SM1" }), AUTH)).toBe(true);
  expect(await w.inboxCount()).toBe(1);
});
it("keeps a text the worker didn't take, and replays it once", async () => {
  const path = inbox.save(LANE, raw);
  await stub.down();
  expect(await deliverText(stubTarget, ORIGIN, LANE, raw, AUTH)).toBe(false);
  await stub.up();
  await replayInbox(inbox, stubTarget, ORIGIN, LANE, AUTH);
  await replayInbox(inbox, stubTarget, ORIGIN, LANE, AUTH);
  expect(stub.received).toHaveLength(1);
  expect(existsSync(path)).toBe(false);
});
it("forwards a visitor identity link under /t/<id>/", async () => { /* GET /t/<id>/verify/<token> → worker's /verify/<token> page */ });
it("never forwards the caller's bearer token to the worker", async () => { /* stub sees only the worker key */ });
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/touringForward.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `touringForward.ts`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/touringForward.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hosted/touringForward.ts test/touringForward.test.ts
git commit -m "Hosted: forward a touring tenant's calls, links, and texts, with a saved-text queue"
```

---

### Task 6: One address, tools by service, and routing

**Files:**
- Create: `src/hosted/serviceTools.ts`
- Modify: `src/cleaner-core/hosted/router.ts` (route `/mcp`, texts, and `/t/<id>/` by service; drop `/mcp` from `TOUR_CORE_PATHS`)
- Modify: `src/web/server.ts` (multi-tenant OAuth `tenantPolicy` allows `MCP_PATH`; resource name; build the supervisor; `syncAll` at start)
- Modify: `src/mcp/oauth/index.ts` (resource name for `/mcp` is "Cleaner Core and Tour Core" when multi-tenant)
- Test: `test/sharedServiceRouting.test.ts`
- Modify: `test/multiTenantHarness.ts` (a `toolAt(path, token, name, args)` helper and a supervisor using the real fork)

**Interfaces:**
- Consumes: Tasks 1, 4, 5.
- Produces, in `src/hosted/serviceTools.ts`:
  - `FRONT_TOOLS`: the definitions of `get_state` (unset only), `choose_service` (`service: "touring" | "cleaning"`), `switch_service` (`to`, `confirmation?`), `stand_down_service` (`confirmation?`), and `save_alert_routine` (touring only). Names and inputs are fixed here. Descriptions follow Cleaner Core's style in `src/cleaner-core/mcp.ts`.
  - `toolsFor(tenant: Tenant, env: NodeJS.ProcessEnv): "unset" | "cleaning" | "touring"`
  - `handleFrontTool(ctx: FrontContext, name: string, args: object): Promise<ToolReply | undefined>`: undefined means it isn't a front tool, so the call goes to the active service.
  - `interface FrontContext { h: HostedCleaner; tenant: Tenant; caller: { grantId: string; assistant: CleanerAssistant }; supervisor: TouringSupervisor; noteToolsChanged(): void }`
- Unset copy (exact):
  - `get_state.next`: `"This number isn't set up yet. Ask the host which service to set up: touring (visitors text this number to book a self-guided tour) or cleaning (turnover cleanings from the host's booking calendar). Then call choose_service."`
  - With the flag off, the touring half is left out, and the cleaning line is followed by `" Call choose_service with cleaning."`
  - `choose_service` reply: `"Set up for {service}. Your tools have changed. If you don't see the new ones, start a new chat."`
- Routing rules:
  - `/mcp` and `/mcp/cleaner-core` both authenticate on their own resource and resolve the tenant from the grant.
  - `tools/list` returns that service's list plus the front tools for that state. A touring tenant's list is the worker's `tools/list`, with `save_alert_routine`, `switch_service` and `stand_down_service` added.
  - `tools/call` for a front tool is answered at the front. For a tool of the inactive service it returns the Review Focus 3 refusal. Anything else goes to the active service.
  - `initialize` on a touring tenant is forwarded, so Tour Core's instructions and playbook choice are unchanged.
  - A text to `CLEANER_TWILIO_PATH`: signature check, tenant by `To`, then cleaning goes to the existing desk, touring is saved, delivered, and on failure answered with `EMPTY_TWIML`, and unset is answered with `EMPTY_TWIML` plus the log line `"A text reached {id}, which has no service yet. Nothing was sent."`
  - `/t/<id>/<rest>`: cleaning goes to the existing `handleTenantPath`, touring goes to `forwardTenantPath` (404 while the worker is down, except `/webhooks/twilio`, which is queued), and unset is 404.
  - After `choose_service` or a switch, `noteToolsChanged` calls `noteInitialized` for that connection's sessions (`src/mcp/toolListChanged.ts`).

- [ ] **Step 1: Write the failing tests** with `multiTenantApp({ env: { TOUR_CORE_TENANTS: "1" } })`, one tenant per state, joined through `/mcp`.

```ts
it("shows an unset tenant only get_state and choose_service", async () => {
  expect(await names(m, "/mcp", token)).toEqual(["choose_service", "get_state"]);
});
it("turns a tenant into a touring tenant and lists Tour Core's tools", async () => {
  await m.toolAt("/mcp", token, "choose_service", { service: "touring" });
  expect(await names(m, "/mcp", token)).toEqual(expect.arrayContaining(["get_state", "publish", "save_alert_routine", "switch_service", "stand_down_service"]));
});
it("keeps an existing cleaning host working on /mcp/cleaner-core", async () => { /* existing join + get_state unchanged */ });
it("offers only cleaning while TOUR_CORE_TENANTS is off", async () => { /* choose_service touring refused; get_state copy */ });
it("routes a text to a touring tenant's process and answers a visitor", async () => { /* local Scratch tenant → outbox has the welcome */ });
it("refuses a cleaning tool on a touring tenant with the start-a-new-chat line", async () => {});
it("answers nothing to a text for a tenant with no service", async () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/sharedServiceRouting.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the router branches, `serviceTools.ts`, and the server wiring. Call `supervisor.syncAll(registry.list())` once the public address is known, and `replayInbox` for each tenant after its worker is ready.

- [ ] **Step 4: Run the new tests and every hosted test**

Run: `npx vitest run test/sharedServiceRouting.test.ts test/cleanerHosted*.test.ts test/cleanerOauth.test.ts test/cleanerFullSetup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hosted/serviceTools.ts src/cleaner-core/hosted/router.ts src/web/server.ts src/mcp/oauth/index.ts test/sharedServiceRouting.test.ts test/multiTenantHarness.ts
git commit -m "Hosted: one address, tools by the tenant's service, texts and links routed by it"
```

---

### Task 7: Touring alerts through the tenant's routine

**Files:**
- Create: `src/hosted/touringAlerts.ts`
- Modify: `src/hosted/serviceTools.ts` (`save_alert_routine` for touring)
- Modify: `src/cleaner-core/hosted/router.ts` (the upload path under `/t/<id>/`)
- Modify: `src/cleaner-core/hosted/tenantSecrets.ts` (touring routine names per connection)
- Modify: `src/cleaner-core/hosted/tenantEnv.ts` (`PER_TENANT_NAMES` gains the touring routine names)
- Modify: `test/multiTenantHarness.ts` (`setTouringAlertFetch` recorder)
- Test: `test/touringAlerts.test.ts`

**Interfaces:**
- Produces:
  - `TOURING_ROUTINE_NAMES = ["TOURING_ROUTINE_URL", "TOURING_ROUTINE_KEY"] as const`, saved with `setForConnection` and added to `PER_TENANT_NAMES`.
  - `TOURING_ALERT_UPLOAD_PREFIX = "/touring/alert-routine/"`. One-time 43-character codes (the same `UPLOAD_CODE` shape as `src/cleaner-core/http.ts`), valid 30 minutes, kept as hashes in `tenants/<id>/touring-uploads.json`.
  - `issueTouringAlertLink(h: HostedCleaner, tenant: Tenant, grantId: string): string`: returns `<origin>/t/<id>/touring/alert-routine/<code>`.
  - `handleTouringAlertUpload(h, tenant, code, body: Record<string, unknown>): { status: 200 | 400 | 404; body: { ok: boolean; message?: string; error?: string } }`. It accepts `url` plus `token` or `key`, the same field names as Cleaner Core's upload. It refuses a non-https `url` or an empty token with 400. A used or expired code gets 404.
  - `touringSinkFor(h, tenant): OperatorNotificationSink`: the primary connection (`registry.primary`) picks `GrokRoutineWebhookSink` for grok, `ClaudeRoutineFireSink` for claude, and `NoopOperatorNotificationSink` for chatgpt and muse (an open task). It reads `TOURING_ROUTINE_*` for that connection.
  - `touringAlertsConnected(h, tenant): boolean`: the sink is `configured()`.
  - `setTouringAlertFetch(fetch: Fetch | undefined): void`: the test hook, like `setCleanerAlertFetch`. The sinks get it as `options.fetch`. `test/multiTenantHarness.ts` points it at the same `wakes` recorder.
  - The supervisor's `onEvent` delivers through `touringSinkFor`. Success acks `ok: true`, and a `DeliveryError` acks with its `retryable` flag. After a save, a disconnect, or a primary change, the front calls `supervisor.setAlerts(id, touringAlertsConnected(...))`. The worker sends the `installation.test` itself when that turns alerts on (Task 3).
- `save_alert_routine` reply (exact): `"Send the host this private link to paste the routine's webhook address and key. Never in chat: {link}"`.

- [ ] **Step 1: Write the failing tests**

```ts
it("wakes the Grok routine with a touring event, with no message text or phone numbers", async () => {
  await connectTouringRoutine(m, lane, grokToken);
  await visitorBooksATour(m, lane);
  const wake = m.wakes.at(-1)!;
  expect(JSON.parse(wake.body).eventType).toBe("tour.booked");
  expect(wake.body).not.toMatch(/\+1555/);
});
it("lets publish through only after the routine is connected", async () => {});
it("refuses an http routine address and a used link", async () => {});
it("keeps one tenant's routine away from another's events", async () => {});
it("retries a wake the routine refused, from the worker's outbox", async () => { m.setWakeStatus(500); /* then 200 → one more wake */ });
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/touringAlerts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/touringAlerts.test.ts test/sharedServiceRouting.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hosted/touringAlerts.ts src/hosted/serviceTools.ts src/cleaner-core/hosted/router.ts src/cleaner-core/hosted/tenantSecrets.ts src/cleaner-core/hosted/tenantEnv.ts test/multiTenantHarness.ts test/touringAlerts.test.ts
git commit -m "Hosted: touring alerts go out through the tenant's routine"
```

---

### Task 8: What's live, stand-down, and switching

**Files:**
- Create: `src/hosted/service.ts`
- Modify: `src/cleaner-core/liveDesk.ts` (`liveWork`, `standDown`)
- Create: `src/hosted/touringLive.ts` (worker side: `/internal/live`, `/internal/stand-down`)
- Modify: `src/web/server.ts` (mount the two internal routes in worker mode, behind the key)
- Modify: `src/hosted/serviceTools.ts` (`switch_service`, `stand_down_service`)
- Test: `test/serviceSwitching.test.ts`

**Interfaces:**
- Produces in `src/hosted/service.ts`:
  - `interface ServicePort { live(): Promise<{ live: string[]; inProgress: boolean } | "unreachable">; standDown(confirmation?: string): Promise<ToolReply> }`
  - `cleaningPort(h, tenant): ServicePort` and `touringPort(supervisor, tenantId): ServicePort`. The touring port answers `"unreachable"` when `target` is undefined or the call fails.
  - `switchService(ctx: FrontContext, input: { to: TenantService; confirmation?: string; force?: boolean }): Promise<ToolReply>`. It uses a `ConfirmationBook` (`src/operator/confirmations.ts`, 10 minutes) held by the front, with action `"switch-service"`, the tenant id as target, and the fingerprint `${from}>${to}`.
- `LiveDesk.liveWork(): string[]`: one line per live item: `"The property is active."` while activated, and one line per job in `offered`, `confirmed`, `awaiting_departure`, `cleared`, or `in_progress`.
- `LiveDesk.standDown(input: { confirmation?: string }): Promise<ToolReply>`:
  - Refused while a job is `cleared` or `in_progress` (`"A cleaning is under way. Stand down after it's done."`).
  - Otherwise it previews, then sets activated off and cancels each `offered`, `confirmed`, or `awaiting_departure` job, sending its cleaner one text through the consent-checked send path: `"The cleaning at {address} on {day} is called off. You don't need to come."`
  - It keeps property, people, consent, the sealed door code, preferences, routine connections, and history.
- Worker `/internal/live` returns `{ live, inProgress }`:
  - `live` has one line per published, unpaused property (`"{name} is taking bookings."`) and one per reservation in `RESERVED`, `AWAITING_CONSENT`, `AWAITING_VERIFICATION`, `READY`, `OPERATOR_HOLD`, or `PROVIDER_FAILURE` whose window ends after now (`"{visitor}'s tour at {time} on {day}."`).
  - `inProgress` is true when any reservation is `TOURING`.
- Worker `/internal/stand-down` previews, then pauses each published property with booked tours cancelled (the same work as `pauseTours(..., { bookedTours: "cancel" })` in `src/operator/availability.ts`, with that tool's cancel text). It is refused while `inProgress`, with `"Someone is on a tour right now. Stand down after it ends."`
- `switch_service` copy:
  - Blocked: `"{Service} is still live, so the number can't switch yet:\n- {line}\n…\nCall stand_down_service to stop it first. Its setup is kept."`
  - Unreachable: Review Focus 1's line.
  - Question: `"Switch this number from {from} to {to}? {From} stops answering texts. Its setup is kept, so you can switch back later. Reply yes to switch."`
  - Done: the `choose_service` reply.
- On a confirmed switch: `registry.setService`, then `supervisor.stop` or `ensure`, then `noteToolsChanged`. No texts are sent.

- [ ] **Step 1: Write the failing tests**

```ts
it("refuses to switch a touring tenant with a booked tour, and lists it", async () => {});
it("refuses to switch when the touring process isn't answering", async () => {});
it("stands touring down: previews the cancel texts, then pauses and cancels", async () => {});
it("refuses to stand touring down while someone is on a tour", async () => {});
it("stands cleaning down: one text to the cleaner, setup kept", async () => {});
it("switches with no texts, then switching back finds the saved setup", async () => {
  const before = m.sms.sent.length;
  await switchTo(m, lane, "cleaning");
  expect(m.sms.sent.length).toBe(before);
  await switchTo(m, lane, "touring");
  expect((await m.toolAt("/mcp", token, "get_state")).text).toContain("paused: false");
});
it("rejects a stale confirmation code after the live work changed", async () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/serviceSwitching.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests and Cleaner Core's gates**

Run: `npx vitest run test/serviceSwitching.test.ts test/cleanerCoreStepG.test.ts test/cleanerGroupFirst.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hosted/service.ts src/hosted/touringLive.ts src/hosted/serviceTools.ts src/cleaner-core/liveDesk.ts src/web/server.ts test/serviceSwitching.test.ts
git commit -m "Hosted: switch a number's service only when nothing is live, with stand-down"
```

---

### Task 9: STOP across services, and the inactive service's contacts

**Files:**
- Create: `src/hosted/crossService.ts`
- Modify: `src/cleaner-core/hosted/router.ts` (call it before routing a text)
- Modify: `src/cleaner-core/hosted/router.ts` `drainAllTenants` (skip tenants not on `cleaning`)
- Test: `test/crossService.test.ts`

**Interfaces:**
- Produces:
  - `class TenantOptOuts`, with `constructor(dataRoot: string)`:
    - `stop(tenantId: string, phone: string): void`
    - `start(tenantId: string, phone: string): void`
    - `stopped(tenantId: string, phone: string): boolean`
    - Kept in `tenants/<id>/opt-outs.json`, as E.164 numbers.
  - `screenText(input: { h; tenant: Tenant; from: string; body: string; optOuts: TenantOptOuts; knownToInactive: (phone: string) => Promise<boolean>; alert: (text: string) => Promise<void> }): Promise<"route" | "drop">`:
    - Updates opt-outs on STOP-family or START words, using the same keyword list Tour Core's STOP handling uses, and returns `"route"` for both, so each service still answers as today.
    - A phone that is stopped and not starting goes to `"drop"`.
    - A phone the inactive service knows also goes to `"drop"`, after one alert: `"Someone from your {inactive} setup texted this number, which is set up for {active} now. They didn't get a reply."`
  - `knownToInactive`:
    - For cleaning, it checks the desk's saved host and cleaner numbers (a `LiveDesk.knownPhones(): string[]`, added here).
    - For touring, it calls the worker's `/internal/known-phone?phone=` (added in `touringLive.ts`). When the worker is down it answers false.
- The alert goes out through the active service's routine: touring through `touringSinkFor`, cleaning through the desk's existing alert queue.

- [ ] **Step 1: Write the failing tests**

```ts
it("keeps a phone that texted STOP to cleaning opted out after the switch to touring", async () => {});
it("lets START reopen it", async () => {});
it("doesn't answer a cleaner's DONE as a tour request after the switch, and alerts the host once", async () => {});
it("sends no cleaning alerts for a tenant on touring", async () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/crossService.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/crossService.test.ts test/sharedServiceRouting.test.ts test/stopReply.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hosted/crossService.ts src/hosted/touringLive.ts src/cleaner-core/hosted/router.ts src/cleaner-core/liveDesk.ts test/crossService.test.ts
git commit -m "Hosted: STOP covers both services; the inactive service's contacts get no reply"
```

---

### Task 10: `/admin`: service, switch, force, and health

**Files:**
- Modify: `src/cleaner-core/hosted/admin.ts`
- Modify: `src/cleaner-core/hosted/adminPages.ts`
- Modify: `src/hosted/service.ts` (an admin entry to `switchService` with `force`)
- Modify: `src/hosted/touringSupervisor.ts` (queued text count via `TouringInbox.pending`)
- Test: `test/cleanerHostedAdmin.test.ts`

**Interfaces:**
- Consumes: `switchService` (Task 8), `TouringSupervisor.health` (Task 4), `TouringInbox.pending` (Task 5).
- Produces:
  - The list page gets the columns "Service" (`touring`, `cleaning`, or `not chosen`) and "Touring process" (`up`, `down`, or `—`).
  - The tenant page shows restarts in the last day and queued texts. It gets `POST /admin/tenants/<id>/service` with `to` and an optional `force=1`.
    - Without force: on blockers the page shows them and nothing changes. When clear, the service switches. The page's own CSRF form is the confirmation.
    - With force: it switches without standing down and sends nothing.
  - The tenant's audit gets `{ at, actor: "admin", from, to, forced }` in `tenants/<id>/service-audit.jsonl`.
  - Deleting a tenant calls `supervisor.stop` before removing folders.

- [ ] **Step 1: Write the failing tests** in the existing admin test file's style.

```ts
it("shows each tenant's service and touring process", async () => {});
it("shows the blockers and doesn't switch a live tenant without force", async () => {});
it("force-switches a live tenant, sends nothing, and records it", async () => {});
it("stops a touring process before deleting its tenant", async () => {});
it("shows no phone numbers of visitors or cleaners, codes, or routine values", async () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/cleanerHostedAdmin.test.ts`
Expected: FAIL on the new tests only.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/cleanerHostedAdmin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cleaner-core/hosted src/hosted test/cleanerHostedAdmin.test.ts
git commit -m "Admin: each tenant's service, switch and force, touring process health"
```

---

### Task 11: Scratch touring tools

**Files:**
- Modify: `src/hosted/touringSupervisor.ts` (`scratch` is true when `isScratchTestNumber(tenant.twilioNumber)`)
- Modify: `src/hosted/touringLive.ts` (worker `/internal/scratch/inbox`, `/internal/scratch/outbox`, `/internal/scratch/text`)
- Modify: `src/hosted/serviceTools.ts` (touring `read_inbox`, `read_outbox`, `send_test_text` when `CLEANER_CORE_SCRATCH_TOOLS` is on and the tenant is Scratch)
- Test: `test/touringScratch.test.ts`

**Interfaces:**
- Consumes: `isScratchTestNumber` from `src/cleaner-core/scratch.ts`. On the worker, Tour Core's local outbox in `src/messaging/local/`.
- Produces: the same three tool names and inputs as Cleaner Core's Scratch tools in `src/cleaner-core/mcp.ts` (`send_test_text` takes `from` and `text`). `from` must be a 555 number, or it is refused with Cleaner Core's wording.
- A Scratch touring worker runs with the `LOCAL` provider (Task 3), so no Twilio call is ever made for it, even with live texts on.

- [ ] **Step 1: Write the failing tests**

```ts
it("books a practice visitor end to end on a Scratch tenant, all in the outbox", async () => {});
it("refuses send_test_text from a number outside the 555 block", async () => {});
it("makes no Twilio call for a Scratch touring tenant even with live texts on", async () => {});
it("doesn't list the Scratch tools for a tenant whose number isn't a 555 number", async () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/touringScratch.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/touringScratch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hosted test/touringScratch.test.ts
git commit -m "Hosted: Scratch tools for touring tenants, 555 numbers only"
```

---

### Task 12: Tour Core safety gates and the hosted tenants gate

**Files:**
- Create: `docs/tour-core-safety-gates.md`
- Create: `test/tourCoreSafetyGates.test.ts`
- Create: `test/sharedServiceTenants.test.ts`
- Modify: `scripts/ci-check.sh` only if the new tests need a separate run (they shouldn't: `npm test` picks them up)

**Interfaces:**
- Consumes: everything above. The harness is `multiTenantApp` with `TOUR_CORE_TENANTS=1`: two touring tenants (`tnt_lane…`, `tnt_mill…`) and one cleaning tenant (`tnt_court…`), all on 555 numbers.
- The gates doc follows `docs/cleaner-core-safety-gates.md`: a short intro, then a table of Gate, What it holds, and Proof. Each row's proof is a test name in the two test files.

- [ ] **Step 1: Write the gate tests**

`test/tourCoreSafetyGates.test.ts`. Each gate runs through a touring tenant on the shared service:
- door access only on the reserved route during the window; early arrival denied; an off-route door turned away; a repeat request doesn't grant twice
- a fair-housing question opens a landlord item with no draft, and the visitor gets the holding reply
- STOP and HELP win over a booking text
- after a worker restart and a replayed queue, no visitor gets a second copy of any text

`test/sharedServiceTenants.test.ts`, the hosted tenants gate. None of these reach another tenant:
- a text to Lane's number
- Lane's grant on `/mcp` or `/mcp/cleaner-core`
- a swapped `/t/<id>/` prefix on a `/verify/` link
- a forwarded MCP call
- a worker's environment (assert no Court or Mill value in Lane's `buildTouringEnv`)
- a touring alert (Mill's routine gets no Lane event)
- a stand-down

- [ ] **Step 2: Run them.** They should pass on the code from Tasks 1–11. A failure is a bug in the owning task: fix it there and re-run.

Run: `npx vitest run test/tourCoreSafetyGates.test.ts test/sharedServiceTenants.test.ts`
Expected: PASS.

- [ ] **Step 3: Write `docs/tour-core-safety-gates.md`** with one row per gate, naming the test.

- [ ] **Step 4: Run the full CI script**

Run: `bash scripts/ci-check.sh`
Expected: every step `ok`.

- [ ] **Step 5: Commit**

```bash
git add docs/tour-core-safety-gates.md test/tourCoreSafetyGates.test.ts test/sharedServiceTenants.test.ts scripts/ci-check.sh
git commit -m "Tour Core safety gates on the shared service, and the hosted tenants gate"
```

---

### Task 13: Templates, Railway, and docs

**Files:**
- Modify: `grok-template/template.json` (`hostedTourCoreUrl` set to `https://tourcore-production-8b80.up.railway.app`)
- Modify: `test/grokTemplate.test.ts` (the URL)
- Modify: `.railway/railway.ts` (it describes the one shared service: `CLEANER_CORE_MULTI_TENANT`, `CLEANER_CORE_ENABLED`, and `TOUR_CORE_TENANTS` documented in the comment, no secrets)
- Modify: `docs/deployment.md`, `docs/hosted-multitenancy.md`, `GROK_BOOTSTRAP.md`, `README.md`
- Modify: `src/eval/clientMatrix.ts` only if a template test reads the URL from it

**Interfaces:**
- Content:
  - `docs/hosted-multitenancy.md` gains a "Services" section: the `service` field, choose and switch, touring processes, and the alias.
  - `docs/deployment.md`'s Tour Core service section says the shared service replaced it. The variable table gains `TOUR_CORE_TENANTS`.
  - The README's variable table gains `TOUR_CORE_TENANTS`, with the description from the Global Constraints.
  - `GROK_BOOTSTRAP.md`: "Approval shows a pairing code. The operator clicks Allow. The first approval claims this demo." becomes the invite-code wording from `cleaner-template/`. The host then chooses touring.
  - The spec's open tasks go into `docs/hosted-multitenancy.md` under "Not yet".

- [ ] **Step 1: Update `test/grokTemplate.test.ts`** to expect the new URL and the invite-code wording. Run it and see it fail.

Run: `npx vitest run test/grokTemplate.test.ts test/grokSkills.test.ts`
Expected: FAIL on the URL.

- [ ] **Step 2: Make the template and doc changes.**

- [ ] **Step 3: Run the template tests and the full suite**

Run: `npx vitest run test/grokTemplate.test.ts test/grokSkills.test.ts test/cleanerTemplate.test.ts && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add grok-template/template.json test/grokTemplate.test.ts .railway/railway.ts docs/deployment.md docs/hosted-multitenancy.md GROK_BOOTSTRAP.md README.md
git commit -m "Docs and templates: Tour Core lives on the shared service"
```

---

## After the plan (Saad, not code)

1. Merge with `TOUR_CORE_TENANTS` unset. The deploy changes nothing for current hosts.
2. Set `TOUR_CORE_TENANTS=1` on Railway. Make a Scratch tenant with a 555 number on `/admin`, connect Grok, choose touring, set up a property, connect the touring routine, run a practice tour, and send visitor texts with `send_test_text`. Then switch to cleaning and back.
3. One real pilot landlord, only with Saad's okay on live texts and the allowlist.
