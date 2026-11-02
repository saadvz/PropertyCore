import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { TourCoreConfig } from "../config/tourCoreConfig";
import { DemoClock } from "../core/clock";
import { pausedPropertyVisitorText, pausedUnitVisitorText, removedPropertyVisitorText } from "../core/availabilityCopy";
import { normalizePhone } from "../core/phone";
import { orList } from "../core/questions";
import { operatorConfirmBy } from "../core/customSlot";
import { bookedClockZone } from "../core/inProgressTour";
import { formatDay, formatLocalDate, formatTime, formatWeekday, isValidTimeZone, localDateOf, UnsetTimeZoneError } from "../core/timezone";
import type { SpokenTime } from "../core/spokenTime";
import { bookingRefusal, isEffectivelyPaused, isRemoved, openUnits, operatorPausedBookingRefuse } from "../setup/availability";
import type { PropertyState } from "../setup/workspace";
import { entryReply, timeMenu } from "./entry";
import { operatorUnitName, visitorTourOf } from "./identity";
import { ONE_OFF_REPLACED_DETAIL } from "./oneOffGate";
import { offerDate } from "./unavailableDay";
import { alreadyAskedLine, bookedForLine, customTimeAskedLine, isLiveHelpReservation, pendingCustomTimeLine, TAKEN_SLOT_OTHER_DAY, takenSlotLine, TourCore, TourCoreError, visitorCancelConfirmFor, visitorCancelDoneFor, type AccessOutcome, type InboundMeta } from "../core/TourCore";
import { isCancelableReservation, PAUSED, TERMINAL } from "../domain/stateMachine";
import { visitorCancelTarget, type VisitorCancelTarget } from "./cancelTarget";
import { isoDate, parseIsoDate, type TourSlot } from "../core/schedule";
import { createDurin, createStore, createVerificationProvider } from "../createTourCore";
import type { TourCoreStore } from "../storage/Store";
import { UNNAMED_VISITOR, type Reservation, type TourTimeRequest } from "../domain/model";
import { countDurinCalls, type CountingDurin } from "../durin/countingDurin";
import type { DeliveryReceipt, MessagingAdapter, OutgoingMessage } from "../messaging/Messenger";
import type { ReplyPrompt } from "../messaging/presentation";
import { toursUnavailableText, visitorTeamName } from "../sms/templates";
import { SetupInputError } from "../setup/setupActions";
import type { ConversationItem, TourRecord } from "../setup/workspace";
import type { ExportBundle } from "../export/exportBundle";
import { isConcreteHelpProblem, isMedicalEmergency, isPlainLanguageStop, keywordOf, type Awaiting, type IntentInterpretation } from "../intent";
import { smsHelpBody, smsStopAck, type SmsCampaignConsent, type SmsConsentStatus } from "./smsConsent";
import type { VerificationLinks } from "./verificationLinks";
import { afterCloseAlertOpen } from "./overstayScheduler";

/**
 * One visitor conversation driving the real Tour Core engine. The same
 * session serves the browser phone (buttons) and a real phone over a
 * messaging provider (typed replies): only the transport passed in differs.
 * Every reply, decision and denial comes from Tour Core itself.
 */

export type VisitorStage =
  | "intro"
  | "choose-unit"
  | "choose-date"
  | "choose-time"
  | "consent"
  | "identity"
  | "ready"
  | "touring"
  | "follow-up"
  | "done"
  | "stopped";

export const VISITOR_DEFAULTS = { name: "Pat Smith", phone: "(555) 010-2000" };

/** Same confirmation line the first one-off text ends with. A leftover menu tap gets only this nudge. */
export const OPERATOR_SCHEDULE_CONFIRM_PROMPT = "Reply YES to confirm, NO to cancel, or STOP to opt out.";

/** First outbound text when the operator sets up a tour for someone who hasn't texted in. */
export function operatorScheduledFirstText(config: TourCoreConfig, start: Date): string {
  const tz = config.property.timezone;
  return `Hi, this is the ${visitorTeamName(config.operator.name)} at ${config.property.address}. We set up a tour for you at ${formatTime(start, tz)} on ${formatWeekday(start, tz)}. ${OPERATOR_SCHEDULE_CONFIRM_PROMPT}`;
}

/** The browser phone: nothing to deliver, the page reads the thread. Replies are phrased for buttons. */
export class WebVisitorTransport implements MessagingAdapter {
  readonly provider = "web-demo";
  readonly presentation = "WEB" as const;
  async send(_message: OutgoingMessage): Promise<DeliveryReceipt> {
    return { provider: this.provider, channel: "WEB", status: "SENT", sentAt: new Date().toISOString() };
  }
}

const Text = z.string();
const ACTIONS = {
  begin: z.object({ name: Text, phone: Text }),
  chooseUnit: z.object({ unitId: Text }),
  chooseTime: z.object({ slotStart: Text }),
  chooseDate: z.object({ date: Text }),
  consent: z.object({ agree: z.boolean() }),
  submitIdentity: z.object({ firstName: Text, lastName: Text, email: Text, phone: Text }),
  arrive: z.object({}),
  atStop: z.object({ doorId: Text }),
  ask: z.object({ question: Text }),
  help: z.object({}),
  finish: z.object({}),
  followUp: z.object({ wantsContact: z.boolean() }),
  demoSkipAhead: z.object({}),
  demoWrongDoor: z.object({}),
};
export type VisitorAction = keyof typeof ACTIONS;

/** Which actions make sense at each stage. Anything else is refused. Property questions can be asked at every stage once someone's there. */
const ALLOWED: Record<VisitorStage, VisitorAction[]> = {
  intro: ["begin"],
  "choose-unit": ["chooseUnit", "ask"],
  "choose-date": ["chooseDate", "ask"],
  "choose-time": ["chooseTime", "ask"],
  consent: ["consent", "ask"],
  identity: ["submitIdentity", "ask"],
  ready: ["arrive", "ask", "help", "demoSkipAhead", "demoWrongDoor"],
  touring: ["atStop", "ask", "help", "finish", "demoWrongDoor"],
  "follow-up": ["followUp", "ask"],
  done: ["ask"],
  stopped: ["help"],
};

export interface QuestionOutcome {
  outcome: "answered" | "unknown" | "which-unit";
  units?: string[];
  /** A fair-housing hold. The open day or time menu is sent again. */
  fairHousing?: boolean;
}

export interface LastAccess {
  doorId: string;
  allowed: boolean;
  code: string;
  durinCalled: boolean;
  durinRequestsBefore: number;
  durinRequestsAfter: number;
}

export interface VisitorSessionOptions {
  realNow?: () => number;
  /** How messages reach the visitor. Defaults to the browser phone. */
  transport?: MessagingAdapter;
  /** "messaging" for a real phone; "visitor-demo" for the browser simulator. */
  kind?: TourRecord["kind"];
  /** Personal identity-form links for visitors on a messaging channel. */
  verificationLinks?: VerificationLinks;
  /** Kept when a conversation is restored from its saved records. */
  id?: string;
  startedAt?: Date;
  /** Canonical tour records. Defaults to the in-memory store (local demo). */
  store?: TourCoreStore;
  storageRead?: () => "live" | "cached" | "stale";
  beforeAccess?: () => Promise<void>;
  /** Other tours on this property that should count as busy. */
  otherBusyStarts?: () => Promise<Date[]>;
  /** Other tours' real held windows (start + effective end, including extensions). */
  otherBusyWindows?: () => Promise<import("../core/customSlot").OccupiedWindow[]>;
  /** Test hook: pause inside the property slot lock. */
  slotLockBarrier?: (op: import("../core/TourCore").SlotLockOp) => Promise<void>;
}

/** How one typed message was read, kept on the visitor's line for developer details. Never model reasoning. */
export type InterpretationNote = NonNullable<ConversationItem["interpretation"]>;

/** Optional details about the visitor's own message that triggered an action. */
export interface Said {
  /** What the visitor actually typed or tapped. */
  text?: string;
  meta?: InboundMeta;
}

