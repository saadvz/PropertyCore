# Routine: Property Core Check

Wakes the Property Core bot every hour once the account runs separate bots,
so nothing the clock found for the host is missed when a wake-up didn't get
through, and so the host hears when one of their bots has gone quiet. It
carries no webhook address, no key, and no secret.

The Property Core bot creates it when `get_state` first shows `team` with a
core whose `holder` is `own bot`. An account with one bot never needs it.

## Trigger

Scheduled, every hour.

## Instructions for the routine

1. Call `get_state`. If it has no `team`, post nothing and stop.
2. If `check_alerts` isn't in your tool list, refresh the Property Core connector's tool list first: it only appears once a flow has its own bot. Call `check_alerts`. Tell the host each item in `alerts` and `notes` once,
   in your own words. Each is returned only once.
3. For each `team` entry marked `quiet`, tell the host its `note` once a day
   at most, and ask them to open that bot or say it's gone. When the host says
   they removed it, call `remove_bot` with that core as `bot`, in two calls with the
   host's yes, in chat, never from this routine.
4. Post nothing when there's nothing new.
5. Never show an id, a door code, or a token. Never ask another bot for a
   code or an approval.

## Allowed tools

`get_state` and `check_alerts`.
