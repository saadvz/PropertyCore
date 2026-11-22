import { createHash } from "node:crypto";
import { zonedParts } from "../core/timezone";
import { DEFAULT_KIND_CODES, type ActivityCode, type RowKind } from "./codes";
import type { LogKey, RowFact, Timing } from "./fact";
import { OWNER_RULES_VERSION } from "./ownerRules";
import { DEFAULT_SOURCES, mergeMoments, rawFacts, type PropertyRecords, type RowSource } from "./sources";
import { codeList, type HoursSettings } from "./store";

/**
 * One month of the hours log (#238): every row in the month, by log, in local time at the property, with
 * what needs the host and the month checked against the booking calendar. Built fresh on every call.
 */

/** One work session, in the issue's columns. */
export interface HoursRow {
  /** Stable across rebuilds while the record is the same. */
  id: string;
  log: LogKey;
  kind: RowKind;
  timing: Timing;
  /** Local `YYYY-MM-DD`. */
  date: string;
  /** Local `HH:MM`. */
  start: string;
  end: string;
  property: string;
  participant: string;
  code: string;
  category: string;
  activity: string;
  task: string;
  reference: string;
  where: "On site" | "Remote";
  hours: number;
}

export interface MonthLog {
  log: LogKey;
  /** The person's name, or Property Core. */
  name: string;
  rows: HoursRow[];
  hours: number;
}

export interface Reconcile {
  /** Checkouts in the month from the booking calendar, local dates. */
  checkouts: string[];
  /** Of those, the ones with no finished cleaning. */
  unmatched: string[];
  /** The lock events check waits on the smart-lock connection (#180). */
  lockEvents: "waiting";
}

export interface Month {
  month: string;
  rows: HoursRow[];
  logs: MonthLog[];
  /** Plain lines for the host's review. */
  needs: string[];
  reconcile: Reconcile;
  /** Changes when any row changes, or the owner-row rules do. */
  fingerprint: string;
  rulesVersion: number;
  /** The month's owner facts before they are merged into rows: what a confirmation keeps. */
  ownerFacts: RowFact[];
}

export interface BuildOptions {
  sources?: readonly RowSource[];
  /** Owner facts kept with the month when the host confirmed it. */
  kept?: readonly RowFact[];
  /** The row kinds to build with: a month confirmed before #18 has only the kinds it was confirmed with. Unset is every kind. */
  kinds?: ReadonlySet<RowKind>;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH.test(value);
}

const pad = (n: number) => String(n).padStart(2, "0");

