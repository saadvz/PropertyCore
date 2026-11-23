---
name: grok-live-test
description: "Run a feature's live test in the real Grok Bot desktop app on the test account. Use when asked to run the Grok tests, a Grok retest, or a live test for an issue or pull request number. Drives Grok Bot with computer use, checks Seam, Railway and Property Core pages in Chrome, and reports pass or fail per step. Texts go only to 555 Scratch numbers."
---

# Grok live test

You act as the host in the real Grok Bot desktop app and run one feature's test script, step by step, on the
test account. The design is [docs/superpowers/specs/2026-11-22-grok-live-test-design.md](../../../docs/superpowers/specs/2026-11-22-grok-live-test-design.md).
The script format is [docs/grok-tests/README.md](../../../docs/grok-tests/README.md).

## What you need

- The person's Windows computer linked to the thread, with Computer use turned on in the Claude desktop app.
- Computer use access to the app named exactly `Grok Bot`. Ask for that app only.
- Claude in Chrome, signed in to Railway, the Seam console (`console.seam.co`, workspace "Saad's Sandbox") and
  Property Core's `/admin`.
- Two properties on the test account:
  - **12 Scratch Lane**: Cleaner Core only, host `+15555550100`, cleaner `+15555550101`, for every step about texts.
  - **Adélie Cottage**: the Seam sandbox lock, for steps about locks, guest codes and visits.

If any of these is missing, say which one in one line and stop.

## Find the script

Look for `docs/grok-tests/<number>-*.md`. If there is none, write one in the README's format from the pull
request description and the issue's "still to test" list. Save it to
`/mnt/project-files/grok-tests/<number>/script.md`. Before running it, check it the way the saved scripts are
checked, and fix every problem it lists:

```
GROK_TEST_SCRIPT=/mnt/project-files/grok-tests/<number>/script.md npx vitest run test/grokTestScripts.test.ts
```

Then post it in the thread and run it without waiting. Leave out any step that would text a real phone, disconnect
the lock account, or buy something, and name those in a "Still by hand" note.

## Preflight

Stop with the reason if any of these fails.

1. Railway: the service's latest deploy is live and its commit includes the feature's merge.
2. Grok Bot: the "Property Core" chat opens, and `/admin` shows the switches the script names.
3. Seam: the console shows the sandbox workspace, not a live one.
4. Ask "What's on the lock right now?" and get a sane answer with no code digits in it.

If the feature changed the tool list and Grok says a tool isn't there, the connector needs reconnecting. That is
the person's step: ask them, and wait.

## Driving the app

- Open `Grok Bot` and take a screenshot. Click the chat named "Property Core" in the left list.
- The message box reads "Message Property Core", or "Type your answer…" while a card is open. Click it, type the
  Say line exactly, press Return. Do the click, type, Return, a 20 second wait and a screenshot in one batch.
- **A reply is finished** when two screenshots 5 seconds apart show the same last message and no "Typing" line.
  Wait up to 2 minutes in total. After that the step is "stuck": screenshot it and report it as a fail.
- If a "new messages" button shows above the box, click it before judging the reply.
- **Every step starts from a fresh screenshot.** Re-find the chat and the box each time. The window may have moved.
- Press a card option only when the script says so, or when the card asks for a made-up value on 12 Scratch Lane
  (a name, a time, a door, a business name). Pick something plain and say what you picked in the report.
- **Routines post into the same chat** (Cleaner Core Check, Fixer Core Check, Supply Core Check, Alerts). Record
  what they said as an observation. Don't answer them unless the script expects them.
- Release the desktop at the end of every turn.

## Test texts

Every Say line on 12 Scratch Lane starts with "On 12 Scratch Lane only:". Lines that work:

- "On 12 Scratch Lane only: reset Scratch."
- "On 12 Scratch Lane only: add a test turnover with checkout 10:00 AM and next check-in 4:00 PM."
- "On 12 Scratch Lane only: send a test text as the cleaner (+1 555 555 0101) that says YES."
- "On 12 Scratch Lane only: read the test texts in and out and list each line exactly as the tools returned them."
- "On 12 Scratch Lane only: record the latest test text to the cleaner as delivered."

Test texts can come only from the host, the cleaner or the observer. A pro or visitor replying by text can't be
tested this way: mark such a step "could not check".

If an outbox line reads "failed", report the step as a fail and quote the line. Cleaner Core keeps a Scratch
property's texts in the outbox and never hands them to Twilio (#288), so a failed line is a fault. On a server
older than #288, a failed line only means Twilio refused the 555 number: say so in the report.

## Checks outside the chat

- **Seam console:** which access codes exist, their names, doors and hours. Never write down a code's digits.
- **`/admin`:** the account's switches.
- **Visit pages and private links:** open them in Chrome. If a page shows a code, note that it showed one and
  don't keep that screenshot.
- **Railway:** the deploy and its logs, for errors at the time of the step.
- Never open Railway's variables page or Seam's API keys page.

## Waits

- A `Wait:` up to 2 minutes: wait in place.
- Longer: release the desktop, schedule a check-in a minute after the due time, and pick up at that step.
- A step that waits for a calendar day becomes its own dated check-in. The report says the run is still open.

## Safety rules

- Only the test properties, in the Property Core chat. If the chat is about another property, stop.
- Texts go only to 555 Scratch numbers. Every person a run adds gets a 555 number. If Grok is about to text any
  other number, say no on the card and stop.
- Door codes are made up or Seam sandbox codes. Never type a code into the chat, never copy one into a report, and
  drop any screenshot that shows one. A code appearing in Grok's chat is a failed step and gets reported without
  the digits.
- No purchases. Supply Core carts are tested up to the approval card and never approved.
- Answer only the cards the script covers, plus cards asking for made-up values on 12 Scratch Lane. Leave other
  open cards alone and list them in the report.
- One run at a time.
- A reply that names the other property, or acts on it, fails the step.

## Cleanup

- Reset Scratch at the start and the end of the text steps.
- On Adélie Cottage, undo only what this run created: cancel its visits, remove its pros, remove codes it made.
  Confirm in the chat and in Seam.
- List anything you could not remove.

## Report

One reply in the thread, under 80 words of prose plus the table:

| Step | Result | What Grok said | Evidence |
| --- | --- | --- | --- |

Result is pass, fail, or could not check. Quote Grok only where the wording is what was tested. Save screenshots
to `/mnt/project-files/grok-tests/<number>/<YYYY-MM-DD>/step-<n>.jpg` and attach them. Draft a GitHub comment only
if asked, and post it only if asked.

## Known limits

- You can't see which tool Grok called, only what it said and what changed.
- Clock waits are real time.
- No real phone is exercised. Cleaner Core's Scratch texts never reach Twilio, but the hosted lock and visitor
  texts do: a step that saves a visit or a pro texts their 555 number through Twilio, which refuses it and may
  charge a small fee for the failed text. Scripts mark those steps. A hand check with a real phone covers delivery.
