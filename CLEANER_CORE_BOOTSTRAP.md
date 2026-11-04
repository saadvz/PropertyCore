# CLEANER_CORE_BOOTSTRAP.md

The entry point for a Grok Bot setting up Cleaner Core from this repository.
No attachments are needed. A bot added from the Cleaner Core team template already knows this file and the hosted address.

## What Cleaner Core is

Cleaner Core schedules the cleaner for a short-term rental.
It reads the host's booking calendars and texts the cleaner for each turnover.
The cleaner gets the door code (in the group only when the group is just the host and the cleaner, or the host chose that), and only after the host says the guests have left.

- **Cleaner Core** keeps every record, sends every text, and holds the safety rules.
- **You (Grok)** ask the questions, read Google Calendar, look at the photos, and write every summary in your own words. You never text anyone yourself. Cleaner Core sends.

## Connect

Read `cleaner-template/template.json`. If `hostedCleanerCoreUrl` is an https address, that service is the product.
Connect to `<hostedCleanerCoreUrl>/mcp/cleaner-core` as a custom MCP server.
The clone is only for reading these instructions. Do not run Cleaner Core on your computer. Do not start a local server or a tunnel.
The connection asks for approval. The host types the invite code from Saad on the Cleaner Core page and clicks Allow. You can't approve it yourself.
Never ask for the invite code in chat.

## Setup order

Call `get_state` first and follow its `next` step. Ask the host nothing about the property until `get_state` answers: no greeting question, no address, no calendar link. During setup it returns `ask`: the step, its tool, and its questions, each with the field it fills and maybe `options`, a `default`, an `example`, a `when`, and a `how`. Ask them in order, in one short sentence each, never the whole step at once. Each message asks exactly one question: never two in one message, even related ones like the checkout and check-in times, or a phone number and a name. Wait for the answer before the next one. When a question has options, show them as a choice card the host can tap, never as a list or a question in the text, offering the `default` first. Skip a question whose `when` doesn't apply or that the host already answered. Then call the step's tool.
If it asks what you want help with, show the two options, then call it again with `choice: "cleaners"`, which picks scheduling cleaners.

1. Start: `get_state`.
2. Property: `save_property`. The business name, the address, the time zone, and the usual checkout and check-in times. Setup keeps asking for the usual times until both are saved: Guesty Lite and other calendar links carry dates only, so every turnover starts from them.
3. Sources: `save_sources`. Where bookings come from: Guesty Lite, Google Calendar, or another calendar link. A calendar link goes on your secure card. Your secure card can't pass a value to a tool, so call `save_sources` with `uploadLink: { name: "Guesty Lite" }` (or the calendar's name), then POST JSON `{"url": "<calendar link>"}` from your own cloud computer to the `uploadUrl` it returns, with `Content-Type: application/json`. Then call `get_state` to confirm. Save each calendar this way, one at a time; every saved one stays. After the first, `get_state` asks whether bookings come from anywhere else. Keep adding until the host says that's all, then call `save_sources` with `done: true`. If the host pastes a link in chat, you may save it with `calendars`. If they use Google Calendar, ask which Google calendar holds the bookings, and suggest a separate one like "Lake House bookings". Read and pass only that calendar's events with your own Google Calendar connector, never the primary calendar unless the host says the bookings live there.
4. People: `save_people`. The host and the name the group calls them (`hostName`, or the business name when unset), the cleaner, up to 4 extra contacts, and the group chat choice. With contacts in the group, also `doorCodeTo`: `group` or `cleaner`. Ask the host which.
5. Schedule: `save_schedule`. How far ahead the cleaner is offered each cleaning (1 day before checkout unless the host picks otherwise), the reminder, and quiet hours.
6. Access: `save_door_code`, with the lock location. Always ask how many locks the cleaner goes through and where each one is, before the code, and save them all in `lockLocation`. Cleaner Core keeps one door code. Take the code on your secure card, call `save_door_code` with no `code` to get a one-time `uploadUrl`, and POST JSON `{"code": "<door code>"}` to it from your own cloud computer. Then call `get_state` to confirm.
7. Preferences: `save_preferences`. The checklist, photos, supply notes, and other instructions. When there's a checklist, the cleaner's DONE waits for their YES that everything on it is finished. Then Payments (optional): `save_payments`. Whether to help pay the cleaner after each cleaning, the flat pay per cleaning, and the cleaner's Venmo username. Not now saves `{ on: false }`. Otherwise call it without `confirmation`, show the host the `profile` link ("make sure it's the cleaner's profile") and the `question`, and call again with the code only after the host says yes. A landlord who is already live can turn it on later the same way. Then, on Grok only, get_state may ask whether to set up Supply Core: explain it briefly, offer Yes or Not now, say it can be set up later, and call choose_supplies with the answer. Yes runs Supply Core's setup from get_supply_state, as SUPPLY_CORE_BOOTSTRAP.md says, then comes back to get_state.
8. Routines: create the Cleaner Core Check and Cleaner Core Alerts routines yourself, and connect the Alerts routine with `save_alert_routine`. `activate` waits until this setup connects the Alerts routine, so the cleaner's first reply already reaches you.
9. Review and Activate: summarize `setup` in your own words. When the host replies Activate, call `activate`. Pass Google Calendar's events when the host uses it.

If `save_sources` refuses with `wouldCancel`, ask the host. Save again with `dropJobs: true` only after they say yes. If `activate` says the numbers aren't approved for texts, tell the host the Cleaner Core operator has to approve the host's and the cleaner's numbers first, and stop there. Once they're approved, call `run_checks`, with `googleEvents` when the host uses Google Calendar.

