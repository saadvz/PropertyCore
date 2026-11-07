# Supply Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A landlord's Grok Bot keeps a rental stocked: Supply Core keeps the list, schedules, spending, and order log, says what's due, and decides go or hold on every cart; Grok shops and checks out with its own shopping tools and Vault. It runs standalone or as a Cleaner Core add-on fed by the cleaner's answer after DONE.

**Architecture:** A new module `src/supply-core/` holds pure helpers (`schedule.ts`, `gate.ts`, `cards.ts`), the record (`store.ts`, one `supply.json` per tenant folder), the desk that runs every tool (`desk.ts`), setup steps (`setupAsk.ts`), and the MCP tool table (`tools.ts`). The shared service's front door (`src/hosted/frontMcp.ts`) answers Supply Core's tools in-process: for a `supplies` tenant as its whole tool list, and for a `cleaning` tenant with the add-on on, appended to Cleaner Core's list on Grok connections. Cleaner Core's engine (`core.ts`) gains the DONE supplies question behind a `supplyAsk` option that `liveDesk.ts` sets from `supply.json`.

**Tech Stack:** TypeScript (Node 22), vitest, zod 4 (MCP inputs).

**Spec:** `docs/superpowers/specs/2026-11-04-supply-core-design.md`

## Global Constraints

- Supply Core never takes card details and never buys. Every Supply Core tool schema is `.strict()`, and every string in a tool's arguments passes `refuseCards` (Task 2) before anything is saved or logged.
- Tests use only 555 numbers, made-up door codes from `SCRATCH_TENANTS`, made-up stores, links on `https://shop.example/…`, and made-up order numbers. No test reaches a real store or the network.
- Money is whole cents. Product price `1`–`500_000`. `perOrderCapCents` `100`–`500_000`. `perMonthCapCents` `100`–`2_000_000`. `priceJumpPct` `5`–`100`, default `20`. `bufferDays` `0`–`14`, default `3`. `qtyPerOrder` `1`–`50`. Up to `30` items. `every.days` `1`–`365`. `monthlyOn` `1`–`28`. `bookings.stays` `1`–`50`. `storeNote` under `160` characters.
- Cart tokens and approved carts last `30` minutes. An order not delivered keeps its items "on their way" for `14` days. The cleaner's supplies answer is taken within `12` hours of the question.
- Exact copy:
  - Done text with supplies on: `Thanks, cleaning marked done. Anything running low? Reply with what's low, or NONE.`
  - Reply to the cleaner's answer: `Thanks, noted.`
  - Service choice label: `Supply Core: supplies reordered for a property`
  - Price-jump question: `{Item} went from {$old} to {$new}. Buy anyway, switch to your backup, or skip?` (dollars as `$24.00`)
  - Order line: `Ordered from {store}: {items}. {$total}, arriving {Weekday}.`
- `SUPPLY_CORE=1` offers the `supplies` service choice. Without it, nothing about service choice changes. The cleaning add-on (`turn_on_supplies`) is offered on Grok connections whether or not the flag is set.
- Supply Core's tools are listed only on Grok connections (`caller.assistant === "grok"`).
- `docs/cleaner-core-safety-gates.md` stays green. Existing cleaning and touring tenants behave exactly as today until a cleaning tenant turns supplies on.
- Run one file with `npx vitest run <file>`. The full gate is `scripts/ci-check.sh`.

## Review Focus

1. **Supplies turned on mid-cleaning.** The cleaner already has the code and texts DONE after the host activates supplies. Expect: the combined done text, because the engine reloads on activation (`refreshSupplyAsk`). Test in Task 7.
2. **The landlord says yes after the cart's 30 minutes ran out.** Expect: `approve_cart` with the code refuses (`That cart expired. Check it again.`), and `record_order` refuses. Nothing is recorded as approved. Test in Task 4.
3. **Two carts with the same item checked back to back** (the daily routine and the Cleaner Core routine overlap). Expect: the second `check_cart` refuses with `in-open-cart`, with no token. Test in Task 4.
4. **A month boundary in the property's time zone.** An order placed at 23:30 on Oct 31 in New York (03:30 UTC Nov 1) counts toward October, not November. Test in Task 3.
5. **The cleaner's supplies answer contains the door code or a long digit run** ("out of soap, code is 4812"). Expect: the saved `supplyReport.text` and the kept message have the digits redacted, and nothing is held as a code-exposure review only because of the redaction path. Test in Task 7.

---

### Task 1: `schedule.ts`, when an item is due

**Files:**
- Create: `src/supply-core/schedule.ts`
- Test: `test/supplySchedule.test.ts`

**Interfaces:**
- Consumes: `addCalendarDays(ymd: string, days: number): string` from `src/cleaner-core/calendar.ts`.
- Produces:
  - `type Schedule = { kind: "every"; days: number } | { kind: "every"; monthlyOn: number } | { kind: "bookings"; stays: number } | { kind: "custom"; rrule: string; said: string }`
  - `scheduleProblem(schedule: Schedule): string | undefined` (plain-language refusal, or undefined when valid)
  - `nextDates(schedule: Schedule, startYmd: string, afterYmd: string, count: number, checkouts?: readonly string[]): string[]` (for `bookings`, the checkout dates on which the count would be reached; `[]` when unknown)
  - `interface DueInput { schedule: Schedule; anchorYmd?: string; startYmd: string; todayYmd: string; checkouts: readonly string[]; lowReported: boolean }` where `anchorYmd` is the later of the last order and the last skip, and `startYmd` is the item's save date or Activate, whichever is later
  - `dueOn(input: DueInput): { due: boolean; why?: "schedule" | "report"; occurrenceYmd?: string }`
  - `deadlineFor(input: { todayYmd: string; occurrenceYmd?: string; bufferDays: number; nextCleaningYmd?: string }): string`

- [ ] **Step 1: Write the failing tests** in `test/supplySchedule.test.ts`:

