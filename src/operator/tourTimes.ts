import { isLiveMessaging } from "../config/tourCoreConfig";
import { moveLaterBookingInstead, moveLaterBookingOutsideHours, movedLaterBookingSummary, tourInProgressCannotMove } from "../core/availabilityCopy";
import { intervalsOverlap, parseFlexibleTime, placementOf, relativeWhen, tourInterval, touringHoursLabel } from "../core/customSlot";
import { REQUEST_ALREADY_HANDLED, requestAlreadyExpiredLine, requestProposePassedLine, requestTimePassedLine, SLOT_ALREADY_PASSED, TourCoreError, visitorBookingConfirmed, WITHDRAWN_FOR_REGULAR_BOOKING } from "../core/TourCore";
import { formatDay, formatTime, formatWeekday, localDateOf, timeOnDay } from "../core/timezone";
import { formatPhone, parsePhone } from "../core/phone";
import type { Reservation, TourTimeRequest } from "../domain/model";
import { isRunningReservation, TERMINAL } from "../domain/stateMachine";
import { operatorPausedBookingRefuse } from "../setup/availability";
import { SetupInputError } from "../setup/setupActions";
import { oneOffBlockReason } from "../visitor/oneOffGate";
import { SmsConsentDirectory } from "../visitor/smsConsent";
import type { ConfirmationBook } from "./confirmations";
import { requireUnit, resolvePropertyId } from "./resolve";
import { persistSession, type OperatorServices } from "./services";
import { operatorUnitName, streetLine, visitorSubject } from "../visitor/identity";
import { operatorWhoLabel } from "./exceptions";
import { currentReservation, findTour, midSentence, nextReservation, tourRef, tourSnapshots, unitNameOf, visitorNameOf, type TourSnapshot } from "./tours";

interface Ctx {
  services: OperatorServices;
  confirmations: ConfirmationBook;
  now: () => Date;
}

function ask(ctx: Ctx, action: string, target: string, fingerprint: string, question: string, details: Record<string, unknown> = {}) {
  const confirmation = ctx.confirmations.issue(action, target, fingerprint, question);
  return {
    status: "needs-confirmation" as const,
    summary: question,
    confirmation,
    instructions: "Ask the operator exactly this question. Call this tool again with confirmationCode only if they clearly say yes.",
    ...details,
  };
}

function redeem(ctx: Ctx, code: string, action: string, target: string, fingerprint: string): void {
  ctx.confirmations.redeem(code, action, target, fingerprint);
}

export async function findTimeRequest(services: OperatorServices, id: string): Promise<{ tour: TourSnapshot; request: TourTimeRequest } | undefined> {
  for (const tour of await tourSnapshots(services)) {
    const request = tour.bundle.tourTimeRequests.find((item) => item.id === id);
    if (request) return { tour, request };
  }
  return undefined;
}

/** First name, or the phone label when unnamed. Never "The visitor" mid-sentence. */
export function who(tour: TourSnapshot): string {
  return operatorWhoLabel(visitorNameOf(tour), tour.visitorPhone);
}

function visitorTextNote(name: string, confirm: boolean, outside: boolean): string {
  const action = confirm ? "to confirm" : "with the new time";
  if (outside) return `This is a one-off. Your regular tour hours stay the same, and ${midSentence(name)} gets a text ${action}.`;
  return `${name} gets a text ${action}.`;
}

function moveFromTo(from: Date, to: Date, _now: Date, tz: string, _outside: boolean): string {
  return `from ${formatTime(from, tz)} on ${formatDay(from, tz)} to ${formatTime(to, tz)} on ${formatDay(to, tz)}`;
}

function operatorDeclineSummary(name: string, reservation: { slotStart?: string; status: string; consentId?: string } | undefined, tz: string): string {
  if (!reservation?.slotStart) return "Declined.";
  const time = formatTime(new Date(reservation.slotStart), tz);
  const day = formatDay(new Date(reservation.slotStart), tz);
  return visitorBookingConfirmed(reservation)
    ? `Declined. ${name}'s ${time} tour on ${day} is still confirmed.`
    : `Declined. ${name} is still booked for ${time} on ${day}.`;
}

