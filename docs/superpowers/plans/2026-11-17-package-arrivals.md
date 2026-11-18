# Package Arrivals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expected deliveries from Supply Core orders, their seen/not-seen flags, and the bring-it-in visit (no lock code yet), with hours log rows (#241).

**Architecture:** A new `src/package-arrivals/` module with its own `packages.json` per property. It reads Supply Core's `supply.json` on each call and never writes it. Tools are answered on the shared service behind `PACKAGE_ARRIVALS=1`, like the hours log and stay check. The hours log gets a `packageRows` source.

**Tech Stack:** TypeScript, Node, vitest. JSON Schema tool inputs (like `src/stay-check/tools.ts`).

**Spec:** `docs/superpowers/specs/2026-11-17-package-arrivals-design.md`

## Global Constraints

- Nothing in this module texts anyone, and no lock code appears anywhere.
- Tests use made-up names, 555 numbers and made-up addresses only.
- `bringInHours`: whole number 1 to 72. End of day: local 21:00.
- Allowed bring-in roles: `cleaner`, `co-host`, `assistant`. Must be opted in and not stopped.
- `how`: `tracking` | `host` | `camera`. Camera beats any other signal; otherwise the earliest signal is kept.
- A broken `packages.json` is a refusal and is never overwritten.
- Copy: plain, short sentences, no em-dashes in user-facing text.

## Review Focus

- An order with no `expectedBy`: listed, never flagged not-seen. (Task 2 test)
- Supply Core marks an order delivered after the host already said it was seen: the host's earlier time stays. (Task 2 test)
- The default person stops (STOP) after being saved: planning refuses them, the visit is not auto-planned. (Task 3 test)
- `mark_brought_in` with `startedAt` after `at`, or `at` in the future: refused. (Task 3 test)
- Property not under an account folder (no shared people list): planning refuses with a plain line, the rest works. (Task 3 test)

---

### Task 1: Record and settings

**Files:**
- Create: `src/package-arrivals/store.ts`
- Test: `test/packageStore.test.ts`

**Interfaces:**
- Produces: `PACKAGES_FILE = "packages.json"`, `type SeenHow = "tracking" | "host" | "camera"`, `interface Arrival { seen?: { at: string; how: SeenHow }; notSeenTold?: boolean; visit?: { person: string; name?: string; role: "cleaner" | "co-host" | "assistant"; plannedAt: string }; broughtIn?: { at: string; startedAt?: string; note?: string }; lateTold?: boolean }`, `interface PackagesFile { settings: { bringInHours?: number; person?: string }; arrivals: Record<string, Arrival> }`, `class PackagesFileError`, `readPackages(root): PackagesFile`, `writePackages(root, file): void`, `supplyKey(orderId): string` (`supply:<id>`).

- [ ] Test: missing file reads as `{ settings: {}, arrivals: {} }`; round trip; a non-object file throws `PackagesFileError` and is left byte-for-byte.
- [ ] Run, see fail; implement (mirror `src/stay-check/store.ts`); run, pass; commit.

### Task 2: Expected deliveries and check_packages

**Files:**
- Create: `src/package-arrivals/desk.ts`
- Test: `test/packageDesk.test.ts`

**Interfaces:**
- Consumes: Task 1; `readSupply` from `src/supply-core/store.ts`; `readHubFile` for `property.timeZone`; `zonedParts`/`localDateOf` from `src/core/timezone.ts`.
- Produces: `class PackageDesk(root, deps: { now(): Date; people?(): PeopleView | undefined })`, `packageDeskFor(root, deps)`, `resetPackageDesks()`, `interface PackageReply { text; structured?; isError }`, `END_OF_DAY = "21:00"`, `check(): PackageReply`, `markSeen(input): PackageReply`, `saveSettings(input): PackageReply`. `PeopleView = { propertyId: string; person(phone): Person | undefined; roleOn(phone, propertyId); optedIn(phone); stopped(phone) }`.

`check()` structured: `{ expected: Delivery[], notSeen: Delivery[], waiting: Delivery[], toBringIn: Delivery[], visits: Visit[], bringInLate: Visit[], ask?: string, next?: string }`. `Delivery = { orderId, store, items: string[], expectedBy?, seen? }`. `Visit = { orderId, name?, by: string (ISO) | undefined, broughtIn?: false }`. `notSeen` and `bringInLate` carry each delivery only the first time (sets `notSeenTold`/`lateTold`); later checks list them in `waiting` / `visits` without the flag.

