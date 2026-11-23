import { addCalendarDays, zonedInstant } from "../hub/calendar";
import type { AccessGrant, AccessRefusal } from "../hub/doorAccess";

/**
 * How the engine gets a door code to send: it asks for door access for the cleaner during the
 * cleaning's window, after its own checks (approval, opt-in, channel, the release gate). On the live
 * service the port is the property hub's request; the CLI and scratch paths pass their made-up code.
 */
export interface DoorAccessPort {
  request(input: { person: string; window: { from: string; until: string }; purpose: "cleaning"; jobId: string }): Promise<AccessGrant>;
  /** The code for the engine's leak checks only. Never sent. */
  codeForChecks(): string | undefined;
  /** On connected locks, every live per-visit code and backup code, for the leak checks only. Never sent. */
  codesForChecks?(): string[];
}

export type AccessRefusedLines = Partial<Record<AccessRefusal, string>>;

export const DOOR_WINDOW_OVER = "The cleaning's window has passed, so the door code didn't go out.";
export const DOOR_NOT_OPENED = "The door code didn't go out. Save it again through the private box.";
export const DOOR_LOCK_FAILED = "The cleaner's code didn't go out. The lock didn't take it, there's no backup code, and no door code is saved. Let the cleaner in yourself, or save a door code.";

/**
 * A port that grants this made-up code for any window: the CLI, scratch, and tests. With no code it
 * refuses no-code, as an engine with no code never texts one.
 */
export function fixedCodePort(code: string | undefined, lockLocation?: string): DoorAccessPort {
  const saved = code?.trim() || undefined;
  return {
    request: async (input) => (saved ? { ok: true, kind: "code", code: saved, ...(lockLocation?.trim() ? { lockLocation: lockLocation.trim() } : {}), until: input.window.until } : { ok: false, reason: "no-code" }),
    codeForChecks: () => saved,
  };
}

/**
 * A cleaning's door window: from the checkout instant to the next guests' check-in in the property's
 * time zone (their confirmed time, else the property's usual check-in time, else 4 PM), so the code
 * never works once they're in. With no next booking, to the end of the day after checkout.
 */
export function cleaningWindow(input: { checkoutDate: string; checkoutTime: string; nextCheckInDate: string | null; nextCheckInTime?: string; timeZone: string }): { from: string; until: string } {
  const from = new Date(Date.parse(zonedInstant(input.checkoutDate, input.checkoutTime, input.timeZone))).toISOString();
  const end = input.nextCheckInDate
    ? zonedInstant(input.nextCheckInDate, input.nextCheckInTime ?? DEFAULT_NEXT_CHECK_IN, input.timeZone)
    : zonedInstant(addCalendarDays(input.checkoutDate, 2), "00:00", input.timeZone);
  return { from, until: new Date(Date.parse(end)).toISOString() };
}

/** The check-in time a cleaning window ends at when neither the booking nor the property gives one. */
export const DEFAULT_NEXT_CHECK_IN = "16:00";
