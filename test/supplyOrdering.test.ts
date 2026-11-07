import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { supplyDeskFor, type SupplyDeps, type SupplyDesk } from "../src/supply-core/desk";
import { readSupply } from "../src/supply-core/store";
import { interpretFeed } from "../src/hub/calendar";
import { setCleanerCalendarFetch } from "../src/cleaner-core/liveDesk";

/** Supply Core's ordering tools on a made-up property. Made-up stores, links, and order numbers only. */

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
  const deps: SupplyDeps = { now: () => clock.now, standalone: true };
  const desk = supplyDeskFor(root, deps);
  await desk.saveSettings({ property: PROPERTY });
  await desk.saveItem(towels);
  await desk.saveItem(soap);
  await desk.saveItem({ done: true });
  await desk.saveSettings({ mode: over.mode ?? "hands-off", perOrderCapCents: null, perMonthCapCents: over.perMonthCapCents ?? null, checkTime: "10:00", routineCreated: true });
  expect((await desk.activate({})).isError).toBe(false);
  const items = readSupply(root).items;
  return { desk, root, clock, ids: { towels: items[0]!.id, soap: items[1]!.id } };
}

const cartOf = (lines: { itemId: string; product?: "preferred" | "backup"; qty: number; unitCents: number }[], over: Record<string, unknown> = {}) => {
  const items = lines.map((line) => ({ product: "preferred" as const, ...line }));
  const total = items.reduce((sum, line) => sum + line.qty * line.unitCents, 0);
  return { store: "Example Mart", items, shippingCents: 0, taxCents: 0, totalCents: total, deliveryBy: "2026-11-06", ...over };
};

function code(reply: { structured?: Record<string, unknown> }): string {
  return (reply.structured!.confirmation as { code: string }).code;
}

describe("check_supplies", () => {
  it("lists due items with deadlines and leaves out items on their way", async () => {
    const { desk, ids } = await activated();
    const first = await desk.checkSupplies({});
    expect(first.structured!.due).toEqual([
      expect.objectContaining({ itemId: ids.towels, name: "Paper towels", why: "schedule", deadline: "2026-11-07", qtyPerOrder: 2 }),
      expect.objectContaining({ itemId: ids.soap, name: "Dish soap", why: "schedule", deadline: "2026-11-07", qtyPerOrder: 1 }),
    ]);
    const go = await desk.checkCart(cartOf([{ itemId: ids.towels, qty: 2, unitCents: 2400 }]));
    await desk.recordOrder({ cartToken: go.structured!.cartToken as string, orderNumber: "SCRATCH-1", chargedCents: 4800 });
    const after = await desk.checkSupplies({});
    expect((after.structured!.due as { itemId: string }[]).map((d) => d.itemId)).toEqual([ids.soap]);
    expect(after.structured!.monthSpentCents).toBe(4800);
  });
});

