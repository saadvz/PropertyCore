import type { Clock } from "../core/clock";
import {
  occupantFromReservation,
  occupantFromTimeRequest,
  extensionAvailability,
  type Occupant,
} from "../core/extensionAvailability";
import {
  EXTENSION_AFTER_T,
  extensionAlreadyUsed,
  extensionGranted,
  extensionUnavailable,
  isLeavingTour,
  isMoreTimeAsk,
  isRebookAccept,
  isT15NoOrAllGood,
  landlordExtensionGranted,
  landlordPlus15,
  landlordPlus5,
  landlordWho,
  knownFirstName,
  plus15Closed,
  plus5CheckIn,
  T15_BARE_YES,
  T15_NO_OR_ALL_GOOD,
  T5_NO_OFFER_BARE_YES,
  t15Questions,
  t5NoOffer,
  t5Offering,
  tourEnded,
} from "../core/overstayCopy";
import { withPropertySlotLock } from "../core/slotLock";
import { bookedClockZone } from "../core/inProgressTour";
import { formatTime } from "../core/timezone";
import type { TourCore } from "../core/TourCore";
import type { Reservation } from "../domain/model";
import { TERMINAL } from "../domain/stateMachine";
import { visitorSubject } from "./identity";
import { normalize, stripFiller } from "../intent/normalize";
import { yesNo } from "../intent/yesNo";
import type { RuntimeStore } from "../storage/runtimeStore";
import type { VisitorDemoSession } from "./session";

export const OVERSTAY_STEPS = ["t15", "t5", "tEnd", "tPlus5", "tPlus15"] as const;
export type OverstayStep = (typeof OVERSTAY_STEPS)[number];

export type OverstayPrompt = "none" | "t15" | "t5-offer" | "t5-no-offer";

export interface OverstayRecord {
  schemaVersion: 1;
  reservationId: string;
  propertyId: string;
  tourId?: string;
  originalWindowEnd: string;
  windowEnd: string;
  startedAt?: string;
  extensionGranted: boolean;
  t5Kind?: "offering" | "no-offer";
  prompt: OverstayPrompt;
  fired: Partial<Record<OverstayStep, string>>;
  /** Window end the last T-5 text was sent against. A new end after an extension gets another T-5. */
  t5ForWindowEnd?: string;
  /** After the no-time line, a yes starts the rebook flow. */
  pendingRebook?: boolean;
  /** Operator resolved the overstay exception — after-close alerts stop. */
  alertClosedAt?: string;
  /** Visitor text failed every retry. Value is the windowEnd for t5, otherwise "1". */
  sendFailed?: Partial<Record<OverstayStep, string>>;
  cancelled?: boolean;
}

export const AFTER_CLOSE_ALERT_MS = 24 * 60 * 60_000;
export const VISITOR_SEND_ATTEMPTS = 3;

export function afterCloseAlertOpen(input: {
  nowMs: number;
  closedAt?: string;
  confirmedLeft: boolean;
  exceptionResolved: boolean;
}): boolean {
  if (input.confirmedLeft || input.exceptionResolved) return false;
  if (!input.closedAt) return false;
  return input.nowMs - Date.parse(input.closedAt) < AFTER_CLOSE_ALERT_MS;
}

const OFFSETS: Record<OverstayStep, number> = {
  t15: -15 * 60_000,
  t5: -5 * 60_000,
  tEnd: 0,
  tPlus5: 5 * 60_000,
  tPlus15: 15 * 60_000,
};

function dueAt(windowEnd: string, step: OverstayStep): number {
  return Date.parse(windowEnd) + OFFSETS[step];
}

/** True when this step's time is due and that time was not before the visitor entered. */
function dueAfterEntry(record: OverstayRecord, step: OverstayStep, nowMs: number): boolean {
  if (record.cancelled || !record.startedAt) return false;
  const when = dueAt(record.windowEnd, step);
  return nowMs >= when && when >= Date.parse(record.startedAt);
}