function local(iso: string, timeZone: string): { date: string; time: string } {
  const p = zonedParts(new Date(iso), timeZone);
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

const roundHours = (ms: number) => Math.max(0, Math.round(ms / 36_000) / 100);

const LOG_ORDER = (log: LogKey) => (log === "owner" ? 0 : log === "cleaner" ? 1 : log === "property-core" ? 3 : 2);

/** The month's rows from the property's records, with the host's settings. */
export function buildMonth(records: PropertyRecords, month: string, settings: HoursSettings, options: BuildOptions = {}): Month {
  const timeZone = records.timeZone ?? "America/New_York";
  const codes = codeList(settings);
  const codeFor = (kind: RowKind): ActivityCode => {
    const wanted = settings.kindCodes?.[kind] ?? DEFAULT_KIND_CODES[kind];
    return codes.find((code) => code.code === wanted) ?? { code: wanted, group: "", activity: "" };
  };
  const ownerName = settings.ownerName ?? records.hostName ?? "Owner";
  const property = records.propertyName ?? "";
  const needs: string[] = [];
  const unset = new Map<string, { code: ActivityCode; count: number }>();
  const rows: HoursRow[] = [];
  const raw = rawFacts(records, options.sources ?? DEFAULT_SOURCES, options.kept ?? [], options.kinds);
  const inMonth = (fact: RowFact) => local(fact.at, timeZone).date.startsWith(`${month}-`);
  const ownerFacts = raw.filter((fact) => fact.log === "owner" && inMonth(fact));
  for (const fact of mergeMoments(raw)) {
    const start = local(fact.at, timeZone);
    if (!start.date.startsWith(`${month}-`)) continue;
    const code = codeFor(fact.kind);
    const row = rowFor(fact, start, code, timeZone);
    row.property = property;
    if (fact.log === "owner") {
      row.participant = ownerName;
      if (fact.timing === "rule" && code.minutes === undefined) {
        const seen = unset.get(code.code) ?? { code, count: 0 };
        unset.set(code.code, { code, count: seen.count + 1 });
      }
    }
    if (fact.needs) needs.push(`${row.date}, ${fact.reference}: ${fact.needs}`);
    rows.push(row);
  }
  for (const { code, count } of unset.values()) {
    needs.push(`Owner minutes aren't set for ${code.code}${code.activity ? ` (${code.activity})` : ""}, so its ${count} owner row${count === 1 ? " has" : "s have"} 0 hours. Ask the host how long one usually takes, and save it with save_hours_settings.`);
  }
  const reconcile = reconcileMonth(records, month);
  for (const date of reconcile.unmatched) needs.push(`The ${date} checkout has no finished cleaning in the log.`);
  const logs = logsOf(rows, records);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ rulesVersion: OWNER_RULES_VERSION, columns: settings.columns ?? null, rows }))
    .digest("hex");
  return { month, rows, logs, needs, reconcile, fingerprint, rulesVersion: OWNER_RULES_VERSION, ownerFacts };
}

function rowFor(fact: RowFact, start: { date: string; time: string }, code: ActivityCode, timeZone: string): HoursRow {
  let hours = 0;
  let end = start.time;
  if (fact.until && fact.timing !== "system") {
    hours = roundHours(Date.parse(fact.until) - Date.parse(fact.at));
    end = local(fact.until, timeZone).time;
  } else if (fact.timing === "rule" && code.minutes) {
    hours = roundHours(code.minutes * 60_000);
    end = local(new Date(Date.parse(fact.at) + code.minutes * 60_000).toISOString(), timeZone).time;
  }
  const id = createHash("sha256").update(`${fact.kind}|${fact.reference}|${fact.at}`).digest("hex").slice(0, 16);
  return {
    id,
    log: fact.log,
    kind: fact.kind,
    timing: fact.timing,
    date: start.date,
    start: start.time,
    end,
    property: "",
    participant: fact.participant,
    code: code.code,
    category: code.group,
    activity: code.activity,
    task: fact.task,
    reference: fact.reference,
    where: fact.onSite ? "On site" : "Remote",
    hours,
  };
}

function logsOf(rows: HoursRow[], records: PropertyRecords): MonthLog[] {
  const byLog = new Map<LogKey, HoursRow[]>();
  for (const row of rows) byLog.set(row.log, [...(byLog.get(row.log) ?? []), row]);
  return [...byLog.entries()]
    .sort(([a], [b]) => LOG_ORDER(a) - LOG_ORDER(b) || a.localeCompare(b))
    .map(([log, list]) => ({
      log,
      name: log === "property-core" ? "Property Core" : log === "cleaner" ? (records.cleanerName ?? list[0]!.participant) : list[0]!.participant,
      rows: list,
      hours: Math.round(list.reduce((sum, row) => sum + row.hours, 0) * 100) / 100,
    }));
}

/** Each checkout in the month from the booking calendar, and the ones with no finished cleaning. */
function reconcileMonth(records: PropertyRecords, month: string): Reconcile {
  const checkouts = [...new Set(records.stays.filter((stay) => stay.kind === "stay" && stay.checkout.startsWith(`${month}-`)).map((stay) => stay.checkout))].sort();
  const cleaned = new Set(records.cleaningJobs.filter((job) => job.done && !job.canceled && !job.declined).map((job) => job.checkoutDate));
  return { checkouts, unmatched: checkouts.filter((date) => !cleaned.has(date)), lockEvents: "waiting" };
}
