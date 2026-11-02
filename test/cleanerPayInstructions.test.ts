import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHATGPT_INSTRUCTIONS, CHATGPT_TASK_PROMPT, CLAUDE_INSTRUCTIONS, CLAUDE_TASK_PROMPT, MUSE_INSTRUCTIONS, MUSE_TASK_PROMPT } from "../src/cleaner-core/assistant";
import { GROK_INSTRUCTIONS } from "../src/cleaner-core/mcp";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const INSTRUCTIONS: Record<string, string> = {
  grok: GROK_INSTRUCTIONS,
  claude: CLAUDE_INSTRUCTIONS,
  chatgpt: CHATGPT_INSTRUCTIONS,
  muse: MUSE_INSTRUCTIONS,
};

const TASK_PROMPTS: Record<string, string> = {
  claude: CLAUDE_TASK_PROMPT,
  chatgpt: CHATGPT_TASK_PROMPT,
  muse: MUSE_TASK_PROMPT,
};

const GROK_FILES = ["CLEANER_CORE_BOOTSTRAP.md", "cleaner-template/routines/cleaner-core-check.md", "cleaner-template/routines/cleaner-core-alerts.md", "cleaner-template/bot-profile.md"];

describe("Every assistant knows the payments flow", () => {
  for (const [name, text] of Object.entries(INSTRUCTIONS)) {
    it(`${name}: sets up payments, posts payDue links as given, and marks paid only on the host's word`, () => {
      expect(text).toContain("save_preferences, save_payments");
      expect(text).toContain("payDue");
      expect(text).toContain("exactly as returned");
      expect(text).toContain("mark_paid");
      expect(text).toContain("Never build or change a Venmo link");
      expect(text).toContain("never send a pay link to the cleaner");
    });
  }

  for (const [name, prompt] of Object.entries(TASK_PROMPTS)) {
    it(`${name}: the scheduled run posts payDue and never marks paid on its own`, () => {
      expect(prompt).toContain("If the reply has payDue");
      expect(prompt).toMatch(/Call confirm_times, mark_guests_left, mark_paid,/);
    });
  }

  for (const path of GROK_FILES) {
    it(`${path} covers payDue and mark_paid`, () => {
      const text = read(path);
      expect(text).toContain("payDue");
      expect(text).toContain("mark_paid");
    });
  }

  it("the bootstrap puts the Payments step in the setup order", () => {
    expect(read("CLEANER_CORE_BOOTSTRAP.md")).toContain("save_payments");
  });

  it("the safety gates list the payments rows", () => {
    const gates = read("docs/cleaner-core-safety-gates.md");
    for (const row of ["| Pay link |", "| Owed once |", "| Checklist YES |"]) expect(gates).toContain(row);
  });
});
