import {
  BUILDING_ACCESS,
  BUILDING_ACCESS_LABELS,
  DEMO_VERIFICATION_FORM_URL,
  PROPERTY_TYPE_LABELS,
  PropertyTypeSchema,
  validateConfig,
  type BuildingAccess,
  type Door,
  type PropertyType,
  type TourCoreConfig,
  type TourHours,
  type Unit,
} from "../config/tourCoreConfig";
import { nextProfileQuestion, parseProfileValue, PROFILE_FIELDS, ProfileValueError, type ProfileField, type UnitProfile } from "../config/unitProfile";
import { type ConfigIssue, type ConfigSection } from "../config/validateConfig";
import { formatPhone, parsePhone } from "../core/phone";
import { formatClockTime, friendlyTimeZone, spokenClockTime, WEEKDAYS, type Weekday } from "../core/timezone";
import { mergeTourWindow, tourWindows, withTourWindows } from "../core/tourWindows";
import { describeTourDays } from "../operator/tourDayWords";
import { isApartmentOrCondo, isSingleTourPlace, streetAndUnit, streetLine, unitLabel, visitorSubject } from "../visitor/identity";
import { resolveTimeZone, SAME_DAY_HOURS, slugify, tourHoursEndSameDay, zoneForState } from "./parse";
import { isLegacyVerification, verificationSummaryRows } from "./verification";
import {
  CITY_QUESTION,
  STREET_QUESTION,
  STATE_QUESTION,
  STATE_UNREADABLE_QUESTION,
  canonicalizeStreet,
  fillAddress,
  normalizeUsState,
  parseUsAddress,
  titleCasePlace,
  type CanonicalAddress,
} from "./address";
import { stateForZip, zipStateMismatchQuestion } from "./zipState";
import { canonicalDoor, canonicalUnitName } from "./normalizeDraft";

/**
 * Setup actions. Each takes the current draft and returns a new one; nothing
 * here does I/O or knows about the terminal. A Grok Bot skill can call these
 * same functions one answer at a time.
 */

/** A TourCoreConfig that may not be complete or valid yet. */
export type SetupDraft = TourCoreConfig;

/** Setup copy for the team name visitors hear after "the". Rendered exactly as entered. */
export class OperatorTeamCopy {
  static hint(): string {
    return 'Use a team name that reads naturally after "the", for example leasing team or Maple Leasing team.';
  }

  static cliPrompt(): string {
    return `Who should we alert if a visitor needs help? ${this.hint()}`;
  }
}

/** Visible, overridable defaults. Policy values live in config, never in code paths. */
export const SETUP_DEFAULTS = {
  operatorName: "property team",
  operatorContact: "Shown on screen (demo)",
  entranceName: "Main Entrance",
  tourHours: {
    days: ["MON", "TUE", "WED", "THU", "FRI"],
    start: "09:00",
    end: "17:00",
    slotEveryMinutes: 60,
    tourLengthMinutes: 45,
    earlyArrivalMinutes: 10,
  } satisfies TourHours,
  verificationMode: "basic-form",
  verificationValidForDays: 30,
  messagingMode: "demo",
  storageMode: "memory",
  accessMode: "durin-mock",
} as const;

/** What the operator sees instead of mode ids. */
export const CHOICE_LABELS = {
  verification: {
    "basic-form": "Basic identity form (recommended)",
    none: "No form",
  },
  messaging: { demo: "Demo messaging (texts show on screen)", live: "Real texts to visitors' phones" },
  storage: { memory: "Demo records (kept on this computer)", "google-drive": "Google Drive" },
  access: { "durin-mock": "Door access demo mode (no real doors open)", durin: "Real door access" },
} as const;

/**
 * One sentence about what's real and what's demo, per subsystem. Never a
 * blanket "everything is in demo mode": visitor texting can be live while
 * door access is still demo.
 */
/** Local QA texting: honest, and "live" appears only in this sentence. */
export const LOCAL_TEST_TEXTING =
  "Texting is in test mode, so texts don't reach real phones. Real visitors won't get anything until live texting is turned on.";

function doorAccessSentence(accessDemo: boolean): string {
  return accessDemo ? "Door access is still in demo mode, so no physical locks will open." : "Door access is connected.";
}

/** Local test texting plus the same door sentence modeSentence uses. */
export function localTestModeSentence(accessDemo: boolean): string {
  return `${LOCAL_TEST_TEXTING} ${doorAccessSentence(accessDemo)}`;
}

/** The number visitors text, said once a property takes real texts. */
export function visitorsTextLine(number: string): string {
  return `Visitors text ${number} to book a tour.`;
}

export function modeSentence(textingLive: boolean, accessDemo: boolean): string {
  const texting = textingLive ? "Visitor texting is live." : "Visitor texts are practice only, so nobody is texted.";
  return `${texting} ${doorAccessSentence(accessDemo)}`;
}

export class SetupInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const clone = <T>(v: T): T => structuredClone(v);

function uniqueId(base: string, taken: Iterable<string>, fallback: string): string {
  const used = new Set(taken);
  const root = base || fallback;
  if (!used.has(root)) return root;
  for (let i = 2; ; i++) if (!used.has(`${root}_${i}`)) return `${root}_${i}`;
}

function requireName(name: string | undefined, code: string, message: string): string {
  const trimmed = name?.trim();
  if (!trimmed) throw new SetupInputError(code, message);
  return trimmed;
}

function requireTimeZone(input: string): string {
  const tz = resolveTimeZone(input);
  if (!tz) throw new SetupInputError("TIMEZONE_INVALID", `I don't recognize the time zone "${input}". Try something like Eastern or Pacific.`);
  return tz;
}

// ------------------------------------------------------------------ property

/** How the property is named to visitors and the operator: their own name for it, otherwise the canonical address. */
export function propertyLabel(property: { address: string; displayName?: string; name?: string }): string {
  return property.displayName?.trim() || property.address.trim() || property.name?.trim() || "";
}

const INTERNAL_SPACE_NAME = /^main home$/i;

/**
 * Operator-facing property name for remove and similar copy: their public
 * name, or street plus unit when an apartment or condo has exactly one unit,
 * otherwise the street line (derived from the address when the stored street
 * is empty). Never the internal single-family space label "Main Home".
 */
