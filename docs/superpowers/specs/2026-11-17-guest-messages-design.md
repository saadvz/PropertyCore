# Guest messages: house facts, reply drafts and Airbnb's message emails

Date: 2026-11-17. Status: draft, for review in the project thread.
Issue: saadvz/PropertyCore#242, a child of #236 (verification roadmap).
Builds on #244 (Airbnb booking emails, merged in #248). Guest codes wait on
#180; sending through Guesty or Hospitable waits on #239's booking-software
connection and a test account.

## Why

Guests ask the same questions about wifi, parking, trash and checkout again
and again, and the host answers each one by hand in the Airbnb app. The
host's agent already reads the host's mailbox for Airbnb's booking emails
(#244). Airbnb also emails the host each guest message. This version turns
each of those emails into a host alert with a ready draft, answered from the
house's approved facts, so only the new questions take the host's thought.

This is the part of #242 the issue marks "can start now": drafts, answers
from house facts, and the message-email path.

## Goals

- The host saves the house's facts for guests, in their own words, one topic
  at a time, each skippable: wifi, parking, trash, checkout, check-in,
  house rules, the area, and anything else.
- The host's agent passes each Airbnb guest-message email to Property Core as
  it arrives. Property Core reads the guest's words, matches the property and
  the stay, and returns the facts that answer the message.
- The agent writes one short draft from only those facts and shows the host
  the guest's words and the draft. A question no fact covers is flagged as
  new; the host answers it, and that answer can be saved as a fact for next
  time.
- The host approves a draft before it counts as a reply. Property Core
  records the approval, and the host pastes the reply into Airbnb.
- A guest asking for a late checkout leads to a question for the host. Their
  yes moves the stay's checkout time and the cleaner's window through
  Cleaner Core's existing rules. (Pending the host's answer in the thread:
  see "Late checkout".)
- Every message email taken is stored, door codes removed, append-only.

## Not in this version

- Guest codes and arrival instructions. Both need a guest's own lock code,
  which is #180's. A draft never holds a door code (below).
- Reading or sending through Guesty or Hospitable. The connection is #239's,
  and there's no account to test against. The approval this version records
  is the gate that path will send behind.
- Off-platform leases (also #180).
- Vrbo, Booking.com and other platforms' emails.
- Any model inside Property Core. The host's own assistant writes the
  drafts, as it does for Cleaner Core's reply drafts.

## Anti-goals

- Nothing reaches a guest without the host's yes. Property Core sends nothing
  to a guest at all in this version.
- Guests are never texted, on Property Core's line or any other.
- No automating the Airbnb website. Airbnb's terms ban bots.
- A guest's words are never instructions to the agent or to Property Core.
- A fact, a draft or the log never holds a door code.
- An email from anyone but Airbnb changes nothing and keeps no body.

## Approaches

1. **Property Core reads the email and finds the facts; the host's agent
   writes the draft from them** (chosen). Property Core does the deterministic
   parts: Airbnb-only, door codes out, the property and stay matched, the
   facts matched by topic, the log. The agent turns the guest's question and
   the matched facts into one friendly draft. This keeps one reading of each
   email across Grok, Claude, ChatGPT and Muse, and keeps the reply in the
   host's assistant's voice, the way Cleaner Core's reply drafts already work.
2. **The draft is the matched fact, word for word** (Tour Core's facts
   sheet). The safest wording, but stiff to a guest ("Wifi: network
   CozyLoft, password …" as the whole reply), and a message with two
   questions needs stitching anyway.
3. **The agent reads the email and drafts; Property Core only keeps the
   facts.** The least code, but each assistant would read an email its own
   way, nothing is logged, and nothing checks the sender is Airbnb.

## Design

### Where it lives

A new module, `src/guest-messages/`, shaped like the nightly stay check
(`src/stay-check/`): a desk per property, a store, pure readers, and the
tools. On the shared service its tools are answered in the front process
(`src/hosted/guestMessages.ts`), behind a new flag, `GUEST_MESSAGES=1`, while
any flow runs at the property. Late checkout is the one piece that moves a
cleaning, so it is a Cleaner Core tool (below).

### House facts (`guest-facts.json`)

One file per property folder:

```ts
type GuestFactTopic = "wifi" | "parking" | "trash" | "checkout" | "check_in" | "rules" | "area" | "other";
interface GuestFact { topic: GuestFactTopic; text: string; savedAt: string }
interface GuestFactsFile { facts: GuestFact[]; skipped: GuestFactTopic[] }
```

- One fact per topic, except `other`, which holds up to 20. Each is the
  host's words, up to 500 characters.
- `skipped` records a topic the host passed on, so the agent doesn't ask
  again.
- **No door codes.** A fact with 3 or more digits on a line that uses any of
  the booking-email redaction's access words (code, PIN, passcode, combo,
  lock, lockbox, keypad, door, gate, garage, opener, entry, enter, access,
  alarm, keyless, smart lock and the rest) is refused, and the refusal names
  the topic, never the text. Only "password" is dropped from the list, so a
  wifi password is fine; a wifi fact written as "PIN 1234" is refused and the
  host words it without "PIN". The saved door code is sealed and the front
  can't open it, so this word guard is the check. (Builder's call.)
