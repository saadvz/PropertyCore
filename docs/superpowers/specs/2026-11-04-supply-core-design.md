# Supply Core: keeping a rental stocked

> Superseded in part by `docs/superpowers/specs/2026-11-07-property-hub-details-calendars-design.md` (#165): the property and booking calendars now live in the property hub, shared with Cleaner Core, with one upload flow. Supply Core counts checkouts from the shared calendars whether Cleaner Core is on or off.

Date: 2026-11-04. Approved in conversation with Saad, section by section. Status: written spec for Saad's review.

## Goal

The landlord's Grok Bot keeps a rental property stocked with the supplies it always needs, without the landlord doing anything day to day. The landlord picks each product once. After that, Supply Core says what's due, Grok shops and checks out with Grok Bot's own shopping tools, and Supply Core keeps the record and the spending rules.

Supply Core works on its own, as a standing delivery service, or with Cleaner Core, where the cleaner's report of what's running low turns into an order.

Supply Core never sees a card number and never buys anything itself. Grok buys, through the landlord's own Grok Vault.

## What Grok Bot's shopping can do (checked 2026-11-04)

Grok Bot's shopping release (0.75.2 on Oct 22 through 0.78.1 on Oct 27, plus the Nov 2 roundup) sets the limits for this design. The official changelog page (`x.ai/changelog/bot`) returned 403 to our fetch, so this comes from the docs and mirrors listed at the end.

- Product results show as cards with photos, price, rating, and store. **Buy now starts an order you approve.** 0.77.0: "You still approve every purchase." The Order Concierge and Deal Watcher templates never buy without approval.
- **A card saved in Vault fills at a store's checkout without a fresh prompt for each use.** The docs: to approve every payment, don't save the card. Whether a scheduled routine can finish a checkout on its own is not documented. This design treats it as unproven until the real-Grok probe below passes.
- Payment routes: Shop Pay through a store's checkout where accepted, a one-time Shop card elsewhere, Link one-time cards (US and Canada, approved each time, about 10 minutes to approve), X Money. Approval cards stay open 30 minutes.
- Vault contacts fill shipping addresses. After a purchase, Grok tracks the order in chat.
- Stores can block automated browsing, require sign-in, or ask for human verification. Reports say Amazon blocks Grok Bot.
- There is no built-in recurring order. Supply Core supplies the schedule.

## What the landlord said

- Setup builds the list one item at a time. For each item Grok shows several product options; the landlord picks a preferred one and, if they want, a backup.
- For each item Grok suggests the best store for when it's needed. A store the landlord prefers wins, and Grok states its caveats.
- Two modes: **hands-off**, and **stop at checkout**, where Grok waits for the landlord's yes before placing the order.
- **Hands-off means hands-off wherever Grok allows it** (choice A). Grok checks out with a card saved in Vault. Where a store or payment route needs Grok's own approval card, or the probe hasn't passed, it falls back to one tap on Pay.
- Each item has one schedule: **every** (every 3 weeks, the 1st of the month), **by bookings** (once every 4 stays), or **other** (a custom schedule the landlord describes, which Grok turns into a rule and reads back). A "we're low" from the landlord, or from the cleaner when Cleaner Core is on, always orders on top of the schedule.
- **A cleaner's report orders in the landlord's mode** (choice A). Items on the list are ordered hands-off or held at checkout, as set. Anything not on the list goes to the landlord as a question first.
- **Cleaner Core asks the cleaner once, after DONE** (choice A): `Anything running low?`. A supply mention earlier in the cleaning is still told to the landlord, as today, but doesn't order.
- **Orders ship to the property** (choice A). With Cleaner Core the deadline is the next cleaning. Standalone, it's the item's scheduled date plus a buffer the landlord picks. If no store can make the deadline, Grok tells the landlord instead of ordering late.
- **Caps are optional.** Setup asks whether the landlord wants a cap per order, a cap per month, both, or neither. Monthly spending is always tracked.
- **A price jump is always told to the landlord, and holds that item** (choice A): buy anyway, switch to the backup, or skip. The rest of the order goes through.
- **Approach 1**: a module on the hosted service keeps the records and decides go or hold; Grok does all shopping and checkout.

## Not in this version

Supply Core with Tour Core; Claude, ChatGPT, and Muse (Supply Core's tools are listed only on Grok connections); more than one property per tenant; outside the US; returns and refunds (Grok's Order Concierge can help, but Supply Core records nothing about them); stock counts or inventory; texting the cleaner about deliveries; Supply Core buying through any store API.

## Rules that stay

- `docs/cleaner-core-safety-gates.md` stays green. One gate is added for the DONE supplies question (Part 5).
- No live text to a real person without Saad's okay. Tests and Scratch runs use only 555 numbers and made-up door codes.
- Secrets stay out of code, logs, prompts, chat, and tool arguments. Card details never reach Supply Core at all.
- Existing cleaning and touring tenants behave exactly as today until a cleaning tenant turns Supply Core on.
- Neither Cleaner Core nor Supply Core ever moves money. Grok buys with the landlord's own Vault.

## 1. Architecture

**Code.** A new module, `src/supply-core/`, kept apart from Cleaner Core's large files:

| File | Job |
| --- | --- |
| `store.ts` | Reads and writes `supply.json`: settings, items, orders, carts. |
| `schedule.ts` | Pure functions. What's due today, each item's deadline, the next dates of a schedule, RRULE checks. |
| `gate.ts` | Pure functions. A cart's go or hold, per item and for the cart, and the token bound to it. |
| `setupAsk.ts` | The `ask` steps, in Cleaner Core's `get_state` → `ask` shape (`src/cleaner-core/setupAsk.ts`). |
| `tools.ts` | The MCP tools (Part 4). |
| `cards.ts` | Refuses card-like input (Part 5, gate 1). |

**Record.** One `supply.json` per tenant, in the tenant's folder on the same persistent disk as `cleaner-live.json`.

**How a host gets it.**

- **Standalone.** `supplies` becomes a third `TenantService` beside `cleaning` and `touring` in `src/cleaner-core/hosted/registry.ts`, and a third choice in `src/hosted/serviceChoice.ts`: `Supply Core: supplies reordered for a property`. It is offered only while `SUPPLY_CORE=1`, the way touring waits on `TOUR_CORE_TENANTS=1`. A supplies tenant is created on `/admin` with a number like any tenant, and Supply Core never texts from it; texts to that number get no reply. `switch_service` and `stand_down_service` work as for the other two; an order on its way is not "live" for switching, but a held cart is cleared when the service stands down.
- **With Cleaner Core.** A cleaning tenant turns Supply Core on as an add-on with `turn_on_supplies`. The tenant's `service` stays `cleaning`, so the one-active-service rule is unchanged. The registry entry gains `supplies: boolean`. With it on, `src/hosted/frontMcp.ts` adds Supply Core's tools to the cleaning tool list and sends `notifications/tools/list_changed`.

**Who does what.**

- **Supply Core** keeps the list, schedules, settings, price history, the order log, and monthly spending. It says what's due and whether a cart is go or hold.
- **Grok** asks the setup questions, shows product cards, compares stores, shops, checks out with Vault, follows tracking, and reports every order back.
- **Cleaner Core** asks the cleaner `Anything running low?` after DONE when supplies are on, and returns the answer.

**Templates and routines.**

- `supply-template/`: `template.json`, `bot-profile.md`, `SETUP_PROMPT.md`, `README.md`, and `routines/supply-core-check.md`.
- `SUPPLY_CORE_BOOTSTRAP.md` at the repository root, the entry point like `CLEANER_CORE_BOOTSTRAP.md`.
- **Supply Core Check**, a scheduled Grok routine, daily at a time the landlord picks (default 10:00 in the property's time zone, so an approval card isn't waiting overnight). Allowed tools: `get_supply_state`, `check_supplies`, `check_cart`, `approve_cart` (first call only, never with a code), `record_order`, `record_problem`, `mark_delivered`.
- A cleaning tenant with supplies on gets **no second bot**. The Cleaner Core Check and Alerts routines gain one step: after `check_now`, pass any `supplyReport` to `report_low`, then run the Supply Core Check steps. The landlord still creates the daily Supply Core Check routine, so scheduled items are ordered on days with no cleaning.

## 2. The record and setup

### `supply.json`

```
settings: {
  mode: "hands-off" | "checkout",
  perOrderCapCents?: number,      // optional, $1 to $5,000
  perMonthCapCents?: number,      // optional, $1 to $20,000
  priceJumpPct: number,           // default 20, 5 to 100
  bufferDays: number,             // standalone only, default 3, 0 to 14
  checkTime: "HH:MM",             // the routine's time, default 10:00
  property?: { name, address, timeZone },   // standalone; a cleaning tenant reads Cleaner Core's
  activatedAt?: string,
}
items: Item[]                     // up to 30
orders: Order[]
carts: Cart[]                     // open go/hold answers, 30 minutes each
lowReports: { itemId, source: "cleaner" | "host", at, jobId? }[]
```

**Item.**

```
{ id, name, qtyPerOrder,                       // 1 to 50
  preferred: Product, backup?: Product,
  storeNote: string,                           // one line, under 160 characters: why this store, and any caveat
  schedule: Schedule,
  lastOrderedAt?: string }

Product: { title, store, url, packSize, priceCents, pickedAt, lastPaidCents? }

Schedule:
  | { kind: "every", days: number }                 // 1 to 365
  | { kind: "every", monthlyOn: number }            // day of month 1 to 28
  | { kind: "bookings", stays: number }             // 1 to 50
  | { kind: "custom", rrule: string, said: string } // RRULE subset; `said` is the landlord's own words
```

`url` must be https. `store` is the store's own name, as Grok's product card shows it. `custom` accepts the RRULE parts `FREQ` (DAILY, WEEKLY, MONTHLY, YEARLY), `INTERVAL`, `BYDAY`, `BYMONTHDAY`, `BYMONTH`, `BYSETPOS`, `COUNT`, `UNTIL`. A rule that never fires again, or fires more than once a day, is refused.

**Order.**

```
{ id, at, store, items: { itemId, product: "preferred" | "backup", qty, unitCents }[],
  totalCents, chargedCents, orderNumber?, expectedBy?, deliveredAt?,
  source: "schedule" | "cleaner" | "host",
  approvedBy: "rules" | "landlord" | "grok-card",
  status: "placed" | "unconfirmed" | "delivered" }
```

**On its way.** An item on an order that isn't delivered is not due again until `deliveredAt` is set or 14 days pass after `at`.

**Monthly spending.** The sum of `chargedCents` for orders placed in each calendar month, in the property's time zone. Held carts don't count.

### When an item is due, and its deadline

- `every` with `days`: due when `lastOrderedAt + days` is today or earlier. An item never ordered is due on Activate.
- `every` with `monthlyOn`: due on that day of each month, or the first run after it.
- `bookings`: due when the count of checkouts since `lastOrderedAt` (or since Activate) reaches `stays`. Checkouts come from Cleaner Core's turnovers, or standalone from the saved bookings source.
- `custom`: due on each date the rule gives, or the first run after it.
- A low report: due now.

**Deadline.** With Cleaner Core: the day before the next cleaning. If the next cleaning is today or tomorrow, the deadline is that cleaning day and Grok picks the fastest delivery. Standalone: the due date plus `bufferDays`.

### Setup

The same `get_state` → `ask` pattern as Cleaner Core, one question per message, choice cards where there are options. A standalone tenant's `get_state` is Supply Core's. A cleaning tenant uses `get_supply_state`, and Cleaner Core's `get_state` gains one line (`Supplies: on, 8 items. November: $142 of $300.`, `Supplies: setup not finished.`, or nothing when off).

1. **Property**, standalone only: business name, address, time zone (`save_supply_settings`).
2. **Items**, one at a time (`save_supply_item`):
   1. The landlord names an item.
   2. Grok searches and shows 3 to 4 product cards.
   3. The landlord picks a preferred product, then optionally a backup.
   4. How many per order.
   5. Which store. With a preference, Grok uses it and states its caveats in `storeNote`. Without one, Grok suggests one with the reason (price per unit, delivery time against the deadline, membership or minimum order, whether Grok can check out there).
   6. The schedule, as a choice card: **Every…**, **By bookings**, **Other**. For Other, Grok writes the RRULE, calls `preview_schedule`, and reads the next 3 dates back before saving.

   Then "Anything else to add?" until the landlord says that's all.
3. **Bookings source**, only when an item is `bookings` and Cleaner Core is off. `save_supply_sources` reuses Cleaner Core's calendar-link upload and Google Calendar handling (`src/cleaner-core/sources.ts`, `calendar.ts`).
4. **Mode**: hands-off or stop at checkout.
5. **Caps**: "Want a spending cap?" Per order, per month, both, or no cap. Then the amounts.
6. **Check time**: when the daily routine runs (default 10:00).
7. **Routine**: Grok creates Supply Core Check.
8. **Review and Activate**: Grok summarizes the list, mode, caps, and schedule in its own words. On the landlord's Activate, `activate_supplies`.

**After Activate**, every change (add, change, or remove an item; mode; caps; check time) uses the two-call approval that `send_message` uses: the first call saves nothing and returns the question and a code bound to that exact change; the second call, with the code, saves after the landlord's yes.

## 2a. Setup order, revised after the first dev test (2026-11-04)

Saad's first run on dev changed the setup order. This section overrides the setup list in Part 2.

1. **Property:** the delivery address first. Grok works out the time zone from it and asks only when it's ambiguous. The name is optional and defaults to the street address.
2. **The whole list at once** (`save_supply_list`): "What do you want restocked regularly? List everything, up to 30 items." Saved as a draft of names.
3. **Where to buy** (`save_supply_stores`), before any product search, with the whole list in hand. Only delivery that works at an empty rental: shipped to the door from the store's own site (`shipping`), or a same-day driver who leaves it at the door (`same-day`). Never pickup, signature, marketplace third-party sellers, or local stores that don't deliver. Only stores Grok can check out with now. One main store that covers the list in time, or the fewest that do, plus an optional same-day store (Saad chose A) used only when the main store can't make a deadline.
4. **Products** from the plan's stores only (`save_supply_item` refuses a product from any other store). One question first: the same schedule for everything, or each its own. The store note is optional.

`check_supplies` returns the plan as `stores`, and Grok uses the same-day store for an item whose deadline the main store can't make.

## 3. Ordering

**What's due.** `check_supplies` returns:

- `due`: each item due today, with why (`schedule`, `cleaner`, `host`), the deadline, `qtyPerOrder`, both products, and the last price paid.
- `unconfirmed`: carts that got go but have no `record_order` (below).
- `held`: carts waiting for the landlord.
- `late`: orders past their deadline with no delivery, each told once.
- `monthSpentCents`, and the caps.

**Grok shops each batch.**

1. For each due item, Grok opens the preferred product. Out of stock, a changed listing, or no delivery by the deadline: try the backup. Both fail: `record_problem`, and the landlord is asked.
2. Grok groups items by store and goes through checkout to the final page, where tax, shipping, and the delivery date show.
3. **Before Place Order, Grok calls `check_cart`** with the store, each item (`itemId`, `preferred` or `backup`, qty, unit price), shipping, tax, the final total, and the delivery date. Supply Core answers:
   - per item, **hold** when the unit price is more than `priceJumpPct` above `lastPaidCents` (or `priceCents` before the first order), when the item isn't due, when it's on its way, or when it's already in another open go cart (so two routines running at once can't both order it);
   - per cart, **hold** when the total is over `perOrderCapCents`, when `monthSpentCents + total` is over `perMonthCapCents`, when the delivery date misses any item's deadline, or when the mode is `checkout`;
   - **go** when nothing holds and the mode is hands-off.

   Holds come in two kinds. **Approvable** (a price jump, a cap, a missed deadline, `checkout` mode): the answer carries a `cartToken` with status `held`, and the landlord can approve it. **Remove first** (not due, on its way, in another open cart, not on the list): no token; Grok takes those items out and checks again. The token is bound to the exact store, items, quantities, prices, and total, good for 30 minutes, and any change needs a new `check_cart`. To place the rest of a cart around a held item, Grok removes the held item and checks the smaller cart, so the total checked is always the total paid.
