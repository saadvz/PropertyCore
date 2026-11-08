import type { Door, PropertyType, TourCoreConfig, Unit } from "../config/tourCoreConfig";
import { isShortUnitCode, isSingleTourPlace, unitLabel, visitorSubject } from "../visitor/identity";
import { canonicalizeStreet, formatCanonical, parseUsAddress, titleCasePlace } from "./address";

/**
 * Shared write normalizer. PropertyWorkspace.save and saveDraft are the only
 * writers. classifyChange normalizes copies of both sides so a spelling-only
 * difference is not treated as a new setup. A property already on disk is not
 * rewritten on read or deploy.
 * Old tools and milestone tools both persist through it, so equivalent
 * landlord wording lands as one stored config. Address identity is
 * case-insensitive; the stored line is the one form canonicalizeStreet and
 * titleCasePlace produce.
 *
 * Equivalent shared-entrance wording (the duplex variants) collapses to
 * "Front Door" / ENTRANCE: front door, the front door, front entrance, main
 * entrance, building entrance, shared front door. A different door name
 * (Lobby Entrance, Side Gate, Garage) is kept.
 *
 * A unit door whose words are only the unit plus door/suite/unit collapses
 * to the default "<Unit> Door" ("Suite A door", "A's door", "unit a door").
 * Any other word is the landlord's own name and is kept.
 */

const SHARED_ENTRANCE = new Set(["front door", "front entrance", "main entrance", "building entrance", "shared front door"]);

const DOOR_FILLER = new Set(["unit", "apt", "apartment", "suite", "door", "the"]);