```ts
describe("scheduleProblem", () => {
  it("accepts the documented bounds", () => {
    expect(scheduleProblem({ kind: "every", days: 1 })).toBeUndefined();
    expect(scheduleProblem({ kind: "every", days: 365 })).toBeUndefined();
    expect(scheduleProblem({ kind: "every", monthlyOn: 28 })).toBeUndefined();
    expect(scheduleProblem({ kind: "bookings", stays: 50 })).toBeUndefined();
    expect(scheduleProblem({ kind: "custom", rrule: "FREQ=MONTHLY;BYDAY=1MO;BYMONTH=5,6,7,8,9", said: "first Monday, May to September" })).toBeUndefined();
  });
  it("refuses out-of-range values and unsupported rules", () => {
    expect(scheduleProblem({ kind: "every", days: 0 })).toBeDefined();
    expect(scheduleProblem({ kind: "every", monthlyOn: 29 })).toBeDefined();
    expect(scheduleProblem({ kind: "bookings", stays: 51 })).toBeDefined();
    expect(scheduleProblem({ kind: "custom", rrule: "FREQ=HOURLY", said: "hourly" })).toBeDefined();
    expect(scheduleProblem({ kind: "custom", rrule: "FREQ=DAILY;BYHOUR=9", said: "9am" })).toBeDefined();
    expect(scheduleProblem({ kind: "custom", rrule: "FREQ=WEEKLY;UNTIL=20200101", said: "ended" })).toBeDefined(); // never fires again
  });
});

describe("nextDates", () => {
  it("gives the next 3 dates of a custom rule", () => {
    expect(nextDates({ kind: "custom", rrule: "FREQ=MONTHLY;BYDAY=1MO;BYMONTH=5,6,7,8,9", said: "" }, "2026-11-04", "2026-11-04", 3))
      .toEqual(["2027-05-03", "2027-06-07", "2027-07-05"]);
  });
  it("handles INTERVAL, BYMONTHDAY, BYSETPOS and COUNT", () => {
    expect(nextDates({ kind: "custom", rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", said: "" }, "2026-11-03", "2026-11-03", 3)).toEqual(["2026-11-17", "2026-12-01", "2026-12-15"]);
    expect(nextDates({ kind: "custom", rrule: "FREQ=MONTHLY;BYMONTHDAY=15", said: "" }, "2026-11-04", "2026-11-04", 2)).toEqual(["2026-11-15", "2026-12-15"]);
    expect(nextDates({ kind: "custom", rrule: "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", said: "last weekday" }, "2026-11-04", "2026-11-04", 2)).toEqual(["2026-11-30", "2026-12-31"]);
    expect(nextDates({ kind: "custom", rrule: "FREQ=DAILY;COUNT=2", said: "" }, "2026-11-04", "2026-11-04", 5)).toEqual(["2026-11-05"]);
  });
  it("gives every-N-days dates from the start", () => {
    expect(nextDates({ kind: "every", days: 21 }, "2026-11-04", "2026-11-04", 2)).toEqual(["2026-11-25", "2026-12-16"]);
  });
});

describe("dueOn", () => {
  const base = { startYmd: "2026-11-01", todayYmd: "2026-11-04", checkouts: [], lowReported: false };
  it("is due on Activate for an every-N-days item never ordered", () => {
    expect(dueOn({ ...base, schedule: { kind: "every", days: 21 } })).toMatchObject({ due: true, why: "schedule" });
  });
  it("is due again N days after the last order, not before", () => {
    expect(dueOn({ ...base, schedule: { kind: "every", days: 21 }, anchorYmd: "2026-10-15" }).due).toBe(false);
    expect(dueOn({ ...base, schedule: { kind: "every", days: 21 }, anchorYmd: "2026-10-14" }).due).toBe(true);
  });
  it("is due on the month day, or the first run after it, once", () => {
    expect(dueOn({ ...base, schedule: { kind: "every", monthlyOn: 3 } })).toMatchObject({ due: true, occurrenceYmd: "2026-11-03" });
    expect(dueOn({ ...base, schedule: { kind: "every", monthlyOn: 3 }, anchorYmd: "2026-11-03" }).due).toBe(false);
    expect(dueOn({ ...base, schedule: { kind: "every", monthlyOn: 5 } }).due).toBe(false);
  });
  it("counts checkouts after the anchor for bookings", () => {
    const checkouts = ["2026-10-20", "2026-10-28", "2026-11-02", "2026-11-04", "2026-11-09"];
    expect(dueOn({ ...base, schedule: { kind: "bookings", stays: 3 }, anchorYmd: "2026-10-25", checkouts }).due).toBe(true);
    expect(dueOn({ ...base, schedule: { kind: "bookings", stays: 4 }, anchorYmd: "2026-10-25", checkouts }).due).toBe(false); // 11-09 is after today
  });
  it("is due now on a low report, whatever the schedule", () => {
    expect(dueOn({ ...base, schedule: { kind: "every", days: 365 }, anchorYmd: "2026-11-03", lowReported: true })).toMatchObject({ due: true, why: "report" });
  });
});

describe("deadlineFor", () => {
  it("is the day before the next cleaning with Cleaner Core", () => {
    expect(deadlineFor({ todayYmd: "2026-11-04", bufferDays: 3, nextCleaningYmd: "2026-11-09" })).toBe("2026-11-08");
  });
  it("is the cleaning day itself when the cleaning is today or tomorrow", () => {
    expect(deadlineFor({ todayYmd: "2026-11-04", bufferDays: 3, nextCleaningYmd: "2026-11-05" })).toBe("2026-11-05");
    expect(deadlineFor({ todayYmd: "2026-11-04", bufferDays: 3, nextCleaningYmd: "2026-11-04" })).toBe("2026-11-04");
  });
  it("is the occurrence (never before today) plus the buffer otherwise", () => {
    expect(deadlineFor({ todayYmd: "2026-11-04", bufferDays: 3, occurrenceYmd: "2026-11-01" })).toBe("2026-11-07");
    expect(deadlineFor({ todayYmd: "2026-11-04", bufferDays: 0 })).toBe("2026-11-04");
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run test/supplySchedule.test.ts`. Expected: FAIL, cannot resolve `../src/supply-core/schedule`.

