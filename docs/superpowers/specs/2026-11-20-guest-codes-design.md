# Guest codes: a door code for each stay

Status: design approved by Saad on 2026-11-20. Issue #262, part of #236. Ships with #180 (merged in #266) as one
access package. Decisions from Saad in chat on 2026-11-20 are marked **(decided)**.

## Why

Our tester makes each guest's lock code by hand in the lock app and pastes it into the arrival
message, same-day bookings included. A direct lease runs entirely outside the flow. In the owner
survey (18 Nov), a code for each guest's exact dates ranked second of six future additions (41 of 92
owners); only 16 of 92 automate it today.

## Goals

1. Each booking in the property's booking-email log gets its own code on the connected locks, live
   from check-in to checkout.
2. A changed booking moves the code, a cancellation removes it, and a late checkout the host said
   yes to moves its end.
3. The host gets each code on a private single-use page and pastes it into the platform.
4. A lease the host enters gets a code from its start to the end of move-out day. The tenant gets
   it the way a standing code goes out: one opt-in text, then a single-use page.
5. Guest codes are named in `visit-codes.json` as `guest`, so visit records, the hours log and the
   "someone else came in" check can tell a guest's code from an unknown one.
6. A property without a connected lock, or without guest codes switched on, behaves exactly as
   before.

## Non-goals

- Sending anything to a guest. Property Core never messages a guest; the host pastes the code.
- Putting the code into a booking platform's message on the server (Guesty, Hospitable). Booking
  software is on hold: our tester's Guesty Lite has no API. The design leaves room for it (below).
- Codes for stays seen only on the calendar **(decided: booking emails only)**.
- Early check-in, and moving a code's start. Only the end moves (late checkout).
- Automating the Airbnb website (its terms ban bots).

## Anti-goals

- The agent sees a guest code's digits **(decided: the page, never agent chat)**. A tool returns
  status only, as for every other code.
- A guest code is logged, or stored anywhere but sealed in `door-grants.json`.
- A guest code works outside its stay, or survives a cancellation the host confirmed.
- A guest code falls back to the host's saved code. A guest who has no working code is the host's
  call, told urgently, never a silent swap to the code every cleaner knows.

## Decisions (2026-11-20)

| Question | Decision |
| --- | --- |
| How the code reaches the guest | A private single-use page for the host, linked from a note in agent chat. The host taps once to see the code and pastes it into the platform. Saad first said the code could sit in agent chat, then chose to keep the page so the agent never sees digits. |
| Which stays | Only bookings in the booking-email log (Airbnb today; #263's platforms once the host says yes to each booking). |
| Leases | The host enters the tenant's name, phone, start and move-out day. The tenant gets one opt-in text and, after YES, a single-use page, like a standing code. |
| When a code is made | 7 days before check-in, or at once for a booking made inside 7 days. |
| Flag | A new `GUEST_CODES` flag, which also needs `SMART_LOCKS`. |
| How guest codes work | The host's choice per property: automatic, ask me each time, or off. Only offered once the property's lock is connected; without a connection no code can be made, and the property works as today. |
| Design sign-off (Saad, 20 Nov) | Approved with the host's choice above. No saved-code fallback, an urgent note 24 hours ahead, leases from their start date, only a stay's end moves, and the "guest on 12–15 Dec" label stand as written. |

## How it works today (what this builds on)

- `src/hub/grants.ts`: `GrantBook.sync(flow, wanted)` issues, moves and revokes one flow's codes to
  match a list of `{ jobId, person, window, label, who }`. Each issue names the code in
  `visit-codes.json` through `deps.named`. Leak checks (`codesForChecks`) cover every grant until a
  day after its window.
- `src/hub/doorAccess.ts`: `request({ purpose, jobId, person, window })` releases a grant. A
  standing code never falls back to the saved code.
- `src/locks/desk.ts` and `src/hosted/locks.ts`: standing codes with an opt-in text, YES, and a
  single-use page (`GET` shows a button, `POST …/show` shows the code once).
- `src/hub/bookingEmails.ts`: `rebuildBookings` gives the latest of each booking by confirmation
  code (dates, times, cancelled).
- `src/guest-messages/store.ts`: `lateCheckoutFor(records, checkout)` gives the late checkout the
  host allowed for the stay leaving that day.
- `src/cleaner-core/stayCodeHook.ts`: a booking email or a late checkout asks for a lock sync.
- `tickAllLocks` in `src/hosted/locks.ts`: the lock clock, on Fixer's tick.

## The design

### 1. Switching it on: the host chooses how guest codes work (decided)

- Service: `GUEST_CODES=1`, and `SMART_LOCKS` on with a lock adapter. Either off: no tool listed,
  no code made, page routes answer 404.
- **No connected lock, no guest codes.** Property Core can only make a code on a lock it's
  connected to. A property not on connected locks isn't asked about guest codes, keeps working
  exactly as today, and `get_guest_codes` says so and points to the lock step (`connect_lock`).
- **The host's choice, per property.** Once the property is on connected locks, the lock setup asks
  "How should guests' door codes work?", with the same shape as #180's release setting:

  | Choice | What happens |
  | --- | --- |
  | **Automatic** | Property Core makes a code for each booking, 7 days before check-in, and the host gets the page link. |
  | **Ask me each time** | For each booking, 7 days before check-in (or when it lands, if sooner), the host gets "Make a door code for the guest on 12–15 Dec?" Nothing goes on the lock until their yes for that booking. After it, the code follows the booking (moves, removal) with no further ask. |
  | **Off** | The host keeps making guest codes themselves. Nothing changes. |

  There's no default: until the host answers, it's off. Changing the choice takes the host's yes
  (a confirm code). Choosing off revokes every live guest code at once; the host is told which stays
  had one. Ask to automatic makes codes for the stays still waiting; automatic to ask keeps the
  codes already made.
- Leases (section 5) don't follow this choice: each lease is its own host yes when it's entered.
- Settings and the leases live in a new per-property file, `guest-codes.json`, next to
  `door-locks.json`. It holds no code: the choice, each booking's yes under ask, the leases,
  page-link hashes, and which notes went.

### 2. Which codes are wanted

A new grant flow, `guest`. On each pass the property's guest desk works out the wanted list, and
`syncGrants("guest", wanted)` makes the locks match:

- **Each booking** in `rebuildBookings(readBookingEmails(root))` that is not cancelled, whose
  checkout is still ahead, whose check-in is within 7 days (or already passed), and, under ask,
  that has the host's yes:
  - `jobId`: `stay:<confirmation code>`;
  - `person`: `guest:<confirmation code>` (a guest has no phone in Property Core; the grant only
    needs a stable key);
  - `window`: check-in date at the email's check-in time (else the property's check-in time, else
    16:00), to checkout date at the late checkout the host allowed (`lateCheckoutFor`), else the
    email's checkout time, else the property's, else 11:00. Local to the property's time zone.
  - `label`: "the guest on 12–15 Dec" (never a name from the email, never a phone);
  - `who`: `{ role: "guest" }`.