describe("check_cart and record_order", () => {
  it("a go cart records once; record_order without a token or with a stale one is refused", async () => {
    const { desk, ids } = await activated();
    const go = await desk.checkCart(cartOf([{ itemId: ids.towels, qty: 2, unitCents: 2400 }]));
    expect(go.structured).toMatchObject({ verdict: "go", cartToken: expect.stringMatching(/^cart_/), expiresInMinutes: 30 });
    expect((await desk.recordOrder({ chargedCents: 4800 })).isError).toBe(true);
    expect((await desk.recordOrder({ cartToken: "cart_nope", chargedCents: 4800 })).isError).toBe(true);
    const token = go.structured!.cartToken as string;
    expect((await desk.recordOrder({ cartToken: token, chargedCents: 4800 })).isError).toBe(false);
    const twice = await desk.recordOrder({ cartToken: token, chargedCents: 4800 });
    expect(twice.isError).toBe(true);
    expect(twice.text).toBe("No go answer or landlord approval for that order. Check the cart again.");
  });

  it("record_order updates lastOrderedAt and lastPaidCents, clears low reports, and returns the order line", async () => {
    const { desk, root, ids } = await activated();
    await desk.reportLow({ itemIds: [ids.towels], source: "cleaner", jobId: "job_1" });
    const go = await desk.checkCart(cartOf([{ itemId: ids.towels, qty: 2, unitCents: 2450 }]));
    const reply = await desk.recordOrder({ cartToken: go.structured!.cartToken as string, orderNumber: "SCRATCH-1", chargedCents: 4800, expectedBy: "2026-11-05" });
    expect(reply.structured!.line).toBe("Ordered from Example Mart: Paper towels ×2. $48.00, arriving Thursday.");
    const file = readSupply(root);
    expect(file.items[0]!.lastOrderedAt).toBe(START.toISOString());
    expect(file.items[0]!.preferred.lastPaidCents).toBe(2450);
    expect(file.lowReports).toEqual([]);
    expect(file.orders[0]).toMatchObject({ approvedBy: "rules", source: "cleaner", status: "placed", orderNumber: "SCRATCH-1" });
  });

  it("a held cart needs approve_cart's code; the landlord's yes lets record_order through with approvedBy landlord", async () => {
    const { desk, root, ids } = await activated({ mode: "checkout" });
    const held = await desk.checkCart(cartOf([{ itemId: ids.towels, qty: 2, unitCents: 2400 }]));
    expect(held.structured).toMatchObject({ verdict: "held", holds: [{ reason: "checkout-mode" }] });
    const token = held.structured!.cartToken as string;
    expect((await desk.recordOrder({ cartToken: token, chargedCents: 4800 })).isError).toBe(true);
    const ask = await desk.approveCart({ cartToken: token });
    expect(ask.structured!.question).toContain("Example Mart");
    expect(ask.structured!.question).toContain("$48.00");
    expect((await desk.approveCart({ cartToken: token, confirmation: code(ask) })).isError).toBe(false);
    expect((await desk.recordOrder({ cartToken: token, chargedCents: 4800 })).isError).toBe(false);
    expect(readSupply(root).orders[0]!.approvedBy).toBe("landlord");
  });

  it("a price jump asks buy anyway, backup, or skip", async () => {
    const { desk, ids } = await activated();
    const held = await desk.checkCart(cartOf([{ itemId: ids.towels, qty: 1, unitCents: 3100 }]));
    expect(held.structured).toMatchObject({ verdict: "held", question: "Paper towels went from $24.00 to $31.00. Buy anyway, switch to your backup, or skip?" });
  });

  it("approve_cart after 30 minutes refuses with 'That cart expired. Check it again.' and record_order refuses", async () => {
    const made = await activated({ mode: "checkout" });
    const held = await made.desk.checkCart(cartOf([{ itemId: made.ids.towels, qty: 2, unitCents: 2400 }]));
    const token = held.structured!.cartToken as string;
    const ask = await made.desk.approveCart({ cartToken: token });
    made.clock.now = new Date(START.getTime() + 31 * MIN);
    const late = await made.desk.approveCart({ cartToken: token, confirmation: code(ask) });
    expect(late.isError).toBe(true);
    expect(late.text).toBe("That cart expired. Check it again.");
    expect((await made.desk.recordOrder({ cartToken: token, chargedCents: 4800 })).isError).toBe(true);
    expect(readSupply(made.root).orders).toEqual([]);
  });

  it("a second check_cart with the same item while the first is open refuses with in-open-cart", async () => {
    const { desk, ids } = await activated();
    await desk.checkCart(cartOf([{ itemId: ids.towels, qty: 2, unitCents: 2400 }]));
    const second = await desk.checkCart(cartOf([{ itemId: ids.towels, qty: 2, unitCents: 2400 }]));
    expect(second.structured).toEqual(expect.objectContaining({ verdict: "refused", remove: [{ itemId: ids.towels, reason: "in-open-cart" }] }));
    expect(second.structured!.cartToken).toBeUndefined();
  });

  it("a go cart with no record_order after 30 minutes becomes an unconfirmed order; its items stay on their way", async () => {
    const made = await activated();
    await made.desk.checkCart(cartOf([{ itemId: made.ids.towels, qty: 2, unitCents: 2400 }]));
    made.clock.now = new Date(START.getTime() + 31 * MIN);
    const check = await made.desk.checkSupplies({});
    expect(check.structured!.unconfirmed).toEqual([expect.objectContaining({ store: "Example Mart", status: "unconfirmed" })]);
    expect((check.structured!.due as { itemId: string }[]).map((d) => d.itemId)).toEqual([made.ids.soap]);
  });

  it("record_order with an unconfirmed orderId places it; record_problem not-placed frees its items", async () => {
    const made = await activated();
    await made.desk.checkCart(cartOf([{ itemId: made.ids.towels, qty: 2, unitCents: 2400 }]));
    await made.desk.checkCart(cartOf([{ itemId: made.ids.soap, qty: 1, unitCents: 429 }]));
    made.clock.now = new Date(START.getTime() + 31 * MIN);
    const orders = (await made.desk.checkSupplies({})).structured!.unconfirmed as { id: string; items: { itemId: string }[] }[];
    const towelsOrder = orders.find((o) => o.items[0]!.itemId === made.ids.towels)!;
    const soapOrder = orders.find((o) => o.items[0]!.itemId === made.ids.soap)!;
    expect((await made.desk.recordOrder({ orderId: towelsOrder.id, orderNumber: "SCRATCH-2", chargedCents: 4800 })).isError).toBe(false);
    expect((await made.desk.recordProblem({ reason: "not-placed", orderId: soapOrder.id })).isError).toBe(false);
    const after = await made.desk.checkSupplies({});
    expect((after.structured!.due as { itemId: string }[]).map((d) => d.itemId)).toEqual([made.ids.soap]);
    expect(after.structured!.unconfirmed).toEqual([]);
    expect(readSupply(made.root).orders.map((o) => o.status)).toEqual(["placed"]);
  });

  it("chargedCents above the checked total is recorded with chargedMore, and counts toward the month cap", async () => {
    const { desk, ids } = await activated({ perMonthCapCents: 5000 });
    const go = await desk.checkCart(cartOf([{ itemId: ids.towels, qty: 2, unitCents: 2400 }]));
    const reply = await desk.recordOrder({ cartToken: go.structured!.cartToken as string, chargedCents: 4900 });
    expect(reply.structured!.chargedMore).toBe(true);
    const next = await desk.checkCart(cartOf([{ itemId: ids.soap, qty: 1, unitCents: 429 }]));
    expect(next.structured).toMatchObject({ verdict: "held", holds: [{ reason: "over-month-cap" }] });
  });
});

