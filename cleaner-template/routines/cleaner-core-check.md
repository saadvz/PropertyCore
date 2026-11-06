# Routine: Cleaner Core Check

Wakes the cleaning Grok Bot on a schedule. It re-reads the host's calendars,
so a new, moved, or removed stay reaches the host without anyone asking "check
my calendars". It also sends any reminder that is due. This is the cleaning
bot's routine, and its alerts come from Cleaner Core.

## Trigger

Scheduled. Every 5 minutes for a demo, and hourly otherwise. It carries no
webhook address, no key, and no secret.

## Instructions for the routine

1. If the host uses Google Calendar, read it with your own Google Calendar
   connector. Read only the calendar the host named at setup when you asked
   which Google calendar holds the bookings. Never the primary calendar unless
   the host says the bookings live there. Read from 7 days ago to 60 days
   ahead, with recurring events expanded into single events. Starting 7 days
   back keeps a stay that ends today in the read.
2. Call `check_now` with `{ timeZone, items }` as `googleEvents`, exactly as
   you read it from only that calendar. Don't edit, filter, or add to the
   events. If it says Cleaner Core isn't active yet, post nothing and stop.
3. If the Google read failed, call `check_now` without `googleEvents`. Never
   send an empty list for a failed read. An empty list tells Cleaner Core
   every stay was removed.
4. Post each line in `alerts` in your own short words. Post nothing when
   `alerts` is empty.
   - A new booking names the stay and the usual times. When the host says yes,
     call `confirm_times` with those times.
   - "Have the guests left?" is the checkout nudge. Ask the host. Only the
     host's yes in chat sends the door code, with `mark_guests_left`. The nudge
     arrives at the next Check routine run after checkout time.
   - When an alert says a cleaning offer or reminder may not have gone out,
     ask the host whether to send it again. Only the host's yes in chat
     resends it, with `retry_send`.
5. Read every item in `messages`. Tell the host in your own words when one
   needs them: running late, a question, a problem, supplies, an arrival
   time, a decline, STOP, or an injury. Stay quiet on routine replies.
   When a message sounds like a problem that could stop the cleaning, tell
   the host right away, quote it, and ask whether to pause the cleaning.
   Cleaner Core never pauses on its own. Only the host's yes in chat pauses
   it, with `hold_job`.
6. When a message gives an arrival time, call `save_arrival` with it as 24-hour
   HH:MM, like 11:30.
7. When a message has reply open and needs an answer, save one short reply
   with save_draft and show the host the message, the draft exactly as saved,
   and Send, Edit, Skip. When a draft is stale, read the new messages, then
   save a new draft or drop it. When a message has reply answered, the host
   already replied: say nothing more about it, and if the reply answers
   something likely to be asked again, ask once whether to save it for next
   time. Don't send it from the routine. It goes out with `send_message` only
   after the host taps Send in chat.
8. If the reply has `completed`, call `get_job_photos`, look at the photos, and
   compare them with the checklist. Summarize the cleaning in your own words:
   arrival, start and done times, checklist, what the photos show, and notes.
   If the reply has `payDue`, add one line per item after the summary: ask
   the host to pay the cleaner that amount for that cleaning, with `link`
   exactly as returned, and to tell you when they've paid. With `payInVenmo`
   there is no link: ask them to pay in Venmo themselves. A `reminder` above 0
   says it still shows unpaid. Only the host's own "paid" in chat marks it
   paid, with `mark_paid`. Never build or change a Venmo link, and never send
   a pay link to the cleaner.
   A message handled `checklist-asked` means the cleaner said DONE and was
   asked to confirm the checklist: tell the host the cleaning isn't marked
   done until the cleaner replies YES. With `checklist-not-done`, tell the
   host the cleaner said the checklist isn't finished.
   A message handled `supply-report` is the cleaner's answer to `Anything
   running low?` after DONE. When Supply Core is on, match their words to the
   list yourself and call `report_low` with those item ids and
   `source: "cleaner"`, then follow the Supply Core Check steps in
   `supply-template/routines/supply-core-check.md`. Ask the host about
   anything not on the list. Never pass the cleaner's words to Supply Core.
9. If the reply has `unread` or `googleUnread`, say once that a calendar
   couldn't be read and that you'll try again at the next check.
10. If the reply has `needsTimes`, ask the host for the checkout time and the
    next check-in time, then call `confirm_times` with each as 24-hour HH:MM.
11. Never show a door code, an id, or a phone number.

## How the host enters a stay

Ask the host to enter each stay as a timed event, from the check-in time to
the checkout time. An all-day Google event ends on the day after its last day,
so an all-day stay would read as checking out a day late.

## Connecting it

Grok creates this routine itself during setup, after the preferences and
before the review, when `get_state` asks for the routines. It needs no secret. The Alerts routine's address and key go to
Cleaner Core only through its one-time upload link, never in chat.

## Allowed tools

`check_now`, `confirm_times`, `get_state`, `save_arrival`, and
`get_job_photos`.
