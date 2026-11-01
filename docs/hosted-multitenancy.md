# Hosted multi-tenant Cleaner Core

One Cleaner Core service serves many hosts. Each host is a **tenant**. A host can
connect Grok, Claude, ChatGPT, or more than one of them, to their tenant. The
design is `docs/superpowers/specs/2026-10-27-cleaner-core-multi-tenant-hosting-design.md`.

The same service hosts touring: each tenant's number runs touring or cleaning,
chosen by the host. The design is
`docs/superpowers/specs/2026-10-30-shared-service-touring-design.md`. Tour Core's
own hosted demo (`HOSTED_RAILWAY_P0` without the flag below) is still
single-tenant and unchanged.

## Turning it on

The service runs `TOURCORE_DEPLOYMENT_MODE=HOSTED_RAILWAY_P0` with
`CLEANER_CORE_MULTI_TENANT=1`. The flag makes the service multi-tenant: `/mcp`
and `/mcp/cleaner-core` both take an invite code. `TOUR_CORE_TENANTS=1` adds
touring. The variables are in `docs/deployment.md`.

## The boundary

Every request resolves exactly one tenant before it reads or writes anything:

| Way in | How the tenant is found |
| --- | --- |
| `/mcp/cleaner-core` | The OAuth grant. The host's invite code on the Allow page bound it to a tenant |
| A text to `/webhooks/twilio/cleaner-core` | The `To` number. Each tenant has its own Twilio number |
| Everything Cleaner Core hands out: group webhooks, status callbacks, upload pages, photo links | The `/t/<tenantId>/` path prefix. Twilio signs the full URL, and photo links are signed with the tenant's own key |

A request that names no tenant, an unknown one, or a turned-off one stops there.
The un-prefixed upload, photo and group paths answer 404 on this service.

Each tenant has:

- its own folder, `/data/tenants/<id>/`, which is the root of an ordinary
  Cleaner Core desk (state, job store, alert queue, photos);
- its own secrets in that folder (`secrets.json`, mode 600): the door-code and
  photo keys, and each connection's alert routine;
- its own environment, built per request: the process environment minus every
  per-tenant name, plus the tenant's secrets, number, and `PUBLIC_BASE_URL`
  under `/t/<id>`.

The registry is `/data/tenants.json`. Invite codes are stored only as hashes.

## Chats

A tool reply speaks to the chat making the call. Texts to the host and cleaner,
and which alert routine is woken, follow the tenant's **primary** connection: the
first one connected. When the primary hasn't connected its alert routine and
another chat on the tenant does, that chat becomes primary, so setup never
waits on a chat that won't make one. A primary whose routine is connected
changes only when Saad changes it on the admin page. When the primary's grant
is gone, the oldest live connection stands in.

## Saad's admin page

`/admin`, behind `CLEANER_CORE_ADMIN_PASSWORD`. Add a host and its Twilio number
(the page points the number's webhook at this service), hand out invite codes
with the one connector address (`/mcp`), pick the primary, disconnect a chat,
turn a tenant off, or delete it. The page sets no service: the host's chat
picks it. Once it's chosen, the page can switch the number to the other
service. The page never shows a door code, a calendar link, a routine key, or a
cleaner's phone.

## Services

Each tenant has a `service`: touring, cleaning, or not chosen yet. Existing
tenants became cleaning. A tenant's one number answers for its service only.

- **Choosing.** A tenant with no service shows `get_state` and `choose_service`.
  The cleaning address picks cleaning for it on the first call.
- **Tools.** A cleaning tenant gets Cleaner Core's tools; a touring tenant gets
  Tour Core's landlord tools from its own process. Both also get
  `switch_service` and `stand_down_service`, and touring gets
  `save_alert_routine`. A tool of the other service is refused with "This number
  is set up for {service} now. Start a new chat to see its tools."
- **Touring processes.** One Tour Core process per enabled touring tenant
  (`TENANT_WORKER`), on loopback, with its own key, folder
  (`/data/tenants/<id>/tour-core/`), and number. It restarts after a crash
  (1 s, 2 s, 4 s, up to a minute). Texts that arrive while it's down wait in
  `/data/tenants/<id>/tour-core-inbound/` and are handed over once it's back.
- **Switching.** Only when nothing on the service is live, after the host's
  yes, with no texts. `stand_down_service` previews the exact texts, then stops
  what's live: touring pauses bookings and cancels booked tours; cleaning calls
  off offered and confirmed jobs. Each service's setup is kept, so switching back
  picks it up. `/admin` can switch too, or force a switch that sends nothing.
- **Across a switch.** STOP covers both services until START or YES. The other
  service's people get no reply, and the host is told once.
- **Gates.** `docs/tour-core-safety-gates.md`.

## Not yet

Self-serve signup (a phone check in place of the invite code), copying backups
off Railway, and a per-tenant SMS allowlist.

Touring open tasks:

- Claude touring support, checked live on a Scratch tenant.
- ChatGPT touring support, checked live on a Scratch tenant (its alerts poll, so
  touring publish waits until they're connected).
- Muse touring support and a Muse touring setup script, checked live.
- A `verify-tourcore` skill, like `.cursor/skills/verify-cleanercore/`.
- One Grok template for both services, in place of `grok-template/` and
  `cleaner-template/`.
- Touring in-process: bring Tour Core up to Cleaner Core's per-request standard,
  then retire the touring processes.
- A second number per tenant, if both services should run at once.
