# Supply Core Grok Bot template (v0.1.0)

> **To start, use [`property-core-template/`](../property-core-template/README.md).**
> Its Grok Bot sets up Supply Core and Cleaner Core from one connection. This
> folder holds the Supply Core guide that bot reads: the standing
> instructions, the routine doc, and the manifest.

Everything a Grok Bot needs to set up and run Supply Core, versioned with the
code. The Grok Bot is the host's chat and does the shopping. Supply Core is the
hosted service that keeps the list, the order log, and the spending rules.

```
Host ─► Grok Bot ─► hosted Supply Core (hostedSupplyCoreUrl/mcp)
            │
            └─ Grok's own shopping tools, product cards, Vault, and routines ─► the store's checkout
```

## How a host starts

New hosts start from [`property-core-template/`](../property-core-template/README.md):
add the Property Core bot or paste its prompt, say "Set up Property Core", and
pick Supply Core for the property. The bot reads
[`SUPPLY_CORE_BOOTSTRAP.md`](../SUPPLY_CORE_BOOTSTRAP.md) and this folder's
routine doc. The paste-in prompt that used to be in
[`SETUP_PROMPT.md`](SETUP_PROMPT.md) moved there.

A host who already runs Cleaner Core doesn't need a new bot either. Their
Cleaner Core bot turns Supply Core on for a property with `set_flows` when they
ask.

## What the bot needs from the host

- A card, Shop Pay, Link, or X Money in their Grok Vault. A card saved in Vault
  fills at checkout without a fresh prompt. To approve every payment, they can
  leave cards unsaved and use stop-at-checkout mode.
- The Supply Core Check routine, which the bot creates during setup.

## Build the team template

New team templates are built from
[`property-core-template/`](../property-core-template/README.md#build-the-team-template),
which covers Supply Core. For a Supply Core-only bot, build it from a clean bot, so nothing from a real setup comes along: enter
[`bot-profile.md`](bot-profile.md), then **Share as Template**. Custom MCP
servers, Vault contents, and secrets never travel with a template.