export class VisitorDemoSession {
  readonly id: string;
  readonly clock: DemoClock;
  readonly store: TourCoreStore;
  readonly durin: CountingDurin;
  readonly core: TourCore;
  readonly transport: MessagingAdapter;
  readonly kind: TourRecord["kind"];
  readonly startedAt: Date;
  visitor?: { name: string; phone: string };
  prospectId?: string;
  reservationId?: string;
  lastAccess?: LastAccess;
  /** Dates offered before a day is chosen. */
  offeredDates: { date: string; label: string }[] = [];
  /** YYYY-MM-DD once the visitor picked a day. Times in offeredSlots belong to this day. */
  selectedDate?: string;
  /** Times offered at inquiry; typed replies ("2") and buttons both pick from this list. */
  offeredSlots: TourSlot[] = [];
  /** Day menu last shown to the visitor. A later hours change is compared to this, not the rebuilt list. */
  lastShownDates: { date: string; label: string }[] = [];
  /** Time menu last shown to the visitor. */
  lastShownSlots: TourSlot[] = [];
  /** True only for a time menu shown after the current booking was made or moved. */
  slotMenuLive = false;
  /** True only for a day menu shown after the current booking was made or moved. */
  dateMenuLive = false;
  /** The published day list changed since the last day menu this visitor saw. */
  staleDateMenu = false;
  /** The published time list changed since the last time menu this visitor saw. */
  staleTimeMenu = false;
  /** A custom time named before a unit was chosen. Filed once the unit is picked. */
  heldTime?: SpokenTime;
  optedOut = false;
  /**
   * The router's opt-out already tried the 911 line. Skip another visitor text.
   * The team is still alerted.
   */
  suppressMedicalVisitorLine = false;
  /** Ended because the operator set a one-off tour for this phone. */
  superseded = false;
  /**
   * SMS campaign status. Undefined means this sender has not opted in.
   * A phone number or an older tour does not set this.
   */
  smsConsent?: SmsConsentStatus;
  /**
   * keyword_confirm asks for TOUR then YES before property content.
   * disabled starts the conversation immediately. STOP, START and HELP still apply.
   */
  smsConsentMode: "keyword_confirm" | "disabled" = "keyword_confirm";
  /** Last keyword-consent record, so a later STOP keeps the original opt-in time. */
  smsRecord?: SmsCampaignConsent;
  /**
   * Bare cancel on a booked tour promised that START books again.
   * A plain STOP does not set this, so START still asks for YES.
   */
  consentRestoresOnStart = false;
  /** After that START, a greeting stays on this property instead of asking which place. */
  bindNextBooking = false;
  /** Writes the keyword-consent record. Unset in tests that only need memory. */
  persistSmsConsent?: (record: SmsCampaignConsent) => void;
  /** Resolved PUBLIC_BASE_URL. Compliance texts never invent a host. */
  complianceBaseUrl?: () => string | undefined;
  /** The messaging line this visitor texts (E.164), for text-message conversations. */
  line?: string;
  readonly durinLines: string[] = [];
  private readonly thread: ConversationItem[] = [];
  private readonly shown = new Set<string>();
  private readonly links?: VerificationLinks;
  private noted?: InterpretationNote;
  private expected?: { stage: VisitorStage; awaiting: Awaiting };
  /** Where this tour reads the property's current approved content (set by the registry). */
  contentSource?: () => TourCoreConfig | undefined;
  /** Pause / remove status, read at booking time so an operator's pause applies immediately. */
  availabilitySource?: () => PropertyState | undefined;
  /** Records a visitor who was told tours would come back, or who got a paused-unit line. */
  rememberPauseWaiter?: (waiter: { phone: string; unitId?: string; at: string }) => void;
  /** Overstay timeline for this conversation. Set by the messaging router and tests. */
  overstay?: import("./overstayScheduler").OverstayScheduler;
  /** Secondary rebooking while a tour is still the active booking. */
  pendingRebook = false;
  rebookUnitId?: string;
  /** New reservation booked during a running tour; becomes active when that tour ends. */
  pendingBookingId?: string;
  /** Custom-time request filed against a held or current booking. Never overwrites pendingBookingId. */
  pendingCustomRequestId?: string;
  /** Finished tour still waiting on the follow-up question after a held booking was promoted. */
  followUpReservationId?: string;
  /** The active booking was a held rebook that just took over after the tour ended. */
  heldBookingTakenOver = false;
  /**
   * Cancel arrived before anything was booked. Menus are cleared.
   * The next text starts scheduling again; it does not need TOUR.
   */
  schedulingIdle = false;

  private _config: TourCoreConfig;

