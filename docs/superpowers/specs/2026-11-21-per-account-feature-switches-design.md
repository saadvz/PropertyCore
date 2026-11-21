# Per-account feature switches

Saad, 21 Nov. Replaces the service-wide roadmap flags (#236) with one switch per feature per account, on `/admin`.

## Why

Each roadmap feature was a Railway variable (`VISIT_RECORDS`, `HOURS_LOG`, `STAY_CHECK`, `GUEST_MESSAGES`,
`PACKAGE_ARRIVALS`, `REMOTE_OVERSIGHT`, `BOOKING_PLATFORMS`, `SMART_LOCKS`, `GUEST_CODES`, `CAMERAS`, `FIXER_CORE`).
Each one was on or off for every account at once, and each change was a redeploy. Saad wants far fewer Railway
variables, and to turn a feature on for one account, such as his tester, without turning it on for every host.

## Saad's decisions (21 Nov)

| Question | Answer |
| --- | --- |
| Fixer Core's flag | Goes away. Fixer Core is offered to every account on Grok Bot and Muse. Each property still starts with it off, until the host's yes. |
| Emergency off switch | Yes: `FEATURES_OFF`. |
| Old flags set on Railway | `FIXER_CORE` only. |
| Guest codes | Their own switch, which needs Connected locks on for the same account. |

## The rule

`featureOn(account, feature, env)` in `src/features/features.ts` is the one rule. A feature is on for an account
only when all of these hold:

1. The account's own switch for it is on. Every switch starts off.
2. `FEATURES_OFF` on the service doesn't name it (or `all`).
3. For `locks`: `SEAM_API_KEY` and `SEAM_WEBHOOK_SECRET` are set. For `cameras`: a valid `CAMERA_TOKEN_KEY` and
   `RING_CLIENT_ID`, `RING_CLIENT_SECRET` and `RING_WEBHOOK_SECRET` are set.
4. For `guest-codes`: `featureOn(account, "locks")` too.

`featureState` gives the same answer with the reason, for `/admin`. Code that reaches a lock still also checks
that the lock adapter is set, since that's the object it calls.

## Where switches live, and who changes them

- `tenants.json`: `features` on each account, `{ on, changedAt, changedBy }` per feature, and `featureChanges`,
  the last 100 changes (feature, on, at, by), oldest first.
- Only `/admin` changes a switch: `POST /admin/tenants/<id>/features` with `feature` and `on` (`1` or `0`), behind
  the admin password, a session and the form's token. `TenantRegistry.setFeature` is called from nowhere else. No
  agent tool reads or writes it, and nothing a chat passes reaches it.
- `changedBy` is `admin`: `/admin` has one shared password, so there's no per-person name to record. The change
  time is the service clock's. Each change is also a log line naming the account and the feature, never a secret.
- A change takes effect on the next request: switches are read from `tenants.json` on every call, and each desk's
  environment is rebuilt per request. No redeploy.

## Code that only holds an environment

The desks (Cleaner Core, Fixer Core, door access, the lock and guest-code desks) get an environment, not an
account. `buildTenantEnv` writes the account's own switches that are on under `PROPERTY_CORE_ACCOUNT_FEATURES`.
`deskFeatureOn(env, feature)` reads them back and applies `featureOn` to them, so the rule is the same function.

- The process's value of that name is dropped (it's a per-tenant name), so a Railway variable can't turn a feature
  on for every account.
- An account's saved secrets can't replace `FEATURES_OFF`, the lock credentials or Ring's: `buildTenantEnv`
  drops those names from the account's secrets before using them.

## The split

**Always on: records only, sends nothing, and the agent sees nothing new.**

| What | Where |
| --- | --- |
| The visit log: each text in and out, each visit window as it's set or moved, Fixer Core's visit-page steps | `visit-events/<YYYY-MM>.jsonl` in the property's folder, written by Cleaner Core and Fixer Core |

**Behind the account's switch: anything that changes what the host's agent shows, lists or asks, or that sends.**

