import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASSISTANT_PROFILES, CHATGPT_INSTRUCTIONS, CLAUDE_INSTRUCTIONS, runsSupplies, type CleanerAssistant } from "../src/cleaner-core/assistant";
import { listedChooseSupplies, listedSupplyFront } from "../src/hosted/supplies";
import { REPO_ROOT } from "./files";

/** docs/client-matrix.md says what the code does: which agents run which flows, and each agent's profile. */

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const AGENTS = Object.keys(ASSISTANT_PROFILES) as CleanerAssistant[];
const FLAGS = ["privatePages", "photoImages", "polledTask", "supplies"] as const;

/** The rows of the markdown table under a heading, as cells. */
function table(doc: string, heading: string): string[][] {
  const start = doc.indexOf(`## ${heading}\n`);
  if (start < 0) throw new Error(`no ${heading} section`);
  const lines = doc.slice(start).split("\n");
  const first = lines.findIndex((line) => line.startsWith("|"));
  const after = lines.slice(first);
  const end = after.findIndex((line) => !line.startsWith("|"));
  return after
    .slice(2, end < 0 ? undefined : end)
    .map((row) => row.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length > 1);
}

describe("the client matrix", () => {
  const doc = read("docs/client-matrix.md");

  it("names Grok Bot and Muse as the agents that run Supply Core, and only those", () => {
    expect(AGENTS.filter(runsSupplies).sort()).toEqual(["grok", "muse"]);
    for (const agent of AGENTS) {
      expect(listedSupplyFront(agent).length > 0, agent).toBe(runsSupplies(agent));
      expect(listedChooseSupplies(agent).length > 0, agent).toBe(runsSupplies(agent));
    }
    const flows = table(doc, "Property Core flows");
    expect(flows.find((row) => row[0] === "**Supply Core**")).toEqual(["**Supply Core**", "Yes", "Yes", "No", "No"]);
    expect(flows.find((row) => row[0] === "**Cleaner Core**")).toEqual(["**Cleaner Core**", "Yes", "Yes", "Yes", "Yes"]);
  });

  it("never tells a plain chat to set up or run Supply Core", () => {
    for (const [agent, instructions] of [["claude", CLAUDE_INSTRUCTIONS], ["chatgpt", CHATGPT_INSTRUCTIONS]] as const) {
      expect(instructions, agent).not.toMatch(/choose_supplies|Supply Core skill|check_cart/);
    }
  });

  it("lists every agent's profile exactly as the code has it", () => {
    const rows = table(doc, "Agent profiles");
    expect(rows.map((row) => row[0]).sort()).toEqual([...AGENTS].sort());
    for (const row of rows) {
      const profile = ASSISTANT_PROFILES[row[0] as CleanerAssistant];
      FLAGS.forEach((flag, i) => expect(row[i + 1], `${row[0]} ${flag}`).toBe(profile[flag] ? "yes" : "no"));
    }
  });

  it("says how a host on an agent that can't be woken hears urgent news", () => {
    expect(doc).toContain("## Urgent alerts on an agent that can't be woken");
    expect(doc).toMatch(/never depends on a text to the\s+host/);
  });
});
