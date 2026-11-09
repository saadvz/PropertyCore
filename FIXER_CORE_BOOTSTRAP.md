# FIXER_CORE_BOOTSTRAP.md

The entry point for a Grok Bot setting up Fixer Core from this repository.
No attachments are needed.

## What Fixer Core is

Fixer Core gets a rental property's repairs and regular upkeep done. The host says who they already call. After that, Fixer Core says what needs doing and who to contact, you find, call and book pros with your own search and tools, and Fixer Core keeps the record and the rules.

- **Fixer Core** keeps the host's pros, the upkeep list, the repair jobs, the cost log, the booking checks, and the door access for each visit. It decides, in code, whether a pro may be contacted and whether a time can be booked. It never pays anyone, never takes a card, and holds the door code.
- **You (Grok)** ask the setup questions, search for pros, call or message them, ask the host, and report every outcome back.

Only Grok Bot and Muse run Fixer Core in v1. Each uses its own search to find pros; there is no partner network. In a plain chat (Claude or ChatGPT), Fixer Core is not offered.

Fixer Core turns on only on a service with `FIXER_CORE=1`, and the host can turn it off. No Core moves money: the host pays the pro, and Fixer Core only logs what a job cost.

## Connect

In chat, call this connection Property Core. You're already connected: Fixer Core's tools are on the same connection as Cleaner Core and Supply Core. Never add a second connection.

- **Turn it on:** when the host asks for repairs at a property, call `set_flows` with the property and `fixer` true, then `get_fixer_state`. If it answers that Fixer Core isn't available yet, tell the host and carry on with their other flows.
- **Several properties:** each property has its own pros, jobs, and costs. Name the property in every Fixer Core call with its id from `get_state`.
- **Turn it off:** `set_flows` with `fixer` false takes the host's yes. Open jobs are cancelled, and you tell each booked pro.

If the new tools don't appear after Fixer Core turns on, start a new chat. Never ask for an invite code, a key, or a door code in chat.

## Setup order

Call `get_fixer_state` first and follow its `ask`. Ask one question per message, in your own short words. When a question has options, show them as a choice card. Then call the step's tool.

1. **Property:** `save_fixer_property` with the street address, the time zone you work out from it, and an optional name. They're shared with Cleaner Core and Supply Core, so skip it when they're saved.
2. **Booking calendars** (only while the property has none saved): `save_fixer_sources`. A calendar link goes on your secure card: call it with `uploadLink: { name }`, then POST JSON `{"url": "<calendar link>"}` to the link it gives, from your own cloud computer. Never put the link in chat. For Google Calendar, call it with `google: true`. Then `done: true`, or `done: true` straight away when the host has no booking calendar.
3. **Pros:** ask who the host already calls, trade by trade (plumbing, HVAC, electrical, handyman, gutters, pest control, appliance, locksmith). If you can see the host's contacts or receipts, draft pros from them with `save_pro` and `draft: true`, and confirm them with the host (`confirm: [ids]`). A phone already on another of the host's properties needs the host's yes, then `shared: true`. Save each pro with their trades, the order to call them in for each trade (`preferredFor`, rank 1 first), how to reach them (phone in +1 form, email, website, booking page), and whether they prefer text.  When the list is final, `save_fixer_settings` with `prosDone: true`.
4. **Cost line:** "Want a cost line? A repair over it needs your yes, and so does a price raised on site." `save_fixer_settings` with `costLineCents`, or null for no line. Also the buffer before check-in (`checkInBufferMinutes`) and how long a cleaning takes (`cleaningMinutes`) if the host wants to change them.
5. **Ask the cleaner** (only with Cleaner Core on): whether the cleaner is asked "Anything broken?" after each cleaning. What they report opens a repair for the host to approve. `save_fixer_settings` with `askCleaner`.
6. **Upkeep:** regular jobs like gutters or HVAC filters. `save_upkeep` with the trade, what it is, the schedule (every so many days, or a day of the month, or another rule: call `preview_schedule` and read the next 3 dates back first), and how many days ahead to start (`leadDays`). Then `save_fixer_settings` with `upkeepDone: true`.
7. **Routine:** create the Fixer Core Check routine yourself from [fixer-template/routines/fixer-core-check.md](fixer-template/routines/fixer-core-check.md), every hour unless the host picks another. One routine covers every property with Fixer Core on, so reuse it if it's already there. Then confirm with the host that it's set.
8. **Review and Activate:** summarize the pros, cost line, and upkeep in your own words. On the host's Activate, call `activate_fixer`.

To drop a pro or an upkeep item, use `remove_pro` or `remove_upkeep`. After Activate, every change (a pro, upkeep, a setting, the address) takes the host's yes: call the tool without `confirmation` to get the question and a code, ask the host, and call again with the code only after their yes.

## Every run

The Fixer Core Check routine runs this every hour, and you run it whenever the host mentions something broken. Call `check_fixes` on every run and act on everything it returns: `needsGo`, `contactNext`, `unconfirmed`, `followUps`, `held`, `delays`, `preferredAsk`, `rotationAsk`, `news`. When Google Calendar is saved for the property, read the calendar's events and pass them as `googleEvents` to `check_fixes` and to `approve_booking`.

