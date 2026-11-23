# A Bot for Each Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Cleaner Core, Supply Core and Fixer Core each run in their own Grok bot, with the server deciding which bot may list, call and be woken for what, and the Property Core bot as the front door.

**Architecture:** Every connection carries a job, taken from the address its sign-in grant is bound to. One pure rule in `src/jobs/jobs.ts` answers who has and who holds each job, and the front connection (`src/hosted/frontMcp.ts`), the desk environment and the host-alert clock all ask it. Nothing is saved for a hand-over: the holder is computed on every request from the connections, their saved routines and the account's `bots` switch.

**Tech Stack:** TypeScript on Node 22.13+, zod, vitest. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-22-bot-per-core-design.md` (today at `/mnt/project-files/bot-per-core/design.md`). Read it first. This plan is meant for `docs/superpowers/plans/2026-11-22-bot-per-core.md`.

**Scope:** the spec's build steps 1 to 4, which are all server work. Step 5 (templates and guides) waits on the scratch Grok check the spec lists, and step 6 (`get_schedule`) is a separate read-only tool. Each gets its own plan. Step 7 is a hand test.

**Pull requests:** four, in the spec's order. Tasks 1 to 4 are step 1, tasks 5 to 8 are step 2, task 9 is step 3, task 10 is step 4. Task 11 rides with the last one.

## Global Constraints

- An account with only `/mcp` connections behaves exactly as on `master` at `92c824b2`: `tools/list`, `initialize` and every reply byte for byte. `test/propertyClientMatrix.test.ts` stays green untouched.
- Nothing changes for an account whose `bots` switch is off. `bots` is off by default.
- A job only takes tools away from a connection. It never adds a tool that the flows and `featureOn` would not list, and no gate's decision changes.
- The job check is in code on the call, before any desk is reached, not only on the list.
- A core's address is for Grok Bot only, and only on an account whose primary `/mcp` connection is Grok Bot.
- The primary is only ever a connection with no `job`.
- No door code, digits of one, phone number or another core's question travels between bots. A wake-up carries ids and a time, nothing else.
- From `AGENTS.md`: tests use made-up stores, 555 numbers, made-up codes and a stubbed routine fetch. No test texts a real phone. Secrets stay out of code, logs and prompts.
- Paths: `/mcp/cleaner`, `/mcp/supply`, `/mcp/fixer`. Quiet threshold: 150 minutes (`CHATGPT_CHECK_GAP_MS` in `src/cleaner-core/assistant.ts`). `lastSeenAt` is written at most every 5 minutes. Routine upload links last 30 minutes.
- New wording in this plan is a first draft for the repository's wording pass. Tests compare against the exported constant, not a copied string.
- Run `npm run typecheck` and the named test file before each commit. Run `npm test` once at the end of each pull request.

## Review Focus

Each line is pinned by a test in the task named.

1. **A core's bot is connected but its setup is never finished.** It must hold nothing, and the Property Core chat keeps the tools and the wake-ups. Task 5, "a core bot with no routine holds nothing".
2. **A second bot connects for a job that already has one, mid-setup.** The first is disconnected, its routine is deleted, and no alert goes to both. Task 3, "a second Fixer Core bot replaces the first".
3. **The primary chat disconnects while core bots are connected.** A core connection must never become primary. Task 2, "disconnecting the primary never picks a core connection".
4. **A tool name another bot holds is called by a routine left behind in the Property Core chat.** It is refused before any desk, with the line that sends the host to the right bot. Task 4, "a left-behind routine's check is refused before the desk".
5. **An alert arrives while the bot it is routed to has no working routine.** It is kept once, shown once by `check_alerts`, and not re-sent every pass. Task 7, "an alert with no routine waits and is shown once".

---

### Task 1: The `bots` switch and the rule

**Files:**
- Modify: `src/features/features.ts:12-28` (`FEATURES`, `FEATURE_INFO`)
- Create: `src/jobs/jobs.ts`
- Modify: `docs/environment-variables.md:17-19,46` (the feature names `/admin` and `FEATURES_OFF` take gain `bots`)
- Test: `test/botJobs.test.ts` (new), `test/featureSwitches.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (all exported from `src/jobs/jobs.ts`, which imports types only):

```ts
export const JOBS = ["property", "cleaning", "supplies", "fixer"] as const;
export type Job = (typeof JOBS)[number];
export type CoreJob = Exclude<Job, "property">;
export const CORE_JOBS: readonly CoreJob[] = ["cleaning", "supplies", "fixer"];
export const JOB_PATHS: Record<CoreJob, string> = { cleaning: "/mcp/cleaner", supplies: "/mcp/supply", fixer: "/mcp/fixer" };
export const JOB_NAMES: Record<Job, string> = { property: "Property Core", cleaning: "Cleaner Core", supplies: "Supply Core", fixer: "Fixer Core" };
export const QUIET_MS = 150 * 60_000;
export function jobOfPath(path: string): CoreJob | undefined;
/** The shape the rule reads. Tenant and TenantConnection satisfy it after Task 2, as FeatureAccount is satisfied by Tenant. */
export interface JobConnection { grantId: string; assistant: CleanerAssistant; connectedAt: string; job?: CoreJob; lastSeenAt?: string }
export interface JobAccount { primaryGrantId?: string; connections: JobConnection[] }
export interface JobDeps { botsOn: boolean; isLive(grantId: string): boolean; hasRoutine(grantId: string): boolean }
/** The primary among live connections with no job: primaryGrantId when it is one, else the oldest. */
export function mainConnection(account: JobAccount, deps: JobDeps): JobConnection | undefined;
/** The live connection at this core's address. Undefined when botsOn is false. */
export function coreBot(account: JobAccount, job: CoreJob, deps: JobDeps): JobConnection | undefined;
export function holderOf(account: JobAccount, job: Job, deps: JobDeps): JobConnection | undefined;
export function jobsFor(account: JobAccount, connection: JobConnection, deps: JobDeps): Job[];
/** At least one core job is held by its own bot. */
export function isTeam(account: JobAccount, deps: JobDeps): boolean;
/** No call for QUIET_MS, counted from lastSeenAt, or connectedAt when it never called. */
export function isQuiet(connection: JobConnection, now: Date): boolean;
```

`FEATURES` gains `"bots"` last. `FEATURE_INFO.bots = { title: "Separate bots", covers: "A Grok bot for each of Cleaner Core, Supply Core and Fixer Core, managed by the Property Core bot" }`. It needs no credentials and no other switch.

- [ ] **Step 1: Write the failing tests in `test/botJobs.test.ts`**

Build accounts by hand: `main` is `{ grantId: "g-main", assistant: "grok", connectedAt: "2026-11-22T10:00:00.000Z" }`, `fixerBot` is the same shape with `grantId: "g-fix"`, `job: "fixer"`, an hour later. `deps(over)` returns `{ botsOn: true, isLive: () => true, hasRoutine: () => false, ...over }`.

