# Vendors and visitors can say yes any way: design

Extends the #243 ruling (a pro's yes can come by text, email, a call, or the host arranging it) to routine vendors (#237) and expected visitors (#240). Everything stays behind its flags (FIXER_CORE, SMART_LOCKS), off by default.

## Today

- **Routine vendors (#237).** The standing yes proposes the visit by text. Only the vendor's own text YES (or a new time that fits) sets `vendor.confirmedAt`, and only then can a code exist. `confirm_visit` refuses vendor visits. A vendor who doesn't take texts never gets the proposal, so the host gets the 48-hour "no answer" note and the visit is called off at its end.
- **Expected visitors (#240, #280 17).** A visit saved with a phone sends one opt-in text. The visitor's YES, given once ever, is both their consent to texts and the gate for the code. The code only ever goes by text, 30 minutes before. A visitor who doesn't reply YES gets no code, and the host isn't told why or offered another way.

## Approaches

1. **One record, the #243 shape, on both (chosen).** Vendors already have `booking.confirmed` from #243, so `confirm_visit` covers them. Expected visits get the same `confirmed: { at, by, via }` field. A visitor who said yes off text gets their code through the host's single-use page, the same pattern as `pro_code_link`. Small, and it matches the ruling word for word.
2. **Treat the host's save of the visit as the yes.** Fewer steps, but it skips the "the person agreed" part of the ruling. I'm not using this one.
3. **Add email delivery for visitors.** Visits have no email today. That means a new field, new sends, and new consent rules. Left for later.

## The record

- **Vendor visit:** unchanged fields. `vendor.confirmedAt` plus `booking.confirmed` (`by: "host"`, `via`) are set together.
- **Expected visit:** a new `confirmed?: { at, by: "visitor" | "host", via: "text" | "email" | "call" | "host-arranged" }`. A visitor's text YES still sits on the `Visitor` record (once ever, as consent). A host-passed yes is for that one visit only.

## Vendors

- `confirm_visit` accepts a routine vendor's proposed visit. It takes the host's two-call yes ("Has Test Vendor confirmed Thursday 9 to 11 by call?"). It sets `confirmedAt`, and the standing yes still counts as the host's OK for the code, the same as a vendor's text YES.
- The 48-hour "no answer" note adds: "If they told you yes another way, tell me and I'll make their code."
- The code reaches them the way #243 set up: `visit_link` to their email, or `pro_code_link` for a host who reads it to them. A non-texting vendor gets no proposal text, which is unchanged.
- A vendor's text YES, moves, called-off, and service notices are unchanged.

## Visitors

- **Passing the yes on:** a new `confirm_expected_visit` (visitId, via) with the host's two-call yes. `add_expected_visit` also takes an optional `confirmedVia`, so "Mike said yes on the phone, he's coming Thursday" is one question.
- **The code is made** for a visit with a yes on record: the visitor's text YES, or a host yes for that visit. It's made in the same window as today (30 minutes before, cut around stays).
- **How it reaches them:**
  - Opted in by text: as today, one text 30 minutes before.
  - Not opted in: no text. The host gets one note when the code is on the lock, and a new `visit_code_link` gives the host a single-use page with the code to read or pass on. It opens once and ends with the visit. Only its hash is kept.
- **The opt-in text** still goes once as today, so the visitor can choose texts. If they reply YES, the code also comes by text. It's the same code.
- **No yes yet:** one host note 2 hours before the code window: "Mike hasn't replied YES, so no code is made. If he said yes another way, tell me." This is my call on the timing.
- **STOP (my call, please check):** a visitor who replied STOP gets no texts. A host-passed yes can still make their code, and it goes only through the host's page. STOP means no texts, not no entry.

## Unchanged

- The same-day missed-visit check.
- No code during a stay.
- A cancel takes the code off.
- No code digits in chat, tool results, logs, or the visit record.
- Texting consent rules.

## Tests and gates

`docs/fixer-core-safety-gates.md` and the oversight gates get rows for each of these. Fakes and 555 numbers only.

- `confirm_visit` on a vendor visit makes the code and records who and how.
- A vendor's replayed YES after a host yes does nothing twice.
- `confirm_expected_visit` and `confirmedVia` make the visit code, for that visit only.
- A not-opted-in visitor is never texted the code.
- The host page shows the code once and ends with the visit.
- The "no yes" note comes once, 2 hours before.
- A STOP'd visitor with a host yes gets a code but no texts.
- A visit with no yes still gets no code.
