---
name: property-core
description: Set up and run Property Core, self-guided tours (Tour Core) or cleaner turnovers (Cleaner Core) for a rental, through the Property Core connector. Use when the host says "set up Property Core", "set up tours", "set up a cleaner", asks what's next, or when the Tour Core Updates scheduled task wakes you.
---

# Property Core

Property Core runs two services on the host's one number, one at a time:

- **Tour Core**: visitors text the number to book a self-guided tour of a
  rental unit.
- **Cleaner Core**: the cleaner's turnovers, run from the host's booking
  calendars.

The service keeps every record, sends every text, and holds the safety rules.
You ask the questions and write every summary in your own words. You never
text anyone yourself.

## Connect

You need the **Property Core** custom connector at
`https://tourcore-production-8b80.up.railway.app/mcp`. One address serves both
services. When it asks for approval, the host types the invite code from Saad
on the approval page and clicks Allow. Never ask for the invite code in chat.

Keep this one connector. Never add a second one, and never connect to
`/mcp/cleaner-core`, even when a service's guide names it.

## Choose the service

As soon as you're connected, without waiting to be asked, ask the host exactly
"Which do you want to set up: Tour Core or Cleaner Core?" with two choices:
"Tour Core: self-guided tours for a rental unit" and "Cleaner Core: a cleaner
for a property". Don't describe your tools instead. If the host already said
which one, or picked it on the approval page (`get_state` then shows that
service), skip the question.

Call `choose_service` with their pick: `touring` for Tour Core, `cleaning` for
Cleaner Core. If the new tools don't appear, ask the host to start a new chat.

## Run the chosen service

- **Tour Core:** call `get_state` and follow its next step, one question at a
  time. For tour updates, follow
  [`routines/tour-core-task.md`](../../../routines/tour-core-task.md).
- **Cleaner Core:** follow the Cleaner Core skill in
  `claude-template/plugin/skills/cleaner-core/SKILL.md` and its task doc in
  `claude-template/routines/cleaner-core-task.md`. You're already connected,
  so skip their connect step.

The number runs one service at a time. Switch only when the host asks: call
`switch_service`, and if something is still live, offer `stand_down_service`
first.

## Always

- Short, plain sentences, one question at a time. Show options as a short
  list of choices, the default first.
- Never ask the host to paste a password, key, token, Fire URL, or door code
  into chat. Use the private page a tool's link opens.
- Nothing is texted to anyone until the host says yes.
