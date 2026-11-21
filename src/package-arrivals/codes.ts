import type { WantedCode } from "../hub/grants";
import type { Stay } from "../hub/store";
import type { CodeWindow } from "../locks/adapter";
import { busyTimes, type OccupyInput } from "../fixer-core/window";
import type { Order } from "../supply-core/store";
import { effectiveSeen, supplyKey, type PackagesFile } from "./store";

/**
 * Bring-in codes (#241): which codes package arrivals wants on the connected locks now, one per delivery whose
 * bring-in visit is planned and whose drop was seen, for the person the host picked. Pure. The hub's `bring-in`
 * grants put them on the locks; this file never holds a code.
 */

const HOUR_MS = 3_600_000;

/**
 * The bring-in window: from the later of the drop and the planning, to the deadline (the drop plus the host's
 * hours), cut at the next stay's check-in buffer. "during-stay" when it would start inside a stay or its buffer.
 */
export function bringInWindow(input: { seenAt: string; plannedAt: string; hours: number }, stays: readonly Stay[], occupy: OccupyInput): CodeWindow | "during-stay" {
  const from = Math.max(Date.parse(input.seenAt), Date.parse(input.plannedAt));
  let until = Date.parse(input.seenAt) + input.hours * HOUR_MS;
  for (const busy of busyTimes(stays, occupy)) {
    if (busy.start <= from && from < busy.end) return "during-stay";
    if (busy.start > from && busy.start < until) until = busy.start;
  }
  return { from: new Date(from).toISOString(), until: new Date(until).toISOString() };
}

export interface BringInInput {
  now: Date;
  stays: readonly Stay[];
  occupy: OccupyInput;
  /** Whether this phone may still bring a package in here: saved as cleaner, co-host or assistant, YES, no STOP. */
  canPick(phone: string): boolean;
}

/** The bring-in codes wanted now, and the deliveries whose window falls in a stay (no code for those). */
export function wantedBringInCodes(file: PackagesFile, orders: readonly Order[], input: BringInInput): { wanted: WantedCode[]; duringStay: string[] } {
  const wanted: WantedCode[] = [];
  const duringStay: string[] = [];
  for (const order of orders) {
    const key = supplyKey(order.id);
    const arrival = file.arrivals[key];
    const visit = arrival?.visit;
    if (!visit || arrival.broughtIn) continue;
    const seen = effectiveSeen(order, arrival);
    const hours = visit.hours ?? file.settings.bringInHours;
    if (!seen || hours === undefined || !input.canPick(visit.person)) continue;
    const window = bringInWindow({ seenAt: seen.at, plannedAt: visit.plannedAt, hours }, input.stays, input.occupy);
    if (window === "during-stay") {
      duringStay.push(order.id);
      continue;
    }
    if (Date.parse(window.until) <= input.now.getTime() || Date.parse(window.from) >= Date.parse(window.until)) continue;
    wanted.push({ jobId: key, person: visit.person, window, ...(visit.name ? { label: visit.name } : {}), who: { role: "package" } });
  }
  return { wanted, duringStay };
}
