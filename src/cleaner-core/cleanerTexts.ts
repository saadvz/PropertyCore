import { GROK_HELPER } from "./assistant";
/**
 * The only place a cleaning offer, reminder, or door code is addressed.
 * The recipient is the property's opted-in cleaner record. There is no phone
 * argument and no fallback to the host.
 */

export interface OptedInCleaner {
  readonly phone: string;
  readonly approved: true;
  readonly consent: "in";
}

export type CleanerTextKind = "offer" | "reminder" | "pin";

export interface AddressedCleanerText {
  to: string;
  kind: CleanerTextKind;
  body: string;
}

/** Turns the stored cleaner record into the only recipient a cleaner text can name. */
export function asOptedInCleaner(record: {
  phone: string | undefined;
  approved: boolean;
  consent: "pending" | "in" | "out";
}): OptedInCleaner | undefined {
  if (!record.phone || record.approved !== true || record.consent !== "in") return undefined;
  return { phone: record.phone, approved: true, consent: "in" };
}

/** Addresses one cleaner text. No record means no text. */
export function addressCleaner(
  cleaner: OptedInCleaner | undefined,
  message: { kind: CleanerTextKind; body: string },
): AddressedCleanerText | null {
  if (!cleaner) return null;
  return { to: cleaner.phone, kind: message.kind, body: message.body };
}

const OFFER_ASK = "Reply YES to schedule it, or STOP to opt out.";
const OFFER_WAIT = "The cleaner will reply to confirm.";

export function offerBody(
  address: string,
  checkout: { day: string; time: string },
  next: { day: string; time: string } | null,
  sameDay: boolean,
): string {
  const guest = !next ? "" : sameDay || next.day === checkout.day ? `, next guest ${next.time}` : `, next guest ${next.day} at ${next.time}`;
  return `Turnover at ${address} on ${checkout.day}. Checkout ${checkout.time}${guest}. ${OFFER_ASK}`;
}

const HOST_NOTE = " Note from the host: ";

/** A text with the host's saved other instructions at the end. Without any, the text is unchanged. */
export function withHostNote(body: string, instructions: string | undefined): string {
  const note = instructions?.trim();
  return note ? `${body}${HOST_NOTE}${note}` : body;
}

/** The text an offer adds after Cleaner Core's own words: the host's note, or nothing. */
export function hostNoteOf(body: string): string {
  const index = body.indexOf(HOST_NOTE);
  return index < 0 ? "" : body.slice(index);
}

/**
 * Offer copies drop the YES ask. The cleaner is the only person who can confirm. The host's note,
 * when there is one, stays after it.
 */
export function offerForOthers(body: string): string {
  const note = hostNoteOf(body);
  const own = body.slice(0, body.length - note.length);
  return own.endsWith(OFFER_ASK) ? `${own.slice(0, -OFFER_ASK.length)}${OFFER_WAIT}${note}` : body;
}

/**
 * The offer as it goes into the group: the YES ask names the cleaner, since the host reads it too.
 * The group's intro already says how to leave, so the offer drops the STOP ask. The host's note,
 * when there is one, stays after it.
 */
export function groupOfferBody(cleanerName: string, body: string): string {
  const note = hostNoteOf(body);
  const own = body.slice(0, body.length - note.length);
  return own.endsWith(OFFER_ASK) ? `${own.slice(0, -OFFER_ASK.length)}${cleanerName}, reply YES to schedule it.${note}` : body;
}

/**
 * A group text without Cleaner Core's STOP ask. Only the first text in the group (the intro) says how to
 * leave, so later texts don't end on STOP. STOP still works. The host's note is left as it is.
 */
export function withoutStopAsk(body: string): string {
  const note = hostNoteOf(body);
  const own = body.slice(0, body.length - note.length);
  return `${own.replace(/, or STOP to opt out\./g, ".").replace(/ ?Reply STOP to opt out\./g, "").trim()}${note}`;
}

/** The checklist, after the private code. Each item loses a trailing period or semicolon. */
export function checklistBody(name: string, items: readonly string[]): string {
  const list = items.map((item) => item.trim().replace(/[.;]+$/, "")).join("; ");
  return `Checklist for ${name}: ${list}. Send photos, then reply DONE when finished.`;
}

export const PHOTO_FIRST = "Please send a photo of the finished rooms, then reply DONE.";

