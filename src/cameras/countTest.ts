import { zonedParts } from "../core/timezone";
import { addCalendarDays } from "../hub/calendar";
import { countable } from "./count";
import { isCameraEvent, latestCounts, type StoredLine } from "./lines";

/**
 * The counting test (#239): a week of a test property's real camera events, our counts against the host's own
 * review. `exportRows` and `toCsv` give the host a sheet with one row per counted event and empty columns for their
 * numbers; they find each event in their own Ring app by camera and time, so no image or link is in the sheet.
 * `fromCsv` and `scoreRows` read it back and score people, vehicles and animals, day and night apart, plus the
 * night peak (the most in one event each night), which is what the nightly check uses. Thresholds wait on this.
 */

export type Kind = "people" | "vehicles" | "animals";
export const KINDS: readonly Kind[] = ["people", "vehicles", "animals"];
type Triple = Record<Kind, number>;

export interface SheetRow {
  eventId: string;
  localDate: string;
  localTime: string;
  camera: string;
  label: string;
  period: "day" | "night";
  ours: Triple;
  /** The host's numbers; undefined when they left the row blank. */
  host?: Triple;
  note?: string;
}

/** Rough sunrise and sunset at mid-US latitudes, local clock time, by month. Good enough to split day from night. */
const SUN: Record<number, [string, string]> = {
  1: ["07:20", "16:50"],
  2: ["07:00", "17:25"],
  3: ["07:05", "19:00"],
  4: ["06:25", "19:35"],
  5: ["05:45", "20:05"],
  6: ["05:30", "20:30"],
  7: ["05:40", "20:30"],
  8: ["06:10", "20:00"],
  9: ["06:40", "19:10"],
  10: ["07:10", "18:20"],
  11: ["06:45", "16:45"],
  12: ["07:15", "16:35"],
};

