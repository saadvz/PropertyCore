import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OPERATOR_TOOL_NAMES } from "../src/operator/tools";
import { LANDLORD_CORE_TOOLS, OPS_TOOL_NAMES, QA_TOOL_NAMES } from "../src/mcp/scopes";
import { filesUnder } from "./files";

/** The Grok template and skills are code: versioned, consistent with the tool contract, and free of secrets. */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILLS = join(ROOT, ".grok", "skills");
const TEMPLATE = join(ROOT, "grok-template");
const SKILL_NAMES = ["install-tour-core", "setup-property", "map-route", "run-readiness-check", "simulate-tour", "work-exception", "export-audit", "backup-tour-core"];

function frontmatter(text: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, "\n"))?.[1];
  if (!block) return {};
  return Object.fromEntries(block.split("\n").filter((l) => /^[a-z-]+:/.test(l)).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
}

describe("Grok skills", () => {
  it("are Install Tour Core plus the seven operator skills, in SKILL.md format", () => {
    expect(readdirSync(SKILLS).sort()).toEqual([...SKILL_NAMES].sort());
    for (const name of SKILL_NAMES) {
      const text = readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");
      const meta = frontmatter(text);
      expect(meta.name, name).toBe(name);
      expect(meta.description?.length, name).toBeGreaterThan(40);
      expect(meta["user-invocable"], name).toBe("true");
      expect(meta["when-to-use"], name).toBeTruthy();
      // PRD: each skill defines required inputs, allowed tools, expected output and a stop condition.
      for (const section of ["## When to use", "## Required inputs and access", "## Sequence", "## Validate", "## Return", "## Requires approval", "## Stop when"]) {
        expect(text, `${name} is missing "${section}"`).toContain(section);
      }
    }
  });

  it("name only landlord tools, and together they cover those 21", () => {
    const landlord = new Set<string>([...LANDLORD_CORE_TOOLS, "reset_hosted_demo"]);
    const used = new Set<string>();
    for (const name of SKILL_NAMES) {
      const tools = frontmatter(readFileSync(join(SKILLS, name, "SKILL.md"), "utf8"))["allowed-tools"]!.split(/\s+/);
      if (name === "simulate-tour") {
        expect(tools.sort()).toEqual([...QA_TOOL_NAMES].sort());
        continue;
      }
      for (const t of tools) {
        expect(landlord, `${name} lists ${t}`).toContain(t);
        expect(OPERATOR_TOOL_NAMES).toContain(t);
        used.add(t);
      }
    }
    for (const tool of LANDLORD_CORE_TOOLS) expect(used, tool).toContain(tool);
  });
});

/**
 * SHA-256 of the approved grok-template/SETUP_PROMPT.md. Change the prompt only on purpose.
 * CI also diffs the file against origin/master; this pin works offline and on master pushes.
 */
const SETUP_PROMPT_SHA256 = "47def95ba56823cb821b631c974f765fc3a59cfecd62e86d6c0dfdcf86a55b48";

