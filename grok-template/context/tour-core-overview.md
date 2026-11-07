# Tour Core overview (reusable context)

Tour Core is an open-source self-touring tool. A prospect texts the landlord's
one touring number, which covers every property. A first text that names the
place, or a listing link, starts that tour; an unclear first text asks which
place, then stays on that choice. One published property does not ask. They book
a time, agree to texts and tour records, confirm who they are,
and tours one unit on their own. The text thread stays live through the tour:
Tour Core guides them door by door. After the tour has started they get a
15-minutes-left questions text, then a 5-minute warning. One extra 10 minutes
is granted when they ask any time before the tour ends and the next time is
free; a bare yes to the questions text never grants time. After the no-time
line, yes starts booking another look. After the end, doors never open. A +5 text
asks if they've left; at +15 the tour closes and the team gets one issue.
DONE, "I'm out", or "leaving" ends the tour with the usual goodbye. After a
+15 close, other replies alert the team once per message and always reply
to the visitor, until DONE, the operator marks the leaving issue handled,
or 24 hours pass (alerts stop then; the leaving issue stays open until
DONE or handled). While that 24-hour window is open, a standalone HI or
yo stays on after-close handling; a clear booking phrase (including
see it again / schedule another visit) starts a new booking only when
nothing is held. After 24 hours, greetings go back to normal. A
greeting with more text, or anything about being stuck, locked,
jammed, still in the unit, unable to leave, unable to get
outside, unable to find the way out, where the way out is, or how
to get out, does not start booking. Help booking does not hide those
other words. "Which way out of the lobby" is not distress. A rebook or custom-time
request during a tour stays secondary until that tour ends for any
reason (done, closed, called off, cancelled, or expired), then
an unfinished identity form continues. A bare yes or no
answers the latest question asked: a door check wins over a held
booking. While they are touring, `get_tours`, pause, resume and call-off target the running tour; the
later booking is their next booking. After the running tour ends, texts
and those tools move to the later booking, or a greeting starts a new
conversation if nothing is held. `pause_tours` with cancel cancels
every real future booking, including a held rebook, and counts only
tours actually cancelled; if they are still touring, the cancel text
says their tour right now isn't affected. A one-off overlap check sees
the running tour and every future or held booking. `schedule_tour`
will not move a tour in progress, including hold or a door-system problem (`{who} is touring right now, so I can't
move this tour. Once it ends, you can book them another time.`); if they
have a later booking it asks `Want me to move their {oldTime} on {oldDay}
booking to {newTime} on {newDay} instead?` (outside hours: `{who} is
touring right now, so I can't move this tour. Their later booking is
{oldTime} on {oldDay}, and {newTime} on {newDay} is outside your tour
hours. Want me to move it there anyway?`) and a yes is `Moved {who}'s
later booking to {time} on {day}.`. Calling off describes the tour that was called off;
the later booking is `nextBooking`. After the follow-up
reply, an unapproved custom-time request is told once that it is still
with the {team}; they can reply with a day for a regular
time only when they do not already have a held or booked regular tour.
A held rebook taking over gets the booked-for line, then the usual
next steps. Later texts use the normal
booking flow. Asking for a regular open time moves a held or confirmed
booking right away. A taken regular slot keeps the current booking and
says `Sorry, {time} on {day} is already taken.` plus `You're still booked
for {curTime} on {curDay}.` only when they have a held or future booking
(never the tour already in progress), then the remaining times that day
or `If you'd like another time, just reply with a day.` A numbered reply
from that menu books the pick only when the menu was shown after the
current booking, including after the operator moves it. On hold, send
the taken line and no menu. Farewells and
arrival remarks after booking (`yes, see you later`, `yes, I'll arrive
earlier`, `yes, no need to switch`, `yes, the sooner the better`) do not
ask again; `later`/`earlier`/`sooner` is
a change only when it is an actual ask (`make it later`, `earlier
if possible`, `later in the week`, `can we do it later`, `anything later`,
`sooner would be better`, `can we do it sooner`, `sooner?`).
`yes, anything earlier is fine too` does not ask again. A named day (`tuesday
works better`) shows
that day's times. A leftover number, time, or bare later/earlier/sooner
does not move a booking. If a visitor text cannot be handled, they are told
`Sorry, I hit a snag with that. I've let the {team} know, and
they'll reply here as soon as they can.` when a landlord record was
created, or `Sorry, I hit a snag with that. Could you text me again in a
few minutes?` when it was not. That opens a handler-failed issue, not a
flagged question. The team sees `{who} texted "{their message}" and I
couldn't handle it, so they're waiting on you. I told them you'd reply
as soon as you can.` After a partial reply: `{who} texted "{their
message}" and I couldn't finish handling it. They got part of a reply,
so they may still be waiting on you.` Partial reply plus empty text:
`{who} sent a text I couldn't finish handling. They got part of a reply,
so they may still be waiting on you.` Empty text with no reply: `{who}
sent a text I couldn't handle, so they're waiting on you. I told them
you'd reply as soon as you can.` `resolve_issue` on that issue texts the
visitor and does not save a fact. First call: `Send this to {who}? "{reply}"`
After yes: `Sent to {who}.` If they cannot be texted: `I couldn't text
{who}, so nothing was sent and this is still open. If you can reach them
another way, do that, then mark it handled.` A repeat answer or resolve
on that issue returns `That's already been handled.` A repeat answer on a
flagged question returns `That question has already been handled.`
Booking a regular slot withdraws that request so a later
approve cannot double-book; replacing a held or booked future tour also
sends `That replaces your {time} tour on {day}.` Operators see
`They booked a regular time instead.` If the requested time has already
passed, the request expires and the visitor is texted once:
`The {team} couldn't get to your request for {newTime} on {newDay} in time.`
then `You're still booked for {time} on {day}.` or
`If you'd like another time, just reply with a day.` Approve and decline
tell the operator `That time has already passed, so I've let {who} know
their request ran out. You can still book them a one-off time.`
Then use `schedule_tour`.
Already expired: `That request already ran out because its time passed,
and {who} has been told. You can still book them a one-off time.`
Already approved or declined: `That request has already been handled.`
Propose tells the operator `That request ran out because its time already
passed, so your offer of {newTime} on {newDay} didn't go out. I've let
{who} know, and you can still book them a one-off time.` and does not
send the proposal. Approving a custom time that
moves a confirmed booking uses the moved wording, then you're all set —
not a second question. While the leaving
issue is open after the close, stuck-inside texts and greetings stay
on after-close handling. After the follow-up reply, a booking that was
still waiting gets the booked-for line, then the usual next steps.
DONE after the close uses the usual thanks and follow-up; a yes is
the same follow-up as a normal finish and does not ask again. During a tour,
the hint when there is no next stop is `Text DONE when you're finished.` The
didn't-catch line ends `or text DONE when you're finished.` `finish` still
ends the tour. STOP
during a tour stops visitor texts only; the tour stays on its window and
team alerts still go out. Afterwards it sends a recap and one follow-up
question.

The welcome is one message. It names the property by its address, and by a
name the operator gave it only when there is one: "Hi! Welcome to the
self-guided tours at 144 Hillside Ave. I can answer questions about the
property and help you book a tour." Then the unit menu. A single-family home
says "home" and offers tour days instead of a unit menu. An apartment or condo
(one unit) names the street plus unit ("145 Main St, Unit 4B"), never "Main
Home", and also skips the unit menu. Any property with exactly one unit skips
the unit question and offers days. A building that still has another unit
keeps the unit question when one unit is paused. One published place on a
shared number skips the place question. A draft is never listed. When every
open property on the line is a draft, STOP and HELP still use the opt-out and
help lines. START keeps the disclosure and replaces only the YES line. With a
help number that line is `Tours by text aren't available right now. You can call the {team} at {phone}. Reply HELP for help or STOP to opt out.` Without one it is `Tours by text aren't available right now. Please check back soon. Reply HELP for help or STOP to opt out.` START does not save a pending consent. A yes from a number with no consent record gets the disclosure. START on a draft also removes that number's saved consent record, including an earlier opt-out. Any other text gets the not-ready line. A one-place miss is `I didn't catch that. Which place are you touring?` Entry instructions are not in the
welcome; they arrive only on the you're-all-set text, after the identity
form when this place uses one.

