import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grokTestScriptProblems, parseGrokTestScript } from "../src/grok-tests/script";

const GOOD = `# Smoke

Property: 12 Scratch Lane

## 1. Outbox

Say: "On 12 Scratch Lane only: read the test texts out."
Expect: Grok lists the outbox lines.
Check: none
Wait: none
`;

describe("Grok test scripts", () => {
  it("parses a script", () => {
    const script = parseGrokTestScript(GOOD);
    expect(script.title).toBe("Smoke");
    expect(script.property).toBe("12 Scratch Lane");
    expect(script.steps).toHaveLength(1);
    expect(script.steps[0]).toMatchObject({
      number: 1,
      title: "Outbox",
      say: '"On 12 Scratch Lane only: read the test texts out."',
      expect: "Grok lists the outbox lines.",
      check: "none",
      wait: "none",
    });
    expect(grokTestScriptProblems(script)).toEqual([]);
  });

  it("reports a step with a missing part", () => {
    expect(grokTestScriptProblems(parseGrokTestScript(GOOD.replace("Wait: none\n", "")))).toEqual(["Step 1 has no Wait line."]);
  });

  it("reports a phone number that is not a 555 test number", () => {
    const script = parseGrokTestScript(GOOD.replace("read the test texts out", "text +1 201 867 5309"));
    expect(grokTestScriptProblems(script)).toEqual(["Step 1 uses a phone number that is not a 555 test number."]);
  });

  it("accepts a 555 test number", () => {
    const script = parseGrokTestScript(GOOD.replace("read the test texts out", "send a test text as the cleaner (+1 555 555 0101) that says YES"));
    expect(grokTestScriptProblems(script)).toEqual([]);
  });

  it("reports door code digits", () => {
    const script = parseGrokTestScript(GOOD.replace("read the test texts out", "set the door code to 9073"));
    expect(grokTestScriptProblems(script)).toEqual(["Step 1 has door code digits. Scripts never hold a code."]);
  });

  it("reports a Scratch step that does not name the property", () => {
    const script = parseGrokTestScript(GOOD.replace("On 12 Scratch Lane only: ", ""));
    expect(grokTestScriptProblems(script)).toEqual(['Step 1 must start its Say line with "On 12 Scratch Lane only:".']);
  });

  it("lets a card press skip the property prefix", () => {
    const script = parseGrokTestScript(GOOD.replace('"On 12 Scratch Lane only: read the test texts out."', "press A on the card"));
    expect(grokTestScriptProblems(script)).toEqual([]);
  });

  it("reports a missing or unknown property", () => {
    expect(grokTestScriptProblems(parseGrokTestScript(GOOD.replace("12 Scratch Lane\n", "Somewhere Else\n")))).toContain(
      "The Property line must be 12 Scratch Lane or Adélie Cottage.",
    );
  });

  it("reports a script with no steps", () => {
    expect(grokTestScriptProblems(parseGrokTestScript("# Empty\n\nProperty: Adélie Cottage\n"))).toEqual(["The script has no steps."]);
  });

  it("reports a Wait that is not none, a duration or a clock time", () => {
    const script = parseGrokTestScript(GOOD.replace("Wait: none", "Wait: until it feels right"));
    expect(grokTestScriptProblems(script)).toEqual(["Step 1 has a Wait that isn't none, a duration or a clock time."]);
  });

  it("every script in docs/grok-tests is well formed", () => {
    const dir = join(process.cwd(), "docs", "grok-tests");
    const files = readdirSync(dir).filter((name) => name.endsWith(".md") && name !== "README.md");
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const script = parseGrokTestScript(readFileSync(join(dir, name), "utf8"));
      expect({ name, problems: grokTestScriptProblems(script) }).toEqual({ name, problems: [] });
      expect(script.steps.length).toBeGreaterThan(0);
    }
  });
});