describe("problems, skips, and deliveries", () => {
  it("store-blocked twice in a row for an item returns suggestOtherStore; a placed order resets the count", async () => {
    const { desk, root, ids } = await activated();
    expect((await desk.recordProblem({ reason: "store-blocked", itemIds: [ids.towels] })).structured!.suggestOtherStore).toBeUndefined();
    expect((await desk.recordProblem({ reason: "store-blocked", itemIds: [ids.towels] })).structured!.suggestOtherStore).toBe(true);
    const go = await desk.checkCart(cartOf([{ itemId: ids.towels, qty: 2, unitCents: 2400 }]));
    await desk.recordOrder({ cartToken: go.structured!.cartToken as string, chargedCents: 4800 });
    expect(readSupply(root).items[0]!.blockedRuns).toBe(0);
  });

  it("skip_item clears a due item until its next occurrence", async () => {
    const made = await activated();
    await made.desk.skipItem({ itemId: made.ids.soap });
    expect(((await made.desk.checkSupplies({})).structured!.due as { itemId: string }[]).map((d) => d.itemId)).toEqual([made.ids.towels]);
    made.clock.now = new Date(START.getTime() + 30 * 86_400_000);
    expect(((await made.desk.checkSupplies({})).structured!.due as { itemId: string }[]).map((d) => d.itemId)).toContain(made.ids.soap);
  });

  it("mark_delivered frees the item before 14 days; without it the item frees after 14 days", async () => {
    const made = await activated();
    const a = await made.desk.checkCart(cartOf([{ itemId: made.ids.towels, qty: 2, unitCents: 2400 }]));
    const placed = await made.desk.recordOrder({ cartToken: a.structured!.cartToken as string, chargedCents: 4800 });
    await made.desk.reportLow({ itemIds: [made.ids.towels], source: "host" });
    expect(((await made.desk.checkSupplies({})).structured!.due as { itemId: string }[]).map((d) => d.itemId)).not.toContain(made.ids.towels);
    await made.desk.markDelivered({ orderId: placed.structured!.orderId as string });
    expect(((await made.desk.checkSupplies({})).structured!.due as { itemId: string }[]).map((d) => d.itemId)).toContain(made.ids.towels);

    const b = await made.desk.checkCart(cartOf([{ itemId: made.ids.soap, qty: 1, unitCents: 429 }]));
    await made.desk.recordOrder({ cartToken: b.structured!.cartToken as string, chargedCents: 429 });
    await made.desk.reportLow({ itemIds: [made.ids.soap], source: "host" });
    made.clock.now = new Date(START.getTime() + 13 * 86_400_000);
    expect(((await made.desk.checkSupplies({})).structured!.due as { itemId: string }[]).map((d) => d.itemId)).not.toContain(made.ids.soap);
    made.clock.now = new Date(START.getTime() + 15 * 86_400_000);
    expect(((await made.desk.checkSupplies({})).structured!.due as { itemId: string }[]).map((d) => d.itemId)).toContain(made.ids.soap);
  });

  it("late lists a past-deadline undelivered order once", async () => {
    const made = await activated();
    const go = await made.desk.checkCart(cartOf([{ itemId: made.ids.towels, qty: 2, unitCents: 2400 }]));
    await made.desk.recordOrder({ cartToken: go.structured!.cartToken as string, chargedCents: 4800 });
    made.clock.now = new Date(START.getTime() + 4 * 86_400_000);
    expect((await made.desk.checkSupplies({})).structured!.late).toEqual([expect.objectContaining({ store: "Example Mart" })]);
    expect((await made.desk.checkSupplies({})).structured!.late).toEqual([]);
  });

  it("report_low takes known item ids only and refuses free text", async () => {
    const { desk, ids } = await activated();
    expect((await desk.reportLow({ itemIds: ["paper towels"], source: "cleaner" })).isError).toBe(true);
    expect((await desk.reportLow({ itemIds: [ids.towels], source: "cleaner" })).isError).toBe(false);
  });

  it("approved-by grok-card is recorded when Grok's own card was paid on a go cart", async () => {
    const { desk, root, ids } = await activated();
    const go = await desk.checkCart(cartOf([{ itemId: ids.towels, qty: 2, unitCents: 2400 }]));
    await desk.recordOrder({ cartToken: go.structured!.cartToken as string, chargedCents: 4800, approvedBy: "grok-card" });
    expect(readSupply(root).orders[0]!.approvedBy).toBe("grok-card");
  });

  it("every ordering tool refuses card-like input", async () => {
    const { desk, ids } = await activated();
    const card = "4242 4242 4242 4242";
    expect((await desk.checkCart(cartOf([{ itemId: ids.towels, qty: 2, unitCents: 2400 }], { store: card }))).isError).toBe(true);
    expect((await desk.recordOrder({ cartToken: "cart_x", orderNumber: card, chargedCents: 1 })).isError).toBe(true);
    expect((await desk.reportLow({ itemIds: [ids.towels], source: "cleaner", jobId: card })).isError).toBe(true);
    expect((await desk.approveCart({ cartToken: card })).isError).toBe(true);
    expect((await desk.recordProblem({ reason: "store-blocked", itemIds: [card] })).isError).toBe(true);
  });
});