export function operatorFacingPropertyName(draft: {
  property: { address: string; displayName?: string; name?: string; propertyType?: PropertyType; canonicalAddress?: { street?: string } };
  units: { name: string }[];
}): string {
  const given = draft.property.displayName?.trim();
  if (given && !INTERNAL_SPACE_NAME.test(given)) return given;
  if (isApartmentOrCondo(draft.property) && draft.units.length === 1) {
    return streetAndUnit(draft.property, draft.units[0]!.name);
  }
  const street = streetLine(draft.property);
  if (street && !INTERNAL_SPACE_NAME.test(street)) return street;
  const fallback = draft.property.name?.trim() ?? "";
  return INTERNAL_SPACE_NAME.test(fallback) ? "" : fallback;
}

function withLabel(property: SetupDraft["property"]): SetupDraft["property"] {
  const displayName = property.displayName?.trim();
  const { displayName: _dropped, ...rest } = property;
  return { ...rest, ...(displayName ? { displayName } : {}), name: displayName || property.address.trim() };
}

function addressSoFar(draft: SetupDraft): CanonicalAddress | undefined {
  return draft.property.canonicalAddress ?? parseUsAddress(draft.property.address)?.address;
}

/** The zone the address's state would use, or the ZIP's state when no state is saved. Basis "address" only then. */
export function addressTimeZoneGuess(parts: CanonicalAddress | undefined): { timezone: string; basis: "address" | "computer" } {
  const fromState = parts?.state.trim() ? zoneForState(parts.state) : undefined;
  if (fromState) return { timezone: fromState, basis: "address" };
  const zip = parts?.postalCode?.trim().slice(0, 5) ?? "";
  const fromZip = zip ? zoneForState(stateForZip(zip) ?? "") : undefined;
  if (fromZip) return { timezone: fromZip, basis: "address" };
  return { timezone: "", basis: "computer" };
}

/** Replaces a guessed zone from the state now on the address. A locked zone is left alone. */
function applyGuessedTimeZone(property: SetupDraft["property"]): void {
  const guess = addressTimeZoneGuess(property.canonicalAddress);
  if (guess.basis === "address") property.timezone = guess.timezone;
}

/**
 * Saves the parts. The public address line becomes the one-line form only
 * when street, city and state are all there, so a read-back is never a
 * blank city. `display` is the line to show until then.
 */
function storeAddress(draft: SetupDraft, parts: CanonicalAddress, display?: string): void {
  draft.property.canonicalAddress = parts;
  if (parts.street.trim() && parts.city.trim() && parts.state.trim()) draft.property.address = parts.formatted;
  else if (display?.trim()) draft.property.address = display.trim();
  draft.property.addressConfirmed = false;
}

/** A ZIP entered with a state that doesn't own it is refused before anything is stored. */
function rejectMismatchedZip(state: string | undefined, zip: string | undefined): void {
  if (!state?.trim() || !zip?.trim()) return;
  const question = zipStateMismatchQuestion(state.trim(), zip.trim());
  if (question) throw new SetupInputError("ZIP_STATE_MISMATCH", question);
}

function requirePropertyType(input: string): PropertyType {
  const parsed = PropertyTypeSchema.safeParse(input);
  if (!parsed.success) throw new SetupInputError("PROPERTY_TYPE_UNKNOWN", "Choose a single-family home, a multifamily home, or an apartment or condo.");
  return parsed.data;
}

export function createPropertySetup(input: {
  address: string;
  /** Only a name the operator gave themselves. Leave out to use the address. */
  name?: string;
  propertyType?: string;
  timezone?: string;
  /** Property ids already in use, so a new one never collides. */
  existingPropertyIds?: string[];
  /** The installation's real visitor texting, when it has one: a new property uses it instead of demo messaging. */
  messagingMode?: SetupDraft["messagingMode"];
}): SetupDraft {
  const parsed = parseUsAddress(input.address);
  rejectMismatchedZip(parsed?.address.state, parsed?.address.postalCode);
  const address = parsed?.address.formatted || requireName(input.address, "ADDRESS_MISSING", "Please enter the property's address.");
  const displayName = input.name?.trim() || undefined;
  const explicitZone = input.timezone ? requireTimeZone(input.timezone) : undefined;
  const guessed = addressTimeZoneGuess(parsed?.address);
  const timezone = explicitZone ?? (guessed.basis === "address" ? guessed.timezone : "");
  const propertyType = input.propertyType ? requirePropertyType(input.propertyType) : undefined;
  const zip = parsed?.address.postalCode;
  const confirmed = !!zip && !!propertyType && !parsed!.missing.some((part) => part !== "postalCode");
  return {
    schemaVersion: 1,
    property: withLabel({
      id: uniqueId(`prop_${slugify(displayName ?? address)}`, input.existingPropertyIds ?? [], "prop_property"),
      name: "",
      address,
      ...(parsed ? { canonicalAddress: parsed.address } : {}),
      addressConfirmed: confirmed,
      ...(displayName ? { displayName } : {}),
      ...(propertyType ? { propertyType } : {}),
      timezone,
      ...(explicitZone ? { timezoneConfirmed: true } : {}),
      facts: [],
    }),
    operator: { name: SETUP_DEFAULTS.operatorName, contact: SETUP_DEFAULTS.operatorContact },
    doors: [],
    units: [],
    routes: [],
    tourHours: clone(SETUP_DEFAULTS.tourHours),
    verificationMode: SETUP_DEFAULTS.verificationMode,
    verificationFormUrl: DEMO_VERIFICATION_FORM_URL,
    verificationValidForDays: SETUP_DEFAULTS.verificationValidForDays,
    messagingMode: input.messagingMode ?? SETUP_DEFAULTS.messagingMode,
    storageMode: SETUP_DEFAULTS.storageMode,
    accessMode: SETUP_DEFAULTS.accessMode,
  };
}

/**
 * The property id never changes after creation, even if the name does. An
 * empty name removes the operator's own name, so the address is used again.
 */
