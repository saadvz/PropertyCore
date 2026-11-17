import { formatWhen, zonedInstant } from "../hub/calendar.js";
import { joinSplitDigits } from "../hub/digits.js";
import type { Stay } from "../hub/store.js";
import { busyTimes, type OccupyInput } from "./window.js";

/**
 * An urgent visit during a guest's stay (#243): one window, one stay, one job. Pure. It may be booked only with the
 * host's yes and the guest's okay to that exact window, and the code shows only inside that window. The guest's
 * message itself comes from #242's drafts; this only records what the guest answered.
 */

export const MAX_URGENT_MINUTES = 240;
const DEFAULT_CHECKOUT = "11:00";
const MINUTE_MS = 60_000;

export interface Span {
  from: string;
  until: string;
}

/** The guest's latest answer. A later "no" replaces a "yes". */
export interface GuestAnswer {
  /** `stayKey` of the stay it was given for. */
  stay: string;
  answer: "yes" | "no";
  /** The window the guest agreed to, on a yes. */
  window?: Span;
  at: string;
  /** "host" when the host relays what the guest said. */
  via: "text" | "platform" | "host";
}

export function stayKey(stay: Pick<Stay, "checkIn" | "checkout">): string {
  return `${stay.checkIn}|${stay.checkout}`;
}

/** The first guest stay the window touches, or undefined. Calendar blocks aren't guests. */
export function urgentStay(window: Span, stays: readonly Stay[], times: OccupyInput): Stay | undefined {
  const from = Date.parse(window.from);
  const until = Date.parse(window.until);
  const guests = stays.filter((s) => s.kind === "stay");
  const busy = busyTimes(guests, times);
  return guests.find((_, i) => from < busy[i]!.end && until > busy[i]!.start);
}

export type UrgentHold = "not-during-stay" | "spans-checkout" | "too-long" | "no-guest-ok" | "guest-declined" | "guest-ok-other-stay" | "guest-ok-other-window" | "no-host-yes";

export interface UrgentVisitInput {
  window: Span;
  stays: readonly Stay[];
  times: OccupyInput;
  guest?: GuestAnswer;
  hostYes?: { at: string };
}

/** Why the guest's answer doesn't cover this visit, or undefined when it does. */
function guestHold(guest: GuestAnswer | undefined, stay: Stay, window: Span): UrgentHold | undefined {
  if (!guest) return "no-guest-ok";
  if (guest.answer === "no") return "guest-declined";
  if (guest.stay !== stayKey(stay)) return "guest-ok-other-stay";
  const agreed = guest.window;
  if (!agreed || Date.parse(agreed.from) > Date.parse(window.from) || Date.parse(agreed.until) < Date.parse(window.until)) return "guest-ok-other-window";
  return undefined;
}

/** Why an urgent visit can't go ahead yet, in a fixed order. Empty when it can. */
export function urgentVisitHolds(input: UrgentVisitInput): UrgentHold[] {
  const stay = urgentStay(input.window, input.stays, input.times);
  if (!stay) return ["not-during-stay"];
  const holds: UrgentHold[] = [];
  const checkoutAt = Date.parse(zonedInstant(stay.checkout, input.times.checkoutTime ?? DEFAULT_CHECKOUT, input.times.timeZone));
  if (Date.parse(input.window.until) > checkoutAt) holds.push("spans-checkout");
  if (Date.parse(input.window.until) - Date.parse(input.window.from) > MAX_URGENT_MINUTES * MINUTE_MS) holds.push("too-long");
  const guest = guestHold(input.guest, stay, input.window);
  if (guest) holds.push(guest);
  if (!input.hostYes) holds.push("no-host-yes");
  return holds;
}

export type UrgentRefusal = UrgentHold | "door-lock" | "no-phone" | "before-visit" | "after-visit";

