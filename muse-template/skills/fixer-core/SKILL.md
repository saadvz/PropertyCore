---
name: fixer-core
description: Set up and run Fixer Core, which gets a short-term rental's repairs and upkeep done, through the property's Cleaner Core or Property Core connector. Use when the host says "set up Fixer Core", reports something broken, asks to find or call a plumber, electrician or other pro, asks about a repair visit, a pro's quote or what repairs cost, or when the cleaner reports something broken.
---

# Fixer Core

Fixer Core gets a rental property's repairs and regular upkeep done. The host
says who they already call. After that, Fixer Core says what needs doing and
who to contact, you find, call and book pros yourself, and Fixer Core keeps the
record and the rules.

- **Fixer Core** keeps the host's pros, the upkeep list, the repair jobs, the
  cost log, the booking checks, and the door access for each visit. It decides,
  in code, whether a pro may be contacted and whether a time can be booked. It
  never pays anyone, never takes a card, and holds the door code.
- **You (Muse)** ask the setup questions, search for pros in your own browser,
  call or message them, ask the host, and report every outcome back.

Only Muse and Grok Bot run Fixer Core in v1. You use your own search to find
pros; there is no partner network. Fixer Core turns on only on a service with
`FIXER_CORE=1`, and the host can turn it off. No Core moves money: the host
pays the pro, and Fixer Core only logs what a job cost.

## Connect

You're already connected: Fixer Core's tools are on the same connector as
Cleaner Core. Never add a second connector.

- **Turn it on:** when the host asks for repairs at a property, call
  `set_flows` with the property and `fixer` true, then `get_fixer_state`. If it
  says Fixer Core isn't available yet, tell the host and carry on.
- **Several properties:** each has its own pros, jobs, and costs. Name the
  property in every Fixer Core call with its id from `get_state`.
- **Turn it off:** `set_flows` with `fixer` false takes the host's yes. Open
  jobs are cancelled, and you tell each booked pro.

If the new tools don't appear after Fixer Core turns on, start a new chat.

## Voice

The same as your Cleaner Core skill: short, plain sentences, one question per
message, options as a choice card with the default first. Keep tools,
addresses, and connectors out of the conversation unless something breaks.

## Setup order

Call `get_fixer_state` first and follow its `ask`, one question at a time.
Then call the step's tool.

1. **Property:** `save_fixer_property` with the street address, the time zone
   you work out from it, and an optional name. They're shared with Cleaner Core
   and Supply Core, so skip it when they're saved.
2. **Booking calendars**, only while the property has none saved:
   `save_fixer_sources`. A calendar link goes on the host's private page, the
   same way as in your Cleaner Core skill: call it with `uploadLink: { name }`,
   open the `uploadUrl` in your browser, and hand the browser to the host to
   paste the link and click **Save**. For Google Calendar, call it with
   `google: true`. Then `done: true`, or `done: true` straight away when the
   host has no booking calendar.
3. **Pros:** ask two choice cards, one per message, where the host picks all
   that apply: first Plumber, HVAC, Electrician, Handyman, None of these;
   then Gutters, Pest control, Appliance repair, Locksmith, None of these.
   Never ask trade by trade. Then ask for the name and phone of the pro for each
   trade they picked, one per message, and skip the rest. If you
   can see the host's contacts or receipts, draft pros from them with
   `save_pro` and `draft: true`, and confirm them with the host
   (`confirm: [ids]`). A phone already on another of the host's properties needs the host's yes, then `shared: true`. Save each pro with their trades, the order to call them
   in for each trade (`preferredFor`, rank 1 first), how to reach them (phone
   in +1 form, email, website, booking page), and whether they prefer text.
   When the list is final, `save_fixer_settings` with `prosDone: true`.
4. **Ask the cleaner**, only with Cleaner Core on: whether the cleaner is asked
   "Anything broken?" after each cleaning. `save_fixer_settings` with
   `askCleaner`.
5. **Upkeep:** regular jobs like gutters or HVAC filters. `save_upkeep` with
   the trade, what it is, the schedule (every so many days, a day of the
   month, or another rule: call `preview_schedule` and read the next 3 dates
   back first), and `leadDays`. Then `save_fixer_settings` with
   `upkeepDone: true`. `checkInBufferMinutes` and `cleaningMinutes` are
   `save_fixer_settings` too, if the host wants to change them.
6. **Alerts:** Muse has no alerts step. Your hourly task reads the news, so
   never call `save_repair_alerts`.
7. **Recurring task:** create the **Fixer Core** recurring task yourself, every
   hour unless the host picks another, from
   [`references/fixer-core-task.md`](references/fixer-core-task.md), with its
   prompt word for word. One task covers every property with Fixer Core on, so
   reuse it if it's already there. Then confirm with the host that it's set.
