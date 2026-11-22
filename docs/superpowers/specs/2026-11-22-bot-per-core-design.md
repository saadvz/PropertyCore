# A bot for each core, managed by Property Core

Date: 2026-11-22. Status: **draft, waiting on the owner's okay.** Approach picked by zakitka on 22 Nov:
jobs on the server, separate chats.
Issues: saadvz/PropertyCore#250 (test: one Grok bot or several), a child of #236. Builds on the host-alert
clock (#277, `2026-11-21-host-alerts-routine-design.md`) and the per-account feature switches (#278,
`2026-11-21-per-account-feature-switches-design.md`). Read against `master` at `92c824b2` (#279).
Meant for `docs/superpowers/specs/2026-11-22-bot-per-core-design.md`.

## Why

Property Core has grown past what one Grok bot holds well. With every flow and every switch on, one bot
carries about 135 tools (3 for the account, about 31 for Cleaner Core, 17 for Supply Core, 38 for Fixer Core,
and 45 across locks, guest codes, cameras, the stay check, expected visits, visit records, packages, guest
messages and the hours log), three guides and four routines. More is on the way: connected locks, guest
codes and Ring cameras all landed behind switches this week.

The owner wants each core to have its own bot, created from what the host picks in setup, with the Property
Core bot managing them. The worry is overlap: the cores share the calendar, the door and the people.

A split is safe because the server already holds every record and decides every gate in code. The bots are
consoles. So the split is made on the server too: each bot's connection carries a job, and the server shows
that bot only its job's tools, sends it only its job's instructions, and wakes only that bot for its job's
news.

## Decisions so far

| Question | Answer | Who, when |
| --- | --- | --- |
| How to split | A job on each connection, enforced by the server. Not by instructions alone, and not a separate service per core | zakitka, 22 Nov |
| Group chat or separate chats | Separate chats. The Property Core bot is the front door | zakitka, 22 Nov |

## Goals

- A core's bot sees only its own tools: about 35 for Cleaner Core, 25 for Supply Core, 40 for Fixer Core and
  42 for Property Core, in place of 135.
- Each bot is woken only for its own news.
- Every overlap between cores is settled by the server from the shared records, never by bots talking.
- The Property Core bot is the one place the host can ask "what needs me?" across every core.
- An account with one bot behaves exactly as it does today.

## Not goals

- A group chat of bots. It can be added later as a place to talk. See "Why separate chats".
- A fifth bot for watching the house (cameras, the stay check, expected visits). The routing allows it later.
- Making "the guests have left" one fact for Cleaner Core and Fixer Core. It changes a Cleaner Core safety
  gate and needs its own design. `mark_guests_left` and `guests_left` both stay.
- Using the house schedule inside any booking check, and planning a turnover around a repair block. This
  design adds the read only.
- Several bots on Muse, Claude or ChatGPT. They keep one connection.
- Any change to what a gate decides.

## What would make this a failure

- A door code, or any digits of one, shown in any chat or carried in any message between bots.
- A bot acting on another core's work: the Fixer bot releasing the cleaner's code, the Cleaner bot placing an
  order.
- An alert lost because its bot wasn't set up yet, or sent twice because two bots hold the same job.
- A host with one bot today seeing any change they didn't ask for.
- Two copies of a shared fact: a calendar, a person or a door code saved once per bot.

## How it works today

- **One address, one list.** Every chat connects to `/mcp` (`/mcp/cleaner-core` is an alias). `propertyToolList`
  in `src/hosted/frontMcp.ts` builds one list from the account's flows and switches. Every connection on the
  account gets the same list.
- **Connections.** `TenantConnection` in `src/cleaner-core/hosted/registry.ts` is `{ grantId, assistant,
  connectedAt }`. The sign-in grant is bound to the exact address it was issued for
  (`src/mcp/oauth/provider.ts`), and the service declares its addresses as `resources` in `src/web/server.ts`.
- **The primary chat.** Texts, alerts and the routine follow the account's primary connection, the first one
  connected. `buildTenantEnv` puts the primary's routine address and key in each desk's environment.
  `TenantSecrets` already keeps a routine per connection.
- **Wake-ups carry no content.** Cleaner Core queues `cleaning.update` and the bot reads the note with
  `check_now`. Fixer Core queues `repairs.update` and the bot reads it with `check_fixes`. Supply Core has no
  wake-up.
- **Host alerts.** `routineFor(accountRoot, kind)` in `src/host-alerts/routes.ts` answers `"alerts"` for every
  kind. Its comment says a routine id is added "when #250 decides to split kinds across bots".
- **Crossing between cores is done by the one bot.** When the cleaner answers "Anything running low?", the bot
  matches the words to the list and calls `report_low`. When the cleaner says something is broken, the bot
  calls `open_job` with source `cleaner`
  (`cleaner-template/routines/cleaner-core-alerts.md`, step 8).
- **Bot profiles per core already exist.** `cleaner-template/` and `supply-template/` each hold a
  `bot-profile.md`, a setup prompt and a `template.json`, from before the flows moved into one bot. Fixer Core
  has only `fixer-template/routines/`.

Where the cores already meet, and what a split does to each:

| Where they meet | Today | With several bots |
| --- | --- | --- |
| Property, calendars, people | The hub (`src/hub/`), one copy per property | Unchanged |
| The door | The hub's grant book, one per property, for cleaning, repair, standing, guest and bring-in codes | Unchanged |
| When a pro can come | Fixer Core builds open windows from the stays and the cleaning (`src/fixer-core/window.ts`) | Unchanged |
| The text line | One number per account, routed by sender (`src/hosted/lineRouter.ts`) | Unchanged |
| Hours log | Rebuilt from every flow's records | Unchanged |
| The cleaner's "low" or "broken" answer | The one bot calls the other core's tool | Needs filing (below) |
| Alerts to the host | One routine, for the primary chat | Needs a routine per job (below) |

## Approaches

| | A. Instructions only | B. A job on each connection (picked) | C. A service per core |
| --- | --- | --- | --- |
| What | Every bot connects as today and sees all the tools. Only its instructions name its job | Each connection carries a job. The server lists, instructs and wakes by job | Each core is its own connector with its own records |
| Tools per bot | About 135 | 25 to 42 | Fewest |
| Who enforces it | The bot | The server | The server |
| Overlaps | Two bots can act on the same thing | Decided on the server from the shared hub | The hub is cut apart, or copied |
| Work | Small | Medium. Reuses the address-bound grants, the per-connection routines and #277's routing point | Large. Undoes the move to one `/mcp` |

B was picked. A doesn't lower what each bot holds. C cuts up the hub, which is what makes overlaps safe.

### Why separate chats

From xAI's Grok Bot docs (links at the end): a group holds two to six bots, a plain message lets the bots
decide who answers, handoffs between bots are text only, and approval requests, secret and login requests
and drafts don't show in a group. Every bot reply counts toward usage.

Property Core depends on the secure card (door code, calendar link, routine key) and on approvals, and neither
shows in a group. "The guests have left" releases a door code, so which bot hears it can't be a guess. A
routine belongs to one bot. So each bot works in its own chat, and the Property Core bot answers across them.

## The rule

**A core's job is held by its own bot once that bot is connected and has saved its Alerts routine. Until
then, and whenever that bot goes away, the Property Core connection holds it.**

`src/jobs/jobs.ts` (new) holds the whole rule, the way `src/features/features.ts` holds `featureOn`:

```ts
export const JOBS = ["property", "cleaning", "supplies", "fixer"] as const;
export type Job = (typeof JOBS)[number];
export type CoreJob = Exclude<Job, "property">;
/** The live connection that holds this job: the core's own bot once its routine is saved, else the primary /mcp connection. */
export function holderOf(tenant: Tenant, job: Job, deps): TenantConnection | undefined;
/** The jobs whose tools this connection may list and call now. */
export function jobsFor(tenant: Tenant, connection: TenantConnection, deps): Job[];
/** Which jobs may call this tool. */
export function jobsOf(tool: string): readonly Job[];
```

Two words are used the same way through this document:

- A bot **has** a job when it may list and call that job's tools.
- A bot **holds** a job when it is also the one woken for that job's news. Each job has exactly one holder.

| Connection | Has | Holds |
| --- | --- | --- |
| At a core's address, routine not saved yet | That core's job, so it can run setup | Nothing |
| At a core's address, routine saved | That core's job | That core's job |
| At `/mcp` | `property`, plus every core job that no core bot holds | The same, when it is the primary |

- While a core's bot is connected and hasn't saved its routine, both it and the Property Core connection have
  that core's tools. That is the same as two chats on one account today. Wake-ups keep going where they go
  today, so a live turnover is never left unread.
- The moment the core's bot saves its routine, it holds the job. The Property Core connection stops having
  that core's tools from its next request.
- An account with only `/mcp` connections has and holds every job on them. That is today's behaviour, and no
  code path for it changes.
- **A team** means an account where at least one core job is held by its own bot.

A job comes back to the Property Core connection when any of these happens, and nothing has to be saved for
it, because the holder is computed on each request:

1. The core bot's grant ends.
2. Saad disconnects it on `/admin`.
3. The `bots` switch is turned off for the account.
4. The host tells the Property Core bot the core's bot is gone, and it calls `remove_bot` (new, `property`
   only): a two-call yes that names the bot, then disconnects that connection and deletes its routine. This
   is needed because deleting a bot in Grok doesn't end its grant, so the server can't see it.