/** DONE's question when the cleaner was sent a checklist. The job is done only after YES. */
export const CHECKLIST_ASK = "Before I mark it done: is everything on the checklist I sent finished? Reply YES or NO.";

/** The reply to NO: the cleaning stays open. */
export const CHECKLIST_NOT_DONE = "No problem. Finish up and reply DONE when everything's done.";

export function reminderBody(address: string, when: { day: string; time: string }, privateTurn: boolean): string {
  return privateTurn
    ? `Reminder: cleaning at ${address} is ${when.day} at ${when.time}.`
    : `Reminder: checkout at ${address} is ${when.day} at ${when.time}. Reply STOP to opt out.`;
}

/** The scheduled reminder. It names the checkout and asks the cleaner when they plan to arrive. */
export function arrivalReminderBody(address: string, when: { day: string; time: string }): string {
  return `Reminder: cleaning at ${address} on ${when.day}. Checkout is ${when.time}. What time do you plan to arrive?`;
}

/** The new-booking question for the host when the property's usual times are saved. */
export function usualTimesAsk(name: string, checkInDay: string, checkoutDay: string, checkout: string, checkIn: string): string {
  return `New booking at ${name}: check-in ${checkInDay}, checkout ${checkoutDay}. Use the usual ${checkout} checkout and ${checkIn} check-in?`;
}

export function doorCodeBody(address: string, code: string, lockLocation?: string): string {
  const label = lockLocation ? `Door code for the ${lockLocation}` : "Door code";
  return `Guests have left ${address}. ${label}: ${code}. This code is only for you. Reply DONE when the cleaning is finished.`;
}

/** The door code as the group reads it: it names the cleaner and does not say the code is private. */
export function groupDoorCodeBody(address: string, code: string, cleanerName: string, lockLocation?: string): string {
  const label = lockLocation ? `Door code for the ${lockLocation}` : "Door code";
  return `Guests have left ${address}. ${label}: ${code}. ${cleanerName}, reply DONE when the cleaning is finished.`;
}

/** The host's note while a cleaning waits for the cleaner's first YES. Nothing is on hold, and the host has nothing to do. */
export function waitingForYesNote(address: string): string {
  return `The cleaning at ${address} is waiting for the cleaner to reply YES.`;
}

export function holdNote(address: string): string {
  return `The cleaning at ${address} is on hold until the cleaner replies YES.`;
}

export function jobHoldLine(address: string): string {
  return `The cleaning at ${address} is on hold.`;
}

export function cleanerOptOutHold(address: string, helper = GROK_HELPER): string {
  return `The cleaner opted out of cleaning texts for ${address}, so the cleaning is on hold. Find another cleaner or reach them directly, then tell ${helper} to restart it.`;
}

export function injuryHoldLine(address: string, helper = GROK_HELPER): string {
  return `The cleaning at ${address} is on hold because the cleaner reported an injury. Once everyone's okay, tell ${helper} to restart it.`;
}

export function ownerOptOutHoldNote(address: string, helper = GROK_HELPER): string {
  return `The cleaning at ${address} is on hold because you opted out of texts. Tell ${helper} to restart it.`;
}

export function optedOutCodeLine(): string {
  return "The cleaner opted out, so the door code wasn't sent. Please reach them directly.";
}

export function resumeNote(address: string): string {
  return `The cleaning at ${address} is back on.`;
}

export function hostStopReply(address: string, held: boolean): string {
  return held
    ? `You're opted out of cleaning texts for ${address}, and the cleaning there is on hold. Reply START to get texts again.`
    : `You're opted out of cleaning texts for ${address}. Reply START to get texts again.`;
}

export function hostStartReply(address: string, held: boolean, helper = GROK_HELPER): string {
  return held
    ? `You'll get cleaning texts for ${address} again. The cleaning is still on hold. Tell ${helper} to restart it.`
    : `You'll get cleaning texts for ${address} again.`;
}

export function hostDoneLine(address: string): string {
  return `The cleaner marked the cleaning at ${address} done.`;
}

export function groupOptInBody(name: string, otherName: string, address: string): string {
  return `${name}, you're invited to the cleaning group for ${address} with ${otherName}. Reply YES to join that group, or STOP to opt out.`;
}

