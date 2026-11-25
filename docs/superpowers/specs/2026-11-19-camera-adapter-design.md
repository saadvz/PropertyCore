# Camera adapter: Ring events, our own counting, and what plugs into them

Date: 2026-11-19. Status: proposed, for Saad's review. Nothing is built yet.
Issue: saadvz/PropertyCore#239, project 4 of the verification roadmap (#236).
Builds on the nightly check (#253, `STAY_CHECK`), package arrivals (#257,
`PACKAGE_ARRIVALS`) and booking emails (#244). Shares #237's event log.

## Decisions already made

- **Ring's developer API is the product path** (#249, closed 19 Nov). The
  browser route is dropped.
- **Booking software is on hold** (19 Nov). Booking details come from emails
  (#244, #263).
- **Camera events go in #237's log** (Saad, 19 Nov): `camera` lines in the
  property's `visit-events/YYYY-MM.jsonl`, not a store of their own.
- **Counting uses a separate vision model our server calls**, not the host's
  agent (Saad, 19 Nov). It has to run with no chat open, give one accuracy
  number for every host whatever agent they use, and send snapshots to one
  named processor the host agreed to.
- **Hosts and agents see "Ring"** (Saad, 19 Nov). Code stays provider-neutral.
- **The counting test scores against the host's own review sheet** (Saad,
  19 Nov).

## What Ring's API offers (checked 19 Nov 2026)

Sources: developer.amazon.com/docs/ring/ (API documentation, release notes,
develop, publish, certify, developer FAQ, content policy) and Ring's support
page on third-party apps. To recheck at registration.

- **It exists as described, mostly.** The Ring Appstore API (also called the
  Partner API) has been generally available since April 2025 and is updated
  through Nov 2026. US only. The API reference says access is requested
  through a Ring AppStore partner representative.
- **Private app.** No certification, no public listing. The publish page and
  FAQ say up to **10** Ring accounts on its allowlist; a July 2026 release
  note says **5**. The portal will show which. A private app can't become
  public; a public one needs certification (a privacy and legal
  questionnaire, staging tests, a production account-link run).
- **Every linked account needs a Ring plan or trial.** A link without one
  fails with `ring_base_plan_required`. Which tier unlocks Smart Alerts
  labels isn't documented; Ring's plan page lists smart alerts from its
  lowest paid plan up. Hosts using the nightly check need a plan.
- **Auth.** OAuth 2.0. The host signs in on Ring's own page; we never see the
  password. Two link modes: Ring-driven (Ring sends a single-use code, valid
  60 seconds, to our account-link URL) and partner-started with PKCE (by
  invitation). Access tokens last about 4 hours; refresh tokens about 30
  days, and each refresh replaces the last. Ring asks that refresh tokens be
  encrypted at rest.
- **Events by webhook, with a poll to fill gaps.** Webhooks are signed
  (HMAC-SHA256 of the raw body, `X-Signature: sha256=<hex>`), must get a 200
  within 5 seconds, are retried for about an hour, then held 72 hours. Dedupe
  on `meta.request_id`. An event-history endpoint returns motion, ding and
  on-demand events, never before the host's consent date.
- **Event types:** `motion_detected`, `button_press`, `device_online`,
  `device_offline`, `device_added`, `device_removed`, link and plan changes.
- **Labels.** A motion event's `sub_type` is `motion` with Smart Alerts off,
  and `human`, `vehicle`, `package_delivery` or `other_motion` with it on.
  Ring says the set may grow. **No animal label, no counts**, and no call
  says whether Smart Alerts is on. Times come as epoch milliseconds and UTC
  ISO; the readable time has no zone.
- **Media.** A snapshot request returns a short-lived signed link, for times
  within the last 180 days. A clip request returns the MP4 itself, up to 15
  minutes per request. All media carries Ring's watermark. End-to-end
  encrypted cameras are hidden from the API. How long recordings are kept
  isn't documented; it follows the host's plan.
- **Health.** `device_offline` and `device_online` webhooks, and a status
  call that answers 503 for an offline camera.
- **Limits and policy.** 100 requests a second per app. Servers in data
  centres may need a registered outbound IP. Collect only what's needed,
  let the host delete their data, get explicit consent before any third
  party sees their data, no tracking across customers, face recognition
  only for people the customer enrolled.

## Why

The tester's nightly look at the lock and camera apps is the biggest block
of owner time. The nightly check (#253) already compares one night's events
with the booking and the house rules, on sample events. This project fills
those events from the host's real cameras, counts people, cars and animals
ourselves, and builds the test that tells us whether our counts are good
enough before any threshold is final.

## Goals

- A camera adapter we own. Ring is its first implementation; an in-memory
  fake serves every test. Nothing else in Property Core calls Ring.
- The host connects their Ring account on Ring's own page, from a one-time
  link their agent gives them, and picks which outdoor cameras belong to
  which property.
- Every camera event is stored as received, once, in #237's log.
- Snapshots are fetched when needed and not kept. Clips are kept by
  reference, and copied only when the host pins one as evidence.
- Our own count of people, vehicles and animals for each event the night's
  check needs, from the event's snapshot, stored as its own line next to the
  event.
- The nightly check reads real events for a property with cameras.
- A package seen on camera marks the expected delivery seen.
- A camera offline for 30 minutes is told to the host once, through the
  account's alerts routine, and again when it's back.
- A stay timeline from camera events, with lock events joined once #180
  writes them.
- The counting test harness, ready for a week of real events.
- Smaller items: the tool to mark a flag false, and pets read from booking
  emails.

## Not in this version

- Sending the nightly alert, and the nightly run on a clock. Both wait on
  #250, as in #253's design. The check can be run on demand.
- Final counting thresholds. The counting test comes first.
- Booking software, Fixer Core outdoor visits and invoice matching, noise
  sensors (#180), indoor cameras.
- Live use. It waits until Saad registers the private developer app.

## Anti-goals

- No face recognition, no identifying anyone. Counts only.
- No video copied into Property Core unless the host pins a clip.
- No snapshot kept after counting. Only the counts and the event's reference
  are stored.
- Ring credentials stay in environment secrets; a host's tokens are sealed
  in the tenant's secrets file. None in code, logs, tool replies or chat.
- No test talks to Ring. No test sends anything to a real phone.
- A property without a connected camera behaves exactly as today.
- No indoor camera is ever used. The host confirms each camera is outdoors.

## Approaches

1. **Our own adapter interface, Ring behind it, raw events in #237's log,
   counts as separate lines** (chosen). Swappable provider, one store, raw
   events never edited, counts rebuildable when the counter changes.
2. **Write counts into the camera line.** One line per event, but a
   recount would mean editing a stored line, which the log forbids.
3. **Call Ring at check time, store nothing.** No storage, but no timeline,
   nothing to replay, and the history endpoint stops at the consent date.

## Design

### Where it lives

A new folder, `src/cameras/`:

- `adapter.ts`: the `CameraProvider` interface and its types.
- `ring.ts`: the Ring implementation (HTTP only, behind the interface).
- `fake.ts`: the in-memory fake every test uses.
- `link.ts`: account linking, token refresh, sealed token storage.
- `webhook.ts`: verify, parse, map to camera lines, append.
- `counter.ts`: the `Counter` interface, the vision-model counter, a fake.
- `count.ts`: which events get counted, and the count lines.
- `night.ts`: camera lines plus count lines to the nightly check's
  `StayEvent[]`.
- `health.ts`: offline and back-online notes.
- `timeline.ts`: the stay timeline, pure.
- `desk.ts`, `tools.ts`: one property's desk and its tools.
- `countTest.ts`: the counting test's export and scoring.

On the shared service, `src/hosted/cameras.ts` lists and answers the tools,
the way `src/hosted/stayCheck.ts` does, and `POST /webhooks/ring` takes
Ring's events.

### The flag and the secrets

`CAMERAS=1` (or `true`), `camerasOn` in `src/cleaner-core/flag.ts`,
documented in `docs/environment-variables.md`. Off, no tool is listed, the
webhook route answers 404, and nothing changes.

Service secrets, environment only: `RING_CLIENT_ID`, `RING_CLIENT_SECRET`,
`RING_WEBHOOK_SECRET`, and `COUNTER_API_KEY` for the vision model. With any
Ring secret missing, connecting says Ring isn't set up yet.

### The adapter

```ts
interface CameraProvider {
  readonly name: "ring" | "fake";
  /** The URL the host opens to sign in on the provider's own page. */
  linkUrl(state: string): string;
  /** Trades the provider's code for tokens. Tokens go straight to the sealed store. */
  finishLink(code: string, state: string): Promise<LinkedAccount>;
  devices(account: AccountRef): Promise<CameraDevice[]>;
  /** Verifies and parses one webhook delivery. Unsigned or bad: undefined. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string>): CameraWebhook | undefined;
  /** Events since a time, to fill gaps. */
  history(account: AccountRef, device: string, since: string): Promise<CameraEvent[]>;
  /** A short-lived image for one moment. Never stored. */
  snapshot(account: AccountRef, device: string, at: string): Promise<Uint8Array>;
  /** Clip bytes for a range, only for pinning. */
  clip(account: AccountRef, ref: ClipRef): Promise<Uint8Array>;
  status(account: AccountRef, device: string): Promise<"online" | "offline">;
}

interface CameraEvent {
  /** The provider's own id, so a resent webhook is stored once. */
  id: string;
  at: string;                 // ISO, UTC
  device: string;             // the provider's device id
  kind: "motion" | "ding" | "online" | "offline";
  /** The provider's label as given: "human", "vehicle", "package_delivery", "other_motion", "motion". */
  label?: string;
}

/** A clip by reference: what to ask the provider for, never the video. */
interface ClipRef { provider: string; device: string; from: string; until: string }
```

`ring.ts` maps Ring's fields: `meta.request_id` to `id`, `meta.time` to `at`,
`attributes.source` to `device`, `sub_type` to `label`. Token refresh
happens inside `ring.ts`, which writes each new refresh token before using
the new access token, since Ring retires the old one.

### Connecting a host's cameras

- `connect_cameras` (agent tool): returns a one-time link under the
  property's path, valid 30 minutes, like the alerts-routine upload link.
- The link sends the host to Ring's sign-in page. Ring returns a code to
  `/cameras/ring/linked`; the server trades it for tokens and seals them in
  the tenant's `secrets.json` with the account's server key. The Ring
  account id maps to the tenant, for routing webhooks.
- Before the link, the page says, in plain words: Ring events and snapshots
  for the cameras the host picks are read by Property Core; snapshots are
  sent to our counting model (named) and not kept; clips stay at Ring unless
  the host pins one. The host ticks "I agree" before continuing. This is the
  consent Ring's content policy asks for.
- `pick_cameras` (agent tool): lists the account's cameras by name. The host
  names which belong to this property, and confirms each is **outdoors**.
  Only picked cameras are read; events from others are dropped unstored.
  One Ring account can serve several properties (the tester has two houses).
- `disconnect_cameras` deletes the sealed tokens and the device picks. Stored
  lines stay, as the log is append-only; the host can ask for a property's
  camera lines to be deleted, which is a support step, not a tool (Ring's
  policy asks for deletion on request).
- Saving a camera adds the per-property camera gate the nightly check's
  design left open: `get_house_rules` and the night's check read real events
  only for a property with cameras.

Which of Ring's two link modes fits a private app is checked at
registration; the interface is the same for both.

### Camera lines in #237's log

Written with `new VisitLog(propertyRoot, now).append(event)` from #237's
`src/visits/store.ts` (branch `claude/visit-records-237`): monthly
`visit-events/YYYY-MM.jsonl`, mode 0600, `loggedAt` added, a known id never
written twice, names and labels through the digit-run redaction. #237's
`CameraEvent` type is the line; the fields below are asked of #237 (sent 19
Nov) and marked *asked*:

```ts
{ type: "camera", id, at, device /* the host's name */, label?,
  kind /* asked: "motion" | "ding" | "online" | "offline" */,
  deviceId /* asked: the provider's id */, provider /* asked: "ring" */ }
```

- `id` is the provider's id; a resent webhook or a history fill adds
  nothing.
- No image, no clip, no link (signed links expire and are credentials).
  #237's optional `snapshot` and `clip` are never written by the adapter;
  they follow from `deviceId` and `at`.
- *Asked:* counts in their own `camera-count` line, not on the camera line,
  so a recount never edits a stored line:

```ts
{ type: "camera-count", id: "count:<eventId>:<counter>", event: eventId, at,
  counter: "vision-v1", people, vehicles, animals, confidence?: "low" }
```

  A recount with a new counter version is a new line. The newest counter's
  line wins when reading.
- *Asked:* a `camera-pin` line when the host pins a clip:
  `{ type: "camera-pin", id, at, event?, deviceId, from, until, file }`.

**Which flag writes.** #237 writes its log only while `VISIT_RECORDS` is on.
Camera lines need to be written whenever `CAMERAS` is on. **Decided (Saad,
19 Nov):** the store isn't gated; each writer checks its own flag (camera
lines `CAMERAS`, lock lines #180's, message and window lines
`VISIT_RECORDS`).

Until #237 is merged, `src/cameras/` writes through a one-method `EventLog`
interface that `VisitLog` satisfies, so the build isn't blocked on the merge.

### Webhook route

`POST /webhooks/ring`:

1. Verify the signature over the raw body. Bad or missing: 401, nothing
   read further, body not logged.
2. Map the Ring account to a tenant, the device to a picked camera and its
   property. Unknown: 200, dropped, logged without its body.
3. Append the camera line. Answer 200, all within Ring's 5 seconds.
4. After the answer: counting, the package sighting and the offline timer
   run off the stored line, never off the request.

A gap fill runs on the clock tick: per picked camera, `history` since the
last stored event, at most once an hour.

### Counting

Which events are counted:

- `motion` events labelled `human`, `vehicle`, `other_motion` or `motion`,
  on a picked camera, at a property with a checkable house rule, inside a
  stay (`stayForNight`). `other_motion` and `motion` are counted because
  animals have no label of their own.
- `package_delivery` and `ding` events are not counted.
- At most 60 counted events per property per night. Past that, events wait
  for the next tick, and the night's check lists the rest as uncounted.

How: fetch the snapshot at the event's time, send it to the counter, append
a `camera-count` line, drop the image.

```ts
interface Counter {
  readonly name: string;    // "vision-v1"
  count(image: Uint8Array, hint: { label?: string; local: string }): Promise<Counts>;
}
interface Counts { people: number; vehicles: number; animals: number; confidence?: "low" }
```

The vision counter asks one fixed model for whole-number counts of people,
vehicles and animals, as JSON, and nothing else: no description, no guess
at who anyone is. The model and its prompt are picked at build time and
named in the counter's version, and the counting test may change the pick.

A failed snapshot or count is retried twice, then left uncounted. The
night's check lists uncounted events under `unchecked`; it never guesses.

### The nightly check

`cameraEventsFor(root, window)` reads the window's camera and count lines
and returns the check's existing `StayEvent[]`:

- `source: "camera"`, `device` is the camera's name, `label` passed through.
- `counts` from the newest count line; an event with none has no `counts`.
- `snapshot` and `clip` as `MediaRef`s: the clip covers 30 seconds before to
  60 seconds after the event, by reference.

`runNight` uses these when the property has cameras and no events are passed
in. Nothing else in `check.ts` changes.

### Pets from booking emails

`guestsOf` in `src/hub/airbnbEmail.ts` also reads `N pet(s)`; `GuestCount`
gains `pets`, and `EmailStay` an optional `pets`. In `checkNight`, a stay
booked with a pet leaves the pets rule unchecked with the reason "booked
with a pet". A stay booked without one keeps the rule.

### Marking a flag false

`mark_flag_false` (agent tool): `{ property, kind }` after the host says a
flag was wrong. It calls `markFalse`, says how many sightings the kind now
needs, and never touches the allowed number. Listed with the nightly
check's tools.

### Packages

A `package_delivery` event on a picked camera calls package arrivals'
`markSeen` with `how: "camera"` when exactly one placed order is expected
at that property that day and not yet seen. With none or several, the
sighting is stored and `check_packages` shows "a package seen on camera at
2:10 PM" so the agent can ask the host which. Only while `PACKAGE_ARRIVALS`
is also on.

### Camera offline

- `device_offline` starts a 30-minute timer for the camera; `device_online`
  stops it.
- Still offline at 30 minutes: one note to the host through the account's
  alerts routine (the same webhook sink Fixer Core and #180's lock alerts
  use): "The Front door camera at Lake House has been offline since 2:10
  PM." One more when it's back. Each note has an outbox id, so a replay or
  restart sends nothing new.
- No alerts routine: the note waits for the host's next chat, as today.

### Stay timeline

`stayTimeline(lines, stay, timeZone)` is pure: every camera event (with its
counts) and, once #180 writes them, every lock event, from the stay's
check-in time to its checkout time, in local time, oldest first.
`stay_timeline` (agent tool) returns it for one stay by check-in date, as
text ready to paste into a claim, with clip references the host can pin.
`pin_clip` copies one clip into the property's `evidence/` folder, with a
line in the log saying who pinned it and when. That's the only video
Property Core ever keeps.

### The counting test harness

Run from the command line on the server, not through an agent:

- `npm run cameras:count-test -- export --property <id> --from <date> --to <date>`
  writes a CSV, one row per counted event: event id, local date and time,
  camera, Ring label, day or night, our people, vehicles and animals, and
  empty columns for the host's numbers and a note. No images, no links. The
  host finds each event in their own Ring app by camera and time, as they do
  in their nightly review today.
- `... score --file <filled.csv>` reads it back and reports, for people,
  vehicles and animals, day and night apart: exact matches, within one,
  over-counts, under-counts, and the **night peak** (the most in one event
  each night, which is what the check uses) compared to the host's.
- Night is sunset to sunrise at the property, from its time zone and a
  fixed table by month, so no outside call is needed.
- The report is what the issue's acceptance criterion records. Thresholds
  stay as they are until it's read.

### Tools

All behind `CAMERAS` and, where noted, the property having cameras. Each
takes `property`.

- `connect_cameras`, `pick_cameras`, `disconnect_cameras`, `camera_health`
  (picked cameras, online or not, last event time).
- `stay_timeline`, `pin_clip` (with cameras).
- `mark_flag_false` (with `STAY_CHECK`).

## New safety gates

Added with their tests. Row "Cameras" in
`docs/cleaner-core-safety-gates.md`: behind `CAMERAS`. No test reaches Ring
or the counting model. Webhooks are verified before reading. Raw camera
lines are written once and never edited. No image is stored; no clip is
copied unless pinned. No token, secret or signed link in a log, a tool
reply or a stored line. Only picked, outdoor cameras are read. A property
without cameras is unchanged. Offline notes go once each, through the
alerts routine.

## Testing

All on the fake provider and fake counter:

- `test/camerasRing.test.ts`: Ring's payloads (recorded shapes, made up)
  map to camera events; signature check passes and fails; token refresh
  saves the new refresh token first. HTTP is stubbed.
- `test/camerasLink.test.ts`: the one-time link, consent, sealed tokens,
  picking cameras, outdoor confirmation, disconnect.
- `test/camerasWebhook.test.ts`: append once per id, unknown account or
  device dropped, unsigned refused, nothing slow before the 200.
- `test/camerasCount.test.ts`: which events are counted, the nightly cap,
  retries, recount lines, newest counter wins, no image kept.
- `test/camerasNight.test.ts`: lines to `StayEvent[]`, `runNight` on a
  property with cameras, uncounted events listed.
- `test/camerasPackages.test.ts`, `test/camerasHealth.test.ts`,
  `test/camerasTimeline.test.ts`, `test/camerasCountTest.test.ts`.
- Additions to `test/airbnbEmail*.test.ts` (pets) and
  `test/stayCheckNight.test.ts` (booked with a pet), and
  `test/stayCheckTools.test.ts` (`mark_flag_false`).

Made-up data only: 555 numbers, made-up codes, made-up device ids.

## Open choices for Saad

1. **Which link mode.** Ring-driven or partner-started, whichever the
   private app gets at registration. The design works with either.
2. **The counting model.** Picked at build time and tested in the counting
   test. Snapshots go to that one model's provider, named on the consent
   page.
3. **Numbers.** 60 counted events a night, 30-minute offline wait, clip
   from 30 seconds before to 60 after.
4. **Flag name.** Proposed `CAMERAS`.
5. ~~Which flag writes the shared log.~~ Decided 19 Nov: each writer's own
   flag; camera lines under `CAMERAS`.

## Left to the builder

- Wording beyond the examples, in the repo's plain style.
- File split inside `src/cameras/`.

## As built (19 Nov)

On branch `claude/camera-adapter-239`, merged with `claude/visit-records-237`
(PR #264) so camera lines go through its `VisitLog`. All on the fake provider
and fake counter; nothing has talked to Ring.

- **Where:** `src/cameras/` (`adapter`, `ring`, `fake`, `accounts`, `webhook`,
  `counter`, `count`, `night`, `health`, `timeline`, `desk`, `tools`,
  `countTest`, `countTestCli`, `sharedLog`, `lines`) and `src/hosted/cameras.ts`.
- **Tools:** `connect_cameras`, `list_cameras` (devices, picks, online status,
  and notes to tell the host once), `pick_cameras`, `disconnect_cameras`,
  `check_night` (the nightly check on demand), `stay_timeline`, `pin_clip`.
  `mark_flag_false` is with the stay-check tools.
- **Routes:** `POST /webhooks/ring`, `GET/POST /cameras/connect/<link>` (the
  consent page, then a redirect to Ring), `GET /cameras/ring/linked` (Ring's
  return). 404 unless `CAMERAS` is on and Ring's secrets are set.
- **Secrets:** `CAMERA_TOKEN_KEY` seals tokens (AES-256-GCM) in the account's
  `secrets.json` under its own slot. `RING_CLIENT_ID`, `RING_CLIENT_SECRET`,
  `RING_WEBHOOK_SECRET` come from the developer portal.
- **Sign-in:** built for Ring's partner-started PKCE flow (`state` ties the
  return to the one-time link). If the private app gets only the Ring-driven
  mode, `linkUrl` and the return route change; nothing else does.
  (25 Nov: it did. The private app gets the Ring-driven mode; see
  `2026-11-25-ring-account-linking-design.md`, #302.)
- **Webhook routing** is by device id to the property that picked it; the
  Ring account id isn't stored. A Ring "app removed" webhook is logged; the
  next call then says Ring needs connecting again.
- **History fill** (`history` in `ring.ts`) is built but not on the clock yet:
  Ring's history gives no labels, so filled events would be counted as plain
  motion. Turn it on once a live test shows how often webhooks are missed.
- **Notes:** an offline note goes through Cleaner Core's host note when
  cleaning runs at the property; otherwise it waits for `list_cameras`. No new
  alerts-routine event type was added.
- **Counting: an open-source detector on our own server** (Saad, 19 Nov). A
  Gemini 4 Neon counter was built first, then removed at Saad's ask: no API
  key, no third party, free. RF-DETR Medium (Apache-2.0, COCO) from
  `onnx-community/rfdetr_medium-ONNX` at a pinned revision and SHA-256, run with
  `onnxruntime-node` on the CPU (`src/cameras/detector.ts`); stills decoded
  with `jpeg-js`. People are COCO's person; vehicles are car, motorcycle, bus
  and truck; animals are cat and dog only (birds and wildlife would trip a
  no-pet rule). Same-class boxes overlapping over 0.7 IoU count once. A count
  with a box within 0.1 of the threshold is marked low-confidence. Cloudflare
  Workers AI (only DETR-ResNet-50, 2020) and Vercel Functions were looked at
  and not chosen; the detector sits behind the same `Counter` hook, so it can
  move to either later.
- **First run on six public photos** (Wikimedia Commons, 19 Nov), at the 0.35
  default: two dogs right; a street of 5 cars right with 1 of 2 half-hidden
  people; 10 of about 12 cars at dusk; 2 soldiers in green night vision right;
  a near-black silhouette missed. 0.5 under-counted (5 cars at dusk); 0.25
  saw people who weren't there. About half a second a still on this
  container's CPU. Too few images to set the threshold: the counting week does.
- **Consent page** now says stills are counted by an open-source detector on
  Property Core's own server and never sent to anyone else.
- Each counter counts every event once on its own, and the night's check reads
  only the service's counter, so a second counter can run beside it for the
  counting week. `--counter` picks one for the sheet.
- **Pets:** `GuestCount.pets` and `EmailStay.pets` from "N pets / dogs /
  cats"; a stay booked with a pet leaves the pets rule unchecked. Camera events
  with no count yet are listed in `unchecked`, never guessed.
- **Packages:** `PackageDesk.cameraSighting`; an unmatched sighting is kept
  in `packages.json` and `check_packages` lists it as `cameraSightings`.
- **Counting test:** `npm run cameras:count-test -- export|score`, reading the
  shared log read-only.

## Counting week, as built (25 Nov)

- **Every event for 7 days.** Counting was only inside a stay with a camera
  rule, so a week with no booking counted nothing. Decided 25 Nov: the
  counting test counts every motion event on the picked outdoor cameras for 7
  days, day and night, whatever the calendar. `counting_week` starts it only
  after the host agrees to a read-back in chat, and `stop` ends it early. The
  window is saved in `cameras.json` as `countingWeek`; a night in it counts up
  to 200 events instead of 60.
- **The review sheet** downloads from the account's /admin page
  (`/admin/tenants/<id>/count-sheet?property=<id>`, the week's days by default,
  `from`/`to` for others): one row per counted event, camera name and local
  time, empty host columns. Scored with `cameras:count-test -- score`.
- **On the service** the model download and the sheet commands are built into
  `dist/` (`node dist/getDetectorCli.js`, `node dist/countTestCli.js`), since
  Railway doesn't install `tsx`.
- **Online state (#302).** `list_cameras` asked Ring only about picked cameras,
  so right after linking it said nothing. It now reads every camera's state from
  `GET /v1/devices?include=status`, falls back to the status call, and says
  `unknown` rather than online when Ring doesn't say.