  constructor(
    readonly propertyId: string,
    config: TourCoreConfig,
    readonly tourId: string,
    options: VisitorSessionOptions = {},
  ) {
    this._config = config;
    this.id = options.id ?? `vd_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.clock = new DemoClock(options.realNow);
    this.startedAt = options.startedAt ?? this.clock.now();
    this.store = options.store ?? createStore(config);
    this.transport = options.transport ?? new WebVisitorTransport();
    this.kind = options.kind ?? "visitor-demo";
    this.durin = countDurinCalls(createDurin(config, this.clock, (line) => this.durinLines.push(line.trim())));
    const links = options.verificationLinks;
    this.links = links;
    this.core = new TourCore({
      config,
      clock: this.clock,
      store: this.store,
      messenger: this.transport,
      durin: this.durin,
      verification: createVerificationProvider(config),
      correlationId: this.id,
      approvedContent: () => this.contentSource?.(),
      availability: (unitId) => {
        const refused = bookingRefusal(this.availabilitySource?.(), this.config, unitId);
        return refused ? { allowed: false, message: refused.message } : undefined;
      },
      storageRead: options.storageRead,
      beforeAccess: options.beforeAccess,
      otherBusyStarts: options.otherBusyStarts,
      otherBusyWindows: options.otherBusyWindows,
      ...(options.slotLockBarrier ? { slotLockBarrier: options.slotLockBarrier } : {}),
      ...(links ? { verificationLink: ({ reservation, prospect }) => links.issue({ sessionId: this.id, reservationId: reservation.id, phone: prospect.phone }) } : {}),
    });
  }

  get config(): TourCoreConfig {
    return this._config;
  }

  get conversation(): readonly ConversationItem[] {
    return this.thread;
  }

  /**
   * Point this open conversation at the property's current published settings.
   * Stage, reservation, pending confirmations and records stay as they are.
   * Returns whether those settings actually changed.
   */
  applyPublishedConfig(next: TourCoreConfig): boolean {
    const changed = JSON.stringify(this._config) !== JSON.stringify(next);
    this._config = next;
    this.core.useConfig(next);
    return changed;
  }

  /**
   * Rebuild the day and time menus from the current published hours.
   * An already-booked reservation is not touched. If the rebuilt menus
   * differ from what the visitor was last shown, numbered replies are
   * not silently remapped — the conversation must re-show the list.
   */
  async refreshOfferedSchedule(): Promise<void> {
    const shownDates = this.lastShownDates.length ? this.lastShownDates : this.offeredDates;
    const shownSlots = this.lastShownSlots.length ? this.lastShownSlots : this.offeredSlots;
    this.offeredDates = (await this.core.availableDates()).map(({ date, label }) => ({ date, label }));
    if (!this.selectedDate) {
      this.offeredSlots = [];
    } else {
      try {
        this.offeredSlots = await this.selectDate(this.selectedDate);
      } catch {
        this.offeredSlots = [];
      }
    }
    if (shownDates.length && !sameDateMenu(shownDates, this.offeredDates)) this.staleDateMenu = true;
    if (shownSlots.length && !sameTimeMenu(shownSlots, this.offeredSlots)) this.staleTimeMenu = true;
  }

  /** The visitor just saw these days. Numbered replies now mean this list. */
  markDatesShown(): void {
    this.lastShownDates = this.offeredDates.map((day) => ({ date: day.date, label: day.label }));
    this.staleDateMenu = false;
    this.dateMenuLive = true;
    this.lastShownSlots = [];
    this.slotMenuLive = false;
  }

  /** The visitor just saw these times. Numbered replies now mean this list. */
  markTimesShown(): void {
    this.lastShownSlots = this.offeredSlots.map((slot) => ({ start: slot.start, label: slot.label }));
    this.staleTimeMenu = false;
    this.slotMenuLive = true;
  }

  /** A booking was created or moved: leftover menus must not pick a time. */
  clearShownMenus(): void {
    this.lastShownSlots = [];
    this.lastShownDates = [];
    this.slotMenuLive = false;
    this.dateMenuLive = false;
  }

  /** What the visitor had been shown (a snapshot), before menus are rebuilt from the current config. */
  rememberShownSchedule(dates: { date: string; label: string }[], slots: TourSlot[]): void {
    this.lastShownDates = dates.map((day) => ({ date: day.date, label: day.label }));
    this.lastShownSlots = slots.map((slot) => ({ start: slot.start, label: slot.label }));
  }

  get presentation() {
    return this.transport.presentation;
  }

  async reservation(): Promise<Reservation | undefined> {
    return this.reservationId ? this.store.get("reservations", this.reservationId) : undefined;
  }

  /** Current name: the visitor's own words, or the legal name from their form once they've filled it in. */
  async visitorName(): Promise<string | undefined> {
    const prospect = this.prospectId ? await this.store.get("prospects", this.prospectId) : undefined;
    const name = prospect?.name ?? this.visitor?.name;
    return name === UNNAMED_VISITOR ? undefined : name;
  }

  async stage(): Promise<VisitorStage> {
    if (this.superseded) return "stopped";
    if (!this.visitor) return "intro";
    const r = await this.reservation();
    if (!r) return "choose-unit";
    if (r.awaitingVisitorConfirm) return "intro";
    if (this.followUpReservationId && (await this.activeNeedsConsent()) && !(await this.hasFollowUpResponse(this.followUpReservationId))) {
      return "follow-up";
    }
    switch (r.status) {
      case "INQUIRY":
        return this.selectedDate ? "choose-time" : "choose-date";
      case "RESERVED":
      case "AWAITING_CONSENT":
        return "consent";
      case "AWAITING_VERIFICATION":
        return "identity";
      case "READY":
        return "ready";
      case "TOURING":
        return "touring";
      case "COMPLETED":
        return (await this.store.listAudit()).some((e) => e.type === "FOLLOW_UP_RESPONSE" && e.reservationId === r.id) ? "done" : "follow-up";
      case "EXPIRED": {
        const audit = await this.store.listAudit();
        const left = audit.some((e) => e.type === "VISITOR_CONFIRMED_LEFT" && e.reservationId === r.id);
        const answered = audit.some((e) => e.type === "FOLLOW_UP_RESPONSE" && e.reservationId === r.id);
        if (left && !answered) return "follow-up";
        return "stopped";
      }
      default:
        return "stopped";
    }
  }

  /** Paused by the team or by a door-system problem: not over, just waiting for the team. */
  async isPaused(): Promise<boolean> {
    const status = (await this.reservation())?.status;
    return !!status && PAUSED.includes(status);
  }

  /** Doors on the reserved route that haven't been opened yet, in order. */
  async remainingStops(): Promise<string[]> {
    const r = await this.reservation();
    if (!r) return [];
    const opened = new Set((await this.core.listGrants(r.id)).map((g) => g.doorId));
    return r.allowedRoute.filter((d) => !opened.has(d));
  }

  offRouteDoor(r: Reservation): string | undefined {
    return this.config.doors.find((d) => !r.allowedRoute.includes(d.id))?.id;
  }

  stopLabel(doorId: string): string {
    return this.core.stopName(doorId);
  }

  /** Runs one visitor action. `said` carries the visitor's real words and provider details when they typed them. */
  async act(action: string, input: unknown, said: Said = {}): Promise<void> {
    const schema = (ACTIONS as Record<string, z.ZodType>)[action];
    if (!schema) throw new SetupInputError("UNKNOWN_ACTION", "That isn't something I can do.");
    const parsed = schema.safeParse(input ?? {});
    if (!parsed.success) throw new SetupInputError("INPUT_INVALID", "Some of that information is missing.");
    if (action === "chooseTime") {
      const reservation = await this.reservation();
      const slotStart = String((parsed.data as { slotStart?: string }).slotStart ?? "");
      if (slotStart && reservation?.slotStart === slotStart && reservation.status !== "INQUIRY") return;
    }
    if (action === "consent" && (parsed.data as { agree?: boolean }).agree !== false) {
      const reservation = await this.reservation();
      if (reservation?.consentId) return;
    }
    const stage = await this.stage();
    if (!ALLOWED[stage].includes(action as VisitorAction)) throw new SetupInputError("NOT_AVAILABLE", "That isn't available right now.");
    try {
      await this.run(action as VisitorAction, parsed.data as Record<string, unknown>, said);
    } catch (err) {
      if (err instanceof UnsetTimeZoneError) {
        await this.reply(toursUnavailableText(this.config.property.name, this.config.operator.name, this.config.operator.visitorContact));
        return;
      }
      throw err;
    }
    await this.syncReplies();
  }

  // ------------------------------------------- messaging-channel entry points

  /** Attaches how the next visitor text was read to its line in the thread. The returned note can still be updated. */
  noteInterpretation(i: IntentInterpretation): InterpretationNote {
    const { type, ...entities } = i.intent as { type: string } & Record<string, string>;
    this.noted = {
      intent: type,
      confidence: Math.round(i.confidence * 100) / 100,
      interpreter: i.interpreter,
      clarification: false,
      ...(Object.keys(entities).length ? { entities } : {}),
      ...(i.manipulation ? { manipulation: true } : {}),
    };
    return this.noted;
  }

  /** Remembers what Tour Core just asked, so a bare "yes" or "2" in the next text means something. */
  expect(stage: VisitorStage, awaiting: Awaiting): void {
    this.expected = { stage, awaiting };
  }

  /** The confirmation Tour Core is waiting on, if any (saved so it survives a restart). */
  get pendingClarification(): { stage: VisitorStage; awaiting: Awaiting } | undefined {
    return this.expected;
  }

  /** Puts back what only the conversation knew: the times offered and an unanswered confirmation. */
  resume(state: { offeredSlots?: TourSlot[]; offeredDates?: { date: string; label: string }[]; selectedDate?: string; pending?: { stage: VisitorStage; awaiting: Awaiting }; heldTime?: SpokenTime }): void {
    if (state.offeredSlots) this.offeredSlots = state.offeredSlots;
    if (state.offeredDates) this.offeredDates = state.offeredDates;
    if (state.selectedDate) this.selectedDate = state.selectedDate;
    this.expected = state.pending;
    if (state.heldTime) this.heldTime = state.heldTime;
  }

  holdTime(time: SpokenTime): void {
    this.heldTime = time;
  }

  takeHeldTime(): SpokenTime | undefined {
    const time = this.heldTime;
    this.heldTime = undefined;
    return time;
  }

  /**
   * Drop a day or time menu when nothing is booked. The inquiry stays.
   * The next text starts scheduling again.
   */
  clearUnbookedSchedule(): void {
    this.selectedDate = undefined;
    this.offeredSlots = [];
    this.heldTime = undefined;
    this.clearShownMenus();
    this.expected = undefined;
    this.staleDateMenu = false;
    this.staleTimeMenu = false;
    this.schedulingIdle = true;
  }

  /** What Tour Core was waiting for, if the conversation is still at the same step. One reply only. */
  takeExpected(stage: VisitorStage): Awaiting | undefined {
    const e = this.expected;
    this.expected = undefined;
    this.noted = undefined;
    return e?.stage === stage ? e.awaiting : undefined;
  }

  /** A visitor on a real phone is known by their number; their name comes later from the identity form. */
  identify(phone: string): void {
    if (!this.visitor) this.visitor = { name: UNNAMED_VISITOR, phone: normalizePhone(phone) };
  }

  /** The first message from a phone ("Hi"): record it and send the welcome. */
  async greet(said: Said): Promise<void> {
    await this.recordText(said);
    await this.welcome();
  }

  /** Stores something the visitor sent that didn't trigger an action (so history is complete). */
  async recordText(said: Said): Promise<void> {
    if (!said.text) return;
    this.say("visitor", said.text);
    await this.core.recordIncoming({ phone: this.visitor?.phone ?? "", body: said.text, prospectId: this.prospectId, reservationId: this.reservationId, meta: said.meta });
  }

  /** A Tour Core message that isn't part of a tour step (welcome, "didn't catch that", help info). */
  async reply(body: string, prompt?: ReplyPrompt, options?: { deliverDespiteOptOut?: boolean; templateId?: string }): Promise<void> {
    await this.core.sendConversationText({
      phone: this.visitor?.phone ?? "",
      body,
      prompt,
      reservationId: this.reservationId,
      deliverDespiteOptOut: options?.deliverDespiteOptOut,
      templateId: options?.templateId,
    });
    await this.syncReplies();
  }

  /** Records the texting opt-in. Booking writes the visit record from that YES. */
  noteSmsConsent(status: SmsConsentStatus, keyword: string): void {
    const sender = normalizePhone(this.visitor?.phone ?? "");
    if (!sender || sender === "+") return;
    const now = this.clock.now().toISOString();
    const previous = this.smsRecord;
    const record: SmsCampaignConsent = {
      sender,
      status,
      method: "keyword",
      keyword,
      updatedAt: now,
      ...(status === "opted_in" ? { optedInAt: previous?.optedInAt ?? now } : previous?.optedInAt ? { optedInAt: previous.optedInAt } : {}),
      ...(status === "opted_out" ? { optedOutAt: now } : previous?.optedOutAt ? { optedOutAt: previous.optedOutAt } : {}),
    };
    this.smsConsent = status;
    this.smsRecord = record;
    this.persistSmsConsent?.(record);
  }

  /** Clears a STOP flag so a re-opt-in disclosure can be delivered. Does not opt the sender into the campaign. */
  async allowMessagingAgain(): Promise<void> {
    this.optedOut = false;
    await this.core.optInToMessaging(this.visitor?.phone ?? "");
  }

  async optOut(said: Said, options?: { reply?: string; keyword?: string; restoreOnStart?: boolean }): Promise<void> {
    await this.recordText(said);
    await this.reply(options?.reply ?? smsStopAck(), undefined, { deliverDespiteOptOut: true });
    this.optedOut = true;
    const raw = (said.text ?? "STOP").trim();
    const keyword = options?.keyword ?? (isPlainLanguageStop(raw) ? "STOP" : raw.toUpperCase());
    this.noteSmsConsent("opted_out", keyword);
    if (options?.restoreOnStart) this.consentRestoresOnStart = true;
    await this.core.optOutOfMessaging(this.visitor?.phone ?? "", keyword);
    await this.syncReplies();
  }

  async optIn(said: Said): Promise<void> {
    await this.recordText(said);
    await this.allowMessagingAgain();
    await this.reply(`You'll get messages from ${visitorTourOf(this.config.property)} again. Text HI any time to start a tour.`);
  }

  /**
   * HELP. Bare HELP or INFO is always the carrier keyword body. On a booked
   * tour that is upcoming, inside its window, or still in progress after the
   * window, that keyword also alerts the team, files the help inbox item, and
   * records HELP_REQUESTED. When the team text goes out, a tour in progress
   * gets the stay-where-you-are line and an upcoming booking gets the remote
   * help line. When it fails, the snag line follows the keyword.
   * A real problem still uses the help ack alone. Finished, canceled, revoked,
   * failed-ID, expired, or not-yet-booked reservations — and unknown numbers —
   * get the keyword reply and no alert.
   */
  async help(said: Said): Promise<void> {
    const text = said.text ?? "HELP";
    if (isMedicalEmergency(text)) {
      const reservation = await this.reservation();
      if (reservation) {
        this.say("visitor", text);
        await this.core.requestHelp(reservation.id, await this.currentPlace(), { text, meta: said.meta });
      } else {
        await this.recordText(said);
        await this.core.requestHelp(undefined, undefined, {
          text,
          meta: said.meta,
          phone: this.visitor?.phone ?? "",
          messagingOptedOut: this.optedOut,
          suppressMedicalVisitorLine: this.suppressMedicalVisitorLine,
        });
      }
      await this.syncReplies();
      return;
    }
    // Bare HELP or INFO is the carrier keyword. A booked or in-progress tour still alerts the team, then sends the remote line, the stay line, or the snag line.
    if (keywordOf(text) === "help") {
      const keywordBody = smsHelpBody(process.env, { visitorContact: this.config.operator.visitorContact });
      const reservation = await this.reservation();
      if (reservation && isLiveHelpReservation(reservation, this.clock.now())) {
        this.say("visitor", text);
        await this.core.requestHelp(reservation.id, await this.currentPlace(), { text, meta: said.meta, keywordBody });
        await this.syncReplies();
        return;
      }
      await this.recordText(said);
      await this.reply(keywordBody, undefined, { deliverDespiteOptOut: true });
      return;
    }
    const reservation = await this.reservation();
    if (reservation && isLiveHelpReservation(reservation, this.clock.now())) {
      this.say("visitor", said.text ?? "HELP");
      await this.core.requestHelp(reservation.id, await this.currentPlace(), { text: said.text ?? "HELP", meta: said.meta });
      await this.syncReplies();
      return;
    }
    if (!reservation && isConcreteHelpProblem(text)) {
      await this.recordText(said);
      await this.core.requestHelp(undefined, undefined, { text, meta: said.meta, phone: this.visitor?.phone ?? "" });
      await this.syncReplies();
      return;
    }
    await this.recordText(said);
    await this.reply(
      smsHelpBody(process.env, { visitorContact: this.config.operator.visitorContact }),
      undefined,
      { deliverDespiteOptOut: this.smsConsent !== "opted_in" },
    );
  }