One rule covers the single bot, a partial team (a bot for Fixer Core only), a bot that goes away, and every
agent that can't run several bots.

## Addresses and sign-in

Three more `resources` in `src/web/server.ts`, on the multi-tenant service only:

| Address | Job | Label on the approval page |
| --- | --- | --- |
| `/mcp` (and the `/mcp/cleaner-core` alias) | `property`, plus any core job without its own bot | Property Core |
| `/mcp/cleaner` | `cleaning` | Cleaner Core |
| `/mcp/supply` | `supplies` | Supply Core |
| `/mcp/fixer` | `fixer` | Fixer Core |

- A grant is already bound to its exact address, so a token for `/mcp/fixer` is refused at `/mcp`. The job
  can't be changed by anything a chat sends.
- `TenantConnection` gains `job?: CoreJob`. `invites.connected` passes it from the grant's address. A
  connection with no `job` is a `/mcp` connection.
- The primary is only ever a connection with no `job`. `registry.connect` sets `primaryGrantId` only for one,
  and `registry.primary` and `disconnect` pick only among them. Today they would pick any connection.
- `handleHostedCleaner` sends the three new paths to `handleTenantMcp`, which already receives the path.
- The approval page names the job: "Allow this chat to run Fixer Core for your account." Sign-in is the same
  page as today (sign in, or the invite code).
