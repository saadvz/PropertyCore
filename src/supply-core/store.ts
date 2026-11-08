import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { zonedParts } from "../core/timezone";
import { writeJsonAtomic } from "../storage/atomicWrite";
import type { CartInput, Mode } from "./gate";
import type { Schedule } from "./schedule";

/**
 * Supply Core's record: one `supply.json` in the property's folder, beside `cleaner-live.json`. It
 * holds the list, the settings, the open carts, and the order log. Never a card detail.
 */

export const SUPPLY_FILE = "supply.json";
/** An order not delivered keeps its items on their way this long. */
export const ON_ITS_WAY_DAYS = 14;

export interface Product {
  title: string;
  store: string;
  url: string;
  packSize: string;
  priceCents: number;
  pickedAt: string;
  lastPaidCents?: number;
}

export interface Item {
  id: string;
  name: string;
  qtyPerOrder: number;
  preferred: Product;
  backup?: Product;
  storeNote: string;
  schedule: Schedule;
  savedAt: string;
  lastOrderedAt?: string;
  skippedAt?: string;
  /** Store-blocked runs in a row. A placed order resets it. */
  blockedRuns?: number;
}

export interface Order {
  id: string;
  at: string;
  store: string;
  items: { itemId: string; product: "preferred" | "backup"; qty: number; unitCents: number }[];
  totalCents: number;
  chargedCents: number;
  orderNumber?: string;
  expectedBy?: string;
  /** The latest deadline the order had to make, local `YYYY-MM-DD`. */
  deadline?: string;
  deliveredAt?: string;
  source: "schedule" | "cleaner" | "host";
  /** grok-card: the host tapped Pay on Grok's own card. host-browser: the host placed it themselves in Muse's browser. */
  approvedBy: "rules" | "landlord" | "grok-card" | "host-browser";
  status: "placed" | "unconfirmed" | "delivered";
  lateTold?: boolean;
}

export interface Cart {
  token: string;
  fingerprint: string;
  cart: CartInput;
  status: "go" | "held" | "approved" | "recorded";
  holds: string[];
  expiresAt: string;
  source: Order["source"];
  deadline: string;
}

export interface LowReport {
  itemId: string;
  source: "cleaner" | "host";
  at: string;
  jobId?: string;
}

/** How a store gets things to an empty rental: shipped to the door, or a same-day driver who leaves it at the door. */
export type StoreChannel = "shipping" | "same-day";

export interface PlanStore {
  name: string;
  channel: StoreChannel;
  note?: string;
}

/** Where the list is bought: one main store, and an optional same-day store for deadlines the main one can't make. */
export interface StorePlan {
  primary: PlanStore;
  fast?: PlanStore;
}

export interface SupplySettings {
  mode?: Mode;
  perOrderCapCents?: number;
  perMonthCapCents?: number;
  priceJumpPct: number;
  bufferDays: number;
  checkTime?: string;
  stores?: StorePlan;
  /** One schedule for every item, when the host chose the same for everything. */
  sharedSchedule?: Schedule;
  /** Plan stores Grok checked it can check out with: signed in, delivering to the property, a payment method in Vault. */
  storesReady?: string[];
  activatedAt?: string;
}

/** Supply Core's own record for one property. Its details and booking calendars are in the property hub. */
export interface SupplyFile {
  settings: SupplySettings;
  /** Setup steps the host finished that leave no other trace. */
  setup: { itemsDone?: boolean; capsDone?: boolean; routineCreated?: boolean; scheduleAsked?: boolean };
  items: Item[];
  /** Item names from the host's list that don't have products picked yet, in their order. */
  draft: string[];
  orders: Order[];
  carts: Cart[];
  lowReports: LowReport[];
  offAt?: string;
}

export function emptySupply(): SupplyFile {
  return { settings: { priceJumpPct: 20, bufferDays: 3 }, setup: {}, items: [], draft: [], orders: [], carts: [], lowReports: [] };
}

export function readSupply(root: string): SupplyFile {
  const path = join(root, SUPPLY_FILE);
  if (!existsSync(path)) return emptySupply();
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SupplyFile>;
  const empty = emptySupply();
  return {
    ...empty,
    ...raw,
    settings: { ...empty.settings, ...raw.settings },
    setup: { ...raw.setup },
    items: raw.items ?? [],
    draft: raw.draft ?? [],
    orders: raw.orders ?? [],
    carts: raw.carts ?? [],
    lowReports: raw.lowReports ?? [],
  };
}

export function writeSupply(root: string, file: SupplyFile): void {
  writeJsonAtomic(join(root, SUPPLY_FILE), file);
}

/** True when Cleaner Core should ask the cleaner about supplies: activated and not turned off. */
export function supplyAskOn(root: string): boolean {
  const file = readSupply(root);
  return Boolean(file.settings.activatedAt) && !file.offAt;
}

function monthOf(date: Date, timeZone: string): string {
  const { year, month } = zonedParts(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** What was charged for orders placed this calendar month, in the property's time zone. */
export function monthSpentCents(file: SupplyFile, timeZone: string, now: Date): number {
  const month = monthOf(now, timeZone);
  return file.orders.filter((order) => monthOf(new Date(order.at), timeZone) === month).reduce((sum, order) => sum + order.chargedCents, 0);
}

/** Item ids on an order that isn't delivered, placed within the last 14 days. */
export function onItsWay(file: SupplyFile, now: Date): Set<string> {
  const since = now.getTime() - ON_ITS_WAY_DAYS * 86_400_000;
  const out = new Set<string>();
  for (const order of file.orders) {
    if (order.status === "delivered" || order.deliveredAt) continue;
    if (new Date(order.at).getTime() < since) continue;
    for (const line of order.items) out.add(line.itemId);
  }
  return out;
}
