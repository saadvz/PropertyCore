# Bigger repairs: repair blocks, crew workdays, urgent visits during a stay

Date: 2026-11-17. Status: proposed in the project thread, for Saad's review.
Issue: saadvz/PropertyCore#243, project 8 of 8 under #236. Builds on Fixer Core
(`src/fixer-core/`), which holds the pros and every job (#245 settled on Fixer
Core).

## Why

Fixer Core books one visit at a time, between stays. Three kinds of work don't
fit that:

- a problem a guest reports mid-stay (the tester's pest problem ended a long
  stay early and needed an inspection and two crew visits);
- a repair block on the calendar (a block that wasn't on the calendar yet let a
  booking in, and the host paid the cancel fee);
- a crew working for days or weeks, coordinated by phone from far away.

Two things in today's code stop these outright:

1. `approveBooking` refuses any time that overlaps a stay, and `accessCheck`
   never shows the code during one. An urgent visit during a stay can't happen.
2. `visitWindows` and `overlapsStay` count a calendar block (`Stay.kind ===
   "block"`) as busy, the same as a guest. Once a repair block is on the
   calendar, Fixer Core finds no time inside it for the crew.

## Goals

The issue's "can start now" list, as pure rules with tests, in the same shape as
`gate.ts` and `window.ts` (the desk builds the input from its record and saves
the answer):

- **Repair-block logic:** whether a repair block is on the calendar yet, which
  guest stays collide with it, the stays Fixer Core should treat as busy when it
  books the crew inside the block, and who the door is for at a given time.
- **Crew workday windows:** a crew's workdays and hours over a date range, as
  one window per day, clipped around guest stays, and whether a window is open
  now.
- **Urgent visit during a stay:** when one may be booked (the host's yes, the
  guest's okay to that exact window), when the code may show (only inside that
  window), and the timeline kept for the platform.

## Not in this version

- **Writing blocks to the calendar** through the host's booking software. The
  rules only read what the calendar already says.
