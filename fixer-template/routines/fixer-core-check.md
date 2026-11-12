# Routine: Fixer Core Check

Wakes the Fixer Core bot on a schedule. It finds the repairs and upkeep that
need a move, follows up on pros who haven't answered, and asks the host about
anything held or new. It carries no webhook address, no key, and no secret.

## Trigger

Scheduled, every hour (the host can pick another). A contact with no outcome
turns unconfirmed after 2 hours, and a waiting pro is followed up after 24
hours, so an hourly run keeps jobs moving without waking anyone at night.

## Instructions for the routine

1. Call `get_state`. When it lists more than one property, run steps 2 to 9
   once for each property whose flows have fixer on, and name that property in
   every Fixer Core call. If none has Fixer Core on, post nothing and stop.
2. Call `check_fixes`. If Google Calendar is saved for the property, by Fixer
   Core, Cleaner Core or Supply Core, read only the calendar the host named
   and pass its events as `googleEvents`. If it says Fixer Core isn't active,
   reply "Nothing new." and stop. For each `upkeepDue` item, call `open_job` with its trade and `what`, urgency `by-date` with its `nextDate` as `byDate`, source `upkeep`, and its `upkeepId` as `sourceRef`. It waits for the host's go: post the question it gives.
3. For each `unconfirmed` contact, find out what happened (look in your own
   call, email or message history first), then `record_contact` with the
   outcome.
4. For each `followUps` entry, contact the pro again, or the next pro it names.
   Call `contact_pro` before every call, email, text, form or message, and
   contact only a pro it gives a token for.
5. For `contactNext`, call `contact_pro` for the pro it names and reach them.
   Then `record_contact` with what they said. A booked time that overlaps a
   guest stay gives no question: tell the host, and ask the pro for another
   time.
6. For `needsGo`, `quotesReady`, `held`, `preferredAsk`, `rotationAsk`, and a booking
   question, post the question for the host as given. Call `approve_job`,
   `approve_booking`, `pick_pros`, `pick_quote`, `save_pro`, `skip_question` or
   `change_door_code` without a code or confirmation, never with one.
7. For `delays` and `news`, tell the host once, in your own words.
8. Never confirm a held time to the pro. Never send a visit link from a run:
   the host's yes comes in chat.
9. Never type, paste, or pass a card number to Fixer Core, and never pay a pro.
   Post nothing when there is nothing to do, ask, or tell.
