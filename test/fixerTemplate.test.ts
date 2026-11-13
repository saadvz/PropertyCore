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
const ROUTINE = "fixer-template/routines/fixer-core-check.md";
const TASK = "muse-template/skills/fixer-core/references/fixer-core-task.md";

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

const CHECK_FIXES_KEYS = ["needsGo", "upkeepDue", "contactNext", "quotesReady", "unconfirmed", "followUps", "held", "delays", "preferredAsk", "rotationAsk", "news"];

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
    it(`${file} sets up the routine, and says a stay overlap is never booked and visit_link is refused for a text pro`, () => {
      const text = read(file).replace(/\s+/g, " ");
      expect(text).toMatch(/fixer-core-(check|task)\.md/);
      expect(text).toContain("confirm with the host that it's set");
      expect(text).toContain("overlaps a guest stay is never booked");
      expect(text).toContain("refused for a pro who gets the door code by text");
      expect(text).toContain("`confirmed: true`");
    });

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

  for (const file of [ROUTINE, TASK]) {
    it(`${file} names only tools that exist, runs check_fixes, and stops with Nothing new.`, () => {
      const text = read(file);
      const known = new Set([...FIXER_TOOL_NAMES, ...FRONT_TOOLS, ...OTHER_TOOLS]);
      for (const name of toolsNamed(text)) expect(known.has(name), `${file}: ${name}`).toBe(true);
      for (const name of text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []) expect(known.has(name), `${file}: ${name}`).toBe(true);
      expect(text).toContain("check_fixes");
      expect(text).toContain("googleEvents");
      expect(text).toContain("more than one property");
      expect(text).toContain("Nothing new.");
      expect(text).toContain("Never confirm a held time to the pro");
    });
  }

  it("both alerts routines call check_fixes on repairs.update, and the guide sets alerts up with save_repair_alerts", () => {
    for (const file of ["property-core-template/routines/property-core-alerts.md", "cleaner-template/routines/cleaner-core-alerts.md"]) {
      const text = read(file);
      expect(text, file).toContain("repairs.update");
      expect(text, file).toContain("check_fixes");
    }
    const shared = read("property-core-template/routines/property-core-alerts.md");
    expect(shared).toContain("cleaning.update");
    expect(shared).toContain("check_now");
    // Cleaner Core's steps for a cleaning wake-up include asking for the times (needsTimes): none is skipped.
    expect(shared).not.toContain("steps 2 to 9");
    expect(shared).toContain("needsTimes");
    const guide = read(BOOTSTRAP).replace(/\s+/g, " ");
    expect(guide).toContain("`save_repair_alerts`");
    expect(guide).toContain("property-core-template/routines/property-core-alerts.md");
  });

  it("the client matrix points at the real routine and task", () => {
    const matrix = read("docs/client-matrix.md");
    expect(matrix).toContain("fixer-template/routines/fixer-core-check.md");
    expect(matrix).toContain("muse-template/skills/fixer-core/references/fixer-core-task.md");
    expect(existsSync(join(ROOT, ROUTINE)) && existsSync(join(ROOT, TASK))).toBe(true);
  });

  it("the Muse template lists the skill, and the skill's front matter names it", () => {
    expect(existsSync(join(ROOT, SKILL))).toBe(true);
    expect(read("muse-template/template.json")).toContain("muse-template/skills/fixer-core");
    expect(read(SKILL)).toMatch(/^---\nname: fixer-core\n/);
  });

  it("the environment, README, matrix and hosting docs mention Fixer Core and its flag", () => {
    expect(read("docs/environment-variables.md")).toContain("`FIXER_CORE`");
    expect(read("README.md")).toContain("FIXER_CORE_BOOTSTRAP.md");
    expect(read("docs/client-matrix.md")).toContain("FIXER_CORE_BOOTSTRAP.md");
    expect(read("docs/hosted-multitenancy.md")).toContain("Fixer Core");
  });

  it("the gates hold the Alerts and Voicemail rows, and Cleaner Core's names a cleaner's voicemail", () => {
    const gates = read(GATES);
    expect(gates).toMatch(/^\| Alerts \|/m);
    expect(gates).toMatch(/^\| Voicemail \|/m);
    expect(gates).toContain("test/voiceCall.test.ts");
    expect(gates).toContain("test/fixerAlerts.test.ts");
    expect(read("docs/cleaner-core-safety-gates.md")).toContain("a cleaner's voicemail is a Cleaner Core note and nothing else");
  });

  it("every test the safety gates name exists in its file", () => {
    const gates = read(GATES);
    const cited = [...gates.matchAll(/`(test\/[A-Za-z]+\.test\.ts)` \("((?:[^"\\]|\\.)*)"\)/g)];
    const titled = (file: string, name: string) => new RegExp(`\\b(?:it|test)(?:\\.each\\([^)]*\\))?\\(\\s*(["'\`])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`).test(read(file));
    expect(cited.length).toBeGreaterThan(30);
    for (const [, file, name] of cited) {
      expect(existsSync(join(ROOT, file!)), file).toBe(true);
      expect(titled(file!, name!), `${file}: ${name}`).toBe(true);
    }
  });
});