- [ ] **Step 3: Implement `src/supply-core/schedule.ts`.** Dates are local `YYYY-MM-DD` strings throughout; the caller converts instants with `localDateOf`. The RRULE subset is `FREQ` (DAILY, WEEKLY, MONTHLY, YEARLY), `INTERVAL`, `BYDAY` (with an optional ordinal such as `1MO` or `-1FR` for MONTHLY and YEARLY), `BYMONTHDAY`, `BYMONTH`, `BYSETPOS`, `COUNT`, `UNTIL` (`YYYYMMDD`). Any other part refuses. Evaluate day by day from `startYmd` for up to 3 years: a date is a candidate when it passes every BY* filter and its period index from `startYmd` (days, weeks from the start's Monday, months, years) is a multiple of `INTERVAL`. Without BY* parts, WEEKLY takes the start's weekday, MONTHLY the start's day of month, and YEARLY the start's month and day. Apply `BYSETPOS` within each period's candidate list. `COUNT` counts occurrences from `startYmd`, with `startYmd` itself excluded. `UNTIL` is inclusive. A rule with no occurrence after `afterYmd` within 3 years, or one that would produce more than one occurrence per day, is refused by `scheduleProblem`. `nextDates` returns occurrences strictly after `afterYmd`. `every.days` occurrences are `startYmd + k·days` for k ≥ 1. `dueOn` for `monthlyOn` and `custom` is due when an occurrence falls in `(anchorYmd ?? startYmd − 1 day, todayYmd]`, and returns the latest such date as `occurrenceYmd`.

- [ ] **Step 4: Run to verify it passes.** `npx vitest run test/supplySchedule.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/supply-core/schedule.ts test/supplySchedule.test.ts
git commit -m "Supply Core: schedules, due dates, and deadlines"
```

---

### Task 2: `cards.ts` and `gate.ts`, refusing card details and deciding go or hold

**Files:**
- Create: `src/supply-core/cards.ts`, `src/supply-core/gate.ts`
- Test: `test/supplyGate.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `looksLikeCard(text: string): boolean`: true for a run of 13 to 19 digits (single spaces or dashes allowed between digits) that passes the Luhn check.
  - `refuseCards(args: unknown): boolean`: true when any string anywhere in `args` (deep, arrays and objects) `looksLikeCard`.
  - `type Mode = "hands-off" | "checkout"`
  - `interface CartLine { itemId: string; product: "preferred" | "backup"; qty: number; unitCents: number }`
  - `interface CartInput { store: string; items: CartLine[]; shippingCents: number; taxCents: number; totalCents: number; deliveryBy: string }`
  - `type RemoveFirst = "unknown-item" | "not-due" | "on-its-way" | "in-open-cart"`
  - `type Approvable = "price-jump" | "over-order-cap" | "over-month-cap" | "misses-deadline" | "checkout-mode"`
  - `interface GateContext { mode: Mode; perOrderCapCents?: number; perMonthCapCents?: number; priceJumpPct: number; monthSpentCents: number; items: ReadonlyMap<string, { name: string; baseline: { preferred: number; backup?: number } }>; due: ReadonlyMap<string, { deadline: string }>; onItsWay: ReadonlySet<string>; inOpenCart: ReadonlySet<string> }`. `baseline` is `lastPaidCents ?? priceCents` for each product.
  - `type GateAnswer = { verdict: "refused"; remove: { itemId: string; reason: RemoveFirst }[] } | { verdict: "go" | "held"; holds: { reason: Approvable; itemId?: string; wasCents?: number; nowCents?: number }[] }`
  - `checkCart(cart: CartInput, ctx: GateContext): GateAnswer`
  - `cartFingerprint(cart: CartInput): string`: sha256 of the cart's canonical JSON, with items sorted by `itemId`.

- [ ] **Step 1: Write the failing tests** in `test/supplyGate.test.ts`:

```ts
describe("looksLikeCard / refuseCards", () => {
  it("catches a Luhn-valid 16-digit number with spaces or dashes", () => {
    expect(looksLikeCard("4242 4242 4242 4242")).toBe(true);
    expect(looksLikeCard("4242-4242-4242-4242")).toBe(true);
    expect(refuseCards({ items: [{ note: "card 4242424242424242" }] })).toBe(true);
  });
  it("lets order numbers and prices through", () => {
    expect(looksLikeCard("Order 112-7781234-5566778")).toBe(false); // not Luhn-valid as one run
    expect(looksLikeCard("4242 4242 4242 4241")).toBe(false);
    expect(refuseCards({ store: "Target", totalCents: 3911 })).toBe(false);
  });
});

const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  mode: "hands-off", priceJumpPct: 20, monthSpentCents: 0,
  items: new Map([["it_towels", { name: "Paper towels", baseline: { preferred: 2400, backup: 2100 } }], ["it_soap", { name: "Dish soap", baseline: { preferred: 429 } }]]),
  due: new Map([["it_towels", { deadline: "2026-11-08" }], ["it_soap", { deadline: "2026-11-08" }]]),
  onItsWay: new Set(), inOpenCart: new Set(), ...over,
});
const cart = (over: Partial<CartInput> = {}): CartInput => ({
  store: "Target", items: [{ itemId: "it_towels", product: "preferred", qty: 1, unitCents: 2400 }], shippingCents: 0, taxCents: 0, totalCents: 2400, deliveryBy: "2026-11-07", ...over,
});

describe("checkCart", () => {
  it("is go when nothing holds in hands-off mode", () => {
    expect(checkCart(cart(), ctx())).toEqual({ verdict: "go", holds: [] });
  });
  it("holds a price more than priceJumpPct above the baseline, and not at it", () => {
    expect(checkCart(cart({ items: [{ itemId: "it_towels", product: "preferred", qty: 1, unitCents: 2880 }], totalCents: 2880 }), ctx()).verdict).toBe("go"); // exactly +20%
    expect(checkCart(cart({ items: [{ itemId: "it_towels", product: "preferred", qty: 1, unitCents: 2881 }], totalCents: 2881 }), ctx()))
      .toEqual({ verdict: "held", holds: [{ reason: "price-jump", itemId: "it_towels", wasCents: 2400, nowCents: 2881 }] });
  });
  it("compares the backup against the backup's baseline", () => {
    expect(checkCart(cart({ items: [{ itemId: "it_towels", product: "backup", qty: 1, unitCents: 2600 }], totalCents: 2600 }), ctx()).verdict).toBe("held");
  });
  it("holds over the per-order cap, over the month cap, each alone, and neither when unset", () => {
    expect(checkCart(cart(), ctx({ perOrderCapCents: 2399 }))).toMatchObject({ verdict: "held", holds: [{ reason: "over-order-cap" }] });
    expect(checkCart(cart(), ctx({ perMonthCapCents: 30000, monthSpentCents: 27601 }))).toMatchObject({ verdict: "held", holds: [{ reason: "over-month-cap" }] });
    expect(checkCart(cart(), ctx({ perMonthCapCents: 30000, monthSpentCents: 27600 })).verdict).toBe("go");
  });
  it("holds a delivery after any item's deadline", () => {
    expect(checkCart(cart({ deliveryBy: "2026-11-09" }), ctx())).toMatchObject({ verdict: "held", holds: [{ reason: "misses-deadline" }] });
  });
  it("holds every cart in checkout mode", () => {
    expect(checkCart(cart(), ctx({ mode: "checkout" }))).toMatchObject({ verdict: "held", holds: [{ reason: "checkout-mode" }] });
  });
  it("refuses, with no token, items not due, on their way, in another open cart, or unknown", () => {
    const four = cart({ items: ["it_towels", "it_soap", "it_x", "it_y"].map((itemId) => ({ itemId, product: "preferred" as const, qty: 1, unitCents: 100 })) });
    const answer = checkCart(four, ctx({ due: new Map([["it_x", { deadline: "2026-11-08" }]]), onItsWay: new Set(["it_towels"]), inOpenCart: new Set(["it_soap"]) }));
    expect(answer).toEqual({ verdict: "refused", remove: [
      { itemId: "it_towels", reason: "on-its-way" }, { itemId: "it_soap", reason: "in-open-cart" },
      { itemId: "it_x", reason: "unknown-item" }, { itemId: "it_y", reason: "unknown-item" },
    ] });
  });
});

