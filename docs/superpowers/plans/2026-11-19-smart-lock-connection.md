# Smart-Lock Connection Implementation Plan

**Goal:** A code for each person's visit through a lock partner (#180, project 1 of #236): issued when
the visit is booked, moved with its window, revoked on cancel, decline or pause, released from the
lock, with fallback, lock events, alerts, checkout-time release, a release setting, pro extensions
and standing codes.

**Spec:** `docs/superpowers/specs/2026-11-12-smart-lock-connection-design.md` (approved; its
"Decisions of 2026-11-19" are final and not reopened here).

**Architecture:** A new `src/locks/` module owns the lock adapter interface, the in-memory fake, the
Seam implementation (last), the grant logic and the per-property lock settings. The hub's
`DoorAccess` keeps the saved code as today and, only when the property is on connected locks, answers
`request()` from grants. `request()` becomes async. Flows don't call issue, move and revoke at each
call site: each flow says which codes it wants now (`wantedCodes()`), and the hub's `syncGrants`
issues, moves and revokes to match. That one reconcile covers a YES, a new cleaner, a cancel, a
decline, a hold, a moved window and a restart, and it runs again on every tick, so a failed lock call
is retried.

**Tech stack:** TypeScript, Node, vitest. No new dependencies: the Seam client is `fetch`, and the
webhook check is `node:crypto` HMAC (Seam signs webhooks the Svix way).

## Global constraints

- Everything is behind `SMART_LOCKS=1` on the service, off by default. With it off, or with a
  property not on connected locks, `request()` returns exactly what it returns today.
- Tests and Scratch use the fake adapter, 555 numbers and made-up codes built at runtime (the secret
  scan). No test reaches the network or Seam.
- The Seam API key and webhook secret are service environment secrets (`SEAM_API_KEY`,
  `SEAM_WEBHOOK_SECRET`), read only by the Seam adapter, never logged or returned.
- No code digits in a tool result, log line, event line, host note or agent-visible text. A tool
  returns a code's status only.
- The lock partner isn't named in tester-facing docs, bootstrap guides, tool descriptions or agent
  replies. Code and developer docs (`docs/environment-variables.md`, this plan) may name it.
- Grants are sealed with the account's own server key (`CLEANER_CORE_PIN_KEY` in the tenant's
  secrets, made if missing), whatever key the saved code uses.

## Files

| File | What |
| --- | --- |
| `src/locks/adapter.ts` | `LockAdapter`, device, code and event types |
| `src/locks/fake.ts` | `FakeLockAdapter`: programming delays, failures, backup pool, events |
| `src/locks/sameCode.ts` | One code value on every device of a visit; retry on refusal |
| `src/locks/settings.ts` | `door-locks.json`: connected devices, which doors, release setting, extension setting, `codeAtCheckout`, standing people |
| `src/locks/grants.ts` | `door-grants.json`: one entry per code, sealed; `syncGrants`, `release` |
| `src/locks/registry.ts` | The service's adapter (`setLockAdapter`), `smartLocksOn(env)` |
| `src/locks/events.ts` | Webhook to event, the event store hand-off, which events change something |
| `src/locks/alerts.ts` | Host notes for lock problems, once each |
| `src/locks/seam.ts` | The Seam implementation (last slice) |
| `src/hub/doorAccess.ts` | Async `request()`, `connected()`, grants, `codesForChecks()` |
| `src/cleaner-core/doorPort.ts` | Port gains `wanted` sync and `codesForChecks()` |
| `src/cleaner-core/core.ts` | `wantedCodes()`, leak checks over a set, `codeAtCheckout` release |
| `src/fixer-core/desk.ts` | Async `openCode`, `wantedCodes()`, release ask, extensions |
| `src/hosted/locks.ts` | Tools (`connect_lock`, `save_locks`, `lock_settings`, `standing_code`), webhook route |

## Slices (each test-first, each committed)

1. **Adapter and fake.** Interface; fake with `set`/`failed`/`programming` per device, backup pool,
   and a webhook signer. `sameCode` makes one value on every device and retries all on a refusal.
   Tests: `test/locksFake.test.ts`.