| Switch | Covers |
| --- | --- |
| `visits` Visit records | `list_visits`, `visit_health`, `name_lock_code`; the late-cleaner text and the host's visit notes; Fixer Core's late-pro and stray-code news lines; routine vendor visits (the standing yes, the proposal text, the confirmation); service notices |
| `hours` Hours log | `review_hours`, `export_hours`, `save_hours_settings` |
| `stay-check` Nightly stay check | `get_house_rules`, `save_house_rules`, `allow_for_stay`, `mark_flag_false` |
| `guest-messages` Guest messages | The guest tools, the agent's guest-message instruction, and `set_late_checkout` |
| `packages` Package arrivals | The package tools; with `locks` on too, `approve_bring_in_code` and the bring-in code text; a camera's package sighting |
| `oversight` Expected visits | `add_expected_visit`, `list_expected_visits`, `cancel_expected_visit` (lock lines read only with `locks` on, camera sightings only with `cameras` on) |
| `booking-platforms` Booking platforms | `bookingEmails` and `shareSamples` on `save_sources`, the platforms setup question and instruction, the sender check, and routing other platforms' emails |
| `locks` Connected locks | The lock tools, the partner's events, per-visit codes, standing codes and their pages, the lock clock |
| `guest-codes` Guest codes | The guest-code tools, each stay's code, leases, and the guest page |
| `cameras` Cameras | The camera tools, the consent link and Ring's sign-in return, Ring's events and the camera clock |

Fixer Core and voicemail have no switch. Each property's own flow switch (off until the host's yes) is the gate,
as for Cleaner Core and Supply Core.

The host's own per-property yes still applies on top of every switch: a property switches to connected locks only
with the host's yes, picks its cameras, saves its own rules.

## Locks and cameras on the service

The routes that belong to the service, not an account (`POST /webhooks/seam`, `POST /webhooks/ring`, the camera
consent and return pages), answer 404 until some account has the feature on. Each event, link or page is then
checked against its own account: an event for an account with the switch off is dropped, and a link for one is
refused.

Turning Connected locks off for an account stops its lock clock too, as turning `SMART_LOCKS` off did for everyone:
a per-visit code already on a lock stays there until the lock partner's own end time, and nothing revokes it early.
Turn it off only once the host has switched the property back to saved codes, or with no visit under way. The lock adapter is set at startup when both Seam secrets are set; with only the key, startup says so
and locks stay off.

## Emergency off switch

`FEATURES_OFF` lists feature names, comma-separated, or `all`. Any feature it names is off for every account,
whatever `/admin` says, from the next request. Startup logs what it shuts off and any name that isn't a feature.
`/admin` shows each switch's state as "off for every account: FEATURES_OFF names it". It can't turn anything on,
and it doesn't stop the visit log.

## Moving over

Only `FIXER_CORE` is set on Railway, and Fixer Core now needs no flag, so no account loses a running feature and no
switch needs carrying over: every other feature was off for every account, and every switch starts off. Startup
logs any retired flag that's still set, so a forgotten one shows up; nothing reads its value.

What changes on the first deploy:

- Fixer Core and voicemail: unchanged, since `FIXER_CORE=1` was set.
- The visit log starts being written on every property with Cleaner Core or Fixer Core. It sends nothing and lists
  nothing.
- Every other feature stays off until Saad turns it on for an account on `/admin`.

## Tests

`test/featureSwitches.test.ts`: the rule (off by default, credentials, guest codes need locks, `FEATURES_OFF`),
the desk environment (each account's own switches, never the process's or a saved secret's), the registry
(who and when, the kept history), one account's switch never reaching another, only `/admin` changing a switch,
and a change taking effect without a restart. Each feature's own tests turn its switch on with
`test/featureEnv.ts`, which holds only made-up credentials.

## Coordination

The alerts work (#250) merged as #277 while this was open. Its host-alert clock now checks the account's own
`oversight`, `stay-check`, `packages` and `cameras` switches with `featureOn`, instead of `REMOTE_OVERSIGHT`,
`STAY_CHECK`, `PACKAGE_ARRIVALS` and `CAMERAS`. The wording pass merged as #274 before this; no Muse guest-code branch was pushed.
