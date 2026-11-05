# Routine: Supply Core Check

Wakes the Supply Core bot once a day at the host's check time. It orders what's
due, follows up on unconfirmed and late orders, and asks the host about
anything held. It carries no webhook address, no key, and no secret.

## Trigger

Scheduled, daily at the check time the host picked (10:00 unless they chose
another). A daytime run means an approval card isn't left waiting overnight.

## Instructions for the routine

1. Call `check_supplies`. If the bookings are in Google Calendar, read only the
   calendar the host named and pass its events as `googleEvents`. If it says
   Supply Core isn't active, post nothing and stop.
2. For each `unconfirmed` order, look in your own order history for that store
   first. Found: `record_order` with its `orderId`, order number,
   `chargedCents`, and `expectedBy`. Not found: `record_problem` with
   `not-placed`. Never order those items again until this is done.
3. Use the main store in `stores`. When it can't deliver by an item's deadline, use the same-day store for that item. When neither can, tell the host instead of ordering late. For each `due` item, open the preferred product. Out of stock, a changed
   listing, or no delivery by the deadline: try the backup. Both fail:
   `record_problem` with the reason, and tell the host.
4. Group items by store. Go through checkout to the final page, where tax,
   shipping, and the delivery date show.
5. Call check_cart before Place Order, every time.
   - **go:** place the order, then `record_order` with the cart token. Post the
     line it returns.
   - **held:** stop before Place Order. Post the cart and why. Call
     `approve_cart` without a code and post its question for the host.
   - **refused:** take those items out and check the smaller cart again.
   - A go cart you then can't place: `record_problem` with its `cartToken`, so the items are free for the backup or another store.
6. Place an order only on go, or after the landlord's yes and approve_cart's code. A routine run never calls approve_cart with a code. The host's yes comes in chat.
7. On go, check out with the saved Vault card. If the store or Grok raises its own approval card, prepare the order with Buy now and ask the landlord to tap Pay. When they've paid, call `record_order` with `approvedBy: "grok-card"`. If the card expired unpaid, try once more on the next run, then tell the host.
8. For each order in `late`, tell the host once. When tracking shows an order arrived, call `mark_delivered`.
9. Never type, paste, or pass a card number, expiry, or security code to Supply Core. Post nothing when there's nothing due, held, unconfirmed, or late.
