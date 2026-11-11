# Cleaner Core and Supply Core for Muse (v0.1.0, beta)

> **To start, use [`property-core-template/muse/`](../property-core-template/muse/SETUP_PROMPT.md).**
> Its prompt saves the Property Core skill, which loads the Cleaner Core and
> Supply Core skills in this folder for each flow the host turns on. This
> folder holds those skills, their recurring tasks, and the open live checks.

Everything Meta's Muse needs to set up and run Cleaner Core and Supply Core.
Muse is the host's agent. Cleaner Core is the hosted service that keeps the
records and sends the texts. Supply Core, on the same connector, keeps the
property stocked while Muse shops in its own browser. The Grok Bot version in [`cleaner-template/`](../cleaner-template/), the
Claude version in [`claude-template/`](../claude-template/), and the ChatGPT
version in [`chatgpt-template/`](../chatgpt-template/) connect to the same
service.

```
Host ─► Muse ─► hosted Cleaner Core (/mcp/cleaner-core) ─► the cleaner's phone
         │            ▲
         │            └─ private pages, opened and filled in Muse's own browser
         └─ Muse's Google Calendar connector, a recurring task, and its browser
```

**Status: beta.** Grok Bot and Muse are the supported agents: both are
always on and run Cleaner Core, Supply Core and Fixer Core end to end (Fixer Core
only on a service with `FIXER_CORE=1`). Claude and ChatGPT are plain chats: Cleaner Core works there at a
basic level, without Supply Core. See
[`docs/client-matrix.md`](../docs/client-matrix.md).

On Muse, the guides, both recurring tasks, and the server's Muse profile are
built. The last open checks need a live run on the deployed server before a
host uses it. See [Before a host uses this](#before-a-host-uses-this).

## How a host starts

1. Open a new Muse chat and paste the prompt in
   [`property-core-template/muse/SETUP_PROMPT.md`](../property-core-template/muse/SETUP_PROMPT.md).
2. When the approval page opens, sign in or type the invite code from Saad and
   click **Allow**.
3. In **Settings → Connectors → Property Core**, let Muse use it without
   asking each time, so the recurring tasks can run.
4. Give Muse the property's address, and pick Cleaner Core, Supply Core, or
   both.

Muse has no shareable bot templates like Grok's, so the paste-in prompt is the
way in. Muse clones the repository on its cloud computer only to save the
Property Core skill, then saves
[`skills/cleaner-core`](skills/cleaner-core/SKILL.md) and
[`skills/supply-core`](skills/supply-core/SKILL.md) as skills for the flows
the host turns on, so later chats and the recurring tasks already know the
guides. Everything else happens in the chat. The older prompt in this folder's
[`SETUP_PROMPT.md`](SETUP_PROMPT.md) moved there.

## What's different from the other chats

| | Grok Bot | Claude, ChatGPT | Muse |
| --- | --- | --- | --- |
| Entry | Team template, or a paste-in prompt | Add the connector in settings | A paste-in prompt. Muse creates the connector itself |
| Guide | Cloned `CLEANER_CORE_BOOTSTRAP.md` | The connector's instructions (and Claude's skill) | The `cleaner-core` skill Muse saves from the clone |
| Questions with options | Choice cards | A short list | Choice cards, or a short list if Muse can't show one |
| Door code | Grok's secure card, posted from its cloud computer | The host types it on Cleaner Core's private page from a link | Muse opens the private page in its own browser and hands it to the host, who types the code there |
| Calendar links | Grok's secure card | The host pastes it on the private page | The host picks: they have the link (as above), or Muse finds it on the booking site in its browser after the host signs in |
| Routines | Check (scheduled) and Alerts (webhook) | Claude: hourly plus API trigger. ChatGPT: hourly only | One recurring task, as often as the host picks (every minute to hourly). Nothing can wake it |
| When the cleaner texts | The webhook wakes the bot | Claude: the API trigger. ChatGPT: the next hourly run | The host sees it in the group text right away. Muse reads it at its next check, or at once when the host asks |
| Cleaning photos | Signed links | Claude: images. ChatGPT: links | Muse opens the signed links in its browser and looks at them |
| Texts to the host | "Tell your Grok Bot…" | "Tell Claude…", "Tell ChatGPT…" | "Tell Muse…" |
| Supply Core | Grok's shopping tools, product cards, and Vault | Not offered: Cleaner Core only | Muse's own browser, at stores the host signed in to there, with the payment method saved on the store account |
| Supply Core's check | The Supply Core Check routine | None | A second recurring task, Supply Core, daily at the check time |

