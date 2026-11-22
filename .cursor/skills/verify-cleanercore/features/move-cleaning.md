# Feature: move-cleaning

Findings #6 and #8 from the 21–22 Nov end-to-end test, on Scratch Lane (`+15555550100` host, `+15555550101` cleaner) with fake texts, a stubbed alert routine, the in-memory fake lock adapter and the made-up door code.

- **#6:** the host hears the cleaner's progress without asking. The cleaner's YES to cleaning texts, the group being set up, and each YES or NO to a cleaning give one note each. Each wakes the Alerts routine once and shows once in `check_now`.
- **#8:** a cleaning the cleaner declined moves to Monday Oct 19 at 10:00, between the Sunday Oct 18 checkout and the Thursday Oct 22 check-in. The host approves it with `move_cleaning` (two calls), and only the cleaner's YES puts them back on it.

## Drive

Run the flag-on doctor first, then:

```
npx tsx .cursor/skills/verify-cleanercore/scripts/prove-move-cleaning.ts .cursor/skills/verify-cleanercore/evidence/move-cleaning/move-cleaning.json
```

## Expected

- `timed` ends with `I'll post here when the cleaner replies.` The routine is connected, so the promise holds.
- `optInAlerts` holds `Ana said YES to cleaning texts for 12 Scratch Lane, Teaneck, NJ 07666.` once. `noAlerts` holds `Ana said no to the Sunday, Oct 18 cleaning, so nobody is booked for it yet. The next guests check in Thursday, Oct 22 at 4:00 PM, so whoever cleans has until then. It can also move to another day or time before then, if Ana can do it.` `wakesForProgress` is 2: one wake-up per event.
- `previewTexts` is the cleaner's exact update: `Update: the cleaning at 12 Scratch Lane, Teaneck, NJ 07666 is now Monday, Oct 19 at 10:00 AM. Reply YES to take it, or NO if you can't.` Only the second call, with the code, sends it (`movedText`).
- `codesBeforeYes` is 0. After the cleaner's YES, `yesAlerts` holds `Ana said YES to the Monday, Oct 19 at 10:00 AM cleaning at 12 Scratch Lane, Teaneck, NJ 07666.`, and the cleaner's own lock code (`lockWindow`) runs from `2026-10-19T14:00:00.000Z`, the moved start.
- On checkout day, `left` says the code waits for Monday 10:00 AM, and `codeBeforeStart` is false.
- `reminder` is one text naming Monday, Oct 19. `codeTexts` is 1, from the moved start, with the cleaner's own code, never the saved one.
- Every recipient is a Scratch number. The evidence holds neither the saved code nor the per-visit code.

The script exits non-zero and names each check that failed.

## Not covered

The live Grok Bot. Whether Grok posts each alert line once, and drafts the "Ask Maria about another day" question before calling `move_cleaning`, is a retest in Grok on Saad's test tenant (steps in the pull request). Real Seam locks are not covered either: the fake adapter stands in for them.
