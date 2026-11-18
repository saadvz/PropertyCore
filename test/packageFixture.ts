import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Order, SupplyFile } from "../src/supply-core/store";
import { emptySupply } from "../src/supply-core/store";

/**
 * A made-up property for package arrivals (#241): its hub in New York and Supply Core orders. Made-up names,
 * 555 numbers and made-up stores only; no door code anywhere.
 */

export const PROPERTY_ID = "prp_lanepkgs01";
const made: string[] = [];

export function cleanupFolders(): void {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true });
}

/** A property folder under an account folder, so the shared people list is found: …/tenants/<id>/properties/<pid>. */
export function propertyFolder(opts: { underAccount?: boolean; timeZone?: string | null } = {}): { root: string; accountRoot: string } {
  const base = mkdtempSync(join(tmpdir(), "packages-"));
  made.push(base);
  const accountRoot = join(base, "tenants", "tnt_lanepkgs1");
  const root = opts.underAccount === false ? join(base, "flat") : join(accountRoot, "properties", PROPERTY_ID);
  mkdirSync(root, { recursive: true });
  const timeZone = opts.timeZone === null ? {} : { timeZone: opts.timeZone ?? "America/New_York" };
  writeFileSync(join(root, "hub.json"), JSON.stringify({ schemaVersion: 1, property: { nickname: "Scratch Lane", address: "12 Scratch Lane, Teaneck, NJ 07666", ...timeZone }, calendars: [], stays: [] }));
  return { root, accountRoot };
}

export function order(id: string, extra: Partial<Order> = {}): Order {
  return {
    id,
    at: "2026-11-15T14:00:00.000Z",
    store: "Example Mart",
    items: [{ itemId: "itm_towels", product: "preferred", qty: 2, unitCents: 1200 }],
    totalCents: 2400,
    chargedCents: 2400,
    source: "schedule",
    approvedBy: "rules",
    status: "placed",
    ...extra,
  };
}

export function writeOrders(root: string, orders: Order[]): void {
  const file: SupplyFile = {
    ...emptySupply(),
    items: [
      {
        id: "itm_towels",
        name: "Paper towels",
        qtyPerOrder: 2,
        preferred: { title: "Example towels", store: "Example Mart", url: "https://shop.example/towels", packSize: "12 rolls", priceCents: 1200, pickedAt: "2026-11-01T12:00:00.000Z" },
        storeNote: "",
        schedule: { kind: "reports" },
        savedAt: "2026-11-01T12:00:00.000Z",
      },
    ],
    orders,
  };
  writeFileSync(join(root, "supply.json"), JSON.stringify(file));
}