describe("cartFingerprint", () => {
  it("ignores item order and changes with any price, qty or total", () => {
    const a = cart({ items: [{ itemId: "it_soap", product: "preferred", qty: 1, unitCents: 429 }, { itemId: "it_towels", product: "preferred", qty: 1, unitCents: 2400 }] });
    const b = cart({ items: [...a.items].reverse() });
    expect(cartFingerprint(a)).toBe(cartFingerprint(b));
    expect(cartFingerprint(a)).not.toBe(cartFingerprint({ ...a, totalCents: a.totalCents + 1 }));
  });
});
```

`it_x` is due but not in `items`, so it's `unknown-item`. In this context `it_towels` and `it_soap` aren't due either, but `on-its-way` and `in-open-cart` are listed for them because each item gets only its first failing reason, checked in the order `unknown-item`, then `on-its-way`, then `in-open-cart`, then `not-due`.

- [ ] **Step 2: Run to verify it fails.** `npx vitest run test/supplyGate.test.ts`. Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `cards.ts` and `gate.ts`.** Remove-first reasons are checked first, in this order per item, each item reporting only its first: `unknown-item`, `on-its-way`, `in-open-cart`, `not-due`. Any of them makes the verdict `refused`, listing every such item in cart order. Otherwise approvable holds are collected in this order: each item's `price-jump` (`unitCents > baseline × (1 + pct/100)`, compared in integer cents), then `over-order-cap`, `over-month-cap` (`monthSpentCents + totalCents > cap`), `misses-deadline` (`deliveryBy` later than the earliest deadline among the cart's items), `checkout-mode`.

- [ ] **Step 4: Run to verify it passes.** `npx vitest run test/supplyGate.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/supply-core/cards.ts src/supply-core/gate.ts test/supplyGate.test.ts
git commit -m "Supply Core: refuse card details; decide go or hold on a cart"
```

---

### Task 3: `store.ts`, `setupAsk.ts`, and the desk's setup tools

**Files:**
- Create: `src/supply-core/store.ts`, `src/supply-core/setupAsk.ts`, `src/supply-core/desk.ts`
- Test: `test/supplyDesk.test.ts` (setup half)

**Interfaces:**
- Consumes: Task 1 (`Schedule`, `scheduleProblem`, `nextDates`), Task 2 (`refuseCards`, `Mode`). `writeJsonAtomic` from `src/storage/atomicWrite.ts`. `ConfirmationBook` from `src/operator/confirmations.ts` (10-minute codes, `issue` / `redeem`). `localDateOf`, `isValidTimeZone` from `src/core/timezone.ts`.
- Produces:
  - `store.ts`: the types `SupplyFile`, `SupplySettings`, `Item`, `Product`, `Order`, `Cart`, `LowReport`, exactly as in the spec's Part 2, plus `Item.savedAt`, `Item.skippedAt?`, `Item.blockedRuns?`, `Order.lateTold?`, `SupplyFile.offAt?`, and `Cart { token: string; fingerprint: string; cart: CartInput; status: "go" | "held" | "approved" | "recorded"; holds: string[]; expiresAt: string; source: Order["source"] }`.
    - `SUPPLY_FILE = "supply.json"`
    - `readSupply(root: string): SupplyFile` (an empty file when missing)
    - `writeSupply(root: string, file: SupplyFile): void`
    - `supplyAskOn(root: string): boolean`: `activatedAt` set and `offAt` unset.
    - `monthSpentCents(file: SupplyFile, timeZone: string, now: Date): number`
    - `onItsWay(file: SupplyFile, now: Date): Set<string>`: item ids on orders with status `placed` or `unconfirmed`, not delivered, `at` within 14 days.
  - `desk.ts`: `class SupplyDesk`, built by `supplyDeskFor(root: string, deps: SupplyDeps): SupplyDesk` and cached per root like `liveDeskFor`.
    - `interface SupplyDeps { now(): Date; standalone: boolean; cleaning?: { property(): { name: string; address: string; timeZone: string } | undefined; turnovers(): Promise<{ checkoutYmd: string }[]> } }`
    - Every method returns `Promise<SupplyReply>`, with `type SupplyReply = { text: string; structured?: Record<string, unknown>; isError: boolean }`. Calls run one at a time through a promise chain (`serial`).
    - Setup methods: `state()`, `saveSettings(input)`, `saveItem(input)`, `removeItem(input)`, `previewSchedule(input)`, `activate(input)`.
  - `setupAsk.ts`: `supplySetupAsk(file: SupplyFile, standalone: boolean): { step: string; tool: string; questions: AskQuestion[] } | undefined`, in the same `AskQuestion` shape as `src/cleaner-core/setupAsk.ts` (`field`, `ask`, `required`, `options?`, `default?`, `when?`, `how?`).

- [ ] **Step 1: Write the failing tests** in `test/supplyDesk.test.ts`. Use a temp folder per test, a fixed `now` of `2026-11-04T15:00:00Z`, and `America/New_York`.

```ts
describe("setup", () => {
  it("asks property, items, bookings source, mode, caps, check time, routine, review, in order, standalone", async () => { /* get each step from state().structured.ask.step after saving the previous */ });
  it("skips property for a cleaning tenant and reads Cleaner Core's", async () => { /* deps.cleaning.property returns the property; first step is "items" */ });
  it("asks the bookings source only when an item is by bookings and Cleaner Core is off", async () => {});
  it("asks 'Anything else to add?' until the host says that's all (saveItem { done: true })", async () => {});
  it("refuses a 31st item, an http link, a 161-character storeNote, qty 0, and price 0", async () => {});
  it("refuses any input holding a card number, and saves nothing", async () => {
    const reply = await desk.saveItem({ ...towels, storeNote: "use 4242 4242 4242 4242" });
    expect(reply.isError).toBe(true);
    expect(readSupply(root).items).toHaveLength(0);
  });
  it("previewSchedule returns the next 3 dates, or the refusal", async () => {});
  it("activate is refused without an item, a mode, and a check time", async () => {});
});

describe("changes after Activate", () => {
  it("save_supply_item, remove_supply_item, and settings take two calls; a changed input makes the code stale", async () => {
    const first = await desk.saveItem({ ...towels, qtyPerOrder: 3 });
    expect(first.structured).toMatchObject({ question: expect.any(String), confirmation: { code: expect.any(String) } });
    expect(readSupply(root).items[0].qtyPerOrder).toBe(2);
    const stale = await desk.saveItem({ ...towels, qtyPerOrder: 4, confirmation: (first.structured!.confirmation as { code: string }).code });
    expect(stale.isError).toBe(true);
  });
});