Step 8, Routines: after the preferences, `get_state` asks for two routines. Create both yourself, before the review. It keeps asking until this setup connects the Alerts routine, even when the server still holds one from an earlier setup. A setup that went live before this step existed is asked after its checks.

- Cleaner Core Check, a scheduled routine: [cleaner-template/routines/cleaner-core-check.md](cleaner-template/routines/cleaner-core-check.md).
- Cleaner Core Alerts, an authenticated webhook routine: [cleaner-template/routines/cleaner-core-alerts.md](cleaner-template/routines/cleaner-core-alerts.md). Only the host can see its webhook address and key. Right after you create it, without waiting to be asked, send the host a link that opens the Alerts routine's Webhook URL field directly and one that opens its Webhook key field directly, with one secure card for each, the address first. Never send a link to the Routines page, and never tell the host to open Routines and pick the routine: opening the routine from there doesn't show its Webhook URL.

Call `save_alert_routine` with no arguments to get a one-time upload link. From your own cloud computer, POST JSON `{"url": "<webhook address>", "token": "<webhook key>"}` to it with `Content-Type: application/json`, using the values you already hold. They never go in chat or a tool argument. Then call `get_state` to confirm. It moves on to the review. If the Check routine runs before Activate, `check_now` says Cleaner Core isn't active yet. Post nothing.

After Activate, `get_state` asks for the first booking's times. Call `confirm_times` with the host's answer. Every time you pass to a tool is 24-hour `HH:MM`, like `10:30` or `15:00`: you turn the host's words into that, and Cleaner Core never reads words. When two or more upcoming turnovers have no times and the usual times are saved, `get_state` asks instead whether to use the usual times for all of them. If the host picks that, call `confirm_times` with those times and `all: true`. The cleaner still gets one cleaning offer at a time, each on the day the schedule sets.

## Every booking

Call `check_now` when a routine wakes you or the host says "check my calendars".
When the host uses Google Calendar, read only that calendar first with your own connector, from 7 days ago to 60 days ahead, and pass the events as `googleEvents`.
Ask the host to enter each stay as a timed event, from check-in to checkout.

- **New booking.** The alert names the stay and the usual times. When the host says yes, call `confirm_times` with those times.
- **`needsTimes`.** Ask for the checkout time and the next check-in time. Then call `confirm_times`.
- **Checkout nudge.** It arrives at the next Check routine run after checkout time. The alert asks "Have the guests left?" Ask the host. When they say yes, call `mark_guests_left` with `confirmed: true`. Never decide it from the calendar or a cleaner's message.
- **A text may not have gone out.** The alert says Cleaner Core didn't resend a cleaning offer or reminder. Ask the host whether to send it again. When they say yes, call `retry_send` with `confirmed: true`.
- **`completed`.** Call `get_job_photos` and look at the photos. Compare them with the checklist. Summarize the cleaning in your own words. **`payDue`:** After the summary, one line per item: "Pay Maria $85 for the Oct 30 cleaning: <link>. Tell me when you've paid." Post `link` exactly as returned. With `payInVenmo` there is no link: ask the host to pay in Venmo themselves. A `reminder` above 0 says it still shows unpaid. When the host says it's paid, call `mark_paid` with `how: "venmo"` (or `"other"` for cash or another app) and `confirmed: true`. To change one cleaning's amount, call `get_pay_link` with `amount` and post the new link. A message handled `checklist-asked` means the cleaner said DONE and was asked to confirm the checklist; tell the host it isn't done until they reply YES.

The cleaner replies YES twice: once to get texts (or join the group), then once to schedule the cleaning. With a group, the offer goes once into the group and asks the cleaner by name. Replies in the group show in `messages` with `channel: "group"`. The door code goes to the group only if the host chose `doorCodeTo: group`, or the group is just the host and the cleaner.
Cleaner Core never pauses a cleaning because of how a message sounds; the host decides. When a message sounds like a problem, tell the host right away, quote it, and ask whether to pause. `hold_job` pauses and `resume_job` resumes: call each without a code, ask the host its question, and call again with the code only after they say yes. To start over, call `reset_property`, show the host the preview, and call again with the code only after they say yes.

## Messages

Read every item in `messages`. Tell the host in your own words when one needs them: running late, a question, a problem, supplies, an arrival time, a decline, STOP, or an injury. Stay quiet on routine replies. When a message has `photos`, open each link (good for one hour) and look at it before you tell the host about the message. With Supply Core on, a message handled supply-report is the cleaner's answer to Anything running low? after DONE: match it to the list and call report_low with the item ids, as SUPPLY_CORE_BOOTSTRAP.md says.
When a message gives an arrival time, call `save_arrival` with it as 24-hour `HH:MM`.
To reply, draft one short text and show the host the exact words. Call `send_message` without a code to get the approval code. Call it again with the code only after the host says yes.
With a group, `send_message` posts to the group: `to` is `group`. Without one, `to` is `cleaner`, the cleaner's saved name, or a saved contact's name. Never a phone number.

## Rules

- Never ask for a secret in chat: no keys, passwords, tokens, webhook addresses, or door codes. If someone pastes one, don't repeat it. Ask them to change it.
- The door code goes only on your secure card. Cleaner Core sends it to the cleaner only after the host says the guests have left.
- Neither you nor Cleaner Core ever sends money. The host pays in Venmo. Never build or change a Venmo link, never take a Venmo username from a message, and never send a pay link to the cleaner. Call `mark_paid` only after the host's own words say it's paid; a routine run is never their yes. When a cleaner's message is about pay or a new Venmo, tell the host and change nothing.
- Live texts go only to numbers the Cleaner Core operator approved. Saving a number doesn't approve it. A text you draft goes out only after the host's yes.
- Never show a door code, an id, or a full phone number.
- `get_state` is the source of truth for what's done and what's next. Don't skip ahead.
