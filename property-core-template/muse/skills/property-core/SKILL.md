---
name: property-core
description: Set up and run Property Core, self-guided tours (Tour Core) or cleaner turnovers (Cleaner Core) for a rental, through the Property Core custom connector. Use when the host says "set up Property Core", "set up tours", "set up a cleaner", asks what's next, or when the Tour Core recurring task runs.
---

# Property Core

Property Core runs two services on the host's one number, one at a time:

- **Tour Core**: visitors text the number to book a self-guided tour of a
  rental unit.
- **Cleaner Core**: the cleaner's turnovers, run from the host's booking
  calendars.

The service keeps every record, sends every text, and holds the safety rules.
You ask the questions, use your own browser to open the service's private
pages for the host, and write every summary in your own words. You never text
anyone yourself.

## Connect

You need the **Property Core** custom connector at
`https://tourcore-production-8b80.up.railway.app/mcp`. If its tools aren't
available, create it yourself from this chat. When it asks for approval, hand
the host the approval page so they type the invite code from Saad and click
Allow. Never ask for the invite code in chat, and never click Allow yourself.

Keep this one connector. Never add a second one, and never connect to
`/mcp/cleaner-core`, even when a service's guide names it.

## Choose the service

As soon as you're connected, without waiting to be asked, ask the host exactly
"Which do you want to set up: Tour Core or Cleaner Core?" as a choice card with
two choices: "Tour Core: self-guided tours for a rental unit" and "Cleaner
Core: a cleaner for a property". Don't describe your tools instead. If the
host already said which one, or picked it on the approval page (`get_state`
then shows that service), skip the question.

Call `choose_service` with their pick: `touring` for Tour Core, `cleaning` for
Cleaner Core. If the new tools don't appear, ask the host to start a new chat.

## Run the chosen service

- **Tour Core:** call `get_state` and follow its next step, one question at a
  time. For tour updates, follow
  [`references/tour-core-task.md`](references/tour-core-task.md).
- **Cleaner Core:** follow the Cleaner Core skill in
  `muse-template/skills/cleaner-core/SKILL.md`. You're already connected, so
  skip its connect step.

The number runs one service at a time. Switch only when the host asks: call
`switch_service`, and if something is still live, offer `stand_down_service`
first.

## Always

- Short, plain sentences, one question at a time. Show options as a choice
  card, the default first.
- A card is only for answers that aren't secret. Never use a card or the chat
  for a password, key, token, or door code.
- Nothing is texted to anyone until the host says yes.