4. **Go.** Grok places the order with the landlord's saved Vault card, then calls `record_order` with the token, the order number, `chargedCents`, and the expected delivery. The landlord gets one chat line: `Ordered from Target: paper towels ×2, dish soap. $39.11, arriving Thursday.`
5. **Hold.** Grok stops before Place Order and shows the landlord the cart and why. `approve_cart` without a code returns the question and a code. After the landlord's yes, Grok calls it again with the code, places the order, then calls `record_order` with the code.
   - A price-jump hold asks: `Paper towels went from $24 to $31. Buy anyway, switch to your backup, or skip?` Buy anyway is `approve_cart`. Backup is a new `check_cart`. Skip is `skip_item`, which clears it until the next due date.

**Fallback: Grok's own approval card.** When the store or payment route raises Grok's approval card, or while the probe (Part 6) hasn't passed, Grok uses Buy now and tells the landlord to tap Pay. After the landlord pays, Grok calls `record_order` with `approvedBy: "grok-card"` and the same token. If the card expires unpaid, the next run tries once more, then tells the landlord in chat.

**Unconfirmed carts.** A go token with no `record_order` within 30 minutes becomes an `unconfirmed` order. Its items stay on their way. On the next run, Grok checks its own order history and tracking for that store first: found, `record_order` with the details; not found, `record_problem` with `not-placed`, which frees the items. This keeps a crash or timeout from ordering twice.