```ts
it("an account with only /mcp connections has and holds every job on the primary", () => {
  const account = { primaryGrantId: "g-main", connections: [main] };
  expect(jobsFor(account, main, deps())).toEqual(["property", "cleaning", "supplies", "fixer"]);
  for (const job of JOBS) expect(holderOf(account, job, deps())?.grantId).toBe("g-main");
  expect(isTeam(account, deps())).toBe(false);
});
it("a core bot with no routine has its job and holds nothing", () => {
  const account = { primaryGrantId: "g-main", connections: [main, fixerBot] };
  expect(jobsFor(account, fixerBot, deps())).toEqual(["fixer"]);
  expect(jobsFor(account, main, deps())).toContain("fixer");
  expect(holderOf(account, "fixer", deps())?.grantId).toBe("g-main");
});
it("a core bot with its routine saved holds its job, and /mcp stops having it", () => {
  const d = deps({ hasRoutine: (id) => id === "g-fix" });
  const account = { primaryGrantId: "g-main", connections: [main, fixerBot] };
  expect(holderOf(account, "fixer", d)?.grantId).toBe("g-fix");
  expect(jobsFor(account, main, d)).toEqual(["property", "cleaning", "supplies"]);
  expect(isTeam(account, d)).toBe(true);
});
it("the job comes back when the grant ends or the switch goes off", () => {
  const account = { primaryGrantId: "g-main", connections: [main, fixerBot] };
  const saved = { hasRoutine: (id: string) => id === "g-fix" };
  expect(holderOf(account, "fixer", deps({ ...saved, isLive: (id) => id !== "g-fix" }))?.grantId).toBe("g-main");
  expect(holderOf(account, "fixer", deps({ ...saved, botsOn: false }))?.grantId).toBe("g-main");
  expect(jobsFor(account, fixerBot, deps({ ...saved, botsOn: false }))).toEqual([]);
});
it("the primary is never a core connection", () => {
  const account = { primaryGrantId: "g-fix", connections: [fixerBot, main] };
  expect(mainConnection(account, deps())?.grantId).toBe("g-main");
  expect(mainConnection({ connections: [fixerBot] }, deps())).toBeUndefined();
});
it("a second /mcp chat has the same tools as the primary and holds nothing", () => { /* second no-job connection: jobsFor equals main's; holderOf("property") is g-main */ });
it("quiet is 150 minutes from the last call", () => {
  const seen = { ...fixerBot, lastSeenAt: "2026-11-22T12:00:00.000Z" };
  expect(isQuiet(seen, new Date("2026-11-22T14:29:00.000Z"))).toBe(false);
  expect(isQuiet(seen, new Date("2026-11-22T14:30:00.000Z"))).toBe(true);
});
it("maps the three addresses and nothing else", () => {
  expect(jobOfPath("/mcp/fixer")).toBe("fixer");
  expect(jobOfPath("/mcp")).toBeUndefined();
  expect(jobOfPath("/mcp/cleaner-core")).toBeUndefined();
});
```

In `test/featureSwitches.test.ts`, add: `bots` is in `FEATURES`, is off for a new account, turns on with `switchOn`, and `FEATURES_OFF=bots` turns it off.

- [ ] **Step 2: Run** `npx vitest run test/botJobs.test.ts test/featureSwitches.test.ts`. Expected: FAIL, `src/jobs/jobs` not found.
- [ ] **Step 3: Implement** the module and the `FEATURES` entry. When two live connections carry the same job (the registry prevents it after Task 2), `coreBot` takes the newest `connectedAt`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then `npm run typecheck`: any `Record<Feature, …>` that now misses `bots` is a compile error to fix where it is.
- [ ] **Step 5: Commit** `feat(jobs): the bots switch and the rule for who holds each job`.

---

### Task 2: A job and a last-seen time on the connection

**Files:**
- Modify: `src/cleaner-core/hosted/registry.ts:16-20` (`TenantConnection`), `:241-273` (`connect`, `disconnect`, `setPrimary`, `primary`), near `:199-210` (invites), near `:340-350` (`touch`)
- Modify: `src/cleaner-core/hosted/router.ts:519-542` (`promoteRoutineOwner`, `promoteFixerRoutine`)
- Test: `test/cleanerHostedRegistry.test.ts`

**Interfaces:**
- Consumes: `CoreJob`, `mainConnection` from Task 1.
- Produces:

```ts
export interface TenantConnection { grantId: string; assistant: CleanerAssistant; connectedAt: string; job?: CoreJob; lastSeenAt?: string }
/** Returns the grant ids this connection replaced: older connections with the same job. Empty for a /mcp connection. */
connect(tenantId: string, connection: TenantConnection): { replaced: string[] };
/** Throws RegistryError("unknown-tenant") for a connection that has a job. */
setPrimary(tenantId: string, grantId: string): void;
/** Picks only among connections with no job (mainConnection's rule). */
primary(tenantId: string, isLive: (grantId: string) => boolean): TenantConnection | undefined;
/** Writes lastSeenAt for this connection, at most once every 5 minutes (TOUCH_MS). */
seen(tenantId: string, grantId: string): void;
/** The account an unused invite belongs to, without using it up. */
inviteOwner(code: string): string | undefined;
```

- [ ] **Step 1: Write the failing tests** in `test/cleanerHostedRegistry.test.ts`:

```ts
it("connecting a core bot never makes it primary", () => {
  registry.connect(id, { grantId: "g-fix", assistant: "grok", connectedAt: T1, job: "fixer" });
  expect(registry.get(id)!.primaryGrantId).toBeUndefined();
  registry.connect(id, { grantId: "g-main", assistant: "grok", connectedAt: T2 });
  expect(registry.get(id)!.primaryGrantId).toBe("g-main");
});
it("disconnecting the primary never picks a core connection", () => {
  // g-main (primary), g-fix (fixer), g-second (/mcp, later)
  registry.disconnect(id, "g-main");
  expect(registry.get(id)!.primaryGrantId).toBe("g-second");
  registry.disconnect(id, "g-second");
  expect(registry.get(id)!.primaryGrantId).toBeUndefined();
  expect(registry.primary(id, () => true)).toBeUndefined();
});
it("a second bot for a job replaces the first", () => {
  registry.connect(id, { grantId: "g-fix", assistant: "grok", connectedAt: T1, job: "fixer" });
  expect(registry.connect(id, { grantId: "g-fix-2", assistant: "grok", connectedAt: T2, job: "fixer" })).toEqual({ replaced: ["g-fix"] });
  expect(registry.get(id)!.connections.map((c) => c.grantId)).toEqual(["g-fix-2"]);
});
it("setPrimary refuses a core connection", () => { expect(() => registry.setPrimary(id, "g-fix")).toThrow(); });
it("seen writes lastSeenAt at most every 5 minutes", () => { /* two calls 4 minutes apart keep the first time; a third at 6 minutes moves it */ });
it("inviteOwner names the account and leaves the invite usable", () => {
  const code = registry.invite(id);
  expect(registry.inviteOwner(code)).toBe(id);
  expect(registry.claimInvite(code)).toEqual({ tenantId: id });
  expect(registry.inviteOwner(code)).toBeUndefined();
});
```

- [ ] **Step 2: Run** `npx vitest run test/cleanerHostedRegistry.test.ts`. Expected: FAIL on the six new tests.
- [ ] **Step 3: Implement.** `primary` hands the tenant to `mainConnection` with `{ botsOn: true, isLive, hasRoutine: () => false }`. `promoteRoutineOwner` and `promoteFixerRoutine` skip any connection with a `job`. Every existing caller of `connect` ignores the new return value.
- [ ] **Step 4: Run** the file, then `npx vitest run test/cleanerHostedRouter.test.ts`. Expected: PASS, no existing test changed.
- [ ] **Step 5: Commit** `feat(registry): a job and a last-seen time on each connection`.

---

### Task 3: The three addresses, sign-in and `/admin`

