# Touring on Claude, ChatGPT, and Muse

Date: 2026-11-01. Status: approved in chat, awaiting review of this spec.

## Goal

A host on Claude, ChatGPT, or Muse connects to the shared service at `/mcp`,
picks Tour Core, sets up a property, publishes, and visitors book by text, the
same way it already works on Grok. Cleaner Core's handling of each platform is
the standard: a private page where Grok uses its secure card, a Fire URL task on
Claude, and a recurring task on ChatGPT and Muse.

Success: an end-to-end run on each platform with a 555 number, through the
shared service, matching what Grok does today.

## Decisions from the brainstorm

- **Approach A.** The shared service owns everything that differs by platform:
  how tour updates connect, texts to the host, and the "what's new" list for
  tasks that can't be woken. The touring process stays the same for every
  platform, apart from wording it already picks by the chat's name.
- **Host texts on every platform.** The host chooses **Urgent only**,
  **Everything**, or **No texts**. Setup says each platform's limit plainly.
- **Property Core template per platform.** Claude, ChatGPT, and Muse get a
  Property Core template like Grok's. The Cleaner Core-only templates stay.

## 1. Connecting tour updates

`save_alert_routine` stays the one tool. What it does depends on the calling
connection's chat, which the shared service knows from the sign-in.

| Chat | What `save_alert_routine` does | Tested when |
| --- | --- | --- |
| Grok | One-time link. Grok posts the routine's webhook address and key from its own computer. Unchanged. | The test update sent on connect is delivered. |
| Claude | One-time link to a private page. The host makes a scheduled task with an API trigger and pastes its Fire URL and token into the form. Values never enter chat. | The test update sent on connect is delivered. |
| ChatGPT, Muse | Called with no arguments after the chat creates the recurring task. Nothing secret, no link. | Connecting is enough: nothing can wake the task, so there is no test update. |

- Claude's events go through the existing Fire URL sink.
- ChatGPT and Muse events go to the "what's new" list (section 3).
- Publishing still waits until updates are connected, on every platform.
- A connection belongs to one chat. Events go to the primary chat's connection,
  as today.

## 2. Texts to the host's phone

**Setup.** After tour updates connect, `save_alert_routine`'s reply tells the
chat to ask one question as a choice card: "Want tour updates texted to your
phone too?"

- The options are **Urgent only**, **Everything**, and **No texts**.
- The suggested pick is **Urgent only** on ChatGPT and Muse, and **No texts**
  on Grok and Claude.
- On ChatGPT and Muse, the question states the platform's limit. For example:
  "ChatGPT checks for updates at most once an hour, so a text gets you there
  sooner." Muse runs whenever the host sets.
- If the host wants texts, the chat asks for their phone in chat and calls a
  new front tool, `save_host_texts`, with `phone` and `which` (`urgent`, `all`,
  or `off`).
- The host can change it anytime by asking.

**Urgent:** `tour.time_requested`, `exception.created`, `access.problem`, and
`verification.problem`. **Everything** adds `tour.booked`, `tour.started`,
`tour.completed`, and `tour.cancelled`. `installation.test` is never texted.

**What a text says.** No visitor name or number, matching the routine's
wake-ups:

- Time request: "Tour Core: a visitor asked for a tour time. Open your chat to
  answer."
- A problem: "Tour Core: something on a tour needs you. Open your chat."
- Routine: "Tour Core: a tour was booked." (or started, finished, cancelled)

**Sending.**

- Texts go from the tenant's own number through the shared Twilio account.
- They follow `CLEANER_CORE_LIVE_SMS` and `CLEANER_CORE_SMS_ALLOWLIST`, like
  every other text.
- Each event is texted at most once.
- A failed text is logged without the phone number and retried at most once.
  It never holds up the routine's delivery or the "what's new" list.
- On a 555 Scratch tenant, texts go to the Scratch outbox, never a phone.

**Stored** once per tenant, in the shared service's tenant folder: the phone,
the choice, and the IDs of events already texted.

**The host texting their own number.**

- The shared service recognizes the saved host phone. It never hands that text
  to touring as a visitor, and replies once: "This is your Tour Core number.
  Open your chat to manage tours."
- STOP from the host's phone turns host texts off, using the existing
  opt-outs. START turns them back on.
- HELP and injury texts still route as they do today.

**Validation.** `save_host_texts` refuses a phone that isn't a full phone
number or is the tenant's own number. On a live tenant it also refuses a 555
number. On a Scratch tenant it takes only a 555 number (AGENTS.md).

## 3. The "what's new" list, Claude's page, and per-platform wording

**The list.**

- The shared service keeps a short list of each touring tenant's events: type,
  when, and event ID. It holds the last 7 days, up to 200 events.
- For a ChatGPT or Muse connection, delivering an event means adding it to the
  list and sending any host text. It is acknowledged to the touring process
  right away.
