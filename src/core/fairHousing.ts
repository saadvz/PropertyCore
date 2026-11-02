/**
 * Fair-housing questions are detected here, before any rent sentence, keyword
 * match, or saved answer. A protected-group word anywhere in the message
 * matches, unless the next word names a thing (a family car, a kid's bike,
 * a white door, Asian restaurants). "discount" and "building" do not stop
 * a group word, so senior discounts and a senior building still match.
 * "age of the building" and "roof age" name the building, not a person.
 * A group word after "I'm", "I am", or "my name is" is skipped only when
 * that word and the word before it are both capitalized ("Kim Single",
 * "Jordan Black"). A day or time the scheduler already
 * recognizes, or bringing someone to the tour or showing, stays on the tour
 * when the message does not also ask whether the place suits them. So does
 * "allowed" on the tour or showing. "works for" next to a recognized time
 * is that booking. A wheelchair, walker, cane, or the words blind, deaf,
 * disabled, or disability is not that tour-logistics exemption.
 */

import { dayReference, spokenTimes } from "./spokenTime";

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[-/]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Audit code on a flagged fair-housing question. No draft is proposed. */
export const FAIR_HOUSING_CODE = "FAIR_HOUSING";

/**
 * Longer phrases first. A match counts unless the next word is a stop word.
 * "baby grand" is a piano, not the group word baby.
 */
const GROUP_WORD = [
  "young professionals?",
  "older people",
  "people of color",
  "familial status",
  "national origin",
  "country of origin",
  "single (?:moms?|mothers?|dads?|fathers?|parents?)",
  "sexual orientation",
  "gender identity",
  "same sex couples?",
  "teenagers?",
  "newborns?",
  "toddlers?",
  "infants?",
  "wheelchairs?",
  "disabilities",
  "disability",
  "handicapped",
  "handicap",
  "families",
  "family",
  "children",
  "babies",
  "baby",
  "child",
  "retirees?",
  "elderly",
  "seniors?",
  "teens?",
  "kids?",
  "couples?",
  "married",
  "partners?",
  "single",
  "disabled",
  "pregnant",
  "pregnancy",
  "immigrants?",
  "nationality",
  "religious",
  "religions?",
  "christians?",
  "catholics?",
  "protestants?",
  "jewish",
  "jews?",
  "muslims?",
  "islamic",
  "hindus?",
  "buddhists?",
  "sikhs?",
  "mormons?",
  "atheists?",
  "hispanics?",
  "latinos?",
  "latinas?",
  "asians?",
  "blacks?",
  "whites?",
  "arabs?",
  "racial",
  "race",
  "color",
  "hispanic",
  "latino",
  "latina",
  "asian",
  "black",
  "white",
  "arab",
  "gender",
  "blind",
  "deaf",
  "ages?",
  "sex",
  "gays?",
  "lesbians?",
  "lgbtq?",
  "transgender",
].join("|");

const GROUP = new RegExp(`\\b(?:${GROUP_WORD})\\b`, "g");

/** The group word only names this thing. It is not a question about the group. */
const CLASS_STOP =
  /^(?:car|cars|room|rooms|size|sizes|style|styles|offender|offenders|neutral|dinner|dinners|gathering|gatherings|bike|bikes|toy|toys|dog|dogs|cat|cats|piano|pianos|parking|photography|table|tables|fridge|fridges|walls?|doors?|gates?|paints?|roofs?|fridays?|restaurants?)$/;

const FRIENDLY = /\b(?:family|kid|child) friendly\b/;
const FAMILY_BUILDING = /\bfamily buildings?\b/;

/**
 * Fair housing even with no group word left after the stop list. A bare
 * "pets", "dogs", or "minimum" is not enough. Assistance animals include
 * dog, cat, and pet, so "service dog" still matches when dog is a stop word.
 */
const ASSISTANCE_ANIMAL =
  /\b(?:(?:service|assistance|support|guide|seeing eye|therapy) (?:dogs?|animals?|cats?|pets?)|emotional support \w+|esas?)\b/;

/**
 * Faith and creed names, including plurals. Place words such as church,
 * temple, and mosque are not names, so a church nearby stays out.
 */
const FAITH =
  /\b(?:christians?|catholics?|protestants?|jewish|jews?|muslims?|islamic|hindus?|buddhists?|sikhs?|mormons?|atheists?)\b/;

/** A social security number is tied to immigration and national origin. */
const SSN = /\b(?:ssns?|social security(?: numbers?)?)\b/;