describe("monthSpentCents", () => {
  it("counts an order at 23:30 Oct 31 New York in October", () => {
    const file = { ...emptyFile(), orders: [order({ at: "2026-11-01T03:30:00.000Z", chargedCents: 4000 })] };
    expect(monthSpentCents(file, "America/New_York", new Date("2026-11-04T15:00:00Z"))).toBe(0);
    expect(monthSpentCents(file, "America/New_York", new Date("2026-10-31T20:00:00Z"))).toBe(4000);
  });
});
```

Fill in each placeholder body with one desk call and the asserts its name gives. `towels` is a valid item input: preferred `https://shop.example/towels`, store `Example Mart`, `priceCents: 2400`, `qtyPerOrder: 2`, schedule every 21 days.

- [ ] **Step 2: Run to verify it fails.** `npx vitest run test/supplyDesk.test.ts`. Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `store.ts`, `setupAsk.ts`, and the setup half of `desk.ts`.**
  - `state()` returns `{ ask }` while setup is open. After Activate it returns `{ summary: { items, mode, caps, month: { spentCents, capCents? }, held } }` and a one-line `line` (`Supplies: on, 8 items. November: $142 of $300.`, or `November: $142` with no cap). Task 6 reuses `line`.
  - Item ids are `it_` plus 8 random lowercase characters.
  - Before Activate, saves need no code. After Activate, `saveItem`, `removeItem`, and `saveSettings` use `ConfirmationBook`: action `supply-item`, `supply-remove`, or `supply-settings`; target the item id or `settings`; fingerprint the sha256 of the input's JSON without `confirmation`.
  - `saveItem({ done: true })` closes the items step. After that, `state()` moves on.
  - The settings input takes `property?`, `mode?`, `perOrderCapCents?: number | null`, `perMonthCapCents?: number | null`, `priceJumpPct?`, `bufferDays?`, `checkTime?`, and `routineCreated?: true`. `null` clears a cap. `routineCreated` closes the routine step.

- [ ] **Step 4: Run to verify it passes.** `npx vitest run test/supplyDesk.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/supply-core/store.ts src/supply-core/setupAsk.ts src/supply-core/desk.ts test/supplyDesk.test.ts
git commit -m "Supply Core: the record, setup steps, and setup tools"
```

---

### Task 4: The desk's ordering tools

**Files:**
- Modify: `src/supply-core/desk.ts`
- Test: `test/supplyOrdering.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3. `GoogleEventList` and `googleCalendarSource` from `src/cleaner-core/sources.ts`, for standalone checkouts passed to `checkSupplies`.
- Produces these `SupplyDesk` methods:
  - `checkSupplies(input: { googleEvents?: GoogleEventList })` → `{ due: DueItem[], unconfirmed: Order[], held: Cart[], late: Order[], monthSpentCents, perOrderCapCents?, perMonthCapCents? }`, where `DueItem = { itemId, name, why, deadline, qtyPerOrder, preferred, backup?, lastPaidCents? }`
  - `reportLow(input: { itemIds: string[]; source: "cleaner" | "host"; jobId?: string })`
  - `checkCart(input: CartInput & { source?: "schedule" | "cleaner" | "host" })` → `{ verdict, cartToken?, holds?, remove?, expiresInMinutes: 30, question? }`. `question` is the price-jump copy when that's the only hold.
  - `approveCart(input: { cartToken: string; confirmation?: string })`
  - `recordOrder(input: { cartToken?: string; orderId?: string; orderNumber?: string; chargedCents: number; expectedBy?: string; approvedBy?: "grok-card" })` → `{ orderId, line, chargedMore?: true }`
  - `recordProblem(input: { reason: "store-blocked" | "listing-changed" | "out-of-stock" | "misses-deadline" | "not-placed"; itemIds?: string[]; orderId?: string })` → `{ suggestOtherStore?: true }`
  - `skipItem(input: { itemId: string })`
  - `markDelivered(input: { orderId: string })`

- [ ] **Step 1: Write the failing tests** in `test/supplyOrdering.test.ts`. Use an activated desk with `towels` and `soap`, and move `now` with a mutable clock.

```ts
it("check_supplies lists due items with deadlines and leaves out items on their way", async () => {});
it("a go cart records once; record_order without a token or with a stale one is refused", async () => {});
it("record_order updates lastOrderedAt and lastPaidCents, clears low reports, and returns the order line", async () => {
  expect(reply.structured!.line).toBe("Ordered from Example Mart: Paper towels ×2. $48.00, arriving Thursday.");
});
it("a held cart needs approve_cart's code; the landlord's yes lets record_order through with approvedBy landlord", async () => {});
it("approve_cart after 30 minutes refuses with 'That cart expired. Check it again.' and record_order refuses", async () => {});
it("a second check_cart with the same item while the first is open refuses with in-open-cart", async () => {});
it("a go cart with no record_order after 30 minutes becomes an unconfirmed order; its items stay on their way", async () => {});
it("record_order with an unconfirmed orderId places it; record_problem not-placed frees its items", async () => {});
it("chargedCents above the checked total is recorded with chargedMore, and counts toward the month cap", async () => {});
it("store-blocked twice in a row for an item returns suggestOtherStore; a placed order resets the count", async () => {});
it("skip_item clears a due item until its next occurrence", async () => {});
it("mark_delivered frees the item before 14 days; without it the item frees after 14 days", async () => {});
it("late lists a past-deadline undelivered order once", async () => {});
it("report_low takes known item ids only and refuses free text", async () => {
  expect((await desk.reportLow({ itemIds: ["paper towels"], source: "cleaner" })).isError).toBe(true);
});
it("approved-by grok-card is recorded when Grok's own card was paid on a go cart", async () => {});
it("every ordering tool refuses card-like input", async () => {});
```

Fill in each placeholder body with the calls and asserts its name gives.

- [ ] **Step 2: Run to verify it fails.** `npx vitest run test/supplyOrdering.test.ts`. Expected: FAIL, methods missing.

- [ ] **Step 3: Implement the ordering methods in `desk.ts`.**
  - Every call starts with a sweep. A `go` or `approved` cart past `expiresAt` with no record becomes an `Order` with status `unconfirmed`. A `held` cart past `expiresAt` is dropped.
  - The next cleaning, for `deadlineFor`, is the first `deps.cleaning.turnovers()` checkout on or after today. `checkTime` is `HH:MM` 24-hour, default `10:00`.
  - `checkCart` builds the `GateContext` from the file:
    - `due` comes from `dueOn` for every item.
    - `inOpenCart` holds item ids in unexpired carts with status `go`, `held`, or `approved`.
    - `onItsWay` comes from `onItsWay()`.
  - On `go` or `held`, it saves a `Cart` with a token of `cart_` plus 10 random characters.
  - `approveCart` without a code issues a `ConfirmationBook` code with action `supply-cart`, target the token, and fingerprint the cart's fingerprint. The question names the store, items, total, and every hold. Redeeming the code sets the status to `approved` and resets `expiresAt` to now plus 30 minutes.
  - `recordOrder` accepts a cart with status `go` (`approvedBy: "rules"`, or `grok-card` when passed) or `approved` (`approvedBy: "landlord"`). With `orderId`, it accepts an `unconfirmed` order. Anything else refuses with `No go answer or landlord approval for that order. Check the cart again.`
  - The order line's weekday comes from `expectedBy` in the property's time zone. With no `expectedBy`, the line ends at the total.

- [ ] **Step 4: Run to verify it passes.** `npx vitest run test/supplyOrdering.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/supply-core/desk.ts test/supplyOrdering.test.ts
git commit -m "Supply Core: what's due, the go/hold check, approvals, and the order log"
```

---

### Task 5: Standalone bookings source

**Files:**
- Modify: `src/supply-core/desk.ts`; `src/cleaner-core/hosted/router.ts` (the `/t/<id>/` upload route)
- Test: `test/supplyOrdering.test.ts` (bookings block)

**Interfaces:**
- Consumes: Cleaner Core's calendar-link upload pattern: `LiveDesk.uploadCalendarLink` (`src/cleaner-core/liveDesk.ts:1185`), `calendarUploadCode` and `handleCleanerCalendarUpload` (`src/cleaner-core/http.ts`), `interpretFeed(ical: string): FeedRead` (`src/cleaner-core/calendar.ts`), and the calendar fetch Cleaner Core uses (`setCleanerCalendarFetch` in tests).
- Produces:
  - `SupplyDesk.saveSources(input: { uploadLink?: { name: string }; google?: boolean; done?: true })` → `{ uploadUrl?, expiresInMinutes? }`
  - `SupplyDesk.uploadCalendarLink(code: string, body: Record<string, unknown>)` with the same return shape as Cleaner Core's
  - the route `POST /t/<tenant>/supply/calendar/<code>`
  - stored `sources: { name: string; kind: "ical" | "google-calendar"; url?: string }[]` in `supply.json`. `url` is never returned by any tool and is redacted from logs with `redactCalendarUrl`.

- [ ] **Step 1: Write the failing tests.** These cover:
  - an upload link that saves one calendar
  - a second link adds to the first
  - checkouts from a fetched feed (use `src/cleaner-core/fixtures/guesty-lite-scratch.ics`) drive a `bookings` item due
  - `googleEvents` passed to `checkSupplies` drive it too
  - no tool reply contains the calendar URL
  - a failed fetch leaves the item not due, with `sourcesFailed: true`

  A cleaning tenant takes checkouts from `deps.cleaning.turnovers()` and never calls the fetch.
- [ ] **Step 2: Run to verify it fails.** `npx vitest run test/supplyOrdering.test.ts -t bookings`. Expected: FAIL.
- [ ] **Step 3: Implement** by reusing Cleaner Core's upload-code issue and expiry and its fetch limits (`src/cleaner-core/fetchLimits.ts`), not by copying them.
- [ ] **Step 4: Run to verify it passes.** Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add src/supply-core/desk.ts src/cleaner-core/hosted/router.ts test/supplyOrdering.test.ts
git commit -m "Supply Core: booking calendars for standalone by-bookings items"
```