function alreadyExpiredResult(visitorWho: string, request: TourTimeRequest) {
  const summary = requestAlreadyExpiredLine(visitorWho);
  return {
    summary,
    expired: true,
    status: "expired" as const,
    reason: summary,
    tourTimeRequestId: request.id,
  };
}

function expiredResult(visitorWho: string, request: TourTimeRequest) {
  const summary = requestTimePassedLine(visitorWho);
  return {
    summary,
    expired: true,
    status: "expired" as const,
    reason: summary,
    tourTimeRequestId: request.id,
  };
}

function proposePassedResult(visitorWho: string, newTime: string, newDay: string, request: TourTimeRequest) {
  const summary = requestProposePassedLine(visitorWho, newTime, newDay);
  return {
    summary,
    expired: true,
    status: "expired" as const,
    reason: summary,
    tourTimeRequestId: request.id,
  };
}

async function expirePassedOnLiveTours(services: OperatorServices): Promise<void> {
  for (const session of services.visitors?.all() ?? []) {
    if (session.kind !== "messaging") continue;
    const expired = await session.core.expirePassedTourTimeRequests();
    if (expired.length) await persistSession(services, session);
  }
}

function moveConfirmQuestion(input: { who: string; from?: Date; to: Date; now: Date; tz: string; outside: boolean; confirm: boolean }): string {
  const lead = input.from
    ? `Move ${midSentence(input.who)}'s tour ${moveFromTo(input.from, input.to, input.now, input.tz, input.outside)}?`
    : `Book ${input.who} for ${timeOnDay(input.to, input.tz)}?`;
  const extra = input.outside ? " That's outside your tour hours." : "";
  const verb = input.from ? "Move it?" : "Book it?";
  return `${lead}${extra} ${visitorTextNote(input.who, input.confirm, input.outside)} ${verb}`;
}

/** Landlord-facing place for the wake question. Never "Main Home". */
function placeOf(tour: TourSnapshot, request: TourTimeRequest): string | undefined {
  const reservation = tour.bundle.reservations.find((item) => item.id === request.reservationId);
  const unitId = request.unitId ?? reservation?.unitId;
  const unit = unitId ? tour.config.units.find((item) => item.id === unitId) : undefined;
  if (!unit) return undefined;
  const named = operatorUnitName(tour.config.property, unit.name).trim();
  if (!named || /^main home$/i.test(named)) {
    const street = streetLine(tour.config.property).trim();
    return street && !/^main home$/i.test(street) ? street : undefined;
  }
  return named;
}

function requestView(tour: TourSnapshot, request: TourTimeRequest, now: Date) {
  const tz = tour.config.property.timezone;
  const reservation = tour.bundle.reservations.find((item) => item.id === request.reservationId);
  const placement = placementOf(tour.config, new Date(request.requestedStartsAt));
  const place = placeOf(tour, request);
  return {
    tourTimeRequestId: request.id,
    tourRef: tourRef(tour.propertyId, tour.tourId),
    visitorName: visitorNameOf(tour),
    unitName: unitNameOf(tour),
    ...(place ? { place } : {}),
    requestedTime: relativeWhen(new Date(request.requestedStartsAt), now, tz),
    ...(reservation?.slotStart ? { currentTime: relativeWhen(new Date(reservation.slotStart), now, tz) } : {}),
    ...(request.proposedAlternativeAt ? { offeredTime: relativeWhen(new Date(request.proposedAlternativeAt), now, tz) } : {}),
    status: request.status === "PENDING" ? "waiting" : request.status.toLowerCase(),
    outsideHours: placement === "OUTSIDE_HOURS",
    regularTime: placement === "ON_GRID",
    ...(request.status === "WITHDRAWN" ? { reason: WITHDRAWN_FOR_REGULAR_BOOKING } : {}),
    ...(request.status === "EXPIRED" ? { reason: requestTimePassedLine(who(tour)) } : {}),
  };
}

function withdrawnResult(request: TourTimeRequest) {
  return {
    summary: WITHDRAWN_FOR_REGULAR_BOOKING,
    withdrawn: true,
    status: "withdrawn" as const,
    reason: WITHDRAWN_FOR_REGULAR_BOOKING,
    tourTimeRequestId: request.id,
  };
}

function requireLive(tour: TourSnapshot) {
  if (!tour.live) throw new SetupInputError("TOUR_NOT_RUNNING", "That tour isn't running right now, so the time can't be changed.");
  return tour.live;
}

