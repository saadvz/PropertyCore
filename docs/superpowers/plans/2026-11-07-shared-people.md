# Shared People Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One phone can be a person on several of an account's properties after the host's `shared: true`. Its texts reach the right property, one YES and one STOP cover every property, and nothing it receives names another property.

**Architecture:**
- An account-level `people.json` (`src/hub/people.ts`) holds each person's opt-in, STOP and property assignments, plus each property's landlord phone.
- Desks keep their own roles. They read the account state, and they report the engine's consent changes through a relay that the hosted layer plugs in (`src/hosted/sharedPeople.ts`).
- The line router routes a shared person's one-to-one text by name, then by context, then by asking. Held texts live in `<account>/line-asks.json`.

**Tech Stack:** TypeScript, Node 22, vitest. The existing harnesses are `test/multiTenantHarness.ts`, `test/cleanerDeskHarness.ts` and `test/wiringProof.ts`.

**Spec:** `docs/superpowers/specs/2026-11-07-shared-people-design.md`

## Global Constraints

- Tests use only 555 numbers (`+1555555xxxx`). Door codes are the made-up Scratch pins. Nothing texts a real phone.
- `src/hub/` never imports Cleaner Core (`src/cleaner-core/**`) or the hosted layer, and never sends a text.
- `AGENTS.md` is not edited. The door-code row in `docs/cleaner-core-safety-gates.md` doesn't change.
- Writes to JSON files use `writeJsonAtomic` from `src/storage/atomicWrite.ts`.
- Exact copy, verbatim:
  - **Refusal:** `That number is already on ${places}. Ask the host whether the same person helps here too, then save again with shared: true.` Here `places` is each `${label} as the ${role}`, joined with `" and "`.
  - **Ask:** `Which property is this about? Reply 1 for ${a} or 2 for ${b}.` With 3 or more, it's `Reply 1 for ${a}, 2 for ${b} or 3 for ${c}.`. Each name is the street part of the address: the text before its first comma.
  - **Dropped note:** `A text from ${who} couldn't be matched to a property.` Here `who` is the saved name, or `the ${role}` without one.
  - **STOP line reply:** `You're opted out of texts from ${business}. Reply START to opt back in. Reply HELP for help.`
  - **START line reply:** `You're opted back in to texts from ${business}. Reply STOP to opt out.`
  - `business` is the business name when all the person's properties share one. Otherwise it's `this number`.
- Times: a held text lasts **2 hours**, and an ask goes out at most once every **10 minutes** per phone.
- Roles are `"cleaner" | "co-host" | "assistant" | "observer"`. The legacy `observer` field maps to `"observer"`.

## Review Focus

1. **A cleaner texts a bare number, like "2" (a towel count), with no held text.** It must route as a normal text, never be taken as an answer. The test is in Task 6.
2. **A shared person's other property turns cleaning off,** leaving one cleaning property. Their texts must go straight to it with no ask, as with one property today. The test is in Task 6.
3. **Names that overlap.** A label `Lane` against `12 Scratch Lane`, or `Court` inside the word "courtesy". Only a whole word or phrase counts, and two matches mean no match. The test is in Task 2.
4. **One phone, different roles:** the cleaner on A and an observer on B. The refusal and the assignment carry the role per property. The test is in Task 5.
5. **A YES lands while another desk is closed, or the process restarts before the relay runs.** A desk opened later must still find the person opted in or stopped. The account state is applied on every engine open. The test is in Task 4.

---

### Task 1: The account people list