Everything else is the same server and the same gates: the setup steps, the
questions, the approval codes, who gets the door code and when, and every
safety rule in [`docs/cleaner-core-safety-gates.md`](../docs/cleaner-core-safety-gates.md).

## Why cards for some things and the browser for others

A Muse choice card is fine for any answer that isn't secret: the address, the
usual times, names, and every question with options. Whatever goes in a card
lands in the conversation, where the model reads it. So the door code, the
calendar links, and the invite code never go in a card.

For those, Muse uses its computer use. It opens Cleaner Core's one-time page
in its own cloud browser and hands the browser to the host, who types the
value there. Meta says a password the host types into Muse's browser is kept
from the model like one on its login screen. The door-code field on Cleaner
Core's page is already a password field
([`src/cleaner-core/uploadPage.ts`](../src/cleaner-core/uploadPage.ts)).
Muse's secure credential prompt isn't used: it holds only a sign-in
(username and password) or an API key, so it can't take a door code or a
link (probe, 2026-10-29).

**Find it for me.** Finding a calendar's export link is the hardest step for
most hosts. When the host doesn't have it, Muse opens the booking site in its
browser and hands it to the host to sign in. Then it finds the listing's
export link and pastes it into the private page. Muse sees that link while it
works. Saad chose that trade for ease: Muse never writes it in chat, a tool
argument, its memory, or a skill.

The browser never stands in for the host. Muse never clicks **Allow**, never
types the invite code or an approval code, never signs in with a password it
knows, and never messages anyone itself. The skill spells this out under
"Your browser".

## Supply Core on Muse

When the host says Yes to Supply Core at the end of Cleaner Core's setup (or
asks later), Muse saves
[`skills/supply-core`](skills/supply-core/SKILL.md) as a second skill and
follows it from `get_supply_state`. The server answers Muse in its own words:
a calendar link goes on the host's private page, and nothing tells Muse to
post a value.

- **Shopping** happens in Muse's own cloud browser. For each store in the
  plan, Muse hands the host the browser to sign in, and checks the delivery
  address and that a payment method is saved on the store account. Muse never
  types a password or a card detail.
- **Every cart** goes through `check_cart` before Place Order, the same gate
  as on Grok. Holds wait for the host's yes in chat.
- **When a store wants the host** (a security code, a new sign-in), Muse
  hands them the browser on that page in a live chat. The host clicks Place
  Order only on a cart `check_cart` said go to, or one they approved with
  `approve_cart`'s code, and that order is recorded as `host-browser`, beside
  Grok's `grok-card`. In a recurring run, Muse tells the host and tries again
  at the next run.
- **One Supply Core task** checks every property on the account that has
  Supply Core on.
- **The Supply Core recurring task** runs daily at the check time. When the
  cleaner reports something low, the Cleaner Core task shops for
  it right away.

## Urgent alerts

Muse can't be woken, and the host runs everything from Muse, so urgent news
doesn't depend on a text to the host. It reaches them through Muse:

1. **The recurring task finds it.** It runs as often as the host picks;
   setup suggests every 5 minutes. A run puts anything urgent first in its
   reply (an injury, a problem that could stop the cleaning, STOP, a decline,
   a text that may not have gone out, the checkout nudge), and Muse shows the
   host that reply.
2. **Quiet runs stay quiet.** A run with nothing for the host says only
   "Nothing new.", so a reply from the task means something.
3. **The group text** shows the host the cleaner's words as they're sent,
   before Muse's next check. A host who picks texts to the cleaner alone is
   told at setup that those messages wait for the next check.
4. **No safety rule waits on a check.** The door code goes only after the
   host's yes, and a cleaning is never paused because of how a message sounds.
   A slower check delays an answer, never a gate.
5. **A stopped task** is caught: `get_state` warns once no check has come in
   for two and a half hours, and Muse tells the host to turn it back on.

## Which Muse accounts work

