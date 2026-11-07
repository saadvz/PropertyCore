/**
 * Where a property's calendar upload link lives, under its own base path. The two older prefixes,
 * Cleaner Core's and Supply Core's, still lead to the same link, so one issued before a deploy works.
 */

export const HUB_CALENDAR_PREFIX = "/calendar-link/";
const OLDER_PREFIXES = ["/cleaner-core/calendar-link/", "/supply/calendar/"] as const;
const UPLOAD_CODE = /^[A-Za-z0-9_-]{43}$/;

/** The one-time code in a calendar upload path, or undefined when the path isn't one. */
export function hubCalendarCode(pathname: string): string | undefined {
  for (const prefix of [HUB_CALENDAR_PREFIX, ...OLDER_PREFIXES]) {
    if (!pathname.startsWith(prefix)) continue;
    const code = pathname.slice(prefix.length);
    return UPLOAD_CODE.test(code) ? code : undefined;
  }
  return undefined;
}

/** Where a property's door code upload link lives. Cleaner Core's older prefix still leads to it. */
export const HUB_DOOR_CODE_PREFIX = "/door-code/";
const OLDER_DOOR_PREFIX = "/cleaner-core/door-code/";

/** The one-time code in a door code upload path, or undefined when the path isn't one. */
export function hubDoorCode(pathname: string): string | undefined {
  for (const prefix of [HUB_DOOR_CODE_PREFIX, OLDER_DOOR_PREFIX]) {
    if (!pathname.startsWith(prefix)) continue;
    const code = pathname.slice(prefix.length);
    return UPLOAD_CODE.test(code) ? code : undefined;
  }
  return undefined;
}
