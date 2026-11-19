import type { EntryEvent } from "../oversight/events";

/**
 * Visit records' raw events (#237): what the property's lock reported, what was said to and from the cleaner, the
 * pros and the host, and every visit window as it was set or moved. Lines are written once and never edited; visit
 * records are derived from them. Nothing here holds a door code, a code's digits or a phone number.
 */

/** One lock event in a shape no lock partner owns. The lock connection (#180) maps its own events into it. */
export interface LockEvent {
  type: "lock";
  /** The provider's own event id, so a resent webhook is stored once. */
  id: string;
  /** ISO time the lock says it happened. */
  at: string;
  /** The lock's name, like "Front door". */
  device: string;
  action: "unlock" | "lock";
  /** Where it was worked from, when the lock says. "outside" covers the keypad and a lock-from-outside button. */
  side?: "outside" | "inside";
  /** The lock's own name for the code used, like "Cleaner" or "Maria". Unset when the lock doesn't say. */
  codeName?: string;
  /** The provider's word as given ("keypad", "app", "auto"). Kept, never read by a rule. */
  method?: string;
}

/** The lock connection says the lock was connected or disconnected. */
export interface LockConnectionEvent {
  type: "lock-connection";
  id: string;
  at: string;
  connected: boolean;
}

export type MessageRole = "cleaner" | "pro" | "host" | "observer" | "group";

/** One text to or from someone about a visit. The body is redacted before it's written; a door-code text has none. */
export interface MessageEvent {
  type: "message";
  id: string;
  at: string;
  direction: "in" | "out";
  role: MessageRole;
  /** A hash of the phone, keyed with the property's own salt. Never the phone. */
  personKey?: string;
  /** The visit it was about, as a visit id ("cleaning:<jobId>"). */
  visit?: string;
  /** What it was: "start", "done", "door-code", "late-ask", "visit-note", "reminder", "other" and so on. */
  label: string;
  body?: string;
}

export type VisitKind = "cleaning" | "repair" | "crew-day";

export interface VisitWho {
  role: "cleaner" | "pro";
  name: string;
  proId?: string;
}

/** A visit's window as it was set or moved. The latest one for a visit counts. */
export interface WindowEvent {
  type: "visit-window";
  id: string;
  at: string;
  visit: string;
  kind: VisitKind;
  /** ISO instants. */
  from: string;
  until: string;
  /** When the person is expected: the cleaner's saved arrival time, else the window's start. */
  expectedAt: string;
  sameDay: boolean;
  /** The next guests' check-in, when there is one. */
  checkIn?: string;
  who: VisitWho;
}

export interface CancelEvent {
  type: "visit-cancelled";
  id: string;
  at: string;
  visit: string;
}

/** A step on Fixer Core's visit page: the pro's "I'm at the door", or their done. */
export interface PageEvent {
  type: "visit-page";
  id: string;
  at: string;
  visit: string;
  step: "at-door" | "done";
}

export type VisitEvent = LockEvent | LockConnectionEvent | MessageEvent | WindowEvent | CancelEvent | PageEvent;

/** A line as stored: the event and when it was written. */
export type StoredEvent = VisitEvent & { loggedAt: string };

/** Whose a lock code is, in Property Core's own terms. "shared" is a code more than one person uses. */
export type CodePerson = { role: "cleaner" } | { role: "pro"; proId: string } | { role: "host" } | { role: "guest" } | { role: "shared" };

/** The lock's name for a code, mapped to its person. Keys are compared with case and spacing ignored. */
export type CodeNames = Record<string, CodePerson>;

export const codeKey = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();

/** The person a lock event's code belongs to. Undefined when the lock didn't name the code, or nobody saved it. */
export function codePerson(codeNames: CodeNames, codeName: string | undefined): CodePerson | undefined {
  if (!codeName) return undefined;
  const key = codeKey(codeName);
  for (const [name, person] of Object.entries(codeNames)) if (codeKey(name) === key) return person;
  return undefined;
}

export const cleaningVisit = (jobId: string): string => `cleaning:${jobId}`;
export const repairVisit = (jobId: string): string => `repair:${jobId}`;
export const crewVisit = (jobId: string, day: string): string => `crew:${jobId}:${day}`;

/** The job id inside a visit id. */
export const jobOfVisit = (visit: string): string => visit.split(":")[1] ?? "";

/**
 * Remote oversight's entry events (#240), from the same raw lines: each unlock, with `person` the name of the
 * code's person when it's known. So #240's same-day check and visit records read one source.
 */
export function entryEventsFrom(events: readonly VisitEvent[], codeNames: CodeNames, names: { cleaner?: string; pros?: Record<string, string> } = {}): EntryEvent[] {
  const out: EntryEvent[] = [];
  for (const event of events) {
    if (event.type !== "lock" || event.action !== "unlock") continue;
    const person = codePerson(codeNames, event.codeName);
    const name = person?.role === "cleaner" ? (names.cleaner ?? "Cleaner") : person?.role === "pro" ? names.pros?.[person.proId] : undefined;
    out.push({ id: event.id, at: event.at, device: event.device, ...(name ? { person: name } : {}), ...(event.method ? { method: event.method } : {}) });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
