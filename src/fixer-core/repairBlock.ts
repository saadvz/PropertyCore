import { addCalendarDays, zonedInstant } from "../hub/calendar.js";
import type { Stay } from "../hub/store.js";
import { busyTimes, type OccupyInput } from "./window.js";

/**
 * Repair blocks (#243): whole local days the host closes on the booking calendar so a crew can work. Pure: the
 * desk passes the saved blocks and the last calendar read. A block from `firstDay` to `lastDay` closes the nights
 * `firstDay` through `lastDay`, which on a booking calendar is a block that checks out the day after `lastDay`.
 */

export const MAX_BLOCK_DAYS = 92;

export interface RepairBlock {
  id: string;
  /** First local day, YYYY-MM-DD. */
  firstDay: string;
  /** Last local day, inclusive. */
  lastDay: string;
  jobIds: string[];
}

export type BlockDays = Pick<RepairBlock, "firstDay" | "lastDay">;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar day written as YYYY-MM-DD. */
export function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !YMD.test(value)) return false;
  return addCalendarDays(value, 0) === value;
}

/** The days from first to last, inclusive. */
export function daysBetween(firstDay: string, lastDay: string): string[] {
  const days: string[] = [];
  for (let day = firstDay; day <= lastDay; day = addCalendarDays(day, 1)) days.push(day);
  return days;
}

/** The nights the block closes, first to last. */
export function nightsOf(block: BlockDays): string[] {
  return daysBetween(block.firstDay, block.lastDay);
}

/** Why these days can't be a repair block, or undefined when they can. */
export function repairBlockProblem(block: BlockDays, todayYmd: string): string | undefined {
  if (!isDay(block.firstDay) || !isDay(block.lastDay)) return "Give the first and last day as dates, like 2026-12-05.";
  if (block.firstDay < todayYmd) return "A repair block can't start before today.";
  if (block.lastDay < block.firstDay) return "The last day can't be before the first.";
  if (addCalendarDays(block.firstDay, MAX_BLOCK_DAYS - 1) < block.lastDay) return `A repair block can be at most ${MAX_BLOCK_DAYS} days. Save a longer job as two blocks.`;
  return undefined;
}

export interface RepairBlockStatus {
  /** Calendar blocks close every night of the repair block. */
  onCalendar: boolean;
  /** Nights a booking could still land on. */
  openNights: string[];
  /** Guest stays holding any of its nights. */
  collisions: Stay[];
}

const holdsNight = (entry: Stay, night: string) => entry.checkIn <= night && night < entry.checkout;
const holdsAny = (entry: Stay, block: BlockDays) => entry.checkIn <= block.lastDay && entry.checkout > block.firstDay;

/** What the last calendar read says about a repair block. */
export function repairBlockStatus(block: BlockDays, stays: readonly Stay[]): RepairBlockStatus {
  const closers = stays.filter((s) => s.kind === "block");
  const openNights = nightsOf(block).filter((night) => !closers.some((c) => holdsNight(c, night)));
  const collisions = stays.filter((s) => s.kind === "stay" && holdsAny(s, block));
  return { onCalendar: openNights.length === 0, openNights, collisions };
}

/** The stays to count as busy when booking a crew: calendar blocks are cut down to the parts outside repair blocks. */
export function staysForCrew(stays: readonly Stay[], blocks: readonly BlockDays[]): Stay[] {
  let out: Stay[] = [...stays];
  for (const block of blocks) {
    const after = addCalendarDays(block.lastDay, 1);
    out = out.flatMap((entry) => {
      if (entry.kind !== "block" || !holdsAny(entry, block)) return [entry];
      const parts: Stay[] = [];
      if (entry.checkIn < block.firstDay) parts.push({ ...entry, checkout: block.firstDay });
      if (entry.checkout > after) parts.push({ ...entry, checkIn: after });
      return parts;
    });
  }
  return out;
}

export type DoorFor = "guests" | "crew" | "none";

/** Who the door is for at an instant: a guest stay wins, then a repair block that is on the calendar. */
export function doorFor(at: Date, blocks: readonly BlockDays[], stays: readonly Stay[], times: OccupyInput): DoorFor {
  const t = at.getTime();
  const guests = stays.filter((s) => s.kind === "stay");
  if (busyTimes(guests, times).some((b) => b.start <= t && t < b.end)) return "guests";
  const crew = blocks.some((block) => {
    const from = Date.parse(zonedInstant(block.firstDay, "00:00", times.timeZone));
    const until = Date.parse(zonedInstant(addCalendarDays(block.lastDay, 1), "00:00", times.timeZone));
    return from <= t && t < until && repairBlockStatus(block, stays).onCalendar;
  });
  return crew ? "crew" : "none";
}
