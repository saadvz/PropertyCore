# Remote oversight: expected visits and the same-day flag

Date: 2026-11-17. Status: proposed in the project thread, for Saad's review.
Issue: saadvz/PropertyCore#240, a child of #236 (verification roadmap).
This is the part #240 marks "can start now": expected visits and the same-day
flag, on fake events. Personal codes, entry events and sensors wait on #180;
visit records on #237; camera evidence on #239's camera connection. How a flag
reaches the host waits on #250.

## Why

When a local manager runs the house, the owner's oversight is texts and calls.
The tester's manager once said he'd stop by for a walk-through, never came,
and nothing on record showed it either way. When anyone says "I'll stop by"
(a property manager, a cleaner, a handyman, a friend picking up a key), the
owner wants that treated as an expected visit, and to be told the same day if
nobody came. Nothing in the flow is specific to managers: `who` is just a name.

## Goals

- The host's agent saves an expected visit from what the host says (or a text
  they forward or paste) or from a calendar invite the visitor sent.
- From a text, the agent reads back who, the day and the time window before
  saving. From an invite, the date and times are read in code, never guessed.
- For one day at a property, the check compares the day's expected visits with
  that day's entry events and returns, per visit, whether someone came, nobody
  came yet, or nobody came and it's time to say so.
- Every missed visit is flagged the same day, with one alert text for the day.
- The host can cancel an expected visit ("Mike moved it to Friday").

## Not in this version

