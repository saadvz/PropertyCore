import type { TourCoreConfig } from "../config/tourCoreConfig";
import { windowOn } from "./tourWindows";
import { addDays, formatTime, localDateOf, weekdayOf, zonedTimeToUtc, type LocalDate } from "./timezone";

export interface TourSlot {
  start: Date;
  label: string;
}

/** How far ahead visitors can pick a regular tour day. */
export const BOOKING_HORIZON_DAYS = 21;

export function calendarDaysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round((Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) / 86_400_000);
}

export function isBeyondBookingHorizon(today: LocalDate, requested: LocalDate): boolean {
  return calendarDaysBetween(today, requested) >= BOOKING_HORIZON_DAYS;
}

export function minutesOfDay(hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Minutes after local midnight at which tours may start, for one window (`start` to `end`). */
export function slotStartMinutes(tourHours: TourCoreConfig["tourHours"]): number[] {
  const start = minutesOfDay(tourHours.start);
  const end = minutesOfDay(tourHours.end);
  const out: number[] = [];
  if (tourHours.slotEveryMinutes <= 0 || tourHours.tourLengthMinutes <= 0) return out;
  for (let t = start; t + tourHours.tourLengthMinutes <= end; t += tourHours.slotEveryMinutes) out.push(t);
  return out;
}

/** Tour start times on a property-local date, as absolute instants. */
export function slotsOn(config: TourCoreConfig, day: LocalDate): TourSlot[] {
  const tz = config.property.timezone;
  const hours = windowOn(config.tourHours, weekdayOf(day));
  if (!hours) return [];
  return slotStartMinutes({ ...config.tourHours, ...hours }).map((mins) => {
    const start = zonedTimeToUtc({ ...day, hour: Math.floor(mins / 60), minute: mins % 60 }, tz);
    return { start, label: formatTime(start, tz) };
  });
}

export function nextTourDay(config: TourCoreConfig, from: Date): LocalDate {
  let day = localDateOf(from, config.property.timezone);
  for (let i = 0; i < 14; i++) {
    if (slotsOn(config, day).some((s) => s.start > from)) return day;
    day = addDays(day, 1);
  }
  throw new Error("No tour times are available in the next two weeks");
}

/** "2026-09-28" */
export function isoDate(day: LocalDate): string {
  return `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
}

export function parseIsoDate(value: string): LocalDate | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function tourWindow(config: TourCoreConfig, slotStart: Date): { windowStart: Date; windowEnd: Date } {
  return {
    windowStart: new Date(slotStart.getTime() - config.tourHours.earlyArrivalMinutes * 60_000),
    windowEnd: new Date(slotStart.getTime() + config.tourHours.tourLengthMinutes * 60_000),
  };
}
