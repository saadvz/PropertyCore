import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createMessenger } from "../createTourCore";
import { claimVisitorSms } from "../sms/templates";
import { pauseConfirmQuestion, PROPERTY_REMOVED_REFUSE, REMOVE_REFUSED_LIVE_TOUR, removeConfirmQuestion, removeSetupConfirmQuestion, removedPropertySummary, removedSetupSummary, resumeConfirmQuestion, toursAreBackText } from "../core/availabilityCopy";
import { normalizePhone } from "../core/phone";
import { newId, type AuditEvent, type AuditEventType, type Reservation } from "../domain/model";
import { isRunningReservation } from "../domain/stateMachine";
import { operatorFacingPropertyName, SetupInputError } from "../setup/setupActions";
import { visitorSubject } from "../visitor/identity";
import { isEffectivelyPaused, isRemoved } from "../setup/availability";
import { dropUnitWaiters, dropWaiters, rememberWaiter, uniquePhones, waitersFor } from "../setup/pauseWaiters";
import type { PropertyState, TourRecord } from "../setup/workspace";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { SmsConsentDirectory } from "../visitor/smsConsent";
import { VisitorDemoSession } from "../visitor/session";
import type { ConfirmationBook } from "./confirmations";
import { requireUnit, resolvePropertyId } from "./resolve";
import { persistSession, type OperatorServices } from "./services";
import { isFutureBooking, tourSnapshots, type TourSnapshot } from "./tours";

interface Ctx {
  services: OperatorServices;
  confirmations: ConfirmationBook;
  now: () => Date;
}

export function ask(ctx: Ctx, action: string, target: string, fingerprint: string, question: string, details: Record<string, unknown> = {}) {
  const confirmation = ctx.confirmations.issue(action, target, fingerprint, question);
  return {
    status: "needs-confirmation" as const,
    summary: question,
    confirmation,
    instructions: "Ask the operator exactly this question. Call this tool again with confirmationCode only if they clearly say yes.",
    ...details,
  };
}

export function redeem(ctx: Ctx, code: string, action: string, target: string, fingerprint: string): void {
  ctx.confirmations.redeem(code, action, target, fingerprint);
}

function labelOf(services: OperatorServices, propertyId: string): string {
  return services.workspace.load(propertyId).config.property.name;
}

function unitIdsOf(services: OperatorServices, propertyId: string): string[] {
  return services.workspace.load(propertyId).config.units.map((unit) => unit.id);
}

export function availabilityEventsPath(root: string, propertyId: string): string {
  return join(root, "properties", propertyId, "operator", "availability-events.json");
}

export function readAvailabilityEvents(root: string, propertyId: string): AuditEvent[] {
  const path = availabilityEventsPath(root, propertyId);
  if (!existsSync(path)) return [];
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { events?: AuditEvent[] }).events ?? [];
  } catch {
    return [];
  }
}

export function appendAvailabilityEvent(root: string, propertyId: string, type: AuditEventType, detail: string, at: string, extra: Partial<AuditEvent> = {}): AuditEvent {
  const events = readAvailabilityEvents(root, propertyId);
  const event: AuditEvent = {
    id: extra.id ?? newId("aud"),
    seq: extra.seq ?? events.length + 1,
    type,
    at,
    detail,
    ...(extra.reservationId ? { reservationId: extra.reservationId } : {}),
    ...(extra.prospectId ? { prospectId: extra.prospectId } : {}),
    ...(extra.unitId ? { unitId: extra.unitId } : {}),
    ...(extra.code ? { code: extra.code } : {}),
  };
  writeJsonAtomic(availabilityEventsPath(root, propertyId), { schemaVersion: 1, events: [...events, event] });
  return event;
}

function futureBookingsOn(tour: TourSnapshot, now: Date, unitId?: string): Reservation[] {
  return tour.bundle.reservations.filter((reservation) => isFutureBooking(reservation, now) && (!unitId || reservation.unitId === unitId));
}

function clockOf(services: OperatorServices): Date {
  return services.now?.() ?? new Date();
}