- Real entry events. The lock connection (#180) feeds them later through the
  same event shape. This version runs on sample events.
- Personal codes per visit, named entries with time on site (#237), the
  turnover check against the management agreement, the manager's log for the
  hours log, empty-house sensor alerts and urgent-visit codes. All wait on
  #180, #237 or the agreement.
- Reading the manager's texts automatically. "I'll stop by" usually goes to
  the owner's own phone, not to a line Property Core reads.
- Sending the alert, and a scheduled same-day run. #250 decides which bot
  reaches the host. The check returns a result and the alert text.
- Visits Property Core already schedules itself (Cleaner Core cleanings,
  Fixer Core pros). Those become visit records in #237.

## Anti-goals

- No visit the host didn't give. Nothing is created from a guess.
- A visit never holds a door code. A note or invite text that looks like one is
  refused, or (for an invite) left out of what's saved.
- The check never texts anyone.
- A missed visit is never flagged on a later day only. If it's missed, the flag
  is due the same day.
- An entry that names someone else never counts as the expected person's visit.

## Approaches

1. **Saved visits plus a pure same-day check on given entry events**
   (chosen). Same pattern as the nightly stay check (#239): a record in the
   property's folder, a pure check, a desk, tools on the shared service behind
   a flag. Entry events get their own small shape inside the new folder, so
   #180's design can change without touching anything else.
2. **Read the manager's texts automatically from Cleaner Core's group.** The
   manager is already a participant role there, but "I'll stop by" mostly goes
   to the owner's phone, so this would miss most visits, and parsing free text
   in code is fragile.
3. **Wait for #237's visit records** and build expected visits on them.
   Blocked, and #240 says expected visits can start now.

## Design

### Where it lives

A new folder, `src/oversight/`, like `src/stay-check/`:

- `events.ts`: the provider-neutral entry event. Nothing outside the folder
  imports it except tests and the shared-service wrapper.
- `visits.ts`: the expected visit type, validation, the door-code refusal.
- `invite.ts`: reads an expected visit from a calendar invite (`.ics` text).
- `store.ts`: `oversight.json` in the property's folder.
- `check.ts`: `checkDay`, a pure function.
- `alert.ts`: the alert text.
- `desk.ts`: one property's desk: add, list and cancel visits, and run one day
  against given events.
- `tools.ts`: the tools as `tools/list` shows them, and their handler.

On the shared service, `src/hosted/oversight.ts` lists and answers the tools,
the way `src/hosted/stayCheck.ts` does. Off unless `REMOTE_OVERSIGHT` is `1`
or `true` (`remoteOversightOn` in `src/cleaner-core/flag.ts`), documented in
`docs/environment-variables.md`. Listed while the flag is on and any property
runs a flow; each tool takes `property`.

### Entry events

```ts
interface EntryEvent {
  id: string;
  at: string;          // ISO time
  device: string;      // the lock's name, like "Front door"
  person?: string;     // whose code, as the lock partner names it; unset when the code isn't named
  method?: string;     // the provider's word as given ("keypad", "app", "key"); the check never reads it
}
```

The event carries no code digits. When #180's design lands, its adapter maps
its own events into this shape (or this shape is swapped for its own); the
check reads only `at` and `person`.

### Expected visits

```ts
interface ExpectedVisit {
  id: string;              // "v-" + 8 hex, made on save
  who: string;             // the person's name as the host or invite gives it, 1 to 60 characters
  date: string;            // local date YYYY-MM-DD at the property
  from?: string;           // "HH:MM", local; both or neither
  to?: string;             // "HH:MM", local, after from, same day
  note?: string;           // why, 1 to 200 characters ("walk-through", "check the furnace")
  source: "text" | "invite";
  savedAt: string;         // ISO
  cancelledAt?: string;    // ISO; a cancelled visit is kept but never checked
  flaggedAt?: string;      // ISO; when a run of the day first found it missed
}
```

- Up to 50 open visits per property (not cancelled, today or later); older and
  cancelled ones are kept for the record.
- `who` and `note` refuse anything that may carry a door code, with the same
  rule the house rules use: a run of 4 or more digits (split or not, clock
  times aside), or anything `redactBookingEmail` would take out. The refusal
  names the field, never repeats the text. The shared helper moves to one
  place both folders import, so the two rules can't drift (my call).
- `from`/`to` are 24-hour `HH:MM`, `to` after `from`. A window that runs past
  midnight isn't allowed in this version; the agent saves two visits or an
  all-day one (my call, rare for a stop-by).
- A visit dated before today at the property is refused: it can't be flagged
  the same day.
- The same person on the same day with the same window is one visit: saving it
  again returns the existing one.

From a text, the agent turns "I'll swing by Thursday afternoon" into a date
and a window, reads it back ("Mike, Thursday Nov 19, 12 to 5 PM?"), and saves
only after the host agrees. Loose words get a suggested window the host can
change: morning 8:00–12:00, afternoon 12:00–17:00, evening 17:00–20:00. No
time at all is an all-day visit.

### Calendar invites

`visitFromInvite(ics, timeZone)` reads the first `VEVENT` that isn't
cancelled:

- `DTSTART`/`DTEND` with a time become `date`, `from`, `to` in the property's
  time zone. A `Z` time is converted. A `TZID` is converted when it's an IANA
  name ("America/Chicago"); any other `TZID` (Outlook's "Eastern Standard
  Time", a custom `VTIMEZONE`) is refused with a plain reason, and the agent
  asks the host for the time instead, so a time is never guessed. A floating
  time is taken as local. (Builder check: my call.)
- A repeating invite (`RRULE`, `RDATE`) or a changed occurrence
  (`RECURRENCE-ID`) is refused: the agent saves the next visit from the host's
  words instead. (Builder check: my call.) An all-day `DTSTART;VALUE=DATE` becomes an all-day visit on that
  date. An event over more than one day is refused.
- `who` is the `ORGANIZER`'s `CN`, else the host must give it.
- `note` is the `SUMMARY`, cut to 200 characters, and left out when it may
  carry a code (the visit is still saved, and the reply says the title was
  left out).
- `DESCRIPTION`, `LOCATION` and attendees are never saved.
- `source` is `"invite"`. The agent still reads the visit back before saving.

The `add_expected_visit` tool takes either the fields or `invite` (the
`.ics` text), not both. With `invite` and no `confirm: true`, it returns the
visit it read without saving it, so the agent can read it back first.

### The record: `oversight.json`

```ts
interface OversightFile {
  visits: ExpectedVisit[];
}
```

An unreadable file is a plain refusal and is never written over, as with
`stay-check.json`.

### The check

`checkDay({ visits, entries, date, timeZone, now, label })`, for one local
date at the property:

- Only visits on `date` that aren't cancelled are checked.
- **The window that counts** runs from 30 minutes before `from` to 1 hour
  after `to`. An all-day visit counts the whole local day.
- **Flag time:** 1 hour after `to`; for an all-day visit, 20:00 local. Always
  the same day (a window ending after 23:00 still flags by 23:59).
- **Someone came** when an entry event falls inside the counting window and
  either names this visit's person (case and spacing ignored, first name
  matching a full name allowed: "Mike" matches "Mike Doyle") or names no one.
  An entry naming someone else doesn't count. An unnamed entry counts but is
  marked `unnamed`, so the host knows a shared or unnamed code was used.
- Per visit the result is one of:
  - `came`: the first matching entry, its time, and `unnamed` when it was.
  - `waiting`: no matching entry yet, and it's before the flag time.
  - `missed`: no matching entry, and the flag time has passed.
- A matching entry after the counting window but before local midnight on the
  visit's date turns a `missed` into `came` with `late: true` (when the day is
  run again with later events). After midnight it doesn't count. (Builder
  check: my call.)
- **Repeat runs.** The check is pure, and the desk's `runDay` records
  `flaggedAt` on each visit the first time it comes back `missed`. Each missed
  visit in the result carries `alreadyFlagged` when it had a `flaggedAt`
  before this run, and the alert text holds only the visits flagged for the
  first time. When every missed visit was already flagged, the result is
  `flags` with no `alert`, so #250 never texts the same miss twice. (Builder
  check: my call.)

