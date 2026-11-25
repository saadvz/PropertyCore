# A yes before any pro's code (#243 ruling): design

Approved by zakitka in the #243 thread, for every pro who comes through the door (crews, one-day pros, routine vendors).


From the ruling on #243 (24 Nov): no door code goes on the lock at booking. It is made once the job is confirmed. Everything here stays behind FIXER_CORE and SMART_LOCKS, both off by default.

## What "booked" means today (point 4)

"Booked" is not a confirmation on record. In the code, a booking starts when the agent records `record_contact` with outcome `booked` after `contact_pro` (by call, email, form, booking page, text or network). Then the host says yes with `approve_booking`, and the pro's code goes on the lock right away (`wantedCodes` in `src/fixer-core/desk.ts`). The pro's text YES is only consent to texts.

Nothing records who actually agreed. The agent can record "booked" on the host's word, which is what happened with Test Painter on 23 Nov, and a form or network request can be recorded as booked before the pro answers. Routine vendors are the one exception: their code already waits for their own YES (`vendor.confirmedAt`, #271).

## The record

A booking gets one new field:

`confirmed: { at, by: "pro" | "host", via: "text" | "email" | "call" | "host-arranged" }`

- `by: "pro"` means the pro's own YES came in by text, from their own opted-in phone.
- `by: "host"` means the host passed it on, and `via` says how the pro told them (email or a call), or that the host set the visit up themselves.
- A host-passed yes is also added to the job's host steps (`confirm-visit`), so the hours log shows it as the host's word.

No lock code exists, the visit page shows no code, and no code text goes out until `confirmed` is set. A routine vendor's YES fills it too, so there's one field for everyone.

## Three ways to a yes

1. **The pro's YES by text.** Right after the host's yes to the booking, a pro who texts on the line gets one text naming the dates and hours, ending "Reply YES to confirm." Their YES confirms the visit. A pro who hasn't opted in gets no text, because the texting-consent rule is unchanged. While the confirm waits, their texts go to Fixer Core, the way a waiting vendor's do. A replayed YES does nothing twice. Any other reply is news on the job for the host.
2. **The host passes it on.** A new tool, `confirm_visit` (jobId, via: email, call or host-arranged), takes the host's two-call yes. The question names the pro, the dates, and how the pro confirmed.
3. **In the same yes as the booking.** `approve_booking` takes an optional `confirmedVia` when the host already has the pro's word. One question then covers both, so the usual "I called them, book it" stays a single step.

## When the host is asked (point 1)

- **48 hours before the first workday** (or the visit's start), with no yes on record: one question to the host. "Has Test Painter confirmed Dec 2 to 4? Their door code is made only once they have." This matches the routine vendor's 48-hour note.
- **A booking made less than 48 hours out** gets no separate ask. The booking question offers the confirm instead.
- **At the start, still no yes:** one note that no code was made. The host can confirm, which makes the code then, or let the pro in.
- There is never a code without a yes, and there are no repeat asks.

A crew's code is live only inside each workday's window anyway, so making it at 48 hours instead of at booking costs the crew nothing.

## How the code reaches a pro who doesn't take texts (point 3)

- **The pro has an email:** no change. `visit_link` already goes to the pro's own email, and the page shows the code at the door inside the window.
- **Phone calls only (no texts, no email):** a new `pro_code_link` gives the host a single-use page, the same pattern as guest codes (#262). The host taps once, sees the code, and reads it to the pro on the phone. The link is for the host only. It works once and ends with the job. A crew keeps one code for the whole job, so once is enough.

Under `release.pros: ask`, a yes the host passes on also counts as their OK for the code, so it's one question, not two. A pro's own text YES still waits for the host's OK under ask, as today.

## Who it covers (point 5)

Chosen: everyone who comes through the door on a pro's code. That's crews, single-day pros, and routine vendors (who already work this way). Today a single-day pro's code goes on the lock at the host's yes. With this change it waits for the confirm too. The cost is one step for a pro who doesn't text, and `confirmedVia` on the booking yes mostly removes it.

## When this ships

A booked job with a code and no confirm on record loses its code from the lock until a yes comes in. The Test Painter job on Adélie Cottage (Dec 2 to 4) is one of these. Its code comes off the lock, and the host is asked on Nov 30 at 9 AM. That's the strict reading of the ruling.

## Unchanged

- The code is live only in each workday's window, with no early lead for a crew.
- A cancel revokes it.
- The leak checks still cover it.
- No code digits appear in chat, tool results or logs.

## Tests and gates

- `docs/fixer-core-safety-gates.md`: the "Crew-day codes (#243)" row and the pros' code row say the code waits for a confirm on record, with these tests:
  - nothing on the lock at the host's yes
  - the pro's YES makes it
  - `confirm_visit` and `confirmedVia` make it, and record who and how
  - one ask at 48 hours, and an immediate offer inside 48 hours
  - one note at the start with no code
  - a replayed YES does nothing twice
  - a not-opted-in pro is never texted
  - the host's single-use page shows the code once
  - an existing unconfirmed booking's code comes off
- Fakes and 555 numbers only.