describe("bookings", () => {
  const FEED_URL = "https://calendar.example/feed.ics";
  const FEED = readFileSync(join("src/cleaner-core/fixtures", "guesty-lite-scratch.ics"), "utf8");
  afterEach(() => setCleanerCalendarFetch(undefined));

  async function bookingsDesk(now: Date) {
    const root = mkdtempSync(join(tmpdir(), "supply-book-"));
    dirs.push(root);
    const clock = { now };
    const deps: SupplyDeps = { now: () => clock.now, standalone: true, uploadBase: () => "https://supply.example/t/tnt_scratch000" };
    const desk = supplyDeskFor(root, deps);
    await desk.saveSettings({ property: PROPERTY });
    await desk.saveItem({ ...towels, schedule: { kind: "bookings", stays: 1 } });
    await desk.saveItem({ done: true });
    return { root, desk, clock };
  }

  async function finish(desk: SupplyDesk) {
    await desk.saveSettings({ mode: "hands-off", perOrderCapCents: null, perMonthCapCents: null, checkTime: "10:00", routineCreated: true });
    expect((await desk.activate({})).isError).toBe(false);
  }

  it("an upload link saves one calendar, a second adds to it, and no reply repeats the link", async () => {
    let fetched = 0;
    setCleanerCalendarFetch(async () => {
      fetched += 1;
      return { status: 200, url: FEED_URL, async text() { return FEED; } };
    });
    const { desk, root } = await bookingsDesk(START);
    const first = await desk.saveSources({ uploadLink: { name: "Airbnb" } });
    const url = first.structured!.uploadUrl as string;
    expect(url).toMatch(/^https:\/\/supply\.example\/t\/tnt_scratch000\/supply\/calendar\/[A-Za-z0-9_-]{43}$/);
    const code = url.slice(url.lastIndexOf("/") + 1);
    expect((await desk.uploadCalendarLink(code, { url: FEED_URL })).status).toBe(200);
    expect((await desk.uploadCalendarLink(code, { url: FEED_URL })).status).toBe(404);
    const second = await desk.saveSources({ uploadLink: { name: "Vrbo" } });
    const code2 = (second.structured!.uploadUrl as string).split("/").pop()!;
    expect((await desk.uploadCalendarLink(code2, { url: "https://calendar.example/vrbo.ics" })).status).toBe(200);
    expect(readSupply(root).sources.map((s) => s.name)).toEqual(["Airbnb", "Vrbo"]);
    const state = await desk.state();
    expect(JSON.stringify(state)).not.toContain("calendar.example");
    expect((await desk.saveSources({ done: true })).isError).toBe(false);
    expect(fetched).toBe(0);
  });

  it("checkouts from a fetched feed make a by-bookings item due", async () => {
    setCleanerCalendarFetch(async () => ({ status: 200, url: FEED_URL, async text() { return FEED; } }));
    const read = interpretFeed(FEED);
    const checkout = read.turnovers.map((t) => t.checkoutDate).sort()[0]!;
    const { desk } = await bookingsDesk(new Date(`${checkout}T12:00:00.000Z`));
    const up = await desk.saveSources({ uploadLink: { name: "Airbnb" } });
    await desk.uploadCalendarLink((up.structured!.uploadUrl as string).split("/").pop()!, { url: FEED_URL });
    await desk.saveSources({ done: true });
    await finish(desk);
    // Activate is the checkout's own day, and a checkout on Activate's day counts.
    const check = await desk.checkSupplies({});
    expect(check.structured!.sourcesFailed).toBeUndefined();
    expect(check.structured!.due).toEqual([expect.objectContaining({ name: "Paper towels" })]);
  });

  it("googleEvents passed to check_supplies drive a by-bookings item", async () => {
    const { desk, clock } = await bookingsDesk(START);
    await desk.saveSources({ google: true, done: true });
    await finish(desk);
    clock.now = new Date("2026-11-10T15:00:00.000Z");
    const googleEvents = { timeZone: "America/New_York", items: [{ id: "ev1", status: "confirmed", summary: "Guest stay", start: { date: "2026-11-05" }, end: { date: "2026-11-08" } }] };
    const check = await desk.checkSupplies({ googleEvents });
    expect(check.structured!.due).toEqual([expect.objectContaining({ name: "Paper towels" })]);
  });

  it("a failed fetch leaves the item not due, with sourcesFailed", async () => {
    setCleanerCalendarFetch(async () => ({ status: 500, url: FEED_URL, async text() { return ""; } }));
    const { desk } = await bookingsDesk(START);
    const up = await desk.saveSources({ uploadLink: { name: "Airbnb" } });
    await desk.uploadCalendarLink((up.structured!.uploadUrl as string).split("/").pop()!, { url: FEED_URL });
    await desk.saveSources({ done: true });
    await finish(desk);
    const check = await desk.checkSupplies({});
    expect(check.structured!.sourcesFailed).toBe(true);
    expect(check.structured!.due).toEqual([]);
  });

  it("a cleaning tenant takes checkouts from Cleaner Core and never fetches", async () => {
    let fetched = 0;
    setCleanerCalendarFetch(async () => {
      fetched += 1;
      return { status: 200, url: FEED_URL, async text() { return FEED; } };
    });
    const root = mkdtempSync(join(tmpdir(), "supply-book-"));
    dirs.push(root);
    const clock = { now: START };
    const desk = supplyDeskFor(root, { now: () => clock.now, standalone: false, cleaning: { property: () => PROPERTY, turnovers: async () => [{ checkoutYmd: "2026-11-06" }, { checkoutYmd: "2026-11-20" }] } });
    await desk.saveItem({ ...towels, schedule: { kind: "bookings", stays: 1 } });
    await desk.saveItem({ done: true });
    await finish(desk);
    clock.now = new Date("2026-11-07T15:00:00.000Z");
    const check = await desk.checkSupplies({});
    expect(check.structured!.due).toEqual([expect.objectContaining({ name: "Paper towels", deadline: "2026-11-19" })]);
    expect(fetched).toBe(0);
  });
});

