# Booking emails from more platforms Implementation Plan

> Steps use checkbox (`- [ ]`) syntax. Each task is test-first: write the tests, run them and see them fail, implement, run them and see them pass, then run the booking-email suites again.

**Goal:** The host picks the platforms they book on. Booking emails from any of those platforms other than Airbnb go through the Other path: the agent extracts the fields, Property Core checks them, and the host says yes to each booking before anything moves. Every stay carries its platform and who vouched for it.

**Architecture:** Pure code in `src/hub/`:
- `bookingSources.ts`: the saved platforms and senders;
- `emailAuth.ts`: the `Authentication-Results` verdict;
- `otherEmail.ts`: the sender and shape checks.

The log (`bookingEmails.ts`) learns platforms, the `awaiting-host` outcome and `vouchedBy`. Cleaner Core's `bookingEmailDesk.ts` adds the host's-yes step in front of the existing Airbnb path. `save_sources` saves the platforms, and `get_state` and `check_now` name the senders. All of it sits behind `BOOKING_PLATFORMS`.

**Spec:** `docs/superpowers/specs/2026-11-20-booking-platforms-design.md`

## Global Constraints

- Flag off (`BOOKING_PLATFORMS` unset): nothing new is asked, read or said. The instructions and tool replies stay byte-identical, and `email.authentication` and `extracted` are ignored.
- No `bookingSources` saved means Airbnb only.
- `src/hub/` imports nothing from `src/cleaner-core/` (`test/hubBoundaries.test.ts`).
- Made-up emails, references and door codes only, and 555 numbers. No real guest names, phones or emails in fixtures.
- An email never adds or removes a booked night.
- `awaiting-host` never counts: `rebuildBookings`, `stayForNight` and `emailFacts` never see it.
- An existing Airbnb log rebuilds exactly as before.

---

### Task 1: Flag and saved sources

**Files:** `src/cleaner-core/flag.ts`, create `src/hub/bookingSources.ts`, `src/hub/store.ts`, `src/hub/hub.ts`, test `test/bookingSources.test.ts`

- `bookingPlatformsOn(env)`.
- `type BookingPlatform = "airbnb" | "vrbo" | "booking" | "direct" | "other"`.
- `interface BookingSource { platform; sender?; name? }`.
- `PRESET_SENDERS = { vrbo: "sender@messages.homeaway.com", booking: "noreply@booking.com" }`.
- `normalizeSources(input, carriesCode)` returns `{ ok, sources } | { ok: false, error }`:
  - it fills in the preset senders;
  - `direct` and `other` need a sender, and `other` needs a name;
  - it refuses a bad address, door code text, duplicates, or more than 8.
- `senderAddress(from)`: the address in a From header, or undefined.
- `sourceFor(sources, from)`: the saved source whose sender equals the address (Airbnb by domain).
- `bookingEmailsLine(sources)`.
- In the hub: `hub.bookingSources()` (default `[{ platform: "airbnb" }]`), `hub.setBookingSources(list)`, and `shareSamples`.

- [ ] Tests:
  - the defaults and the presets;
  - a display name posing as a saved sender doesn't match;
  - a per-guest Vrbo relay address doesn't match;
  - door code text is refused;
  - the line names only the chosen platforms.

### Task 2: Authentication verdict

**Files:** create `src/hub/emailAuth.ts`, test `test/emailAuth.test.ts`

- `authVerdict(authentication: string | undefined, fromDomain: string): "pass" | "fail" | "unknown"`. Only the topmost header counts, and only when its authserv-id is a known provider.
  - `pass`: `dmarc=pass` aligned with the From domain, or `dkim=pass` with `header.d` equal to that domain or a parent of it.
  - `fail`: `dmarc=fail`, or neither DKIM nor SPF passes.

- [ ] Tests:
  - a Gmail pass;
  - a DKIM pass for another domain counts as fail when nothing else passes;
  - a forged lower header doesn't count;
  - an unknown authserv-id gives unknown;
  - no header gives unknown;
  - a DMARC fail.

### Task 3: Other-path checks

**Files:** create `src/hub/otherEmail.ts`, test `test/otherEmail.test.ts`

- `checkOtherEmail(email, extracted, source, now)` returns `{ ok, parsed: ParsedBookingEmail } | { ok: false, reason, field? }`.
- The reasons are `bad-fields`, `no-reference-in-email` and `door-code`.
- `ParsedBookingEmail` gains `platform?: BookingPlatform`, absent meaning Airbnb.