- **Each lease** (section 5) with the tenant's YES, not stopped or removed, whose move-out day is
  still ahead: `jobId` `lease:<id>`, `person` the tenant's phone, window from the start date at
  00:00 to the end of the move-out day (23:59), `label` the tenant's first name, `who` guest.
- **Platform yes (for #263).** A booking whose log entry needs the host's yes before it moves
  anything (#263's other platforms) is left out until it has that yes. Until #263 lands, every
  booking in the log is Airbnb's and counts as is. The filter is one function, so #263 fills it in.

Everything else follows from the reconcile, with no per-event code:

| Event | What happens |
| --- | --- |
| A booking email lands, inside 7 days | Automatic: code issued on the next pass. Ask: the host is asked once. |
| A booking 7 days out | The same, when the clock pass sees it inside 7 days |
| The host's yes for a booking (ask) | Code issued on the next pass |
| A changed booking (new dates or times) | Window moves |
| A cancellation the log counts | Revoked. A cancellation still waiting on the host (`asked`) changes nothing until their yes. |
| The host's late checkout (#260) | End moves to the new time |
| Checkout passes | The window ends; the lock drops it; the grant stays in the leak checks a day longer |
| A lease removed, or the tenant's STOP | Revoked |

The pass runs on the lock clock (`tickAllLocks`) and right after a booking email or a late checkout
(the existing `StayCodeHook` asks, extended to the stay's job). A failed lock call is retried on the
next pass, as for every other flow.

### 3. How the host gets a stay's code

When a stay's code is set on every door (or by the latest the next morning's pass, when one door is
still programming), the host gets one note in agent chat through `tellLockNote`:

> The code for the guest on 12–15 Dec is on the lock, from 3:00 PM on the 12th until 11:00 AM on
> the 15th. Open this once to copy it into your arrival message: https://…/locks/guest/‹token›

- The page is the standing-code page's twin at `/locks/guest/<token>`: `GET` shows the stay's dates
  and a "Show the code" button and no code, so a link preview never uses it up; `POST …/show` shows
  the code once and ends the link. When doors take different codes (a backup on one door), it names
  each door.
- The link holds a letters-only token. Only its sha256 is stored. It ends when used, at checkout, or
  when a new one is made.
- A new link takes the host's yes (`guest_code_link`, with a confirm code), any time until checkout.
- When the window moves, the code doesn't change, so the host needn't paste again. The note says
  "Same code, now until 1:00 PM." A move to new dates still keeps the code when the lock allows it.
- When a stay is cancelled, the host gets "Removed the code for the 12–15 Dec stay."

The agent sees the link, never the digits. A link is a bearer token, so the page is single-use: if
anything other than the host opened it, the host sees "This link has ended" and asks for a new one.

**Booking software, later.** With a booking-software connection (#239 on hold), the same release can
put the code into the host-approved arrival message on the server at send time. That's a new
release path with its own gate, not built here.

### 4. A guest code that won't program

- At issue: the grant's own note ("I couldn't put the guest's code on the lock yet…"), as for any
  flow; the pass retries.
- At the page: the release runs as for any grant: a failed door gets a backup code for that door,
  named by door, and the host is told. A guest code never falls back to the host's saved code; with
  no backup the page says "The code isn't on the lock yet" and the host is told, urgently when
  check-in is within 24 hours.
- A clock check: a stay checking in within 24 hours whose code isn't set on every door tells the
  host once, urgently, so a guest isn't left at the door.

### 5. Leases

A host tool, `add_lease` (name, phone, start date, move-out date), with a confirm code: "Give Sam a
door code at ‹street› from 1 Jan until move-out on 30 Jun? They get one text asking them to reply
YES first." Then, exactly as a standing code:

- one opt-in text from the line, under the account's texting consent (host confirmed, not stopped);
- the tenant's YES (routed as a standing person's YES is today) puts the code on the locks and texts
  a single-use, 24-hour page link; the text never holds digits;
- a new link takes the host's yes (`lease_code_link`);
- `remove_lease` (with a yes) or the tenant's STOP revokes the code. Changing move-out is
  `change_lease`, with a yes; the code's end moves.

A lease code is made from the start date (or at YES, if later), not 7 days ahead: a lease is known
and stable, and a tenant may need the door on the first day.

### 6. What the agent sees

`get_guest_codes` (and a line in `get_locks`) lists, per stay and lease: dates, status (`waiting`
for the 7-day mark, `programming`, `on-lock`, `backup`, `failed`, `ended`, `revoked`), whether the
host's link was sent or used, and the lease's YES status. Never a code, never a guest's name or
email.

### 7. Checkout signal and "someone else came in"

Nothing new is built: issue names the code `guest` in `visit-codes.json`, so visit records and the
"someone else came in" check already read it. The note to the host can then say "the guest's code
opened the door at 10:40" rather than "someone else". The checkout-time release still keys on the
cleaning's checkout time, which a late checkout already moves.

### 8. Tools

| Tool | What it does |
| --- | --- |
| `guest_codes` | The host's choice for this property: automatic, ask or off, with a yes |
| `make_guest_code` | Under ask, the host's yes for one booking, with a confirm code |
| `get_guest_codes` | Status of each stay's and lease's code, no digits |
| `guest_code_link` | A new single-use page link for one stay, with a yes |
| `add_lease`, `change_lease`, `remove_lease`, `lease_code_link` | Leases, each with a yes |

Listed only with `GUEST_CODES` and `SMART_LOCKS` on and a lock adapter. No tool, description or
reply names the lock partner.

## Safety gates to add

A "Guest codes (#262)" section in `docs/cleaner-core-safety-gates.md`, and a line in
`docs/fixer-core-safety-gates.md` (pros see guest codes only as leak-checked codes). Each with a
test on the fake adapter:

- **Off means unchanged.** Flag off, `SMART_LOCKS` off, no adapter, a property not on connected
  locks, or the host's choice unset or off: nothing reaches a lock, and the page is 404. Without
  `GUEST_CODES` no tool is listed.
- **The host's choice.** No choice means off. Under ask, no code is made for a booking before the
  host's yes for it, and each booking is asked once. Choosing off revokes every guest code.
- **One code per stay, its dates only.** A code is made only for a booking in the log, 7 days
  ahead, for its check-in to checkout; never for a calendar-only stay or a booking waiting on the
  host's platform yes.
- **Moves and removals.** A changed booking moves the code; a counted cancellation revokes it; a
  cancellation waiting on the host doesn't; a late checkout moves its end.
- **Never seen, logged or unsealed.** No tool result, note, state, log, visit line or file but
  sealed `door-grants.json` holds a guest code. The host's note holds a link, never digits.
- **The page.** `GET` shows no code; `POST` shows it once; a used, expired, wrong or cancelled
  stay's link shows nothing. A new link needs the host's yes.
- **No saved-code fallback.** A guest code never falls back to the host's saved code.
- **Leases.** No code before the tenant's YES; the text holds no digits; STOP or remove revokes; the
  code ends at the end of move-out day.
- **Leak checks.** A cleaner's or host's outgoing text holding a live guest code is refused, as for
  any grant.

## Rollout

1. Build and test on the fake adapter, CI green, no network.
2. In the sandbox run for #180, add a booking email for a test stay and check the code appears for
   its dates, moves, and is removed.
3. `GUEST_CODES=1` only after Saad's okay, after `SMART_LOCKS` is live.

## Wording for a design pass

Every host-facing and tenant-facing line here is new and is flagged in the PR: the setup question
and its three choices, the per-booking ask, the code-ready note,
the moved and removed notes, the failed-code notes, the page text, the switch-on question, and the
lease invite and link texts.

## Left to the builder

- File format of `guest-codes.json`.
- How the pass is triggered after a booking email (the hook or a direct call).
- The exact page copy, pending the design pass.

## Open, outside this issue

- #263's per-booking yes: this design filters on it, and #263 defines it.
- Codes for calendar-only stays, if bookings without emails turn out to be common.
- Putting the code into the arrival message through booking software.
