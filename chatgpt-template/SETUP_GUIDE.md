# Set up Cleaner Core with ChatGPT

ChatGPT runs Cleaner Core through one custom connector and one hourly
scheduled task. You add the connector yourself, and ChatGPT makes the task
during setup. It takes about 15 minutes.

```
You ─► ChatGPT ─► Cleaner Core ─► texts to you and the cleaner
         │            ▲
         │            └─ private pages: the door code and calendar links go here, never in the chat
         └─ the hourly scheduled task checks bookings and messages
```

You talk to ChatGPT. Secrets go straight from your browser to Cleaner Core.
Cleaner Core can't wake ChatGPT when the cleaner texts, so the group text is
how you hear from the cleaner right away (see [Day to day](#day-to-day)).

## Before you start

| What | Why | Where it comes from |
| --- | --- | --- |
| ChatGPT Plus or above | The Free plan has no custom connectors. Plus is tested. Pro, Business, Enterprise, and Edu should work. See [README.md](README.md#which-chatgpt-plans-work). | Your ChatGPT account |
| A computer with a web browser | Developer Mode and custom connectors are set up on chatgpt.com only, not in the apps | — |
| An invite code from Saad | It links your ChatGPT to your own Cleaner Core account. You type it once, when you connect | Saad |
| Your own phone, confirmed with a code when you sign in | Nobody is texted until the host's number is that phone. The cleaner needs no approval: their YES to the first text decides | The connect page. If yours hasn't confirmed a phone yet, the Cleaner Core operator approves it |

The Cleaner Core address is the same for everyone: `https://tourcore-production-8b80.up.railway.app/mcp/cleaner-core`.
Your invite code puts your ChatGPT in your own Cleaner Core account. Other
hosts on the same service never see your property, people, or texts.

## Step 1: Turn on Developer Mode

1. On chatgpt.com, open **Settings → Apps & Connectors** (on some accounts,
   **Connectors**).
2. Click **Advanced** and turn on **Developer Mode**.

On a Business plan, an admin turns it on for themselves; it can't be turned
on for other members.

## Step 2: Add the Cleaner Core connector

ChatGPT offers a plugin or a custom MCP server. Choose **custom MCP server**.
Cleaner Core's own instructions come with the connector, so no plugin is
needed.

| Field | Choose | Why |
| --- | --- | --- |
| Name | Cleaner Core | Any name works; this one matches the guide |
| URL | `https://tourcore-production-8b80.up.railway.app/mcp/cleaner-core` | The Cleaner Core service. Every host and every chat uses this address |
| Authentication | OAuth | The invite code, not the client, decides whose Cleaner Core this is |

Then:

1. Click **Create** (or **Connect**). A page titled **Connect ChatGPT to
   Cleaner Core** opens.
2. Type the invite code from Saad in **Invite code from Saad**, then click
   **Allow**.
3. If your bookings are in Google Calendar, also connect ChatGPT's **Google
   Calendar** app.

Add it only once. If you also want Grok or Claude on the same Cleaner Core
account, ask Saad for another invite code for that chat.

## Step 3: Run setup in a chat

1. Open a new chat.
2. Click **+** in the message box and add **Cleaner Core** to the chat.
   ChatGPT only uses a custom connector that is added to the chat.
3. Say **Set up Cleaner Core**.

ChatGPT asks one question per message, with the choices as buttons:

1. What you want help with: pick scheduling cleaners.
2. The property: business name, address, usual checkout and check-in times.
3. Where bookings come from: Guesty Lite, Google Calendar, or another calendar link.
4. The people: you, the cleaner, and who's in the texts. Pick **A group text
   with me and the cleaner** (the default) to see the cleaner's texts the
   moment they arrive. With texts to the cleaner alone, their messages can
   take up to an hour to reach you.
5. The schedule: how far ahead the cleaner is offered each cleaning, the
   reminder, quiet hours.
6. The locks, then the door code.
7. Supplies, photos, a checklist, and any special instructions.

Secrets never go in the chat. For a calendar link and the door code, ChatGPT
sends a private Cleaner Core link instead. Open it, type the value, click
**Save**, and tell ChatGPT it's saved. Each link works once and expires in 10
minutes. Ask for a new one if it runs out.

ChatGPT may ask you to approve some Cleaner Core actions. Approve the ones
that match what you asked for.

## Step 4: The hourly scheduled task

After the preferences, ChatGPT creates one scheduled task named **Cleaner
Core** that runs every hour, a few minutes past the hour. You don't paste
anything: ChatGPT makes it in the chat, then connects it to Cleaner Core.
Activate is refused until it's connected.

Check it on ChatGPT's scheduled tasks page:

- There is exactly one **Cleaner Core** task, running hourly, and it's on.
- Its prompt matches [routines/cleaner-core-task.md](routines/cleaner-core-task.md).
- Delete any older test task that also calls Cleaner Core.

Before Activate, each run replies **Nothing new.**

## Step 5: Activate and confirm the times

1. ChatGPT summarizes your setup. Reply **Activate**.
2. Cleaner Core reads your calendar, and ChatGPT asks to confirm the times.
   Pick your usual times for all turnovers, or set them one at a time.
3. ChatGPT says what went out. With a group text, the cleaner gets one text
   asking them to reply YES to join. Offers start after they do, one at a
   time.

If ChatGPT says **Nothing was sent yet** and you expected a text, see
[Troubleshooting](#troubleshooting).

## Day to day

| You want to | Do this |
| --- | --- |
| Know when the cleaner writes | Read the group text. It arrives right away. |
| Answer the cleaner | Tell ChatGPT "Maria texted, draft a reply". It reads the message first, drafts, and sends only after your yes. |
| Send the door code | Tell ChatGPT "the guests have left". The code goes only to the approved cleaner. |
| Catch new bookings | Nothing. The hourly task does it. Or say "check my calendars". |
| See what happened overnight | Open the scheduled task's latest run. |

If the hourly task stops, ChatGPT warns you the next time you open a chat
with Cleaner Core: no check has come in for over two and a half hours. Turn
the task back on from the scheduled tasks page.

## Troubleshooting

Every row here came up while testing on ChatGPT Plus.

| What you see | Cause | Fix |
| --- | --- | --- |
| "This tool call was blocked by OpenAI's safety checks" | ChatGPT's own check stopped the call before it reached Cleaner Core | Say "try again". It usually goes through. |
| ChatGPT answers from general knowledge, or asks what Cleaner Core is | Cleaner Core isn't added to this chat | Click **+** and add Cleaner Core, or start a new chat with it added |
| "That invite code isn't right", "has expired", or "was already used" | Each invite code works once, for 7 days | Ask Saad for a new invite code, then click **Connect** again |
| "This connection isn't linked to a Cleaner Core account" | Saad disconnected this chat, or turned the account off | Ask Saad for a new invite code, then remove and add the connector again |
| Alerts go to another chat on your account, not ChatGPT | That chat connected its alerts first, so it is the primary | Ask Saad to make ChatGPT the primary on the admin page |
| Activate says the host's phone isn't confirmed | The host number you saved isn't the phone you confirmed when you signed in | Save that phone as yours, then say "run the checks". If you haven't confirmed one yet, ask the operator to approve your phone |
| Setup finished but no text arrived, or ChatGPT says "Nothing was sent yet" | Live texting is off, or the Twilio details are missing on the service | Tell Saad. The service's variables are in `docs/deployment.md`. |
| The scheduled task paused itself after an error | An older task prompt, or a task made before Cleaner Core was set up | Delete it and ask ChatGPT to create the Cleaner Core task again from setup |
| The cleaner said YES but no group started | Twilio didn't create the group text | The operator checks the deploy log for "Twilio refused … for the group text". The number must support group texts (local, MMS-capable, not toll-free). |
