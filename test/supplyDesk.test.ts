import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { supplyDeskFor, type SupplyDeps } from "../src/supply-core/desk";
import { emptySupply, monthSpentCents, readSupply, type Order } from "../src/supply-core/store";

/** Supply Core setup on a made-up property. Made-up stores and links only; nothing reaches a store. */

const NOW = new Date("2026-11-04T15:00:00.000Z");
const PROPERTY = { name: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "supply-desk-"));
  dirs.push(dir);
  return dir;
}

function standalone(root = folder()) {
  const deps: SupplyDeps = { now: () => NOW, standalone: true };
  return { root, desk: supplyDeskFor(root, deps) };
}

function cleaning(root = folder()) {
  const deps: SupplyDeps = { now: () => NOW, standalone: false, cleaning: { property: () => PROPERTY, turnovers: async () => [] } };
  return { root, desk: supplyDeskFor(root, deps) };
}

const towels = {
  name: "Paper towels",
  qtyPerOrder: 2,
  preferred: { title: "Example paper towels, 12 rolls", store: "Example Mart", url: "https://shop.example/towels", packSize: "12 rolls", priceCents: 2400 },
  backup: { title: "Other paper towels, 8 rolls", store: "Example Mart", url: "https://shop.example/towels-b", packSize: "8 rolls", priceCents: 2100 },
  storeNote: "Cheapest per roll; arrives in 2 days.",
  schedule: { kind: "every" as const, days: 21 },
};

async function step(desk: ReturnType<typeof standalone>["desk"]): Promise<string | undefined> {
  const state = await desk.state();
  return (state.structured?.ask as { step?: string } | undefined)?.step;
}

/** A standalone desk taken through setup to Activate. */
async function activated() {
  const made = standalone();
  const { desk } = made;
  await desk.saveSettings({ property: PROPERTY });
  await desk.saveItem(towels);
  await desk.saveItem({ done: true });
  await desk.saveSettings({ mode: "hands-off" });
  await desk.saveSettings({ perOrderCapCents: null, perMonthCapCents: null });
  await desk.saveSettings({ checkTime: "10:00" });
  await desk.saveSettings({ routineCreated: true });
  const reply = await desk.activate({});
  expect(reply.isError).toBe(false);
  return made;
}

describe("setup", () => {
  it("asks property, items, mode, caps, check time, routine, review, in order, standalone", async () => {
    const { desk } = standalone();
    expect(await step(desk)).toBe("property");
    await desk.saveSettings({ property: PROPERTY });
    expect(await step(desk)).toBe("items");
    await desk.saveItem(towels);
    expect(await step(desk)).toBe("items");
    await desk.saveItem({ done: true });
    expect(await step(desk)).toBe("mode");
    await desk.saveSettings({ mode: "checkout" });
    expect(await step(desk)).toBe("caps");
    await desk.saveSettings({ perMonthCapCents: 30000 });
    expect(await step(desk)).toBe("check-time");
    await desk.saveSettings({ checkTime: "09:30" });
    expect(await step(desk)).toBe("routine");
    await desk.saveSettings({ routineCreated: true });
    expect(await step(desk)).toBe("review");
    expect((await desk.activate({})).isError).toBe(false);
    const after = await desk.state();
    expect(after.structured?.ask).toBeUndefined();
    expect(after.structured?.line).toBe("Supplies: on, 1 item. November: $0.00 of $300.00.");
  });

  it("skips property for a cleaning tenant and reads Cleaner Core's", async () => {
    const { desk } = cleaning();
    expect(await step(desk)).toBe("items");
    await desk.saveItem(towels);
    await desk.saveItem({ done: true });
    await desk.saveSettings({ mode: "hands-off", perOrderCapCents: null, perMonthCapCents: null, checkTime: "10:00", routineCreated: true });
    expect(await step(desk)).toBe("review");
    expect((await desk.activate({})).isError).toBe(false);
    expect((await desk.state()).structured?.line).toBe("Supplies: on, 1 item. November: $0.00.");
  });

  it("asks the bookings source only when an item is by bookings and Cleaner Core is off", async () => {
    const one = standalone();
    await one.desk.saveSettings({ property: PROPERTY });
    await one.desk.saveItem({ ...towels, schedule: { kind: "bookings", stays: 4 } });
    await one.desk.saveItem({ done: true });
    expect(await step(one.desk)).toBe("sources");

    const two = cleaning();
    await two.desk.saveItem({ ...towels, schedule: { kind: "bookings", stays: 4 } });
    await two.desk.saveItem({ done: true });
    expect(await step(two.desk)).toBe("mode");
  });

  it("asks 'Anything else to add?' until the host says that's all", async () => {
    const { desk } = cleaning();
    await desk.saveItem(towels);
    const ask = (await desk.state()).structured?.ask as { questions: { field: string; ask: string }[] };
    expect(ask.questions[0]).toMatchObject({ field: "more", ask: "Anything else to add?" });
  });

  it("refuses a 31st item, an http link, a 160-character storeNote, qty 0, and price 0", async () => {
    const { desk, root } = cleaning();
    for (let i = 0; i < 30; i++) expect((await desk.saveItem({ ...towels, name: `Item ${i}` })).isError).toBe(false);
    expect((await desk.saveItem({ ...towels, name: "Item 31" })).isError).toBe(true);
    expect(readSupply(root).items).toHaveLength(30);

    const fresh = cleaning().desk;
    expect((await fresh.saveItem({ ...towels, preferred: { ...towels.preferred, url: "http://shop.example/towels" } })).isError).toBe(true);
    expect((await fresh.saveItem({ ...towels, storeNote: "x".repeat(160) })).isError).toBe(true);
    expect((await fresh.saveItem({ ...towels, storeNote: "x".repeat(159) })).isError).toBe(false);
    expect((await fresh.saveItem({ ...towels, qtyPerOrder: 0 })).isError).toBe(true);
    expect((await fresh.saveItem({ ...towels, preferred: { ...towels.preferred, priceCents: 0 } })).isError).toBe(true);
    expect((await fresh.saveItem({ ...towels, schedule: { kind: "every", days: 400 } })).isError).toBe(true);
  });

  it("refuses any input holding a card number, and saves nothing", async () => {
    const { desk, root } = cleaning();
    const reply = await desk.saveItem({ ...towels, storeNote: "use 4242 4242 4242 4242" });
    expect(reply.isError).toBe(true);
    expect(readSupply(root).items).toHaveLength(0);
    expect((await desk.saveSettings({ property: { ...PROPERTY, name: "4242424242424242" } })).isError).toBe(true);
  });

  it("previewSchedule returns the next 3 dates, or the refusal", async () => {
    const { desk } = cleaning();
    const ok = await desk.previewSchedule({ schedule: { kind: "custom", rrule: "FREQ=MONTHLY;BYDAY=1MO;BYMONTH=5,6,7,8,9", said: "first Monday, May to September" } });
    expect(ok.structured?.nextDates).toEqual(["2027-05-03", "2027-06-07", "2027-07-05"]);
    const bad = await desk.previewSchedule({ schedule: { kind: "custom", rrule: "FREQ=HOURLY", said: "hourly" } });
    expect(bad.isError).toBe(true);
  });

  it("activate is refused without an item, a mode, and a check time", async () => {
    const { desk } = cleaning();
    expect((await desk.activate({})).isError).toBe(true);
    await desk.saveItem(towels);
    expect((await desk.activate({})).isError).toBe(true);
    await desk.saveSettings({ mode: "hands-off" });
    expect((await desk.activate({})).isError).toBe(true);
    await desk.saveSettings({ checkTime: "10:00" });
    expect((await desk.activate({})).isError).toBe(false);
  });

  it("refuses a check time that isn't 24-hour HH:MM", async () => {
    const { desk } = cleaning();
    expect((await desk.saveSettings({ checkTime: "10am" })).isError).toBe(true);
    expect((await desk.saveSettings({ checkTime: "24:00" })).isError).toBe(true);
  });
});

