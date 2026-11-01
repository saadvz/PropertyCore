# Set up Property Core with ChatGPT

Property Core runs Tour Core (self-guided tours) or Cleaner Core (cleaner
turnovers) on your one number. In ChatGPT you add one connector and, for
updates, one hourly scheduled task.

## Before you start

| What | Why | Where it comes from |
| --- | --- | --- |
| A ChatGPT plan with Developer Mode and scheduled tasks | Custom connectors and tasks need them | Your ChatGPT account |
| An invite code from Saad | It links your ChatGPT to your own number | Saad |

## Step 1: Add the connector

Turn on **Developer Mode**, then add a custom connector named **Property Core**
with the address `https://tourcore-production-8b80.up.railway.app/mcp`. When
the approval page opens, type your invite code and click Allow. This one
connector serves both services.

## Step 2: Pick a service

In a new chat with Property Core attached, say "Set up Property Core".

ChatGPT's instructions for this step: as soon as you're connected, without
waiting to be asked, ask the host exactly "Which do you want to set up: Tour
Core or Cleaner Core?" with two choices: "Tour Core: self-guided tours for a
rental unit" and "Cleaner Core: a cleaner for a property". Don't describe
your tools instead. Call `choose_service` with their pick: `touring` or
`cleaning`. Keep this one connector, and never connect to `/mcp/cleaner-core`,
even when a service's guide names it.

## Step 3: Run the chosen service

- **Tour Core:** ChatGPT calls `get_state` and walks you through your
  property, hours, and tour updates, one question at a time. For tour
  updates, it makes the hourly task in
  [`routines/tour-core-task.md`](routines/tour-core-task.md).
- **Cleaner Core:** follow the Cleaner Core guide in
  [`chatgpt-template/SETUP_GUIDE.md`](../../chatgpt-template/SETUP_GUIDE.md)
  from its setup chat step. Skip its connector step: you already have one.

ChatGPT never asks you to paste a password, key, token, or door code into
chat. When something secret is needed, a tool gives a private page to open
instead.

Your number runs one service at a time. To change it later, ask ChatGPT to
switch.
