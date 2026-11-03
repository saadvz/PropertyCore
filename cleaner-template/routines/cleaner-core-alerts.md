# Routine: Cleaner Core Alerts

Wakes the cleaning Grok Bot the moment something happens on a turnover, for
example the cleaner texts YES, a question, or DONE, so the host hears about it
without asking. This is the cleaning bot's routine, not Tour Core's.

## Trigger

Authenticated webhook (POST). Grok creates the routine and gets a webhook
address and a sender (bearer) key. Those two values are installation secrets:

- They don't travel with this template. Each installation creates its own.
- Only the host can see them, in the routine panel. Right after creating the
  routine, without waiting to be asked, Grok sends the host a link that opens
  the Webhook URL field directly and one that opens the Webhook key field
  directly, with one secure card for each, the address first. The host opens
  each link, copies the value, and pastes it in its card. Grok never links the
  Routines page or tells the host to open Routines and pick the routine:
  opening the routine from there doesn't show its Webhook URL.
- Grok sends them to Cleaner Core through a one-time upload link, from Grok's
  own cloud computer. They are never in chat, in a tool argument, or in a file
  in this repository. Rotate the key first if it was ever shown anywhere else.
- Cleaner Core keeps them in its secret store and never returns them to Grok.
  Its reply never repeats them.

## What Cleaner Core sends

Minimal JSON. No message text, no phone numbers, no door code, and no
credentials:

```json
{
  "schemaVersion": 1,
  "eventId": "evt_...",
  "eventType": "cleaning.update",
  "occurredAt": "2026-10-15T13:05:00.000Z"
}
```

`eventType` is `cleaning.update` when something new is waiting for the host, or
`installation.test` for the test sent when the routine is saved. The payload
never holds message text. The words come from `check_now`.

Every new message from the cleaner or a saved contact wakes the routine. Cleaner
Core keeps at most one wake-up waiting. If several things happen before the
routine runs, it wakes once, and `check_now` returns all of them.

## Instructions for the routine

1. If `eventType` is `installation.test`, post:
   "Cleaner Core alerts are connected." and stop.
2. Otherwise call `check_now` without `googleEvents`. A webhook can't read the
   host's Google Calendar. The Cleaner Core Check routine does that.
3. Post each line in `alerts` in your own short words. Post nothing when
   `alerts` is empty. A new booking asks the host to confirm the usual times.
   "Have the guests left?" asks the host about the checkout. Only the host's
   yes in chat sends the door code, with `mark_guests_left`. When an alert
   says a cleaning offer or reminder may not have gone out, ask the host
   whether to send it again. Only the host's yes in chat resends it, with
   `retry_send`.
4. Read every item in `messages`. Tell the host in your own words when one
   needs them: running late, a question, a problem, supplies, an arrival time,
   a decline, STOP, or an injury. Stay quiet on routine replies.
   When a message sounds like a problem that could stop the cleaning, tell
   the host right away, quote it, and ask whether to pause the cleaning.
   Cleaner Core never pauses on its own. Only the host's yes in chat pauses
   it, with `hold_job`.
5. When a message gives an arrival time, call `save_arrival` with it as 24-hour
   HH:MM, like 11:30.
6. If a message needs a reply, draft one and offer it to the host. Don't send
   it from the routine. It goes out with `send_message` only after the host's
   yes in chat.
7. If the reply has `completed`, call `get_job_photos`, look at the photos, and
   compare them with the checklist. Summarize the cleaning in your own words.
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
8. If the reply has `needsTimes`, ask the host for the checkout time and the
   next check-in time, then call `confirm_times` with each as 24-hour HH:MM.
9. Never show a door code, an id, or the webhook payload.

## Connecting it

After the preferences and the Payments step, and before the review, `get_state` asks for the two
routines. Then:

1. Grok creates this routine with an authenticated webhook trigger and the
   instructions above.
2. Grok calls `save_alert_routine` with no arguments to get a one-time upload
   link (`uploadUrl`). It works once and expires after 10 minutes.
3. From your own cloud computer, POST JSON
   `{"url": "<webhook address>", "token": "<webhook key>"}` to `uploadUrl` with
   `Content-Type: application/json`, using the values you already hold. The
   values are never in chat or a tool argument. A 400 reply means a value was
   wrong, and the link still works. A 404 means ask for a new link.
4. Call `get_state` to confirm. Cleaner Core sends one `installation.test`.
   Grok posts "Cleaner Core alerts are connected." and `get_state` moves on to
   the review.

If a value was pasted in chat anyway, Grok doesn't repeat it and asks the host
to rotate the key.

## Allowed tools

`check_now`, `confirm_times`, `get_state`, `save_arrival`, and
`get_job_photos`.