describe("held carts don't block the way forward", () => {
  it("the backup after a price-jump hold is checked, and the held cart closes", async () => {
    const { desk, root, ids } = await activated();
    const held = await desk.checkCart(cartOf([{ itemId: ids.towels, qty: 2, unitCents: 3100 }]));
    expect(held.structured!.verdict).toBe("held");
    const backup = await desk.checkCart(cartOf([{ itemId: ids.towels, product: "backup", qty: 2, unitCents: 2100 }]));
    expect(backup.structured!.verdict).toBe("go");
    expect(readSupply(root).carts.map((c) => c.status)).toEqual(["go"]);
    expect((await desk.approveCart({ cartToken: held.structured!.cartToken as string })).isError).toBe(true);
  });

  it("the rest of a cart goes through around a held item", async () => {
    const { desk, ids } = await activated();
    const held = await desk.checkCart(cartOf([{ itemId: ids.towels, qty: 2, unitCents: 3100 }, { itemId: ids.soap, qty: 1, unitCents: 429 }]));
    expect(held.structured!.verdict).toBe("held");
    const rest = await desk.checkCart(cartOf([{ itemId: ids.soap, qty: 1, unitCents: 429 }]));
    expect(rest.structured!.verdict).toBe("go");
  });

  it("skip_item closes held carts holding the item", async () => {
    const { desk, root, ids } = await activated();
    await desk.checkCart(cartOf([{ itemId: ids.towels, qty: 2, unitCents: 3100 }, { itemId: ids.soap, qty: 1, unitCents: 429 }]));
    await desk.skipItem({ itemId: ids.towels });
    expect(readSupply(root).carts).toEqual([]);
    expect((await desk.checkCart(cartOf([{ itemId: ids.soap, qty: 1, unitCents: 429 }]))).structured!.verdict).toBe("go");
  });

  it("a go cart Grok couldn't place closes with record_problem, so another store can be checked, and it never becomes unconfirmed", async () => {
    const made = await activated();
    const go = await made.desk.checkCart(cartOf([{ itemId: made.ids.towels, qty: 2, unitCents: 2400 }]));
    const blocked = await made.desk.recordProblem({ reason: "store-blocked", cartToken: go.structured!.cartToken as string });
    expect(blocked.isError).toBe(false);
    const other = await made.desk.checkCart(cartOf([{ itemId: made.ids.towels, qty: 2, unitCents: 2400 }], { store: "Other Mart" }));
    expect(other.structured!.verdict).toBe("go");
    made.clock.now = new Date(START.getTime() + 31 * MIN);
    const check = await made.desk.checkSupplies({});
    expect((check.structured!.unconfirmed as unknown[]).length).toBe(1);
    expect(check.structured!.monthSpentCents).toBe(4800);
  });

  it("a go cart still locks its items against a second cart", async () => {
    const { desk, ids } = await activated();
    await desk.checkCart(cartOf([{ itemId: ids.towels, qty: 2, unitCents: 2400 }]));
    expect((await desk.checkCart(cartOf([{ itemId: ids.towels, product: "backup", qty: 2, unitCents: 2100 }]))).structured!.verdict).toBe("refused");
  });

  it("a card-like booking number in Google events doesn't block the daily check", async () => {
    const { desk } = await activated();
    const googleEvents = { timeZone: "America/New_York", items: [{ id: "ev1", status: "confirmed", summary: "Stay", description: "Booking 4242 4242 4242 4242", start: { date: "2026-11-05" }, end: { date: "2026-11-08" } }] };
    expect((await desk.checkSupplies({ googleEvents })).isError).toBe(false);
  });
});