/** Latest unsent step that is due. Steps whose time passed before entry never fire on entry. */
export function latestDueStep(record: OverstayRecord, nowMs: number): OverstayStep | undefined {
  if (record.cancelled || !record.startedAt) return undefined;
  const end = Date.parse(record.windowEnd);
  if (dueAfterEntry(record, "tPlus15", nowMs) && !record.fired.tPlus15) return "tPlus15";
  if (dueAfterEntry(record, "tPlus5", nowMs) && nowMs < end + OFFSETS.tPlus15 && !record.fired.tPlus5) return "tPlus5";
  if (dueAfterEntry(record, "tEnd", nowMs) && nowMs < end + OFFSETS.tPlus5 && !record.fired.tEnd) return "tEnd";
  if (dueAfterEntry(record, "t5", nowMs) && nowMs < end && record.t5ForWindowEnd !== record.windowEnd && record.sendFailed?.t5 !== record.windowEnd) return "t5";
  if (dueAfterEntry(record, "t15", nowMs) && nowMs < end - 5 * 60_000 && !record.extensionGranted && !record.sendFailed?.t15 && shouldSendT15(record, nowMs)) return "t15";
  return undefined;
}

export function shouldSendT15(record: OverstayRecord, nowMs: number): boolean {
  if (record.fired.t15 || record.extensionGranted || record.cancelled || !record.startedAt) return false;
  const t15 = dueAt(record.windowEnd, "t15");
  const started = Date.parse(record.startedAt);
  if (t15 <= started) return false;
  if (started >= t15) return false;
  if (nowMs >= Date.parse(record.windowEnd)) return false;
  return nowMs >= t15;
}

export class OverstayScheduler {
  private running?: Promise<void>;
  private again = false;

  constructor(
    private readonly runtime: RuntimeStore,
    private readonly options: { clock?: Clock; now?: () => Date } = {},
  ) {}

  private now(): Date {
    return this.options.clock?.now() ?? this.options.now?.() ?? new Date();
  }

  get(reservationId: string): OverstayRecord | undefined {
    return this.runtime.get<OverstayRecord>("overstay", reservationId);
  }

  private put(record: OverstayRecord): OverstayRecord {
    this.runtime.put("overstay", record.reservationId, record);
    return record;
  }

  cancel(reservationId: string): void {
    const existing = this.get(reservationId);
    if (!existing || existing.cancelled) return;
    this.put({ ...existing, cancelled: true, prompt: "none", pendingRebook: false });
  }

  /** Operator resolved the leaving exception: stop after-close alerts. */
  closeAlertWindow(reservationId: string): void {
    const existing = this.get(reservationId);
    if (!existing || existing.alertClosedAt) return;
    this.put({ ...existing, alertClosedAt: this.now().toISOString() });
  }

  private clearOffer(record: OverstayRecord): OverstayRecord {
    const { t5Kind: _dropped, ...rest } = record;
    return this.put({ ...rest, prompt: "none" });
  }

  ensure(reservation: Reservation, propertyId: string, tourId?: string): OverstayRecord {
    const existing = this.get(reservation.id);
    const windowEnd = reservation.windowEnd ?? existing?.windowEnd;
    if (!windowEnd) {
      return existing ?? {
        schemaVersion: 1,
        reservationId: reservation.id,
        propertyId,
        tourId,
        originalWindowEnd: "",
        windowEnd: "",
        extensionGranted: false,
        prompt: "none",
        fired: {},
      };
    }
    if (existing) {
      const startedAt = existing.startedAt ?? (reservation.status === "TOURING" ? reservation.updatedAt : undefined);
      return this.put({
        ...existing,
        windowEnd: reservation.windowEnd ?? existing.windowEnd,
        originalWindowEnd: existing.originalWindowEnd || windowEnd,
        extensionGranted: existing.extensionGranted || !!reservation.extensionGrantedAt,
        ...(startedAt && !existing.startedAt ? { startedAt } : {}),
        ...(tourId && !existing.tourId ? { tourId } : {}),
      });
    }
    return this.put({
      schemaVersion: 1,
      reservationId: reservation.id,
      propertyId,
      ...(tourId ? { tourId } : {}),
      originalWindowEnd: reservation.originalWindowEnd ?? windowEnd,
      windowEnd,
      ...(reservation.status === "TOURING" ? { startedAt: reservation.updatedAt } : {}),
      extensionGranted: !!reservation.extensionGrantedAt,
      prompt: "none",
      fired: {},
    });
  }