function refuseIfPaused(ctx: Ctx, propertyId: string, unitId?: string): void {
  const { config, state } = ctx.services.workspace.load(propertyId);
  const message = operatorPausedBookingRefuse(state, config, unitId);
  if (message) throw new SetupInputError("TOURS_PAUSED", message);
}

export async function listTourTimeRequests(ctx: Ctx, input: { property?: string; includeHandled?: boolean; status?: string }) {
  await expirePassedOnLiveTours(ctx.services);
  const propertyId = input.property ? resolvePropertyId(ctx.services.workspace, input.property) : undefined;
  const filter = input.status?.trim().toLowerCase();
  const includeAll = filter === "all" || !!input.includeHandled;
  const requests = [];
  for (const tour of await tourSnapshots(ctx.services, { propertyId })) {
    for (const request of tour.bundle.tourTimeRequests) {
      if (filter && filter !== "all") {
        const wanted = filter === "waiting" ? "PENDING" : filter.toUpperCase();
        if (request.status !== wanted) continue;
      } else if (!includeAll && request.status !== "PENDING") {
        continue;
      }
      requests.push(requestView(tour, request, ctx.now()));
    }
  }
  const waiting = requests.filter((request) => request.status === "waiting").length;
  return {
    summary: waiting ? `${waiting} ${waiting === 1 ? "person is" : "people are"} waiting on a different tour time.` : "Nobody is waiting on a different tour time.",
    requests,
  };
}

export async function inspectTourTimeRequest(ctx: Ctx, tourTimeRequestId: string) {
  await expirePassedOnLiveTours(ctx.services);
  const found = await findTimeRequest(ctx.services, tourTimeRequestId);
  if (!found) throw new SetupInputError("REQUEST_NOT_FOUND", "I couldn't find that time request.");
  const view = requestView(found.tour, found.request, ctx.now());
  if (found.request.status === "WITHDRAWN") {
    return {
      summary: `${view.visitorName} — ${view.requestedTime}. ${WITHDRAWN_FOR_REGULAR_BOOKING}`,
      ...view,
      note: WITHDRAWN_FOR_REGULAR_BOOKING,
      reason: WITHDRAWN_FOR_REGULAR_BOOKING,
    };
  }
  if (found.request.status === "EXPIRED") {
    const passed = requestTimePassedLine(who(found.tour));
    return {
      summary: `${view.visitorName} — ${view.requestedTime}. ${passed}`,
      ...view,
      note: passed,
      reason: passed,
    };
  }
  const note = view.outsideHours
    ? `${formatTime(new Date(found.request.requestedStartsAt), found.tour.config.property.timezone)} is outside the property's normal ${touringHoursLabel(found.tour.config, new Date(found.request.requestedStartsAt))} touring hours.`
    : view.regularTime
      ? "That is one of the regular tour times."
      : "That isn't one of the regular tour times. Approving it doesn't change the regular schedule.";
  return { summary: `${view.visitorName} — ${view.requestedTime}. ${note}`, ...view, note };
}

