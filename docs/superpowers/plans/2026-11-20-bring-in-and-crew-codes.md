# Bring-in codes and crew-day codes: plan

Design: `docs/superpowers/specs/2026-11-20-bring-in-and-crew-codes-design.md`. Each slice is test first:
write the failing test, see it fail, make it pass, run the neighbouring suites. Fake lock adapter, 555 numbers,
codes made at runtime only.

## Slice 1: the grants know the new flow and role

- `src/visits/events.ts`: `CodePerson` gains `{ role: "package" }`; `src/visits/store.ts` `validPerson` keeps it.
- `src/hub/grants.ts`: `GrantFlow` gains `"bring-in"`, prefix `Package`, default who `{ role: "package" }`,
  `whoOf` default "the person bringing the package in".
- `src/hub/doorAccess.ts`: `AccessRequest.purpose` gains `"bring-in"` (the saved-code fallback applies).
- `src/locks/desk.ts`: switching locks off revokes `bring-in` codes too.
- Tests (`test/bringInGrants.test.ts`): issues a `Package …` code for the window named `package`; leaves
  other flows alone; the release falls back like a pro's; in the leak checks; a `package` unlock isn't a stray
  and isn't "someone else".

## Slice 2: `release.packages`

- `src/locks/settings.ts`: `release.packages`, default ask, read as ask when unset.
- `src/locks/desk.ts` and `src/locks/tools.ts`: `lock_settings` takes `packages`.
- Test: defaults to ask; saves automatic with the host's two calls.

## Slice 3: bring-in wanted codes (pure)

- `src/package-arrivals/codes.ts`: `wantedBringInCodes(file, supply, input)` → `WantedCode[]`, window cut at
  the next busy time; none during a stay, after inside, for a person who can't be picked, or before the drop.
- Tests (`test/bringInCodes.test.ts`).

## Slice 4: the desk syncs, releases and texts

- `PackageDesk` deps gain optional `door`, `send`, `textsAllowed`, `stays`.
- `syncCodes()`: sync grants, then the release pass (automatic or the host's OK; one text per visit; mark
  before send; unsure → note; texts off → note; refused → note). Returns host notes.
- `approveCode({ orderId, confirmation })`: two calls with a `ConfirmationBook`.
- Replies on connected locks: `code` and `next` per the design; unchanged off them.
- `src/package-arrivals/tools.ts`: `approve_bring_in_code`.
- `src/hosted/packages.ts`: wires door, send, textsAllowed; runs `syncCodes()` after each call; `lockNotes`.
- Tests: no lock → unchanged; ask → code on lock, no text until OK; automatic → one text with the code;
  inside → revoked; new person → old revoked; STOP → revoked; texts off → note; restart → no second text;
  no file but the sealed grants holds the code.

## Slice 5: crew-day codes

- `src/fixer-core/desk.ts`: crew jobs may book `access: "code"` on connected locks; `wantedCodes` gives a crew
  job its current-or-next window; `accessFor` gives a crew the open workday window; `lockPass` asks the
  host's OK for a crew but never extends.
- Tests (`test/fixerCrewCodes.test.ts`): off connected locks crew still host access; one code live only in day
  one's window, moved to day two after, same value; nothing between windows; done/cancel revokes; release
  only inside a window; named as the pro.

## Slice 6: docs and gates

- Gate rows in both safety-gates docs; README/bootstrap mentions where tools are listed; full test run;
  `scripts/ci-check.sh` if it runs here.