## Visitor questions, at every stage

Prospects can ask about the property at any point: before choosing a unit,
while choosing a time, during the identity form when this place uses one, after
booking, before arriving, during and after the tour. No booking is needed to
ask. Answers come only from approved facts, with the structured unit details
first (bedrooms, bathrooms, rent, availability, square footage); the
description isn't used for those. If the question is ambiguous ("How much is
it?" with several units and none chosen), Tour Core asks "Which unit do you
mean: 1A, 1B or 2A?".

After the answer, Tour Core puts the interrupted step back in front of them
(the same unit menu, the same offered times, the same identity-form reminder when
this place uses one, or the pending confirmation). A question it can't answer gets one text, "I'll pass
your question to the {team}, and they'll reply here as soon as they can.", plus an issue and an operator
update. When the operator answers, the visitor gets the answer and the step
they were on. The save question is `Send this to {name} and save it for anyone who asks the same thing later? "{visitorWillReceive}"`, and the quote equals that text byte for byte. After a tour has ended, an approved-fact question is answered
and that answer gets ` If you'd like to tour again, just text HI.` (a period
is added first if the answer has no `.` `!` or `?`). A question that fits
more than one unit is asked back as `Which unit do you mean: {A} or {B}?`
with no HI line; after the visitor picks a unit, the approved answer gets
the HI line, or the locked ended flag text if that unit has no approved
answer. A question with no approved answer is flagged:
`I'll pass your question to the {team}, and they'll reply here as soon as they can. If you'd like to tour
again, just text HI.` A non-question keeps the ended-tour line and is not
flagged.

