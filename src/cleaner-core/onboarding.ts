import { isScratchTestNumber } from "./scratch";
import { isTenantPhone, SCRATCH_TENANTS } from "./tenants";
import { schedulerOptInBody } from "./cleanerTexts";

export const PROPERTY_PROMPT =
  "What should I call this property? Send the nickname, the street address, the time zone, the usual checkout time, the usual check-in time, and the host phone, separated by |.";
export const PROPERTY_RETRY =
  "I need a nickname, a street address, a time zone, a checkout time, a check-in time, and a Scratch host phone, separated by |.";
export const SOURCES_PROMPT =
  "Which booking sources should I read? Name each one. Say whether early check-ins or late checkouts are agreed on Airbnb, outside that calendar. Do not add a separate Airbnb or Vrbo feed when Guesty Lite already includes those stays.";
export const DUPLICATE_FEED =
  "Guesty Lite already includes Airbnb and Vrbo stays. I did not add a second feed. Name the sources again, without a separate Airbnb or Vrbo feed.";
export const SOURCES_RETRY = "Name at least one booking source, such as Guesty Lite, Google Calendar, or Notion.";
export const PEOPLE_PROMPT =
  "Who should get texts? Send the cleaner's phone, then each other person's role and phone. Roles are owner, manager, or observer. I won't text anyone until they reply YES.";
export const PEOPLE_RETRY =
  "Send the cleaner phone, then each other person as a role and a phone. Use owner, manager, or observer. Each phone has to be a Scratch number for this property.";
// This setup saves only quiet hours and who to escalate to, so it asks for nothing else.
export const SCHEDULE_PROMPT =
  "Which quiet hours should cleaning texts wait out, and who should I escalate problems to? For example: quiet hours 9:00 PM to 8:00 AM, escalate to the host.";
export const SCHEDULE_RETRY = "Send quiet hours as a start and an end, and say who to escalate to.";
export const ACCESS_PROMPT =
  "What is the permanent outdoor code, and where is the lock? I store a sealed reference and never print the digits. This demo cannot rotate, revoke, or control the lock. When you change the code, change it on the lock yourself, then tell me it changed.";
export const ACCESS_RETRY = "Send the outdoor code and where the lock is. I will store a sealed reference and will not repeat the digits.";
export const ACCESS_ACK =
  "Recorded a sealed code for the outdoor lock. This demo cannot rotate, revoke, or control the lock. Change the code on the lock yourself, then tell me it changed. The code goes only to the approved cleaner after you say the guests have left. It does not go to a group, an observer, a mirrored copy, or a number that has not opted in.";
export const OPTIONAL_PROMPT =
  "Do you want checklists, photos, supplies, a ledger, or a review of old cleaner texts? Old texts are not consent. Reply SKIP to leave this out.";
export const OPTIONAL_ACK = "Saved. Old texts are not consent, and I did not opt anyone in from them.";
export const NOT_ACTIVATED = "Not activated. The cleaner has not opted in, so I did not send a cleaning text.";

export type OnboardingStep =
  | "property"
  | "sources"
  | "preview"
  | "people"
  | "schedule"
  | "access"
  | "optional"
  | "review"
  | "active";

export type PersonRole = "owner" | "manager" | "observer" | "cleaner";

export interface OnboardingPerson {
  phone: string;
  role: PersonRole;
  name?: string;
  consent: "pending" | "in" | "out";
}

export interface OnboardingSession {
  step: OnboardingStep;
  prompts: string[];
  inboundIds: string[];
  nickname: string;
  address: string;
  timeZone: string;
  checkoutLabel: string;
  checkInLabel: string;
  checkout: string;
  checkIn: string;
  hostPhone: string;
  sourceLine: string;
  airbnbExceptions: boolean;
  people: OnboardingPerson[];
  quietFrom: string;
  quietUntil: string;
  quietLabel: string;
  escalate: string;
  lockWhere: string;
  sealed: boolean;
  optionalNote: string;
  activated: boolean;
  published: boolean;
  tenantId: string;
}

export interface OnboardingPreview {
  stays: number;
  blocks: number;
  stale: boolean;
  conflicts: number;
  sourceLabel: string;
}

export interface OnboardingEffect {
  session: OnboardingSession;
  prompt: string;
  optIn: { phone: string; body: string }[];
  pin?: string;
  publish: boolean;
}

export function beginOnboarding(): OnboardingEffect {
  const session = emptySession();
  session.prompts = [PROPERTY_PROMPT];
  return { session, prompt: PROPERTY_PROMPT, optIn: [], publish: false };
}