**Files:**
- Create: `src/hub/people.ts`
- Test: `test/hubPeople.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Role = "cleaner" | "co-host" | "assistant" | "observer";
  export interface Person {
    phone: string; name?: string;
    optedIn?: { at: string; propertyId: string };
    stopped?: { at: string };
    invitedFrom?: string;
    where: { propertyId: string; role: Role }[];
  }
  export interface PeopleFile { schemaVersion: 1; people: Person[]; hosts: Record<string, string>; movedAt?: string }
  export type PersonChange = { phone: string; kind: "opted-in" | "stopped" | "started"; from?: string; properties: string[] };
  export interface MoveSource { propertyId: string; host?: string; people: { phone: string; role: Role; name?: string }[]; stopped: string[]; optedIn: string[]; optedOut: string[] }

  export const PEOPLE_FILE = "people.json";
  export function streetOf(address: string): string;                      // text before the first comma, trimmed
  export function accountOf(propertyRoot: string): { accountRoot: string; propertyId: string } | undefined;
  export function peopleFor(accountRoot: string, deps: { now(): Date }): People;
  export function forgetPeople(accountRoot: string): void;
  export function resetPeople(): void;

  export class People {
    person(phone: string): Person | undefined;
    propertiesOf(phone: string): string[];            // propertyIds, in assignment order
    roleOn(phone: string, propertyId: string): Role | undefined;
    hostOf(propertyId: string): string | undefined;
    stopped(phone: string): boolean;
    optedIn(phone: string): boolean;
    invitedElsewhere(phone: string, propertyId: string): boolean;
    savePropertyPeople(propertyId: string, host: string | undefined, people: { phone: string; role: Role; name?: string }[]): void;
    markInvited(phone: string, propertyId: string): void;
    optIn(phone: string, propertyId: string): PersonChange | undefined;   // undefined when already opted in
    stop(phone: string): PersonChange | undefined;                       // undefined when already stopped
    start(phone: string): PersonChange | undefined;                      // undefined when not stopped
    onChange(relay: (change: PersonChange) => Promise<void>): void;      // last one wins
    relay(change: PersonChange | undefined): Promise<void>;              // no-op on undefined
    moved(): boolean;
    move(sources: MoveSource[]): void;
  }
  ```

- [ ] **Step 1: Write the failing tests** in `test/hubPeople.test.ts`. Use a `mkdtempSync` account folder and a fixed clock.
  - `streetOf("12 Scratch Lane, Teaneck, NJ 07666")` is `"12 Scratch Lane"`. `streetOf("9 Annex")` is `"9 Annex"`.
  - `accountOf("/d/tenants/tnt_x/properties/prp_abcdefghij")` returns `{ accountRoot: "/d/tenants/tnt_x", propertyId: "prp_abcdefghij" }`. A folder that isn't `…/properties/prp_[a-z0-9]{10}` returns `undefined`.
  - `savePropertyPeople("prp_a…", HOST, [{phone: C, role: "cleaner"}])`, then the same for `prp_b…` with `C` as `"observer"`:
    - `propertiesOf(C)` equals `["prp_a…","prp_b…"]`
    - `roleOn(C,"prp_b…")` is `"observer"`
    - `hostOf("prp_a…")` is `HOST`
    - `person(HOST)` is `undefined`
  - Saving `prp_a…` with `[]` drops `prp_a…` from `C.where` but keeps the entry. `stopped(C)` still reads after `stop(C)`.
  - `optIn(C,"prp_a…")` returns `{ phone: C, kind: "opted-in", from: "prp_a…", properties: ["prp_a…","prp_b…"] }`. A second call returns `undefined`.
  - `stop(C)` and `start(C)` return their changes. `stopped(C)` flips each time. Calling either one twice returns `undefined`.
  - `markInvited(C,"prp_a…")`:
    - `invitedElsewhere(C,"prp_b…")` is true and `invitedElsewhere(C,"prp_a…")` is false.
    - After `savePropertyPeople("prp_a…", HOST, [])`, `invitedElsewhere(C,"prp_b…")` is false.
    - After `optIn`, it is false.
  - `onChange` gets each change that `relay` is given. `relay(undefined)` calls nothing.
  - **The move:** `move([...])` with a stopped phone, an engine `in` and an engine `out`:
    - sets `stopped`, `optedIn` (with that property) and `stopped` respectively
    - fills `hosts`
    - sets `movedAt`
    - after it, `moved()` is true
    - a second `move` changes nothing
  - **Persistence:** `forgetPeople`, then `peopleFor` again, reads the same state from `people.json`.

- [ ] **Step 2: Run them and see them fail**

  Run: `npx vitest run test/hubPeople.test.ts`. Expected: FAIL (`Cannot find module '../src/hub/people'`).

- [ ] **Step 3: Implement `src/hub/people.ts`**
  - One `People` per account folder, cached in a `Map` like `hubFor` in `src/hub/hub.ts`.
  - Reads are synchronous on an in-memory copy.
  - Each write is followed by `writeJsonAtomic(join(accountRoot, PEOPLE_FILE), file)`.
  - Phones are compared as given. Callers pass E.164.
  - Match the property id with a local `/^prp_[a-z0-9]{10}$/`. Don't import `isPropertyId`.