Photos are not forwarded yet. A photo alone gets one plain reply:
`I can't take photos yet. Text your question and I'll pass it along.`
A photo plus a question Tour Core can't answer gets one text:
`I can't open photos yet. I'll pass your question to the {team}, and they'll reply here as soon as they can.`
(and is flagged). After an ended tour, that line adds
`If you'd like to tour again, just text HI.` A photo plus an answerable
ended question gets `I can't take photos yet.` once, then the answer with
the HI line. A photo with handleable text (an approved-fact question or a
booking reply such as `1` or `YES`) gets only `I can't take photos yet.`;
the text is handled as usual. Mention photos at most once per inbound.
Do not also send the short photo line when the combined unknown-question
text is used.
Do not append “Text your question…”. The same inbound is not answered twice.
Do not say "MMS" to a visitor.

A visitor with a booked (or held) tour can cancel by text in their own words —
"Can we cancel the tour?", "I want to cancel the booked tour", "cancel",
"please cancel my tour", "call off the tour", "I can't make it", "I need to
cancel". That is not a property question. Tour Core confirms first:
`Cancel your {time} tour on {day}? Reply YES or NO.` YES cancels (doors
off, status cancelled, audit) and they hear `You're cancelled. Text me
anytime if you want to book again.` NO keeps the booking: `Okay, your tour
stays on {day} at {time}.` While they are touring and the cancel targets a
later booking: `Cancel your later tour at {time} on {day}? Your tour right
now isn't affected. Reply YES or NO.` YES: `Done, I've cancelled your later
tour at {time} on {day}. Your tour right now isn't affected.` NO: `Okay,
your later tour at {time} on {day} stays booked.` If they name the tour
they are on: `You can't cancel the tour you're on, but you're free to wrap
up whenever you like. Your later tour at {time} on {day} is still booked.
Want me to cancel that one instead? Reply YES or NO.` A touring visitor
with no later booking who texts cancel hears `You can't cancel the tour
you're on, but you're free to wrap up whenever you like. Text me anytime
if you want to book another tour.` On hold or a door-system problem those
refusal lines insert `The {team} is still working on the problem and will
text you here.` after the first sentence. A reply that isn't a clear yes or no is flagged:
`I'll check with the {team} and get back to you.` STOP still opts out. If
cancel cannot finish, they get
`I can't cancel it from here. I've asked the {team} to call it off and
get back to you.` and the team is flagged. Never use the unanswered-question fallback for a clear cancel ask.
When nothing is booked yet, that same cancel phrasing at the day menu, the time menu, or the property picker (`Actually cancel that`, `cancel that`, `cancel please`, `nevermind`; a bare `cancel` is still STOP) clears the step and replies `No problem, nothing's booked yet, so I'll stop here. Text me anytime if you want to pick a time.` It does not ask YES or NO and it does not say the tour is cancelled. The next text from someone already opted in starts scheduling again, with no TOUR keyword. A named day is used. At the property picker, that next text asks which place again.

