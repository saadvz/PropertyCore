# Visitor text templates

Every outbound visitor text uses one of these ids. `{slot}` is filled before send. `{slot?}` may be empty. A channel prompt may be appended after the body. The stored template id is the body, not the prompt.

Text from the landlord or from a model reaches a visitor only as `approved-answer` or `approved-answer-closing`, and only after they approve a flagged question (`resolve_issue`). A no-draft flag never gets a draft. `approved-profile-fact` repeats a fact they already saved.

217 message templates. 7 channel prompts.

## Messages

### fair-housing-held

Sent only after the question is flagged no-draft. Never names the reason.

```
Good question for the {team}. I've passed it along, and they'll text you back here.
```

### door-stuck-no-steps

No step left, including a stale denial on a no-form property, and a failed forward of a held question.

```
I can't open the doors for you right now. I've let the {team} know, and they'll text you here shortly.
```

### finish-steps

```
We're not quite ready to open doors yet. Finish the steps I sent earlier and you'll be all set.
```

### tour-window-ended

{time} drops :00, for example 3 PM or 3:30 PM. No door opens.

```
Your tour time ended at {time}, so the doors are locked now. Want to come back another time? Just reply with a day that works.
```

### all-doors-open

```
Every door on your tour is already open for you. Text HELP if one isn't working.
```

### unknown-answer

```
I'll pass your question to the {team}, and they'll reply here as soon as they can.
```

### unknown-answer-photo

```
I can't open photos yet. I'll pass your question to the {team}, and they'll reply here as soon as they can.
```

### unknown-answer-ended

```
I'll pass your question to the {team}, and they'll reply here as soon as they can. If you'd like to tour again, just text HI.
```

### unknown-answer-ended-photo

```
I can't open photos yet. I'll pass your question to the {team}, and they'll reply here as soon as they can. If you'd like to tour again, just text HI.
```

### tour-ended-reply

```
This tour has ended. Text HI any time to start a new one.
```

### open-times

{times} is one line per day: the day, then its open times. Never the unit's move-in availability.

```
Here are the open tour times:
{times}
```

### open-times-booked

A booked visitor asked. Their booking is not changed.

```
Here are the open tour times:
{times}
Your tour stays as it is. To move it, say which day and time you'd like.
```

### open-times-other-day

The named weekday has no open times.

```
Nothing is open {day}. Here are the next open times:
{times}
```

### open-times-none

```
Nothing is open for tours right now.
```

### reschedule-offer

A booked visitor asked to move their tour. {options} is numbered lines like "1) Tuesday, Sep 29 at 2:00 PM".

```
Here are the open times:
{options}
Reply with the number of the time you'd like. Your tour stays as it is until you pick.
```

### reschedule-none

```
Nothing else is open right now, so your tour stays as it is.
```

### my-tour

A booked visitor asked when their tour is.

```
Your tour is at {time} on {day}.
Doors will work for you from {start} to {end}.
The address is {address}.
```

### no-tour-booked

```
You don't have a tour booked yet.
```

### property-address

```
The address is {address}.
```

### reschedule-taken

The picked time was booked by someone else first. The visitor's tour is unchanged.

```
That time was just taken. Here are the open times now:
{options}
Reply with the number of the time you'd like.
```

### storage-unavailable

```
I can't check that right now. Please try again in a little while.
```

### shared-fact

```
Here's what the {team} shared: {fact}
```

### tour-length

From the tour length set at setup.

```
Tours are about {minutes} minutes.{again?}
```

### tour-id-form

ID question, identity form on.

```
You'll fill out a short form with your name, email, and phone before your tour. No ID is needed at the door.{again?}
```

### tour-id-none

ID question, no identity form.

```
No ID or form is needed for this tour.{again?}
```

### approved-profile-fact

Explicit id only. Not matched automatically. A profile fact the landlord already saved. Not a draft.

```
{answer}
```

### approved-answer

Explicit id only. Not matched automatically. Landlord reply from resolve_issue only. No-draft items never use this.

```
{answer}
```

