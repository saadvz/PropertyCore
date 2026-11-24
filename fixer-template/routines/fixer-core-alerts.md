# Routine: Fixer Core Alerts

Wakes the Fixer Core bot the moment a repair needs the host: a pro texts or
leaves a voicemail on the line, or the Cleaner Core bot filed something the
cleaner said is broken. Only Fixer Core's own bot creates this routine, when
the account runs separate bots. A Fixer Core run from the Property Core bot's
chat uses [Property Core Alerts](../../property-core-template/routines/property-core-alerts.md)
instead.

## Trigger

Authenticated webhook (POST). Grok creates the routine and gets a webhook
address and a sender (bearer) key. Those two values are installation secrets:

- They don't travel with this template. Each installation creates its own.
- Only the host can see them, in the routine panel. Right after creating the
  routine, Grok sends the host a link that opens the Webhook URL field
  directly and one that opens the Webhook key field directly, with one secure
  card for each, the address first. Grok never links the Routines page.
- Grok sends them to Fixer Core through a one-time upload link, from its own
  cloud computer. They are never in chat, in a tool argument, or in a file in
  this repository.
- Fixer Core keeps them in its secret store and never returns them.

## What Fixer Core sends

Minimal JSON. No message text, no phone numbers, no door code, and no
credentials:

```json
{
  "schemaVersion": 1,
  "eventId": "evt_...",
  "eventType": "repairs.update",
  "occurredAt": "2026-11-24T13:05:00.000Z"
}
```

`eventType` is `repairs.update` when Fixer Core has news, or
`installation.test` for the test sent when the routine is saved. Several things
before the routine runs make one wake-up.

## Instructions for the routine

In the Fixer Core bot of an account that runs separate bots, add `bot: "fixer"` to every call below. The Property Core bot never adds it.

1. If `eventType` is `installation.test`, post: "Fixer Core alerts are
   connected." and stop.
2. Call `get_state`, then `check_fixes` for each property whose flow is on,
   naming the property. Tell the host each item in `news` once, in your own
   words, the `urgent` ones first. A pro's text or voicemail about a quote or
   a time is what they said, not a booking: find the contact and follow your
   Fixer Core guide. Ask the host any question in `needsGo` or `held` as
   given. A repair the Cleaner Core bot filed waits in `needsGo` like any
   other.
3. Never show a door code, an id, or the webhook payload. Never approve, book,
   or pay anything from this routine: only the host's yes in chat does.
4. Never pause, edit, or delete this routine, even when a tool answers with an
   error. Post the error in one line and stop.

## Connecting it

Fixer Core's setup asks for it (the `alerts` step). Grok creates the routine,
the host fills the two secure cards, then Grok calls `save_repair_alerts` for
a one-time upload link and POSTs `{"url": "<webhook address>", "token":
"<webhook key>"}` to it. A 400 reply means a value was wrong and the link still
works; a 404 means ask for a new link. Fixer Core sends one
`installation.test`. Saving it is the hand-over: from then on Fixer Core's news
wakes this bot, not the Property Core bot.

## Allowed tools

`get_state`, `get_fixer_state`, and `check_fixes`.