  /** After a finished tour, distress texts the visitor and alerts the landlord like a +15 close. */
  async alertDistress(said: Said, reservationId?: string): Promise<void> {
    const reservation = reservationId ? await this.store.get("reservations", reservationId) : await this.reservation();
    if (!reservation) {
      await this.help(said);
      return;
    }
    await this.recordText(said);
    await this.core.alertVisitorDistress(reservation.id, said.text ?? "I'm locked in");
    await this.syncReplies();
  }

  /**
   * Answers a property question from approved facts wherever the visitor is:
   * the unit they named or chose (if any) and the property. Nothing about the
   * conversation's own step changes. `unitId` overrides the unit context (the
   * visitor just said which unit they meant).
   */
  /**
   * The current turn's fact picker, set by the conversation only when a language model is configured.
   * Not saved with the session.
   */
  factPicker?: (question: string, facts: string[], options?: { name?: string }) => Promise<number | undefined>;

  async askQuestion(question: string, options: { meta?: InboundMeta; unitId?: string; alreadyRecorded?: boolean; unknownReply?: string; answerSuffix?: string } = {}): Promise<QuestionOutcome> {
    const r = await this.reservation();
    const out = await this.core.answerPropertyQuestion({
      phone: this.visitor?.phone ?? "",
      question,
      reservationId: r?.id,
      unitId: options.unitId ?? r?.unitId,
      ...(options.unitId ? { pickedUnitId: options.unitId } : {}),
      meta: options.meta,
      recordInbound: !options.alreadyRecorded,
      ...(options.unknownReply ? { unknownReply: options.unknownReply } : {}),
      ...(options.answerSuffix ? { answerSuffix: options.answerSuffix } : {}),
      ...(this.factPicker ? { pickFact: this.factPicker } : {}),
    });
    await this.syncReplies();
    return { outcome: out.outcome, ...(out.units ? { units: out.units } : {}), ...(out.fairHousing ? { fairHousing: true } : {}) };
  }

  /** Flags a question for the team and sends `reply` (skipped when they opted out). */
  async flagUnknownQuestion(said: Said, options: { reply: string; alreadyRecorded?: boolean; silent?: boolean }): Promise<void> {
    await this.core.flagUnansweredQuestion({
      phone: this.visitor?.phone ?? "",
      question: said.text ?? "",
      reservationId: this.reservationId,
      meta: said.meta,
      reply: options.reply,
      recordInbound: !options.alreadyRecorded,
      silent: options.silent ?? this.optedOut,
    });
    await this.syncReplies();
  }

  /** Sends a fresh identity-form link (the earlier one stops working). */
  async resendVerificationLink(said: Said): Promise<void> {
    await this.recordText(said);
    const link =
      this.reservationId && this.visitor ? this.links?.issue({ sessionId: this.id, reservationId: this.reservationId, phone: this.visitor.phone }) : undefined;
    await this.reply("Here's your identity form link again. The earlier link no longer works.", { kind: "form", link });
  }

  // ------------------------------------------------------- operator changes

  /** Tour times the operator can move this visitor's tour to. */
  async rescheduleOptions(): Promise<TourSlot[]> {
    return this.reservationId ? this.core.rescheduleOptions(this.reservationId) : [];
  }

  /** Operator action: move the tour. The visitor is told through this conversation's own transport. */
  async reschedule(newStartsAt: string, options: { outsideTourHours?: boolean; customTime?: boolean; notice?: "default" | "moved" | "none"; reservationId?: string } = {}): Promise<{ changed: boolean }> {
    const { reservationId: targetId, ...rest } = options;
    const reservationId = targetId ?? this.reservationId;
    if (!reservationId) throw new SetupInputError("NO_TOUR", "This visitor hasn't booked a tour yet.");
    const reservation = targetId ? await this.store.get("reservations", targetId) : await this.reservation();
    const paused = operatorPausedBookingRefuse(this.pauseState(), this.config, reservation?.unitId);
    if (paused) throw new SetupInputError("TOURS_PAUSED", paused);
    const { changed } = await this.core.rescheduleReservation({ reservationId, newStartsAt, ...rest });
    this.clearShownMenus();
    await this.syncReplies();
    return { changed };
  }

  /** Books one of the regular offered times without recording another visitor line. False when the slot could not be taken (hold, already booked). */
  async bookOffered(slotStart: string): Promise<boolean> {
    const reservation = await this.reservation();
    if (!reservation) throw new SetupInputError("NO_TOUR", "Choose a unit before choosing a time.");
    if (await this.refuseIfPaused(reservation.unitId)) return true;
    if (reservation.slotStart === slotStart && reservation.status !== "INQUIRY") {
      await this.sameSlotBookedReply(reservation);
      return true;
    }
    try {
      const booked = await this.core.reserveSlot(reservation.id, slotStart, reservation.slotStart ? { replace: true } : {});
      if (this.pendingBookingId === reservation.id) this.pendingBookingId = booked.id;
      if (this.reservationId === reservation.id) this.reservationId = booked.id;
    } catch (err) {
      if (err instanceof TourCoreError && err.code === "SLOT_UNCHANGED") {
        await this.sameSlotBookedReply(reservation);
        return true;
      }
      if (err instanceof TourCoreError && err.code === "SLOT_UNAVAILABLE") {
        await this.replyTakenSlot(slotStart, reservation);
        return true;
      }
      if (err instanceof TourCoreError && err.code === "ALREADY_BOOKED") return false;
      throw err;
    }
    this.pendingCustomRequestId = undefined;
    this.clearShownMenus();
    await this.syncReplies();
    return true;
  }

  /** A held or booked future tour — never the tour already in progress. */
  private async futureBookedReservation(current?: Reservation): Promise<Reservation | undefined> {
    const held = await this.pendingBooking();
    const live = (reservation?: Reservation) =>
      !!reservation?.slotStart && reservation.status !== "TOURING" && !TERMINAL.includes(reservation.status);
    if (live(held)) return held;
    if (live(current)) return current;
    return undefined;
  }

  /** Taken regular slot: keep the current booking, never file a custom-time request. */
  private async replyTakenSlot(slotStart: string, current?: Reservation): Promise<void> {
    const tz = this.config.property.timezone;
    const start = new Date(slotStart);
    const time = formatTime(start, tz);
    const day = formatDay(start, tz);
    const stillBooked = await this.futureBookedReservation(current);
    const curStart = stillBooked?.slotStart ? new Date(stillBooked.slotStart) : undefined;
    await this.reply(takenSlotLine(time, day, curStart ? { time: formatTime(curStart, tz), day: formatDay(curStart, tz) } : undefined));
    const active = current ?? (await this.reservation());
    const pending = await this.pendingBooking();
    const mine = (await this.store.list("reservations")).filter((item) => item.prospectId && item.prospectId === active?.prospectId);
    if (active?.status === "OPERATOR_HOLD" || pending?.status === "OPERATOR_HOLD" || mine.some((item) => item.status === "OPERATOR_HOLD") || (await this.isPaused())) return;
    const openSlots = await this.core.availableSlots(localDateOf(start, tz));
    if (openSlots.length) {
      this.offeredSlots = openSlots;
      this.selectedDate = isoDate(localDateOf(start, tz));
      this.markTimesShown();
      const menu = timeMenu(day, openSlots.map((slot) => slot.label));
      await this.reply(menu.body, menu.prompt);
    } else {
      await this.reply(TAKEN_SLOT_OTHER_DAY);
    }
  }

  private async sameSlotBookedReply(reservation: Reservation): Promise<void> {
    if (reservation.consentId && reservation.slotStart) {
      const tz = this.config.property.timezone;
      const start = new Date(reservation.slotStart);
      await this.reply(bookedForLine(formatTime(start, tz), formatDay(start, tz)));
      return;
    }
    if (await this.activeNeedsConsent()) await this.announceHeldBookingConsent(reservation.id);
  }

