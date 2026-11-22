import { mayHoldCode } from "../hub/codeText";
import { GuestFactsFileError, readGuestFacts, writeGuestFacts, type GuestFactsFile } from "../guest-messages/store";
import { MAX_RULES, MAX_RULE_TEXT } from "../stay-check/rules";
import { readStayCheck, StayCheckFileError, writeStayCheck } from "../stay-check/store";

/**
 * One list of house rules (#15). The nightly stay check's rules in `stay-check.json` are the list: each rule
 * in the host's words, a camera check on one only after the host agreed to its read-back (#253). Guest
 * replies draft from every rule on it. House facts (`guest-facts.json`) no longer keep a rules fact of their
 * own; one saved before this change is moved onto the list here, as text only, the first time either desk
 * opens. Nothing is lost: a fact that can't move whole stays where it was, and drafts still read it.
 */

/** Normalized for comparing two rules: the same words in any case, spacing or end mark. */
const same = (text: string) => text.toLowerCase().replace(/[\s.!;,]+/g, " ").trim();

/** Cuts a piece over the rule limit at the last space before it. */
function wrap(piece: string): string[] {
  const out: string[] = [];
  let rest = piece.trim();
  while (rest.length > MAX_RULE_TEXT) {
    const cut = rest.lastIndexOf(" ", MAX_RULE_TEXT);
    const at = cut > MAX_RULE_TEXT / 2 ? cut : MAX_RULE_TEXT;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * A house facts rules text as house rules, in the host's own words: one per line (list marks taken off),
 * a line over 200 characters by its sentences, and only a sentence over 200 cut at a space. A line of
 * several rules ("No smoking, parties or pets") stays one rule.
 */
export function splitRuleText(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s+/, "").trim();
    if (!line) continue;
    if (line.length <= MAX_RULE_TEXT) {
      out.push(line);
      continue;
    }
    let current = "";
    for (const sentence of line.split(/(?<=[.!?;])\s+/)) {
      const joined = current ? `${current} ${sentence}` : sentence;
      if (joined.length <= MAX_RULE_TEXT) {
        current = joined;
        continue;
      }
      if (current) out.push(current);
      const pieces = wrap(sentence);
      current = pieces.pop() ?? "";
      out.push(...pieces);
    }
    if (current) out.push(current);
  }
  return out;
}

export type MergeResult =
  /** Nothing to move: no rules fact in house facts. */
  | { status: "none" }
  /** The rules fact is on the house rules list now, and gone from house facts. `added` leaves out rules already on it. */
  | { status: "moved"; added: number }
  /** The rules fact stays in house facts, untouched, and drafts still read it. Why it couldn't move. */
  | { status: "kept"; why: "too-many" | "code" | "unreadable" };

/**
 * Moves a rules fact from house facts onto the house rules list, once. Writes the list first and takes the
 * fact out second, so a crash between leaves both, and the next call finds every rule already on the list
 * and only takes the fact out. A rule already on the list (the same words) isn't added twice. No check is
 * ever added: the host never agreed to a read-back for these. The save stays in the facts' history, so the
 * hours log keeps the host's own entry.
 */
export function mergeGuestRules(root: string, now: Date): MergeResult {
  let facts: GuestFactsFile;
  try {
    facts = readGuestFacts(root);
  } catch (error) {
    if (error instanceof GuestFactsFileError) return { status: "none" };
    throw error;
  }
  const fact = facts.facts.find((item) => item.topic === "rules");
  if (!fact) return { status: "none" };
  const pieces = splitRuleText(fact.text);
  if (pieces.some(mayHoldCode)) return { status: "kept", why: "code" };
  let stay;
  try {
    stay = readStayCheck(root);
  } catch (error) {
    if (error instanceof StayCheckFileError) return { status: "kept", why: "unreadable" };
    throw error;
  }
  const have = new Set(stay.rules.map((rule) => same(rule.text)));
  const fresh: string[] = [];
  for (const piece of pieces) {
    if (have.has(same(piece))) continue;
    have.add(same(piece));
    fresh.push(piece);
  }
  if (stay.rules.length + fresh.length > MAX_RULES) return { status: "kept", why: "too-many" };
  if (fresh.length) writeStayCheck(root, { ...stay, rules: [...stay.rules, ...fresh.map((text) => ({ text }))], rulesMergedAt: now.toISOString() });
  const history = [...(facts.history ?? [])];
  if (!history.some((entry) => entry.topic === "rules" && entry.at === fact.savedAt)) history.push({ at: fact.savedAt, topic: "rules" });
  writeGuestFacts(root, { ...facts, facts: facts.facts.filter((item) => item !== fact), skipped: facts.skipped.filter((topic) => topic !== "rules"), history });
  return { status: "moved", added: fresh.length };
}

/** Every house rule a guest reply may draft from, in the host's words: the list, then a rules fact that couldn't move. */
export interface GuestRules {
  rules: string[];
  /** Set when stay-check.json can't be read: the list is unknown, so the host needs to look. */
  unreadable?: true;
}

export function rulesForGuests(root: string, now: Date): GuestRules {
  mergeGuestRules(root, now);
  const leftover = (() => {
    try {
      return readGuestFacts(root).facts.filter((fact) => fact.topic === "rules").map((fact) => fact.text);
    } catch {
      return [];
    }
  })();
  try {
    return { rules: [...readStayCheck(root).rules.map((rule) => rule.text), ...leftover] };
  } catch (error) {
    if (error instanceof StayCheckFileError) return { rules: leftover, unreadable: true };
    throw error;
  }
}
