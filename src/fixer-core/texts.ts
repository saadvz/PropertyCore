import { formatWeekday, zonedParts } from "../core/timezone";
import type { BookingHold } from "./gate";
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

/** `cleanerName` is left out for a job with no cleaner's photo, like upkeep coming due. */
export function hostGoQuestion(f: { what: string; cleanerName?: string; proName?: string }): string {
  const tail = f.proName ? `Want me to call ${f.proName}?` : "Want me to find someone?";
  return `${f.what}${f.cleanerName ? ` (photo from ${f.cleanerName})` : ""}. ${tail}`;
}

/** One short sentence per hold the host's yes would accept. A stay overlap is never asked, so it has none. */
export function holdSentences(f: { holds: readonly BookingHold[]; costLineCents?: number }): string {
  const line = f.costLineCents === undefined ? "" : shortDollars(f.costLineCents);
  const parts: string[] = [];
  if (f.holds.includes("outside-window")) parts.push("That's outside the open times between stays.");
  if (f.holds.includes("cost")) parts.push(`That's over your ${line} cost line.`);
  if (f.holds.includes("no-estimate")) parts.push(`They gave no estimate, and you have a ${line} cost line.`);
  return parts.map((part) => `${part} `).join("");
}

export function bookingQuestion(f: {
  proName: string;
  from: string;
  until: string;
  timeZone: string;
  estimateCents?: number;
  access: "code" | "host";
  holds?: readonly BookingHold[];
  costLineCents?: number;
}): string {
  const when = `${formatWeekday(new Date(f.from), f.timeZone)} ${hourOf(f.from, f.timeZone)} to ${hourOf(f.until, f.timeZone)}`;
  const about = f.estimateCents === undefined ? "" : `, about ${shortDollars(f.estimateCents)}`;
  const tail = f.access === "host" ? "you'll let them in?" : "let them in with the door code?";
  const holds = holdSentences({ holds: f.holds ?? [], ...(f.costLineCents !== undefined ? { costLineCents: f.costLineCents } : {}) });
  return `${f.proName} can come ${when}${about}. ${holds}Book it and ${tail}`;
}

/** With no estimate to compare, the "not {$old}" part is left out. */
export function raisedPrice(f: { proName: string; newCents: number; oldCents?: number }): string {
  return `${f.proName} says the fix is ${dollars(f.newCents)}${f.oldCents === undefined ? "" : `, not ${dollars(f.oldCents)}`}. Go ahead?`;
}

/** A raised price that doesn't wait for the host: news only. */
export function raisedPriceNews(f: { proName: string; newCents: number; oldCents?: number }): string {
  return `${f.proName} says the fix is ${dollars(f.newCents)}${f.oldCents === undefined ? "" : `, not ${dollars(f.oldCents)}`}.`;
}

/** What was charged, told once when it's over the cost line or more than 20% over the estimate. */
export function costNewsText(f: { proName: string; cents: number; estimateCents?: number; costLineCents?: number }): string {
  if (f.costLineCents !== undefined && f.cents > f.costLineCents) return `${f.proName} charged ${dollars(f.cents)}, over your ${shortDollars(f.costLineCents)} cost line.`;
  return `${f.proName} charged ${dollars(f.cents)}, more than 20% over the ${dollars(f.estimateCents ?? 0)} estimate.`;
}

/** The street line of an address: what comes before the first comma. */
export function streetOf(address: string): string {
  return address.split(",")[0]!.trim();
}

/** Told to the host when the tick texted the code to the pro. */
export function codeTextNews(f: { proName: string; at: string; timeZone: string }): string {
  return `${f.proName} got the door code by text at ${clock(f.at, f.timeZone)}.`;
}

/** The hub wouldn't open the code (no key after a restart, or the window is over): nothing went to the pro. */
export function codeRefusedNote(f: { proName: string }): string {
  return `I couldn't open the door code for ${f.proName}'s visit, so it wasn't sent. You'll need to let them in.`;
}

/** The code text was marked to go out, but it isn't known that it did (a restart or a failed send). It is never sent twice. */
export function codeTextUnsureNote(f: { proName: string }): string {
  return `The door code text to ${f.proName} may not have gone out. Check with them, or let them in yourself.`;
}

/** A stay read after the booking now overlaps the visit: the code is held, and the host decides. */
export function stayOverBookingNews(f: { proName: string; from: string; timeZone: string }): string {
  return `A stay on the calendar now overlaps ${f.proName}'s repair visit ${formatWeekday(new Date(f.from), f.timeZone)} ${hourOf(f.from, f.timeZone)}. The door code won't go out for it. Reschedule or cancel the visit?`;
}

/** With the visit in held: what the agent asks the host. */
export const STAY_OVER_NEXT = "A stay now overlaps this booked visit, so the door code won't go out. Ask the host: reschedule_job or cancel_job?";

/** The pro gets the code by text, but texts can't go out from this property (Fixer only, or the host isn't confirmed). */
export function codeTextOffNote(f: { proName: string }): string {
  return `Texts can't go out from this property yet, so ${f.proName} won't get the door code by text. Send them the visit link, or let them in yourself.`;
}

/** check_fixes while calendars are saved but none has been read: no visit times. */
export const STAYS_UNREAD = "The booking calendars haven't been read yet, so there are no visit times. Call check_fixes again (with googleEvents when the bookings are in Google Calendar), or check_now where Cleaner Core runs.";

/** A booking or the host's yes while calendars are saved but none has been read. */
export const STAYS_UNREAD_BOOK = "The booking calendars haven't been read yet, so this time can't be checked against the stays. Call check_fixes first, then try again.";