describe("Grok template package", () => {
  it("keeps SETUP_PROMPT.md byte-identical to the approved prompt", () => {
    const current = readFileSync(join(TEMPLATE, "SETUP_PROMPT.md"));
    expect(createHash("sha256").update(current).digest("hex")).toBe(SETUP_PROMPT_SHA256);
  });

  it("lists the landlord, ops, and QA tools once each, each under its own connector, in the integration notes", () => {
    const doc = readFileSync(join(TEMPLATE, "integrations", "tour-core-tools.md"), "utf8");
    const rows = (text: string) => [...text.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]!);
    const landlordTable = doc.slice(doc.indexOf("## Landlord connector"), doc.indexOf("## Ops connector"));
    const opsTable = doc.slice(doc.indexOf("## Ops connector"), doc.indexOf("## QA connector"));
    const qaTable = doc.slice(doc.indexOf("## QA connector"));
    expect(rows(landlordTable)).toEqual([...LANDLORD_CORE_TOOLS]);
    expect(rows(opsTable)).toEqual([...OPS_TOOL_NAMES]);
    expect(rows(qaTable)).toEqual([...QA_TOOL_NAMES]);
    // No row outside those three tables, and so no tool listed twice.
    expect(rows(doc)).toEqual([...LANDLORD_CORE_TOOLS, ...OPS_TOOL_NAMES, ...QA_TOOL_NAMES]);
    expect(landlordTable).toContain("`reset_hosted_demo`");
    const healthLine = opsTable.split("\n").find((line) => line.includes("`check_runtime_health`")) ?? "";
    expect(healthLine).toMatch(/^\| `check_runtime_health` \| read \| When records aren't on permanent storage:/);
  });

  it("has a manifest whose files exist, with the operator-updates routine and the PRD's starting prompts", () => {
    const manifest = JSON.parse(readFileSync(join(TEMPLATE, "template.json"), "utf8"));
    for (const f of [manifest.profile, ...manifest.context, ...manifest.skills, ...manifest.examples, ...manifest.integrations.map((i: { doc: string }) => i.doc), ...manifest.routines.map((r: { doc: string }) => r.doc)]) {
      expect(existsSync(join(TEMPLATE, f)), f).toBe(true);
    }
    expect(manifest.routines).toEqual([expect.objectContaining({ name: "Tour Core Operator Updates", trigger: "authenticated-webhook", credentialsTravelWithTemplate: false })]);
    for (const t of manifest.routines[0].allowedTools) expect(OPERATOR_TOOL_NAMES).toContain(t);
    expect(manifest.distribution).toBe("team");
    expect(manifest.integrations[0].travelsWithTemplate).toBe(false);
    const profile = readFileSync(join(TEMPLATE, "bot-profile.md"), "utf8");
    for (const prompt of manifest.suggestedPrompts) expect(profile).toContain(`- ${prompt}`);
    expect(profile).toContain("Configure properties, test self-guided routes, monitor live tours, resolve\nexceptions, and export tour records.".replace(/\n/g, profile.includes("\r\n") ? "\r\n" : "\n"));
  });

  it("contains no secrets, credentials or real contact details", () => {
    // The one secrets scan for the Grok-facing docs: the bootstrap, the template, and the skills.
    const all = [join(ROOT, "GROK_BOOTSTRAP.md"), ...filesUnder(TEMPLATE), ...filesUnder(SKILLS)].map((f) => ({ f, text: readFileSync(f, "utf8") }));
    const envValues = existsSync(join(ROOT, ".env"))
      ? readFileSync(join(ROOT, ".env"), "utf8")
          .split(/\r?\n/)
          .map((l) => /^[A-Z_]+=(.+)$/.exec(l.trim())?.[1]?.trim())
          .filter((v): v is string => !!v && v.length >= 8)
      : [];
    for (const { f, text } of all) {
      expect(text, f).not.toMatch(/Bearer [A-Za-z0-9_-]{20,}/);
      expect(text, f).not.toMatch(/\b(sk|xai|sb)[-_][A-Za-z0-9]{16,}/);
      expect(text, f).not.toMatch(/[A-Z_]+(KEY|SECRET|TOKEN)\s*=\s*\S/);
      expect(text, f).not.toMatch(/[A-Za-z0-9._%+-]+@(?!example\.com)[A-Za-z0-9.-]+\.[a-z]{2,}/);
      // Google access tokens, refresh tokens, and Drive folder ids.
      expect(text, f).not.toMatch(/ya29\./);
      expect(text, f).not.toMatch(/1\/\/[A-Za-z0-9_-]{10,}/);
      expect(text, f).not.toMatch(/folder_[A-Za-z0-9]{10,}/);
      // Phone numbers only from the fictional 555-01xx range.
      for (const m of text.matchAll(/\+?1?[\s.-]?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{2})(\d{2}|xx)/g)) {
        expect(`${m[1]}-${m[2]}-${m[3]}`, `${f}: ${m[0]}`).toMatch(/^\d{3}-555-01$|^555-01\d-\d{2}$/);
      }
      for (const v of envValues) expect(text.includes(v), `${f} contains a value from .env`).toBe(false);
    }
  });
});

describe("landlord docs keep sample phone numbers out", () => {
  it("has no formatted phone number outside the grok-template examples", () => {
    const roots = [join(ROOT, "README.md"), join(ROOT, "docs", "tour-core", "README.md"), join(ROOT, "GROK_BOOTSTRAP.md"), join(ROOT, ".grok"), TEMPLATE];
    const paths = roots.flatMap((p) => (statSync(p).isDirectory() ? filesUnder(p) : [p]));
    const phone = /\(\d{3}\) \d{3}-\d{4}/;
    for (const path of paths) {
      if (path.includes(`${join("grok-template", "examples")}`)) continue;
      expect(readFileSync(path, "utf8"), path).not.toMatch(phone);
    }
  });
});