Visitors can name a tour day as today, tomorrow, a weekday, or a calendar
date ("Dec 1", "December 1st", "1 Dec", "12/1", "Tuesday Oct 6", `mon`, `tmrw`). Without a
year, Tour Core uses the next date on or after today in the property's time
zone. If that this-year date has already passed and next year is beyond the
21-day horizon, it stays that past date — "That day has already passed" —
instead of rolling forward and calling it too far ahead. A named weekday is that day: the next one, or today only when today is that weekday and the time is still ahead. `Is Saturday at 2:45 PM possible?` is Saturday, not today. A no that names a time (`No, Saturday at 2:45 PM`) starts a request for that time. A bare no with nothing booked is `No problem. If you'd like another time, just reply with a day.` When a tour is booked, that no keeps the current booking. Declining a request with nothing booked is `The {team} couldn't approve {time} on {day}. If you'd like another time, just reply with a day.` A booked tour keeps the still-booked or still-confirmed ending. A tour still waiting on the identity form says still booked, not still confirmed. A fair-housing question is detected before rent, keywords, or a saved answer. A protected-group word anywhere matches too (`good for families`, `a good place for kids`, `family friendly`, `accessible for a wheelchair`, `good for ages 20-30`, `young professionals`, `good for families with kids`, `good for raising a family`, `a family building`). The group word does not count when the next word is car, room, size, style, offenders, neutral, dinner, gatherings, bike, toys, dog, cat, piano, parking, photography, table, fridge, wall, door, gate, paint, roof, Friday, or restaurant, so `Is parking good for a family car?`, `Is there a family room?`, and `What color are the walls?` do not match. `discount` and `building` do not stop a group word, so `Do you offer senior discounts?`, `Are there senior discounts?`, `Do you have a family discount?`, and `Is this a senior building?` match. `What is the age of the building?` and `roof age` do not match. Bringing someone to the tour or showing, or `allowed` on the tour, or a day or time with no suitability question, stays on the tour. `works for` next to a recognized time is a booking. A wheelchair, walker, cane, or the words blind, deaf, disabled, or disability is not that exemption. A group word after "I'm", "I am", or "my name is" is skipped only when that word and the word before it are both capitalized, so `Hi, I'm Kim Single` and `my name is Jordan Black` do not match, and `I'm legally blind`, `I'm currently single`, and `I'm happily married` do. Help, an open door, cancel, and a menu answer are handled first. A fair-housing hold at a live day or time menu sends that menu again. `Is the tour OK for kids?` still matches. `stop texting me`, `stop texting us`, `stop texting my family`, and `please stop texting my ...` opt out like STOP. The inbox title is `Possible fair-housing question`. A home office is not a protected class. The landlord inbox says `They asked: "{question}"` plus a period when the question does not already end with `.`, `?`, or `!`, then `This may touch on fair housing, so there's no draft. Only you can answer this one. They were told you'd text them back here.` The next step is only `Mark it handled once you've replied.` Neighborhood composition and steering are included, such as many families nearby, who lives nearby, is the neighborhood safe, and the crime rate. A race or color word matches on its own, including `white picket fence in the neighborhood?`, `what color are the doors in the building?`, `is it mostly white around here?`, `is it mostly Black around here?`, and `is the area mostly Asian?`. `any Asian restaurants nearby?` and `Black Friday sale nearby?` do not. Color photography does not. A church, parking, or a playground nearby, and room for kids' bikes, stay ordinary questions. A service, assistance, support, guide, seeing-eye, or therapy dog, animal, cat, or pet, emotional support followed by any word, and ESA are included even when a pets answer is saved. So are 55+, 55 and over, a senior community, age restrictions, housing assistance, a housing voucher, HUD, Section 8, undocumented status, sexual orientation, gender identity, gay, lesbian, LGBTQ, a same-sex couple, transgender, religion, Christian, Catholic, Protestant, Jewish, Jew, Muslim, Islamic, Hindu, Buddhist, Sikh, Mormon, atheist, a social security number, SSN, pregnancy, a newborn, a baby on the way, adults only, immigrants, immigration status, a minimum age, age limits, and discrimination. `Do you allow pets?`, `Do you allow dogs?`, `Is there a dog park?`, `Is there a church nearby?`, and `Is there a minimum lease?` are not. A dog park is not parking. Parking matches `parking`, `park my car`, or `where do I park`. After that no-draft flag is saved, the visitor gets `Good question for the {team}. I've passed it along, and they'll text you back here.` `{team}` is the operator name only when that name ends in "team"; otherwise it is "property team". The visitor never hears fair housing, the law, or why the question was held. If the flag cannot be saved, the team is texted first: `{who} asked a question, but I couldn't save it for you to answer. Please text them back. They're waiting.` The visitor then gets `I can't open the doors for you right now. I've let the {team} know, and they'll text you here shortly.` only if that text went out; otherwise `Sorry, I hit a snag with that. Could you text me again in a few minutes?` The audit write is afterwards, and a failed write is logged. A door with no step left, including a stale denial when there is no form, texts `{who} is at {door}, and I couldn't open it for them. Please text them or let them in.` first, then the same visitor lines. A stale identity form they can fill again is `It's been a while since you filled out the identity form, so I'll need you to fill it out again before I can open doors.` After the window, `Your tour time ended at {time}, so the doors are locked now. Want to come back another time? Just reply with a day that works.` HELP after every door is already open, and HELP after the window while the tour is still in progress, texts the team first. The visitor gets `I've let the {team} know. Stay where you are and reply here. They'll reply as soon as they can.` only if that text went out; otherwise `Sorry, I hit a snag with that. Could you text me again in a few minutes?` Injury texts are help in every state, including idle, a day menu, a time menu, a booked tour, and a tour in progress. When the team alert goes out, the visitor gets `If someone is hurt, call 911 now. I've also let the {team} know, and they'll text you here as soon as they can.` When it does not, and a visitor help number is saved, they get `If someone is hurt, call 911 now. I couldn't reach the {team} just now, so please call them at {phone} too.` With no help number they get `If someone is hurt, call 911 now. I couldn't reach the {team} just now.` That reply is never the snag line. Plain help, with no injury, keeps the stay-where-you-are line. `get_inbox` titles a medical help item `Possible injury` and says `They texted: "{q}"` plus a period when that text does not already end with `.`, `?`, or `!`, then `They were told to call 911 if someone is hurt, and that you'd text them here.` When the 911 text went out and the team alert did not, that ending is `They were told to call 911 and that you couldn't be reached.` When the 911 text was blocked or failed, that ending is `Our text telling them to call 911 didn't go out, so they haven't heard back yet.` When a later injury is skipped after STOP, that ending is `They've opted out of texts, so they weren't texted back this time. They were already told to call 911.` if an earlier 911 text got through, and `They've opted out of texts, so they weren't texted back this time. Our earlier text telling them to call 911 didn't go out.` if it did not. When that 911 text is still unconfirmed, the ending is `They were sent a text to call 911 if someone is hurt, but we can't confirm it reached them.`, and after STOP it is `They've opted out of texts, so they weren't texted back this time. Our earlier text telling them to call 911 was sent, but we can't confirm it reached them.` The next step is `Text or call them now, then mark it handled.` For the blocked ending, either skipped ending, and either unconfirmed ending, the next step is `Call them now, then mark it handled.` When a queued 911 text also has a failed team alert, the ending is `We sent them a text to call 911 and said you couldn't be reached, but we can't confirm it got to them.` The next step is `Call them now, then mark it handled.` A plain HELP with no medical word stays `Asked for help.` An injury text does not fold into that plain item. It opens its own Possible injury item. A later plain HELP still folds into an open injury item. A later injury on that tour stays on the injury item, and the ending follows the latest alert attempt, so a failed alert followed by a sent retry ends with the 911 sentence. A double quote inside the visitor's words is shown as a single quote. When a fair-housing text also got the 911 line, that item stays `Possible fair-housing question`, keeps `This may touch on fair housing, so there's no draft.`, and its last sentence is the injury ending. The inbox does not list `A text to you didn't go out` when the record before it is an injury help request. The audit row stays. After STOP, an injury text still alerts the team and opens a Possible injury item, except on a draft with no saved setup, which does not open that inbox item yet. The visitor gets the 911 line once per opt-out, including when STOP is the first text and when they opt in and then STOP before choosing a unit. A second injury before START alerts again and opens another item when an inbox item is opened, and does not send the 911 line again. After START, then STOP, the next injury gets the 911 line once more. If the carrier blocks that line, it is logged once, not retried, and not listed as a text that didn't go out. HELP after STOP gets the help reply. Any other text stays silent and the opt-out stays. On a draft, both a single-property line and a shared line check an injury before the not-ready reply, including a draft with no saved config. That injury is never dropped. If the team cannot be alerted, the visitor gets `If someone is hurt, call 911 now. I couldn't reach the {team} just now.` An injury text on a draft with no saved setup sends the 911 line and alerts the team, but doesn't open a Possible injury inbox item yet. After STOP on that draft, the 911 line goes out once per opt-out and a later injury still alerts the team. `my dad passed out` and `call 911` each send one alert and the 911 line and, on a saved draft, open Possible injury, with no not-ready text. `Hi` still gets the not-ready line. fell, hurt, injured, slipped, and tripped count only with a person or a help word in the same text. `I fell in love with the place`, `the price fell`, `would it hurt to ask`, `the date slipped`, `choking hazard`, `seizure of`, `heart attack of`, `is a heart attack`, `passed out` flyers, papers, pamphlets, or candy, `tripped the breaker`, `tripped the alarm`, `tripped the switch`, and a tour, showing, appointment, time, date, or it `slipped to` do not. `she slipped to the ground, help`, `my son slipped to the floor`, and `I slipped to the floor` still do. `he passed out`, `my kid is choking`, `she's having a heart attack`, `broke his back`, and `had a stroke` still do. `bleeding` and `ambulance` match as whole words, so `ambulance-chaser` does not. `not breathing`, `stopped breathing`, `cannot breathe`, `can't breathe`, `can not breathe`, `trouble breathing`, `cannot get up`, `can not get up`, `can't get up`, `cant get up`, `choking`, `unconscious`, `unresponsive`, `passed out`, `fainted`, `collapsed`, `heart attack`, `having a stroke`, `had a stroke`, `has a stroke`, `seizure`, `overdose`, `overdosed`, `overdosing`, `allergic reaction`, `chest pain`, and `chest pains` match without a person or a help word. `broke` or `broken` counts when a body part follows, optionally after `his`, `her`, `my`, `their`, `your`, `our`, or `a`: arm, leg, wrist, ankle, hand, foot, feet, finger, toe, rib, nose, hip, collarbone, neck, bone, tooth, teeth, jaw, elbow, knee, shoulder, skull, and their plurals. `back` counts only after `his`, `her`, `my`, `their`, `your`, or `our`, so `broke a back window`, `broke a lease`, and `broke a nail` do not. `911` matches `call 911`, `dial 911`, or `911` alone, and not an address such as `911 Main St`. When that team text does not go out, the landlord sees `I couldn't text you about {who}, so I asked them to text me again in a few minutes.` That line never names a provider or an error. The fair-housing flag has `proposeDraft` false. The landlord refusal is `This one touches on fair housing, so I won't draft an answer. Reply to them yourself, then mark it handled.` `How much is rent?` and `Is rent due monthly?` stay rent answers. A date or booking ask is handled as booking, not as a flagged question. If
the day can't be resolved ("the 45th", "sometime next month"), Tour Core
asks which day they meant and shows the day menu; it does not flag the team. A bare fragment at that menu gets `Sorry, I didn't catch that.` `mon` and `tmrw` are days, so they are accepted.
While a one-off tour is waiting on YES, NO, or STOP, a leftover menu
number only re-prompts; a real question is flagged for the team and the
hold stays pending.