  /** Concurrent ticks share one pass so a step cannot fire twice. */
  tickCore(core: TourCore, ctx: { session?: VisitorDemoSession; propertyId?: string; tourId?: string } = {}): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.pass(core, ctx);
      } while (this.again);
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  async tickSession(session: VisitorDemoSession): Promise<void> {
    await this.tickCore(session.core, { session, propertyId: session.propertyId, tourId: session.tourId });
    await session.refreshThread();
  }

  private async pass(core: TourCore, ctx: { session?: VisitorDemoSession; propertyId?: string; tourId?: string }): Promise<void> {
    await core.expirePassedTourTimeRequests();
    const reservations = await core.store.list("reservations");
    for (const reservation of reservations) {
      if (!reservation.windowEnd) continue;
      if (reservation.status === "TOURING" || this.get(reservation.id)) {
        this.ensure(reservation, ctx.propertyId ?? reservation.propertyId, ctx.tourId);
      }
      const record = this.get(reservation.id);
      if (!record || record.cancelled) continue;
      if (reservation.status === "COMPLETED") {
        this.cancel(reservation.id);
        continue;
      }
      if (TERMINAL.includes(reservation.status) && reservation.status !== "EXPIRED") {
        this.cancel(reservation.id);
        continue;
      }
      const step = latestDueStep(record, this.now().getTime());
      if (step) await this.fire(core, reservation.id, step, ctx.session);
    }
  }

  private async markFired(reservationId: string, step: OverstayStep, extra: Partial<OverstayRecord> = {}): Promise<void> {
    const current = this.get(reservationId);
    if (!current) return;
    this.put({ ...current, ...extra, fired: { ...current.fired, [step]: this.now().toISOString() } });
  }

  private async deliverStep(core: TourCore, reservationId: string, body: string): Promise<boolean> {
    if (await core.visitorAlreadyReceived(reservationId, body)) return true;
    for (let attempt = 1; attempt <= VISITOR_SEND_ATTEMPTS; attempt++) {
      if (await core.messageVisitor(reservationId, body, { recordFailure: attempt === VISITOR_SEND_ATTEMPTS })) return true;
    }
    return false;
  }

  private markSendFailed(reservationId: string, step: OverstayStep, token: string): void {
    const current = this.get(reservationId);
    if (!current) return;
    this.put({ ...current, sendFailed: { ...current.sendFailed, [step]: token } });
  }

  private async fire(core: TourCore, reservationId: string, step: OverstayStep, session?: VisitorDemoSession): Promise<void> {
    const claimed = this.get(reservationId);
    if (!claimed || claimed.cancelled) return;
    if (step !== "t5" && claimed.fired[step]) return;
    if (step === "t5" && claimed.t5ForWindowEnd === claimed.windowEnd) return;
    const reservation = await core.getReservation(reservationId);
    if (!reservation) return;
    const prospect = await core.getProspect(reservation.prospectId);
    const place = visitorSubject(core.config.property, core.unitName(reservation));
    const name = knownFirstName(prospect?.name);
    const end = clockLabel(core, reservation, reservation.windowEnd);
    const who = landlordWho(prospect?.name);
    const help = core.visitorHelpNumber();

    if (step === "t15") {
      if (this.now().getTime() >= Date.parse(reservation.windowEnd!)) return;
      if (claimed.sendFailed?.t15) return;
      const body = t15Questions(place, name);
      if (!(await this.deliverStep(core, reservationId, body))) {
        this.markSendFailed(reservationId, step, "1");
        return;
      }
      await this.markFired(reservationId, step, { prompt: "t15" });
      session?.expect("touring", { kind: "t15-questions" });
      return;
    }

    if (step === "t5") {
      if (claimed.sendFailed?.t5 === claimed.windowEnd) return;
      const available = !claimed.extensionGranted && (await this.available(core, reservation));
      const body = available ? t5Offering(place, end, name) : t5NoOffer(place, end, name);
      if (!(await this.deliverStep(core, reservationId, body))) {
        this.markSendFailed(reservationId, step, claimed.windowEnd);
        return;
      }
      const kind = available ? "offering" : "no-offer";
      await this.markFired(reservationId, step, {
        t5Kind: kind,
        prompt: available ? "t5-offer" : "t5-no-offer",
        t5ForWindowEnd: claimed.windowEnd,
      });
      session?.expect("touring", { kind: available ? "t5-extension-offer" : "t5-no-offer" });
      return;
    }

    if (step === "tEnd") {
      const body = tourEnded(place, name);
      await core.revokeGrantsFor(reservationId, "tour window ended");
      await this.markFired(reservationId, step, { prompt: "none", pendingRebook: false });
      const after = this.get(reservationId);
      if (after) this.clearOffer(after);
      await this.deliverStep(core, reservationId, body);
      return;
    }

    if (step === "tPlus5") {
      const body = plus5CheckIn(place);
      await core.alertOperator(reservationId, landlordPlus5(who, place));
      await this.markFired(reservationId, step);
      await this.deliverStep(core, reservationId, body);
      return;
    }

    const closed = plus15Closed(place, help);
    await core.closeTourAsOverstay(reservationId);
    await core.alertOperator(reservationId, landlordPlus15(who, place));
    await this.markFired(reservationId, step, { pendingRebook: false });
    await this.deliverStep(core, reservationId, closed);
  }

  async available(core: TourCore, reservation: Reservation): Promise<boolean> {
    return (await this.availability(core, reservation)).available;
  }

  async availability(core: TourCore, reservation: Reservation) {
    const occupants = (await this.occupants(core, reservation.id)).filter((o) => o.start.toISOString() !== reservation.slotStart);
    return extensionAvailability({ config: core.config, reservation, occupants });
  }

  private async occupants(core: TourCore, exceptId: string): Promise<Occupant[]> {
    const reservations = await core.store.list("reservations");
    const requests = await core.store.list("tourTimeRequests");
    const out: Occupant[] = [];
    for (const reservation of reservations) {
      if (reservation.id === exceptId) continue;
      const occupant = occupantFromReservation(core.config, reservation);
      if (occupant) out.push(occupant);
    }
    for (const request of requests) {
      const occupant = occupantFromTimeRequest(core.config, request);
      if (occupant) out.push(occupant);
    }
    for (const window of await core.extraBusyWindows()) {
      const windowStart = new Date(window.start.getTime() - core.config.tourHours.earlyArrivalMinutes * 60_000);
      out.push({ start: window.start, windowStart, windowEnd: window.end, unitId: "*", doors: ["*"], kind: "booked" });
    }
    return out;
  }

  async handleAsk(core: TourCore, reservationId: string, kind: "natural" | "bare-yes" = "natural"): Promise<string> {
    return withPropertySlotLock(core.config.property.id, () => this.doHandleAsk(core, reservationId, kind));
  }

  private async doHandleAsk(core: TourCore, reservationId: string, kind: "natural" | "bare-yes"): Promise<string> {
    const reservation = await core.getReservation(reservationId);
    if (!reservation?.windowEnd) return EXTENSION_AFTER_T;
    const record = this.ensure(reservation, reservation.propertyId);
    const nowMs = this.now().getTime();
    const end = clockLabel(core, reservation, reservation.windowEnd);
    if (nowMs >= Date.parse(reservation.windowEnd)) return EXTENSION_AFTER_T;
    if (record.extensionGranted || reservation.extensionGrantedAt) return extensionAlreadyUsed(end);

    const offering = record.t5Kind === "offering" || record.prompt === "t5-offer";
    // A bare yes/sure/please only takes the extension after an offering T-5.
    // T-15 asked about questions, not time; an explicit ask uses kind "natural".
    if (kind === "bare-yes" && !offering) return T15_BARE_YES;

    const available = await this.available(core, reservation);
    if (!available) {
      const current = this.get(reservationId)!;
      const { t5Kind: _offer, ...rest } = current;
      this.put({ ...rest, pendingRebook: true, prompt: "none" });
      return extensionUnavailable(end, core.config.operator.name);
    }

    const extended = await core.extendTourWindowLocked(reservationId);
    const newEnd = clockLabel(core, extended, extended.windowEnd);
    const prospect = await core.getProspect(extended.prospectId);
    const place = visitorSubject(core.config.property, core.unitName(extended));
    const fired = this.get(reservationId)!.fired;
    this.put({
      ...this.get(reservationId)!,
      windowEnd: extended.windowEnd!,
      originalWindowEnd: record.originalWindowEnd || record.windowEnd,
      extensionGranted: true,
      prompt: "none",
      pendingRebook: false,
      // Keep T-15 from resending. A later T-5 still fires against the new end.
      fired: { ...fired, t15: fired.t15 ?? this.now().toISOString() },
    });
    await core.alertOperator(reservationId, landlordExtensionGranted(landlordWho(prospect?.name), place, newEnd));
    return extensionGranted(newEnd);
  }

  /** Yes / "sure, another time" after the no-time line. Clears pending-rebook when used. */
  takePendingRebook(reservationId: string, text: string): boolean {
    const record = this.get(reservationId);
    if (!record?.pendingRebook) return false;
    const t = stripFiller(normalize(text));
    if (isMoreTimeAsk(t) || isLeavingTour(t)) return false;
    const yn = yesNo(t);
    if (!(yn.answer === "yes" && yn.confidence >= 0.75) && !isRebookAccept(t)) return false;
    this.put({ ...record, pendingRebook: false, prompt: "none" });
    return true;
  }

  async replyToVisitor(core: TourCore, reservationId: string, text: string): Promise<string | undefined> {
    const reservation = await core.getReservation(reservationId);
    if (!reservation?.windowEnd) return undefined;
    const record = this.get(reservationId);
    const t = stripFiller(normalize(text));
    if (isLeavingTour(t)) return undefined;
    const nowMs = this.now().getTime();

    if (nowMs >= Date.parse(reservation.windowEnd) && (isMoreTimeAsk(t) || (record?.prompt === "t5-offer" && yesNo(t).answer === "yes"))) {
      return EXTENSION_AFTER_T;
    }

    if (record?.prompt === "t15") {
      if (isMoreTimeAsk(t)) {
        this.put({ ...record, prompt: "none" });
        return this.handleAsk(core, reservationId, "natural");
      }
      if (isT15NoOrAllGood(t) || yesNo(t).answer === "no") {
        this.put({ ...record, prompt: "none" });
        return T15_NO_OR_ALL_GOOD;
      }
      if (yesNo(t).answer === "yes" && yesNo(t).confidence >= 0.75 && !isMoreTimeAsk(t)) {
        this.put({ ...record, prompt: "none" });
        return T15_BARE_YES;
      }
      this.put({ ...record, prompt: "none" });
      return undefined;
    }

    const offering = record?.prompt === "t5-offer" || record?.t5Kind === "offering";
    if (offering && record) {
      if (isMoreTimeAsk(t)) return this.handleAsk(core, reservationId, "natural");
      if (yesNo(t).answer === "yes" && yesNo(t).confidence >= 0.75) return this.handleAsk(core, reservationId, "bare-yes");
      if (yesNo(t).answer === "no" || isT15NoOrAllGood(t)) {
        this.clearOffer(record);
        return T5_NO_OFFER_BARE_YES;
      }
      this.clearOffer(record);
      return undefined;
    }

    if (record?.prompt === "t5-no-offer" || record?.t5Kind === "no-offer") {
      if (isMoreTimeAsk(t)) return this.handleAsk(core, reservationId, "natural");
      if (yesNo(t).answer === "yes" && yesNo(t).confidence >= 0.75 && !isMoreTimeAsk(t)) {
        this.put({ ...(record ?? this.ensure(reservation, reservation.propertyId)), prompt: "none" });
        return T5_NO_OFFER_BARE_YES;
      }
    }

    if (isMoreTimeAsk(t)) return this.handleAsk(core, reservationId, "natural");
    return undefined;
  }
}

function clockLabel(core: TourCore, reservation: Reservation, at: string | undefined): string | undefined {
  if (!at) return undefined;
  const zone = bookedClockZone(core.config.property.timezone, reservation);
  return zone ? formatTime(new Date(at), zone) : undefined;
}