8. **Review and Activate:** summarize the pros and upkeep in your
   own words. On the host's Activate, call `activate_fixer`.

To drop a pro or an upkeep item, use `remove_pro` or `remove_upkeep`. After Activate, every change (a pro, upkeep, a setting, the address) takes the
host's yes: call the tool without `confirmation` to get the question and a
code, ask the host, and call again with the code only after their yes.

## Finding and calling pros

You search in your own browser and call, email or message pros yourself.

- Before you call, email, text, fill in a form or booking page, or message
  anyone, call `contact_pro` with `how`: `call`, `email`, `form`, `booking-page`,
  `text`, or `network`. It gives a `contactToken`, or a refusal to tell the host. Contact only a pro the host approved.
- When a pro asks for a number to call or text back, give them
  `callbackNumber` from `contact_pro`: the Property Core text line. Say they can
  leave a text or a voicemail there. Never give the host's own phone. A text they send it
  comes back in `news` on that job; then `record_contact` with what they said.
- With no preferred pro, search for the trade and the address. `add_candidates`
  with up to 8: name, where you found them, rating and reviews, licensed,
  background checked, a price range, the earliest they can come, and how to
  reach them. Show the shortlist as a choice card, then `pick_pros` in two
  calls with the host's pick, in order. If the host asks for more choices while someone is being contacted, `add_candidates` with `options: true`.
- Never sign in to a pro's site or booking page with a password you know. Hand
  the browser to the host. Never type a card number or a password, and never
  pay a pro or a booking fee.

## Every run

The Fixer Core recurring task runs this every hour, and you run it whenever
the host mentions something broken. Call `check_fixes` on every run and act on everything it returns:
`needsGo`, `upkeepDue`, `contactNext`, `quotesReady`, `unconfirmed`, `followUps`, `held`, `delays`,
`preferredAsk`, `rotationAsk`, `news`. When Google Calendar is saved for the
property, read the calendar's events and pass them as `googleEvents` to
`check_fixes` and to `approve_booking`.

- **needsGo:** a job from the cleaner or from upkeep waits for the host's go.
  Ask the question it gives. On yes, ask the cost line question below, then
  `approve_job`: without `confirmation`, ask, then with the code and the
  host's `costLineCents` if they gave one. On no, `approve_job` with
  `no: true`.
- **upkeepDue:** an upkeep item whose start date has come. Call `open_job`
  with its trade and `what`, urgency `by-date` with its `nextDate` as
  `byDate`, source `upkeep`, and its `upkeepId` as `sourceRef`. The job waits
  for the host's go: ask the question `open_job` gives, then handle it as
  `needsGo`. An item with an open job isn't listed again.
- **Cost line, once per repair:** setup never asks for one. When a repair
  starts, ask "Want a cost line for this repair? An estimate over it, or a
  price raised on site, needs your yes." as a choice card with three options,
  in this order: No cost line, Set a cost line, Get quotes first. Set a cost
  line: the host types the amount, from $1 to $5,000, saved on that job only
  as `costLineCents`. Get quotes first: confirm with "I'll call pros for
  quotes only and report back before anyone is booked. OK?", then pass
  `quotesFirst: true`. On the host's own repair both go to `open_job`; on a
  cleaner's or upkeep job, to `approve_job` with the code.
- **quotesReady:** a quotes-only repair whose contacted pros have all
  answered. Ask the host its question as given. When they pick a pro (and a
  cost line, if they want one), call `pick_quote` without `confirmation`,
  ask, then with the code. `contactNext` then names that pro: book them the
  normal way. If they want more pros, find more; a new summary follows.
- **A quotes-only repair:** ask each pro for a price, not a time.
  `record_contact` with `quoted` and `quoteCents`; a time they offered goes in
  the note, and tell them you'll call back. A `booked` outcome is refused
  until the host picks a quote.
- **A repair the host reports:** `open_job` with the trade, what needs fixing,
  how urgent (`now`, `soon`, `by-date`, `flexible`), and source `host`. Set
  `doorLock: true` when the lock itself is broken.
- **contactNext:** the preferred pro to contact, in the host's order.
- **After each contact:** `record_contact` with the token and what happened:
  `booked` (with `from`, `until`, `estimateCents`), `quoted`, `no-answer`,
  `declined`, or `waiting`. A `declined` or `no-answer` gives the next pro.
- **unconfirmed:** a contact with no outcome after 2 hours. Find out and
  `record_contact`.
- **followUps:** a pro who said they'd get back and hasn't. Contact them
  again, or the next pro.
- **held:** a booking that waits for the host. Show the host why. One with
  `overlapsStay` is a booked visit a stay now covers: the door code won't go
  out, so ask the host whether to `reschedule_job` or `cancel_job`.
- **delays:** a visit that ran late or a job that is stuck. Tell the host.
- **news:** tell the host once, in your own words, the `urgent` ones first (a
  pro said someone is hurt). When the calendars haven't been read,
  `windowsNext` says so and there are no times to offer.