- [ ] **Step 4: Run them and see them pass**

  Run: `npx vitest run test/hubPeople.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/hub/people.ts test/hubPeople.test.ts
  git commit -m "Account people list in people.json (#190)"
  ```

### Task 2: Property names, the ask, and held texts

**Files:**
- Create: `src/hosted/sharedRoute.ts` (pure text functions)
- Create: `src/hosted/lineAsks.ts` (the held-text store)
- Test: `test/sharedRoute.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // sharedRoute.ts
  export interface Named { id: string; label: string; nickname?: string; address?: string }
  // streetOf comes from src/hub/people.ts (Task 1)
  export function namedProperty(text: string, own: Named[]): string | undefined;   // id, only when exactly one matches
  export function answerOf(text: string, own: Named[]): string | undefined;        // "1".."n" or a name match → id
  export function whichPropertyText(own: Named[]): string;
  export function lineStopText(business: string): string;
  export function lineStartText(business: string): string;
  export function droppedNote(who: string): string;
  export function sharedRefusal(places: { label: string; role: string }[]): string;
  export function businessFor(names: (string | undefined)[]): string;     // the one shared name, else "this number"

  // lineAsks.ts
  export const HOLD_MS = 2 * 60 * 60_000;
  export const ASK_EVERY_MS = 10 * 60_000;
  export interface HeldText { id: string; text: string; media?: { url: string; contentType?: string }[]; propertyIds: string[]; heldAt: string; askedAt: string }
  export class LineAsks {
    constructor(accountRoot: string, now: () => Date);
    held(phone: string): HeldText | undefined;                             // undefined once expired
    hold(phone: string, text: Omit<HeldText, "heldAt" | "askedAt">): { ask: boolean };  // replaces; ask when none was asked in ASK_EVERY_MS
    take(phone: string): HeldText | undefined;                             // removes
    expired(): { phone: string; text: HeldText }[];                        // removes and returns every expired one
  }
  ```

- [ ] **Step 1: Write the failing tests** in `test/sharedRoute.test.ts`.
  - Fixtures:
    - `A = { id: "prp_a…", label: "Beach", address: "12 Scratch Lane, Teaneck, NJ 07666" }`
    - `B = { id: "prp_b…", label: "Court", nickname: "the cottage", address: "8 Scratch Court, Teaneck, NJ 07666" }`
  - `namedProperty`:
    - `"running late at scratch lane"` → A
    - `"the Cottage door sticks"` → B
    - `"thanks for the courtesy"` → `undefined`. "Court" is not a whole word there.
    - `"lane and court both done"` → `undefined`, because two match.
    - `"YES"` → `undefined`
  - `answerOf`:
    - `"1"` → A, `" 2 "` → B, `"3"` → `undefined`
    - `"8 scratch court"` → B
    - `"2 towels left"` → `undefined`. Only a bare number counts.
  - `whichPropertyText([A, B])` equals `"Which property is this about? Reply 1 for 12 Scratch Lane or 2 for 8 Scratch Court."`. Three properties give `"Reply 1 for X, 2 for Y or 3 for Z."`.
  - The ask never contains a label: `whichPropertyText([A,B])` doesn't contain `"Beach"`.
  - `lineStopText`, `lineStartText`, `droppedNote` and `sharedRefusal([{label:"12 Scratch Lane", role:"cleaner"},{label:"8 Scratch Court", role:"observer"}])` equal the Global Constraints copy.
  - `businessFor(["Scratch","Scratch"])` is `"Scratch"`. `businessFor(["Scratch","Other"])` and `businessFor([undefined])` are `"this number"`.
  - `LineAsks`, with a moving clock:
    - the first `hold` returns `{ask: true}`
    - a second `hold` 5 minutes later returns `{ask: false}` and replaces the text
    - a hold 11 minutes after the last ask returns `{ask: true}`
    - `take` returns the latest text and removes it
    - after 2 hours and 1 ms, `held` is `undefined` and `expired()` returns it once
    - state survives a new `LineAsks` on the same folder