export async function bookedTours(services: OperatorServices, propertyId: string, unitId?: string): Promise<TourSnapshot[]> {
  const tours = await tourSnapshots(services, { propertyId });
  const now = clockOf(services);
  return tours.filter((tour) => futureBookingsOn(tour, now, unitId).length > 0);
}

async function anyoneTouring(services: OperatorServices, propertyId: string): Promise<boolean> {
  return (await tourSnapshots(services, { propertyId })).some((tour) =>
    tour.bundle.reservations.some((reservation) => isRunningReservation(reservation.status)),
  );
}

async function sessionFor(services: OperatorServices, tour: TourSnapshot): Promise<VisitorDemoSession> {
  if (tour.live) return tour.live;
  const record: TourRecord = {
    schemaVersion: 1,
    tourId: tour.tourId,
    kind: tour.kind,
    ranAt: tour.startedAt,
    updatedAt: tour.updatedAt,
    outcome: tour.outcome,
    ...(tour.visitorPhone ? { visitorPhone: tour.visitorPhone } : {}),
    conversation: tour.conversation,
  };
  const session = new VisitorDemoSession(tour.propertyId, tour.config, tour.tourId, { kind: tour.kind, startedAt: new Date(tour.startedAt) });
  await session.hydrate(record, tour.bundle);
  services.visitors?.add(session);
  return session;
}

export async function cancelBooked(
  services: OperatorServices,
  tours: TourSnapshot[],
  propertyWide: boolean,
  reason: string,
  removed = false,
): Promise<number> {
  let cancelled = 0;
  for (const tour of tours) {
    const session = await sessionFor(services, tour);
    let remembered = false;
    const now = clockOf(services);
    for (const reservation of futureBookingsOn(tour, now)) {
      const latest = await session.store.get("reservations", reservation.id);
      if (!latest || !isFutureBooking(latest, now)) continue;
      const before = latest.status;
      const after = await session.operatorChange((core, id) => core.cancelBookedTour(id, { reason, propertyWide, ...(removed ? { removed: true } : {}) }), latest.id);
      if (session.pendingBookingId === latest.id) session.pendingBookingId = undefined;
      if (after.status !== "CANCELLED" || before === "CANCELLED") continue;
      cancelled += 1;
      if (propertyWide && !removed && !remembered) {
        const phone = session.visitor?.phone;
        if (phone) rememberWaiter(services.workspace.root, session.propertyId, { phone, at: (services.now?.() ?? new Date()).toISOString() });
        remembered = true;
      }
    }
    await persistSession(services, session);
  }
  return cancelled;
}

function visitorUnreachable(services: OperatorServices, propertyId: string, phone: string): boolean {
  const sender = normalizePhone(phone);
  if (!sender || sender === "+") return true;
  if (new SmsConsentDirectory(services.workspace.root).get(propertyId, sender)?.status === "opted_out") return true;
  const session = services.visitors?.latestForPhone(propertyId, sender);
  return !!session?.optedOut || session?.smsConsent === "opted_out";
}

function reachableWaitingPhones(services: OperatorServices, propertyId: string, unitId?: string): string[] {
  return uniquePhones(waitersFor(services.workspace.root, propertyId, unitId)).filter((phone) => !visitorUnreachable(services, propertyId, phone));
}

function phonesToNotify(services: OperatorServices, propertyId: string, unitId?: string): string[] {
  if (unitId) {
    const { state } = services.workspace.load(propertyId);
    if (state.paused || isRemoved(state)) return [];
  }
  return reachableWaitingPhones(services, propertyId, unitId);
}

async function notifyWaiters(services: OperatorServices, propertyId: string, unitId: string | undefined, now: Date): Promise<number> {
  if (unitId) {
    const { state } = services.workspace.load(propertyId);
    if (state.paused || isRemoved(state)) return 0;
  }
  const phones = reachableWaitingPhones(services, propertyId, unitId);
  const { config } = services.workspace.load(propertyId);
  const body = toursAreBackText(config.property.address);
  const templateId = claimVisitorSms(body);
  let sent = 0;
  for (const phone of phones) {
    if (visitorUnreachable(services, propertyId, phone)) continue;
    const session = services.visitors?.latestForPhone(propertyId, phone);
    if (session) {
      await session.reply(body);
      await persistSession(services, session);
    } else {
      await createMessenger(config).send({ to: phone, audience: "PROSPECT", body, templateId }).catch(() => undefined);
    }
    appendAvailabilityEvent(services.workspace.root, propertyId, "TOURS_BACK_NOTIFIED", body, now.toISOString(), {
      ...(unitId ? { unitId } : {}),
      ...(session?.prospectId ? { prospectId: session.prospectId } : {}),
    });
    sent += 1;
  }
  if (unitId) dropUnitWaiters(services.workspace.root, propertyId, unitId);
  else dropWaiters(services.workspace.root, propertyId);
  return sent;
}

