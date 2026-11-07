import { createHash } from "node:crypto";
import { refuseCards } from "./cards";
import { calendarUrlAllowed } from "./fetchLimits";

/**
 * A property's saved booking calendars, and the names every flow gives them. The source ids and the
 * link hash are the ones Cleaner Core's job engine holds, so the hub and the engine name a calendar
 * the same way.
 */

/** The legacy single link from save_calendar_link reads as one calendar with this name. */
export const LEGACY_CALENDAR = "Guesty Lite";
export const MAX_CALENDARS = 8;
export const MAX_CALENDAR_NAME = 40;

export const DOOR_CODE_IN_CHAT = "Please don't send the door code in chat. Use the private box instead.";
export const CALENDAR_COUNT_REFUSED = `I can keep up to ${MAX_CALENDARS} calendar links.`;
export const CALENDAR_NAME_MISSING = "Give each calendar link a name, like Airbnb or Vrbo.";
export const CALENDAR_NAME_LONG = `Keep the calendar's name under ${MAX_CALENDAR_NAME} characters.`;
export const CALENDAR_MASKED = "That link came through masked, so I didn't save it. Ask for an upload link and send it to the host.";
export const CALENDAR_CARD = "That looks like a card number. A calendar link never holds card details.";
export const calendarPrivate = (name: string) => `I can't use the ${name} link. It has to be a public https address, and not a private network.`;

/** The line get_state and get_supply_state carry while calendars wait in the set-aside list. Names only. */
export function setAsideLine(names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  return `Supply Core had its own calendars (${names.join(", ")}) that aren't in this property's list. Ask the host whether to add them.`;
}

/** A calendar as hub.json keeps it. `legacy` marks the single link from save_calendar_link. */
export interface StoredCalendar {
  name: string;
  url: string;
  legacy?: true;
}

/** A saved calendar with the id and link hash the engine knows it by. */
export interface SavedCalendar {
  name: string;
  url: string;
  sourceId: string;
  origin: string;
}

/** One saved source as the engine holds it: a calendar's id and link hash, or Google. */
export interface CalendarClaim {
  id: string;
  origin?: string;
}

export type CalendarRefusal = "masked" | "private" | "card" | "code" | "name" | "count";

/** Characters a secure card shows in place of a value it hides. */
const MASK_MARK = /[*•●·]/;

/** True when a calendar link is a secure card's placeholder, like [REDACTED] or dots. */
export function maskedLink(url: string): boolean {
  return /redacted|\[hidden\]/i.test(url) || MASK_MARK.test(url);
}

/** A hash of the calendar link, never the link. Ties a read to the link, not the name. */
export function originOf(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/** Lowercase, each run of other characters as one dash, at most 32 characters, and unique. */
export function calendarSlug(name: string, used: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "calendar";
  for (let count = 1; ; count++) {
    const suffix = count === 1 ? "" : `-${count}`;
    const slug = `${base.slice(0, 32 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (used.has(slug)) continue;
    used.add(slug);
    return slug;
  }
}

/** The saved calendars with their source ids. The legacy link is `guesty-lite`; the others `ical:<slug>`. */
export function savedCalendars(list: readonly StoredCalendar[]): SavedCalendar[] {
  const used = new Set<string>();
  return list.map((calendar) => ({
    name: calendar.name,
    url: calendar.url,
    sourceId: calendar.legacy ? "guesty-lite" : `ical:${calendarSlug(calendar.name, used)}`,
    origin: originOf(calendar.url),
  }));
}

/** Every saved source in dedupe order, as the engine holds them. */
export function claimsOf(list: readonly StoredCalendar[], google: boolean): CalendarClaim[] {
  return [...savedCalendars(list).map((calendar) => ({ id: calendar.sourceId, origin: calendar.origin })), ...(google ? [{ id: "google-calendar" }] : [])];
}

/**
 * The part of a link after its path: the query and fragment. A card number is looked for only there,
 * because a booking site's listing id in the path (Airbnb's run to 19 digits) can pass the card check.
 */
function linkQuery(url: string): string {
  const at = url.search(/[?#]/);
  return at < 0 ? "" : url.slice(at);
}

/** Why a calendar's link can't be saved, without its door-code check, or undefined. */
export function calendarRefusal(name: string, url: string): { reason: CalendarRefusal; error: string } | undefined {
  if (!name) return { reason: "name", error: CALENDAR_NAME_MISSING };
  if (maskedLink(url)) return { reason: "masked", error: CALENDAR_MASKED };
  if (refuseCards(name) || refuseCards(linkQuery(url))) return { reason: "card", error: CALENDAR_CARD };
  if (!calendarUrlAllowed(url)) return { reason: "private", error: calendarPrivate(name) };
  return undefined;
}
