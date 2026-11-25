# Vendor visits: routine upkeep by text, codes that move with the window

Date: 2026-11-20. Status: decisions taken with Saad on 20 Nov (below); built
on `claude/visit-records-237-vendor` on the fake lock. "As built" at the end
lists the builder's calls. The live run waits for Saad's okay.
Issue: saadvz/PropertyCore#237, the vendor-visit part. Project 2 of the
verification roadmap (#236). Builds on the visit records design
(`docs/superpowers/specs/2026-11-19-visit-records-design.md`), Fixer Core
(`docs/superpowers/specs/2026-11-07-fixer-core-design.md`, Decision 13: Fixer
Core holds the owner's pros and upkeep schedules) and #180's grants
(`src/hub/grants.ts`, `syncGrants`).

## Why

A routine vendor, like pest control, comes on a fixed schedule. Today each
visit goes through Fixer Core's whole flow: the upkeep comes due, the agent
opens a job, the host says go, the pro is contacted, the booking is recorded,
and the host says yes again. That's two host questions per visit for a visit
nobody needed to decide. And nothing records when the vendor was really
there, so the host can't check the invoice against the work.

## Decisions (Saad, 20 Nov)

1. **Standing yes.** The host says yes once per upkeep item: this pro, their
   usual hours, their own door code each visit, about this much. After that,
   each visit runs with no search, no contact step and no host question.
   Fixer Core proposes the window to the vendor by text. The vendor confirms
   or moves it. The code is issued and expired, and time on site is logged.
   The host gets one news line per visit. A price over the usual one still
   waits for the host.
2. **A vendor's text can move their own visit if the new time fits.** This
   only applies to a standing-yes visit, from that vendor's own opted-in
   phone. When the new time passes the booking gate (inside an open window,
   not over a stay, clear of the check-in buffer), the booking moves in
   place. Their code moves with it (a `move`, per #180), and the host gets
   one news line. A time that doesn't fit becomes a host question. The Fixer
   gate "a pro's text never books or changes anything" is rewritten to say
   exactly this.
3. **The code exists only after the vendor confirms.** No code is made for a
   window the vendor hasn't said yes to. Their YES issues it for 30 minutes
   early to the window's end, as for other pros. A move moves it. Done, or
   the window's end, ends it.
4. **The completed-service notice is evidence only.** It's stored as received
   in its own append-only file, like booking emails, with door codes and
   digit runs taken out. A `service-notice` line in the visit log links it to
   the visit. It's read only for the service date, to match it to a visit.
   It never sets times: time on site comes from the lock and DONE.
5. **The standing yes counts as the code OK.** On connected locks with pros'
   codes on "ask", no per-visit OK is asked for a standing-yes visit. The
   standing-yes question names the code. The host is told when the code is
   issued and can withdraw the standing yes at any time.
6. **A narrow parser, with an echo.** Code reads only a day (a weekday or a
   date) and a time range. "1" to "6" read as PM and "7" to "11" as AM. The
   vendor is texted back exactly what was understood ("Moved to Thu Jan 14,
   1 to 3 PM."), and never a code. A text it can't read confidently goes to
   the host's agent as news. The agent can then enter the time with
   `move_vendor_visit`, which goes through the same gate.
7. **A busy due date moves to the next open day.** The vendor's usual hours
   are proposed on the first day from the due date that fits, up to 7 days
   later. When none fits, the host gets one question, as today's upkeep flow
   does.

## Scope

- A standing yes on an upkeep item (`save_upkeep` with `standing`, a
  two-call yes).
- The clock pass proposes each due visit to the vendor by text, once.
- The vendor's YES confirms. A new time moves the visit if it fits; else the
  host is asked. NO, or no answer in 48 hours, goes to the host once.
- On connected locks, the vendor's own code: issued at YES, moved with the
  window, ended at done.
- The visit's window goes into the visit log only once confirmed, so a
  proposal nobody accepted is never "late" or a "no-show".
- `save_service_notice`: the host's agent passes a completed-service email
  as received. It's stored append-only and linked to the visit.
- Time on site comes from the same visit log as other Fixer visits, so
  #238's `fixerRows` marks the row `measured` with no new code.

## Not in this version

- The photo check against the listing standard (#239's photo work).
- Butler (Decision 13 in the Fixer Core design).
- Codes per crew day (#243's follow-up).
- A vendor who doesn't text. Their upkeep keeps today's flow, and the standing
  yes is refused for them. The refusal says why.
- Proposing more than one visit ahead.

## Anti-goals

- A vendor's text never books a visit that wasn't proposed to them, never
  changes another pro's visit, never touches a visit without a standing yes,
  and never sets a price.
- No proposal, confirm, echo or move text holds a door code, an address
  other than the street, or another property's name.
- No code is put on a lock for an unconfirmed window.
- A replay or restart never sends a second proposal, echo or host note.
- Without `VISIT_RECORDS` and `FIXER_CORE`, or without a standing yes on the
  item, nothing changes. A property without a connected lock gets no lock
  call. The code goes as it does today for a texting pro.

## Design

### The standing yes

`Upkeep` gains:

```ts
standing?: {
  proId: string;           // a saved pro with a phone who texts on the line (prefersText, opted in)
  from: string;            // usual local start, "09:00"
  until: string;           // usual local end, "11:00", same day, at most 4 hours after from
  access: "code" | "host";
  usualCents?: number;     // the usual price; a price over it waits for the host
  yesAt: string;           // the host's two-call yes
}
```

`save_upkeep` takes `standing`, and it always needs the two-call yes, even
before Activate. The question names the code:
`Pest control (Bug Busters) every 3 months, 9 to 11. When it's due I'll text
Bug Busters the date, they confirm or move it, and they get their own door
code for that visit. About $120 each time. Okay?` (wording for the design
pass). It's refused when the pro isn't saved, has no phone, or doesn't text
on the line, and when the hours run backwards or last more than 4 hours.
`remove_upkeep`, or `save_upkeep` with `standing: null`, withdraws it. That
doesn't cancel a visit already confirmed: the host cancels that as today.

### Proposing a visit

On Fixer Core's clock pass, with `VISIT_RECORDS` on, for each standing item
whose `leadDays` window has opened (`upkeepDue`'s rule):

1. Find the first day from the due date, up to 7 days later, where the usual
   hours pass `holdsFor` with no hold except `cost`/`no-estimate`, which the
   standing yes already covers.
2. If one fits, make the job: `source: "upkeep"`, `hostGo` and
   `booking.hostYes` from the standing yes's `yesAt`, `estimateCents` from
   `usualCents`, `access` from the standing yes, and
   `booking.vendor = { proposedAt }`. The state is `booked`, but the visit
   isn't confirmed. Then the proposal text goes once:
   `Hi Bug Busters, pest control at 12 Scratch Lane is due. Can you come Tue
   Jan 12, 9 to 11? Reply YES, or send another day and time.` The send goes
   through the existing consent check (`textsAllowed`), and `proposedAt` is
   saved before the send, so a restart doesn't send it twice.
3. If none fits, today's flow runs: `upkeepDue` lists it, and the host is
   asked once.

Until then (24 Nov follow-up), `check_fixes` lists a due standing item in
`routineVisits`, not `upkeepDue`, with a `next` line saying what the proposal
waits on (the vendor's YES to texts, the bookings, texts on the line), and
`open_job` refuses an upkeep job for it. The 23 Nov live run showed why: with
the proposal held up, the agent opened a regular job and asked the host for a
go and a cost line the standing yes already gave. The item goes back to
`upkeepDue` only when the vendor can't be texted at all (removed, no phone,
STOP, the host's own phone), with Visit records off, or after the no-day note.

`save_upkeep` takes an optional `firstDate` (today or later, within a year):
the first visit falls on it and the schedule runs on from it, until a visit is
done after it was saved. Without it, nothing changes: an every-N-days or
monthly schedule's first visit is a full period out, so a visit today couldn't
be set up before.

The hours log sees a `HostStep` of kind `standing-yes` on the job, so the
host's approval is still on record.

### The vendor's reply

In `proInbound`, before DONE and the price, for a pro with an unconfirmed or
not-yet-started standing visit:

- **YES** (they're already opted in): confirmed. `booking.vendor.confirmedAt`
  is set, the visit window goes into the visit log, and the code is synced
  (connected locks). The vendor is texted back:
  `Thanks, see you Tue Jan 12, 9 to 11. Your door code comes by text when the
  visit starts.` (or `The host will let you in.`). The host gets one news line.
- **A new time** that `parseVendorTime` reads: the booking gate runs. If the
  time fits, the booking's `from`/`until` change in place, the visit counts
  as confirmed, the window line is written, and the code moves. The vendor is
  texted the echo, and the host gets one news line. If it doesn't fit, the
  vendor is told the host will confirm, and the host gets a question:
  `move_vendor_visit` with the time is a two-call yes.
- **NO**, or a text it can't read: news for the host's agent, with the
  vendor's words (digit runs taken out). The agent can call
  `move_vendor_visit`.
- **No reply in 48 hours** before the visit, or by the visit's start if
  that's sooner: one host note.
- **At most 3 moves per visit** by text. After that, any further time goes
  to the host.

A move after the code went out (a vendor running late) works the same way.
The window can't go past the next check-in buffer, because the gate refuses
it.

### Codes

`wantedCodes` leaves out a booking where `vendor` is set and not confirmed.
Once confirmed, it's a pro's code like any other, so `syncGrants` issues it.
A move changes `booking.from`/`until` in place, so `syncGrants` sees the same
job and person with a new window and calls `moveGrant`. Done revokes it, as
today. `lockPass` treats `booking.vendor.confirmedAt` with the standing yes
as `codeYes`. No change to `grants.ts`.

### Visit records

The repair visit's `visit-window` line is written only once the visit is
confirmed (`visitPass` skips an unconfirmed vendor booking). Every move writes
a new line, so the record follows the latest window. Message lines:
`window-proposed`, `confirm` and `move-echo` go out, and `confirm`, `move`
and `decline` come in. A DONE by text or on the visit page is the departure,
as today. So arrival, departure, duration and the late flag work with no
change to `buildVisits`.

### Completed-service notices

`save_service_notice({ jobId?, email: { from, subject, body, receivedAt,
messageId? } })`, listed with Fixer Core when the host turned
`serviceNotices` on in `save_fixer_settings`:

- **The store.** `service-notices.jsonl`, append-only, mode 0600. It holds
  the body as received, with each code the property knows (the saved code and
  every live grant) and every digit run of 4 or more taken out, plus a hash
  of the body, so a second copy isn't stored twice.
- **Matching.** The job given, else the sender's address matching a saved
  pro's email, and a date in the subject or body within a day of that pro's
  visit, else that pro's visit done within 3 days before `receivedAt`. When
  nothing matches, it's stored with no visit, and the reply says so.
- **The visit log line.** A `service-notice` line: `visit`, `notice` (the
  hash) and `serviceDate`. `buildVisits` doesn't read it for times, and
  `list_visits` shows that a notice is on file.

### Flags

Everything new is behind `VISIT_RECORDS` and `FIXER_CORE`. Without a standing
yes, upkeep runs exactly as today.

## Safety gates

**Fixer Core**, the Texting consent row is reworded:
"A pro's text never approves, books or changes anything, except that a vendor
with a standing yes can confirm or move their own proposed visit when the new
time passes the booking gate." A new "Routine vendor visits" row, with tests:
- The standing yes is a two-call yes that names the code, and it's refused for
  a vendor who doesn't text.
- One proposal per visit, sent once across a restart.
- No code before the vendor confirms.
- A move that doesn't fit changes nothing, and the host is asked.
- No more than 3 moves.
- No text holds a code.
- A notice never sets times and holds no code or digit run.

Cleaner Core isn't touched.

## Testing

All on the fake lock adapter, 555 numbers and made-up codes:

- `test/vendorTime.test.ts`: the parser.
- `test/vendorVisits.test.ts`: the standing yes, the proposal, YES, a move
  that fits and one that doesn't, NO, no answer, a restart, the code
  timeline on the fake lock (none before YES, issued at YES, moved, ended at
  done), time on site, and the hours-log row as `measured`.
- `test/serviceNotices.test.ts`: the store, redaction, dedupe and matching.
- Two pest-control visits end to end on the fake lock, in
  `test/vendorVisits.test.ts`, through to the hours log's `measured` rows.

## As built

Builder's calls, for review:

- **The standing-yes job.** A proposed visit is a normal Fixer job, `source:
  "upkeep"`, with `standingYes: { upkeepId, at }`. Its `hostGo` and
  `booking.hostYes` carry the standing yes's time, so every existing gate
  reads it as approved. A `booking.vendor` record holds the proposal, the
  confirm, the moves and any held time.
- **The hours log.** `fixerRows` doesn't add "approved the repair" or
  "approved the booking" rows for a standing-yes visit, because the host
  didn't approve that visit. A row for the standing yes itself is left to
  #238.
- **Moves.** At most 3 by the vendor's text. A move after the visit
  started puts it back to `booked` when the new start is later. A move ends
  any visit link, as a rebook does. The vendor texts, so the code normally
  goes by text.
- **No answer.** One note at 48 hours before the visit. When the proposal
  went later than that, the vendor gets a day first, and the note is never
  later than the visit's start.
- **The proposal is saved before the send.** A failed send isn't retried.
  The no-answer note then tells the host.
- **Notices.** A notice whose visit isn't found is kept with no visit, and
  the reply says so. A second copy, by message id or body, adds a
  `duplicate` line with no body. `VisitRecord.notices` lists the hashes.
- **Vendor-facing and host-facing wording** is new, in
  `src/fixer-core/texts.ts` after the "Routine vendor visits (#237)" comment.
  It's flagged for a design pass.
- **No change to `grants.ts`.** A move changes the booking in place, and the
  existing `syncGrants` moves the code.
- **After review (20 Nov).** Changes made after the code review:
  - A time over a stay is never put to the host. The vendor is asked for
    another time, and the host gets news.
  - A fourth move that fits gets its own question.
  - Replying with the proposed time confirms, the same as YES.
  - A visit never confirmed is called off at its end.
  - The upkeep rule "a cancelled job means the date was dealt with" now moves
    on to the following date. Before this, the item never came due again.
    That was a bug that existed before this branch.
  - The standing-yes question names how often. A change of schedule drops
    the standing yes.
  - The host's yes to a vendor's move is a reschedule row in the hours log.
  - The parser ignores durations ("2-3 hours"), and reads "today" and
    "tomorrow" as the day the vendor texts.