export function applyOnboardingAnswer(
  session: OnboardingSession,
  input: { id: string; from: string; text: string },
  preview: OnboardingPreview,
): OnboardingEffect {
  if (session.inboundIds.includes(input.id) || session.activated) {
    return { session, prompt: currentPrompt(session), optIn: [], publish: false };
  }
  const next: OnboardingSession = {
    ...session,
    inboundIds: [...session.inboundIds, input.id],
    people: session.people.map((person) => ({ ...person })),
    prompts: [...session.prompts],
  };
  const from = input.from.trim();
  const text = input.text.trim();
  if (isYes(text)) {
    const person = next.people.find((item) => item.phone === from && item.consent === "pending");
    if (person) person.consent = "in";
    return finish(next, currentPrompt(next), [], false);
  }
  if (/^\s*stop\s*$/i.test(text)) {
    const person = next.people.find((item) => item.phone === from);
    if (person) person.consent = "out";
    return finish(next, currentPrompt(next), [], false);
  }
  if (next.step === "property") return answerProperty(next, text);
  if (next.step === "sources") return answerSources(next, text, preview);
  if (next.step === "preview") return answerPreview(next, text);
  if (next.step === "people") return answerPeople(next, text);
  if (next.step === "schedule") return answerSchedule(next, text);
  if (next.step === "access") return answerAccess(next, text);
  if (next.step === "optional") return answerOptional(next, text);
  return answerReview(next, text);
}

export function previewPrompt(session: OnboardingSession, preview: OnboardingPreview): string {
  const stays = preview.stays === 1 ? "1 stay" : `${preview.stays} stays`;
  const blocks = preview.blocks === 1 ? "1 block" : `${preview.blocks} blocks`;
  const fresh = preview.stale ? `${preview.sourceLabel} is stale.` : `${preview.sourceLabel} was read just now.`;
  const conflicts = preview.conflicts === 1 ? "1 date conflict." : `${preview.conflicts} date conflicts.`;
  return `Preview for ${session.nickname}: ${stays}, ${blocks}. ${fresh} ${conflicts} A block is not a departure. Airbnb timing changes are not in the calendar. I will not assume the place is empty. Reply OK to continue.`;
}

export function reviewPrompt(session: OnboardingSession): string {
  const cleaner = session.people.find((person) => person.role === "cleaner");
  const observer = session.people.find((person) => person.role === "observer");
  const cleanerLine = cleaner
    ? `Cleaner ${cleaner.phone} is ${cleaner.consent === "in" ? "opted in" : "not opted in"}.`
    : "No cleaner is on this property.";
  const observerLine = observer
    ? `${observer.name ?? "The observer"} at ${observer.phone} is an observer and does not get the door code.`
    : "No observer is on this property.";
  const airbnb = session.airbnbExceptions
    ? "Airbnb timing stays with you, not the calendar."
    : "You did not record an Airbnb timing exception.";
  return `Dry run for ${session.nickname} at ${session.address}. ${cleanerLine} ${observerLine} Quiet hours ${session.quietLabel}. Escalate to ${session.escalate}. ${airbnb} This demo cannot rotate or revoke the lock. Reply APPROVE to activate. I will not activate without the cleaner's YES and your APPROVE.`;
}

export function activatedPrompt(session: OnboardingSession): string {
  return `Activated ${session.nickname}. I will text only the numbers that opted in. I will not infer consent, a vacancy, or a lock-code change.`;
}

export function optInBody(session: OnboardingSession): string {
  return schedulerOptInBody(session.nickname, session.address);
}

function answerProperty(session: OnboardingSession, text: string): OnboardingEffect {
  const parts = text.split("|").map((part) => part.trim());
  if (parts.length !== 6 || parts.some((part) => part === "")) return finish(session, PROPERTY_RETRY, [], false);
  const [nickname, address, timeZone, checkoutLabel, checkInLabel, hostPhone] = parts as [string, string, string, string, string, string];
  const checkout = clockOf(checkoutLabel);
  const checkIn = clockOf(checkInLabel);
  const tenantId = nickname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!checkout || !checkIn || !timeZone.includes("/") || !isScratchTestNumber(hostPhone) || tenantId === "" || tenantId === "scratch-lane" || tenantId === "scratch-court") {
    return finish(session, PROPERTY_RETRY, [], false);
  }
  if (belongsToKnownTenant(hostPhone)) return finish(session, PROPERTY_RETRY, [], false);
  session.nickname = nickname;
  session.address = address;
  session.timeZone = timeZone;
  session.checkoutLabel = checkoutLabel;
  session.checkInLabel = checkInLabel;
  session.checkout = checkout;
  session.checkIn = checkIn;
  session.hostPhone = hostPhone;
  session.tenantId = tenantId;
  session.step = "sources";
  return finish(session, SOURCES_PROMPT, [], false);
}

function answerSources(session: OnboardingSession, text: string, preview: OnboardingPreview): OnboardingEffect {
  const lower = text.toLowerCase();
  const namesAFeed = /\b(airbnb|vrbo)\s+(feed|ical|calendar)\b/.test(lower) || /\b(separate|another|second)\s+(airbnb|vrbo)\b/.test(lower);
  if (/guesty/.test(lower) && namesAFeed) return finish(session, DUPLICATE_FEED, [], false);
  if (!/\b(guesty|notion|google)\b/.test(lower)) return finish(session, SOURCES_RETRY, [], false);
  session.sourceLine = text;
  session.airbnbExceptions = /\bairbnb\b/.test(lower) && /\b(early|late|timing|outside)\b/.test(lower);
  session.step = "preview";
  return finish(session, previewPrompt(session, preview), [], false);
}

