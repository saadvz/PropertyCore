import { hoursRangeRefusal, tourSpacingRefusal } from "../config/validateConfig";
import { applySetupCommand } from "../setup/commands";
import { SAME_DAY_HOURS } from "../setup/parse";
import { SetupInputError, type SetupDraft } from "../setup/setupActions";

/** What a save-hours call would do, checked before anything is written. */
export type HoursPlan = { next: SetupDraft } | { blocked: string } | { ask: string };

/**
 * Applies parsed hours to a copy of the draft. With `merge`, named days get
 * the new hours and every other day keeps its own. Nothing is saved here.
 */
export function planTourHours(draft: SetupDraft, parsed: Record<string, unknown>, merge: boolean): HoursPlan {
  let next: SetupDraft;
  try {
    const { slotEveryMinutes: _s, tourLengthMinutes: _l, earlyArrivalMinutes: _e, ...times } = parsed;
    next = applySetupCommand(draft, "setTourHours", { ...times, merge });
  } catch (error) {
    if (!(error instanceof SetupInputError)) throw error;
    if (error.code === "TOUR_HOURS_BACKWARDS") return { blocked: SAME_DAY_HOURS };
    if (error.code === "TOUR_DAYS_NEEDED" || error.code === "TOUR_TIMES_NEEDED") return { ask: error.message };
    throw error;
  }
  const range = hoursRangeRefusal({
    tourLengthMinutes: typeof parsed.tourLengthMinutes === "number" ? parsed.tourLengthMinutes : undefined,
    slotEveryMinutes: typeof parsed.slotEveryMinutes === "number" ? parsed.slotEveryMinutes : undefined,
  });
  if (range) return { blocked: range };
  const spacing = tourSpacingRefusal({
    ...draft.tourHours,
    ...(typeof parsed.slotEveryMinutes === "number" ? { slotEveryMinutes: parsed.slotEveryMinutes } : {}),
    ...(typeof parsed.tourLengthMinutes === "number" ? { tourLengthMinutes: parsed.tourLengthMinutes } : {}),
    ...(typeof parsed.earlyArrivalMinutes === "number" ? { earlyArrivalMinutes: parsed.earlyArrivalMinutes } : {}),
  });
  if (spacing) return { blocked: spacing };
  const { days: _d, start: _st, end: _en, ...minutes } = parsed;
  return { next: Object.keys(minutes).length ? applySetupCommand(next, "setTourHours", minutes) : next };
}
