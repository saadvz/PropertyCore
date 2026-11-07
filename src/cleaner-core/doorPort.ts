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
}

export type AccessRefusedLines = Partial<Record<AccessRefusal, string>>;

export const DOOR_WINDOW_OVER = "The cleaning's window has passed, so the door code didn't go out.";
export const DOOR_NOT_OPENED = "The door code didn't go out. Save it again through the private box.";

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
 * A cleaning's door window: from the checkout instant to the end of the next check-in day in the
 * property's time zone, or with no next booking, to the end of the day after checkout.
 */
export function cleaningWindow(input: { checkoutDate: string; checkoutTime: string; nextCheckInDate: string | null; timeZone: string }): { from: string; until: string } {
  const from = new Date(Date.parse(zonedInstant(input.checkoutDate, input.checkoutTime, input.timeZone))).toISOString();
  const lastDay = input.nextCheckInDate ?? addCalendarDays(input.checkoutDate, 1);
  const until = new Date(Date.parse(zonedInstant(addCalendarDays(lastDay, 1), "00:00", input.timeZone))).toISOString();
  return { from, until };
}