/** May the code show now for an urgent visit? Only inside the agreed visit, from its start: the guest is inside. */
export function urgentAccessCheck(input: UrgentVisitInput & { now: Date; proPhone?: string; doorLock?: boolean }): { ok: true; window: Span } | { ok: false; reason: UrgentRefusal } {
  const held = urgentVisitHolds(input)[0];
  if (held) return { ok: false, reason: held };
  if (input.doorLock) return { ok: false, reason: "door-lock" };
  if (!input.proPhone) return { ok: false, reason: "no-phone" };
  const t = input.now.getTime();
  if (t < Date.parse(input.window.from)) return { ok: false, reason: "before-visit" };
  if (t >= Date.parse(input.window.until)) return { ok: false, reason: "after-visit" };
  return { ok: true, window: { from: input.window.from, until: input.window.until } };
}

export type TimelineKind = "reported" | "guest-asked" | "guest-agreed" | "guest-declined" | "host-yes" | "code-shown" | "visit-done" | "photo";

export interface TimelineEntry {
  at: string;
  kind: TimelineKind;
  text: string;
}

export interface TimelineInput {
  timeZone: string;
  reportedAt: string;
  what: string;
  proName: string;
  guestAskedAt?: string[];
  guestAnswers?: GuestAnswer[];
  hostYesAt?: string;
  codeShownAt?: string[];
  done?: { at: string; note?: string };
  photos?: { at: string; from: "cleaner" | "pro" }[];
}

const NUMBER_WORD = "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|a|an|couple|few)";
const MONEY_WORD = "(?:dollars?|bucks?|grand|cents?|usd)";
/** Amounts, most specific first: spelled out, digits with a money word after or before, or a currency mark on either side. */
const AMOUNTS: readonly RegExp[] = [
  new RegExp(`\\b${NUMBER_WORD}(?:(?:[\\s-]+|\\s+and\\s+)${NUMBER_WORD})*\\s+${MONEY_WORD}\\b`, "gi"),
  new RegExp(`\\d[\\d,.]*\\s*k?\\s*${MONEY_WORD}\\b`, "gi"),
  /\b(?:usd|us\$)\s*\d[\d,.]*k?/gi,
  /[$€£]\s?\d[\d,.]*k?/g,
  /\d[\d,.]*\s?[$€£]/g,
];

/** Free text with no code, phone number or amount in it. */
export function timelineText(text: string): string {
  const joined = joinSplitDigits(text);
  return AMOUNTS.reduce((out, pattern) => out.replace(pattern, "[amount removed]"), joined).replace(/\d{4,}/g, "[number removed]");
}

function spanText(span: Span, timeZone: string): string {
  const from = formatWhen(span.from, timeZone);
  const until = formatWhen(span.until, timeZone);
  return from.day === until.day ? `${from.day}, ${from.time} to ${until.time}` : `${from.day} ${from.time} to ${until.day} ${until.time}`;
}

/** The record for the platform, oldest first: names and times only, never a code, phone number or cost. */
export function urgentTimeline(input: TimelineInput): TimelineEntry[] {
  const pro = timelineText(input.proName);
  const entries: TimelineEntry[] = [{ at: input.reportedAt, kind: "reported", text: `Reported: ${timelineText(input.what)}` }];
  for (const at of input.guestAskedAt ?? []) entries.push({ at, kind: "guest-asked", text: "The guest was asked about a repair visit." });
  for (const answer of input.guestAnswers ?? []) {
    if (answer.answer === "yes") entries.push({ at: answer.at, kind: "guest-agreed", text: answer.window ? `The guest agreed to a visit ${spanText(answer.window, input.timeZone)}.` : "The guest agreed to a visit." });
    else entries.push({ at: answer.at, kind: "guest-declined", text: "The guest declined the visit." });
  }
  if (input.hostYesAt) entries.push({ at: input.hostYesAt, kind: "host-yes", text: `The host approved ${pro}'s visit.` });
  for (const at of input.codeShownAt ?? []) entries.push({ at, kind: "code-shown", text: `The door code was shown to ${pro}.` });
  if (input.done) entries.push({ at: input.done.at, kind: "visit-done", text: input.done.note ? `${pro} finished: ${timelineText(input.done.note)}` : `${pro} finished.` });
  for (const photo of input.photos ?? []) entries.push({ at: photo.at, kind: "photo", text: `A photo from the ${photo.from}.` });
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => Date.parse(a.entry.at) - Date.parse(b.entry.at) || a.index - b.index)
    .map(({ entry }) => entry);
}
