# Cleaner Core for Claude (v0.1.0)

> **To start, use [`property-core-template/claude/SETUP_GUIDE.md`](../property-core-template/claude/SETUP_GUIDE.md).**
> It adds one Property Core connector and then follows this folder's Cleaner
> Core guide. This folder holds that guide, the task, and the manifest. Its
> own connector steps below, for a Cleaner Core connector, still work for a
> host who set up that way.

Everything Claude needs to set up and run Cleaner Core. Claude is the host's
chat. Cleaner Core is the hosted service that keeps the records and sends the
texts. The Grok Bot version in [`cleaner-template/`](../cleaner-template/) and
the ChatGPT version in [`chatgpt-template/`](../chatgpt-template/) connect to
the same service.

```
Host ─► Claude ─► hosted Cleaner Core (/mcp/cleaner-core) ─► the cleaner's phone
          │
          └─ Claude's Google Calendar connector, a scheduled task, and vision
```

## What's different from Grok

| | Grok Bot | Claude |
| --- | --- | --- |
| Door code, calendar links, alert key | Grok's secure card, posted from Grok's cloud computer | The host types them on Cleaner Core's own private page, from a one-time link Claude sends |
| Routines | Cleaner Core Check (scheduled) and Cleaner Core Alerts (webhook) | One scheduled task with an hourly schedule and an API trigger ([`routines/cleaner-core-task.md`](routines/cleaner-core-task.md)) |
| Where alerts land | The bot's chat | The scheduled task's run, a session the host can reply in |
| Cleaning photos | Signed links | The same links, plus the photos themselves as images |
| Texts to the host | "Tell your Grok Bot…" | "Tell Claude…" |
| Guide | Cloned from the repo (`CLEANER_CORE_BOOTSTRAP.md`) | The connector's own instructions, plus the `cleaner-core` skill |

Everything else is the same server and the same gates: the setup steps, the
questions, the approval codes, who gets the door code and when, and every
safety rule in [`docs/cleaner-core-safety-gates.md`](../docs/cleaner-core-safety-gates.md).

## The service (Saad, once)

Every host on every chat uses one multi-tenant Cleaner Core service:
`https://tourcore-production-8b80.up.railway.app`. Each host is a tenant with its own folder, secrets, and
Twilio number, so hosts never see each other's records. How it works is in
[`docs/hosted-multitenancy.md`](../docs/hosted-multitenancy.md), and its
Railway variables are in [`docs/deployment.md`](../docs/deployment.md).

To add a host, Saad opens `https://tourcore-production-8b80.up.railway.app/admin`, creates a tenant with the host's
label and Twilio number, and sends the host the invite code. The host types
it on the Cleaner Core page that opens when they connect Claude. A host can
also connect Grok, Claude, or ChatGPT to the same tenant, each with its own
invite code. Texts to the host and the alerts follow the tenant's primary
chat: the first one connected, or the chat that connects its alert routine
when the primary hasn't. Saad can change it on the admin page.

To start a host over, the host asks Claude to reset the property. To remove
a host or one chat's access, Saad uses the admin page.

## How a host starts

The illustrated, step-by-step version is [`SETUP_GUIDE.md`](SETUP_GUIDE.md).

1. In claude.ai, open **Settings → Connectors → Add custom connector**. Name
   it **Cleaner Core** and enter
   `https://tourcore-production-8b80.up.railway.app/mcp/cleaner-core` (the `hostedCleanerCoreUrl` in
   [`template.json`](template.json)).
2. Keep **Sign in now** and the OAuth client Claude detects. Click **Add**.
   On the Cleaner Core page, type the invite code from Saad and click
   **Allow**.
3. Connect Claude's **Google Calendar** connector too, if the bookings are in
   Google Calendar.
4. Optional, for the fullest guide: add the `cleaner-core` skill (below).
5. Say "Set up Cleaner Core".

The connector is shared by claude.ai, the desktop and mobile apps, Cowork,
Claude Code, and the scheduled task. Add it only once: a second connection,
such as `claude mcp add` in Claude Code, needs its own invite code.

## The skill

[`plugin/skills/cleaner-core/SKILL.md`](plugin/skills/cleaner-core/SKILL.md)
is the Claude version of `CLEANER_CORE_BOOTSTRAP.md`. Claude works without it,
because the connector's instructions carry the essentials, but the skill holds
the full guide.

- **Claude Code:** `/plugin marketplace add saadvz/PropertyCore`, then
  `/plugin install cleaner-core@property-core`.
- **claude.ai, desktop, Cowork:** zip the `plugin/skills/cleaner-core` folder
  and upload it in **Settings → Capabilities → Skills**.

The plugin carries only the skill, not a connector, for the reason above.

## What Claude does itself

- Reads only the Google calendar the host says holds the bookings, and passes
  those events to Cleaner Core.
- Sends the host each private upload link, and confirms with `get_state` once
  the host has saved the value there.
- Walks the host through the scheduled task, then reads its runs.
- Looks at the cleaner's photos and summarizes the cleaning in its own words.

Claude never texts anyone. Cleaner Core sends every text, after the host's yes
when a person wrote it.

## What's never in this template

The door code, the scheduled task's Fire URL or token, Cleaner Core or Google
tokens, Twilio details, phone numbers, calendar links, or any live booking or
cleaning record. `test/cleanerClaude.test.ts` fails if a secret pattern, a
phone number outside the 555 test range, or a door code shows up here.

## Files

| File | What it is |
| --- | --- |
| [`SETUP_GUIDE.md`](SETUP_GUIDE.md) | The host's setup guide, with diagrams in [`images/`](images/) |
| [`template.json`](template.json) | Manifest: the deployment, the connectors, the task, and what's never included |
| [`routines/cleaner-core-task.md`](routines/cleaner-core-task.md) | The scheduled task: how to make it, its prompt, and what Cleaner Core sends it |
| [`plugin/`](plugin/) | The Claude plugin, listed by [`/.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) |
| [`plugin/skills/cleaner-core/SKILL.md`](plugin/skills/cleaner-core/SKILL.md) | The skill: setup order, every booking, messages, and rules |

The code side is [`src/cleaner-core/assistant.ts`](../src/cleaner-core/assistant.ts)
(the Claude wording and the switch) and
[`src/cleaner-core/uploadPage.ts`](../src/cleaner-core/uploadPage.ts) (the
private page). `test/cleanerClaude.test.ts` pins both, and pins Grok's
connector instructions byte for byte.
