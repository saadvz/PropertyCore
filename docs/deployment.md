# Deploying Tour Core

Tour Core is the system of record and the policy authority. Grok is the
installer and the operator console. This document describes how a Tour Core
installation is deployed, set up and kept running, and what is (and isn't)
automated.

The normal product path is one Tour Core service we host. A landlord does not
create a Railway project. Grok connects to that service. The Railway volume
is the live operational store. Grok's Google Drive connector keeps portable
backups and exports. Drive is not the live record store.

```
Grok
   │  connects to the already-hosted service (hostedTourCoreUrl)
   ▼
Tour Core on Railway (HOSTED_RAILWAY_P0, one demo installation)
   ├── https://<railway-domain>
   │     ├── /mcp                  Grok's OAuth connection
   │     ├── /webhooks/sendblue    visitor texts
   │     ├── /verify/<token>       identity form
   │     ├── /connect              operator approves Grok
   │     ├── /install              short-lived secure setup
   │     └── /healthz              Railway deploy check
   ├── volume at /data             live operational state and secrets
   └── Grok's Drive connector      Tour Core/Backups and Tour Core/Exports
```

Open-source and local development still use a process on a computer, with a
quick tunnel only for `GROK_MANAGED_P0`:

```
Grok cloud computer or a developer machine
   ▼
Tour Core runtime (src/web/server.ts)
   ├── public https address (quick tunnel, or PUBLIC_BASE_URL)
   │     ├── /mcp  /webhooks/sendblue  /verify/<token>  /healthz
   ├── this computer only
   │     ├── /install   /grok   /
   └── tourcore-data/
```

No Tour Core business logic lives in Grok's instructions. Grok decides nothing
about installation order, readiness or access: it reads Tour Core's
installation status and follows its next step.

## Deployment modes

| Mode | Where Tour Core runs | Who sets it up | Public address |
| --- | --- | --- | --- |
| `HOSTED_RAILWAY_P0` | One Railway service we run | The distributor, once. Landlords never see Railway | `https://${RAILWAY_PUBLIC_DOMAIN}`, or an explicit `PUBLIC_BASE_URL` |
| `GROK_MANAGED_P0` | Grok's own cloud computer | Grok, with `npm run bootstrap:grok` | Cloudflare quick tunnel (temporary) or a URL Grok is given |
| `SELF_HOSTED` | A server the operator runs | They deploy; Grok only connects and configures | `PUBLIC_BASE_URL` |
| `LOCAL_DEVELOPER` (default) | A developer's computer | `npm run setup`, `.env`, a manual tunnel | `PUBLIC_BASE_URL` |

The mode is resolved from `TOURCORE_DEPLOYMENT_MODE`, then the installation
manifest, then `LOCAL_DEVELOPER` (`src/install/deployment.ts`). It changes how
Tour Core is installed and reached, never a tour, policy or access rule.

**`HOSTED_RAILWAY_P0` is a single-tenant demo host.** One installation, one
operator client. A second account is refused. Marketplace publication
requires tenant isolation (`docs/hosted-multitenancy.md`). It is not
production multi-tenant hosting.

**`GROK_MANAGED_P0` is the open-source demo on Grok's computer.** It runs
only while that computer does, and the quick-tunnel address changes whenever
the tunnel restarts. It is not the recommended hosted demo.

## The installation manifest

`tourcore-data/install/manifest.json` (`src/install/manifest.ts`), versioned
and non-secret:

```json
{
  "schemaVersion": 1,
  "deploymentMode": "GROK_MANAGED_P0",
  "installationId": "inst_...",
  "publicBaseUrl": "https://....trycloudflare.com",
  "publicEndpointProvider": "CLOUDFLARE_QUICK_TUNNEL",
  "messagingProvider": "UNSET",
  "storageProvider": "LOCAL_DEMO",
  "accessProvider": "DURIN_DEMO",
  "operatorNotificationProvider": "GROK_ROUTINE",
  "options": { "grokLegacyOAuthCompat": true },
  "installedAt": "...",
  "updatedAt": "..."
}
```

The schema is strict (no extra fields), and every write is refused if any
configured credential value appears anywhere in it. The installation id is
created once and never changes, which is what makes the bootstrap idempotent.
`messagingProvider` is `UNSET` until the operator chooses, then `SENDBLUE`, `TWILIO`, `PHOTON`, or `LOCAL`.
A working Sendblue install with no explicit choice is migrated to Sendblue once. It is not switched to another provider.
A property may still opt into local test texts (`messagingProvider: "local"` on that building) while this installation value stays on the live provider.
Check results (public address, messaging, alerts) and the history of public
addresses live next to it in `install/state.json`, also non-secret.

## SecretStore

`src/install/secretStore.ts`. `LocalSecretStore` is one JSON file,
`install/secrets.json`, inside the data folder, written atomically and
`chmod 600` where the file system supports it. It holds the Sendblue API key,
API secret and incoming-webhook secret, the texting number, the Grok
Routine's webhook address and key, and Google OAuth tokens.

On `HOSTED_RAILWAY_P0` that folder is the Railway volume (`TOURCORE_HOME`,
normally `/data`, the same path as `RAILWAY_VOLUME_MOUNT_PATH`). The
container filesystem is wiped on every deploy. The volume is the live
operational store: properties, tours, sessions, ledgers, the outbox,
exceptions, and secrets. A restart does not restore from Drive. Secrets are
not written into portable backups.

- Written only by the secure setup page (or created by Tour Core itself, for
  the Sendblue webhook secret).
- Read only through the settings layer (`src/install/settings.ts`), which
  layers: the environment (a developer's `.env`), then SecretStore values
  (which win), then the manifest's public address (used when
  `PUBLIC_BASE_URL` isn't set, and always in `GROK_MANAGED_P0`). Adapters keep
  reading the familiar names, so `.env`-only developer setups are unchanged.
- Never in the manifest, install state, MCP arguments or results, the secure
  setup API's responses, audit, exports or logs. Tool results and secure setup
  responses are also passed through a redaction step that removes any
  configured credential value, whatever produced it.

## Secure setup

The secure setup page is `src/web/public/install.*` and
`src/install/secureSetup.ts`. On a Grok-managed or developer computer it is
`http://localhost:4321/install` and answers only for a local browser. On
`HOSTED_RAILWAY_P0` the same page is served over the Railway https address,
with a short-lived session, a CSRF secret in the URL fragment, and a small
write budget. An anonymous visitor cannot save credentials. Values are
write-only. Grok's secure secret input remains the preferred way to fill the
form.

Protection on a local or Grok-managed computer:

- The server listens on `127.0.0.1` only.
- `/install` and `/api/install/*` answer only for a local `Host` **and** only
  when the request carries no proxy or tunnel headers (`cf-connecting-ip`,
  `cf-ray`, `x-forwarded-for`, `forwarded`, ...). Through the public address
  they're "Not found", whatever `Host` is sent.
- A setup session lasts 30 minutes.

On `HOSTED_RAILWAY_P0` the process listens on `0.0.0.0` and Railway's proxy
headers are expected. `/install` is reachable only over https, and only with
the session. The session lasts 15 minutes, carries a CSRF secret, and can
save credentials a few times. `POST` from another site's `Origin` is refused.
Grok's MCP bearer token cannot approve the connection.

Shared rules:

- The token travels in the URL fragment (never a query string, never a
  `Referer`) and comes back in a custom header. Only its hash is stored.
  Expired sessions are rejected.
- A session can write provider settings. Nothing can read a credential back.

## Hosted Grok connection

`HOSTED_RAILWAY_P0` accepts Grok's current narrow legacy callbacks by
default (`cursor://anysphere.cursor-mcp/oauth/callback` and
`https://www.cursor.com/agents/mcp/oauth/callback`, exact strings only).
`TOURCORE_GROK_LEGACY_OAUTH_COMPAT=true` forces that list on in any mode.
`TOURCORE_GROK_LEGACY_OAUTH_COMPAT=false` forces it off, including on
Railway. Any other value is ignored and the mode default applies.
`LOCAL_DEVELOPER` and `SELF_HOSTED` stay off unless the variable is `true`.
`GROK_MANAGED_P0` still turns it on at bootstrap unless `--strict-oauth`
was used. Hosted startup does not need the variable set.

On a fresh hosted demo, the authorization page shows the pairing code and
Allow. The first human Allow binds that Grok client as the owner and finishes
OAuth. Registration alone does not claim it, and neither does opening the
page or clicking Deny. The binding is stored on the volume and survives
restart. The same client can approve again later. A different client is
refused. There is no separate owner-claim page and no bootstrap secret.

This first-approved-client rule exists only because `HOSTED_RAILWAY_P0` is a
controlled single-tenant demo. It is not the Marketplace sign-in. Before a
public multi-tenant host, Tour Core must authenticate the user, resolve that
user's installation, and bind Grok to that tenant. Do not treat
first-connect-wins as production tenant security.

To clear the owner without deleting tour records, set
`TOURCORE_HOSTED_OWNER_RESET=reset-hosted-owner` for one deploy, then remove
it. The next approved Grok connection can claim the demo. That reset is an
admin recovery step, not user onboarding.

To erase the whole hosted demo and start a fresh installation on the same
service, the current owner calls `reset_hosted_demo` (two-step confirmation).
That clears properties, tours, texting, operator updates, the backup
acknowledgment, OAuth grants, and the owner binding. It keeps the Railway
service, the stable URL, the volume, and files already saved in Google Drive.
It is a development reset for this demo, not a landlord feature, and it is
not available outside `HOSTED_RAILWAY_P0`. The environment variable above
does not do that full reset.

## Installation status and next step

`src/install/status.ts`. Components, in the order Tour Core works through
them, with the requirement Tour Core (not the agent) assigns:

| Component | Requirement | Phase |
| --- | --- | --- |
| `RUNTIME`, `PUBLIC_ENDPOINT` | required before property | BOOTSTRAP |
| `GROK_OPERATOR` | required before property | CONNECT |
| `VISITOR_MESSAGING`, `STORAGE`, `ACCESS` (DURIN_DEMO accepted) | required before property | INFRASTRUCTURE |
| `PROPERTY` | required to publish | PROPERTY |
| `OPERATOR_ALERTS` ("Tour updates") | recommended; offered only after the property is saved; turned on or declined with `save_settings`; chosen but not connected → `CONNECT_OPERATOR_ALERTS` | PROPERTY |
| `READINESS`, `PRACTICE_TOUR` | required to publish; run automatically | VALIDATE |
| `PUBLISH` | explicit yes | PUBLISH |

States: `NOT_CONFIGURED`, `ACTION_REQUIRED`, `CONFIGURING`, `READY`,
`DEGRADED`, `ERROR`. Once published, the phase is `OPERATE`.

The next step is the first component that isn't ready, with an action, its
phase, who does it (`GROK`, `OPERATOR`, `OPERATOR_IN_SECURE_SETUP`,
`OPERATOR_DECISION`), the tool or skill to use, an `operatorMessage` that's
safe to say to a landlord as-is, and `grokInstructions` with anything
technical (addresses, commands) for Grok only. Nothing on the property path
has a next step until the infrastructure is ready, so Grok can't offer
property setup early. Every step carries a `rule`: Tour Core decides the
order, so Grok doesn't offer alternatives or ask the operator what to do
next. Technical values (public address, connector address, providers) are
under `technical`, marked for Grok only. A later storage provider
(Google Drive as `STORAGE`) or live Durin Access Platform credentials
(`ACCESS`) changes what this returns; the Install Tour Core skill doesn't
change. Tour Core is already built on the Durin Access Platform.

<!-- historical-tools: These names are the install-layer tools still defined in src/install/tools.ts. The landlord connector does not list them. -->
### Installation tools (MCP)

`src/install/tools.ts`: `get_installation_status`,
`get_next_installation_step`, `get_installation_component`,
`skip_optional_setup`, `check_runtime_health`, `check_public_endpoint`, `test_visitor_messaging`,
`get_notification_preferences`, `set_notification_preferences`,
`get_operator_update`, `test_operator_alerts`, `test_storage`, `test_access`,
`get_secure_setup_url`.

None takes a credential (no input field may even be named like one; a test
enforces it), none returns one, and none runs a shell command. There is no
`set_api_key`, `set_sender_key` or `set_sendblue_secret`.
<!-- /historical-tools -->

## Bootstrap (`npm run bootstrap:grok`)

`scripts/bootstrap-grok.mjs` (plain Node: checks Node 20+, installs
dependencies with `npm ci` on a fresh folder) hands off to
`src/install/bootstrap.ts`:

1. detect the existing installation;
2. validate dependencies;
3. create the data folders;
4. create or reuse the manifest (same installation id every time);
5. validate configuration that would stop Grok connecting;
6. start the runtime, or keep the healthy one (a stuck or stopped one is
   restarted);
7. check local health (`/healthz`);
8. establish the public address and check it from outside (the public
   `/healthz` must return this installation's fingerprint);
9. mint a secure setup link and print operator-safe status (`--json` for
   machines);
10. exit, leaving Tour Core (and the tunnel) running in the background.

Running it again repairs and checks; it never creates a second installation.

`npm run bootstrap:self-hosted` runs the same steps without a tunnel, using
`PUBLIC_BASE_URL`.

## Runtime management

`src/install/service.ts`, for the install layer only (never an MCP tool):

```bash
npm run service:start     # start in the background; no-op if healthy
npm run service:stop      # stop (add -- --tunnel to stop the tunnel too)
npm run service:restart   # restart; the tunnel and its address are kept
npm run service:status    # running? healthy? pid, log file
npm run install:status    # installation status, component by component
npm run install:link      # a fresh secure setup link
```

The server writes `tourcore-data/service/runtime.json` (pid, port) when it's
listening and removes it on a clean stop; the service manager combines that
with the process table and `/healthz`. Output goes to
`tourcore-data/service/tourcore.log`. It works the same on Linux (Grok's
cloud computer) and Windows (developers).

**Self-healing (P0):** if Tour Core stopped, `npm run bootstrap:grok` (or
`service:start`) starts it again, and pending operator updates are retried on
startup. There is no supervisor process: no systemd, no containers.

## Public address

`src/install/publicEndpoint.ts`: `PublicEndpointProvider` with
`ManualPublicEndpointProvider`, `CloudflareQuickTunnelProvider`, and
`RailwayPublicEndpointProvider`. Tour Core's business logic only ever sees
the resulting address. `HOSTED_RAILWAY_P0` uses the Railway provider only.
It never installs or starts cloudflared, and it rejects a trycloudflare
address. The hostname comes from `RAILWAY_PUBLIC_DOMAIN` (Railway injects
it; Tour Core does not call the Railway API). An explicit https
`PUBLIC_BASE_URL` overrides it.

The quick tunnel provider finds `cloudflared` on `PATH` or in
`tourcore-data/bin`; on Linux it downloads Cloudflare's official static binary
there; elsewhere (or if the download fails) it returns one clear step (install
cloudflared or set `PUBLIC_BASE_URL`). It runs `cloudflared tunnel --url
http://127.0.0.1:<port>` in the background, captures the `trycloudflare.com`
address from its log, and reuses a running tunnel on the next bootstrap.

**Quick tunnel addresses change.** A new address invalidates Grok's MCP
connection and OAuth issuer/resource, Sendblue's webhook, and any identity-form
link built on the old address. Tour Core records every address; when it
changes, the installation status marks `PUBLIC_ENDPOINT` (check the new
address), `GROK_OPERATOR` (reconnect at the new connector address) and
`VISITOR_MESSAGING` (`set_up_texting` moves Tour Core's own Sendblue
webhook to the new address and removes the old one) as needing action. OAuth
already refuses tokens issued for a different address. Nothing continues
silently on a stale address.

## Visitor messaging

The operator chooses Sendblue, Twilio, Photon, or the local QA loopback. Grok collects that
provider's credentials with a secure input and submits them. The setup page
remains the write path and the manual fallback. A fresh installation asks;
an existing installation that already has valid Sendblue credentials stays on
Sendblue. Switching providers takes the previous one out of active use and
requires a new connection test. It does not delete saved credentials or
attached lines for other providers. Switching back uses the stored account
unless those details were never set.

Sendblue then checks the account and line, creates an incoming-webhook secret
if there isn't one, registers its own receive webhook for the current public
address, removes its webhook for an old address, and runs the readiness checks
(`src/messaging/sendblue/connect.ts`). Other webhooks on the account are never
touched. `.env`-based setups and `npm run sendblue:*` keep working.

## Operator updates

```
a tour is booked / starts / finishes / is cancelled, or a visitor needs judgment
   → (for a question with no approved answer) safe fallback texted to the visitor right away
   → operator event saved in the durable outbox (runtime/operator-events/),
     only for the update kinds the operator chose
   → POST to the Grok Routine webhook (Authorization: Bearer <routine key>)
   → Tour Core Operator Updates routine wakes, calls get_inbox(eventId)
   → the operator gets a plain sentence ("New tour booked: Testy is scheduled
     to tour Unit 1A today at 3:00 PM."), without having asked
```

- `OperatorNotificationSink` with `NoopOperatorNotificationSink` and
  `GrokRoutineWebhookSink` (`src/alerts/operatorEvents.ts`).
- Event payload: `schemaVersion`, `eventId`, `eventType`, `propertyId`,
  `tourId` (the tour handle, `get_tours`'s `tourRef`) or `exceptionId`,
  `occurredAt`. `eventType` is `tour.booked`, `tour.started`,
  `tour.completed`, `tour.cancelled`, `exception.created`, `access.problem`,
  `verification.problem` or `installation.test`. No visitor PII, message text
  or credentials.
- Preferences (`src/alerts/preferences.ts`, `save_settings`):
  the recommended default is everything except cancellations; before the
  operator chooses, only the three problem kinds are sent. "Booked" means a
  time was chosen and consent is on file (and the identity form, when this place uses one). Only real
  text-message tours produce updates (not practice tours or the browser
  demo), and something that happened before its kind was turned on is never
  sent late. No-shows aren't detected yet.
- Connecting the routine: Grok creates it, asks for the webhook address and
  key with a secure secret input, and submits Tour Core's form. If that input
  cannot be used and both values stay hidden behind copy buttons, Grok may
  paste them into the masked fields without reading them. If a value is shown
  on screen, the operator copies it. See
  `grok-template/routines/operator-updates.md`.
- `src/alerts/outbox.ts`: saved before delivery, keyed by a stable `eventId`
  derived from the exception (so the same exception is never queued twice),
  delivered after the visitor has been answered, retried with exponential
  backoff (5 s doubling to 15 min, 20 attempts), retried after a restart, and
  skipped (marked suppressed) if the exception was handled before delivery.
  Operator-placed holds aren't announced back to the operator.
- On the first start with alerts, exceptions that already exist are recorded
  but not announced.
- A delivery failure never affects the visitor; the installation status shows
  tour updates as degraded until a test update gets through. A later ordinary delivery does not clear a miss.

## Full new-user experience (Grok-managed)

Instruction hierarchy, with nothing duplicated between levels:
`GROK_BOOTSTRAP.md` (entry point) → `.grok/skills/install-tour-core/SKILL.md`
(detailed installation workflow) → the other `.grok/skills/*/SKILL.md`
(specific workflows) → Tour Core's MCP tools (actual state and actions).

Two ways in:

- **Final template experience:** add the Tour Core Bot, say "Set up Tour
  Core." The template knows the canonical repository and bootstrap behavior.
- **Development / open-source fallback:** a blank Grok Bot, no attachments,
  one prompt that names the repository URL and asks Grok to follow
  `GROK_BOOTSTRAP.md` (prompt in `docs/grok-manual-test.md`, test B). Grok
  discovers everything else from the clone.

The canonical repository is `repository.url` in `grok-template/template.json`.
An address from the operator's message (or `TOURCORE_REPO_URL`) is a fallback;
if it differs, Grok asks the operator, and the bootstrap refuses to start a
clone whose git origin isn't the canonical repository.

1. The operator installs the Tour Core Grok template (or sends the one-prompt
   bootstrap to a blank Bot).
2. They say **"Set up Tour Core."**
3. Grok checks whether Tour Core exists (the connector, then its cloud computer).
4. If not, Grok clones the canonical repository on its own cloud computer and
   reads `GROK_BOOTSTRAP.md`.
5. Grok runs `npm run bootstrap:grok`: Tour Core starts and gets its secure
   public connection. ("I'll handle the technical setup and only ask when I
   need a login, approval or decision.")
6. Grok adds the Tour Core connection itself; **the operator approves** it on
   Tour Core's approval screen in Grok's cloud browser. Grok continues on its
   own: "Connected. I'm checking the rest of the setup now."
7. Grok follows `get_state`. A fresh install asks which
   messaging provider to use. After the operator chooses, Grok collects that
   provider's credentials with a secure secret input, submits them, and tests
   the provider. Tour records (stored with this installation) and access
   (Demo) need nothing.
8. "Everything needed to start is connected and tested. Would you like to add your first property?"
9. Grok configures the property conversationally (Setup Property, Map Route):
   the address (confirmed as Tour Core saved it; a name only if the operator
   gives one), "What type of property is this?" (single-family home,
   multifamily, or apartment or condo), the units (or "Main Home" for a
   single-family home, or one unit number for an apartment or condo), each unit's bedrooms, bathrooms, rent and
   availability (bulk answers welcome; "not sure" is saved as not provided,
   never guessed), doors, routes, hours and verification. The property uses
   the installed texting automatically; nobody is asked how to text people.
   Alerts are not offered before this point and are never required.
10. Tour Core offers tour updates (recommended): "Would you like me to keep
    you updated when someone books, starts or finishes a tour, and alert you
    if something needs your input?" If yes, Grok saves the choice, creates the
    Tour Core Operator Updates routine itself, and connects it with the same
    secure secret input; Grok sends a test update. If no, Grok records the
    choice and moves on.
11. Grok explains how prospects use it and runs the readiness check and a
    practice tour without asking whether to skip them.
12. Grok asks for an explicit yes to publish.
13. "Your property is published. Visitor texting is live. Door access is still
    in demo mode, so no physical locks will open. I'll keep you updated on
    your tours and let you know when something needs your attention."
14. A real visitor can text the property; Tour Core wakes Grok for bookings,
    tour starts, completions and whenever a visitor needs judgment.

In the happy path the operator never sees addresses, tool counts, connectors,
tunnels, commands or protocol names, and is never asked to choose the setup
order.

### What still needs the operator

Grok can clone code, run commands, open pages, fill in non-sensitive settings
and run tests. The operator may still need to create or sign in to provider
accounts, pass MFA, accept provider terms, approve Grok's connection, and
make policy decisions (property facts, publishing). Provider credentials are
collected in Grok's secure input. Typing them into the setup page is only the
fallback when that input cannot be used. This is not zero-click setup.

## Limitations of `GROK_MANAGED_P0`

- Availability depends on Grok's cloud computer staying up; there's no
  supervisor restarting Tour Core between Grok sessions.
- The quick tunnel address is temporary; each change needs Grok reconnected
  (with the operator approving again) and Sendblue re-pointed.
- Records live on that computer's disk (`LOCAL_DEMO`). If the cloud computer
  is reset, tour history is lost unless exported.
- `cloudflared` is auto-installed only on Linux x64/arm64.
- Grok's current OAuth callback still needs the legacy compatibility option,
  which the Grok-managed bootstrap turns on by default (`--strict-oauth` turns
  it off).
- The secure setup session token is visible to Grok (it opens the link). It
  lets a browser on that computer write settings, never read them.

## Hosted Railway (distributor, once)

Checked against Railway's docs as of September 2026:

- GitHub-linked services redeploy when the connected branch changes
  ([GitHub autodeploys](https://docs.railway.com/deployments/github-autodeploys)).
  This repository's branch is `master`.
- Railway injects `PORT`. The process must listen on `0.0.0.0:$PORT`
  ([public networking](https://docs.railway.com/networking/public-networking)).
  `HOSTED_RAILWAY_P0` does not fall back to 4321.
- `RAILWAY_PUBLIC_DOMAIN` is the hostname, for example
  `example.up.railway.app`, not a URL
  ([variables reference](https://docs.railway.com/variables/reference)).
- A healthcheck path is configured in the service settings. Railway calls it
  with `Host: healthcheck.railway.app` and waits for any `2xx` before
  shifting traffic. It does not poll the path after the deploy is live
  ([healthchecks](https://docs.railway.com/deployments/healthchecks)).
  Tour Core's path is `/healthz`. It does not read Drive on each call.
- A volume is mounted at container start, not during build. `RAILWAY_VOLUME_MOUNT_PATH`
  is set automatically ([volumes](https://docs.railway.com/volumes)).
  Redeploying a service with a volume has a short period where the old and
  new containers are not both mounted. A deploy does not delete Drive records.
  The hosted process inspects that mount at startup (mountinfo and device id)
  and refuses to start if `TOURCORE_HOME` is unset or not on a persistent
  volume. `/healthz` and `check_runtime_health` on the ops connector report the path, whether it is
  persistent, and the mount that was found. `npm run check:storage` or
  `node dist/server.js --check-storage` prints the verdict without starting
  the server or writing files. `TOURCORE_ALLOW_EPHEMERAL_STORAGE=1` turns the
  refusal into a warning for disposable demos.
- `railway.json` / `railway.toml` are deprecated. New services cannot opt
  into them, and they stop being read on 2026-12-01
  ([config as code](https://docs.railway.com/config-as-code)). The desired
  service is `.railway/railway.ts` (Infrastructure as Code). Applying it is
  `railway config plan` then `railway config apply`. A git push deploys the
  connected branch; it does not apply that file by itself. Railpack installs
  with `npm ci` (`RAILPACK_NODE_NPM_INSTALL`) so the lockfile is the install,
  then runs `npm run build` and `npm start`. `NPM_CONFIG_PRODUCTION=false`
  keeps the build tools installed for that build. `RAILPACK_NODE_VERSION` is
  `22.14.0` because Cleaner Core backups need Node 22.13 or newer. No Docker image.
  Cleaner Core is off on this service. Hosted Cleaner Core runs only as its own
  multi-tenant service (below).

Production start is `npm run build` then `npm start` (`node dist/server.js`).
`npm run setup` stays the developer process. The hosted process exits if
required configuration is malformed, or if `TOURCORE_HOME` is not on a
persistent volume. It does not require a Google OAuth client, and it does
not refuse to start because Drive is unreachable. `DIRECT_GOOGLE_DRIVE` is a
separate optional mode.

### One-time admin setup

1. Push Tour Core to GitHub (`saadvz/TourCore`, branch `master`).
2. Create one Railway project and one service from that repo. Do not create
   a project per landlord.
3. Generate a Railway public domain (Settings, Networking). Leave
   `RAILWAY_PUBLIC_DOMAIN` as the variable Railway provides.
4. Add a volume mounted at `/data`.
5. Set `TOURCORE_DEPLOYMENT_MODE=HOSTED_RAILWAY_P0` and `TOURCORE_HOME=/data`.
   Do not set `TOURCORE_GOOGLE_WEB_CLIENT_ID` or
   `TOURCORE_GOOGLE_WEB_CLIENT_SECRET` for the normal hosted path. Do not set
   `TOURCORE_GROK_LEGACY_OAUTH_COMPAT` unless you need to force it off
   (`false`) or on (`true`). The hosted mode already accepts the known Grok
   callbacks.
6. Set the healthcheck path to `/healthz`.
7. Put `https://<that-domain>` into `hostedTourCoreUrl` in
   `grok-template/template.json` for the bot you publish. The skills read
   that field. They do not contain a Railway hostname.
8. Open `/healthz` and confirm `service` is `tour-core`.

`TOURCORE_STORAGE_MODEL=DIRECT_GOOGLE_DRIVE` is optional and off by default.
Only that mode uses Tour Core's own Google client and
`/google/oauth/callback`. Do not register that callback for a normal hosted
demo.

To clear the demo operator binding without deleting tour records, set
`TOURCORE_HOSTED_TENANT_RESET=reset-demo-tenant` for one deploy, then remove
it. Tour records live on the volume. The reset does not delete them.

After the first deploy, connect Grok and click Allow on the authorization
page. That first approval claims the demo. There is no owner-claim setup.

### Moving an older install

If an older computer used optional direct Drive as its live store, keep that
mode only while you still need it (`TOURCORE_STORAGE_MODEL=DIRECT_GOOGLE_DRIVE`).
The hosted product path does not take over a Drive writer lease. New hosted
installations keep operational records on the volume and put portable backups
in Grok's Drive folder.

A Railway restart uses the volume. Restoring a portable backup is for a lost
volume, onto a clean installation, after an explicit yes. The restore upload
accepts a backup, 50 MB by default (TOURCORE_RESTORE_UPLOAD_MAX_BYTES). An upload
over that cap returns 413 and states the cap.

### What a fresh Grok user does

They say "Set up Tour Core." Grok connects to `hostedTourCoreUrl`, the
operator approves, then Sendblue, Grok's Google Drive connector for portable
backups, the property, updates, readiness, a practice tour, and publish.
Grok then saves the first portable backup to Drive. The conversation does not
mention Railway, ports, tunnels, or `/mcp`, and it does not ask for a second
Google approval.

## Multi-tenant Cleaner Core (one service, many hosts)

One Railway service serves every Cleaner Core host, on Grok, Claude, and ChatGPT.
How it keeps hosts apart is in `docs/hosted-multitenancy.md`.

Saad creates a `cleaner-core` service from this repository in the Railway
dashboard, with its own volume at `/data` and the same build, start command,
healthcheck, and Railpack variables as `.railway/railway.ts`. That file stays the
Tour Core service's.

| Variable | Value |
| --- | --- |
| `TOURCORE_DEPLOYMENT_MODE` | `HOSTED_RAILWAY_P0` |
| `TOURCORE_HOME` | `/data` |
| `CLEANER_CORE_MULTI_TENANT` | `1` |
| `TOUR_CORE_TENANTS` | `1` to offer touring, `0` for cleaning only |
| `CLEANER_CORE_ENABLED` | `1` |
| `CLEANER_CORE_ADMIN_PASSWORD` | Saad's admin password. Railway variables only |
| `CLEANER_CORE_TWILIO_ACCOUNT_SID`, `CLEANER_CORE_TWILIO_AUTH_TOKEN` | The one Twilio account every tenant's number is on |
| `CLEANER_CORE_LIVE_SMS`, `CLEANER_CORE_SMS_ALLOWLIST` | As on any Cleaner Core deployment |
| `NODE_ENV`, `RAILPACK_NODE_NPM_INSTALL`, `NPM_CONFIG_PRODUCTION`, `RAILPACK_NODE_VERSION` | As in `.railway/railway.ts` |

Do not set `CLEANER_CORE_TWILIO_PHONE_NUMBER`, `CLEANER_CORE_ASSISTANT`, or
`CLEANER_CORE_MCP_TOKEN` there. Each tenant's number and chat come from its
tenant, and a fixed token names no tenant.

Adding a host: on `/admin`, create a tenant with its label and Twilio number,
then send the host the invite code. They add the connector at `<service>/mcp`
(or `<service>/mcp/cleaner-core` from a Cleaner Core template), type the code
on the page that opens, and choose touring or cleaning.

This shared service replaced the separate Tour Core service: touring tenants
run on it, each in its own Tour Core process (`TENANT_WORKER`), when
`TOUR_CORE_TENANTS` is on. `.railway/railway.ts` describes it. The single-owner
Tour Core demo below still works for a service without
`CLEANER_CORE_MULTI_TENANT`.

## Self-hosted

An operator who runs their own copy sets `TOURCORE_DEPLOYMENT_MODE=SELF_HOSTED`
and `PUBLIC_BASE_URL`, then starts Tour Core with their process manager
(`npm run build && npm start`, or `npm run bootstrap:self-hosted`). Grok
connects. That path is not the Marketplace experience.

## Technical debt

- Installation checks record results but the public address isn't re-checked
  on a schedule; a tunnel that dies between bootstraps shows up only when
  something fails or the bootstrap runs.
- The settings layer is a process-wide registration (one installation per
  process), kept simple for P0.
- The service manager relies on a pid file plus `/healthz`; there's no
  supervisor, log rotation or crash-loop protection.
- The outbox keeps delivered events indefinitely; it needs pruning before
  long-running use.
- `npm run sendblue:configure` still writes the webhook secret to `.env`
  (developer path); the secure setup path uses the SecretStore. They coexist,
  with SecretStore values taking precedence.
- The Grok Routine webhook authentication is assumed to be a bearer token;
  if Grok changes the header format, `GrokRoutineWebhookSink` is the one place
  to adjust.
