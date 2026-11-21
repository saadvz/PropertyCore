/**
 * Bring-in code wording (#241), from the #273/#275 wording pass. Never logged;
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
  return `Hi ${firstName(f.name)}, a package is waiting at the door at ${f.street}. To bring it inside, ${codes}. It works until ${clock(f.until, f.timeZone)}, and stops once the package is in.`;
}

/** The plan_bring_in / mark_package_seen next step on connected locks, under ask. */
export const BRING_IN_ASK =
  "Once the package is seen at the door, the person gets their own door code, live only until the bring-in deadline. It goes to them by text after the host's OK: ask the host, then call approve_bring_in_code with the orderId.";
/** The same, on automatic. */
export const BRING_IN_AUTO =
  "Once the package is seen at the door, the person gets their own door code by text. It works only until the deadline, and stops once you call mark_brought_in. Tell the host who is bringing it in and by when.";

export function approveQuestion(f: { name?: string; until: string; timeZone: string }): string {
  return `Should I text ${f.name ?? "the person bringing the package in"} a door code to bring the package in? It works until ${clock(f.until, f.timeZone)}.`;
}

export function textedNote(f: { name?: string }): string {
  return `I texted ${f.name ?? "the person bringing the package in"} the door code to bring the package in.`;
}

export function textsOffNote(f: { name?: string }): string {
  return `Texts can't go out from this property yet, so I can't text ${f.name ?? "the person bringing the package in"} a door code for the package. You'll need to let them in.`;
}

export function unsureNote(f: { name?: string }): string {
  return `My text to ${f.name ?? "the person bringing the package in"} with the door code may not have gone out. Check with them, or let them in yourself.`;
}

export function refusedNote(f: { name?: string }): string {
  return `I couldn't get a door code for ${f.name ?? "the person bringing the package in"} from the lock, so nothing was sent. You'll need to let them in.`;
}

export function duringStayNote(f: { name?: string }): string {
  return `Guests are staying, so I won't make ${f.name ?? "the person bringing the package in"} a door code for this package. The guests can bring it in, or you can let someone in.`;
}