### approved-answer-closing

Explicit id only. Not matched automatically. Approved fact plus the closing line, from resolve_issue only.

```
{answer} Let me know if you have any other questions.
```

### cancel-done

```
You're cancelled. Text me anytime if you want to book again.
```

### cancel-opt-out

Bare cancel when a tour is booked and has not started. Also the carrier opt-out. The stored keyword is STOP.

```
Your tour is cancelled and you won't get any more texts from us. To come back or book again, reply START.
```

### nothing-booked-cancel

```
No problem, nothing's booked yet, so I'll stop here. Text me anytime if you want to pick a time.
```

### cancel-failed

```
I can't cancel it from here. I've asked the {team} to call it off and get back to you.
```

### cancel-confirm

```
Cancel your {time} tour on {day}? Reply YES or NO.
```

### cancel-kept

```
Okay, your {time} tour on {day} stays booked.
```

### later-cancel-confirm

```
Cancel your later tour at {time} on {day}? Your tour right now isn't affected. Reply YES or NO.
```

### later-cancel-done

```
Done, I've cancelled your later tour at {time} on {day}. Your tour right now isn't affected.
```

### later-cancel-kept

```
Okay, your later tour at {time} on {day} stays booked.
```

### cannot-cancel-running-later

```
You can't cancel the tour you're on, but you're free to wrap up whenever you like.{note?} Your later tour at {time} on {day} is still booked. Want me to cancel that one instead? Reply YES or NO.
```

### cannot-cancel-running

```
You can't cancel the tour you're on, but you're free to wrap up whenever you like.{note?} Text me anytime if you want to book another tour.
```

### at-door-phone

```
Stay where you are. {who} reply as soon as they can, or call {phone}.
```

### at-door

```
Stay where you are and reply here. {who} reply as soon as they can.
```

### remote-phone

```
{who} reply here as soon as they can, or call {phone}.
```

### remote

```
{who} reply here as soon as they can.
```

### operator-hold

```
Your tour is on hold, and your tour time keeps running while the {team} sorts this out. {rest}
```

### called-off

```
Your tour{when?} has been called off, so the doors won't open for it. {rest}
```

### too-early

```
You're a little early! I can open the doors from {when}. {again}
```

### too-early-generic

```
You're a little early! I can open the doors from your tour time. Text me again at your tour time.
```

### follow-up-yes

```
Great. Someone from the {team} will be in touch soon.
```

### help-ack

```
I've let the {team} know. {rest}
```

### help-repeat

```
The {team} already knows and is on it. {rest}
```

### medical-help

Injury help when the team alert went out. Plain help with no medical word keeps help-ack.

```
If someone is hurt, call 911 now. I've also let the {team} know, and they'll text you here as soon as they can.
```

### medical-help-call

Injury help when the team alert failed and a visitor help number is saved. Same help-number choice as property-not-ready-call. Never the snag line.

```
If someone is hurt, call 911 now. I couldn't reach the {team} just now, so please call them at {phone} too.
```

### medical-help-unreached

Injury help when the team alert failed and no visitor help number is saved. Never the snag line.

```
If someone is hurt, call 911 now. I couldn't reach the {team} just now.
```

### no-open-times

```
There are no open tour times right now. The {team} will reach out.
```

### doors-not-responding

```
Sorry, the doors aren't responding right now. I've let the {team} know. {rest}
```

### follow-up-phone

```
The {team} will follow up here, or call {phone}.
```

### follow-up

```
The {team} will follow up here.
```

### failed-id-door

```
I couldn't confirm your details, so I can't open doors for this tour. {rest}
```

### failed-id-booking

```
Thanks for filling that out. {rest}
```

### failed-id-ended

```
I couldn't confirm your details, so your tour has ended. Please head out the way you came in. {rest}
```

### stale-verification

```
It's been a while since you filled out the identity form, so I'll need you to fill it out again before I can open doors.
```

### missing-consent

```
Before I can open doors, text me back and I'll finish setting up your tour.
```

### wrong-route

