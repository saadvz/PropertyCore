# Fixer Core: repairs and upkeep for a rental

Date: 2026-11-07. Status: written spec for Saad's review. The choices marked
**Decision** below are Saad's to make, each with a recommendation.
Issue: saadvz/TourCore#169, part of saadvz/TourCore#159 (Phase 1). Builds on
the property hub (#165, `docs/superpowers/specs/2026-11-07-property-hub-details-calendars-design.md`
and `docs/superpowers/specs/2026-11-07-property-hub-door-access-design.md`),
shared people (#190, `docs/superpowers/specs/2026-11-07-shared-people-design.md`),
draft-and-confirm setup (#166) and per-account texting consent (#164). Laid
out like `docs/superpowers/specs/2026-11-04-supply-core-design.md`. The gates
are in `docs/fixer-core-safety-gates.md`.

## Goal

The host's agent finds a pro for a repair or for upkeep, books them between
stays, and lets them in for that visit only. The pro finishes with photos, and
the cost is logged. The host makes every decision that matters from their
agent: who is contacted, who gets in, and any job over a set cost.

Fixer Core keeps the pro list, the jobs and the records, and decides in code
what is allowed. The agent does all the outside work: searching, calling,
email, web forms and booking pages. Fixer Core never pays a pro. Pros charge
at the visit.

## What the issues set

From #159 and #169 to #174:

- **How a pro is found.** The host's preferred pros come first. "Who do you
  already call?" is the first setup question. If there's no preferred pro for
  the trade, they're busy, or the host wants options, the agent's own search
  and pro networks build a shortlist. The host picks who to contact. The
  agent contacts them and books. The pro gets access for that visit only,
  finishes with photos, and the cost is logged. If the pro was new, Fixer Core
  asks the host: "Add them to your preferred list?"
- **Trades for v1:** plumbing, HVAC, electrical, handyman, gutters, pest
  control, appliance repair, locksmith, backup cleaning (see Decision 1).
- **Job states:** requested → shortlisted → contacted → booked → in progress →
  done, or cancelled.
- **How pros reply:** through the agent's own channels by default (a call or
  email). The text line only if a pro would rather text.
- **What needs the host's yes:** contacting a pro they haven't approved,
  sharing door access, and any job over a set cost.
- **Three ways a job starts:** the host asks, the cleaner reports a problem,
  or upkeep comes due.
- **The booking window** comes from the hub's booking calendars: between
  stays, and after the cleaner when both are needed.
- **Never:** pay a pro, share a door code outside the booked window, or text a
  pro who hasn't opted in.
- **Pros are hub people.** From the #170 comment: a preferred pro is one more
  role in the account's `people.json` (`src/hub/people.ts`), with the same
  `shared: true` confirmation and the same STOP across properties.
- **Door access** goes through `hub.doorAccess(env).request({ person, window, purpose: "repair" })`
  (the #174 comment). The hub checks only the property side and refuses after
  `window.until`. Fixer Core checks the rest before asking, the way
  `deliverPin` does for Cleaner Core.

## Decisions for Saad

Each one names the option this spec is written around. Reply with the number
and a letter to change one.

1. **Trades.** (A, recommended) The nine trades in #169, with two rules:
   a locksmith job never gets the door code (the lock may be what's broken,
   so the host lets them in), and backup cleaning is left out of Fixer Core
   because a cleaning belongs to Cleaner Core. A backup cleaner there is new
   work with its own issue, since Cleaner Core has one cleaner per property
   today. (B) All nine, with backup cleaning as an ordinary Fixer Core job.
2. **What a cleaner's report or due upkeep does.** (A, recommended) It opens a
   requested job and asks the host once: `Kitchen sink is leaking (photo from
   Maria). Want me to call Joe's Plumbing?` The host's yes starts it. A job the
   host asked for starts right away. (B) It goes straight to the preferred pro
   with no question.
3. **The cost line.** Under Decision 4A every booking already asks the host,
   so the line matters in two places: the booking question says when an
   estimate is over it or missing, and a price the pro raises on site waits
   for the host's yes before the work goes on. Under 4B it's also what makes a
   preferred pro's booking wait. (A, recommended) Every property has a line,
   default $250, set in setup. (B) The line is optional, like Supply Core's
   caps. With no line, a raised price is news to the host, not a hold.
4. **The yes for door access.** (A, recommended) Once per job, asked together
   with the booking: `Joe's Plumbing can come Tuesday 10 to 12, about $180.
   Book it and let them in with the door code?` (B) A standing yes for each
   preferred pro, asked when they're saved.
5. **How the pro gets in and reports done.** (A, recommended) A visit page:
   one private link per booked job, which the agent sends the pro by email or
   text. Inside the visit window, after the pro taps "I'm at the door", it
   shows the door code, and it takes the done photos and the amount charged.
   The link holds no code, and no tool reply does. But the link works for
   whoever holds it during the visit, and it travels through the agent and
   the pro's email, so the spec treats it like a key (Part 4). A pro who
   opted in to the text line can get the code by text and reply DONE with
   photos instead, like the cleaner. (B) The text
   line only: a pro who won't text can't get the code, and the host lets them
   in. (C) Fixer Core never shares access, and the host always lets pros in.
   Under every option the host can pick "I'll let them in" for a job.
6. **After the visit.** With the host's own code, Fixer Core can stop showing
   the code, but the pro still knows it. Real per-visit codes need a lock
   partner (#180). (A, recommended) After a visit by a pro who isn't on the
   preferred list, Fixer Core asks the host to change the code, using the
   steps in `docs/cleaner-core-code-rotation.md`, and the cleaner gets the new
   code as today. The preferred-list question comes first: a pro the host adds
   to the list gets no rotation question. A cancel after the code was shown
   asks the same question. (B) Ask after every pro visit. (C) No code to a
   pro who isn't preferred until a lock partner gives per-visit codes.
7. **A pro and a cleaning on the same turnover.** (A, recommended, as #171
   says) The pro comes after the cleaner. Their window starts at the
   cleaner's DONE, or when planning ahead, at checkout plus the cleaning
   length (default 3 hours). (B) Indoor trades (plumbing, HVAC, electrical,
   appliance, pest control, handyman) come before the cleaner, so the cleaner
   cleans up after them. (C) The host picks per job.
8. **Asking the cleaner.** (A, recommended) With Fixer Core on, the DONE text's
   question becomes `Anything running low or broken? Reply with what, or
   NONE.` One answer can mark supplies low and open a repair. (B) No new
   question: only problems the cleaner reports on their own open jobs. Option
   A changes cleaner-facing copy, so it needs a design pass.
9. **Hours a pro can be booked.** (A, recommended) 8:00 to 18:00 in the
   property's time zone by default, editable in setup, and never within 1 hour
   of the next check-in. (B) Any time between stays.
10. **Pros in the people list.** (A, recommended, as the #170 comment says)
    Every saved pro with a phone is a person in `people.json` with role
    `pro`. A shortlist candidate joins only when booked. A person can be a
    `pro` and hold another role on the same property (a cleaner who is also
    the handyman): `where` gets a second entry, which `people.ts` allows
    today only once per property, so that rule changes. (B) Only pros who
    text on the line join, and the rest stay in `fixer.json` alone.

Which pro networks Fixer Core connects to is not a decision here. #175 is
researching it, and this spec takes candidates from any source the same way
(Part 3).

## Not in this version

- Paying a pro, a payment link, or holding any card or bank detail.
- Per-visit door codes from a lock partner (#180). The provider behind
  `request()` changes, and Fixer Core's own checks stay.
- Fixer Core calling a pro network from the server. The agent reaches
  networks itself, through its browser or a connector, until #175 picks one
  worth connecting.
- Warranties, invoices as files, or tax records. The cost log is a number and
  a note per job.
- Fixer Core with Tour Core, and on Claude or ChatGPT plain chats. Like Supply
  Core, it's offered on the always-on agents only (Grok Bot and Muse).
- Jobs during a stay as a normal flow. A booking that overlaps a stay always
  waits for the host, who arranges it with the guest.
- Ratings of pros by the host beyond "preferred" or not.
- Outside the US.

## Rules that stay

- `docs/cleaner-core-safety-gates.md` and `docs/supply-core-safety-gates.md`
  stay green. Decision 8 changes one Cleaner Core gate (the supplies
  question), and that gate is updated with it.
- No live text to a real person without Saad's okay. Tests and Scratch runs
  use only 555 numbers, made-up door codes, and `example.com` addresses.
- No call, email or form from a test reaches anyone. The agent's outside work
  is never run in CI.
- Secrets stay out of code, logs, prompts, chat and tool arguments. The door
  code never appears in a tool reply.
- Properties with Fixer Core off behave exactly as today.
- No Core moves money.

## What exists today

- **The flow switch.** `Property.flows.fixer` exists
  (`src/cleaner-core/hosted/properties.ts`). `registry.setFlow` throws
  `fixer-not-yet` for `on: true` (`src/cleaner-core/hosted/registry.ts:290-292`),
  and `set_flows` returns `FIXER_NOT_YET` (`src/hosted/service.ts:64`,
  `src/hosted/propertyTools.ts:15`).
- **Door access.** `DoorAccess.request` (`src/hub/doorAccess.ts`) checks a
  code is saved, the key opens it, and now is before `window.until`. It
  answers `{ ok: true, kind: "code", code, lockLocation?, until }` or
  `{ ok: false, reason: "no-code" | "no-key" | "sealed" | "window-over" }`.
  `purpose: "repair"` is already in `AccessRequest`. The provider is
  `ownCode`, the host's own code.
- **People.** `people.json` holds each person's properties and role, their one
  YES and their STOP. `Role` is `"cleaner" | "co-host" | "assistant" | "observer"`.
- **Calendars.** The hub reads each property's booking calendars and keeps
  checkout dates from the last clean read (`HubFile.checkouts`).
  `interpretFeed` (`src/hub/calendar.ts`) gives `Turnover`s with
  `checkoutDate` and `nextCheckInDate`. `HubProperty` has `checkoutTime` and
  `checkInTime`.
- **Supply Core's patterns.** The pure gate (`src/supply-core/gate.ts`), the
  token bound to a cart and the two-call approval (`src/supply-core/desk.ts`,
  `checkCart` and `approveCart`), the sweep for go carts that were never
  recorded (`sweep` in `desk.ts`), `report_low` taking ids only, and
  `schedule.ts` with `preview_schedule`'s RRULE check.
- **Photos.** `src/cleaner-core/photos.ts` keeps MMS photos per job, with
  letters-only paths and links that expire after an hour, deleted 30 days
  after the job.
- **Cleaner reports.** `check_now` labels each message with a `MessageHandled`
  value (`src/cleaner-core/core.ts:252`), such as `supply-report`.
- **The tick.** The hosted service's tick runs `drainAllTenants`
  (`src/cleaner-core/hosted/router.ts:447`) to deliver each account's waiting
  alerts.
- **Departure.** Cleaner Core sends the door code only after clearance: the
  host's "guests have left" (`hostDeparture` in `core.ts`) or its own release
  rules.
- **Draft-and-confirm setup** (#166, `test/cleanerDraftSetup.test.ts`): the
  agent drafts what it already knows, shows one summary with the gaps marked
  "needs you", and the host confirms.

## 1. Architecture

**Code.** A new module, `src/fixer-core/`, apart from Cleaner Core and Supply
Core:

| File | Job |
| --- | --- |
| `store.ts` | Reads and writes `fixer.json`: settings, pros, upkeep, jobs. |
| `window.ts` | Pure functions. The open visit windows for a job, from the hub's merged stays, check-in and checkout times, booking hours, and any cleaning on the same turnover. |
| `gate.ts` | Pure functions. Go or hold for a contact, a booking, and door access, and the tokens bound to each. |
| `setupAsk.ts` | The `ask` steps, in the `get_state` → `ask` shape, with draft-and-confirm. |
| `desk.ts` | One per property folder, like `SupplyDesk`. Jobs, the sweep, door access through the hub, and news for the host. |
| `visitPage.ts` | The visit page (Decision 5A): the private link, the window check, photos and the amount. |
| `tools.ts` | The MCP tools (Part 5). |

Upkeep schedules reuse `src/supply-core/schedule.ts` (`every` and `custom`,
and `preview_schedule`'s checks). If that import feels wrong, the schedule
functions move to `src/hub/` with no change in behaviour.

**Record.** One `fixer.json` per property, in the property folder beside
`supply.json`, plus `fixer-approvals.json` for the two-call codes. Pros with a
phone are also persons in the account's `people.json` (Decision 10).

**How a host gets it.** `set_flows` with `fixer: true` on a property, once
`FIXER_CORE=1` is set on the service, the way Supply Core waited on
`SUPPLY_CORE=1`. Without it, `fixer-not-yet` stays. Turning it on starts
setup and contacts nobody. Turning it off with a job booked gives the host
the jobs that will be cancelled and stops first, with a code, like the other
flows. The agent tells each booked pro.

**Agents.** Grok Bot and Muse. The agent profile in
`src/cleaner-core/assistant.ts` gains `fixer: yes` for both, matching
`supplies`, and `docs/client-matrix.md` gets its Fixer Core rows.
`test/propertyClientMatrix.test.ts` checks them. A plain chat asked for Fixer
Core gets one line saying it works with Grok Bot and Muse.

**Who does what.**

- **Fixer Core** keeps the pro list, upkeep, jobs, shortlists, the host's
  picks, bookings and the cost log. It works out the visit windows. It decides
  go or hold for each contact, booking and door access. It sends the door
  code, and only through the hub's request.
- **The agent** asks the setup questions, drafts the pro list from the host's
  contacts and receipts where it can read them, searches, calls, emails,
  fills in web forms and booking pages, reports every outcome back, and sends
  the pro the visit link.
- **Cleaner Core** asks the cleaner (Decision 8) and passes reports on, as it
  passes supply reports today.

**Routines.** No new routine. The property's existing Alerts routine (Grok)
or recurring task (Muse) gains one step: call `check_fixes` and act on what
it returns. A visit that runs late is time-bound, so Fixer Core also queues it
on the same alert wake Cleaner Core uses, and the agent hears it on its next
wake.

**The clock.** Time-bound steps run on the service's tick, beside
`drainAllTenants`: each property with Fixer Core on gets one pass that moves
a booked job to `in-progress` at the visit start, sends the code text to an
opted-in pro once the code may go out, ends a visit, and queues delay news.
The pass reads `fixer.json` and the hub only, and sends nothing a replay or
restart would send again.

**What it reads from the other flows.** Calendars through the hub: with
Cleaner Core and Supply Core off, `check_fixes` triggers the hub's
`readCalendars`, as Supply Core's check does. Cleaner Core's cleaning for a
checkout, and its DONE time, through one new read in
`src/hosted/crossService.ts`, so Fixer Core never imports Cleaner Core.

## 2. The record and setup

### `fixer.json`

```
settings: {
  costLineCents: number,          // Decision 3: default 25000, $1 to $5,000
  hours: { from: "HH:MM", until: "HH:MM" },   // Decision 9: default 08:00 to 18:00
  checkInBufferMinutes: number,   // default 60, 0 to 240
  cleaningMinutes: number,        // Decision 7: default 180, 30 to 480
  activatedAt?: string,
}
pros: Pro[]                       // up to 60
upkeep: Upkeep[]                  // up to 30
jobs: Job[]
```

**Pro.**

```
{ id,                             // "pro_" + 10 of [a-z0-9]
  name, trades: Trade[],          // one or more
  preferredFor: { trade: Trade, rank: number }[],   // 1 is called first for that trade
  reach: { phone?, email?, website?, bookingUrl? },   // at least one
  prefersText?: true,             // the pro asked to text on the line
  status: "draft" | "saved",      // a draft isn't approved until the host confirms
  source: "host" | "drafted" | "job",
  addedAt, lastJobAt? }

Trade = "plumbing" | "hvac" | "electrical" | "handyman" | "gutters"
      | "pest-control" | "appliance" | "locksmith"     // + "backup-cleaning" under Decision 1B
```

`phone` is E.164 and is the pro's key in `people.json` (role `pro`, on each
property they serve). `website` and `bookingUrl` must be https. A pro on two
properties needs the host's `shared: true`, as for any person.

**Upkeep.**

```
{ id, trade, what,                // "Clean the gutters", under 120 characters
  schedule: Schedule,             // "every" or "custom", as Supply Core
  leadDays: number,               // open the job this many days early, default 14
  savedAt,                        // the schedule counts from here, or from lastDoneAt
  proId?, lastDoneAt? }
```

**Job.**

```
{ id,                             // "job_" + 10 of [a-z0-9]
  trade, what,                    // under 300 characters, digits of 4 or more redacted
  source: "host" | "cleaner" | "upkeep",
  sourceRef?,                     // the cleaning job id, or the upkeep id
  photos: PhotoRef[],             // { id, from: "cleaner" | "pro", at }: photos.ts entries,
                                  // the cleaner's report photos, then the pro's done photos
  urgency: "now" | "soon" | "by-date" | "flexible",
  byDate?,                        // local YYYY-MM-DD, for "by-date"
  state: "requested" | "shortlisted" | "contacted" | "booked" | "in-progress" | "done" | "cancelled",
  hostGo?: { at },                // the host's go for a job they didn't start (Decision 2)
  candidates: Candidate[],        // up to 8
  picked: string[],               // candidate or pro ids the host picked
  contacts: Contact[],
  booking?: Booking,
  done?: { at, by: "pro-page" | "pro-text" | "agent" | "host", note? },
  cost?: { cents, by: "pro" | "agent" | "host", at, note? },
  news: { kind, at, toldAt? }[],  // what the host has been told, once each
  createdAt, cancelledAt?, cancelReason? }

Candidate: { id, name, trade, source: "search" | string,   // a network's name
             rating?, reviewCount?, licensed: "yes" | "no" | "unknown",
             backgroundChecked?: "yes" | "no" | "unknown",
             costRange?: { lowCents, highCents },
             priceText?,          // the source's own words, like "$95/hr", under 60 characters
             earliestAt?,         // often unknown for a network candidate
             reach: { phone?, email?, website?, bookingUrl?, networkRef? } }

Contact: { id, to: string,        // a pro or candidate id
           how: "call" | "email" | "form" | "booking-page" | "text" | "network",
           token, at, outcome?: "booked" | "quoted" | "no-answer" | "declined" | "waiting",
           outcomeAt?, followUpAt?, quote?: { cents, note? } }

Booking: { proId, from, until,    // ISO instants
           estimateCents?, access: "code" | "host",
           heldFor?: ("cost" | "no-estimate" | "outside-window" | "overlaps-stay")[],
           hostYes?: { at },      // the booking and the access, together (Decision 4A)
           visitToken?,           // the visit page's token hash (Decision 5A); a new one on
                                  // every rebook, extend or cancel
           revealedAt?: string[], // each time the page showed the code
           revisedQuote?: { cents, at, hostYes? },
           extendedUntil? }
```

### Job states

| State | Means | Leaves by |
| --- | --- | --- |
| `requested` | The job exists. A job the host didn't start waits for `hostGo`. | A preferred pro is contacted → `contacted`. Candidates are added → `shortlisted`. The host says no to the go → `cancelled`. |
| `shortlisted` | Candidates are recorded and the host picks. | The host's pick is contacted → `contacted`. |
| `contacted` | Pros were contacted and outcomes are awaited (`waiting`, `quoted`), or a booking waits for the host's yes. | Booked with the host's yes → `booked`. Every contact declined or no answer → back to `shortlisted`, or to `requested` with no one left. |
| `booked` | One time inside the window, with the host's yes. | The visit starts → `in-progress`. A reschedule → `contacted`, with the old booking and its visit link ended. |
| `in-progress` | The visit is open. Door access can go out. | Done → `done`. The visit ends with no done: it stays, the host is told, and the host marks it done, extends, rebooks (→ `contacted`) or cancels. |
| `done` | The pro finished. Photos and the cost are logged. | Final. |
| `cancelled` | The host called it off, or Fixer Core was turned off. | Final. |

A job with a preferred pro for its trade skips `shortlisted`. The host can ask
for options at any time, which adds candidates and moves it to `shortlisted`.

A job has at most one live booking. When the agent contacts several picks at
once, the first `booked` outcome goes to the host, and a second one is held
until the host chooses between them. The agent tells the other pro.

### Visit windows

`window.ts` works out the open windows for a job, from now through the
job's latest date (the `byDate`, or 14 days for `soon`, 30 for `flexible`):

- A window lies between a checkout (the hub's `checkoutTime`, default 11:00)
  and the next check-in (`checkInTime`, default 16:00) minus
  `checkInBufferMinutes`. Days with no stay and no block are open all day.
  A block counts as occupied, since it may be the owner's own stay.
- Only inside `hours`.
- With a cleaning on that turnover (Cleaner Core on, a cleaning job for that
  checkout), the window starts at the cleaner's DONE, or before it's known,
  at checkout plus `cleaningMinutes` (Decision 7A).
- `urgency: "now"` still uses windows, and a time during a stay is held for
  the host (`overlaps-stay`).

The stays come from the hub's last clean read. `interpretFeed` works out
`nextCheckInDate` within one feed, and `FeedBlock` carries no dates, so per-feed
turnovers would show false gaps when a property has two calendars. Instead the
hub keeps, beside `HubFile.checkouts`, the merged stays from every calendar
and Google: `stays: { checkIn, checkout, kind: "stay" | "block" }[]`, with
the block dates read from each feed. Fixer Core reads no calendar of its
own. After a failed read, the last good stays are kept, and a booking made on
them is checked again at the next good read. If the new read shows a stay
over the booking, the host is told.

### Setup

The `get_state` → `ask` pattern with draft-and-confirm (#166), one question
per message, choice cards where there are options. Cleaner Core's and Supply
Core's `get_state` gain one line (`Repairs: on, 4 pros, 1 job open.`, or
`Repairs: setup not finished.`).

1. **"Who do you already call?"** grouped by trade. The agent drafts the list
   from what it can read (the host's contacts, receipts and emails) and saves
   each as `status: "draft"` with `save_pro`. It shows one summary, trade by
   trade, with gaps marked "needs you". The host confirms, edits or removes.
   Only confirmed pros are `saved`. For each trade the host puts the pros in
   the order to call them, which is each pro's `preferredFor` rank.
2. **The cost line** (Decision 3). "Any repair over this needs your yes."
3. **Booking hours** (Decision 9), shown as the default with a choice to
   change.
4. **Upkeep**, optional: "Want reminders for regular upkeep?" Suggested
   items: gutters spring and fall, HVAC filters every 3 months, smoke
   detectors twice a year. For each: the schedule (read back through
   `preview_schedule`) and an optional pro.
5. **Review and Activate.** The agent summarizes the pros, cost line, hours
   and upkeep in its own words. On the host's Activate, `activate_fixer`.

Activate is refused until the property has an address and time zone in the
hub, and the hub has at least one booking calendar or the host said there is
none (an empty calendar opens every day). Door access isn't needed to
activate: without a saved door code every booking is `access: "host"`.

After Activate, every change to the cost line, hours, a pro or upkeep uses the
two-call approval. A pro the agent adds is a draft until the host confirms.

## 3. Finding and contacting a pro

### Opening a job

- **The host asks** ("Find someone for the gutters before winter"): the agent
  calls `open_job` with `source: "host"`. That's the host's go.
- **The cleaner reports a problem.** The answer to the DONE question
  (Decision 8A), or a problem the cleaner texts on their own, reaches the
  agent through `check_now` with a new `MessageHandled` label,
  `repair-report`, with the photos' ids. Step 11 of the Cleaner Core
  instructions in `src/cleaner-core/assistant.ts` gains what to do with it.
  The agent matches it to a trade and calls `open_job` with
  `source: "cleaner"`, the cleaning job id and the photo ids. The cleaner's
  words are saved with every run of 4 or more digits redacted. A report that
  is a supply goes to `report_low` as today, and one answer can do both.
- **Upkeep comes due.** `check_fixes` returns upkeep items `leadDays` before
  their next date. The agent calls `open_job` with `source: "upkeep"`.

A job from the cleaner or upkeep waits for the host's go (Decision 2A).
`check_fixes` returns it in `needsGo` with a question for the agent to ask,
and `approve_job` takes the two-call yes. A cleaner's text can only open a
requested job. It can't pick a pro, contact anyone, approve a booking or set
a cost.

### Preferred pro first

With the host's go, `check_fixes` names the preferred pro for the trade, the
one ranked 1. The agent calls `contact_pro`, contacts them, and reports the
outcome. If they decline or don't answer, the next ranked pro is offered.
With none left, or when the host asks for options, the agent builds a
shortlist.

### The shortlist

The agent searches on its own (Google, Yelp, and any source it can reach) and
through any pro network it's connected to. It records each candidate with
`add_candidates`: name, trade, rating and review count, licensed or not,
estimated cost range, earliest availability, source, and how to reach them.
Up to 8 per job. Each candidate's `source` names where it came from, so a
network that #175 recommends fits without a change here.

The early #175 findings (`docs/fixer-core-pro-networks.md`, in its own PR)
shape this: a network may return licensing and a price as text but no
availability, phone or email. So `costRange` and `earliestAt` are optional,
`priceText` keeps the source's words, and a network candidate is reached by
`networkRef`, with its replies coming back through the network
(`how: "network"`). Booking through a network is out of scope, since the
networks that book need a payment token, which clashes with "no payment
step". A network quote request is a contact like any other: it needs the
host's pick first.

The host sees a choice card per candidate, never a list in text. `pick_pros`
takes the two-call yes for the picked candidates, and the pick is the host's
approval to contact them. The host can pick one or several in order.

### Contacting

`contact_pro` returns a `contactToken`, or refuses. It allows:

- a saved pro who is `preferredFor` the job's trade, on a job with the host's
  go, or
- a pro or candidate in the job's `picked`.

Anyone else is refused, and the refusal is shown to the host. The agent then
reaches out the way that fits: a call where the agent can place one (Grok
Bot), email, a web form, a booking page, or a network. A text only to a pro
who opted in on the line.

The agent reports back with `record_contact` and the token:

- `booked`: a time and, if given, an estimate (below).
- `quoted`: an amount, with no time yet.
- `no-answer` or `declined`: the next pick, or the next ranked preferred pro,
  is offered to the host.
- `waiting`: an email or form sent, with no reply yet. `followUpAt` defaults
  to 24 hours. Past it with no reply, the host is offered the next pick.

**Unreported contacts.** A token with no `record_contact` within 2 hours is
`unconfirmed`, like Supply Core's sweep. `check_fixes` returns it, and the
agent checks its own call log or sent mail first. Found: `record_contact`.
Not found: `record_contact` with `no-answer`. The host is told of an
unconfirmed contact once.

### Booking

When the pro offers a time, the agent offers only times inside the job's
windows from `check_fixes`. It says it will confirm any other time with the
host. `record_contact` with `booked` runs the booking gate (`gate.ts`):

- **held, outside-window**: the time isn't inside an open window.
- **held, overlaps-stay**: the time overlaps a stay.
- **held, cost**: the estimate is over `costLineCents`.
- **held, no-estimate**: no estimate was given (Decision 3A).
- Every booking also needs the host's yes for access (Decision 4A), so it
  always asks the host once. The holds decide what the question says.

`approve_booking` is the two-call yes. Its question carries the pro, the time,
the estimate, any hold, and the access: `Joe's Plumbing can come Tuesday 10 to
12, about $180. Book it and let them in with the door code?` with a choice for
"I'll let them in". After the yes, the job is `booked`, and the agent
confirms with the pro. The agent never confirms a held time to the pro before
the yes. The booking's token is bound to the exact pro, time, estimate and
access, and any change needs a new `record_contact`.

A locksmith job is always `access: "host"` (Decision 1A).

## 4. The visit

### Door access

The code goes out only when all of these hold. Fixer Core checks them before
asking the hub:

- the job is `booked` or `in-progress`, with the host's yes and
  `access: "code"`;
- the pro has a saved phone, which is the request's `person` (an E.164 phone,
  as `AccessRequest` needs). A pro with no phone is always `access: "host"`;
- now is inside the visit: from 30 minutes before `from` to `until` (or
  `extendedUntil`);
- on a checkout day, the guests have left: the host's "guests have left", or
  the cleaner's DONE for that checkout. Until then the code waits, the way
  Cleaner Core's release waits for clearance. A day with no checkout needs no
  clearance;
- it goes one-to-one: to the pro's own phone on the line after their YES, or
  through the visit page. Never a group, never in an email or a tool reply.

Then Fixer Core asks `hub.doorAccess(env).request({ person, window, purpose: "repair" })`
with the pro's phone and the visit window. The hub refuses after the window
ends (`window-over`). On any refusal, nothing is sent and the host gets one
note for the job.

**The key.** A text from the tick and a visit page request carry no request
key, so `request()` uses the key it last opened the code with, or the
server's key (`serverPinKey`). After a restart, a code sealed with only a
request key can't open (`no-key` or `sealed`): the page shows no code, the
host gets the one note, and the pro is told the host will let them in. This
case has its own test.

**By text**, for a pro who opted in: at the start of the visit, one text:
`Hi Joe, the door code for 12 Scratch Lane is {code}, at {lock location}.
Reply DONE with photos when you finish.` A replay or restart sends it once.

**By the visit page** (Decision 5A): after the host's yes, `visit_link` gives
the agent a link `/{base}/visit/{token}` to send the pro, for every booked
job. The token is letters only, like photo links, and holds no code. The
link is returned once. A rebook, an extend or a cancel ends it and issues a
new one, and `revoke_visit` ends it on the host's word.

- Before the visit, the page shows the time and the job, and says the code
  shows at the start. It shows the address only from 24 hours before.
- During the visit, with `access: "code"` and once the code may go out, the
  pro taps "I'm at the door" and the page shows the code and the lock
  location. Each reveal is logged, and the host is told each time:
  `Joe's Plumbing opened the door code at 10:04.` With `access: "host"`, the
  page never shows a code.
- During and after the visit, it takes up to 10 photos (the same types and
  5 MB limit as MMS photos, with location data removed), the amount charged,
  and a revised price before the work (below). Every text field goes through
  `refuseCards` and the digit-run redaction.
- After the visit and a done, it shows only "This visit has ended."
- It's never indexed, sends no referrer, and answers at most 30 requests an
  hour per link.

The link is a key for the length of the visit. Whoever holds it then can see
the code, and it passes through the agent and the pro's email. The agent
sends it only to the pro's own address or phone, never to a group or a
thread with anyone else in it, and the host hears of every reveal.

**After the visit.** The code stops showing, but a pro who saw it still knows
it. With the host's own code there's no way to take it back, only to change
it (Decision 6A). When the pro isn't on the preferred list after the
preferred-list question, the host is asked: `Joe's Plumbing knows the door
code. Want to change it? Set the new code on the lock, then save it here.` This
uses the existing one-time upload link.

### Done

The pro finishes in one of these ways:

- the visit page: photos and the amount;
- DONE by text with MMS photos, if they opted in;
- the agent's `record_done` from the pro's email or invoice, with the amount
  and a note, and no photos;
- the host tells the agent.

Photos are kept the way the cleaner's are (`src/cleaner-core/photos.ts`):
under the job, letters-only paths, signed links that expire after an hour,
deleted 30 days after done. `get_job_photos` takes a Fixer Core job id too.

`done` moves the job to `done`. If no photos came, the host is told so.

### Cost

**A price raised on site.** When the pro says the work will cost more than
the approved estimate (on the visit page, by text, or to the agent), it's
recorded as `revisedQuote`. Over the cost line, or more than 20% over the
estimate, it waits for the host's yes through `approve_booking` before the
pro goes on: `Joe's Plumbing says the fix is $420, not $180. Go ahead?` The
pro is told to wait for the answer. Under both, it's news to the host.

`record_cost` logs the amount against the job, from the pro, the agent or
the host. There's no payment step. When the amount is over the estimate by
more than 20%, or over the cost line, the host is told once. The amount is
already charged, so this is news, not a hold.

`get_fixer_state` shows each open job, and the cost log for this month and
this year by trade.

### Preferred list

After a done job with a pro who isn't saved, or saved but not preferred for
the trade, `check_fixes` returns the question: `Add Joe's Plumbing to your
preferred list for plumbing?` A yes is `save_pro` with the job id, two-call.

### Delays

- The visit ends with no done: the host is told once, and the code stops
  showing. `extend_visit` gives more time with the host's yes, never past the
  next check-in buffer.
- The visit's end is within 1 hour of a check-in and no done has come: the
  host is told once, on the alert wake.
- A pro reports they're running late (by text, or the agent hears it): the
  agent asks for a new time, which runs the booking gate again.

## 5. Tools

| Tool | Does |
| --- | --- |
| `get_fixer_state` | Setup's next `ask`, or the summary: pros by trade, upkeep, open jobs, the cost log. |
| `save_fixer_settings` | Cost line, hours, check-in buffer, cleaning length. Two-call after Activate. |
| `save_pro` / `remove_pro` | The pro list. The agent's drafts are `draft` until the host confirms. With a `jobId`, saves a pro from a done job. Two-call after Activate. |
| `save_upkeep` / `remove_upkeep` | Upkeep items. Two-call after Activate. |
| `preview_schedule` | Supply Core's tool, listed whenever Fixer Core or Supply Core is on: the next 3 dates, or why a schedule is refused. |
| `activate_fixer` | Refused until the checks in Part 2. |
| `check_fixes` | Jobs that need the host's go, upkeep due, the preferred pro to contact, windows for each job, unconfirmed contacts, follow-ups due, holds, delays, and preferred-list questions. |
| `open_job` | A new job: trade, what, urgency, source, and any photo ids. |
| `approve_job` | Two-call: the host's go for a job from the cleaner or upkeep. |
| `add_candidates` | Records shortlist candidates on a job. |
| `pick_pros` | Two-call: the host's pick from the shortlist. |
| `contact_pro` | A `contactToken` for a pro the host approved, or a refusal. |
| `record_contact` | The outcome. A booking runs the gate. |
| `approve_booking` | Two-call: the booking and the access together. |
| `visit_link` | The visit page link for a booked job, returned once. |
| `revoke_visit` | Ends a visit link on the host's word. |
| `extend_visit` | Two-call: more time for a visit. |
| `record_done` / `record_cost` | The agent's report of done and the amount. |
| `cancel_job` | Two-call when booked: the agent tells the pro, the visit link ends, and the code is never shown again. After a reveal, the host gets the Decision 6 question. |
| `get_job_photos` | Cleaner Core's tool, listed whenever Fixer Core is on, taking a Fixer Core job id too. |

Every tool's input is strict and checked by `refuseCards` (`src/hub/cards.ts`).
No tool has a field for a payment, and none takes or returns a door code.

**Text line.** A pro's one-to-one texts route by sender, like any person on
the account. STOP, HELP, and the injury phrases win over everything else, as
for the cleaner, and an injury report uses the same 911 path. Fixer Core
takes YES (the opt-in), STOP and START (through `people.json`, across
properties), DONE with photos for the pro's job in progress, and a revised
price. Any other text from a pro is passed to the host as news, with digit
runs redacted. A pro's text never approves, books or changes anything.

## 6. Safety gates

`docs/fixer-core-safety-gates.md`, in the same format as the other two, each
gate with its tests. In short:

1. No payment and no card details.
2. Contact only a pro the host approved.
3. The cost line and the window are Fixer Core's code.
4. Door access only for a booked job, with the host's yes, inside the visit,
   after the guests left, one-to-one.
5. The visit page holds no code, shows it only after "I'm at the door"
   inside the visit, and tells the host of every reveal.
6. No text to a pro without their YES.
7. A cleaner's report only opens a job.
8. A pro on several properties sees only their own.
9. Photos kept like the cleaner's.
10. Tests contact no one.
11. Accounts apart.

## 7. Testing and verification

**New tests (vitest).**

- `test/fixerWindow.test.ts`: windows between stays merged from two
  calendars, blocks as occupied, check-in buffer, hours, open days with no
  booking, a cleaning on the turnover (DONE known and not),
  same-day turnovers, time zones and daylight-saving days.
- `test/fixerGate.test.ts`: contact allowed for preferred and picked pros
  only; booking holds for outside-window, overlaps-stay, cost at, below and
  above the line, and no estimate; tokens bound to the exact booking; door
  access refused before the visit, after it, without the host's yes, with
  `access: "host"`, for a locksmith, and on a checkout day before the guests
  left; a revised price over the line held; one live booking per job.
- `test/fixerDesk.test.ts`: the setup asks with drafts; the job states end to
  end for each start (host, cleaner, upkeep); declined and no-answer offering
  the next pick; the 2-hour sweep and 24-hour follow-up; done from each path;
  cost news; the preferred-list question; the two-call approvals; card-like
  input refused on every tool.
- `test/fixerVisitPage.test.ts`: the page before, during and after the visit;
  the code only after "I'm at the door"; no code in the link or any reply; a
  new token on rebook, extend and cancel; `revoke_visit`; the rate limit;
  photos and amount; a host note on each reveal; a refused hub request,
  including no key after a restart, sends nothing.
- `test/fixerPeople.test.ts`: a pro as role `pro` in `people.json`; `shared:
  true` for a pro on two properties; STOP across properties; the opt-in text
  only to a pro who asked to text, after the host saved them; nothing a pro
  receives names another property.
- `test/fixerHosted.test.ts`: `set_flows` with `fixer: true` behind
  `FIXER_CORE=1`; tool lists with Fixer Core on and off; Grok and Muse only;
  two accounts apart.
- `test/cleanerRepairAsk.test.ts` (Decision 8A): the DONE question's new
  words only with Fixer Core on; a reply that's both a supply and a repair;
  STOP, HELP, injury and code-like texts still win.

**Updated tests.** `cleanerHostedRegistry` (`fixer-not-yet` only without the
flag), `propertyFlows`, `propertyClientMatrix`, the pinned assistant texts,
and the cleaner supplies-question tests.

**Before shipping.** `scripts/ci-check.sh`: the suite, typecheck and the
door-code secret scan. The Scratch smoke gains a Fixer Core drive with a
made-up pro on a 555 number: open job → contact → booked → visit page → done
with a photo → cost. No real call, email or text.

**The real repair.** #159 is done when outside hosts run at least one real
repair end to end. That contacts a real pro and shares a real door code, so
it needs Saad's okay, and a host runs it with their own agent.

## How the build issues map

| Issue | Parts |
| --- | --- |
| #170 Preferred pros, asked first | Part 2 (pros, setup step 1), Part 3 (preferred pro first), the preferred-list question, `people.json` role `pro` |
| #171 Jobs and what starts them | Part 2 (jobs, windows and the hub's merged stays, upkeep), Part 3 (opening a job), Decision 8 |
| #172 Shortlist and the host's pick | Part 3 (the shortlist), `add_candidates`, `pick_pros` |
| #173 The agent contacts and books | Part 3 (contacting, booking), the sweep |
| #174 Access, done with photos, cost | Part 4, the visit page, the gates doc |

#170 and #171 can start in parallel once this is merged. #172 needs #171's
jobs. #173 needs #172. #174 needs #173's bookings.

## Later

- Per-visit codes from a lock partner (#180).
- A pro network connected from the server, if #175 finds one worth it.
- Recurring pros for upkeep booked without a new question each time.
- Jobs during a stay with the guest's consent.
- Warranties and invoice files.
