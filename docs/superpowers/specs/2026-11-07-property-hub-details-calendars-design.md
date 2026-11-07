# Property hub: property details and booking calendars

Date: 2026-11-07. Status: draft, decided in review with Saad on 2026-11-07.
Issue: saadvz/TourCore#165, part of saadvz/TourCore#158 (Phase 0).

## Goal

Each property has one hub that holds its details and its booking calendars.
Cleaner Core and Supply Core both read from it. Supply Core stops importing
Cleaner Core's files, and there is one calendar upload flow.

## What Saad said

- This branch takes the property details and calendars only (option A of
  three: B added door access, C added shared people too).
- Shared people move to their own issue, saadvz/TourCore#190.
- Door access stays in #165 for a later branch. #165 stays open.
- When Cleaner Core and Supply Core are both on, Supply Core's checkout dates
  come from the shared calendars, not from Cleaner Core's cleanings. A
  cleaning the host called off still counts as a stay for supplies while the
  booking is on the calendar.
- The hub is its own module with a file in each property's folder
  (approach 1 of three: 2 wrapped Cleaner Core's file, 3 put the hub in the
  account registry).

## Not in this version

- Door access and the door access request (#165).
- Shared people, the host's confirmation of them, and "which property?"
  (#190).
- Fixer Core reading the hub.
- Changing the registry's property `label`, or any tool's name or shape.

## What exists today

- `LiveFile` in `src/cleaner-core/liveDesk.ts` holds the property's details
  (`nickname`, `address`, `propertyType`, `timeZone`, `checkoutTime`,
  `checkInTime`), its calendars (`calendarLink`, `calendars`, `google`,
  `sourcesDone`) and the pending `calendarUpload`.
- `SupplyFile` in `src/supply-core/store.ts` holds a standalone property's
  `settings.property`, its own `sources`, its own `calendarUpload`, and
  `checkouts` from its last good read.
- With cleaning on, Supply Core reads the property and the checkout dates
  through Cleaner Core's desk (`propertyForSupplies`, `turnoverDates`), wired
  in `src/supply-core/hosted.ts`. A tenant switched to Supply Core copies the
  property over (`adoptProperty`, called from `src/hosted/service.ts`).
- There are two calendar upload flows: Cleaner Core's
  (`issueCalendarUpload`, `uploadCalendarLink`, the private page in
  `src/cleaner-core/uploadPage.ts`, path `/cleaner-core/calendar-link/`) and
  Supply Core's (`saveSources`, `uploadCalendarLink` in
  `src/supply-core/desk.ts`, path `/supply/calendar/`, POST only).
- Supply Core imports from `cleaner-core/`: `calendar.ts`, `fetchLimits.ts`,
  `sources.ts`, `setupAsk.ts`, `liveDesk.ts` (`cleanerCalendarFetch`,
  `liveDeskFor`), `assistant.ts`, and `hosted/registry.ts`,
  `hosted/properties.ts`, `hosted/router.ts` in `supply-core/hosted.ts`.

## Design

### The hub

A new module, `src/hub/`. One hub per property folder, opened with
`hubFor(root, deps)`. It is cached per folder, runs its writes one at a time,
and saves atomically, like `liveDeskFor`. `forgetHub(root)` drops it, called
wherever `forgetLiveDesk` is.

`hub.json` sits next to `cleaner-live.json` and `supply.json`:

```ts
interface HubFile {
  schemaVersion: 1;
  property: {
    nickname?: string;
    address?: string;
    propertyType?: string;
    timeZone?: string;
    /** "HH:MM" */
    checkoutTime?: string;
    checkInTime?: string;
  };
  /** In dedupe order. The legacy single Guesty Lite link becomes the first entry, named "Guesty Lite". */
  calendars: { name: string; url: string }[];
  google?: boolean;
  /** The host said there are no more booking calendars to add. */
  calendarsDone?: boolean;
  /** The pending upload link: the sha256 of its code, never the code or the link. */
  calendarUpload?: { hash: string; expiresAt: string; name: string; by?: Caller };
  /** Checkout dates from the last read where every calendar read cleanly. */
  checkouts?: { dates: string[]; at?: string; failedAt?: string };
  /** Calendars only one flow had when the data moved. Never read. See "Moving existing data". */
  calendarsSetAside?: { name: string; url: string }[];
}
```

What stays where it is:

- Cleaner Core keeps the host, the business name, the cleaner, contacts, the
  door code (`pinSeal`, `lockLocation`), the schedule, payments, and its job
  engine with its snapshots. Its `propertyId` (the engine's tenant id) stays
  too.
- Supply Core keeps its items, orders, carts, budgets, stores and routine.

### Boundaries

- `src/hub/` imports nothing from `src/cleaner-core/` or `src/supply-core/`.
- `src/supply-core/` imports nothing from `src/cleaner-core/`.
- These files move from `src/cleaner-core/` to `src/hub/`, unchanged except
  for their imports: `calendar.ts`, `sources.ts`, `fetchLimits.ts`. The
  calendar fetch override (`setCleanerCalendarFetch`,
  `cleanerCalendarFetch`) moves with them as `setCalendarFetch` and
  `calendarFetch`. Every importer, touring included, imports from `src/hub/`.
- The `AskQuestion` type and `askNext` move from
  `src/cleaner-core/setupAsk.ts` to `src/hub/ask.ts`.
- `src/supply-core/hosted.ts` is the glue that puts Supply Core's desk on
  an account's property. It moves to `src/hosted/supplies.ts`, next to the
  other account code, which may import both flows. The registry, the
  property model and the router stay where they are.

### Guards

Cleaner Core plugs two checks into the hub. The hosted layer connects them
while Cleaner Core is on for the property, and the single-folder setup
connects them always:

```ts
interface HubGuards {
  /** True when a calendar name or link carries the door code. */
  carriesCode(text: string): boolean;
  /** The upcoming cleanings this calendar list would call off. */
  wouldCancel(next: CalendarClaim[]): Promise<string[]>;
}
```

`CalendarClaim` is the `{ id, origin }` pair the engine already uses
(`claimsOf` in `liveDesk.ts`). It moves to `src/hub/`, and so do the source
ids (`guesty-lite`, `ical:<slug>`, `google-calendar`) and the link hash
(`originOf`), so the hub and the engine name a calendar the same way.

With no guards connected (a property with only Supply Core on), the hub still
refuses masked links, private addresses and card numbers, and refuses any
run of 4 or more digits in a calendar's name. That is what Cleaner Core does
today when it can't open the sealed code.

### Property details

- `save_property` (Cleaner Core) writes the hub's property details. Its checks
  stay as they are, including the door-code check on free text.
- `save_supply_settings` with `property` writes the same details, as
  `nickname` and `address` and `timeZone`. It no longer refuses when Cleaner
  Core is on.
- Supply Core's property view is `nickname`, else the first part of the
  address. Today's Cleaner Core view also fell back to the business name. That
  fallback stays in Cleaner Core's own texts only.
- `propertyForSupplies` and `adoptProperty` are removed.

### One upload flow

- `hub.issueCalendarUpload(name, google, by)` makes the one-time link: 32
  random bytes, only the sha256 kept, 10 minutes. A new link replaces the
  last one. `google: true` is saved at once, as today.
- The link is `<property base>/calendar-link/<code>`. It takes a POST from
  Grok's own computer and has the private browser page for Claude, ChatGPT
  and Muse (`uploadPage.ts`'s calendar page, moved to `src/hub/`). Supply
  Core gains the page.
- `/cleaner-core/calendar-link/<code>` and `/supply/calendar/<code>` still
  route to the hub's link, so a link handed out just before a deploy works.
- The router accepts the link while any flow is on for the property.
- An upload is refused with 400 when the link isn't public https, is a masked
  placeholder, holds a card number, or `carriesCode` says it holds the door
  code. A link under an existing name replaces that one, and every other
  saved calendar stays.
- An upload whose list `wouldCancel` says would call off cleanings is
  refused with 409, as today. The agent asks the host and saves through
  `save_sources` with `dropJobs: true`.
- The link is never repeated in a reply or written to a log.
- `save_sources`, `save_calendar_link` and `save_supply_sources` all issue
  links and save through the hub. `save_supply_sources` no longer refuses when
  Cleaner Core is on. `save_sources` keeps `dropJobs` and asks `wouldCancel`
  before saving.

### Reading the calendars

`hub.readCalendars({ googleEvents })` fetches every saved link through
`readPublicCalendar` and returns, for each calendar, its name, source id, link
hash, and either the body or the failure reason. Google counts only when the
host saved Google, and is read from the events the agent passed in. Events
none of which read as a stay or a block count as unread, as today.

After a read:

- When every calendar read cleanly (Google included, if saved), the hub saves
  the checkout dates as a sorted set with no repeats in `checkouts.dates`,
  and the time in `checkouts.at`.
- Otherwise it saves the time in `checkouts.failedAt` and keeps the last
  good dates.

Who reads:

- **Cleaner Core**'s `readCalendars` calls the hub's and runs its own engine
  logic on the results, unchanged: held snapshots, the partial-failure
  rules, `allOrNothing`, `fromLink`.
- **Supply Core**'s `check_supplies` calls the hub's `readCalendars` whenever
  any calendar is saved, whether Cleaner Core is on or off. Its by-bookings
  items count `checkouts.dates`. After a failed read they wait for the next
  good one, as today.

There is no cache between the two flows. Two reads of the same link in an hour
is fine.

### Setup steps

- Cleaner Core's `property` and `sources` steps, and Supply Core's property
  and bookings-source steps, all read the hub. Whichever flow the host sets
  up first asks. The other finds the step done and moves on.
- Supply Core asks for calendars only when an item is "every N stays" and
  the hub has none. That doesn't depend on Cleaner Core any more.
- `supplySetupAsk` loses its `standalone` argument, and Supply Core's desk
  loses `standalone` and `cleaning` from its deps.

### Moving existing data

`hubFor(root)` moves the data the first time it opens a folder without
`hub.json`. Both desks open the hub before they read their own file, so no
desk holds the old fields in memory to save back. This covers the shared
service and the single-folder setup alike.

Order, so that a crash at any point is finished by the next open:

1. Write `hub.json` atomically.
2. Remove the moved fields from `cleaner-live.json`, then from
   `supply.json`, each atomically.

When `hub.json` already exists, an open only does step 2 for any file that
still has the fields.

Rules:

- **Property details:** each field Cleaner Core saved wins. Supply Core's
  `settings.property` fills only what Cleaner Core never saved.
- **Calendars:** when only one file has calendars, the hub takes them. When
  both have them, the list in use wins: Cleaner Core's when cleaning is on
  for the property (and always in the single-folder setup), else Supply
  Core's. The legacy `calendarLink` counts as part of Cleaner Core's list.
- **Set aside:** links in the losing list that aren't in the winning one go
  to `calendarsSetAside`. Nothing adds them by itself, because a new
  calendar gives Cleaner Core new cleanings, and those text the cleaner.
  While the list isn't empty, `get_state` and `get_supply_state` carry one
  line: "Supply Core had its own calendars (Airbnb) that aren't in this
  property's list. Ask the host whether to add them." Names only, never
  links. To add one, the host sends its link again through an upload link,
  like any new calendar, with the usual checks. Any later save through
  `save_sources` or `save_supply_sources`, `done: true` included, clears
  the list. The links stay in `hub.json` only so an operator can recover
  them. No reply or log ever carries them.
- **Google and done:** `google` is set when either file had it.
  `calendarsDone` is set when the winning list's file had `sourcesDone`.
- **Pending upload:** Cleaner Core's moves over. Supply Core's is dropped.
  It expires within 10 minutes anyway.
- **Checkouts:** Supply Core's last good `checkouts` move over. Cleaner
  Core has none.

`hub.json` is a property file: it joins `PROPERTY_FILES` in
`src/cleaner-core/hosted/migrate.ts`, and backups and exports carry it like
the others.

### Cleaner Core's reads of the moved fields

`LiveDesk` reads the property details and calendars from the hub through
one private accessor, in place of `this.file.<field>`. Its own file loses the
fields. Its replies and texts read the same as today.

## Testing

All tests use 555 numbers and made-up codes.

- `test/hub.test.ts`:
  - Saving the property details.
  - Saving the calendars, with the masked, private-address and card refusals.
  - The upload flow: a new link replaces the old one, expiry, the 400 and
    409 refusals, the link never in a reply.
  - With guards: `carriesCode` refuses a name or a link, and `wouldCancel`
    gives 409.
  - Without guards: a name with 4 or more digits is refused.
  - `readCalendars`: results for each calendar, and Google read only when
    saved.
  - Checkouts: kept only after every calendar reads cleanly. A failed read
    keeps the last good dates and sets `failedAt`.
- `test/hubMigration.test.ts`:
  - Each rule above, including set-aside calendars that add no cleaning.
  - A crash after `hub.json` is written: the next open finishes the move.
  - A desk opened on the folder never writes the old fields back.
  - A single-folder setup moves the same way.
- `test/hubBoundaries.test.ts`: no file under `src/supply-core/` imports from
  `src/cleaner-core/`, and no file under `src/hub/` imports from either.
- Existing behavior tests keep their assertions and change only their setup
  (fields, paths): `test/cleanerCoreStepG.test.ts` (fetch limits),
  `test/twoPropertiesEndToEnd.test.ts`, `test/cleanerSupplyDesk.test.ts`, the
  Supply Core desk tests, and `test/cleanerHostedRouter.test.ts`.
- A Supply Core test with cleaning on gets its checkouts from the calendars,
  and a cleaning the host called off still counts while the booking is on
  the calendar.

## Safety gates

- `docs/cleaner-core-safety-gates.md`:
  - The "Fetch limits" row also points at `test/hub.test.ts`.
  - A new row, **Shared calendars**: a calendar change through either
    flow, or an upload, can't call off a cleaning without `dropJobs`, and
    can't carry the door code. Moving the data adds no calendar to Cleaner
    Core. Its proofs are `test/hub.test.ts` and `test/hubMigration.test.ts`.
- `docs/supply-core-safety-gates.md`: a new row says by-bookings items count
  only checkouts from a read where every calendar read cleanly.
- Proof: `npm run typecheck`, `npm test`, `scripts/ci-check.sh`, and the
  verify-cleanercore skill's offline proof (`prove-step-g.sh`). No live run.

## Done when

- No file under `src/supply-core/` imports a file under `src/cleaner-core/`,
  and a test checks it.
- There is one calendar upload flow, the hub's, for both flows.
- Supply Core's checkout dates come from the shared calendars.
- Existing properties move to `hub.json` on their first open, with no
  calendar added to Cleaner Core.
- The safety gates stay green.
