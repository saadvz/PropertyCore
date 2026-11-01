import type { TourCoreConfig } from "../config/tourCoreConfig";
import type { Reservation, TourTimeRequest } from "../domain/model";
import { TERMINAL } from "../domain/stateMachine";
import { intervalsOverlap, type TimeInterval } from "./customSlot";
import { EXTENSION_MINUTES } from "./overstayCopy";
import { bookedClockZone } from "./inProgressTour";
import { isValidTimeZone, localDateOf, weekdayOf, zonedTimeToUtc } from "./timezone";
import { windowOn } from "./tourWindows";

export const EXTENSION_MS = EXTENSION_MINUTES * 60_000;

export type ExtensionBlocker =
  | "booked"
  | "one-off"
  | "pending"
  | "early-arrival"
  | "route-door"
  | "tour-hours";

export interface Occupant {
  /** Slot or requested start. */
  start: Date;
  windowStart: Date;
  windowEnd: Date;
  unitId?: string;
  doors: string[];
  kind: "booked" | "one-off" | "pending";
  oneOff?: boolean;
}

export function extensionWindow(tourEnd: Date): TimeInterval {
  return { startMs: tourEnd.getTime(), endMs: tourEnd.getTime() + EXTENSION_MS };
}

export function occupantInterval(occupant: Occupant): TimeInterval {
  return { startMs: occupant.windowStart.getTime(), endMs: occupant.windowEnd.getTime() };
}

export function tourHoursEndOn(config: TourCoreConfig, at: Date, timeZone = config.property.timezone): Date {
  const tz = timeZone;
  const day = localDateOf(at, tz);
  const close = windowOn(config.tourHours, weekdayOf(day))?.end ?? config.tourHours.end;
  const [hour = 0, minute = 0] = close.split(":").map(Number);
  return zonedTimeToUtc({ ...day, hour, minute }, tz);
}

export function isOneOff(reservation: Pick<Reservation, "scheduleOverride">): boolean {
  return reservation.scheduleOverride?.kind === "OUTSIDE_HOURS";
}

export function doorsForUnit(config: TourCoreConfig, unitId: string, allowedRoute?: string[]): string[] {
  if (allowedRoute?.length) return [...allowedRoute];
  const route = config.routes.find((r) => r.unitId === unitId);
  return route ? route.stops.map((s) => s.doorId) : [];
}

export function occupantFromReservation(config: TourCoreConfig, reservation: Reservation): Occupant | undefined {
  if (!reservation.slotStart || TERMINAL.includes(reservation.status)) return undefined;
  const start = new Date(reservation.slotStart);
  const windowStart = reservation.windowStart ? new Date(reservation.windowStart) : new Date(start.getTime() - config.tourHours.earlyArrivalMinutes * 60_000);
  const windowEnd = reservation.windowEnd
    ? new Date(reservation.windowEnd)
    : new Date(start.getTime() + config.tourHours.tourLengthMinutes * 60_000);
  return {
    start,
    windowStart,
    windowEnd,
    unitId: reservation.unitId,
    doors: doorsForUnit(config, reservation.unitId, reservation.allowedRoute),
    kind: isOneOff(reservation) ? "one-off" : "booked",
    oneOff: isOneOff(reservation),
  };
}

export function occupantFromTimeRequest(config: TourCoreConfig, request: TourTimeRequest): Occupant | undefined {
  if (request.status !== "PENDING") return undefined;
  const start = new Date(request.requestedStartsAt);
  const end = request.requestedEndsAt
    ? new Date(request.requestedEndsAt)
    : new Date(start.getTime() + config.tourHours.tourLengthMinutes * 60_000);
  const windowStart = new Date(start.getTime() - config.tourHours.earlyArrivalMinutes * 60_000);
  const unitId = request.unitId;
  return {
    start,
    windowStart,
    windowEnd: end,
    unitId,
    doors: unitId ? doorsForUnit(config, unitId) : [],
    kind: "pending",
  };
}

function sharesRouteDoor(ours: string[], theirs: string[]): boolean {
  if (theirs.includes("*") || ours.includes("*")) return true;
  return ours.some((door) => theirs.includes(door));
}

/**
 * The extra 10 minutes after T must be free for this unit and every door
 * on its route. Counts booked, one-off, and pending tours (including pending
 * time requests) plus the next visitor's early-arrival window. Must stay
 * inside tour hours unless this tour is a one-off.
 */
export function extensionAvailability(input: {
  config: TourCoreConfig;
  reservation: Reservation;
  occupants: Occupant[];
}): { available: boolean; blocker?: ExtensionBlocker } {
  const end = input.reservation.windowEnd ? new Date(input.reservation.windowEnd) : undefined;
  if (!end) return { available: false };
  const extra = extensionWindow(end);
  if (!isOneOff(input.reservation)) {
    const zone = bookedClockZone(input.config.property.timezone, input.reservation);
    if (!zone || !isValidTimeZone(zone) || extra.endMs > tourHoursEndOn(input.config, end, zone).getTime()) {
      return { available: false, blocker: "tour-hours" };
    }
  }
  const ourDoors = doorsForUnit(input.config, input.reservation.unitId, input.reservation.allowedRoute);
  for (const other of input.occupants) {
    if (!intervalsOverlap(extra, occupantInterval(other))) continue;
    const sameUnit = !other.unitId || other.unitId === "*" || other.unitId === input.reservation.unitId;
    const doorHit = sharesRouteDoor(ourDoors, other.doors);
    if (!sameUnit && !doorHit) continue;
    const body: TimeInterval = { startMs: other.start.getTime(), endMs: other.windowEnd.getTime() };
    const earlyOnly: TimeInterval = { startMs: other.windowStart.getTime(), endMs: other.start.getTime() };
    if (!intervalsOverlap(extra, body) && intervalsOverlap(extra, earlyOnly)) {
      return { available: false, blocker: "early-arrival" };
    }
    if (other.kind === "pending") return { available: false, blocker: "pending" };
    if (other.kind === "one-off") return { available: false, blocker: "one-off" };
    if (!sameUnit && doorHit) return { available: false, blocker: "route-door" };
    return { available: false, blocker: "booked" };
  }
  return { available: true };
}
