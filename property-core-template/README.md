# Property Core Grok Bot template (v0.1.0)

One Grok Bot for both hosted services. The host picks one for their number:

- **Tour Core**: visitors text the number to book a self-guided tour of a
  rental unit.
- **Cleaner Core**: the cleaner's turnovers, run from the host's booking
  calendars.

```
Host ─► Grok Bot ─► hosted service (hostedPropertyCoreUrl/mcp) ─┬─► Tour Core ─► visitors' phones
                                                                  └─► Cleaner Core ─► the cleaner's phone
```

The bot connects once, to `/mcp`, and asks "Which do you want to set up: Tour
Core or Cleaner Core?" right away. After the host picks, it follows that
service's own guide: [`GROK_BOOTSTRAP.md`](../GROK_BOOTSTRAP.md) and
[`grok-template/bot-profile.md`](../grok-template/bot-profile.md) for Tour
Core, or [`CLEANER_CORE_BOOTSTRAP.md`](../CLEANER_CORE_BOOTSTRAP.md) and
[`cleaner-template/bot-profile.md`](../cleaner-template/bot-profile.md) for
Cleaner Core. It skips their connect step, since it's already connected.

This template doesn't replace [`grok-template/`](../grok-template/) or
[`cleaner-template/`](../cleaner-template/). Those still set up one service
each.

The published team template: https://x.ai/bot/rfmREJxrfqNuTiOs2VqYQ

The same bot for the other chats is in [`claude/`](claude/SETUP_GUIDE.md),
[`chatgpt/`](chatgpt/SETUP_GUIDE.md), and [`muse/`](muse/SETUP_PROMPT.md).

## How a host starts

Saad first adds the host as a tenant on
`https://tourcore-production-8b80.up.railway.app/admin`, with their Twilio
number. That gives an invite code and the connector address, which ends in
`/mcp`. Nothing about the service is set there: the host picks it in chat.

From the team template (the usual way):

1. Open the Property Core template link and click **Add to Grok Bot**, then
   **Add Bot**.
2. Say "Set up Property Core".
3. When the approval page opens, type the invite code from Saad, pick Tour
   Core or Cleaner Core, and click Allow. If they skip the pick, the bot asks
   in chat instead.

Without the template, open a new Grok Bot and paste the prompt in
[`SETUP_PROMPT.md`](SETUP_PROMPT.md) instead.

The number runs one service at a time. To change it later, the host asks the
bot to switch; it stands the current service down first if anything is live.

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
3. Add the seven Tour Core skills listed in [`template.json`](template.json).
   Cleaner Core has no skills; its guide is read at setup.
4. Don't connect the service, don't create any routines, and don't run setup.
   Each installed bot connects with its host's own invite code and creates
   only its chosen service's routines during setup.
5. Open the bot's settings and click **Share as Template**. In **View
   Details**, check that it has the instructions and skills and nothing else:
   no memories, no integrations, no routines.
6. Choose **Team** and click **Publish**. Share the link with the team.
7. Test it: add the template as a new bot, say "Set up Property Core", and
   check that it connects and asks Tour Core or Cleaner Core before anything
   else.

Update the template only when `bot-profile.md` or the skills change. Changes to
the services' guides and routine docs reach every bot on its next setup without
re-sharing.
