import { describeHistory, type HistoryEntry } from "../audit/describe";
import type { TourCoreConfig } from "../config/tourCoreConfig";
import { formatPhone } from "../core/phone";
import { formatDay, formatTime } from "../core/timezone";
import type { AccessGrant, Message, Prospect, Reservation } from "../domain/model";
import { UNNAMED_VISITOR } from "../domain/model";
import { isRunningReservation, PAUSED, TERMINAL } from "../domain/stateMachine";
import type { ExportBundle } from "../export/exportBundle";
import { SetupInputError } from "../setup/setupActions";
import { visitorSubject } from "../visitor/identity";
import type { ConversationItem, TourRecord } from "../setup/workspace";
import type { VisitorDemoSession } from "../visitor/session";
import { STATUS_LABELS } from "../visitor/views";
import { AccessWindows } from "./accessWindows";
import type { OperatorServices } from "./services";

/**
 * Read-only views of visitor tours for operator surfaces. Live conversations
 * are read from memory; everything else from the saved tour records, which
 * are canonical. Nothing here changes a tour.
 */

export interface TourSnapshot {
  propertyId: string;
  config: TourCoreConfig;
  tourId: string;
  kind: TourRecord["kind"];
  outcome: TourRecord["outcome"];
  /** The running conversation, when this process has it. Only live tours can be changed. */
  live?: VisitorDemoSession;
  startedAt: string;
  updatedAt: string;
  visitorPhone?: string;
  failure?: string;
  bundle: ExportBundle;
  conversation: ConversationItem[];
}

const SEP = "~";

/** An opaque handle for one tour. Surfaces pass it back; operators never need to see it. */
export function tourRef(propertyId: string, tourId: string): string {
  return `${propertyId}${SEP}${tourId}`;
}

export function parseTourRef(ref: string): { propertyId: string; tourId: string } | undefined {
  const m = /^([a-z0-9_]+)~([A-Za-z0-9_-]+)$/.exec(ref.trim());
  return m ? { propertyId: m[1]!, tourId: m[2]! } : undefined;
}

function fromParts(propertyId: string, config: TourCoreConfig, record: TourRecord, bundle: ExportBundle, live?: VisitorDemoSession): TourSnapshot {
  return {
    propertyId,
    config,
    tourId: record.tourId,
    kind: record.kind,
    outcome: record.outcome,
    live,
    startedAt: record.ranAt,
    updatedAt: record.updatedAt,
    visitorPhone: record.visitorPhone,
    failure: record.failure,
    bundle,
    conversation: record.conversation ?? [],
  };
}

