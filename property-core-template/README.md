# Start here: set up Property Core (v0.2.0)

This folder is the one way to start Property Core. Pick your agent, follow its
file, and the agent sets up every flow from there. Grok Bot and Muse are the
supported agents: both are always on and run Cleaner Core and Supply Core end
to end.

| Your agent | Start with | Flows it sets up |
| --- | --- | --- |
| **Grok Bot** | The Property Core team template, https://x.ai/bot/rfmREJxrfqNuTiOs2VqYQ, or the prompt in [`SETUP_PROMPT.md`](SETUP_PROMPT.md) | Cleaner Core, Supply Core |
| **Muse** (beta) | The prompt in [`muse/SETUP_PROMPT.md`](muse/SETUP_PROMPT.md) | Cleaner Core, Supply Core |
| Claude, as a plain chat | [`claude/SETUP_GUIDE.md`](claude/SETUP_GUIDE.md) | Cleaner Core, at a basic level |
| ChatGPT, as a plain chat | [`chatgpt/SETUP_GUIDE.md`](chatgpt/SETUP_GUIDE.md) | Cleaner Core, at a basic level |

The flows:

- **Cleaner Core:** the cleaner's turnovers, run from the host's booking
  calendars. The cleaner gets the door code only after the host says the
  guests have left.
- **Supply Core:** the property kept stocked. The host picks each product
  once, the agent shops and checks out with its own tools, and Supply Core
  decides go or hold on every cart.
- **Fixer Core** (repairs and upkeep) comes next. It isn't offered yet.

```
Host ─► Grok Bot or Muse ─► hosted service (hostedPropertyCoreUrl/mcp) ─┬─► Cleaner Core ─► the cleaner's phone
                                                                         └─► Supply Core ─► go or hold on each cart
```

The agent connects once, to `/mcp`, and calls `get_state`. It adds the host's
properties with `add_property` and turns Cleaner Core or Supply Core on for
each with `set_flows`. For each flow it then follows that flow's own guide,
skipping the guide's connect step, since it's already connected:

| Flow | Grok Bot reads | Muse saves the skill |
| --- | --- | --- |
| Cleaner Core | [`CLEANER_CORE_BOOTSTRAP.md`](../CLEANER_CORE_BOOTSTRAP.md) and [`cleaner-template/`](../cleaner-template/) | [`muse-template/skills/cleaner-core`](../muse-template/skills/cleaner-core/SKILL.md) |
| Supply Core | [`SUPPLY_CORE_BOOTSTRAP.md`](../SUPPLY_CORE_BOOTSTRAP.md) and [`supply-template/`](../supply-template/) | [`muse-template/skills/supply-core`](../muse-template/skills/supply-core/SKILL.md) |

Those folders hold the flow guides and routine docs the agents read. They are
not separate ways to start, and their old paste-in prompts point back here.
Claude and ChatGPT read the Cleaner Core guides in
[`claude-template/`](../claude-template/) and
[`chatgpt-template/`](../chatgpt-template/) the same way.
[`docs/client-matrix.md`](../docs/client-matrix.md) shows what each agent does
differently. Step-by-step pages for hosts are in `docs/`:
[Grok](../docs/property-core-grok-setup.html),
[Muse](../docs/property-core-muse-setup.html),
[Claude](../docs/property-core-claude-setup.html), and
[ChatGPT](../docs/property-core-chatgpt-setup.html).

## How a host starts

Saad first adds the host as a tenant on
`https://tourcore-production-8b80.up.railway.app/admin`, with their Twilio
number. That gives an invite code and the connector address, which ends in
`/mcp`. Where sign-up is open, the host can create the account on the approval
page instead, with a code texted to their phone.

From the Grok team template (the usual way):

1. Open the Property Core template link and click **Add to Grok Bot**, then
   **Add Bot**.
2. Say "Set up Property Core".
3. When the approval page opens, sign in or type the invite code from Saad,
   and click Allow.
4. Give the bot the property's address, and pick Cleaner Core, Supply Core, or
   both. The bot asks the rest one question at a time.

Without the template, open a new Grok Bot and paste the prompt in
[`SETUP_PROMPT.md`](SETUP_PROMPT.md) instead. On Muse, paste
[`muse/SETUP_PROMPT.md`](muse/SETUP_PROMPT.md) into a new chat.

A host can turn a flow on or off for any property later, or add another
property, by asking the agent.

## Tour Core is parked

New accounts don't get touring. Only Saad makes an account a touring account,
on `/admin`, and then `get_state` shows Tour Core instead. The touring files
stay for those accounts and are marked parked: the Tour Core task in each of
[`claude/routines/`](claude/routines/tour-core-task.md),
[`chatgpt/routines/`](chatgpt/routines/tour-core-task.md), and
[`muse/skills/property-core/references/`](muse/skills/property-core/references/tour-core-task.md),
and the seven Tour Core skills the Grok template carries. Touring's guide is
[`docs/tour-core/README.md`](../docs/tour-core/README.md).

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
3. Add the seven Tour Core skills listed in [`template.json`](template.json),
   for touring accounts. Cleaner Core and Supply Core have no skills; their
   guides are read at setup.
4. Don't connect the service, don't create any routines, and don't run setup.
   Each installed bot connects with its host's own invite code and creates
   only its chosen flows' routines during setup.
5. Open the bot's settings and click **Share as Template**. In **View
   Details**, check that it has the instructions and skills and nothing else:
   no memories, no integrations, no routines.
6. Choose **Team** and click **Publish**. Share the link with the team, and
   update `templateLink` in [`template.json`](template.json) if it changed.
7. Test it: add the template as a new bot, say "Set up Property Core", and
   check that it connects, adds a property, and offers Cleaner Core and Supply
   Core before anything else.

Update the template only when `bot-profile.md` or the skills change. Changes to
the flows' guides and routine docs reach every bot on its next setup without
re-sharing.