export async function approveTourTimeRequest(ctx: Ctx, input: { tourTimeRequestId: string; confirmationCode?: string; acknowledgeOutsideHours?: boolean }) {
  const found = await findTimeRequest(ctx.services, input.tourTimeRequestId);
  if (!found) throw new SetupInputError("REQUEST_NOT_FOUND", "I couldn't find that time request.");
  if (found.request.status === "WITHDRAWN") return withdrawnResult(found.request);
  if (found.request.status === "EXPIRED") return alreadyExpiredResult(who(found.tour), found.request);
  if (found.request.status !== "PENDING") throw new SetupInputError("REQUEST_CLOSED", REQUEST_ALREADY_HANDLED);
  const session = requireLive(found.tour);
  const name = who(found.tour);
  if (new Date(found.request.requestedStartsAt).getTime() <= ctx.now().getTime()) {
    try {
      await session.core.expirePassedTourTimeRequests();
    } catch (err) {
      if (!(err instanceof TourCoreError && err.code === "REQUEST_EXPIRED")) throw err;
    }
    await persistSession(ctx.services, session);
    return expiredResult(name, found.request);
  }
  refuseIfPaused(
    ctx,
    found.tour.propertyId,
    found.request.unitId ?? found.tour.bundle.reservations.find((item) => item.id === found.request.reservationId)?.unitId,
  );
  const tz = found.tour.config.property.timezone;
  const start = new Date(found.request.requestedStartsAt);
  const outside = placementOf(found.tour.config, start) === "OUTSIDE_HOURS";
  const fingerprint = `${found.request.id}|${found.request.requestedStartsAt}|${outside}`;
  const reservation = found.tour.bundle.reservations.find((item) => item.id === found.request.reservationId);
  if (!input.confirmationCode) {
    const question = moveConfirmQuestion({
      who: name,
      ...(reservation?.slotStart ? { from: new Date(reservation.slotStart) } : {}),
      to: start,
      now: ctx.now(),
      tz,
      outside,
      confirm: false,
    });
    return ask(ctx, "approve-time", found.request.id, fingerprint, question, outside ? { outsideHours: true } : {});
  }
  if (outside && !input.acknowledgeOutsideHours) {
    throw new SetupInputError("OUTSIDE_HOURS", "Approving a time outside normal touring hours needs a clear yes to that specifically.");
  }
  redeem(ctx, input.confirmationCode, "approve-time", found.request.id, fingerprint);
  try {
    await session.approveTimeRequest(found.request.id, { outsideTourHours: outside });
  } catch (err) {
    if (err instanceof TourCoreError && err.code === "REQUEST_WITHDRAWN") return withdrawnResult(found.request);
    if (err instanceof TourCoreError && err.code === "REQUEST_EXPIRED") {
      await persistSession(ctx.services, session);
      return expiredResult(name, found.request);
    }
    throw err;
  }
  await persistSession(ctx.services, session);
  return {
    summary: `${name}'s tour is set for ${timeOnDay(start, tz)}. They've been told. The regular tour times are unchanged.`,
    approved: true,
    tourTimeRequestId: found.request.id,
  };
}

export async function declineTourTimeRequest(ctx: Ctx, input: { tourTimeRequestId: string; note?: string }) {
  const found = await findTimeRequest(ctx.services, input.tourTimeRequestId);
  if (!found) throw new SetupInputError("REQUEST_NOT_FOUND", "I couldn't find that time request.");
  if (found.request.status === "WITHDRAWN") return withdrawnResult(found.request);
  if (found.request.status === "EXPIRED") return alreadyExpiredResult(who(found.tour), found.request);
  if (found.request.status !== "PENDING") throw new SetupInputError("REQUEST_CLOSED", REQUEST_ALREADY_HANDLED);
  const session = requireLive(found.tour);
  try {
    await session.declineTimeRequest(found.request.id, input.note);
  } catch (err) {
    if (err instanceof TourCoreError && err.code === "REQUEST_WITHDRAWN") return withdrawnResult(found.request);
    if (err instanceof TourCoreError && err.code === "REQUEST_EXPIRED") {
      await persistSession(ctx.services, session);
      return expiredResult(who(found.tour), found.request);
    }
    throw err;
  }
  await persistSession(ctx.services, session);
  const reservation = found.tour.bundle.reservations.find((item) => item.id === found.request.reservationId);
  return { summary: operatorDeclineSummary(who(found.tour), reservation, found.tour.config.property.timezone), tourTimeRequestId: found.request.id };
}

