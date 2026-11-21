# Plan: host alerts through the Alerts routine, on a clock (#250)

Design: `docs/superpowers/specs/2026-11-21-host-alerts-routine-design.md`.
Branch: `claude/host-alerts-routine-250`. Each slice is test first: a failing
test, the smallest code to pass it, then the full suite.

1. **The routing point.** `src/host-alerts/routes.ts`: `ALERT_KINDS`,
   `ROUTINES` (`"alerts"` only), `routineFor(accountRoot, kind)` from
   `alert-routes.json`, defaulting every kind to the Alerts routine. Tests in
   `test/hostAlerts.test.ts`.
2. **The guard.** `src/host-alerts/guard.ts`: no run of 4+ digits (split
   digits joined), no `+` and digit, the property's label let through. Each
   producer's own wording passes. Tests in `test/hostAlerts.test.ts`.
3. **The ledger.** `src/host-alerts/ledger.ts` (`host-alerts.json`): keep by
   id, withhold with no text, pending, delivered, expired, and the nightly
   check's `nights`.
4. **The pass.** `src/host-alerts/clock.ts` `runHostAlerts`: keep, then the
   producer's mark, then the sink; one source's failure never stops the rest;
   a kept alert no sink took is tried next pass and let go after 48 hours.
   Tests: order, second run, restart, crash before the mark, withheld, expiry.
5. **Producers, read and mark apart.** `OversightDesk.peekDay`;
   `CameraDesk.dueNotes` / `markTold` / `nightWindow`;
   `PackageDesk.dueNotSeen` / `markNotSeenTold`, and `check()` with
   `alertsByClock` listing `notSeenPending` instead of marking. The package
   alert wording. Tests in `test/hostAlerts.test.ts`.
6. **Sources.** `src/host-alerts/sources.ts`: today's same-day check; the
   nightly check 30 minutes after the window closes, up to an hour for
   counting, never older than 12 hours, clean nights recorded; packages;
   camera health. Timing tests in `test/hostAlertsHosted.test.ts`.
7. **Fixer's sink.** `FixerDesk.hostAlert(id, text)`: a news item with
   `noteId`, kept once, waking the routine. `FileNews.noteId`.
8. **Hosted.** `src/hosted/hostAlerts.ts` `tickAllHostAlerts`: per property,
   each kind behind its flag; the `"alerts"` sink is Cleaner Core's
   `noteForHost`, else Fixer's `hostAlert`; camera notes no sink took wait for
   `list_cameras`. On the service tick after `tickAllCameras`, which stops
   sending notes. `check_packages` gets `alertsByClock` where Cleaner Core or
   Fixer Core runs. Tests in `test/hostAlertsHosted.test.ts` and the updated
   `test/camerasHosted.test.ts`.
9. **Docs.** Gate rows in `docs/cleaner-core-safety-gates.md` and
   `docs/fixer-core-safety-gates.md`; the design's decisions and as-built.
10. **Verify.** Typecheck, the full suite, the verify-cleanercore doctor and
    smoke proofs; push; issue comments on #250, #239, #240 and #241; a pull
    request (Saad asked for it, 21 Nov).
