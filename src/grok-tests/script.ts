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
}

const PARTS = ["say", "expect", "check", "wait"] as const;
type Part = (typeof PARTS)[number];
const PART_LABEL: Record<Part, string> = { say: "Say", expect: "Expect", check: "Check", wait: "Wait" };

export const SCRATCH_PREFIX = "On 12 Scratch Lane only:";

/** A US number in any usual spelling: +1 555 555 0101, (555) 555-0101, 5555550101. */
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;
/** "code" followed closely by four or more digits. Phone numbers are taken out first. */
const DOOR_CODE = /code\b[^\n]{0,20}?(?<!\d)\d{4,}/i;
const DURATION = /^(?:about )?\d+ (?:seconds?|minutes?|hours?|days?)\b/i;
const CLOCK = /^\d{1,2}(?::\d{2})? ?(?:AM|PM)\b/i;

export function parseGrokTestScript(markdown: string): GrokTestScript {
  let title = "";
  let property: GrokTestProperty | undefined;
  let propertyLine: string | undefined;
  const steps: GrokTestStep[] = [];
  let current: GrokTestStep | undefined;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^## (\d+)\. (.+)$/.exec(line);
    if (heading) {
      current = { number: Number(heading[1]), title: heading[2]!.trim(), say: "", expect: "", check: "", wait: "" };
      steps.push(current);
      continue;
    }
    if (line.startsWith("## ")) {
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
  return { title, property, steps };
}

export function grokTestScriptProblems(script: GrokTestScript): string[] {
  const problems: string[] = [];
  if (!script.property) problems.push(`The Property line must be ${GROK_TEST_PROPERTIES.join(" or ")}.`);
  if (script.steps.length === 0) problems.push("The script has no steps.");
  for (const step of script.steps) {
    const missing = PARTS.filter((part) => step[part] === "");
    for (const part of missing) problems.push(`Step ${step.number} has no ${PART_LABEL[part]} line.`);
    const text = PARTS.map((part) => step[part]).join("\n");
    const phones = text.match(PHONE) ?? [];
    if (phones.some((phone) => !isScratchTestNumber(asE164(phone)))) {
      problems.push(`Step ${step.number} uses a phone number that is not a 555 test number.`);
    }
    if (DOOR_CODE.test(text.replace(PHONE, ""))) problems.push(`Step ${step.number} has door code digits. Scripts never hold a code.`);
    const quoted = step.say.startsWith('"');
    if (script.property === "12 Scratch Lane" && quoted && !step.say.startsWith(`"${SCRATCH_PREFIX}`)) {
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