---

### Task 6: Tools on the shared service

**Files:**
- Create: `src/supply-core/tools.ts`
- Modify:
  - `src/cleaner-core/hosted/registry.ts`: `TenantService` gains `"supplies"`; `Tenant.supplies?: boolean`; `setSupplies(id, on)`
  - `src/hosted/serviceChoice.ts`: the third choice; `serviceChoices(opts)`; `serviceQuestion(choices)`
  - `src/hosted/serviceTools.ts`: the `Service` enum, `BY_STATE.supplies`, `turn_on_supplies` / `turn_off_supplies` on cleaning, `get_state` / `choose_service` copy from `serviceChoices`
  - `src/hosted/service.ts`: switching to and from `supplies`; stand-down clears carts
  - `src/hosted/frontMcp.ts`: the `supplies` state answered in-process; the cleaning add-on's tools appended and dispatched; Cleaner Core's `get_state` gains `supplies: <line>`
  - `src/mcp/oauth/pages.ts`: the Allow page lists `serviceChoices(...)`
  - `src/cleaner-core/liveDesk.ts`: `turnoverDates(): Promise<{ checkoutYmd: string }[]>`, `propertyForSupplies()`, `refreshSupplyAsk(): void` (sets `stale = true`)
- Test: `test/supplyHosted.test.ts`; update `test/sharedServiceConsent.test.ts` and `test/serviceSwitching.test.ts` only where the third choice changes copy

**Interfaces:**
- Consumes: Tasks 3–5 (`supplyDeskFor`, every desk method), `multiTenantApp` from `test/multiTenantHarness.ts`.
- Produces:
  - `SUPPLY_TOOLS: { name, title, description, input: z.ZodObject }[]`, with every input `.strict()`. Names: `get_supply_state`, `save_supply_settings`, `save_supply_item`, `remove_supply_item`, `preview_schedule`, `save_supply_sources`, `activate_supplies`, `check_supplies`, `report_low`, `check_cart`, `approve_cart`, `record_order`, `record_problem`, `skip_item`, `mark_delivered`.
  - `SUPPLY_TOOL_NAMES: ReadonlySet<string>`
  - `handleSupplyTool(desk: SupplyDesk, name: string, args: unknown): Promise<SupplyReply | undefined>`: `refuseCards` first, then the zod parse, then the desk method.
  - `supplyCoreOn(env: NodeJS.ProcessEnv): boolean` (`SUPPLY_CORE === "1"`)
  - `serviceChoices(opts: { touring: boolean; supplies: boolean })`: cleaning is always included, in the order touring, cleaning, supplies
  - `serviceQuestion(choices)`: `Which do you want to set up: Tour Core or Cleaner Core?` for two choices; `Which do you want to set up: Tour Core, Cleaner Core, or Supply Core?` for three; `Which do you want to set up: Cleaner Core or Supply Core?` when touring is off

  A standalone tenant's `get_state` is `get_supply_state` under that name. Its initialize instructions tell Grok to follow `get_state` and that Supply Core never texts.

