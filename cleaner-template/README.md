# Cleaner Core Grok Bot template (v0.2.0)

Everything a Grok Bot needs to set up and run Cleaner Core, versioned with the
code. The Grok Bot is the host's chat. Cleaner Core is the hosted service that
keeps the records and sends the texts.

```
Host ─► Grok Bot ─► hosted Cleaner Core (hostedCleanerCoreUrl/mcp/cleaner-core) ─► the cleaner's phone
            │
            └─ Grok's own Google Calendar connector, secure card, routines, and vision
```

## How a host starts

From the team template (the usual way):

1. Open the Cleaner Core template link and click **Add to Grok Bot**, then
   **Add Bot**.
2. Say "Set up Cleaner Core".
3. When the Cleaner Core page opens, type the invite code from Saad and click
   Allow.

Without the template, open a new Grok Bot and paste the prompt in
[`SETUP_PROMPT.md`](SETUP_PROMPT.md) instead.

Either way, Grok clones the repository only to read
[`CLEANER_CORE_BOOTSTRAP.md`](../CLEANER_CORE_BOOTSTRAP.md) and the routine
docs, so a bot always follows the current guide, not a copy frozen when the
template was shared. Then it asks the setup questions one at a time. The host
never leaves the chat.

## Build the team template

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
| The paste-in prompt | `SETUP_PROMPT.md` | Fallback without the template: the host pastes it into a new Grok Bot |
| Profile and standing instructions | `bot-profile.md` | Bot actions → Edit Profile, and the Bot's instructions. They name the repository and the hosted address, so the template needs no paste-in prompt |
| Routine: Cleaner Core Check | `routines/cleaner-core-check.md` | Grok creates it before Activate (scheduled trigger) |
| Routine: Cleaner Core Alerts | `routines/cleaner-core-alerts.md` | Grok creates it before Activate (authenticated webhook trigger) |
| Manifest | `template.json` | For reviewers. It lists every item and what's never included |

`SETUP_PROMPT.md` is pinned by `test/cleanerTemplate.test.ts`. Change it only
on purpose, and update the pin in the same change.

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
