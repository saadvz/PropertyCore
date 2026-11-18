/**
 * The house's facts for guests (#242): the host's own words on wifi, parking, trash, checkout and the
 * rest, and which of them answer a guest's message. Pure. Built on the shape of Tour Core's facts sheet
 * (docs/superpowers/specs/2026-11-02-visitor-scenarios-and-facts-design.md): fixed topics, plus free text.
 */

export const FACT_TOPICS = ["wifi", "parking", "trash", "checkout", "check_in", "rules", "area", "other"] as const;

export type GuestFactTopic = (typeof FACT_TOPICS)[number];

export interface GuestFact {
  topic: GuestFactTopic;
  /** The host's words. */
  text: string;
  savedAt: string;
}

export const MAX_FACT_TEXT = 500;
export const MAX_OTHER_FACTS = 20;

/** How a topic reads in a sentence to the host or agent. */
export const TOPIC_LABELS: Readonly<Record<GuestFactTopic, string>> = {
  wifi: "wifi",
  parking: "parking",
  trash: "trash",
  checkout: "checkout",
  check_in: "check-in",
  rules: "house rules",
  area: "the area",
  other: "other",
};

export function isFactTopic(value: unknown): value is GuestFactTopic {
  return typeof value === "string" && (FACT_TOPICS as readonly string[]).includes(value);
}

/**
 * The booking-email redaction's access words without the password ones, so a wifi password stays and a
 * door, gate or lockbox code doesn't.
 */
const ACCESS_WORDS =
  /\b(code|codes|pin|pins|passcode|combo|combination|lock|lockbox|keypad|key\s?pad|door|gate|garage|opener|entry|entrance|enter|access|alarm|keyless|smart\s?lock)\b|\bpin(?=\d)/i;
const DIGITS = /\d(?:[\s.-]?\d){2,}/;

/** True when the text has 3 or more digits on a line that talks about a way in (a password alone doesn't count). */
export function holdsDoorCode(text: string): boolean {
  let afterAccess = false;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const access = ACCESS_WORDS.test(line);
    if (DIGITS.test(line) && (access || (afterAccess && /^[\d\s#*.-]+$/.test(line.trim())))) return true;
    if (line.trim()) afterAccess = access;
  }
  return false;
}

/** Undefined when the fact can be saved; else a refusal that names the topic, never the text. */
export function factProblem(topic: GuestFactTopic, text: unknown): string | undefined {
  const label = TOPIC_LABELS[topic];
  if (typeof text !== "string" || !text.trim()) return `Give the ${label} fact in the host's own words.`;
  if (text.trim().length > MAX_FACT_TEXT) return `Keep the ${label} fact under ${MAX_FACT_TEXT} characters.`;
  if (holdsDoorCode(text)) return `Keep door codes out of the house facts. Guest codes come with the smart-lock connection. Give the ${label} fact without the number.`;
  return undefined;
}

/** The words that put a message on each topic. "other" matches on shared words instead. */
const TOPIC_WORDS: Readonly<Record<Exclude<GuestFactTopic, "other">, RegExp>> = {
  wifi: /\b(wi-?fi|internet|network|password|router)\b/i,
  parking: /\b(park|parking|car|cars|garage|driveway|street)\b/i,
  trash: /\b(trash|garbage|rubbish|recycling|bins?|dumpster)\b/i,
  checkout: /\b(check[\s-]?out|leave|leaving|departure)\b/i,
  check_in: /\b(check[\s-]?in|arrive|arriving|arrival|get in|early)\b/i,
  rules: /\b(rules?|pets?|dogs?|smok(e|ing)|party|parties|quiet|noise|guests over|visitors?)\b/i,
  area: /\b(restaurants?|grocery|groceries|coffee|beach|things to do|nearby|eat)\b/i,
};

const STOP = new Set(["that", "this", "with", "have", "what", "when", "where", "there", "will", "your", "from", "about", "would", "could", "should", "they", "them", "here", "just", "also", "thanks", "thank", "please", "there's", "it's"]);

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z']+/)
      .map((word) => word.replace(/^'+|'+$/g, ""))
      .filter((word) => word.length >= 4 && !STOP.has(word)),
  );
}

export interface FactMatch {
  /** The saved facts that answer some part of the message. Only these may go in a draft. */
  facts: GuestFact[];
  /** Topics the message asks about with no saved fact. */
  missing: GuestFactTopic[];
  /** Nothing on file answers it. */
  isNew: boolean;
}

export function matchFacts(message: string, facts: readonly GuestFact[]): FactMatch {
  const touched = (Object.keys(TOPIC_WORDS) as Exclude<GuestFactTopic, "other">[]).filter((topic) => TOPIC_WORDS[topic].test(message));
  const words = contentWords(message);
  const matched = facts.filter((fact) => (fact.topic === "other" ? [...contentWords(fact.text)].some((word) => words.has(word)) : touched.includes(fact.topic)));
  const missing = touched.filter((topic) => !facts.some((fact) => fact.topic === topic));
  return { facts: matched, missing, isNew: matched.length === 0 };
}

const LATE_CHECKOUT = [
  /\blate\s+check[\s-]?out\b/i,
  /\bcheck[\s-]?out\s+(a\s+(bit|little)\s+)?later\b/i,
  /\bleave\s+(a\s+(bit|little)\s+)?later\b/i,
  /\bstay\s+(a\s+(bit|little)\s+)?(longer|later)\b/i,
  /\bextra\s+hours?\b/i,
  /\b(leave|check[\s-]?out)\s+at\s+\d/i,
];

/** The guest's words ask to leave later than checkout. */
export function asksLateCheckout(message: string): boolean {
  return LATE_CHECKOUT.some((pattern) => pattern.test(message));
}
