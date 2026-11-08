# Cleaner Core Grok Bot template (v0.2.0)

> **To start, use [`property-core-template/`](../property-core-template/README.md).**
> Its Grok Bot sets up Cleaner Core and Supply Core from one connection. This
> folder holds the Cleaner Core guide that bot reads: the standing
> instructions, the routine docs, and the manifest. A bot added from the
> Cleaner Core team template before the change keeps working as it is.

Everything a Grok Bot needs to set up and run Cleaner Core, versioned with the
code. The Grok Bot is the host's chat. Cleaner Core is the hosted service that
keeps the records and sends the texts.

```
Host ─► Grok Bot ─► hosted Cleaner Core (hostedCleanerCoreUrl/mcp/cleaner-core) ─► the cleaner's phone
            │
            └─ Grok's own Google Calendar connector, secure card, routines, and vision
```

## How a host starts

New hosts start from [`property-core-template/`](../property-core-template/README.md)
and pick Cleaner Core for their property. The steps below are for a bot added
from the older Cleaner Core team template, which still works:

1. Open the Cleaner Core template link and click **Add to Grok Bot**, then
   **Add Bot**.
2. Say "Set up Cleaner Core".
3. When the Cleaner Core page opens, type the invite code from Saad and click
   Allow.

The paste-in prompt that used to be in [`SETUP_PROMPT.md`](SETUP_PROMPT.md)
moved to [`property-core-template/SETUP_PROMPT.md`](../property-core-template/SETUP_PROMPT.md).

Either way, Grok clones the repository only to read
[`CLEANER_CORE_BOOTSTRAP.md`](../CLEANER_CORE_BOOTSTRAP.md) and the routine
docs, so a bot always follows the current guide, not a copy frozen when the
template was shared. Then it asks the setup questions one at a time. The host
never leaves the chat.

## Build the team template

New team templates are built from
[`property-core-template/`](../property-core-template/README.md#build-the-team-template).
These steps are kept for rebuilding the older Cleaner Core template.

A Grok Bot template is made from a configured bot: **Share as Template**
packages its profile, instructions, skills, standard plugins, and routines. It
leaves out custom MCP servers, code, and secrets. Build it from a clean bot so
nothing from a real setup comes along.

1. Create a new Grok Bot. Don't chat with it.
2. In **Bot actions → Edit Profile**, enter the name, title, and description
   from [`bot-profile.md`](bot-profile.md), and paste its **Standing
   instructions** section as the bot's instructions. Add the suggested
   starting prompts.
3. Don't connect Cleaner Core, don't create the routines, and don't run setup.
   Each installed bot connects with its host's own invite code and creates its
   own routines during setup. The template bot has no invite code.
4. Open the bot's settings and click **Share as Template**. In **View
   Details**, check that it has the instructions and nothing else: no
   memories, no integrations, no routines.
5. Choose **Team** and click **Publish**. Share the link with the team.
6. Test it: add the template as a new bot, say "Set up Cleaner Core", and check
   that it connects to the hosted service and starts the setup questions.

Update the template only when `bot-profile.md` changes. Changes to the guide
or the routine docs reach every bot on its next setup without re-sharing.

### Demos

The hosted Cleaner Core serves many hosts. Each host is a tenant that Saad adds
on `https://tourcore-production-8b80.up.railway.app/admin`, with its own Twilio number and invite code.
To demo again:

- With the same bot: ask it to reset the property (`reset_property`), then
  set up again.
- With a new bot: Saad makes a new invite code on the admin page, or a new
  tenant for a separate demo, and the new bot connects with it.

## What's in the template

| Part | File | How it gets into Grok Bot |
| --- | --- | --- |
| Where the paste-in prompt went | `SETUP_PROMPT.md` | Points to `property-core-template/SETUP_PROMPT.md`, the one prompt for every flow |
| Profile and standing instructions | `bot-profile.md` | Bot actions → Edit Profile, and the Bot's instructions. They name the repository and the hosted address, so the template needs no paste-in prompt |
| Routine: Cleaner Core Check | `routines/cleaner-core-check.md` | Grok creates it before Activate (scheduled trigger) |
| Routine: Cleaner Core Alerts | `routines/cleaner-core-alerts.md` | Grok creates it before Activate (authenticated webhook trigger) |
| Manifest | `template.json` | For reviewers. It lists every item and what's never included |

`test/setupEntryPoint.test.ts` checks that `SETUP_PROMPT.md` points to the
Property Core prompt and holds no prompt of its own.

## What Grok does itself

- Reads only the Google calendar the host says holds the bookings, with its
  own connector, and passes those events to Cleaner Core.
- Takes the door code on its secure card. Sends the Alerts routine's address
  and key to a one-time upload link from its own cloud computer.
- Runs its own scheduled and webhook routines.
- Looks at the cleaner's photos and summarizes the cleaning in its own words.

Grok never texts anyone. Cleaner Core sends every text, after the host's yes
when a person wrote it.

## What's never in the template

The door code, the Alerts routine's webhook address or token, Cleaner Core or
Google tokens, Twilio details, phone numbers, calendar links, or any live
booking or cleaning record. `test/cleanerTemplate.test.ts` fails if a secret
pattern, a phone number outside 555-01xx, or a door-code-like number shows up
here or in `CLEANER_CORE_BOOTSTRAP.md`.

Custom MCP servers and credentials don't travel with a Grok Bot template. Each
host connects with their own invite code and creates their own routines.

## Admin prep (the operator, once)

The service runs in deployment mode `HOSTED_RAILWAY_P0` with
`CLEANER_CORE_MULTI_TENANT=1` and OAuth on (`TOURCORE_MCP_AUTH_MODE` unset or
`oauth`, never `static`), or the Allow page never appears. Its variables are in
[`docs/deployment.md`](../docs/deployment.md).