/** Every visitor tour (and optionally practice tours) for one property or all of them, newest first. */
export async function tourSnapshots(services: OperatorServices, options: { propertyId?: string; includePractice?: boolean } = {}): Promise<TourSnapshot[]> {
  const ws = services.workspace;
  const ids = options.propertyId ? [options.propertyId] : ws.list().map((p) => p.config.property.id);
  const out: TourSnapshot[] = [];
  for (const propertyId of ids) {
    if (!ws.has(propertyId)) continue;
    const { config } = ws.load(propertyId);
    const live = new Map((services.visitors?.all() ?? []).filter((s) => s.propertyId === propertyId).map((s) => [s.tourId, s]));
    const seen = new Set<string>();
    for (const record of ws.listTours(propertyId)) {
      if (record.kind === "practice" && !options.includePractice) continue;
      seen.add(record.tourId);
      const session = live.get(record.tourId);
      if (session) {
        const current = await session.record();
        out.push(fromParts(propertyId, session.config, current.record, current.bundle, session));
        continue;
      }
      const saved = ws.loadTour(propertyId, record.tourId);
      if (saved) out.push(fromParts(propertyId, config, saved.record, saved.bundle));
    }
    for (const session of live.values()) {
      if (seen.has(session.tourId)) continue;
      const current = await session.record();
      out.push(fromParts(propertyId, session.config, current.record, current.bundle, session));
    }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function findTour(services: OperatorServices, ref: string): Promise<TourSnapshot> {
  const parsed = parseTourRef(ref);
  const tour = parsed ? (await tourSnapshots(services, { propertyId: parsed.propertyId, includePractice: true })).find((t) => t.tourId === parsed.tourId) : undefined;
  if (!tour) throw new SetupInputError("TOUR_NOT_FOUND", "I couldn't find that tour.");
  return tour;
}

/** The reservation a tour is about: the live conversation's booking, then a held rebook, else the heuristic. */
export function currentReservation(tour: TourSnapshot): Reservation | undefined {
  const reservations = tour.bundle.reservations;
  const live = tour.live;
  if (!live) return pickCurrentReservation(reservations);
  const pointed = live.reservationId ? reservations.find((r) => r.id === live.reservationId) : undefined;
  if (pointed && !TERMINAL.includes(pointed.status)) return pointed;
  const pending = live.pendingBookingId
    ? reservations.find((r) => r.id === live.pendingBookingId && !TERMINAL.includes(r.status))
    : undefined;
  if (pending) return pending;
  if (pointed) return pointed;
  return pickCurrentReservation(reservations);
}

/** In-progress first, then the newest booking still in play, else the latest record. */
export function pickCurrentReservation(reservations: Reservation[]): Reservation | undefined {
  if (!reservations.length) return undefined;
  const running = reservations.find((r) => isRunningReservation(r.status));
  if (running) return running;
  const open = reservations.filter((r) => !TERMINAL.includes(r.status));
  return open.at(-1) ?? reservations.at(-1);
}

export function isFutureBooking(reservation: Reservation, now?: Date): boolean {
  if (!reservation.slotStart || isRunningReservation(reservation.status) || TERMINAL.includes(reservation.status)) return false;
  if (now && Date.parse(reservation.slotStart) <= now.getTime()) return false;
  return true;
}

/** A later booking held while this tour is still running. */
export function nextReservation(tour: TourSnapshot, now?: Date): Reservation | undefined {
  const current = currentReservation(tour);
  return tour.bundle.reservations.filter((r) => isFutureBooking(r, now) && r.id !== current?.id).at(-1);
}

export function visitorNameOf(tour: TourSnapshot): string {
  const r = currentReservation(tour);
  const prospect: Prospect | undefined = tour.bundle.prospects.find((p) => p.id === r?.prospectId) ?? tour.bundle.prospects[0];
  const name = prospect?.name && prospect.name !== UNNAMED_VISITOR ? prospect.name : undefined;
  return name ?? (tour.visitorPhone ? formatPhone(tour.visitorPhone) : "A visitor");
}

export function unitNameOf(tour: TourSnapshot): string | undefined {
  const r = currentReservation(tour);
  const unit = tour.config.units.find((u) => u.id === r?.unitId);
  return unit ? visitorSubject(tour.config.property, unit.name) : undefined;
}

/** Lowercase a leading "A" / "The" so the name reads naturally mid-sentence. */
export function midSentence(name: string): string {
  return name.replace(/^(A|The)(\s)/, (_all, article: string, space: string) => article.toLowerCase() + space);
}

/** Still in play: a reservation that hasn't ended, or a live visitor who hasn't booked yet. */
export function isActive(tour: TourSnapshot): boolean {
  const r = currentReservation(tour);
  if (r) return !TERMINAL.includes(r.status);
  return !!tour.live && tour.outcome === "in-progress";
}

export function isPaused(tour: TourSnapshot): boolean {
  const s = currentReservation(tour)?.status;
  return !!s && PAUSED.includes(s);
}

function stopName(config: TourCoreConfig, doorId: string): string {
  const unit = config.units.find((u) => u.doorId === doorId);
  if (unit) return visitorSubject(config.property, unit.name);
  const door = config.doors.find((d) => d.id === doorId);
  return door?.kind === "ENTRANCE" ? "the entrance" : (door?.name ?? "a door");
}

function currentStep(tour: TourSnapshot): string {
  const r = currentReservation(tour);
  if (!r) return tour.live ? "Choosing a unit" : "Not started";
  const grants: AccessGrant[] = tour.bundle.accessGrants.filter((g) => g.reservationId === r.id);
  if (r.status === "TOURING") {
    const last = grants.at(-1)?.doorId;
    const opened = new Set(grants.map((g) => g.doorId));
    const next = r.allowedRoute.find((d) => !opened.has(d));
    return last ? `At ${stopName(tour.config, last)}${next ? `, next: ${stopName(tour.config, next)}` : ""}` : "Arriving";
  }
  if (r.awaitingVisitorConfirm) return "Waiting for the visitor to confirm";
  if (r.status === "READY") return "Not arrived yet";
  if (r.status === "COMPLETED") return "Left the property";
  return STATUS_LABELS[r.status];
}

function tourTimeOf(reservation: Reservation, tour: TourSnapshot): string | undefined {
  if (!reservation.slotStart) return undefined;
  const tz = tour.config.property.timezone;
  const start = new Date(reservation.slotStart);
  const end = reservation.windowEnd
    ? new Date(reservation.windowEnd)
    : new Date(Date.parse(reservation.slotStart) + tour.config.tourHours.tourLengthMinutes * 60_000);
  return `${formatDay(start, tz)}, ${formatTime(start, tz)}\u2013${formatTime(end, tz)}`;
}

function tourTime(tour: TourSnapshot): string | undefined {
  const r = currentReservation(tour);
  return r ? tourTimeOf(r, tour) : undefined;
}

export function nextBookingOf(tour: TourSnapshot) {
  const next = nextReservation(tour);
  if (!next) return undefined;
  const time = tourTimeOf(next, tour);
  return {
    ...(time ? { tourTime: time } : {}),
    status: STATUS_LABELS[next.status],
  };
}

const SOURCE: Record<TourRecord["kind"], string> = { messaging: "Real phone", "visitor-demo": "Visitor demo", practice: "Practice tour" };

export function statusOf(tour: TourSnapshot): string {
  const r = currentReservation(tour);
  if (r) return STATUS_LABELS[r.status];
  return tour.live ? "Browsing" : "Not started";
}

/** One operator-facing inspect line. Terminal status is not repeated as the step. */
export function inspectTourSummary(view: { visitorName: string; unitName?: string; status: string; currentStep: string }): string {
  const who = `${view.visitorName}${view.unitName ? `, ${view.unitName}` : ""}`;
  return view.currentStep && view.currentStep !== view.status ? `${who}: ${view.status}. ${view.currentStep}.` : `${who}: ${view.status}.`;
}

/** One line per tour, in words an operator uses. */
export function tourSummary(tour: TourSnapshot) {
  return {
    tourRef: tourRef(tour.propertyId, tour.tourId),
    property: tour.config.property.name,
    visitorName: visitorNameOf(tour),
    unitName: unitNameOf(tour),
    tourTime: tourTime(tour),
    ...(nextBookingOf(tour) ? { nextBooking: nextBookingOf(tour) } : {}),
    status: statusOf(tour),
    currentStep: currentStep(tour),
    source: SOURCE[tour.kind],
    active: isActive(tour),
    paused: isPaused(tour),
    /** Only tours running in this Tour Core process can be paused, resumed or called off. */
    canChange: !!tour.live && isActive(tour),
  };
}

export function history(tour: TourSnapshot): HistoryEntry[] {
  return describeHistory(tour.bundle.auditEvents, { ...tour.bundle, operatorName: tour.config.operator.name }, tour.config.property.timezone);
}

/** Active visitor tours this Tour Core is running now. */
export async function listActiveTours(services: OperatorServices, propertyId?: string) {
  const tours = (await tourSnapshots(services, { propertyId })).filter((t) => t.live && isActive(t));
  return tours.map(tourSummary);
}

/** What's happening on one tour: status, latest activity, questions, denials. */
export function inspectTourView(tour: TourSnapshot) {
  const tz = tour.config.property.timezone;
  const timeline = history(tour);
  const messages: Message[] = tour.bundle.messages;
  const failedToVisitor = messages.filter((m) => m.audience === "PROSPECT" && m.deliveryStatus === "FAILED").length;
  const followUp = tour.bundle.auditEvents.find((e) => e.type === "FOLLOW_UP_RESPONSE");
  return {
    ...tourSummary(tour),
    latestActivity: timeline.slice(-8).map((e) => `${e.time}: ${e.text}`),
    questions: timeline.filter((e) => e.dev.type === "QUESTION_UNANSWERED" || e.dev.type === "HELP_REQUESTED" || e.dev.type === "QUESTION_ANSWERED").map((e) => `${e.time}: ${e.text}`),
    accessDenials: timeline.filter((e) => e.dev.type === "ACCESS_DENIED").map((e) => `${e.time}: ${e.text}`),
    accessGrants: AccessWindows.grants(tour),
    denials: AccessWindows.denials(tour),
    recentMessages: tour.conversation.slice(-6).map((m) => ({ from: m.from === "tourcore" ? "Tour Core" : m.from === "visitor" ? "Visitor" : "Demo note", text: m.text, time: formatTime(new Date(m.at), tz) })),
    messageProblems: failedToVisitor ? `${failedToVisitor === 1 ? "1 message" : `${failedToVisitor} messages`} couldn't be delivered to the visitor.` : undefined,
    followUp: followUp ? (followUp.detail === "yes" ? "Wants someone to follow up" : "No follow-up needed") : undefined,
    failure: tour.failure,
  };
}