export async function proposeTourTime(ctx: Ctx, input: { tourTimeRequestId: string; newStartsAt: string }) {
  const found = await findTimeRequest(ctx.services, input.tourTimeRequestId);
  if (!found) throw new SetupInputError("REQUEST_NOT_FOUND", "I couldn't find that time request.");
  if (found.request.status === "WITHDRAWN") return withdrawnResult(found.request);
  if (found.request.status === "EXPIRED") return alreadyExpiredResult(who(found.tour), found.request);
  if (found.request.status !== "PENDING") throw new SetupInputError("REQUEST_CLOSED", REQUEST_ALREADY_HANDLED);
  const session = requireLive(found.tour);
  const tz = found.tour.config.property.timezone;
  const reservation = found.tour.bundle.reservations.find((item) => item.id === found.request.reservationId);
  const contextDay = reservation?.slotStart ? localDateOf(new Date(reservation.slotStart), tz) : localDateOf(new Date(found.request.requestedStartsAt), tz);
  const resolved = parseFlexibleTime(input.newStartsAt, found.tour.config, ctx.now(), contextDay);
  if (!resolved.ok) {
    if (resolved.code === "TIME_PASSED") throw new SetupInputError("SLOT_PAST", SLOT_ALREADY_PASSED);
    throw new SetupInputError("TIME_UNCLEAR", resolved.ask);
  }
  if (resolved.start.getTime() <= ctx.now().getTime()) throw new SetupInputError("SLOT_PAST", SLOT_ALREADY_PASSED);
  try {
    await session.proposeAlternative(found.request.id, resolved.start.toISOString());
  } catch (err) {
    if (err instanceof TourCoreError && err.code === "REQUEST_WITHDRAWN") return withdrawnResult(found.request);
    if (err instanceof TourCoreError && err.code === "REQUEST_EXPIRED") {
      await persistSession(ctx.services, session);
      return proposePassedResult(who(found.tour), formatTime(resolved.start, tz), formatDay(resolved.start, tz), found.request);
    }
    throw err;
  }
  await persistSession(ctx.services, session);
  const visitorWho = who(found.tour);
  const hasBooking = !!reservation?.slotStart && !TERMINAL.includes(reservation.status);
  return {
    summary: hasBooking
      ? `I asked ${midSentence(visitorWho)} about ${timeOnDay(resolved.start, tz)}. Their current booking stays until they say yes.`
      : `Sent ${visitorWho} ${timeOnDay(resolved.start, tz)}. Nothing's booked until they say yes.`,
    tourTimeRequestId: found.request.id,
  };
}

async function tourForReschedule(services: OperatorServices, input: { reservationId?: string; tourRef?: string; visitor?: string }): Promise<TourSnapshot> {
  if (input.tourRef) return findTour(services, input.tourRef);
  const tours = await tourSnapshots(services);
  if (input.reservationId) {
    const tour = tours.find((item) => item.bundle.reservations.some((reservation) => reservation.id === input.reservationId));
    if (!tour) throw new SetupInputError("TOUR_NOT_FOUND", "I couldn't find that tour.");
    return tour;
  }
  if (input.visitor) {
    const needle = input.visitor.trim().toLowerCase();
    const matches = tours.filter((tour) => {
      const name = visitorNameOf(tour).toLowerCase();
      return name === needle || name.startsWith(`${needle} `) || name.split(/\s+/).includes(needle);
    });
    const booked = matches.filter((tour) => {
      const reservation = currentReservation(tour);
      return !!reservation?.slotStart && !TERMINAL.includes(reservation.status);
    });
    const pool = booked.length ? booked : matches;
    if (pool.length === 1) return pool[0]!;
    if (!pool.length) throw new SetupInputError("TOUR_NOT_FOUND", `I couldn't find a tour for ${input.visitor}.`);
    throw new SetupInputError("TOUR_AMBIGUOUS", `More than one tour matches ${input.visitor}.`);
  }
  throw new SetupInputError("TOUR_NOT_FOUND", "Which visitor's tour should move?");
}

