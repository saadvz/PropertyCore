import { propertyUpdateEvent, suppliesUpdateEvent } from "../alerts/operatorEvents";
import { featureOn } from "../features/features";
import { liveDeskFor } from "../cleaner-core/liveDesk";
import { propertyFolder, type Property } from "../cleaner-core/hosted/properties";
import { tenantFolder, type Tenant } from "../cleaner-core/hosted/registry";
import { propertyContext, type HostedCleaner } from "../cleaner-core/hosted/router";
import { readCameras } from "../cameras/accounts";
import { runHostAlerts, type AlertSink, type AlertSource, type HostAlert } from "../host-alerts/clock";
import { HostAlertLedger } from "../host-alerts/ledger";
import { ALERT_KINDS, routineFor, type AlertKind, type BotRoutine, type RoutineId } from "../host-alerts/routes";
import { cameraHealthSource, localHour, localToday, oversightSource, packageSource, stayNightSource } from "../host-alerts/sources";
import { readHubFile } from "../hub/store";
import { PackageDesk } from "../package-arrivals/desk";
import { cameraDeskFor } from "./cameras";
import { noteQuiet } from "./botTools";
import { fixerDesk } from "./fixer";
import { holder, team } from "./jobDeps";
import { retryKeptWakes, WAKE_RETRY_MS, wakeHolder } from "./jobWake";
import { oversightDeskOf } from "./oversight";

/**
 * Host alerts on a clock (#250): for each property, the same-day check (#240), the nightly stay check (#239),
 * packages not seen by 9 PM (#241) and camera health (#239), each behind its own feature's flag. Every alert that's
 * due goes to the routine its kind is routed to. On an account with one bot that is the account's Alerts routine: a
 * note in Cleaner Core's check_now when cleaning runs at the property, else in Fixer Core's check_fixes. On a team,
 * where a core has its own bot, it is one wake-up for the Property Core bot or the Supply Core bot, which reads the
 * alert with check_alerts. Nothing here texts anyone, and nothing is logged but ids and kinds.
 */

/** The same-day check runs from 7 AM to midnight at the property (a miss is due by 8 PM, or an hour after a late window). */
export const OVERSIGHT_FROM_HOUR = 7;
/** How often each kind runs per property. Camera health runs every tick, as it did on the camera clock. */
export const EVERY_MS: Record<AlertKind, number> = { oversight: 15 * 60_000, packages: 15 * 60_000, "stay-night": 5 * 60_000, "camera-health": 0 };

export { WAKE_RETRY_MS };

const lastRun = new Map<string, number>();
const wakeFailed = new Map<string, number>();
let round = false;

/** Tests only: forget when each kind last ran, as a restart does. */
export function resetHostAlertClock(): void {
  lastRun.clear();
  wakeFailed.clear();
  round = false;
}

/**
 * Which routine each kind goes to for this account now. A team is an account where a core holds its job with its
 * own bot; everything else is today's one Alerts routine.
 */
export function alertRoutes(h: HostedCleaner, tenant: Tenant): (kind: AlertKind) => RoutineId {
  const account = h.registry.get(tenant.id) ?? tenant;
  const onTeam = team(h, account) ? { suppliesOwnBot: Boolean(holder(h, account, "supplies")?.job) } : undefined;
  const accountRoot = tenantFolder(h.dataRoot, tenant.id);
  return (kind) => routineFor(accountRoot, kind, onTeam);
}

/**
 * True when the clock tells the host about `kind` at this property. A kind that goes to the one Alerts routine needs
 * a host-note path there; one a bot reads with check_alerts needs only a flow on.
 */
export function clockTells(h: HostedCleaner, tenant: Tenant, property: Property, kind: AlertKind): boolean {
  return alertRoutes(h, tenant)(kind) === "alerts" ? hostNotePath(property) : anyFlowOn(property);
}

/** True when the property has a host-note path today: Cleaner Core or Fixer Core runs there. */
export function hostNotePath(property: Property): boolean {
  return property.flows.cleaning.on || property.flows.fixer.on;
}

const anyFlowOn = (property: Property) => property.flows.cleaning.on || property.flows.supplies.on || property.flows.fixer.on;

