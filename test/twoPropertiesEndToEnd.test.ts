import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Property } from "../src/cleaner-core/hosted/properties";
import { SCRATCH_TENANTS } from "../src/cleaner-core/tenants";
import { readSupply } from "../src/supply-core/store";
import { closeHostedApps } from "./cleanerOauthHarness";
import { filesUnder } from "./files";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";
import { CALENDAR_URL, FROZEN } from "./wiringProof";

/**
 * The issue's done-when (saadvz/PropertyCore#161): one account runs Cleaner Core and Supply Core on two
 * properties at once, on its one line, set up through the Grok chat with the property argument. Each
 * property has its own cleaner; the landlord is the host on both. Only 555 numbers; the door codes
 * are the made-up Scratch pins.
 */

const [LANE, COURT] = SCRATCH_TENANTS as [(typeof SCRATCH_TENANTS)[number], (typeof SCRATCH_TENANTS)[number]];
const LINE = "+15555550150";
const LANDLORD = LANE.ownerPhone;
const ZONE = "America/New_York";
const SLOW = 180_000;
const towels = {
  name: "Paper towels",
  qtyPerOrder: 2,
  preferred: { title: "Example towels", store: "Example Mart", url: "https://shop.example/towels", packSize: "12 rolls", priceCents: 2400 },
  storeNote: "Cheapest per roll.",
  schedule: { kind: "every", days: 21 },
};

let m: MultiTenantApp;
let token: string;
let accountId: string;
let lane: Property;
let court: Property;
let pinSends: { to: string; body: string }[];
let orderLine: string;

const tool = async (name: string, args: Record<string, unknown>) => {
  const reply = await m.toolAt("/mcp", token, name, args);
  expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
  return reply;
};

/** Cleaner Core for one property, through the tools: its cleaner, calendar, and door code upload link. */
async function cleaning(property: Property, scratch: typeof LANE) {
  const p = { property: property.id };
  await tool("set_flows", { ...p, cleaning: true });
  await tool("get_state", { ...p, choice: "cleaners" });
  await tool("save_property", { ...p, business: "Scratch", address: scratch.property.address, timeZone: ZONE });
  await tool("save_people", { ...p, host: LANDLORD, cleaner: scratch.cleanerPhone });
  await tool("save_calendar_link", { ...p, url: CALENDAR_URL });
  const link = await tool("save_door_code", p);
  const path = new URL(String(link.structured?.uploadUrl)).pathname;
  expect(path.startsWith(`/t/${accountId}/p/${property.id}/door-code/`)).toBe(true);
  const upload = await m.app.http(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: scratch.pin }) });
  expect(upload.status).toBe(200);
  await tool("set_up_texting", p);
  await tool("run_checks", p);
  await tool("confirm_times", { ...p, checkout: "10:30", checkIn: "15:00" });
}

beforeAll(async () => {
  m = await multiTenantApp({ now: () => new Date(FROZEN), env: { SUPPLY_CORE: "1" } });
  accountId = m.registry.create({ label: "Scratch Homes", twilioNumber: LINE }).tenant.id;
  token = await m.joinAt(accountId, "grok", "/mcp");
  const id = (reply: { structured?: Record<string, unknown> }) => (reply.structured?.property as { id: string }).id;
  const laneId = id(await tool("add_property", { label: "Scratch Lane" }));
  const courtId = id(await tool("add_property", { label: "Scratch Court" }));
  const find = (pid: string) => m.registry.get(accountId)!.properties.find((p) => p.id === pid)!;
  await cleaning(find(laneId), LANE);
  await cleaning(find(courtId), COURT);
  lane = find(laneId);
  court = find(courtId);

  // Each cleaner takes their own turnover by text, on the one line.
  for (const [scratch, n] of [[LANE, 1], [COURT, 2]] as const) {
    await m.text(LINE, scratch.cleanerPhone, "YES", `SM-yes-${n}-a`);
    await m.text(LINE, scratch.cleanerPhone, "YES", `SM-yes-${n}-b`);
  }
  // The landlord says the guests left, through the agent, one property at a time.
  for (const property of [lane, court]) await tool("mark_guests_left", { property: property.id, confirmed: true });
  pinSends = m.sms.sent.filter((s) => s.body.includes(LANE.pin) || s.body.includes(COURT.pin));
  for (const [scratch, n] of [[LANE, 1], [COURT, 2]] as const) await m.text(LINE, scratch.cleanerPhone, "DONE", `SM-done-${n}`);

  // Supply Core on Lane, beside its Cleaner Core, to one order.
  await tool("set_flows", { property: lane.id, supplies: true });
  await tool("save_supply_item", { property: lane.id, ...towels });
  await tool("save_supply_item", { property: lane.id, done: true });
  await tool("save_supply_settings", { propertyId: lane.id, mode: "hands-off", perOrderCapCents: null, perMonthCapCents: null, checkTime: "10:00", routineCreated: true });
  await tool("activate_supplies", { property: lane.id });
  const itemId = readSupply(m.cleaningRoot(accountId)).items[0]!.id;
  // Activate doesn't order the list by itself: the host says towels are low.
  await tool("report_low", { property: lane.id, itemIds: [itemId], source: "host" });
  const due = await tool("check_supplies", { property: lane.id });
  const deadline = (due.structured?.due as { deadline: string }[])[0]!.deadline;
  const go = await tool("check_cart", { property: lane.id, store: "Example Mart", items: [{ itemId, product: "preferred", qty: 2, unitCents: 2400 }], shippingCents: 0, taxCents: 0, totalCents: 4800, deliveryBy: deadline });
  expect(go.structured?.verdict).toBe("go");
  const recorded = await tool("record_order", { property: lane.id, cartToken: go.structured?.cartToken, orderNumber: "SCRATCH-1", chargedCents: 4800 });
  orderLine = String(recorded.structured?.line);
}, SLOW);