- **One bot per core job.** A new connection for a job that already has a live one replaces it: the older
  grant is disconnected, as `/admin`'s Disconnect does, and its saved routine is deleted. `/mcp` keeps today's
  rule of several chats and one primary.
- **Grok Bot only.** A core's address is refused on the approval page for any agent but Grok Bot, and for an
  account whose primary `/mcp` connection isn't Grok Bot. So every desk keeps reading the primary's agent for
  its wording and its wake-up kind, and nothing about polled tasks changes. Muse joins when it is known to run
  several agents.
- **Behind a switch.** A new account feature, `bots` ("Separate bots"), on `/admin`, off by default, added
  to `FEATURES`. With it off, the three addresses refuse on the approval page with one line, and `jobsFor`
  and `holderOf` ignore any core connection. Turning it off for an account hands every job back to `/mcp` at once.
  `FEATURES_OFF` can name it.

## What each job holds

`jobsOf(tool)` is built from the name sets that already exist. A tool outside the caller's jobs is left off
`tools/list` **and refused in `propertyToolCall` before any desk is reached.**

| Job | Tools |
| --- | --- |
| `property` | `add_property`, `set_flows`, `remove_bot` (new); the lock tools and guest-code tools (`LOCK_FRONT_NAMES`); the camera tools; the stay-check tools; the expected-visit tools; the visit-record tools; the guest-message tools; the hours tools; `check_alerts` (new) |
| `cleaning` | Every Cleaner Core tool (`CLEANER_TOOL_NAMES`), and three for filing: `get_supply_state`, `report_low`, `open_job`. `choose_supplies` only on a `/mcp` connection (below) |
| `supplies` | Every Supply Core tool (`SUPPLY_FRONT_NAMES`), the package tools (`PACKAGE_FRONT_NAMES`), `check_alerts` (new) |
| `fixer` | Every Fixer Core tool (`FIXER_FRONT_NAMES`) |
| Every job | `get_state`, `get_schedule` (new). `get_job_photos` is cleaning's and fixer's. `preview_schedule` is supplies' and fixer's |

