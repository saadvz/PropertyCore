# Routine: Supply Core Alerts

Wakes the Supply Core bot when Supply Core has news for the host: the Cleaner
Core bot filed what the cleaner said is running low, or a package wasn't seen
by evening. Only Supply Core's own bot creates this routine, when the account
runs separate bots. A Supply Core run from the Property Core bot's chat keeps
using that chat's Alerts routine instead.

## Trigger

Authenticated webhook (POST). Grok creates the routine and gets a webhook
address and a sender (bearer) key. Those two values are installation secrets:

- They don't travel with this template. Each installation creates its own.
- Only the host can see them, in the routine panel. Right after creating the
  routine, Grok sends the host a link that opens the Webhook URL field
  directly and one that opens the Webhook key field directly, with one secure
  card for each, the address first. Grok never links the Routines page.
- Grok sends them to Property Core through a one-time upload link, from its
  own cloud computer. They are never in chat, in a tool argument, or in a file
  in this repository.
- Property Core keeps them in its secret store and never returns them.

## What Property Core sends

Minimal JSON. No item names, no message text, no phone numbers, no door code,
and no credentials:

```json
{
  "schemaVersion": 1,
  "eventId": "evt_...",
  "eventType": "supplies.update",
  "occurredAt": "2026-11-24T13:05:00.000Z"
}
```

`eventType` is `supplies.update` when Supply Core has news, or
`installation.test` for the test sent when the routine is saved. Several things
before the routine runs make one wake-up.

## Instructions for the routine

1. If `eventType` is `installation.test`, post: "Supply Core alerts are
   connected." and stop.
2. Call `check_alerts`. Tell the host each item in `alerts` and `notes` once,
   in your own words. Each is returned only once, so never ask for it again.
3. Follow every step of `supply-template/routines/supply-core-check.md` from
   its first: `check_supplies` returns what the Cleaner Core bot filed as
   low, and you order it the same way as anything else that's due.
4. Never show an id, a door code, or the webhook payload. Never approve or pay
   from this routine: only the host's yes in chat does.
5. Never pause, edit, or delete this routine, even when a tool answers with an
   error. Post the error in one line and stop.

## Connecting it

At the end of Supply Core's setup, before Activate, Grok creates this routine,
sends the host the two field links with a secure card each, then calls
`check_alerts` with `connect: true` for a one-time upload link and POSTs
`{"url": "<webhook address>", "token": "<webhook key>"}` to it from its own
cloud computer, with `Content-Type: application/json`. A 400 reply means a
value was wrong and the link still works; a 404 means ask for a new link.
Property Core sends one `installation.test`. Saving it is the hand-over:
from then on Supply Core's news wakes this bot, not the Property Core bot.

## Allowed tools

`check_alerts`, `get_state`, `get_supply_state`, `check_supplies`,
`check_cart`, `approve_cart`, `record_order`, `record_problem`,
`mark_delivered`, and, when they're listed, `check_packages` and
`mark_package_seen`.
