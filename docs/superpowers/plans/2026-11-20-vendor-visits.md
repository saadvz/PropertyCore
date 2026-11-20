# Vendor Visits Implementation Plan

**Goal:** The vendor-visit part of #237. A routine vendor with a standing yes
gets each visit proposed by text. They confirm or move it, their code moves
with it, the completed-service notice is kept as evidence, and time on site is
logged.

**Spec:** `docs/superpowers/specs/2026-11-20-vendor-visits-design.md`. Its
decisions were taken with Saad on 20 Nov.

**Architecture:** Standing yes on `Upkeep`. A `vendor` marker on `Booking`
(proposed, confirmed, moves). A new `vendorPass` on Fixer Core's clock
proposes due visits. `proInbound` reads a vendor's YES or new time first. A
move changes `booking.from`/`until` in place, so the existing lock sync moves
the grant. Unconfirmed vendor bookings are skipped by `wantedCodes`,
`codeTextPass`, `accessFor`, `visitPass` and the in-progress step. Service
notices get their own append-only store and a `service-notice` line in the
visit log. `grants.ts` doesn't change.

## Global constraints

- Behind `VISIT_RECORDS` and `FIXER_CORE`. Without a standing yes, upkeep
  runs exactly as today.
- Tests use the fake lock adapter, 555 numbers and made-up codes. Nothing
  reaches Seam or a real phone.
- No door code or digit run of 4 or more in any vendor text, note, log line
  or notice.

## Slices (each test-first, each committed)

1. **`parseVendorTime`** (`src/fixer-core/vendorTime.ts`): a weekday or
   date plus a time range, read against the proposal's date and time zone.
   Tests: `test/vendorTime.test.ts`.
2. **The standing yes** on `save_upkeep`: always two-call, and it names the
   code. It's refused for a pro who doesn't text, and for hours that run
   backwards or last over 4 hours. Withdrawn with `standing: null`. Tests:
   `test/vendorVisits.test.ts`.
3. **The proposal**: `vendorPass` makes the job and booking and sends the
   proposal once. A busy due date moves to the next open day, up to 7 days
   later. When none fits, today's flow runs. Unconfirmed bookings get no
   code, page reveal, window line or in-progress step.
4. **The reply**: YES confirms (code issued, window line written, echo,
   news). A move that fits moves in place (code moved, echo, news). One that
   doesn't fit is held for the host. NO or an unreadable text is news. At most
   3 moves. No answer: one note.
5. **`move_vendor_visit`**: the agent's entry of a vendor's time. It moves
   when the time fits, else takes the host's two-call yes. A stay overlap is
   always refused.
6. **Service notices**: `serviceNotices` setting, `save_service_notice`, the
   store, matching and the visit log line.
7. **Gates and docs**: Fixer gate rows, the visit-records spec's "As built",
   `docs/environment-variables.md` if needed, a full test run, and two
   pest-control visits end to end in a test.
