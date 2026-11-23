# Grok Bot live test sessions

Today every new Property Core feature gets a hand-run retest in the Grok Bot desktop app: the host types the
messages, waits on clocks, checks the Seam console, and reports back on the issue. This design replaces the
typing and checking with a Claude session started from the project. Claude operates the Grok Bot app on the
host's desktop, checks the results in Chrome, and hands back a pass or fail report per step.

It runs on a Claude subscription. No API key is involved.

## Goals

- One session per pushed feature, started with one sentence.
- Claude runs the feature's retest steps in the real Grok Bot app, on the test account, as the host.
- Every step ends as pass, fail, or could not check, with a screenshot.
- A failed step comes back with enough detail to file on the issue without re-running it.

## Non-goals

- Replacing `npm test`, the eval harness, or the verify-cleanercore skill. Those stay as they are.
- Running without the host's computer. This version needs the desktop awake with the Claude app and Grok Bot open.
- Testing more than one feature at a time.

## What would make it a failure

- A text reaches any real phone, or a run costs money on Twilio.
- A door code's digits end up in a report, a screenshot kept in the project, or the chat.
- Claude touches a property other than the test properties, or approves a purchase.
- A run leaves test visits, pros, or codes behind without saying so.

## What the trial showed (22 Nov)

Claude connected to the desktop, opened Grok Bot, opened the Property Core chat, sent "What's on the lock right
now?" and read the reply in about 40 seconds, most of it Grok thinking.

- Finding the app, the chat, the message box and the reply all worked first time.
- Choice cards are readable and clickable.
- The reply's wording is fully readable, so wording checks work.
- Claude cannot see which tool Grok called. Only Grok's words show in the chat.
- While a step runs, other windows are hidden and the screen is Claude's.
- Chrome is signed in to Railway and to the Seam console ("Saad's Sandbox").
- The server prints almost nothing per tool call, so Railway logs show errors and restarts but not which tool ran.
- After a redeploy that changed the tool list, Grok kept the old list until its Property Core connector was reconnected.

A second trial set up 12 Scratch Lane through Grok, added a test turnover, sent YES as the cleaner with the
Scratch tools and read both boxes. It worked, but the outbox showed the opt-in text as "failed": with live texts
on, the server handed the 555 text to Twilio, which refused it.

## Approaches considered

**A. A project thread drives the host's desktop (picked).** Claude uses computer use for the Grok Bot app and
Chrome for Seam, Property Core's own pages and Railway. Nothing to install, and it's what the trial proved. It
costs the host their screen while steps run, and the computer has to stay awake.

**B. A dedicated machine or virtual machine.** The same on a second Windows install, so the host's screen stays
free and runs can happen overnight. Better for the long term, but it needs a spare machine and a second sign-in to
everything. Worth doing once A has run a few features. The scripts and the skill carry over unchanged.

**C. Claude talks to Property Core directly, with no Grok.** Fast and exact for server behaviour, but it skips
what the host tests by hand: what Grok itself says and does. It could later cover the slow clock-driven steps.

Saad picked A, on the existing Property Core bot and test account instead of a scratch account.

## How a session works

1. **Start.** In the project: "Run the Grok tests for #285" (an issue or pull request number).
2. **Find or write the script.** Claude looks for `docs/grok-tests/<number>-<name>.md`. If there isn't one, it
   writes one from the pull request description and the issue's "still to test" list, posts it in the thread, and
   carries on without waiting.
3. **Preflight.** The deploy on Railway contains the feature. The Property Core chat is the one in use and `/admin`
   shows the switches the script needs. Seam shows the sandbox workspace. A baseline question gets a sane answer.
4. **Steps.** For each step Claude types the host's line, waits for the reply to finish, screenshots it, and checks
   what the script says to check: the wording, a card, the Seam console, a visit page or private link, or `/admin`.
5. **Waits.** Claude does not hold the screen for clock waits. It releases the desktop, sets itself a check-in for
   the due time, and resumes then. A calendar-day step becomes its own dated check-in.