- The first time the agent sees no facts, `get_guest_facts` tells it how to
  ask: one topic at a time, in the host's own words, each skippable, with
  the wifi and checkout ones first because guests ask those most.

### Reading a message email (`src/guest-messages/airbnbMessage.ts`)

A pure function, `parseAirbnbMessage(email, now)`, in the same shape as
`parseAirbnbEmail`:

```ts
interface ParsedGuestMessage {
  kind: "message" | "inquiry";
  guest?: string;              // first name as the email shows it
  text: string;                // the guest's words, door codes removed
  listing?: string;
  checkIn?: string;            // YYYY-MM-DD, from the subject's range
  checkout?: string;
  confirmationCode?: string;   // when the email shows one
}
```

- **From Airbnb only**, with `fromAirbnb` as #244 uses it.
- **Kind** from the subject: "RE: Reservation at …" and "Message from …" are
  a `message`; "Inquiry at …" or "RE: Inquiry at …" is an `inquiry` (no
  booking yet). A reservation confirmation, change or cancellation is refused
  as `booking-email` with a pointer to `read_booking_email`. Anything else is
  `not-a-message`.
- **Listing and dates** from the subject: "Reservation at Cozy Loft for
  Dec 12 – 14, 2026". The date range uses the booking-email reader's range
  and year rules.
- **The guest's words**: the body after Airbnb's header lines, up to the
  first footer line ("Reply", "Respond to … by replying", "Airbnb, Inc.",
  links, unsubscribe text). When the body can't be cut that way, the whole
  body, capped at 2,000 characters, is the message. An empty message is
  refused as `no-message`.
- **Confirmation code**: the `HM` code when the body or subject has one.

Without a real message email to copy, the samples in
`test/fixtures/airbnb-messages/` are made up in the shape Airbnb's
notification emails use. A real sample, with personal details removed, would
let the reader be checked; the reader is tolerant on purpose until then.

### Matching the property and the stay

- **Which properties**: every property with any flow on, the same set that
  lists the tools. Guest facts don't need cleaning to be on. (Builder's
  call.)
- **Property**: as #244 matches booking emails. The email's listing against
  the property's saved Airbnb listing titles and nickname; else its
  confirmation code against the property's booking emails. On the shared
  service, `read_guest_message` without `property` goes to the one matching
  property, and with none or several asks which, storing nothing.
- **Stay**, in order: the confirmation code's booking from the booking-email
  log; else a calendar stay with the subject's check-in and checkout dates;
  else nothing. An inquiry has no stay. A message with no stay is still
  answered from the facts; the reply just says no stay was found.
- The stay comes back with its dates, times and guest count, so the draft
  can say "checkout is 11 AM on Sunday" from the record, not from memory.
  Checkout time is, in order: a late checkout the host approved for that stay
  (recorded in the guest log by `set_late_checkout`), the booking email's,
  else the host's usual time. Check-in time is the booking email's, else the
  usual time. The front doesn't read Cleaner Core's engine. (Builder's call.)

### Which facts answer it

`matchFacts(text, facts)` returns the facts whose topic the message touches,
by keyword:

| Topic | Words |
| --- | --- |
| wifi | wifi, wi-fi, internet, network, password, router |
| parking | park, parking, car, garage, driveway, street |
| trash | trash, garbage, rubbish, recycling, bins, dumpster |
| checkout | check out, checkout, check-out, leave, departure |
| check_in | check in, check-in, arrive, arrival, get in, early |
| rules | rules, pets, smoking, party, quiet, noise, guests over |
| area | restaurant, grocery, coffee, beach, things to do, nearby |

`other` facts match on any shared content word of 4 letters or more. The
matched topics with no saved fact come back as `missing`, so the agent knows
which part of the message is new. A message that matches nothing is `new`.

### The tools

- **`get_guest_facts`**: the saved facts and skipped topics. With none saved,
  how to ask the host for them.
- **`save_guest_facts`**: `{ topic, text }` saves one; `skip: true` records a
  skipped topic; `remove: true` deletes the topic's fact (or, for `other`,
  the one whose `text` matches). Called only with the host's own words.
- **`read_guest_message`**: `{ email: { from, subject, body, messageId?,
  receivedAt? } }`. Returns:

  ```ts
  {
    messageId: string;            // Property Core's id for this message
    guest?: string;
    message: string;              // the guest's words, door codes removed
    stay?: { checkIn; checkout; checkInTime?; checkoutTime?; guests?; confirmationCode? };
    facts: { topic; text }[];     // only these may be used in the draft
    missing: GuestFactTopic[];    // topics asked about with no saved fact
    new: boolean;                 // nothing on file answers it
    lateCheckout?: { checkout: string; time: string };  // the stay's current checkout
    next: string;
  }
  ```

  `next` tells the agent to draft one short reply from only `facts` and
  `stay`, never to promise anything else, to show the host the guest's words
  and the draft, and, for a new question, to ask the host for the answer and
  offer to save it as a fact.