2. **Grants and an async hub.** `door-locks.json` and `door-grants.json`; `DoorAccess.request()`
   async; `syncGrants(flow, wanted)`; release order: set code, backup per failed device (named by
   door when only some doors fell back), wait up to two minutes while programming, the host's saved
   code, else `lock-failed`. The host is told each time. No connected locks: today's path, unchanged.
   Tests: `test/locksGrants.test.ts`, `test/hubDoorAccess.test.ts` stays green.
3. **Cleaner Core and Fixer wiring.** Engine `wantedCodes()` (cleaner's YES, not cancelled, declined,
   held or replaced); LiveDesk syncs after each change and each tick; `StayCodeHook` set to a sync.
   Fixer `wantedCodes()` (host's yes, `access: "code"`, live), async `openCode`/`accessFor`, crew
   windows and urgent windows. Tests: `test/cleanerLockGrants.test.ts`, `test/fixerLockGrants.test.ts`.
4. **Leak checks over a set.** The port's `codesForChecks()` gives every live code (each grant's
   code and backup, plus the saved code) until a day after its window. Redaction, draft refusals and
   saved-answer checks read the set. Tests: `test/cleanerLockLeaks.test.ts`.
5. **Webhook route, events and alerts.** `POST /webhooks/seam`, verified before reading; tenant from
   the account mapping; unknown account or device dropped and logged without its body. Events go to
   the one append-only store #237 reads (see "Event store" below). Alerts: failed code (with backup),
   backup pool low, low battery once per reading, offline 30 minutes and back, account disconnected
   with a fresh connect link. Tests: `test/locksWebhook.test.ts`, `test/locksAlerts.test.ts`.
6. **`codeAtCheckout`.** Off by default, only on connected locks; at checkout time the release runs
   with every other check; the host's note and the heads-up an hour before; `hold_job` revokes; lock
   offline falls back to the nudge; another code in the hour before the cleaner's first unlock tells
   the host; resuming never sends, reminders every 30 minutes while paused, escalating when the next
   check-in is within the cleaning's time. Tests: `test/cleanerCodeAtCheckout.test.ts`.
7. **Release setting and extensions.** Per property, cleaners and pros apart, default ask. Under ask
   the pro's tap shows "waiting for the host" until the host's yes, with a reminder at the visit's
   start. Extensions 15 minutes before the end without "done": ask, or 30 minutes automatically,
   never past the next check-in buffer, each a move. Tests: `test/fixerLockRelease.test.ts`.
8. **Standing codes.** The host names a person; one opt-in text; after YES, a texted single-use
   expiring link to a page that shows the code once opened. Digits never in a text, chat, tool result
   or log. `ownerLockEntries` reads owners' standing-code unlocks. Tests: `test/locksStanding.test.ts`.
9. **Setup step and get_state.** `connect_lock`, `save_locks` (all doors or none), sensors, the
   alerts-routine requirement, and status in `get_state`. Guides (no partner name). Tests:
   `test/locksSetup.test.ts`.
10. **Seam implementation.** Behind the adapter, `fetch` injected; tests use a stub `fetch` only.
    Access codes, unless the sandbox shows Access Grants give the same (decided in the sandbox run).

Safety gates change with slices 2, 3, 6, 7 and 8, in `docs/cleaner-core-safety-gates.md` and
`docs/fixer-core-safety-gates.md`, each row naming its test.

## Event store

#237 (`claude/visit-records-237`, design for review) proposes one append-only log per property,
`visit-events/<YYYY-MM>.jsonl`, with a `LockEvent` type at the boundary that #180's adapter maps into.
The #180 spec's section 5 named its own `lock-events.jsonl`. One store, not two: slice 5 writes lock
events through a `LockEventSink`, and the sink's file is #237's store once that design is settled.
Until then the question is with Saad (see the session report).

## Review focus

- With `SMART_LOCKS` off, or no connected lock, every existing door test passes unchanged.
- A grant's code is never in `door-grants.json` unsealed, in a tool result, or in a log line.
- `syncGrants` never issues for a person or job the flow didn't name, and revokes everything else.
- A paused turnover has no live code, and resuming makes a new one without sending it.
