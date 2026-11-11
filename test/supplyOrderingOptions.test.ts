import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hubFor, resetHubs } from "../src/hub/hub";
import { CLEANER_THERE, resetSupplyDesks, supplyDeskFor } from "../src/supply-core/desk";
import { readSupply } from "../src/supply-core/store";
import { handleSupplyTool } from "../src/supply-core/tools";
import { CARDS, type SupplyAsk } from "../src/supply-core/setupAsk";
import { museSupplyAsk } from "../src/hosted/supplyWording";

/**
 * Supply Core's ordering choices: only when something's reported low, or on a schedule too; when the
 * cleaner is asked; and the whole list saved in one confirmed call. Made-up stores and links only.
 */

const NOW = new Date("2026-11-04T15:00:00.000Z");
const PROPERTY = { name: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" };

const dirs: string[] = [];
afterEach(() => {
  resetSupplyDesks();
  resetHubs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function cleaning() {
  const root = mkdtempSync(join(tmpdir(), "supply-options-"));
  dirs.push(root);
  const hub = hubFor(root, { now: () => NOW });
  hub.saveProperty({ nickname: PROPERTY.name, address: PROPERTY.address, timeZone: PROPERTY.timeZone });
  hub.setCalendars({ calendars: [{ name: "Airbnb", url: "https://calendar.example/lane.ics" }], done: true });
  const clock = { now: NOW };
  return { root, clock, desk: supplyDeskFor(root, { now: () => clock.now }) };
}

const product = (slug: string, priceCents: number) => ({ title: `Example ${slug}`, store: "Example Mart", url: `https://shop.example/${slug}`, packSize: "1 pack", priceCents });
const towels = { name: "Paper towels", qtyPerOrder: 1, preferred: product("towels", 2400) };
const soap = { name: "Dish soap", qtyPerOrder: 1, preferred: product("soap", 429) };
const coffee = { name: "Coffee pods", qtyPerOrder: 1, preferred: product("coffee", 1299) };

type Ask = { step: string; questions: { field: string; ask: string; how?: string; options?: { value: string }[]; default?: string }[] };
const askOf = async (desk: ReturnType<typeof cleaning>["desk"]) => (await desk.state()).structured?.ask as Ask;

async function finish(desk: ReturnType<typeof cleaning>["desk"]) {
  await desk.saveItem({ done: true });
  await desk.saveSettings({ mode: "hands-off", perOrderCapCents: null, perMonthCapCents: null, checkTime: "10:00", routineCreated: true });
  const plan = readSupply(desk.root).settings.stores;
  if (plan) await desk.saveSettings({ storesReady: [plan.primary.name, ...(plan.fast ? [plan.fast.name] : [])] });
  const reply = await desk.activate({});
  expect(reply.isError, reply.text).toBe(false);
}

describe("how Supply Core orders", () => {
  it("is asked before the list: only when it's low or on a schedule too, and when the cleaner is asked", async () => {
    const { desk } = cleaning();
    const ask = await askOf(desk);
    expect(ask.step).toBe("ordering");
    expect(ask.questions.map((q) => q.field)).toEqual(["ordering", "cleanerAsk"]);
    expect(ask.questions[0]!.options!.map((o) => o.value)).toEqual(["reports", "schedule"]);
    expect(ask.questions[1]!.options!.map((o) => o.value)).toEqual(["arrival", "done"]);
    expect(ask.questions[1]!.default).toBe("arrival");
    expect((await desk.saveSettings({ ordering: "sometimes" as never })).isError).toBe(true);
    expect((await desk.saveSettings({ cleanerAsk: "never" as never })).isError).toBe(true);
    expect((await desk.saveSettings({ ordering: "reports", cleanerAsk: "arrival" })).isError).toBe(false);
    expect((await askOf(desk)).step).toBe("list");
  });

  it("only when it's low: no schedule is asked, items save without one, and nothing is due until a report", async () => {
    const { root, desk } = cleaning();
    await desk.saveSettings({ ordering: "reports" });
    await desk.saveList({ names: ["Paper towels", "Dish soap"] });
    await desk.saveStores({ primary: { name: "Example Mart", channel: "same-day" } });
    const products = await askOf(desk);
    expect(products.step).toBe("products");
    expect(products.questions[0]!.how).toContain("leave schedule out");
    expect((await desk.saveItem({ items: [towels, soap] })).isError).toBe(false);
    expect(readSupply(root).items.map((item) => item.schedule)).toEqual([{ kind: "reports" }, { kind: "reports" }]);
    await finish(desk);
    expect((await desk.checkSupplies({})).structured!.due).toEqual([]);
    const id = readSupply(root).items[0]!.id;
    await desk.reportLow({ itemIds: [id], source: "cleaner" });
    expect((await desk.checkSupplies({})).structured!.due).toEqual([expect.objectContaining({ itemId: id, why: "report" })]);
  });

  it("choosing only when it's low turns a schedule already saved into only when it's low", async () => {
    const { root, desk } = cleaning();
    await desk.saveSettings({ ordering: "schedule" });
    await desk.saveItem({ ...towels, schedule: { kind: "every", days: 21 } });
    await desk.saveSettings({ ordering: "reports" });
    expect(readSupply(root).items[0]!.schedule).toEqual({ kind: "reports" });
    expect(readSupply(root).settings.sharedSchedule).toEqual({ kind: "reports" });
    await desk.saveSettings({ ordering: "schedule" });
    expect(readSupply(root).settings.sharedSchedule).toBeUndefined();
  });

  it("a setup already under way is asked how it orders before going on", async () => {
    const { desk } = cleaning();
    await desk.saveItem({ ...towels, schedule: { kind: "every", days: 21 } });
    await desk.saveItem({ done: true });
    expect((await askOf(desk)).step).toBe("ordering");
  });

  it("on a schedule too, each item can still be only when it's low", async () => {
    const { root, desk } = cleaning();
    await desk.saveSettings({ ordering: "schedule" });
    await desk.saveList({ names: ["Paper towels", "Dish soap"] });
    await desk.saveStores({ primary: { name: "Example Mart", channel: "shipping" } });
    const schedule = await askOf(desk);
    expect(schedule.step).toBe("schedule");
    expect(schedule.questions[1]!.options!.map((o) => o.value)).toContain("reports");
    await desk.saveSettings({ sharedSchedule: null });
    expect((await desk.saveItem({ items: [{ ...towels, schedule: { kind: "reports" } }, { ...soap, schedule: { kind: "every", days: 30 } }] })).isError).toBe(false);
    expect(readSupply(root).items.map((item) => item.schedule.kind)).toEqual(["reports", "every"]);
  });

  it("Activate doesn't order an every-so-many-days item the same day", async () => {
    const { desk, clock } = cleaning();
    await desk.saveSettings({ ordering: "schedule" });
    await desk.saveItem({ ...towels, schedule: { kind: "every", days: 21 } });
    await finish(desk);
    expect((await desk.checkSupplies({})).structured!.due).toEqual([]);
    clock.now = new Date("2026-11-25T15:00:00.000Z");
    expect((await desk.checkSupplies({})).structured!.due).toEqual([expect.objectContaining({ name: "Paper towels", why: "schedule" })]);
  });
});

describe("the whole list at once", () => {
  it("with two or more items, the products step asks one confirm for the whole list, with no backup or quantity question", async () => {
    const { desk } = cleaning();
    await desk.saveSettings({ ordering: "reports" });
    await desk.saveList({ names: ["Paper towels", "Dish soap", "Coffee pods"] });
    await desk.saveStores({ primary: { name: "Example Mart", channel: "same-day" } });
    const ask = await askOf(desk);
    expect(ask.questions.map((q) => q.field)).toEqual(["items"]);
    expect(ask.questions[0]!.how).toContain("show the whole list once");
    expect(ask.questions[0]!.how).toContain("Quantity is 1");
    expect(ask.questions[0]!.how).toContain("Don't ask about backups");
    expect(ask.questions[0]!.how).toContain("product cards");
  });

  it("on Muse, the whole-list confirm shops in its own browser", async () => {
    const { desk } = cleaning();
    await desk.saveSettings({ ordering: "reports" });
    await desk.saveList({ names: ["Paper towels", "Dish soap"] });
    await desk.saveStores({ primary: { name: "Example Mart", channel: "same-day" } });
    const muse = museSupplyAsk((await desk.state()).structured?.ask as SupplyAsk);
    expect(muse.questions[0]!.how).toContain("in your browser");
    expect(muse.questions[0]!.how).not.toContain(CARDS);
  });

  it("saves every item in one call, then asks whether there's anything else", async () => {
    const { root, desk } = cleaning();
    await desk.saveSettings({ ordering: "reports" });
    await desk.saveList({ names: ["Paper towels", "Dish soap", "Coffee pods"] });
    await desk.saveStores({ primary: { name: "Example Mart", channel: "same-day" } });
    const saved = await handleSupplyTool(desk, "save_supply_item", { items: [towels, soap, coffee] });
    expect(saved?.isError, saved?.text).toBe(false);
    expect(saved?.structured?.saved).toBe(3);
    expect(readSupply(root).items.map((item) => item.name)).toEqual(["Paper towels", "Dish soap", "Coffee pods"]);
    expect(readSupply(root).draft).toEqual([]);
    expect((await askOf(desk)).questions[0]!.field).toBe("more");
  });

  it("saves nothing when one item can't be saved, and names it", async () => {
    const { root, desk } = cleaning();
    await desk.saveSettings({ ordering: "reports" });
    await desk.saveStores({ primary: { name: "Example Mart", channel: "same-day" } });
    const refused = await desk.saveItem({ items: [towels, { ...soap, preferred: { ...soap.preferred, store: "Random Shop" } }] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Dish soap");
    expect(readSupply(root).items).toEqual([]);
    expect((await desk.saveItem({ items: [towels, towels] })).isError).toBe(true);
  });

  it("after Activate, the whole list takes the host's yes", async () => {
    const { root, desk } = cleaning();
    await desk.saveSettings({ ordering: "reports" });
    await desk.saveItem(towels);
    await finish(desk);
    const asked = await desk.saveItem({ items: [soap, coffee] });
    expect(asked.structured?.question).toContain("Dish soap, Coffee pods");
    expect(readSupply(root).items).toHaveLength(1);
    const code = (asked.structured!.confirmation as { code: string }).code;
    expect((await desk.saveItem({ items: [soap, coffee], confirmation: code })).isError).toBe(false);
    expect(readSupply(root).items).toHaveLength(3);
  });
});

describe("asking the cleaner on arrival", () => {
  it("marks what the cleaner named today as cleanerThere, for a same-day order while they're there", async () => {
    const { root, desk } = cleaning();
    await desk.saveSettings({ ordering: "reports", cleanerAsk: "arrival" });
    await desk.saveStores({ primary: { name: "Example Mart", channel: "shipping" }, fast: { name: "Example Now", channel: "same-day" } });
    await desk.saveItem({ items: [towels, soap] });
    await finish(desk);
    const [a, b] = readSupply(root).items.map((item) => item.id);
    await desk.reportLow({ itemIds: [a!], source: "cleaner" });
    await desk.reportLow({ itemIds: [b!], source: "host" });
    const check = await desk.checkSupplies({});
    const due = check.structured!.due as { itemId: string; cleanerThere?: true }[];
    expect(due.find((d) => d.itemId === a)?.cleanerThere).toBe(true);
    expect(due.find((d) => d.itemId === b)?.cleanerThere).toBeUndefined();
    expect(check.structured!.cleanerThere).toBe(CLEANER_THERE);
  });

  it("asked when done, nothing is marked cleanerThere", async () => {
    const { root, desk } = cleaning();
    await desk.saveSettings({ ordering: "reports", cleanerAsk: "done" });
    await desk.saveStores({ primary: { name: "Example Mart", channel: "same-day" } });
    await desk.saveItem(towels);
    await finish(desk);
    await desk.reportLow({ itemIds: [readSupply(root).items[0]!.id], source: "cleaner" });
    const check = await desk.checkSupplies({});
    expect((check.structured!.due as { cleanerThere?: true }[])[0]!.cleanerThere).toBeUndefined();
    expect(check.structured!.cleanerThere).toBeUndefined();
  });

  it("the store question names DoorDash, and asks for a same-day store when the cleaner is asked on arrival", async () => {
    const { desk } = cleaning();
    await desk.saveSettings({ ordering: "reports", cleanerAsk: "arrival" });
    await desk.saveList({ names: ["Paper towels"] });
    const ask = await askOf(desk);
    expect(ask.step).toBe("stores");
    expect(ask.questions[0]!.how).toContain("DoorDash");
    expect(ask.questions[0]!.how).toContain("as they arrive");
    expect(ask.questions[1]!.how).toContain("DoorDash");
  });
});
