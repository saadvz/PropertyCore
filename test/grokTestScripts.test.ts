import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grokTestScriptProblems, parseGrokTestScript } from "../src/grok-tests/script";

// Split up so no real number sits whole in the repo.
const REAL_NUMBER = ["+1", "212", "555", "1234"].join("");

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
    const script = parseGrokTestScript(GOOD.replace("read the test texts out", `text ${REAL_NUMBER}`));
    expect(grokTestScriptProblems(script)).toEqual(["Line 7 uses a phone number that is not a 555 test number."]);
  });

  it("reads a phone number spelled with double spaces", () => {
    const spaced = REAL_NUMBER.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "+1  $1  $2  $3");
    const script = parseGrokTestScript(GOOD.replace("read the test texts out", `text ${spaced}`));
    expect(grokTestScriptProblems(script)).toEqual(["Line 7 uses a phone number that is not a 555 test number."]);
  });

  it("checks phone numbers and door codes outside the steps too", () => {
    const script = parseGrokTestScript(`${GOOD}\n## Still by hand\n\n- Text ${REAL_NUMBER} the code 9073.\n`);
    expect(grokTestScriptProblems(script)).toEqual([
      "Line 14 uses a phone number that is not a 555 test number.",
      "Line 14 has door code digits. Scripts never hold a code.",
    ]);
  });

  it("accepts a 555 test number", () => {
    const script = parseGrokTestScript(GOOD.replace("read the test texts out", "send a test text as the cleaner (+1 555 555 0101) that says YES"));
    expect(grokTestScriptProblems(script)).toEqual([]);
  });

  it("reports door code digits", () => {
    const script = parseGrokTestScript(GOOD.replace("read the test texts out", "set the door code to 9073"));
    expect(grokTestScriptProblems(script)).toEqual(["Line 7 has door code digits. Scripts never hold a code."]);
  });

  it.each([
    ["a long gap", "set the door code for the side entrance by the garage to 9073"],
    ["codes", "add codes 9073 and 4410"],
    ["PIN", "set the PIN to 9073"],
    ["digits first", "use 9073 as the code"],
    ["spaced digits", "set the code to 9 0 7 3"],
    ["dashed digits", "set the code to 90-73"],
  ])("reports door code digits with %s", (_name, words) => {
    const script = parseGrokTestScript(GOOD.replace("read the test texts out", words));
    expect(grokTestScriptProblems(script)).toEqual(["Line 7 has door code digits. Scripts never hold a code."]);
  });

  it("leaves times and short numbers next to a code alone", () => {
    const script = parseGrokTestScript(GOOD.replace("read the test texts out", "give the cleaner a code from 10:00 AM to 4:00 PM on Oct 18"));
    expect(grokTestScriptProblems(script)).toEqual([]);
  });

  it("reports a Scratch step that does not name the property", () => {
    const script = parseGrokTestScript(GOOD.replace("On 12 Scratch Lane only: ", ""));
    expect(grokTestScriptProblems(script)).toEqual(['Step 1 must start its Say line with "On 12 Scratch Lane only:".']);
  });

  it("lets a card press skip the property prefix", () => {
    const script = parseGrokTestScript(GOOD.replace('"On 12 Scratch Lane only: read the test texts out."', "press A on the card"));
    expect(grokTestScriptProblems(script)).toEqual([]);
  });

  it("accepts curly quotes and checks the Scratch prefix inside them", () => {
    const curly = parseGrokTestScript(GOOD.replace('"On 12 Scratch Lane only: read the test texts out."', "\u201cOn 12 Scratch Lane only: read the test texts out.\u201d"));
    expect(grokTestScriptProblems(curly)).toEqual([]);
    const missing = parseGrokTestScript(GOOD.replace('"On 12 Scratch Lane only: read the test texts out."', "\u201cread the test texts out.\u201d"));
    expect(grokTestScriptProblems(missing)).toEqual(['Step 1 must start its Say line with "On 12 Scratch Lane only:".']);
  });

  it("accepts an action in Chrome that starts with in", () => {
    const script = parseGrokTestScript(GOOD.replace('"On 12 Scratch Lane only: read the test texts out."', "in the Seam console, unlock the Front door"));
    expect(grokTestScriptProblems(script)).toEqual([]);
  });

  it("reports a Say line of no known shape", () => {
    const script = parseGrokTestScript(GOOD.replace('"On 12 Scratch Lane only: read the test texts out."', "On 12 Scratch Lane only: read the test texts out."));
    expect(grokTestScriptProblems(script)).toEqual([
      'Step 1 has a Say line that isn\'t quoted, "press <letter> on the card", or an action starting with "in".',
    ]);
  });

  it("reports a step heading in the wrong shape instead of dropping its steps", () => {
    const script = parseGrokTestScript(`${GOOD}\n## 2 Second\n\nSay: "On 12 Scratch Lane only: reset Scratch."\nExpect: done\nCheck: none\nWait: none\n`);
    expect(grokTestScriptProblems(script)).toEqual(['Line 12 looks like a step but isn\'t "## <n>. <title>".']);
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

  it.each(["15 minutes", "about 2 hours", "5:15 PM", "9 AM"])("accepts the Wait %s", (wait) => {
    expect(grokTestScriptProblems(parseGrokTestScript(GOOD.replace("Wait: none", `Wait: ${wait}`)))).toEqual([]);
  });

  it.each(["15 minutes or so", "5:15 PM tomorrow"])("reports a Wait with words after it: %s", (wait) => {
    expect(grokTestScriptProblems(parseGrokTestScript(GOOD.replace("Wait: none", `Wait: ${wait}`)))).toEqual([
      "Step 1 has a Wait that isn't none, a duration or a clock time.",
    ]);
  });

  it("a script Claude wrote for a run is well formed (GROK_TEST_SCRIPT names its path)", () => {
    const path = process.env.GROK_TEST_SCRIPT;
    if (!path) return;
    const script = parseGrokTestScript(readFileSync(path, "utf8"));
    expect({ path, problems: grokTestScriptProblems(script) }).toEqual({ path, problems: [] });
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