afterAll(() => {
  m?.close();
  closeHostedApps();
});

describe("one account runs Cleaner Core and Supply Core on two properties at once", () => {
  it("each door code goes once, to its own property's cleaner, after the landlord's word through the agent", () => {
    expect(pinSends.filter((s) => s.body.includes(LANE.pin)).map((s) => s.to)).toEqual([LANE.cleanerPhone]);
    expect(pinSends.filter((s) => s.body.includes(COURT.pin)).map((s) => s.to)).toEqual([COURT.cleanerPhone]);
  });

  it("each cleaner gets only their own property's texts", () => {
    const to = (phone: string) => m.sms.sent.filter((s) => s.to === phone).map((s) => s.body);
    expect(to(LANE.cleanerPhone).length).toBeGreaterThan(0);
    expect(to(COURT.cleanerPhone).length).toBeGreaterThan(0);
    for (const body of to(LANE.cleanerPhone)) {
      expect(body).not.toContain(COURT.property.address);
      expect(body).not.toContain("Scratch Court");
      expect(body).not.toContain(COURT.pin);
    }
    for (const body of to(COURT.cleanerPhone)) {
      expect(body).not.toContain(LANE.property.address);
      expect(body).not.toContain("Scratch Lane");
      expect(body).not.toContain(LANE.pin);
    }
  });

  it("every text to the landlord starts with its property's label", () => {
    const toLandlord = m.sms.sent.filter((s) => s.to === LANDLORD).map((s) => s.body);
    expect(toLandlord.length).toBeGreaterThan(0);
    for (const body of toLandlord) expect(body.startsWith("Scratch Lane: ") || body.startsWith("Scratch Court: "), body).toBe(true);
  });

  it("both cleanings are marked done, each on its own property", async () => {
    for (const property of [lane, court]) {
      const check = await m.toolAt("/mcp", token, "check_now", { property: property.id });
      expect(JSON.stringify(check.structured), property.label).toContain("completed");
    }
  });

  it("Supply Core on Lane placed its order, and Court has no supply list", () => {
    expect(orderLine).toContain("Ordered from Example Mart: Paper towels ×2.");
    expect(readSupply(m.cleaningRoot(accountId)).orders).toHaveLength(1);
    expect(m.registry.get(accountId)!.properties.find((p) => p.id === court.id)!.flows.supplies.on).toBe(false);
  });

  it("neither door code is in any saved file", () => {
    for (const file of filesUnder(m.app.root)) {
      const text = readFileSync(file, "utf8").replace(/[A-Za-z0-9+/]{16,}={0,2}/g, " ").replace(/[0-9a-f-]{16,}/gi, " ").replace(/\d{10,}/g, " ");
      expect(text.includes(`"${LANE.pin}"`) || text.includes(`"${COURT.pin}"`), file).toBe(false);
    }
  });
});