**Charged differs.** `chargedCents` above the checked total is recorded and told to the landlord. If it puts the month over the cap, later carts that month hold.

**Delivery.** When Grok's tracking reports delivery, `mark_delivered`. An order past its deadline is told to the landlord once.

**Problems.** `record_problem` takes `store-blocked`, `listing-changed`, `out-of-stock`, `misses-deadline`, or `not-placed`, for an item or a cart. Store blocked twice in a row for an item: Grok suggests the backup's store or another store. Listing changed: Grok asks the landlord to pick again with product cards.

**Cleaner reports** (cleaning tenants with supplies on and activated).

1. When the cleaner's DONE is taken (after the checklist YES when there is one), the done text becomes one text: `Thanks, cleaning marked done. Anything running low? Reply with what's low, or NONE.` The job saves `supplyAskedAt`. The delivery id stays `done:{inboundId}`.
2. The cleaner's next text within 12 hours that isn't a keyword (STOP, HELP, START, DONE), an injury report, or code-like is the answer. It's saved on the job as `supplyReport: { text, at }`, with the door code and every run of 4 or more digits redacted (`noteText`), and Cleaner Core replies `Thanks, noted.` (delivery id `supply-noted:{inboundId}`). NONE, NO, or "nothing" saves `supplyReport: { none: true }` with the same reply. A YES there means nothing and the question keeps waiting.
3. After 12 hours with no answer, the question closes. Nothing is re-sent.
4. `check_now` returns the report in `messages` with the label `supply-report`. Grok matches the words to list items and calls `report_low` with those item ids, `source: "cleaner"`, and the job id. Words that match nothing go to the landlord: `Maria says trash bags are low. They're not on your list. Want to add them?`
5. Only the cleaner's own phone counts. In a group, the question goes to the group addressed to the cleaner by name (`addressCleaner`), and a reply from the landlord or a contact doesn't count.
6. Replays and restarts never send a second question or a second `Thanks, noted.`