The result is one of:

```ts
| { status: "none"; reason: string }                       // no visits that day
| { status: "ok"; visits: VisitResult[] }                  // nobody missed (some may be waiting)
| { status: "flags"; visits: VisitResult[]; missed: VisitResult[]; alert?: string } // alert only for new misses
```

### The alert text

One message for the day, every missed visit in it, in the property's time
zone, plain words, no door code:

> Today at Lake House: Mike was expected between 1 PM and 5 PM (walk-through).
> No one came in by 6 PM.

An all-day visit reads "Mike was expected today. No one came in by 8 PM."
The text never guesses anyone's pronouns.
When an entry by someone else happened in the window, the alert says so ("The
door was opened at 2:10 PM by Sam."), because that may be the visit by another
name.

### Tools

- `add_expected_visit`: `{ who, date, from?, to?, note? }` from a text, or
  `{ invite, who?, confirm? }` from a calendar invite. The description says to
  read the visit back and save only after the host agrees, and never to
  create a visit the host didn't give.
- `list_expected_visits`: open visits from today on, and the last 7 days'
  visits with their result where events are known (none yet: results come
  with #180, so this lists the visits).
- `cancel_expected_visit`: `{ id }`, after the host says so.

## Testing

- `test/oversightVisits.test.ts`: validation, the door-code refusal on `who`
  and `note`, past dates refused, duplicates.
- `test/oversightInvite.test.ts`: invites in `test/fixtures/oversight/`: a
  timed invite with `TZID`, a `Z` invite, an all-day invite, a cancelled one,
  a multi-day one refused, a non-IANA `TZID` refused, a repeating invite
  refused, a summary with a code left out, organizer name.
- `test/oversightCheck.test.ts`: `checkDay` on sample entry events: came,
  waiting, missed, the 30-minute early and 1-hour late edges, all-day at 20:00,
  unnamed entries, someone else's entry not counting but named in the alert,
  late arrival up to midnight, cancelled visits, the alert text, already
  flagged visits left out of the alert.
- `test/oversightDesk.test.ts`: the desk over a temp property folder with a
  hub file: add, list, cancel, no time zone refused, a broken record refused
  and not written over, `runDay` on sample events.
- `test/oversightHosted.test.ts`: the tools on the shared service behind the
  flag, with `property`, listed only with the flag on.

Made-up data only: 555 numbers, no real codes, no real addresses.

## Left to the builder

- Copy wording beyond the examples above, in the repo's plain style.
- File names inside `src/oversight/` if a split reads better.
- Where the shared door-code helper lives.
