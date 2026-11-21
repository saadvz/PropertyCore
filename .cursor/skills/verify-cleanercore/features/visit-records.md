# Feature: visit-records

Visit records (#237) on Scratch numbers with fake lock events. Cleaner Core always writes each cleaning's window and each text to the append-only visit log. With the account's Visit records switch on and a connected lock, a late cleaner gets one text and the host one note when the next check-in is at risk. Without a lock, nothing new is sent.

## Drive

```
npx tsx .cursor/skills/verify-cleanercore/scripts/prove-visits.ts .cursor/skills/verify-cleanercore/evidence/visits/visits.json
```

## Expected

- `switchOn` and `switchOff` each have `logWritten` true and `windows` holding the 18 Oct same-day window, `2026-10-18T15:00:00.000Z` to `2026-10-18T20:00:00.000Z`: the log doesn't wait on the switch.
- `late.texts` is exactly one `late-ask` to `+15555550101` (`Hi Ana, checking in on today's clean at 12 Scratch Lane, Teaneck, NJ 07666. Are you on your way?`) and one `visit-note` to `+15555550100` (`Ana hasn't arrived at 12 Scratch Lane, Teaneck, NJ 07666 yet. The next guests check in at 4 PM.`). `late.newAfterRestart` is 0.
- `arrived.texts` is empty. `arrived.visit` has arrival source `lock`, departure source `done-text` with `lockCheck` `matched`, and 141 minutes on site. `logHoldsCode` and `logHoldsPhone` are false.
- `noLock.texts` is empty.
- `switchOffLate.texts` is empty and `switchOffLate.windows` is at least 1: with the switch off, the late journey writes its window and sends nothing.
- Every recipient is a Scratch 555 number, and the door code appears nowhere in the evidence.

The script exits non-zero and names the failure when any of these doesn't hold.

## Not covered

Real lock events (#180), and which events the test property's lock sends when someone locks from outside. A live turnover at the test property in January 2027 is the first real check, and only Saad okays it.