- [ ] **Step 2: Run them and see them fail**

  Run: `npx vitest run test/sharedRoute.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement both files**
  - Matching folds case and collapses whitespace. A name matches only at word boundaries (`\b…\b` on an escaped phrase).
  - Candidates per property: `label`, `nickname`, `streetOf(address)`.
  - `line-asks.json` sits in the account folder, as `{ [phone]: HeldText }`.

- [ ] **Step 4: Run them and see them pass**

  Run: `npx vitest run test/sharedRoute.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/hosted/sharedRoute.ts src/hosted/lineAsks.ts test/sharedRoute.test.ts
  git commit -m "Property names, the which-property ask, and held line texts (#190)"
  ```

### Task 3: Engine hooks for account consent

**Files:**
- Modify: `src/cleaner-core/core.ts`:
  - `CleanerCoreOptions` (around `:728-780`)
  - `sendOptIn` (`:1785`), `sendParticipantOptIns` (`:1513`) and `sendGroupInvites` (`:1532`)
  - `optInCleaner` (`:1828`) and `optInParticipant` (`:1546`)
  - `stop` (`:3040`) and `stopMember` (`:2893`)
- Test: `test/cleanerAccountConsent.test.ts`. Build the engine with `openCleanerCore`, the way `test/cleanerCoreGroup.test.ts` does.

**Interfaces:**
- Produces, on `CleanerCoreOptions`:
  ```ts
  /** True when this phone's invite is already out from another property of the account: send none here. */
  optInElsewhere?: (phone: string) => boolean;
  /** Called after this engine moves a phone (cleaner or contact) to "in" by its YES, or to "out" by its STOP. */
  onConsent?: (phone: string, consent: "in" | "out") => void;
  ```
- Produces, on `CleanerCore`:
  ```ts
  waitingOn(phone: string): boolean;                     // invite awaiting YES, offered job, checklist or supplies question open, cleaning in progress
  accountOptIn(phone: string): Promise<CleanerText[]>;   // pending → in, no invite reply; then drains like a YES. Never out → in.
  accountStop(phone: string): Promise<void>;             // → out with today's holds and host note; no STOP reply to the phone
  accountStart(phone: string): Promise<void>;            // today's START state change for that engine, no text to the phone
  ```

- [ ] **Step 1: Write the failing tests** in `test/cleanerAccountConsent.test.ts`, with 555 numbers and a Scratch pin.
  - **Invites held:** `optInElsewhere: (p) => p === CLEANER` sends no `opt-in:` text to the cleaner. With it returning false, one invite goes out as today. Do the same for a group contact.
  - **`onConsent` on YES:** after the invite and the cleaner's YES, `onConsent` was called once with `(CLEANER, "in")`. A contact's YES calls it with `(CONTACT, "in")`.
  - **`onConsent` on STOP:** a STOP one-to-one and in group mode each call `onConsent(phone, "out")` once.
  - **`accountOptIn`:**
    - pending → `in` with no `opt-in:` text sent
    - in group mode, the group intro follows, naming this property's address only
    - on an `out` engine it changes nothing and returns `[]`
  - **`accountStop`:**
    - the cleaner's consent becomes `out`, with `problemHold` and the host note, as a STOP does
    - nothing is sent to the cleaner
    - a later door-code release sends nothing to the cleaner
  - **`accountStart`:**
    - cleaner-only mode: `out` → `in`, with no text to the cleaner
    - group mode: the cleaner stays `out` (`core.ts:3125` rule)
  - **`waitingOn(CLEANER)`:**
    - true after the invite is sent and before YES
    - true with a job `offered`
    - true while a checklist or supplies question is open
    - true with a cleaning in progress
    - false with none of these
    - always false for a phone that isn't on this property

- [ ] **Step 2: Run them and see them fail**

  Run: `npx vitest run test/cleanerAccountConsent.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the options and methods in `core.ts`**
  - `waitingOn` reads only the existing state: `awaitingOptIn()`, `conversationJob()`, `checklistWaiting()`, `supplyWaiting()`, `progressJob()`, and `participantConsent === "pending"` with `opt-in:<phone>` sent.
  - `accountStop` and `accountStart` share the state changes in `stop`, `stopMember` and the START branch (`:3100-3135`) through private helpers. Don't copy those branches.
  - `onConsent` is not called from `accountOptIn`, `accountStop` or `accountStart`. Only a text from the person calls it, so a relay can't loop.
  - The door-code path is not touched.