Each tool is still listed only when its flow or its account switch says so, exactly as today. The job is a
second filter on top of `featureOn` and the flows. It never adds a tool.

The refusal for a tool another bot holds is one fixed line that names the bot, so the host is sent to the
right chat: "Fixer Core has its own bot on this account. Ask the host to open the Fixer Core bot for that."
When the caller still has a routine that calls such a tool (an account that just moved to several bots), the
line adds: "Delete your Fixer Core routines here. That bot runs its own."

`choose_supplies` turns Supply Core on from inside Cleaner Core's setup (`src/hosted/supplies.ts`). A core's
bot can't turn a flow on or off, so it is never listed at `/mcp/cleaner`. There, Cleaner Core's setup takes
the answer from the property's own flows: Supply Core on is a yes, and off is "not now". The host picks flows
with the Property Core bot before a core's bot exists.

Each core keeps its own setup tools, including the ones that write the hub (`save_property`, `save_sources`,
`save_people`, `save_door_code`, `save_fixer_property`, `save_supply_sources`). They already save to the one
hub, so a bot that asks second finds the answer there. Nothing moves.

### `get_state` by job

- **A core's bot** gets what `stateOf` gives today when only that flow is on: the properties that run its
  flow, and that flow's own state and next step for the one it names. A property where its flow is off is
  listed with `flow: "off"` and no next step. It never gets another core's state, only the one-line
  `supplies`, `repairs` and `locks` summaries that `propertyStates` already adds.
- **The Property Core bot** gets the overview as today, plus `team`: one entry per core job with `holder`
  (`"own bot"` or `"this chat"`), the agent's name, `connectedAt`, `lastSeenAt`, and `alerts` (`"connected"`
  or `"not connected"`). In a team, each property's line carries one `next` per flow, read from that flow's
  desk, so the bot can say which chat is waiting on the host. It never carries another core's questions,
  codes or tokens: only the step's name.
- `TenantConnection` gains `lastSeenAt`, written at most every 5 minutes, like `registry.touch`.
- A core's bot that hasn't called in 2.5 hours shows in `team` as `quiet: true`, with one line for the host.
  That is the same threshold as the stopped-task warning in `src/cleaner-core/assistant.ts`.

### Instructions on connect

`initialize` sends one short line for the job, then only that job's instructions: `cleanerInstructions` for
`cleaning`, the guest-message and booking-platform lines where they apply today, and for `property` a line
that says which cores have their own bot. A `/mcp` connection that holds every job gets today's text.

## Alerts for each bot

Each bot saves its own Alerts routine during its setup. The storage is there: `TenantSecrets.connection`.
Saving it is also what makes a core's bot the holder (the rule above).

