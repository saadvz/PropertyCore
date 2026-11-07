import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setCalendarFetch } from "../src/hub/calendarFetch";
import { hubFor, resetHubs } from "../src/hub/hub";
import { resetSupplyDesks, supplyDeskFor, type SupplyDesk } from "../src/supply-core/desk";
import { SUPPLY_TOOLS } from "../src/supply-core/tools";

/** Supply Core reads the property and its booking calendars from the property hub. Made-up links only. */

const NOW = new Date("2026-11-10T15:00:00.000Z");
const FEED_URL = "https://calendar.example/lane.ics";
const BASE = "https://supply.example/t/tnt_abcdefghij/p/prp_abcdefghij";
const PLACE = { nickname: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York", checkoutTime: "10:00", checkInTime: "16:00" };
const roots: string[] = [];

afterEach(() => {
  resetSupplyDesks();
  resetHubs();
  setCalendarFetch(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "hub-supply-"));
  roots.push(root);
  return root;
}

/** A feed with one stay checking out on the given day. */
function feed(checkout: string): string {
  const day = checkout.replace(/-/g, "");
  return ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:stay-1", "DTSTART;VALUE=DATE:20261101", `DTEND;VALUE=DATE:${day}`, "SUMMARY:Guest", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}

const towels = {
  name: "Paper towels",
  qtyPerOrder: 2,
  preferred: { title: "Example towels", store: "Example Mart", url: "https://shop.example/towels", packSize: "12 rolls", priceCents: 2400 },
  storeNote: "Cheapest per roll.",
  schedule: { kind: "bookings" as const, stays: 1 },
};

/** A property Cleaner Core already set up: details and one calendar in the hub. */
function cleaningProperty(root = folder()) {
  const hub = hubFor(root, { now: () => NOW });
  hub.saveProperty(PLACE);
  hub.setCalendars({ calendars: [{ name: "Airbnb", url: FEED_URL }], done: true });
  const desk = supplyDeskFor(root, { now: () => NOW, cleaningOn: () => true, uploadBase: () => BASE });
  return { root, hub, desk };
}

async function step(desk: SupplyDesk): Promise<string | undefined> {
  return ((await desk.state()).structured?.ask as { step?: string } | undefined)?.step;
}

async function activate(desk: SupplyDesk): Promise<void> {
  await desk.saveItem(towels);
  await desk.saveItem({ done: true });
  await desk.saveSettings({ mode: "hands-off", perOrderCapCents: null, perMonthCapCents: null, checkTime: "10:00", routineCreated: true });
  const reply = await desk.activate({});
  expect(reply.isError, reply.text).toBe(false);
}

describe("Supply Core on the property hub", () => {
  it("setup skips the property and calendar steps Cleaner Core already finished", async () => {
    const { desk } = cleaningProperty();
    expect(await step(desk)).toBe("list");
    await desk.saveItem(towels);
    await desk.saveItem({ done: true });
    expect(await step(desk)).not.toBe("sources");
  });

  it("with cleaning on, checkouts come from the calendars", async () => {
    setCalendarFetch(async (url) => ({ status: url === FEED_URL ? 200 : 404, url, async text() { return feed("2026-11-09"); } }));
    const { desk, hub } = cleaningProperty();
    await activate(desk);
    const checked = await desk.checkSupplies({});
    expect(checked.isError, checked.text).toBe(false);
    expect(hub.checkouts()?.dates).toEqual(["2026-11-09"]);
  });

  it("a stay on the calendar counts even when no cleaning reads it", async () => {
    // Cleaner Core may have called the cleaning off; Supply Core never asks it. Only the calendar counts.
    let now = new Date("2026-11-08T15:00:00.000Z");
    setCalendarFetch(async (url) => ({ status: url === FEED_URL ? 200 : 404, url, async text() { return feed("2026-11-09"); } }));
    const root = folder();
    const hub = hubFor(root, { now: () => now });
    hub.saveProperty(PLACE);
    hub.setCalendars({ calendars: [{ name: "Airbnb", url: FEED_URL }], done: true });
    const desk = supplyDeskFor(root, { now: () => now, cleaningOn: () => true, uploadBase: () => BASE });
    await activate(desk);
    now = new Date("2026-11-10T15:00:00.000Z");
    const checked = await desk.checkSupplies({});
    expect(checked.isError, checked.text).toBe(false);
    expect((checked.structured?.due as { name: string }[]).map((item) => item.name)).toEqual(["Paper towels"]);
  });

  it("save_supply_sources saves to the shared calendars when Cleaner Core is on", async () => {
    const { desk, hub } = cleaningProperty();
    const issued = await desk.saveSources({ uploadLink: { name: "Vrbo" } });
    expect(issued.isError, issued.text).toBe(false);
    const url = String(issued.structured?.uploadUrl);
    expect(url.startsWith(`${BASE}/calendar-link/`)).toBe(true);
    const saved = await hub.uploadCalendarLink(url.slice(url.lastIndexOf("/") + 1), { url: "https://calendar.example/vrbo.ics" });
    expect(saved.status).toBe(200);
    expect(hub.calendars().map((c) => c.name)).toEqual(["Airbnb", "Vrbo"]);
  });

  it("save_supply_settings saves the property to the hub when Cleaner Core is on", async () => {
    const { desk, hub } = cleaningProperty();
    const saved = await desk.saveSettings({ property: { address: "8 Scratch Court, Teaneck, NJ 07666", timeZone: "America/New_York" } });
    expect(saved.isError, saved.text).toBe(false);
    expect(hub.property().address).toBe("8 Scratch Court, Teaneck, NJ 07666");
  });

  it("get_supply_state carries the set-aside line", async () => {
    const root = folder();
    const hub = hubFor(root, { now: () => NOW });
    hub.saveProperty(PLACE);
    const desk = supplyDeskFor(root, { now: () => NOW });
    expect((await desk.state()).structured?.setAside).toBeUndefined();
    resetHubs();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, "hub.json"), JSON.stringify({ schemaVersion: 1, property: PLACE, calendars: [], calendarsSetAside: [{ name: "Vrbo", url: "https://calendar.example/vrbo.ics" }] }));
    resetSupplyDesks();
    const again = supplyDeskFor(root, { now: () => NOW });
    const state = await again.state();
    expect(state.structured?.setAside).toBe("Supply Core had its own calendars (Vrbo) that aren't in this property's list. Ask the host whether to add them.");
    expect(JSON.stringify(state)).not.toContain("vrbo.ics");
  });

  it("save_supply_sources says it saves the property's shared calendars", () => {
    const tool = SUPPLY_TOOLS.find((t) => t.name === "save_supply_sources")!;
    expect(tool.description).not.toContain("Standalone");
    expect(tool.description).toContain("shared with Cleaner Core");
  });

  it("with Google saved and no events passed, check_supplies asks for the events", async () => {
    const root = folder();
    const hub = hubFor(root, { now: () => NOW });
    hub.saveProperty(PLACE);
    hub.setCalendars({ google: true, done: true });
    const desk = supplyDeskFor(root, { now: () => NOW, cleaningOn: () => true, uploadBase: () => BASE });
    await activate(desk);
    const checked = await desk.checkSupplies({});
    expect(checked.structured?.sourcesFailed).toBe(true);
    expect(checked.structured?.next).toBe("Google Calendar is saved for this property: read its events and call check_supplies again with them as googleEvents. Until then, by-bookings items wait.");
  });
});