export function setPropertyDetails(
  draft: SetupDraft,
  input: {
    name?: string;
    address?: string;
    propertyType?: string;
    timezone?: string;
    facts?: string[];
    city?: string;
    state?: string;
    street?: string;
    postalCode?: string;
    confirmAddress?: boolean;
    buildingAccess?: string;
    entryInstructions?: string;
    skipEntryInstructions?: boolean;
  },
  options?: { everPublished?: boolean },
): SetupDraft {
  let next = clone(draft);
  const stateBefore = next.property.canonicalAddress?.state.trim() ?? "";
  const addressWasConfirmed = next.property.addressConfirmed === true;
  // Snapshot before storeAddress clears addressConfirmed. Ever-published is passed in by the caller; a client cannot clear it.
  const zoneLocked = next.property.timezoneConfirmed === true || addressWasConfirmed || options?.everPublished === true;
  let addressEdited = false;
  // A setup saved before names and addresses were kept apart: an earlier name that isn't the address was the operator's.
  if (next.property.displayName === undefined && next.property.name.trim() && next.property.name.trim() !== next.property.address.trim()) next.property.displayName = next.property.name.trim();
  if (input.name !== undefined) next.property.displayName = input.name.trim() || undefined;
  if (input.address !== undefined) {
    addressEdited = true;
    const parsed = parseUsAddress(input.address);
    if (!parsed) {
      next.property.address = requireName(input.address, "ADDRESS_MISSING", "Please enter the property's address.");
      next.property.addressConfirmed = false;
    } else {
      const previous = next.property.canonicalAddress;
      const parts = fillAddress(
        previous,
        {
          street: parsed.address.street || previous?.street || "",
          city: parsed.address.city || previous?.city || "",
          state: parsed.address.state || previous?.state || "",
          unit: parsed.address.unit ?? (parsed.address.street ? null : undefined),
          postalCode: parsed.address.postalCode || previous?.postalCode,
        },
        parsed.address.formatted || input.address.trim(),
      );
      const showing = parts.street.trim() && parts.city.trim() && parts.state.trim() ? undefined : parsed.address.formatted || input.address.trim();
      storeAddress(next, parts, showing);
    }
  }
  if (input.street !== undefined) {
    addressEdited = true;
    const street = canonicalizeStreet(input.street);
    if (!street) throw new SetupInputError("STREET_MISSING", STREET_QUESTION);
    const current = addressSoFar(next);
    storeAddress(next, fillAddress(current, { street }, current?.formatted || next.property.address));
  }
  if (input.city !== undefined) {
    addressEdited = true;
    const city = titleCasePlace(input.city);
    if (!city) throw new SetupInputError("CITY_MISSING", CITY_QUESTION);
    const current = addressSoFar(next);
    storeAddress(next, fillAddress(current, { city }, current?.formatted || next.property.address));
  }
  if (input.state !== undefined) {
    addressEdited = true;
    const state = normalizeUsState(input.state);
    if (!state) throw new SetupInputError("STATE_UNREADABLE", STATE_UNREADABLE_QUESTION);
    const current = addressSoFar(next);
    storeAddress(next, fillAddress(current, { state }, current?.formatted || next.property.address));
  }
  if (input.postalCode !== undefined) {
    addressEdited = true;
    const zip = input.postalCode.trim();
    if (!/^\d{5}(?:-\d{4})?$/.test(zip)) throw new SetupInputError("ZIP_INVALID", "A ZIP code is five digits, like 07666.");
    const current = addressSoFar(next);
    storeAddress(next, fillAddress(current, { postalCode: zip.slice(0, 5) }, current?.formatted || next.property.address));
  }
  if (input.confirmAddress) {
    const parts = next.property.canonicalAddress;
    if (!parts?.street?.trim()) throw new SetupInputError("ADDRESS_INCOMPLETE", STREET_QUESTION);
    if (!parts.state?.trim()) throw new SetupInputError("ADDRESS_INCOMPLETE", STATE_QUESTION);
    if (!parts.city?.trim()) throw new SetupInputError("ADDRESS_INCOMPLETE", "I still need the city before that address can be confirmed.");
    if (!parts.postalCode) throw new SetupInputError("ADDRESS_INCOMPLETE", "I still need the ZIP code before that address can be confirmed.");
    next.property.addressConfirmed = true;
    next.property.timezoneConfirmed = true;
  }
  if (input.propertyType !== undefined) next.property.propertyType = requirePropertyType(input.propertyType);
  if (input.timezone !== undefined) {
    next.property.timezone = requireTimeZone(input.timezone);
    next.property.timezoneConfirmed = true;
  } else if (!zoneLocked || !next.property.timezone.trim()) {
    const stateAfter = next.property.canonicalAddress?.state.trim() ?? "";
    const stateChanged = !!stateAfter && stateAfter !== stateBefore;
    const zipTouched = input.postalCode !== undefined || (input.address !== undefined && !!parseUsAddress(input.address)?.address.postalCode);
    if (stateChanged || (!next.property.timezone.trim() && zipTouched)) applyGuessedTimeZone(next.property);
  } else if (addressWasConfirmed && addressEdited && next.property.timezoneConfirmed !== true) {
    next.property.timezoneConfirmed = true;
  }
  const stateAfter = next.property.canonicalAddress?.state.trim() ?? "";
  const stateChanged = !!stateAfter && stateAfter !== stateBefore;
  const enteredZip =
    input.postalCode !== undefined || (input.address !== undefined && !!parseUsAddress(input.address)?.address.postalCode);
  const enteredStateAndZip = input.state !== undefined && input.postalCode !== undefined;
  if (enteredZip || enteredStateAndZip || stateChanged) {
    rejectMismatchedZip(next.property.canonicalAddress?.state, next.property.canonicalAddress?.postalCode);
  }
  if (input.facts !== undefined) next.property.facts = cleanFacts(input.facts);
  if (input.buildingAccess !== undefined) next = setBuildingAccess(next, input.buildingAccess);
  if (input.entryInstructions !== undefined || input.skipEntryInstructions) {
    next = setEntryInstructions(next, { instructions: input.entryInstructions, skip: input.skipEntryInstructions });
  }
  next.property = withLabel(next.property);
  return refreshCondoLabel(next);
}

/** What Tour Core suggests calling the one tourable space of a single-family home. The operator can rename it. */
export const SINGLE_FAMILY_SPACE_NAME = "Main Home";
/** The single-family home's own door, when the operator hasn't named one. */
export const SINGLE_FAMILY_DOOR_NAME = "Front Door";

export const CONDO_UNIT_QUESTION = "What's the unit number?";
export const BUILDING_ACCESS_QUESTION = "Do you control the building entrance, or only the unit door?";
export const BUILDING_ENTRANCE_QUESTION = "What's the building entrance called?";
export const ENTRY_INSTRUCTIONS_QUESTION = "How should visitors get in and find your unit?";

