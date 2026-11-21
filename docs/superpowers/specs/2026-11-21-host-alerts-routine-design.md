# Host alerts through the Alerts routine, on a clock

Date: 2026-11-21. Status: decisions taken by Saad on 21 Nov (below), built on
`claude/host-alerts-routine-250`. As-built notes at the end.
Issues: saadvz/PropertyCore#250 (test: one Grok bot or several), a child of
#236. Sends what #239, #240 and #241 already produce. Builds on the same-day
check (#254, #275, `2026-11-20-oversight-real-entries-design.md`), the nightly
check (#253, `2026-11-17-nightly-stay-check-rules-design.md`), the camera
adapter (#267, `2026-11-19-camera-adapter-design.md`), package arrivals (#257,
`2026-11-17-package-arrivals-design.md`) and the way Fixer Core reaches the
host (`2026-11-12-fixer-alerts-and-voicemail-design.md`).

## Why

Four features produce host alert text and send none of it, each "waiting on
#250":

| Kind | Producer | "Already told" record today |
| --- | --- | --- |
| Same-day flag (#240) | `OversightDesk.runDay(date, label)` returns `flags` with an optional `alert` | `flaggedAt` on each visit in `oversight.json`, written by `runDay` |
| Nightly stay check (#239) | `CameraDesk.runNight(date)` (camera events into #253's `checkNight`) returns `flags` with `alert` and `evidence` | **None.** `runNight` is a pure read |
| Package not seen by 9 PM (#241) | `PackageDesk.check()`, under `notSeen` | `notSeenTold` on the arrival in `packages.json`, written **by the listing tool** `check_packages` |
| Camera offline / back online (#239) | `dueCameraNotes`, through `CameraDesk.takeNotes()` | `told` ids in `cameras.json` |

#250 is a test of whether one bot or several should hold Property Core. It
will take a while. Meanwhile every account already has one path to the host
that works: the **Cleaner Core Alerts routine** (`CLEANER_CORE_BOOTSTRAP.md`
step 8, `cleaner-template/routines/cleaner-core-alerts.md`), an authenticated
webhook connected with `save_alert_routine`. Cleaner Core's host notes, Fixer
Core's notes and #180's lock notes already use it. So these alerts can go out
now through that routine, with a small routing point #250 can later point at
other bots.

## How the Alerts routine works today (what this reuses)

- The account's routine address and key are `CLEANER_CORE_ROUTINE_URL` and
  `CLEANER_CORE_ROUTINE_KEY` in the account's secrets. One per account, for its
  primary chat.
- **The wake-up carries no content.** Cleaner Core's `noteForHost(id, body)`
  keeps a host note in its engine (`keepHostNote`, once per id, refused if the
  body holds a door code) and queues one `cleaning.update` wake-up. The bot
  then calls `check_now`, whose `alerts` list carries the note text.
- Fixer Core does the same with `repairs.update`, and the note is read with
  `check_fixes`.
- #180's lock notes (`tellLockNote` in `src/hosted/locks.ts`) pick Cleaner
  Core's notes when cleaning runs at the property, else Fixer Core's.
- **With no routine connected,** a note still goes into Cleaner Core's notes
  (shown at the next scheduled `check_now`) or Fixer's news (shown at the next
  `check_fixes`). Nothing is lost; it waits until the host's chat checks.

## Proposal

### 1. One clock pass: `tickAllHostAlerts`

A new pass in `src/hosted/hostAlerts.ts`, on the service's existing 15-second
tick, after `tickAllCameras` (same pattern as #180's lock clock and #267's
camera tick: a reentry guard, every account and property, one property's
failure never stops the rest, nothing logged but ids).

For each property, each kind runs only with its own flag on, exactly as the
feature runs today:

| Kind | Runs when | Cadence |
| --- | --- | --- |
| `oversight` | `REMOTE_OVERSIGHT` and any flow on | Every 15 minutes, 7 AM to midnight local (a miss is due 1 h after its window, or 8 PM for an all-day visit). The desk runs today's date only, so the "Today at…" text is always sent the same day |
| `stay-night` | `CAMERAS` and `STAY_CHECK`, cameras picked, a checkable house rule, a stay that night | Looked at every 5 minutes; each night is checked once, 30 minutes after its window closes (decision 1) |
| `packages` | `PACKAGE_ARRIVALS` and Supply Core on | Every 15 minutes; a package is due at 9 PM local on its day, as #257 decided |
| `camera-health` | `CAMERAS` and cameras picked | Every tick (today's behaviour) |

The cadence is kept per property in memory (a restart just runs early once,
which is safe because every kind is exactly-once).

### 2. Exactly once: write the alert down before the producer marks it told

A per-property ledger, `host-alerts.json` (new, in the property folder):

```json
{ "alerts": [{ "id": "oversight:2026-11-21:v_ab12,v_cd34", "kind": "oversight", "text": "...", "keptAt": "...", "deliveredAt": "...", "via": "cleaning" }] }
```

- **Order on each pass:** compute the due alert read-only, keep it in the
  ledger (by id, so keeping twice is a no-op), then let the producer mark it
  told, then hand it to the routine. A restart between any two steps either
  re-finds the alert (not yet marked) under the same id, or re-delivers the
  ledger's undelivered entry. Never twice: the ledger id and the sink's own id
  (`keepHostNote` keeps an id once) both dedupe.
- **Reused "already told" records:** oversight's `flaggedAt` (via `runDay`),
  packages' `notSeenTold`, cameras' `told`. Only the nightly check gets a new
  one: `nights` in `host-alerts.json` itself, set for a night whether it was
  clean or flagged, so a night is checked and told once. Keeping it in the
  ledger leaves `stay-check.json` and its writers untouched.
- **Listing tools never use up an alert:**
  - `list_expected_visits` already never marks (since #275).
  - `check_night` stays a pure read.
  - `list_cameras` keeps showing only the notes this path couldn't hand over
    (today's `waiting` queue).
  - `check_packages` today **marks `notSeenTold` when it lists.** At a property
    where this path can deliver (below), it stops marking: a due package not
    yet told is listed read-only as `notSeenPending` ("Property Core tells the
    host"), and the clock is the only writer of `notSeenTold`. At a property
    where this path can't deliver (Supply Core alone), `check_packages`
    behaves exactly as today.
- The ledger keeps the last 200 entries per property.

### 3. The routing point

`src/host-alerts/routes.ts`:

```ts
export const ALERT_KINDS = ["oversight", "stay-night", "packages", "camera-health"] as const;
export type RoutineId = "alerts"; // the account's Cleaner Core Alerts routine; the only one today
export function routineFor(accountRoot: string, kind: AlertKind): RoutineId;
```

- Per account, `alert-routes.json` in the account folder:
  `{ "routes": { "<kind>": "<routine id>" } }`. Missing file, missing kind or
  an unknown routine id all mean `"alerts"`.
- No tool writes it and no second routine is built now. #250's answer adds a
  routine id (say, a camera bot's) and points `stay-night` and
  `camera-health` at it, without touching the producers or the clock.
- Each routine id has one sink. The `"alerts"` sink is the path #180's lock
  notes use: **Cleaner Core's `noteForHost` when cleaning runs at the
  property, else Fixer Core's `noteForHost` when Fixer runs there.** Both wake
  the same Alerts routine and both dedupe by id. Fixer's `noteForHost` is
  generalised from lock notes only to any host-alert kind, deduped by id.

### 4. No Alerts routine connected

As Cleaner Core and Fixer do today: the note is still kept, in Cleaner Core's
notes (shown at the next `check_now`, from the hourly Check routine or when the
host opens chat) or in Fixer's news (shown at the next `check_fixes`). The
ledger marks it delivered once the sink took it; the sink's own wake-up outbox
retries the routine. Nothing is dropped and nothing is sent twice.

**A property with neither Cleaner Core nor Fixer Core on** (Supply Core
alone) has no host-note path today. There the clock sends nothing: packages
stay with `check_packages` exactly as today, camera notes wait for
`list_cameras` as today, and the same-day and nightly checks stay read-only as
today. Listed as a follow-up (a `check_alerts` read for such properties), not
built here.

### 5. Safety

- **No door code, no digits of one, no phone number.** Every alert text goes
  through one guard (`src/host-alerts/guard.ts`) before it's kept in the
  ledger:
  - no run of 4 or more digits, after joining digits split by spaces, dots,
    dashes, underscores or slashes (`joinSplitDigits`), except inside the
    property's own label (a street number). Codes are 4 to 8 digits, so this
    covers every saved code without reading one;
  - nothing shaped like a phone number: a `+` and a digit, and 7 or more
    digits already fail the run rule.
  Clock times ("11:30 PM") are split by a colon and pass.

  A text that fails is never kept or sent. The ledger records a `withheld`
  entry with no text, the producer's mark still stands (so it isn't retried
  every tick), and the service logs only the kind and the property id.
  Cleaner Core's `keepHostNote` code check stays as a second line.
- **Only the host.** The sinks are host notes read in the host's own chat.
  Nothing in this path calls `sendLiveSms`, and no guest, cleaner or pro is
  reachable from it. A test asserts the path never calls the text sender.
- **Off by default.** No new flag: each kind runs only behind its feature's
  existing flag (`REMOTE_OVERSIGHT`, `STAY_CHECK` with `CAMERAS`,
  `PACKAGE_ARRIVALS`, `CAMERAS`). With those off, a property behaves exactly as
  before, including `check_packages`.
- **Tests** use the fake camera provider, the fake lock adapter, 555 numbers,
  made-up codes, and a stubbed routine fetch. No test talks to Seam, Ring or a
  real routine.

## Decisions (Saad, 21 Nov)

Saad took the recommended option on all three.

1. **The nightly check's run time, and quiet hours.** Window close plus 30
   minutes, no hold.
   - Run time: **when the night's window closes, plus 30 minutes for
     counting to finish.** The window already ends at the host's own saved
     check time (default 11 PM, asked in setup by #253), or at checkout on the
     stay's last night. If an event is still uncounted then, it waits up to 60
     minutes in all, then runs and lists that event as unchecked, never
     guessed.
   - Quiet hours: Property Core has **no host quiet-hours setting** today.
     Cleaner Core's quiet hours hold texts to the cleaner, not host notes.
     **No hold.** The alert is a note in the host's own chat, and an
     11 PM note about a party is the point of the check.
2. **One message per kind, or batched.** Separate notes, one wake-up: **each
   alert is its own note, but one wake-up per pass.** The bot reads every note due at that
   moment in one `check_now` and can say them together. The kinds rarely come
   due together (9 PM packages, the check time, hourly misses), and separate
   notes keep each one's exactly-once record simple.
3. **Camera offline notes.** **They move to this path only.** Today
   they go through Cleaner Core's host note when cleaning runs, else wait for
   `list_cameras`. The new path is the same Cleaner Core note, plus Fixer's
   note where Fixer runs, with the same `told` ids, so the host is told once.
   `tickAllCameras` keeps counting and stops sending.

## Host-facing wording

The same-day, nightly and camera alerts are the producers' own text,
unchanged. New wording, for the wording pass:

- **The package alert.** #257 had no alert text: `check_packages` listed the
  package and told the agent to word it. The clock needs one:
  > A package from Example Mart (Paper towels x2) was expected at 12 Scratch
  > Lane today, and nothing confirmed it arrived by 9 PM. Check its tracking.

  An earlier day reads "on Friday, November 20" instead of "today". More than
  three items end "and 2 more".
- **`check_packages`' next step** for `notSeenPending`: "Property Core tells
  the host about each package in notSeenPending through their alerts. Don't
  tell them again."
- **A log line** (operators only): "A <kind> alert for <account>/<property>
  was withheld: its text looked like it held a code or a phone number." 

## Gate rows to add

A new section in `docs/cleaner-core-safety-gates.md`, "Host alerts on a clock
(#250)", and a matching row in `docs/fixer-core-safety-gates.md` for Fixer's
generalised `noteForHost`:

- An alert holding a saved code, 4+ digits or a phone number is withheld, never
  kept or sent.
- Each alert is kept and handed over once, across a restart and a second run.
- A listing tool never marks an alert told.
- The path never texts anyone.
- With the four flags off, nothing runs and `check_packages` is unchanged.

## Out of scope

Sending to anyone but the host, new alert kinds (the late bring-in in
`check_packages` stays as it is), changing what any producer decides, a second
routine, and the alert wording itself.

## As built (21 Nov)

- `src/host-alerts/`: `routes.ts` (the routing point), `guard.ts`,
  `ledger.ts` (`host-alerts.json`), `clock.ts` (`runHostAlerts`: keep, mark,
  hand over) and `sources.ts` (one source per kind).
- `src/hosted/hostAlerts.ts`: `tickAllHostAlerts`, on the service's tick after
  `tickAllCameras` (`src/web/server.ts`). Cadence: same-day check every 15
  minutes from 7 AM local, packages every 15 minutes, the nightly check looked
  at every 5 minutes, camera health every tick.
- Producers: `OversightDesk.peekDay` (read-only `runDay`), `CameraDesk.dueNotes`
  / `markTold` / `nightWindow`, `PackageDesk.dueNotSeen` / `markNotSeenTold`
  and the `alertsByClock` dep, `FixerDesk.hostAlert` (a news item with a
  `noteId`, kept once, waking the routine). `tickAllCameras` only counts now.
- A kept alert no routine took within 48 hours is let go (`expiredAt`, text
  dropped): "Today at…" and "Tonight at…" don't keep.
- A camera note no routine took still waits for `list_cameras`, as before,
  including at a property where Cleaner Core runs but isn't active yet and
  Fixer Core doesn't run.
- The clock builds its own `PackageDesk`, not `packageDeskFor`'s cached one,
  which keeps the deps it was first made with (found by the hosted test).
  The camera webhook's package drop does the same now: before, a drop seen
  before any `check_packages` call made the cached desk without its door,
  sender and (now) `alertsByClock`.
- Gate rows: "Host alerts on a clock (#250)" in
  `docs/cleaner-core-safety-gates.md`, and "Host alerts (#250)" in
  `docs/fixer-core-safety-gates.md`.

## Follow-ups

- A property with neither Cleaner Core nor Fixer Core has no host-note path:
  a `check_alerts` read (or Supply Core's own news) would let the same-day and
  nightly alerts reach it.
- #250's answer: add a routine id and its sink, and point kinds at it in
  `alert-routes.json`, with a tool for the host to choose.
- The late bring-in flag in `check_packages` could move to the clock the same
  way, as a new kind.
- A positive same-day alert through the hosted path, on the fake lock adapter
  with a property switched to connected locks. The unit test runs the real
  desk on a visit log.