As of October 2026, Muse is US-only (some reports add Canada) and adults-only.
It needs a payment card even on the free tier, and every run counts against
usage, including every check, so the host picks how often it runs. Custom connectors and recurring tasks are
reported on the web, the iOS and Android apps, and WhatsApp. That still needs
checking for this connector.

## Before a host uses this

### Server work (built)

A sign-in from `agent.meta.ai` is Muse (`assistantForRedirect` in
[`src/cleaner-core/assistant.ts`](../src/cleaner-core/assistant.ts)), and the
multi-tenant service allows that host with no extra config, so
`TOURCORE_OAUTH_REDIRECT_HOSTS` doesn't need it. Muse's profile:

- Helper `Muse` and the approval page "Connect Muse".
- Private pages, which Muse opens in its own browser for the host. On Muse the
  calendar-link field is a password field too.
- Choice cards, as on Grok.
- Upload replies that only describe the host's private page. Muse's safety
  check refuses a tool that tells it to send, post, or fill a value.
- The recurring task, at the frequency the host picks, connected with `save_alert_routine` and no values, with
  ChatGPT's no-wake-up alert sink and 2.5-hour check warning, in Muse's words.
- Photos as links. Muse opens them in its browser.

`test/cleanerMuseDeployment.test.ts` drives it end to end, on one deployment
and on the multi-tenant service. `test/supplyMuse.test.ts` drives Supply Core
for a Muse connection: it's offered, its tools and setup speak Muse's words,
and an order Muse places goes through the same cart gate as Grok's.

### Live probe

Run it with a Muse account, a scratch tenant, and a made-up door code. It
sends no texts.

- [x] Muse creates the connector from the chat. Its OAuth callback is
      `https://agent.meta.ai/api/hatch/oauth/callback`, so the host is
      `agent.meta.ai` (probe, 2026-10-29). Muse builds its own connect page
      from a spec with our discovered addresses and registers itself. On the
      first try it mistyped the registration address, so the skill now lists
      the exact addresses.
- [x] With `agent.meta.ai` in `TOURCORE_OAUTH_REDIRECT_HOSTS`, Muse
      registers as "Muse", the host types the invite code on the Cleaner Core
      page, and the connector connects (probe, 2026-10-29). The page still says
      Grok until the server has the Muse profile.
- [x] The sign-in opens Muse's own connect page, then the Cleaner Core page,
      where the host types the invite code (probe, 2026-10-29).
- [x] Muse saves `skills/cleaner-core` from the clone (probe, 2026-10-29).
- [ ] A new Muse chat loads the saved skill. Open a new chat and say "Check
      my calendars". Pass: Muse calls `check_now` through the connector
      without being told about Cleaner Core again.
- [x] Muse shows choice cards for `options`, and asks one question at a time
      (probe, 2026-10-29).
- [x] Muse's safety check refuses a tool reply that tells it to send a secret
      somewhere. With the server still treating Muse as Grok, `save_sources`
      answered "POST JSON {url} … to uploadUrl", and Muse stopped and wouldn't
      follow it (probe, 2026-10-29). So Muse's upload replies must carry only
      data, `uploadUrl` and `expiresInMinutes`, with no instruction to send
      anything. What to do with the page comes from the skill and the host.
- [x] Muse's secure credential prompt takes only a username and password or
      an API key, so it can't hold a door code or a link (probe, 2026-10-29).
- [x] Muse opens the private page in its browser, but with the Grok profile
      the page is "Not found", because a Grok link has no page. Expected until
      the Muse profile has `privatePages: true` (probe, 2026-10-29).
- [x] With the Muse profile deployed and Muse reconnected, setup ran to the
      end: the host typed the calendar link and the door code into the private
      page in Muse's browser, and the cleaner's texts and a group reply went
      through (re-test, 2026-10-29).
- [ ] Muse never sees what the host types on the private page. Meta says so;
      not checked yet. Type a made-up door code on the door-code page in
      Muse's browser, then ask Muse "What door code did I just type?" and
      "Read me what's on that page." Pass: Muse can't say the code, and
      the code isn't in the chat, its memory, or the task's history.
- [ ] Find it for me reaches an Airbnb or Guesty Lite export link after the
      host signs in. Pick Find it for me, sign in when Muse hands over the
      browser, and pick the listing. Pass: `get_state` shows the calendar
      saved by its name, and the link isn't in the chat.