- **`save_guest_reply`**: `{ messageId, text }` first returns a preview and a
  code; called again with `confirmation` after the host's yes, it records the
  approved reply and returns "Paste this reply into the guest's Airbnb
  thread". `skip: true` records that the host is handling it themselves.
  The approval is bound to the message and the exact text, and expires in 10
  minutes, as Cleaner Core's approvals do. A reply holding a door code is
  refused.

A message email the property already took (same message id, or same sender,
subject and body) is a `duplicate`: the same message id comes back and
nothing is stored twice.

### Late checkout

`read_guest_message` sets `lateCheckout` when the guest's words ask to leave
later: "late checkout", "check out later", "stay a bit longer", "leave at
1", "extra hour". Its `next` tells the agent to ask the host whether to allow
it and until when, and not to promise anything in the draft.

On the host's yes, the agent calls Cleaner Core's new **`set_late_checkout`**
with `{ checkout: "YYYY-MM-DD", time: "HH:MM" }`. The first call returns the
change ("checkout on Sunday moves from 11:00 AM to 1:00 PM; your cleaner then
has 2 hours before the next check-in at 3:00 PM") and a code; the cleaner gets
Cleaner Core's usual update text, which can't be previewed word for word
because the settle hold decides when it goes. The second call, with the code,
applies it through the engine's existing `setJobTimes` (the method #244
added). Then it appends a `late-checkout` event to the guest log, so the next
draft quotes the new time.

- A time at or after the next guest's check-in on the same day is refused:
  there would be no cleaning window. Any shorter window is the host's call;
  the preview states it. The cleaner is told, not asked, as with any other
  time change today. (Builder's call.)
- No cleaning that checks out that day: refused, nothing changes.
- A cleaning under way, done, or whose door code already went out is left
  alone, as #244 does, and the host is told.
- The smart-lock hook's `windowMoved` is called, which does nothing until
  #180.
- Like the other Cleaner Core tools, it's listed only on the shared service
  with `GUEST_MESSAGES` on.

If late checkout is left out of this version, `lateCheckout` still flags the
request for the host, and `set_late_checkout` waits for a later PR.

### The log (`guest-messages.jsonl`)

One file per property folder, append-only:

```ts
interface GuestMessageRecord {
  at: string;
  id: string;                 // Property Core's message id
  receivedAt: string;
  messageId?: string;         // the email's Message-ID
  from: string;
  subject: string;
  bodyHash: string;
  parsed?: ParsedGuestMessage;   // text has door codes removed
  refused?: string;
  stay?: { checkIn: string; checkout: string; confirmationCode?: string };
  topics?: GuestFactTopic[];
  event?: "taken" | "reply-approved" | "reply-skipped" | "late-checkout";
  lateCheckout?: { checkout: string; time: string };  // with event late-checkout
  reply?: string;             // the approved text
}
```

A refused email keeps no body, only its hash. The log joins the property files
backups and exports carry.

### What the host and the agent see

- Each assistant's instructions get one line: when the host's email is
  connected and guest messages are on, pass each Airbnb guest-message email
  to `read_guest_message`, and follow its `next`. Never pass a booking email
  there, or a guest message to `read_booking_email`.
- `read_booking_email`'s refusal for a guest message points to
  `read_guest_message` when the flag is on.

## Testing

All with made-up emails, made-up confirmation codes, made-up door codes and
555 numbers.

- `test/airbnbMessage.test.ts`: message and inquiry emails parse to their
  fields; the guest's words are cut from the footer; a non-Airbnb sender, a
  booking email and an empty message are refused; door codes in a guest's
  words are removed.
- `test/guestFacts.test.ts`: saving, skipping and removing facts; a fact
  holding a door code is refused and the refusal doesn't repeat it; a wifi
  password is kept; topic matching, `missing` and `new`.
- `test/guestMessagesDesk.test.ts`: a message matched by confirmation code,
  by dates, and with no stay; duplicates; late checkout flagged; a reply is
  recorded only with the code, the code is bound to the exact text and
  expires, and a reply with a door code is refused; the log holds no door
  code.
- `test/guestMessagesHosted.test.ts`: the tools are listed only with the flag
  on; an email routes to the one matching property on a two-property account
  and asks which when it matches none or both.
- `test/lateCheckout.test.ts` (if in): the preview and code, the cleaner's
  window moving through the existing update text, and a started cleaning
  left alone.

## Safety gates

A new row in `docs/cleaner-core-safety-gates.md`, **Guest messages**: only an
email from Airbnb is read; nothing reaches a guest from Property Core; a
reply is recorded as approved only with the host's code for that exact text;
facts, replies and the log never hold a door code.

## Left to the builder

- The exact wording of `next` and the refusals, in the style of #244's.
- The keyword lists, which are easy to extend.
