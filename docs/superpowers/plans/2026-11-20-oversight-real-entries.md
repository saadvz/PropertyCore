# Plan: remote oversight on real entries (#240)

Design: `docs/superpowers/specs/2026-11-20-oversight-real-entries-design.md`.
Branch: `claude/oversight-real-entries-240`. Each slice is test first: a
failing test, the smallest code to pass it, then the full suite.

1. **Entries by role.** `EntryEvent.party`; `entryEventsFrom` names a
   standing code by its person and marks host and guest codes as a party.
   Unknown roles stay unnamed. Tests in `test/visitEvents.test.ts`.
2. **Evidence.** `src/oversight/evidence.ts`: `dayEvidence` (entries, quiet
   spans, sightings), and the name readers (window lines, `door-grants.json`).
   Tests in `test/oversightEvidence.test.ts`.
3. **The check.** `checkDay` takes evidence: party entries never count,
   `unknown` for no lock and for a quiet lock, sightings as support, `unsure`
   in `flags`. Tests in `test/oversightCheck.test.ts`.
4. **Alert wording.** Quiet lock, sightings, host and guest codes. Tests in
   `test/oversightCheck.test.ts`.
5. **The desk.** `runDay(date, label)` from the log; `locks` and `cameras`
   deps; `flaggedAt` for `unsure` too; `list_expected_visits` results that
   record nothing. Tests in `test/oversightDesk.test.ts`.
6. **Hosted.** The shared service passes `locks` (the hub's door access is
   connected) and `cameras` (`CAMERAS`). Test in
   `test/oversightHosted.test.ts`.
7. **Docs.** Safety gate row, `docs/environment-variables.md`, the
   oversight design's "as built" pointer.
8. **Verify.** Full test suite, typecheck, `scripts/ci-check.sh` where it
   runs offline; review; push.
