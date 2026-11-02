# Set up Property Core with Claude

Property Core runs Tour Core (self-guided tours) or Cleaner Core (cleaner
turnovers) on your one number. In Claude you add one connector and, for tour
updates, make one scheduled task.

## Before you start

| What | Why | Where it comes from |
| --- | --- | --- |
| A Claude Pro, Max, Team or Enterprise plan | Scheduled tasks need one | Your Claude account |
| An invite code from Saad | It links your Claude to your own number | Saad |
| On a Team or Enterprise plan: an Owner | Only Owners add a custom connector | Your Claude admin |

## Step 1: Add the connector

In **Settings → Connectors → Add custom connector**, name it **Property Core**
with the address `https://tourcore-production-8b80.up.railway.app/mcp`. When
the approval page opens, type your invite code, pick **Tour Core** or
**Cleaner Core**, and click Allow. Picking there means your first chat already
has the right tools. This one connector serves both services; don't add a
second.

## Step 2: Add the skill

Install the plugin in [`plugin/`](plugin/). It carries the **property-core**
skill, which tells Claude how to run setup.

## Step 3: Pick a service

In a new chat, say "Set up Property Core". Claude asks "Which do you want to
set up: Tour Core or Cleaner Core?" Pick one.

- **Tour Core:** Claude walks you through your property, hours, the
  property facts visitors ask about (how to apply, fees, lease, and more; each
  can be skipped), and tour updates. For tour updates, make the scheduled task in
  [`routines/tour-core-task.md`](routines/tour-core-task.md).
- **Cleaner Core:** Claude follows the Cleaner Core guide in
  [`claude-template/SETUP_GUIDE.md`](../../claude-template/SETUP_GUIDE.md)
  from its step on calendars. Skip its connector step: you already have one.

Your number runs one service at a time. To change it later, ask Claude to
switch.
