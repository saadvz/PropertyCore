import { isScratchTestNumber } from "../cleaner-core/scratch";

/**
 * Grok live test scripts (docs/grok-tests): one Markdown file per feature, read by the grok-live-test skill
 * and by a person running the same steps by hand. This only reads and checks the files. Nothing here talks
 * to Grok, Twilio or a lock.
 */

export const GROK_TEST_PROPERTIES = ["12 Scratch Lane", "Adélie Cottage"] as const;
export type GrokTestProperty = (typeof GROK_TEST_PROPERTIES)[number];

export interface GrokTestStep {
  number: number;
  title: string;
  say: string;
  expect: string;
  check: string;
  wait: string;
}

export interface GrokTestScript {
  title: string;
  property: GrokTestProperty | undefined;
  steps: GrokTestStep[];
  /** Every line of the file, so the phone and door code checks cover notes and "Still by hand" too. */
  lines: string[];
  /** Line numbers (from 1) of "## " headings that start like a step but aren't `## <n>. <title>`. */
  badHeadings: number[];
}

const PARTS = ["say", "expect", "check", "wait"] as const;
type Part = (typeof PARTS)[number];
const PART_LABEL: Record<Part, string> = { say: "Say", expect: "Expect", check: "Check", wait: "Wait" };

export const SCRATCH_PREFIX = "On 12 Scratch Lane only:";

/** A US number in any usual spelling: +1 555 555 0101, (555) 555-0101, 5555550101, 555  555  0101. */
const PHONE = /(?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}(?!\d)/g;
/** Four to eight digits, also spelled with spaces or dashes between them: 9073, 9 0 7 3, 90-73. */
const DIGITS = String.raw`(?<![\d])\d(?:[ -]?\d){3,7}(?![\d])`;
const CODE_WORD = String.raw`\b(?:codes?|pins?|passcodes?)\b`;
/** A code word and four or more digits close together, in either order. Phone numbers are taken out first. */
const DOOR_CODE = new RegExp(`${CODE_WORD}[^\\n]{0,40}?${DIGITS}|${DIGITS}[^\\n]{0,40}?${CODE_WORD}`, "i");
const DURATION = /^(?:about )?\d+ (?:seconds?|minutes?|hours?|days?)$/i;
const CLOCK = /^\d{1,2}(?::\d{2})? ?(?:AM|PM)$/i;
/** The three shapes of a Say line: a quoted host line, a card press, or an action in Chrome. */
const QUOTED = /^["\u201c].*["\u201d]$/;
const CARD_PRESS = /^press [A-Z] on the card$/i;
const CHROME_ACTION = /^in \S/;

export function parseGrokTestScript(markdown: string): GrokTestScript {
  let title = "";
  let property: GrokTestProperty | undefined;
  let propertyLine: string | undefined;
  const steps: GrokTestStep[] = [];
  const lines = markdown.split(/\r?\n/);
  const badHeadings: number[] = [];
  let current: GrokTestStep | undefined;
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    const heading = /^## (\d+)\. (.+)$/.exec(line);
    if (heading) {
      current = { number: Number(heading[1]), title: heading[2]!.trim(), say: "", expect: "", check: "", wait: "" };
      steps.push(current);
      continue;
    }
    if (line.startsWith("## ")) {
      if (/^## \d/.test(line)) badHeadings.push(index + 1);
      // A section that isn't a step (a "Still by hand" note) ends the steps above it.
      current = undefined;
      continue;
    }
    if (!title && line.startsWith("# ")) {
      title = line.slice(2).trim();
      continue;
    }
    if (!current && propertyLine === undefined && line.startsWith("Property:")) {
      propertyLine = line.slice("Property:".length).trim();
      property = GROK_TEST_PROPERTIES.find((name) => name === propertyLine);
      continue;
    }
    if (!current) continue;
    for (const part of PARTS) {
      const label = `${PART_LABEL[part]}:`;
      if (line.startsWith(label)) current[part] = line.slice(label.length).trim();
    }
  }
  return { title, property, steps, lines, badHeadings };
}

export function grokTestScriptProblems(script: GrokTestScript): string[] {
  const problems: string[] = [];
  if (!script.property) problems.push(`The Property line must be ${GROK_TEST_PROPERTIES.join(" or ")}.`);
  if (script.steps.length === 0) problems.push("The script has no steps.");
  for (const at of script.badHeadings) problems.push(`Line ${at} looks like a step but isn't "## <n>. <title>".`);
  for (const [index, line] of script.lines.entries()) {
    const phones = line.match(PHONE) ?? [];
    if (phones.some((phone) => !isScratchTestNumber(asE164(phone)))) {
      problems.push(`Line ${index + 1} uses a phone number that is not a 555 test number.`);
    }
    if (DOOR_CODE.test(line.replace(PHONE, ""))) problems.push(`Line ${index + 1} has door code digits. Scripts never hold a code.`);
  }
  for (const step of script.steps) {
    const missing = PARTS.filter((part) => step[part] === "");
    for (const part of missing) problems.push(`Step ${step.number} has no ${PART_LABEL[part]} line.`);
    const quoted = QUOTED.test(step.say);
    if (step.say && !quoted && !CARD_PRESS.test(step.say) && !CHROME_ACTION.test(step.say)) {
      problems.push(`Step ${step.number} has a Say line that isn't quoted, "press <letter> on the card", or an action starting with "in".`);
    }
    if (script.property === "12 Scratch Lane" && quoted && !step.say.slice(1).startsWith(SCRATCH_PREFIX)) {
      problems.push(`Step ${step.number} must start its Say line with "${SCRATCH_PREFIX}".`);
    }
    if (step.wait && step.wait.toLowerCase() !== "none" && !DURATION.test(step.wait) && !CLOCK.test(step.wait)) {
      problems.push(`Step ${step.number} has a Wait that isn't none, a duration or a clock time.`);
    }
  }
  return problems;
}

function asE164(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}