- `get_updates`, a new touring front tool, returns that connection's unread
  events, oldest first. Each comes with a plain line, like "A visitor asked
  for a tour time." The call marks them read.
- Each connection has its own read marker.

**The task's prompt** (in each template's touring task doc) says:

1. Call `get_updates`.
2. For anything urgent, call `get_inbox` and post the details in your own
   short words.
3. Post a one-line summary of routine updates.
4. Say nothing if there's nothing new.

**A stopped task.**

- Each `get_updates` call records when it ran.
- Once a property is published and the primary chat is ChatGPT or Muse,
  touring's `get_state` warns when no check has come in for over two and a
  half hours, as Cleaner Core does. For example: "Your Tour Core task hasn't
  checked in since {day} at {time}. Turn it back on in your chat's scheduled
  tasks."
- The shared service adds the warning to `get_state`, the same way it adds
  service notices today.

**Claude's private page.**

- A Claude chat's one-time link opens a form like Cleaner Core's, with Fire
  URL and Token fields. It posts back to the same link.
- The form refuses a Fire URL that isn't Claude's routines address, or a short
  token. It saves both values, never shows them back, and sends the test
  update.
- Grok's link still shows "go back to your chat".

**Wording in the touring process.** It already gets the chat's name from the
shared service, so its tour-updates step names the right setup:

- Grok: the webhook routine, posted from its computer.
- Claude: a scheduled task with an API trigger, plus the private page.
- ChatGPT and Muse: a recurring task with the template's prompt, then
  `save_alert_routine` with no arguments.

Its alerts status counts a ChatGPT or Muse connection as tested once
connected. Tour Core's existing Claude and ChatGPT playbooks cover the rest of
setup. Muse gets the baseline playbook, as on Cleaner Core.

## 4. Templates

In `property-core-template/`, beside the Grok files, which stay at the root
because the published Grok bot reads `property-core-template/template.json`:

- `claude/`: `template.json`, `SETUP_GUIDE.md` (one custom connector at
  `/mcp`, the invite code, then the service choice), a plugin skill with the
  standing instructions, and `routines/tour-core-task.md` (the scheduled task
  with an API trigger, its prompt, and the private page).
- `chatgpt/`: `template.json`, `SETUP_GUIDE.md`, and
  `routines/tour-core-task.md` (an hourly task, its prompt, and
  `save_alert_routine` with no arguments, plus the once-an-hour limit).
- `muse/`: `template.json`, `SETUP_PROMPT.md`, and a skill with a touring task
  reference. The host picks how often it runs.

Every template connects to `/mcp` and asks "Which do you want to set up: Tour
Core or Cleaner Core?" with the two choices the service gives. After the
choice:

- Tour Core: the platform's new touring task doc, plus `GROK_BOOTSTRAP.md`'s
  steps that apply to every chat.
- Cleaner Core: that platform's existing guide and task doc in
  `claude-template/`, `chatgpt-template/`, or `muse-template/`.
- Those guides name `/mcp/cleaner-core`, so each template says to skip the
  connect step and keep the one `/mcp` connection.

The Grok template's README and manifest record the published template link,
`https://x.ai/bot/rfmREJxrfqNuTiOs2VqYQ`.

## 5. Errors, testing, and rollout

**Errors.**

- No primary chat with updates connected: events wait in the touring
  process's outbox, as today. Host texts still go out.
- Switching to cleaning: host texts and the list stop with touring. Settings
  stay, so switching back picks them up.
- Two chats on different platforms on one tenant: events follow the primary
  connection, and read markers are per connection.

**Tests.** All with 555 numbers and fake Twilio and wakes.

- One end-to-end test per platform through the shared service: connect, choose
  touring, connect tour updates, publish, a visitor text, then the update
  arrives (a Fire URL wake on Claude, `get_updates` on ChatGPT and Muse).
- Host texts:
  - urgent-only texts a time request and skips a booking;
  - everything texts both;
  - texts carry no names and go out once per event;
  - a Scratch tenant's texts go to its outbox;
  - STOP turns them off;
  - the host's own text never reaches touring.
- The stopped-task warning, and the per-platform tour-updates wording.
- Template tests per platform: paths exist, the address is `/mcp`, the
  question and choices match the service, task prompts call `get_updates`
  (ChatGPT and Muse) or set up the Fire URL (Claude), and nothing secret.
- `scripts/ci-check.sh` passes.

**Rollout.**

- Grok's flow is unchanged except for the texts question.
- Touring stays behind `TOUR_CORE_TENANTS`. Real texts stay behind
  `CLEANER_CORE_LIVE_SMS` and the allowlist.
- `docs/hosted-multitenancy.md`'s open tasks: Claude, ChatGPT, and Muse touring
  done. A `verify-tourcore` skill and the listed small gaps stay open.
- It lands on `claude/tender-bardeen-oid5hr`, in the same pull request.