The landlord says "we're low on coffee" in chat: Grok calls `report_low` with `source: "host"`.

## 4. Tools

| Tool | Does |
| --- | --- |
| `get_supply_state` | Setup's next `ask`, or the summary: items, mode, caps, this month's spending, open holds. A standalone tenant's `get_state` returns the same. |
| `turn_on_supplies` / `turn_off_supplies` | Cleaning tenants only. On needs no code (nothing is live yet). Off uses the two-call approval and clears open carts. |
| `save_supply_settings` | Property (standalone), mode, caps, price-jump percent, buffer, check time. |
| `save_supply_item` | Adds or changes an item. Two-call approval after Activate. |
| `remove_supply_item` | Two-call approval after Activate. |
| `preview_schedule` | The next 3 dates for a schedule, or why it's refused. |
| `save_supply_sources` | Standalone bookings source, reusing Cleaner Core's upload flow. |
| `activate_supplies` | Refused until there's at least one item, a mode, and a check time. |
| `check_supplies` | What's due, unconfirmed, held, late, and spending. |
| `report_low` | Marks list items due now. Takes item ids only, never free text or a product. |
| `check_cart` | Go or hold, with the token. |
| `approve_cart` | Two-call approval for a held cart. |
| `record_order` | Refused without a live go token or a valid approval code. |
| `record_problem` | An item's or cart's problem (Part 3). |
| `skip_item` | Clears a held item until its next due date. |
| `mark_delivered` | An order arrived. |