/** Whether `kind` is due to run at this property now, and records that it did. */
function dueToRun(root: string, kind: AlertKind, now: number): boolean {
  const key = `${root}|${kind}`;
  const last = lastRun.get(key);
  if (last !== undefined && now - last < EVERY_MS[kind]) return false;
  lastRun.set(key, now);
  return true;
}

/** The account and property as they are now, so a flow switched since the pass began is seen. */
function current(h: HostedCleaner, tenant: Tenant, property: Property): { account: Tenant; property: Property } {
  const account = h.registry.get(tenant.id) ?? tenant;
  return { account, property: account.properties.find((item) => item.id === property.id) ?? property };
}

/**
 * The account's Alerts routine, for one property: Cleaner Core's host note when cleaning runs there, else Fixer
 * Core's. Each keeps a note once per id and wakes the routine; with no routine connected, the note waits for the
 * next check_now or check_fixes, as their own notes do.
 */
function alertsRoutineSink(h: HostedCleaner, tenant: Tenant, property: Property): AlertSink {
  return async (alert: HostAlert) => {
    const now = current(h, tenant, property);
    if (now.property.flows.cleaning.on) {
      const ctx = propertyContext(h, now.account, now.property);
      if ((await liveDeskFor(ctx.root, ctx.env, () => h.now()).noteForHost(alert.id, alert.text)) === true) return "cleaning";
    }
    if (now.property.flows.fixer.on && (await fixerDesk(h, now.account, now.property).hostAlert(alert.id, alert.text))) return "fixer";
    return undefined;
  };
}

/**
 * The Property Core bot's or the Supply Core bot's routine: the alert stays in the ledger, where check_alerts reads
 * it, and the bot gets one wake-up per pass however many alerts the pass has. Not sent, the alert stays pending and
 * is tried again on a later pass, until a wake-up goes through or the bot reads it on its own schedule.
 */
function botSink(h: HostedCleaner, tenant: Tenant, job: BotRoutine, now: Date): AlertSink {
  let sent: Promise<boolean> | undefined;
  const key = `${tenant.id}|${job}`;
  return async () => {
    sent ??= (async () => {
      const failed = wakeFailed.get(key);
      if (failed !== undefined && now.getTime() - failed < WAKE_RETRY_MS) return false;
      const woken = await wakeHolder(h, tenant, job, job === "supplies" ? suppliesUpdateEvent(now) : propertyUpdateEvent(now));
      // A Supply Core bot gone quiet is told about once, as the desks' own wake-ups do for theirs.
      if (job === "supplies") await noteQuiet(h, tenant.id, "supplies").catch(() => undefined);
      if (woken) wakeFailed.delete(key);
      else wakeFailed.set(key, now.getTime());
      return woken;
    })();
    return (await sent) ? job : undefined;
  };
}

/** One sink per routine id. */
function sinks(h: HostedCleaner, tenant: Tenant, property: Property, now: Date): Record<RoutineId, AlertSink> {
  return { alerts: alertsRoutineSink(h, tenant, property), property: botSink(h, tenant, "property", now), supplies: botSink(h, tenant, "supplies", now) };
}

/** Today's behaviour kept for camera notes no routine took: they wait for list_cameras. */
function withCameraFallback(h: HostedCleaner, tenant: Tenant, property: Property, sink: AlertSink): AlertSink {
  return async (alert) => {
    const via = await sink(alert).catch(() => undefined);
    if (via) return via;
    cameraDeskFor(h, tenant, property).queueNotes([{ id: alert.id, text: alert.text }]);
    return "list_cameras";
  };
}

function timeZoneOf(root: string): string | undefined {
  try {
    return readHubFile(root)?.property.timeZone || undefined;
  } catch {
    return undefined;
  }
}

function camerasPicked(root: string): boolean {
  try {
    return readCameras(root).cameras.length > 0;
  } catch {
    return false;
  }
}