export const BUILDING_ACCESS_CHOICES = BUILDING_ACCESS.map((choice) => ({ choice, label: BUILDING_ACCESS_LABELS[choice] }));

/**
 * The one setup question that depends on the property type: how to ask about
 * the tourable spaces. Undefined until the type is known.
 */
export function tourableSpacesQuestion(draft: SetupDraft): { question: string; suggestedName?: string } | undefined {
  switch (draft.property.propertyType) {
    case "SINGLE_FAMILY":
      return { question: `People will tour the whole home. Should I call it "${SINGLE_FAMILY_SPACE_NAME}", or would you like another name?`, suggestedName: SINGLE_FAMILY_SPACE_NAME };
    case "APARTMENT_OR_CONDO":
      return { question: CONDO_UNIT_QUESTION };
    case "MULTIFAMILY_HOME":
    case "APARTMENT_BUILDING":
      return { question: "Which units can people tour?" };
    case "OTHER":
      return { question: "How would you like the spaces people tour to be named?" };
    default:
      return undefined;
  }
}

export function entryInstructionsDecided(property: SetupDraft["property"]): boolean {
  return !!property.entryInstructionsDecided;
}

export function condoNextQuestion(draft: SetupDraft): { nextQuestion: string; choices?: { choice: string; label: string }[] } | undefined {
  if (!isApartmentOrCondo(draft.property)) return undefined;
  if (!draft.units.length) return { nextQuestion: CONDO_UNIT_QUESTION };
  if (!draft.property.buildingAccess) return { nextQuestion: BUILDING_ACCESS_QUESTION, choices: [...BUILDING_ACCESS_CHOICES] };
  if (draft.property.buildingAccess === "BUILDING_AND_UNIT" && !draft.doors.some((d) => d.kind === "ENTRANCE")) {
    return { nextQuestion: BUILDING_ENTRANCE_QUESTION };
  }
  if (!entryInstructionsDecided(draft.property)) return { nextQuestion: ENTRY_INSTRUCTIONS_QUESTION };
  return undefined;
}

function requireBuildingAccess(input: string): BuildingAccess {
  const parsed = BUILDING_ACCESS.find((value) => value === input);
  if (!parsed) throw new SetupInputError("BUILDING_ACCESS_UNKNOWN", "Say whether you control the building entrance, or only the unit door.");
  return parsed;
}

/** Default apartment or condo nickname is street + unit, never "Main Home". An operator-given public name still wins. */
export function refreshCondoLabel(draft: SetupDraft): SetupDraft {
  if (!isApartmentOrCondo(draft.property) || draft.property.displayName?.trim() || !draft.units[0]) return draft;
  const next = clone(draft);
  next.property.name = streetAndUnit(next.property, next.units[0]!.name);
  return next;
}

export function setBuildingAccess(draft: SetupDraft, input: string): SetupDraft {
  const access = requireBuildingAccess(input);
  let next = clone(draft);
  next.property.buildingAccess = access;
  next = applyCondoRoute(next);
  return refreshCondoLabel(next);
}

export function setEntryInstructions(draft: SetupDraft, input: { instructions?: string; skip?: boolean }): SetupDraft {
  const next = clone(draft);
  const unit = next.units[0];
  const text = input.instructions?.trim();
  if (unit) {
    if (text) unit.entryInstructions = text;
    else delete unit.entryInstructions;
  }
  if (input.skip || input.instructions !== undefined) next.property.entryInstructionsDecided = true;
  return next;
}

/** Non-empty landlord instructions only. Skip stores nothing. */
export function entryInstructionsFragment(instructions?: string): string | undefined {
  const text = instructions?.trim();
  return text ? `Here's how to get in: ${text}` : undefined;
}

/**
 * After the operator answers the condo access questions, set the route:
 * building entrance + unit door, or the unit door alone.
 */
export function applyCondoRoute(draft: SetupDraft): SetupDraft {
  if (!isApartmentOrCondo(draft.property) || !draft.units[0]) return draft;
  const unit = draft.units[0];
  if (!unit.doorId) return draft;
  const access = draft.property.buildingAccess;
  if (!access) return draft;
  const entrance = draft.doors.find((d) => d.kind === "ENTRANCE");
  if (access === "UNIT_ONLY") return setRoute(draft, unit.id, [unit.doorId]);
  if (!entrance) return draft;
  const doors = [...new Set([entrance.id, unit.doorId])];
  return setRoute(draft, unit.id, doors);
}

/** Keeps operator wording as written; only trims and drops blanks. */
function cleanFacts(facts: string[]): string[] {
  const cleaned = facts.map((f) => f.trim()).filter(Boolean);
  if (cleaned.length > 30) throw new SetupInputError("TOO_MANY_FACTS", "Please keep it to 30 facts or fewer.");
  return [...new Set(cleaned)];
}

/** The door label setup suggests for a unit, e.g. "Unit 101" -> "Unit 101 Door". */
export function defaultUnitDoorName(unitName: string): string {
  return `${unitName.trim()} Door`;
}

export const VISITOR_HELP_NUMBER_QUESTION =
  "What number can stuck visitors call? Pick one someone answers during tour hours.";
export const VISITOR_HELP_QUESTION = VISITOR_HELP_NUMBER_QUESTION;

export function visitorHelpDecided(operator: SetupDraft["operator"]): boolean {
  return !!operator.visitorHelpDecided || !!operator.visitorContact;
}

export function visitorHelpLines(operator: SetupDraft["operator"]): string[] {
  return [`Visitors can call: ${operator.visitorContact ? formatPhone(operator.visitorContact) : "not set"}`];
}

/** Asked once the rest of the setup is saveable, so it sits with the alert step. */
export function visitorHelpQuestion(draft: SetupDraft): { nextQuestion: string } | undefined {
  if (visitorHelpDecided(draft.operator)) return undefined;
  if (nextProfileQuestion(draft.units)) return undefined;
  if (validateConfig(draft).length) return undefined;
  return { nextQuestion: VISITOR_HELP_QUESTION };
}

