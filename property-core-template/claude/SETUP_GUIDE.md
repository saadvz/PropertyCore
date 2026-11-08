# Set up Property Core with Claude

Property Core runs your short-term rental's flows from one connector. In
Claude, as a plain chat, that's Cleaner Core (cleaner turnovers) at a basic
level. Supply Core needs an always-on agent: use Grok Bot or Muse for it, from
[`../README.md`](../README.md).

## Before you start

| What | Why | Where it comes from |
| --- | --- | --- |
| A Claude Pro, Max, Team or Enterprise plan | Scheduled tasks need one | Your Claude account |
| An invite code from Saad | It links your Claude to your own number | Saad |
| On a Team or Enterprise plan: an Owner | Only Owners add a custom connector | Your Claude admin |

## Step 1: Add the connector

In **Settings → Connectors → Add custom connector**, name it **Property Core**
with the address `https://tourcore-production-8b80.up.railway.app/mcp`. When
the approval page opens, sign in or type your invite code, and click Allow.
This one connector serves every flow; don't add a second.

## Step 2: Add the skill

Install the plugin in [`plugin/`](plugin/). It carries the **property-core**
skill, which tells Claude how to run setup. Add the **cleaner-core** skill
too: it's Cleaner Core's full guide.

- **Claude Code:** run `/plugin marketplace add saadvz/PropertyCore`, then
  `/plugin install property-core@property-core` and
  `/plugin install cleaner-core@property-core`.
- **claude.ai, desktop, Cowork:** zip the
  `property-core-template/claude/plugin/skills/property-core` and
  `claude-template/plugin/skills/cleaner-core` folders from
  [the repository](https://github.com/saadvz/PropertyCore), one zip each, and
  upload both in **Settings → Capabilities → Skills**.

## Step 3: Add your property

In a new chat, say "Set up Property Core". Claude asks for your property's
address, adds it, and turns on Cleaner Core for it. Have more than one
property? Add each one the same way.

Claude then follows the Cleaner Core guide in
[`claude-template/SETUP_GUIDE.md`](../../claude-template/SETUP_GUIDE.md) from
its setup chat step. Skip its connector and skill steps: you already have
both. Where it says **Cleaner Core** for the connector, yours is **Property
Core**.

Tour Core is parked. Only an account Saad has made a touring account gets it,
and then the tour updates task is in
[`routines/tour-core-task.md`](routines/tour-core-task.md).
