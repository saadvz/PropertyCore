import { zonedInstant } from "../hub/calendar";
import type { WantedCode } from "../hub/grants";
import type { Stay } from "../hub/store";
import { busyTimes, type OccupyInput } from "../fixer-core/window";
import type { CodeWindow } from "../locks/adapter";
import type { OversightFile } from "./store";
import type { ExpectedVisit } from "./visits";

/**
 * Visit codes (#280 17): which expected visits want the visitor's own door code on the connected locks
 * now. Pure. The hub's `visit` grants put them on the locks; this file never holds a code.
 */

const MINUTE_MS = 60_000;
/** A timed visit's code starts this long before the visit, like a pro's. */
export const VISIT_EARLY_MINUTES = 30;
/** An all-day visit's code runs these hours (the same-day check flags it at 8 PM). */
export const ALL_DAY_FROM = "08:00";
export const ALL_DAY_UNTIL = "20:00";

export interface VisitWindowInput {
  timeZone: string;
  stays: readonly Stay[];
  occupy: OccupyInput;
}

/**
 * The visit code's window: 30 minutes before the visit to its end, or 8 AM to 8 PM all day, cut around
 * guest stays (with their check-in buffer) the way crew windows are, keeping the first part left.
 * "during-stay" when no part is left.
 */
export function visitWindow(visit: Pick<ExpectedVisit, "date" | "from" | "to">, input: VisitWindowInput): CodeWindow | "during-stay" {
  const timed = visit.from !== undefined && visit.to !== undefined;
  const from = timed ? Date.parse(zonedInstant(visit.date, visit.from!, input.timeZone)) - VISIT_EARLY_MINUTES * MINUTE_MS : Date.parse(zonedInstant(visit.date, ALL_DAY_FROM, input.timeZone));
  const until = Date.parse(zonedInstant(visit.date, timed ? visit.to! : ALL_DAY_UNTIL, input.timeZone));
  let pieces = [{ from, until }];
  for (const busy of busyTimes(input.stays, input.occupy)) {
    pieces = pieces.flatMap((piece) => {
      if (busy.end <= piece.from || busy.start >= piece.until) return [piece];
      return [
        { from: piece.from, until: busy.start },
        { from: busy.end, until: piece.until },
      ].filter((part) => part.until > part.from);
    });
  }
  const first = pieces.sort((a, b) => a.from - b.from)[0];
  if (!first) return "during-stay";
  return { from: new Date(first.from).toISOString(), until: new Date(first.until).toISOString() };
}

export interface WantedVisitInput extends VisitWindowInput {
  now: Date;
  /** Whether this visit's person may have a code for it now: the host's yes for the visit, or the visitor's YES (or opted in on the property) with no STOP. */
  mayHaveCode(visit: ExpectedVisit): boolean;
}

/** The visit codes wanted now, and the visits whose window falls inside a stay (no code for those). */
export function wantedVisitCodes(file: OversightFile, input: WantedVisitInput): { wanted: WantedCode[]; duringStay: string[] } {
  const wanted: WantedCode[] = [];
  const duringStay: string[] = [];
  for (const visit of file.visits) {
    if (visit.cancelledAt || !visit.phone || !input.mayHaveCode(visit)) continue;
    let window: CodeWindow | "during-stay";
    try {
      window = visitWindow(visit, input);
    } catch {
      continue;
    }
    if (window === "during-stay") {
      const whole = visitWindow(visit, { ...input, stays: [] });
      if (whole !== "during-stay" && Date.parse(whole.until) > input.now.getTime()) duringStay.push(visit.id);
      continue;
    }
    if (Date.parse(window.until) <= input.now.getTime()) continue;
    wanted.push({ jobId: visit.id, person: visit.phone, window, label: visit.who, who: { role: "visitor" } });
  }
  return { wanted, duringStay };
}
