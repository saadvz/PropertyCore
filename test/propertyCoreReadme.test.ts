import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./files";

/**
 * saadvz/TourCore#177: a new reader, or an agent, lands on Property Core first. Tour Core is parked
 * in docs/tour-core/ and stays reachable.
 */

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const README = "README.md";
const PARKED = "docs/tour-core/README.md";
const ENV = "docs/environment-variables.md";

/** Every relative link in a markdown file, with its #anchor if it has one. Web, mail and same-page links are left out. */
function relativeTargets(rel: string): string[] {
  const text = read(rel).replace(/```[\s\S]*?```/g, "");
  const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);
  return targets.filter((t) => !/^(https?:|mailto:|#)/.test(t));
}

/** Every relative link target in a markdown file, without its #anchor. */
const relativeLinks = (rel: string) => relativeTargets(rel).map((t) => t.split("#")[0]!);

/** GitHub's anchor for each heading in a markdown file. */
function anchors(rel: string): Set<string> {
  const text = read(rel).replace(/```[\s\S]*?```/g, "");
  const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");
  return new Set([...text.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]!)));
}

describe("the README", () => {
  const readme = read(README);

  it("opens on Property Core for short-term rental hosts", () => {
    expect(readme.split("\n")[0]).toBe("# Property Core");
    const opening = readme.slice(0, readme.indexOf("\n## "));
    expect(opening).toMatch(/short-term rental/);
    expect(opening).not.toMatch(/Tour Core|touring|self-touring/i);
  });

  it("names the three flows and the two supported agents", () => {
    for (const name of ["Cleaner Core", "Supply Core", "Fixer Core", "Grok Bot", "Muse"]) expect(readme).toContain(name);
  });

  it("links each flow's safety gates and setup guide", () => {
    const links = relativeLinks(README);
    for (const doc of [
      "docs/cleaner-core-safety-gates.md",
      "docs/supply-core-safety-gates.md",
      "CLEANER_CORE_BOOTSTRAP.md",
      "SUPPLY_CORE_BOOTSTRAP.md",
      "cleaner-template/",
      "supply-template/",
      "muse-template/",
    ]) {
      expect(links, doc).toContain(doc);
    }
  });

  it("says touring is parked and links to the Tour Core docs", () => {
    expect(readme).toMatch(/parked/i);
    expect(relativeLinks(README)).toContain(PARKED);
  });

  it("does not name the lock provider", () => {
    expect(readme).not.toMatch(/\bdurin\b/i);
  });
});

describe("the parked Tour Core docs", () => {
  it("keep the Tour Core README, marked parked, with the brochure beside it", () => {
    const parked = read(PARKED);
    expect(parked.split("\n")[0]).toBe("# Tour Core (parked)");
    expect(parked.slice(0, 600)).toMatch(/parked/i);
    expect(existsSync(join(REPO_ROOT, "docs/tour-core/tour_core.pdf"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "tour_core.pdf"))).toBe(false);
  });
});

describe("links into the moved docs", () => {
  for (const rel of [README, PARKED, ENV, "AGENTS.md", "grok-template/README.md", "docs/grok-template-setup.md", "docs/grok-manual-test.md"]) {
    it(`${rel} links only to files and headings that exist`, () => {
      const missing = relativeTargets(rel).filter((target) => {
        const [path, anchor] = target.split("#") as [string, string | undefined];
        const file = join(dirname(rel), path);
        if (!existsSync(join(REPO_ROOT, file))) return true;
        return anchor !== undefined && file.endsWith(".md") && !anchors(file).has(anchor);
      });
      expect(missing).toEqual([]);
    });
  }
});

describe("the package and the plugin marketplace", () => {
  it("describe Property Core, not touring", () => {
    const pkg = JSON.parse(read("package.json")) as { description: string };
    expect(pkg.description).toMatch(/Property Core/);
    expect(pkg.description).not.toMatch(/touring|\bdurin\b/i);
    const market = JSON.parse(read(".claude-plugin/marketplace.json")) as { owner: { name: string }; metadata: { description: string } };
    expect(market.owner.name).toBe("Property Core");
    expect(market.metadata.description).toMatch(/Property Core/);
  });
});
