import type { TourCoreConfig, Unit } from "../config/tourCoreConfig";
import { mentionedButNotAsked, profileFacts, questionTopic, stripFieldWords, type ProfileField } from "../config/unitProfile";
import { visitorSubject } from "../visitor/identity";
import { isFairHousingQuestion } from "./fairHousing";
import { approvedFacts, findApprovedAnswer, type ApprovedFact } from "./facts";

/**
 * Which approved facts answer a visitor's question, and about which unit.
 * Pure and deterministic; nothing here writes an answer. Context is used
 * conservatively: a unit the visitor named wins, then the unit they chose,
 * then the only unit there is. A question about one unit's details with no
 * unit to go on is asked back ("Which unit do you mean?"), never guessed.
 * `pickedUnitId` is that ask's answer: it wins even if the original question
 * named more than one unit. A reservation's current unit (`selectedUnitId`)
 * does not skip that ask.
 */

export type QuestionResolution =
  | { kind: "answer"; facts: ApprovedFact[]; unitId?: string }
  | { kind: "which-unit"; units: string[] }
  | { kind: "unknown"; unitId?: string; fairHousing?: boolean };

/** Details that belong to one unit; the description is never read for these once the unit has structured details. */
const UNIT_FIELDS: ProfileField[] = ["bedrooms", "bathrooms", "monthlyRent", "availability", "squareFeet", "floor", "furnished", "features"];
/** Often building-wide ("Is there parking?"): property facts can answer them without a unit. */
const SHARED_FIELDS: ProfileField[] = ["parking", "laundry", "pets", "utilities"];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s: string) => s.toLowerCase().replace(/['\u2019]/g, "").replace(/\s+/g, " ").trim();

/**
 * Units named in a question: "Unit 1A", "unit 1a", "apt 1A", or the bare "1A"
 * / "101". A bare label counts only when it can't be an ordinary number or
 * word ("1" is a menu choice, not Unit 1).
 */
export function unitsNamedIn(question: string, units: Pick<Unit, "id" | "name">[]): Pick<Unit, "id" | "name">[] {
  const t = ` ${norm(question).replace(/[^a-z0-9# ]+/g, " ")} `;
  return units.filter((u) => {
    const name = norm(u.name).replace(/[^a-z0-9# ]+/g, " ").trim();
    if (!name) return false;
    if (new RegExp(`\\s${esc(name)}\\s`).test(t)) return true;
    const label = name.replace(/^(unit|apt|apartment|suite|#)\s*/, "");
    if (!label || label === name) return false;
    if (new RegExp(`\\s(unit|apt|apartment|suite|number|#)\\s*${esc(label)}\\s`).test(t)) return true;
    const distinctive = /\d/.test(label) && (/[a-z]/.test(label) || label.length >= 2);
    return distinctive && new RegExp(`\\s#?${esc(label)}\\s`).test(t);
  });
}

function unitAnswer(config: TourCoreConfig, unit: Unit, field: ProfileField): ApprovedFact | undefined {
  const subject = visitorSubject(config.property, unit.name);
  const fact = profileFacts(unit, subject).find((f) => f.field === field);
  return fact ? { scope: "unit", unitId: unit.id, subject, text: fact.text, source: "operator", profileField: field } : undefined;
}

function propertyFacts(config: TourCoreConfig): ApprovedFact[] {
  return approvedFacts(config).filter((f) => f.scope === "property");
}

/**
 * A keyword that only appears because the question mentions a room is not an
 * answer. "Can I paint the bedroom walls?" does not ask how many bedrooms.
 */
function factsForQuestion(facts: ApprovedFact[], question: string): ApprovedFact[] {
  const skip = mentionedButNotAsked(question);
  if (!skip.length) return facts;
  const asked = stripFieldWords(question, skip);
  return facts.filter((fact) => {
    if (fact.profileField && skip.includes(fact.profileField)) return false;
    const stripped = stripFieldWords(fact.text, skip);
    const still = findApprovedAnswer([{ ...fact, text: stripped, profileField: undefined }], asked);
    if (still.length) return true;
    return findApprovedAnswer([fact], question).length === 0;
  });
}

/** A unit's facts for keyword matching. Its description is left out for topics its structured details cover. */
function unitFacts(config: TourCoreConfig, unitId: string, topic: ProfileField | undefined): ApprovedFact[] {
  const unit = config.units.find((u) => u.id === unitId);
  const all = approvedFacts(config, unitId).filter((f) => f.scope === "unit");
  if (!unit || !topic || !UNIT_FIELDS.includes(topic) || !unit.profile?.[topic]) return all;
  return all.filter((f) => f.profileField || f.text !== unit.summary);
}

/** The question without unit names in it: "1A" says which unit, not what about it, so it never matches a fact on its own. */
function withoutUnitNames(question: string, units: Pick<Unit, "name">[]): string {
  let out = question;
  for (const u of units) {
    const label = u.name.replace(/^(unit|apt\.?|apartment|suite)\s+/i, "");
    for (const n of [...new Set([u.name, label])].filter((x) => x.trim())) out = out.replace(new RegExp(`(?<![A-Za-z0-9])#?${esc(n)}(?![A-Za-z0-9])`, "gi"), " ");
  }
  return out;
}

/** "How long does the tour take?" Needs a tour word, so "How long is the lease?" is not this. */
const TOUR_WORD = /\b(?:tours?|showings?|viewings?)\b/;
const HOW_LONG = /\bhow (?:long|many minutes)\b/;
/** "Do I need ID?", "Should I bring my license?" Not a license plate. */
const ID_ASK = /\b(?:need|bring|required?|require)\b.*\b(?:id|ids|identification|license|licence|passport)\b(?!\s+plates?)/;

/** Tour logistics read from settings: a full sentence, never a guess. */
function logisticsAnswer(config: TourCoreConfig, asked: string): ApprovedFact | undefined {
  // One sentence at a time, so "How long is the lease? ... the tour." isn't read as the tour's length.
  const sentences = norm(asked)
    .split(/[.?!]+/)
    .map((s) => s.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const base = { scope: "property" as const, subject: config.property.name, source: "operator" as const };
  if (sentences.some((s) => HOW_LONG.test(s) && TOUR_WORD.test(s))) return { ...base, text: `Tours are about ${config.tourHours.tourLengthMinutes} minutes.`, templateId: "tour-length" };
  if (sentences.some((s) => ID_ASK.test(s))) {
    return config.verificationMode === "none"
      ? { ...base, text: "No ID or form is needed for this tour.", templateId: "tour-id-none" }
      : { ...base, text: "You'll fill out a short form with your name, email, and phone before your tour. No ID is needed at the door.", templateId: "tour-id-form" };
  }
  return undefined;
}

export function resolveQuestion(config: TourCoreConfig, asked: string, context: { selectedUnitId?: string; pickedUnitId?: string } = {}): QuestionResolution {
  // Before rent, keywords, saved answers, and "which unit?". A fair-housing
  // question is never auto-answered, even when a saved fact would match.
  if (isFairHousingQuestion(asked)) return { kind: "unknown", fairHousing: true };
  const logistics = logisticsAnswer(config, asked);
  if (logistics) return { kind: "answer", facts: [logistics] };
  const named = unitsNamedIn(asked, config.units);
  const question = withoutUnitNames(asked, config.units);
  const picked = context.pickedUnitId && config.units.some((u) => u.id === context.pickedUnitId) ? context.pickedUnitId : undefined;
  if (named.length > 1 && !picked) return { kind: "which-unit", units: named.map((u) => u.name) };
  const unitId =
    picked ?? named[0]?.id ?? (context.selectedUnitId && config.units.some((u) => u.id === context.selectedUnitId) ? context.selectedUnitId : undefined) ?? (config.units.length === 1 ? config.units[0]!.id : undefined);
  const unit = config.units.find((u) => u.id === unitId);
  const topic = questionTopic(question);

  // 1. Structured unit details first (bedrooms, rent, availability, ...).
  if (unit && topic) {
    const structured = unitAnswer(config, unit, topic);
    if (structured) return { kind: "answer", facts: [structured], unitId: unit.id };
    // The operator gave (or explicitly withheld) this detail; the description isn't a second source for it.
    if (UNIT_FIELDS.includes(topic) && unit.profile?.[topic]) return { kind: "unknown", unitId: unit.id };
  }

  const unitScoped = !!topic && UNIT_FIELDS.includes(topic);
  const property = findApprovedAnswer(factsForQuestion(propertyFacts(config), question), question);

  // 2. With a unit: its own approved facts, then building-wide ones (never for a unit-only detail like rent).
  if (unit) {
    const own = findApprovedAnswer(factsForQuestion(unitFacts(config, unit.id, topic), question), question);
    if (own.length) return { kind: "answer", facts: own, unitId: unit.id };
    if (property.length && !unitScoped) return { kind: "answer", facts: property, unitId: unit.id };
    return { kind: "unknown", unitId: unit.id };
  }

  // 3. No unit to go on. A unit-only detail is always asked back; a general question can be answered building-wide.
  const whichUnit: QuestionResolution = { kind: "which-unit", units: config.units.map((u) => u.name) };
  if (unitScoped) return config.units.length > 1 ? whichUnit : { kind: "unknown" };
  if (property.length) return { kind: "answer", facts: property };
  const onFileForSomeUnit = config.units.some((u) => (topic && SHARED_FIELDS.includes(topic) && unitAnswer(config, u, topic)) || findApprovedAnswer(factsForQuestion(unitFacts(config, u.id, topic), question), question).length);
  return onFileForSomeUnit && config.units.length > 1 ? whichUnit : { kind: "unknown" };
}

/** "1A, 1B, 2A or 2B" */
export function orList(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}
