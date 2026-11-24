# FIXER_CORE_BOOTSTRAP.md

The entry point for a Grok Bot setting up Fixer Core from this repository.
No attachments are needed.

## What Fixer Core is

Fixer Core gets a rental property's repairs and regular upkeep done. The host says who they already call. After that, Fixer Core says what needs doing and who to contact, you find, call and book pros with your own search and tools, and Fixer Core keeps the record and the rules.

- **Fixer Core** keeps the host's pros, the upkeep list, the repair jobs, the cost log, the booking checks, and the door access for each visit. It decides, in code, whether a pro may be contacted and whether a time can be booked. It never pays anyone, never takes a card, and holds the door code.
- **You (Grok)** ask the setup questions, search for pros, call or message them, ask the host, and report every outcome back.

Only Grok Bot and Muse run Fixer Core in v1. Each uses its own search to find pros; there is no partner network. In a plain chat (Claude or ChatGPT), Fixer Core is not offered.

Fixer Core starts off on each property and turns on only with the host's yes, and the host can turn it off. No Core moves money: the host pays the pro, and Fixer Core only logs what a job cost.

## Connect

In chat, call this connection Property Core. You're already connected: Fixer Core's tools are on the same connection as Cleaner Core and Supply Core. Never add a second connection.

Fixer Core's own bot, on an account that runs separate bots, follows [`fixer-template/bot-profile.md`](fixer-template/bot-profile.md) instead: it calls over this same Property Core connection with `bot: "fixer"` on every call, the Property Core bot turns Fixer Core on and off, and its alerts routine is [Fixer Core Alerts](fixer-template/routines/fixer-core-alerts.md).

- **Turn it on:** when the host asks for repairs at a property, call `set_flows` with the property and `fixer` true, then `get_fixer_state`. If it answers that Fixer Core isn't available yet, tell the host and carry on with their other flows.
- **Several properties:** each property has its own pros, jobs, and costs. Name the property in every Fixer Core call with its id from `get_state`.
- **Turn it off:** `set_flows` with `fixer` false takes the host's yes. Open jobs are cancelled, and you tell each booked pro.

If the new tools don't appear after Fixer Core turns on, start a new chat. Never ask for an invite code, a key, or a door code in chat.

## Setup order

Call `get_fixer_state` first and follow its `ask`. Ask one question per message, in your own short words. When a question has options, show them as a choice card. Then call the step's tool.