```
That door isn't part of your tour, so I can't open it. You're here to see {place}. I've let the {team} know in case you need a hand.
```

### tour-completed-doors

```
Your tour is finished, so the doors are locked again. Want to book another visit?
```

### tour-inactive

```
This tour is no longer active, so I can't open doors. Reply if you'd like to book a new time.
```

### booked-for

```
Great, you're booked for {time} on {day}.
```

### replaces-tour

```
That replaces your {time} tour on {day}.
```

### custom-time-asked

```
I've asked the {team} about {newTime} on {newDay} instead. Your {time} tour on {day} stays booked unless they approve the change.
```

### decline-request

```
The {team} couldn't approve {newTime} on {newDay}. {rest}
```

### decline-still-confirmed

```
The {team} couldn't approve {newTime} on {newDay}. Your {time} tour on {day} is still confirmed.
```

### decline-still-booked

```
The {team} couldn't approve {newTime} on {newDay}. You're still booked for {time} on {day}.
```

### decline-no-booking

```
The {team} couldn't approve {newTime} on {newDay}. If you'd like another time, just reply with a day.
```

### request-expired

```
The {team} couldn't get to your request for {newTime} on {newDay} in time. {rest}
```

### propose-one-off

```
The {team} can do {time} on {day} as a one-off. {rest}
```

### propose-instead

```
The {team} can't do {requestedTime} on {requestedDay}, but {proposedTime} on {proposedDay} works. {rest}
```

### decline-proposed-confirmed

```
No problem. Your {time} tour on {day} is still confirmed.
```

### decline-proposed-booked

```
No problem. You're still booked for {time} on {day}.
```

### decline-proposed-none

```
No problem. If you'd like another time, just reply with a day.
```

### pending-custom

```
Your request for {time} on {day} is still with the {team}. I'll text you as soon as they respond.{rest?}
```

### taken-slot

```
Sorry, {time} on {day} is already taken.{rest?}
```

### taken-other-day

```
If you'd like another time, just reply with a day.
```

### already-asked

```
I've already asked the {team} about {time} on {day}.
```

### time-passed

```
That time has already passed. What later time works for you?
```

### time-passed-today

```
That time today has already passed. Did you mean tomorrow?
```

### time-invalid

```
That time doesn't work. What time would you like?
```

### consent-declined

```
No problem, I won't text you again about this tour. Reach out anytime if you change your mind.
```

### inquiry

```
{greeting} Happy to set up a self-guided tour of {place}.{summary?}
{next}
```

### tour-moved-window

```
Your tour has moved to {when}.
Doors will work for you from {start} to {end}.
```

### tour-moved-same

```
Your tour has moved to {when}. Everything else stays the same.
```

### tour-moved-notice

```
Your tour of {unit} has been moved to {time} on {day}.{extra?}
```

### operator-schedule-declined

```
No problem. I cancelled that tour. Text me anytime to book another.
```

### operator-schedule-expired

```
I didn't hear back, so I released your {when} tour. Text me anytime to book another.
```

### follow-up-no

```
No problem. Thanks again for visiting!
```

### no-problem

```
No problem.
```

### mark-ready

```
You're all set for your {time} tour on {day}!
Doors will work for you from {start} to {end}.{entry?}
```

### tour-directions

```
Here's how to get there: {url}
```

### door-open

```
{door} is open for you now.{tail?}
```

### identity-form

```
Thanks! One last step before your tour: please fill out this short form with your legal name, email and phone.
```

### photo-alone

```
I can't take photos yet. Text your question and I'll pass it along.
```

### photo-with-text

```
I can't take photos yet.
```

### schedule-changed

```
Tour times just changed. Here's what's open now:
```

### day-menu

```
I have tours available. Which day works for you?
```

### no-weekend

```
I don't have weekend tours, but weekdays are open. Which day works for you?
```

### sorry

```
Sorry, I didn't catch that.
```

### sorry-rest

```
Sorry, I didn't catch that. {rest}
```

### sorry-ready