function answerPreview(session: OnboardingSession, text: string): OnboardingEffect {
  if (!/^\s*ok\s*$/i.test(text)) return finish(session, currentPrompt(session), [], false);
  session.step = "people";
  return finish(session, PEOPLE_PROMPT, [], false);
}

function answerPeople(session: OnboardingSession, text: string): OnboardingEffect {
  const found = [...text.matchAll(/\b(cleaner|manager|observer|owner)\b\s+(?:(cory)\s+)?(\+\d{10,15})/gi)];
  if (found.length === 0) return finish(session, PEOPLE_RETRY, [], false);
  const people: OnboardingPerson[] = [];
  for (const match of found) {
    const namedCory = typeof match[2] === "string" && match[2].toLowerCase() === "cory";
    const role = namedCory ? "observer" : (match[1]?.toLowerCase() as PersonRole);
    const phone = match[3] ?? "";
    if (!isScratchTestNumber(phone) || belongsToKnownTenant(phone) || phone === session.hostPhone) return finish(session, PEOPLE_RETRY, [], false);
    people.push({ phone, role, ...(namedCory ? { name: "Cory" } : {}), consent: "pending" });
  }
  if (!people.some((person) => person.role === "cleaner")) return finish(session, PEOPLE_RETRY, [], false);
  session.people = people;
  session.step = "schedule";
  const body = optInBody(session);
  return finish(session, SCHEDULE_PROMPT, people.map((person) => ({ phone: person.phone, body })), false);
}

function answerSchedule(session: OnboardingSession, text: string): OnboardingEffect {
  const quiet = /quiet hours\s+(.+?)\s+to\s+([^.]*)/i.exec(text);
  const escalate = /escalate to\s+([^.]*)/i.exec(text);
  const from = quiet ? clockOf(quiet[1] ?? "") : undefined;
  const until = quiet ? clockOf(quiet[2] ?? "") : undefined;
  if (!from || !until || !escalate || escalate[1]?.trim() === "") return finish(session, SCHEDULE_RETRY, [], false);
  session.quietFrom = from;
  session.quietUntil = until;
  session.quietLabel = `${(quiet?.[1] ?? "").trim()} to ${(quiet?.[2] ?? "").trim()}`;
  session.escalate = escalate[1]?.trim() ?? "";
  session.step = "access";
  return finish(session, ACCESS_PROMPT, [], false);
}

function answerAccess(session: OnboardingSession, text: string): OnboardingEffect {
  const code = /\b(\d{4,8})\b/.exec(text);
  if (!code?.[1]) return finish(session, ACCESS_RETRY, [], false);
  session.sealed = true;
  session.lockWhere = "the outdoor lock";
  session.step = "optional";
  return finish(session, `${ACCESS_ACK} ${OPTIONAL_PROMPT}`, [], false, code[1]);
}

function answerOptional(session: OnboardingSession, text: string): OnboardingEffect {
  session.optionalNote = /^\s*skip\s*$/i.test(text) ? "not included" : "noted";
  session.step = "review";
  return finish(session, `${OPTIONAL_ACK} ${reviewPrompt(session)}`, [], false);
}

function answerReview(session: OnboardingSession, text: string): OnboardingEffect {
  if (!/^\s*approve\s*$/i.test(text)) return finish(session, reviewPrompt(session), [], false);
  const cleaner = session.people.find((person) => person.role === "cleaner");
  if (!cleaner || cleaner.consent !== "in") return finish(session, NOT_ACTIVATED, [], false);
  session.activated = true;
  session.published = true;
  session.step = "active";
  return finish(session, activatedPrompt(session), [], true);
}

function finish(session: OnboardingSession, prompt: string, optIn: { phone: string; body: string }[], publish: boolean, pin?: string): OnboardingEffect {
  if (session.prompts[session.prompts.length - 1] !== prompt) session.prompts.push(prompt);
  return { session, prompt, optIn, publish, ...(pin ? { pin } : {}) };
}

function currentPrompt(session: OnboardingSession): string {
  return session.prompts[session.prompts.length - 1] ?? PROPERTY_PROMPT;
}

function emptySession(): OnboardingSession {
  return {
    step: "property",
    prompts: [],
    inboundIds: [],
    nickname: "",
    address: "",
    timeZone: "",
    checkoutLabel: "",
    checkInLabel: "",
    checkout: "",
    checkIn: "",
    hostPhone: "",
    sourceLine: "",
    airbnbExceptions: false,
    people: [],
    quietFrom: "",
    quietUntil: "",
    quietLabel: "",
    escalate: "",
    lockWhere: "",
    sealed: false,
    optionalNote: "",
    activated: false,
    published: false,
    tenantId: "",
  };
}

function isYes(text: string): boolean {
  return /^\s*yes\s*$/i.test(text);
}

function clockOf(text: string): string | undefined {
  const match = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(text.trim());
  if (!match?.[1] || !match[2]) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) return undefined;
  const meridiem = match[3]?.toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (hour > 23) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function belongsToKnownTenant(phone: string): boolean {
  return SCRATCH_TENANTS.some((tenant) => isTenantPhone(tenant, phone));
}