  /** Asks the property team about a one-off time. An existing booking stays as it is. A request during a running tour is secondary, like a rebook. */
  async requestCustomTime(start: Date, sourceMessageId?: string): Promise<{ created: boolean; request: TourTimeRequest }> {
    const reservation = await this.reservation();
    if (!this.prospectId || !reservation) throw new SetupInputError("NO_TOUR", "Choose a unit before asking for a time.");
    if (await this.refuseIfPaused(reservation.unitId)) return { created: false, request: { id: "", propertyId: this.propertyId, prospectId: this.prospectId, requestedStartsAt: start.toISOString(), requestedEndsAt: start.toISOString(), requestSource: "VISITOR", status: "DECLINED", createdAt: this.clock.now().toISOString() } };
    const running = reservation.status === "TOURING";
    let requestReservationId = reservation.id;
    const held = await this.pendingBooking();
    if (held && held.slotStart && held.status !== "CANCELLED" && held.status !== "REVOKED" && held.status !== "EXPIRED") {
      requestReservationId = held.id;
    } else if (running) {
      if (!this.pendingBookingId) {
        const oldId = this.reservationId;
        await this.inquire(reservation.unitId, { announce: false });
        this.pendingBookingId = this.reservationId;
        this.reservationId = oldId;
      }
      requestReservationId = this.pendingBookingId!;
    }
    const { request, created } = await this.core.createTourTimeRequest({
      prospectId: this.prospectId,
      reservationId: requestReservationId,
      unitId: reservation.unitId,
      requestedStartsAt: start.toISOString(),
      requestSource: "VISITOR",
      ...(sourceMessageId ? { sourceMessageId } : {}),
    });
    if (created) this.pendingCustomRequestId = request.id;
    const tz = this.config.property.timezone;
    const label = formatTime(start, tz);
    const newDay = formatDay(start, tz);
    const target = requestReservationId === held?.id ? held : reservation;
    if (!created) {
      await this.reply(alreadyAskedLine(label, newDay, this.config.operator.name));
    } else if (target.slotStart && (running || target.id === reservation.id)) {
      const currentStart = new Date(target.slotStart);
      await this.reply(customTimeAskedLine(label, newDay, formatTime(currentStart, tz), formatDay(currentStart, tz), this.config.operator.name));
    } else if (running || !reservation.slotStart) {
      await this.reply(`${label} isn't one of the regular tour times, but I can ask the ${visitorTeamName(this.config.operator.name)}. I'll let you know once they respond.`);
    } else {
      const currentStart = new Date(reservation.slotStart);
      await this.reply(customTimeAskedLine(label, newDay, formatTime(currentStart, tz), formatDay(currentStart, tz), this.config.operator.name));
    }
    return { created, request };
  }

  /**
   * Ends a leftover pre-booking conversation so an operator one-off can take
   * its place. Cancels an inquiry with nothing held. Does not text the visitor.
   */
  async supersedeForOperatorOneOff(): Promise<void> {
    this.superseded = true;
    this.expected = undefined;
    this.offeredDates = [];
    this.offeredSlots = [];
    this.selectedDate = undefined;
    this.heldTime = undefined;
    const reservation = await this.reservation();
    if (!reservation || reservation.status !== "INQUIRY") return;
    await this.core.cancelReservation(reservation.id, ONE_OFF_REPLACED_DETAIL);
    for (const request of await this.store.list("tourTimeRequests")) {
      if (request.reservationId === reservation.id && request.status === "PENDING") {
        await this.store.put("tourTimeRequests", {
          ...request,
          status: "SUPERSEDED",
          resolvedAt: this.clock.now().toISOString(),
          operatorNote: ONE_OFF_REPLACED_DETAIL,
        });
      }
    }
  }

  /**
   * Operator set a tour for this phone: reserve the one-off time and wait for
   * the visitor's YES. Does not change tour hours.
   */
  async scheduleOneOff(input: { unitId: string; start: Date; outsideHours: boolean; name?: string }): Promise<Reservation> {
    if (input.name?.trim() && this.visitor) this.visitor = { ...this.visitor, name: input.name.trim() };
    if (!this.visitor) throw new SetupInputError("PHONE_MISSING", "I need the visitor's phone number.");
    await this.inquire(input.unitId, { announce: false });
    if (input.name?.trim() && this.prospectId) {
      const prospect = await this.store.get("prospects", this.prospectId);
      if (prospect && (prospect.name === UNNAMED_VISITOR || !prospect.name)) {
        await this.store.put("prospects", { ...prospect, name: input.name.trim() });
      }
    }
    const confirmBy = operatorConfirmBy(input.start, this.clock.now());
    const reservation = await this.core.bookCustomSlot(this.reservationId!, input.start.toISOString(), {
      outsideTourHours: input.outsideHours,
      holdForVisitorConfirm: { confirmBy },
    });
    this.expect("intro", { kind: "confirm-operator-tour", confirmBy: confirmBy.toISOString() });
    this.noteSmsConsent("pending", "YES");
    this.clearShownMenus();
    await this.reply(operatorScheduledFirstText(this.config, input.start), undefined, { deliverDespiteOptOut: true });
    return reservation;
  }

  async confirmOperatorSchedule(): Promise<void> {
    if (!this.reservationId) throw new SetupInputError("NO_TOUR", "This visitor hasn't booked a tour yet.");
    await this.core.confirmOperatorScheduledTour(this.reservationId);
    await this.syncReplies();
  }

  async declineOperatorSchedule(): Promise<void> {
    if (!this.reservationId) throw new SetupInputError("NO_TOUR", "This visitor hasn't booked a tour yet.");
    await this.core.declineOperatorScheduledTour(this.reservationId);
    await this.syncReplies();
  }

  /** Flags a question for the team without dropping the YES hold. */
  async flagQuestionWhileAwaitingConfirm(said: Said): Promise<void> {
    await this.core.flagUnansweredQuestion({
      phone: this.visitor?.phone ?? "",
      question: said.text ?? "",
      reservationId: this.reservationId,
      meta: said.meta,
      reply: `I'll check with the ${visitorTeamName(this.config.operator.name)} and get back to you.`,
    });
    await this.syncReplies();
  }

  async releaseUnconfirmedOperatorTour(): Promise<void> {
    await this.core.releaseExpiredOperatorScheduled();
    await this.settleOperatorConfirmPrompt();
    await this.syncReplies();
  }

  /**
   * True when this session is waiting on an operator-scheduled confirm, so the
   * caller still needs to save. Clears that prompt once the hold is gone.
   */
  async settleOperatorConfirmPrompt(): Promise<boolean> {
    const waiting = this.expected?.awaiting.kind === "confirm-operator-tour";
    if (!waiting) return false;
    const reservation = await this.reservation();
    if (reservation?.awaitingVisitorConfirm?.kind !== "OPERATOR_SCHEDULED") this.expected = undefined;
    return true;
  }

  async approveTimeRequest(requestId: string, options: { outsideTourHours?: boolean } = {}) {
    const reservation = await this.reservation();
    const paused = operatorPausedBookingRefuse(this.pauseState(), this.config, reservation?.unitId);
    if (paused) throw new SetupInputError("TOURS_PAUSED", paused);
    const result = await this.core.approveTourTimeRequest(requestId, options);
    this.clearShownMenus();
    await this.syncReplies();
    if (result.needsConsentAsk) await this.announceHeldBookingConsent(result.reservation.id);
    return result;
  }

  async declineTimeRequest(requestId: string, note?: string) {
    const request = await this.core.declineTourTimeRequest(requestId, note);
    await this.syncReplies();
    return request;
  }

  async proposeAlternative(requestId: string, startsAt: string) {
    const request = await this.core.proposeTourTime(requestId, startsAt);
    this.expect(await this.stage(), { kind: "confirm-alternative", requestId, startsAt: request.proposedAlternativeAt! });
    await this.syncReplies();
    return request;
  }

  async acceptAlternative(requestId: string) {
    const reservation = await this.reservation();
    if (await this.refuseIfPaused(reservation?.unitId)) return;
    const result = await this.core.acceptProposedTime(requestId);
    this.clearShownMenus();
    await this.syncReplies();
    if (result.needsConsentAsk) await this.announceHeldBookingConsent(result.reservation.id);
    return result;
  }

  async declineAlternative(requestId: string) {
    const request = await this.core.declineProposedTime(requestId);
    await this.syncReplies();
    return request;
  }

  async cancelTarget(): Promise<VisitorCancelTarget | undefined> {
    return visitorCancelTarget({ current: await this.reservation(), later: await this.pendingBooking() });
  }

  async hasCancelableTour(): Promise<boolean> {
    return !!(await this.cancelTarget());
  }

  cancelConfirmLine(reservation: Reservation, laterWhileTouring = false): string | undefined {
    const zone = bookedClockZone(this.config.property.timezone, reservation);
    if (!zone) return undefined;
    return visitorCancelConfirmFor(reservation, zone, laterWhileTouring);
  }

  /** Visitor confirmed cancel-by-text: revoke doors, cancel, audit, then the short done line. */
  async cancelBookedTour(said: Said, laterWhileTouring = false): Promise<"cancelled" | "failed"> {
    await this.recordText(said);
    const target = await this.cancelTarget();
    try {
      if (!target || !isCancelableReservation(target.reservation)) {
        throw new SetupInputError("NOT_CANCELABLE", "This tour can't be cancelled from here.");
      }
      await this.core.cancelTourByVisitor(target.reservation.id);
      this.clearShownMenus();
      if (this.pendingBookingId === target.reservation.id) this.pendingBookingId = undefined;
      const start = target.reservation.slotStart ? new Date(target.reservation.slotStart) : undefined;
      const zone = bookedClockZone(this.config.property.timezone, target.reservation);
      const later = laterWhileTouring || target.laterWhileTouring;
      await this.reply(start && zone ? visitorCancelDoneFor(formatDay(start, zone), formatTime(start, zone), later) : visitorCancelDoneFor("", "", later && !!zone));
      return "cancelled";
    } catch {
      await this.core.flagVisitorCancelFailed({
        phone: this.visitor?.phone ?? "",
        text: said.text ?? "cancel",
        reservationId: target?.reservation.id ?? this.reservationId,
        meta: said.meta,
        recordInbound: false,
      });
      await this.syncReplies();
      return "failed";
    }
  }

  async reportCancelFailed(said: Said): Promise<void> {
    await this.recordText(said);
    await this.core.flagVisitorCancelFailed({
      phone: this.visitor?.phone ?? "",
      text: said.text ?? "cancel",
      reservationId: this.reservationId,
      meta: said.meta,
      recordInbound: false,
    });
    await this.syncReplies();
  }