```
Sorry, I didn't catch that. You can ask me a question about the property.
```

### sorry-touring

```
Sorry, I didn't catch that. You can ask me a question{hint?}, or text DONE when you're finished.
```

### which-unit

```
Which unit do you mean: {units}?
```

### which-unit-plain

```
Which unit would you like to see?
```

### unit-two

```
Sure — did you mean {a} or {b}?
```

### unit-many

```
Sure — which unit did you mean?
```

### day-unclear

```
I couldn't tell which day you meant. Which day works for you?
```

### confirm-arrival

```
Are you at the property now?
```

### confirm-stop

```
Are you at {stop} now?
```

### choose-stop

```
Which door are you at: {stops}?
```

### confirm-finish

```
Are you finished with your tour?
```

### identity-waiting

```
Your identity form is in my earlier message. Once it's filled out, I'll confirm your tour.
```

### follow-up-question

```
Would you like someone from the {team} to follow up?
```

### follow-up-clarify

```
Just to check: {question}
```

### tour-not-started

```
Your tour hasn't started yet.
```

### start-at-first

```
Let's start at {stop}. Are you there now?
```

### arrival-all-set

```
You're all set.{hint?}
```

### which-time

```
Which time works for you?
```

### which-time-sure

```
Sure — which time works for you?
```

### which-time-rule

```
{lead} Which time works for you?
```

### manipulation

```
I can only help with your own tour. Doors open only for the stops on it, during your tour time.{hint?}
```

### custom-time-which-unit

```
{time} isn't one of the regular tour times. Which unit should I ask the {team} about?
```

### custom-time-yes

```
If you'd like {time}, reply YES and I'll ask the {team}.
```

### custom-time-ask

```
{time} isn't one of the regular tour times, but I can ask the {team}. I'll let you know once they respond.
```

### awaiting-team

```
I'll check with the {team} and get back to you.
```

### clarify-which-time

```
Which time did you mean?
```

### clarify-what-time

```
What time would you like?
```

### clarify-what-time-be

```
What time should that be?
```

### clarify-am-pm

```
Did you mean {label} AM or {label} PM?
```

### clarify-time-closed

```
That time isn't open.
```

### clarify-en-route

```
No rush! Text me when you're at the property.
```

### clarify-arrival-no

```
No problem. Text me when you're at the property.
```

### clarify-stop-no

```
No problem. Text me when you get there.
```

### clarify-finish-no

```
No rush. Take your time.
```

### welcome-unit

```
Hi! Welcome to the self-guided tour for {place}. I can answer questions about the unit and help you book a tour.{next?}
```

### welcome-home

```
Hi! Welcome to the self-guided tour for {place}. I can answer questions about the home and help you book a tour.{next?}
```

### welcome-building

```
Hi! Welcome to the self-guided tours {where}. I can answer questions about the property and help you book a tour.{next?}
```

### time-menu

```
I have these times available {day}:
```

### time-menu-empty

```
I don't have any open times on {day}.
```

### closed-weekday

```
Tours don't run on {days}.{rest?}
```

### beyond-horizon

```
I can't book that far ahead yet.{rest?}
```

### no-more-today

```
There are no more tours today.{rest?}
```

### day-full

```
{day} is fully booked.{rest?}
```

### day-passed

```
That day has already passed. {rest}
```

### next-opening-follow

```
Reply yes for {time} on {day}, or pick a day.
```

### slot-grabbed

```
Someone just grabbed that time. {rest}
```

### still-confirmed

```
Your {time} tour on {day} is still confirmed.
```

### still-booked

```
You're still booked for {time} on {day}.
```

### switch-keep

```
Reply YES to switch, or NO to keep your {time} tour on {day}.
```

### switch-keep-looking

```
Reply YES to switch, or NO to keep looking.
```

### which-day

```
Which day works for you?
```

### tour-hours-which-day

```
Tours run {days}, {hours}. Which day works for you? Just reply with a day, like {examples}.
```

### next-opening-want

```
The next {noun} is {when}. Want that, or another day?
```

