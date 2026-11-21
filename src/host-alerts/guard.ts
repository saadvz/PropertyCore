import { joinSplitDigits } from "../hub/digits";

/**
 * The last check on a host alert's text before it's kept or sent (#250). Door codes are 4 to 8 digits, and a phone
 * number is 7 or more, so no alert may hold a run of 4 or more digits, even split by spaces, dots, dashes or
 * slashes, or anything shaped like a phone number. The one exception is a run inside the property's own name (a
 * street number), which the host gave as its label. Clock times ("11:30 PM") are split by a colon and pass.
 */

const PHONE = /\+\s*\d/;
const LONG_RUN = /\d{4,}/;

export type AlertProblem = "digits" | "phone";

/** Why `text` can't go to the host, or undefined when it can. */
export function alertProblem(text: string, opts: { label?: string } = {}): AlertProblem | undefined {
  let rest = text;
  const label = opts.label?.trim();
  if (label) rest = rest.split(label).join(" ");
  if (PHONE.test(rest)) return "phone";
  if (LONG_RUN.test(joinSplitDigits(rest))) return "digits";
  return undefined;
}
