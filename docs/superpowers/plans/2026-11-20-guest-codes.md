# Guest Codes Implementation Plan

**Goal:** A door code for each stay and lease, made, moved and removed through #180's grants, with
the host's choice of how guest codes work (#262).

**Spec:** `docs/superpowers/specs/2026-11-20-guest-codes-design.md` (approved 2026-11-20).

**Architecture:** A new `guest` grant flow. A pure reader works out the wanted guest codes from
`booking-emails.jsonl`, `guest-messages.jsonl` (late checkouts), the property's times and
`guest-codes.json` (the host's choice, each booking's yes under ask, leases). A guest-code desk runs
the reconcile (`syncGrants("guest", wanted)`) and turns what changed into host notes: the ask, the
code-ready note with a single-use page link, moved, removed, and failed. The hosted layer lists the
tools, serves the page, runs the desk on the lock clock and after a booking email, and routes a lease
tenant's YES and STOP.

**Tech stack:** TypeScript, Node, vitest. No new dependencies.

## Global constraints

- Behind `GUEST_CODES=1` and `SMART_LOCKS` with a lock adapter. Off: no tool, no code, page 404.
- A property not on connected locks, or with the host's choice unset or off: nothing changes.
- Tests: the fake adapter, 555 numbers, made-up codes and made-up `HM` confirmation codes. No network.
- No code digits in a tool result, note, text, log, visit line or any file but sealed grants.
- The lock partner isn't named in tool descriptions, notes or texts.
- A guest code never falls back to the host's saved code.

## Files

| File | What |
| --- | --- |
| `src/locks/guestCodes.ts` | `guestCodesOn(env)`, `guest-codes.json` (choice, yeses, leases, links, told), `wantedGuestCodes()` |
| `src/locks/guestDesk.ts` | `GuestCodeDesk`: status, choice, per-booking yes, sync and notes, page, leases |
| `src/locks/guestTools.ts` | Tool definitions and dispatch |
| `src/hub/grants.ts` | `GrantFlow` gains `guest`; code name `Guest …`; `who` defaults to guest |
| `src/hub/doorAccess.ts` | `purpose: "guest"`; no saved-code fallback |
| `src/hosted/locks.ts` | Desk per property, tools listed, page route, lock clock pass, lease tenant texts |
| `src/cleaner-core/hosted/router.ts`, `src/hosted/frontMcp.ts`, `src/hosted/lineRouter.ts` | Wiring |

## Slices (each test-first, each committed)

1. **Grants take a guest flow.** `guest` in `GrantFlow` and `AccessRequest.purpose`; the code is
   named `Guest <letters>` and `{ role: "guest" }` in `visit-codes.json`; a guest release never uses
   the saved code. Tests: `test/guestCodesGrants.test.ts`.
2. **Wanted codes.** `wantedGuestCodes()`: bookings from the log, not cancelled, checkout ahead,
   check-in within 7 days; window from the email's times, else the property's, else 16:00 and
   11:00; a late checkout moves the end; an `asked` cancellation keeps the code; under ask, only
   bookings with the host's yes; unset or off, none; leases after YES, start to end of move-out day.
   A `needsHostYes(booking)` hook for #263, false for now. Tests: `test/guestCodesWanted.test.ts`.
3. **Desk: choice and sync.** `guest_codes` (choice, with a yes; off revokes all); sync on the clock
   with a signature cache; under ask, one ask note per booking and `make_guest_code` with a yes;
   code-ready note with a page link once every door is set; moved and removed notes; an urgent note
   within 24 hours of check-in when not set. Not connected: nothing, and status says so.
   Tests: `test/guestCodesDesk.test.ts`.
4. **The page.** `/locks/guest/<token>`: `GET` no code; `POST …/show` the code once; ended at use,
   checkout, cancel or a new link; `guest_code_link` with a yes; doors named on a backup.
   Tests: in `test/guestCodesDesk.test.ts`, and the hosted route in `test/guestCodesHosted.test.ts`.
5. **Leases.** `add_lease`, `change_lease`, `remove_lease`, `lease_code_link`, each with a yes; one
   opt-in text under texting consent; YES makes the code and texts a single-use link; STOP and remove
   revoke. Tests: `test/guestCodesLeases.test.ts`.
6. **Hosted wiring.** Tools listed only with both flags and an adapter; the clock pass; a sync after
   a booking email and a late checkout; a lease tenant's YES and STOP on the shared line; page route
   on its property's path only. Tests: `test/guestCodesHosted.test.ts`.
7. **Gates and docs.** "Guest codes (#262)" in `docs/cleaner-core-safety-gates.md`, a line in
   `docs/fixer-core-safety-gates.md`, `GUEST_CODES` in `docs/environment-variables.md`, the setup
   guide step in `CLEANER_CORE_BOOTSTRAP.md`. A leak test: no guest code in any file but sealed
   grants, in a tool result, or in a note.

## Review focus

- With either flag off, or no connected lock, every existing lock and door test passes unchanged.
- Under ask, no code before the host's yes; unset means off.
- A guest code never in a tool result, note or file unsealed; the agent gets links, not digits.
- A cancellation waiting on the host keeps the code; a counted one revokes it.