  /**
   * Operator action on this visitor's reservation (hold, resume, revoke) through
   * the engine; anything Tour Core tells the visitor goes out on this
   * conversation's own transport.
   */
  async operatorChange<T>(run: (core: TourCore, reservationId: string) => Promise<T>, reservationId = this.reservationId): Promise<T> {
    const id = reservationId ?? this.reservationId;
    if (!id) throw new SetupInputError("NO_TOUR", "This visitor hasn't booked a tour yet.");
    const result = await run(this.core, id);
    this.clearShownMenus();
    await this.syncReplies();
    return result;
  }

  /** Developer mode only: the tour starts this minute, even outside tour hours. The clock is not touched. */
  async moveTourToNow(): Promise<{ changed: boolean }> {
    const start = new Date(Math.floor(this.clock.now().getTime() / 60_000) * 60_000);
    return this.reschedule(start.toISOString(), { outsideTourHours: true });
  }

  /** Rebuilds a conversation from its saved records (used after the server restarts). */
  async hydrate(record: TourRecord, bundle: ExportBundle): Promise<void> {
    for (const p of bundle.prospects) await this.store.put("prospects", p);
    for (const r of bundle.reservations) await this.store.put("reservations", r);
    for (const c of bundle.consents) await this.store.put("consents", c);
    for (const v of bundle.verifications) await this.store.put("verifications", v);
    for (const g of bundle.accessGrants) await this.store.put("accessGrants", g);
    for (const request of bundle.tourTimeRequests ?? []) await this.store.put("tourTimeRequests", request);
    for (const m of bundle.messages) {
      await this.store.put("messages", m);
      this.shown.add(m.id);
    }
    for (const e of bundle.auditEvents) await this.store.appendAudit(e);
    this.thread.push(...(record.conversation ?? []));
    const prospect = bundle.prospects[0];
    const phone = prospect?.phone ?? record.visitorPhone;
    if (phone) this.visitor = { name: prospect?.name ?? UNNAMED_VISITOR, phone };
    this.prospectId = prospect?.id;
    this.reservationId = bundle.reservations.find((r) => r.status === "TOURING")?.id ?? bundle.reservations.at(-1)?.id;
    this.optedOut = !!prospect?.messagingOptedOut;
  }

  // ------------------------------------------------------------------ actions

  private async run(action: VisitorAction, input: Record<string, unknown>, said: Said): Promise<void> {
    const r = await this.reservation();
    const doorName = (id: string) => this.config.doors.find((d) => d.id === id)?.name ?? "a door";
    const visitorSays = async (fallback: string) => {
      const text = said.text ?? fallback;
      this.say("visitor", text);
      await this.inbound(text, said.meta);
    };
    switch (action) {
      case "begin": {
        const name = String(input.name ?? "").trim();
        const phone = normalizePhone(String(input.phone ?? ""));
        if (!name) throw new SetupInputError("NAME_MISSING", "Please enter a name.");
        if (phone.replace(/\D/g, "").length < 10) throw new SetupInputError("PHONE_INVALID", "Please enter a full phone number.");
        this.visitor = { name, phone };
        await this.welcome();
        return;
      }
      case "chooseUnit": {
        const unit = this.config.units.find((u) => u.id === input.unitId);
        if (!unit) throw new SetupInputError("UNIT_NOT_FOUND", "That unit isn't available.");
        const text = said.text ?? `I'd like to see ${unit.name}.`;
        this.say("visitor", text);
        if (await this.refuseIfPaused(unit.id)) {
          if (this.prospectId) await this.core.recordInbound(this.prospectId, this.reservationId, text, said.meta);
          return;
        }
        await this.inquire(unit.id);
        await this.core.recordInbound(this.prospectId!, this.reservationId, text, said.meta);
        return;
      }
      case "chooseDate": {
        const date = String(input.date);
        const local = parseIsoDate(date);
        const label = local ? formatLocalDate(local, this.config.property.timezone) : date;
        this.say("visitor", said.text ?? label);
        if (await this.refuseIfPaused(r?.unitId)) return;
        await offerDate(this, date);
        return;
      }
      case "chooseTime": {
        const start = new Date(String(input.slotStart));
        const label = Number.isNaN(start.getTime()) ? String(input.slotStart) : formatTime(start, this.config.property.timezone);
        await visitorSays(`${label} works for me.`);
        if (await this.refuseIfPaused(r?.unitId)) return;
        try {
          await this.core.reserveSlot(r!.id, String(input.slotStart));
        } catch (err) {
          if (err instanceof TourCoreError && err.code === "TOURS_PAUSED") {
            await this.reply(err.message);
            return;
          }
          if (err instanceof TourCoreError && err.code === "SLOT_UNCHANGED") {
            this.clearShownMenus();
            return;
          }
          if (err instanceof TourCoreError && err.code === "SLOT_UNAVAILABLE") {
            await this.replyTakenSlot(String(input.slotStart), r);
            return;
          }
          throw err;
        }
        this.clearShownMenus();
        return;
      }
      case "consent":
        await visitorSays(input.agree ? "Yes, that's OK." : "No thanks.");
        await this.core.recordConsent(r!.id, !!input.agree);
        return;
      case "submitIdentity": {
        this.say("visitor", said.text ?? `Sent my details: ${input.firstName} ${input.lastName}, ${input.email}, ${input.phone}`);
        await this.inbound("Submitted the identity form.", said.meta);
        await this.core.submitVerification(r!.id, {
          responseId: `visitor_form_${this.id}`,
          submittedAt: this.clock.now().toISOString(),
          answers: {
            governmentFirstName: String(input.firstName),
            governmentLastName: String(input.lastName),
            email: String(input.email),
            phone: String(input.phone),
          },
        });
        return;
      }
      case "arrive":
        await visitorSays("I'm here.");
        await this.requestDoor(r!.allowedRoute[0]!);
        return;
      case "atStop": {
        // Any door on file may be asked for; Tour Core's policy decides. Doors off the route are refused before Durin.
        if (!this.config.doors.some((d) => d.id === input.doorId)) throw new SetupInputError("DOOR_NOT_FOUND", "I don't know that door.");
        await visitorSays(`I'm at ${this.stopLabel(String(input.doorId))}.`);
        await this.requestDoor(String(input.doorId));
        return;
      }
      case "ask": {
        this.say("visitor", said.text ?? String(input.question).trim());
        const out = await this.askQuestion(String(input.question), { meta: said.meta });
        // The browser phone asks again with the unit named; a text conversation handles this itself (see conversation.ts).
        if (out.outcome === "which-unit" && !said.text) await this.reply(`Which unit do you mean: ${orList(out.units ?? [])}?`);
        return;
      }
      case "help":
        return this.help({ ...said, text: said.text ?? "I need help" });
      case "finish":
        await visitorSays("I'm done with the tour.");
        await this.core.completeTour(r!.id);
        this.followUpReservationId = r!.id;
        return;
      case "followUp": {
        const followUpId = this.followUpReservationId ?? r!.id;
        this.say("visitor", said.text ?? (input.wantsContact ? "Yes, please." : "No, thanks."));
        await this.core.recordFollowUpResponse(followUpId, !!input.wantsContact, { text: said.text ?? (input.wantsContact ? "Yes" : "No"), meta: said.meta });
        this.followUpReservationId = undefined;
        this.promotePendingBookingIfEnded();
        if (await this.activeNeedsConsent()) await this.announceHeldBookingConsent();
        else await this.announceUnapprovedCustomTime();
        return;
      }
      case "demoSkipAhead": {
        const windowStart = Date.parse(r!.windowStart!);
        const slot = Date.parse(r!.slotStart!);
        if (this.clock.now().getTime() >= windowStart) throw new SetupInputError("ALREADY_OPEN", "Your tour time has already started.");
        this.clock.jumpTo(new Date(Math.max(windowStart, slot - 2 * 60_000)));
        this.say("demo", `Demo: the clock skipped ahead to ${formatTime(this.clock.now(), this.config.property.timezone)}, just before the tour.`);
        return;
      }
      case "demoWrongDoor": {
        const wrong = this.offRouteDoor(r!) ?? "demo_door_not_on_file";
        await visitorSays(`I'm at ${doorName(wrong)}.`);
        const access = await this.requestDoor(wrong);
        await this.syncReplies();
        this.say(
          "demo",
          !access.decision.allowed && !access.durinCalled
            ? "Demo safety check: Tour Core kept this door locked because it's not on their route."
            : "Demo safety check FAILED: this door should not have opened.",
        );
        return;
      }
    }
  }

  /** After the no-time line: offer days as a secondary flow. The running tour stays the active booking. */
  async beginRebook(): Promise<{ date: string; label: string }[]> {
    const current = await this.reservation();
    if (!current) return [];
    this.rebookUnitId = current.unitId;
    this.pendingRebook = true;
    this.offeredDates = (await this.core.availableDates()).map(({ date, label }) => ({ date, label }));
    this.selectedDate = undefined;
    this.offeredSlots = [];
    this.markDatesShown();
    return this.offeredDates;
  }