export function setAlertContact(
  draft: SetupDraft,
  input: { name?: string; contact?: string; visitorContact?: string; skipVisitorHelp?: boolean },
): SetupDraft {
  const next = clone(draft);
  if (input.name !== undefined) next.operator.name = requireName(input.name, "OPERATOR_MISSING", "Please say who should get alerts.");
  if (input.contact !== undefined) next.operator.contact = input.contact.trim() || SETUP_DEFAULTS.operatorContact;
  if (input.visitorContact !== undefined) {
    const raw = input.visitorContact.trim();
    if (!raw) delete next.operator.visitorContact;
    else {
      const phone = parsePhone(raw);
      if (!phone) throw new SetupInputError("PHONE_INVALID", "Please enter a full phone number.");
      next.operator.visitorContact = phone;
    }
  }
  if (input.skipVisitorHelp || input.visitorContact !== undefined) {
    next.operator.visitorHelpDecided = true;
  }
  return next;
}

// ------------------------------------------------------------- doors, units

export function addDoor(draft: SetupDraft, input: { name: string; kind: Door["kind"]; unitId?: string }): { draft: SetupDraft; door: Door } {
  const requested = requireName(input.name, "DOOR_NAME_MISSING", "Please give the door a name.");
  const unit = input.unitId ? draft.units.find((item) => item.id === input.unitId) : undefined;
  const named = canonicalDoor({ name: requested, kind: input.kind, unitName: unit?.name, propertyType: draft.property.propertyType });
  const name = named.name;
  const kind = named.kind;
  if (draft.doors.some((d) => d.name.toLowerCase() === name.toLowerCase())) {
    throw new SetupInputError("DOOR_NAME_TAKEN", `There's already a door called "${name}".`);
  }
  const next = clone(draft);
  const door: Door = { id: uniqueId(slugify(name), next.doors.map((d) => d.id), "door"), name, kind };
  next.doors.push(door);
  if (input.unitId) {
    const unit = next.units.find((u) => u.id === input.unitId);
    if (!unit) throw new SetupInputError("UNIT_NOT_FOUND", "That unit isn't part of this property.");
    unit.doorId = door.id;
  }
  const routed = kind === "ENTRANCE" && isApartmentOrCondo(next.property) ? applyCondoRoute(next) : next;
  return { draft: routed, door };
}

export function renameDoor(draft: SetupDraft, doorId: string, name: string): SetupDraft {
  const current = draft.doors.find((d) => d.id === doorId);
  const unit = draft.units.find((item) => item.doorId === doorId);
  const requested = requireName(name, "DOOR_NAME_MISSING", "Please give the door a name.");
  const named = canonicalDoor({
    name: requested,
    kind: current?.kind ?? "COMMON",
    unitName: unit?.name,
    propertyType: draft.property.propertyType,
  });
  if (draft.doors.some((d) => d.id !== doorId && d.name.toLowerCase() === named.name.toLowerCase())) {
    throw new SetupInputError("DOOR_NAME_TAKEN", `There's already a door called "${named.name}".`);
  }
  const next = clone(draft);
  const door = next.doors.find((d) => d.id === doorId);
  if (!door) throw new SetupInputError("DOOR_NOT_FOUND", "That door isn't part of this property.");
  door.name = named.name;
  door.kind = named.kind;
  return next;
}

/** Routes that used this door are left alone so the review flags them. */
export function removeDoor(draft: SetupDraft, doorId: string): SetupDraft {
  const next = clone(draft);
  next.doors = next.doors.filter((d) => d.id !== doorId);
  for (const unit of next.units) if (unit.doorId === doorId) unit.doorId = "";
  return next;
}

export function addUnit(
  draft: SetupDraft,
  input: { name: string; summary?: string; facts?: string[] },
): { draft: SetupDraft; unit: Unit } {
  const name = canonicalUnitName(requireName(input.name, "UNIT_NAME_MISSING", "Please give the unit a name."), draft.property.propertyType);
  if (draft.units.some((u) => u.name.toLowerCase() === name.toLowerCase())) {
    throw new SetupInputError("UNIT_NAME_TAKEN", `There's already a unit called "${name}".`);
  }
  const next = clone(draft);
  const unit: Unit = {
    id: uniqueId(slugify(name), next.units.map((u) => u.id), "unit"),
    name,
    doorId: "",
    summary: input.summary?.trim() ?? "",
    facts: cleanFacts(input.facts ?? []),
  };
  next.units.push(unit);
  return { draft: next, unit };
}

/** True when the unit's door still carries the label setup suggested, so it can safely follow a rename. */
export function doorFollowsUnitName(draft: SetupDraft, unitId: string): boolean {
  const unit = draft.units.find((u) => u.id === unitId);
  const door = draft.doors.find((d) => d.id === unit?.doorId);
  return !!unit && !!door && door.name === defaultUnitDoorName(unit.name);
}

/**
 * Renames one unit. Apartment or condo names get the same casing as add
 * (`4b` → `Unit 4B`, `loft` → `Unit Loft`), and the street-plus-unit nickname
 * is refreshed. Its door is renamed too when asked (or always for a condo)
 * AND the door still has the suggested label; a door the operator named
 * themselves is never touched.
 */
export function renameUnit(draft: SetupDraft, unitId: string, name: string, options: { alsoRenameDoor?: boolean } = {}): SetupDraft {
  const requested = requireName(name, "UNIT_NAME_MISSING", "Please give the unit a name.");
  const clean = canonicalUnitName(isApartmentOrCondo(draft.property) ? unitLabel(requested) : requested, draft.property.propertyType);
  if (draft.units.some((u) => u.id !== unitId && u.name.toLowerCase() === clean.toLowerCase())) {
    throw new SetupInputError("UNIT_NAME_TAKEN", `There's already a unit called "${clean}".`);
  }
  const followDoor = options.alsoRenameDoor === true || isApartmentOrCondo(draft.property);
  const renameDoorToo = followDoor && doorFollowsUnitName(draft, unitId);
  let next = clone(draft);
  const unit = next.units.find((u) => u.id === unitId);
  if (!unit) throw new SetupInputError("UNIT_NOT_FOUND", "That unit isn't part of this property.");
  const old = unit.name;
  unit.name = clean;
  for (const route of next.routes.filter((r) => r.unitId === unitId)) {
    for (const stop of route.stops) stop.guidance = stop.guidance.split(old).join(clean);
  }
  if (renameDoorToo) next = renameDoor(next, unit.doorId, defaultUnitDoorName(clean));
  return refreshCondoLabel(next);
}

