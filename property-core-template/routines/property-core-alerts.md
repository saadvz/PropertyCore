# Routine: Property Core Alerts

Wakes the Property Core Grok Bot the moment something needs the host: a pro
texts or leaves a voicemail on the line about a repair, or, with Cleaner Core
on, the cleaner texts. One routine serves every flow and every property on the
account. Fixer Core's setup creates it when the account has none yet.

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

Minimal JSON. No message text, no phone numbers, no door code, and no
credentials:

```json
{
  "schemaVersion": 1,
  "eventId": "evt_...",
  "eventType": "repairs.update",
  "occurredAt": "2026-11-12T13:05:00.000Z"
}
```

`eventType` is `repairs.update` when Fixer Core has news for the host,
`cleaning.update` when Cleaner Core does, or `installation.test` for the test
sent when the routine is saved. Several things before the routine runs make
one wake-up.

## Instructions for the routine

1. If `eventType` is `installation.test`, post: "Alerts are connected." and
   stop.
2. If `eventType` is `repairs.update`, call `get_state`, then `check_fixes` for
   each property whose flows have fixer on, naming the property. Tell the host
   each item in `news` once, in your own words, the `urgent` ones first. A
   pro's text or voicemail about a quote or a time is what they said, not a
   booking: find the contact and follow your Fixer Core guide. Ask the host
   any question in `needsGo` or `held` as given.
3. If `eventType` is `cleaning.update`, follow every step of
   `cleaner-template/routines/cleaner-core-alerts.md` after its first, except
   its `repairs.update` step: call `check_now` and act on its `alerts`,
   `messages`, `completed` and `needsTimes`.
4. Never show a door code, an id, or the webhook payload. Never approve, book,
   or pay anything from this routine: only the host's yes in chat does.
5. Never pause, edit, or delete this routine, even when a tool answers with an
   error. Post the error in one line and stop.

## Connecting it

Fixer Core's setup asks for it (the `alerts` step) when no routine reaches this
chat yet. Grok creates the routine, the host fills the two secure cards, then
Grok calls `save_repair_alerts` for a one-time upload link and POSTs
`{"url": "<webhook address>", "token": "<webhook key>"}` to it. A 400 reply
means a value was wrong and the link still works; a 404 means ask for a new
link. Property Core sends one `installation.test`.