  /** Books the rebooked time. Creates a new reservation only on confirm; a running tour stays active. */
  async confirmRebook(slotStart: string): Promise<void> {
    const current = await this.reservation();
    if (await this.refuseIfPaused(this.rebookUnitId ?? current?.unitId)) return;
    const held = await this.pendingBooking();
    if (held?.slotStart && held.status !== "OPERATOR_HOLD" && held.status !== "PROVIDER_FAILURE" && held.status !== "TOURING" && held.status !== "COMPLETED" && held.status !== "CANCELLED" && held.status !== "REVOKED" && held.status !== "EXPIRED") {
      try {
        await this.core.reserveSlot(held.id, slotStart, { replace: true });
      } catch (err) {
        if (err instanceof TourCoreError && err.code === "SLOT_UNCHANGED") {
          if (held.status === "AWAITING_CONSENT" && !held.consentId) await this.announceHeldBookingConsent(held.id);
          else if (held.slotStart) {
            const tz = this.config.property.timezone;
            const start = new Date(held.slotStart);
            await this.reply(bookedForLine(formatTime(start, tz), formatDay(start, tz)));
          }
          return;
        }
        if (err instanceof TourCoreError && err.code === "TOURS_PAUSED") {
          await this.reply(err.message);
          return;
        }
        if (err instanceof TourCoreError && err.code === "SLOT_UNAVAILABLE") {
          await this.replyTakenSlot(slotStart, held);
          return;
        }
        throw err;
      }
      this.pendingCustomRequestId = undefined;
      this.pendingRebook = false;
      this.rebookUnitId = undefined;
      this.clearShownMenus();
      await this.syncReplies();
      return;
    }
    const unitId = this.rebookUnitId ?? current?.unitId;
    if (!unitId) throw new SetupInputError("UNIT_NOT_FOUND", "That unit isn't available.");
    const keepActive = current?.status === "TOURING";
    const oldId = this.reservationId;
    const createdInquiry = !current || current.status !== "INQUIRY";
    if (createdInquiry) {
      await this.inquire(unitId, { announce: false });
    }
    const inquiryId = this.reservationId;
    try {
      const booked = await this.core.reserveSlot(this.reservationId!, slotStart);
      this.reservationId = booked.id;
    } catch (err) {
      if (keepActive && oldId) this.reservationId = oldId;
      if (createdInquiry && inquiryId && inquiryId !== oldId) {
        await this.core.cancelReservation(inquiryId, "requested time was taken").catch(() => undefined);
      }
      if (err instanceof TourCoreError && err.code === "TOURS_PAUSED") {
        await this.reply(err.message);
        return;
      }
      if (err instanceof TourCoreError && err.code === "SLOT_UNAVAILABLE") {
        await this.replyTakenSlot(slotStart, current);
        return;
      }
      throw err;
    }
    this.pendingRebook = false;
    this.rebookUnitId = undefined;
    if (keepActive && oldId) {
      this.pendingBookingId = this.reservationId;
      this.reservationId = oldId;
    }
    this.clearShownMenus();
    await this.syncReplies();
  }

  async pendingBooking(): Promise<Reservation | undefined> {
    return this.pendingBookingId ? this.store.get("reservations", this.pendingBookingId) : undefined;
  }

  async pendingBookingNeedsConsent(): Promise<boolean> {
    const pending = await this.pendingBooking();
    return !!pending && pending.status === "AWAITING_CONSENT" && !pending.consentId;
  }

  async activeNeedsConsent(): Promise<boolean> {
    const active = await this.reservation();
    return !!active && active.status === "AWAITING_CONSENT" && !active.consentId;
  }

  async hasFollowUpResponse(reservationId: string): Promise<boolean> {
    return (await this.store.listAudit()).some((e) => e.type === "FOLLOW_UP_RESPONSE" && e.reservationId === reservationId);
  }

  /** Booked-for line, then the usual next steps. The texting opt-in already covers the visit record. */
  async announceHeldBookingConsent(reservationId?: string): Promise<void> {
    const active = reservationId ? await this.store.get("reservations", reservationId) : await this.reservation();
    if (!active?.slotStart || active.status !== "AWAITING_CONSENT" || active.consentId) return;
    const start = new Date(active.slotStart);
    const tz = this.config.property.timezone;
    await this.reply(bookedForLine(formatTime(start, tz), formatDay(start, tz)));
    await this.core.recordConsent(active.id, true);
    await this.syncReplies();
    this.clearShownMenus();
    this.heldBookingTakenOver = false;
  }

  /**
   * A booking left on the old visit-record question. The first texting YES
   * already covers it, so the next text finishes the booking.
   */
  async finishVisitRecordFromTextingOptIn(said: Said = {}): Promise<boolean> {
    const reservation = await this.reservation();
    if (!reservation || reservation.consentId || reservation.status !== "AWAITING_CONSENT") return false;
    if (said.text) await this.recordText(said);
    await this.core.recordConsent(reservation.id, true);
    await this.syncReplies();
    return true;
  }

  /** Same grant for a booking held beside a tour that is still running. */
  async grantPendingVisitRecord(): Promise<boolean> {
    const pending = await this.pendingBooking();
    if (!pending || pending.consentId || pending.status !== "AWAITING_CONSENT") return false;
    await this.core.recordConsent(pending.id, true);
    await this.syncReplies();
    return true;
  }

  /** Unapproved custom-time request still waiting on the property team. */
  async unapprovedCustomTimeRequest(): Promise<TourTimeRequest | undefined> {
    const requests = await this.store.list("tourTimeRequests");
    if (this.pendingCustomRequestId) {
      const named = requests.find((request) => request.id === this.pendingCustomRequestId && request.status === "PENDING");
      if (named) return named;
    }
    const ids = new Set([this.reservationId, this.pendingBookingId].filter((id): id is string => !!id));
    return requests.find((request) => request.status === "PENDING" && request.reservationId && ids.has(request.reservationId));
  }

  /** A held or booked future regular tour that is still live. */
  async hasLiveRegularTour(): Promise<boolean> {
    for (const id of [this.pendingBookingId, this.reservationId]) {
      if (!id) continue;
      const reservation = await this.store.get("reservations", id);
      if (reservation?.slotStart && reservation.status !== "CANCELLED" && reservation.status !== "REVOKED" && reservation.status !== "EXPIRED" && reservation.status !== "COMPLETED") {
        return true;
      }
    }
    return false;
  }

  /** After a tour ends, tell the visitor their custom-time request is still with the team. Once per request. */
  async announceUnapprovedCustomTime(): Promise<boolean> {
    await this.core.expirePassedTourTimeRequests();
    const request = await this.unapprovedCustomTimeRequest();
    if (!request || request.pendingNoticeSentAt) return false;
    const start = new Date(request.requestedStartsAt);
    const tz = this.config.property.timezone;
    const offerRegularTimes = !(await this.hasLiveRegularTour());
    await this.reply(pendingCustomTimeLine(formatTime(start, tz), formatDay(start, tz), { offerRegularTimes, team: this.config.operator.name }));
    await this.core.markPendingCustomTimeNotice(request.id);
    this.clearShownMenus();
    return true;
  }

  async pendingBookingNeedsVerification(): Promise<boolean> {
    const pending = await this.pendingBooking();
    return !!pending && pending.status === "AWAITING_VERIFICATION";
  }

  async answerPendingConsent(agree: boolean, said: Said): Promise<void> {
    if (!this.pendingBookingId) return;
    await this.recordText(said);
    await this.core.recordConsent(this.pendingBookingId, agree);
    await this.syncReplies();
  }

  async resendPendingVerification(said: Said): Promise<void> {
    if (!this.pendingBookingId || !this.visitor) return;
    await this.recordText(said);
    const link = this.links?.issue({ sessionId: this.id, reservationId: this.pendingBookingId, phone: this.visitor.phone });
    await this.reply("Here's your identity form link again. The earlier link no longer works.", { kind: "form", link });
  }

  /** When the running tour has ended, the pending booking becomes the active one. */
  promotePendingBookingIfEnded(): boolean {
    if (!this.pendingBookingId) return false;
    const currentId = this.reservationId;
    if (currentId === this.pendingBookingId) {
      this.pendingBookingId = undefined;
      return false;
    }
    this.reservationId = this.pendingBookingId;
    this.pendingBookingId = undefined;
    this.heldBookingTakenOver = true;
    return true;
  }

  async promotePendingBookingIfTourEnded(): Promise<boolean> {
    if (!this.pendingBookingId) return false;
    if (await this.afterCloseStillOpen()) return false;
    const current = await this.reservation();
    if (!current) return this.promotePendingBookingIfEnded();
    if (current.status === "COMPLETED") {
      if (!(await this.hasFollowUpResponse(current.id))) return false;
      return this.promotePendingBookingIfEnded();
    }
    if (current.status === "EXPIRED") {
      const left = await this.core.hasConfirmedLeftAfterClose(current.id);
      if (left && !(await this.hasFollowUpResponse(current.id))) return false;
      return this.promotePendingBookingIfEnded();
    }
    // Called off, cancelled, or otherwise ended: the held rebook takes over.
    if (TERMINAL.includes(current.status)) return this.promotePendingBookingIfEnded();
    return false;
  }

  /** After-close alerts and the leaving issue are still open — do not promote a held booking. */
  async afterCloseStillOpen(): Promise<boolean> {
    const current = await this.reservation();
    if (!current || current.status !== "EXPIRED") return false;
    if (await this.core.hasConfirmedLeftAfterClose(current.id)) return false;
    const closedAt = (await this.store.listAudit()).find((e) => e.type === "TOUR_OVERSTAY_CLOSED" && e.reservationId === current.id)?.at;
    return afterCloseAlertOpen({
      nowMs: this.clock.now().getTime(),
      closedAt,
      confirmedLeft: false,
      exceptionResolved: !!this.overstay?.get(current.id)?.alertClosedAt,
    });
  }

  private async inquire(unitId: string, options: { announce?: boolean } = {}): Promise<void> {
    if (!isValidTimeZone(this.config.property.timezone)) throw new UnsetTimeZoneError();
    const { prospect, reservation } = await this.core.startInquiry({ ...this.visitor!, unitId }, options);
    this.prospectId = prospect.id;
    this.reservationId = reservation.id;
    this.offeredDates = await this.core.availableDates();
    this.selectedDate = undefined;
    this.offeredSlots = [];
    if (options.announce !== false) this.markDatesShown();
  }

