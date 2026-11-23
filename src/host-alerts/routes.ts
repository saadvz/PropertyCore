import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The routing point for host alerts (#250): which routine receives which alert kind, per account. An account with
 * one bot sends every kind to its one Alerts routine (the Cleaner Core Alerts routine connected with
 * save_alert_routine). On a team, where a core has its own bot, the kinds go to the Property Core bot or the Supply
 * Core bot, which read them with check_alerts. A saved alert-routes.json entry wins either way. Nothing writes the
 * file yet.
 */

export const ALERT_KINDS = ["oversight", "stay-night", "packages", "camera-health"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** The routines an alert can go to: the account's one Alerts routine, or on a team the Property Core bot's or the Supply Core bot's. */
export const ROUTINES = ["alerts", "property", "supplies"] as const;
export type RoutineId = (typeof ROUTINES)[number];
/** The routines a bot reads with check_alerts. "alerts" is a note in a desk's own check instead. */
export type BotRoutine = Exclude<RoutineId, "alerts">;
export const isBotRoutine = (value: unknown): value is BotRoutine => value === "property" || value === "supplies";

export const DEFAULT_ROUTINE: RoutineId = "alerts";
export const ROUTES_FILE = "alert-routes.json";

const isRoutine = (value: unknown): value is RoutineId => typeof value === "string" && (ROUTINES as readonly string[]).includes(value);

/** The account's saved map. A missing or unreadable file, a missing kind and an unknown routine all mean the default. */
export function readRoutes(accountRoot: string): Partial<Record<AlertKind, RoutineId>> {
  const path = join(accountRoot, ROUTES_FILE);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  const routes = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { routes?: unknown }).routes : undefined;
  if (!routes || typeof routes !== "object" || Array.isArray(routes)) return {};
  const out: Partial<Record<AlertKind, RoutineId>> = {};
  for (const kind of ALERT_KINDS) {
    const value = (routes as Record<string, unknown>)[kind];
    if (isRoutine(value)) out[kind] = value;
  }
  return out;
}

/**
 * The routine that receives `kind` for this account. With no `team`, an account with one bot: its one Alerts
 * routine. On a team, packages go to Supply Core's own bot when it has one, and everything else to the Property
 * Core bot. A saved entry wins.
 */
export function routineFor(accountRoot: string, kind: AlertKind, team?: { suppliesOwnBot: boolean }): RoutineId {
  const saved = readRoutes(accountRoot)[kind];
  if (saved) return saved;
  if (!team) return DEFAULT_ROUTINE;
  return kind === "packages" && team.suppliesOwnBot ? "supplies" : "property";
}
