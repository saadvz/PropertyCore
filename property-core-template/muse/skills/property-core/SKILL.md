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

Fixer Core, for repairs, comes later. It isn't offered yet.

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

## Always

- Short, plain sentences, one question at a time. Show options as a choice
  card, the default first.
- A card is only for answers that aren't secret. Never use a card or the chat
  for a password, key, token, or door code.
- Nothing is texted to anyone until the host says yes.