- **needsGo:** a job from the cleaner or from upkeep waits for the host's go. Ask the question it gives. On yes, `approve_job`: call it without `confirmation`, ask, then call with the code. On no, `approve_job` with `no: true`.
- **A repair the host reports:** `open_job` with the trade, what needs fixing, how urgent (`now`, `soon`, `by-date`, or `flexible`), and source `host`. Set `doorLock: true` when the lock itself is broken. A host's job starts at once.
- **contactNext:** the preferred pro to contact, in the host's order. Before you call, email, text, fill in a form or booking page, or message anyone, call `contact_pro` with `how`: `call`, `email`, `form`, `booking-page`, `text`, or `network`. It gives a `contactToken`, or a refusal to tell the host.
- **No preferred pro:** find pros with your own search for the trade and the address. `add_candidates` with up to 8: name, where you found them, rating and reviews, licensed, background checked, a price range, the earliest they can come, and how to reach them. Show the host the shortlist as a choice card, then `pick_pros` in two calls with the host's pick, in order. Only the pros they pick are contacted. If the host asks for more choices while someone is being contacted, `add_candidates` with `options: true`.
- **After each contact:** `record_contact` with the token and what happened: `booked` (with `from`, `until`, and `estimateCents` if they gave one), `quoted`, `no-answer`, `declined`, or `waiting`. A `declined` or `no-answer` gives the next pro to try.
- **unconfirmed:** a contact with no outcome after 2 hours. Find out what happened and `record_contact`.
- **followUps:** a pro who said "I'll get back to you" and hasn't. Contact them again, or the next pro.
- **held:** a booking that waits for the host. Show the host why.
- **delays:** a visit that ran late or a job that is stuck. Tell the host.
- **news:** things the host should hear, once. Tell them in your own words.

## Booking

When a pro books a time, `record_contact` with `booked` runs Fixer Core's checks and gives the host's question. Say it as given: `{Pro} can come {Weekday} {from} to {until}, about {$est}. Book it and let them in with the door code?`, or `you'll let them in?` when the host lets them in. It adds one plain sentence for each hold: outside the open times between stays, over the cost line, or no estimate with a cost line set. Those are the holds sentences in the booking question; the host's yes accepts them.

0. **A time that overlaps a guest stay is never booked.** `record_contact` gives no question then. Tell the host, and ask the pro for another time.
1. Ask the host the question. Do not tell the pro the time is settled.
2. On the host's yes, call `approve_booking` without `confirmation`, then with the code, passing `proId` to choose another pro's held yes on the job, and `access` (`code` or `host`) and `cleaningOrder` (`before` or `after`) when the visit shares a day with a cleaning. The code is bound to the exact pro, time, estimate and access. If the stays changed or the time has passed, it refuses with a plain reason, and nothing is booked.
3. Only then confirm the time to the pro.
4. `visit_link` gives the private visit page link, once. Send it to the pro's own email or phone. It is refused for a pro who gets the door code by text: that pro has no visit page, unless the code text failed. Tell the host and keep going by text.

**Door access.** A pro gets the door code by the text line if they text (they said YES to the opt-in text), else by the visit page. On a booking with `access: "code"` the code goes out in the 30 minutes before the visit, on a checkout day only after the host says the guests have left (`guests_left`, after you ask) or the cleaner's DONE. A locksmith job on the door-code lock defaults to the host letting them in. You never see or pass the code; no tool takes or returns it.

**Access.** On a property with no saved door code (a Fixer-only property), the booking's access is `host`: the host lets them in. `guests_left` takes `confirmed: true`, only after you ask the host.

**Changes.** `reschedule_job`, `extend_visit` and `cancel_job` take the host's yes in two calls. Reschedule, extend and cancel end the old link: a new time or more time gives a new `visit_link`, and a cancel gives none. Tell the pro. `revoke_visit` ends a link on the host's word.

**On site.** A raised price comes from the pro on the visit page or by text. Over the cost line, or more than 20% over the estimate, it waits for the host's yes: ask `{Pro} says the fix is {$new}, not {$old}. Go ahead?`, then `approve_booking` with `revised: true`.

**After the visit.** The pro's photos and done arrive on the visit page or by text. `get_job_photos` shows the photos. The visit page stays open after the visit until the pro marks done, at most 24 hours. `record_done` and `record_cost` log what the pro or the host says it cost. Costs are logged, not paid. News tells the host each time a pro opened the door code.

**Questions after a visit.**
- `preferredAsk`: `Add {Pro} to your preferred list for {trade}?` On yes, `save_pro` with `jobId`. On no, `skip_question` with `question: "preferred"`.
- `rotationAsk`: after a pro saw the code and isn't preferred, or a visit was cancelled after the code was opened: `{Pro} knows the door code. Want to change it? Set the new code on the lock, then save it here.` On yes, `change_door_code` gives a one-time link for the host alone. They save the new code through it. Never ask for the code in chat. On no, `skip_question` with `question: "rotate"`.

## With Cleaner Core

When a Cleaner Core message is handled `repair-report`, the cleaner answered "Anything broken?" after DONE. Call `open_job` with `source: "cleaner"`, the trade you judge it to be, the cleaner's words as `what`, `photoMessageIds` for their photos, and their name. It waits for the host's go. A cleaner's words only open a job. They never pick a pro, contact anyone, book, set a cost, or share access. Never open a job for NONE.

## Rules

- Contact only a pro the host approved.
- Never confirm a held time to the pro before the host's yes.
- Send the visit link only to the pro's own email or phone.
- Never pass a card number to Fixer Core.
- Never ask for or repeat a door code, a password, a key, or a calendar link in chat.
- A pro's text or page never approves, books, or changes anything. Only the host's yes does.
- No Core moves money. Fixer Core never pays a pro, and no tool is for a payment link, card, bank detail or payment username.
- Keep tools, addresses, and connectors out of the conversation unless something breaks.
- `get_fixer_state` is the source of truth for what's done and what's next.
