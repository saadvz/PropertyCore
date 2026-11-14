# Booking details from Airbnb emails

Date: 2026-11-14. Status: draft, for Saad's review.
Issue: saadvz/PropertyCore#244, a child of #236 (verification roadmap).
Blocks #239 (headcount) and #242 (guest codes). Feeds #180 (smart-lock codes).

## Why

Property Core reads booking calendars. They say which nights are booked, but
not the check-in or checkout times, and not how many guests are coming. The
host's usual times stand in, and when a guest arranges a late checkout or an
early arrival, the cleaner's window is wrong. Airbnb's confirmation, change
and cancellation emails carry the times, the guest count and the
confirmation code the minute a stay is booked.

## Goals

- From Airbnb confirmation, change and cancellation emails, each stay gets
  its times, guest count and confirmation code, matched to the right
  property.
- Cleaner Core uses the email's times in place of the host's usual times,
  with a host note when they differ from what was saved.
- A same-day booking's turnover uses the email's times as soon as the email
  is read.
- A changed time moves the cleaner's window through Cleaner Core's existing
  rules.
- A cancellation calls off the turnover through the existing rules, with the
  host's yes when anything is live.
- Every parsed email is stored as received, append-only, so the times can be
  rebuilt.

## Not in this version

- Reading guest messages (#242) and pet information (#239).
- Moving or revoking a smart-lock code. That waits on #180 and the lock
  partner meeting. This version calls a hook at the two places it would happen, and
  the hook does nothing.
- Anything that needs Cognito, a lock partner, or Property Core reading a
  mailbox itself. The host's agent reads the mail, as it already reads
  Google Calendar for Cleaner Core.
- Vrbo, Booking.com and other platforms' emails.

## Anti-goals

- An email never adds or removes a booked night. The calendar decides which
  nights are booked.
- An email never stores, repeats or logs a door code.
- An email from anyone but Airbnb changes nothing.
- An email never texts anyone by itself. Texts go out only the way Cleaner
  Core's existing rules already send them after a time changes.

## Approaches

1. **The agent passes the email, and Property Core parses it** (chosen). The
   agent hands over the sender, subject, plain-text body, message id and
   received time, the way it hands over Google Calendar's `events.list`
   today. Property Core reads the fields with its own parser. Parsing is
   deterministic and tested on sample emails, and the stored email is the
   email itself, so the times can be rebuilt by parsing the log again.
2. **The agent reads the fields and passes a booking.** Less code here, but
   each assistant (Grok, Claude, ChatGPT, Muse) would read the email its own
   way, a misread time would go straight to the cleaner, and the log would
   hold the agent's summary rather than the email.
3. **Both, with the agent's fields as a fallback** when the parser can't read
   an email. More surface and two paths to test. Left for later if Airbnb's
   format changes faster than the parser keeps up.

## Design

### The tool

A new Cleaner Core tool, `read_booking_email`:

```ts
{
  email: {
    from: string;        // the From header, like "Airbnb <automated@airbnb.com>"
    subject: string;
    body: string;        // plain text, up to 50,000 characters
    messageId?: string;  // the Message-ID header, for dedupe
    receivedAt?: string; // ISO time the email arrived; defaults to now
  };
  googleEvents?: GoogleEventList; // as check_now takes them
  confirmation?: string;          // the host's yes to a cancellation, as standDown does it
}
```

The host's agent fetches the emails from the host's own connected mailbox;
Property Core never reads a mailbox. The Claude, ChatGPT and Muse
instructions (`BOOKING_EMAIL_INSTRUCTION`) and the tool description tell the
agent to call it for each Airbnb reservation email as it arrives, never for a
guest message or a forward, and, when the host's email isn't connected, to
say once that connecting it gives Cleaner Core each booking's exact times.
Grok's initialize instructions are pinned byte for byte, so Grok gets this
from the tool description only.

### Parsing (`src/hub/airbnbEmail.ts`)

A pure function, `parseAirbnbEmail(email)`, returns either a parsed booking
or a reason it couldn't:

```ts
interface ParsedBookingEmail {
  kind: "confirmed" | "changed" | "cancelled";
  confirmationCode: string;       // like HMABC12345
  listing?: string;               // the listing's title as the email shows it
  checkIn?: { date: string; time?: string };   // "YYYY-MM-DD", "HH:MM"
  checkout?: { date: string; time?: string };
  guests?: { adults: number; children: number; infants: number; total: number };
}
```

- **From Airbnb only.** The sender's address (the last `<...>` in the From
  header, or the whole header when it's a bare address) must be at
  `airbnb.com` or a subdomain. A display name that looks like Airbnb's
  address counts for nothing. Anything else is refused with `not-airbnb`.
- **Kind** from the subject: "Reservation confirmed" and "booking confirmed"
  are `confirmed`; "altered", "changed", "updated" and "alteration" are
  `changed`; "canceled" and "cancelled" are `cancelled`. A request ("Alteration
  request", "Cancellation request") isn't a change until the subject says it
  was accepted. Anything else is `not-a-reservation` (a guest message, a
  payout, a review request).
- **Confirmation code**: the `HM` code Airbnb uses, 10 letters and digits.
  Without one, `no-code`.
- **Dates and times** from the labeled Check-in and Checkout blocks. A label
  is a line that is only the label, or the label and a date; "Check-in is
  easy" isn't one. Both layouts Airbnb's plain text uses are read: one label
  per block, and the two labels on one line with the dates and times side by
  side below. In that layout a value at or past the Checkout header's column
  is checkout's, so "Flexible      11:00 AM" gives checkout 11:00 and
  check-in no time. In the block layout a time comes from the date's own line
  or from the next line when that line is only a time. Dates without a year
  take the earliest year that isn't more than a month before the email (a
  December email about "Jan 3" is next year, a January email about "Dec 30"
  is last year). A cancellation may give only a range ("Dec 12 – 14"); that
  is read too, but a range that runs into a clock time ("canceled on Nov 14,
  2026 - 10:32 AM") or spans over a year isn't one. A cancellation with no
  dates is matched by its confirmation code.
- **Guests**: "2 guests", or "2 adults, 1 child, 1 infant". `total` is adults
  plus children, as Airbnb counts guests; infants are kept on their own.
- **Listing**: the line above the room-type line ("Entire home/apt",
  "Private room", and Airbnb's other types). Optional.

### Never a door code

Before anything is stored, the body passes through `redactBookingEmail`:

- Any run of 3 or more digits (alone or split by single spaces, dots or
  dashes, like 3156, 31 56 or 3-1-5-6) on a line that mentions a code, PIN,
  passcode, password, combination, lock, lockbox, keypad, door, gate, garage,
  opener, entry, entrance, enter, access or alarm is replaced with
  `[code removed]`, and so is a line of only digits right after one.
- Any text Cleaner Core's door-code guard says carries the saved code (the
  same `carriesCode` the calendar upload uses) is replaced too, in the body,
  subject, sender and message id.

The redacted body is what the log keeps and what is parsed. The confirmation
code is letters and digits, so it never trips the first rule. An email that
can't be read (a forward, a guest message) keeps no body at all, only a hash
of it so a second copy is known.

### The log (`booking-emails.jsonl`)

One file per property folder, next to `hub.json`. Each line is one email as
received (redacted), with its parse result and what came of it:

```ts
interface BookingEmailRecord {
  at: string;                // when Property Core took it
  receivedAt: string;
  messageId?: string;
  from: string;
  subject: string;
  body?: string;             // redacted; none for a refused email
  bodyHash?: string;         // for dedupe
  parsed?: ParsedBookingEmail;
  refused?: string;          // the parse refusal, when there's no parse
  outcome: string;           // applied, pending, mismatch, duplicate, ...
}
```

- Lines are only ever appended. A second copy of the same email (same
  message id, or the same sender, subject and body when there's no id) is
  recorded as `duplicate` and changes nothing.
- `rebuildBookings(records)` replays the log, in the order Airbnb sent the
  emails, into the latest booking per confirmation code (a change replaces
  the times, a cancellation marks it cancelled; one still waiting on the
  host's yes doesn't). The desk keeps no other copy: it rebuilds from the
  log on open, so the times can always be rebuilt from the emails.
- An email older than one already counted for the same booking is recorded
  `superseded` and changes nothing, whether it's passed late or was waiting
  on the calendar when the newer one applied.
- The log joins the property files that backups and exports carry.

### Matching the property

- Each property can save its Airbnb listing titles, stored in the hub as
  `airbnbListings`. The host confirms one the first time an email names it:
  the agent asks, and on the host's yes calls `read_booking_email` again with
  the same email and `thisListing: true`.
- An email matches a property when its listing title equals (ignoring case,
  spacing and punctuation) one of the saved titles or the property's
  nickname. With no listing title in the email, it matches when the body
  contains a saved title (not the nickname, which is the host's own word).
- **One property** (the single-folder setup, or an account with one
  property): an email that doesn't match is recorded as `mismatch`, changes
  nothing, and keeps one host note naming the listing: "An Airbnb email for
  ‘Cozy Loft’ doesn't match 12 Scratch Lane. Is that listing this property?"
- An email that doesn't name its listing (some cancellations) matches when
  this property already took an email with its confirmation code.
- **Several properties** on the shared service: `read_booking_email` with no
  `property` is matched across the account's properties with Cleaner Core
  on. Exactly one match routes it to that property's desk. None, or more
  than one, changes nothing and the reply asks the host which property, by
  label. Nothing is stored until a property is named, because there's no
  property folder to store it in. The agent passes `property` on the retry.

### Matching the stay

The calendar decides which nights are booked. The email adds times and
headcount. For a `confirmed` or `changed` email:

- **Same nights**: a job whose stay has the email's check-in and checkout
  dates. That stay's job takes the email's checkout time, and the job before
  it (whose next check-in is that stay) takes the email's check-in time.
- **Disagrees**: a job shares one of the two dates but not both. Nothing
  changes. One host note: "Airbnb says HMABC12345 is Dec 12 to Dec 15, but
  the calendar shows Dec 12 to Dec 14. Check the booking, then run the
  checks again."
- **Not on the calendar yet**: no job has either date. The tool first reads
  the calendars once (the same read as `check_now`; with Google saved, only
  when the agent passed `googleEvents`). Still nothing: the email is
  `pending`. Every later calendar read tries pending emails again. One still
  not on the calendar 3 hours after it arrived gets the "disagrees" note
  instead, worded for a missing stay.

This is how a same-day booking gets its times within minutes: the email
reads the calendars and applies at once, and when the calendar lags, the
next check applies it.

### Applying the times (Cleaner Core)

A new engine method, `setJobTimes({ jobId, checkout?, checkIn? })`, adds the
host-time facts for one job, the same facts `confirm_times` adds today, and
then sends whatever Cleaner Core's existing rules send for a changed time.
That means:

- A job not yet offered is offered with the email's times when its offer is
  due.
- A job already offered or confirmed with another checkout time gets Cleaner
  Core's existing update text, after its usual settle hold. A change to only
  the next check-in time sends the cleaner nothing, which is what Cleaner
  Core's existing rules do for a check-in change today; the host's note
  about the new time is how the cleaner hears of it.
- A job under way, done, called off or declined is left alone.
- A job whose door code has already gone out is left alone, and the host
  gets a note that the times changed after the code went out (moving a code
  is #180).

The email's times win over the host's usual times and over times saved for
that job. When they differ from what was saved (the job's own times, or else
the usual times), the host gets one note per job: "Airbnb says checkout on
Sunday, Dec 14 is 12:00 PM, not 11:00 AM. I'm using 12:00 PM."

An email with no time for a side (Airbnb sometimes shows "Flexible") changes
only the side it has.

### Cancellations

- The tool reads the calendars first. When the stay is gone from the
  calendar, Cleaner Core's existing rules have already called the cleaning
  off (and texted the cleaner if they'd been told). The email is recorded
  `applied` and nothing more happens.
- The stay is the one the booking's earlier emails gave, else the
  cancellation's own dates. When the calendar never showed it, nothing is
  called off and the host gets a note.
- When the calendar still shows the stay:
  - Nothing live for it (the cleaner hasn't been told): the reply and one
    host note say Airbnb cancelled it while the calendar still shows it,
    and ask the host whether to call the cleaning off. Nothing changes.
  - Something live (the cleaner was offered or confirmed): the same ask,
    with the exact text the cleaner would get, and a confirmation code, as
    `stand_down` does today.
  - With the host's yes, the agent calls again with `confirmation`, and the
    engine's new `callOffJob(jobId)` calls off that one job the way a stay
    leaving the calendar does: the same tombstone, the same cancel text. A
    job called off this way stays off while the calendar shows the same
    checkout date, even when the next booking changes.

### The smart-lock hook (stub)

```ts
interface StayCodeHook {
  windowMoved(input: { jobId: string; window: { start: string; end: string } }): Promise<void>;
  stayCancelled(input: { jobId: string }): Promise<void>;
}
```

Cleaner Core calls it after an email moves a window and after an email's
cancellation calls a cleaning off. The default does nothing. #180 fills it
in once the lock partner is chosen.

### What the host and the agent see

- `get_state` and `check_now` carry the notes above.
- Each job in `get_state` gains `guests` and `confirmationCode` when an
  email gave them, for #239 and #242 to build on.

## Testing

All with made-up emails in `test/fixtures/airbnb-emails/`, made-up
confirmation codes, made-up door codes, and 555 numbers.

- `test/airbnbEmail.test.ts`: each sample parses to its fields (both
  layouts, year rollover, guests with and without children and infants,
  cancellation range, cancellation with no dates); non-Airbnb senders and
  non-reservation subjects are refused; door codes are redacted and the
  confirmation code isn't.
- `test/bookingEmailLog.test.ts`: append-only, duplicates, `rebuildBookings`.
- `test/bookingEmails.test.ts` (desk, end to end with the fake sink):
  - A confirmation sets both sides' times on the right jobs.
  - A same-day booking that isn't on the calendar yet applies after the
    calendar read the tool runs, with no second call.
  - A change moves an offered cleaner's window through the existing update
    text; the hook is called.
  - A cancellation the calendar already removed is recorded and nothing
    else happens; one the calendar still shows asks, and with the yes calls
    the cleaning off with the existing cancel text; the hook is called.
  - A mismatched listing, and an email whose dates disagree with the
    calendar, change nothing and keep one host note.
  - The host note when the email's times differ from the saved ones.
  - Nothing in the log or any reply holds the door code.
- Hosted: an email routes to the one matching property on a two-property
  account, and asks which property when it matches none or both.

## Safety gates

A new row in `docs/cleaner-core-safety-gates.md`, **Booking emails**: only an
email from Airbnb is read; it never adds or removes a booked night; a
cancellation the calendar still shows calls nothing off without the host's
yes; the log and replies never hold a door code. Proofs are the three test
files above.

## Left to the builder

- The exact host-note wording, kept in the style of the existing notes.
- The pending window (3 hours) is a constant, easy to change.
