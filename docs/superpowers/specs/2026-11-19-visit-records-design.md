# Visit records: arrival, departure and time on site

Date: 2026-11-19. Status: approved by Saad on 19 Nov with every recommendation
below, and built on `claude/visit-records-237`. "As built" at the end lists
where the build differs from the first draft.
Issue: saadvz/PropertyCore#237, project 2 of the verification roadmap (#236).
Target: the first January 2027 turnover.

This covers the turnover and Fixer-visit parts of #237. The vendor-visit part
(a vendor confirming or moving a window by text, completed-service notices)
waits on the Butler-or-Fixer decision in #245. Camera evidence waits on #239's
Ring adapter. Real lock events wait on #180. Everything here runs on stored
and fake lock events.

## Why

Property Core knows when a visit was scheduled, not when it happened. The
tester's hours log counts each turnover as a flat 2 hours. A late cleaner or a
no-show shows up only when the next guest arrives. With a lock that reports
which code opened the door, the visit can be measured. Without one, the
cleaner's own texts keep doing what they do today.

## Decisions already made

- **A late cleaner is texted first** (16 Nov). The host hears only when the
  next check-in is at risk.
- **Departure comes from DONE**, the cleaner's text or the pro's "done", checked
  against the next lock-from-outside event. Each departure records its source,
  so camera evidence from #239 can replace it later (#249 closed 19 Nov).
- **No lock-partner code.** This design has its own small lock-event type at the
  boundary. #180's adapter maps into it later.
- **Off by default** behind a service flag, like the other roadmap work.

## Goals

- An append-only event store per property: lock events, every message to and
  from the cleaner, the pros and the host about a visit, and every visit
  window as it was set or moved. Lines are written once and never edited.
- Visit records are derived from that store by a pure function, and can be
  rebuilt at any time, including after a rule changes.
- For every cleaning and Fixer visit: an arrival, a departure with its source,
  and the time on site.
- For each multi-day crew job: one attendance record per workday window.
- Flags: no-show, late arrival, entry outside the window. Each one leads to at
  most one host note, and the late-clean step texts the cleaner first.
- A shorter late threshold for same-day turnovers.
- Arrival-day readiness: before the next check-in, the clean is DONE and the
  stay's start is clear.
- A property without a connected lock behaves exactly as today.

## Not in this version

