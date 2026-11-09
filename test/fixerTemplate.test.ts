import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIXER_TOOL_NAMES } from "../src/fixer-core/tools";

/** Fixer Core's Grok bootstrap, Muse skill and docs: consistent with the real tools, the rules, and the tests the gates name. */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");

const BOOTSTRAP = "FIXER_CORE_BOOTSTRAP.md";
const SKILL = "muse-template/skills/fixer-core/SKILL.md";
const GATES = "docs/fixer-core-safety-gates.md";

/** The front answers these two for every flow; they are not in Fixer Core's own list. */
const FRONT_TOOLS = ["get_job_photos", "preview_schedule"];
/** Property Core, Cleaner Core and Supply Core tools the Fixer docs may name. */
const OTHER_TOOLS = ["get_state", "set_flows", "add_property", "report_low", "check_cart"];

const RULES = [
  "Contact only a pro the host approved.",
  "Never confirm a held time to the pro before the host's yes.",
  "Send the visit link only to the pro's own email or phone.",
  "Never pass a card number to Fixer Core.",
];

const CHECK_FIXES_KEYS = ["needsGo", "contactNext", "unconfirmed", "followUps", "held", "delays", "preferredAsk", "rotationAsk", "news"];

/** Every snake_case word in backticks that looks like a tool call. */
function toolsNamed(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) names.add(match[1]!);
  return [...names];
}

/** Words in backticks that aren't tools: fields, values and file names. */
const NOT_TOOLS = new Set(["no_reply"]);

describe("Fixer Core agent instructions", () => {
  for (const file of [BOOTSTRAP, SKILL]) {
    it(`${file} names only tools that exist, and every Fixer Core tool`, () => {
      const text = read(file);
      const known = new Set([...FIXER_TOOL_NAMES, ...FRONT_TOOLS, ...OTHER_TOOLS]);
      for (const name of toolsNamed(text)) {
        if (NOT_TOOLS.has(name)) continue;
        // Fields like prefersText are camelCase; snake_case in backticks must be a tool.
        expect(known.has(name), `${file}: ${name}`).toBe(true);
      }
      for (const tool of FIXER_TOOL_NAMES) expect(text, `${file} names ${tool}`).toContain(`\`${tool}\``);
    });

    it(`${file} carries the rules, check_fixes' keys, Google events, and the money line`, () => {
      const text = read(file).replace(/\s+/g, " ");
      for (const rule of RULES) expect(text, rule).toContain(rule);
      for (const key of CHECK_FIXES_KEYS) expect(text, key).toContain(key);
      expect(text).toContain("googleEvents");
      expect(text).toContain("No Core moves money.");
      expect(text).toContain("FIXER_CORE=1");
      expect(text).toContain("there is no partner network");
      expect(text).toContain("A locksmith job on the door-code lock defaults to the host letting them in.");
      expect(text).toContain("Reschedule, extend and cancel end the old link");
      expect(text).toContain("holds sentences in the booking question");
    });

    it(`${file} holds no door code, real phone number or card number`, () => {
      const text = read(file);
      expect(text).not.toMatch(/\b\d{13,19}\b/);
      expect(text).not.toMatch(/\+1\s?\(?[2-9]\d{2}\)?[\s-]?(?!555)\d{3}[\s-]?\d{4}/);
    });
  }

  it("the Muse template lists the skill, and the skill's front matter names it", () => {
    expect(existsSync(join(ROOT, SKILL))).toBe(true);
    expect(read("muse-template/template.json")).toContain("muse-template/skills/fixer-core");
    expect(read(SKILL)).toMatch(/^---\nname: fixer-core\n/);
  });

  it("the docs name only tools that exist and carry the rules word for word", () => {
    expect(read("docs/environment-variables.md")).toContain("`FIXER_CORE`");
    expect(read("README.md")).toContain("FIXER_CORE_BOOTSTRAP.md");
    expect(read("docs/client-matrix.md")).toContain("FIXER_CORE_BOOTSTRAP.md");
    expect(read("docs/hosted-multitenancy.md")).toContain("Fixer Core");
  });

  it("every test the safety gates name exists in its file", () => {
    const gates = read(GATES);
    const cited = [...gates.matchAll(/`(test\/[A-Za-z]+\.test\.ts)` \("((?:[^"\\]|\\.)*)"\)/g)];
    expect(cited.length).toBeGreaterThan(30);
    for (const [, file, name] of cited) {
      expect(existsSync(join(ROOT, file!)), file).toBe(true);
      expect(read(file!), `${file}: ${name}`).toContain(name!);
    }
  });
});