  /** Times for one day. An empty list means that day has no open regular tours. */
  async selectDate(date: string): Promise<TourSlot[]> {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) throw new SetupInputError("DATE_INVALID", "That date isn't valid.");
    const day = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    this.selectedDate = date;
    this.offeredSlots = await this.core.availableSlots(day);
    return this.offeredSlots;
  }

  /**
   * The first thing a visitor hears: one message, named by the canonical
   * address and an operator-given name only when there is one. A single-family
   * home offers its next regular times; a building asks which unit.
   */
  offerableUnits() {
    return openUnits(this.config.units, this.availabilitySource?.());
  }

  private pauseState(): PropertyState | undefined {
    return this.availabilitySource?.();
  }

  private propertyPausedCopy(): string {
    return pausedPropertyVisitorText(this.config.property.address, this.config.operator.name, this.config.operator.visitorContact);
  }

  private notePauseWaiter(unitId?: string): void {
    const phone = this.visitor?.phone;
    if (!phone || phone === "+") return;
    this.rememberPauseWaiter?.({ phone, at: this.clock.now().toISOString(), ...(unitId ? { unitId } : {}) });
  }

  async refuseIfPaused(unitId?: string): Promise<boolean> {
    const state = this.pauseState();
    const unitIds = this.config.units.map((unit) => unit.id);
    if (state && isRemoved(state)) {
      await this.reply(removedPropertyVisitorText(this.config.property.address, this.config.operator.visitorContact));
      return true;
    }
    if (state && isEffectivelyPaused(state, unitIds)) {
      await this.reply(this.propertyPausedCopy());
      this.notePauseWaiter(unitId);
      return true;
    }
    if (unitId && state) {
      const refused = bookingRefusal(state, this.config, unitId);
      if (refused?.reason === "paused-unit") {
        const open = this.offerableUnits();
        if (!open.length) {
          await this.reply(this.propertyPausedCopy());
          this.notePauseWaiter(unitId);
          return true;
        }
        const paused = this.config.units.find((unit) => unit.id === unitId);
        await this.reply(`${pausedUnitVisitorText(paused ? operatorUnitName(this.config.property, paused.name) : "That unit")}\n\nWhich unit would you like to see?`, {
          kind: "choose",
          options: open.map((unit) => unit.name),
          what: "a unit",
        });
        this.notePauseWaiter(unitId);
        return true;
      }
    }
    return false;
  }

  async welcome(): Promise<void> {
    if (await this.refuseIfPaused()) return;
    if (!isValidTimeZone(this.config.property.timezone)) throw new UnsetTimeZoneError();
    const open = this.offerableUnits();
    const only = this.config.units.length === 1 ? open.find((unit) => unit.id === this.config.units[0]!.id) : undefined;
    if (only && !this.reservationId) await this.inquire(only.id, { announce: false });
    const { body, prompt } = entryReply(this.config, this.offeredDates, open);
    await this.reply(body, prompt);
    if (prompt?.kind === "choose" && prompt.what === "a day") this.markDatesShown();
  }

  private async currentPlace(): Promise<string | undefined> {
    const last = this.reservationId ? (await this.core.listGrants(this.reservationId)).at(-1) : undefined;
    return last ? this.config.doors.find((d) => d.id === last.doorId)?.name : undefined;
  }

  private async requestDoor(doorId: string): Promise<AccessOutcome> {
    const before = this.durin.requestCount;
    const outcome = await this.core.requestAccess({ reservationId: this.reservationId!, prospectId: this.prospectId!, doorId });
    this.lastAccess = {
      doorId,
      allowed: outcome.decision.allowed,
      code: outcome.decision.code,
      durinCalled: outcome.durinCalled,
      durinRequestsBefore: before,
      durinRequestsAfter: this.durin.requestCount,
    };
    return outcome;
  }

  private async inbound(text: string, meta?: InboundMeta): Promise<void> {
    if (this.prospectId) await this.core.recordInbound(this.prospectId, this.reservationId, text, meta);
  }

  private say(from: ConversationItem["from"], text: string): void {
    const item: ConversationItem = { from, text, at: this.clock.now().toISOString() };
    if (from === "visitor" && this.noted) {
      item.interpretation = this.noted;
      this.noted = undefined;
    }
    this.thread.push(item);
  }

  /** Pulls new Tour Core texts into the visitor thread (used after a scheduled overstay step). */
  async refreshThread(): Promise<void> {
    await this.syncReplies();
  }

  /** Appends Tour Core's new messages to the visitor thread (read from the store, in order), with delivery details. */
  private async syncReplies(): Promise<void> {
    for (const m of await this.store.list("messages")) {
      if (m.audience !== "PROSPECT" || m.direction !== "OUTBOUND") continue;
      const existing = this.thread.find((t) => t.messageId === m.id);
      const delivery = { provider: m.provider, channel: m.deliveryChannel, status: m.deliveryStatus, providerMessageId: m.providerMessageId };
      if (existing) {
        existing.delivery = delivery;
        continue;
      }
      if (this.shown.has(m.id)) continue;
      this.shown.add(m.id);
      this.thread.push({ from: "tourcore", text: m.body, at: m.at, messageId: m.id, delivery });
    }
  }

  async record(): Promise<{ record: TourRecord; bundle: ExportBundle }> {
    const stage = await this.stage();
    const r = await this.reservation();
    const name = await this.visitorName();
    const record: TourRecord = {
      schemaVersion: 1,
      tourId: this.tourId,
      kind: this.kind,
      ranAt: this.startedAt.toISOString(),
      updatedAt: this.clock.now().toISOString(),
      outcome: stage === "done" || stage === "follow-up" ? "finished" : stage === "stopped" && !(await this.isPaused()) ? "stopped" : "in-progress",
      ...(r ? { unitId: r.unitId } : {}),
      ...(name ? { visitorName: name } : {}),
      ...(this.visitor ? { visitorPhone: this.visitor.phone } : {}),
      conversation: [...this.thread],
    };
    return { record, bundle: await this.core.exportRecords() };
  }
}

/** Live visitor conversations for this server process. Records are saved after every step. */
export class VisitorDemoRegistry {
  private readonly sessions = new Map<string, VisitorDemoSession>();
  private content?: (propertyId: string) => TourCoreConfig | undefined;
  private availability?: (propertyId: string) => PropertyState | undefined;
  private pauseWaiter?: (propertyId: string, waiter: { phone: string; unitId?: string; at: string }) => void;

  add(session: VisitorDemoSession): VisitorDemoSession {
    this.sessions.set(session.id, session);
    if (this.content || this.availability || this.pauseWaiter) this.attach(session);
    return session;
  }

  /**
   * Where live tours read the property's current approved content (the saved
   * setup). Applies to tours already running, so an operator's new fact is
   * used on the very next question.
   */
  useApprovedContent(content: (propertyId: string) => TourCoreConfig | undefined): void {
    this.content = content;
    for (const s of this.sessions.values()) this.attach(s);
  }

  useAvailability(availability: (propertyId: string) => PropertyState | undefined): void {
    this.availability = availability;
    for (const s of this.sessions.values()) this.attach(s);
  }

  usePauseWaiters(remember: (propertyId: string, waiter: { phone: string; unitId?: string; at: string }) => void): void {
    this.pauseWaiter = remember;
    for (const s of this.sessions.values()) this.attach(s);
  }

  private attach(session: VisitorDemoSession): void {
    if (this.content) session.contentSource = () => this.content!(session.propertyId);
    if (this.availability) session.availabilitySource = () => this.availability!(session.propertyId);
    if (this.pauseWaiter) session.rememberPauseWaiter = (waiter) => this.pauseWaiter!(session.propertyId, waiter);
  }

  get(id: string): VisitorDemoSession {
    const session = this.sessions.get(id);
    if (!session) throw new SetupInputError("DEMO_NOT_FOUND", "This visitor demo has ended. Start a new one from the property page.");
    return session;
  }

  find(id: string): VisitorDemoSession | undefined {
    return this.sessions.get(id);
  }

  /** Every conversation in this process, oldest first. */
  all(): VisitorDemoSession[] {
    return [...this.sessions.values()];
  }

  /** The most recent conversation with this phone at this property, finished or not. */
  latestForPhone(propertyId: string, phone: string, kind?: TourRecord["kind"]): VisitorDemoSession | undefined {
    const e164 = normalizePhone(phone);
    return [...this.sessions.values()].reverse().find((s) => s.propertyId === propertyId && s.visitor?.phone === e164 && (!kind || s.kind === kind));
  }

  /** Drops every live conversation in this process. Saved files are a separate step. */
  clear(): void {
    this.sessions.clear();
  }

  /** The most recent unfinished conversation for a property, if any. */
  async activeFor(propertyId: string): Promise<VisitorDemoSession | undefined> {
    const mine = [...this.sessions.values()].filter((s) => s.propertyId === propertyId).reverse();
    for (const s of mine) {
      const stage = await s.stage();
      if ((stage !== "done" && stage !== "stopped") || (await s.isPaused())) return s;
    }
    return undefined;
  }
}

function sameDateMenu(a: { date: string }[], b: { date: string }[]): boolean {
  return a.length === b.length && a.every((day, i) => day.date === b[i]?.date);
}

function sameTimeMenu(a: TourSlot[], b: TourSlot[]): boolean {
  return a.length === b.length && a.every((slot, i) => slot.start.getTime() === b[i]?.start.getTime());
}