- [ ] **Step 4: Run the new tests and the engine suites**

  Run: `npx vitest run test/cleanerAccountConsent.test.ts test/cleanerCoreGroup.test.ts test/cleanerDone.test.ts test/cleanerChecklistYes.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/cleaner-core/core.ts test/cleanerAccountConsent.test.ts
  git commit -m "Engine: account opt-in, stop and start hooks (#190)"
  ```

### Task 4: The desk reads and reports account state

**Files:**
- Modify: `src/cleaner-core/liveDesk.ts`:
  - the constructor (`:637`)
  - `labeled` (`:2188`) and `lineOptedOut` (`:2197`)
  - `inboundNow`'s START/YES lift (`:2853-2857`)
  - `inboundBeforeJob` (`:3030`)
  - the engine options (`:3431-3466`)
  - `markOptedOut` (`:2155`), which is removed
- Test: `test/cleanerDeskAccount.test.ts`

**Interfaces:**
- Consumes: `accountOf` and `peopleFor` (Task 1). `optInElsewhere`, `onConsent`, `waitingOn`, `accountOptIn`, `accountStop` and `accountStart` (Task 3).
- Produces, on `LiveDesk`:
  ```ts
  waitingOn(phone: string): Promise<boolean>;     // false with no engine
  accountOptIn(phone: string): Promise<void>;
  accountStop(phone: string): Promise<void>;      // no engine yet: sets cleanerOut for the cleaner, like inboundBeforeJob
  accountStart(phone: string): Promise<void>;     // no engine yet: clears cleanerOut
  moveSource(): Promise<MoveSource>;              // this desk's people, lineOptOuts, and the engine's in/out phones, for Task 5
  ```

- [ ] **Step 1: Write the failing tests** in `test/cleanerDeskAccount.test.ts`.
  - Open two desks whose roots are `<tmp>/tenants/tnt_lane000001/properties/prp_<10>`, using `cleanerDeskHarness`'s env and fakes. Save the same `CLEANER` on both.
  - **Stopped blocks everything:** with `people.stop(CLEANER)` written directly, the sink sends nothing to `CLEANER` on either desk, and a door-code release throws as `lineOptOuts` did.
  - **The relay:** a YES to desk A's invite calls `people.optIn` through `onConsent`. The relay registered with `people.onChange` receives `{kind: "opted-in", from: A, properties: [A, B]}`.
  - **Invites held:** desk B sends no invite while A's is out.
  - **Applied on open (Review Focus 5):** with `people.optIn(CLEANER, A)` written while B is closed, a reopened B (`resetLiveDesks`) treats the cleaner as `in` with no invite. The same holds for `stop`: a reopened B sends nothing to the cleaner.
  - **The prefix:**
    - with the cleaner on two properties, a one-to-one text to them starts with `"12 Scratch Lane: "` (the street part, never the label)
    - with them on one property, there's no prefix
    - texts to the landlord keep today's label prefix
  - **No account:** a desk whose root has no account (`openDesk` from the harness) behaves as today. The existing desk suites cover this.

- [ ] **Step 2: Run them and see them fail**

  Run: `npx vitest run test/cleanerDeskAccount.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - Wire the people list into the desk:
    - The constructor sets `this.account = accountOf(root)` and `this.people = this.account && peopleFor(this.account.accountRoot, { now })`.
    - `lineOptedOut(phone)` becomes `this.people?.stopped(phone) ?? false`. `lineOptOuts` is no longer read or written, apart from `moveSource`.
    - The `inboundNow` lift calls `this.people.start(from)` and then `relay`.
  - Wire the engine to the account:
    - The engine options pass `optInElsewhere: (p) => this.people?.invitedElsewhere(p, id) ?? false`.
    - They pass `onConsent`, which calls `people.optIn(p, id)` or `people.stop(p)` and then `people.relay(...)`. It's async, but the engine call doesn't await it.
    - After every engine open, apply the account to each person on this desk: stopped → `accountStop`, opted in → `accountOptIn`.
  - Record the invite: when the engine emits `kind: "opt-in"` to a person, call `people.markInvited(phone, id)`.
  - Prefix `labeled` with `streetOf(this.place.address)` for a one-to-one text to a phone where `people.propertiesOf(phone).length >= 2`. Import `streetOf` from `src/hub/people.ts`. Cleaner Core never imports the hosted layer.

- [ ] **Step 4: Run the new tests and the desk suites**

  Run: `npx vitest run test/cleanerDeskAccount.test.ts test/cleanerLineDesk.test.ts test/cleanerHostOptOut.test.ts test/inboundTextPipeline.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/cleaner-core/liveDesk.ts test/cleanerDeskAccount.test.ts
  git commit -m "Desk reads account opt-in and STOP, and reports its own (#190)"
  ```

### Task 5: The hosted layer: move, relay, and saving shared people

**Files:**
- Create: `src/hosted/sharedPeople.ts`
- Modify:
  - `src/hosted/lineRouter.ts`: remove `phoneTaken`, `peopleRefusal` and `afterPeopleSaved` (they move here)
  - `src/hosted/frontMcp.ts:8, 197-202`
  - `src/cleaner-core/mcp.ts:43-51`: `save_people` takes `shared?: boolean`
  - `src/cleaner-core/liveDesk.ts`: `PeopleInput` (`:320`) accepts and ignores `shared`
- Test: `test/sharedPeopleSave.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2 and 4.
- Produces:
  ```ts
  export function accountPeople(h: HostedCleaner, tenant: Tenant): People;   // registers the relay once; runs movePeople if not moved
  export async function movePeople(h: HostedCleaner, tenant: Tenant): Promise<void>;
  export async function peopleRefusal(h: HostedCleaner, tenant: Tenant, property: Property, args: Record<string, unknown>): Promise<string | undefined>;
  export async function afterPeopleSaved(h: HostedCleaner, tenant: Tenant, property: Property): Promise<void>;
  ```
