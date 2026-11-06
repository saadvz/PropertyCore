# Supply Core Grok Bot template (v0.1.0)

Everything a Grok Bot needs to set up and run Supply Core, versioned with the
code. The Grok Bot is the host's chat and does the shopping. Supply Core is the
hosted service that keeps the list, the order log, and the spending rules.

```
Host ─► Grok Bot ─► hosted Supply Core (hostedSupplyCoreUrl/mcp)
            │
            └─ Grok's own shopping tools, product cards, Vault, and routines ─► the store's checkout
```

## How a host starts

1. Open the Supply Core template link and click **Add to Grok Bot**, then
   **Add Bot**. Or open a new Grok Bot and paste [`SETUP_PROMPT.md`](SETUP_PROMPT.md).
2. Say "Set up Supply Core".
3. When the page opens, type the invite code from Saad and click Allow.

A host who already runs Cleaner Core doesn't need this bot. Their Cleaner Core
bot turns Supply Core on for a property with `set_flows` when they ask.

## What the bot needs from the host

- A card, Shop Pay, Link, or X Money in their Grok Vault. A card saved in Vault
  fills at checkout without a fresh prompt. To approve every payment, they can
  leave cards unsaved and use stop-at-checkout mode.
- The Supply Core Check routine, which the bot creates during setup.

## Build the team template

Build it from a clean bot, so nothing from a real setup comes along: enter
[`bot-profile.md`](bot-profile.md), then **Share as Template**. Custom MCP
servers, Vault contents, and secrets never travel with a template.
