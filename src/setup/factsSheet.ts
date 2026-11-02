/**
 * The property facts sheet: the extra facts visitors ask about, asked one at a time during setup.
 * Each answer is stored word for word as an approved property fact, prefixed with its topic label,
 * so keyword matching finds it ("How to apply: Apply online at ..."). "other" is free text, split into
 * one fact per line, then per sentence, with no prefix.
 */

export const FACT_TOPICS = ["apply", "fees", "lease", "move_in", "guests", "rules", "area", "other"] as const;
export type FactTopic = (typeof FACT_TOPICS)[number];

export const FACT_LABELS: Record<FactTopic, string> = {
  apply: "How to apply",
  fees: "Fees and deposit",
  lease: "Lease length",
  move_in: "Due at move-in",
  guests: "Bringing someone",
  rules: "Building rules",
  area: "The area",
  other: "",
};

export const FACT_QUESTIONS: Record<FactTopic, string> = {
  apply: "How do people apply?",
  fees: "Is there an application fee or deposit?",
  lease: "What lease lengths do you offer?",
  move_in: "What's due at move-in?",
  guests: "Can visitors bring someone on the tour?",
  rules: "Any building rules visitors should know?",
  area: "Anything about the area worth mentioning?",
  other: "Anything else visitors should know?",
};

/** The fact as stored: the topic's label, then the landlord's own words. */
export function factFor(topic: FactTopic, text: string): string {
  const label = FACT_LABELS[topic];
  return label ? `${label}: ${text.trim()}` : text.trim();
}

/** True when this stored fact is that topic's labeled answer. "other" facts have no label, so none match. */
export function isTopicFact(topic: FactTopic, fact: string): boolean {
  const label = FACT_LABELS[topic];
  return !!label && fact.startsWith(`${label}: `);
}

/** The first topic not yet answered or skipped, or undefined once every one is. */
export function nextFactTopic(property: { factsAsked?: readonly string[] }): FactTopic | undefined {
  const asked = new Set(property.factsAsked ?? []);
  return FACT_TOPICS.find((topic) => !asked.has(topic));
}

/** One entry per non-empty line, then per sentence. */
export function splitFreeText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/))
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The refusal for a line that states a preference about who should live there. */
export const FAIR_HOUSING_FACT_REFUSAL = "That says who should live there, which fair housing rules don't allow, so I didn't save it. Say what the place offers instead.";