export function setUnitDetails(draft: SetupDraft, unitId: string, input: { summary?: string; facts?: string[] }): SetupDraft {
  const next = clone(draft);
  const unit = next.units.find((u) => u.id === unitId);
  if (!unit) throw new SetupInputError("UNIT_NOT_FOUND", "That unit isn't part of this property.");
  if (input.summary !== undefined) unit.summary = input.summary.trim();
  if (input.facts !== undefined) unit.facts = cleanFacts(input.facts);
  return next;
}

/**
 * Sets unit details (bedrooms, bathrooms, rent, availability, ...) from the
 * operator's words. "I don't know" / "don't list it" become an explicit
 * NOT_PROVIDED; anything unreadable is refused, never guessed. Unchanged
 * values keep their original timestamp.
 */
export function setUnitProfile(draft: SetupDraft, unitId: string, values: Partial<Record<ProfileField, string | number | boolean>>, now = new Date()): SetupDraft {
  const next = clone(draft);
  const unit = next.units.find((u) => u.id === unitId);
  if (!unit) throw new SetupInputError("UNIT_NOT_FOUND", "That unit isn't part of this property.");
  const profile: UnitProfile = { ...(unit.profile ?? {}) };
  for (const [key, raw] of Object.entries(values) as [ProfileField, string | number | boolean | undefined][]) {
    if (!PROFILE_FIELDS.includes(key)) throw new SetupInputError("UNIT_DETAIL_UNKNOWN", `"${key}" isn't a unit detail Tour Core keeps.`);
    if (raw === undefined || (typeof raw === "string" && !raw.trim())) continue;
    let parsed;
    try {
      parsed = parseProfileValue(key, raw, now, next.property.timezone);
    } catch (err) {
      if (err instanceof ProfileValueError) throw new SetupInputError("UNIT_DETAIL_UNREADABLE", `${unit.name}: ${err.message}`);
      throw err;
    }
    const old = profile[key];
    const same = old && old.status === parsed.status && JSON.stringify("value" in old ? old.value : null) === JSON.stringify("value" in parsed ? parsed.value : null);
    if (!same) (profile as Record<string, unknown>)[key] = parsed;
  }
  unit.profile = profile;
  return next;
}

/** Entrance -> unit door, when both exist. A unit-only condo is just the unit door. */
export function suggestRoute(draft: SetupDraft, unitId: string): string[] {
  const unit = draft.units.find((u) => u.id === unitId);
  if (isApartmentOrCondo(draft.property) && draft.property.buildingAccess === "UNIT_ONLY") {
    return [unit?.doorId].filter((id): id is string => !!id && draft.doors.some((d) => d.id === id));
  }
  const entrance = draft.doors.find((d) => d.kind === "ENTRANCE");
  return [...new Set([entrance?.id, unit?.doorId].filter((id): id is string => !!id && draft.doors.some((d) => d.id === id)))];
}

/**
 * Adds a tourable space with its own door. In a single-family home the space
 * is the whole home: it's named "Main Home" unless the operator says
 * otherwise, its door is the home's entrance (added as "Front Door" if there
 * isn't one yet), and its route is just that door. An apartment or condo is
 * one unit: the operator's unit number, a unit door, and a route once they
 * say whether they control the building entrance.
 */
export function addTourableSpace(draft: SetupDraft, input: { name?: string; summary?: string; facts?: string[]; doorName?: string }): SetupDraft {
  if (isApartmentOrCondo(draft.property)) {
    if (draft.units.length) throw new SetupInputError("APARTMENT_OR_CONDO_ONE_UNIT", `An apartment or condo is one unit, and it's already set up as ${draft.units[0]!.name}.`);
    const name = unitLabel(requireName(input.name, "UNIT_NAME_MISSING", "What's the unit number?"));
    const { draft: withUnit, unit } = addUnit(draft, { ...input, name });
    const withDoor = addDoor(withUnit, { name: input.doorName?.trim() || defaultUnitDoorName(unit.name), kind: "UNIT", unitId: unit.id }).draft;
    return refreshCondoLabel(applyCondoRoute(withDoor));
  }
  if (draft.property.propertyType !== "SINGLE_FAMILY") {
    const { draft: withUnit, unit } = addUnit(draft, { ...input, name: input.name ?? "" });
    return addDoor(withUnit, { name: input.doorName?.trim() || defaultUnitDoorName(unit.name), kind: "UNIT", unitId: unit.id }).draft;
  }
  if (draft.units.length) throw new SetupInputError("SINGLE_FAMILY_ONE_SPACE", `A single-family home has one tourable space, and it's already set up as ${draft.units[0]!.name}.`);
  const { draft: withUnit, unit } = addUnit(draft, { ...input, name: input.name?.trim() || SINGLE_FAMILY_SPACE_NAME });
  const named = input.doorName?.trim();
  let entrance = withUnit.doors.find((d) => d.kind === "ENTRANCE" && (!named || d.name.toLowerCase() === named.toLowerCase()));
  let next = withUnit;
  if (!entrance) ({ draft: next, door: entrance } = addDoor(withUnit, { name: named || SINGLE_FAMILY_DOOR_NAME, kind: "ENTRANCE" }));
  next = clone(next);
  next.units.find((u) => u.id === unit.id)!.doorId = entrance.id;
  return setRoute(next, unit.id, [entrance.id]);
}

/** Removes the unit, its route, and its own door. */
export function removeUnit(draft: SetupDraft, unitId: string): SetupDraft {
  const unit = draft.units.find((u) => u.id === unitId);
  if (!unit) return draft;
  let next = clone(draft);
  next.units = next.units.filter((u) => u.id !== unitId);
  next.routes = next.routes.filter((r) => r.unitId !== unitId);
  const door = next.doors.find((d) => d.id === unit.doorId);
  if (door?.kind === "UNIT" && !next.units.some((u) => u.doorId === door.id)) next = removeDoor(next, door.id);
  return next;
}

export function setUnitSummary(draft: SetupDraft, unitId: string, summary: string): SetupDraft {
  return setUnitDetails(draft, unitId, { summary });
}

// -------------------------------------------------------------------- routes