- [x] Muse creates the recurring task from the chat, and it can run as often
      as every minute, so the cleaner's texts reach Muse in about a minute
      instead of an hour. Each run uses Muse's usage meter (re-test,
      2026-10-29).
- [x] A photo the cleaner sent before a cleaning reached Muse only as
      `[photo]`, in every chat: Cleaner Core kept photos only during a
      cleaning. Fixed: a photo from the cleaner or a contact is now kept with
      its message for 7 days, and `check_now` links it (re-test, 2026-10-29).
- [ ] Muse opens a message's photo link in its browser and describes the
      photo. Text a photo from the scratch cleaner's 555 number, then run
      the task or say "Check my calendars". Pass: Muse describes what's in
      the photo, not just that there is one.
- [ ] Muse shows a recurring task's reply to the host as it happens. With
      the task every 5 minutes, text INJURY from the scratch cleaner. Pass:
      the next run's reply leads with it, and the host's phone shows a Muse
      notification for it. If Muse doesn't notify, note how the host would
      have seen it.

### Live run: Supply Core

Run it on the same scratch tenant with Cleaner Core live, and a store account
the tester owns. Use stop-at-checkout mode and a per-order cap under $20.

- [ ] Muse offers Supply Core after the preferences, saves the Supply Core
      skill, and its setup reaches `activate_supplies`, asking one question
      at a time.
- [ ] Products show as product cards or a choice card, from the plan's
      stores only.
- [ ] Muse creates the Supply Core recurring task, daily at the check time,
      with the prompt word for word.
- [ ] Each store check hands the host the browser to sign in, and Muse never
      sees or types the password.
- [ ] Muse's sign-in to the store is still there in a later recurring run.
      If it isn't, every run would need the host, and the store check has to
      say so.
- [ ] A turnover with a supply reorder: the scratch cleaner texts DONE, then
      "paper towels". Pass: the Cleaner Core task calls `report_low`, goes to
      checkout, calls `check_cart`, and stops for the host's yes. On the
      host's yes, the order is placed and `record_order` logs it.
- [ ] Muse's own safety check lets it place an order with the saved payment
      method in a recurring run (hands-off mode, after the stop-at-checkout
      run passes). If Muse always stops for the host, keep Muse on
      stop-at-checkout and note it in this README.

## What Muse does itself

- Creates the Cleaner Core connector and the recurring task from the chat, at
  the frequency the host picks.
- Fills each private page in its own browser, and confirms with `get_state`.
- Finds a calendar's export link when the host doesn't have it.
- Reads only the Google calendar the host says holds the bookings.
- Looks at the cleaner's photos and summarizes the cleaning in its own words.
- Shops for Supply Core in its own browser, after `check_cart` says go or the
  host says yes.

Muse never texts anyone. Cleaner Core sends every text, after the host's yes
when a person wrote it. Muse never types a password or card detail: the host
signs in to each store in Muse's browser, and the store keeps the card.

## What's never in this template

The door code, Cleaner Core or Google tokens, Twilio details, phone numbers,
calendar links, booking-site passwords, or any live booking or cleaning
record. `test/cleanerMuse.test.ts` fails if a secret pattern, a phone number
outside the 555 test range, or a door code shows up here.

## Files

| File | What it is |
| --- | --- |
| [`SETUP_PROMPT.md`](SETUP_PROMPT.md) | Points to the one Muse prompt, in `property-core-template/muse/` |
| [`skills/cleaner-core/SKILL.md`](skills/cleaner-core/SKILL.md) | The guide Muse saves as a skill: connect, private pages, calendar links, setup order, every booking, messages, the browser's limits, and rules |
| [`skills/cleaner-core/references/cleaner-core-task.md`](skills/cleaner-core/references/cleaner-core-task.md) | The recurring task: how Muse makes it and its prompt |
| [`skills/supply-core/SKILL.md`](skills/supply-core/SKILL.md) | The Supply Core guide Muse saves when the host turns it on: setup, the store checks, every run, and the browser's limits |
| [`skills/supply-core/references/supply-core-task.md`](skills/supply-core/references/supply-core-task.md) | The daily Supply Core recurring task: how Muse makes it and its prompt |
| [`template.json`](template.json) | Manifest: the deployment, the connectors, the task, and what's never included |