describe("changes after Activate", () => {
  it("save_supply_item takes two calls; a changed input makes the code stale", async () => {
    const { desk, root } = await activated();
    const id = readSupply(root).items[0]!.id;
    const first = await desk.saveItem({ ...towels, id, qtyPerOrder: 3 });
    expect(first.structured).toMatchObject({ question: expect.any(String), confirmation: { code: expect.any(String) } });
    expect(readSupply(root).items[0]!.qtyPerOrder).toBe(2);
    const code = (first.structured!.confirmation as { code: string }).code;
    const stale = await desk.saveItem({ ...towels, id, qtyPerOrder: 4, confirmation: code });
    expect(stale.isError).toBe(true);
    expect(readSupply(root).items[0]!.qtyPerOrder).toBe(2);

    const again = await desk.saveItem({ ...towels, id, qtyPerOrder: 3 });
    const yes = await desk.saveItem({ ...towels, id, qtyPerOrder: 3, confirmation: (again.structured!.confirmation as { code: string }).code });
    expect(yes.isError).toBe(false);
    expect(readSupply(root).items[0]!.qtyPerOrder).toBe(3);
  });

  it("remove_supply_item and settings take two calls too", async () => {
    const { desk, root } = await activated();
    const id = readSupply(root).items[0]!.id;
    const remove = await desk.removeItem({ itemId: id });
    expect(readSupply(root).items).toHaveLength(1);
    await desk.removeItem({ itemId: id, confirmation: (remove.structured!.confirmation as { code: string }).code });
    expect(readSupply(root).items).toHaveLength(0);

    const settings = await desk.saveSettings({ mode: "checkout" });
    expect(readSupply(root).settings.mode).toBe("hands-off");
    await desk.saveSettings({ mode: "checkout", confirmation: (settings.structured!.confirmation as { code: string }).code });
    expect(readSupply(root).settings.mode).toBe("checkout");
  });
});

describe("monthSpentCents", () => {
  const order = (over: Partial<Order>): Order => ({
    id: "ord_1",
    at: NOW.toISOString(),
    store: "Example Mart",
    items: [],
    totalCents: 0,
    chargedCents: 0,
    source: "schedule",
    approvedBy: "rules",
    status: "placed",
    ...over,
  });

  it("counts an order at 23:30 Oct 31 New York in October", () => {
    const file = { ...emptySupply(), orders: [order({ at: "2026-11-01T03:30:00.000Z", chargedCents: 4000 })] };
    expect(monthSpentCents(file, "America/New_York", new Date("2026-11-04T15:00:00Z"))).toBe(0);
    expect(monthSpentCents(file, "America/New_York", new Date("2026-10-31T20:00:00Z"))).toBe(4000);
  });
});
