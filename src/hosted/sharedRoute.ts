import { streetOf } from "../hub/people";

/**
 * The words for a person who is on several of an account's properties (saadvz/TourCore#190): which
 * property their text names, their answer to "which property?", and the line's own replies. Every
 * function looks only at the person's own properties, so nothing here can name another one.
 */

export interface Named {
  id: string;
  label: string;
  nickname?: string;
  address?: string;
}

const fold = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The names a property goes by: its label, nickname, and the street part of its address, with or without its number. */
function namesOf(property: Named): string[] {
  const street = property.address ? streetOf(property.address) : undefined;
  const names = [property.label, property.nickname, street, street?.replace(/^\d+[a-z]?\s+/i, "")];
  return names.map((name) => (name ? fold(name) : "")).filter((name) => name.length > 0);
}

function says(text: string, name: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escape(name)}($|[^a-z0-9])`).test(text);
}

/** The one property the text names as a whole word or phrase. Two or more named reads as none. */
export function namedProperty(text: string, own: Named[]): string | undefined {
  const folded = fold(text);
  const hits = own.filter((property) => namesOf(property).some((name) => says(folded, name)));
  return hits.length === 1 ? hits[0]!.id : undefined;
}

/** An answer to the ask: a bare number from its list, or a name. */
export function answerOf(text: string, own: Named[]): string | undefined {
  const folded = fold(text);
  if (/^\d+$/.test(folded)) return own[Number(folded) - 1]?.id;
  return namedProperty(text, own);
}

/** True when the whole text is only a number or one of a property's names: an answer with nothing more to say. */
export function bareAnswer(text: string, own: Named[]): boolean {
  const folded = fold(text).replace(/[.!?,]+$/, "").trim();
  return /^\d+$/.test(folded) || own.some((property) => namesOf(property).includes(folded));
}

/** The ask, by the street part of each address. Labels are the host's own names and aren't used. */
export function whichPropertyText(own: Named[]): string {
  const items = own.map((property, i) => `${i + 1} for ${property.address ? streetOf(property.address) : `property ${i + 1}`}`);
  const list = items.length <= 2 ? items.join(" or ") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
  return `Which property is this about? Reply ${list}.`;
}

export function lineStopText(business: string): string {
  return `You're opted out of texts from ${business}. Reply START to opt back in. Reply HELP for help.`;
}

export function lineStartText(business: string): string {
  return `You're opted back in to texts from ${business}. Reply STOP to opt out.`;
}

export function droppedNote(who: string): string {
  return `A text from ${who} couldn't be matched to a property.`;
}

/** The refusal, to the agent only, when a saved phone is already a person on another property. */
export function sharedRefusal(places: { label: string; role: string }[]): string {
  const where = places.map((place) => `${place.label} as the ${place.role}`).join(" and on ");
  return `That number is already on ${where}. Ask the host whether the same person helps here too, then save again with shared: true.`;
}

/** The one business name all the person's properties share, else "this number". */
export function businessFor(names: (string | undefined)[]): string {
  const set = new Set(names.map((name) => name?.trim()));
  const [only] = [...set];
  return set.size === 1 && only ? only : "this number";
}
