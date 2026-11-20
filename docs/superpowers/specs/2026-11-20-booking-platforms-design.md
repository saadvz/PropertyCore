# Booking emails from more platforms

Date: 2026-11-20. Status: agreed with Saad on 20 Nov (the four questions below are settled).
Issue: saadvz/PropertyCore#263, a child of #236. Builds on #244 (done in #248):
[the Airbnb design](2026-11-14-airbnb-booking-emails-design.md).
Feeds #180 (cleaner codes), #262 (guest codes), #239 (headcount).

## Why

Booking details come from Airbnb's emails today. Hosts also book on Vrbo,
Booking.com and their own direct-booking site, and those stays get only the
calendar's dates and the host's usual times. This adds a setup question for
the host's platforms, and a path for any platform's emails that holds every
booking until the host says yes.

## Decided (19 Nov, in the issue)

- The host picks their platforms per property: Airbnb, Vrbo, Booking.com,
  their own direct-booking site, or Other (they name it). The agent looks
  only for the chosen platforms' emails.
- **Other:** the host names the sender address once. The agent extracts the
  dates, times and guest count, Property Core checks their shape, and **each
  booking waits for the host's yes** before it moves a cleaner's window or a
  door code.
- Direct-booking sites go on the Other path. Their emails are written by the
  host and sent from the host's own address.
- Trust takes more than the sender's domain. A platform email counts only
  with the right sender, a recognized reservation subject and structure, and
  passing SPF/DKIM results where the host's mailbox shows them.
- No Vrbo or Booking.com reader is built until real sample emails exist,
  with personal details removed.

## Decided (20 Nov, with Saad)

- **Vrbo and Booking.com start on the Other path**, with their senders
  pre-filled and the host's yes on each booking. With the host's okay,
  redacted copies of the emails that arrive become the samples for each
  platform's own reader.
- **A failed sender check:**
  - on a sender the host named (their own site, or Other), the host is warned
    in the ask and still decides;
  - on Vrbo's or Booking.com's pre-filled sender, or on Airbnb, it changes
    nothing.
- **No calendar link for a platform:** the calendar rule stays. An email never
  adds a night, and the host is asked to add that platform's calendar.
- **A stay waiting for the host's yes is hidden from every caller.** Only
  `waitingStays()` lists it, for the host's to-do list.

## The stay shape (for #262 and #180)

Every stay, from every platform, goes in the same `booking-emails.jsonl` log,
and `stayForNight` returns it. The stay says which platform it came from and
how it was vouched for:

```ts
type BookingPlatform = "airbnb" | "vrbo" | "booking" | "direct" | "other";

interface EmailStay {
  checkIn: string;            // YYYY-MM-DD
  checkout: string;
  checkInTime?: string;       // HH:MM
  checkoutTime?: string;
  guests?: number;
  infants?: number;
  pets?: number;
  /** The platform's own reference. Absent when an Other email gave none. */
  confirmationCode?: string;
  /** New. Every stay before this change is "airbnb". */
  platform: BookingPlatform;
  /**
   * New. Who vouched for the stay's dates and times:
   * - "reader": Property Core's own reader for that platform read them from a
   *   verified platform email (Airbnb today);
   * - "host": the agent extracted them and the host said yes to this booking.
   */
  vouchedBy: "reader" | "host";
}
```

**The host's-yes rule lives in the log, not in each caller.** A stay whose
email still waits for the host's yes is never returned by `stayForNight`,
`rebuildBookings` or `emailFacts`. A caller that gets a stay can rely on it.
#262's guest codes and #180's cleaner codes don't need to check anything
extra. `vouchedBy` is there so a caller can say where the times came from
("the host confirmed this Vrbo booking"), and so a later rule can treat the
two differently.

For a caller that wants to show what's waiting (the host's to-do list),
`waitingStays(root)` returns the stays still waiting for a yes. Each has the
same shape, with `vouchedBy: "none"` and the email's `kind`. Nothing should
act on those stays. `get_state` and `check_now` carry their count as
`waitingBookings`.