const STANDALONE =
  /\b(?:pregnant|pregnancy|newborns?|baby(?:s)? on the way|adults only|immigrants?|immigration status|minimum age|age limits?|age restrictions?|55 and over|senior community|housing assistance|housing vouchers?|section\s*8|hud|undocumented|sexual orientation|gender identity|gays?|lesbians?|lgbtq?|same sex couples?|transgender|religions?|religious|discriminat(?:e|es|ed|ing|ion)|vouchers?)\b/;

/** "55+" loses the plus when punctuation is stripped, so it is checked on the raw text. */
const FIFTY_FIVE_PLUS = /55\s*\+/;

/**
 * People words that can pair with an area phrase. A singular race word still
 * matches on its own through the group-word rule.
 */
const PEOPLE_BESIDE =
  /\b(?:people|families|family|folks|residents|neighbors|tenants|kids|children|child|hispanics|latinos|latinas|asians|blacks|whites|arabs)\b/;

const RACE_OR_COLOR = /\b(?:hispanic|latino|latina|asian|black|white|arab|color)\b/;

/** How many. A race or color word counts here only beside a people word. */
const QUANTITY = /\b(?:many|a lot of|lots of)\b/;

/** Where, or what the place is like. */
const PLACE = /\b(?:mostly|around here|in the area|neighborhood|nearby|on the block|in the building)\b/;

const OBJECT_NOUN =
  /\b(?:foods?|restaurants?|stores?|markets?|grocer(?:y|ies)|shops?|cafes?|baker(?:y|ies)|cuisines?|dishes?|meals?|fences?|doors?|walls?|paints?|fridays?|sales?|kitchens?|trim|siding|carpets?|tiles?|cabinets?|floors?|ceilings?|roofs?|appliances?|counters?|windows?|blinds?)\b/;

const OBJECT_FILLER = "(?:picket|painted|front|back|garage|exterior|interior|local|nearby|the|a|an|some|any)";

const OTHER_AREA = /\b(?:neighbors|lives? around|any other)\b/;

/** Steering even with no class word beside it. "Is it safe for walking" is not this. */
const STEERING =
  /\b(?:what kind of people|what type of people|who lives (?:there|here|in the building|nearby)|is the (?:neighborhood|area) safe|safe neighborhood|safe area|crime rate|good neighborhood|bad neighborhood)\b/;

/** Suitability, as opposed to "is that ok?" about bringing someone along. */
const SUITABILITY_OTHER =
  /\b(?:good|safe|okay|ok|right|suitable|ideal|great|perfect)\s+for\b|\bbig enough\b|\ba fit for\b|\baccessible for\b/;

/** "2 pm works for my family" is a booking. "works for my family" with no clock is suitability. */
const WORKS_FOR = /\b(?:work|works|working)\s+for\b/;

/** An object a person might ask the age of. Sits on either side of "age". */
const AGE_OBJECT = "(?:walls?|doors?|gates?|paints?|roofs?|buildings?|discounts?|fridays?|restaurants?)";

/**
 * These words are not "can my mom come to the tour". The message stays a
 * possible fair-housing question.
 */
const DISABILITY_SKIPS_TOUR = /\b(?:wheelchairs?|walkers?|canes?|blind|deaf|disabled|disabilit(?:y|ies))\b/;

