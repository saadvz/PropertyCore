import { describe, expect, it } from "vitest";
import { looksLikeCard, refuseCards } from "../src/supply-core/cards";
import { cartFingerprint, checkCart, type CartInput, type GateContext } from "../src/supply-core/gate";

describe("looksLikeCard / refuseCards", () => {
  it("catches a Luhn-valid 16-digit number with spaces or dashes", () => {
    expect(looksLikeCard("4242 4242 4242 4242")).toBe(true);
    expect(looksLikeCard("4242-4242-4242-4242")).toBe(true);
    expect(refuseCards({ items: [{ note: "card 4242424242424242" }] })).toBe(true);
  });

  it("lets order numbers and prices through", () => {
    expect(looksLikeCard("Order 112-7781234-5566778")).toBe(false);
    expect(looksLikeCard("4242 4242 4242 4241")).toBe(false);
    expect(refuseCards({ store: "Target", totalCents: 3911 })).toBe(false);
  });
});

const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  mode: "hands-off",
  priceJumpPct: 20,
  monthSpentCents: 0,
  items: new Map([
    ["it_towels", { name: "Paper towels", baseline: { preferred: 2400, backup: 2100 } }],
    ["it_soap", { name: "Dish soap", baseline: { preferred: 429 } }],
  ]),
  due: new Map([
    ["it_towels", { deadline: "2026-11-08" }],
    ["it_soap", { deadline: "2026-11-08" }],
  ]),
  onItsWay: new Set(),
  inOpenCart: new Set(),
  ...over,
});

const cart = (over: Partial<CartInput> = {}): CartInput => ({
  store: "Target",
  items: [{ itemId: "it_towels", product: "preferred", qty: 1, unitCents: 2400 }],
  shippingCents: 0,
  taxCents: 0,
  totalCents: 2400,
  deliveryBy: "2026-11-07",
  ...over,
});

describe("checkCart", () => {
  it("is go when nothing holds in hands-off mode", () => {
    expect(checkCart(cart(), ctx())).toEqual({ verdict: "go", holds: [] });
  });

  it("holds a price more than priceJumpPct above the baseline, and not at it", () => {
    expect(checkCart(cart({ items: [{ itemId: "it_towels", product: "preferred", qty: 1, unitCents: 2880 }], totalCents: 2880 }), ctx()).verdict).toBe("go");
    expect(checkCart(cart({ items: [{ itemId: "it_towels", product: "preferred", qty: 1, unitCents: 2881 }], totalCents: 2881 }), ctx())).toEqual({
      verdict: "held",
      holds: [{ reason: "price-jump", itemId: "it_towels", wasCents: 2400, nowCents: 2881 }],
    });
  });

  it("compares the backup against the backup's baseline", () => {
    expect(checkCart(cart({ items: [{ itemId: "it_towels", product: "backup", qty: 1, unitCents: 2600 }], totalCents: 2600 }), ctx()).verdict).toBe("held");
  });

  it("holds over the per-order cap, over the month cap, each alone, and neither when unset", () => {
    expect(checkCart(cart(), ctx({ perOrderCapCents: 2399 }))).toMatchObject({ verdict: "held", holds: [{ reason: "over-order-cap" }] });
    expect(checkCart(cart(), ctx({ perMonthCapCents: 30000, monthSpentCents: 27601 }))).toMatchObject({ verdict: "held", holds: [{ reason: "over-month-cap" }] });
    expect(checkCart(cart(), ctx({ perMonthCapCents: 30000, monthSpentCents: 27600 })).verdict).toBe("go");
    expect(checkCart(cart({ totalCents: 999_999 }), ctx()).verdict).toBe("go");
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
    expect(answer).toEqual({
      verdict: "refused",
      remove: [
        { itemId: "it_towels", reason: "on-its-way" },
        { itemId: "it_soap", reason: "in-open-cart" },
        { itemId: "it_x", reason: "unknown-item" },
        { itemId: "it_y", reason: "unknown-item" },
      ],
    });
  });

  it("refuses an item that isn't due", () => {
    expect(checkCart(cart(), ctx({ due: new Map() }))).toEqual({ verdict: "refused", remove: [{ itemId: "it_towels", reason: "not-due" }] });
  });
});

describe("cartFingerprint", () => {
  it("ignores item order and changes with any price, qty or total", () => {
    const a = cart({
      items: [
        { itemId: "it_soap", product: "preferred", qty: 1, unitCents: 429 },
        { itemId: "it_towels", product: "preferred", qty: 1, unitCents: 2400 },
      ],
    });
    const b = cart({ items: [...a.items].reverse() });
    expect(cartFingerprint(a)).toBe(cartFingerprint(b));
    expect(cartFingerprint(a)).not.toBe(cartFingerprint({ ...a, totalCents: a.totalCents + 1 }));
    expect(cartFingerprint(a)).not.toBe(cartFingerprint({ ...a, items: [{ ...a.items[0]!, qty: 2 }, a.items[1]!] }));
  });
});