**Files:**
- Modify: `src/mcp/oauth/provider.ts:58-67` (`ResourceLabel`, `OAuthResource`), `:133-142` (`InviteBook`), `:405-423` (`approveWithInvite`), `:455-470` (`approveWithAccount`), `:605` (`connected`)
- Modify: `src/mcp/oauth/pages.ts` (`consentPage`), `src/mcp/oauth/index.ts` (export the new scopes)
- Modify: `src/web/server.ts:189` (`OAUTH_RESOURCE_PATHS`), `:536-540` (`resources`), `:566-573` (`invites`)
- Modify: `src/cleaner-core/hosted/router.ts:202` (path check), `:58-73` (`HostedCleaner`)
- Create: `src/hosted/jobDeps.ts`
- Modify: `src/cleaner-core/hosted/admin.ts:205-232`, `src/cleaner-core/hosted/adminPages.ts` (connection rows)
- Modify: `test/multiTenantHarness.ts:80` (`joinAt`)
- Test: `test/botJobsHosted.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's rule, Task 2's registry.
- Produces:

```ts
// src/mcp/oauth/provider.ts
export type ResourceLabel = "Tour Core" | "Cleaner Core" | "Property Core" | "Supply Core" | "Fixer Core";
export const JOB_SCOPES: Record<CoreJob, string> = { cleaning: "propertycore.cleaning", supplies: "propertycore.supplies", fixer: "propertycore.fixer" };
export interface OAuthResource { path: string; scope: string; label: ResourceLabel; enabled?: () => boolean; job?: CoreJob }
export interface InviteBook {
  claim(code: string): { tenantId: string } | { refused: InviteRefusal };
  /** Now also given the address the grant is bound to. */
  connected(tenantId: string, grantId: string, assistant: CleanerAssistant, resourcePath: string): void;
  refusal(reason: InviteRefusal): string;
  accounts?: AccountDoor;
  /** The account an unused invite belongs to, without using it. */
  owner?(code: string): string | undefined;
  /** Words that refuse this connection for this account, or undefined to let it through. */
  admit?(tenantId: string, assistant: CleanerAssistant, resourcePath: string): string | undefined;
}

// src/hosted/jobDeps.ts
export const BOTS_OFF = "Separate bots aren't turned on for this account. Connect this chat to Property Core instead.";
export const BOTS_GROK_ONLY = "Separate bots work with Grok Bot only. Connect this chat to Property Core instead.";
export const BOTS_NEED_MAIN = "Set up the Property Core bot on Grok Bot first, then connect this one.";
export function jobDeps(h: HostedCleaner, tenant: Tenant): JobDeps;            // botsOn = featureOn(tenant, "bots", h.baseEnv()); hasRoutine = both ROUTINE_NAMES saved for that connection in h.secrets
export function holder(h: HostedCleaner, tenant: Tenant, job: Job): TenantConnection | undefined;
export function team(h: HostedCleaner, tenant: Tenant): boolean;
/** The jobs a signed-in caller has. At a core address with no matching registry connection: none. At /mcp with none: as a /mcp connection. */
export function callerJobs(h: HostedCleaner, tenant: Tenant, grantId: string, path: string): Job[];
/** Why this sign-in is refused at a core address, or undefined. Checked in this order: BOTS_OFF, BOTS_GROK_ONLY, BOTS_NEED_MAIN (no live primary, the primary isn't Grok Bot, or the account isn't a properties account). */
export function admitBot(h: HostedCleaner, tenant: Tenant | undefined, assistant: CleanerAssistant, path: string): string | undefined;
/** What /admin's Disconnect does, in one place: revoke the grant, delete the connection's secrets, drop it from the registry. */
export function dropConnection(h: HostedCleaner, tenantId: string, grantId: string): void;

// HostedCleaner gains
revokeGrant?(grantId: string): void;
```

Decisions the code cannot make alone:
- The three resources are added only on the multi-tenant service, each with `enabled: multiTenant`, its `JOB_SCOPES` scope, its `job`, and the label from `JOB_NAMES`.
- `approveWithInvite` calls `owner` then `admit` **before** `claim`, so a refused bot does not use up the invite. `approveWithAccount` calls `admit` after sign-in and before `bind`. Both answer `{ ok: false, message }` with the words `admit` gave.
- `connected` in `server.ts` passes `job: jobOfPath(resourcePath)` to `tenants.connect` and calls `dropConnection` for each id in `replaced`.
- `consentPage` takes the resource's `job` and, when set, says `Allow this chat to run ${JOB_NAMES[job]} for your account.`
- `/admin`: each connection row shows `JOB_NAMES[job ?? "property"]`. "Make primary" is offered only for a row with no job. Disconnect calls `dropConnection`. `server.ts` wires `revokeGrant` on the `HostedCleaner` it builds at `:485-500` the way `:794` does for `/admin`.
- `joinAt` in the harness takes any of the five paths and picks the scope: `OPERATOR_SCOPE` for `/mcp`, `JOB_SCOPES[job]` for a core address, else `CLEANER_SCOPE`. Add `refusedAt(tenantId, assistant, path): Promise<string>` beside it, which runs the same sign-in and returns the page's refusal text.

- [ ] **Step 1: Write the failing tests** in `test/botJobsHosted.test.ts`. Header comment as in `test/hostAlertsHosted.test.ts:26`. Shared fixture, reused by every later task:

```ts
const P = "/mcp", C = "/mcp/cleaner", S = "/mcp/supply", F = "/mcp/fixer";
/** One Grok account on the shared service with one property. `bots` on unless told otherwise. Returns the Property Core chat's token as `main`. */
async function account(options: { bots?: boolean; flows?: FlowName[]; features?: Feature[] } = {})
```

Follow `account()` in `test/hostAlertsHosted.test.ts:55-66` for the registry calls and the `hub.json` it writes.

```ts
it("a token for one address is refused at the others", async () => {
  const { m, tenant } = await account({ flows: ["fixer"] });
  const fixer = await m.joinAt(tenant.id, "grok", F);
  expect((await m.rpcAt(F, fixer, "tools/list")).status).toBe(200);
  for (const path of [P, C, S]) expect((await m.rpcAt(path, fixer, "tools/list")).status).toBe(401);
});
it("the connection carries its job and never becomes primary", async () => {
  /* after joinAt(F): registry.get(id).connections has one with job "fixer"; primaryGrantId is still main's */
});
it("a second Fixer Core bot replaces the first", async () => {
  const first = await m.joinAt(tenant.id, "grok", F);
  await m.joinAt(tenant.id, "grok", F);
  expect((await m.rpcAt(F, first, "tools/list")).status).toBe(401);
  expect(m.registry.get(tenant.id)!.connections.filter((c) => c.job === "fixer")).toHaveLength(1);
  /* the first connection's grant id, read from the registry before the second joined, has no saved values left: m.hosted().secrets.connection(tenant.id, firstId) is {} */
});
it("refuses a core address with the switch off, without using the invite", async () => {
  const { m, tenant } = await account({ bots: false });
  expect(await m.refusedAt(tenant.id, "grok", F)).toContain(BOTS_OFF);
  expect(m.registry.get(tenant.id)!.connections.some((c) => c.job)).toBe(false);
});
it("refuses any agent but Grok Bot, and an account whose primary isn't Grok Bot", async () => {
  expect(await m.refusedAt(tenant.id, "claude", F)).toContain(BOTS_GROK_ONLY);
  /* a second account whose only /mcp chat is Claude: */ expect(await m2.refusedAt(other.id, "grok", F)).toContain(BOTS_NEED_MAIN);
});
it("the approval page names the job", async () => { /* GET the authorize page for F: body contains "Allow this chat to run Fixer Core for your account." */ });
it("/admin shows each connection's job and offers Make primary only for /mcp", async () => { /* follow the page tests in test/cleanerHostedAdmin.test.ts */ });
```

- [ ] **Step 2: Run** `npx vitest run test/botJobsHosted.test.ts`. Expected: FAIL, the new paths answer 404.
- [ ] **Step 3: Implement** in the order of the Files list. `handleTenantMcp` is reached for the three paths but is not changed here.
- [ ] **Step 4: Run** the file, plus `npx vitest run test/cleanerOauth` (every existing sign-in test). Expected: PASS.
- [ ] **Step 5: Commit** `feat(bots): an address and a sign-in for each core's bot`.

---

### Task 4: Each bot lists and calls only its job's tools

**Files:**
- Create: `src/hosted/jobTools.ts`
- Modify: `src/hosted/frontMcp.ts:95-110` (`handleTenantMcp`), `:156` (`Caller`), `:176-179` (`initialize`), `:190-215` (`propertyToolList`), `:217-219` (`propertyToolCall`)
- Test: `test/botJobsHosted.test.ts`, `test/botJobs.test.ts`

**Interfaces:**
- Consumes: `callerJobs`, `holder` (Task 3), `JOB_NAMES`.
- Produces:

```ts
// src/hosted/frontMcp.ts
export type Caller = { grantId: string; assistant: CleanerAssistant; job?: CoreJob; jobs: Job[] };   // now exported. job: the address's; jobs: what it has now

// src/hosted/jobTools.ts
/** The jobs that may call this tool. Empty for a name no desk knows. */
export function jobsOf(tool: string): readonly Job[];
/** True when the caller may call it. Unknown names pass, so they reach today's "There's no tool named" line. */
export function mayCall(tool: string, caller: { job?: CoreJob; jobs: readonly Job[] }): boolean;
export const NO_JOBS = "Separate bots are off for this account. Ask the host to open the Property Core bot.";
/** ownBot true: "Fixer Core has its own bot on this account. Ask the host to open the Fixer Core bot for that." Else: "That belongs to the Property Core bot. Ask the host to open the Property Core bot for that." */
export function elsewhereLine(owner: Job, ownBot: boolean): string;
/** Added after elsewhereLine when a /mcp caller calls check_now, check_supplies or check_fixes: "Delete your Fixer Core routines here. That bot runs its own." */
export function leftBehindLine(owner: CoreJob): string;
/** The first line of initialize for a core's bot. */
export function jobInstructions(job: CoreJob): string;
/** For the Property Core chat on a team: "Cleaner Core and Fixer Core each have their own bot on this account. Send the host to that bot's chat for their work." */
export function teamLine(ownBots: readonly CoreJob[]): string;
```

`jobsOf`, from the name sets that exist:

| Tools | Jobs |
| --- | --- |
| `get_state` | all four |
| `add_property`, `set_flows`; `LOCK_FRONT_NAMES`, `CAMERA_FRONT_NAMES`, `STAY_CHECK_FRONT_NAMES`, `OVERSIGHT_FRONT_NAMES`, `VISITS_FRONT_NAMES`, `GUEST_FRONT_NAMES`, `HOURS_FRONT_NAMES` | `property` |
| `CLEANER_TOOL_NAMES`, and `choose_supplies` | `cleaning` |
| `SUPPLY_FRONT_NAMES` (but `choose_supplies` as above), `PACKAGE_FRONT_NAMES` | `supplies` |
| `FIXER_FRONT_NAMES` | `fixer` |
| `get_job_photos` | `cleaning`, `fixer` |
| `preview_schedule` | `supplies`, `fixer` |

`mayCall` also refuses `choose_supplies` for any caller with a `job`. `jobInstructions(job)` is: `This connection runs ${name} for the host's properties, and nothing else. Call get_state first. When the account has more than one property, name the property in every property tool call with its id from get_state. For anything outside ${name}, send the host to the Property Core bot's chat.`

Decisions:
- `handleTenantMcp` builds `Caller` with `job: jobOfPath(path)` and `jobs: callerJobs(...)`. A core address on an account where `toolsFor(tenant) !== "properties"` answers 403 with `BOTS_NEED_MAIN`.
- `propertyToolList` skips a flow's whole section when the caller lacks that job, so no desk is asked for a list it will not show, then filters the finished list through `mayCall` once. A caller with no jobs gets `[]`.
- `propertyToolCall` checks first, before `get_state`: no jobs answers `NO_JOBS`; `!mayCall` answers `elsewhereLine(owner, ownBot)` where `owner` is the first of `jobsOf(name)` and `ownBot` is whether `holder(h, tenant, owner)` has a `job`, plus `leftBehindLine` when it applies. Both are `isError: true`.
- `initialize` for a caller with a `job`: `jobInstructions(job)`, then `cleanerInstructions(assistant)` only for `cleaning`. For a `/mcp` caller on a team: today's text, minus `cleanerInstructions` when it lacks `cleaning`, plus `teamLine`. A `/mcp` caller that has all four jobs gets today's text unchanged.
- At `/mcp/cleaner`, Cleaner Core's setup must not wait on `choose_supplies`. Read where the desk's setup asks that question (`src/hosted/supplies.ts:80-100` and the `suppliesChoice` it saves) and, for a caller with `job: "cleaning"`, answer it from the property's flow before the call reaches the desk: Supply Core on is a yes, off is "not now".

- [ ] **Step 1: Write the failing tests.** In `test/botJobs.test.ts`:

```ts
it("every listed tool belongs to at least one job", () => { /* each name in the name sets above has jobsOf(name).length > 0 */ });
it("the tools that move money, doors or flows have one owner", () => {
  expect(jobsOf("mark_guests_left")).toEqual(["cleaning"]);
  expect(jobsOf("guests_left")).toEqual(["fixer"]);
  expect(jobsOf("approve_cart")).toEqual(["supplies"]);
  for (const name of ["set_flows", "add_property"]) expect(jobsOf(name)).toEqual(["property"]);
  expect(mayCall("choose_supplies", { job: "cleaning", jobs: ["cleaning"] })).toBe(false);
});
```

In `test/botJobsHosted.test.ts` (all three flows on by `registry.setFlow`, every feature switched on with `credentialsFor`):

```ts
it("an account with one bot lists what it lists with the switch off", async () => {
  /* same account, bots off then on, no core connection: toolNames(P, main) are equal, and the initialize instructions are equal */
});
it("each core's bot lists exactly its own tools", async () => {
  const names = await m.toolNames(F, fixer);
  for (const name of names) expect(jobsOf(name), name).toContain("fixer");
  expect(names).toContain("check_fixes");
  expect(names).not.toContain("set_flows");
  /* the same for C with "cleaning" (and never choose_supplies) and S with "supplies" */
});
it("a core's bot is refused another job's tool before any desk", async () => {
  const reply = await m.toolAt(F, fixer, "mark_guests_left", { property: property.id });
  expect(reply.isError).toBe(true);
  expect(reply.text).toBe(elsewhereLine("cleaning", false));
  expect((await m.toolAt(F, fixer, "set_flows", { property: property.id, fixer: false })).text).toBe(elsewhereLine("property", false));
  expect(m.registry.get(tenant.id)!.properties[0].flows.fixer.on).toBe(true);
});
it("an unknown tool name still gets today's line", async () => {
  expect((await m.toolAt(F, fixer, "no_such_tool")).text).toContain("There's no tool named no_such_tool here.");
});
it("Cleaner Core's setup at /mcp/cleaner takes the Supply Core answer from the property's flows", async () => {
  /* supplies on at the property: the Cleaner bot's get_state never names choose_supplies as the next step, and setup moves past that question.
     A second property with supplies off: the same, with the choice saved as not now */
});
it("a core connection made before the switch went off lists nothing and is refused", async () => {
  /* join F, then switch bots off through the registry: toolNames(F) is [], get_state answers NO_JOBS */
});
it("initialize speaks for the job", async () => {
  const text = String((await m.rpcAt(F, fixer, "initialize", { protocolVersion: "2025-06-18" })).json.result?.instructions);
  expect(text.startsWith(jobInstructions("fixer"))).toBe(true);
  expect(text).not.toContain("Cleaner Core for turnover cleanings");
});
it("one account's bot never reaches another account", async () => {
  /* a second account with its own property: account one's fixer token calling get_state with the other's property id is refused, and lists none of its properties */
});
```

"A left-behind routine's check is refused before the desk" is written here and marked `it.todo`, because it needs a held job. Task 5 fills it in.

- [ ] **Step 2: Run** `npx vitest run test/botJobs.test.ts test/botJobsHosted.test.ts`. Expected: FAIL, the Fixer bot lists every tool.
- [ ] **Step 3: Implement** `jobTools.ts`, then the four edits in `frontMcp.ts`.
- [ ] **Step 4: Run** both files and `npx vitest run test/propertyClientMatrix.test.ts test/sharedServiceRouting.test.ts`. Expected: PASS, the last two untouched.
- [ ] **Step 5: Commit** `feat(bots): each bot lists and calls only its job's tools`. This ends pull request 1.

---

### Task 5: Wake the holder, and hand over when the routine is saved