Keys: an Airbnb booking keeps its bare `HM…` code as its key, so existing
logs rebuild unchanged. Any other platform's booking is keyed
`<platform>:<code>`, or `<platform>:<checkIn>:<checkout>` when the email gave
no code.

## Setup: which platforms

Behind a new flag, `BOOKING_PLATFORMS`, off by default. With the flag off,
nothing below is asked or read. Every property behaves as an Airbnb-only
property does today, and the instructions stay unchanged byte for byte.

With it on, `get_state` asks one question in the calendars step:
"Where do you take bookings for this place?" It's a multi-choice card:
Airbnb, Vrbo, Booking.com, Your own booking site, Other. Then, for each choice
that needs one, it asks "What address do those booking emails come from?"

Saved in `hub.json`:

```ts
interface BookingSource {
  platform: BookingPlatform;
  /** The sender the agent looks for. Pre-filled for Vrbo and Booking.com, the host's own for direct and other. */
  sender?: string;            // a full address, like "bookings@myplace.com"
  /** The name the host gave an Other platform, like "Furnished Finder". */
  name?: string;
}
interface HubFile { /* … */ bookingSources?: BookingSource[] }
```

- **No `bookingSources`** means `[{ platform: "airbnb" }]`, which is today's
  behavior. A property saved before this keeps working with no question.
- **Pre-filled senders, until real samples exist:**
  - Vrbo: `sender@messages.homeaway.com`, the exact address. A guest's relayed
    message comes from a per-guest address at the same domain, so it never
    matches.
  - Booking.com: `noreply@booking.com`.

  The host can change either one.
- The saved addresses are checked like any other saved text: one that
  carries the door code is refused.

**The agent's instructions name only the chosen platforms.** The
`initialize` instructions are shared by every property on a connection, so
they can't list one property's platforms. Instead:
- `get_state` and `check_now` return `bookingEmails`: one line naming the
  senders to look for. An example: "Look only for Airbnb's reservation emails,
  and reservation emails from sender@messages.homeaway.com (Vrbo). Pass each
  one to read_booking_email as it arrives…"
- Until the host saves their platforms, the line also asks the agent to ask
  once. Without that, a property set up before #263 would never be asked: its
  sources step is already done.
- With the flag on, `BOOKING_PLATFORMS_INSTRUCTION` follows the chat's own
  instructions, for Claude, ChatGPT and Muse, single-tenant and hosted.
  `BOOKING_EMAIL_INSTRUCTION` itself is unchanged.
- Grok's instructions are pinned, so Grok reads all of this from the flag-on
  tool description instead.
- With the flag on, `read_booking_email` and `save_sources` are listed with
  their new fields. Off, both are listed exactly as before.

## The Other path, end to end

The tool takes one new, optional field, `extracted`. The agent fills it only
for an email that isn't Airbnb's:

```ts
read_booking_email({
  email: { from, subject, body, messageId?, receivedAt?, authentication? }, // authentication: see below
  extracted?: {
    kind: "confirmed" | "changed" | "cancelled";
    reference?: string;                       // the platform's confirmation code
    listing?: string;
    checkIn: { date: string; time?: string }; // YYYY-MM-DD, HH:MM
    checkout: { date: string; time?: string };
    guests?: { adults?: number; children?: number; infants?: number; pets?: number; total?: number };
  },
  confirmation?: string,
  googleEvents?: …,
  property?: …,   // hosted, as today
})
```

1. **Sender.** The From address must be one this property saved, exactly,
   ignoring case. A display name counts for nothing, as with Airbnb.
   Anything else gets `not-a-saved-sender`: nothing is stored but the hash,
   and nothing changes. With the flag on, this covers Airbnb too: a property
   whose host didn't pick Airbnb reads no Airbnb email.