- [ ] **Step 1: Write the failing tests** in `test/supplyHosted.test.ts`, using `multiTenantApp` and 555 numbers:

```ts
it("offers Supply Core as a choice only with SUPPLY_CORE=1, on the Allow page and in get_state", SLOW, async () => {});
it("a supplies tenant lists Supply Core's tools, switch_service and stand_down_service, and no Cleaner Core tool", SLOW, async () => {});
it("a supplies tenant's get_state is Supply Core's setup", SLOW, async () => {});
it("a cleaning tenant on Grok sees turn_on_supplies; after it, Supply Core's tools join the list; Claude never sees them", SLOW, async () => {});
it("turn_off_supplies takes two calls and clears open carts; the tools leave the list", SLOW, async () => {});
it("Cleaner Core's get_state carries the supplies line once supplies are on", SLOW, async () => {});
it("switching cleaning ↔ supplies works with nothing live; a held cart is cleared on stand-down", SLOW, async () => {});
it("two tenants never see each other's items, orders, or spending", SLOW, async () => {});
it("a text to a supplies tenant's number gets no reply", SLOW, async () => {});
it("a tool call with a card-like argument is refused before the desk", SLOW, async () => {});
```

Fill in each placeholder body with the calls and asserts its name gives.

- [ ] **Step 2: Run to verify it fails.** `npx vitest run test/supplyHosted.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In `frontMcp.ts`, handle `state === "supplies"` the way the `unset` branch is handled. Answer `initialize`, `ping`, `tools/list` (`SUPPLY_TOOLS` plus `listedFrontTools("supplies")`) and `tools/call` (`handleFrontTool`, then `handleSupplyTool`) in-process, never through `cleaningPass`.
  - For `cleaning` with `tenant.supplies` and a Grok caller:
    - `tools/list` appends `SUPPLY_TOOLS`, without `save_supply_sources`.
    - `tools/call` tries `handleSupplyTool` before forwarding.
    - `get_state` is post-processed like `withNotices` to add `supplies: line`.
  - `SupplyDeps.cleaning` reads `liveDeskFor(ctx.root, ctx.env, h.now)`.
  - `activate_supplies` and `turn_off_supplies` on a cleaning tenant call `refreshSupplyAsk()`.
  - The supplies tenant's Twilio route returns an empty TwiML reply and keeps nothing.
  - Keep `refusedHere` correct: a supply tool called on a tenant without supplies gets `wrongServiceLine`-style refusal text, `Supply Core isn't on for this property.`
- [ ] **Step 4: Run.** First `npx vitest run test/supplyHosted.test.ts test/sharedServiceConsent.test.ts test/serviceSwitching.test.ts test/sharedServiceRouting.test.ts test/sharedServiceTenants.test.ts test/cleanerHostedRouter.test.ts`, then `npm run typecheck`. Expected: PASS. Existing tests change only where the copy now comes from `serviceQuestion`, and with `SUPPLY_CORE` unset that copy is byte-identical.
- [ ] **Step 5: Commit.**

```bash
git add src/supply-core/tools.ts src/cleaner-core/hosted/registry.ts src/hosted src/mcp/oauth/pages.ts src/cleaner-core/liveDesk.ts test/supplyHosted.test.ts test/sharedService*.test.ts test/serviceSwitching.test.ts
git commit -m "Supply Core on the shared service: the supplies choice and the cleaning add-on"
```

---

### Task 7: Cleaner Core asks the cleaner after DONE

**Files:**
- Modify:
  - `src/cleaner-core/core.ts`: option `supplyAsk?: boolean`; `Job.supplyAskedAt?`, `Job.supplyReport?: { text?: string; none?: true; at: string }`; `MessageHandled` gains `"supply-report"`; the combined done text in `markDone`; the answer branch in `receiveClaimed`
  - `src/cleaner-core/cleanerTexts.ts`: `SUPPLY_DONE_ASK`, `SUPPLY_NOTED`
  - `src/cleaner-core/liveDesk.ts`: `preferenceOptions()` adds `supplyAsk: true` when `supplyAskOn(this.root)`; the kept message carries `handled: "supply-report"` and the job id
  - `docs/cleaner-core-safety-gates.md`: the new gate
- Test: `test/cleanerSupplyAsk.test.ts`

**Interfaces:**
- Consumes: `supplyAskOn` (Task 3), `refreshSupplyAsk` (Task 6).
- Produces:
  - `SUPPLY_DONE_ASK = "Thanks, cleaning marked done. Anything running low? Reply with what's low, or NONE."`
  - `SUPPLY_NOTED = "Thanks, noted."`
  - the `check_now` message label `supply-report`, with `jobId`

- [ ] **Step 1: Write the failing tests** in `test/cleanerSupplyAsk.test.ts`. Reuse the `cleaning()` helper shape from `test/cleanerChecklistYes.test.ts`, with `supplyAsk: true`.

```ts
it("DONE sends one combined text and marks the job done", async () => { expect(texts(box)).toContain(SUPPLY_DONE_ASK); expect(texts(box)).not.toContain("Thanks, cleaning marked done."); });
it("after the checklist YES, the same combined text", async () => {});
it("the next cleaner text is the answer: saved redacted, labelled supply-report, replied Thanks, noted.", async () => {});
it("NONE, NO, and 'nothing' save none with the same reply", async () => {});
it("a YES is not the answer; the question keeps waiting", async () => {});
it("STOP, HELP, an injury report, and a code-like text still win", async () => {});
it("after 12 hours the question is closed and a text is a normal message", async () => {});
it("in a group, only the cleaner's reply counts", async () => {});
it("a replayed answer and a restart send one Thanks, noted.", async () => {});
it("supplyAsk off keeps today's done text exactly", async () => {});
it("an answer with the door code or a 4-digit run is redacted in the job and the message", async () => {});
it("LiveDesk turns supplyAsk on when supply.json is activated, and refreshSupplyAsk picks it up mid-cleaning", async () => {});
```

Fill in each placeholder body with the calls and asserts its name gives.

