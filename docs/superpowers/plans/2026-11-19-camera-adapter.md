# Camera adapter: build plan

Design: `docs/superpowers/specs/2026-11-19-camera-adapter-design.md` (approved by
Saad, 19 Nov). Issue #239. Branch `claude/camera-adapter-239`.

Every slice is test-first: a failing test, the least code to pass it, then the
whole suite. All tests use the fake provider, the fake counter and an
in-memory event log. No test reaches Ring or a counting model.

## Slices

1. **Lines and log** (`src/cameras/lines.ts`, `log.ts`). The `camera`,
   `camera-count` and `camera-pin` line types, `cleanCameraLine` (checks and
   digit-run redaction), the one-method `EventLog` interface `VisitLog`
   satisfies, and `memoryLog` for tests. Newest counter wins.
2. **Provider interface and fake** (`adapter.ts`, `fake.ts`).
3. **Ring provider** (`ring.ts`). Webhook signature check, payload mapping,
   token exchange and refresh (new refresh token saved before use), devices,
   history, snapshot (303 redirect followed), clip, status. `fetch` injected;
   tests stub it with made-up payloads.
4. **Accounts and picks** (`accounts.ts`). Sealed tokens per tenant, account
   id to tenant, `cameras.json` per property (picked cameras, outdoor
   confirmed, consent time). One-time connect links.
5. **Webhook ingest** (`webhook.ts`). Verify, route, append once, return
   fast; follow-up work queued off the stored line.
6. **Counter** (`counter.ts`). Interface, fake, and the vision counter
   (model call injected; JSON counts only).
7. **Counting pass** (`count.ts`). Which events, stay window, nightly cap,
   two retries, count lines, no image kept.
8. **Night** (`night.ts`). Lines to `StayEvent[]`, clip window by reference;
   `runNight` reads camera events for a property with cameras.
9. **Pets** (`src/hub/airbnbEmail.ts`, `bookingEmails.ts`, `check.ts`).
   `pets` in the guest count and `EmailStay`; a stay booked with a pet leaves
   the pets rule unchecked.
10. **Mark a flag false** (`stay-check/tools.ts`, `desk.ts`).
11. **Packages** (`packages.ts`). One expected order that day: `markSeen`
    with `camera`. Otherwise kept for `check_packages` to show.
12. **Offline** (`health.ts`). 30-minute wait, one note each way, outbox ids.
13. **Timeline and pin** (`timeline.ts`). Pure timeline with lock lines when
    present; pin copies one clip to `evidence/` and logs a `camera-pin` line.
14. **Counting test** (`countTest.ts`, `npm run cameras:count-test`). Export
    CSV, score filled CSV: exact, within one, over, under, night peak; day and
    night apart.
15. **Tools, service and flag.** `CAMERAS` flag, `src/cameras/tools.ts`,
    `src/hosted/cameras.ts`, `POST /webhooks/ring`, docs
    (`docs/environment-variables.md`), safety-gates row.

## Waiting on others

- #237 adds the `camera-count` and `camera-pin` types and the `kind`,
  `deviceId`, `provider` fields to `VisitLog`, and drops its own
  `VISIT_RECORDS` gate from the store. Until it merges, the service wiring of
  slice 15 is behind `CAMERAS` and the `EventLog` seam.
- Live use waits on Saad registering Ring's private developer app.
