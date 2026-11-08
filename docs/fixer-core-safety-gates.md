# Fixer Core safety gates

These gates have to stay green before Fixer Core contacts a real pro or shares
a door code for anyone. CI runs `scripts/ci-check.sh` on Node 22. No gate's
proof calls, emails or texts a real person, or reaches a real pro network.

Status: proposed with the design spec
(`docs/superpowers/specs/2026-11-07-fixer-core-design.md`). The tests named
below are written with the build issues (#170 to #174), and each gate's row
is checked against them before `FIXER_CORE=1` is set anywhere.

| Gate | What it holds | Proof |
| --- | --- | --- |
| No payment | Fixer Core never pays a pro. No tool or visit page field is for a payment link, card, bank detail or payment username, and every tool schema is strict. Every tool input and visit page field is checked by `refuseCards`: a 13 to 19 digit run that passes the Luhn check is refused before anything is saved or logged. The cost log records an amount already charged, never a payment. | `test/fixerDesk.test.ts`, `test/fixerHosted.test.ts` |
| Approved pros only | `contact_pro` gives a token only for a saved pro preferred for the job's trade on a job with the host's go, or a pro or candidate the host picked through `pick_pros`'s code. Anyone else is refused, and the refusal is shown to the host. A drafted pro isn't approved until the host confirms. `record_contact` is refused without a live token. | `test/fixerGate.test.ts`, `test/fixerDesk.test.ts` |
| Cost line and window in code | The booking gate decides in code: an estimate over the cost line, no estimate, a time outside an open window, or a time over a stay holds the booking. The agent's words can't turn a hold into a booking. Every booking waits for `approve_booking`'s code, which is bound to the exact pro, time, estimate and access. A price raised on site over the line, or more than 20% over the estimate, waits for the host's yes before the work. A job has one live booking. | `test/fixerGate.test.ts`, `test/fixerWindow.test.ts` |
| Door access | The code goes out only for a booked job with the host's yes and `access: "code"`, to a pro with a saved phone, from 30 minutes before the visit to its end (or the host's extension), and on a checkout day only after the host's "guests have left" or the cleaner's DONE. It goes one-to-one: by text to the pro's own phone after their YES, or on the visit page. Never to a group, never in an email body, never in a tool reply. Fixer Core asks the hub's `request()` with `purpose: "repair"` only after these checks, and a refusal sends nothing and leaves the host one note per job. A locksmith job never gets the code. Replay and restart send the code at most once. | `test/fixerGate.test.ts`, `test/fixerVisitPage.test.ts`, `test/hubDoorAccess.test.ts` |
| Visit page | The link is treated as a key for the visit. Its token is letters only and holds no code, phone or address digits. It's returned once, and a rebook, extend, cancel or `revoke_visit` ends it. The code shows only inside the visit, after the pro's "I'm at the door", and never with `access: "host"`. The host is told of every reveal. After the visit the page shows only that it ended. A refused hub request, including no key after a restart, shows no code and leaves the host one note. The page sends no referrer, isn't indexed, and answers at most 30 requests an hour per link. | `test/fixerVisitPage.test.ts` |
| Texting consent | No text to a pro without their own YES. The one opt-in text goes only to a pro who asked to text, after the host saved them, under the same per-account consent as every other text (`docs/cleaner-core-safety-gates.md`, Texting consent). A pro's STOP covers every property on the account. STOP, HELP and injury phrases win over every other text. A pro's text never approves, books, or changes anything. | `test/fixerPeople.test.ts` |
| Cleaner report | A cleaner's report only opens a requested job, which waits for the host's go. It can't pick a pro, contact anyone, approve a booking, set a cost, or share access. Digit runs of 4 or more in the report are redacted before saving. | `test/fixerDesk.test.ts`, `test/cleanerRepairAsk.test.ts` |
| Own property only | A pro on two properties needs the host's `shared: true`. Nothing a pro receives names, hints at, or carries another property's address, label or door code. | `test/fixerPeople.test.ts`, `test/sharedPeopleEndToEnd.test.ts` |
| Photos | A pro's done photos are kept like the cleaner's: letters-only paths, signed links that expire after an hour, deleted 30 days after done. | `test/fixerVisitPage.test.ts`, `test/fixerDesk.test.ts` |
| Tests contact no one | Tests use 555 numbers, made-up door codes, `example.com` addresses and made-up pro networks. No test places a call, sends an email, fills in a real form, or reaches a network. Calendar reads are stubbed. | every `test/fixer*.test.ts` |
| Accounts apart | Two accounts never see each other's pros, jobs, costs or visit pages. | `test/fixerHosted.test.ts` |

With the host's own code, the code stops showing after the visit, but a pro who saw it still knows it. Only changing the code takes it back, so after a visit by a pro who isn't preferred, or a cancel after a reveal, the host is asked to change it. Per-visit codes wait for a lock partner (#180).

Fixer Core can't be turned on until `FIXER_CORE=1` is set on the service.
A real repair contacts a real pro and shares a real door code, so only Saad
okays the first one, and a host runs it with their own agent.
