# Touring and cleaning on one shared service: design

Date: 2026-10-30. Status: draft for Saad's review.

## Goal

One hosted MCP service serves both products. A host's agent connects once, at one address, and the host picks the touring service (Tour Core) or the cleaning service (Cleaner Core). Each host is one tenant with one Twilio number. The number answers for whichever service the tenant has chosen.

Today the two products are hosted differently:

| Today | How it's hosted | Address |
| --- | --- | --- |
| Cleaner Core | One multi-tenant service: a tenant per host, an invite code, a Twilio number per tenant, `/admin` | `https://tourcore-production-8b80.up.railway.app` (live) |
| Tour Core | One single-tenant demo: the first Allow owns it, one Sendblue touring number for every property | `https://tourcore-production.up.railway.app` (Railway answers "Application not found") |

On the Cleaner Core service, `CLEANER_CORE_MULTI_TENANT=1` turns Tour Core's `/mcp` off (`src/cleaner-core/hosted/router.ts` answers 404). So right now no hosted Tour Core works at all.

Tour Core was a proof of concept for the agentic flow. Cleaner Core is further along. **Cleaner Core is the standard.** Wherever Cleaner Core already solves something, Tour Core takes Cleaner Core's way instead of keeping its own.

## What Saad decided

- **One service.** The live Cleaner Core service becomes the one service. The separate Tour Core Railway service does not come back.
- **One tenant per host, with both services available.** One invite code, one connection. The agent asks which service to set up.
- **One number per tenant, one active service.** The number answers for the active service only. Saad does not hand out a second number.
- **The service is locked once chosen.** It changes only when the host asks their agent to switch, or Saad switches it on `/admin`.
- **Switch only when nothing is live.** The host can stand the live service down first. Its setup is saved, so switching back picks up where it left off.
- **Each touring landlord is isolated** like a Cleaner Core tenant: their own properties, tours, texting number, and settings.
- **Visitors text cold.** Anyone can text a touring number to book a tour. No group thread on touring.
- **A process per touring tenant** (option 1 of three). The alternatives were one process with a per-request tenant context (a large change across Tour Core, where one missed global leaks between landlords) and a shared database with a tenant column (a storage rewrite).
- **Touring is offered on every chat. Grok is the supported path.** Claude, ChatGPT, and Muse support are open tasks.

## Scope

- In: the `service` choice and switching on the multi-tenant service; touring tenants each running Tour Core in its own process; Tour Core moved onto Cleaner Core's alerts, secret entry, texting, Scratch QA, admin health, and safety gate format; the Grok Tour Core template pointed at the shared service.
- Not now (open tasks, listed at the end): Claude, ChatGPT, and Muse touring support; a Muse touring setup script; a `verify-tourcore` skill; one merged Grok template; touring in-process without a separate process; a second number per tenant; real door access (Tour Core stays on the demo access adapter).

## Rules that stay

- `docs/cleaner-core-safety-gates.md` stays green, unchanged.
- No live text to a real person without Saad's okay. Tests and Scratch runs use only 555 numbers and made-up door codes.
- Secrets stay out of code, logs, prompts, chat, and tool arguments.
- Existing cleaning tenants behave exactly as today. Their connectors at `/mcp/cleaner-core` keep working without reconnecting.
- These modes behave exactly as today, and their tests stay green unchanged: single-tenant `HOSTED_RAILWAY_P0` without `CLEANER_CORE_MULTI_TENANT`, local, Grok-managed, and single-tenant Cleaner Core with `CLEANER_CORE_ASSISTANT`.
- Door access stays on the demo adapter (`DURIN_DEMO`). No real lock is opened.

## Part 1. One address, and what the agent sees

Every template (Grok, Claude, ChatGPT, Muse) points at `<service>/mcp`. Connecting is Cleaner Core's: the Allow page, the invite code, and the grant bound to the tenant. `/mcp/cleaner-core` stays as an alias for the same tenant and the same tools, so existing hosts don't reconnect. The OAuth protected-resource documents for both paths name the same authorization server, and the resource name for `/mcp` becomes the service's name instead of "Tour Core".

The tools depend on the tenant's `service`:

| `service` | Tools |
| --- | --- |
| unset | `get_state` (says no service is chosen and describes both), `choose_service` |
| `cleaning` | Today's Cleaner Core tools, unchanged, plus `switch_service` and `stand_down_service` |
| `touring` | Tour Core's landlord tools, forwarded to the tenant's touring process, plus `switch_service` and `stand_down_service` |

`choose_service` takes `touring` or `cleaning`. It needs no confirmation code, because nothing is set up yet. It offers `touring` only while `TOUR_CORE_TENANTS=1` (Part 8).