**Files:**
- Modify: `src/cleaner-core/hosted/tenantEnv.ts:41-82` (`buildTenantEnv`)
- Modify: `src/cleaner-core/hosted/router.ts:121-143` (`accountContext.env`), `:144-156` (`saveSecrets`), `:440-447` (Fixer routine upload), `:548-566` (`shareRoutine`)
- Modify: `src/hosted/fixer.ts:84-91` (`routine`, `assistant`)
- Modify: `src/mcp/toolListChanged.ts` only if `noteInitialized` cannot be called for another session's key as it is
- Test: `test/botJobsHosted.test.ts`

**Interfaces:**
- Consumes: `holder` (Task 3).
- Produces:

```ts
// buildTenantEnv's input: `primary` is renamed `alerts`, the connection woken for this desk's news.
// accountContext passes holder(h, tenant, "cleaning"). The three values it sets keep their names.
export function buildTenantEnv(input: { base; tenant; secrets; alerts: TenantConnection | undefined; origin; serviceLines; property?; propertyCount? }): NodeJS.ProcessEnv;
/** Tells every other open session of the account that its tool list changed. Called when a core connection saves its routine, is dropped, or the bots switch changes. */
export function noteTeamChanged(h: HostedCleaner, tenant: Tenant, exceptGrantId?: string): void;   // src/hosted/jobDeps.ts
```

Decisions:
- Fixer Core's `routine()` reads `h.secrets.connection(id, holder(h, tenant, "fixer").grantId)` in place of the Cleaner Core environment values. `assistant()` stays the primary's.
- `liveDesk.ts` is not changed. `routineReady()` compares `routineConnections` with `CLEANER_CORE_PRIMARY_CONNECTION`, which is now the `cleaning` holder's id. For an account with only `/mcp` connections that is the primary, as today.
- `shareRoutine` shares the `cleaning` holder's connection where it shares the primary's today.
- A routine saved by a connection with a `job` never calls `promoteFixerRoutine` or `promoteRoutineOwner`.
- `saveSecrets` calls `noteTeamChanged` after it stores a routine for a connection that has a `job`. `dropConnection` and `/admin`'s switch change call it too.

- [ ] **Step 1: Write the failing tests.** Add to the fixture `saveRoutine(m, path, token, tool, hook)`: call `tool` (`save_repair_alerts` here), then POST `hook` as JSON to the `uploadUrl` it returns, as `test/hostAlertsHosted.test.ts:76-84` does. Add `activeFixer(m, path, token, property)` copied from the same file with the path as a parameter. `MAIN_HOOK`, `FIX_HOOK` and `SUP_HOOK` are `https://example.com/…` addresses with made-up keys. `wakesTo(m, url, eventType)` counts `m.wakes` sent to `url` whose body's `eventType` matches. `openHostJob(m, path, token, property)` calls `open_job` with `source: "host"`, trade `plumbing` and a made-up line, and expects no error. `pushFixerNews(m, property, text)` (Task 8) drives one `tell()` from the pro's side, as `test/fixerEndToEnd.test.ts` does with a 555 number. `later(minutes)` moves `clock.now` on.

```ts
it("a core bot with no routine holds nothing", async () => {
  // main has MAIN_HOOK saved and Fixer Core active; the Fixer bot is connected, nothing saved
  expect(await m.toolNames(P, main)).toContain("check_fixes");
  expect(await m.toolNames(F, fixer)).toContain("check_fixes");
  await openHostJob(m, P, main, property);            // any open_job the host starts, which queues repairs.update
  await vi.waitFor(() => expect(wakesTo(m, MAIN_HOOK.url, "repairs.update")).toBeGreaterThan(0));
  expect(wakesTo(m, FIX_HOOK.url, "repairs.update")).toBe(0);
});
it("saving its routine hands the job over", async () => {
  await saveRoutine(m, F, fixer, "save_repair_alerts", FIX_HOOK);
  expect(await m.toolNames(P, main)).not.toContain("check_fixes");
  const before = wakesTo(m, MAIN_HOOK.url, "repairs.update");
  await openHostJob(m, F, fixer, property);
  await vi.waitFor(() => expect(wakesTo(m, FIX_HOOK.url, "repairs.update")).toBeGreaterThan(0));
  expect(wakesTo(m, MAIN_HOOK.url, "repairs.update")).toBe(before);
  expect(m.registry.get(tenant.id)!.primaryGrantId).toBe(mainGrantId);
});
it("a left-behind routine's check is refused before the desk", async () => {
  const reply = await m.toolAt(P, main, "check_fixes", { property: property.id });
  expect(reply.text).toBe(`${elsewhereLine("fixer", true)} ${leftBehindLine("fixer")}`);
});
it("the job comes back when the bot is disconnected, and when the switch goes off", async () => {
  /* dropConnection through /admin's Disconnect: toolNames(P, main) contains check_fixes again and the next wake goes to MAIN_HOOK.
     Second account state: switch bots off instead; same two checks, and FIX_HOOK gets nothing more. */
});
it("a live Cleaner Core desk stays ready through the hand-over", async () => {
  /* a live cleaning property as sharedAccount in test/sharedHarness.ts builds it; join C; get_state at P shows the routine connected before and
     after the Cleaner bot saves its own with save_alert_routine; after, cleaning.update goes to the Cleaner bot's hook only */
});
```

- [ ] **Step 2: Run** `npx vitest run test/botJobsHosted.test.ts`. Expected: FAIL, the wake-up still goes to `MAIN_HOOK` after the hand-over.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file and `npx vitest run test/hostAlertsHosted.test.ts test/fixerEndToEnd.test.ts test/cleanerHostedRouter.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bots): wake each job's holder, and hand over on a saved routine`.

---

### Task 6: Each core's notes go to its own bot

**Files:**
- Modify: `src/fixer-core/desk.ts` (`FixerDeps`; `tell()` near `:2380`), `src/hosted/fixer.ts:63,78` (`cleaningOn`, `notifyHost`), `src/hosted/voice.ts`
- Test: `test/botJobsHosted.test.ts`

**Interfaces:**
- Consumes: `holder` (Task 3).
- Produces: `FixerDeps.sharesNotes(): boolean`, true when Cleaner Core runs at the property **and** one connection holds both `cleaning` and `fixer`. `tell()` and the voice-note path use it wherever they use `cleaningOn()` today to choose between Cleaner Core's `noteForHost` and Fixer Core's own news. `cleaningOn()` keeps its other uses (visit windows). `tellLockNote` is not touched.

- [ ] **Step 1: Write the failing tests.** Both need one property with Cleaner Core live and Fixer Core active.

```ts
it("with one holder, a Fixer Core note shows in check_now, as today", async () => { /* no core bots: the note's id is in check_now's notes and not in check_fixes' news */ });
it("with different holders, a Fixer Core note wakes the Fixer bot and never shows in check_now", async () => {
  /* Fixer bot holds fixer: the same note is in check_fixes at F, check_now at P has no note with that id, and FIX_HOOK got repairs.update */
});
```

Use the pro's missed-visit note or any `tell()` call a test in `test/fixerEndToEnd.test.ts` already drives. Add the voice-note pair the same way from `test/voiceCall.test.ts`.

- [ ] **Step 2: Run.** Expected: FAIL on the second test of each pair.
- [ ] **Step 3: Implement** `sharesNotes`.
- [ ] **Step 4: Run** the file and `npx vitest run test/fixer`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bots): each core's notes go to the bot that holds it`.

---

### Task 7: Host alerts for the Property Core and Supply Core bots

**Files:**
- Modify: `src/alerts/operatorEvents.ts:20,101-117`
- Modify: `src/host-alerts/routes.ts`, `src/host-alerts/ledger.ts:17-30,59-110`
- Modify: `src/hosted/hostAlerts.ts:66-90,110-155`
- Create: `src/hosted/jobWake.ts`, `src/hosted/jobRoutineLink.ts`, `src/hosted/checkAlerts.ts`
- Modify: `src/hosted/jobTools.ts`, `src/hosted/frontMcp.ts` (list and call), `src/cleaner-core/hosted/router.ts` (the upload route, beside `:426-447`)
- Test: `test/botJobsHosted.test.ts`, `test/hostAlerts*.test.ts`