| What changes | How |
| --- | --- |
| Which routine a desk wakes | `buildTenantEnv` takes the job a desk is for and uses `holderOf(tenant, job)`'s routine and connection id in place of the primary's. Cleaner Core's desks pass `cleaning`. Fixer Core's `routine()` in `src/hosted/fixer.ts` passes `fixer`. Since a core's bot holds its job only once its routine is saved, a desk that is live never loses its routine: `routineReady()` in `liveDesk.ts` reads the holder where it reads `CLEANER_CORE_PRIMARY_CONNECTION` today |
| The primary chat | Unchanged, and only ever a `/mcp` connection. `promoteRoutineOwner` and `promoteFixerRoutine` pick only among `/mcp` connections |
| Saving a routine | `save_alert_routine` and `save_repair_alerts` keep their one-time upload link, which saves to the calling connection as it does now. Supply Core and Property Core get the same link from `check_alerts` with `connect: true` (below), so no tool is added for it |
| New events | `supplies.update` and `property.update` join `OPERATOR_EVENT_TYPES`, with `suppliesUpdateEvent` and `propertyUpdateEvent` next to `cleaningUpdateEvent`. Same payload: ids and a time, no content |
| A core's own notes | Each core's notes for the host go to that core's holder. Today, on a property that also runs Cleaner Core, Fixer Core hands its notes to Cleaner Core's `noteForHost` and skips its own wake-up (`tell()` in `src/fixer-core/desk.ts`, `notifyHost` in `src/hosted/fixer.ts`), and voice notes take the same path (`src/hosted/voice.ts`). That shortcut is kept only while one connection holds both `cleaning` and `fixer`. When they have different holders, Fixer Core's notes and the voice notes go to Fixer Core's own news and queue `repairs.update` |
| Host-alert routing | `ROUTINES` in `src/host-alerts/routes.ts` becomes `["alerts", "property", "supplies"]`. On a team, the defaults are: `stay-night`, `camera-health` and `oversight` go to `property`; `packages` goes to `supplies` when Supply Core has its own holder, else to `property`. `alert-routes.json` can still override per account. An account that isn't a team gets `"alerts"`, today's sink, for everything |
| The two new sinks | `property` and `supplies` keep the alert in the property's `host-alerts.json` ledger (it is kept there already) and queue `property.update` or `supplies.update` for that job's holder. The bot reads it with `check_alerts` |
| Which properties are checked | Today the clock skips a property with neither Cleaner Core nor Fixer Core on (`src/hosted/hostAlerts.ts`), because it has no host-note path. For a kind routed to one of the new sinks, any flow on is enough. This closes the Supply-Core-only gap #277 listed as a follow-up |

`check_alerts` (new, for `property` and `supplies`): returns the ledger's alerts for the caller's kinds that
this job hasn't been shown, oldest first, across the account's properties or the one named, and marks each
`shownAt`. A listing tool never marks an alert told, and this one isn't a listing tool: it is the hand-over.
The ledger's `deliveredAt` (the wake-up was queued) and `shownAt` (a bot read it) stay separate. Called with
`connect: true` it gives the one-time upload link for this bot's routine and reads nothing.

Two scheduled routines make sure an alert is read even when a wake-up fails:

- **Property Core Check** (new, hourly): `get_state`, then `check_alerts`. It also tells the host about any
  bot the team view marks quiet.
- **Supply Core Check** (daily, exists): gains a `check_alerts` step.

Where a wake-up goes:

1. To the job's holder's routine. By the rule, a core's bot that holds a job has one.
2. When the holder is the Property Core connection and it has no routine, the alert waits in the desk's notes
   or the ledger for the next scheduled check, as today.
3. **A holder gone quiet.** When a core's bot holds a job and hasn't called in 2.5 hours, each wake-up for
   that job also queues one `property.update`. `check_alerts` then gives the Property Core bot one line with
   no content: "The Fixer Core bot hasn't checked in since 2:10 PM, and it has news waiting. Open it, or tell
   me if you removed it." If the host removed it, `remove_bot` hands the job back, and the news is still in
   that core's desk to be read.

Lock notes (`tellLockNote`) stay as they are: Cleaner Core's notes when cleaning runs at the property, else
Fixer Core's. Each then follows its own holder.

## Filing between cores

A bot may file into another core. Only the owning bot works it.

| From | Into | Tool | Limits for the filing bot |
| --- | --- | --- | --- |
| Cleaner Core bot | Supply Core | `get_supply_state`, to read the list's item ids | Read-only. The `suppliesLine` summary is not enough to match items |
| Cleaner Core bot | Supply Core | `report_low` | `source` must be `cleaner`. Anything else is refused |
| Cleaner Core bot | Fixer Core | `open_job` | `source` must be `cleaner`. Anything else is refused |

- A filing is an ordinary write to the owning core's own record (`lowReports`, a job). The record is the
  filing, so there is no second ledger, and nothing new can be lost or doubled.
- After a filing by a connection that doesn't hold the owning job, the server queues `supplies.update` or
  `repairs.update` for the holder.
- The reply to the filing bot changes: it never carries the owning core's question. `report_low` answers
  "Filed. The Supply Core bot orders these." `open_job` answers "Filed. The Fixer Core bot asks the host."
  The job's `needsGo` question then appears in the Fixer bot's next `check_fixes`, as it does for any open job.
