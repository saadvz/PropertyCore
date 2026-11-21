/**
 * Bring-in code wording (#241). New person-facing and host-facing text, flagged for the wording pass. Never logged;
 * only the code text itself holds a code, and it goes to the person the host picked, by the consent-checked send.
 */

function firstName(name: string | undefined): string {
  return name?.trim().split(/\s+/)[0] || "there";
}

function clock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
}

/** The one text to the bring-in person, with their own code. */
export function bringInCodeText(f: { name?: string; street: string; code: string; lockLocation?: string; doors?: { door: string; code: string }[]; until: string; timeZone: string }): string {
  const codes = f.doors && f.doors.length > 1 ? `the door codes are ${f.doors.map((item) => `${item.door}: ${item.code}`).join(", ")}` : `the door code is ${f.code}${f.lockLocation ? `, at ${f.lockLocation}` : ""}`;
  return `Hi ${firstName(f.name)}, there's a package at the door at ${f.street}. To bring it inside, ${codes}. It works until ${clock(f.until, f.timeZone)}, and stops once the package is marked inside.`;
}

/** The plan_bring_in / mark_package_seen next step on connected locks, under ask. */
export const BRING_IN_ASK =
  "The person's own bring-in code goes on the lock once the drop is seen, for the bring-in window only. It goes to them by text after the host's OK: ask the host, then call approve_bring_in_code with the orderId.";
/** The same, on automatic. */
export const BRING_IN_AUTO =
  "The person gets their own bring-in code by text once the drop is seen. It works only until the deadline, and stops once the package is marked inside. Tell the host who is bringing it in and by when.";

export function approveQuestion(f: { name?: string; until: string; timeZone: string }): string {
  return `Text ${f.name ?? "the person bringing the package in"} their own door code to bring the package in? It works until ${clock(f.until, f.timeZone)}.`;
}

export function textedNote(f: { name?: string }): string {
  return `${f.name ?? "The person bringing the package in"} got the bring-in code by text.`;
}

export function textsOffNote(f: { name?: string }): string {
  return `Texts can't go out from this property yet, so ${f.name ?? "the person bringing the package in"} won't get the bring-in code by text. Let them in yourself.`;
}

export function unsureNote(f: { name?: string }): string {
  return `The bring-in code text to ${f.name ?? "the person bringing the package in"} may not have gone out. Check with them, or let them in yourself.`;
}

export function refusedNote(f: { name?: string }): string {
  return `I couldn't get ${f.name ?? "the bring-in person"}'s code from the lock, so it wasn't sent. Let them in yourself.`;
}

export function duringStayNote(f: { name?: string }): string {
  return `Guests are staying, so ${f.name ?? "the person bringing the package in"} gets no door code for this package. The guests can bring it in, or you let someone in yourself.`;
}
