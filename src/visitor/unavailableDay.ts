import type { TourCoreConfig } from "../config/tourCoreConfig";
import { calendarDaysBetween, isoDate, isBeyondBookingHorizon, parseIsoDate } from "../core/schedule";
import { formatDay, formatLocalDate, formatTime, localDateOf, sameLocalDate as sameDay, weekdayOf, type LocalDate } from "../core/timezone";
import { TourCoreError, VisitorDenialCopy } from "../core/TourCore";
import { namesTourDay } from "../core/spokenTime";
import { acceptsNextOpening } from "../intent/yesNo";
import { normalize, stripFiller } from "../intent/normalize";
import type { ReplyPrompt } from "../messaging/presentation";
import { timeMenu } from "./entry";
import type { Said, VisitorDemoSession } from "./session";

function weekdayPlural(requested: LocalDate, tz: string): string {
  return `${formatLocalDate(requested, tz).split(",")[0]!}s`;
}

/** "Monday, Oct 5 at 8:15 AM" in the property's zone. */
export function nextOpeningWhen(start: Date, tz: string): string {
  return `${formatDay(start, tz)} at ${formatTime(start, tz)}`;
}

function nextClause(nextOpening: Date | undefined, tz: string, noun: "one" | "opening"): string {
  return nextOpening ? ` The next ${noun} is ${nextOpeningWhen(nextOpening, tz)}.` : "";
}

/** One instruction when a day menu follows a next-opening line; "Want that, or another day?" when it does not. */
function nextOpeningCloser(withMenu: boolean): string {
  if (!withMenu) return " Want that, or another day?";
  return " Reply yes to take it, or pick a day:";
}

function nextOpeningAsk(nextOpening: Date, tz: string, withMenu: boolean): string {
  return `The next opening is ${nextOpeningWhen(nextOpening, tz)}.${nextOpeningCloser(withMenu)}`;
}

const GRABBED = "Someone just grabbed that time.";

/**
 * Why a requested day has no bookable regular tours, in the visitor's words.
 * Uses the property's tour hours and timezone; never implies a closed weekday
 * when the day is open but the remaining starts have passed or been taken.
 */
export function unavailableDayReply(input: {
  config: TourCoreConfig;
  now: Date;
  requested: LocalDate;
  nextOpening?: Date;
  /** True when the usual day menu will follow this sentence. */
  withMenu?: boolean;
}): string {
  const { config, now, requested, nextOpening, withMenu } = input;
  const tz = config.property.timezone;
  const today = localDateOf(now, tz);
  const ask = nextOpening ? nextOpeningCloser(!!withMenu) : "";

  if (!config.tourHours.days.includes(weekdayOf(requested))) {
    return `Tours don't run on ${weekdayPlural(requested, tz)}.${nextClause(nextOpening, tz, "opening")}${ask}`;
  }
  if (isBeyondBookingHorizon(today, requested)) {
    return `I can't book that far ahead yet.${nextClause(nextOpening, tz, "opening")}${ask}`;
  }
  if (sameDay(requested, today)) {
    return `There are no more tours today.${nextClause(nextOpening, tz, "one")}${ask}`;
  }
  return `${formatLocalDate(requested, tz)} is fully booked.${nextClause(nextOpening, tz, "opening")}${ask}`;
}

/** Flexible yes / "that" / "I'll take it" after a next-opening offer. A named other day is not an accept. */
export function acceptsOfferedOpening(text: string, today?: LocalDate): boolean {
  const t = stripFiller(normalize(text));
  if (namesTourDay(t, today)) return false;
  return acceptsNextOpening(t);
}

/** Follow-up when the offer is still pending and the reply was not an accept or a day. */
export function nextOpeningFollowUp(start: Date, tz: string): string {
  const weekday = formatDay(start, tz).split(",")[0]!;
  return `Reply yes for ${formatTime(start, tz)} on ${weekday}, or pick a day.`;
}

function datePrompt(session: VisitorDemoSession): ReplyPrompt | undefined {
  if (!session.offeredDates.length) return undefined;
  return { kind: "choose", options: session.offeredDates.map((day) => day.label), what: "a day", after: "" };
}