export async function rescheduleTour(
  ctx: Ctx,
  input: { reservationId?: string; tourRef?: string; visitor?: string; newStartsAt: string; confirmationCode?: string; acknowledgeOutsideHours?: boolean },
) {
  const tour = await tourForReschedule(ctx.services, input);
  const session = requireLive(tour);
  const reservation = currentReservation(tour);
  refuseIfPaused(ctx, tour.propertyId, reservation?.unitId);
  if (!reservation?.slotStart) throw new SetupInputError("NO_TOUR", `${who(tour)} doesn't have a tour time to move yet.`);
  const tz = tour.config.property.timezone;
  const name = who(tour);
  const issued = input.confirmationCode ? ctx.confirmations.peek(input.confirmationCode) : undefined;
  const laterMoveConfirm = issued?.fingerprint.endsWith("|later");
  const running = isRunningReservation(reservation.status);
  if (running || laterMoveConfirm) {
    const later =
      running
        ? nextReservation(tour, ctx.now())
        : tour.bundle.reservations.find((item) => item.id === issued?.target);
    if (running && !later?.slotStart) throw new SetupInputError("TOUR_IN_PROGRESS", tourInProgressCannotMove(name));
    if (!later?.slotStart) throw new SetupInputError("NO_TOUR", `${name} doesn't have a later booking to move.`);
    const laterStart = new Date(later.slotStart);
    const resolved = parseFlexibleTime(input.newStartsAt, tour.config, ctx.now(), localDateOf(laterStart, tz));
    if (!resolved.ok) throw new SetupInputError("TIME_UNCLEAR", resolved.ask);
    const outside = resolved.placement === "OUTSIDE_HOURS";
    const fingerprint = `${later.id}|${later.updatedAt}|${resolved.start.toISOString()}|${outside}|later`;
    const oldTime = formatTime(laterStart, tz);
    const oldDay = formatDay(laterStart, tz);
    const newTime = formatTime(resolved.start, tz);
    const newDay = formatDay(resolved.start, tz);
    const offer = outside
      ? moveLaterBookingOutsideHours(name, oldTime, oldDay, newTime, newDay)
      : moveLaterBookingInstead(name, oldTime, oldDay, newTime, newDay);
    if (!input.confirmationCode) {
      return ask(ctx, "reschedule-tour", later.id, fingerprint, offer, outside ? { outsideHours: true } : {});
    }
    redeem(ctx, input.confirmationCode, "reschedule-tour", later.id, fingerprint);
    await session.reschedule(resolved.start.toISOString(), { customTime: true, outsideTourHours: outside, notice: "moved", reservationId: later.id });
    await persistSession(ctx.services, session);
    return {
      summary: movedLaterBookingSummary(name, newTime, newDay),
      rescheduled: true,
      tourRef: tourRef(tour.propertyId, tour.tourId),
    };
  }
  const resolved = parseFlexibleTime(input.newStartsAt, tour.config, ctx.now(), localDateOf(new Date(reservation.slotStart), tz));
  if (!resolved.ok) throw new SetupInputError("TIME_UNCLEAR", resolved.ask);
  const outside = resolved.placement === "OUTSIDE_HOURS";
  const fingerprint = `${reservation.id}|${reservation.updatedAt}|${resolved.start.toISOString()}|${outside}`;
  if (!input.confirmationCode) {
    const question = moveConfirmQuestion({
      who: name,
      from: new Date(reservation.slotStart),
      to: resolved.start,
      now: ctx.now(),
      tz,
      outside,
      confirm: false,
    });
    return ask(ctx, "reschedule-tour", reservation.id, fingerprint, question, outside ? { outsideHours: true } : {});
  }
  if (outside && !input.acknowledgeOutsideHours) {
    throw new SetupInputError("OUTSIDE_HOURS", "Moving a tour outside normal touring hours needs a clear yes to that specifically.");
  }
  redeem(ctx, input.confirmationCode, "reschedule-tour", reservation.id, fingerprint);
  await session.reschedule(resolved.start.toISOString(), { customTime: true, outsideTourHours: outside, notice: "moved", reservationId: reservation.id });
  await persistSession(ctx.services, session);
  return {
    summary: `${name}'s tour is now ${relativeWhen(resolved.start, ctx.now(), tz)}. They've been told. The regular tour times are unchanged.`,
    rescheduled: true,
    tourRef: tourRef(tour.propertyId, tour.tourId),
  };
}

