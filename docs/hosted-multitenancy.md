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
turn a tenant off, or delete it, and turn each feature on or off for an account (see Feature switches). The page lists each account's properties and
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
  A line pointed before voice gets its voice webhook once at startup. Two sign-ups never get
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
Cleaner Core (`cleaning`), Supply Core (`supplies`), and Fixer Core (`fixer`).
The account keeps the line, the secrets, the chats, and
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
a property only with the host's yes, and only for Grok Bot and Muse; Claude and ChatGPT get one plain line saying so. A property with it off
behaves exactly as before, and the host can turn it off, which cancels open
jobs after their yes. Each property keeps its pros, jobs, costs and visit
pages in its own folder, and the visit page answers only on its own property's
path. A pro on two properties needs the host's `shared: true`, and a pro who
texts is held in `people.json` beside the cleaner, with their own YES and STOP
for the account. The agent finds pros with its own search, since there's no
partner network in v1. Fixer Core never pays or takes a card, and the door
code reaches only the pro's own phone for the visit.
**Gates.** `docs/fixer-core-safety-gates.md`.

## Feature switches

The design is
`docs/superpowers/specs/2026-11-21-per-account-feature-switches-design.md`.
Each roadmap feature (#236) has its own switch per account on Saad's admin page, under Features on the
account's page. Every switch starts off. Only `/admin` changes one, behind its password; no agent tool can. Each
change is kept on the account with who changed it and when (`features` and `featureChanges` in `tenants.json`),
takes effect on the next request, and needs no redeploy. One account's switch never reaches another account.

Every check goes through `featureOn(account, feature)` in `src/features/features.ts`: the account's switch, then
`FEATURES_OFF` on the service, which shuts a feature off for everyone, then the service's credentials for locks
and cameras. A desk gets its own account's switches in its environment (`PROPERTY_CORE_ACCOUNT_FEATURES`, set per
request; the process's value is ignored) and asks the same rule with `deskFeatureOn`. The host's own
per-property yes still applies on top.

Always on, because it only records and sends nothing: the visit log. Cleaner Core and Fixer Core write each
property's `visit-events/<YYYY-MM>.jsonl` (append-only: each text to and from the cleaner, the host and pros, with
digit runs and the door code taken out and no phone number, and each visit window as it was set or moved). Lock
events reach it only with Connected locks on, and camera events only with Cameras on.

Behind each account's switch:

- **Visit records (`visits`).** `list_visits`, `visit_health` and `name_lock_code`, listed for every agent on the
  account when any property runs Cleaner Core or Fixer Core. Visit records are rebuilt from the log on every read.
  Only with a connected lock: a cleaner not in 30 minutes after the expected time (15 on a same-day turnover) gets
  one text, and the host one note when the next check-in is at risk, on a no-show, on a failed arrival-day check,
  or when the cleaner's code opens the door outside a cleaning; a pro or crew not in by the start plus 30 minutes
  is one Fixer Core news line. Routine vendor visits (a standing yes) and service notices need it too. Without a
  lock, nothing new is sent. The hours log uses measured visit times when a record has both ends. No tool writes a
  lock event: they come from the lock connection (#180).
- **Hours log (`hours`).** `review_hours`, `export_hours` and `save_hours_settings`, listed when any property runs
  a flow. The rows are rebuilt from the property's own records on every call; `hours.json` keeps only the host's
  settings and each month's confirmation, with the owner's actions it confirmed. Each flow keeps its own record of
  the host's approvals whatever the switch says, so an approval replaced before its month is confirmed still shows.
  It texts nobody and holds no Google or Microsoft token: the agent writes the host's own spreadsheet with its own
  connector. Owner rows come from the host's own standing lock code, on connected locks (#180).
- **Nightly stay check (`stay-check`).** `get_house_rules`, `save_house_rules`, `allow_for_stay` and
  `mark_flag_false`, listed when any property runs a flow. The agent saves a check only for a rule it read back and
  the host agreed to. `stay-check.json` keeps the rules, the check time, per-stay allowances and the sightings each
  kind needs after false flags. With Cameras on too, and Cleaner Core or Fixer Core at the property, the host-alert
  clock (#250) checks each night once, 30 minutes after its window closes (up to an hour while events are still
  being counted), and sends a flagged night through the account's Alerts routine; a clean night sends nothing.
- **Guest messages (`guest-messages`).** `get_guest_facts`, `save_guest_facts`, `read_guest_message` and
  `save_guest_reply`, listed when any property runs a flow, the guest-message instruction on connect, and Cleaner
  Core's `set_late_checkout`. Property Core returns the guest's words, the stay and the house facts that answer
  them, and the agent drafts a reply from only those. `guest-facts.json`, `guest-messages.jsonl` (append-only,
  door codes removed) and `guest-approvals.json` are in the property's folder. Nothing reaches a guest from
  Property Core: the host pastes each approved reply into Airbnb.
- **Package arrivals (`packages`).** `check_packages`, `mark_package_seen`, `plan_bring_in`, `mark_brought_in` and
  `save_package_settings`, listed when any property runs Supply Core. Expected deliveries are read from Supply
  Core's placed orders; `packages.json` keeps when each was seen and how, the bring-in visit and the host's
  bring-in settings. A package expected and not seen by 9 PM local on its day is flagged once: where Cleaner Core or
  Fixer Core runs at the property, the host-alert clock (#250) sends it through the account's Alerts routine.
  Without connected
  locks it texts nobody. With Connected locks on and the property on them, `approve_bring_in_code` is listed too,
  and the picked person (the cleaner, a co-host or an assistant who said YES) gets their own bring-in code for the
  window, by one text under the host's `release.packages` choice (ask by default).
- **Expected visits (`oversight`).** `add_expected_visit`, `list_expected_visits` and `cancel_expected_visit`,
  listed when any property runs a flow. The agent saves a visit only after reading it back and the host agreeing.
  `oversight.json` keeps the visits and when each was flagged. A visit with no entry is flagged the same day: 1 hour
  after its window, or at 8 PM for an all-day visit. It reads the visit log: unlocks and lock status only with
  Connected locks on and the property on them, camera sightings only with Cameras on; otherwise a visit is "can't
  tell". Where Cleaner Core or Fixer Core runs at the property, the host-alert clock (#250) runs the check every
  15 minutes from 7 AM local and sends a new flag through the account's Alerts routine, once.
- **Booking platforms (`booking-platforms`).** `save_sources` takes `bookingEmails` (Airbnb, Vrbo, Booking.com,
  the host's own site or Other, with each sender) and `shareSamples`; `get_state` and `check_now` return
  `bookingEmails` and `waitingBookings`; `read_booking_email` takes `extracted` and `email.authentication`; and the
  setup asks where the host takes bookings. An email from any platform but Airbnb is read only from its saved
  sender, and changes nothing until the host says yes to that booking. An email whose sender check fails changes
  nothing. Off, every property reads Airbnb's emails only, exactly as before.
- **Connected locks (`locks`).** Needs `SEAM_API_KEY` and `SEAM_WEBHOOK_SECRET` on the service. `get_locks`,
  `connect_lock`, `save_locks`, `lock_settings` and the standing code tools, listed when a property runs Cleaner
  Core or Fixer Core, and `POST /webhooks/seam` takes the partner's events for the account. A property switches to
  connected locks only with the host's yes, every door the cleaner and pros use connected, and a working alerts
  routine. Each cleaner and pro then gets their own code per visit, sealed in `door-grants.json` with the account's
  own server key. With the switch off, or a property not switched on, every door code works exactly as before and
  an event for the account is dropped. Turned on for an account only after the gates in
  `docs/cleaner-core-safety-gates.md` and `docs/fixer-core-safety-gates.md` are green and Saad okays it.
- **Guest codes (`guest-codes`).** Needs Connected locks on for the same account. `get_guest_codes`,
  `guest_codes`, `make_guest_code`, `guest_code_link` and the lease tools; the lock clock keeps each stay's code in
  step with `booking-emails.jsonl` and late checkouts, and `/locks/guest/<token>` serves the single-use page. Only
  a property on connected locks whose host chose automatic or ask gets guest codes; leases each take the host's
  yes. With it off, nothing changes.
- **Cameras (`cameras`).** Needs `CAMERA_TOKEN_KEY` and the three `RING_*` secrets on the service; counting also
  needs `CAMERA_DETECTOR_MODEL`. `connect_cameras`, `list_cameras`, `pick_cameras`, `disconnect_cameras`,
  `check_night`, `stay_timeline` and `pin_clip`, listed when any property runs a flow. `POST /webhooks/ring`,
  `/cameras/connect/<link>` and `/cameras/ring/linked` answer once some account has Cameras on, and each event or
  link is checked against its own account. The host signs in on Ring's own page; only the outdoor cameras they
  pick are read. `cameras.json` keeps the picks, the consent time and notes waiting for the host. No image is
  kept; a clip is copied to `evidence/` only when the host pins it. Camera offline and back-online notes go out on the
  host-alert clock (#250) through the account's Alerts routine, else wait for `list_cameras`. It texts nobody.

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