- The rule in the Cleaner routine stays: the cleaner's words never reach Supply Core, only item ids.
- The Cleaner Core routine docs lose the Supply Core Check steps when Supply Core has its own bot, and
  `supplyTools` leaves the Cleaner routines in `template.json`.
- A Supply Core bot's package bring-in (`plan_bring_in`) and the Fixer bot's visits need no filing. They
  already write records the cleaner's texts and the door book read.

## One schedule for the house (read only)

`get_schedule` (new, every job): for one property and up to 31 days, everyone due at the house next to the
guest stays, oldest first. Each line has a kind, a start, an end when known, a short label, and which core
owns it.

| Kind | Read from |
| --- | --- |
| Guest stay | The hub's calendars and `booking-emails.jsonl`, as `stayForNight` reads them |
| Turnover | Cleaner Core's jobs |
| Pro visit, crew day, repair block, vendor visit | Fixer Core's `fixer.json` |
| Package bring-in | `packages.json` |
| Expected visit | `oversight.json`, when the `oversight` switch is on |

- It lives in `src/hub/` and takes readers for each source, so the hub doesn't import the desks.
- It never returns a code, a phone number, a price or a guest's name. Labels are first names and trades, as
  the visit log keeps them.
- It decides nothing. Each core's own check still decides, as today. Using it inside a check is the next
  design.

This is what lets the Fixer bot answer "can the plumber come Tuesday?" knowing the cleaner is there until 2,
and what lets the Property Core bot answer "who's at the house this week?".

## Setup, as the host sees it

1. The host adds the Property Core bot and says "Set up Property Core". It connects to `/mcp`, as today.
2. The bot adds the property and asks which flows the host wants, as today.
3. On Grok Bot, with the `bots` switch on: for each flow picked, the Property Core bot sets up that core's
   own bot and tells the host to open it.
4. The core's bot connects to its own address. The host clicks Allow once for each bot.
5. The core's bot runs its flow's setup in its own chat, from its own guide, and creates its own Check
   routine and its own Alerts routine. Saving the Alerts routine is the hand-over.
6. The Property Core bot's `get_state` shows the team.

The host can say "keep it all in one bot" at step 3, and nothing else changes. Adding a flow later, or moving
an existing account to several bots, is the same step 3 for that flow. When a core's bot takes hold of its job, the
Property Core bot's list is shorter at its next `tools/list`. The service sends `tools/list_changed` only to
the session that made a change today (`src/mcp/toolListChanged.ts`), so this design adds a notice to the
account's other open sessions at hand-over. Until the Property Core bot deletes its routines for that core,
they get the refusal above.

Turning a flow off stays with the Property Core bot's `set_flows`.

### Repository content

- `property-core-template/bot-profile.md`: a "Your team" section. Step 3 above, what `team` means, and that it
  never asks another bot for a code or an approval.
- `cleaner-template/bot-profile.md` and `supply-template/bot-profile.md`: point at `/mcp/cleaner` and
  `/mcp/supply`, and say which chat to send the host to for anything else.
- `fixer-template/bot-profile.md` (new), in the same shape.
- `property-core-template/template.json`: each service gets `address`, and the routines list moves each
  routine under its own bot. Two new routine docs, `supply-template/routines/supply-core-alerts.md` and
  `property-core-template/routines/property-core-check.md`. `property-core-alerts.md` gains a
  `property.update` step that calls `check_alerts`, and `supply-core-check.md` gains the same call.
- `docs/client-matrix.md`: a "Separate bots" row (Grok Bot: yes; the others: no), kept in step by
  `test/propertyClientMatrix.test.ts`.
- `docs/hosted-multitenancy.md`: the Chats section, rewritten around the rule.

### `/admin`

Each connection shows its job. Disconnect works on any connection. "Make primary" is offered only for `/mcp`
connections. The `bots` switch sits with the other feature switches.

## Safety

