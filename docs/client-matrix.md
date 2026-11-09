# Client matrix

Property Core runs on always-on agents. Today those are **Grok Bot** and
**Muse**. Both run Cleaner Core and Supply Core end to end, and Fixer Core
on a service with `FIXER_CORE=1`. Claude's and ChatGPT's agent products join this list
when they're generally available.

Claude and ChatGPT as plain chats keep working at a basic level: Cleaner Core,
without Supply Core or Fixer Core. Asked for either, a plain chat gets one line
saying it works with Grok Bot and Muse, and Cleaner Core goes on as before.

Every agent talks to the same server and passes the same gates. Only the words,
the formats, and how the agent hears news change. Nothing here adds a tool
that skips a gate.

## Property Core flows

| | Grok Bot | Muse | Claude (plain chat) | ChatGPT (plain chat) |
| --- | --- | --- | --- | --- |
| Support | Full | Full, beta: last live checks in [`muse-template/README.md`](../muse-template/README.md#before-a-host-uses-this) | Basic | Basic |
| Start with | [`property-core-template/`](../property-core-template/README.md): the team template, or its [prompt](../property-core-template/SETUP_PROMPT.md) | [`property-core-template/muse/SETUP_PROMPT.md`](../property-core-template/muse/SETUP_PROMPT.md); Muse creates the connector | [`property-core-template/claude/`](../property-core-template/claude/SETUP_GUIDE.md): add the connector in settings | [`property-core-template/chatgpt/`](../property-core-template/chatgpt/SETUP_GUIDE.md): add the connector in settings |
| Sign-in host | Any other host | `agent.meta.ai` | `claude.ai` | `chatgpt.com` |
| Guide | [`CLEANER_CORE_BOOTSTRAP.md`](../CLEANER_CORE_BOOTSTRAP.md), [`SUPPLY_CORE_BOOTSTRAP.md`](../SUPPLY_CORE_BOOTSTRAP.md) | The `cleaner-core` and `supply-core` skills in [`muse-template/skills/`](../muse-template/skills/) | The connector's instructions and Claude's skill | The connector's instructions |
| Questions with options | Choice cards | Choice cards | A short list | A short list |
| Door code, calendar link | Grok's secure card, posted from its cloud computer | The private page, opened in Muse's browser; the host types there | The private page, from a link | The private page, from a link |
| How it hears the cleaner | The Alerts routine's webhook wakes it | One recurring task, as often as the host picks (every 5 minutes suggested) | An hourly task plus an API trigger that wakes it | An hourly task |
| Cleaning photos | Signed links | Signed links, opened in its browser | Images | Signed links |
| **Cleaner Core** | Yes | Yes | Yes | Yes |
| **Supply Core** | Yes | Yes | No | No |
| Where it shops | Grok's shopping tools and product cards | Its own cloud browser | | |
| Store sign-in | A saved login in Vault, or the store's connector | The host signs in on Muse's browser | | |
| Payment | A card, Shop Pay, Link, or X Money in Vault | The payment method saved on the store account | | |
| When the host must pay | Grok's approval card: `approvedBy: "grok-card"` | The host places the order in Muse's browser: `approvedBy: "host-browser"` | | |
| Daily supply check | The Supply Core Check routine | The Supply Core recurring task | | |
| Cleaner's "running low" answer | The Alerts routine shops right away | The Cleaner Core task shops right away | | |
| **Fixer Core** | Yes | Yes | No | No |
| Where it finds pros | Grok's own search | Its own cloud browser | | |
| Calling a pro | Grok's own call, email or message tools | Muse's own call, email or message tools | | |
| Door code for a pro | The text line if they text (opted in), else the visit page. Never in chat | The same | | |
| Calendar link, new door code | Grok's secure card, from its cloud computer | The private page, opened in Muse's browser; the host types there | | |
| Repair check | `check_fixes` on every run of the Alerts routine | `check_fixes` on every run of the recurring task | | |
| Guide | [`FIXER_CORE_BOOTSTRAP.md`](../FIXER_CORE_BOOTSTRAP.md) | The `fixer-core` skill in [`muse-template/skills/`](../muse-template/skills/) | | |

Fixer Core has no partner network in v1: each agent finds pros with its own
search. Both contact only a pro the host approved, never confirm a held time
to the pro before the host's yes, and send the visit link only to the pro's
own email or phone. No Fixer Core tool takes a card number or a door code, and
no Core moves money. In a plain chat, Fixer Core answers with one line that it
works with Grok Bot and Muse, and Cleaner Core goes on as before.

Every Supply Core cart goes through `check_cart` before Place Order, on both
agents. A held cart waits for the host's yes in chat and `approve_cart`'s
code. Card details never reach Supply Core: `check_cart` and every other tool
refuse anything that looks like a card number.

## Agent profiles

The server picks each agent's words from its profile in
[`src/cleaner-core/assistant.ts`](../src/cleaner-core/assistant.ts).
`test/propertyClientMatrix.test.ts` checks this table against the code.

| Agent | `privatePages` | `photoImages` | `polledTask` | `supplies` | `fixer` |
| --- | --- | --- | --- | --- | --- |
| grok | no | no | no | yes | yes |
| muse | yes | no | yes | yes | yes |
| claude | yes | yes | no | no | no |
| chatgpt | yes | no | yes | no | no |

- `privatePages`: a secret goes on Cleaner Core's private page from a one-time link, since there's no secure card.
- `photoImages`: `get_job_photos` also returns the photos as images.
- `polledTask`: one recurring task that nothing outside the agent can wake.
- `supplies`: an always-on agent that shops and checks out itself, so it runs Supply Core.
- `fixer`: an always-on agent that finds, calls and books repair pros itself, so it runs Fixer Core.

## Urgent alerts on an agent that can't be woken

Muse (like ChatGPT) has no webhook, so nothing can wake it. The host runs
everything from their agent, so urgent news never depends on a text to the
host:

1. The recurring task finds it at its next run. Setup suggests every 5
   minutes, and the host can pick every minute.
2. A run puts anything urgent first in its reply: an injury, a problem that
   could stop the cleaning, STOP, a decline, a text that may not have gone
   out, or the checkout nudge. The agent shows the host each run's reply.
3. A run with nothing for the host says only "Nothing new.", so a reply from
   the task means something.
4. With a group text, the host sees the cleaner's words as they're sent.
5. No safety rule waits on a check: the door code goes only after the host's
   yes, and a cleaning is never paused because of how a message sounds. A
   slower check delays an answer, never a gate.
6. When no check has come in for two and a half hours, `get_state` warns,
   and the agent tells the host to turn the task back on.

## Tour Core eval matrix

The eval matrix runs Tour Core's safety gates and the ten-duplex config diff once for each client, over the MCP connectors. A client's playbook follows that client's name and capabilities. It is not cut down to the weakest client. The client name does not add a tool or skip a gate. Muse has no Tour Core playbook yet, so it gets the baseline.

### Clients

| Client | `clientInfo.name` | Capabilities | Profile | What that profile adds |
| --- | --- | --- | --- | --- |
| Grok | `Grok` | elicitation, sampling, and roots | Grok, full | Notes in the agent's own memory, the masked card for the texting login, the agent's own folder for the portable copy, more than one setup step in a chat, and the tour-update wake. |
| ChatGPT | `ChatGPT` | elicitation | ChatGPT, tools | One step at a time and the secure setup link. Elicitation does not turn this profile into the full one. There is no wake. |
| Claude | `claude-ai` | elicitation, sampling, and roots | Claude, full | Keeping the playbook in a project, the secure setup link, and a draft only when the landlord asks for one. There is no wake. |
| Unknown | `example-client` | tools only | Baseline, tools | One step at a time, the secure setup link, and nothing filled in. Elicitation on an unknown name would still be this profile. |
| Spoofed | `grok` | tools only | Baseline, tools | Nothing beyond the unknown client. A grok name that declares only tools does not unlock the full playbook. |

A grok or Cursor name with no capabilities, or with only `prompts` or `resources`, still gets the full Grok playbook. That is how those clients connect. A saved OAuth name that selects a playbook still gets full, including when the initialize in front of us is baseline or has no name. `prompts` and `resources` do not count as a declared set.

Tool lists stay 21 on the landlord connector, 22 for the hosted owner (`reset_hosted_demo`), 15 on QA, and 13 on ops.

### Safety gates

Each client has to pass all of these:

- Landlord, hosted-owner, QA, and ops tool lists, including annotations
- A landlord call to a QA tool is refused
- Publish and remove ask for a yes before anything changes
- The practice tour's safety checks hold: early arrival denied, an off-route door turned away, a repeat request does not grant access twice
- `initialize` instructions match, and they say a client name never changes a rule
- The playbook matches the profile in the table
- The ten duplexes at 18 Maple Street store the same config (zero fields differ)

The spoofed client is also compared with the unknown client. Playbook text, tool lists, gate results, and the stored duplex config have to match.

### Run it

```bash
npx vitest run --config vitest.eval.config.ts test/eval/clientMatrix.test.ts
```

`npm run test:eval` runs this file with the rest of the eval harness. `npm test` does not.