## 5. Safety gates

A new `docs/supply-core-safety-gates.md`, in the same format as the Cleaner Core one, each gate with a test:

1. **No card details.** Every Supply Core text input is checked: a run of 13 to 19 digits (spaces and dashes allowed) that passes the Luhn check, or a field named like a card number, expiry, or security code, is refused and nothing is saved or logged.
2. **No order without go or the landlord.** `record_order` is refused without a live go token bound to that cart, or an approval code from `approve_cart`. A refused `record_order` is shown to the landlord.
3. **Caps and price jumps are Supply Core's code.** `check_cart` decides them. Grok's words can't change a hold to go.
4. **A cleaner's text only marks list items low.** It can't add an item, set a product, store, link, or cap, approve a cart, or order anything not on the list. Unmatched words go to the landlord as a question.
5. **The DONE supplies question** goes only to the approved cleaner (or the group addressed to them), only with supplies on and activated, never carries the door code, and follows the existing allowlist. This gate is added to `docs/cleaner-core-safety-gates.md`.
6. **Tests and Scratch never shop.** No test reaches a real store or places an order, and tests use 555 numbers only. Scratch has a supplies drive where `record_order` takes made-up order numbers.
7. **Tenants are apart.** Two tenants never see each other's lists, orders, or spending.

## 6. Testing and verification

