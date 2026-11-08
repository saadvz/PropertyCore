import type { PropertyType } from "../config/tourCoreConfig";

export type NamedProperty = {
  address: string;
  displayName?: string;
  propertyType?: PropertyType;
  name?: string;
  canonicalAddress?: { street?: string };
};

/**
 * What a visitor should hear. An internal tourable-space label ("Main Home")
 * is not a property name. A public name is used only when the operator gave
 * one that isn't that internal label.
 */
export function visitorTourOf(property: NamedProperty): string {
  const place = visitorPlace(property);
  const street = property.canonicalAddress?.street?.trim();
  return place.publicName ? `${place.publicName} at ${place.address}` : street || place.address;
}

/** One tourable place: a whole home, or one apartment or condo unit. Visitors are not asked which unit. */
export function isSingleTourPlace(property: { propertyType?: PropertyType }): boolean {
  return property.propertyType === "SINGLE_FAMILY" || property.propertyType === "APARTMENT_OR_CONDO";
}

export function isApartmentOrCondo(property: { propertyType?: PropertyType }): boolean {
  return property.propertyType === "APARTMENT_OR_CONDO";
}

/**
 * Display form for an apartment or condo unit: always "Unit …".
 * Short codes with a digit (4b, 12c) or 1–2 letters (PH, A) become uppercase.
 * Spelled names of 3+ letters stay title-cased ("Loft", "garden" / "Garden" →
 * "Unit Loft", "Unit Garden") — never ALL-CAPS.
 */
export function unitLabel(name: string): string {
  const trimmed = name.trim().replace(/^#\s*/, "");
  if (!trimmed) return "";
  const rest = trimmed.replace(/^(unit|apt\.?|apartment|suite)\s+/i, "").replace(/^#\s*/, "").trim();
  if (!rest) return "Unit";
  return `Unit ${formatUnitName(rest)}`;
}

/** Codes with a digit (4b, 12c), or 1–2 letters (PH, A). Three-plus letter words stay spelled names. */
export function isShortUnitCode(token: string): boolean {
  if (!/^[a-z0-9]+$/i.test(token)) return false;
  return /\d/.test(token) || token.length <= 2;
}

function formatUnitName(token: string): string {
  if (!/\s/.test(token) && isShortUnitCode(token)) return token.toUpperCase();
  if (!/\s/.test(token) && token === token.toLowerCase()) return token.charAt(0).toUpperCase() + token.slice(1);
  if (!/\s/.test(token) && token.length > 1 && token === token.toUpperCase()) return token.charAt(0) + token.slice(1).toLowerCase();
  if (/^[a-z]/.test(token)) return token.charAt(0).toUpperCase() + token.slice(1);
  return token;
}

/** Street line visitors hear: "145 Main St", never a made-up building name. */
export function streetLine(property: NamedProperty): string {
  const stored = property.canonicalAddress?.street?.trim();
  if (stored) return stored;
  const fromAddress = property.address.split(",")[0]?.trim() || property.address.trim();
  return fromAddress;
}

/** Default apartment or condo nickname: "145 Main St, Unit 4B". Never "Main Home". */
export function streetAndUnit(property: NamedProperty, unitName: string): string {
  const unit = unitLabel(unitName);
  const street = streetLine(property);
  return unit ? `${street}, ${unit}` : street;
}

export function visitorSubject(property: NamedProperty, unitName: string): string {
  if (property.propertyType === "SINGLE_FAMILY") return visitorTourOf(property);
  if (property.propertyType === "APARTMENT_OR_CONDO") return streetAndUnit(property, unitName);
  return unitName;
}

/**
 * Setup-tool unit label. A single-family home uses the street line so
 * "Main Home" never appears; other types keep the stored unit name
 * ("Unit Loft", "1A").
 */
export function operatorUnitName(property: NamedProperty, unitName: string): string {
  if (property.propertyType === "SINGLE_FAMILY") return visitorSubject(property, unitName);
  return unitName;
}

/** Address visitors see: the public name plus the address when one was given, otherwise the address alone. */
export function visitorPlace(property: Pick<NamedProperty, "address" | "displayName" | "name" | "canonicalAddress">): { address: string; publicName?: string } {
  const address = property.address.trim();
  const named = property.displayName?.trim();
  if (!named || sameIgnoreCase(named, address)) return { address };
  const street = property.canonicalAddress?.street?.trim();
  // A street line stored as the "name" is not a public building name — don't say "Oak Ln at Oak Ln, City".
  if (street && sameIgnoreCase(named, street)) return { address };
  if (address.toLowerCase().startsWith(named.toLowerCase())) return { address };
  return { address, publicName: named };
}

function sameIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
