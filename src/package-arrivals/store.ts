import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../storage/atomicWrite";
import type { Order } from "../supply-core/store";

/**
 * Package arrivals' record (#241): one `packages.json` in the property's folder, beside `supply.json`. It holds
 * only what this feature adds to a delivery: when it was seen and how, the bring-it-in visit, when it was
 * brought in, and which flags the host was already told. Expected deliveries are read from Supply Core's orders
 * on every call and never copied here. Never a door code.
 */

export const PACKAGES_FILE = "packages.json";

/** What confirmed the drop: the carrier's tracking, the host saying so, or the camera (#239). */
export type SeenHow = "tracking" | "host" | "camera";

/** Who may bring a package in: a saved person on the property in one of these roles. */
export type BringInRole = "cleaner" | "co-host" | "assistant";

export interface BringInVisit {
  /** E.164 phone of the person the host picked. */
  person: string;
  /** Their name as the people list had it when the visit was planned. */
  name?: string;
  role: BringInRole;
  plannedAt: string;
}

export interface Arrival {
  seen?: { at: string; how: SeenHow };
  /** The host was told it wasn't seen by end of day. */
  notSeenTold?: boolean;
  visit?: BringInVisit;
  broughtIn?: { at: string; startedAt?: string; note?: string };
  /** The host was told the bring-in is late. */
  lateTold?: boolean;
}

export interface PackageSettings {
  /** The host's own hours from the drop to when it should be inside, 1 to 72. */
  bringInHours?: number;
  /** The default bring-in person's phone. */
  person?: string;
}

export interface PackagesFile {
  settings: PackageSettings;
  /** By delivery key: `supply:<orderId>` for a Supply Core order. */
  arrivals: Record<string, Arrival>;
}

/** packages.json is there but isn't a readable record. Nothing is written over it. */
export class PackagesFileError extends Error {}

/** The key of a Supply Core order's delivery. Carrier notices from email get their own prefix later. */
export function supplyKey(orderId: string): string {
  return `supply:${orderId}`;
}

/** The drop that counts for an order: a camera sighting over anything else, otherwise the earliest signal. */
export function effectiveSeen(order: Pick<Order, "deliveredAt">, arrival: Arrival | undefined): { at: string; how: SeenHow } | undefined {
  const tracking = order.deliveredAt ? { at: order.deliveredAt, how: "tracking" as const } : undefined;
  const own = arrival?.seen;
  if (own?.how === "camera" || !tracking) return own;
  if (!own) return tracking;
  return Date.parse(own.at) <= Date.parse(tracking.at) ? own : tracking;
}

export function readPackages(root: string): PackagesFile {
  const path = join(root, PACKAGES_FILE);
  if (!existsSync(path)) return { settings: {}, arrivals: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    raw = undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PackagesFileError(`The package arrivals record (${PACKAGES_FILE}) can't be read, so nothing was changed. Tell the host it needs a look before package arrivals can be used.`);
  }
  const file = raw as Partial<PackagesFile>;
  const object = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
  return { settings: object(file.settings) as PackageSettings, arrivals: object(file.arrivals) as Record<string, Arrival> };
}

export function writePackages(root: string, file: PackagesFile): void {
  writeJsonAtomic(join(root, PACKAGES_FILE), file);
}
