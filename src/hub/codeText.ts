import { redactBookingEmail } from "./airbnbEmail";

/**
 * Text a host or a manager gave that may carry a door code: a run of 4 or more digits (alone or split by single
 * spaces, dots or dashes, clock times like 22:00 aside), or anything the booking-email redaction would take out.
 * Shared by the house rules (#239) and expected visits (#240). The shared service has no saved code to compare
 * against, so this is the rule Cleaner Core uses while the code is sealed.
 */

/** Four or more digits in a row, alone or split by single spaces, dots or dashes. */
const LONG_NUMBER = /\d(?:[\s.-]?\d){3,}/;
/** Clock times like 22:00 or 7:30, taken out before the long-number scan so "Quiet 22:00-07:00" reads as times. */
const CLOCK_TIME = /\b\d{1,2}:\d{2}\b/g;

export function mayHoldCode(text: string): boolean {
  return LONG_NUMBER.test(text.replace(CLOCK_TIME, " ")) || redactBookingEmail(text) !== text;
}
