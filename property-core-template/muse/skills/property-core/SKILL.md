---
name: property-core
description: Set up and run Property Core for a short-term rental, Cleaner Core (cleaner turnovers) and Supply Core (supplies reordered), through the Property Core custom connector. Use when the host says "set up Property Core", "set up a cleaner", "set up Supply Core", asks what's next, or when a Property Core recurring task runs.
---

# Property Core

Property Core runs a short-term rental's flows, property by property:

- **Cleaner Core**: the cleaner's turnovers, run from the host's booking
  calendars.
- **Supply Core**: the property kept stocked. You shop in your own browser,
  and Supply Core decides go or hold on every cart.

- **Fixer Core**: repairs and upkeep. You find, call and book the host's pros
  yourself, and Fixer Core holds the rules and the door access. It starts off
  on each property, until the host says yes.

The service keeps every record, sends every text, and holds the safety rules.
You ask the questions, use your own browser to open the service's private
pages for the host, and write every summary in your own words. You never text
anyone yourself.

## Connect

You need the **Property Core** custom connector at
`https://tourcore-production-8b80.up.railway.app/mcp`. If its tools aren't
available, create it yourself from this chat. When it asks for approval, hand
the host the approval page so they sign in or type the invite code from Saad
and click Allow. Never ask for the invite code in chat, and never click Allow yourself.

Keep this one connector. Never add a second one, and never connect to
`/mcp/cleaner-core`, even when a service's guide names it. Where a guide, a
task, or a tool names the Cleaner Core connector, use this Property Core
connector, and tell the host to look for **Property Core** in Muse's
connector settings.

## Your properties

Call `get_state` first. It lists the account's properties and which flows each
one runs: Cleaner Core (`cleaning`) and Supply Core (`supplies`). With no
property yet, ask the host for the property's address and call `add_property`
with it. Then ask which flows they want there, Cleaner Core, Supply Core, or
both, as a choice card, and call `set_flows` with the property and `cleaning`
or `supplies` true. If `set_flows` says Supply Core can't run on its own yet,
tell the host Cleaner Core has to be on first, and offer both. With more than
one property, name the property in every property tool call with its id from
`get_state`. Touring is parked: only Saad makes an account a touring account,
on `/admin`, and then `get_state` shows Tour Core instead.

## Run each flow

- **Cleaner Core:** save the folder `muse-template/skills/cleaner-core` as a
  skill named Cleaner Core, so later chats and its recurring task know it, and
  follow its `SKILL.md`. You're already connected, so skip its connect step.
- **Supply Core:** when the host wants supplies reordered at a property, call
  `set_flows` with the property and `supplies` true, save the folder
  `muse-template/skills/supply-core` as a skill named Supply Core, and follow
  it from `get_supply_state`. You shop in your own browser, at stores the
  host signs in to there.
- **Tour Core (parked):** only on a touring account. Call `get_state` and
  follow its next step, one question at a time. For tour updates, follow
  [`references/tour-core-task.md`](references/tour-core-task.md).

Turn a flow off only when the host asks: call `set_flows` with the property
and that flow false. With anything live, it shows what stops and the exact
texts that go out, and needs the host's yes first. The setup is kept.

## Guests and house rules

Use this only when `get_house_rules` or `read_guest_message` is among your
tools.

- House rules are one list, used by the nightly check and for guest replies.
  In setup, ask about the house only this: call `get_house_rules` and ask its
  `ask`, which starts with what the cameras can check (guests, pets, cars,
  quiet hours). Read back each rule a camera can check, and save its check
  only after the host agrees.
- Don't ask the host about wifi, parking, checkout or other house facts up
  front. They're learned as guests ask: when `read_guest_message` finds
  nothing saved, ask the host what to say, then offer to keep their answer
  for the next guest. Only on their okay, call `save_guest_facts` with the
  topic, their words and the `messageId`; a house rule goes to
  `save_house_rules` with `add`. A fact the host gives on their own, save it.
- Nothing reaches a guest from here, and no guest is ever texted: the host
  pastes each approved reply into Airbnb.

## Hours log

Use this only when `review_hours` is among your tools.

- When the host asks for their hours or a month's log, call `review_hours`
  with the property and the month. Show each log's rows and every line in
  `needs`, ask its question, and call it again with the code only after
  their yes.
- Then call `export_hours` and write each log, exactly as given, to the
  spreadsheet the host already uses with you: Google Sheets, Excel, or
  another. If none is connected, ask the host where they want the log
  written. Then call `export_hours` again with `stored: true`.
- Save their activity codes, minutes, columns, owner name and spreadsheet
  with `save_hours_settings`, only as the host says.
- Never give tax advice, or say what counts toward any tax test. That's for
  the host and their advisor.

## Always

- Short, plain sentences, one question at a time. Show options as a choice
  card, the default first.
- A card is only for answers that aren't secret. Never use a card or the chat
  for a password, key, token, or door code.
- Nothing is texted to anyone until the host says yes.