/** The sources that run at this property on this pass, each behind the account's own switch for its feature (featureOn). */
function sourcesFor(h: HostedCleaner, tenant: Tenant, property: Property, root: string, ledger: HostAlertLedger, now: Date, routes: (kind: AlertKind) => RoutineId): AlertSource[] {
  const env = h.baseEnv();
  const on = (feature: "cameras" | "oversight" | "packages" | "stay-check") => featureOn(tenant, feature, env);
  if (!on("cameras") && !on("oversight") && !on("packages")) return [];
  const at = now.getTime();
  const sources: AlertSource[] = [];
  const path = hostNotePath(property);
  const timeZone = timeZoneOf(root);
  const cameras = on("cameras") && camerasPicked(root);
  const label = property.label;
  // Camera notes ran on the camera clock for every property with cameras picked: they still do, with or without a path.
  if (cameras) sources.push(cameraHealthSource(cameraDeskFor(h, tenant, property)));
  if (!timeZone) return sources;
  // A kind that goes to the one Alerts routine has no host-note path without Cleaner Core or Fixer Core, and stays
  // as it is today. One a bot reads with check_alerts runs wherever a flow is on.
  const tells = (kind: AlertKind) => (routes(kind) === "alerts" ? path : anyFlowOn(property));
  if (tells("oversight") && on("oversight") && anyFlowOn(property) && localHour(now, timeZone) >= OVERSIGHT_FROM_HOUR && dueToRun(root, "oversight", at)) {
    sources.push(oversightSource(oversightDeskOf(h, tenant, property, () => now), localToday(now, timeZone), label));
  }
  if (tells("stay-night") && cameras && on("stay-check") && dueToRun(root, "stay-night", at)) {
    sources.push(stayNightSource(cameraDeskFor(h, tenant, property), ledger, now, timeZone));
  }
  if (tells("packages") && on("packages") && property.flows.supplies.on && dueToRun(root, "packages", at)) {
    // Its own desk, not packageDeskFor's cached one: that one keeps the deps it was first made with.
    sources.push(packageSource(new PackageDesk(root, { now: () => now }), label));
  }
  return sources;
}

/** One property's pass. */
export async function tickHostAlerts(h: HostedCleaner, tenant: Tenant, property: Property): Promise<void> {
  const root = propertyFolder(h.dataRoot, tenant.id, property);
  const now = h.now();
  const ledger = new HostAlertLedger(root, () => now);
  const routes = alertRoutes(h, tenant);
  const sources = sourcesFor(h, tenant, property, root, ledger, now, routes);
  // An alert a bot was woken for and never read, whose kind is the one Alerts routine's again: the desk's notes take it.
  ledger.reopen(ALERT_KINDS.filter((kind) => routes(kind) === "alerts"));
  // Kept alerts still waiting for a routine are tried on every pass, even when nothing new is due.
  if (!sources.length && !ledger.pending().length) return;
  const bySink = sinks(h, tenant, property, now);
  const sinkFor = (kind: AlertKind): AlertSink => {
    const routine = routes(kind);
    // Only the one Alerts routine falls back to list_cameras: a camera note a bot reads waits for check_alerts.
    return kind === "camera-health" && routine === "alerts" ? withCameraFallback(h, tenant, property, bySink[routine]) : bySink[routine];
  };
  const result = await runHostAlerts({ sources, ledger, sinkFor, now, label: property.label });
  for (const withheld of result.withheld) h.log(`A ${withheld.kind} alert for ${tenant.id}/${property.id} was withheld: its text looked like it held a code or a phone number.`);
  for (const kind of result.failed) h.log(`The ${kind} alert check for ${tenant.id}/${property.id} couldn't run this round.`);
}

/** Every account's properties, on the service's tick. One property's failure never stops the rest. */
export async function tickAllHostAlerts(h: HostedCleaner): Promise<void> {
  if (round) return;
  round = true;
  try {
    for (const listed of h.registry.list()) {
      const tenant = h.registry.get(listed.id);
      if (!tenant || tenant.disabled) continue;
      // A filing's wake-up that didn't go through (#250) is tried again here, whatever the account's alert switches say.
      await retryKeptWakes(h, tenant).catch(() => h.log(`The kept wake-ups for ${tenant.id} couldn't be tried this round.`));
      for (const property of tenant.properties) {
        try {
          await tickHostAlerts(h, tenant, property);
        } catch {
          h.log(`The host alerts for ${tenant.id}/${property.id} couldn't run this round.`);
        }
      }
    }
  } finally {
    round = false;
  }
}