6. **Cleanup.** Claude undoes what the run created, confirms in the chat and in Seam, and lists anything left.
7. **Report.** One reply: a table of steps with pass, fail or could not check, what Grok said where it mattered,
   and the screenshots. A GitHub comment is drafted only when asked, and posted only when asked.

## Test script format

One Markdown file per feature in `docs/grok-tests/`, written so a person could also run it by hand. Each step has
four parts:

```
## 3. Cancel a visit removes its code

Say: "Cancel Test Plumber's visit on Thursday."
Expect: Grok asks once to confirm, then says the code comes off the lock.
Check: Seam console shows no access code named for Test Plumber.
Wait: none
```

- **Say** is typed exactly. A step can also be "press A on the card".
- **Expect** is about meaning, not exact words, unless the line is quoted.
- **Check** names where to look outside the chat, or `none`.
- **Wait** is `none`, a duration, or a clock time, when the server has to act first.

## Texts: Scratch numbers only

No run texts a real phone and nothing is billed on Twilio. Property Core's Scratch tools need the Railway variable
`CLEANER_CORE_SCRATCH_TOOLS` on and a Scratch property (an address on Scratch Lane, Scratch Court or Scratch Annex,
with only 555 numbers saved). With those, the bot can send a test text as the host, the cleaner or the observer,
read the texts in and out, record a delivery, add a test turnover, and reset Scratch. Claude uses them by asking
Grok in the chat.

- Steps about texts run on **12 Scratch Lane**. Each run starts with a Scratch reset.
- Steps about locks, guest codes and visits run on **Adélie Cottage** with the Seam sandbox. People added there get
  555 numbers, which never reply, so codes show on the visit page instead of by text.

Limits: test texts can only come from the host, the cleaner or the observer, so a pro or visitor replying YES by
text can't be tested this way. The outbox never shows a door code, so a code text is checked by its outbox line.

A Scratch property's texts must never be handed to Twilio, even with live texts on. That is a small server change,
separate from the skill (#288). It covers Cleaner Core's texts. The hosted lock and visitor texts on Adélie Cottage
still go to Twilio, which refuses a 555 number and may charge a small fee for the failed text, so scripts mark the
steps that send one and keep them few.

## Where it lives

- A skill in the repo, `.claude/skills/grok-live-test/SKILL.md`, holding the session's rules.
- Test scripts in `docs/grok-tests/`, kept well formed by `test/grokTestScripts.test.ts`.
- Run evidence in the project's files under `grok-tests/<number>/<date>/`, never in the repo.

## Safety rules for a run

- Only the test properties, in the Property Core chat. If the chat is about another property, stop.
- Texts go only to 555 Scratch numbers. Every person a run adds gets a 555 number. If Grok is about to text any
  other number, say no on the card and stop.
- Door codes are made up or Seam sandbox codes. Claude never types a code into the chat, never copies one into a
  report, and drops any screenshot that shows one. A code appearing in Grok's chat is a failed step and gets reported
  without the digits.
- No purchases. Supply Core carts are tested up to the approval card and never approved.
- Claude answers only the cards the script covers, plus cards asking for made-up values on 12 Scratch Lane. Other
  open cards are left alone and listed in the report.
- One run at a time.
- Railway's variables page and Seam's API keys page are never opened.

## Limits

- **Tool calls are invisible.** Claude can check what Grok said and what changed in Seam and on Property Core's
  pages, not which tool Grok called.
- **No real phone in the loop.** The real Twilio line and a real handset are never exercised. Keep an occasional
  hand check for that.
- **Clock time is real time.** A 30-minute wait takes 30 minutes.
- **The host's screen.** Each step takes the screen for under a minute.
- **Routines keep firing.** The Alerts and Check routines post into the same chat. Claude records those and does
  not answer them unless the script expects them.
- **xAI's acceptable use policy** bars unauthorized automated access to Grok. Saad chose to run this on the main
  account. Runs are low volume and at human speed, but the risk of a suspension is not zero.

## Follow-ups

1. A tool-call line in the server log (time, account, tool name, no arguments), so runs can confirm which tools
   Grok called.
2. A dedicated test machine (approach B).
3. A test clock on a second deployment, so clock-driven steps run in seconds.