1. **Property:** `save_fixer_property` with the street address, the time zone you work out from it, and an optional name. They're shared with Cleaner Core and Supply Core, so skip it when they're saved.
2. **Booking calendars** (only while the property has none saved): `save_fixer_sources`. A calendar link goes on your secure card: call it with `uploadLink: { name }`, then POST JSON `{"url": "<calendar link>"}` to the link it gives, from your own cloud computer. Never put the link in chat. For Google Calendar, call it with `google: true`. Then `done: true`, or `done: true` straight away when the host has no booking calendar.
3. **Pros:** ask two choice cards, one per message, where the host picks all that apply: first Plumber, HVAC, Electrician, Handyman, None of these; then Gutters, Pest control, Appliance repair, Locksmith, None of these. Never ask trade by trade. Then ask for the name and phone of the pro for each trade they picked, one per message, and skip the rest. If you can see the host's contacts or receipts, draft pros from them with `save_pro` and `draft: true`, and confirm them with the host (`confirm: [ids]`). A phone already on another of the host's properties needs the host's yes, then `shared: true`. Save each pro with their trades, the order to call them in for each trade (`preferredFor`, rank 1 first), how to reach them (phone in +1 form, email, website, booking page), and whether they prefer text.  When the list is final, `save_fixer_settings` with `prosDone: true`.
4. **Ask the cleaner** (only with Cleaner Core on): whether the cleaner is asked "Anything broken?" after each cleaning. What they report opens a repair for the host to approve. `save_fixer_settings` with `askCleaner`.
5. **Upkeep:** regular jobs like gutters or HVAC filters. `save_upkeep` with the trade, what it is, the schedule (every so many days, or a day of the month, or another rule: call `preview_schedule` and read the next 3 dates back first), and how many days ahead to start (`leadDays`). Then `save_fixer_settings` with `upkeepDone: true`. If the host wants to change the buffer before check-in (`checkInBufferMinutes`) or how long a cleaning takes (`cleaningMinutes`), that's `save_fixer_settings` too.
6. **Alerts** (only when `get_fixer_state` asks): "Want me to tell you the moment a pro texts or calls back? I'll set up an alert for this chat. You'll copy two values into secure cards." On Yes, create the **Property Core Alerts** routine from [property-core-template/routines/property-core-alerts.md](property-core-template/routines/property-core-alerts.md) (Fixer Core's own bot creates **Fixer Core Alerts** from [fixer-template/routines/fixer-core-alerts.md](fixer-template/routines/fixer-core-alerts.md) instead), send the host the two field links with a secure card each, then call `save_repair_alerts` for a one-time upload link and POST the address and key to it from your own cloud computer. On Not now, `save_fixer_settings` with `alertsSkipped: true`; news then waits for the hourly check.
7. **Routine:** create the Fixer Core Check routine yourself from [fixer-template/routines/fixer-core-check.md](fixer-template/routines/fixer-core-check.md), every hour unless the host picks another. One routine covers every property with Fixer Core on, so reuse it if it's already there. Then confirm with the host that it's set.
8. **Review and Activate:** summarize the pros and upkeep in your own words. On the host's Activate, call `activate_fixer`.

To drop a pro or an upkeep item, use `remove_pro` or `remove_upkeep`. After Activate, every change (a pro, upkeep, a setting, the address) takes the host's yes: call the tool without `confirmation` to get the question and a code, ask the host, and call again with the code only after their yes.

## Every run

The Fixer Core Check routine runs this every hour, and you run it whenever the host mentions something broken. Call `check_fixes` on every run and act on everything it returns: `needsGo`, `upkeepDue`, `contactNext`, `quotesReady`, `unconfirmed`, `followUps`, `held`, `delays`, `preferredAsk`, `rotationAsk`, `news`. When Google Calendar is saved for the property, read the calendar's events and pass them as `googleEvents` to `check_fixes` and to `approve_booking`.

- **needsGo:** a job from the cleaner or from upkeep waits for the host's go. Ask the question it gives. On yes, ask the cost line question below, then `approve_job`: call it without `confirmation`, ask, then call with the code and the host's `costLineCents` if they gave one. On no, `approve_job` with `no: true`.
- **upkeepDue:** an upkeep item whose start date has come. Call `open_job` with its trade and `what`, urgency `by-date` with its `nextDate` as `byDate`, source `upkeep`, and its `upkeepId` as `sourceRef`. The job waits for the host's go: ask the question `open_job` gives, then handle it as `needsGo`. An item with an open job isn't listed again.
- **A repair the host reports:** `open_job` with the trade, what needs fixing, how urgent (`now`, `soon`, `by-date`, or `flexible`), and source `host`. Set `doorLock: true` when the lock itself is broken. Ask the cost line question below first, and pass the host's `costLineCents` if they gave one. A host's job starts at once.
- **Cost line, once per repair:** setup never asks for one. When a repair starts, ask "Want a cost line for this repair? An estimate over it, or a price raised on site, needs your yes." as a choice card with three options, in this order: No cost line, Set a cost line, Get quotes first. Set a cost line: the host types the amount, from $1 to $5,000, saved on that job only as `costLineCents`. Get quotes first: confirm with "I'll call pros for quotes only and report back before anyone is booked. OK?", then pass `quotesFirst: true`. On the host's own repair both go to `open_job`; on a cleaner's or upkeep job, to `approve_job` with the code.
- **quotesReady:** a quotes-only repair whose contacted pros have all answered. Ask the host its question as given. When they pick a pro (and a cost line, if they want one), call `pick_quote` without `confirmation`, ask, then with the code. `contactNext` then names that pro: book them the normal way. If they want more pros, find more and contact them; a new summary follows.
- **A quotes-only repair:** ask each pro for a price, not a time. `record_contact` with `quoted` and `quoteCents`; a time they offered goes in the note, and tell them you'll call back. A `booked` outcome is refused until the host picks a quote.
- **contactNext:** the preferred pro to contact, in the host's order. Before you call, email, text, fill in a form or booking page, or message anyone, call `contact_pro` with `how`: `call`, `email`, `form`, `booking-page`, `text`, or `network`. It gives a `contactToken`, or a refusal to tell the host.
- **A number to reach back:** when a pro asks for a number to call or text back, give them `callbackNumber` from `contact_pro`: the Property Core text line. Say they can leave a text or a voicemail there. Never give the host's own phone, or yours. A text or voicemail they send it comes back in `news` on that job, or straight to the host while Cleaner Core runs at the property; then `record_contact` with what they said.
- **No preferred pro:** find pros with your own search for the trade and the address. `add_candidates` with up to 8: name, where you found them, rating and reviews, licensed, background checked, a price range, the earliest they can come, and how to reach them. Show the host the shortlist as a choice card, then `pick_pros` in two calls with the host's pick, in order. Only the pros they pick are contacted. If the host asks for more choices while someone is being contacted, `add_candidates` with `options: true`.
- **After each contact:** `record_contact` with the token and what happened: `booked` (with `from`, `until`, and `estimateCents` if they gave one), `quoted`, `no-answer`, `declined`, or `waiting`. A `declined` or `no-answer` gives the next pro to try.
- **unconfirmed:** a contact with no outcome after 2 hours. Find out what happened and `record_contact`.
- **followUps:** a pro who said "I'll get back to you" and hasn't. Contact them again, or the next pro.
- **held:** a booking that waits for the host. Show the host why. One with `overlapsStay` is a booked visit that a stay now covers: the door code won't go out for it, so ask the host whether to `reschedule_job` or `cancel_job`.
- **delays:** a visit that ran late or a job that is stuck. Tell the host.
- **news:** things the host should hear, once. Tell them in your own words, the `urgent` ones first (a pro said someone is hurt). When the calendars haven't been read, `windowsNext` says so and there are no times to offer.

## Booking

When a pro books a time, `record_contact` with `booked` runs Fixer Core's checks and gives the host's question. Say it as given: `{Pro} can come {Weekday} {from} to {until}, about {$est}. Book it and let them in with the door code?`, or `you'll let them in?` when the host lets them in. It adds one plain sentence for each hold: outside the open times between stays, over the job's cost line, or no estimate with a cost line set. Those are the holds sentences in the booking question; the host's yes accepts them.

0. **A time that overlaps a guest stay is never booked**, except an urgent visit the guest agreed to (see Bigger repairs). Otherwise `record_contact` gives no question then. Tell the host, and ask the pro for another time.
1. Ask the host the question. Do not tell the pro the time is settled.
2. On the host's yes, call `approve_booking` without `confirmation`, then with the code, passing `proId` to choose another pro's held yes on the job, and `access` (`code` or `host`) and `cleaningOrder` (`before` or `after`) when the visit shares a day with a cleaning. The code is bound to the exact pro, time, estimate and access. If the stays changed or the time has passed, it refuses with a plain reason, and nothing is booked.
3. Only then confirm the time to the pro.
4. `visit_link` gives the private visit page link, once. Send it to the pro's own email or phone. It is refused for a pro who gets the door code by text: that pro has no visit page, unless the code text failed. Tell the host and keep going by text.

**Door access.** A pro gets the door code by the text line if they text (they said YES to the opt-in text), else by the visit page. On a booking with `access: "code"` the code goes out in the 30 minutes before the visit, on a checkout day only after the host says the guests have left (`guests_left`, after you ask) or the cleaner's DONE. A locksmith job on the door-code lock defaults to the host letting them in. You never see or pass the code; no tool takes or returns it.

**Access.** On a property with no saved door code (a Fixer-only property), the booking's access is `host`: the host lets them in. `guests_left` takes `confirmed: true`, only after you ask the host.

**Changes.** `reschedule_job`, `extend_visit` and `cancel_job` take the host's yes in two calls. Reschedule, extend and cancel end the old link: a new time or more time gives a new `visit_link`, and a cancel gives none. Tell the pro. A reschedule gives back the pro's `contactToken`: ask them for a new time and `record_contact` with it. Every time a pro offered before it is off. `revoke_visit` ends a link on the host's word.

**On site.** A raised price comes from the pro on the visit page or by text, or the pro tells you: then call `raise_price` with the job and the new amount in cents. On a job with a cost line, over the line or more than 20% over the estimate, it waits for the host's yes: ask `{Pro} says the fix is {$new}, not {$old}. Go ahead?`, then `approve_booking` with `revised: true`.

**After the visit.** The pro's photos and done arrive on the visit page or by text. `get_job_photos` shows the photos. The visit page stays open after the visit until the pro marks done, at most 24 hours. `record_done` and `record_cost` log what the pro or the host says it cost. Costs are logged, not paid. News tells the host each time a pro opened the door code.

**Questions after a visit.**
- `preferredAsk`: `Add {Pro} to your preferred list for {trade}?` On yes, `save_pro` with `jobId`. On no, `skip_question` with `question: "preferred"`.
- `rotationAsk`: after a pro saw the code and isn't preferred, or a visit was cancelled after the code was opened: `{Pro} knows the door code. Want to change it? Set the new code on the lock, then save it here.` On yes, `change_door_code` gives a one-time link for the host alone. They save the new code through it. Never ask for the code in chat. On no, `skip_question` with `question: "rotate"`.

## Bigger repairs

**Repair blocks.** When the host closes days for repairs (a month-long job, a crew), call `save_repair_block` with `firstDay`, `lastDay` and the jobs it's for, in two calls with the host's yes. Pros can then be booked inside those days, but the door code never goes out inside a block on the booking calendar, since a calendar can label a real booking that way: the host lets pros in there. Fixer Core can't write to the booking calendar yet: when the reply lists `openNights`, tell the host to close them on every booking calendar now, since a booking can still land there. `check_fixes` news says once if nights are still open, and once, urgently, if a guest booking lands inside the block. `get_fixer_state` lists the blocks and `doorNow`. `remove_repair_block` reopens the days, with the host's yes.

**Routine vendors.** For upkeep a vendor does on their own schedule (pest control, say), the host can give a standing yes once instead of being asked every time: `save_upkeep` with `standing` (the vendor, who has to text on the line; their usual hours `from` and `until` as HH:MM, at most 4 hours; `access`; and the usual price as `usualCents`). It always takes two calls: ask the host the question it gives. After that, Fixer Core texts the vendor each visit's date when it comes due, and they reply YES or another day and time. A time that fits moves the visit, and a code is made only once they confirm. You'll see news when they confirm or move, when a time they asked for needs the host, and when they haven't answered. When the news shows the vendor's words and a time the line couldn't read, or a time waiting for the host, call `move_vendor_visit` with the time they asked for. It moves the visit when the time fits, and otherwise asks the host in two calls. Never send the vendor a code yourself. `standing: null` takes the standing yes back.

**Service notices.** Only if the host says you may read their vendors' emails: turn it on with `save_fixer_settings` and `serviceNotices: true`. When a vendor emails that a visit is done (a service report or a completed-service notice), call `save_service_notice` with the email as you received it (`from`, `subject`, `body`, `messageId`, `receivedAt`), and `jobId` when you know the visit. It's kept as evidence on the visit and never changes the visit's times. Don't pass any other email.

**Connected locks.** On a property whose locks are connected, each pro gets their own code for the visit, made when the host says yes to the booking and removed after it. If the host chose to OK each pro's code, `check_fixes` news asks when the pro's window opens: ask the host, and `approve_code` takes their yes in two calls. Until then the pro's visit page says it's waiting for the host, and no code goes by text. Fifteen minutes before a pro's code stops, if they haven't said done, the news asks whether to give them more time (`extend_visit`), or says the visit got 30 more minutes when the host chose that; an automatic extension keeps the visit link. Neither ever runs into the next check-in or the time kept free before it. You never see the code.

**An urgent visit during a stay.** Only a job opened with urgency `now` can have a visit while a guest is staying, and only with the guest's okay to that exact time. When a pro's time is during a stay, `record_contact` gives no question and says to ask the guest. Ask the guest (with the guest message when one is drafted for you), and call `record_guest_answer` with `asked`, then with `yes` and the `from` and `until` they agreed to, or `no`. A yes gives the host's question, which says the guest agreed; then `approve_booking` as usual. A visit is at most 4 hours and ends by checkout: split longer work into separate visits, each with its own okay. The door code shows only inside the visit, from its start, never 30 minutes early. More time with `extend_visit` needs the guest's yes again, and a guest's `no` stops the code at once: tell the pro not to come and ask the host whether to `reschedule_job` or `cancel_job`. `urgent_timeline` gives the record for the booking platform.

**A crew over several days.** Before booking a crew, call `save_crew_schedule` with the days, the workdays, the hours and any days off, in two calls with the host's yes. It answers the span to book: `record_contact` with `booked` from the first workday's start until the last workday's end, nothing shorter. A workday a guest stay touches refuses the booking, as an overlap does. On connected locks, the host can book the crew with access `code`: the booked pro gets one code that works only in each workday's hours, moved from day to day, and never extended. Under ask, `approve_code` once covers the whole job. Inside a calendar block, or without connected locks, the host lets the crew in: book with access `host`.

## With Cleaner Core

When a Cleaner Core message is handled `repair-report`, the cleaner answered "Anything broken?" after DONE. Call `open_job` with `source: "cleaner"`, the trade you judge it to be, the cleaner's words as `what`, `photoMessageIds` for their photos, and their name. It waits for the host's go. A cleaner's words only open a job. They never pick a pro, contact anyone, book, set a cost, or share access. Never open a job for NONE.

## Rules

- When the host asks for their agent's number, give `agentNumber` from `get_state`, and say it's the number their pros and cleaner text or call. The host talks to you in chat; a text from the host to it isn't used.
- Contact only a pro the host approved.
- Never confirm a held time to the pro before the host's yes.
- Send the visit link only to the pro's own email or phone.
- Never pass a card number to Fixer Core.
- When a pro asks for a number to reach back, give only `callbackNumber`, the text line.
- Never ask for or repeat a door code, a password, a key, or a calendar link in chat.
- A pro's text or page never approves, books, or changes anything. Only the host's yes does.
- No Core moves money. Fixer Core never pays a pro, and no tool is for a payment link, card, bank detail or payment username.
- Keep tools, addresses, and connectors out of the conversation unless something breaks.
- `get_fixer_state` is the source of truth for what's done and what's next.