If that day has no bookable tours, the visitor is told why — no more tours
today, fully booked, tours don't run that weekday, beyond the 21-day
booking horizon, or no open times at all — plus the next opening when there
is one. A date that has already passed starts "That day has already
passed. The next opening is {when}." Wherever "The next opening is
{when}." is followed by the day menu, the ending is "Reply yes to take
it, or pick a day:". An offer without that next-opening line still ends
"Reply yes for {time} on {Weekday}, or pick a day:". The follow-up is
"Reply yes for {time} on {Weekday}, or pick a day." A natural yes — yes,
that, yeah, yep, ok, okay, "Yes I'll take it", "Yes 1 works", "I'll take
it", and similar accepts — books that exact start after a recheck; if it
was taken, they hear "Someone just grabbed that time." A reply that is
neither an accept nor a day keeps the offer and repeats the follow-up.
Bare numbers and day names still pick from the day menu. A sentence that
names another day or time ("Can I come oct 6 at 12 pm?") is a fresh date
request for that day, not an accept of the pending opening.

Open conversations pick up the latest published settings (hours, units,
and so on) on every inbound text. A stale numbered reply after hours
change gets "Tour times just changed. Here's what's open now:" and the
fresh days. "Tour" restarts booking from the current day picker. An
offered next opening is rechecked against the current hours before it is
booked.