/** The group invite. The cleaner replies YES to join the group chat. */
export function groupInviteBody(landlordName: string, address: string): string {
  return `${landlordName} wants to set up a group chat with you for cleaner services at ${address}. Reply YES to join, or STOP to opt out.`;
}

/** Names joined as "A", "A and B", or "A, B and C". */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The first message in the group chat. It names everyone in the group. */
export function groupIntroBody(names: readonly string[], landlordName: string, address: string): string {
  return `Hi ${nameList(names)}! This is the cleaning group for ${address}. I'm ${landlordName}${landlordName.endsWith("s") ? "'" : "'s"} cleaning assistant, and I'll post cleaning times and updates here. Reply STOP anytime to leave.`;
}

/** Lowercases a sentence's first letter, unless the word is "I" or an all-caps word. */
function lowerFirst(sentence: string): string {
  return /^(I\b|[A-Z]{2,})/.test(sentence) ? sentence : sentence.charAt(0).toLowerCase() + sentence.slice(1);
}

/** Where the last sentence of a text that ends with "?" begins. */
function lastSentenceStart(text: string): number {
  const before = text.slice(0, -1);
  let start = 0;
  for (const mark of [". ", "? ", "! "]) {
    const index = before.lastIndexOf(mark);
    if (index >= 0) start = Math.max(start, index + mark.length);
  }
  return start;
}

/**
 * Puts the cleaner's name on the group's ask. A sentence-start "Reply " becomes "{name}, reply ".
 * Otherwise a closing question gets "{name}, " in front of it. The host note stays at the end.
 */
export function namedAsk(name: string, body: string): string {
  const note = hostNoteOf(body);
  const own = body.slice(0, body.length - note.length);
  const reply = /(^|[.?!] )Reply /.exec(own);
  if (reply) {
    const at = reply.index + (reply[1] ?? "").length;
    return `${own.slice(0, at)}${name}, reply ${own.slice(at + "Reply ".length)}${note}`;
  }
  if (own.endsWith("?")) {
    const start = lastSentenceStart(own);
    return `${own.slice(0, start)}${name}, ${lowerFirst(own.slice(start))}${note}`;
  }
  return body;
}

export type CleanerStep =
  | "needs-yes"
  | "waiting-for-guests"
  | "waiting-for-code"
  | "in-progress"
  | "already-done"
  | "on-hold";

export function cleanerNextStep(step: CleanerStep): string {
  switch (step) {
    case "needs-yes":
      return "Reply YES to schedule the cleaning, or STOP to opt out.";
    case "waiting-for-guests":
      return "The door code comes after the guests leave.";
    case "waiting-for-code":
      return "I haven't sent the door code yet. Reply DONE after I do.";
    case "in-progress":
      return "Reply DONE when the cleaning is finished.";
    case "already-done":
      return "This cleaning is already marked done.";
    case "on-hold":
      return "The cleaning is on hold. I'll send an update when it can start again.";
  }
}

export function privateCodeLine(cleanerName: string): string {
  return `${cleanerName} got the door code privately.`;
}

const PRIVATE_GOT = " got the door code privately.";

export function isPrivateCodeLine(body: string): boolean {
  return body.endsWith(PRIVATE_GOT) && body.length > PRIVATE_GOT.length;
}

const GROUP_SEND_TOPICS = new Map<string, string>([
  ["confirm", "checkout time"],
  ["offer", "cleaning offer"],
  ["reminder", "reminder"],
  ["opt-in", "invitation"],
  ["corrected", "time change"],
  ["cancel-update", "cancellation"],
  ["started", "start note"],
  ["done", "done note"],
  ["emergency", "injury alert"],
  ["intro", "intro"],
]);

/** Twilio wouldn't add this phone to the group. Only the last four digits are shown. */
export function groupRefusedLine(refused: { phone: string; code?: number }): string {
  const digits = refused.phone.replace(/\D/g, "").slice(-4);
  const code = refused.code !== undefined ? ` (Twilio error ${refused.code})` : "";
  return `Twilio wouldn't add the number ending in ${digits} to the group text${code}. Check that number with Twilio support, or use another mobile number for that person.`;
}

export function groupUnconfirmedLine(kind: string): string {
  if (kind === "host-message") return "I couldn't send your message to the group.";
  const topic = GROUP_SEND_TOPICS.get(kind);
  if (!topic) return "I couldn't send that to the group.";
  return `I couldn't send the ${topic} to the group.`;
}