- The relay: for each property id in `change.properties` except `change.from`, open its desk with `propertyContext` and call `accountOptIn`, `accountStop` or `accountStart`, matching `change.kind`.

- [ ] **Step 1: Write the failing tests** in `test/sharedPeopleSave.test.ts`. Use the `twoProperties()` setup from `test/lineRouting.test.ts`, moved into `test/lineHarness.ts` so both files share it.
  - **Refused without `shared`:**
    - Saving Lane's cleaner `CLEANER` as Court's cleaner without `shared` is refused with `sharedRefusal([{label:"12 Scratch Lane", role:"cleaner"}])`.
    - `m.sms.sent` is unchanged.
  - **With `shared: true` (Review Focus 4):**
    - the save succeeds
    - `people.json` has `CLEANER` on both properties
    - with the role `"observer"` on Court when saved as `observer`
  - **Several matches:** the refusal names both, joined with `" and "`.
  - **Still refused, even with `shared: true`:**
    - the landlord's phone as a cleaner or contact (today's `phoneTaken`-style refusal, kept)
    - a person's phone as `host`
  - **A person added later who already said YES on Lane:**
    - Court sends them no invite
    - Court's engine has them `in`
    - Court's intro (group mode) names only `8 Scratch Court`
  - **The move:**
    - An account set up before the deploy (the desks saved, `opt-outs.json` with a phone, no `people.json`) gets `people.json` on `accountPeople`, with `movedAt` set and that phone `stopped`.
    - `opt-outs.json` is still on disk.