function cleanSpace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** "unit a" / "Unit A" / "A" / "4b" → "Unit A" / "Unit 4B". Spelled names stay trimmed. */
export function canonicalUnitName(name: string, propertyType?: PropertyType): string {
  const trimmed = cleanSpace(name);
  if (!trimmed || propertyType === "SINGLE_FAMILY") return trimmed;
  if (propertyType === "APARTMENT_OR_CONDO") return unitLabel(trimmed);
  const rest = trimmed.replace(/^(unit|apt\.?|apartment|suite)\s+/i, "").replace(/^#\s*/, "").trim();
  if (rest && !/\s/.test(rest) && isShortUnitCode(rest)) return unitLabel(trimmed);
  return trimmed;
}

function entranceKey(name: string): string {
  return cleanSpace(name)
    .toLowerCase()
    .replace(/^the\s+/, "");
}

function doorTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/['’]s\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

/** True when the door name is just this unit's default door said another way. */
export function isDefaultUnitDoorWording(doorName: string, unitName: string, propertyType?: PropertyType): boolean {
  const unit = canonicalUnitName(unitName, propertyType);
  const code = unit.replace(/^unit\s+/i, "").toLowerCase();
  if (!code) return false;
  const tokens = doorTokens(doorName);
  if (!tokens.length || !tokens.includes(code)) return false;
  return tokens.every((token) => token === code || DOOR_FILLER.has(token));
}

export function canonicalDoor(input: { name: string; kind: Door["kind"]; unitName?: string; propertyType?: PropertyType }): { name: string; kind: Door["kind"] } {
  const name = cleanSpace(input.name);
  if (SHARED_ENTRANCE.has(entranceKey(name))) return { name: "Front Door", kind: "ENTRANCE" };
  if (input.unitName && isDefaultUnitDoorWording(name, input.unitName, input.propertyType)) {
    const unit = canonicalUnitName(input.unitName, input.propertyType);
    return { name: `${unit} Door`, kind: "UNIT" };
  }
  return { name, kind: input.kind };
}

/** The door label setup suggests for a unit, e.g. "Unit 101" -> "Unit 101 Door". */
export function defaultDoorName(unitName: string): string {
  return `${unitName.trim()} Door`;
}

export function guidanceFor(draft: TourCoreConfig, unit: Unit, doorId: string, isLast: boolean, directions?: string): string {
  const place = isSingleTourPlace(draft.property) ? visitorSubject(draft.property, unit.name) : unit.name;
  if (isLast) return `Welcome to ${place}! Take your time, and text me any questions.`;
  const door = draft.doors.find((item) => item.id === doorId);
  if (door?.kind === "ENTRANCE") {
    return `Come on in. ${directions ? `To get to ${place}: ${directions.replace(/[.!]?$/, ".")}` : `Head to ${place}.`}`;
  }
  return `Keep going toward ${place}.`;
}

function canonicalizeAddress(draft: TourCoreConfig): void {
  const property = draft.property;
  const previousAddress = property.address;
  const previousName = property.name;
  const stored = property.canonicalAddress;
  const parsed = parseUsAddress(stored?.formatted || property.address);
  if (!parsed && !stored) return;
  // A partial save lives on the canonical parts. The one-line form is only
  // rewritten once street, city, and state are all present, so a reparse of
  // the earlier line must not drop a part the landlord already gave.
  const street = canonicalizeStreet(parsed?.address.street || stored?.street || "");
  const city = titleCasePlace(parsed?.address.city || stored?.city || "");
  const state = parsed?.address.state || stored?.state || "";
  const postalCode = parsed?.address.postalCode ?? stored?.postalCode;
  const unit = (parsed?.address.unit ?? stored?.unit)?.trim();
  const formatted = street && city && state ? formatCanonical({ street, city, state, ...(postalCode ? { postalCode } : {}), ...(unit ? { unit } : {}) }) : property.address;
  property.canonicalAddress = {
    street,
    city,
    state,
    ...(unit ? { unit } : {}),
    ...(postalCode ? { postalCode } : {}),
    formatted,
  };
  if (street && city && state) property.address = formatted;
  const namedByAddress = !property.displayName?.trim() && (previousName.trim() === previousAddress.trim() || previousName.trim() === formatted);
  if (namedByAddress) property.name = property.address;
}

function canonicalizeUnitsAndDoors(draft: TourCoreConfig): void {
  const type = draft.property.propertyType;
  for (const unit of draft.units) {
    const previous = unit.name;
    const nextName = canonicalUnitName(previous, type);
    unit.name = nextName;
    const door = draft.doors.find((item) => item.id === unit.doorId);
    if (!door) continue;
    const followed =
      door.name === defaultDoorName(previous) ||
      isDefaultUnitDoorWording(door.name, previous, type) ||
      isDefaultUnitDoorWording(door.name, nextName, type);
    if (followed) {
      door.name = defaultDoorName(nextName);
      door.kind = "UNIT";
    }
  }
  for (const door of draft.doors) {
    const unit = draft.units.find((item) => item.doorId === door.id);
    const canonical = canonicalDoor({ name: door.name, kind: door.kind, unitName: unit?.name, propertyType: type });
    door.name = canonical.name;
    door.kind = canonical.kind;
  }
}

function refreshGuidance(draft: TourCoreConfig, previous: TourCoreConfig): void {
  for (const route of draft.routes) {
    const unit = draft.units.find((item) => item.id === route.unitId);
    if (!unit) continue;
    const oldUnit = previous.units.find((item) => item.id === route.unitId);
    const oldRoute = previous.routes.find((item) => item.id === route.id);
    route.stops = route.stops.map((stop, index) => {
      const generated = guidanceFor(draft, unit, stop.doorId, index === route.stops.length - 1, route.directions);
      const oldStop = oldRoute?.stops[index];
      const oldGenerated =
        oldUnit && oldRoute && oldStop
          ? guidanceFor(previous, oldUnit, oldStop.doorId, index === oldRoute.stops.length - 1, oldRoute.directions)
          : undefined;
      const custom = oldStop !== undefined && oldGenerated !== undefined && oldStop.guidance !== oldGenerated;
      return { doorId: stop.doorId, guidance: custom ? oldStop.guidance : generated };
    });
  }
}

function sortDraft(draft: TourCoreConfig): void {
  const key = (name: string) => name.toLowerCase();
  draft.units.sort((a, b) => key(a.name).localeCompare(key(b.name)) || a.id.localeCompare(b.id));
  const unitOrder = new Map(draft.units.map((unit, index) => [unit.id, index]));
  const kindOrder: Record<Door["kind"], number> = { ENTRANCE: 0, COMMON: 1, UNIT: 2 };
  draft.doors.sort((a, b) => {
    const byKind = kindOrder[a.kind] - kindOrder[b.kind];
    if (byKind) return byKind;
    const unitA = draft.units.find((unit) => unit.doorId === a.id);
    const unitB = draft.units.find((unit) => unit.doorId === b.id);
    const orderA = unitA ? (unitOrder.get(unitA.id) ?? 99) : 99;
    const orderB = unitB ? (unitOrder.get(unitB.id) ?? 99) : 99;
    if (orderA !== orderB) return orderA - orderB;
    return key(a.name).localeCompare(key(b.name)) || a.id.localeCompare(b.id);
  });
  draft.routes.sort((a, b) => (unitOrder.get(a.unitId) ?? 99) - (unitOrder.get(b.unitId) ?? 99) || a.id.localeCompare(b.id));
}

/** Returns a new draft. Idempotent. Does not change property, unit, or door ids. */
export function normalizeStoredDraft(draft: TourCoreConfig): TourCoreConfig {
  const next = structuredClone(draft);
  const previous = structuredClone(draft);
  canonicalizeAddress(next);
  canonicalizeUnitsAndDoors(next);
  refreshGuidance(next, previous);
  sortDraft(next);
  return next;
}
