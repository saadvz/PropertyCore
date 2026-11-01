import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalRepoUrl, checkRepositorySource, normalizeRepoUrl } from "../src/install/repoSource";

/** GROK_BOOTSTRAP.md is the one entry point for a blank Grok Bot: short, safe, and pointing at the skill. */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const BOOTSTRAP = "GROK_BOOTSTRAP.md";

describe("GROK_BOOTSTRAP.md", () => {
  const text = existsSync(new URL(`../${BOOTSTRAP}`, import.meta.url)) ? read(BOOTSTRAP) : "";

  it("exists at the repository root and gives the self-discovery sequence", () => {
    expect(text.length).toBeGreaterThan(0);
    const order = ["Clone the repository", "npm run bootstrap:grok", ".grok/skills/install-tour-core/SKILL.md", "get_state", "infrastructure ready"];
    const positions = order.map((s) => text.indexOf(s));
    for (const [i, p] of positions.entries()) expect(p, order[i]).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toContain("`.grok/skills/`");
    // The setup order: each step after the one before, and Drive recommended over the local demo.
    const route = text.slice(text.indexOf("visitor texting →"));
    const steps = ["visitor texting", "Google Drive", "property", "alerts", "readiness check", "practice tour", "publish"];
    const at = steps.map((step) => route.indexOf(step));
    for (const [i, p] of at.entries()) expect(p, steps[i]).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(route).toMatch(/local demo only if they decline/);
    expect(text).toMatch(/Never ask the operator "what next\?" while Tour Core has a next step/);
    expect(text).toMatch(/don't offer parallel or optional paths while required setup is incomplete/);
    expect(text).toMatch(/move fully to the property/);
    expect(text).toMatch(/Keep infrastructure out of the conversation/);
    expect(text).toMatch(/explicit yes/);
  });

  it("says Tour Core's tools are authoritative, secrets never go in chat, and people act in secure setup", () => {
    expect(text).toMatch(/installation tools are authoritative/);
    expect(text).toMatch(/Never request secrets in chat/);
    expect(text).toMatch(/secure setup page/);
    expect(text).toMatch(/Never ask the operator to run a command/);
    expect(text).toMatch(/No\s+attachments are needed/);
    expect(text).toMatch(/Don't continue with an unexpected\s+repository/);
  });

  it("stays a short entry point and doesn't copy the Install Tour Core skill", () => {
    const skill = read(".grok/skills/install-tour-core/SKILL.md");
    expect(text.split("\n").length).toBeLessThan(80);
    expect(text.length).toBeLessThan(skill.length / 2);
    // No run of 12 words appears in both.
    const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
    const skillText = ` ${words(skill).join(" ")} `;
    const w = words(text);
    for (let i = 0; i + 12 <= w.length; i++) {
      const run = w.slice(i, i + 12).join(" ");
      expect(skillText.includes(` ${run} `), run).toBe(false);
    }
  });
});

describe("fresh-bot bootstrap documentation", () => {
  it("the manual test sends one prompt with only the repository URL and attaches nothing", () => {
    const doc = read("docs/grok-manual-test.md");
    const section = doc.slice(doc.indexOf("## B."), doc.indexOf("## Connection and operator demo"));
    expect(section).toMatch(/Do \*\*not\*\* attach/);
    const prompt = section
      .split("\n")
      .filter((l) => l.startsWith(">"))
      .join("\n");
    expect(prompt).toContain("https://github.com/&lt;owner&gt;/&lt;repo&gt;");
    expect(prompt).toContain("GROK_BOOTSTRAP.md");
    expect(prompt).toContain("Never ask me to paste secrets");
    expect(prompt).not.toMatch(/attach/i);
    expect(section).toMatch(/Pass = no attached files/);
    expect(section).toMatch(/final template experience/i);
  });

  it("the Install skill doesn't require attachments", () => {
    const skill = read(".grok/skills/install-tour-core/SKILL.md");
    expect(skill).toMatch(/No attached files/);
    expect(skill).toContain("GROK_BOOTSTRAP.md");
  });
});

describe("hosted URL wins over a clone request", () => {
  const HOSTED = "https://tourcore-production-8b80.up.railway.app";
  const bootstrap = read(BOOTSTRAP);
  const skill = read(".grok/skills/install-tour-core/SKILL.md");
  const manual = read("docs/grok-manual-test.md");
  const template = JSON.parse(read("grok-template/template.json")) as { hostedTourCoreUrl: string };
  const prompt = manual
    .slice(manual.indexOf("## B."), manual.indexOf("## Connection and operator demo"))
    .split("\n")
    .filter((line) => line.startsWith(">"))
    .map((line) => line.replace(/^>\s?/, ""))
    .join("\n");
  const hostedSkill = skill.slice(skill.indexOf("When the deployment is HOSTED"), skill.indexOf("Otherwise the operator explicitly chose local"));
  const localSkill = skill.slice(skill.indexOf("Otherwise the operator explicitly chose local"), skill.indexOf("### Phase 2:"));

  it("the standard bootstrap prompt selects the hosted service when hostedTourCoreUrl is set", () => {
    expect(template.hostedTourCoreUrl).toBe(HOSTED);
    expect(prompt).toMatch(/clone the repository only/);
    expect(prompt).toMatch(/use that service rather than starting Tour Core locally/);
    const decision = bootstrap.indexOf("Decide before you start anything");
    const forbid = bootstrap.indexOf("Do not run `npm run bootstrap:grok`");
    const localRun = bootstrap.indexOf("In `tour-core`, run `npm run bootstrap:grok`");
    expect(decision).toBeGreaterThan(-1);
    expect(forbid).toBeGreaterThan(decision);
    expect(localRun).toBeGreaterThan(forbid);
    expect(bootstrap).toMatch(/does not mean Tour Core should run on your computer/);
    expect(bootstrap).toMatch(/"Clone the repository" is not\s+an explicit local or self-host request/);
    expect(bootstrap).toMatch(/do not\s+start cloudflared, and do not open a Quick Tunnel/);
    expect(bootstrap).toMatch(/Do not clone a runtime/);
    expect(bootstrap).toMatch(/Do\s+not store operational records on your computer/);
  });

  it("hosted instructions use Grok's Drive connector and never Tour Core's Google app", () => {
    expect(hostedSkill).toMatch(/deployment is HOSTED/);
    expect(hostedSkill).toMatch(/You may clone the repository\s+to read instructions and skills/);
    expect(hostedSkill).toMatch(/Do not run\s+`npm run bootstrap:grok`/);
    expect(hostedSkill).toMatch(/Never start cloudflared/);
    expect(hostedSkill).toMatch(/Quick Tunnel/);
    expect(hostedSkill).toMatch(/backup_records/);
    expect(hostedSkill).toMatch(/built-in\s+connector for portable backups/);
    expect(hostedSkill).toMatch(/Do not say\s+Tour Core's Google app is not configured/);
    expect(hostedSkill).toMatch(/do not offer to keep records\s+on your computer/);
    expect(hostedSkill).not.toMatch(/Offer to keep records on this computer/);
    expect(hostedSkill).not.toMatch(/begin_google_drive_connect/);
    expect(skill).toMatch(/There is no discretion/);
    expect(skill).toMatch(/Do not choose a local install because the\s+operator asked you to clone/);
  });

  it("keeps the hosted URL in the template only, and hosting words out of what the operator hears", () => {
    const both = `${skill}\n${bootstrap}`;
    expect(both).toContain("hostedTourCoreUrl");
    expect(both).not.toMatch(/up\.railway\.app/);
    expect(skill).toMatch(/skip a local Node process/);
    expect(skill).toMatch(/only works while your\s+computer is on/);
    expect(skill).toMatch(/connect →|Connect to that service/);
    const sequence = skill.slice(skill.indexOf("## Sequence"), skill.indexOf("## Validate"));
    expect(sequence).toMatch(/Sendblue|Visitor texting/);
    expect(sequence).toMatch(/Google Drive/);
    expect(sequence).toMatch(/first property/);
    const quoted = skill.split("\n").filter((line) => line.startsWith(">")).join("\n");
    expect(quoted).not.toMatch(/\brailway\b|\bcloudflared\b|\bRAILWAY_|\btrycloudflare\b|only works while/i);
    expect(quoted).toMatch(/only ask when I need an approval/);
    expect(quoted).toMatch(/pairing code/);
  });

  it("an explicit local or self-host request still uses the open-source runtime", () => {
    expect(bootstrap).toMatch(/explicitly requests a local demo, self-hosting,\s+or an open-source local deployment/);
    expect(localSkill).toMatch(/npm run bootstrap:grok/);
    expect(localSkill).toMatch(/cloudflared/);
    expect(skill).toMatch(/open-source path, when the next step is Google Drive's own approval/);
    expect(skill).toMatch(/ops connector/);
    expect(skill).not.toMatch(/begin_google_drive_connect/);
  });
});

describe("canonical repository", () => {
  it("normalizes https and ssh forms of the same repository", () => {
    expect(normalizeRepoUrl("https://github.com/Owner/Repo.git/")).toBe("github.com/owner/repo");
    expect(normalizeRepoUrl("git@github.com:Owner/Repo.git")).toBe("github.com/owner/repo");
    expect(normalizeRepoUrl("")).toBeUndefined();
    expect(normalizeRepoUrl("not a url")).toBeUndefined();
  });

  it("refuses a clone from another repository; accepts a match or an unrecorded canonical", () => {
    expect(checkRepositorySource({ canonical: "https://github.com/owner/repo", actual: "git@github.com:Owner/Repo.git" }).ok).toBe(true);
    expect(checkRepositorySource({ canonical: undefined, actual: "https://github.com/else/where" }).ok).toBe(true);
    const mismatch = checkRepositorySource({ canonical: "https://github.com/owner/repo", actual: "https://github.com/else/where" });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.message).toContain("Not starting an unexpected repository");
  });

  it("is recorded in the template manifest, with GROK_BOOTSTRAP.md as its entry point", () => {
    const manifest = JSON.parse(read("grok-template/template.json"));
    expect(manifest.repository.bootstrap).toBe("GROK_BOOTSTRAP.md");
    const url = canonicalRepoUrl(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    expect(url).toBe(manifest.repository.url || undefined);
    if (url) expect(normalizeRepoUrl(url)).toMatch(/^github\.com\/[^/]+\/[^/]+$/);
  });
});
