# Property hub: door access

Date: 2026-11-07. Status: draft, decided in review with Saad on 2026-11-07.
Issue: saadvz/TourCore#165 (the door access part), part of
saadvz/TourCore#158 (Phase 0). Follows
`docs/superpowers/specs/2026-11-07-property-hub-details-calendars-design.md`.

## Goal

The property hub takes one door access request: "let this person into this
property during this window." Today the answer is the landlord's own code.
Cleaner Core gets the code only through that request. Fixer Core (#174) will
make the same request, and a lock partner (#180) can answer it later.

## What Saad said

- The hub owns the sealed code, the lock location, the upload link and the
  key. Cleaner Core gets the code for a release only from the hub's request.
  Cleaner Core keeps its existing leak checks, which still hold the code in
  memory (option A of three: B moved every leak check behind the hub, C moved
  only the storage).
- The engine's own seal in `core.ts` is removed. The engine never stores the
  code (option A of three: B kept it as a documented exception, C had the
  engine store it through the hub).
- The code lives in its own file in the property's folder, not in `hub.json`
  (approach 1 of three: 2 put the seal in `hub.json`, 3 made a separate
  top-level `src/access/` module).

## Not in this version

- A log of the grants the hub gives.
- Per-visit codes and a lock partner (#180).
- Fixer Core calling the request (#174).
- Moving the leak checks behind the hub.
- Shared people across properties (#190).

## What exists today

- `LiveFile` in `src/cleaner-core/liveDesk.ts` holds `pinSeal`,
  `lockLocation` and the pending `doorCodeUpload` in `cleaner-live.json`.
  LiveDesk picks the key (`keyFor`: the request's key, else
  `serverPinKey(env)`), seals the code (`saveDoorCodeNow`), opens it
  (`openSeal`, `unlock`), and serves the upload link at
  `/cleaner-core/door-code/` (`issueDoorCodeUpload`, `uploadDoorCode`). The
  request's key for a pending upload stays in memory only
  (`doorCodeUploadKey`).
- LiveDesk opens the engine with `pin` and `lockLocation` in its options and
  `sealPinAtRest: false`. The engine keeps the code in memory as `this.pin`.
- The engine in `src/cleaner-core/core.ts` uses `this.pin` for two jobs:
  - The door-code text in `deliverPin`, after its own checks: approval,
    opt-in, the stale feed, holds, and `pinChannel()`.
  - About 40 leak checks: redaction, draft refusals, and "is a code saved"
    checks.
- With `sealPinAtRest` on (the default), the engine also seals the code into
  its own store with `pinKeyFor(propertyId)`, a key made from the property
  id. Only the CLI, the scratch tenants (Lane and Court, with made-up codes)
  and the text onboarding inside the engine use this. The CLI's
  `onboarding-draft` is the only way into text onboarding. The hosted
  service turns it off, so no hosted tenant has an engine seal.
- `src/cleaner-core/pinSeal.ts` holds `sealPin`, `openPin`, `serverPinKey`,
  `pinKeyFromHeader` and `pinKeyFor`.
- The release gate is `markGuestsLeft` in LiveDesk: the host says the guests
  left, LiveDesk opens the code, and then `engine.hostDeparture` runs
  `deliverPin`.

## Design

### Door access in the hub

A new file, `src/hub/doorAccess.ts`, reached through `hub.doorAccess()`. It is
named apart from Tour Core's unrelated `src/policy/evaluateAccess.ts`. It
runs on the hub's in-memory copy, one write at a time, like the rest of the
hub.

`pinSeal.ts` moves to `src/hub/pinSeal.ts` with `sealPin`, `openPin`,
`serverPinKey` and `pinKeyFromHeader`. `pinKeyFor` is deleted. The key rule
moves with it: the request's key, or else the server's key.

`door-access.json` sits next to `hub.json`:

```ts
interface DoorAccessFile {
  schemaVersion: 1;
  pinSeal?: PinSeal;
  /** Where the lock is, named in the door-code text. Never a code. */
  lockLocation?: string;
  /** The pending upload link: the sha256 of its code, never the code or the link. */
  upload?: { hash: string; expiresAt: string; lockLocation?: string; by?: HubCaller };
}
```

Methods:

| Method | Does |
| --- | --- |
| `save(code, lockLocation, key)` | Seals a 4 to 8 digit code. Same checks as `saveDoorCodeNow` today, plus the guards' `codeRefused`. |
| `issueUpload(lockLocation, key)` | Makes a one-time upload link. A new link replaces the last one. The key stays in memory only. |
| `upload(code, body)` | Seals a code posted to the link. Only a save uses the link up. A refused code keeps the link. |
| `saved()` | True when a code is sealed. Never the code. |
| `lockLocation()` | The saved lock location. |
| `codeForChecks(key)` | The open code, for leak checks only. Its result is never sent. A test and its comment say so. |
| `request(req)` | The door access request below. |

Every write of `door-access.json` is refused when the file would hold the
code as its own token or the key, as `persist()` does today.

### The request

```ts
interface AccessRequest {
  /** E.164 phone of who is let in. */
  person: string;
  /** ISO instants. */
  window: { from: string; until: string };
  /** "repair" is unused until Fixer Core. */
  purpose: "cleaning" | "repair";
  /** The request's own key, else the server's key. */
  key?: Buffer;
}

type AccessGrant =
  | { ok: true; kind: "code"; code: string; lockLocation?: string; until: string }
  | { ok: false; reason: "no-code" | "no-key" | "sealed" | "window-over" };

interface AccessProvider {
  grant(request: AccessRequest, saved: SavedCode): AccessGrant;
}
```

- The hub checks only what belongs to the property:
  - a code is saved
  - a key is there and opens the seal
  - the window's `until` hasn't passed
- The hub never decides who may get in. Approval, opt-in, `pinChannel`, and
  the "guests have left" gate stay in Cleaner Core, which makes the request
  only after its own checks pass. Fixer Core brings its own checks.
- One provider exists, `ownCode`: the landlord's own code. A lock partner
  becomes a second provider behind the same request (#180).

### Guards

`HubGuards` in `src/hub/hub.ts` gets one more method:

```ts
/** Cleaner Core's refusal for this code or lock location, never holding the digits. */
codeRefused?(code: string, lockLocation?: string): string | undefined;
```

Cleaner Core's checks move into it unchanged:

- The digits are already in a saved answer (`CODE_IN_SAVED_ANSWER`).
- The digits are in a waiting draft (`CODE_IN_DRAFT`).
- The lock location is too long, holds a run of 4 or more digits, or carries
  the code.

They run for `save_door_code` and for a code posted to the upload link.

### Upload link

- The new path is `/door-code/<code>`, in `src/hub/paths.ts` next to the
  calendar link.
- `/cleaner-core/door-code/` still leads to the same link, so one issued
  before a deploy works.
- The reply never holds the code, and the code is never logged.

### Cleaner Core

LiveDesk:

- `pin`, `pinSeal`, `lockLocation` and `doorCodeUpload` leave `LiveFile`.
- `openSeal` and `unlock` become `hub.doorAccess().codeForChecks(key)`. Every
  existing leak check keeps working on the code it returns.
- `save_door_code` and its upload link call the hub. Their tool names, inputs
  and replies don't change.
- `doorCodeTo` stays in `LiveFile`, because it is a `pinChannel` rule.
- `markGuestsLeft` keeps its checks and its replies.

The engine (`core.ts`):

- A new option:

  ```ts
  access: {
    request(input: { person: string; window: { from: string; until: string }; purpose: "cleaning" }): Promise<AccessGrant>;
    codeForChecks(): string | undefined;
  };
  ```

- `deliverPin` keeps every check it has. Only once they pass does it call
  `access.request` for the cleaner, and it builds the door-code text from the
  grant's `code` and `lockLocation`.
- A refused grant sends the cleaner nothing, retries nothing on its own, and
  gives the host one note (see Refusals).
- `this.pin` serves the leak checks only. It is read from
  `access.codeForChecks()` when the engine opens, and LiveDesk's existing
  `rememberPin` still fills it after a later call opens the code.
  `options.pin` and `options.lockLocation` are removed.
- `sealPinAtRest`, `pinKeyMaterial` and the store's `pinSeal` are removed. An
  old store's `pinSeal` is ignored on load and dropped on the next save.
- LiveDesk builds the port. It uses the key of the call it's serving, or the
  server's key on a tick. A crash after clearance still sends the code once
  on the next reminder pass.

The cleaning window:

- `from`: the job's checkout instant.
- `until`: the end of the next check-in day in the property's time zone, or
  the end of the day after checkout when there is no next booking.
- This is wide enough that every release that goes out today still goes out.
  The only new refusal is for a release days late, such as a replay of an old
  job.

The CLI and scratch paths:

- The CLI passes a port backed by the tenant's made-up code in
  `src/cleaner-core/tenants.ts`. It grants that code for any window. The
  window check is proved on the hub, not on the CLI.
- Text onboarding keeps the code it was given in memory and hands it to the
  published engine through the same kind of port.
- Nothing stores the code at rest outside the hub.

### Refusals

| Reason | When | The host hears |
| --- | --- | --- |
| `no-code` | No code saved. | Release never gets this far: it already needs a saved code. |
| `no-key` | No key from the request and none on the server. | `PIN_KEY_MISSING`, as today. |
| `sealed` | The key doesn't open the seal. | `PIN_REENTER`, as today. |
| `window-over` | The window's `until` has passed. | One new note, kept once per job: the cleaning's window has passed, so the door code didn't go out. |

No refusal names the code, the key or the lock location.

### Moving existing data

`src/hub/migrate.ts` also moves `pinSeal`, `lockLocation` and
`doorCodeUpload` (renamed `upload`) from `cleaner-live.json` into
`door-access.json`:

- `door-access.json` is written first, then the fields are removed from
  `cleaner-live.json`. Each write is atomic, so a crash at any point is
  finished by the next open.
- The seal is copied byte for byte. It is never reopened, so no key is needed
  for the move.
- Once `door-access.json` exists it is the record. An open only removes
  fields the old file still holds.
- `doorCodeTo` stays in `cleaner-live.json`.
- An engine store's `pinSeal` is not moved. Only the CLI and scratch paths
  ever wrote one, with made-up codes.

### Boundaries

- `src/hub/` still imports neither flow.
- No file outside `src/hub/` reads `pinSeal` or imports `src/hub/pinSeal.ts`.
  Cleaner Core reaches the code only through `hub.doorAccess()`. The
  exceptions are `pinKeyFromHeader` and `serverPinKey`, which
  `src/cleaner-core/http.ts` and the hosted wiring use to read a request's
  key. They are re-exported from `src/hub/doorAccess.ts` for that.

## Testing

All tests use 555 numbers and made-up codes.

- `test/hubDoorAccess.test.ts`:
  - Sealing and opening, and the key rule: the request's key, else the
    server's.
  - A write that would hold the plain code or the key is refused.
  - The upload link: expiry, single use, a refused code keeps the link, the
    old `/cleaner-core/door-code/` path still works, and no reply holds the
    code.
  - `codeRefused` from the guards blocks a save without repeating the digits.
  - `request()` grants, and refuses for each reason.
  - A fake second provider plugs in behind `request()`.
- `test/hubMigration.test.ts`:
  - `pinSeal`, `lockLocation` and `doorCodeUpload` move to
    `door-access.json` with the seal bytes unchanged.
  - A crash after `door-access.json` is written: the next open finishes.
  - `doorCodeTo` stays in `cleaner-live.json`.
- `test/hubBoundaries.test.ts`: no file outside `src/hub/` reads `pinSeal` or
  imports `src/hub/pinSeal.ts`.
- Engine tests:
  - A port that refuses: no `pin` text, one host note.
  - A port that grants: the text uses the grant's code and lock location.
  - The existing release scenarios all still release with the new window.
- These pass with their assertions unchanged:
  `test/cleanerGroupFirst.test.ts`, `test/twoPropertiesEndToEnd.test.ts`,
  `test/lineRouting.test.ts`, `test/cleanerReplyDrafts.test.ts`,
  `test/cleanerSavedAnswers.test.ts`.
- These change only where they read the seal (now `door-access.json`) and
  drop `pinKeyFor`: `test/cleanerScratchTools.test.ts`,
  `test/cleanerFullSetup.test.ts`, `test/cleanerCoreWiring.test.ts`,
  `test/propertyMigration.test.ts`, `test/cleanerCoreStepG.test.ts`.
- `scripts/scan-cleaner-secrets.mjs` already opens any `pinSeal` it finds with
  the test key. A test shows it catches a code sealed in `door-access.json`.

## Safety gates

- `docs/cleaner-core-safety-gates.md`, the "Door code" row adds: the sealed
  code lives in the property hub's `door-access.json`. Cleaner Core gets it
  only through the hub's door access request, after its own approval,
  opt-in, channel and release checks. Its proof adds
  `test/hubDoorAccess.test.ts`.
- Proof: `npm run typecheck`, `npm test`, `scripts/ci-check.sh`, and the
  verify-cleanercore skill's offline proof (`prove-step-g.sh`). No live run.

## Done when

- Cleaner Core releases the code through the hub's door access request, with
  the same `pinChannel` rules and release gate.
- No file outside `src/hub/` reads `pinSeal`, and a test checks it.
- The engine stores no code at rest.
- Existing properties move their seal to `door-access.json` on their first
  open.
- The safety gates stay green, including the "Door code" row.