**Interfaces:**
- Consumes: `holder`, `team`, `jobDeps` (Task 3); `noteTeamChanged` (Task 5).
- Produces:

```ts
// operatorEvents.ts: "supplies.update" and "property.update" join OPERATOR_EVENT_TYPES
export function suppliesUpdateEvent(now: Date): OperatorEvent;
export function propertyUpdateEvent(now: Date): OperatorEvent;

// routes.ts
export const ROUTINES = ["alerts", "property", "supplies"] as const;
/** Undefined team: today's answer. On a team: stay-night, camera-health and oversight go to "property"; packages goes to "supplies" when suppliesOwnBot, else "property". A valid alert-routes.json entry still wins. */
export function routineFor(accountRoot: string, kind: AlertKind, team?: { suppliesOwnBot: boolean }): RoutineId;

// ledger.ts
export interface KeptAlert { /* as today, plus */ shownAt?: string }
class HostAlertLedger {
  /** Kept, not withheld, not expired, with text, and not shown yet. Oldest first. */
  unshown(kinds: readonly AlertKind[]): (KeptAlert & { text: string })[];
  shown(id: string): void;
  /** As today, and never an alert that has shownAt. */
  pending(): (KeptAlert & { text: string })[];
}

// jobWake.ts
/** Sends one event to the routine of the job's holder, through GrokRoutineWebhookSink and the same stubbed fetch the desks use. False when the holder has no saved routine or the send fails. */
export function wakeHolder(h: HostedCleaner, tenant: Tenant, job: Job, event: OperatorEvent): Promise<boolean>;

// jobRoutineLink.ts, modelled on src/hosted/touringAlerts.ts
export const JOB_ROUTINE_UPLOAD_PREFIX = "/bots/alert-routine/";
export const JOB_ROUTINE_LINK_MINUTES = 30;
export function issueJobRoutineLink(h: HostedCleaner, tenant: Tenant, grantId: string): string;
export function handleJobRoutineUpload(h: HostedCleaner, r: HostedRequest, tenant: Tenant, rest: string): Promise<boolean | undefined>;

// checkAlerts.ts
export const CHECK_ALERTS = "check_alerts";
/** Listed for a caller that has "property" or "supplies", on an account whose bots switch is on. */
export function listedCheckAlerts(h: HostedCleaner, tenant: Tenant, caller: Caller): Record<string, unknown>[];
export function checkAlertsCall(h: HostedCleaner, tenant: Tenant, caller: Caller, args: unknown): Promise<FrontReply>;
```

`check_alerts` takes `{ property?: string, connect?: boolean }`, strict. With `connect: true` it answers `{ uploadUrl, expiresInMinutes: 30 }` and reads nothing. Otherwise it answers `{ alerts: [{ id, kind, property, text, keptAt }], notes: string[] }` for the kinds routed to a job the caller has, across the account's properties or the one named, oldest first, and marks each one shown. `notes` is empty until Task 8. `jobsOf("check_alerts")` is `["property", "supplies"]`.

Decisions:
- The two new sinks send **one** wake-up per job per pass, however many alerts that pass has: `sinks()` keeps one promise per job and every alert for that job awaits it. A sink answers `"property"` or `"supplies"` when the wake-up was sent, and `undefined` when not, so the alert stays pending and is tried again on the next pass until it is delivered or shown.
- `withCameraFallback` wraps only the `"alerts"` sink. A camera note routed to `property` waits for `check_alerts`.
- In `sourcesFor`, a kind routed to `property` or `supplies` runs when any flow is on at the property. A kind routed to `"alerts"` keeps the `hostNotePath` gate. The time-zone gate stays.
- The upload link saves `CLEANER_CORE_ROUTINE_URL` and `CLEANER_CORE_ROUTINE_KEY` for the calling connection with `secrets.setForConnection`, then calls `noteTeamChanged`. This is how a Supply Core bot takes hold of its job.
- The #277 guard is not touched: an alert is checked before it is kept, so a withheld one never reaches a sink or `check_alerts`.

- [ ] **Step 1: Write the failing tests.** Unit tests next to the existing ones for `routes.ts` and `ledger.ts`:

```ts
it("routes by team", () => {
  expect(routineFor(root, "packages")).toBe("alerts");
  expect(routineFor(root, "packages", { suppliesOwnBot: true })).toBe("supplies");
  expect(routineFor(root, "packages", { suppliesOwnBot: false })).toBe("property");
  for (const kind of ["stay-night", "camera-health", "oversight"] as const) expect(routineFor(root, kind, { suppliesOwnBot: true })).toBe("property");
});
it("shown is separate from delivered, and a shown alert is no longer pending", () => {
  ledger.keep({ id: "a1", kind: "packages", text: "A package for Scratch Lane arrived." });
  expect(ledger.unshown(["packages"]).map((a) => a.id)).toEqual(["a1"]);
  ledger.shown("a1");
  expect(ledger.unshown(["packages"])).toEqual([]);
  expect(ledger.pending()).toEqual([]);
  expect(readHostAlerts(root).alerts[0].deliveredAt).toBeUndefined();
});
```

Hosted, in `test/botJobsHosted.test.ts`, with packages written by `writeOrders` from `test/packageFixture.ts` as `test/hostAlertsHosted.test.ts` does:

```ts
it("a property with only Supply Core on gets its package alert through check_alerts", async () => {
  // flows: supplies only. The Supply bot connects at S and saves SUP_HOOK through check_alerts { connect: true }.
  await tickAllHostAlerts(m.hosted());
  await vi.waitFor(() => expect(wakesTo(m, SUP_HOOK.url, "supplies.update")).toBe(1));
  const first = await m.toolAt(S, supply, "check_alerts");
  expect((first.structured!.alerts as { kind: string }[]).map((a) => a.kind)).toEqual(["packages"]);
  expect(((await m.toolAt(S, supply, "check_alerts")).structured!.alerts as unknown[])).toHaveLength(0);
  for (const wake of m.wakes) expect(wake.body).not.toMatch(/package|Example Mart/i);
  /* packages.json is byte for byte what it was before check_alerts: the producer's own record is never marked */
});
it("a delivered alert is not sent again after a restart", async () => {
  /* after the wake-up above: resetHostAlertClock(), later(16), tick again. Still exactly one supplies.update */
});
it("an alert with no routine waits and is shown once", async () => {
  // a team (the Fixer bot holds fixer), and the Property Core chat has no routine saved
  await tickAllHostAlerts(m.hosted()); later(16); await tickAllHostAlerts(m.hosted());
  expect(m.wakes.filter((w) => JSON.parse(w.body).eventType === "property.update")).toHaveLength(0);
  expect(((await m.toolAt(P, main, "check_alerts")).structured!.alerts as unknown[])).toHaveLength(1);
  expect(((await m.toolAt(P, main, "check_alerts")).structured!.alerts as unknown[])).toHaveLength(0);
});
it("two alerts in one pass send one wake-up", async () => { /* two packages, the Property Core chat has a routine: exactly one property.update */ });
it("an account that isn't a team keeps today's path", async () => { /* bots on, no core bot: the alert is a host note in check_fixes as on master, check_alerts returns none */ });
it("check_alerts is not listed with the switch off", async () => { /* toolNames(P, main) has no check_alerts */ });
it("the upload link is single-use and saves to the caller only", async () => { /* a second POST is refused; secrets.connection(main) is unchanged */ });
```