### next-opening-menu

```
The next {noun} is {when}. Reply yes to take it, or pick a day:
```

### heres-whats-left

```
Here's what's left:
```

### tours-back-soon

```
They'll text you when tours are back.
```

### text-anytime-another

```
Text me anytime to book another.
```

### questions-call

```
Questions? Call {phone}.
```

### pending-regular

```
If you'd rather pick one of the regular times instead, just reply with a day.
```

### at-stop-hint

```
Text me when you're at {stop}.
```

### done-hint

```
Text DONE when you're finished.
```

### operator-scheduled

```
Hi, this is the {team} at {address}. We set up a tour for you at {time} on {day}. Reply YES to confirm, NO to cancel, or STOP to opt out.
```

### operator-schedule-nudge

```
Reply YES to confirm, NO to cancel, or STOP to opt out.
```

### opt-in-again

```
You'll get messages from {place} again. Text HI any time to start a tour.
```

### identity-resend

```
Here's your identity form link again. The earlier link no longer works.
```

### paused-property

```
Tours at {address} are paused right now. The {team} will text you when they're back{call?}.
```

### paused-unit

```
{unit} isn't open for tours right now.{rest?}
```

### removed-property

```
{address} isn't offering tours anymore.{rest?}
```

### called-off-lead

```
Sorry, the {team} had to cancel your {time} tour on {day} at {address}. {rest}
```

### called-off-later

```
Sorry, the {team} had to cancel your later tour at {time} on {day}. Your tour right now isn't affected. {rest}
```

### tours-are-back

```
Tours at {address} are back. Text me anytime to book.
```

### sms-disclosure

```
{brand}: You're starting a text conversation about a self-guided property tour.

Message frequency varies. Message and data rates may apply.

Reply YES to continue, HELP for help, or STOP to opt out.

Privacy: {privacy}
Terms: {terms}
```

### sms-disclosure-draft

START on a draft-only line when no visitor help number is saved. Same disclosure as sms-disclosure, with the YES line replaced.

```
{brand}: You're starting a text conversation about a self-guided property tour.

Message frequency varies. Message and data rates may apply.

Tours by text aren't available right now. Please check back soon. Reply HELP for help or STOP to opt out.

Privacy: {privacy}
Terms: {terms}
```

### sms-disclosure-draft-call

START on a draft-only line when a visitor help number is saved. {team} and {phone} use the same help-number wording as the not-ready reply.

```
{brand}: You're starting a text conversation about a self-guided property tour.

Message frequency varies. Message and data rates may apply.

Tours by text aren't available right now. You can call the {team} at {phone}. Reply HELP for help or STOP to opt out.

Privacy: {privacy}
Terms: {terms}
```

### sms-opt-in

```
{brand}: You're opted in. I can answer questions about the property and help you schedule and complete a self-guided tour.
I'll keep a record of your visit times and the doors you use.

Reply STOP at any time to opt out.
```

### sms-gate

```
Reply YES to continue, HELP for help, or STOP to opt out.
```

### sms-keyword

```
Text TOUR to ask questions or schedule a self-guided tour. Reply HELP for help or STOP to opt out.
```

### sms-stop

Shared with Cleaner Core. No product-brand prefix.

```
You're opted out and won't receive more messages. Reply START to opt back in. Reply HELP for help.
```

### sms-help

```
{brand}: {help} Message and data rates may apply. Reply STOP to opt out.
```

### property-not-ready

Sent when tours cannot run and no visitor help number is saved, including a new visitor text to a property that is not published for demo (a draft, or a demo sent back to draft). A tour that was already booked on that property keeps going.

```
Thanks for reaching out to {name}. Tours by text aren't available right now. Please check back soon.
```

### property-not-ready-call

The same reply when a visitor help number is saved. {phone} is that number, formatted the same way as the paused and removed replies.

```
Thanks for reaching out to {name}. Tours by text aren't available right now. You can call the {team} at {phone}.
```

### storage-save-failed

```
I couldn't save that, so nothing was booked or changed. Please try again in a little while.
```