/** Door ids in the order the visitor walks through them. Replaces any existing route for the unit. */
export function setRoute(draft: SetupDraft, unitId: string, doorIds: string[], options: { directions?: string } = {}): SetupDraft {
  const unit = draft.units.find((u) => u.id === unitId);
  if (!unit) throw new SetupInputError("UNIT_NOT_FOUND", "That unit isn't part of this property.");
  if (doorIds.length === 0) throw new SetupInputError("ROUTE_EMPTY", "Pick at least one door for this route.");
  if (doorIds.some((id) => !draft.doors.some((d) => d.id === id))) {
    throw new SetupInputError("ROUTE_DOOR_UNKNOWN", "One of those doors isn't part of this property.");
  }
  const directions = options.directions?.trim() || undefined;
  const next = clone(draft);
  next.routes = next.routes.filter((r) => r.unitId !== unitId);
  next.routes.push({
    id: uniqueId(`route_${unit.id}`, next.routes.map((r) => r.id), "route"),
    unitId,
    ...(directions ? { directions } : {}),
    stops: doorIds.map((doorId, i) => ({ doorId, guidance: guidanceFor(draft, unit, doorId, i === doorIds.length - 1, directions) })),
  });
  return next;
}

function guidanceFor(draft: SetupDraft, unit: Unit, doorId: string, isLast: boolean, directions?: string): string {
  const place = isSingleTourPlace(draft.property) ? visitorSubject(draft.property, unit.name) : unit.name;
  if (isLast) return `Welcome to ${place}! Take your time, and text me any questions.`;
  const door = draft.doors.find((d) => d.id === doorId);
  if (door?.kind === "ENTRANCE") {
    return `Come on in. ${directions ? `To get to ${place}: ${directions.replace(/[.!]?$/, ".")}` : `Head to ${place}.`}`;
  }
  return `Keep going toward ${place}.`;
}

// ---------------------------------------------------------- hours, policies

/**
 * Saves touring hours. By default the days and times given become the only
 * window (the old one-window behaviour the setup page and CLI use). With
 * `merge`, the days given get these hours and every other day keeps its own,
 * so "add Saturday 9-8" leaves weekdays 9-5 alone.
 */
export function setTourHours(draft: SetupDraft, input: Partial<TourHours> & { merge?: boolean }): SetupDraft {
  const next = clone(draft);
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (input.days !== undefined && input.days.some((d) => !WEEKDAYS.includes(d))) {
    throw new SetupInputError("TOUR_DAYS_UNREADABLE", "I didn't understand those days.");
  }
  for (const key of ["start", "end"] as const) {
    const value = input[key];
    if (value !== undefined && !hhmm.test(value)) throw new SetupInputError("TOUR_TIME_UNREADABLE", "I didn't understand that time.");
  }
  if (input.windows !== undefined) {
    for (const w of input.windows) {
      if (w.days.some((d) => !WEEKDAYS.includes(d))) throw new SetupInputError("TOUR_DAYS_UNREADABLE", "I didn't understand those days.");
      if (!hhmm.test(w.start) || !hhmm.test(w.end)) throw new SetupInputError("TOUR_TIME_UNREADABLE", "I didn't understand that time.");
    }
    next.tourHours = withTourWindows(next.tourHours, input.windows);
  }
  if (input.days !== undefined || input.start !== undefined || input.end !== undefined) {
    next.tourHours = input.merge ? mergeHours(next.tourHours, input) : replaceHours(next.tourHours, input);
  }
  for (const key of ["slotEveryMinutes", "tourLengthMinutes", "earlyArrivalMinutes"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value)) throw new SetupInputError("TOUR_MINUTES_UNREADABLE", "Please use a whole number of minutes.");
    next.tourHours[key] = value;
  }
  if (tourWindows(next.tourHours).some((w) => !tourHoursEndSameDay(w.start, w.end))) {
    throw new SetupInputError("TOUR_HOURS_BACKWARDS", SAME_DAY_HOURS);
  }
  return next;
}

/** One window from now on. Anything not given comes from the first window. */
function replaceHours(hours: TourHours, input: Partial<TourHours>): TourHours {
  return withTourWindows(hours, [{ days: input.days ?? hours.days, start: input.start ?? hours.start, end: input.end ?? hours.end }]);
}

/** The days given get these hours; other days keep theirs. */
function mergeHours(hours: TourHours, input: Partial<TourHours>): TourHours {
  const windows = tourWindows(hours);
  if (input.days === undefined) {
    // New times with no days: fine with one window, but which window when there are several?
    if (windows.length > 1) throw new SetupInputError("TOUR_DAYS_NEEDED", `Which days are those hours for? Right now ${describeTourWindows(hours)}.`);
    return replaceHours(hours, input);
  }
  let start = input.start;
  let end = input.end;
  if (start === undefined || end === undefined) {
    // A missing time comes from the window those days already sit in. Days in
    // different windows, or not open yet with several windows, need the host to say.
    const homes = new Set(input.days.map((day) => windows.find((w) => w.days.includes(day))).filter((w) => w !== undefined));
    const home = homes.size === 1 ? [...homes][0]! : homes.size === 0 && windows.length === 1 ? windows[0]! : undefined;
    if (!home) throw new SetupInputError("TOUR_TIMES_NEEDED", `What hours should tours run on ${describeTourDays(input.days)}?`);
    start ??= home.start;
    end ??= home.end;
  }
  return mergeTourWindow(hours, { days: input.days, start, end });
}

/** Review rows: days, then hours, for one window; "Mon-Fri, 9:00 AM-5:00 PM" per window when there are several. */
export function tourWindowRows(hours: TourHours): string[] {
  const windows = tourWindows(hours);
  if (windows.length <= 1) return [describeDays(hours.days), `${formatClockTime(hours.start)}-${formatClockTime(hours.end)}`];
  return windows.map((w) => `${describeDays(w.days)}, ${formatClockTime(w.start)}-${formatClockTime(w.end)}`);
}

