import { createHash } from "node:crypto";

/**
 * Supply Core's go or hold on a cart, decided by code rather than by the assistant. Pure: the desk
 * builds the context from its record and saves the answer.
 */

export type Mode = "hands-off" | "checkout";

export interface CartLine {
  itemId: string;
  product: "preferred" | "backup";
  qty: number;
  unitCents: number;
}

export interface CartInput {
  store: string;
  items: CartLine[];
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  /** The delivery date the store's checkout shows, local `YYYY-MM-DD`. */
  deliveryBy: string;
}

/** Holds the landlord can't approve: Grok takes the item out and checks again. */
export type RemoveFirst = "unknown-item" | "not-due" | "on-its-way" | "in-open-cart";
/** Holds the landlord can approve. */
export type Approvable = "price-jump" | "over-order-cap" | "over-month-cap" | "misses-deadline" | "checkout-mode";

export interface GateContext {
  mode: Mode;
  perOrderCapCents?: number;
  perMonthCapCents?: number;
  priceJumpPct: number;
  monthSpentCents: number;
  /** Each product's baseline is its last price paid, else the price when picked. */
  items: ReadonlyMap<string, { name: string; baseline: { preferred: number; backup?: number } }>;
  due: ReadonlyMap<string, { deadline: string }>;
  onItsWay: ReadonlySet<string>;
  inOpenCart: ReadonlySet<string>;
}

export interface Hold {
  reason: Approvable;
  itemId?: string;
  wasCents?: number;
  nowCents?: number;
}

export type GateAnswer = { verdict: "refused"; remove: { itemId: string; reason: RemoveFirst }[] } | { verdict: "go" | "held"; holds: Hold[] };

function removeReason(line: CartLine, ctx: GateContext): RemoveFirst | undefined {
  const item = ctx.items.get(line.itemId);
  if (!item || (line.product === "backup" && item.baseline.backup === undefined)) return "unknown-item";
  if (ctx.onItsWay.has(line.itemId)) return "on-its-way";
  if (ctx.inOpenCart.has(line.itemId)) return "in-open-cart";
  if (!ctx.due.has(line.itemId)) return "not-due";
  return undefined;
}

export function checkCart(cart: CartInput, ctx: GateContext): GateAnswer {
  const remove = cart.items.flatMap((line) => {
    const reason = removeReason(line, ctx);
    return reason ? [{ itemId: line.itemId, reason }] : [];
  });
  if (remove.length > 0) return { verdict: "refused", remove };

  const holds: Hold[] = [];
  for (const line of cart.items) {
    const baseline = ctx.items.get(line.itemId)!.baseline[line.product]!;
    // Integer cents: over baseline × (1 + pct / 100), with no rounding.
    if (line.unitCents * 100 > baseline * (100 + ctx.priceJumpPct)) holds.push({ reason: "price-jump", itemId: line.itemId, wasCents: baseline, nowCents: line.unitCents });
  }
  if (ctx.perOrderCapCents !== undefined && cart.totalCents > ctx.perOrderCapCents) holds.push({ reason: "over-order-cap" });
  if (ctx.perMonthCapCents !== undefined && ctx.monthSpentCents + cart.totalCents > ctx.perMonthCapCents) holds.push({ reason: "over-month-cap" });
  const deadline = cart.items.map((line) => ctx.due.get(line.itemId)!.deadline).sort()[0];
  if (deadline && cart.deliveryBy > deadline) holds.push({ reason: "misses-deadline" });
  if (ctx.mode === "checkout") holds.push({ reason: "checkout-mode" });
  return { verdict: holds.length > 0 ? "held" : "go", holds };
}

/** The cart's identity: any change to the store, an item, a price, a quantity, or a total changes it. */
export function cartFingerprint(cart: CartInput): string {
  const items = [...cart.items]
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : a.product.localeCompare(b.product)))
    .map((line) => [line.itemId, line.product, line.qty, line.unitCents]);
  const canonical = JSON.stringify([cart.store, items, cart.shippingCents, cart.taxCents, cart.totalCents, cart.deliveryBy]);
  return createHash("sha256").update(canonical).digest("hex");
}
