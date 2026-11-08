# Cleaner Core for ChatGPT (v0.1.0)

> **To start, use [`property-core-template/chatgpt/SETUP_GUIDE.md`](../property-core-template/chatgpt/SETUP_GUIDE.md).**
> It adds one Property Core connector and then follows this folder's Cleaner
> Core guide. This folder holds that guide, the task, and the manifest. Its
> own connector steps below, for a Cleaner Core connector, still work for a
> host who set up that way.

Everything ChatGPT needs to set up and run Cleaner Core. ChatGPT is the host's
chat. Cleaner Core is the hosted service that keeps the records and sends the
texts. The Grok Bot version in [`cleaner-template/`](../cleaner-template/) and
the Claude version in [`claude-template/`](../claude-template/) connect to the
same service.

```
Host ─► ChatGPT ─► hosted Cleaner Core (/mcp/cleaner-core) ─► the cleaner's phone
          │
          └─ ChatGPT's Google Calendar app and an hourly scheduled task
```

## What's different from Grok and Claude

| | Grok Bot | Claude | ChatGPT |
| --- | --- | --- | --- |
| Door code, calendar links | Grok's secure card | Cleaner Core's private page | Cleaner Core's private page, same as Claude |
| Routines | Check (scheduled) and Alerts (webhook) | One task: hourly schedule plus API trigger | One hourly task. Nothing can wake it. |
| When the cleaner texts | The webhook wakes the bot | The API trigger wakes the task | The host sees it in the group text right away. ChatGPT reads it on the next hourly run, or at once when the host asks. |
| Cleaning photos | Signed links | Links plus the photos as images | Signed links |
| Texts to the host | "Tell your Grok Bot…" | "Tell Claude…" | "Tell ChatGPT…" |

Everything else is the same server and the same gates: the setup steps, the
questions, the approval codes, who gets the door code and when, and every
safety rule in [`docs/cleaner-core-safety-gates.md`](../docs/cleaner-core-safety-gates.md).

### Why the group text matters here

ChatGPT runs a scheduled task at most once an hour, and has no webhook, so
Cleaner Core can't tell ChatGPT the moment the cleaner writes. The group text
(the default answer at setup, "A group text with me and the cleaner") puts the
cleaner's message on the host's phone right away. The host then says "Maria
texted, draft a reply", and ChatGPT calls `check_now` first to read the actual
message. It saves a draft and shows it with Send, Edit, and Skip. Nothing goes
to the cleaner until the host taps Send. When the host answers in the group
text instead, ChatGPT sees that reply on its next check and drops its draft. A host who picks texts to the cleaner alone is told at setup that
those messages can take up to an hour to reach them.

### If the hourly task stops

A ChatGPT task can pause itself. Once Cleaner Core is live, `get_state` warns
when no check has come in for more than two and a half hours, and ChatGPT
tells the host to turn the task back on. The task's prompt also tells it never
to pause, edit, or delete itself.

## The service (Saad, once)

Every host on every chat uses one multi-tenant Cleaner Core service:
`https://tourcore-production-8b80.up.railway.app`. Each host is a tenant with its own folder, secrets, and
Twilio number, so hosts never see each other's records. How it works is in
[`docs/hosted-multitenancy.md`](../docs/hosted-multitenancy.md), and its
Railway variables are in [`docs/deployment.md`](../docs/deployment.md).

To add a host, Saad opens `https://tourcore-production-8b80.up.railway.app/admin`, creates a tenant with the host's
label and Twilio number, and sends the host the invite code. The host types
it on the Cleaner Core page that opens when they connect ChatGPT. A host can
also connect Grok, Claude, or ChatGPT to the same tenant, each with its own
invite code. Texts to the host and the alerts follow the tenant's primary
chat: the first one connected, or the chat that connects its alert routine
when the primary hasn't. Saad can change it on the admin page.

To start a host over, the host asks ChatGPT to reset the property. To remove
a host or one chat's access, Saad uses the admin page.

## Which ChatGPT plans work

Cleaner Core needs a custom connector (Developer Mode) and an hourly scheduled
task. As of October 2026:

| Plan | Custom connector | Scheduled tasks | Cleaner Core |
| --- | --- | --- | --- |
| Free | No: directory apps only | Reported as 3 tasks, each at most once a day | Doesn't work |
| Plus | Yes | Hourly | Works. Setup, Activate, texting, and the hourly check were tested live on Plus. |
| Pro, Business, Enterprise, Edu | Yes. On Business, an admin turns on Developer Mode for themselves. | Hourly | Should work. Not tested yet. |

Published sources disagree on whether Plus and Pro get write tools in
Developer Mode, and OpenAI changes these limits often. Recheck before telling
a host which plan they need. A Free host can only use Cleaner Core once it is
a published app in ChatGPT's directory, and even then a once-a-day task can't
keep up with new bookings.

## How a host starts

The step-by-step version, with troubleshooting, is
[`SETUP_GUIDE.md`](SETUP_GUIDE.md).

1. On chatgpt.com (web only), open **Settings → Apps & Connectors →
   Advanced** and turn on **Developer Mode**. A custom connector needs it until
   Cleaner Core is published in ChatGPT's app directory.
2. Create a connector named **Cleaner Core** with the URL
   `https://tourcore-production-8b80.up.railway.app/mcp/cleaner-core` and OAuth. On the Cleaner Core page,
   type the invite code from Saad and click **Allow**.
3. Connect ChatGPT's **Google Calendar** app too, if the bookings are in
   Google Calendar.
4. In a new chat, add Cleaner Core from the **+** menu and say "Set up Cleaner
   Core". ChatGPT only calls a custom connector that is added to the chat.

## Known limits

- **Safety blocks.** ChatGPT's own safety check sometimes blocks a tool call
  before it reaches Cleaner Core ("This tool call was blocked by OpenAI's
  safety checks"). Asking again usually works. Cleaner Core never sees the
  blocked call.
- **Developer Mode.** Every host turns it on until Cleaner Core is a
  published ChatGPT app, which waits on hosted multi-tenancy
  ([`docs/hosted-multitenancy.md`](../docs/hosted-multitenancy.md)).
- **Photos.** They stay signed links until ChatGPT is shown to read images in
  a tool result.

## What ChatGPT does itself

- Reads only the Google calendar the host says holds the bookings, and passes
  those events to Cleaner Core.
- Sends the host each private upload link, and confirms with `get_state` once
  the host has saved the value there.
- Creates the hourly scheduled task, then reads its runs.
- Drafts a reply when the host asks, after reading the message with
  `check_now`.

ChatGPT never texts anyone. Cleaner Core sends every text, after the host's
yes when a person wrote it.

## What's never in this template

The door code, Cleaner Core or Google tokens, Twilio details, phone numbers,
calendar links, or any live booking or cleaning record.
`test/cleanerChatGpt.test.ts` fails if a secret pattern, a phone number
outside the 555 test range, or a door code shows up here.