After a choice or a switch, the service sends `notifications/tools/list_changed` (the existing `src/mcp/toolListChanged.ts`). Because not every chat honours it, the tool reply also tells the agent to start a new chat if the new tools don't appear.

Setup scripts come from the active service. Cleaner Core's are unchanged. Tour Core picks its script from the client as today (`src/playbooks/`): Grok full, Claude and ChatGPT as written, Muse the baseline. The Tour Core ops and QA connectors (`/mcp/ops`, `/mcp/qa`) stay off on this service.

## Part 2. Registry and folders

Cleaner Core's tenant entry in `/data/tenants.json` gets one field:

| Field | Meaning |
| --- | --- |
| `service` | Unset, `cleaning`, or `touring`. Unset on a new tenant |

On first start with this change, every existing tenant becomes `cleaning`. Nothing else in the entry changes. The number stays `twilioNumber`, one per tenant, unique across tenants.

Folders:

- The cleaning desk stays at `/data/tenants/<id>/`, as today.
- Touring data lives at `/data/tenants/<id>/tour-core/`. That folder is the touring process's `TOURCORE_HOME`.
- The saved-text queue (Part 3) is `/data/tenants/<id>/tour-core-inbound/`.

Neither service reads or writes the other's files. Deleting a tenant on `/admin` removes both.

## Part 3. Texts and the touring process

### Texts to a number

Numbers stay pointed at the webhook they use now (`/webhooks/twilio/cleaner-core`), so no number is repointed on Twilio. A new tenant's number is pointed at the same path, as today. The front of the service checks Twilio's signature once, against the shared account's auth token and the URL Twilio signed, then finds the tenant by `To`, as today. Then:

| Tenant | What happens |
| --- | --- |
| `cleaning` | The cleaning desk, unchanged |
| `touring` | Handed to the tenant's touring process (below) |
| unset, turned off, or unknown | No reply. One log line, as for an unknown number today |

Two rules apply before either service sees a text:

- **STOP covers both services.** A phone that texted STOP to the number is opted out for both services until it texts START. The front of the service keeps that per-tenant list. Each service's own STOP handling still runs as today.
- **People from the inactive service.** When a phone that the inactive service knows (a cleaner, the host's saved numbers on the cleaning desk, or a visitor in the touring records) texts the number, nothing is sent back, and the landlord gets one alert through the tenant's alert routine. A cleaner's "DONE" is never answered as a tour request.

### The touring process

Each enabled tenant whose `service` is `touring` runs today's Tour Core server in its own child process, in a new deployment mode, `TENANT_WORKER`:

- **Starts** at service boot, and when a tenant chooses or switches to touring. **Stops** when the tenant switches away, is turned off, or is deleted.
- **Listens** on `127.0.0.1` only, on a port the front of the service picks. Every request must carry a per-process key the front of the service generated at start. A request without it is refused. The process has no OAuth of its own.
- **Environment** is built like `buildTenantEnv` (`src/cleaner-core/hosted/tenantEnv.ts`): the process environment minus every per-tenant name, plus `TOURCORE_HOME` (the tenant's `tour-core/` folder), the tenant's number as the Twilio touring number, the shared Twilio account, `PUBLIC_BASE_URL` set to `<origin>/t/<id>`, and the deployment mode. No Cleaner Core secret and no other tenant's value reaches it.
- **MCP calls** to `/mcp` (or the alias) on a touring tenant are forwarded after OAuth. The body is forwarded unchanged, so Tour Core's playbook choice from `initialize` works as today. The caller's assistant and grant id travel in internal headers that the process accepts only with its key.
- **Public links** Tour Core hands out (the visitor identity form `/verify/<token>`, its API, audit export links, compliance pages) live under `/t/<id>/` and are forwarded to that tenant's process, the same way Cleaner Core's per-tenant links work.
- **Crashes** restart the process with a growing delay (1 s, 2 s, 4 s, up to 60 s). While it is down, incoming texts for that tenant are written to the saved-text queue and the front of the service answers Twilio with an empty reply. The process takes the queue first when it is back, oldest first, through its normal inbound path. The inbound ledger keeps a text from being handled twice.
- **Size.** Each process is about 60–100 MB. That is fine for tens of touring tenants. Hundreds would mean doing the open task "touring in-process" first.

Tour Core's own server code is reused as the process. The new code is the supervisor, the forwarding, and the queue, kept in `src/hosted/` (Part 9).

## Part 4. Tour Core on Cleaner Core's pieces

| Area | Tour Core today | In a touring process |
| --- | --- | --- |
| Landlord alerts | One Grok Routine webhook (`GrokRoutineWebhookSink`), saved on `/install` | Cleaner Core's alerts. Each connected chat has its own alert routine, saved through a one-time upload link (`save_alert_routine`), and the primary connection gets the wake-ups, under the rules in `docs/hosted-multitenancy.md`. The process holds no routine secrets: its operator events go to the front of the service over the internal link, which queues and delivers them through the tenant's routine. The event format is already shared (`src/alerts/operatorEvents.ts`). Routines are saved per service, so switching to touring asks for a touring routine, and `publish` is refused until it is connected, as Cleaner Core's `activate` is |
| Secret entry | `/install` page with a session and CSRF token | Cleaner Core's one-time upload links under `/t/<id>/`. Touring needs only the alert routine here |
| Texting | Sendblue, Twilio, Photon, or local | Twilio only, on the tenant's number. Tour Core's visitor consent and STOP handling stay. Live sends follow `CLEANER_CORE_LIVE_SMS` and `CLEANER_CORE_SMS_ALLOWLIST`, as cleaning does. Touring needs the allowlist at `*` to reach visitors; turning that on stays Saad's decision |
| Scratch QA | QA connector and local test texts | Cleaner Core's Scratch rule: a tenant whose number and saved numbers are all 555 is Scratch. Touring texts there go to the outbox only. Behind `CLEANER_CORE_SCRATCH_TOOLS`, the touring tools add `read_inbox`, `read_outbox`, and `send_test_text` (a visitor text from a 555 number) |
| Health | `/healthz` | `/admin` lists each tenant's service, whether its touring process is up, restarts in the last day, and queued texts. No phone numbers, codes, or secrets |
| Safety gates | Spread across tests and the client matrix | `docs/tour-core-safety-gates.md`, in the format of `docs/cleaner-core-safety-gates.md`, proofs in CI (Part 7) |
| Backups | Portable backups to the agent's own Drive | Kept as is. The one exception to taking Cleaner Core's way: Cleaner Core has no off-Railway copy yet, and these need no secrets |

Off in `TENANT_WORKER` mode:

- The single-owner hosted demo: first-Allow-claims-the-demo, `/connect`, `reset_hosted_demo`, `TOURCORE_HOSTED_TENANT_RESET`, and `TOURCORE_HOSTED_OWNER_RESET`. Saad's turn-off and delete on `/admin` replace them.
- `/install`, `/api/install/*`, and Tour Core's own OAuth.
- The installation steps for choosing a texting provider, Sendblue setup, and the Grok Routine. `get_state` skips them: the number and Twilio come from the tenant.
- The ops and QA connectors.

## Part 5. Switching

### What counts as live

| Service | Live when any of these holds |
| --- | --- |
| Touring | A tour is in progress. An upcoming or held tour exists. A property is published and taking bookings |
| Cleaning | The property is activated. A job is offered, confirmed, or in progress. A door code is waiting to be sent |

Open issues, flagged questions, and past records never block.

### Tools

Both use the two-step confirmation code Cleaner Core uses for `hold_job`: call without a code to get the question and a code, ask the host, then call again with the code after a yes.

**`switch_service`** (`to`: the other service).

- First call: if the current service is live, the reply lists what is live and points to `stand_down_service`. Otherwise it returns the question and a code.
- Second call: sets `service`, starts or stops the touring process, and sends `tools/list_changed`. It sends no texts.

**`stand_down_service`.**

- First call: a preview of what will stop and the exact texts that will go out, with who gets each.
- Second call: does it.
- Touring: pauses every published property (Tour Core's `pause_tours`) and cancels each upcoming or held tour with the normal cancellation text to that visitor. Refused while a tour is in progress; the reply says to wait until it ends.
- Cleaning: deactivates the property and withdraws each offered or confirmed job, with one text to that job's cleaner saying the cleaning is off. Refused while a cleaning is in progress. This is new to Cleaner Core. `reset_property` stays the full wipe.
- Kept for both: property details, people and opt-ins, calendar links, the sealed door code, preferences, alert routine connections, and history.

**Switching back.** The saved setup is still in the service's folder. `get_state` picks up from it: touring asks to resume bookings (`pause_tours` with `paused: false`), cleaning asks for `activate`. No setup step is repeated unless something it depends on changed.

### On `/admin`

The tenant row shows the service and a switch button. The button shows the same blockers. Saad's **force** switches without standing down and sends nothing. The old service's leftover items stay frozen in its saved setup. The switch, and whether it was forced, is recorded in the tenant's audit log.

### An inactive service does nothing

No timers, reminders, calendar checks, alert sends, or texts. The cleaning alert drain (`drainAllTenants`) skips tenants not on `cleaning`. A tenant not on `touring` has no touring process.

## Part 6. Data lifecycle and logs

- Switching never deletes. Deleting a tenant deletes both services' folders and its queue.
- Logs name the tenant id, never a full phone number, a door code, a routine key, or a calendar link, as today.
- The touring process's log lines are prefixed with the tenant id by the supervisor.

## Part 7. Testing

Vitest, 555 numbers and made-up door codes only, following the `test/cleanerHosted*.test.ts` files.

- Registry: the `service` field, and existing tenants becoming `cleaning`.
- Routing: texts and MCP calls by service, unset and turned-off tenants, the `/mcp/cleaner-core` alias.
- Tool lists for unset, `cleaning`, and `touring`, `choose_service` hiding touring with `TOUR_CORE_TENANTS` off, and `tools/list_changed` after a choice and a switch.
- Forwarding to a fake touring process (key required, headers, `/t/<id>/` links), plus one test that starts a real `TENANT_WORKER` process.
- Supervisor: restart with the growing delay, the saved-text queue taken once after restart, no double handling on replay.
- Switching: the blockers for each service, `stand_down_service` previews and actions for each service, refusal during a tour or cleaning in progress, switching back resuming from the saved setup, and `/admin` force sending nothing.
- STOP across services, and an inactive-service contact getting no reply and one landlord alert.
- **Hosted tenants gate:** two touring tenants and one cleaning tenant. A text to one number, a grant, a swapped `/t/<id>/` prefix, a forwarded MCP call, or a process environment value never reaches another tenant.
- `docs/tour-core-safety-gates.md` gates, each with a test in CI: door access only on the visitor's route during their window; early arrival denied; a repeat request doesn't grant twice; fair-housing questions go to the landlord with no draft; STOP and HELP win; no second send after restart or replay; the hosted tenants gate above.
- Unchanged and still green: `docs/cleaner-core-safety-gates.md`, the client matrix, and every existing mode in "Rules that stay".

## Part 8. Rollout

1. **Ship behind `TOUR_CORE_TENANTS=1`.** With it off, `choose_service` offers cleaning only and no touring process starts. Deploying is safe for current hosts.
2. **Scratch check with Grok:** turn the flag on, make a Scratch tenant with a 555 number on `/admin`, connect Grok, choose touring, set up a property, run a practice tour, send visitor texts with `send_test_text` and read them in the outbox. Switch to cleaning and back.
3. **Templates and docs:** set `hostedTourCoreUrl` in `grok-template/template.json` to the shared service. Update `.railway/railway.ts` to describe the shared service, plus `docs/deployment.md`, `docs/hosted-multitenancy.md`, `GROK_BOOTSTRAP.md`, and the README.
4. **One real pilot landlord**, only with Saad's okay on live texts and the allowlist.

## Part 9. Code layout

- `src/hosted/service.ts`: the tenant's service, `choose_service`, `switch_service`, `stand_down_service`, and the blocker rules, calling each product through a small interface (`isLive`, `standDownPreview`, `standDown`).
- `src/hosted/touringSupervisor.ts`: starting, stopping, and restarting touring processes; ports and keys.
- `src/hosted/touringForward.ts`: forwarding MCP calls, texts, and `/t/<id>/` links; the saved-text queue.
- `src/hosted/crossService.ts`: STOP across services and inactive-service contacts.
- `src/install/deployment.ts`: the `TENANT_WORKER` mode, and the places that turn hosted-demo features off.
- `src/cleaner-core/hosted/`: the registry field and migration, the router handing touring tenants to `src/hosted/`, `/admin` additions.
- `src/cleaner-core/`: Cleaner Core's `stand_down` and its live check.

## Open tasks

- Claude touring support, checked live on a Scratch tenant.
- ChatGPT touring support, checked live on a Scratch tenant.
- Muse touring support and a Muse touring setup script, checked live on a Scratch tenant.
- A `verify-tourcore` skill, like `.cursor/skills/verify-cleanercore/`.
- One Grok template for both services, in place of `grok-template/` and `cleaner-template/`.
- Touring in-process: bring Tour Core up to Cleaner Core's per-request standard, then retire the touring processes.
- A second number per tenant, if Saad later wants both services live at once.

## Build order

1. Registry `service` field and migration; the router routing by service; the flag.
2. `TENANT_WORKER` mode with hosted-demo features off; the supervisor; forwarding; the queue.
3. Alerts through the front of the service; one-time upload links for the touring routine; `publish` waiting on it.
4. Tool lists per service; `choose_service`; `tools/list_changed`.
5. Blockers, `stand_down_service` for both services, `switch_service`, `/admin` switch and force.
6. STOP across services; inactive-service contacts.
7. Scratch tools for touring; `/admin` health.
8. `docs/tour-core-safety-gates.md` and the hosted tenants gate in CI.
9. Templates and docs; Scratch check; pilot.
