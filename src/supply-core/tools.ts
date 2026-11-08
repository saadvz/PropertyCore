import { z } from "zod";
import { refuseCards } from "../hub/cards";
import { CARD_REFUSAL, type SupplyDesk, type SupplyReply } from "./desk";

/**
 * Supply Core's MCP tools: names, descriptions, and strict inputs. Every call is checked for
 * card-like text before it reaches the desk, then parsed, then run.
 */

export interface SupplyTool {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
}

const Cents = z.number().int();
const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Product = z.object({ title: z.string().max(200), store: z.string().max(60), url: z.string().max(500), packSize: z.string().max(60), priceCents: Cents }).strict();
const Schedule = z.union([
  z.object({ kind: z.literal("every"), days: z.number().int() }).strict(),
  z.object({ kind: z.literal("every"), monthlyOn: z.number().int() }).strict(),
  z.object({ kind: z.literal("bookings"), stays: z.number().int() }).strict(),
  z.object({ kind: z.literal("custom"), rrule: z.string().max(300), said: z.string().max(200) }).strict(),
]);
const Confirmation = z.string().max(40).optional();
const GoogleEvents = z.object({ timeZone: z.string().max(80).optional(), items: z.array(z.unknown()).max(2000) }).strict();
const CartLine = z.object({ itemId: z.string().max(40), product: z.enum(["preferred", "backup"]), qty: z.number().int(), unitCents: Cents }).strict();

export const NO_CARDS = "Never pass a card number, expiry, or security code: checkout uses your Vault.";