- Lock-partner code, lock webhooks, per-person codes (#180).
- Camera evidence (#239). The departure source leaves room for it.
- Vendor visits: windows by text, a vendor's code moving with the window,
  completed-service notices (#245).
- Checking the cleaner's photos against the listing standard. It belongs with
  #239's photo work, and nothing here needs it. (My call; say if you want it
  here.)
- Sending anything about a visit to the host through a bot other than the one
  that already reaches them today.

## Anti-goals

- No lock event, arrival or departure is ever made up. No tool lets an agent
  add a lock event. Only code writes them: #180's adapter, tests and the
  Scratch CLI.
- The store never holds a door code, a code's digits or a full phone number.
- A raw line is never edited or deleted to fix a record. A rule change is a new
  derivation, not a rewrite.
- A property without a lock gets no new text, no new note and no change to its
  hours log.
- A late text never carries the door code, and never goes to anyone but the
  opted-in cleaner, through the same consent-checked send path as every other
  cleaner text.
- The host is never texted twice about the same visit for the same reason,
  across replay and restart.

## Approaches

1. **An append-only event log per property, and pure derivation** (chosen).
   The engines tap their existing points (inbound text, outbound text, DONE,
   window changes) into one log through a do-nothing-by-default hook, the way
   `StayCodeHook` works. Visit records are a pure function of the log. The
   clock pass asks it what is due and sends through each flow's own send path.
2. **Add visit fields to Cleaner Core's job and Fixer Core's job.** Fewer
   files, but records couldn't be rebuilt when a rule changes, and #180 would
   write into two engines' state.
3. **Read the engines' current state at derive time** instead of logging
   windows. Simpler, but a moved window would rewrite past records, and the
   issue asks for rebuildable records from raw events.

## Design

### Where it lives

A new folder, `src/visits/`, like `src/oversight/` and `src/stay-check/`:

- `events.ts`: the event types, including `LockEvent`, and the mapping to
  `EntryEvent`.
- `store.ts`: the append-only log, `visit-events.jsonl` in the property's
  folder.
- `sink.ts`: `VisitEventSink`, the hook the engines call. The default does
  nothing.
- `derive.ts`: `buildVisits`, pure.
- `due.ts`: what is due now (a late text, a host note, a readiness check),
  pure, from the records and the notes already logged.
- `wording.ts`: the texts and notes.
- `desk.ts`: one property's desk: read the log, list visits, run the clock
  pass's check.
- `tools.ts`: the read-only tools.

On the shared service, `src/hosted/visits.ts` lists and answers the tools, the
way `src/hosted/oversight.ts` does.

### The flag

`VISIT_RECORDS=1` (or `true`) on the service, `visitRecordsOn` in
`src/cleaner-core/flag.ts`, documented in `docs/environment-variables.md`.
With it off, the sink is the do-nothing one, no line is written, the clock pass
does nothing new, and the hours log reads exactly what it reads today.

### Lock events at the boundary

```ts
/** One lock event in a shape no lock partner owns. #180's adapter maps into it. Never holds code digits. */
export interface LockEvent {
  type: "lock";
  /** The provider's own event id, so a resent webhook is stored once. */
  id: string;
  /** ISO time the lock says it happened. */
  at: string;
  /** The lock's name, like "Front door". */
  device: string;
  action: "unlock" | "lock";
  /** Where it was worked from, when the lock says. "outside" covers the keypad and a lock-from-outside button. */
  side?: "outside" | "inside";
  /** The lock's own name for the code used, like "Cleaner" or "Maria". Unset when the lock doesn't say. */
  codeName?: string;
  /** The provider's word as given ("keypad", "app", "auto"). Kept, never read by a rule. */
  method?: string;
}
```

`EntryEvent` in `src/oversight/events.ts` stays as it is. A pure
`entryEventsFrom(lockEvents, codeNames)` gives #240 its entries: each unlock,
with `person` set from the code name's person. So #240's check and this one
read the same raw events, and #180 maps into one type only. (Open choice 1.)

**Whose code.** The property keeps `codeNames`: the lock's name for a code
mapped to a person in Property Core's own terms (`cleaner`, a pro's id, the
host, guests). The host or the setup step saves it. #180 may fill it when it
issues per-person codes. Until then, most locks hold one shared code, and an
unlock with a code that isn't the person's own counts as `unnamed` (Open
choice 2).

### The event log: `visit-events.jsonl`

One JSON line per event, appended with mode `0600`, like
`booking-emails.jsonl`. Every line has `type`, `id`, `at` (when it happened)
and `loggedAt` (when it was written). An `id` already in the log is not written
again, so a resent webhook or a replay adds nothing.

| `type` | Written by | What it holds |
| --- | --- | --- |
| `lock` | #180's adapter, tests, the Scratch CLI | `LockEvent` above |
| `message` | Cleaner Core and Fixer Core at receive and send | `direction` (`in`, `out`), `role` (`cleaner`, `pro`, `host`, `observer`), `personKey`, `visit` (the job id), `label` (`start`, `done`, `yes`, `late-ask`, `door-code`, `host-note`, `other` …), `body` redacted |
| `visit-window` | Cleaner Core when a job's times are set or moved (booking email, host time, late checkout); Fixer Core on booking, reschedule, extend, crew schedule | `visit` (job id, plus the day for a crew), `kind` (`cleaning`, `repair`, `crew-day`), `from`, `until`, `expectedAt`, `sameDay`, `who` |
| `visit-cancelled` | Both, on a call-off or cancel | `visit` |
| `visit-page` | Fixer Core's visit page | `visit`, `step` (`at-door`, `done`) |

- **What's never stored.** No door code and no digit run of 4 or more in any
  body (`redactDigitRuns` after the engine's own `redact`). A door-code text is
  logged with `label: "door-code"` and no body. No phone number: `personKey`
  is a hash keyed with the property's own salt, as package arrivals does.
- **"Stored as received"** means each line is written once, before any rule
  reads it, and never changed. It doesn't mean unredacted.
- **Bad lines.** A line that doesn't parse is skipped and counted in the
  desk's health, never repaired or rewritten.
- **Size.** One file per property per month (`visit-events/2027-01.jsonl`).
  A derivation reads the visit's month and the one before. (My call.)

The engines reach the log only through `VisitEventSink`, set when the flag is
on. `StayCodeHook` stays one slot for #180; the window events are written from
the same call sites as `stayCodeHook().windowMoved(...)` and
`setJobTimes`, not through the hook, so #180 doesn't have to share it.

### Visit records

```ts
interface VisitRecord {
  /** "cleaning:<jobId>", "repair:<jobId>" or "crew:<jobId>:<YYYY-MM-DD>". */
  id: string;
  kind: "cleaning" | "repair" | "crew-day";
  who: { role: "cleaner" | "pro"; name: string; proId?: string };
  window: { from: string; until: string; expectedAt: string; sameDay: boolean };
  /** Whether the property had a connected lock for this visit: any lock event in the log for its days. */
  lock: boolean;
  arrival?: { at: string; source: "lock" | "lock-unnamed" | "cleaner-text" | "visit-page"; eventId: string };
  departure?: {
    at: string;
    source: "done-text" | "done-page" | "done-pro-text" | "lock" | "camera";
    eventId: string;
    /** The DONE it came from, when it came from one. */
    doneAt?: string;
    /** "matched": a lock from outside close to DONE; "none": no lock after it; "no-lock": no lock at the property. */
    lockCheck: "matched" | "none" | "no-lock";
  };
  minutes?: number;
  flags: VisitFlag[];
  /** The derivation's rule version, so a rebuild after a rule change can be told apart. */
  rules: number;
}

type VisitFlag =
  | { kind: "late"; at: string }           // no arrival by expected + grace
  | { kind: "at-risk"; at: string }        // no arrival by the next check-in's at-risk time
  | { kind: "no-show"; at: string }        // no arrival by the window's end
  | { kind: "out-of-window"; at: string; eventId: string } // the person's own code, outside every window of theirs
  | { kind: "no-done"; at: string }        // arrived, no DONE by the window's end
  | { kind: "not-ready"; at: string; why: string[] };       // arrival-day readiness failed
```

`buildVisits(events, { timeZone, codeNames, now })` is pure. Records aren't
saved: they're built on each read, so the same lines always give the same
records. (My call: the logs are small, and a saved copy could drift.)

The latest `visit-window` event for a visit is its window. A
`visit-cancelled` with no later window ends it: no flag, no note.

### Arrival

- **With a lock:** the first `unlock` with the person's own code from 60
  minutes before the window opens to the window's end. Source `lock`.
- **An unlock with no named code, or a shared code** counts only when exactly
  one visit's window is open then. Source `lock-unnamed`. Two visits open at
  once (a cleaner and a pro) leaves arrival empty for both. (Open choice 2.)
- **Without a lock:** the cleaner's START, else their first message after the
  door code went out (the engine's `startedAt` today). Source `cleaner-text`.
  A pro's "I'm at the door" on the visit page is `visit-page`.

### Departure

- **From DONE.** The cleaner's DONE (`done-text`), the pro's done on the visit
  page (`done-page`) or by text (`done-pro-text`).
- **Checked against the lock.** The first `lock` from outside from 15 minutes
  before DONE to 60 minutes after it. When one is there, the departure time is
  the lock's time and `lockCheck` is `matched`. When none is, the departure is
  DONE's time and `lockCheck` is `none`. Without a lock at the property,
  `no-lock`. (Waiting on #180: if the test lock's lock-from-outside isn't tied
  to a code, any outside lock counts. If it isn't reported at all, every
  departure is `none` until cameras.)
- **No DONE.** The visit gets `no-done` at the window's end. No departure is
  guessed. For a crew day (no DONE per day), the last lock from outside in the
  window is the departure, source `lock`.
- **Later, from cameras.** #239 adds `camera` as a source. A camera departure
  replaces a `done-*` one when it lands within the same match window.

**Duration** is departure minus arrival, in whole minutes, only when both are
known and departure is after arrival.

### Windows

- **A cleaning:** opens at the checkout time (the booking email's or the
  host's), or when the host cleared the guests, if earlier. Closes at the next
  check-in, or at 20:00 local when there's no next stay that day.
  `expectedAt` is the cleaner's saved arrival time (`arrivalAt`), else the
  checkout time. Every change through `setJobTimes`, a booking email, a late
  checkout or `StayCodeHook.windowMoved`'s call site writes a new
  `visit-window` line.
- **A repair:** the booking's `from` to `extendedUntil ?? until`.
  `expectedAt` is `from`.
- **A crew day:** each window from `crewWindows`. `crewWindowAt` answers which
  day an unlock belongs to.

### The late clean (cleanings with a lock only)

| Step | When | What |
| --- | --- | --- |
| Late | No arrival at `expectedAt` + 30 min (same-day turnover: + 15 min) | One text to the cleaner: "Hi Maria, checking in on today's clean at 12 Scratch Lane. Are you on your way?" Through Cleaner Core's consent-checked send path, outbox id `late-ask:<jobId>`. No host note. |
| At risk | No arrival by the next check-in minus the expected clean length minus 30 min | One host note: "Maria hasn't arrived at 12 Scratch Lane. The next guests check in at 4 PM." Outbox id `at-risk:<jobId>`. |
| No-show | No arrival by the window's end | Recorded. A host note only when no at-risk note went (no next stay that day). |

- **Expected clean length:** the median of the last 5 measured cleanings at
  the property, else 3 hours. (Open choice 4.)
- **A reply from the cleaner** ("running 20 min late") is logged as a message
  and passed to the host only through today's paths. It doesn't stop the
  at-risk note: only an arrival does.
- **The clock pass** is Cleaner Core's `runReminders`: with the flag on, it
  asks the visits desk what's due and sends through the engine's `emit`, so
  STOP, opt-in, holds, the problem hold, replay and restart all apply as they
  do today. A note's outbox id makes it once.

### Late arrival and out-of-window

- **Late arrival** (arrived, but after `expectedAt` + grace): recorded on the
  visit. Under the 16 Nov decision, the host isn't texted unless the at-risk
  note already went. (Open choice 3.)
- **Out of window**: an unlock with a named code whose person has no window
  open within 60 minutes. One host note per person per day: "The cleaner's
  code opened the front door at 9:40 PM, outside any visit." Needs named codes,
  so it can't fire on a shared code.

### Same-day turnovers

`sameDay` comes from the job (`nextCheckInDate === checkoutDate`). The late
grace is 15 minutes instead of 30, and readiness is checked 1 hour before
check-in instead of 2. (Open choice 4.)

### Arrival-day readiness

On the next check-in's day, at check-in minus 2 hours (same-day: 1 hour), with
a lock:

- the cleaning is DONE;
- no Fixer visit's window overlaps the check-in;
- the last staff unlock after DONE is followed by a lock from outside (nobody
  left inside the door).

When all hold, nothing is sent. When one fails, one host note with the
reasons, outbox id `ready:<jobId>`. Without a lock, nothing new is checked or
sent.

### Fixer visits and crews

- Arrival and departure as above, from the pro's code and the pro's done.
- **Notes go through Fixer Core's own `news`**, once each, which reach the host
  through Cleaner Core when it's on and the alerts routine otherwise. Pros
  aren't texted when late: the 16 Nov decision is about cleaners. (My call.)
- A pro with `access: "host"` has no code, so arrival comes from the visit page
  or stays empty. No lateness flag without a measured arrival.
- **Crew days:** one record per `crewWindows` window. A crew day with no
  arrival is a no-show, one news line per day. Crew codes wait on #180; until
  then the host lets the crew in and only unnamed unlocks can count.

### Where it plugs in

- **`fixerRows`** (`src/hours-log/sources.ts`): when a visit record for the job
  has an arrival and departure, the row's `at`/`until` come from it and
  `timing` is `measured`; the reference names the departure's source.
  Otherwise unchanged (`scheduled`). `readRecords` reads the log only when it
  exists, so a property without one is unchanged.
- **`cleanerRows`**: the same switch, lock arrival over `startedAt`, only with
  a lock. (Open choice 5.)
- **`EntryEvent`** (`src/oversight/events.ts`): unchanged. `entryEventsFrom`
  feeds #240's check from the same log.
- **`crewWindows` / `crewWindowAt`** (`src/fixer-core/crewDays.ts`): crew day
  windows and which day an unlock belongs to.
- **`setJobTimes`, booking emails, late checkout, `StayCodeHook`**: each call
  site that moves a cleaning's window writes a `visit-window` line.

### Tools

Read-only, listed while the flag is on and the property runs Cleaner Core or
Fixer Core, each taking `property`:

- `list_visits`: `{ from?, to? }`, at most 31 days: each record with times,
  sources and flags, in the property's time zone. No phone, no code.
- `visit_health`: lines read, lines skipped, the last lock event's time, so a
  quiet lock can be noticed.

No tool writes the log.

## New safety gates

Added with their tests when built.

**Cleaner Core** (`docs/cleaner-core-safety-gates.md`), row "Visit records":
behind `VISIT_RECORDS`. Raw lock and message lines are written once and never
edited; records rebuild from them alone. No line holds a door code, a digit run
of 4 or more, or a phone number. No tool writes a lock event. A property
without a lock gets no new text, note or hours change. The late text goes only
to the opted-in cleaner through the consent-checked path, never with the code,
once; the host gets the at-risk note once, and only when the next check-in is
at risk. Replay and restart send nothing new.

**Fixer Core** (`docs/fixer-core-safety-gates.md`), row "Visit records": a
pro's arrival comes only from their own code or the visit page, never a guess.
Each flag is one news line, once. No pro is texted about lateness. A crew day's
attendance comes from the lock only.

## Testing

All on fake lock events, 555 numbers and made-up codes:

- `test/visitEvents.test.ts`: the log appends, dedupes by id, never rewrites,
  skips a bad line, redacts digit runs, logs a door-code text with no body,
  holds no phone; `entryEventsFrom` gives #240 the same entries.
- `test/visitDerive.test.ts`: arrival from a named code, an unnamed unlock with
  one window open and with two, departure matched to an outside lock, DONE
  without a lock (`none`), no lock at all (`no-lock`, times from texts),
  `no-done`, duration, a moved window, a cancelled visit, a rebuild after a
  rule version change gives the same raw lines.
- `test/visitDue.test.ts`: late at +30 and +15 for same-day, at-risk time with
  and without past cleanings, no-show with no next stay, out-of-window,
  readiness pass and fail, nothing due without a lock.
- `test/visitCleanerCore.test.ts`: through the engine: the late text goes once
  to the opted-in cleaner, never with the code, not after STOP or during a hold;
  the at-risk note goes once; replay and restart send nothing new; flag off
  writes nothing.
- `test/visitFixer.test.ts`: a repair visit's measured times, the visit page's
  at-door, crew days, one news line per flag.
- `test/hoursLog*.test.ts` additions: `fixerRows` (and `cleanerRows`, if
  chosen) switch to `measured` only with a record, unchanged without one.
- `test/visitsHosted.test.ts`: the tools behind the flag, read-only.
- Scratch: a `cleaner:smoke` journey that feeds a fake unlock and lock around a
  DONE, with evidence under the verify-cleanercore skill.

## Decisions (19 Nov)

Saad took the recommendation on all six:

1. **Lock event vs `EntryEvent`.** Proposed: a new `LockEvent` at the boundary
   (unlock and lock, side, the lock's code name), and `EntryEvent` stays as
   #240's view, derived from unlocks. The alternative is to widen
   `EntryEvent` itself and have #240 ignore the new fields.
2. **Shared codes.** Until per-person codes (#180), an unlock with the shared
   code counts as the arrival only when exactly one visit is open then, marked
   `lock-unnamed`. Alternative: count only named codes, which leaves most
   arrivals empty until #180.
3. **Late arrival note.** Proposed: a late arrival is recorded, and the host
   is texted only through the at-risk note, per the 16 Nov decision. The issue's
   "one host note each" would text the host on every late arrival.
4. **Numbers.** Late grace 30 min (same-day 15), at-risk buffer 30 min, clean
   length default 3 h (else the median of the last 5), readiness 2 h before
   check-in (same-day 1 h), DONE-to-lock match 15 min before to 60 min after.
5. **Cleaning rows in the hours log.** Proposed: switch `cleanerRows` to the
   lock arrival too, with a lock. The brief named only `fixerRows`.
6. **Flag name.** Proposed `VISIT_RECORDS`.

## Left to the builder

- Wording beyond the examples, in the repo's plain style.
- File split inside `src/visits/`.
- The hash for `personKey`, reusing package arrivals' helper if it fits.

## As built

Where the build differs from the draft above, and why:

- **Strays aren't a visit flag.** An unlock with a named code outside every
  window of that person's belongs to no visit, so `buildVisits` returns them
  as `strays`, beside `visits`. The cleaner's go to the host as one note per
  day; a pro's are one Fixer Core news line per pro per day.
- **A cleaner's arrival counts from the start of the checkout day.** The host
  can clear the guests early, and the code goes then; an unlock with the
  cleaner's own code any time that day is their arrival. An unnamed or shared
  code still counts only from an hour before the window.
- **With a lock but no unlock, the cleaner's own text is the arrival.** So a
  cleaner who is there and texting (a door left open, a key) never gets the
  late text. Only a visit with no unlock and no text is late.
- **A connected lock** is the latest `lock-connection` event before the
  window's end, else any lock event in the 7 days before it.
- **Window lines come from one place in each engine.** Cleaner Core compares
  each cleaning's window with the last one written whenever it saves, so a
  booking email, a host time, a late checkout or an arrival time all write a
  new line without touching each call site. Fixer Core does the same on its
  clock pass. Neither goes through `StayCodeHook`.
- **Message ids are hashed.** Cleaner Core's outbox ids can hold a phone
  number (`opt-in:+1…`), so a message line's id is a hash of the sender's id.
- **The log reads every month's file.** It is small; the cache rereads only
  when a file's size changes.
- **A third tool, `name_lock_code`,** saves whose each lock code is
  (`visit-codes.json`), after the host says so. It refuses a name that holds
  digits. It writes no event.
- **Fixer Core news** is one line when a pro or crew isn't in by the start
  plus 30 minutes. A pro who never comes is already told by the existing
  "visit over with no done" note, so there's no second no-show line. A late
  arrival is recorded, not told (decision 3).
- **A no-show note** goes only within 12 hours of the window's end, so a
  restart days later doesn't bring up an old one.
- **Two new Cleaner Core text kinds:** `late-ask` (to the cleaner,
  one-to-one) and `visit-note` (to the host, one-to-one). Both are blocked
  like every other text when the host or cleaner opted out. No visit text
  says "ready" or "door code", which the engine refuses.
- **Proof:** `prove-visits.ts` in the verify-cleanercore skill, feature
  `visit-records`.
- **Tests:** the due items are tested in `test/visitDerive.test.ts` beside the
  derivation, and the hours log switch in `test/visitHoursLog.test.ts`.