2. **Authentication** (below). A failure on a pre-filled sender (Vrbo,
   Booking.com) gets `failed-authentication`: nothing is stored but the hash,
   and nothing changes. A failure on a sender the host named goes on to the
   host's ask, with a warning in it: "This email didn't pass its sender check.
   Only say yes if you know this booking."
3. **Shape.** Property Core checks the extracted fields:
   - real dates, with checkout after check-in, at most 60 nights, and
     check-in no more than 2 years ahead;
   - times as HH:MM;
   - guests from 1 to 50;
   - a reference of at most 40 letters, digits and dashes.

   It also checks that the reference, when given, appears in the email. A
   failure gets `bad-fields` naming the field, and nothing changes.
4. **Door codes.** The body is redacted as Airbnb's is before anything is
   stored.
   - A listing that carries the door code is refused (`door-code`).
   - A reference is refused only when it holds a guarded code itself. It's
     often all digits, and the chat guard's "any 4 to 8 digits" rule would
     refuse every numeric booking number.
   - Dates and times are checked strictly for shape, so they can't hold a
     code, and they aren't guarded.
5. **The host's yes.** The email is logged `awaiting-host` with its
   extracted fields. The reply carries a one-line summary for the host, plus
   an approval code from the desk's existing `issueApproval`, bound to a hash
   of the email and the fields. An example summary: "Vrbo booking HA-1A2B3C:
   Fri, Dec 12 at 4:00 PM to Mon, Dec 15 at 10:00 AM, 4 guests. Use these
   times for the cleaning?"
   - **Nothing moves.** `awaiting-host` isn't counted by `rebuildBookings`,
     so no stay exists yet for `stayForNight`, #262 or #180.
6. **After the yes**, the agent calls again with the same email, the same
   fields and `confirmation`. A changed field or email doesn't redeem the
   code. The email is then logged with `hostConfirmed: true`. From there it
   follows exactly the Airbnb path: property match, stay match on the
   calendar, `setJobTimes`, `stayCodeHook`, pending and retry, superseded.
7. **A cancellation** on the Other path is one ask, not two. The host's yes
   to the summary is also the yes to calling off a live cleaning, and the
   texts that would go out are shown in the same ask, as today.
8. **A change** is a new booking email, and needs its own yes.

A host's "no" is the absence of a yes. The email stays `awaiting-host`, and
an ask that's never answered never moves anything.

**Property matching** on the shared service: an Other email routes to the one
property that saved that sender. If several properties saved it (one direct
site for several places), it's matched by listing as Airbnb's are, else by a
booking already logged for its reference, else the host is asked which
property.

## Authentication results

**Checked for one agent so far.** Claude's Gmail connector can return a
message in `RAW` format, the full MIME source, which includes the
`Authentication-Results` header Gmail adds. I couldn't check the email
connectors ChatGPT, Grok or Muse use from here. So the field is optional, and
the design never needs it to be present.

- **What the agent passes:** `email.authentication`, the
  `Authentication-Results` header values exactly as received, topmost first,
  up to 4 KB. Never the whole raw message: it holds the host's own address
  and other people's.
- **Which header counts:** only the topmost `Authentication-Results`, and
  only when its authserv-id is a known mailbox provider, such as
  `mx.google.com`, `*.protection.outlook.com`, `mx.icloud.com` or
  `*.yahoo.com`. A sender can put fake `Authentication-Results` lines lower
  in its own email. The provider adds its own line on top.
- **The verdict:**
  - `pass`: `dmarc=pass` with `header.from` equal to the From address's
    domain, or `dkim=pass` with `header.d` equal to that domain or a parent of
    it.
  - `fail`: `dmarc=fail`, or no aligned pass at all. This catches a spoof
    signed for the attacker's own domain: its DKIM and SPF pass, but not for
    the From domain. A bare top-level domain (`com`) never aligns.
  - `unknown`: no header was passed, or none from a known provider.