/** "Monday to Friday, 9 AM to 5 PM, and Saturday and Sunday, 9 AM to 8 PM" */
export function describeTourWindows(hours: TourHours): string {
  const parts = tourWindows(hours).map((w) => `${describeTourDays(w.days)}, ${spokenClockTime(w.start)} to ${spokenClockTime(w.end)}`);
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]}, and ${parts[1]}`;
  return `${parts.slice(0, -1).join("; ")}; and ${parts.at(-1)}`;
}

export function setVerificationPolicy(
  draft: SetupDraft,
  input: { mode?: SetupDraft["verificationMode"]; reuseForDays?: number },
): SetupDraft {
  const next = clone(draft);
  if (input.mode !== undefined) {
    if (isLegacyVerification(input.mode)) {
      throw new SetupInputError("INPUT_INVALID", "Some of that information is missing or doesn't look right.");
    }
    next.verificationMode = input.mode;
  }
  if (input.reuseForDays !== undefined) {
    if (!Number.isInteger(input.reuseForDays)) throw new SetupInputError("VERIFICATION_REUSE_UNREADABLE", "Please use a whole number of days.");
    next.verificationValidForDays = input.reuseForDays;
  }
  return next;
}

export function setServices(
  draft: SetupDraft,
  input: {
    messagingMode?: SetupDraft["messagingMode"];
    messagingProvider?: "local";
    storageMode?: SetupDraft["storageMode"];
    accessMode?: SetupDraft["accessMode"];
  },
): SetupDraft {
  const next = clone(draft);
  if (input.storageMode !== undefined) next.storageMode = input.storageMode;
  if (input.accessMode !== undefined) next.accessMode = input.accessMode;
  if (input.messagingProvider === "local") {
    next.messagingMode = "live";
    next.messagingProvider = "local";
    return next;
  }
  if (input.messagingMode !== undefined) {
    next.messagingMode = input.messagingMode;
    delete next.messagingProvider;
  }
  return next;
}

// -------------------------------------------------------------------- review

export interface ReviewSection {
  /** Which part of setup to revisit to change this. */
  editSection: ConfigSection;
  title: string;
  lines: string[];
}

export interface SetupReview {
  sections: ReviewSection[];
  issues: ConfigIssue[];
  canSave: boolean;
}

export function reviewSetup(draft: SetupDraft): SetupReview {
  const issues = validateConfig(draft);
  const doorName = (id: string) => draft.doors.find((d) => d.id === id)?.name ?? "(missing door)";
  const th = draft.tourHours;
  const sections: ReviewSection[] = [
    {
      editSection: "property",
      title: "PROPERTY",
      lines: [
        draft.property.address,
        ...(draft.property.displayName ? [`Called: ${draft.property.displayName}`] : []),
        draft.property.propertyType ? PROPERTY_TYPE_LABELS[draft.property.propertyType] : "(property type not chosen yet)",
        ...(isApartmentOrCondo(draft.property) && draft.property.buildingAccess === "UNIT_ONLY" ? ["Building entrance: visitors get in on their own"] : []),
        ...(isApartmentOrCondo(draft.property) && draft.property.buildingAccess === "BUILDING_AND_UNIT" ? ["Building entrance: you control it"] : []),
        ...(draft.units[0]?.entryInstructions ? [`Entry instructions: ${draft.units[0].entryInstructions}`] : []),
      ],
    },
    ...(draft.property.timezone.trim()
      ? [{ editSection: "property" as const, title: "TIMEZONE", lines: [`${draft.property.timezone} (${friendlyTimeZone(draft.property.timezone)})`] }]
      : []),
    {
      editSection: "hours",
      title: "TOUR HOURS",
      lines: [
        ...tourWindowRows(th),
        `Each tour lasts ${describeMinutes(th.tourLengthMinutes)}; a new tour can start every ${describeInterval(th.slotEveryMinutes)}`,
        `Visitors can get in up to ${describeMinutes(th.earlyArrivalMinutes)} early`,
      ],
    },
    { editSection: "units", title: "UNITS", lines: draft.units.length ? draft.units.map((u) => u.name) : ["(none yet)"] },
    ...draft.units.map((unit) => {
      const route = draft.routes.find((r) => r.unitId === unit.id);
      return {
        editSection: "routes" as const,
        title: `ROUTE: ${unit.name.toUpperCase()}`,
        lines: route?.stops.length ? route.stops.map((s) => doorName(s.doorId)) : ["(no route yet)"],
      };
    }),
    {
      editSection: "verification",
      title: "VERIFICATION",
      lines: verificationSummaryRows(draft.verificationMode, draft.verificationValidForDays),
    },
    {
      editSection: "services",
      title: "RECORDS, MESSAGES AND DOORS",
      lines: [
        `Records: ${CHOICE_LABELS.storage[draft.storageMode]}`,
        `Messages: ${draft.messagingProvider === "local" ? "Local test texts (no real texts are sent)" : CHOICE_LABELS.messaging[draft.messagingMode]}`,
        `Doors: ${CHOICE_LABELS.access[draft.accessMode]}`,
      ],
    },
    {
      editSection: "property",
      title: "ALERTS",
      lines: [`If a visitor needs help: ${draft.operator.name}`, ...visitorHelpLines(draft.operator)],
    },
  ];
  return { sections, issues, canSave: issues.length === 0 };
}

const DAY_LABEL: Record<Weekday, string> = {
  MON: "Monday", TUE: "Tuesday", WED: "Wednesday", THU: "Thursday", FRI: "Friday", SAT: "Saturday", SUN: "Sunday",
};
const WEEK_ORDER: Weekday[] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

export function describeDays(days: readonly Weekday[]): string {
  const ordered = WEEK_ORDER.filter((d) => days.includes(d));
  if (ordered.length === 0) return "No days selected";
  if (ordered.length === 7) return "Every day";
  const idx = ordered.map((d) => WEEK_ORDER.indexOf(d));
  const contiguous = idx.every((n, i) => i === 0 || n === idx[i - 1]! + 1);
  if (contiguous && ordered.length >= 3) return `${DAY_LABEL[ordered[0]!]}-${DAY_LABEL[ordered[ordered.length - 1]!]}`;
  return ordered.map((d) => DAY_LABEL[d]).join(", ");
}

/** For "every ___": 60 -> "hour", 90 -> "1 hour 30 minutes". */
export function describeInterval(n: number): string {
  return n === 60 ? "hour" : describeMinutes(n);
}

export function describeMinutes(n: number): string {
  if (n === 0) return "0 minutes";
  const h = Math.floor(n / 60);
  const m = n % 60;
  const parts = [h ? `${h} hour${h === 1 ? "" : "s"}` : "", m ? `${m} minute${m === 1 ? "" : "s"}` : ""].filter(Boolean);
  return parts.join(" ");
}
