import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../storage/atomicWrite";
import { ALERT_KINDS, type AlertKind } from "./routes";

/**
 * One property's host-alert ledger (#250), `host-alerts.json`. Each due alert is kept here, by id, before its
 * producer marks it told, and marked delivered once a routine's sink took it. So a restart between any two steps
 * either finds the alert again under the same id or hands over the kept one: never lost, never twice. It also
 * holds the nightly check's own "already checked" record, which the check itself never had.
 */

export const HOST_ALERTS_FILE = "host-alerts.json";
const MAX_ALERTS = 200;
const MAX_NIGHTS = 60;

export interface KeptAlert {
  id: string;
  kind: AlertKind;
  /** Absent on a withheld alert: its text never reaches the file. */
  text?: string;
  keptAt: string;
  deliveredAt?: string;
  /** Which sink took it: "cleaning", "fixer" or "list_cameras". */
  via?: string;
  /** The guard refused the text, so it was never kept or sent. */
  withheld?: true;
  /** Not handed over within the time an alert stays useful, so it was let go. */
  expiredAt?: string;
}

export interface HostAlertsFile {
  alerts: KeptAlert[];
  /** Nights (YYYY-MM-DD) the nightly check has run and told, clean or not. */
  nights: string[];
}

const isKind = (value: unknown): value is AlertKind => typeof value === "string" && (ALERT_KINDS as readonly string[]).includes(value);

export function readHostAlerts(root: string): HostAlertsFile {
  const path = join(root, HOST_ALERTS_FILE);
  if (!existsSync(path)) return { alerts: [], nights: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    raw = undefined;
  }
  const file = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Partial<HostAlertsFile>) : {};
  const alerts = Array.isArray(file.alerts) ? file.alerts.filter((a): a is KeptAlert => !!a && typeof a.id === "string" && isKind(a.kind) && typeof a.keptAt === "string") : [];
  const nights = Array.isArray(file.nights) ? file.nights.filter((n): n is string => typeof n === "string") : [];
  return { alerts, nights };
}

function writeHostAlerts(root: string, file: HostAlertsFile): void {
  writeJsonAtomic(join(root, HOST_ALERTS_FILE), { alerts: file.alerts.slice(-MAX_ALERTS), nights: file.nights.slice(-MAX_NIGHTS) });
}

export class HostAlertLedger {
  constructor(
    private readonly root: string,
    private readonly now: () => Date,
  ) {}

  has(id: string): boolean {
    return readHostAlerts(this.root).alerts.some((alert) => alert.id === id);
  }

  /** Keeps one alert by id. False when that id was already kept, whatever became of it. */
  keep(alert: { id: string; kind: AlertKind; text: string }): boolean {
    const file = readHostAlerts(this.root);
    if (file.alerts.some((each) => each.id === alert.id)) return false;
    file.alerts.push({ id: alert.id, kind: alert.kind, text: alert.text, keptAt: this.now().toISOString() });
    writeHostAlerts(this.root, file);
    return true;
  }

  /** Records an alert the guard refused, with no text, so it's never tried again. */
  withhold(alert: { id: string; kind: AlertKind }): boolean {
    const file = readHostAlerts(this.root);
    if (file.alerts.some((each) => each.id === alert.id)) return false;
    file.alerts.push({ id: alert.id, kind: alert.kind, keptAt: this.now().toISOString(), withheld: true });
    writeHostAlerts(this.root, file);
    return true;
  }

  /** Kept alerts not yet handed over, oldest first. */
  pending(): (KeptAlert & { text: string })[] {
    return readHostAlerts(this.root).alerts.filter((alert): alert is KeptAlert & { text: string } => !alert.withheld && !alert.deliveredAt && !alert.expiredAt && typeof alert.text === "string");
  }

  delivered(id: string, via: string): void {
    const file = readHostAlerts(this.root);
    const alert = file.alerts.find((each) => each.id === id);
    if (!alert || alert.deliveredAt) return;
    alert.deliveredAt = this.now().toISOString();
    alert.via = via;
    writeHostAlerts(this.root, file);
  }

  expired(id: string): void {
    const file = readHostAlerts(this.root);
    const alert = file.alerts.find((each) => each.id === id);
    if (!alert || alert.deliveredAt || alert.expiredAt) return;
    alert.expiredAt = this.now().toISOString();
    delete alert.text;
    writeHostAlerts(this.root, file);
  }

  nightDone(night: string): boolean {
    return readHostAlerts(this.root).nights.includes(night);
  }

  markNight(night: string): void {
    const file = readHostAlerts(this.root);
    if (file.nights.includes(night)) return;
    file.nights.push(night);
    writeHostAlerts(this.root, file);
  }
}