## Who does what

| Part | Job |
| --- | --- |
| Operator (you) | Decides setup, answers, and anything consequential |
| Grok Bot (Tour Core Bot) | Understands the operator and calls Tour Core's tools |
| Tour Core | Keeps every record, applies policy, writes the audit |
| Door system | The door access provider's service. Carries out access Tour Core has already approved |

## The access rule

A door opens only when all of these hold for the visitor asking: their records are valid (reservation,
consent, identity check), it's their tour time, the door is on their exact
reserved route, and the system is healthy with no conflict, provider failure
or operator hold. Anything else is a safe denial, decided before the door system is
asked. If visit records cannot be confirmed before unlock, the door stays
locked and the operator is told "Tour Core couldn't save the visit record, so
{door} stayed locked." (no issue; booking stays ready). If the grant cannot be
saved after unlock, the tour is paused and the issue is "Tour Core couldn't
save the visit record, so the tour was paused." Say "door access" to the
operator; never name the door access provider.

## What an operator does with the Bot

0. **Set up Tour Core**: the Bot installs and starts Tour Core on its own cloud
   computer, then asks the operator only for what needs a person (see
   `installation.md`).
1. **Set up a property**: address (the property's identity; a name only if the
   operator gives one; a street on its own keeps its suffix), one missing part
   at a time (street, then state, then city, then ZIP; a city given early is
   kept), property type (single-family home; multifamily — duplex or small
   building they own; apartment or condo — one unit), units, doors, routes,
   tour hours, visitor verification. No time zone line until a state is known. A street with no state or ZIP leaves the time zone unset. An older saved GMT+00:00 with no state is read as unset and is not rewritten. A published property with no usable time zone (including an older GMT+00:00 with no state, or a file with the time zone field missing) stops tours. The file is not rewritten. Visitors get the normal human-path reply. A tour already in progress finishes normally. No new tour or reservation starts until a zone is set. Say to the landlord: "This property doesn't have a time zone set yet, so tours can't run. What time zone should tours use, like Eastern or Pacific?" `get_inbox` shows that as Time zone needed, with no id, until a zone is set. Setting Eastern or Pacific brings tours back and clears that item. Changing only the state still checks a ZIP already saved. A mismatch saves nothing and asks which to fix, the ZIP or the state. When nothing follows a guess, say "I'm using {Eastern} time for tours. Want a different one?" When a setup question follows, say "I'm using {Eastern} time for tours. You can change that anytime." and then that one question. A guessed time zone updates only before the
   address is confirmed, and never on a property that was published or already
   had a confirmed address or an operator-set zone. A locked zone that a new state would move asks only "Tours still run on {current} time. Should I switch to {new} time?" Ask the next setup question after they answer. A ZIP is not a yes. A ZIP or other detail sent while that question is open is held and saved once they answer, including when they name a zone such as "Pacific" or "keep Eastern". Do not send it again. An end of 11:59 PM is said as midnight. On a fresh install, ask "How should people text you about a tour?" and call `set_up_texting`. Once visitor texting is
   installed, a new property uses it automatically and is not asked again. For an apartment or condo, `get_state` names `save_property` for building-door control and `save_doors_and_routes` for "What's the building entrance called?"
