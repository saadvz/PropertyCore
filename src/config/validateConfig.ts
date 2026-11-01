import { formatClockTime, isValidTimeZone } from "../core/timezone";
import { parsePhone } from "../core/phone";
import { minutesOfDay } from "../core/schedule";
import { tourWindows } from "../core/tourWindows";
import { describeTourDays } from "../operator/tourDayWords";
import type { TourCoreConfig } from "./tourCoreConfig";

export type ConfigSection = "property" | "hours" | "units" | "routes" | "verification" | "services";

export interface ConfigIssue {
  /** Machine-readable, stable. */
  code: string;
  section: ConfigSection;
  /** Operator-facing, plain language. */
  message: string;
  /** Technical detail for dev mode only. */
  detail?: string;
  /** The unit this issue is about, when there is one. */
  unitId?: string;
}

export const MAX_FACT_LENGTH = 300;

export const POLICY_LIMITS = {
  tourLengthMinutes: { min: 15, max: 240 },
  slotEveryMinutes: { min: 15, max: 480 },
  earlyArrivalMinutes: { min: 0, max: 60 },
  verificationValidForDays: { min: 1, max: 365 },
} as const;

export function semanticIssues(cfg: TourCoreConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  let currentUnit: string | undefined;
  const add = (section: ConfigSection, code: string, message: string) => {
    if (!issues.some((i) => i.code === code && i.message === message)) {
      issues.push({ code, section, message, ...(currentUnit ? { unitId: currentUnit } : {}) });
    }
  };
  const doorById = new Map(cfg.doors.map((d) => [d.id, d]));
  const unitById = new Map(cfg.units.map((u) => [u.id, u]));
  const doorName = (id: string) => doorById.get(id)?.name || "a door";

  // Property
  if (!cfg.property.name.trim()) add("property", "PROPERTY_NAME_MISSING", "The property needs a name.");
  if (!cfg.property.address.trim()) add("property", "PROPERTY_ADDRESS_MISSING", "The property needs an address.");
  if (!cfg.property.propertyType) add("property", "PROPERTY_TYPE_MISSING", "Say what type of property this is: a single-family home, a multifamily home, or an apartment or condo.");
  const singleFamily = cfg.property.propertyType === "SINGLE_FAMILY";
  const apartmentOrCondo = cfg.property.propertyType === "APARTMENT_OR_CONDO";
  const unitOnlyAccess = apartmentOrCondo && cfg.property.buildingAccess === "UNIT_ONLY";
  if (singleFamily && cfg.units.length > 1) add("units", "SINGLE_FAMILY_ONE_SPACE", "A single-family home has one tourable space. If people tour more than one space here, choose multifamily or apartment or condo.");
  if (apartmentOrCondo && cfg.units.length > 1) add("units", "APARTMENT_OR_CONDO_ONE_UNIT", "An apartment or condo is one unit in a building. If you own more than one unit here, choose multifamily.");
  if (apartmentOrCondo && cfg.units.length === 1 && !cfg.property.buildingAccess) {
    add("units", "BUILDING_ACCESS_MISSING", "Say whether you control the building entrance, or only the unit door.");
  }
  if (!cfg.property.timezone.trim()) {
    add("property", "TIMEZONE_INVALID", "What time zone should tours use, like Eastern or Pacific?");
  } else if (!isValidTimeZone(cfg.property.timezone)) {
    add("property", "TIMEZONE_INVALID", `I don't recognize the time zone "${cfg.property.timezone}". Try something like Eastern or Pacific.`);
  }
  if (!cfg.operator.name.trim()) add("property", "OPERATOR_MISSING", "Tell us who should get alerts if a visitor needs help.");
  if (cfg.operator.visitorContact?.trim() && !parsePhone(cfg.operator.visitorContact)) {
    add("property", "VISITOR_CONTACT_INVALID", "The number visitors can call doesn't look like a full phone number.");
  }
  const allFacts = [...cfg.property.facts, ...cfg.units.flatMap((u) => [u.summary, ...u.facts])];
  if (allFacts.some((f) => f.length > MAX_FACT_LENGTH)) add("units", "FACT_TOO_LONG", `Keep each description or fact under ${MAX_FACT_LENGTH} characters.`);

  // Units and doors
  for (const id of duplicates(cfg.doors.map((d) => d.id))) add("units", "DUPLICATE_DOOR_ID", `Two doors are labeled "${id}". Give each door its own name.`);
  for (const id of duplicates(cfg.units.map((u) => u.id))) add("units", "DUPLICATE_UNIT_ID", `Two units are labeled "${id}". Give each unit its own name.`);
  for (const id of duplicates(cfg.routes.map((r) => r.id))) add("routes", "DUPLICATE_ROUTE_ID", `Two routes are labeled "${id}". Each unit should have one route.`);

  if (cfg.units.length === 0) add("units", "NO_UNITS", "Add at least one unit people can tour.");
  if (!cfg.doors.some((d) => d.kind === "ENTRANCE") && !unitOnlyAccess) add("units", "NO_ENTRANCE", "Add the main entrance visitors will use.");
  if (cfg.doors.some((d) => !d.name.trim())) add("units", "DOOR_NAME_MISSING", "Every door needs a name.");

  const unitDoorOwners = new Map<string, string[]>();
  for (const unit of cfg.units) {
    const label = unit.name.trim() || "A unit";
    currentUnit = unit.id;
    if (!unit.name.trim()) add("units", "UNIT_NAME_MISSING", "Every unit needs a name.");
    if (!unit.doorId) {
      add("units", "UNIT_DOOR_MISSING", `${label} doesn't have a door yet.`);
      continue;
    }
    const door = doorById.get(unit.doorId);
    if (!door) add("units", "UNIT_DOOR_UNKNOWN", `${label} is linked to a door that no longer exists.`);
    // A single-family home's own door is its entrance; everywhere else a unit has its own unit door.
    else if (door.kind !== "UNIT" && !(singleFamily && door.kind === "ENTRANCE")) add("units", "UNIT_DOOR_NOT_UNIT", `${label} is linked to ${door.name}, which isn't a unit door. Give the unit its own door.`);
    unitDoorOwners.set(unit.doorId, [...(unitDoorOwners.get(unit.doorId) ?? []), label]);
  }
  currentUnit = undefined;
  for (const [doorId, owners] of unitDoorOwners) {
    if (owners.length > 1) add("units", "UNIT_DOOR_SHARED", `${owners.join(" and ")} share ${doorName(doorId)}. Each unit needs its own door.`);
  }

  // Routes
  for (const unit of cfg.units) {
    currentUnit = unit.id;
    const label = unit.name.trim() || "A unit";
    const routes = cfg.routes.filter((r) => r.unitId === unit.id);
    if (routes.length === 0) add("routes", "UNIT_ROUTE_MISSING", `${label} does not have a complete route.`);
    if (routes.length > 1) add("routes", "UNIT_ROUTE_DUPLICATE", `${label} has more than one route. Keep just one.`);
  }
  for (const route of cfg.routes) {
    const unit = unitById.get(route.unitId);
    currentUnit = unit?.id;
    if (!unit) {
      add("routes", "ROUTE_UNIT_UNKNOWN", "A route belongs to a unit that no longer exists.");
      continue;
    }
    const label = unit.name.trim() || "A unit";
    const ids = route.stops.map((s) => s.doorId);
    if (ids.length === 0) {
      add("routes", "UNIT_ROUTE_MISSING", `${label} does not have a complete route.`);
      continue;
    }
    if (ids.some((id) => !doorById.has(id))) add("routes", "ROUTE_DOOR_MISSING", `${label}'s route refers to a door that no longer exists.`);
    const startsAtOwnUnitDoor = unitOnlyAccess && ids[0] === unit.doorId && doorById.get(ids[0]!)?.kind === "UNIT";
    if (doorById.get(ids[0]!)?.kind !== "ENTRANCE" && !startsAtOwnUnitDoor) {
      add("routes", "ROUTE_START_NOT_ENTRANCE", `${label}'s route needs to start at an entrance.`);
    }
    if (ids[ids.length - 1] !== unit.doorId) add("routes", "ROUTE_END_NOT_UNIT", `${label}'s route needs to end at ${label}'s own door.`);
    if (duplicates(ids).length) add("routes", "ROUTE_REPEATS_DOOR", `${label}'s route lists the same door twice.`);
    for (const id of ids) {
      const door = doorById.get(id);
      if (door?.kind === "UNIT" && id !== unit.doorId) {
        add("routes", "ROUTE_THROUGH_OTHER_UNIT", `${label}'s route goes through ${door.name}, which belongs to another unit.`);
      }
    }
    if (route.stops.some((s) => !s.guidance.trim())) add("routes", "ROUTE_GUIDANCE_MISSING", `${label}'s route is missing directions for a stop.`);
  }
  currentUnit = undefined;

  // Tour hours and access windows
  const th = cfg.tourHours;
  const windows = tourWindows(th);
  if (windows.every((w) => w.days.length === 0)) add("hours", "TOUR_DAYS_MISSING", "Pick at least one day when people can tour.");
  const lengthOk = within(th.tourLengthMinutes, POLICY_LIMITS.tourLengthMinutes);
  if (!lengthOk) add("hours", "TOUR_LENGTH_INVALID", TOUR_LENGTH_RANGE);
  if (!within(th.slotEveryMinutes, POLICY_LIMITS.slotEveryMinutes)) add("hours", "SLOT_SPACING_INVALID", SLOT_SPACING_RANGE);
  if (!within(th.earlyArrivalMinutes, POLICY_LIMITS.earlyArrivalMinutes)) add("hours", "EARLY_ARRIVAL_INVALID", "Early arrival should be between 0 and 60 minutes.");
  const seenDays = new Set<string>();
  for (const w of windows) {
    if (w.days.some((day) => seenDays.has(day))) add("hours", "TOUR_DAYS_REPEATED", "A day has two different sets of tour hours. Give each day one set of hours.");
    w.days.forEach((day) => seenDays.add(day));
    const start = minutesOfDay(w.start);
    const end = minutesOfDay(w.end);
    // With one window the sentence stays as it always read; with several it says which days.
    const onDays = windows.length > 1 ? ` on ${describeTourDays(w.days)}` : "";
    if (start >= end) {
      add("hours", "TOUR_HOURS_BACKWARDS", `Tours need to end after they start. Right now they run from ${formatClockTime(w.start)} to ${formatClockTime(w.end)}${onDays}.`);
    }
    if (start < end && lengthOk && end - start < th.tourLengthMinutes) {
      add("hours", "TOUR_HOURS_TOO_SHORT", `The tour hours${onDays} are too short to fit a ${th.tourLengthMinutes}-minute tour.`);
    }
  }
  const visit = accessVisitMinutes(th);
  if (th.slotEveryMinutes > 0 && th.slotEveryMinutes < visit) {
    add(
      "hours",
      "ACCESS_WINDOWS_OVERLAP",
      `Tours start every ${th.slotEveryMinutes} minutes, but each visit (including ${th.earlyArrivalMinutes} minutes early) takes ${visit} minutes, so visitors would overlap. Space tours at least ${visit} minutes apart.`,
    );
  }

  // Verification
  if (!within(cfg.verificationValidForDays, POLICY_LIMITS.verificationValidForDays)) {
    add("verification", "VERIFICATION_REUSE_INVALID", REUSE_DAYS_RANGE);
  }

  return issues;
}

