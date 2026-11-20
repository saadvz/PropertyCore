# Remote oversight on real entries: quiet locks and camera support

Date: 2026-11-20. Status: decisions taken by Saad on 20 Nov (below), for build
on `claude/oversight-real-entries-240`.
Issue: saadvz/PropertyCore#240, a child of #236. Builds on the expected visits
and same-day check (#254,
`2026-11-17-remote-oversight-expected-visits-design.md`), the visit log
(#237, `2026-11-19-visit-records-design.md`), the lock connection's lines
(#180, #266) and the camera adapter's lines (#239, #267).

## Why

The same-day check runs only on sample entry events: nothing outside the tests
calls it. Real unlocks, lock status and camera events are now in the property's
visit log. Three gaps stand between them and an honest flag:

- An unlock with the host's, a guest's or a co-host's code comes out unnamed,
  and the check counts an unnamed entry as the visit. A guest letting
  themselves in would count as Mike's walk-through.
- A lock that's offline or disconnected reports nothing, and "nothing" reads
  as "nobody came".
- A camera that saw someone at the door isn't used at all.

## Decisions (Saad, 20 Nov)

1. **Codes by role.** The cleaner and a pro by name, a standing code by its
   person's name. The host's and a guest's code are someone else: never the
   visit, but named in the alert. A code with no name, or a role not known yet
   (the bring-in and crew-day codes another session is adding), counts as
   unnamed, as today.
2. **No connected lock: "can't tell".** A property without connected locks
   gets a new outcome, `unknown` (`no-lock`), and no miss alert. Sample entry
   events stay in tests only, as `checkDay`'s input.
3. **Cameras support, never confirm.** A person seen on a picked outdoor
   camera in the window is attached to the visit's entry as support. With no
   entry, it doesn't make the visit `came`: the alert says what the camera saw.
4. **"A person seen"** is our own count when the event has one (people 1 or
   more), else Ring's `human` label; a doorbell press counts too. Counting
   stays as #239 built it, inside stays only.
5. **Not in this branch:** camera departures in #237's records, and named
   entries with time on site. Each is a follow-up.

## Not in this version

- Sending the flag to the host, and the scheduled same-day run (#250, test).
- The turnover check, the manager's log, empty-house sensor alerts.
- Any change to what is written to the visit log: this only reads it.

## Design

### Reading the evidence

A new pure module, `src/oversight/evidence.ts`:

```ts
dayEvidence(events: readonly VisitEvent[], input: {
  codeNames: CodeNames;
  names: EntryNames;          // cleaner, pros by id, standing code names
  locks: boolean;             // the property is switched to connected locks
  cameras: boolean;           // CAMERAS is on
}): Evidence

interface Evidence {
  lock: boolean;
  entries: EntryEvent[];      // every unlock, named by role (decision 1)
  quiet: QuietSpan[];         // when a lock couldn't report
  sightings: Sighting[];      // people seen on a camera (decision 4)
}
interface QuietSpan { from: string; until?: string; device?: string; why: "offline" | "disconnected" }
interface Sighting { at: string; device: string }
```

- **Entries.** `entryEventsFrom` grows a role-aware mapping: `cleaner` and
  `pro` as today; `shared` by the standing person's name when known (else
  unnamed); `host` and `guest` set a new `party` field on `EntryEvent`
  (`"host"` or `"guest"`) and no `person`. An unknown role is already dropped
  by `visit-codes.json`'s reader, so its unlocks stay unnamed.
- **Names** come from the log and the property folder, never from a guess:
  the cleaner's and each pro's name from their latest `visit-window` line's
  `who`; a standing code's person from `door-grants.json` (`flow:
  "standing"`, its `codeName` and `label`; the sealed code is never read).
- **Quiet spans.** A `lock-status` `offline` opens a span for its device and
  the next `online` for that device closes it. A `lock-connection` with
  `connected: false` opens a span for every door until the next `true`. A span
  still open has no `until`.
- **Sightings**, only with `cameras`: each `camera` line that is a `ding`, or
  a `motion` whose latest count has people 1 or more, or, with no count, Ring's
  label `human` (any case). Offline and online lines are never sightings.
- With `locks` false, `lock` is false, and entries and quiet spans are empty.

### The check

`checkDay` takes the evidence's fields beside the visits:
`{ entries, lock?, quiet?, sightings? }`. `lock` defaults to true, so the
existing pure tests on sample entries keep their meaning.

Per visit, in this order:

1. A matching entry in the counting window (or late, before midnight):
   `came`, as today. Host and guest entries never match. Sightings in the
   counting window are attached as `seen`.
2. No lock: `unknown`, `why: "no-lock"`. Not alerted.
3. Before the flag time: `waiting`.
4. A quiet span overlaps the counting window: `unknown`,
   `why: "lock-quiet"`, with the spans. Alerted once, like a miss.
5. Otherwise `missed`.

Every result carries `sightings` in the counting window. `others` now holds
host and guest entries too, as `{ at, party }`.

`DayResult` keeps its three statuses. `flags` now carries `missed` and
`unsure` (the `lock-quiet` visits); the alert holds both, only those not
flagged before. `flaggedAt` is recorded for both, so neither is told twice.

### Alert wording (for the wording pass)

- Lock quiet: "Mike Doyle was expected between 1 PM and 5 PM (walk-through).
  The Front door lock couldn't report from 12:40 PM to 3 PM, so I can't tell if
  anyone came in." A disconnected account reads "The lock connection was off
  from …". An open span reads "since 12:40 PM".
- Sighting with a miss or a quiet lock: "The Front porch camera saw someone at
  2:10 PM."
- Host or guest code in the window: "The door was opened at 2:10 PM with the
  host's code." / "… with a guest's code."

### The desk and the tools

- `runDay(date, label)` reads the property's visit log and builds the
  evidence itself. The old `runDay(date, entries, label)` is gone: nothing
  outside tests called it.
- `OversightDeps` gains `locks(): boolean` (the property's door access is
  connected: `SMART_LOCKS` on and switched to connected locks) and
  `cameras(): boolean` (`CAMERAS` on). Both default to false.
- `list_expected_visits` adds `results` for today's and the last week's
  visits: the check's outcome for each, read-only. It never records
  `flaggedAt`, so listing can't swallow a flag #250 hasn't sent.

## Anti-goals

- No entry, sighting or quiet span is made up; only stored lines are read.
- A host or guest code never counts as the expected person.
- A camera sighting never turns a visit into `came`.
- A lock that couldn't report never reads as "nobody came".
- Nothing is sent; nothing is written to the visit log.
- No code, digits or phone in a result or the alert.

## Safety gate

A row "Expected visits on real entries" in
`docs/cleaner-core-safety-gates.md`: behind `REMOTE_OVERSIGHT`; lock evidence
only on a property switched to connected locks, camera evidence only with
`CAMERAS`. A host or guest code never counts; a quiet lock is "can't tell",
never a miss; a sighting is support only; no lock is "can't tell" with no
alert; each flag once; listing records nothing; nothing sent.

## Testing

All on made-up lines, 555 numbers and made-up codes; nothing talks to the
lock partner or Ring:

- `test/oversightEvidence.test.ts`: role mapping (cleaner, pro, standing by
  name, host, guest, unknown role, unnamed), quiet spans from offline/online
  and connection lines, open spans, sightings from count, label and ding,
  cameras off gives none, locks off gives nothing.
- `test/oversightCheck.test.ts` additions: host and guest entries don't
  count and appear in the alert; no-lock `unknown` with no alert; quiet lock
  `unknown` in the alert, once; a quiet span outside the window doesn't
  matter; an entry wins over a quiet span; sightings attached and named in
  the alert; a sighting never makes `came`.
- `test/oversightDesk.test.ts`: `runDay` from a real log in a temp folder,
  standing names from `door-grants.json`, `list_expected_visits` results that
  record nothing.
- `test/oversightHosted.test.ts`: the flags reach the desk.

## As built (20 Nov), after review

An independent review found three cases the first build got wrong. Fixed,
each with tests:

- **Only doors go quiet.** Thermostats and noise sensors write the same
  `offline` lines. Only the property's saved door locks (by name, as the log
  writes them) open a quiet span.
- **A quiet span ends when the door reports.** Besides `online`, the door's
  next lock or unlock line closes its span, so a lost `online` webhook doesn't
  make every later miss "can't tell". A door removed or renamed isn't a door any
  more, so its old span is dropped.
- **The lock switch is read per window.** The host's own switch lines
  (`pc-locks:on`/`off`, from `save_locks`) give the stretches the property was
  on connected locks. A window outside every stretch is `no-lock`. A window the
  switch falls inside is "can't tell" for the part outside it. The lock
  partner's own disconnect is still a quiet span. With no switch lines in the
  log, the property's state now stands for every day. So a past day is still
  checked after the host switches off, and a day before the switch-on isn't
  called missed.
- **A span from another day gives its day** in the alert ("since 12:40 PM on
  Tuesday, Nov 17").
- `OversightDeps` is now `locks` (SMART_LOCKS on with a lock connection: the
  lines can be read), `lockedNow` (switched on now, the fallback above),
  `doors` and `cameras`.