### handler-snag-alerted

```
Sorry, I hit a snag with that. I've let the {team} know, and they'll reply here as soon as they can.
```

### handler-snag-retry

```
Sorry, I hit a snag with that. Could you text me again in a few minutes?
```

### restore-trouble

```
I'm having trouble restoring your tour. I've alerted the {team}.
```

### restore-trouble-restart

```
I'm having trouble restoring your tour. I've alerted the {team}. Text HI to start a new tour.
```

### portfolio-picker

```
Which place are you touring?
{choices}
```

### portfolio-miss-1

```
I didn't catch that. Which place are you touring?
```

### portfolio-miss-2

```
I didn't catch that. Reply 1 or 2 for which place.
```

### portfolio-miss-3

```
I didn't catch that. Reply 1, 2, or 3 for which place.
```

### portfolio-street-miss

```
I couldn't find that one. Reply 1, 2, or 3, or text the street name.
```

### t15

```
Hope you're enjoying {place}{name?}! You have about 15 minutes left. Any questions about the place? Just text them here.
```

### t15-yes

```
Sure, what's your question?
```

### t15-no

```
Sounds good. Enjoy the rest of your tour!
```

### t5-offer

```
Heads up{name?}, your tour of {place} ends in 5 minutes{when?}. Want 10 more minutes? Just reply and ask.
```

### t5-no-offer

```
Heads up{name?}, your tour of {place} ends in 5 minutes{when?}. Text DONE once you're outside.
```

### t5-bare-yes

```
Sounds good. Text DONE once you're outside.
```

### extension-granted

```
You've got 10 more minutes. Your tour now ends at {end}, and your doors will keep opening for you until then.
```

### extension-granted-no-clock

```
You've got 10 more minutes. Your doors will keep opening for you until then.
```

### extension-unavailable

```
Sorry, I can't add more time to this tour. It still ends at {end}. If you'd like another look, the {team} can set that up for you.
```

### extension-unavailable-no-clock

```
Sorry, I can't add more time to this tour. If you'd like another look, the {team} can set that up for you.
```

### extension-used

```
You've already used your extra 10 minutes{still?}.
```

### extension-after-end

```
Your tour time has ended, so I can't add more time now. Please head out the way you came in and text DONE once you're outside.
```

### tour-ended-named

```
Your tour of {place} just ended{name?}. I can't open any more doors for this tour, so please head out the way you came in and text DONE once you're outside.
```

### door-after-end

```
Your tour time has ended, so I can't open that door. Please head out the way you came in and text DONE once you're outside.
```

### late-arrival

```
Your tour time has ended, so I can't open doors anymore. Want me to find you another time?
```

### plus5

```
Just checking in. Have you left {place}? Text DONE once you're outside.
```

### plus15-phone

```
Your tour of {place} is now closed. If you're still inside or need a hand, call {phone}.
```

### plus15

```
Your tour of {place} is now closed. If you're still inside or need a hand, reply here and I'll get someone to help.
```

### after-close-phone

```
Thanks, I've let the {team} know. If you're still inside or need a hand right away, call {phone}.
```

### after-close

```
Thanks, I've let the {team} know, and someone will reach out soon.
```

### tour-finished

```
Thanks for touring {place}{name?}!{recap?} The doors are locked again behind you.
Would you like someone from the {team} to follow up?
```

## Channel prompts

These are appended by the channel. They are not a second visitor message.

### prompt-yes-no

```
Reply YES or NO.
```

### prompt-say

DONE is sent with no quotes: Text DONE when you're finished. Other phrases stay quoted, as in Text "I'm here" when you arrive.

```
Text {phrase} {purpose}.
```

### prompt-choose

Explicit id only. Not matched automatically.

```
{menu}
```

### prompt-form-link

Explicit id only. Not matched automatically.

```
{link}
```

### prompt-form-pending

```
The {team} will send you the form link shortly.
```

### prompt-web-choose

```
Pick {what} below.
```

### prompt-web-form

```
The form is just below.
```