/** "Unit 1A" stays "Unit 1A". A bare code such as "1A" is "unit 1A". */
export function unitScopeDetail(label: string): string {
  const name = label.trim();
  return /^unit\b/i.test(name) ? name : `unit ${name}`;
}

function pauseTarget(ctx: Ctx, property: string | undefined, unit?: string): { propertyId: string; unitId?: string; label: string; state: PropertyState } {
  const propertyId = resolvePropertyId(ctx.services.workspace, property);
  const { config, state } = ctx.services.workspace.load(propertyId);
  if (isRemoved(state)) throw new SetupInputError("PROPERTY_REMOVED", PROPERTY_REMOVED_REFUSE);
  if (!unit) return { propertyId, label: operatorFacingPropertyName(config), state };
  const matched = requireUnit(config, unit);
  return { propertyId, unitId: matched.id, label: visitorSubject(config.property, matched.name), state };
}

export async function pauseTours(
  ctx: Ctx,
  input: { property?: string; unit?: string; bookedTours?: "keep" | "cancel"; confirmationCode?: string },
) {
  const target = pauseTarget(ctx, input.property, input.unit);
  const booked = await bookedTours(ctx.services, target.propertyId, target.unitId);
  const now = clockOf(ctx.services);
  const fingerprint = `${target.propertyId}|${target.unitId ?? ""}|${booked.flatMap((tour) => futureBookingsOn(tour, now, target.unitId).map((reservation) => `${reservation.id}:${reservation.status}`)).join(",")}`;
  if (!input.confirmationCode) {
    return ask(ctx, "pause-tours", target.propertyId, fingerprint, pauseConfirmQuestion(target.label, booked.length), {
      bookedTours: booked.length,
      ...(target.unitId ? { unit: target.label } : {}),
    });
  }
  if (booked.length && input.bookedTours !== "keep" && input.bookedTours !== "cancel") {
    throw new SetupInputError("BOOKED_TOURS_CHOICE", "Say whether to keep the booked tours or cancel them with a text.");
  }
  redeem(ctx, input.confirmationCode, "pause-tours", target.propertyId, fingerprint);

  const { state } = ctx.services.workspace.load(target.propertyId);
  const next: Partial<PropertyState> = target.unitId
    ? { pausedUnitIds: [...new Set([...(state.pausedUnitIds ?? []), target.unitId])] }
    : { paused: true };
  ctx.services.workspace.patchState(target.propertyId, next);

  const after = ctx.services.workspace.load(target.propertyId);
  const propertyWide = isEffectivelyPaused(after.state, unitIdsOf(ctx.services, target.propertyId));
  let cancelled = 0;
  if (input.bookedTours === "cancel") {
    cancelled = await cancelBooked(ctx.services, booked, propertyWide, "tours paused");
  }

  const scope = target.unitId ? unitScopeDetail(target.label) : labelOf(ctx.services, target.propertyId);
  appendAvailabilityEvent(ctx.services.workspace.root, target.propertyId, "TOURS_PAUSED", `${scope}; ${input.bookedTours === "cancel" ? "cancelled booked tours" : "kept booked tours"}`, ctx.now().toISOString(), {
    ...(target.unitId ? { unitId: target.unitId } : {}),
  });

  return {
    status: "paused",
    summary: target.unitId
      ? `Tours of ${target.label} are paused.${cancelled ? ` ${cancelled} booked ${cancelled === 1 ? "tour was" : "tours were"} cancelled.` : ""}`
      : `Tours at ${target.label} are paused.${cancelled ? ` ${cancelled} booked ${cancelled === 1 ? "tour was" : "tours were"} cancelled.` : ""}`,
    paused: true,
    bookedTours: booked.length,
    cancelled,
  };
}

