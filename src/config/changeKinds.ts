import { createHash } from "node:crypto";
import { isValidTimeZone } from "../core/timezone";
import { normalizeStoredDraft } from "../setup/normalizeDraft";
import { LEGACY_ACCESS_MODES, TourCoreConfigShape, type TourCoreConfig } from "./tourCoreConfig";

/**
 * The one place that decides which setup changes affect safety.
 *
 * APPROVED CONTENT is what visitors are told: property facts (and which
 * facts-sheet topics were asked), unit
 * descriptions, unit facts, the unit profile (bedrooms, bathrooms, rent,
 * availability, square footage, amenities, ...), route directions/stop
 * wording, and the optional visitor help number (the number stuck visitors
 * call, or an explicit skip). Changing it is audited and takes effect
 * immediately, including on active tours, and never invalidates readiness,
 * the practice tour or publication.
 *
 * Everything else is STRUCTURAL: doors, which doors a route passes through,
 * entrances, units themselves, tour hours, verification, messaging, storage,
 * access, the property's identity and time zone, and who gets alerts.
 * Changing it invalidates earlier checks until readiness and a practice tour
 * pass again, and needs an explicit republish.
 */

export type ChangeKind = "none" | "content" | "structural";

/** The config with approved content removed: what readiness and practice tours actually vouch for. */
export function structuralView(config: TourCoreConfig): unknown {
  const c = TourCoreConfigShape.parse(config);
  return {
    ...c,
    operator: { name: c.operator.name, contact: c.operator.contact },
    property: { ...c.property, facts: undefined, factsAsked: undefined, entryInstructionsDecided: undefined, timezoneConfirmed: undefined, zoneSwitchOffer: undefined },
    units: c.units.map((u) => ({ ...u, summary: undefined, facts: undefined, profile: undefined, entryInstructions: undefined })),
    routes: c.routes.map((r) => ({ ...r, directions: undefined, stops: r.stops.map((s) => ({ doorId: s.doorId })) })),
  };
}

/**
 * Safety fingerprint from when the visitor help number was still structural.
 * Used only to retarget readiness and practice-tour fingerprints on load.
 */
export function legacyVisitorHelpSafetyHash(config: TourCoreConfig): string {
  const c = TourCoreConfigShape.parse(config);
  return shortHash({
    ...c,
    property: { ...c.property, facts: undefined, entryInstructionsDecided: undefined },
    units: c.units.map((u) => ({ ...u, summary: undefined, facts: undefined, profile: undefined, entryInstructions: undefined })),
    routes: c.routes.map((r) => ({ ...r, directions: undefined, stops: r.stops.map((s) => ({ doorId: s.doorId })) })),
  });
}

/**
 * Fingerprints keep the door access spelling they were made with before
 * saadvz/PropertyCore#179, so a property saved then still matches its readiness,
 * practice tour and publication after the rename.
 */
const FINGERPRINT_ACCESS_MODES: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(LEGACY_ACCESS_MODES).map(([old, current]) => [current, old]));

function fingerprintSpelling(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("accessMode" in value)) return value;
  const mode = (value as { accessMode?: unknown }).accessMode;
  return typeof mode === "string" && FINGERPRINT_ACCESS_MODES[mode] ? { ...value, accessMode: FINGERPRINT_ACCESS_MODES[mode] } : value;
}

const shortHash = (value: unknown) => createHash("sha256").update(JSON.stringify(fingerprintSpelling(value))).digest("hex").slice(0, 16);

/** Fingerprint of the structural/safety part of a setup. Readiness, practice tours and publication are tied to this. */
export function safetyHash(config: TourCoreConfig): string {
  return shortHash(structuralView(config));
}

export function fullHash(config: TourCoreConfig): string {
  return shortHash(TourCoreConfigShape.parse(config));
}

/**
 * The fingerprints a property file had when live messaging was stored as
 * "sendblue". Used only to retarget readiness and publication during the rename.
 */
export function legacySendblueFingerprints(config: TourCoreConfig): { full: string; safety: string } {
  const parsed = TourCoreConfigShape.parse(config);
  const legacy = { ...parsed, messagingMode: "sendblue" as never };
  // The sendblue-era safety hash still included the visitor help number.
  const view = {
    ...parsed,
    messagingMode: "sendblue" as never,
    property: { ...parsed.property, facts: undefined, entryInstructionsDecided: undefined },
    units: parsed.units.map((u) => ({ ...u, summary: undefined, facts: undefined, profile: undefined, entryInstructions: undefined })),
    routes: parsed.routes.map((r) => ({ ...r, directions: undefined, stops: r.stops.map((s) => ({ doorId: s.doorId })) })),
  };
  return { full: shortHash(legacy), safety: shortHash(view) };
}

/** Compare the stored spelling of both sides, so a write that only canonicalizes is not a structural change. */
function asStored(config: TourCoreConfig): TourCoreConfig {
  return TourCoreConfigShape.parse(normalizeStoredDraft(config));
}

/**
 * The only structural change is writing a real zone over a blank or unrecognized one.
 * A change from one real zone to another stays structural: GMT times would open doors hours off.
 */
export function fillingUnsetTimeZone(before: TourCoreConfig, after: TourCoreConfig): boolean {
  const left = asStored(before);
  const right = asStored(after);
  if (isValidTimeZone(left.property.timezone) || !isValidTimeZone(right.property.timezone)) return false;
  const filled = { ...left, property: { ...left.property, timezone: right.property.timezone } };
  return safetyHash(filled) === safetyHash(right);
}

export function classifyChange(before: TourCoreConfig, after: TourCoreConfig): ChangeKind {
  const left = asStored(before);
  const right = asStored(after);
  if (fullHash(left) === fullHash(right)) return "none";
  return safetyHash(left) === safetyHash(right) ? "content" : "structural";
}

/** Plain descriptions of what approved content changed, for the audit log. */
export function describeContentChanges(before: TourCoreConfig, after: TourCoreConfig): string[] {
  const left = asStored(before);
  const right = asStored(after);
  before = left;
  after = right;
  const out: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (!same(before.property.facts, after.property.facts)) out.push(`${after.property.name}: approved facts`);
  if ((before.operator.visitorContact ?? "") !== (after.operator.visitorContact ?? "") || before.operator.visitorHelpDecided !== after.operator.visitorHelpDecided) {
    out.push("visitor help number");
  }
  for (const u of after.units) {
    const old = before.units.find((x) => x.id === u.id);
    if (!old) continue;
    if (!same(old.summary, u.summary)) out.push(`${u.name}: description`);
    if (!same(old.facts, u.facts)) out.push(`${u.name}: approved facts`);
    if (!same(old.entryInstructions, u.entryInstructions)) out.push(`${u.name}: entry instructions`);
    for (const key of new Set([...Object.keys(old.profile ?? {}), ...Object.keys(u.profile ?? {})])) {
      const a = (old.profile as Record<string, { status: string; value?: unknown } | undefined> | undefined)?.[key];
      const b = (u.profile as Record<string, { status: string; value?: unknown } | undefined> | undefined)?.[key];
      if (!same(a && { s: a.status, v: a.value }, b && { s: b.status, v: b.value })) out.push(`${u.name}: ${key}`);
    }
  }
  for (const r of after.routes) {
    const old = before.routes.find((x) => x.id === r.id);
    if (old && (!same(old.directions, r.directions) || !same(old.stops.map((s) => s.guidance), r.stops.map((s) => s.guidance)))) out.push(`${r.unitId}: directions`);
  }
  return out;
}