**New tests (vitest).**

- `test/supplySchedule.test.ts`: `every` days and monthly, `bookings` counts, `custom` RRULE parts and refusals, deadlines with and without Cleaner Core, the 14-day on-its-way lock.
- `test/supplyGate.test.ts`: per-order and monthly caps (each alone, both, neither), price jump at, below, and above the threshold, first order against `priceCents`, a missed deadline, `checkout` mode, a token bound to its cart (any change is stale), expiry at 30 minutes, a partial-go cart.
- `test/supplyDesk.test.ts`: setup `ask` order and skips, two-call approvals after Activate, `record_order` refusals, unconfirmed carts and `not-placed`, `chargedCents` over the check, monthly totals by time zone, `report_low` with ids only, card-number refusal on every input.
- `test/supplyHosted.test.ts`: the `supplies` service choice behind `SUPPLY_CORE=1`, tool lists for a standalone supplies tenant and a cleaning tenant with the add-on on and off, two tenants apart.
- `test/cleanerSupplyAsk.test.ts`: DONE → one text with the question; checklist YES → the same; the answer saved and redacted; NONE; YES ignored; STOP, HELP, injury, and code-like texts still win; 12 hours closes it; group answers only from the cleaner; replays send one question and one `Thanks, noted.`; supplies off sends today's done text unchanged.

**Updated tests.** `cleanerSetupAsk`, the pinned assistant texts, `cleanerTemplate`, and the service-choice tests.

**Before shipping.**

- `scripts/ci-check.sh`: the suite, typecheck, and the door-code secret scan.
- The verify-cleanercore skill's Scratch smoke gains a supplies drive: DONE → the question → a report → `supply-report` in `check_now`. It sends nothing to a real phone.

**The real-Grok probe.** This spends real money, so it needs Saad's okay, and Saad runs it. I can't run Grok from the build container.

1. In a Grok Bot with a low-limit card saved in Vault, a Supply Core Check routine buys one cheap item from a Shopify store through the store's checkout, with nobody in chat.
2. Record whether it finished with no approval card, or whether Auto-review or Grok raised a card.
3. Repeat once from a chat turn with Auto-review's "Allow automatically" rule for that store's checkout.

Until the probe passes, the template tells Grok to use the fallback in hands-off mode: prepare with Buy now, and the landlord taps Pay. The result goes into `SUPPLY_CORE_BOOTSTRAP.md`.

## Later

- Supply Core with Tour Core.
- More than one property per tenant.
- Returns and refunds recorded from Grok's Order Concierge.
- A text to the cleaner when supplies arrive.
- Price watching between orders (Grok's Deal Watcher) to time bulk buys.

## Sources

- Grok Bot Changelog: https://x.ai/changelog/bot
- Changelog mirror: https://www.gradually.ai/en/changelogs/grok-bot/
- Vault and secure sign-in: https://docs.x.ai/grok-bot/vault
- Grok Bot security: https://docs.x.ai/grok-bot/security
- Nov 2 roundup: https://teslanorth.com/2026/11/02/grok-bot-9-upgrades-shopping/
- Shopping assistant guide: https://www.atlascloud.ai/blog/tips/grok-bot-shopping-assistant
- Stripe Link one-time cards: https://dev.to/rohan_techofficial_81a0f/grok-bot-got-a-wallet-what-xais-shopping-agent-actually-does-with-your-money-1n3g
- Amazon blocking reports: https://medium.com/codetodeploy/amazon-locked-grok-bot-out-shopify-just-let-it-pay-7c69dfdfbc58