/** remove_pro while the pro has a visit booked or waiting on the host. */
export function removeBookedPro(f: { proName: string }): string {
  return `${f.proName} has a repair visit on a job. Cancel or reschedule their visit first.`;
}

/** remove_pro while the pro is still being contacted. */
export function removeContactedPro(f: { proName: string }): string {
  return `${f.proName} is still being contacted for a job. Record what they said with record_contact first.`;
}

/** The visit's end passed with no done. */
export function visitOverNews(f: { proName: string; until: string; timeZone: string }): string {
  return `${f.proName}'s visit was due to end at ${clock(f.until, f.timeZone)}, and there's no done yet. Mark it done, give more time, rebook or cancel.`;
}

/** The visit's end passed with no done, and guests check in within the hour after it. */
export function lateBeforeCheckInNews(f: { proName: string; until: string; checkIn: string; timeZone: string }): string {
  return `${f.proName}'s visit was due to end at ${clock(f.until, f.timeZone)}, and there's no done yet. Guests check in at ${clock(f.checkIn, f.timeZone)}.`;
}

/** Done, with no photos from the pro. */
export function noPhotosNews(f: { proName: string }): string {
  return `${f.proName}'s job is marked done, but no photos came.`;
}

export function extendQuestion(f: { proName: string; until: string; timeZone: string }): string {
  return `Give ${f.proName} until ${clock(f.until, f.timeZone)} to finish?`;
}

/** After the host says yes to changing the code. */
export const CODE_CHANGE_NEXT = "Send the host this link. They set the new code on the lock first, then save it through the link. Never ask for the code in chat.";

export function revealNews(f: { proName: string; at: string; timeZone: string }): string {
  return `${f.proName} opened the door code at ${clock(f.at, f.timeZone)}.`;
}

export function preferredQuestion(f: { proName: string; trade: Trade }): string {
  return `Add ${f.proName} to your preferred list for ${f.trade}?`;
}

/** The host's pick: who to call, in order. */
export function pickQuestion(f: { names: string[] }): string {
  return `Call ${f.names.join(", then ")}?`;
}

/** Asked when the visit shares the turnover with a cleaning. */
export function cleaningOrderQuestion(f: { proName: string }): string {
  return `${f.proName} would come the day of a cleaning. Before or after the cleaning?`;
}

export function cancelQuestion(f: { proName: string }): string {
  return `Cancel the repair visit with ${f.proName}? I'll tell them it's off.`;
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

/** The visit page for a link that is unknown, revoked, cancelled, done or past its end. */
export const VISIT_ENDED = "This visit has ended.";

/** A page action before the visit opens. */
export const VISIT_NOT_STARTED = "The visit hasn't started yet. Photos, done and a new price open 30 minutes before it.";

/** A page action while repairs are turned off. */
export const VISIT_PAGE_OFF = "That can't be saved right now. Tell the host.";

/** With the visit link, for the agent. */
export const VISIT_LINK_NEXT = "Send this link only to the pro's own email or phone, never to a group. It is shown once.";

/** The host ended the visit link; visit_link waits for a rebook or more time. */
export const VISIT_REVOKED = "The host ended this visit link. A new time or more time for the visit gives a new one.";

/** A pro who gets the code by text has no visit page (Decision 5). */
export function visitTextPath(f: { proName: string }): string {
  return `${f.proName} texts on the line, so the door code and done go by text. There's no visit page for this visit.`;
}

export function rescheduleQuestion(f: { proName: string }): string {
  return `Move the repair visit with ${f.proName} to a new time? I'll tell them this time is off.`;
}

/** The reply to a pro who texts that someone is hurt, once the host's note was kept or sent. It names no property and no host detail. */
export const PRO_HURT = "If someone is hurt, call 911 now. I've let the host know.";

/** The same reply when no note for the host could be kept or sent. */
export const PRO_HURT_CALL = "If someone is hurt, call 911 now.";

/** Told to the host when a pro texts that someone is hurt. */
export function proHurtNews(f: { proName: string; street: string }): string {
  return `${f.proName} says someone is hurt at ${f.street}. They've been told to call 911.`;
}

/** Told to the host when a pro texts something Fixer Core does not act on. `text` has its digit runs removed. */
export function proTextNews(f: { proName: string; text: string }): string {
  return `${f.proName} texted: "${f.text}"`;
}

/** Sent to an opted-in pro whose DONE text marked the visit done (a design-pass item). */
export const PRO_DONE_ACK = "Thanks, marked done.";

/** Told to the host when a pro's text could not be handled. */
export function proTextFailed(f: { proName: string }): string {
  return `A text from ${f.proName} couldn't be handled. Check with them.`;
}

/** set_flows fixer: false with a visit booked (design pass). Each job is what needs fixing, with the booked pro's name when there is one. */
export function fixerOffQuestion(f: { label: string; jobs: { what: string; proName?: string }[] }): string {
  const list = f.jobs.map((job) => (job.proName ? `${job.what} (${job.proName})` : job.what)).join("; ");
  const count = f.jobs.length === 1 ? "This repair job is cancelled" : `These ${f.jobs.length} repair jobs are cancelled`;
  return `Turn off Fixer Core for ${f.label}? ${count}: ${list}. I'll tell each booked pro, and their visit links end. The pros and upkeep are kept. Reply yes to turn it off.`;
}

/** After Activate, changing the property's address takes the host's yes (design pass). */
export function propertyQuestion(f: { address: string }): string {
  return `Save ${f.address} as the property's address for repairs?`;
}