- No gate changes. A job only takes tools away from a connection.
- The check is in code, on the call, not only on the list.
- `mark_guests_left` is `cleaning` only. `guests_left` is `fixer` only. `approve_cart` is `supplies` only.
  `set_flows`, `add_property` and `remove_bot` are `property` only, and `choose_supplies` is never listed at
  a core's address, so a core's bot can't turn a flow on or off.
- A host's two-call yes stays the desk's, as today: the code is kept by the core's desk, not by a connection.
  The tool that takes the code is listed for one job only, so only the bot that holds that job can finish it.
- Nothing the server needs travels between bots. A message from one bot to another is at most "check now".
- Grok's bots share one cloud computer, and files and sign-ins on it aren't kept apart per bot. So Grok is
  not the wall between the bots. The server's job check is.
- The new alert sinks reuse #277's guard: a text with a code, four or more digits or a phone number is
  withheld, never kept or shown.
- Tests use made-up stores, 555 numbers and a stubbed routine fetch. No test texts a real phone.

## Tests

`test/botJobs.test.ts` (the rule), `test/botJobsHosted.test.ts` (through `/mcp` and the three addresses):

- An account with only `/mcp` connections: `tools/list`, `initialize` and every reply are byte-for-byte what
  they are on `master`. `test/propertyClientMatrix.test.ts` stays green untouched.
- Each job's list holds exactly its own tools, with every switch on and with every switch off.
- A call to a tool outside the job is refused before any desk is reached, on each address.
- A token for one address is refused at the others.
- A second bot for a job replaces the first, and the first's routine is gone.
- A core's bot connected with no routine saved: both it and the Property Core connection can call that core's
  tools, wake-ups still go to the primary's routine, and a live desk stays ready.
- The core's bot saves its routine: it holds the job, the Property Core connection is refused that core's
  tools, and wake-ups go to the core's bot.
- The job comes back on each of the four ways in the rule, including `remove_bot` after the host's yes.
- The primary is never a core connection, including after the primary disconnects.
- A core's address refuses any agent but Grok Bot, and an account whose primary isn't Grok Bot.
- With different holders for `cleaning` and `fixer`, a Fixer Core note and a voice note wake the Fixer bot
  and never appear in `check_now`. With one holder for both, they appear in `check_now` as today.
- A holder quiet for 2.5 hours: the next wake-up also queues one `property.update`, and the line it gives
  carries no content from the other core.
- A property with only Supply Core on gets its package alert through `check_alerts`.
- `choose_supplies` is never listed at `/mcp/cleaner`, and Cleaner Core's setup there takes the answer from
  the property's flows.
- The `bots` switch off: the three addresses refuse, and a core connection made earlier holds nothing.
- Each event wakes its own job's routine, falls back in the order above, and is delivered once across a
  restart.
- `check_alerts` shows each alert once to each job it is routed to, and never marks a producer's own record.
- `report_low` and `open_job` from the Cleaner bot: refused with any source but `cleaner`, written once,
  the holder woken, and the reply carries no question.
- `get_schedule` never returns a code, a phone number, a price or a guest's name.
- One account's jobs never reach another account.

Gate rows: a new "Separate bots (#250)" section in each of `docs/cleaner-core-safety-gates.md`,
`docs/supply-core-safety-gates.md` and `docs/fixer-core-safety-gates.md`, each row naming its test.

Then #250's Part 2 by hand on the scratch account, with its four pass checks: each bot gets its own alerts,
the host knows which bot to ask, the cleaner's "running low" answer reaches Supply Core, and no door code
moves between bots.

## Build order

Each step is its own pull request and changes nothing for an account with the `bots` switch off.

1. **The rule and the addresses.** `src/jobs/jobs.ts`, the `bots` switch, the three resources, `job` on the
   connection, the primary among `/mcp` connections only, the list and call filters, `initialize` by job,
   `/admin`. After this step a core's bot can connect and run its tools, and holds nothing yet.
2. **Alerts for each bot.** The desk environment by job, hand-over on a saved routine, each core's notes to
   its own holder, the two new events, the two new sinks, `check_alerts`, `lastSeenAt`, the quiet-holder
   line and `remove_bot`. This is the largest step.
3. **Filing.** The three tools on the Cleaner job, the source check, the wake-up, the reply wording.
4. **`get_state` by job and the team view.**
5. **Templates and guides.** The profiles, `template.json`, the routine docs, the client matrix, the host
   setup page.
