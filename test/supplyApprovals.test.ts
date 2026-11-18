import { hubFor } from "../src/hub/hub";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { supplyDeskFor, type SupplyDeps, type SupplyDesk } from "../src/supply-core/desk";
import { MAX_APPROVALS, readSupply, writeSupply } from "../src/supply-core/store";
import { interpretFeed } from "../src/hub/calendar";
import { setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";

/** #238 follow-up: Supply Core keeps each cart the host approved, so the hours log has it even when the cart never becomes an order. Made-up stores, links, and order numbers only. */

const PROPERTY = { name: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" };
const START = new Date("2026-11-04T15:00:00.000Z");
const MIN = 60_000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const product = (slug: string, priceCents: number) => ({ title: `Example ${slug}`, store: "Example Mart", url: `https://shop.example/${slug}`, packSize: "1 pack", priceCents });
const towels = { name: "Paper towels", qtyPerOrder: 2, preferred: product("towels", 2400), backup: product("towels-b", 2100), storeNote: "Cheapest per roll.", schedule: { kind: "every" as const, days: 21 } };
const soap = { name: "Dish soap", qtyPerOrder: 1, preferred: product("soap", 429), storeNote: "Same store.", schedule: { kind: "every" as const, days: 30 } };

interface Made {
  desk: SupplyDesk;
  root: string;
  clock: { now: Date };
  ids: { towels: string; soap: string };
}

async function activated(over: { mode?: "hands-off" | "checkout"; perMonthCapCents?: number } = {}): Promise<Made> {
  const root = mkdtempSync(join(tmpdir(), "supply-order-"));
  dirs.push(root);
  const clock = { now: START };
  const deps: SupplyDeps = { now: () => clock.now };
  const desk = supplyDeskFor(root, deps);
  await desk.saveSettings({ property: PROPERTY });
  await desk.saveItem(towels);
  await desk.saveItem(soap);
  await desk.saveItem({ done: true });
  await desk.saveSettings({ mode: over.mode ?? "hands-off", perOrderCapCents: null, perMonthCapCents: over.perMonthCapCents ?? null, checkTime: "10:00", routineCreated: true });
  expect((await desk.activate({})).isError).toBe(false);
  // Activate orders nothing by itself: these tests start a month later, with both items due.
  monthAgo(root);
  const items = readSupply(root).items;
  return { desk, root, clock, ids: { towels: items[0]!.id, soap: items[1]!.id } };
}

/** Moves Activate and every item's save date back a month, as if Supply Core had been on since. */
function monthAgo(root: string): void {
  const file = readSupply(root);
  const then = new Date(START.getTime() - 30 * 24 * 60 * MIN).toISOString();
  file.settings.activatedAt = then;
  for (const item of file.items) item.savedAt = then;
  writeSupply(root, file);
}

const cartOf = (lines: { itemId: string; product?: "preferred" | "backup"; qty: number; unitCents: number }[], over: Record<string, unknown> = {}) => {
  const items = lines.map((line) => ({ product: "preferred" as const, ...line }));
  const total = items.reduce((sum, line) => sum + line.qty * line.unitCents, 0);
  return { store: "Example Mart", items, shippingCents: 0, taxCents: 0, totalCents: total, deliveryBy: "2026-11-06", ...over };
};

function code(reply: { structured?: Record<string, unknown> }): string {
  return (reply.structured!.confirmation as { code: string }).code;
}


/** A held cart of towels, approved by the host with the code. Returns the cart token. */
async function approved(made: Made): Promise<string> {
  const held = await made.desk.checkCart(cartOf([{ itemId: made.ids.towels, qty: 2, unitCents: 2400 }]));
  expect(held.structured!.verdict).toBe("held");
  const token = held.structured!.cartToken as string;
  const ask = await made.desk.approveCart({ cartToken: token });
  expect((await made.desk.approveCart({ cartToken: token, confirmation: code(ask) })).isError).toBe(false);
  return token;
}

describe("the host's cart approvals are kept (#238 follow-up)", () => {
  it("approve_cart records the host's yes, and record_order links it to the order", async () => {
    const made = await activated({ mode: "checkout" });
    const token = await approved(made);
    expect((await made.desk.recordOrder({ cartToken: token, chargedCents: 4800 })).isError).toBe(false);
    const file = readSupply(made.root);
    expect(file.approvals).toEqual([
      { id: expect.stringMatching(/^apv_[a-z0-9]{10}$/), at: START.toISOString(), store: "Example Mart", items: [{ itemId: made.ids.towels, qty: 2 }], totalCents: 4800, orderId: file.orders[0]!.id, orderAt: file.orders[0]!.at },
    ]);
    expect(JSON.stringify(file.approvals)).not.toContain(token);
  });

  it("an approved cart that expires becomes an unconfirmed order linked to the approval, at the approval's time", async () => {
    const made = await activated({ mode: "checkout" });
    await approved(made);
    made.clock.now = new Date(START.getTime() + 31 * MIN);
    await made.desk.checkSupplies({});
    const file = readSupply(made.root);
    const order = file.orders.find((o) => o.status === "unconfirmed")!;
    expect(order.approvedBy).toBe("landlord");
    expect(file.approvals![0]).toMatchObject({ orderId: order.id, orderAt: order.at, at: order.at });
  });

  it("removing that unconfirmed order as not-placed keeps the approval", async () => {
    const made = await activated({ mode: "checkout" });
    await approved(made);
    made.clock.now = new Date(START.getTime() + 31 * MIN);
    const orders = (await made.desk.checkSupplies({})).structured!.unconfirmed as { id: string }[];
    expect((await made.desk.recordProblem({ reason: "not-placed", orderId: orders[0]!.id })).isError).toBe(false);
    const file = readSupply(made.root);
    expect(file.orders).toEqual([]);
    expect(file.approvals).toEqual([expect.objectContaining({ orderId: orders[0]!.id, at: START.toISOString() })]);
  });

  it("an approved cart closed with record_problem keeps the approval, with no order", async () => {
    const made = await activated({ mode: "checkout" });
    const token = await approved(made);
    expect((await made.desk.recordProblem({ reason: "out-of-stock", cartToken: token })).isError).toBe(false);
    const approvals = readSupply(made.root).approvals!;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.orderId).toBeUndefined();
  });

  it("a go cart the rules placed records no approval", async () => {
    const made = await activated();
    const go = await made.desk.checkCart(cartOf([{ itemId: made.ids.towels, qty: 2, unitCents: 2400 }]));
    await made.desk.recordOrder({ cartToken: go.structured!.cartToken as string, chargedCents: 4800 });
    expect(readSupply(made.root).approvals ?? []).toEqual([]);
  });

  it("an older supply.json with none reads, and the next approval starts the list", async () => {
    const made = await activated({ mode: "checkout" });
    const file = readSupply(made.root);
    delete file.approvals;
    writeSupply(made.root, file);
    await approved(made);
    expect(readSupply(made.root).approvals).toHaveLength(1);
  });

  it(`keeps at most ${MAX_APPROVALS}, the oldest dropped`, async () => {
    const made = await activated({ mode: "checkout" });
    const file = readSupply(made.root);
    file.approvals = Array.from({ length: MAX_APPROVALS }, (_, i) => ({ id: `apv_old${String(i).padStart(7, "0")}`, at: "2026-10-01T12:00:00.000Z", store: "Example Mart", items: [], totalCents: 0 }));
    writeSupply(made.root, file);
    await approved(made);
    const approvals = readSupply(made.root).approvals!;
    expect(approvals).toHaveLength(MAX_APPROVALS);
    expect(approvals[0]!.id).toBe("apv_old0000001");
    expect(approvals.at(-1)!.at).toBe(START.toISOString());
  });
});
