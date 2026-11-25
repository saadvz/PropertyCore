import { formatClockTime, formatWeekday, zonedParts } from "../core/timezone";
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
export function shortDollars(cents: number): string {
  return cents % 100 === 0 ? `$${(cents / 100).toLocaleString("en-US")}` : dollars(cents);
}

/** The hour on a 12-hour clock, no am or pm: `10`, or `10:30` when not on the hour. */
function hourOf(iso: string, timeZone: string): string {
  const { hour, minute } = zonedParts(new Date(iso), timeZone);
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? String(h) : `${h}:${String(minute).padStart(2, "0")}`;
}

/** The local date of an instant, for comparing two. */
function localDay(iso: string, timeZone: string): string {
  const { year, month, day } = zonedParts(new Date(iso), timeZone);
  return `${year}-${month}-${day}`;
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
  /** One more sentence after the holds, such as the urgent visit's. */
  extra?: string;
}): string {
  const sameDay = localDay(f.from, f.timeZone) === localDay(f.until, f.timeZone);
  const end = sameDay ? hourOf(f.until, f.timeZone) : `${formatWeekday(new Date(f.until), f.timeZone)} ${hourOf(f.until, f.timeZone)}`;
  const when = `${formatWeekday(new Date(f.from), f.timeZone)} ${hourOf(f.from, f.timeZone)} to ${end}`;
  const about = f.estimateCents === undefined ? "" : `, about ${shortDollars(f.estimateCents)}`;
  const tail = f.access === "host" ? "you'll let them in?" : "let them in with the door code?";
  const holds = holdSentences({ holds: f.holds ?? [], ...(f.costLineCents !== undefined ? { costLineCents: f.costLineCents } : {}) });
  return `${f.proName} can come ${when}${about}. ${holds}${f.extra ?? ""}Book it and ${tail}`;
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

/** On connected locks with pros' codes on ask: the host's OK for one visit's code. */
export function codeOkQuestion(f: { proName: string; from: string; timeZone: string }): string {
  return `OK to send ${f.proName} their code for the ${clock(f.from, f.timeZone)} visit?`;
}

export function codeOkNews(f: { proName: string; from: string; timeZone: string }): string {
  return `${codeOkQuestion(f)} Their code waits for your yes.`;
}

export function codeOkReminder(f: { proName: string }): string {
  return `${f.proName}'s visit has started, and they're waiting for your OK on their code.`;
}

export function extendAskNews(f: { proName: string; until: string; timeZone: string }): string {
  return `${f.proName} hasn't said done, and their code stops at ${clock(f.until, f.timeZone)}. Give them more time?`;
}

export function extendedNews(f: { proName: string; until: string; timeZone: string }): string {
  return `${f.proName} hasn't said done, so I gave them 30 more minutes, until ${clock(f.until, f.timeZone)}.`;
}

export function noExtendNews(f: { proName: string; until: string; timeZone: string }): string {
  return `${f.proName} hasn't said done, and their code stops at ${clock(f.until, f.timeZone)}. The next check-in is too close to give them more time.`;
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
export function codeText(f: { proName: string; street: string; code: string; lockLocation?: string; doors?: { door: string; code: string }[]; crewHours?: string }): string {
  // Crew-day codes (#243): the crew's workdays and hours, worded in the #273/#275 wording pass.
  const crew = f.crewHours ? ` It works only on the crew's workdays, ${f.crewHours}.` : "";
  if (f.doors && f.doors.length > 1) return `Hi ${firstName(f.proName)}, the door codes for ${f.street} are ${doorList(f.doors)}.${crew} Reply DONE with photos when you finish.`;
  const at = f.lockLocation ? `, at ${f.lockLocation}` : "";
  return `Hi ${firstName(f.proName)}, the door code for ${f.street} is ${f.code}${at}.${crew} Reply DONE with photos when you finish.`;
}

/** "Front door: 1, Side gate: 2" when one door fell back to a backup code. */
export function doorList(doors: readonly { door: string; code: string }[]): string {
  return doors.map((item) => `${item.door}: ${item.code}`).join(", ");
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

/** A pro's voicemail on the line, as news for the host: the transcript, or why there is none. */
export function proVoicemailNews(f: { proName: string; text?: string; failed?: boolean }): string {
  if (f.failed) return `${f.proName} left a voicemail that couldn't be transcribed. Call them back.`;
  if (!f.text) return `${f.proName} called and left no message.`;
  return `${f.proName} left a voicemail: "${f.text}"`;
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

/** A quotes-only repair's summary for the host, once every contacted pro answered. */
export function quotesQuestion(f: { what: string; quotes: { name: string; cents: number; note?: string }[] }): string {
  if (f.quotes.length === 0) return `No quotes yet for ${f.what}. Want me to find more pros?`;
  const list = f.quotes.map((q) => `${q.name} ${shortDollars(q.cents)}${q.note ? ` (${q.note})` : ""}`).join(", ");
  return `Quotes for ${f.what}: ${list}. Who should I book, and want a cost line?`;
}

/** "Mon, Nov 16": a repair block's day, as the host reads it. */
function dayLabel(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day, 12)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Mon, Nov 16 to Fri, Nov 20", or one day. */
export function daysLabel(firstDay: string, lastDay: string): string {
  return firstDay === lastDay ? dayLabel(firstDay) : `${dayLabel(firstDay)} to ${dayLabel(lastDay)}`;
}

/** save_repair_block: the host's yes (#243). */
export function repairBlockQuestion(f: { firstDay: string; lastDay: string }): string {
  return `Close ${daysLabel(f.firstDay, f.lastDay)} for repairs? Pros can be booked on those days, and no guest should be.`;
}

/** remove_repair_block: the host's yes. */
export function removeRepairBlockQuestion(f: { firstDay: string; lastDay: string }): string {
  return `Stop holding ${daysLabel(f.firstDay, f.lastDay)} for repairs?`;
}

/** A saved block a booking could still land on: what the agent tells the host now. Fixer Core can't write to the calendar yet. */
export function blockCalendarNext(f: { openNights: string[] }): string {
  return `Ask the host to close ${f.openNights.length === 1 ? dayLabel(f.openNights[0]!) : `these ${f.openNights.length} nights (${daysLabel(f.openNights[0]!, f.openNights[f.openNights.length - 1]!)})`} on every booking calendar now. Fixer Core can't write to the booking calendar yet, and a booking can still land there.`;
}

/** The block is fully closed on the calendar. */
export const BLOCK_ON_CALENDAR_NEXT = "The booking calendar already shows these days closed. Book pros inside them the normal way.";

/** check_fixes news: nights of a saved block a booking can still land on. */
export function blockOpenNews(f: { firstDay: string; lastDay: string; openNights: string[] }): string {
  return `The repair days ${daysLabel(f.firstDay, f.lastDay)} aren't all closed on the booking calendar: ${f.openNights.length} ${f.openNights.length === 1 ? "night is" : "nights are"} still open to guests. Close them on every booking calendar.`;
}

/** check_fixes news, urgent: a guest stay inside a saved block. */
export function blockCollisionNews(f: { firstDay: string; lastDay: string; checkIn: string; checkout: string }): string {
  return `A guest booking (${daysLabel(f.checkIn, f.checkout)}) lands inside the repair days ${daysLabel(f.firstDay, f.lastDay)}. Decide whether to move the repairs or the booking.`;
}

/** The extra sentence on the booking question for an urgent visit the guest agreed to. */
export const URGENT_AGREED = "It's during the guest's stay, and the guest agreed to this time. ";

/** record_contact on an urgent job over a stay the guest hasn't agreed to yet. */
export const URGENT_ASK_GUEST = "That time is during a guest's stay. Ask the guest whether a pro may come then, record it with record_guest_answer (asked, then yes or no), and the host's question follows a yes.";

/** Why an urgent visit can't be booked over a stay, by hold. */
export function urgentRefusal(hold: string, f: { proName: string }): string {
  if (hold === "spans-checkout") return `That time runs past the guest's checkout. Ask ${f.proName} for a time that ends by checkout, or one after it.`;
  if (hold === "too-long") return `An urgent visit during a stay can be at most 4 hours. Ask ${f.proName} to split it into shorter visits.`;
  if (hold === "guest-declined") return "The guest said no to a visit during their stay. Tell the host, and ask the pro for a time after checkout.";
  if (hold === "guest-ok-other-stay" || hold === "guest-ok-other-window" || hold === "no-guest-ok") return URGENT_ASK_GUEST;
  return `That time overlaps a guest stay, so nothing is booked. Ask ${f.proName} for another time.`;
}

/** Urgent news: the guest said no after an urgent visit was booked. The code is already stopped. */
export function guestWithdrewNews(f: { proName: string; codeSeen: boolean }): string {
  const code = f.codeSeen ? `${f.proName} already saw the door code, and it won't show again for this visit.` : "The door code won't go out for it.";
  return `The guest said no to ${f.proName}'s visit during their stay. ${code} Reschedule or cancel the visit?`;
}

/** An urgent visit whose guest stay changed or left the calendar: the guest's okay was for that stay, so the code stays off. */
export function urgentStayChangedNews(f: { proName: string; from: string; timeZone: string }): string {
  return `The guest stay ${f.proName}'s repair visit ${formatWeekday(new Date(f.from), f.timeZone)} ${hourOf(f.from, f.timeZone)} was approved for has changed or left the calendar. The guest's okay was for that stay, so the door code won't go out for it. Let ${f.proName} in yourself, reschedule, or cancel the visit?`;
}

/** A visit inside a calendar block: Fixer Core can't tell a repair block from a booking a calendar labels "Not available". */
export const BLOCK_HOST_ACCESS = "That visit is inside a block on the booking calendar, and a calendar can label a real booking as a block, so the door code never goes out there. The host lets the pro in: book it with access host.";

/** "Mon, Tue, Wed" from the saved workdays. */
function crewDays(workdays: readonly string[]): string {
  return workdays.map((d) => d.charAt(0) + d.slice(1).toLowerCase()).join(", ");
}

/** A saved 24-hour time ("08:00", "17:30") in 12-hour words ("8 AM", "5:30 PM"). */
function crewClock(hhmm: string): string {
  return formatClockTime(hhmm).replace(":00 ", " ");
}

/** "Mon, Tue, Wed, from 8 AM to 5 PM", for the crew's code text (#243). */
export function crewHoursOf(f: { workdays: readonly string[]; start: string; end: string }): string {
  return `${crewDays(f.workdays)}, from ${crewClock(f.start)} to ${crewClock(f.end)}`;
}

/** The extra sentence on a crew booking's question. */
export function crewScheduleSentence(f: { workdays: readonly string[]; start: string; end: string }): string {
  return `That's the crew's schedule: ${crewDays(f.workdays)}, ${crewClock(f.start)} to ${crewClock(f.end)}. `;
}

/** save_crew_schedule: the host's yes. */
export function crewScheduleQuestion(f: { firstDay: string; lastDay: string; workdays: readonly string[]; start: string; end: string; windows: number }): string {
  return `Save the crew's schedule: ${crewDays(f.workdays)}, ${crewClock(f.start)} to ${crewClock(f.end)}, ${daysLabel(f.firstDay, f.lastDay)} (${f.windows} workdays)?`;
}

/** A crew job's booking must cover its saved schedule. */
export function crewSpanRefusal(f: { from: string; until: string }): string {
  return `A crew job books its saved schedule: from ${f.from} until ${f.until}. Record the booking with those times, or save a new schedule first.`;
}

/** A crew's door code needs connected locks (#243). */
export const CREW_HOST_ACCESS = "A crew can get a door code only where the locks are connected, and they aren't here. The host lets the crew in: book it with access host.";

// Routine vendor visits (#237). New vendor-facing and host-facing wording, flagged for a design pass.

/** "9 to 11": local "HH:MM" hours on a 12-hour clock, no am or pm. */
export function hoursText(from: string, until: string): string {
  const h = (hm: string) => {
    const [hour, minute] = hm.split(":").map(Number) as [number, number];
    const twelve = hour % 12 === 0 ? 12 : hour % 12;
    return minute === 0 ? String(twelve) : `${twelve}:${String(minute).padStart(2, "0")}`;
  };
  return `${h(from)} to ${h(until)}`;
}

/** "Tue Jan 12, 9 to 11 AM", or "Tue Jan 12, 11 AM to 1 PM". */
export function visitWhen(from: string, until: string, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone }).format(new Date(from));
  const part = (iso: string) => {
    const { hour, minute } = zonedParts(new Date(iso), timeZone);
    const twelve = hour % 12 === 0 ? 12 : hour % 12;
    return { text: minute === 0 ? String(twelve) : `${twelve}:${String(minute).padStart(2, "0")}`, half: hour < 12 ? "AM" : "PM" };
  };
  const a = part(from);
  const b = part(until);
  return `${day}, ${a.half === b.half ? `${a.text} to ${b.text} ${b.half}` : `${a.text} ${a.half} to ${b.text} ${b.half}`}`;
}

/** How often, in a few words: "every 21 days", "on day 15 of each month", or the host's own words for a rule. */
export function scheduleWords(schedule: { kind: string; days?: number; monthlyOn?: number; said?: string }): string {
  if (schedule.kind === "every" && schedule.days !== undefined) return schedule.days === 1 ? "every day" : `every ${schedule.days} days`;
  if (schedule.kind === "every" && schedule.monthlyOn !== undefined) return `on day ${schedule.monthlyOn} of each month`;
  if (schedule.kind === "custom" && schedule.said) return schedule.said;
  return "on its schedule";
}

export function standingQuestion(f: { what: string; proName: string; schedule: string; firstDate?: string; from: string; until: string; access: "code" | "host"; usualCents?: number }): string {
  const access = f.access === "code" ? "They'll get their own door code for each visit." : "You'll let them in.";
  const price = f.usualCents !== undefined ? ` It's usually about ${shortDollars(f.usualCents)}; anything more waits for your OK.` : "";
  const first = f.firstDate ? `, starting ${dayLabel(f.firstDate)}` : "";
  return `Want me to book ${f.what.toLowerCase()} with ${f.proName} on its own, ${f.schedule}${first}, between ${hoursText(f.from, f.until).replace(" to ", " and ")}? When it's due, I'll text ${f.proName} the date, and they'll confirm or pick another time. ${access} You won't be asked each time.${price}`;
}

export function standingOffQuestion(f: { what: string; proName: string }): string {
  return `Stop booking ${f.what} with ${f.proName} on its own? I'll ask you each time again.`;
}

export function vendorProposal(f: { proName: string; what: string; street: string; when: string }): string {
  return `Hi ${firstName(f.proName)}, ${f.what.toLowerCase()} at ${f.street} is due. Can you come ${f.when}? Reply YES, or send another day and time.`;
}

export function vendorConfirmed(f: { when: string; access: "code" | "host" }): string {
  return `Thanks, see you ${f.when}. ${f.access === "code" ? "You'll get your door code by text when the visit starts." : "The host will let you in."}`;
}

export function vendorMoved(f: { when: string; access: "code" | "host" }): string {
  return `Done, you're moved to ${f.when}. ${f.access === "code" ? "You'll get your door code by text when the visit starts." : "The host will let you in."}`;
}

export const VENDOR_ASKING_HOST = "Thanks, I'll check that time with the host and text you back.";

export function vendorConfirmedNews(f: { proName: string; what: string; when: string }): string {
  return `${f.proName} confirmed ${f.what.toLowerCase()} for ${f.when}.`;
}

export function vendorMovedNews(f: { proName: string; what: string; when: string }): string {
  return `${f.proName} moved ${f.what.toLowerCase()} to ${f.when}.`;
}

export function vendorHeldQuestion(f: { proName: string; what: string; when: string }): string {
  return `${f.proName} asked to move ${f.what.toLowerCase()} to ${f.when}, which isn't one of the open times between stays. Move it anyway?`;
}

export function vendorNoAnswerNews(f: { proName: string; what: string; when: string }): string {
  return `${f.proName} hasn't answered about ${f.what.toLowerCase()} on ${f.when}. No code goes out until they confirm.`;
}

/** check_fixes' routineVisits (#237): what happens next for a routine vendor's visit under the standing yes. Agent-facing. */
export const ROUTINE_NOTHING_TO_DO = "Don't open a job or ask the host: the standing yes covers it.";

export function routineProposedNext(proName: string): string {
  return `Fixer Core texts ${proName} this visit's date on its own. ${ROUTINE_NOTHING_TO_DO}`;
}

export function routineWaitYes(proName: string): string {
  return `${proName} hasn't said YES to texts from the line yet, so the visit is texted once they do.`;
}

export function routineWaitStays(proName: string): string {
  return `The bookings haven't been read yet, so ${proName}'s visit is texted once they are.`;
}

export const ROUTINE_WAIT_TEXTS = "Texts on the line aren't on yet, so the visit is texted once they are.";

/** open_job for upkeep under a standing yes (#237). Agent-facing. */
export function standingJobRefusal(f: { what: string; proName: string }): string {
  return `${f.what} has a standing yes: Fixer Core texts ${f.proName} each visit's date, so there's no job to open and nothing to ask the host. For an extra visit the host asks for, open it as the host's own job.`;
}

export function vendorNoDayNews(f: { what: string; proName: string }): string {
  return `${f.what} is due, but ${f.proName}'s usual hours don't fit between stays in the next week, so I'll handle it the usual way.`;
}

/**
 * A text from someone who is both a pro and, say, the cleaner, while both the cleaning and their repair visit wait on
 * them. It went to the cleaning; the host checks whether it was about the visit. Never the text itself.
 */
export function mixedTextNews(f: { proName: string; what: string }): string {
  return `${f.proName} texted while both a cleaning and their visit for ${f.what.toLowerCase()} were waiting on them. I took it as about the cleaning. If it was about the visit, ask them and tell me here.`;
}

export function vendorTimeTaken(f: { street: string }): string {
  return `Sorry, ${f.street} isn't free then. Could you send another day and time?`;
}

export function vendorTakenNews(f: { proName: string; when: string }): string {
  return `${f.proName} asked for ${f.when}, but a guest stay or calendar block is on then. I asked them for another time.`;
}

export function vendorTooManyQuestion(f: { proName: string; what: string; when: string; moves: number }): string {
  return `${f.proName} wants to move ${f.what.toLowerCase()} again, to ${f.when}. That would be move ${f.moves + 1}. Okay?`;
}

export function vendorCalledOffNews(f: { proName: string; what: string; when: string }): string {
  return `${f.proName} never confirmed ${f.what.toLowerCase()} for ${f.when}, so I called it off. I'll offer them the next date when it comes due.`;
}

// A pro's code waits for a yes on record (#243 ruling, 24 Nov): the pro's YES by text, or one the host passes on.

/** How a pro's yes reached the host, as the host passes it on. */
export type ConfirmVia = "email" | "call" | "host-arranged";

/** The visit's dates in the pro's and host's words: a crew's days and hours, or one visit's day and hours. */
export function visitSpan(f: { from: string; until: string; timeZone: string; crew?: { firstDay: string; lastDay: string; workdays: readonly string[]; start: string; end: string } }): string {
  return f.crew ? `${daysLabel(f.crew.firstDay, f.crew.lastDay)} (${crewDays(f.crew.workdays)}, ${crewClock(f.crew.start)} to ${crewClock(f.crew.end)})` : visitWhen(f.from, f.until, f.timeZone);
}

/** The one text asking a pro who texts on the line to confirm their booked visit. */
export function confirmAskText(f: { proName: string; what: string; street: string; span: string }): string {
  return `Hi ${firstName(f.proName)}, you're booked at ${f.street} (${f.what.toLowerCase()}) for ${f.span}. Reply YES to confirm.`;
}

export function confirmThanks(f: { access: "code" | "host" }): string {
  return `Thanks, you're confirmed. ${f.access === "code" ? "You'll get your door code when the visit starts." : "The host will let you in."}`;
}

export function confirmedNews(f: { proName: string; span: string; access: "code" | "host" }): string {
  return `${f.proName} confirmed by text for ${f.span}.${f.access === "code" ? " Their door code is made now." : ""}`;
}

function viaWords(via: ConfirmVia): string {
  return via === "email" ? "by email" : via === "call" ? "on a call" : "with you directly";
}

/** confirm_visit: the host's yes that the pro confirmed. */
export function confirmQuestion(f: { proName: string; span: string; via: ConfirmVia }): string {
  return f.via === "host-arranged" ? `You set up ${f.span} with ${f.proName} yourself, so it's confirmed? Their door code is made then.` : `${f.proName} confirmed ${f.span} ${viaWords(f.via)}? Their door code is made then.`;
}

/** The extra sentence on the booking question when the host passes on the pro's yes with it. */
export function confirmedSentence(f: { proName: string; via: ConfirmVia }): string {
  return f.via === "host-arranged" ? `You set this up with ${f.proName} yourself, so it counts as confirmed. ` : `${f.proName} confirmed it ${viaWords(f.via)}. `;
}

/** The one ask, 48 hours before the start, when no yes is on record. */
export function confirmHostAsk(f: { proName: string; span: string }): string {
  return `Has ${f.proName} confirmed ${f.span}? Their door code is made only once they have. Tell me how they confirmed, or if you set it up with them yourself.`;
}

/** The one note at the start when still no yes is on record. */
export function noConfirmAtStart(f: { proName: string }): string {
  return `No door code was made for ${f.proName}: the visit isn't confirmed. Confirm it to make the code now, or let them in.`;
}

/** The booking reply's next step when the visit starts within 48 hours and isn't confirmed. */
export function confirmSoonNext(f: { proName: string }): string {
  return `Tell ${f.proName} the time. Their door code is made once they confirm: ask the host if they already have, and call confirm_visit.`;
}

/** pro_code_link: the host's yes to a private page with the pro's code, for reading it to them. */
export function proCodeLinkQuestion(f: { proName: string }): string {
  return `Make a private link for you to ${f.proName}'s door code, so you can read it to them? It opens once.`;
}