6. **`get_schedule`.**
7. **The hand test on Scratch, then one real account with Saad's okay.**

## To check on a scratch Grok account before step 5

- Can the Property Core bot create another bot with set instructions and its own connector address? xAI's
  docs say an existing bot can create a bot, and not how much it can set. If it can't, step 3 of setup
  becomes a template link for each core, which the Property Core bot hands the host. `template.json` gets a
  `templateLink` per service either way.
- Does a bot made that way keep its own routines apart from the Property Core bot's? The docs say each bot
  has its own.

## Left to the builder

- The exact wording of every new line, for the wording pass.
- How `jobsFor` is threaded through `propertyToolList` and `propertyToolCall`.
- Where `lastSeenAt` is written, as long as it isn't on every request.
- The shape of `get_schedule`'s lines beyond the fields named above.

## Calls made here, for the owner to check

1. On Grok Bot with the switch on, every flow the host picks gets its own bot, including when they pick only
   one. The host can keep one bot by saying so.
2. A core's bot takes hold of its job when it saves its Alerts routine, not when it connects. Until then the
   Property Core bot keeps that core's tools, so nothing live goes unread during setup.
3. One bot per core job for the whole account, not one per property.
4. Guest messages, locks, guest codes, cameras, the stay check, expected visits, visit records and the hours
   log sit with the Property Core bot. Booking emails and `set_late_checkout` stay with Cleaner Core, and
   packages with Supply Core.
5. Grok Bot only for now, and only on an account whose main chat is Grok Bot.
6. A core's bot can never turn a flow on or off. Cleaner Core's "do you want Supply Core?" question is asked
   only by the Property Core bot on a team.
7. When a core's bot goes quiet for 2.5 hours, the Property Core bot tells the host, and the host can have it
   removed there. The server can't tell a deleted bot from a quiet one.
8. Each core's notes go to its own bot. A repair note no longer shows up in the Cleaner Core chat once the two
   have different bots.
9. Lock notes keep today's routing.
10. A `bots` switch per account, off by default, in the same place as #278's switches.
11. `get_schedule` is read-only in this design.
12. The Property Core bot gets one new hourly routine, Property Core Check.

## Sources

- xAI, Use Grok Bot, chat and collaboration: https://docs.x.ai/grok-bot/chat-and-collaboration.md
- xAI, Work with Grok Bot, bots: https://docs.x.ai/grok-bot/bots.md
- xAI guide, How I run multiple teams of Grok Bots: https://x.ai/bot/guides/how-i-run-multiple-teams-of-grok-bots
- Microsoft, AI agent orchestration patterns: https://learn.microsoft.com/azure/architecture/ai-ml/guide/ai-agent-design-patterns
- The discussion draft: https://claude.ai/artifact/D21hBKGAsBCHJyj7iZg4NF
- The repository's open issues were not read: this session had the code, not the issue tracker.

## Changed after the branch review (22 Nov 2026)

Four things differ from the text above, each from the whole-branch review, each with its own test in
`test/botJobsHosted.test.ts`:

- **Quiet is per job.** 2.5 hours for Cleaner Core and Fixer Core, whose checks run every hour. 26 hours for Supply
  Core, whose check runs once a day: at 2.5 hours a healthy Supply Core bot was called quiet on most of its news.
- **An unread alert outlives the team.** An alert a bot was woken for and never read goes to the host's notes
  (`check_now` or `check_fixes`) when the last core bot goes, because `check_alerts` goes with it.
- **A filing's wake-up is retried.** One that doesn't go through is kept by time only and tried again every 5
  minutes, until it goes through, the owning bot calls on its own, or two days pass.
- **The team view uses nothing up.** The Property Core chat reads only the name of Cleaner Core's next step, so the
  one-time line about a door code that didn't reach the cleaner stays for the bot that runs Cleaner Core.
- **Feature offers follow the job.** `get_state`'s feature offers landed on master while this was built. An offer
  is made to, and answered by, only a chat whose jobs can run that feature's tools. Not done yet: at a property
  whose flows all run in other bots, the Property Core chat is shown no offers.