export async function scheduleOneOffTour(
  ctx: Ctx,
  input: { property?: string; phone: string; visitorName?: string; unit: string; startsAt: string; confirmationCode?: string; acknowledgeOutsideHours?: boolean },
) {
  await ctx.services.releaseUnconfirmedTours?.();
  const propertyId = resolvePropertyId(ctx.services.workspace, input.property);
  if (!ctx.services.workspace.has(propertyId)) throw new SetupInputError("PROPERTY_NOT_FOUND", "I couldn't find that property.");
  const { config, state } = ctx.services.workspace.load(propertyId);
  if (state.status !== "PUBLISHED_FOR_DEMO" || !isLiveMessaging(config.messagingMode)) {
    throw new SetupInputError("NOT_LIVE", "That property isn't published with live visitor texting, so I can't set up a tour.");
  }
  if (!ctx.services.openMessagingSession) {
    throw new SetupInputError("NOT_LIVE", "Visitor texting isn't live on that property, so I can't set up a tour.");
  }
  const phone = parsePhone(input.phone);
  if (!phone) throw new SetupInputError("PHONE_INVALID", "That phone number doesn't look complete.");
  const optedOut = new SmsConsentDirectory(ctx.services.workspace.root).get(propertyId, phone);
  if (optedOut?.status === "opted_out") {
    throw new SetupInputError("OPTED_OUT", "That number asked us not to text them (STOP), so I can't set up a tour.");
  }
  const existing = ctx.services.visitors?.latestForPhone(propertyId, phone, "messaging");
  if (existing) {
    const blocked = await oneOffBlockReason(existing);
    if (blocked) throw new SetupInputError("TOUR_EXISTS", blocked);
  }
  const unit = requireUnit(config, input.unit);
  const resolved = parseFlexibleTime(input.startsAt, config, ctx.now());
  if (!resolved.ok) {
    if (resolved.code === "TIME_PASSED") throw new SetupInputError("SLOT_PAST", SLOT_ALREADY_PASSED);
    throw new SetupInputError("TIME_UNCLEAR", resolved.ask);
  }
  if (resolved.start.getTime() <= ctx.now().getTime()) throw new SetupInputError("SLOT_PAST", SLOT_ALREADY_PASSED);
  const wanted = tourInterval(config, resolved.start);
  await assertOneOffSlotFree(ctx, propertyId, wanted);
  const outside = resolved.placement === "OUTSIDE_HOURS";
  const tz = config.property.timezone;
  const whoLabel = input.visitorName?.trim() ? input.visitorName.trim().split(/\s+/)[0]! : formatPhone(phone);
  const whenLabel = `on ${formatWeekday(resolved.start, tz)} at ${formatTime(resolved.start, tz)}`;
  const fingerprint = `${propertyId}|${phone}|${unit.id}|${resolved.start.toISOString()}|${outside}`;
  if (!input.confirmationCode) {
    const extra = outside ? " That's outside your tour hours." : "";
    const place = visitorSubject(config.property, unit.name);
    const question = `Set up a tour for ${whoLabel} at ${place} ${whenLabel}? Only say yes if they asked for this tour.${extra} ${visitorTextNote(whoLabel, true, outside)} Book it?`;
    return ask(ctx, "schedule-one-off", `${propertyId}:${phone}`, fingerprint, question, outside ? { outsideHours: true } : {});
  }
  if (outside && !input.acknowledgeOutsideHours) {
    throw new SetupInputError("OUTSIDE_HOURS", "Setting up a tour outside normal touring hours needs a clear yes to that specifically.");
  }
  redeem(ctx, input.confirmationCode, "schedule-one-off", `${propertyId}:${phone}`, fingerprint);
  await assertOneOffSlotFree(ctx, propertyId, wanted);
  const session = await ctx.services.openMessagingSession(propertyId, phone);
  try {
    await session.scheduleOneOff({ unitId: unit.id, start: resolved.start, outsideHours: outside, name: input.visitorName });
    await persistSession(ctx.services, session);
  } catch (err) {
    await session.supersedeForOperatorOneOff();
    await persistSession(ctx.services, session);
    throw err;
  }
  return {
    summary: `I texted ${whoLabel} to confirm a tour of ${visitorSubject(config.property, unit.name)} ${whenLabel}. The regular tour times are unchanged.`,
    scheduled: true,
    tourRef: tourRef(propertyId, session.tourId),
  };
}

/** Running tour and every future or held booking occupy a slot. */
function occupyingReservations(tour: TourSnapshot): Reservation[] {
  return tour.bundle.reservations.filter((reservation) => reservation.slotStart && !TERMINAL.includes(reservation.status));
}

async function assertOneOffSlotFree(ctx: Ctx, propertyId: string, wanted: ReturnType<typeof tourInterval>): Promise<void> {
  for (const tour of await tourSnapshots(ctx.services, { propertyId })) {
    for (const reservation of occupyingReservations(tour)) {
      if (intervalsOverlap(wanted, tourInterval(tour.config, new Date(reservation.slotStart!), reservation.windowEnd ? new Date(reservation.windowEnd) : undefined))) {
        throw new SetupInputError("SLOT_OVERLAP", "That time overlaps another tour.");
      }
    }
  }
}