2. **Check readiness**: real checks against the pieces the setup uses.
3. **Run a practice tour**: a full pretend tour with safety checks. Nobody is
   texted and no real door opens. A single-family home keeps the entrance proof
   line; a unit-door-only apartment or condo shows the unit-door proof instead.
4. **Publish for demo**: only after both pass, and only after the operator's yes.
   A property that is not published does not take a new visitor text. Someone who already booked keeps that tour.
5. **Watch active tours** and **work exceptions**: unanswered questions, help
   requests, door problems, paused tours, tours that couldn't be restored.
   Pause or resume bookings at a property or unit (`pause_tours`;
   pass `paused` false to resume; resume texts people who were told tours would be back;
   a later Tour / Hi / book restarts booking the same way as a first text),
   or remove a property from the list (`remove_property`; finds any
   property `get_state` shows, including an unpublished setup;
   published records stay, including a property sent back to draft that
   still has publishedAt, visitor tour or reservation records, or a publish
   event in its audit (a practice tour alone does not count); an unpublished setup is removed completely,
   whether or not it is complete; unpublished confirmation says it isn't
   published yet so no visitors are affected, but everything entered will
   be deleted for good; published with no bookings says no one is booked,
   so no cancel texts go out; one booked visitor is singular; it names the
   operator-given name, or street plus unit when there is exactly one unit,
   otherwise the street line, never Main Home; a later text
   gets a goodbye and cannot book; booked cancel text does not promise tours
   will be back). While paused, `reply_to_time_request`
   and `schedule_tour` refuse (`Tours at {property} are paused. Resume
   them first.`). Say remove, never archive.
   Tour Core also wakes the Bot (Tour Core Operator Updates routine) for the
   updates the operator chose: bookings, tour starts, completions and anything
   that needs their judgment. Only real text-message tours produce updates.
   If an update doesn't get through, say "A tour update didn't reach you. Check your inbox for anything new. I'm sending a test so the next ones get through." Do not set tour updates up again. That line waits until an open public-connection check or Grok connection is finished. A later ordinary delivery does not clear the miss; only a passing test does. A test that gets through goes back to keeping them posted on what they chose. A test that doesn't keeps "Tour updates aren't reaching you." When an alert address is already saved, say "Tour updates aren't reaching you. I'll send you a secure link to reconnect them. Nothing you type there shows in chat." The secure page overwrites the saved address and key with no history, so re-enter the existing routine's address and key there. Never create a new routine or use a new routine's address or key. When no address is saved, use the first-time setup. An issue read joins a finished sentence to the tour status with a space (`There's no approved answer yet. Choosing a time.`, and the same for an ellipsis or a closing quote or parenthesis), never a second period. When the visitor has no name, the summary starts Visitor at {number}, {place}:. A named visitor stays their first name. Each item that had an alert includes its eventId. The ping stays ids only.
   A visitor can ask for a time that isn't a regular slot. The operator can
   also set up a tour for someone who asked (`schedule_tour`), even if
   they haven't texted in — only after confirming they asked. A leftover day or
   time menu with nothing booked does not block: the one-off replaces it, and
   later replies go to the new confirmation. A leftover menu number only
   re-prompts YES / NO / STOP; a real question is flagged. A booked tour, a pending one-off,
   an open tour window, or a hold still refuses — tell the operator Tour Core's
   words (`They already have a booked tour. I can move it or call it off.`),
   then move it with `schedule_tour` or call it off with `cancel_tour`
   (resume a hold with `hold_tour`). Tour-time confirmation
   questions end `Move it?` or `Book it?`. A move names the old
   time. `This is a one-off…` only outside tour hours.