async function explainUnavailable(session: VisitorDemoSession, requested: LocalDate | undefined): Promise<void> {
  const now = session.clock.now();
  const nextOpening = (await session.core.availableDates(1))[0]?.start;
  if (!nextOpening) {
    await session.reply(VisitorDenialCopy.noOpenTimes(session.config.operator.name));
    return;
  }
  const tz = session.config.property.timezone;
  const menu = datePrompt(session);
  const body = requested
    ? unavailableDayReply({ config: session.config, now, requested, nextOpening, withMenu: !!menu })
    : `That day has already passed. ${nextOpeningAsk(nextOpening, tz, !!menu)}`;
  await session.reply(body, menu);
  session.markDatesShown();
  session.expect("choose-date", {
    kind: "accept-next-opening",
    date: isoDate(localDateOf(nextOpening, tz)),
    slotStart: nextOpening.toISOString(),
  });
}

/**
 * Show that day's open times, or explain why there are none. Shared by typed
 * day questions and the browser-phone date buttons.
 */
export async function offerDate(session: VisitorDemoSession, date: string): Promise<void> {
  const slots = await session.selectDate(date);
  const tz = session.config.property.timezone;
  const now = session.clock.now();
  const requested = parseIsoDate(date);
  const today = localDateOf(now, tz);
  const past = requested ? calendarDaysBetween(today, requested) < 0 : false;
  const beyond = requested ? isBeyondBookingHorizon(today, requested) : false;
  if (!slots.length || beyond || past) {
    session.selectedDate = undefined;
    session.offeredSlots = [];
    // Past dates: "That day has already passed. The next opening is {when}."
    await explainUnavailable(session, past ? undefined : requested);
    return;
  }
  const menu = timeMenu(formatDay(slots[0]!.start, tz), slots.map((slot) => slot.label));
  await session.reply(menu.body, menu.prompt);
  session.markTimesShown();
}

async function offerAfterGrabbed(session: VisitorDemoSession, date: string): Promise<void> {
  const slots = await session.selectDate(date);
  const tz = session.config.property.timezone;
  const requested = parseIsoDate(date);
  const today = localDateOf(session.clock.now(), tz);
  const beyond = requested ? isBeyondBookingHorizon(today, requested) : false;
  if (slots.length && !beyond) {
    await session.reply(`${GRABBED} Here's what's left:`, { kind: "choose", options: slots.map((slot) => slot.label), what: "a time" });
    session.markTimesShown();
    return;
  }
  session.selectedDate = undefined;
  session.offeredSlots = [];
  const nextOpening = (await session.core.availableDates(1))[0]?.start;
  if (!nextOpening) {
    await session.reply(`${GRABBED} ${VisitorDenialCopy.noOpenTimes(session.config.operator.name)}`);
    return;
  }
  const menu = datePrompt(session);
  await session.reply(`${GRABBED} ${nextOpeningAsk(nextOpening, tz, !!menu)}`, menu);
  session.markDatesShown();
  session.expect("choose-date", {
    kind: "accept-next-opening",
    date: isoDate(localDateOf(nextOpening, tz)),
    slotStart: nextOpening.toISOString(),
  });
}

async function slotStillOpen(session: VisitorDemoSession, slotStart: string, date: string): Promise<boolean> {
  const start = new Date(slotStart);
  if (Number.isNaN(start.getTime())) return false;
  const day = parseIsoDate(date) ?? localDateOf(start, session.config.property.timezone);
  const open = await session.core.availableSlots(day);
  return open.some((slot) => slot.start.getTime() === start.getTime());
}

/**
 * A flexible yes after a next-opening offer: book that exact start through the
 * same chooseTime path as the time menu, or fall back if it was taken. Re-checks
 * the offered start against the current published schedule first, so an hours
 * change after the offer cannot book a slot that is no longer open.
 */
export async function takeOfferedOpening(
  session: VisitorDemoSession,
  awaiting: { date: string; slotStart: string },
  said: Said = {},
): Promise<void> {
  if (await slotStillOpen(session, awaiting.slotStart, awaiting.date)) {
    await session.selectDate(awaiting.date);
    try {
      await session.act("chooseTime", { slotStart: awaiting.slotStart }, said);
      return;
    } catch (error) {
      if (!(error instanceof TourCoreError) || error.code !== "SLOT_UNAVAILABLE") throw error;
      session.selectedDate = undefined;
      session.offeredSlots = [];
      await offerAfterGrabbed(session, awaiting.date);
      return;
    }
  }
  if (said.text) await session.recordText(said);
  await offerAfterGrabbed(session, awaiting.date);
}