export const SUPPLY_TOOLS: SupplyTool[] = [
  {
    name: "get_supply_state",
    title: "Supply Core: what's next",
    description: "Supply Core's setup step to ask next, or once it's active, the list, mode, caps, this month's spending, and open holds. Call first, and follow its ask one question at a time.",
    input: z.object({}).strict(),
  },
  {
    name: "save_supply_settings",
    title: "Save supply settings",
    description: `Saves any of: property (the delivery address, the time zone you work out from it, and an optional name that defaults to the street address; it's the property's, shared with Cleaner Core), mode (hands-off or checkout), perOrderCapCents and perMonthCapCents (null clears one), priceJumpPct, bufferDays, checkTime (24-hour HH:MM), routineCreated, sharedSchedule (one schedule for every item; null for each its own), and storesReady (the plan's stores you checked you can check out with: signed in, delivering to the property, a payment method ready). After Activate, call without confirmation to get the question and a code, ask the host, and call again with the code only after their yes. ${NO_CARDS}`,
    input: z
      .object({
        property: z.object({ address: z.string().max(200), timeZone: z.string().max(80), name: z.string().max(80).optional() }).strict().optional(),
        mode: z.enum(["hands-off", "checkout"]).optional(),
        perOrderCapCents: Cents.nullable().optional(),
        perMonthCapCents: Cents.nullable().optional(),
        priceJumpPct: z.number().int().optional(),
        bufferDays: z.number().int().optional(),
        checkTime: z.string().max(5).optional(),
        routineCreated: z.literal(true).optional(),
        sharedSchedule: Schedule.nullable().optional(),
        storesReady: z.array(z.string().max(60)).max(2).optional(),
        confirmation: Confirmation,
      })
      .strict(),
  },
  {
    name: "save_supply_list",
    title: "Save the restock list",
    description: "Saves the host's whole list of items to restock, names only, as a draft: up to 30. Ask for everything in one message, read the list back once, then call this. Calling it again adds names to the list.",
    input: z.object({ names: z.array(z.string().max(60)).min(1).max(30) }).strict(),
  },
  {
    name: "save_supply_stores",
    title: "Save where to buy",
    description:
      "Saves the store plan before any product is picked: the one main store that covers the whole list in time, and an optional same-day store for deadlines the main one can't make. channel is shipping (shipped to the door from the store's own site) or same-day (a driver who leaves it at the door). Only stores you can check out with now. After Activate, call without confirmation, ask the host, then call again with the code.",
    input: z
      .object({
        primary: z.object({ name: z.string().max(60), channel: z.enum(["shipping", "same-day"]), note: z.string().max(200).optional() }).strict(),
        fast: z.object({ name: z.string().max(60), channel: z.enum(["shipping", "same-day"]), note: z.string().max(200).optional() }).strict().nullable().optional(),
        confirmation: Confirmation,
      })
      .strict(),
  },
  {
    name: "save_supply_item",
    title: "Save a supply item",
    description: `Saves the next item from the draft list, or changes one with its itemId: name, qtyPerOrder, the preferred product the host picked from your product cards (only from the plan's stores), an optional backup from the plan's stores (null removes it), an optional one-line storeNote under 160 characters, and the schedule. { done: true } ends the list. After Activate it takes the host's yes: call without confirmation, ask, then call again with the code. ${NO_CARDS}`,
    input: z
      .object({
        id: z.string().max(40).optional(),
        name: z.string().max(60).optional(),
        qtyPerOrder: z.number().int().optional(),
        preferred: Product.optional(),
        backup: Product.nullable().optional(),
        storeNote: z.string().max(200).optional(),
        schedule: Schedule.optional(),
        confirmation: Confirmation,
        done: z.literal(true).optional(),
      })
      .strict(),
  },
  {
    name: "remove_supply_item",
    title: "Remove a supply item",
    description: "Removes an item. After Activate, call without confirmation to get the question and a code, and again with the code only after the host's yes.",
    input: z.object({ itemId: z.string().max(40), confirmation: Confirmation }).strict(),
  },
  {
    name: "preview_schedule",
    title: "Preview a schedule",
    description: "The next 3 dates a schedule gives, or why it can't be used. Read them back to the host before saving an Other schedule.",
    input: z.object({ schedule: Schedule }).strict(),
  },
  {
    name: "save_supply_sources",
    title: "Save booking calendars",
    description:
      "For by-bookings items: saves to the property's booking calendars, shared with Cleaner Core, whether Cleaner Core is on or off. Skip it when the property already has its calendars. uploadLink { name } gives a one-time link: from your own cloud computer, POST JSON {\"url\": \"<calendar link>\"} to it. Never put the link in chat or in a tool argument. google: true when the bookings are in Google Calendar; then pass that calendar's events as googleEvents to every check_supplies. done: true when that's all.",
    input: z.object({ uploadLink: z.object({ name: z.string().max(40) }).strict().optional(), google: z.literal(true).optional(), done: z.literal(true).optional() }).strict(),
  },
  {
    name: "activate_supplies",
    title: "Activate Supply Core",
    description: "Starts Supply Core after the host's Activate. Needs at least one item, a mode, and a check time.",
    input: z.object({}).strict(),
  },
  {
    name: "check_supplies",
    title: "What's due",
    description:
      "What to buy now: due items with deadlines, unconfirmed orders to look up in your order history first, held carts, late orders, and this month's spending. Pass googleEvents when the bookings are in Google Calendar.",
    input: z.object({ googleEvents: GoogleEvents.optional() }).strict(),
  },
  {
    name: "report_low",
    title: "Mark items low",
    description: "Marks list items low so they're ordered now. Item ids from the list only: match the cleaner's or host's words to the list yourself, and ask the host about anything not on it.",
    input: z.object({ itemIds: z.array(z.string().max(40)).min(1).max(30), source: z.enum(["cleaner", "host"]), jobId: z.string().max(80).optional() }).strict(),
  },
  {
    name: "check_cart",
    title: "Check a cart before checkout",
    description: `Call before Place Order, every time, with the final page's store, each item, shipping, tax, total, and delivery date. go: place it, then record_order. held: stop and ask the host, then approve_cart. refused: take those items out and check again. ${NO_CARDS}`,
    input: z
      .object({
        store: z.string().max(60),
        items: z.array(CartLine).min(1).max(30),
        shippingCents: Cents,
        taxCents: Cents,
        totalCents: Cents,
        deliveryBy: Ymd,
        source: z.enum(["schedule", "cleaner", "host"]).optional(),
      })
      .strict(),
  },
  {
    name: "approve_cart",
    title: "Approve a held cart",
    description: "For a held cart: call without confirmation to get the question and a code, ask the host, and call again with the code only after their yes. A routine run never calls it with a code.",
    input: z.object({ cartToken: z.string().max(40), confirmation: Confirmation }).strict(),
  },
  {
    name: "record_order",
    title: "Record a placed order",
    description: "Records an order you placed: the cartToken (or an unconfirmed orderId you found in your order history), the order number, chargedCents, and expectedBy (YYYY-MM-DD). approvedBy: grok-card when the host tapped Pay on your own card.",
    input: z
      .object({
        cartToken: z.string().max(40).optional(),
        orderId: z.string().max(40).optional(),
        orderNumber: z.string().max(80).optional(),
        chargedCents: Cents,
        expectedBy: Ymd.optional(),
        approvedBy: z.enum(["grok-card", "host-browser"]).optional(),
      })
      .strict(),
  },
  {
    name: "record_problem",
    title: "Record a problem",
    description:
      "store-blocked, listing-changed, out-of-stock, or misses-deadline for items, or with the cartToken of a cart you couldn't place, which closes it so its items can go to the backup or another store; not-placed for an unconfirmed order you didn't find in your order history.",
    input: z
      .object({ reason: z.enum(["store-blocked", "listing-changed", "out-of-stock", "misses-deadline", "not-placed"]), itemIds: z.array(z.string().max(40)).max(30).optional(), orderId: z.string().max(40).optional(), cartToken: z.string().max(40).optional() })
      .strict(),
  },
  {
    name: "skip_item",
    title: "Skip an item this time",
    description: "Skips a due item until its next due date, when the host says skip.",
    input: z.object({ itemId: z.string().max(40) }).strict(),
  },
  {
    name: "mark_delivered",
    title: "Mark an order delivered",
    description: "When your order tracking shows it arrived.",
    input: z.object({ orderId: z.string().max(40) }).strict(),
  },
];