- [ ] **Step 2: Run to verify it fails.** `npx vitest run test/cleanerSupplyAsk.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `markDone` uses `SUPPLY_DONE_ASK` as the body when `this.options.supplyAsk`, with the same delivery id `done:{id}`, and sets `job.supplyAskedAt` once it's acknowledged.
  - In `receiveClaimed`, after the `retry` line and before the checklist line, take the answer when all of these hold:
    - the text is from the cleaner's phone, with consent `in`
    - the latest done job has `supplyAskedAt` within 12 hours and no `supplyReport`
    - the text is not a keyword, YES, DONE, or an injury report, and `looksLikeCode` is false

    Then save `supplyReport` (`noteText` redaction), reply `SUPPLY_NOTED` with delivery id `supply-noted:{id}`, push the inbound id, and return label `supply-report`. NONE, NO, and "nothing" (after `normalize`) save `{ none: true }`.
  - Add the gate to `docs/cleaner-core-safety-gates.md`, in its existing format, with this test file as its proof.
- [ ] **Step 4: Run.** First `npx vitest run test/cleanerSupplyAsk.test.ts test/cleanerChecklistYes.test.ts test/cleanerDone.test.ts test/cleanerCoreGroup.test.ts`, then `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add src/cleaner-core/core.ts src/cleaner-core/cleanerTexts.ts src/cleaner-core/liveDesk.ts docs/cleaner-core-safety-gates.md test/cleanerSupplyAsk.test.ts
git commit -m "Cleaner Core: ask the cleaner what's running low after DONE when Supply Core is on"
```

---

### Task 8: Grok's side: bootstrap, template, routines, and the Supply Core gates

**Files:**
- Create:
  - `SUPPLY_CORE_BOOTSTRAP.md`
  - `supply-template/template.json`, `supply-template/bot-profile.md`, `supply-template/SETUP_PROMPT.md`, `supply-template/README.md`
  - `supply-template/routines/supply-core-check.md`
  - `docs/supply-core-safety-gates.md`
- Modify:
  - `CLEANER_CORE_BOOTSTRAP.md`: one Supply Core paragraph under "Every booking"
  - `cleaner-template/routines/cleaner-core-check.md` and `cleaner-core-alerts.md`: the `supply-report` → `report_low` step, then the Supply Core Check steps when supplies are on
  - `cleaner-template/template.json`: add the supply tools to both routines' `allowedTools`
  - `src/cleaner-core/assistant.ts`: Grok's pinned check text gains the `supply-report` line
- Test: `test/supplyTemplate.test.ts`; update `test/cleanerTemplate.test.ts`

**Interfaces:**
- Consumes: the tool names from Task 6 and the copy in Global Constraints.
- Produces: the files above. `template.json` follows `cleaner-template/template.json`'s shape, with `hostedSupplyCoreUrl` set to the same service URL. Its routine is `Supply Core Check`: scheduled daily at `checkTime`, `allowedTools` = `get_supply_state`, `check_supplies`, `check_cart`, `approve_cart`, `record_order`, `record_problem`, `mark_delivered`.

- [ ] **Step 1: Write the failing tests** in `test/supplyTemplate.test.ts`:
  - `template.json` parses, names every routine doc that exists, and lists only real Supply Core tool names in `allowedTools`.
  - `neverIncluded` names card details, Vault contents, calendar links, and order numbers.
  - The bootstrap and the routine doc contain each of these exact sentences:
    - `Call check_cart before Place Order, every time.`
    - `Place an order only on go, or after the landlord's yes and approve_cart's code.`
    - `A routine run never calls approve_cart with a code.`
    - `Never type, paste, or pass a card number, expiry, or security code to Supply Core.`
    - `Until the hands-off probe passes, prepare the order with Buy now and ask the landlord to tap Pay.`
  - The routine doc contains the fallback, unconfirmed, and late steps.
  - The cleaner routines name `report_low` and `supply-report`.

  Update `test/cleanerTemplate.test.ts` for the changed routine docs and `allowedTools`.
- [ ] **Step 2: Run to verify it fails.** `npx vitest run test/supplyTemplate.test.ts test/cleanerTemplate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write the files.**
  - The bootstrap follows `CLEANER_CORE_BOOTSTRAP.md`'s sections (Connect, Setup order, Every run, Rules) and the spec's Parts 2–3.
  - `docs/supply-core-safety-gates.md` lists the spec's seven gates, in the Cleaner Core gates doc's format. Each gate names the test that proves it: Task 2 and 4 for 1–3, Task 4 for 4, Task 7 for 5, Tasks 2–7 for 6, and Task 6 for 7.
  - The hands-off probe result line in the bootstrap reads `Hands-off probe: not run yet.`
- [ ] **Step 4: Run.** First `npx vitest run test/supplyTemplate.test.ts test/cleanerTemplate.test.ts test/cleanerClaude.test.ts test/cleanerChatGpt.test.ts test/cleanerMuse.test.ts`, then `node scripts/scan-cleaner-secrets.mjs --tracked`. Expected: PASS. The Claude, ChatGPT, and Muse texts are unchanged.
- [ ] **Step 5: Commit.**

```bash
git add SUPPLY_CORE_BOOTSTRAP.md supply-template docs/supply-core-safety-gates.md CLEANER_CORE_BOOTSTRAP.md cleaner-template src/cleaner-core/assistant.ts test/supplyTemplate.test.ts test/cleanerTemplate.test.ts
git commit -m "Supply Core: Grok bootstrap, template, routines, and safety gates"
```

---

### Task 9: Verify end to end, then the probe handoff

**Files:**
- Modify: `.cursor/skills/verify-cleanercore/SKILL.md` and its `scripts/`; add a supplies drive under its Feature map
- Create: `.cursor/skills/verify-cleanercore/features/supplies.md`

**Interfaces:**
- Consumes: everything above, plus the skill's existing Scratch launch and helpers.

- [ ] **Step 1: Add the supplies drive.**
  1. Scratch tenant with supplies on.
  2. Activate one item.
  3. A cleaning reaches DONE, and the combined text shows in `read_outbox`.
  4. The cleaner's reply `out of paper towels` arrives with `send_test_text` from the 555 cleaner.
  5. `check_now` shows `supply-report`.
  6. `report_low`, then `check_supplies` lists the item as due.
  7. `check_cart` returns go.
  8. `record_order` with order number `SCRATCH-0001`.

  Save the evidence as the skill already does. It sends nothing to a real phone.
- [ ] **Step 2: Run the drive.** Follow the skill's Launch and Drive sections. Expected: every step's evidence saved, and no outbox item addressed to a non-555 number.
- [ ] **Step 3: Run the full gate.** `scripts/ci-check.sh`. Expected: `typecheck ok`, `build ok`, `test-default ok`, `secret-scan ok`, `tracked-scan ok`.
- [ ] **Step 4: Commit.**

```bash
git add .cursor/skills/verify-cleanercore
git commit -m "verify-cleanercore: the Supply Core drive"
```

- [ ] **Step 5: Hand the probe to Saad.** This spends real money, so it isn't run by an agent. Post the spec's Part 6 probe steps to Saad and stop. When Saad reports the result, replace `Hands-off probe: not run yet.` in `SUPPLY_CORE_BOOTSTRAP.md` with the result. If it passed, also replace the fallback sentence with `Check out with the saved Vault card on go.` Update the matching assertion in `test/supplyTemplate.test.ts` and commit.
