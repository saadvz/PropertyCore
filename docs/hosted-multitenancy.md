# Hosted multi-tenant Cleaner Core

One Cleaner Core service serves many hosts. Each host is a **tenant**. A host can
connect Grok, Claude, ChatGPT, or more than one of them, to their tenant. The
design is `docs/superpowers/specs/2026-10-27-cleaner-core-multi-tenant-hosting-design.md`.

The same service hosts touring for accounts that ran it before it was parked. The design is
`docs/superpowers/specs/2026-10-30-shared-service-touring-design.md`. Tour Core's
own hosted demo (`HOSTED_RAILWAY_P0` without the flag below) is still
single-tenant and unchanged.

## Turning it on

The service runs `TOURCORE_DEPLOYMENT_MODE=HOSTED_RAILWAY_P0` with
`CLEANER_CORE_MULTI_TENANT=1`. The flag makes the service multi-tenant: `/mcp`
and `/mcp/cleaner-core` both take an invite code. `TOUR_CORE_TENANTS=1` adds
touring. `CLEANER_CORE_SIGNUP=1` adds Sign in and Create account to the connect
page (below). The variables are in `docs/deployment.md`.

## The boundary

Every request resolves exactly one tenant before it reads or writes anything:

| Way in | How the tenant is found |
| --- | --- |
| `/mcp/cleaner-core` | The OAuth grant. The host's invite code, sign-in, or new account on the Allow page bound it to a tenant |
| A text to `/webhooks/twilio/cleaner-core` | The `To` number. Each tenant has its own Twilio number |
| A call to `/webhooks/twilio/voice`, and its transcript to `/webhooks/twilio/voice/transcript` | The `To` number, as for a text. Both are signed by Twilio. Only a known caller is recorded; see the Voicemail gate in `docs/fixer-core-safety-gates.md` |
| Everything Cleaner Core hands out: group webhooks, status callbacks, upload pages, photo links | The `/t/<tenantId>/` path prefix, and `/p/<propertyId>/` after it for every property but a migrated one. Twilio signs the full URL, and photo links are signed with the tenant's own key |

A request that names no tenant, an unknown one, or a turned-off one stops there.
The un-prefixed upload, photo and group paths answer 404 on this service.

Each tenant has:

- its own folder, `/data/tenants/<id>/`, which is the root of an ordinary
  Cleaner Core desk (state, job store, alert queue, photos, and the host's
  pending approval codes, kept as hashes so a restart doesn't lose them);
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

`/admin`, behind `CLEANER_CORE_ADMIN_PASSWORD`. Add a host, with a number from
the pool or a typed Twilio number (the page points the number's webhook at this
service), keep the number pool topped up, hand out invite codes
with the one connector address (`/mcp`), pick the primary, disconnect a chat,
turn a tenant off, or delete it. The page lists each account's properties and
flows, with a health line per property, and can turn a flow off with force,
which sends nothing. It can make an account with no properties a touring
account. The host's chat adds properties and turns flows on. The page never
shows a door code, a calendar link, a routine key, or a cleaner's phone.

## Text lines and the number pool

Each account has one text line, for the cleaner (and maybe pros). The host
never texts it; they use their agent. US carriers take days to register a
number for business texting (10DLC or toll-free verification), so numbers are
bought and registered ahead of time and kept in a pool,
`/data/number-pool.json` (saadvz/PropertyCore#163).

- **Top up.** `/admin/pool` adds numbers that are on the Twilio account and
  held by no account or other part of the service. Add only registered
  numbers: the page can't check registration. Accounts made before the pool
  are recorded as in use the first time `/admin` loads.
- **Sign-up.** `openAccount` in `src/cleaner-core/hosted/lines.ts` creates the
  account with the ready number that has waited longest, records it, and
  points its SMS webhook at `/webhooks/twilio/cleaner-core` and its voice
  webhook at `/webhooks/twilio/voice` in one call, clearing any TwiML App.
  A line pointed before voice gets its voice webhook once at startup, only
  while `FIXER_CORE` is on. Two sign-ups never get
  the same number. With no ready number, sign-up is refused and the log says
  so. `/admin`'s "Add a host" with a blank number makes the same call. A typed
  number is recorded in the pool too, unless it is resting.
- **Webhook.** If Twilio refuses the webhook, the account is still created;
  the pool page shows "not pointed" with a button to point it again.
- **Closing.** Deleting an account clears its webhook and returns the number to
  the pool, where it rests 30 days so the old cleaner stops texting it before
  another account gets it. A text to a resting number reaches no account. The
  delete form can release the number from Twilio instead, and the pool page
  can release a ready or resting one; a number being released is out of the
  pool, so no sign-up can take it. Releasing gives up its registration. If a
  release fails, the page says so after the delete.
- **Low alert.** At 3 or fewer ready numbers, `/admin` shows "The number pool
  is low", and the log says so after every sign-up.
- **Own numbers.** Pooled numbers count as the service's own, so none is ever
  texted as a person.

## Accounts and properties

The design is
`docs/superpowers/specs/2026-11-06-property-core-accounts-properties-design.md`.
Each tenant is an **account** with one text line and one or more
**properties**. Each property has its own folder,
`/data/tenants/<id>/properties/<pid>/`, which is the root of an ordinary
Cleaner Core and Supply Core desk, and switches each flow on or off on its own:
Cleaner Core (`cleaning`), Supply Core (`supplies`), and Fixer Core (`fixer`,
refused without `FIXER_CORE=1`). The account keeps the line, the secrets, the chats, and
their alert routines.

- **Migration.** At startup, a `tenants.json` older than version 3 moves each
  cleaning or supplies tenant into one property (`prp_` + its id's ten
  characters), with its links still under `/t/<id>/`. If a move fails, the
  service doesn't start, and the next start finishes the job.
- **Tools.** `get_state` lists the properties and each one's next step;
  `add_property` adds one; `set_flows` turns a flow on, or stands it down and
  turns it off after the host's yes. Every Cleaner Core and Supply Core tool
  takes `property` (or `propertyId`, where the tool has its own `property`
  field), required once the account has two or more properties.
- **Links.** A new property's links are under `/t/<id>/p/<pid>/`.
- **Texts.** Group texts and callbacks arrive on the property's own path.
  One-to-one texts go by sender. A person (the cleaner or a contact) can be on
  several properties after the host's `shared: true`
  (`docs/superpowers/specs/2026-11-07-shared-people-design.md`). The account
  keeps them in `/data/tenants/<id>/people.json`, with their one YES and their
  own STOP for every property. A shared person's text goes to the property it
  names, or to the one property waiting on them, or they're asked "which
  property?"; the held text waits in `line-asks.json` for 2 hours.
  With two or more properties, the landlord's own texts change nothing but STOP
  and START, which reach every property where they're the host; anything else
  gets one reply, "Please tell me in your agent chat so I know which property.",
  at most once in 12 hours. Every text to the landlord starts with the
  property's label. A STOP from someone on no property holds for the whole line.
- **Gates.** `docs/cleaner-core-safety-gates.md` ("Own property only").

## Fixer Core

Fixer Core (`fixer`) gets a property's repairs and upkeep done. It turns on for
a property only with `FIXER_CORE=1` on the service, and only for Grok Bot and
Muse; Claude and ChatGPT get one plain line saying so. A property with it off
behaves exactly as before, and the host can turn it off, which cancels open
jobs after their yes. Each property keeps its pros, jobs, costs and visit
pages in its own folder, and the visit page answers only on its own property's
path. A pro on two properties needs the host's `shared: true`, and a pro who
texts is held in `people.json` beside the cleaner, with their own YES and STOP
for the account. The agent finds pros with its own search, since there's no
partner network in v1. Fixer Core never pays or takes a card, and the door
code reaches only the pro's own phone for the visit.
**Gates.** `docs/fixer-core-safety-gates.md`.

## Touring (parked)

Touring is parked: new accounts get properties. An existing touring account
(`service: "touring"`, no properties) keeps its own Tour Core process and
tools. Only `/admin` makes an account with no properties a touring account,
while `TOUR_CORE_TENANTS` is on.

- **Tools.** A touring account gets Tour Core's landlord tools from its own
  process, plus `save_alert_routine`, `save_host_texts`, and `get_updates`. A
  property tool is refused with "This number is set up for touring now. Start a
  new chat to see its tools."
- **Touring processes.** One Tour Core process per enabled touring account
  (`TENANT_WORKER`), on loopback, with its own key, folder
  (`/data/tenants/<id>/tour-core/`), and number. It restarts after a crash
  (1 s, 2 s, 4 s, up to a minute). Texts that arrive while it's down wait in
  `/data/tenants/<id>/tour-core-inbound/` and are handed over once it's back.
  Its environment drops every `TOURCORE_*` value of the service except the
  five visitor-model settings (`TOURCORE_INTENT_MODEL_URL`, `_KEY`,
  `TOURCORE_INTENT_MODEL`, `TOURCORE_INTENT_MODEL_TIMEOUT_MS`,
  `TOURCORE_INTENT_MODEL_REASONING_EFFORT`), which every
  touring process shares. Without them, touring runs on its rules alone.
- **An earlier cleaning setup.** STOP holds until START or YES. People from a
  cleaning setup the account had before it became a touring account get no
  reply, and the host is told once.
- **Gates.** `docs/tour-core-safety-gates.md`.

## Sign in and Create account

The design is
`docs/superpowers/specs/2026-11-07-connect-page-sign-up-design.md`. With
sign-up open, the connect page offers Sign in, Create account, and the invite
code. A phone code from Twilio Verify proves the landlord holds their phone.
A code is a text, so it waits for `CLEANER_CORE_LIVE_SMS` and goes only to
phones `CLEANER_CORE_SMS_ALLOWLIST` allows, and only to US and Canadian
numbers. Sign in binds the grant to the account that phone signed up; Create account
opens a new account with a line from the number pool and records its landlord
(`owner` in `tenants.json`: phone, email, when the phone was verified, and the
terms version). Codes are limited per phone, per page, and for the whole
service, and five wrong codes lock a phone out for an hour. A page that
confirmed a phone keeps it confirmed, so switching between Sign in and Create
account doesn't need a second code. Invite codes keep
working for accounts made on `/admin`.

## Not yet

Buying numbers from `/admin`, copying backups off Railway, and claiming an
admin-made account by phone. Texting consent is already per account: a tenant's
desk texts nobody until its host is the landlord's phone confirmed at sign-up
(`tenant.owner`, passed as `CLEANER_CORE_LANDLORD_PHONE`), and then each
person's own YES and STOP decide.

Touring on every chat:

- **Tour updates.** Grok posts its webhook routine from its computer. Claude's
  host pastes a scheduled task's Fire URL and token on a private page. A
  ChatGPT or Muse task connects with `save_alert_routine` and no arguments, and
  reads new events with `get_updates`; touring's `get_state` warns once a
  published host's task hasn't checked in for two and a half hours.
- **Texts to the host.** On any chat the host can have urgent tour updates, or
  all of them, texted to their own phone with `save_host_texts`. A text never
  names a visitor. The host's own texts to the number never reach touring.
- **Templates.** `property-core-template/` is the one way to start: the Grok
  bot and its `claude/`, `chatgpt/`, and `muse/` versions. Touring's task in
  each is marked parked.

Touring open tasks:

- Live runs of touring on Claude, ChatGPT, and Muse on a Scratch tenant, Muse's
  first.
- A `verify-tourcore` skill, like `.cursor/skills/verify-cleanercore/`.
- Touring in-process: bring Tour Core up to Cleaner Core's per-request standard,
  then retire the touring processes.
- A second number per tenant, if both services should run at once.