- [ ] **Step 2: Run** `npx vitest run test/botJobsHosted.test.ts test/hostAlerts`. Expected: FAIL, `routineFor` takes two arguments and `check_alerts` is unknown.
- [ ] **Step 3: Implement,** events first, then routes and ledger, then `jobWake`, the link, `check_alerts`, and last the sinks.
- [ ] **Step 4: Run** the same command. Expected: PASS, with `test/hostAlertsHosted.test.ts` untouched.
- [ ] **Step 5: Commit** `feat(bots): host alerts for the Property Core and Supply Core bots`.

---

### Task 8: A quiet bot, and `remove_bot`

**Files:**
- Create: `src/jobs/wakeListeners.ts`, `src/hosted/botTools.ts`
- Modify: `src/cleaner-core/liveDesk.ts:1003`, `src/fixer-core/desk.ts:418` (one line each), `src/cleaner-core/hosted/router.ts` (`accountContext`, beside `registerSecretSaver`)
- Modify: `src/hosted/frontMcp.ts:105` (`seen`), list and call; `src/hosted/jobTools.ts`; `src/hosted/checkAlerts.ts` (`notes`)
- Test: `test/botJobsHosted.test.ts`

**Interfaces:**
- Consumes: `isQuiet`, `QUIET_MS` (Task 1); `registry.seen` (Task 2); `dropConnection`, `holder` (Task 3); `wakeHolder`, `propertyUpdateEvent` (Task 7).
- Produces:

```ts
// src/jobs/wakeListeners.ts: per-root callbacks, as registerSecretSaver keeps them. No imports from the desks.
export function onWake(root: string, listener: (job: CoreJob) => void): void;
export function woke(root: string, job: CoreJob): void;      // liveDesk calls woke(root, "cleaning"), the Fixer desk woke(root, "fixer"), where each queues its update event

// src/hosted/botTools.ts
export const REMOVE_BOT = "remove_bot";
export const QUIET_BOTS_FILE = "quiet-bots.json";            // in the account's folder: { [job]: { since: string; toldAt?: string } }
/** Called from the wake listener. When the job's holder is its own bot and quiet, and no entry exists for this `since`: write one and send one property.update. */
export function noteQuiet(h: HostedCleaner, tenantId: string, job: CoreJob): Promise<void>;
/** One line per entry not told yet whose bot is still quiet, and marks them told. Drops entries whose bot has called since or is gone. */
export function quietLines(h: HostedCleaner, tenant: Tenant): string[];
export function quietLine(job: CoreJob, since: Date, timeZone: string | undefined): string;
export function listedBotTools(h: HostedCleaner, tenant: Tenant, caller: Caller): Record<string, unknown>[];
export function removeBotCall(h: HostedCleaner, tenant: Tenant, args: unknown): Promise<FrontReply>;
```

`quietLine` with a time zone (the first property's, from its `hub.json`): `The Fixer Core bot hasn't checked in since 2:10 PM, and it has news waiting. Open it, or tell me if you removed it.` Without one, `since 2:10 PM` becomes `in over 2 hours`. It never carries anything from the other core.

`remove_bot` takes `{ bot: "cleaning" | "supplies" | "fixer", confirmation?: string }`, strict. It is `property` only and listed only when the `bots` switch is on. The first call answers what will happen (`This disconnects the Fixer Core bot and deletes its Alerts routine. Fixer Core comes back to this chat. Ask the host, then call remove_bot again with this confirmation.`) with a code from a `ConfirmationBook` kept in the account's folder (`bot-approvals.json`, 10 minutes), as `flowApprovals` does in `src/hosted/service.ts:48`. The second call, with the code, calls `dropConnection` for that job's connection and answers `The Fixer Core bot is disconnected. Fixer Core is back in this chat.` A bot that isn't connected answers `There's no Fixer Core bot on this account.`

`handleTenantMcp` calls `h.registry.seen(tenant.id, caller.grantId)` next to `touch`.

- [ ] **Step 1: Write the failing tests.**

```ts
it("a holder quiet for 2.5 hours: the next wake-up also tells the Property Core bot, once, with no content", async () => {
  // the Fixer bot holds fixer and last called at 15:00Z; main has MAIN_HOOK
  clock.now = new Date("2026-11-21T17:31:00.000Z");
  await pushFixerNews(m, property, "The pro found a leak under the sink.");     // through the pro's side, as fixerEndToEnd drives it
  await vi.waitFor(() => expect(wakesTo(m, MAIN_HOOK.url, "property.update")).toBe(1));
  const notes = (await m.toolAt(P, main, "check_alerts")).structured!.notes as string[];
  expect(notes).toEqual([quietLine("fixer", new Date("2026-11-21T15:00:00.000Z"), NY)]);
  expect(notes[0]).not.toMatch(/leak|sink/);
  expect(((await m.toolAt(P, main, "check_alerts")).structured!.notes as string[])).toEqual([]);
  await pushFixerNews(m, property, "A second note.");
  expect(wakesTo(m, MAIN_HOOK.url, "property.update")).toBe(1);
});
it("a bot that isn't quiet tells nobody", async () => { /* same at 17:00Z: no property.update */ });
it("remove_bot hands the job back after the host's yes", async () => {
  const ask = await m.toolAt(P, main, "remove_bot", { bot: "fixer" });
  expect(await m.toolNames(P, main)).not.toContain("check_fixes");
  const done = await m.toolAt(P, main, "remove_bot", { bot: "fixer", confirmation: String(ask.structured!.confirmation) });
  expect(done.isError).toBe(false);
  expect(await m.toolNames(P, main)).toContain("check_fixes");
  expect((await m.rpcAt(F, fixer, "tools/list")).status).toBe(401);
  /* the news written while the bot was gone is in check_fixes at P */
});
it("remove_bot is refused from a core's bot, and with a wrong confirmation", async () => { /* elsewhereLine("property", false) at F; a made-up code changes nothing */ });
it("lastSeenAt moves at most every 5 minutes", async () => { /* two calls 4 minutes apart keep one time on the connection */ });
```

- [ ] **Step 2: Run** `npx vitest run test/botJobsHosted.test.ts`. Expected: FAIL, `remove_bot` is unknown.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file. Expected: PASS. Then `npm test` for pull request 2.
- [ ] **Step 5: Commit** `feat(bots): tell the host about a quiet bot, and remove_bot`. This ends pull request 2.

---

### Task 9: Filing from the Cleaner Core bot

**Files:**
- Create: `src/hosted/filing.ts`
- Modify: `src/hosted/jobTools.ts` (`mayCall`), `src/hosted/frontMcp.ts` (list and call)
- Test: `test/botJobsHosted.test.ts`

**Interfaces:**
- Consumes: `wakeHolder`, `suppliesUpdateEvent` (Task 7); `repairsUpdateEvent`; `holder`.
- Produces:

```ts
export const FILING_TOOLS = { get_supply_state: "supplies", report_low: "supplies", open_job: "fixer" } as const;
/** True when this caller has "cleaning" and lacks the tool's owning job: the call is a filing. */
export function isFiling(tool: string, caller: Caller): boolean;
export const FILING_SOURCE = "From this chat, source must be cleaner.";
/** "Filed. The Supply Core bot orders these." / "Filed. The Fixer Core bot asks the host." The bot named is Property Core when the owning job has no bot of its own. */
export function filedLine(tool: "report_low" | "open_job", ownBot: boolean): string;
/** Runs the owning desk's tool, then cuts the reply down and wakes the holder. */
export function fileCall(h: HostedCleaner, r: HostedRequest, tenant: Tenant, property: Property, caller: Caller, name: string, args: Record<string, unknown>): Promise<FrontReply>;
```

Decisions:
- `mayCall` lets a filing through. `propertyToolList` adds the three tools for a filing caller when the owning flow is on at some property, using the owning desk's own definitions.
- `report_low` and `open_job` are refused with `FILING_SOURCE` before the desk when `args.source !== "cleaner"`.
- The reply to a filing is `{ text: filedLine(...), structured: { filed: true } }`, plus `jobId` for `open_job`. Nothing else from the desk's reply is passed on.
- `get_supply_state` as a filing answers only `{ items: [{ id, name }] }` for the property's list. This is the plan's call: the spec says read-only, and the rest of Supply Core's state carries its questions.
- After a filing the holder is woken exactly once. `report_low` has no wake-up of its own, so `fileCall` sends `supplies.update`. For `open_job`, check whether the Fixer desk already queues `repairs.update` for a cleaner's job and send one only if it does not. The test counts.
- A caller that has the owning job is not filing: its call runs as on `master`.

- [ ] **Step 1: Write the failing tests** (the Cleaner bot holds `cleaning`; the Supply and Fixer bots hold theirs, with `SUP_HOOK` and `FIX_HOOK`; a supply list with one item is saved through the Supply bot):

```ts
it("the Cleaner bot lists the three filing tools and nothing else of the other cores", async () => {
  const names = await m.toolNames(C, cleaner);
  for (const name of ["get_supply_state", "report_low", "open_job"]) expect(names).toContain(name);
  for (const name of ["approve_cart", "check_supplies", "approve_job", "check_fixes"]) expect(names).not.toContain(name);
});
it("report_low from the Cleaner bot is written once, wakes the Supply bot, and carries no question", async () => {
  const items = (await m.toolAt(C, cleaner, "get_supply_state", { property: property.id })).structured!;
  expect(Object.keys(items)).toEqual(["items"]);
  const itemId = (items.items as { id: string }[])[0].id;
  expect((await m.toolAt(C, cleaner, "report_low", { property: property.id, itemIds: [itemId], source: "host" })).text).toBe(FILING_SOURCE);
  const filed = await m.toolAt(C, cleaner, "report_low", { property: property.id, itemIds: [itemId], source: "cleaner" });
  expect(filed.text).toBe(filedLine("report_low", true));
  expect(filed.structured).toEqual({ filed: true });
  await vi.waitFor(() => expect(wakesTo(m, SUP_HOOK.url, "supplies.update")).toBe(1));
  /* the Supply bot's get_supply_state shows the low report once */
});
it("open_job from the Cleaner bot waits for the host in the Fixer bot's chat", async () => {
  const filed = await m.toolAt(C, cleaner, "open_job", { property: property.id, trade: "plumbing", what: "The kitchen tap drips.", urgency: "soon", source: "cleaner" });
  expect(filed.text).toBe(filedLine("open_job", true));
  expect(Object.keys(filed.structured!).sort()).toEqual(["filed", "jobId"]);
  await vi.waitFor(() => expect(wakesTo(m, FIX_HOOK.url, "repairs.update")).toBe(1));
  /* check_fixes at F carries the job's needsGo question; open_job with source "host" from C answers FILING_SOURCE and opens nothing */
});
it("with one bot, report_low and open_job answer as on master", async () => { /* no core bots: the reply is the desk's own, source "host" is accepted */ });
```

- [ ] **Step 2: Run.** Expected: FAIL, the Cleaner bot is refused `report_low`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file and `npx vitest run test/supply test/fixer`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bots): the Cleaner Core bot files low supplies and repairs`. This is pull request 3.

---

### Task 10: `get_state` by job, and the team view

**Files:**
- Modify: `src/hosted/propertyTools.ts` (`accountState`, `stateOf`), `src/hosted/frontMcp.ts:219` and `:383-428` (`propertyStates`)
- Test: `test/botJobsHosted.test.ts`

**Interfaces:**
- Consumes: `Caller.jobs`, `holder`, `team`, `isQuiet`, `jobDeps`.
- Produces:

```ts
export interface TeamEntry { job: CoreJob; holder: "own bot" | "this chat"; agent?: string; connectedAt?: string; lastSeenAt?: string; alerts: "connected" | "not connected"; quiet?: true; note?: string }
/** One entry per core job that has a flow on somewhere in the account. Only for a caller that has "property", on an account whose bots switch is on. */
export function teamView(h: HostedCleaner, tenant: Tenant, now: Date): TeamEntry[];
/** accountState gains the caller's jobs and, for the Property Core chat, the team. With all four jobs and no team it returns what it returns today. */
export function accountState(tenant: Tenant, args: unknown, states: PropertyStates, assistant: CleanerAssistant, view?: { jobs: readonly Job[]; team?: TeamEntry[] }): Promise<FrontReply>;
```

Decisions:
- A core's bot gets each property with only its own flow's state and next step. A property where its flow is off is listed with `flow: "off"` and no next step. The one-line `supplies`, `repairs` and `locks` summaries `propertyStates` adds today stay.
- `agent` is the connection's `assistant` value (`"grok"`) and exists only for `"own bot"`. `alerts` is whether that holder has a saved routine. `quiet: true` and `note` (`The Fixer Core bot hasn't checked in for over 2 hours.`) appear only for a quiet own bot.
- On a team, each property's line carries `next: { cleaning?, supplies?, fixer? }`, the name of each flow's next step read from that flow's desk, and nothing else from it: no question, code or token.
- `propertyStates` does not ask a desk whose job the caller lacks, except for the step name in the team view.

