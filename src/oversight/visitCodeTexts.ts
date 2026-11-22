/**
 * Visit code wording (#280 17). Never logged; only the code text itself holds a code, and it goes only to the
 * visitor's own phone, by the consent-checked send.
 */

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || "there";
}

function clock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
}

/** The one opt-in text. Nothing else goes to the visitor before their YES. */
export function visitInviteText(street: string): string {
  return `This is the text line for ${street}. The host is expecting you and wants to give you your own door code. Reply YES to get it by text before your visit, or STOP to opt out.`;
}

/** The one text with the visitor's own code, from 30 minutes before the visit. */
export function visitCodeText(f: { name: string; street: string; code: string; lockLocation?: string; doors?: { door: string; code: string }[]; until: string; timeZone: string }): string {
  const codes = f.doors && f.doors.length > 1 ? `your door codes at ${f.street} are ${f.doors.map((item) => `${item.door}: ${item.code}`).join(", ")}` : `your door code at ${f.street} is ${f.code}${f.lockLocation ? `, at ${f.lockLocation}` : ""}`;
  return `Hi ${firstName(f.name)}, ${codes}. It works until ${clock(f.until, f.timeZone)} today.`;
}

export const visitTextedNote = (who: string): string => `${who} has their door code for today's visit.`;
export const visitTextsOffNote = (who: string): string => `I can't text ${who} yet, so they don't have their door code. Let them in another way.`;
export const visitUnsureNote = (who: string): string => `I'm not sure ${who}'s code text went out. Check with them before their visit.`;
export const visitRefusedNote = (who: string): string => `I couldn't get a door code for ${who} from the lock, so nothing was sent. You'll need to let them in.`;
export const visitDuringStayNote = (who: string): string => `${who}'s visit falls during a guest's stay, so they get no door code. You'll need to let them in.`;
export const visitInviteFailedNote = (who: string): string => `The text asking ${who} to reply YES for their door code couldn't go out after several tries. Check the number with the host, or let them in another way.`;
