# Supply Core safety gates

These gates have to stay green before Supply Core places a live order for anyone. CI runs `scripts/ci-check.sh` on Node 22. No gate's proof reaches a real store, places an order, or texts a real phone.

| Gate | What it holds | Proof |
| --- | --- | --- |
| No card details | Every Supply Core tool input is checked: a 13 to 19 digit run that passes the Luhn check is refused before anything is saved or logged, and every tool schema is strict, so no field can carry a card number, expiry, or security code. | `test/supplyGate.test.ts`, `test/supplyOrdering.test.ts`, `test/supplyHosted.test.ts` |
| No order without go or the landlord | `record_order` is refused without a live go token bound to that cart, or the landlord's approval through `approve_cart`'s code. An expired cart can't be approved or recorded. | `test/supplyOrdering.test.ts` |
| Caps and price jumps | `check_cart` decides the per-order and monthly caps, a price more than the threshold over the last price paid, a missed deadline, and stop-at-checkout mode in code. Grok's words can't turn a hold into go. Two open carts can't hold the same item. | `test/supplyGate.test.ts`, `test/supplyOrdering.test.ts` |
| Cleaner text | A cleaner's text only marks list items low. `report_low` takes item ids, not words; it can't add an item, set a product, store, link, or cap, approve a cart, or order anything not on the list. | `test/supplyOrdering.test.ts` |
| DONE supplies question | Goes only to the approved cleaner (or the group addressed to them), only with Supply Core on and active, never carries the door code, and follows the existing allowlist. Also a gate in `docs/cleaner-core-safety-gates.md`. | `test/cleanerSupplyAsk.test.ts`, `test/cleanerSupplyDesk.test.ts` |
| No real shopping in tests | Tests use made-up stores, `https://shop.example/…` links, and made-up order numbers, and 555 numbers only. Calendar reads are stubbed. | every `test/supply*.test.ts` |
| Tenants apart | Two tenants never see each other's lists, orders, or spending. A supplies tenant's number answers no text. | `test/supplyHosted.test.ts` |

The hands-off probe, a real purchase from a Grok routine with a saved Vault card, spends real money, so only Saad runs it. Until it passes, `SUPPLY_CORE_BOOTSTRAP.md` tells Grok to prepare orders with Buy now and ask the landlord to tap Pay.
