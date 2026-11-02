import type { TourCoreConfig } from "../config/tourCoreConfig";
import { profileFacts, type ProfileField } from "../config/unitProfile";
import { visitorTeamName } from "../sms/templates";
import { visitorSubject } from "../visitor/identity";

/** A statement the operator wrote and approved. Tour guidance may only repeat these. */
export interface ApprovedFact {
  scope: "property" | "unit";
  /** Set when scope is "unit". */
  unitId?: string;
  /** What the fact is about, e.g. "100 Alfred Way" or "Unit 101". */
  subject: string;
  text: string;
  source: "operator";
  /** Set when the sentence was generated from a structured unit value (bedrooms, rent, ...), never invented. */
  profileField?: ProfileField;
  /** Set on a built-in tour-logistics answer (tour length, ID): a full sentence read from settings, sent with this template. */
  templateId?: "tour-length" | "tour-id-form" | "tour-id-none";
}

const STOPWORDS = new Set(
  ("a an and any are as at be by can could do does for from get got has have here how i if in is it its me my of on or " +
    "our place please property so tell that the there this to unit apartment what whats which with would you your " +
    "about much many there's it's is there where when will").split(" "),
);

/** Words people use for the same thing, folded to one key. */
const SYNONYMS: Record<string, string> = {
  bed: "bedroom", beds: "bedroom", br: "bedroom", bedroom: "bedroom", bedrooms: "bedroom",
  bath: "bathroom", baths: "bathroom", bathroom: "bathroom", bathrooms: "bathroom", ba: "bathroom",
  parking: "parking", garage: "parking", car: "parking", cars: "parking",
  washer: "laundry", dryer: "laundry", laundry: "laundry",
  pet: "pet", pets: "pet", dog: "pet", dogs: "pet", cat: "pet", cats: "pet",
  include: "include", included: "include", includes: "include", utilities: "include", utility: "include",
  window: "window", windows: "window", light: "window", sunny: "window",
  sqft: "size", square: "size", feet: "size", size: "size", big: "size", large: "size",
  rent: "rent", rents: "rent", price: "rent", priced: "rent", cost: "rent", costs: "rent", monthly: "rent", month: "rent", howmuch: "rent",
  available: "available", availability: "available", vacant: "available", movein: "available",
  studio: "bedroom", furnished: "furnish", unfurnished: "furnish", floor: "floor", story: "floor",
};

/** Parking is the word itself, or one of these asks. A bare "park" ("dog park") is not parking. */
const PARKING_PHRASE = /\b(?:parking|park my car|where do i park)\b/;

function keywords(text: string): string[] {
  const lower = text.toLowerCase().replace(/['\u2019]/g, "");
  const words = lower
    .replace(/\bhow much\b/g, "howmuch")
    .replace(/\bmove[\s-]?in\b/g, "movein")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .map((w) => SYNONYMS[w] ?? w.replace(/(ing|ed|es|s)$/, ""))
    .filter((w) => w.length > 1);
  if (PARKING_PHRASE.test(lower) && !words.includes("parking")) words.push("parking");
  return words;
}

/**
 * Deterministic lookup: returns the approved facts that share a topic word
 * with the question, best first (at most two). Empty means "no approved
 * answer", never a guess.
 */
export function findApprovedAnswer(facts: ApprovedFact[], question: string): ApprovedFact[] {
  const asked = new Set(keywords(question));
  if (!asked.size) return [];
  const scored = facts
    .map((fact) => ({ fact, score: new Set(keywords(fact.text).filter((k) => asked.has(k))).size }))
    .filter((x) => x.score > 0);
  // A structured unit value (bedrooms, rent, ...) is the canonical answer for its topic.
  const structured = scored.filter((x) => x.fact.profileField);
  return (structured.length ? structured : scored)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((x) => x.fact);
}

/** Property-wide facts plus, when given, one unit's structured details, description and facts. Nothing is invented. */
export function approvedFacts(config: TourCoreConfig, unitId?: string): ApprovedFact[] {
  const out: ApprovedFact[] = config.property.facts.map((text) => ({ scope: "property", subject: config.property.name, text, source: "operator" }));
  const units = unitId ? config.units.filter((u) => u.id === unitId) : config.units;
  for (const unit of units) {
    const subject = visitorSubject(config.property, unit.name);
    for (const f of profileFacts(unit, subject)) out.push({ scope: "unit", unitId: unit.id, subject, text: f.text, source: "operator", profileField: f.field });
    for (const text of [unit.summary, ...unit.facts].filter((t) => t.trim())) {
      out.push({ scope: "unit", unitId: unit.id, subject: unit.name, text, source: "operator" });
    }
  }
  return out;
}

/** How an approved answer reads to the visitor: generated unit details are complete sentences on their own. */
export function approvedAnswerText(facts: ApprovedFact[], team?: string): string {
  const text = facts.map((f) => f.text).join(" ");
  return facts.every((f) => f.profileField || f.templateId) ? text : `Here's what the ${visitorTeamName(team)} shared: ${text}`;
}
