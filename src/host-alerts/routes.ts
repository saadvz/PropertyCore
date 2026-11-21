import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The routing point for host alerts (#250): which routine receives which alert kind, per account. Every kind goes
 * to the account's one Alerts routine (the Cleaner Core Alerts routine connected with save_alert_routine) until
 * #250 decides to split kinds across bots. Then a new routine id is added here and a kind pointed at it, without
 * touching the producers or the clock. Nothing writes the file yet.
 */

export const ALERT_KINDS = ["oversight", "stay-night", "packages", "camera-health"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** The routines an alert can go to. Only the account's Alerts routine exists today. */
export const ROUTINES = ["alerts"] as const;
export type RoutineId = (typeof ROUTINES)[number];

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

/** The routine that receives `kind` for this account. */
export function routineFor(accountRoot: string, kind: AlertKind): RoutineId {
  return readRoutes(accountRoot)[kind] ?? DEFAULT_ROUTINE;
}