export async function resumeTours(ctx: Ctx, input: { property?: string; unit?: string; confirmationCode?: string }) {
  const target = pauseTarget(ctx, input.property, input.unit);
  const waiting = phonesToNotify(ctx.services, target.propertyId, target.unitId);
  const fingerprint = `${target.propertyId}|${target.unitId ?? ""}|resume|${waiting.join(",")}`;
  if (!input.confirmationCode) {
    return ask(ctx, "resume-tours", target.propertyId, fingerprint, resumeConfirmQuestion(target.label, waiting.length), {
      waitingVisitors: waiting.length,
    });
  }
  redeem(ctx, input.confirmationCode, "resume-tours", target.propertyId, fingerprint);

  const { state } = ctx.services.workspace.load(target.propertyId);
  if (target.unitId) {
    ctx.services.workspace.patchState(target.propertyId, {
      pausedUnitIds: (state.pausedUnitIds ?? []).filter((id) => id !== target.unitId),
    });
  } else {
    ctx.services.workspace.patchState(target.propertyId, { paused: false, pausedUnitIds: [] });
  }

  const notified = await notifyWaiters(ctx.services, target.propertyId, target.unitId, ctx.now());
  appendAvailabilityEvent(ctx.services.workspace.root, target.propertyId, "TOURS_RESUMED", target.unitId ? unitScopeDetail(target.label) : labelOf(ctx.services, target.propertyId), ctx.now().toISOString(), {
    ...(target.unitId ? { unitId: target.unitId } : {}),
  });

  return {
    status: "resumed",
    summary: target.unitId ? `Tours of ${target.label} can be booked again.` : `Tours at ${target.label} can be booked again.`,
    paused: false,
    notified,
  };
}

function isUnpublished(ctx: Ctx, propertyId: string): boolean {
  return !ctx.services.workspace.wasEverPublished(propertyId);
}

export async function removeProperty(ctx: Ctx, input: { property?: string; confirmationCode?: string }) {
  const propertyId = resolvePropertyId(ctx.services.workspace, input.property);
  const unpublished = isUnpublished(ctx, propertyId);
  const name = operatorFacingPropertyName(ctx.services.workspace.openDraft(propertyId).draft);
  if (!unpublished && isRemoved(ctx.services.workspace.load(propertyId).state)) {
    throw new SetupInputError("PROPERTY_REMOVED", "That property has already been removed.");
  }
  if (await anyoneTouring(ctx.services, propertyId)) {
    throw new SetupInputError("TOUR_IN_PROGRESS", REMOVE_REFUSED_LIVE_TOUR);
  }

  const booked = await bookedTours(ctx.services, propertyId);
  const now = clockOf(ctx.services);
  const fingerprint = `${propertyId}|${booked.flatMap((tour) => futureBookingsOn(tour, now).map((reservation) => `${reservation.id}:${reservation.status}`)).join(",")}`;
  if (!input.confirmationCode) {
    return ask(
      ctx,
      "remove-property",
      propertyId,
      fingerprint,
      unpublished ? removeSetupConfirmQuestion(name) : removeConfirmQuestion(name, booked.length),
      { bookedTours: booked.length },
    );
  }
  redeem(ctx, input.confirmationCode, "remove-property", propertyId, fingerprint);

  if (unpublished) {
    ctx.services.endpoints?.detach(propertyId);
    ctx.services.workspace.removeInProgressSetup(propertyId);
    return { status: "removed", summary: removedSetupSummary(name), cancelled: 0, removed: true };
  }

  const cancelled = await cancelBooked(ctx.services, booked, true, "property removed", true);
  ctx.services.workspace.patchState(propertyId, { removedAt: ctx.now().toISOString(), paused: true });
  dropWaiters(ctx.services.workspace.root, propertyId);
  appendAvailabilityEvent(ctx.services.workspace.root, propertyId, "PROPERTY_REMOVED", name, ctx.now().toISOString());

  return {
    status: "removed",
    summary: removedPropertySummary(name),
    cancelled,
    removed: true,
  };
}
