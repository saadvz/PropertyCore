import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hubFor, resetHubs } from "../src/hub/hub";
import { resetSupplyDesks, supplyDeskFor, type SupplyDeps } from "../src/supply-core/desk";
import { emptySupply, monthSpentCents, readSupply, type Order } from "../src/supply-core/store";

/** Supply Core setup on a made-up property. Made-up stores and links only; nothing reaches a store. */

const NOW = new Date("2026-11-04T15:00:00.000Z");
const PROPERTY = { name: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" };

const dirs: string[] = [];
afterEach(() => {
  resetSupplyDesks();
  resetHubs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "supply-desk-"));
  dirs.push(dir);
  return dir;
}

function standalone(root = folder()) {
  const deps: SupplyDeps = { now: () => NOW };
  return { root, desk: supplyDeskFor(root, deps) };
}

/** A property Cleaner Core runs on: its setup already saved the details and a calendar in the hub. */
function cleaning(root = folder()) {
  const hub = hubFor(root, { now: () => NOW });
  hub.saveProperty({ nickname: PROPERTY.name, address: PROPERTY.address, timeZone: PROPERTY.timeZone });
  hub.setCalendars({ calendars: [{ name: "Airbnb", url: "https://calendar.example/lane.ics" }], done: true });
  const deps: SupplyDeps = { now: () => NOW, cleaningOn: () => true };
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
    expect(await step(desk)).toBe("list");
    await desk.saveList({ names: ["Paper towels"] });
    expect(await step(desk)).toBe("stores");
    await desk.saveStores({ primary: { name: "Example Mart", channel: "shipping" } });
    expect(await step(desk)).toBe("products");
    await desk.saveItem(towels);
    expect(await step(desk)).toBe("products");
    await desk.saveItem({ done: true });
    expect(await step(desk)).toBe("mode");
    await desk.saveSettings({ mode: "checkout" });
    expect(await step(desk)).toBe("caps");
    await desk.saveSettings({ perMonthCapCents: 30000 });
    expect(await step(desk)).toBe("check-time");
    await desk.saveSettings({ checkTime: "09:30" });
    expect(await step(desk)).toBe("routine");
    await desk.saveSettings({ routineCreated: true });
    expect(await step(desk)).toBe("accounts");
    await desk.saveSettings({ storesReady: ["Example Mart"] });
    expect(await step(desk)).toBe("review");
    expect((await desk.activate({})).isError).toBe(false);
    const after = await desk.state();
    expect(after.structured?.ask).toBeUndefined();
    expect(after.structured?.line).toBe("Supplies: on, 1 item. November: $0.00 of $300.00.");
  });

  it("skips property for a cleaning tenant and reads Cleaner Core's", async () => {
    const { desk } = cleaning();
    expect(await step(desk)).toBe("list");
    await desk.saveItem(towels);
    await desk.saveItem({ done: true });
    await desk.saveSettings({ mode: "hands-off", perOrderCapCents: null, perMonthCapCents: null, checkTime: "10:00", routineCreated: true });
    expect(await step(desk)).toBe("review");
    expect((await desk.activate({})).isError).toBe(false);
    expect((await desk.state()).structured?.line).toBe("Supplies: on, 1 item. November: $0.00.");
  });

  it("asks the bookings source only when an item is by bookings and the property has no calendars yet", async () => {
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
    await desk.saveList({ names: ["Paper towels"] });
    await desk.saveStores({ primary: { name: "Example Mart", channel: "shipping" } });
    await desk.saveItem(towels);
    const ask = (await desk.state()).structured?.ask as { step: string; questions: { field: string; ask: string }[] };
    expect(ask.step).toBe("products");
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

describe("approvals across a restart", () => {
  it("a change approved after a restart saves once; an expired code is refused", async () => {
    const { desk, root } = await activated();
    const id = readSupply(root).items[0]!.id;
    const ask = await desk.saveItem({ ...towels, id, qtyPerOrder: 3 });
    const code = (ask.structured!.confirmation as { code: string }).code;
    resetSupplyDesks();
    const restarted = supplyDeskFor(root, { now: () => NOW });
    expect(restarted).not.toBe(desk);
    expect((await restarted.saveItem({ ...towels, id, qtyPerOrder: 3, confirmation: code })).isError).toBe(false);
    expect(readSupply(root).items[0]!.qtyPerOrder).toBe(3);
    resetSupplyDesks();
    expect((await supplyDeskFor(root, { now: () => NOW }).saveItem({ ...towels, id, qtyPerOrder: 3, confirmation: code })).isError).toBe(true);

    const late = await supplyDeskFor(root, { now: () => NOW }).saveItem({ ...towels, id, qtyPerOrder: 5 });
    resetSupplyDesks();
    const later = new Date(NOW.getTime() + 10 * 60_000);
    const expired = await supplyDeskFor(root, { now: () => later }).saveItem({ ...towels, id, qtyPerOrder: 5, confirmation: (late.structured!.confirmation as { code: string }).code });
    expect(expired.isError).toBe(true);
    expect(readSupply(root).items[0]!.qtyPerOrder).toBe(3);
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

describe("address first, the whole list, then where to buy", () => {
  it("asks the delivery address first; the name is optional and defaults to the street address", async () => {
    const { desk, root } = standalone();
    const ask = (await desk.state()).structured?.ask as { questions: { field: string; required: boolean }[] };
    expect(ask.questions.map((q) => q.field)).toEqual(["property.address", "property.timeZone", "property.name"]);
    expect(ask.questions.find((q) => q.field === "property.name")?.required).toBe(false);
    expect((await desk.saveSettings({ property: { address: PROPERTY.address, timeZone: PROPERTY.timeZone } })).isError).toBe(false);
    // The property is the hub's; without a name it reads as the street address.
    expect(hubFor(root, { now: () => NOW }).property()).toEqual({ address: PROPERTY.address, timeZone: PROPERTY.timeZone });
    expect((await desk.state()).text).not.toContain("delivery address");
  });

  it("asks for the whole list at once, up to 30, and saves them as a draft", async () => {
    const { desk, root } = cleaning();
    const ask = (await desk.state()).structured?.ask as { step: string; questions: { field: string; ask: string }[] };
    expect(ask.step).toBe("list");
    expect(ask.questions[0]!.ask).toContain("List everything");
    expect((await desk.saveList({ names: ["Paper towels", "Dish soap", "Coffee pods"] })).isError).toBe(false);
    expect(readSupply(root).draft).toEqual(["Paper towels", "Dish soap", "Coffee pods"]);
    expect((await desk.saveList({ names: Array.from({ length: 31 }, (_, i) => `Item ${i}`) })).isError).toBe(true);
    expect((await desk.saveList({ names: [] })).isError).toBe(true);
  });

  it("asks where to buy with the whole list in hand, before any product", async () => {
    const { desk } = cleaning();
    await desk.saveList({ names: ["Paper towels", "Dish soap"] });
    const ask = (await desk.state()).structured?.ask as { step: string; questions: { field: string; how?: string }[] };
    expect(ask.step).toBe("stores");
    expect((await desk.state()).structured?.draft).toEqual(["Paper towels", "Dish soap"]);
    expect(ask.questions.map((q) => q.field)).toEqual(["primary", "fast"]);
    expect(ask.questions[0]!.how).toContain("leave it at the door");
  });

  it("saves a main store and an optional same-day store, and refuses a store with no delivery channel", async () => {
    const { desk, root } = cleaning();
    await desk.saveList({ names: ["Paper towels"] });
    expect((await desk.saveStores({ primary: { name: "Example Mart", channel: "pickup" as never } })).isError).toBe(true);
    expect((await desk.saveStores({ primary: { name: "Example Mart", channel: "shipping" }, fast: { name: "Example Now", channel: "same-day" } })).isError).toBe(false);
    expect(readSupply(root).settings.stores).toEqual({ primary: { name: "Example Mart", channel: "shipping" }, fast: { name: "Example Now", channel: "same-day" } });
  });

  it("refuses a product from a store outside the plan", async () => {
    const { desk } = cleaning();
    await desk.saveList({ names: ["Paper towels"] });
    await desk.saveStores({ primary: { name: "Example Mart", channel: "shipping" } });
    const other = await desk.saveItem({ ...towels, preferred: { ...towels.preferred, store: "Random Shop" } });
    expect(other.isError).toBe(true);
    expect(other.text).toContain("Example Mart");
    expect((await desk.saveItem({ ...towels, backup: { ...towels.backup, store: "Random Shop" } })).isError).toBe(true);
    expect((await desk.saveItem({ ...towels, preferred: { ...towels.preferred, store: "example mart" }, backup: null })).isError).toBe(false);
  });

  it("asks one schedule for everything before any product, and every item uses it", async () => {
    const { desk, root } = cleaning();
    await desk.saveList({ names: ["Paper towels", "Dish soap"] });
    await desk.saveStores({ primary: { name: "Example Mart", channel: "shipping" } });
    const ask = (await desk.state()).structured?.ask as { step: string; questions: { field: string; when?: string }[] };
    expect(ask.step).toBe("schedule");
    expect(ask.questions.map((q) => q.field)).toEqual(["sameSchedule", "sharedSchedule"]);
    expect((await desk.saveSettings({ sharedSchedule: { kind: "bookings", stays: 1 } })).isError).toBe(false);
    const products = (await desk.state()).structured?.ask as { step: string; questions: { field: string }[] };
    expect(products.step).toBe("products");
    expect(products.questions.map((q) => q.field)).not.toContain("schedule");
    const { storeNote: _note, schedule: _schedule, ...bare } = towels;
    expect((await desk.saveItem(bare)).isError).toBe(false);
    expect(readSupply(root).items[0]!.schedule).toEqual({ kind: "bookings", stays: 1 });
    expect(readSupply(root).draft).toEqual(["Dish soap"]);
    expect((await desk.state()).structured?.next).toContain("Dish soap");
  });

  it("each item its own: the products step asks the schedule per item", async () => {
    const { desk } = cleaning();
    await desk.saveList({ names: ["Paper towels", "Dish soap"] });
    await desk.saveStores({ primary: { name: "Example Mart", channel: "shipping" } });
    await desk.saveSettings({ sharedSchedule: null });
    const products = (await desk.state()).structured?.ask as { step: string; questions: { field: string }[] };
    expect(products.step).toBe("products");
    expect(products.questions.map((q) => q.field)).toContain("schedule");
    const { schedule: _schedule, ...bare } = towels;
    expect((await desk.saveItem(bare)).isError).toBe(true);
  });

  it("a one-item list skips the schedule question", async () => {
    const { desk } = cleaning();
    await desk.saveList({ names: ["Paper towels"] });
    await desk.saveStores({ primary: { name: "Example Mart", channel: "shipping" } });
    expect(await step(desk)).toBe("products");
  });

  it("tells Grok to show product cards and a choice card to tap", async () => {
    const { desk } = cleaning();
    await desk.saveList({ names: ["Paper towels"] });
    await desk.saveStores({ primary: { name: "Example Mart", channel: "shipping" } });
    const ask = (await desk.state()).structured?.ask as { questions: { field: string; how?: string }[] };
    for (const field of ["preferred", "backup"]) {
      const how = ask.questions.find((q) => q.field === field)?.how ?? "";
      expect(how, field).toContain("product cards");
      expect(how, field).toContain("choice card");
    }
  });

  it("won't activate until every store in the plan is checked ready", async () => {
    const { desk } = cleaning();
    await desk.saveList({ names: ["Paper towels"] });
    await desk.saveStores({ primary: { name: "Example Mart", channel: "shipping" }, fast: { name: "Example Now", channel: "same-day" } });
    await desk.saveItem(towels);
    await desk.saveItem({ done: true });
    await desk.saveSettings({ mode: "checkout", perOrderCapCents: null, perMonthCapCents: null, checkTime: "10:00", routineCreated: true });
    const ask = (await desk.state()).structured?.ask as { step: string; questions: { field: string; ask: string; how?: string }[] };
    expect(ask.step).toBe("accounts");
    expect(ask.questions[0]!.how).toContain("payment method");
    expect(ask.questions.map((q) => q.ask).join(" ")).toContain("Example Now");
    const refused = await desk.activate({});
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Example Mart");
    await desk.saveSettings({ storesReady: ["example mart"] });
    expect((await desk.activate({})).isError).toBe(true);
    expect((await desk.saveSettings({ storesReady: ["Random Shop"] })).isError).toBe(true);
    await desk.saveSettings({ storesReady: ["Example Now"] });
    expect((await desk.activate({})).isError).toBe(false);
  });

  it("check_supplies carries the store plan so Grok can use the same-day store for a tight deadline", async () => {
    const made = await activated();
    const plan = { primary: { name: "Example Mart", channel: "shipping" as const }, fast: { name: "Example Now", channel: "same-day" as const } };
    const ask = await made.desk.saveStores(plan);
    await made.desk.saveStores({ ...plan, confirmation: (ask.structured!.confirmation as { code: string }).code });
    const check = await made.desk.checkSupplies({});
    expect(check.structured!.stores).toEqual(plan);
  });
});
