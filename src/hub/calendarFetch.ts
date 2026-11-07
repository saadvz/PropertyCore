import type { CalendarFetch } from "./fetchLimits";

/** The fetch every flow reads booking calendars with. Tests stub it; unset uses the platform fetch. */

let override: CalendarFetch | undefined;

export function setCalendarFetch(fetchImpl: CalendarFetch | undefined): void {
  override = fetchImpl;
}

export function calendarFetch(): CalendarFetch {
  return override ?? fetch;
}