- [ ] Tests (made-up order fixture in `supply.json`, hub with `America/New_York`):
  - placed order expected tomorrow → in `expected`, not `notSeen`.
  - expected today, now 20:59 local → not flagged; 21:00 local → `notSeen` once, second call → in `waiting`, not `notSeen`.
  - expected yesterday, Supply Core `deliveredAt` set → seen by `tracking`, not flagged.
  - no `expectedBy` → listed, never `notSeen`.
  - `unconfirmed` orders → not listed.
  - `markSeen({orderId, how:"host", at})` then Supply Core delivered later → `seen.how` stays `host` with the earlier time; `markSeen` with `camera` replaces it.
  - unknown order id → refusal; future `at` → refusal; bad `how` → refusal.
  - no `bringInHours` saved → `ask` present; `saveSettings({bringInHours: 0})` and `73` refused, `4` saved.
- [ ] Run, fail; implement; run, pass; commit.

### Task 3: The bring-it-in visit

**Files:**
- Modify: `src/package-arrivals/desk.ts`
- Test: `test/packageVisit.test.ts`

**Interfaces:**
- Produces: `planBringIn({ orderId, person? }): PackageReply`, `markBroughtIn({ orderId, at?, startedAt?, note? }): PackageReply`, `saveSettings({ person: string | null })`, `CODE_WAITING` line. Visit deadline = seen.at + bringInHours.
- `markSeen` auto-plans when a default person is saved and still allowed.

- [ ] Tests (people.json written via `peopleFor(accountRoot).savePropertyPeople` + `optIn`, property folder at `<tmp>/tenants/tnt_x/properties/prp_xxxxxxxxxx`):
  - plan with the opted-in cleaner → `visit` saved with name and role, reply has `code: "waiting"` and `by` only after seen.
  - person not on property / not opted in / stopped / observer → refused with plain line.
  - no person and no default → refusal asking who; default saved → used.
  - default saved, then `markSeen` → visit planned at once; default stopped → not planned, `toBringIn` lists it.
  - no `bringInHours` → plan refused with the ask.
  - `check()` after deadline with no bring-in → `bringInLate` once.
  - `markBroughtIn` before seen / without visit → refused; `startedAt` after `at` → refused; future `at` → refused; success closes the visit (not in `visits`).
  - property folder not under an account → plan refused with a plain line that it has no shared people list.
- [ ] Run, fail; implement; run, pass; commit.

### Task 4: Hours log rows

**Files:**
- Modify: `src/hours-log/codes.ts` (row kinds `package-drop`, `bring-in`; codes `PKG-1` Package delivered, `PKG-2` Bring a package inside, group `Packages`), `src/hours-log/fact.ts` (Actor `helper`, LogKey `helper:${string}`), `src/hours-log/sources.ts` (`packages?: PackagesFile` in records, `packageRows`, in `DEFAULT_SOURCES`).
- Test: `test/hoursPackages.test.ts`

- [ ] Tests: seen order → Property Core row at seen time, `timing: "system"`, reference names the order and `how`; brought in by the cleaner with `startedAt` → cleaner log, `measured`, `until` = at; by a co-host → `helper:` log named after them, no phone anywhere in the row; no `startedAt` → single moment with `needs`; neither kind lands in the owner log.
- [ ] Run, fail; implement; run all hours tests; commit.

### Task 5: Tools, service wiring, docs

**Files:**
- Create: `src/package-arrivals/tools.ts` (`PACKAGE_TOOLS`, `PACKAGE_TOOL_NAMES`, `handlePackageTool(desk, name, args)`), `src/hosted/packages.ts` (`PACKAGE_FRONT_NAMES`, `listedPackageFront(h, tenant)`, `packageCall(h, tenant, property, name, args)`).
- Modify: `src/cleaner-core/flag.ts` (`packageArrivalsOn(env)` on `PACKAGE_ARRIVALS`), `src/hosted/frontMcp.ts` (list and route like stay check; listed while flag on and a property runs Supply Core), `docs/environment-variables.md`, `SUPPLY_CORE_BOOTSTRAP.md` (every-run step), `supply-template/routines/supply-core-check.md`.
- Test: `test/packageHosted.test.ts`, modelled on `test/stayCheckHosted.test.ts`.

- [ ] Tests: flag off → not listed and call refused; flag on, supplies on → five tools listed; a call reaches the desk for the named property; property without Supply Core → refused.
- [ ] Run, fail; implement; `npm run typecheck && npm run build && npm test`; commit.