- [ ] Tests:
  - good fields;
  - checkout not after check-in;
  - more than 60 nights;
  - more than 2 years ahead;
  - a bad time;
  - 0 or 51 guests;
  - a reference that isn't in the body;
  - the guest total from adults and children.

### Task 4: The log

**Files:** `src/hub/bookingEmails.ts`, test `test/bookingEmailLog.test.ts`

- The `awaiting-host` outcome.
- New record fields: `hostConfirmed?`, `auth?`.
- `bookingKey(parsed)`: an Airbnb booking keeps its bare code; any other booking is keyed `<platform>:<ref>`, or `<platform>:<checkIn>:<checkout>`.
- `EmailBooking` and `EmailStay` gain `platform` and `vouchedBy`.
- `waitingStays(root)`.

- [ ] Tests:
  - an old Airbnb log rebuilds identically, plus `platform: "airbnb"` and `vouchedBy: "reader"`;
  - `awaiting-host` is never returned;
  - after the host's yes, the stay is returned with `vouchedBy: "host"`;
  - `waitingStays` lists only the waiting stays.

### Task 5: The desk: the host's yes, end to end

**Files:** `src/cleaner-core/bookingEmailDesk.ts`, `src/cleaner-core/liveDesk.ts`, test `test/otherBookingEmail.test.ts`

The Other path runs when the flag is on and the sender isn't Airbnb's. In order:
1. The sender must be one this property saved.
2. The authentication check:
   - a failure on a preset sender changes nothing;
   - a failure on a host-named sender puts a warning in the ask.
3. `checkOtherEmail`.
4. The email is logged `awaiting-host`, and the reply returns a summary and an approval code, bound to the email hash and the fields.
5. On the call with `confirmation`, the code is redeemed, the email is logged with `hostConfirmed`, and it carries on into the Airbnb path.

A cancellation is one ask in total. An Airbnb email whose authentication fails changes nothing, with the flag on.

- [ ] Tests, on a live desk:
  - the host's direct-site booking: nothing moves before the yes, and after it the times are on the cleaning and `stayForNight` returns the stay;
  - a stale code after the fields changed;
  - a sender the host didn't save changes nothing;
  - a guest relay from `abc123@messages.homeaway.com` changes nothing;
  - a spoofed `noreply@booking.com` that fails authentication changes nothing;
  - a direct-site email that fails authentication asks with the warning;
  - a cancellation with the yes calls off a live cleaning;
  - with the flag off, a non-Airbnb email is refused exactly as before.

### Task 6: Setup, tool schema, instructions

**Files:** `src/cleaner-core/mcp.ts`, `src/cleaner-core/setupAsk.ts`, `src/cleaner-core/liveDesk.ts`, `src/cleaner-core/bookingEmailDesk.ts`, `src/cleaner-core/assistant.ts`, test `test/bookingSources.test.ts` (desk part)

- `save_sources` takes `bookingEmails` and `shareSamples`.
- The sources step asks the platforms question when the flag is on.
- `get_state` and `check_now` return `bookingEmails`.
- `read_booking_email` takes `email.authentication` and `extracted`.
- `BOOKING_EMAIL_INSTRUCTION` stays as it is. A flag-on sentence is added after it.

- [ ] Tests:
  - flag off: the tool list's descriptions and the instructions equal the ones before the change, and `get_state` has no `bookingEmails`;
  - flag on: the question is asked, the sources save, and the line names the chosen senders.

### Task 7: Shared service routing

**Files:** `src/hosted/bookingEmailRoute.ts`, test `test/bookingEmailsHosted.test.ts`

- A non-Airbnb email routes to the one property that saved its sender.
- When several properties saved it, routing goes by listing and then by a reference already logged.
- Otherwise the host is asked which property.

### Task 8: Samples export

**Files:** create `scripts/booking-samples.ts`, `package.json` script, test `test/bookingSamples.test.ts`

- It exports only emails the host said yes to, from Vrbo or Booking.com, on a property with `shareSamples`.
- Email addresses, phone numbers and the lines after "Guest"/"Name"/"Traveler" labels are replaced.
- Output goes to a folder Saad reads before anything goes into `test/fixtures/`.

### Task 9: Docs and gates

- Add the gate rows and proofs to `docs/cleaner-core-safety-gates.md`.
- Add one paragraph to `CLEANER_CORE_BOOTSTRAP.md`.
- Bring the design doc up to date.
- Run the full suite and `scripts/ci-check.sh`.
