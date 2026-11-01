import { bookedTourCalledOffText } from "../core/availabilityCopy";
import { formatDay, formatTime } from "../core/timezone";
import { isRunningReservation } from "../domain/stateMachine";
import { UNNAMED_VISITOR } from "../domain/model";
import { bookedTours, cancelBooked } from "../operator/availability";
import type { OperatorServices } from "../operator/services";
import { isFutureBooking, tourSnapshots } from "../operator/tours";
import { isEffectivelyPaused } from "../setup/availability";
import { operatorFacingPropertyName } from "../setup/setupActions";
import { visitorTeamName } from "../sms/templates";

/**
 * What's live on one touring host's Tour Core, and standing it down so the number can switch. Live is
 * a property taking bookings, a booked or held tour still to come, or a tour in progress. Standing
 * down pauses each property and cancels each booked tour with Tour Core's usual text; it never
 * touches a tour in progress, and it keeps every property's setup.
 */

/** A touring process's internal routes, reached only with its key. */
export const TOURING_LIVE_PATH = "/internal/live";
export const TOURING_STAND_DOWN_PATH = "/internal/stand-down";

export interface TouringLive {
  live: string[];
  inProgress: boolean;
  /** The texts a stand-down sends: one per booked tour, to that visitor. */
  texts: { to: string; body: string }[];
}

const unitIdsOf = (services: OperatorServices, propertyId: string) => services.workspace.load(propertyId).config.units.map((unit) => unit.id);

function takingBookings(services: OperatorServices, propertyId: string): boolean {
  const { state } = services.workspace.load(propertyId);
  return state.status === "PUBLISHED_FOR_DEMO" && !isEffectivelyPaused(state, unitIdsOf(services, propertyId));
}

export async function touringLiveWork(services: OperatorServices, now: Date): Promise<TouringLive> {
  const live: string[] = [];
  const texts: TouringLive["texts"] = [];
  let inProgress = false;
  for (const { config } of services.workspace.list()) {
    if (takingBookings(services, config.property.id)) live.push(`${operatorFacingPropertyName(config)} is taking bookings.`);
  }
  for (const tour of await tourSnapshots(services)) {
    const zone = tour.config.property.timezone;
    for (const reservation of tour.bundle.reservations) {
      if (isRunningReservation(reservation.status)) inProgress = true;
      if (!isFutureBooking(reservation, now) || !reservation.slotStart) continue;
      const name = tour.bundle.prospects.find((p) => p.id === reservation.prospectId)?.name ?? UNNAMED_VISITOR;
      const start = new Date(reservation.slotStart);
      const day = formatDay(start, zone);
      const time = formatTime(start, zone);
      live.push(`${name}'s tour at ${time} on ${day}.`);
      texts.push({ to: name, body: bookedTourCalledOffText({ team: visitorTeamName(tour.config.operator.name), day, time, address: tour.config.property.address, propertyWide: true }) });
    }
  }
  return { live, inProgress, texts };
}

/** Pauses every property still taking bookings and cancels every booked tour. The caller checked nobody is touring. */
export async function standDownTouring(services: OperatorServices, now: Date): Promise<{ paused: number; cancelled: number }> {
  let paused = 0;
  let cancelled = 0;
  for (const { config } of services.workspace.list()) {
    const id = config.property.id;
    if (takingBookings(services, id)) {
      services.workspace.patchState(id, { paused: true });
      paused += 1;
    }
    const booked = (await bookedTours(services, id)).filter((tour) => tour.bundle.reservations.some((r) => isFutureBooking(r, now)));
    if (booked.length) cancelled += await cancelBooked(services, booked, true, "tours paused");
  }
  return { paused, cancelled };
}
