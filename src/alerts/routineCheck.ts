import { calendarUrlAllowed } from "../hub/fetchLimits";

/** Characters a secure card shows in place of a value it hides. */
const MASK_MARK = /[*•●·]/;

/**
 * True when a routine's webhook address and key can't be saved: the address isn't a safe https one
 * or is a masked placeholder, or the key is short or masked (mask characters, one character repeated,
 * or only x's). The door-code checks are the caller's.
 */
export function routineValuesRefused(url: string, token: string): boolean {
  if (!calendarUrlAllowed(url) || MASK_MARK.test(url)) return true;
  return token.length < 8 || MASK_MARK.test(token) || /^(.)\1*$/su.test(token) || /^[xX]+$/.test(token);
}
