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

One store, not two: lock events go into #237's visit log (`src/visits/store.ts`), not the
`lock-events.jsonl` the #180 spec's section 5 named. See the build notes below.

## Review focus

- With `SMART_LOCKS` off, or no connected lock, every existing door test passes unchanged.
- A grant's code is never in `door-grants.json` unsealed, in a tool result, or in a log line.
- `syncGrants` never issues for a person or job the flow didn't name, and revokes everything else.
- A paused turnover has no live code, and resuming makes a new one without sending it.

## Build notes (2026-11-19)

All ten slices are built on the fake adapter, with the gates in both safety-gate docs. Calls made while
building, for review:

- **One reconcile, not call sites.** Each flow says which codes it wants (`wantedCodes()`), and its desk
  syncs the hub after every step and on the clock. Issue, move and revoke follow from that, so a YES, a
  new cleaner, a cancel, a decline, a hold, a moved window and a restart are all covered by one path.
  `StayCodeHook` now asks for a sync of that job.
- **Cleaner Core still needs its saved door code.** The engine's whole flow keys on a saved code, and
  it's the last fallback, so a Cleaner Core property keeps one. A Fixer-only property doesn't need one.
- **A code ends at DONE.** The cleaner's code is revoked when the cleaning is done (the user story: "from
  checkout until the clean is done"), and a pro's when the visit is done.
