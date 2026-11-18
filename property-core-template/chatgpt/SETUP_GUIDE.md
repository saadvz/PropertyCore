# Set up Property Core with ChatGPT

Property Core runs your short-term rental's flows from one connector. In
ChatGPT, as a plain chat, that's Cleaner Core (cleaner turnovers) at a basic
level, with one hourly scheduled task. Supply Core needs an always-on agent:
use Grok Bot or Muse for it, from [`../README.md`](../README.md).

## Before you start

| What | Why | Where it comes from |
| --- | --- | --- |
| A ChatGPT plan with Developer Mode and scheduled tasks | Custom connectors and tasks need them | Your ChatGPT account |
| An invite code from Saad | It links your ChatGPT to your own number | Saad |

## Step 1: Add the connector

Turn on **Developer Mode**, then add a custom connector named **Property Core**
with the address `https://tourcore-production-8b80.up.railway.app/mcp`. When
the approval page opens, sign in or type your invite code, and click Allow.
This one connector serves every flow.

## Step 2: Add your property

In a new chat with Property Core attached, say "Set up Property Core".

ChatGPT's instructions for this step: call `get_state` first. With no property
yet, ask the host for the property's address and call `add_property` with it,
then `set_flows` with the property and `cleaning` true for Cleaner Core. With
more than one property, name the property in every property tool call with its
id from `get_state`. Keep this one connector, and never connect to
`/mcp/cleaner-core`, even when a service's guide names it. Where a guide or a
tool names the Cleaner Core connector, it means this Property Core
connector. Touring is parked:
only Saad makes an account a touring account.

## Step 3: Set up Cleaner Core

Follow the Cleaner Core guide in
[`chatgpt-template/SETUP_GUIDE.md`](../../chatgpt-template/SETUP_GUIDE.md)
from its setup chat step. Skip its connector step: you already have one.

Tour Core is parked. Only an account Saad has made a touring account gets it,
and then ChatGPT makes the hourly task in
[`routines/tour-core-task.md`](routines/tour-core-task.md).

## The hours log

When the hours log is on, you can ask ChatGPT for a month of your hours and
have it written to your own spreadsheet.

ChatGPT's instructions for the hours log: follow these only when
`review_hours` is among your tools. When the host asks for their hours or a
month's log, call `review_hours` with the property and the month. Show each
log's rows and every line in `needs`, ask its question, and call it again
with the code only after their yes. Then call `export_hours` and write each
log, exactly as given, to the spreadsheet the host already uses with you:
Google Sheets, Excel, or another. If none is connected, ask the host where
they want the log written. Then call `export_hours` again with
`stored: true`. Save their activity codes, minutes, columns, owner name and
spreadsheet with `save_hours_settings`, only as the host says. Never give
tax advice, or say what counts toward any tax test. That's for the host and
their advisor.

## Always

ChatGPT never asks you to paste a password, key, token, or door code into
chat. When something secret is needed, a tool gives a private page to open
instead.
