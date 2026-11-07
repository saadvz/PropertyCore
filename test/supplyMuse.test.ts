import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { museAsk, SUPPLIES_AGENTS_ONLY } from "../src/cleaner-core/assistant";
import { SUPPLIES_STEP } from "../src/cleaner-core/setupAsk";
import { MUSE_SUPPLY_UPLOAD_NEXT, supplyReplyFor } from "../src/hosted/supplyWording";
import { supplyDeskFor } from "../src/supply-core/desk";
import { CARDS } from "../src/supply-core/setupAsk";
import { readSupply } from "../src/supply-core/store";
import { closeHostedApps } from "./cleanerOauthHarness";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/**
 * Supply Core for a Muse connection on the shared service: offered as on Grok, in Muse's own words
 * (its browser, the host's private page, its recurring task), through the same gates. Only 555
 * numbers, made-up stores and links; nothing reaches a store.
 */

const LANE = "+15555550150";
const SLOW = { timeout: 90_000 };
const PATH = "/mcp";
const PROPERTY = { name: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", timeZone: "America/New_York" };
const towels = {
  name: "Paper towels",
  qtyPerOrder: 2,
  preferred: { title: "Example towels", store: "Example Mart", url: "https://shop.example/towels", packSize: "12 rolls", priceCents: 2400 },
  storeNote: "Cheapest per roll.",
  schedule: { kind: "every", days: 21 },
};

/** Words that only fit Grok: its Vault, its secure card, and posting a value from its own computer. */
const GROK_ONLY_WORDS = [/Vault/, /POST JSON/, /secure card/, /cloud computer/];

let open: MultiTenantApp | undefined;
const dirs: string[] = [];
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function museAccount() {
  open = await multiTenantApp({ env: { SUPPLY_CORE: "1" } });
  const m = open;
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
  const lane = m.registry.addProperty(tenant.id, "12 Scratch Lane");
  m.registry.setFlow(tenant.id, lane.id, "cleaning", true);
  const muse = await m.joinAt(tenant.id, "muse", PATH);
  return { m, tenant, lane, muse };
}

const stepOf = (reply: { structured?: Record<string, unknown> }) => (reply.structured?.ask as { step: string } | undefined)?.step;
const howsOf = (reply: { structured?: Record<string, unknown> }) => ((reply.structured?.ask as { questions: { how?: string }[] }).questions ?? []).map((q) => q.how ?? "").join(" ");

describe("Supply Core on Muse", () => {
  it("set_flows turns it on for a Muse chat, and Muse sees the tools and the setup question", SLOW, async () => {
    const { m, tenant, lane, muse } = await museAccount();
    expect(await m.toolNames(PATH, muse)).toContain("choose_supplies");
    const on = await m.toolAt(PATH, muse, "set_flows", { property: lane.id, supplies: true });
    expect(on.isError).toBe(false);
    expect(m.registry.get(tenant.id)?.properties[0]?.flows.supplies.on).toBe(true);
    const names = await m.toolNames(PATH, muse);
    for (const name of ["get_supply_state", "save_supply_item", "check_cart", "record_order", "choose_supplies"]) expect(names).toContain(name);
  });

  it("lists Supply Core's tools in Muse's words: no Vault, no secure card, nothing to post", SLOW, async () => {
    const { m, lane, muse } = await museAccount();
    await m.toolAt(PATH, muse, "set_flows", { property: lane.id, supplies: true });
    const listed = await m.rpcAt(PATH, muse, "tools/list");
    const tools = (listed.json.result?.tools ?? []) as { name: string; description: string }[];
    const supply = tools.filter((tool) => ["save_supply_settings", "save_supply_item", "save_supply_sources", "check_cart", "record_order"].includes(tool.name));
    expect(supply).toHaveLength(5);
    for (const tool of supply) for (const word of GROK_ONLY_WORDS) expect(tool.description, tool.name).not.toMatch(word);
    expect(supply.find((tool) => tool.name === "record_order")!.description).toContain("host-browser");
    expect(supply.find((tool) => tool.name === "check_cart")!.description).toContain("each store keeps its own saved payment method");
  });

  it("walks setup in Muse's words: its browser for products and stores, its own recurring task", SLOW, async () => {
    const { m, lane, muse } = await museAccount();
    await m.toolAt(PATH, muse, "set_flows", { property: lane.id, supplies: true });
    await m.toolAt(PATH, muse, "save_supply_settings", { property: PROPERTY });
    await m.toolAt(PATH, muse, "save_supply_list", { names: ["Paper towels"] });
    await m.toolAt(PATH, muse, "save_supply_stores", { primary: { name: "Example Mart", channel: "shipping" }, fast: null });
    const products = await m.toolAt(PATH, muse, "get_supply_state");
    expect(stepOf(products)).toBe("products");
    expect(howsOf(products)).toContain("in your browser");
    expect(howsOf(products)).not.toContain(CARDS);
    await m.toolAt(PATH, muse, "save_supply_item", towels);
    await m.toolAt(PATH, muse, "save_supply_item", { done: true });
    await m.toolAt(PATH, muse, "save_supply_settings", { mode: "checkout", perOrderCapCents: null, perMonthCapCents: null, checkTime: "10:00" });
    const routine = await m.toolAt(PATH, muse, "get_supply_state");
    expect(stepOf(routine)).toBe("routine");
    expect(howsOf(routine)).toContain("Muse recurring task named Supply Core");
    expect(howsOf(routine)).toContain("references/supply-core-task.md");
    await m.toolAt(PATH, muse, "save_supply_settings", { routineCreated: true });
    const accounts = await m.toolAt(PATH, muse, "get_supply_state");
    expect(stepOf(accounts)).toBe("accounts");
    expect(howsOf(accounts)).toContain("hand the browser to the host so they sign in themselves");
    expect(howsOf(accounts)).toContain('storesReady: ["Example Mart"]');
    for (const reply of [products, routine, accounts]) for (const word of GROK_ONLY_WORDS) expect(howsOf(reply)).not.toMatch(word);
  });

  it("leaves Grok's words exactly as they were", SLOW, async () => {
    const { m, tenant, lane } = await museAccount();
    const grok = await m.joinAt(tenant.id, "grok", PATH);
    await m.toolAt(PATH, grok, "set_flows", { property: lane.id, supplies: true });
    await m.toolAt(PATH, grok, "save_supply_settings", { property: PROPERTY });
    await m.toolAt(PATH, grok, "save_supply_list", { names: ["Paper towels"] });
    await m.toolAt(PATH, grok, "save_supply_stores", { primary: { name: "Example Mart", channel: "shipping" }, fast: null });
    expect(howsOf(await m.toolAt(PATH, grok, "get_supply_state"))).toContain(CARDS);
    const listed = await m.rpcAt(PATH, grok, "tools/list");
    const sources = ((listed.json.result?.tools ?? []) as { name: string; description: string }[]).find((tool) => tool.name === "save_supply_sources")!;
    expect(sources.description).toContain("POST JSON");
  });

  it("still refuses a plain chat, and Cleaner Core goes on there", SLOW, async () => {
    const { m, tenant, lane } = await museAccount();
    const claude = await m.joinAt(tenant.id, "claude", PATH);
    const refused = await m.toolAt(PATH, claude, "set_flows", { property: lane.id, supplies: true });
    expect(refused).toMatchObject({ isError: true, text: SUPPLIES_AGENTS_ONLY });
    expect(await m.toolNames(PATH, claude)).toContain("save_property");
  });
});

describe("Muse's words for one Supply Core reply", () => {
  it("save_supply_sources hands Muse only the host's private page, never an instruction to post the link", async () => {
    const root = mkdtempSync(join(tmpdir(), "supply-muse-"));
    dirs.push(root);
    const desk = supplyDeskFor(root, { now: () => new Date("2026-11-04T15:00:00.000Z"), uploadBase: () => "https://scratch.example" });
    await desk.saveSettings({ property: PROPERTY });
    const grok = await desk.saveSources({ uploadLink: { name: "Airbnb" } });
    expect(grok.structured?.next).toContain("POST JSON");
    const muse = supplyReplyFor("muse", "save_supply_sources", grok);
    expect(muse.structured).toMatchObject({ uploadUrl: grok.structured!.uploadUrl, expiresInMinutes: grok.structured!.expiresInMinutes, next: MUSE_SUPPLY_UPLOAD_NEXT });
    for (const word of GROK_ONLY_WORDS) expect(muse.text).not.toMatch(word);
    expect(supplyReplyFor("grok", "save_supply_sources", grok)).toBe(grok);
  });

  it("an order the host placed in Muse's browser is recorded as host-browser", async () => {
    const root = mkdtempSync(join(tmpdir(), "supply-muse-"));
    dirs.push(root);
    const desk = supplyDeskFor(root, { now: () => new Date("2026-11-04T15:00:00.000Z") });
    await desk.saveSettings({ property: PROPERTY });
    await desk.saveItem(towels as never);
    await desk.saveItem({ done: true });
    await desk.saveSettings({ mode: "hands-off", perOrderCapCents: null, perMonthCapCents: null, checkTime: "10:00", routineCreated: true });
    expect((await desk.activate({})).isError).toBe(false);
    const itemId = readSupply(root).items[0]!.id;
    const go = await desk.checkCart({ store: "Example Mart", items: [{ itemId, product: "preferred", qty: 2, unitCents: 2400 }], shippingCents: 0, taxCents: 0, totalCents: 4800, deliveryBy: "2026-11-06" });
    expect(go.structured?.verdict).toBe("go");
    await desk.recordOrder({ cartToken: go.structured!.cartToken as string, chargedCents: 4800, approvedBy: "host-browser" });
    expect(readSupply(root).orders[0]!.approvedBy).toBe("host-browser");
  });

  it("Cleaner Core's Supply Core question on Muse keeps cards with the store, not a Vault", () => {
    const how = museAsk(SUPPLIES_STEP).questions[0]!.how!;
    expect(how).toContain("in your own browser");
    expect(how).toContain("choose_supplies");
    expect(how).not.toMatch(/Vault/);
  });
});