export function accessVisitMinutes(hours: { tourLengthMinutes: number; earlyArrivalMinutes: number }): number {
  return hours.tourLengthMinutes + hours.earlyArrivalMinutes;
}

/** Same overlap readiness rejects, in the save-time sentence. Nothing should be written when this is set. */
export function tourSpacingRefusal(hours: { slotEveryMinutes: number; tourLengthMinutes: number; earlyArrivalMinutes: number }): string | undefined {
  const visit = accessVisitMinutes(hours);
  if (hours.slotEveryMinutes > 0 && hours.slotEveryMinutes < visit) {
    return `Tours every ${hours.slotEveryMinutes} minutes don't leave room for ${visit}-minute visits. Should tours start every ${visit} minutes, or should visits be shorter?`;
  }
  return undefined;
}

export const TOUR_LENGTH_RANGE = "Each tour should last between 15 minutes and 4 hours.";
export const SLOT_SPACING_RANGE = "New tours should start between 15 minutes and 8 hours apart.";

/** Save-time refusal. The hours already saved stay as they are. */
export function tourLengthRefusal(minutes: number | undefined): string | undefined {
  if (minutes === undefined) return undefined;
  if (!Number.isInteger(minutes) || !within(minutes, POLICY_LIMITS.tourLengthMinutes)) {
    return `${TOUR_LENGTH_RANGE} How long should each tour be?`;
  }
  return undefined;
}

/** Save-time refusal when a new tour would start too soon or too far apart. */
export function slotSpacingRangeRefusal(minutes: number | undefined): string | undefined {
  if (minutes === undefined) return undefined;
  if (!Number.isInteger(minutes) || !within(minutes, POLICY_LIMITS.slotEveryMinutes)) {
    return `${SLOT_SPACING_RANGE} How often should a new tour start?`;
  }
  return undefined;
}

/** Length first, then how far apart new tours start. Overlap is a separate sentence. */
export function hoursRangeRefusal(input: { tourLengthMinutes?: number; slotEveryMinutes?: number }): string | undefined {
  return tourLengthRefusal(input.tourLengthMinutes) ?? slotSpacingRangeRefusal(input.slotEveryMinutes);
}

export const REUSE_DAYS_RANGE = "Pick a number of days from 1 to 365.";

export function reuseDaysRefusal(days: number | undefined): string | undefined {
  if (days === undefined) return undefined;
  if (!Number.isInteger(days) || days < 1 || days > 365) return REUSE_DAYS_RANGE;
  return undefined;
}

function duplicates(ids: string[]): string[] {
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
}

function within(n: number, range: { min: number; max: number }): boolean {
  return Number.isFinite(n) && n >= range.min && n <= range.max;
}