- [ ] **Step 2: Run them and see them fail**

  Run: `npx vitest run test/sharedPeopleSave.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**
  - `afterPeopleSaved` calls `people.savePropertyPeople(property.id, host, people)` from `desk.phonesOnProperty()` plus the roles from the desk file. It then calls `accountOptIn` and `accountStop` on this desk for anyone who arrived already opted in or stopped.
  - `movePeople` builds a `MoveSource` per cleaning property from `desk.moveSource()`, adds `TenantOptOuts`' phones as `stopped` on the first source, and calls `people.move`.
  - `TenantOptOuts` stays for touring and for `knownToCleaning`. The line router stops writing it in Task 6.

- [ ] **Step 4: Run the new tests**

  Run: `npx vitest run test/sharedPeopleSave.test.ts test/sharedServiceTenants.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/hosted/sharedPeople.ts src/hosted/lineRouter.ts src/hosted/frontMcp.ts src/cleaner-core/mcp.ts src/cleaner-core/liveDesk.ts test/sharedPeopleSave.test.ts test/lineHarness.ts test/lineRouting.test.ts
  git commit -m "Shared people: the host's shared: true, the move, and the relay (#190)"
  ```

### Task 6: Routing a shared person's text

**Files:**
- Modify: `src/hosted/lineRouter.ts`:
  - `routeLineText` (`:36-52`)
  - `phonesOf` (`:55`), which is removed
  - `handleLineText` (`:81-129`)
- Modify: `src/hosted/frontMcp.ts`: `check_now` calls `sweepHeldTexts` for the account
- Test: `test/lineRouting.test.ts`. Extend it, and rewrite the one-property-per-person cases.

**Interfaces:**
- Consumes: `accountPeople` (Task 5), `LineAsks` and `sharedRoute` (Task 2), and `LiveDesk.waitingOn` (Task 4).
- Produces:
  ```ts
  export type LineRoute =
    | { kind: "property"; property: Property }
    | { kind: "person-all"; properties: Property[] }        // a shared person's STOP or START
    | { kind: "person-help" }                                // a shared person's HELP: no desk, no reply
    | { kind: "shared"; properties: Property[] }             // a shared person's other text: name, context, then ask
    | { kind: "host-all"; properties: Property[] }
    | { kind: "host-unused"; property: Property }
    | { kind: "host-help" }
    | { kind: "unknown" };
  export function routeLineText(tenant: Tenant, from: string, text: string, people: Pick<People, "propertiesOf" | "hostOf">): LineRoute;
  export async function sweepHeldTexts(h: HostedCleaner, tenant: Tenant): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**
  - In `routeLineText`'s unit block, replace the `phones` callback with a fake `{ propertiesOf, hostOf }`. Keep every existing expectation. Add:
    - a phone on both Lane and Court: `"YES"` → `shared`, `"STOP"` → `person-all`, `"HELP"` → `person-help`
    - **Review Focus 2:** the same phone, with Court's cleaning off → `property` Lane
  - Integration tests, with one `CLEANER` saved on Lane and Court through `shared: true`, both cleaner-only:
    - **Named:** `"running late at 8 Scratch Court"` reaches only Court (`seenInbound`).
    - **Context:** Lane's invite went out. The cleaner's `"YES"` reaches Lane by context and opts them in on both. Court's engine has them `in`, with no Court invite sent.
    - **Ask:**
      - With no property waiting, `"what time is checkout?"` gets exactly `whichPropertyText([...both])` and reaches no desk.
      - Then `"2"` delivers the held text to Court with its original message id, and nothing to Lane.
      - Answering `"8 scratch court"` works the same.
    - **Replace and the 10-minute limit:**
      - two unanswered texts 5 minutes apart give one ask
      - a third text 11 minutes after the ask gives a second ask
      - the answer delivers only the latest text
    - **Drop:**
      - 2 hours and 1 minute after the hold, `check_now` (via `sweepHeldTexts`) drops it
      - both properties' `check_now` show `droppedNote` for the cleaner
      - the note has no digit runs from the text
    - **Review Focus 1:** with nothing held, a bare `"2"` from the cleaner with Lane waiting goes to Lane as a normal text, not as an answer.
    - **STOP:**
      - a one-to-one `"STOP"` gives exactly one text to the cleaner, `lineStopText("Scratch")`
      - `people.json` marks them `stopped`
      - both engines are `out`
      - each property's host note shows in its `check_now`
    - **START:** a one-to-one `"START"` gives exactly one text, `lineStartText("Scratch")`. In cleaner-only mode both engines are `in` again.
    - **HELP:** `"HELP"` sends nothing and reaches no desk.
    - **YES after STOP:** a stopped cleaner's one-to-one `"YES"` with no property waiting clears `stopped` on both properties and then gets the ask.
    - **Group STOP:** a STOP in Lane's group (group mode) stops Court too.
  - Rewrite the existing cases "an unknown sender … STOP holds when the phone is later saved" and "a cleaner's START lifts the line opt-out for good" to assert on `people.json`'s `stopped`, not on `lineOptOuts`.

- [ ] **Step 2: Run them and see them fail**

  Run: `npx vitest run test/lineRouting.test.ts`. Expected: the new cases FAIL.