function spans(re: RegExp, text: string): Array<{ start: number; end: number }> {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  return [...text.matchAll(new RegExp(re.source, flags))].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function beside(text: string, a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  const left = a.end <= b.start ? a : b;
  const right = left === a ? b : a;
  if (left.end > right.start) return false;
  return /^\s*$/.test(text.slice(left.end, right.start));
}

function modifiesNonPeopleNoun(text: string, word: { start: number; end: number }): boolean {
  const after = text.slice(word.end);
  if (/^\s+(?:people|families|family|folks|residents|neighbors|tenants|kids|children|child|hispanics|latinos|latinas|asians|blacks|whites|arabs)\b/.test(after)) {
    return false;
  }
  if (new RegExp(`^\\s+${OBJECT_FILLER}\\s+${OBJECT_NOUN.source}`, "i").test(after)) return true;
  if (new RegExp(`^\\s+${OBJECT_NOUN.source}`, "i").test(after)) return true;
  const before = text.slice(0, word.start);
  if (new RegExp(`${OBJECT_NOUN.source}\\s+(?:are|is|was|were)\\s+$`, "i").test(before)) return true;
  if (new RegExp(`(?:are|is)\\s+(?:the\\s+)?${OBJECT_NOUN.source}\\s+$`, "i").test(before)) return true;
  if (/\b(?:what|which)\s+$/.test(before) && new RegExp(`^\\s+(?:are|is)\\s+(?:the\\s+)?${OBJECT_NOUN.source}`, "i").test(after)) return true;
  return false;
}

function neighborhoodSteering(text: string): boolean {
  if (STEERING.test(text)) return true;
  const people = spans(PEOPLE_BESIDE, text);
  const race = spans(RACE_OR_COLOR, text);
  const raceBesidePeople = race.filter((word) => people.some((person) => beside(text, word, person)));
  const classes = [...people, ...raceBesidePeople];
  const areas = [...spans(QUANTITY, text), ...spans(PLACE, text), ...spans(OTHER_AREA, text)];
  if (classes.some((word) => areas.some((area) => !overlaps(word, area)))) return true;
  const places = spans(PLACE, text);
  const placeRace = race.filter((word) => !modifiesNonPeopleNoun(text, word));
  return placeRace.some((word) => places.some((place) => !overlaps(word, place)));
}

function nextWord(after: string): string | undefined {
  return /^\s+(\S+)/.exec(after)?.[1];
}

/** A stated age ("she's 80", "80 years old"), not a clock or a head count. */
function personAge(text: string): boolean {
  return /\b(?:shes|hes|theyre)\s+\d{1,3}\b/.test(text) || /\b\d{1,3}\s+years?\s+old\b/.test(text);
}

/** "age of the building", "age of the roof", "roof age". Not "what ages live here". */
function ageBesideObject(text: string, start: number, end: number): boolean {
  const after = text.slice(end);
  const before = text.slice(0, start);
  if (new RegExp(`^\\s+of\\s+(?:the\\s+|a\\s+|an\\s+)?${AGE_OBJECT}\\b`).test(after)) return true;
  return new RegExp(`(?:^|\\s)${AGE_OBJECT}\\s+$`).test(before);
}

/** Words of the original text, aligned with fair-housing normalization. */
function originalTokens(raw: string): Array<{ norm: string; cap: boolean }> {
  const tokens: Array<{ norm: string; cap: boolean }> = [];
  for (const match of raw.matchAll(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*/g)) {
    const piece = match[0];
    const folded = piece.toLowerCase().replace(/['’]/g, "");
    if (folded) tokens.push({ norm: folded, cap: /^[A-Z]/.test(piece) });
  }
  return tokens;
}

/**
 * "Hi, I'm Kim Single" / "my name is Jordan Black". The word right after I'm
 * ("I'm single", "I'm legally blind") is still the group word. The surname
 * slot is skipped only when both that word and the word before it are
 * capitalized in the original text.
 */
function isIntroducedSurname(text: string, start: number, original: string): boolean {
  const before = text.slice(0, start);
  if (!/\b(?:im|i am|my name is)\s+[a-z0-9]+\s+$/.test(before)) return false;
  if (/\b(?:im|i am|my name is)\s+(?:a|an|the|very|so|just|still|not|really|also|my)\s+$/.test(before)) return false;
  const normWords = text.split(" ").filter(Boolean);
  const index = text.slice(0, start).split(" ").filter(Boolean).length;
  const tokens = originalTokens(original);
  if (tokens.length !== normWords.length || tokens.some((token, i) => token.norm !== normWords[i])) return false;
  return !!tokens[index]?.cap && !!tokens[index - 1]?.cap;
}

function unstoppedGroupWord(text: string, original: string): boolean {
  for (const match of text.matchAll(new RegExp(GROUP.source, "g"))) {
    const word = match[0];
    const start = match.index ?? 0;
    const end = start + word.length;
    const after = text.slice(end);
    const next = nextWord(after);
    if (word === "baby" && next === "grand") continue;
    if (next && CLASS_STOP.test(next)) continue;
    if (word === "age" && ageBesideObject(text, start, end)) continue;
    if (word === "color" && /^\s+(?:are|is)\s+(?:the\s+)?walls?\b/.test(after)) continue;
    if (isIntroducedSurname(text, start, original)) continue;
    return true;
  }
  return false;
}

function asksSuitability(text: string): boolean {
  return SUITABILITY_OTHER.test(text) || WORKS_FOR.test(text);
}

/** "2 pm works for my family" books. Other suitability still holds the message. */
function worksForRecognizedTime(text: string): boolean {
  return WORKS_FOR.test(text) && !SUITABILITY_OTHER.test(text) && schedulerRecognizes(text);
}

/** True when a recognized day or time should stay a question because it also asks suitability. */
export function suitabilityBlocksBooking(text: string): boolean {
  const t = norm(text);
  if (SUITABILITY_OTHER.test(t)) return true;
  return WORKS_FOR.test(t) && !schedulerRecognizes(t);
}

/**
 * Topics that keep a weekday from being a day pick ("Black Friday sale",
 * "Sunday parking"). Same list the day menu uses.
 */
const NOT_A_DAY_PICK =
  /\b(?:parking|park|garage|laundry|washer|dryer|pets?|dogs?|cats?|gym|pool|rent|price|cost|deposit|utilities|wifi|internet|ac|heat|heating|bedrooms?|bathrooms?|beds?|baths?|sq ?ft|square feet|size|storage|elevator|floor|lease|move in|amenities|appliances|dishwasher|balcony|view|furnished|sale|nearby|busy)\b/;

/** A day or clock the booking parser already treats as a time request. */
function schedulerRecognizes(text: string): boolean {
  if (spokenTimes(text).length > 0) return true;
  const day = dayReference(text);
  if (!day || day === "menu" || day.unclear) return false;
  if (NOT_A_DAY_PICK.test(text)) return false;
  return true;
}

/**
 * Bringing someone to the tour or showing, including "allowed on the tour".
 * "Is the tour OK for kids?" is suitability, not this. A wheelchair, walker,
 * cane, or the words blind, deaf, disabled, or disability is not this.
 * An assistance animal is handled before this is consulted.
 */
function isTourAccompaniment(text: string): boolean {
  if (DISABILITY_SKIPS_TOUR.test(text)) return false;
  if (/\b(?:i am|im|we are|were) bringing\b/.test(text)) return true;
  if (/\b(?:bring(?:ing)?|brought)\b/.test(text) && /\b(?:tour|showing)\b/.test(text)) return true;
  if (/\b(?:come|coming)\b/.test(text) && /\b(?:tour|showing)\b/.test(text)) return true;
  if (/\b(?:can|could|may)\s+(?:my|our)\s+\w+\s+come\b/.test(text)) return true;
  if (/\ballowed\b/.test(text) && /\b(?:tour|showing)\b/.test(text)) return true;
  return false;
}

/**
 * A tour aside with no day, time, or suitability question. The booking
 * conversation continues, and nothing is answered about who the place suits.
 */
export function isTourPartyNote(text: string): boolean {
  const t = norm(text);
  if (!t || asksSuitability(t) || schedulerRecognizes(t) || !isTourAccompaniment(t)) return false;
  return !isFairHousingQuestion(text);
}

export function isFairHousingQuestion(text: string): boolean {
  if (FIFTY_FIVE_PLUS.test(text)) return true;
  const t = norm(text);
  if (!t) return false;
  if (ASSISTANCE_ANIMAL.test(t) || FAITH.test(t) || SSN.test(t) || STANDALONE.test(t)) return true;
  if (FRIENDLY.test(t) || FAMILY_BUILDING.test(t)) return true;
  if (neighborhoodSteering(t)) return true;
  if (worksForRecognizedTime(t)) return false;
  if (!asksSuitability(t) && (schedulerRecognizes(t) || isTourAccompaniment(t))) return false;
  if (personAge(t) || unstoppedGroupWord(t, text)) return true;
  return false;
}

/** "Ideal for a young professional", "perfect for a quiet guy": a preference about who, even with no group word. */
const WHO_SUITS = /\b(?:ideal|perfect|great|best|suited|good)\s+for\s+(?:an?\s+)?(?:\w+\s+)?(?:man|men|woman|women|guys?|girls?|lad(?:y|ies)|gentlem[ae]n|students?|professionals?|person|people|tenants?|renters?)\b/;

/**
 * A landlord's fact that states who should live there (families, age, faith, origin, disability,
 * sex, race, or similar wording like "no kids" or "ideal for a young professional"). Such a line is
 * never stored or sent. Uses the same checks as visitor questions, plus suitability-for-a-person phrasing.
 */
export function isFairHousingStatement(text: string): boolean {
  if (isFairHousingQuestion(text)) return true;
  return WHO_SUITS.test(norm(text));
}