- [ ] **Step 1: Write the failing tests.**

```ts
it("a core's bot sees only its own flow", async () => {
  const state = (await m.toolAt(F, fixer, "get_state")).structured!;
  expect(JSON.stringify(state)).not.toMatch(/"cleaning":\s*\{|doorCode|checklist/);
  /* a second property with fixer off is listed with flow "off" and no next */
});
it("the Property Core bot sees the team", async () => {
  const team = (await m.toolAt(P, main, "get_state")).structured!.team as TeamEntry[];
  expect(team.find((t) => t.job === "fixer")).toMatchObject({ holder: "own bot", agent: "grok", alerts: "connected" });
  expect(team.find((t) => t.job === "cleaning")).toMatchObject({ holder: "this chat" });
});
it("the team view names each flow's next step and nothing more", async () => { /* next.fixer is a step name; the reply holds no question text from Fixer Core's own get_state */ });
it("a quiet bot is marked", async () => { /* 151 minutes after its last call: quiet true and the note */ });
it("with one bot and the switch off, get_state is what it is on master", async () => { /* structuredContent deep-equals the same call before this task: no team key */ });
```

- [ ] **Step 2: Run.** Expected: FAIL, the Fixer bot's `get_state` carries every flow.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file and `npx vitest run test/propertyClientMatrix.test.ts test/sharedServiceRouting.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bots): get_state by job, and the team view`.

---

### Task 11: Gate rows and the service doc

**Files:**
- Modify: `docs/cleaner-core-safety-gates.md`, `docs/supply-core-safety-gates.md`, `docs/fixer-core-safety-gates.md`, `docs/hosted-multitenancy.md`
- Test: `test/fixerTemplate.test.ts` reads the gate docs; keep it green

- [ ] **Step 1:** Add a "Separate bots (#250)" section to each of the three gate docs, one row per gate, each naming its test in `test/botJobsHosted.test.ts` by its `it` title. Cleaner Core: `mark_guests_left` is the Cleaner job's only; a filing takes source `cleaner` only; no code in any wake-up. Supply Core: `approve_cart` is the Supply job's only; a filing reply carries no question. Fixer Core: `guests_left` and `approve_job` are the Fixer job's only; a repair note never reaches another bot's chat. All three: the check is on the call, a second bot replaces the first, and the job returns on each of the four ways.
- [ ] **Step 2:** Rewrite the Chats section of `docs/hosted-multitenancy.md` around the rule, the four addresses, the `bots` switch and what `/admin` shows.
- [ ] **Step 3: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 4: Commit** `docs(bots): gate rows and the shared service's chats`. Tasks 10 and 11 are pull request 4.

---

## Not in this plan

- Templates, bot profiles, `template.json`, the routine docs (Property Core Check, Supply Core Alerts), the client matrix row and the host setup page: the next plan, after the scratch Grok check in the spec.
- `get_schedule`: its own plan.
- The hand test on Scratch, then one real account with Saad's okay.
