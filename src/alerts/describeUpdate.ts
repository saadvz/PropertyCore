import { placementOf, touringHoursLabel } from "../core/customSlot";
import { formatPhone, looksLikePhone, normalizePhone } from "../core/phone";
import { REQUEST_ALREADY_HANDLED, requestTimePassedLine, WITHDRAWN_FOR_REGULAR_BOOKING } from "../core/TourCore";
import { addDays, formatDay, formatTime, localDateOf } from "../core/timezone";
import { UNNAMED_VISITOR } from "../domain/model";
import { inspectException } from "../operator/exceptions";
import type { OperatorServices } from "../operator/services";
import { currentReservation, findTour, tourRef, tourSnapshots, tourSummary, unitNameOf, visitorNameOf, type TourSnapshot } from "../operator/tours";
import { SetupInputError } from "../setup/setupActions";
import { isIssueEvent, type OperatorEvent } from "./operatorEvents";

/**
 * What an operator update says, read from the canonical records when Grok
 * asks (the webhook itself carries no names). The sentence is Tour Core's,
 * so the landlord hears the same facts however the update reached them.
 */

function firstName(tour: TourSnapshot): string {
  const r = currentReservation(tour);
  const name = (tour.bundle.prospects.find((p) => p.id === r?.prospectId) ?? tour.bundle.prospects[0])?.name;
  return name && name !== UNNAMED_VISITOR ? name.trim().split(/\s+/)[0]! : "A visitor";
}

/** "today at 3:00 PM", "tomorrow at 10:00 AM", "on Wednesday, Sep 30 at 2:00 PM" */
function when(start: Date, now: Date, tz: string): string {
  const day = localDateOf(start, tz);
  const today = localDateOf(now, tz);
  const same = (a: typeof day, b: typeof day) => a.year === b.year && a.month === b.month && a.day === b.day;
  const label = same(day, today) ? "today" : same(day, addDays(today, 1)) ? "tomorrow" : `on ${formatDay(start, tz)}`;
  return `${label} at ${formatTime(start, tz)}`;
}

