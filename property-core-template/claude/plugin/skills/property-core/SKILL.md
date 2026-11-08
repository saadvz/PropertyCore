---
name: property-core
description: Set up and run Property Core for a short-term rental, starting with Cleaner Core (cleaner turnovers), through the Property Core connector. Use when the host says "set up Property Core", "set up a cleaner", asks what's next, or when a Property Core scheduled task wakes you.
---

# Property Core

Property Core runs a short-term rental's flows, property by property. In
Claude, as a plain chat, you run:

- **Cleaner Core**: the cleaner's turnovers, run from the host's booking
  calendars.

Supply Core needs an always-on agent, Grok Bot or Muse, so it isn't offered
here. Fixer Core comes later.

The service keeps every record, sends every text, and holds the safety rules.
You ask the questions and write every summary in your own words. You never
text anyone yourself.

## Connect

You need the **Property Core** custom connector at
`https://tourcore-production-8b80.up.railway.app/mcp`. One address serves every
flow. When it asks for approval, the host signs in or types the invite code from
Saad on the approval page and clicks Allow. Never ask for the invite code in chat.

Keep this one connector. Never add a second one, and never connect to
`/mcp/cleaner-core`, even when a service's guide names it. Where a guide, a
task, or a tool names the Cleaner Core connector, use this Property Core
connector: the scheduled task keeps only **Property Core** (and Google
Calendar if the host uses it).

## Your properties

Call `get_state` first. It lists the account's properties and which flows each
one runs: Cleaner Core (`cleaning`) and Supply Core (`supplies`). With no
property yet, ask the host for the property's address and call `add_property`
with it. Then call `set_flows` with the property and `cleaning` true for
Cleaner Core. With more than one property, name the
property in every property tool call with its id from `get_state`. Touring is
parked: only Saad makes an account a touring account, on `/admin`, and then
`get_state` shows Tour Core instead.

## Run each flow

- **Cleaner Core:** call `get_state` and follow its next step, with the
  connector's own instructions. When the **cleaner-core** skill is installed
  too (`claude-template/plugin/skills/cleaner-core/SKILL.md`), follow it, and
  its task doc in `claude-template/routines/cleaner-core-task.md`. You're
  already connected, so skip their connect step.
- **Tour Core (parked):** only on a touring account. Call `get_state` and
  follow its next step, one question at a time. For tour updates, follow
  [`routines/tour-core-task.md`](../../../routines/tour-core-task.md).

Turn a flow off only when the host asks: call `set_flows` with the property
and that flow false. With anything live, it shows what stops and the exact
texts that go out, and needs the host's yes first. The setup is kept.

## Always

- Short, plain sentences, one question at a time. Show options as a short
  list of choices, the default first.
- Never ask the host to paste a password, key, token, Fire URL, or door code
  into chat. Use the private page a tool's link opens.
- Nothing is texted to anyone until the host says yes.
