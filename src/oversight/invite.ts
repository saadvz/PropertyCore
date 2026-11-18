import { isValidTimeZone, zonedParts, zonedTimeToUtc } from "../core/timezone";
import { addCalendarDays } from "../hub/calendar";
import { mayHoldCode } from "../hub/codeText";
import { MAX_NOTE, MAX_WHO, type VisitInput } from "./visits";

/**
 * An expected visit read from a calendar invite the visitor sent (#240). The date and times are read in code, in
 * the property's time zone, and never guessed: a time zone it can't read, a repeating invite, or one over more
 * than a day is refused, and the agent asks the host instead. Only the organizer's name and the title are kept;
 * the description, location and attendees never are.
 */

export type InviteRead = { ok: true; visit: Partial<VisitInput> & { date: string }; titleLeftOut?: true } | { ok: false; reason: string };

interface Field {
  params: string;
  value: string;
}

interface Local {
  date: string;
  time: string;
}

const refuse = (reason: string): InviteRead => ({ ok: false, reason });
const pad = (n: number) => String(n).padStart(2, "0");

function unfold(ics: string): string {
  return ics.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
}

function field(block: string, name: string): Field | undefined {
  for (const line of block.split("\n")) {
    const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    if (colon < 0) continue;
    const [key, ...params] = line.slice(0, colon).split(";");
    if (key?.trim().toUpperCase() === name) return { params: params.join(";"), value: line.slice(colon + 1).trim() };
  }
  return undefined;
}

function param(f: Field, name: string): string | undefined {
  for (const part of f.params.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim().toUpperCase() === name) return part.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return undefined;
}

const unescape = (text: string) => text.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").replace(/\s+/g, " ").trim();

function localOf(instant: Date, timeZone: string): Local {
  const p = zonedParts(instant, timeZone);
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

/** A timed DTSTART or DTEND at the property, or a reason it can't be read. */
function timed(f: Field, timeZone: string): Local | string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(f.value);
  if (!m) return "The invite's times can't be read. Ask the host for the day and time.";
  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number) as [number, number, number, number, number];
  if (m[7] === "Z") return localOf(new Date(Date.UTC(year, month - 1, day, hour, minute)), timeZone);
  const tzid = param(f, "TZID");
  if (tzid === undefined) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };
  if (!isValidTimeZone(tzid)) return "The invite's time zone isn't one I can read, so I won't guess its time. Ask the host for the day and time.";
  return localOf(zonedTimeToUtc({ year, month, day, hour, minute }, tzid), timeZone);
}

function dateOnly(f: Field): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(f.value);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

/** The first invite in the text that isn't cancelled, as an expected visit at the property. Saves nothing. */
export function visitFromInvite(ics: string, timeZone: string): InviteRead {
  const events = [...unfold(ics).matchAll(/BEGIN:VEVENT\n([\s\S]*?)END:VEVENT/g)].map((match) => match[1] ?? "");
  if (!events.length) return refuse("That isn't a calendar invite. Paste the invite file's text, or give the visit's details.");
  const event = events.find((body) => field(body, "STATUS")?.value.toUpperCase() !== "CANCELLED");
  if (event === undefined) return refuse("That invite was cancelled, so there's no visit to expect.");
  if (field(event, "RRULE") || field(event, "RDATE") || field(event, "RECURRENCE-ID")) {
    return refuse("That invite repeats. Save each visit from the host's words instead, starting with the next one.");
  }
  const start = field(event, "DTSTART");
  const end = field(event, "DTEND");
  if (!start) return refuse("The invite has no start. Ask the host for the day and time.");

  let span: { date: string; from?: string; to?: string };
  const allDay = dateOnly(start);
  if (allDay) {
    const endDate = end ? dateOnly(end) : undefined;
    if (end && endDate !== addCalendarDays(allDay, 1)) return refuse("The invite runs over more than one day. Save one day at a time, from the host's words.");
    span = { date: allDay };
  } else {
    if (!end) return refuse("The invite has no end time. Ask the host how long the visit is.");
    const from = timed(start, timeZone);
    if (typeof from === "string") return refuse(from);
    const to = timed(end, timeZone);
    if (typeof to === "string") return refuse(to);
    // An end at exactly midnight closes the same day.
    const close = to.date === addCalendarDays(from.date, 1) && to.time === "00:00" ? { date: from.date, time: "23:59" } : to;
    if (close.date !== from.date) return refuse("The invite runs over more than one day. Save one day at a time, from the host's words.");
    if (close.time <= from.time) return refuse("The invite ends before it starts. Ask the host for the time.");
    span = { date: from.date, from: from.time, to: close.time };
  }

  const organizer = field(event, "ORGANIZER");
  const name = organizer ? param(organizer, "CN")?.trim() : undefined;
  const who = name && name.length <= MAX_WHO && !mayHoldCode(name) ? name : undefined;
  const summary = field(event, "SUMMARY");
  // The code check reads the whole title before it's cut, so a code split by the cut is still caught.
  const whole = summary ? unescape(summary.value) : "";
  const titleLeftOut = whole !== "" && mayHoldCode(whole);
  const title = whole.slice(0, MAX_NOTE).trim();
  return {
    ok: true,
    visit: { ...(who ? { who } : {}), ...span, ...(title && !titleLeftOut ? { note: title } : {}) },
    ...(titleLeftOut ? { titleLeftOut: true as const } : {}),
  };
}