6. **Export the audit**: a validated, provider-neutral record of the day. On an installation whose records live in Google Drive (`GOOGLE_DRIVE_READY`), the day's `audit-export.json` is written with the records and copied into Drive by the save step. The CSV stays on the Tour Core computer. On a hosted installation (`HOSTED_VOLUME`, Drive used only for backups), day exports stay on the server as 30-minute download links that can be used until they expire. Only readable exports and backups come back as one-time links for the assistant to save into the Tour Core folder in Drive. Door access in a day export is only what was issued or used that day. Each embedded tour in that JSON is trimmed to that day's events and grants.

Day-to-day work uses `get_tours`, `schedule_tour`, `cancel_tour`, `hold_tour`, `pause_tours`, `get_inbox`, `reply_to_time_request`, `resolve_issue`, `export_records`, `backup_records`, and `restore_records`. `get_tours` counts a tour in progress as happening now and a later booking as coming up. Someone who is only texting, with no booked tour, is not a tour and is not counted. None reads "No tours right now." One future booking reads "1 tour coming up: {name} at {time} on {day}." `get_state` points at `get_inbox` once a property is published, and at `backup_records` on the backups step. The landlord connector does not list the older tour, inbox, backup, and export tools. The checksum is the SHA-256 of the backup's `contents` only: compact JSON (no spaces), object keys sorted at every level, arrays kept in order, UTF-8 with non-ASCII characters written as-is (not \u-escaped), no trailing newline. It is stored in the file's `checksum` field, so a hash of the whole downloaded file won't match. `c = json.load(f)["contents"]` `hashlib.sha256(json.dumps(c, sort_keys=True, separators=(",",":"), ensure_ascii=False).encode("utf-8")).hexdigest()`

## Current P0 demo configuration

- Tour Core runs on the Bot's cloud computer (a demo deployment) or at a
  stable self-hosted address.
- Visitor messaging: the provider the operator chooses (Sendblue, Twilio, Photon, or local QA loopback). Do not assume Sendblue.
- Local test texts, when there is no carrier: put that building on local with `set_up_texting` (`provider` local, and that property). `set_up_texting` says "Texting is in test mode, so texts don't reach real phones. Real visitors won't get anything until live texting is turned on." Do not say texting is live. Do not switch the whole installation to local when another building is already on live visitor texting. Publishing a local building leaves out "Visitors can start a tour by texting your touring number." Switching the installation's provider keeps saved carrier credentials.
<!-- connector: qa -->
  On the QA connector, `inject_local_sms` and `read_local_outbox` send and read those texts as separate bubbles. `hasMedia` injects a photo inbound (the file is not forwarded; a photo alone is told it can't take photos yet, and a photo plus a question it can't answer is one combined text and is flagged). Those tools refuse unless that building is on local.
<!-- /connector -->
- Operator updates: the Tour Core Operator Updates Grok Routine.
- Tour records: on the hosted product, stored by hosted Tour Core (`HOSTED_VOLUME`). Google Drive there is only for portable backups. On an installation whose records live in Google Drive (`GOOGLE_DRIVE_READY`), the day's `audit-export.json` is written with the records and copied into Drive by the save step. The CSV stays on the Tour Core computer. On a hosted installation (`HOSTED_VOLUME`, Drive used only for backups), day exports stay on the server as 30-minute download links that can be used until they expire. Only readable exports and backups come back as one-time links for the assistant to save into the Tour Core folder in Drive. Door access in a day export is only what was issued or used that day. Each embedded tour in that JSON is trimmed to that day's events and grants. Optional direct Drive remains a separate mode.
- Door access: demo mode. No physical door is controlled.
- Visitor verification: a basic identity form (recommended; records who they say they are; it
  doesn't prove it) or no form. No form means anyone who texts can book a tour and get in
  without saying who they are, and it is saved only after the landlord agrees.

"Published for demo" is not a production launch. Describe each part as it is
("Visitor texting is live. Door access is still in demo mode, so no physical
locks will open."); for local test texts, use the test-mode sentence above.
Never say "everything runs in demo mode".
