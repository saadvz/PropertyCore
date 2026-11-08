import { formatWeekday, zonedParts } from "../core/timezone";
import type { Trade } from "./store";

/**
 * Every line Fixer Core says in words, one function or constant each, so a design pass can swap them.
 */

/** `$180.00`, as Supply Core writes money. */
export function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** `$180` when the cents are 0, else `$180.50`. */
function shortDollars(cents: number): string {
  return cents % 100 === 0 ? `$${(cents / 100).toLocaleString("en-US")}` : dollars(cents);
}

/** The hour on a 12-hour clock, no am or pm: `10`, or `10:30` when not on the hour. */
function hourOf(iso: string, timeZone: string): string {
  const { hour, minute } = zonedParts(new Date(iso), timeZone);
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? String(h) : `${h}:${String(minute).padStart(2, "0")}`;
}

/** `h:mm` on a 12-hour clock: `4:05`. */
function clock(iso: string, timeZone: string): string {
  const { hour, minute } = zonedParts(new Date(iso), timeZone);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")}`;
}

/** The first word of a name. A business name keeps its first word too ("Joe's"). */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

export function hostGoQuestion(f: { what: string; cleanerName: string; proName?: string }): string {
  const tail = f.proName ? `Want me to call ${f.proName}?` : "Want me to find someone?";
  return `${f.what} (photo from ${f.cleanerName}). ${tail}`;
}

export function bookingQuestion(f: {
  proName: string;
  from: string;
  until: string;
  timeZone: string;
  estimateCents?: number;
  access: "code" | "host";
}): string {
  const when = `${formatWeekday(new Date(f.from), f.timeZone)} ${hourOf(f.from, f.timeZone)} to ${hourOf(f.until, f.timeZone)}`;
  const about = f.estimateCents === undefined ? "" : `, about ${shortDollars(f.estimateCents)}`;
  const tail = f.access === "host" ? "you'll let them in?" : "let them in with the door code?";
  return `${f.proName} can come ${when}${about}. Book it and ${tail}`;
}

export function raisedPrice(f: { proName: string; newCents: number; oldCents: number }): string {
  return `${f.proName} says the fix is ${dollars(f.newCents)}, not ${dollars(f.oldCents)}. Go ahead?`;
}

export function revealNews(f: { proName: string; at: string; timeZone: string }): string {
  return `${f.proName} opened the door code at ${clock(f.at, f.timeZone)}.`;
}

export function preferredQuestion(f: { proName: string; trade: Trade }): string {
  return `Add ${f.proName} to your preferred list for ${f.trade}?`;
}

export function rotationQuestion(f: { proName: string }): string {
  return `${f.proName} knows the door code. Want to change it? Set the new code on the lock, then save it here.`;
}

/** The only text that holds the code. It goes to the pro's own phone. */
export function codeText(f: { proName: string; street: string; code: string; lockLocation?: string }): string {
  const at = f.lockLocation ? `, at ${f.lockLocation}` : "";
  return `Hi ${firstName(f.proName)}, the door code for ${f.street} is ${f.code}${at}. Reply DONE with photos when you finish.`;
}

export function proInvite(f: { proName: string; business: string; street: string }): string {
  return `Hi ${firstName(f.proName)}, this is ${f.business} for repair visits at ${f.street}. Reply YES to get visit details by text, or STOP to opt out.`;
}

export const PLAIN_CHAT =
  "Fixer Core works with Grok Bot and Muse for now: they find, call and book pros themselves. In this chat, Cleaner Core works without Fixer Core.";

/** Setup, ask-cleaner step (Decision 8): the wording differs when Supply Core already asks "Anything running low?". */
export function cleanerAskQuestion(supplyOn: boolean): string {
  return supplyOn
    ? 'After each cleaning, your cleaner is already asked "Anything running low?". Should that become "Anything running low or broken?", so they can report repairs too?'
    : 'Should your cleaner be asked "Anything broken?" after every cleaning? What they report opens a repair for you to approve.';
}
