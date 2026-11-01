import { spokenClockTime, WEEKDAYS, type Weekday } from "../core/timezone";
import { tourWindows } from "../core/tourWindows";
import type { TourWindow } from "../config/tourCoreConfig";
import { isGeneralTourHoursQuestion } from "../intent/tourHoursAsk";
import { describeTourDays } from "../operator/tourDayWords";
import { renderSms } from "../sms/templates";

export { isGeneralTourHoursQuestion };

export function savedTourHours(hours: { days?: readonly string[]; start?: string; end?: string } | undefined): hours is {
  days: readonly string[];
  start: string;
  end: string;
} {
  return !!hours && Array.isArray(hours.days) && hours.days.length > 0 && !!hours.start && !!hours.end;
}

const EXAMPLE_NAME: Record<Weekday, string> = {
  MON: "Monday",
  TUE: "Tuesday",
  WED: "Wednesday",
  THU: "Thursday",
  FRI: "Friday",
  SAT: "Saturday",
  SUN: "Sunday",
};

const NAMED_FILL: readonly Weekday[] = ["SAT", "MON", "TUE", "WED", "THU", "FRI", "SUN"];

function nextWeekday(day: Weekday): Weekday {
  return WEEKDAYS[(WEEKDAYS.indexOf(day) + 1) % 7]!;
}

/** Two names use "or". Three use a comma and ", or". */
export function joinDayExamples(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, or ${labels.at(-1)}`;
}

/**
 * Up to three examples, and only days that have tours.
 * "today" and "tomorrow" are included only when those days are open.
 * The rest are the next open days by name. Saturday is named first when it
 * is open and is not today or tomorrow, so a Monday on an every-day property
 * still reads "today, tomorrow, or Saturday". When neither today nor tomorrow
 * has tours, the hint names the next two open days ("Monday or Tuesday" on a
 * Saturday for a weekdays-only property).
 */
export function tourHoursExamplePhrase(days: readonly Weekday[], today?: Weekday): string {
  if (!today) {
    const named = days.includes("SAT")
      ? EXAMPLE_NAME.SAT
      : EXAMPLE_NAME[(["MON", "TUE", "WED", "THU", "FRI", "SUN"] as const).find((day) => days.includes(day)) ?? "MON"];
    return `today, tomorrow, or ${named}`;
  }
  const open = new Set(days);
  const tomorrow = nextWeekday(today);
  const labels: string[] = [];
  if (open.has(today)) labels.push("today");
  if (open.has(tomorrow)) labels.push("tomorrow");
  const cap = labels.length === 0 ? 2 : 3;
  for (const day of NAMED_FILL) {
    if (labels.length >= cap) break;
    if (!open.has(day) || day === today || day === tomorrow) continue;
    labels.push(EXAMPLE_NAME[day]);
  }
  return joinDayExamples(labels);
}

/** Visitor reply from the hours that are saved. Days and clocks use the same wording as the hours step. */
export function tourHoursVisitorReply(
  hours: { days: readonly Weekday[]; start: string; end: string; windows?: readonly TourWindow[] },
  today?: Weekday,
): { templateId: string; body: string } {
  // Several windows read "Monday to Friday, 9 AM to 5 PM, and Saturday and Sunday, 9 AM to 8 PM".
  const windows = tourWindows(hours);
  const spoken = (w: TourWindow) => `${spokenClockTime(w.start)} to ${spokenClockTime(w.end)}`;
  const last = windows.at(-1)!;
  const lead = windows.slice(0, -1).map((w) => `${describeTourDays(w.days)}, ${spoken(w)}`);
  const joiner = windows.length > 2 ? "; " : ", ";
  return renderSms("tour-hours-which-day", {
    days: lead.length ? `${lead.join("; ")}${joiner}and ${describeTourDays(last.days)}` : describeTourDays(last.days),
    hours: spoken(last),
    examples: tourHoursExamplePhrase(hours.days, today),
  });
}