- [ ] **Step 3: Implement**
  - `routeLineText` uses `propertiesOf(from)`, filtered to cleaning-on properties, and `hostOf` for the landlord.
  - `handleLineText`:
    - **`shared`:** call `sweepHeldTexts` first. A `YES` from a stopped person runs `people.start` and the relay before anything else (the spec's "A YES from a stopped person also removes `stopped`"). Then:
      1. a held text plus an `answerOf` match → deliver the held text
      2. `namedProperty`
      3. exactly one desk's `waitingOn`
      4. `LineAsks.hold`, and send `whichPropertyText` when `ask` is true
    - **Delivery to a desk:** call `liveDeskFor(...).inbound({ id, from, text, media })` with the held or current message id. It is already signature-checked, so it isn't replayed through `handleCleanerTwilioWebhook`.
    - **`person-all`:** `people.stop` or `people.start`, then `people.relay` with `from: undefined` so every property applies it. Then send one line reply with `businessFor` over the properties' business names.
    - **A one-to-one STOP or START from any non-landlord phone** marks `people.stop` or `people.start`. This replaces the `TenantOptOuts` writes on the `property` and `unknown` routes.
  - `sweepHeldTexts` takes `LineAsks.expired()` and calls `noteForHost` on each of the held text's properties with `droppedNote`, through a new `LiveDesk.noteDroppedText(who: string)`. It mirrors `noteUnusedHostText` with its digit redaction.

- [ ] **Step 4: Run the routing and line suites**

  Run: `npx vitest run test/lineRouting.test.ts test/cleanerLineDesk.test.ts test/sharedServiceRouting.test.ts test/crossService.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/hosted/lineRouter.ts src/hosted/frontMcp.ts src/cleaner-core/liveDesk.ts test/lineRouting.test.ts
  git commit -m "Line routing for shared people: name, context, then ask (#190)"
  ```

### Task 7: The leak test, the gate, and the full proof

**Files:**
- Create: `test/sharedPeopleEndToEnd.test.ts`
- Modify: `docs/cleaner-core-safety-gates.md:20` (the "Own property only" row only)
- Modify: `docs/hosted-multitenancy.md`, one line under the account folder layout: `people.json` and `line-asks.json`

- [ ] **Step 1: Write the leak test**
  - Model it on `test/twoPropertiesEndToEnd.test.ts`'s `beforeAll`:
    - Two properties, using `SCRATCH_TENANTS`' Lane and Court addresses and pins.
    - `LANE.cleanerPhone` is saved as the cleaner on both. Court's save passes `shared: true`.
    - Lane uses group mode and Court is cleaner-only.
  - Drive:
    - YES to the invite
    - each turnover's YES and the door code after `mark_guests_left`
    - DONE on both
    - a "which property?" ask and its answer
    - STOP and START one-to-one
    - HELP
  - **Leak assertions:**
    - Every `m.sms.sent` and group post whose audience includes the cleaner, about Lane, contains none of `COURT.pin`, `"8 Scratch Court"`, `"Scratch Court"` or Court's label. The reverse holds for texts about Court.
    - "About Lane" means the text's prefix, or the desk that sent it.
    - Every ask text contains no label.
  - **Door codes:**
    - `pinSends` holds exactly one text with `LANE.pin` and one with `COURT.pin`, both to the cleaner
    - neither code is in any saved file (copy the last test of `twoPropertiesEndToEnd`)

- [ ] **Step 2: Run it**

  Run: `npx vitest run test/sharedPeopleEndToEnd.test.ts`. Expected: PASS. If it fails, the fix goes in the task that owns the code, not in this test.

- [ ] **Step 3: Rewrite the gate row**
  - The row keeps its other sentences, and its proof column adds `test/sharedPeopleEndToEnd.test.ts` and `test/sharedPeopleSave.test.ts`.
  - It replaces "Each property's people are its own: a phone can be a person on only one of the account's properties, and the landlord's phone a person on none." with: "A phone is a person on several of the account's properties only after the host's `shared: true`, and the landlord's phone is a person on none. A shared person's one-to-one text that names no property goes to the one property waiting on them, or gets "which property?", which lists only their properties. Their STOP covers every property. No text to them names, hints at, or carries another property's address, label or door code."

- [ ] **Step 4: Run the full verification**
  - `npm run typecheck` gives no output and exits 0.
  - `npm test` reports all files passing. The baseline was 194 files and 3,155 tests, and the count only grows.
  - `bash .cursor/skills/verify-cleanercore/scripts/prove-step-g.sh` exits 0 with `sends` false.
  - `node scripts/scan-cleaner-secrets.mjs` exits 0.

- [ ] **Step 5: Commit**

  ```bash
  git add test/sharedPeopleEndToEnd.test.ts docs/cleaner-core-safety-gates.md docs/hosted-multitenancy.md
  git commit -m "Shared people: leak test and the Own property only gate (#190)"
  ```