- **Early start.** When the host clears the guests before checkout, the cleaner's code starts then.
- **Event store (settled with #237, 19 Nov).** Lock events go into #237's visit log through
  `VisitLog.append`: unlocks and locks as `lock` lines, a code set or failed, battery, offline, online
  and backup pool low as `lock-status` lines, and a lock account or property switching as
  `lock-connection` lines. They're written under `SMART_LOCKS`, with `VISIT_RECORDS` on or off. Each
  code the hub issues is named in `visit-codes.json` (cleaner, pro, host for an owner's standing code,
  shared otherwise), and a lock line carries Property Core's name for the code, so visit records, the
  hours log and the "someone else came in" check all read whose code it was from there.
- **Standing people** live in `door-locks.json`, not as a new account role, so no other flow's routing
  changes. The line router takes only a standing person's YES (after their invite); their STOP is noted
  and then routed as usual.
- **Paused reminders** turn urgent within three hours of the next check-in.
- **An automatic extension keeps the visit link** (the pro is still inside); the Fixer gates say so.
- **Crews.** A crew's access stays the host's, as today. Codes per crew day are a follow-up.
- **The partner.** Access codes, with the backup pool on. Devices are found the documented way:
  `connected_accounts/list` by `customer_key` (the account id), then `devices/list` by those
  `connected_account_ids`. An account or device the partner returns for any other key is dropped. The
  event names and Access Grants are still to confirm in the sandbox run.

Sandbox run (Saad, 21 Nov, with Grok and the partner's sandbox Yale login):

- **What showed.** The sign-in finished and the partner's console listed the connected account
  (Yale Access, 3 devices, healthy). `get_locks` still showed no lock after waits, repeat calls and
  several fresh links, and the agent told the host the sign-in hadn't finished.
- **Root cause.** `get_locks` read only the devices `save_locks` had saved, and never asked the
  partner. `save_locks` needs device ids "from get_locks", so a property that wasn't connected yet
  could never see its devices: setup dead-ended after every sign-in. With no saved device, its `next`
  said "No lock is connected here. connect_lock gives the host a sign-in link.", which the agent read
  as a failed sign-in and answered with another link. Its tests passed because they called
  `save_locks` with the fake's known ids.
- **Fix (`claude/locks-get-locks-lists-account-180`).** `get_locks` also asks the partner now:
  `account` (`connected`, `none`, or `unknown` on a partner error, which is said and never shown as
  an empty account) and `available` (the account's devices not yet on this or another property, with
  the ids `save_locks` takes). Its `next` tells a connected account with devices, one with none, no
  sign-in yet, and a partner error apart. A new link is offered only when no account is connected.
- **The other leads.** `devices/list` does take `customer_key` per the docs, but the documented path
  above is used and checked device by device for tenant isolation. Reusing one `customer_key` across
  links is allowed. Sandbox Yale devices are `*_lock` types, which read as locks. `get_locks` doesn't
  wait for a `connected_account.connected` webhook. Before `save_locks` that webhook matches no saved
  device, so it's logged as dropped. That's harmless.

Standing-code live run (Saad, 22 Nov, Grok, the partner's sandbox Yale workspace, Connected locks on
in `/admin`). The cleaner's per-visit codes worked; the standing code didn't. Fixed on
`claude/standing-codes-live-fixes-180`:

- **C. "Show my code" did nothing.** The page's inline script sat in a TypeScript template literal,
  which eats a backslash: `replace(/\/$/,"")` reached the phone as `replace(//$/,"")`, and `//` commented
  out the rest of the one-line script, so it never ran. CSP, the token and the route were fine. The
  script is now a plain string (`CODE_PAGE_SCRIPT`), and a test runs it against the service. The page
  also never fails silently now: the tap shows the code, "Your code is still being added to the lock.
  Try again in a minute." (409, the link keeps working), "couldn't be added yet; the host has been
  told" (503), or "This link has ended" (404). Before, a tap before the code was set used the link up
  and could hang for two minutes in the release's wait. The link is now used only when the code shows.
- **D. No standing code on the lock.** The code is made at the person's YES (by design: nothing before
  it), on the shared service. Two faults. (1) Standing codes go to the partner as ongoing codes (no
  start or end), still with `use_backup_access_code_pool: true`. The partner's backup pool is for
  time-bound codes only, which is the likeliest reason the create was refused. Ongoing codes now ask
  for no backup pool. To confirm in the Railway log or the sandbox. (2) A door whose create threw was
  kept as `failed` with no code id, and the grant counted as made, so no note went. The `syncStanding`
  notes were dropped anyway, and nothing tried again. Now a door that didn't take the code is one host
  note ("I couldn't put Pat's standing code on the lock yet...") through the #277 alerts path. The
  lock clock re-syncs standing codes, and a page tap retries too. `get_locks` shows each standing
  code's `lock` state.
- **A. "Not confirmed" while the group was texting.** The invite's check (`textsAllowed`) is Cleaner
  Core's own `hostConfirmed()`, the one the group texts pass, so a confirmed host passes it. But the
  desk set `invitedAt` before sending. A send that failed (or a property whose texts weren't on yet)
  was lost: never tried again, and shown as "waiting-for-yes". The reply also lumped three reasons
  into one line ("the host's phone isn't confirmed, or they opted out"), and the agent picked the
  wrong one. Now `invitedAt` is set only once the text went. The reply names the one reason
  (`waiting`: `texts-off`, `send-failed` or `opted-out`). The lock clock sends a waiting invite once
  it can, every 10 minutes for up to six tries, then one host note. Which of the two happened on 22
  Nov needs the Railway lines around the first `add_standing_code`.
- **B. "I've turned that on now."** No tool the agent has changes who may be texted. Consent comes
  only from the landlord phone confirmed at sign-up and each person's own YES, STOP or START by text.
  `save_host_texts` is Tour Core's and isn't listed for a properties account. The claim had no tool
  behind it: what made the second try work was the remake's fresh, unmarked invite. Tool replies now
  say "No tool changes who may be texted, so never tell the host you turned texts on". A test runs
  every lock tool and checks no person's YES is set without their own text. A code made before the
  fix needs no remake: `standing_code_link` before the YES re-sends the invite (with the host's yes,
  at most once an hour).
- **E. Wording.** "for Maria" was the agent's own line before any call. For the host's own code,
  `add_standing_code` now takes no phone: the confirmed host phone on file is used, and the question
  says "on your number ending 1234". The agent never asks the host to type it, so it has no reason to
  say "I only have the last four digits" (`get_state` shows only the last four).
- **Guest codes** share the page and grants. The lease page had the same early use of the link, and
  the lease invite the same "marked before it went". Both are fixed and tested. A stay's link is made
  only once its code is on the lock, so that page wasn't affected beyond the script.
- **Open question for Saad.** AGENTS.md says the host never texts the Cleaner Core number, but a
  standing code asks the host to reply YES there. The host's chat yes plus their confirmed phone could
  stand in for it. That's left as it is until Saad decides.

Still open:

- **Sensor health** is stored at `save_locks` and from events; no periodic device refresh yet.
- **Setup order.** `get_state` shows the lock status and offers the lock step as a line, but the step
  isn't in Cleaner Core's numbered setup order.
- **Manual sandbox run** found the `get_locks` dead end above. A retest after the fix, then a code on a
  sandbox lock, are next.
