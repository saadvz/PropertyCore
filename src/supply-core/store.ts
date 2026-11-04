import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { zonedParts } from "../core/timezone";
import { writeJsonAtomic } from "../storage/atomicWrite";
import type { CartInput, Mode } from "./gate";
import type { Schedule } from "./schedule";

/**
 * Supply Core's record: one `supply.json` in the tenant's folder, beside `cleaner-live.json`. It
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
  approvedBy: "rules" | "landlord" | "grok-card";
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

export interface SupplySettings {
  mode?: Mode;
  perOrderCapCents?: number;
  perMonthCapCents?: number;
  priceJumpPct: number;
  bufferDays: number;
  checkTime?: string;
  property?: { name: string; address: string; timeZone: string };
  activatedAt?: string;
}

export interface BookingCalendar {
  name: string;
  kind: "ical" | "google-calendar";
  url?: string;
}

export interface SupplyFile {
  settings: SupplySettings;
  /** Setup steps the host finished that leave no other trace. */
  setup: { itemsDone?: boolean; sourcesDone?: boolean; capsDone?: boolean; routineCreated?: boolean };
  items: Item[];
  orders: Order[];
  carts: Cart[];
  lowReports: LowReport[];
  sources: BookingCalendar[];
  /** The pending one-time calendar upload: only the code's sha256 is kept. */
  calendarUpload?: { hash: string; name: string; expiresAt: string };
  /** Checkout dates from the last good read of the standalone calendars. */
  checkouts?: { dates: string[]; at?: string; failedAt?: string };
  offAt?: string;
}

export function emptySupply(): SupplyFile {
  return { settings: { priceJumpPct: 20, bufferDays: 3 }, setup: {}, items: [], orders: [], carts: [], lowReports: [], sources: [] };
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
    orders: raw.orders ?? [],
    carts: raw.carts ?? [],
    lowReports: raw.lowReports ?? [],
    sources: raw.sources ?? [],
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