/** A sentence end, including an ellipsis or one that sits just inside a closing quote or parenthesis. */
const SENTENCE_END = /[.!?…]["'”’)]*$/u;

/**
 * get_inbox label when the visitor has no name and the stored label is a phone
 * number. The full formatted number, not its first chunk. Undefined when the
 * label is a real name.
 */
export function inboxPhoneVisitorLabel(visitorName: string): string | undefined {
  const trimmed = visitorName.trim();
  if (!looksLikePhone(trimmed)) return undefined;
  return `Visitor at ${formatPhone(normalizePhone(trimmed))}`;
}

/** Join an alert summary and the tour status. A finished sentence is not glued on, and a period is never doubled. */
export function joinAlertDetail(summary: string, tourStatus: string): string {
  const left = summary.trim();
  const right = tourStatus.trim();
  if (!right) return left;
  if (!left) return SENTENCE_END.test(right) ? right : `${right}.`;
  const body = SENTENCE_END.test(left) ? `${left} ${right}` : `${left}. ${right}`;
  return SENTENCE_END.test(body) ? body : `${body}.`;
}

export async function describeOperatorUpdate(services: OperatorServices, event: OperatorEvent, now: Date, options?: { inbox?: boolean }) {
  if (event.eventType === "cleaning.update") throw new SetupInputError("UPDATE_INCOMPLETE", "That update is for the cleaning scheduler.");
  if (event.eventType === "installation.test") {
    return { eventType: event.eventType, summary: "Tour updates are connected. I'll let you know about your tours here." };
  }
  if (event.eventType === "tour.time_requested") return describeTimeRequest(services, event, now);
  if (isIssueEvent(event.eventType)) {
    if (!event.exceptionId) throw new SetupInputError("UPDATE_INCOMPLETE", "That update doesn't point at an issue.");
    const x = await inspectException(services, event.exceptionId);
    const phoneLabel = inboxPhoneVisitorLabel(x.visitorName);
    const who = phoneLabel ?? (x.visitorName.startsWith("A visitor") ? x.visitorName : x.visitorName.split(/\s+/)[0]);
    return {
      eventType: event.eventType,
      stillOpen: x.status === "open",
      summary: `${who}${x.unitName ? `, ${x.unitName}` : ""}: ${joinAlertDetail(x.summary, x.tourStatus)}`,
      issue: { exceptionId: x.exceptionId, what: x.title, question: x.question, tourStatus: x.tourStatus, nextSteps: x.nextSteps, tourRef: x.tourRef },
      instructions:
        x.kind === "unanswered-question"
          ? "Ask the operator for the answer itself (not a yes/no). When they give it, use resolve_issue; its question is the only confirmation."
          : x.kind === "handler-failed"
            ? "Ask the operator what to tell the visitor. When they give it, use resolve_issue; it texts them from this number and does not save an approved fact. Ask Send \"{reply}\" to {who}? then after yes it returns Sent to {who}."
            : "Tell the operator what happened. Change nothing unless they ask, through the Work Exception skill.",
    };
  }
  if (!event.tourId) throw new SetupInputError("UPDATE_INCOMPLETE", "That update doesn't point at a tour.");
  const tour = await findTour(services, event.tourId);
  const r = currentReservation(tour);
  const who = firstName(tour);
  const unit = unitNameOf(tour) ?? "their unit";
  const tz = tour.config.property.timezone;
  const slot = r?.slotStart ? when(new Date(r.slotStart), now, tz) : undefined;
  const summary = {
    "tour.booked": `New tour booked: ${who} is scheduled to tour ${unit}${slot ? ` ${slot}` : ""}.`,
    "tour.started": `${who}'s ${unit} tour has started.`,
    "tour.completed": `${who}'s ${unit} tour is complete.`,
    "tour.cancelled": `${who}'s ${unit} tour${slot ? ` ${slot}` : ""} was cancelled.`,
  }[event.eventType];
  return { eventType: event.eventType, summary, tour: tourSummary(tour), instructions: "Post summary as-is in your own short words. Don't act on the tour." };
}

async function describeTimeRequest(services: OperatorServices, event: OperatorEvent, now: Date) {
  if (!event.tourTimeRequestId) throw new SetupInputError("UPDATE_INCOMPLETE", "That update doesn't point at a time request.");
  let match: { tour: TourSnapshot; request: TourSnapshot["bundle"]["tourTimeRequests"][number] } | undefined;
  for (const tour of await tourSnapshots(services, { propertyId: event.propertyId })) {
    const request = tour.bundle.tourTimeRequests.find((item) => item.id === event.tourTimeRequestId);
    if (request) match = { tour, request };
  }
  if (!match) throw new SetupInputError("UPDATE_INCOMPLETE", "That update doesn't point at a time request.");
  const { tour, request } = match;
  const tz = tour.config.property.timezone;
  const who = firstName(tour);
  const unit = unitNameOf(tour) ?? "their unit";
  const requestedAt = new Date(request.requestedStartsAt);
  const requestedClock = formatTime(requestedAt, tz);
  const requested = when(requestedAt, now, tz);
  const reservation = tour.bundle.reservations.find((item) => item.id === request.reservationId) ?? currentReservation(tour);
  const currentAt = reservation?.slotStart ? new Date(reservation.slotStart) : undefined;
  const placement = placementOf(tour.config, requestedAt);
  const asking = currentAt
    ? `${who} is asking to move the ${unit} tour from ${formatTime(currentAt, tz)} to ${requestedClock}.`
    : `${who} is asking to tour ${unit} ${requested}.`;
  const note =
    placement === "OUTSIDE_HOURS"
      ? ` ${requestedClock} is outside the property's normal ${touringHoursLabel(tour.config, requestedAt)} touring hours.`
      : placement === "ON_GRID"
        ? ""
        : ` ${requestedClock} isn't one of the regular tour times.`;
  const choices = currentAt
    ? "Would you like to approve that time, suggest another time, decline the request, or keep the current booking?"
    : "Would you like to approve that time, suggest another time, or decline the request?";
  if (request.status === "WITHDRAWN") {
    return {
      eventType: event.eventType,
      summary: `${who} — ${requested}. ${WITHDRAWN_FOR_REGULAR_BOOKING}`,
      request: {
        tourTimeRequestId: request.id,
        tourRef: tourRef(tour.propertyId, tour.tourId),
        visitorName: visitorNameOf(tour),
        unitName: unitNameOf(tour),
        requestedTime: requested,
        ...(currentAt ? { currentTime: when(currentAt, now, tz) } : {}),
        status: "withdrawn",
      },
      instructions: `${WITHDRAWN_FOR_REGULAR_BOOKING} No decision is needed.`,
    };
  }
  if (request.status === "EXPIRED") {
    return {
      eventType: event.eventType,
      summary: `${who} — ${requested}. ${requestTimePassedLine(who)}`,
      request: {
        tourTimeRequestId: request.id,
        tourRef: tourRef(tour.propertyId, tour.tourId),
        visitorName: visitorNameOf(tour),
        unitName: unitNameOf(tour),
        requestedTime: requested,
        ...(currentAt ? { currentTime: when(currentAt, now, tz) } : {}),
        status: "expired",
      },
      instructions: `${requestTimePassedLine(who)} No decision is needed.`,
    };
  }
  if (request.status !== "PENDING") {
    return {
      eventType: event.eventType,
      summary: `${who} — ${requested}. ${REQUEST_ALREADY_HANDLED}`,
      request: {
        tourTimeRequestId: request.id,
        tourRef: tourRef(tour.propertyId, tour.tourId),
        visitorName: visitorNameOf(tour),
        unitName: unitNameOf(tour),
        requestedTime: requested,
        ...(currentAt ? { currentTime: when(currentAt, now, tz) } : {}),
        status: request.status.toLowerCase(),
      },
      instructions: `${REQUEST_ALREADY_HANDLED} No decision is needed.`,
    };
  }
  return {
    eventType: event.eventType,
    summary: `${asking}${note} ${choices}`,
    outsideHours: placement === "OUTSIDE_HOURS",
    request: {
      tourTimeRequestId: request.id,
      tourRef: tourRef(tour.propertyId, tour.tourId),
      visitorName: visitorNameOf(tour),
      unitName: unitNameOf(tour),
      requestedTime: requested,
      ...(currentAt ? { currentTime: when(currentAt, now, tz) } : {}),
        status: "waiting",
    },
    instructions:
      "A decision is required. Use reply_to_time_request with approve, propose, or decline. For a move the landlord is directing, use schedule_tour. Ask once, using the question Tour Core returns, before approving or moving a tour. A time outside normal touring hours needs the stronger confirmation Tour Core returns. Don't change the property's regular hours. If the time overlaps another tour, say so and don't approve it.",
  };
}
