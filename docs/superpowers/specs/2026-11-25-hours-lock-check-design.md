# Hours log: reconcile the month to the lock events (#238)

The last unticked check in #238's "reconciles to the booking calendar and the lock events" box. Today
`review_hours` returns `reconcile.lockEvents: "waiting"`. Real keypad entries now land in the visit log
(#180, #303), so the month can be checked against them.

## What "reconciles" means

Two directions, both for the month at the property's local time:

1. **Every entry at the door is accounted for.** Each unlock from outside in the month is either covered by
   an on-site row, or belongs to someone whose visit isn't work, or it's listed for the host.
2. **Every on-site visit has an entry.** Each on-site row in the cleaner's, a pro's or a helper's log, at a
   time the lock was connected, has an unlock near it, or it's listed for the host.

## Rule 1: which row covers an unlock

An unlock is covered when a row of the right person runs from up to 1 hour before it until up to 1 hour
after the row ends (the same 1 hour visit records already use for an early arrival and a lock after DONE).

| Whose code (from `visit-codes.json`) | Covered by |
| --- | --- |
| Cleaner | an on-site row in the cleaner's log |
| A pro | an on-site row in that pro's log |
| The host's standing code | an owner on-site row (these already come from the host's unlocks) |
| Package code | a bring-in row |
| Shared code, a code nobody named, or no code (app, auto) | any on-site row; or, if none, a guest stay in the booking calendar at that time |
| Guest or visitor | not work: counted, never listed |

A guest stay runs from check-in to checkout at the property's usual times (Cleaner Core's saved check-in
and checkout, else 4 PM and 11 AM). Unlocks from inside are not entries and are left out.

## Rule 2: which rows need an entry

On-site rows in the cleaner's, a pro's and a helper's logs, measured or scheduled, when the lock was
connected at the row's time (the same "connected" test visit records use). The owner's on-site rows come
from unlocks, so they always have one. Remote rows and Property Core's own rows are never checked.

## What the host sees

Each gap is one line in `needs`, in the review the host already reads before confirming:

- "Nov 12, 2:05 PM, Front door: the cleaner's code opened it, and no row in the log covers that time."
- "Nov 14, 1:13 AM, Front door: opened without a code (from the app), with no row or guest stay then."
- "Nov 20, Turnover cleaning after the Nov 19 checkout: no entry at the lock during it."

`reconcile.lockEvents` becomes a summary instead of "waiting":

```ts
lockEvents:
  | { status: "no-lock" } // no connected lock in the month: nothing to check
  | { status: "checked"; entries: number; covered: number; notWork: number;
      uncovered: { eventId: string; date: string; time: string; device: string; who: string }[];
      visitsWithoutEntry: string[] } // row ids
```

## What it doesn't do

- **It never adds, removes or changes a row.** A gap is a question for the host, never made-up work. So
  the month's fingerprint doesn't move, a confirmed month stays confirmed, and the Dec 1 export of November
  is unaffected.
- **A gap doesn't block confirming.** Same as the checkout check today: the host sees it and decides.
- No code digits anywhere: only the lock's name for a code, mapped to a role.
- No new tool, flag or setting. It's part of `review_hours`, behind the existing Hours log switch.

## Build

- `readRecords` reads the month's lock events, code roles and lock-connection lines from the visit log, plus
  the usual check-in and checkout times. No new file.
- `checkLocks` in `src/hours-log/lockCheck.ts`, called from `buildMonth`, does both rules from the raw facts (all months, so a row
  that crosses midnight at a month's edge still covers its unlock).
- `lockConnected` in `src/visits/derive.ts` is exported for rule 2.
- Tests in `test/hoursLockCheck.test.ts` with fake lock events: each row of the table, an inside unlock, a guest
  stay, the 1-hour edges, a visit with no entry, a property with no lock, and a confirmed month that stays
  confirmed when gaps appear.
- Tick the acceptance box on #238 once merged.

## Decided

An unnamed or no-code unlock during a guest stay counts as the guests', and isn't listed. The door activity
list (#280 item 20) still shows every unlock when the host asks.