- **Crew codes** (#180). The workday windows are what a crew code would follow;
  issuing one waits.
- **Who showed up each day** (#237) and **end-of-day photos**. Attendance needs
  #237's visit records.
- **The guest's message.** The wording that asks the guest comes from #242's
  drafts. These rules only record that the guest agreed, and to which window.
- **A crew's door code.** Until #180, the host lets a crew in: a crew job's
  booking is always `access: "host"`.
- **Cleaner Core around a block** (which turnover clean moves when a block
  follows a checkout). That is Cleaner Core's call and waits for the calendar
  write.

## Anti-goals

- A door code that works during a guest's stay without that guest's okay to
  that window. The code shows only inside the window the guest agreed to.
- A crew booked into dates a guest holds.
- Anything that moves money.

## Approaches

1. **Rules only, tested (recommended, not chosen).** Three new rule files and their
   tests. Small, no clash with the threads building #238, #240, #241 and #242
   in parallel, and nothing half-working reaches the bot before codes and
   calendar writes exist.
2. **Rules plus booking changes.** Also teach `approveBooking` and `accessCheck`
   the urgent visit and the repair block. Gets the urgent visit working sooner,
   but touches the 2,700-line desk while other threads edit near it, and needs
   new `fixer.json` fields before the record's shape is settled.
3. **Rules, booking and new tools (chosen by the person in the thread).** Adds
   tools to save a repair block, a crew schedule and the guest's answer, wires
   the rules into booking and code access, and adds Grok and Muse guide text.
   The flows stop short where #180 and the calendar write are missing, and say
   so plainly.

## The rules

### Repair blocks: `src/fixer-core/repairBlock.ts`

A repair block is a span of whole local days, `firstDay` to `lastDay`
inclusive, with the jobs it is for. On a booking calendar that is a block from
`firstDay` to the day after `lastDay` (the calendar's checkout day), so it
closes the nights `firstDay` through `lastDay`.

- `repairBlockProblem(block, todayYmd)`: valid dates, `firstDay` not before
  today, `lastDay` not before `firstDay`, and at most 92 days (month-long blocks
  are coming; three months is the cap, my call).
- `repairBlockStatus(block, stays)` reads the last calendar read:
  - `onCalendar`: calendar blocks cover every night of the repair block. Joined
    blocks from several calendars count together.
  - `openNights`: the nights still open to a booking (the risk from the issue).
    Empty when `onCalendar`.
  - `collisions`: guest stays (`kind: "stay"`) holding any of its nights. A stay
    checking out on `firstDay`, or checking in the day after `lastDay`, does not
    collide.
- `staysForCrew(stays, blocks)`: the stays Fixer Core should count as busy when
  it books inside a repair block. A calendar block that overlaps a saved repair
  block is cut down to the parts outside the repair block's nights. Every guest
  stay and every other block stays as it is.
- `doorFor(at, blocks, stays, times)`: `"guests"` while a guest stay holds the
  time (the same check-in, buffer and checkout times `window.ts` uses),
  `"crew"` while the time falls on a repair block's days and the block is on the
  calendar, `"none"` otherwise. A guest stay wins over a block: if one is booked
  inside the block, the door is still the guests'.

### Crew workdays: `src/fixer-core/crewDays.ts`

A crew schedule: `firstDay`, `lastDay` (inclusive), `workdays` (e.g. MON to
FRI), `start` and `end` as 24-hour local times with `start` before `end` (no
overnight shifts), and optional `skipDays` (holidays).

- `crewScheduleProblem(schedule, todayYmd)`: valid days and times, at least one
  workday, at most 92 days, skip days inside the range.
- `crewWindows(schedule, input)`: one window per workday, `start` to `end` in
  the property's time zone (DST through `zonedInstant`). A window that touches a
  guest stay (busy from check-in minus the buffer until checkout, as in
  `window.ts`) is cut to the free part, or dropped when nothing is left, and the
  day is listed in `conflicts` with why (`clipped` or `dropped`). The caller
  passes `staysForCrew(...)`, so the repair block's own calendar block never
  counts against the crew.
- `crewWindowAt(windows, now, earlyMinutes = 30)`: the window open now, from 30
  minutes before its start (the same lead the visit code has today, my call)
  until its end, or nothing.

### Urgent visit during a stay: `src/fixer-core/urgentVisit.ts`

An urgent visit is one window during one guest stay, for one job.

- **The guest's okay** is recorded with the stay it belongs to (`checkIn|checkout`),
  the window the guest agreed to, when, and how (`text`, `platform` or `host`,
  the last when the host relays it). A later "no" from the guest replaces it.
- `urgentVisitHolds(input)` lists why it can't be booked yet, in a fixed order:
  - `not-during-stay`: the window touches no guest stay (book it the normal way);
  - `spans-checkout`: the window runs past that stay's checkout (my call: split it,
    since the rest is a normal visit);
  - `too-long`: over 4 hours (my call; the inspection and each crew visit are
    separate urgent visits, each with its own okay);
  - `no-guest-ok`, `guest-declined`, `guest-ok-other-stay`, or
    `guest-ok-other-window` (the agreed window must hold the whole visit);
  - `no-host-yes`.
- `urgentAccessCheck(input)`: whether the code may show now. All of the above
  must pass, the pro needs a phone, and the job isn't on the coded lock. The
  code shows from the visit's start to its end with **no** early lead (the
  guest is inside), and an extension needs the guest's okay again. A guest's
  "no" stops it at once.
- `urgentTimeline(input)`: the record for the platform, oldest first: reported,
  guest asked, guest agreed or declined, host's yes, code shown, visit done,
  photos. Names and times only: never a code, phone number or cost.

## Wiring (approach 3)

### The record (`store.ts`)

- `FixerFile.repairBlocks?: SavedBlock[]`: a `RepairBlock` plus `savedAt` and
  `told?: string[]` (the news keys already given, so each is told once).
  At most 10 saved (my call).
- `Job.crew?: CrewSchedule`: set by `save_crew_schedule`, only before a booking
  is live.
- `Job.guest?: { asked: string[]; answers: GuestAnswer[] }`: what the guest was
  asked and answered for this job. The last answer counts.
- `Booking.urgentStay?: string`: the `stayKey` an approved urgent visit is for.

### New tools

- `save_repair_block` (`firstDay`, `lastDay`, optional `jobIds`): always takes
  the host's yes in two calls. Answers the block's status. While it isn't on
  the calendar, `next` tells the agent to have the host close those dates on
  every booking calendar now, since Fixer Core can't write to the calendar yet.
- `remove_repair_block` (`blockId`): the host's yes in two calls.
- `save_crew_schedule` (`jobId`, `firstDay`, `lastDay`, `workdays`, `start`,
  `end`, optional `skipDays`): the host's yes in two calls. Answers the windows
  and the conflicts.
- `record_guest_answer` (`jobId`, `answer`: `asked`, `yes` or `no`, `from` and
  `until` on a yes, `via`): records what the guest was asked or said. It never
  needs the host's yes, because it approves nothing. A "no" on a job with a live
  urgent visit stops the code and gives the host an urgent note.
- `urgent_timeline` (`jobId`): the timeline for the platform.

### Booking

- **Windows and overlaps** (`windowsFor`, `holdsFor`, `staysOver`) count stays
  through `staysForCrew(stays, repairBlocks)`, so any job can be booked inside a
  saved repair block. The door code still never goes out for a visit inside a
  block on the booking calendar: a calendar can label a real booking "Not
  available" (Booking.com does), and Fixer Core can't tell it from the repair
  block. The host lets pros in there (found in review).
- **An urgent visit**: a job with urgency `now` whose booked time overlaps a
  guest stay. `record_contact` no longer stops at "never booked": it runs
  `urgentVisitHolds`. While the guest hasn't agreed, `next` says to ask the guest
  and call `record_guest_answer`. A time over 4 hours or past checkout is refused
  as before, with the reason. Once the guest agreed, the host gets the booking
  question with one more sentence: it's during the guest's stay and the guest
  agreed to it. `approve_booking` checks it all again and saves `urgentStay`.
  A job with any other urgency is never booked over a stay, as before.
- **Code access** for an urgent visit uses `urgentAccessCheck`: from the visit's
  start, with no 30-minute lead, to its end; never after the guest's "no", and
  never for more time than the guest agreed to (an extension needs a new yes).
  The visit page says the host will let them in, as for any refused code.
- The "a stay now covers your visit" note and `held` skip the stay an urgent
  visit was approved for.
- **A crew job** (one with `crew`): the booked time must run from the first
  window's start to the last window's end; a workday a guest touches refuses
  it, as an overlap does today; access is always `host`.

### Showing it

- `get_fixer_state` lists `repairBlocks` with their status, `doorNow` (from
  `doorFor`) when any block is saved, and each open job's `crew` and guest
  answer.
- `check_fixes` gives news once per block for open nights (while the block is
  ahead) and once per colliding stay (urgent, since a booking inside a repair
  block means a cancel fee).
- The Grok guide and the Muse skill get a "Bigger repairs" section; the gates
  doc gets the urgent-visit code gate.

## Left to the builder

Names of internal helpers, exact error wording (plain, short, in the repo's
voice), and test layout (one test file per rule file, `test/fixer*.test.ts`).
