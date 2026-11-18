# Hours log: rows from existing records, monthly review, Sheet export (#238)

Part of #236. This covers the "Can start now" part of #238: rows from the records Property Core already keeps (cleanings, Fixer visits, supply orders, host approvals), the monthly review, and the Sheet export. The owners' entries on their standing lock codes wait on #180 and a meeting with the lock partner, so they get an empty source to plug into.

## Why

Some hosts have to prove how much time they spend running their rentals. Today they rebuild hundreds of rows by hand at year-end from booking exports, lock histories, email, calendars and phone bills. Property Core already holds much of that record. This writes it down in the host's format: one row per work session, with the proof on the row.

## Goals

- One row per work session, with the issue's columns: date, start, end, property, participant, activity code, category, activity, task, supporting reference, on site or remote, hours.
- Every row has a supporting reference to a record Property Core keeps: a cleaning job, a repair job, a supply order, or the host's saved approval.
- Owner rows record only what the owner did. Work Property Core did by itself never lands in the owner's log.
- Everyone else's time goes to their own log: the cleaner, and each pro.
- The host reviews and confirms each month in agent chat before export.
- The confirmed month goes to the host's Google Sheet in their own column layout, with no manual edits.
- Rows are derived. They are rebuilt from the records on every read, so a change to the owner-row rules rebuilds every month.

## Non-goals

- Tax advice, or deciding what counts toward any tax test.
- Owner rows from standing lock codes (#180), and measured visit times (#237). Their extension points are here; their data is not.
- Property Core holding a Google token on the hosted service.

## Anti-goals

- The system writing owner time for something it did itself. A test proves it never does.
- Made-up owner hours. An approval is one moment in time; the hours on it come only from minutes the host set for that activity code. Unset is 0, and the review names the codes with no minutes.

## Approaches

1. **Derived on read (picked).** A pure builder reads `hub.json`, `cleaner-live.json`, `cleaner-job/cleaner-core.json`, `fixer.json` and `supply.json` in the property's folder and returns the month's rows. A confirmed month keeps only a fingerprint of its rows and the rules version. Rebuilding is free, and nothing in the existing desks changes.
2. **Append-only event log.** Each desk writes a row as things happen. Live, but it touches every desk, and a rule change needs a replay. It works against "rows are derived".
3. **Property Core writes the Sheet itself** with its own Google approval. The hosted service holds no Google token today (docs/google-drive.md), and a second Google approval is a cost for every host. The host's agent already has a Google connector.

## Design

### Records → rows (`src/hours-log/sources.ts`)

| Record | Row | Log | Hours |
| --- | --- | --- | --- |
| Cleaner Core job, done | cleaning, START to DONE (`startedAt`→`doneAt`), on site | cleaner | measured |
| Host gave a cleaning time (`hostFacts[].at`) | confirm cleaning times, remote | owner | host's minutes for the code |
| Cleaning marked paid by the landlord (`pay[job].confirmedBy: landlord`) | pay the cleaner, remote | owner | host's minutes |
| Cleaning marked paid any other way (a receipt email, or unsaid) | record a payment | Property Core | 0 |
| Fixer job, done, with a booking | repair visit, booking start to done (or the booking's end), on site | the pro's | scheduled |
| `hostGo`, `booking.hostYes`, `revisedQuote.hostYes`, `quotePick`, each of `reschedules`, cost or done saved by the host | approve repair / approve booking / approve new price / pick a quote / move a visit / record a cost / confirm a repair is done, remote | owner | host's minutes |
| Supply order approved by the landlord or on the agent's Pay card | approve an order, remote | owner | host's minutes |
| Supply order placed by the host in the agent's browser | place an order, remote | owner | host's minutes |
| Every supply order the agent placed (all but `host-browser`) | place an order, remote | Property Core | 0 |
| Owner entry on a standing lock code | (empty until #180) | owner | measured |

Times are local to the property (`hub.json` time zone). A cleaning with a DONE but no START keeps its date, takes the arrival time Grok saved as start when there is one, and is flagged in the review. Pro visits are scheduled times until visit records (#237) land.

### Owner-row rules (`src/hours-log/ownerRules.ts`)

One file holds which actions count as the owner's, and how their hours are found, with `OWNER_RULES_VERSION`. The tax professional's review tightens this file. The builder routes any row whose actor is not the host away from the owner log, whatever the source says. The host's facts at the same instant came from one action in chat (both cleaning times in one call, a repair marked done with its cost), so they are one owner row and its minutes count once.

### Activity codes (`src/hours-log/codes.ts`)

A placeholder list of codes in groups, one per row kind, until the tester's list (about 40 codes in 7 groups) arrives. The host can replace the list, map each row kind to one of their codes, and set minutes per code with `save_hours_settings`.

### Monthly review and export (`src/hours-log/desk.ts`, tools)

- `review_hours {month}`: the month's rows by log, totals, what needs the host (codes without minutes, cleanings without a START, checkouts with no cleaning row), and a confirmation code. Called again with the code after the host's yes, it confirms the month: it saves the rows' fingerprint and the rules version.
- `export_hours {month}`: for a confirmed month whose rows still match, each log as a header and rows in the host's column order, for the agent to write into the host's Google Sheet with its own connector. Called again with `stored: true` after the agent wrote it, it records the export. Rows that changed since the confirmation refuse the export and ask for a new review.
- `save_hours_settings`: codes, row-kind mapping, minutes, column order and headers, owner name, and the Sheet's name or link.

State is one `hours.json` in the property's folder: settings and each month's confirmation and export. A confirmation keeps the month's owner facts as they were (not rows: the rules still apply to them on every rebuild), because some records replace the host's earlier approval, like a rescheduled booking or a cleaning whose dates moved. Without that, a confirmed month would lose a real owner row. The fingerprint covers the rows and the host's columns. An approval replaced before its month is confirmed was still lost here; each desk's record of the host's approvals now keeps it (`docs/superpowers/specs/2026-11-17-hours-log-follow-ups-design.md`).

### Reconciliation

Every checkout in the month from the hub's stays has a cleaning row, or the review lists it. The lock-event check waits on #180.

### On the shared service

Behind `HOURS_LOG=1`. While on, the three tools are listed for every assistant on an account where any property has a flow on, and take `property` like the other property tools.

## Left to the builder

- Wording of the review's lines and the tool descriptions.
- The placeholder codes' names.
