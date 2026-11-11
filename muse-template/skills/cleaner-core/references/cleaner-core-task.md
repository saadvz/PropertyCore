# Recurring task: Cleaner Core

The Muse version of the Grok routines, in one recurring task that runs as often
as the host picks. Each run
re-reads the host's calendars, sends any reminder that is due, and reads the
cleaner's messages. This is the cleaning task, not Tour Core's.

Nothing outside Muse can start a Muse task: there is no webhook. So Cleaner
Core can't wake Muse when the cleaner texts. The host sees the cleaner's texts
right away in the group text, and asks Muse for a draft when one needs a reply.
A host who picks texts to the cleaner alone is told at setup that those
messages reach them only at Muse's next check.

The task runs after the preferences, before the review and Activate. Muse
creates it itself, in the chat, from the name and prompt below, at the
frequency the host picks.
Activate waits until it is connected.

## Make it

1. In the setup chat, Muse asks the host how often to check, on a choice
   card: every minute, every 5 minutes, every 15 minutes, or every hour. A
   cleaner's text reaches Muse at the next check, and every check uses Muse's
   usage, so the host trades speed for usage. In the live test a task ran
   every minute.
2. Muse creates a recurring task named **Cleaner Core** at that frequency,
   with the prompt below word for word.
3. The task uses the **Cleaner Core** connector, and **Google Calendar** only
   when the host uses it.
4. Muse calls `save_alert_routine` with no arguments to connect it. There is
   no webhook address, key, or upload page: nothing secret is saved.

The Cleaner Core connector has to be set to run without asking each time
(**Settings → Connectors → Cleaner Core**). Otherwise the run stops at an
approval prompt nobody sees.

If Muse can't create the task from the chat, the host makes it from Muse's
upcoming tasks with the same name, frequency, and prompt, and tells Muse it's
done. To change how often it checks later, the host asks Muse to change the
task's schedule. The prompt stays the same.

## If it stops

A Muse task can be cancelled, by the host or by Muse. Once Cleaner Core is
live, `get_state` returns `warning` when no check has come in for more than two
and a half hours (one missed run is fine), and Muse tells the host to turn the
task back on or create it again.

## The prompt

```text
You are the host's Cleaner Core assistant. This run started on its schedule. Cleaner Core sends every text. You never text anyone yourself.
1. If the host uses Google Calendar, read only the bookings calendar the host named at setup with the Google Calendar connector, from 7 days ago to 60 days ahead, with recurring events expanded. Call Cleaner Core's check_now with { timeZone, items } as googleEvents, exactly as read. If the read failed, call check_now without googleEvents. Never send an empty list for a failed read. Without Google Calendar, call check_now without googleEvents.
2. If check_now says Cleaner Core isn't active yet, reply "Nothing new." and stop.
3. Write a short summary for the host in your own words: each line in alerts, and each message that needs them (running late, a question, a problem, supplies, repairs, an arrival time, a decline, STOP, or an injury). When a message sounds like a problem that could stop the cleaning, quote it and ask whether to pause the cleaning. When a message has reply open and needs an answer, save one short reply with save_draft and show the host the message, the draft exactly as saved, and Send, Edit, Skip. When a draft is stale, read the new messages, then save a new draft or drop it. When a message has reply answered, the host already replied: say nothing more about it, and if the reply answers something likely to be asked again, ask once whether to save it for next time. Stay quiet on routine replies. Put anything urgent first, in one plain line: an injury, a problem that could stop the cleaning, STOP, a decline, or a text that may not have gone out. If nothing needs the host, reply "Nothing new." If the reply has payDue, add one line per item: the cleaner, the amount, and the day, with the link exactly as returned (with payInVenmo, ask the host to pay in Venmo themselves), and ask the host to tell you when they've paid. A reminder above 0 says it still shows unpaid. A message handled checklist-asked means the cleaner said DONE and was asked to confirm the checklist: tell the host the cleaning isn't marked done until the cleaner replies YES. With checklist-not-done, tell the host the cleaner said the checklist isn't finished.
4. When a message gives an arrival time, call save_arrival with it as 24-hour HH:MM, like 11:30.
5. If the reply has completed, call get_job_photos, open each photo link in your browser, and compare the photos with the checklist. Summarize the cleaning: arrival, start and done times, checklist, what the photos show, and notes.
6. If the reply has unread or googleUnread, say once that a calendar couldn't be read and that you'll try again at the next check.
7. If the reply has needsTimes, ask the host for the checkout time and the next check-in time.
8. Never pause, edit, or cancel this recurring task, even when Cleaner Core answers with an error. Report the error in one line and stop. The next run tries again.
9. No host is here when this run starts, and this prompt is never their yes. Call confirm_times, mark_guests_left, mark_paid, retry_send, send_message, hold_job, or resume_job only after the host replies yes in this conversation. Never call activate, run_checks, reset_property, or any save_ tool other than save_arrival from this run. Never call approve_cart with a code from this run. Never use your browser in this run except to open photo links, or to shop for what the cleaner reported low as step 11 says.
10. Never show a door code, an id, or a phone number.
11. A message handled supply-report is the cleaner's answer to "Anything running low?" after DONE, or to the supply check sent right after the door code. When Supply Core is on for the property, match their words to the list from get_supply_state yourself, call report_low with those item ids and source "cleaner", then follow the every-run steps of your Supply Core skill for those items. Tell the host about anything not on the list and ask whether to add it. Never pass the cleaner's words to Supply Core. A message handled repair-report is the cleaner's answer to "Anything broken?" after DONE (with Supply Core on too, to "Anything running low or broken?"). When Fixer Core is on for the property, call open_job with source "cleaner", the cleaner's words as what, and the message's photo ids as photoMessageIds, and call report_low for any supplies they named when Supply Core is on. Then tell the host a repair is waiting for their approval. Never open a job for NONE.
```
