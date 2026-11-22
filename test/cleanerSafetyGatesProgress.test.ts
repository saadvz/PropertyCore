import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The safety gates for findings #6 and #8: every row is in docs/cleaner-core-safety-gates.md, and every
 * test a row names as its proof exists in the file it names, so a renamed or deleted test fails here.
 */

const GATES = readFileSync("docs/cleaner-core-safety-gates.md", "utf8");
const SECTION = GATES.split("## The host hears progress, and moved cleanings (findings #6, #8)")[1]?.split("\n## ")[0] ?? "";
const ROWS = ["Progress told once", "Promise matches the wake", "Move needs the host's yes", "Inside the gap", "The cleaner's own YES", "Code never early", "Records follow"];

describe("safety gates for the host's progress notes and moved cleanings", () => {
  it("lists every row", () => {
    for (const row of ROWS) expect(SECTION).toContain(`| ${row} |`);
  });

  it("names only tests that exist", () => {
    const proofs = SECTION.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Gate") && !line.startsWith("| ---"));
    expect(proofs.length).toBe(ROWS.length);
    let named = 0;
    for (const line of proofs) {
      const proof = line.split(" | ").at(-1) ?? "";
      for (const part of proof.split(/\), |`, /)) {
        const file = /`(test\/[^`]+\.test\.ts)`/.exec(part)?.[1];
        if (!file) continue;
        const source = readFileSync(file, "utf8");
        for (const [, title] of part.matchAll(/"([^"]+)"/g)) {
          expect(source, `${file} has no test "${title}"`).toContain(`it("${title}"`);
          named += 1;
        }
      }
    }
    expect(named).toBeGreaterThanOrEqual(ROWS.length);
  });
});