export function isNight(localDate: string, localTime: string): boolean {
  const [rise, set] = SUN[Number(localDate.slice(5, 7))] ?? ["06:30", "18:30"];
  return localTime < rise || localTime >= set;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Every counted motion event between two local dates (the end date is not included), oldest first. */
export function exportRows(lines: readonly StoredLine[], opts: { timeZone: string; from: string; to: string; counter?: string }): SheetRow[] {
  const counts = latestCounts(lines, opts.counter);
  const rows: SheetRow[] = [];
  for (const line of lines.filter(isCameraEvent)) {
    const count = counts.get(line.id);
    if (!countable(line) || !count) continue;
    const p = zonedParts(new Date(line.at), opts.timeZone);
    const localDate = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
    if (localDate < opts.from || localDate >= opts.to) continue;
    const localTime = `${pad(p.hour)}:${pad(p.minute)}`;
    rows.push({ eventId: line.id, localDate, localTime, camera: line.device, label: line.label ?? "motion", period: isNight(localDate, localTime) ? "night" : "day", ours: { people: count.people, vehicles: count.vehicles, animals: count.animals } });
  }
  return rows.sort((a, b) => `${a.localDate} ${a.localTime}`.localeCompare(`${b.localDate} ${b.localTime}`));
}

const HEADER = ["event_id", "local_date", "local_time", "camera", "label", "period", "our_people", "our_vehicles", "our_animals", "host_people", "host_vehicles", "host_animals", "note"];
const cell = (value: string | number) => {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function toCsv(rows: readonly SheetRow[]): string {
  const body = rows.map((row) =>
    [row.eventId, row.localDate, row.localTime, row.camera, row.label, row.period, row.ours.people, row.ours.vehicles, row.ours.animals, row.host?.people ?? "", row.host?.vehicles ?? "", row.host?.animals ?? "", row.note ?? ""].map(cell).join(","),
  );
  return [HEADER.join(","), ...body].join("\n") + "\n";
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else current += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out;
}

const whole = (value: string | undefined) => (value !== undefined && /^\d+$/.test(value.trim()) ? Number(value.trim()) : undefined);

/** Reads a sheet back. A row is scored only when the host filled all three of their numbers. */
export function fromCsv(text: string): SheetRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const header = splitCsvLine(lines[0] ?? "").map((name) => name.trim());
  const at = (name: string) => header.indexOf(name);
  return lines.slice(1).flatMap((line) => {
    const cells = splitCsvLine(line);
    const get = (name: string) => cells[at(name)];
    const ours = { people: whole(get("our_people")), vehicles: whole(get("our_vehicles")), animals: whole(get("our_animals")) };
    const host = { people: whole(get("host_people")), vehicles: whole(get("host_vehicles")), animals: whole(get("host_animals")) };
    const eventId = get("event_id")?.trim();
    if (!eventId || ours.people === undefined || ours.vehicles === undefined || ours.animals === undefined) return [];
    const localDate = get("local_date")?.trim() ?? "";
    const localTime = get("local_time")?.trim() ?? "";
    const period = get("period")?.trim() === "night" || get("period")?.trim() === "day" ? (get("period")!.trim() as SheetRow["period"]) : isNight(localDate, localTime) ? "night" : "day";
    const note = get("note")?.trim();
    const filled = host.people !== undefined && host.vehicles !== undefined && host.animals !== undefined;
    return [
      {
        eventId,
        localDate,
        localTime,
        camera: get("camera") ?? "",
        label: get("label") ?? "",
        period,
        ours: ours as Triple,
        ...(filled ? { host: host as Triple } : {}),
        ...(note ? { note } : {}),
      },
    ];
  });
}

export interface KindScore {
  rows: number;
  exact: number;
  withinOne: number;
  over: number;
  under: number;
}

export interface PeakScore {
  nights: number;
  exact: number;
  over: number;
  under: number;
}

export interface CountScore {
  scored: number;
  blank: number;
  byPeriod: Record<"day" | "night", Record<Kind, KindScore>>;
  nightPeaks: Record<Kind, PeakScore>;
}

const emptyKinds = (): Record<Kind, KindScore> => ({ people: { rows: 0, exact: 0, withinOne: 0, over: 0, under: 0 }, vehicles: { rows: 0, exact: 0, withinOne: 0, over: 0, under: 0 }, animals: { rows: 0, exact: 0, withinOne: 0, over: 0, under: 0 } });

/** The stay night a row belongs to: before noon counts with the night before, as the nightly check does. */
const stayNight = (row: SheetRow) => (row.localTime < "12:00" ? addCalendarDays(row.localDate, -1) : row.localDate);

export function scoreRows(rows: readonly SheetRow[]): CountScore {
  const score: CountScore = { scored: 0, blank: 0, byPeriod: { day: emptyKinds(), night: emptyKinds() }, nightPeaks: { people: { nights: 0, exact: 0, over: 0, under: 0 }, vehicles: { nights: 0, exact: 0, over: 0, under: 0 }, animals: { nights: 0, exact: 0, over: 0, under: 0 } } };
  const nights = new Map<string, { ours: Triple; host: Triple }>();
  for (const row of rows) {
    if (!row.host) {
      score.blank += 1;
      continue;
    }
    score.scored += 1;
    const night = nights.get(stayNight(row)) ?? { ours: { people: 0, vehicles: 0, animals: 0 }, host: { people: 0, vehicles: 0, animals: 0 } };
    for (const kind of KINDS) {
      const s = score.byPeriod[row.period][kind];
      const diff = row.ours[kind] - row.host[kind];
      s.rows += 1;
      if (diff === 0) s.exact += 1;
      if (Math.abs(diff) <= 1) s.withinOne += 1;
      if (diff > 0) s.over += 1;
      if (diff < 0) s.under += 1;
      night.ours[kind] = Math.max(night.ours[kind], row.ours[kind]);
      night.host[kind] = Math.max(night.host[kind], row.host[kind]);
    }
    nights.set(stayNight(row), night);
  }
  for (const { ours, host } of nights.values()) {
    for (const kind of KINDS) {
      const peak = score.nightPeaks[kind];
      peak.nights += 1;
      if (ours[kind] === host[kind]) peak.exact += 1;
      else if (ours[kind] > host[kind]) peak.over += 1;
      else peak.under += 1;
    }
  }
  return score;
}

const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%` : "n/a");

export function formatReport(score: CountScore): string {
  const out = [`Counting test: ${score.scored} events scored, ${score.blank} left blank by the host.`, ""];
  for (const period of ["day", "night"] as const) {
    out.push(`${period === "day" ? "Day" : "Night"}:`);
    for (const kind of KINDS) {
      const s = score.byPeriod[period][kind];
      out.push(`  ${kind}: ${s.rows} events, exact ${pct(s.exact, s.rows)}, within one ${pct(s.withinOne, s.rows)}, over ${s.over}, under ${s.under}`);
    }
  }
  out.push("", "Night peak (most in one event each night, what the nightly check uses):");
  for (const kind of KINDS) {
    const p = score.nightPeaks[kind];
    out.push(`  ${kind}: ${p.nights} nights, exact ${pct(p.exact, p.nights)}, over ${p.over}, under ${p.under}`);
  }
  return out.join("\n") + "\n";
}