- **What the readers do with it:**
  - `fail` changes nothing for Airbnb's reader and for Vrbo's and
    Booking.com's pre-filled senders (`failed-authentication`). For a sender
    the host named, the ask carries the warning and the host decides.
  - With `BOOKING_PLATFORMS` off, `authentication` is ignored, so nothing
    changes for anyone.
  - Booking.com is heavily spoofed, so a Booking.com reader, once one exists,
    needs `pass`. Until then, a `unknown` Booking.com email still goes to the
    host for a yes, with "I couldn't check this email's sender" in the ask.
  - Airbnb's reader keeps working with `unknown`, exactly as today.
- Only the verdict is stored in the log (`auth: "pass" | "fail" | "unknown"`),
  never the header.

## Samples for the platform readers

**Decided (20 Nov):** Vrbo and Booking.com start on the Other
path with their sender pre-filled, as above. The host's okay is saved once
per property (`save_sources` with `shareSamples: true`). It covers that
property's Vrbo and Booking.com emails that the host said yes to.

A command, `npm run booking:samples -- <property folder> <out folder>`, writes
those emails out in the fixtures' shape. It replaces:
- email addresses, except the platform's own From address;
- phone numbers with separators (a bare run of digits is a booking number, so
  it stays);
- the names on labeled lines (Guest, Name, Traveler and the like), wherever
  else they appear.

The stored body already has door codes removed. Saad reads every sample
before any goes into `test/fixtures/`. Once a platform's reader passes on them, that platform's
emails go through the reader, and the per-booking yes drops away.

## A platform with no calendar link

**Decided (20 Nov):** an email still never adds a booked night. A booking from a platform
whose calendar isn't saved stays `pending`. After 3 hours it gets the
existing "the calendar doesn't show it" host note, which now adds "If you
take bookings on Vrbo, add its calendar link."

## Not in this version

- Vrbo and Booking.com readers. They wait on real samples.
- Guest messages from other platforms (#242 stays Airbnb-only).
- Any booking-software connection (#239, on hold).

## Safety gates

New rows in `docs/cleaner-core-safety-gates.md`, under **Booking emails**,
each with a test:

- An email from a sender the property didn't save changes nothing. This
  includes a display name posing as one.
- A guest message relayed from `@messages.homeaway.com` changes nothing.
- A `noreply@booking.com` email whose authentication fails changes nothing.
- An Other booking changes nothing until the host's yes for that exact email
  and those fields. `stayForNight` doesn't return it until then. After the
  yes, it moves the cleaning like an Airbnb email.
- With `BOOKING_PLATFORMS` off, or with no platforms saved, an Airbnb-only
  property behaves exactly as before.

## Testing

All with made-up emails, made-up references and door codes, and 555 numbers.

- `test/bookingSources.test.ts`: the saved sources, the defaults, sender
  matching, and the agent's line.
- `test/bookingPlatformsSetup.test.ts`: covers
  - the flag off, where tools, instructions and `get_state` are unchanged;
  - the setup question, and `save_sources`;
  - the flag-on schema and instructions, including Grok's pinned ones.
- `test/otherEmail.test.ts`: the shape checks.
- `test/otherBookingEmail.test.ts`: the sender, authentication and field
  checks, and the host's-yes flow end to end. It covers a confirmed booking,
  a cancellation, a stale code after the fields changed, an email asked again
  in a new chat, and a booking the calendar doesn't show.
- `test/bookingEmailsHosted.test.ts`: routing by saved sender on a
  two-property account.
- `test/bookingSamples.test.ts`: samples need the host's okay, and names,
  phones and emails are replaced.
- `test/emailAuth.test.ts`: the `Authentication-Results` verdicts. It covers
  a forged lower header, an unknown provider, DKIM on a parent domain, and an
  unaligned pass.
- `test/bookingEmailLog.test.ts`: `platform` and `vouchedBy` on stays, and
  that `awaiting-host` is never returned.