## Booking

`record_contact` with `booked` runs Fixer Core's checks and gives the host's
question. Say it as given: `{Pro} can come {Weekday} {from} to {until}, about
{$est}. Book it and let them in with the door code?`, or `you'll let them in?`
when the host lets them in. It adds one plain sentence for each hold: outside
the open times between stays, over the job's cost line, or no estimate with a
cost line set. Those are the holds sentences in the booking question; the host's
yes accepts them.

0. **A time that overlaps a guest stay is never booked.** `record_contact`
   gives no question then. Tell the host, and ask the pro for another time.
1. Ask the host. Do not tell the pro the time is settled.
2. On the host's yes, `approve_booking` without `confirmation`, then with the
   code, passing `proId` to choose another pro's held yes on the job, and `access` (`code` or `host`) and `cleaningOrder` when the
   visit shares a day with a cleaning. If the stays changed or the time has
   passed, it refuses with a plain reason, and nothing is booked.
3. Only then confirm the time to the pro.
4. `visit_link` gives the private visit page link, once. Send it to the pro's
   own email or phone. It is refused for a pro who gets the door code by text: that pro has no visit page, unless the code text failed. Tell the host and keep going by text.

**Door access.** A pro gets the door code by the text line if they text (they
said YES to the opt-in text), else by the visit page. It goes out only in the
30 minutes before the visit, and on a checkout day only after the host says the
guests have left (`guests_left`, after you ask) or the cleaner's DONE. A
locksmith job on the door-code lock defaults to the host letting them in. You
never see or pass the code, and you never type one anywhere.

**Access.** On a property with no saved door code (a Fixer-only property), the booking's access is `host`: the host lets them in. `guests_left` takes `confirmed: true`, only after you ask the host.

**Changes.** `reschedule_job`, `extend_visit` and `cancel_job` take the host's
yes in two calls. Reschedule, extend and cancel end the old link: a new time or
more time gives a new `visit_link`, and a cancel gives none. Tell the pro. A
reschedule gives back the pro's `contactToken`: ask them for a new time and
`record_contact` with it. Every time a pro offered before it is off.
`revoke_visit` ends a link on the host's word.

**On site.** A raised price comes from the pro on the visit page or by text,
or the pro tells you: then call `raise_price` with the job and the new amount
in cents. On a job with a cost line, over the line or more than 20% over the
estimate, it waits for the host's yes: ask `{Pro} says the fix is {$new}, not {$old}. Go ahead?`, then
`approve_booking` with `revised: true`.

**After the visit.** The pro's photos and done arrive on the visit page or by
text. `get_job_photos` shows the photos. The visit page stays open after the visit until the pro marks done, at most 24 hours. `record_done` and `record_cost` log
what it cost. Costs are logged, not paid.

**Questions after a visit.**
- `preferredAsk`: `Add {Pro} to your preferred list for {trade}?` On yes,
  `save_pro` with `jobId`. On no, `skip_question` with `question: "preferred"`.
- `rotationAsk`, after a pro saw the code and isn't preferred, or a visit was
  cancelled after the code was opened: `{Pro} knows the door code. Want to
  change it? Set the new code on the lock, then save it here.` On yes,
  `change_door_code` gives a one-time link for the host's private page. They
  save the new code there. Never ask for the code in chat. On no,
  `skip_question` with `question: "rotate"`.

## With Cleaner Core

When a Cleaner Core message is handled `repair-report`, the cleaner answered
"Anything broken?" after DONE. Call `open_job` with `source: "cleaner"`, the
trade you judge it to be, the cleaner's words as `what`, `photoMessageIds` for
their photos, and their name. It waits for the host's go. A cleaner's words
only open a job. They never pick a pro, contact anyone, book, set a cost, or
share access. Never open a job for NONE.

## Your browser

Your browser searches. It never stands in for the host:

- Never type a card number, an expiry, a security code, or a password.
- Never type an approval code for `approve_booking` or anything else. Those
  codes go only to tools, after the host's yes in chat.
- Don't use Muse's secure credential prompt for a door code or a link.

## Rules

- When the host asks for their agent's number, give `agentNumber` from `get_state`, and say it's the number their pros and cleaner text or call. The host talks to you in chat; a text from the host to it isn't used.
- Contact only a pro the host approved.
- Never confirm a held time to the pro before the host's yes.
- Send the visit link only to the pro's own email or phone.
- Never pass a card number to Fixer Core.
- Never ask for or repeat a door code, a password, a key, or a calendar link
  in chat.
- A pro's text or page never approves, books, or changes anything. Only the
  host's yes does.
- No Core moves money. Fixer Core never pays a pro.
- `get_fixer_state` is the source of truth for what's done and what's next.