export const SUPPLY_TOOL_NAMES: ReadonlySet<string> = new Set(SUPPLY_TOOLS.map((tool) => tool.name));

/** The tools as tools/list shows them, in Grok's words. src/hosted/supplyWording.ts words them for Muse. */
export function listedSupplyTools(names: readonly string[], describe: (tool: SupplyTool) => string = (tool) => tool.description): Record<string, unknown>[] {
  return SUPPLY_TOOLS.filter((tool) => names.includes(tool.name)).map((tool) => {
    const { $schema: _schema, ...inputSchema } = z.toJSONSchema(tool.input) as Record<string, unknown>;
    return { name: tool.name, title: tool.title, description: describe(tool), inputSchema };
  });
}

/** Answers a Supply Core tool. Undefined when the name isn't one. */
export async function handleSupplyTool(desk: SupplyDesk, name: string, args: unknown): Promise<SupplyReply | undefined> {
  const tool = SUPPLY_TOOLS.find((item) => item.name === name);
  if (!tool) return undefined;
  // Google events are read for their dates only and never saved, so they skip the card check.
  const checked = name === "check_supplies" && args && typeof args === "object" ? { ...(args as Record<string, unknown>), googleEvents: undefined } : args;
  if (refuseCards(checked)) return { text: CARD_REFUSAL, isError: true };
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) return { text: `That was missing something I need, or had something I don't take: ${parsed.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}.`, isError: true };
  const input = parsed.data as never;
  switch (name) {
    case "get_supply_state":
      return desk.state();
    case "save_supply_settings":
      return desk.saveSettings(input);
    case "save_supply_list":
      return desk.saveList(input);
    case "save_supply_stores":
      return desk.saveStores(input);
    case "save_supply_item":
      return desk.saveItem(input);
    case "remove_supply_item":
      return desk.removeItem(input);
    case "preview_schedule":
      return desk.previewSchedule(input);
    case "save_supply_sources":
      return desk.saveSources(input);
    case "activate_supplies":
      return desk.activate(input);
    case "check_supplies":
      return desk.checkSupplies(input);
    case "report_low":
      return desk.reportLow(input);
    case "check_cart":
      return desk.checkCart(input);
    case "approve_cart":
      return desk.approveCart(input);
    case "record_order":
      return desk.recordOrder(input);
    case "record_problem":
      return desk.recordProblem(input);
    case "skip_item":
      return desk.skipItem(input);
    case "mark_delivered":
      return desk.markDelivered(input);
  }
  return undefined;
}
