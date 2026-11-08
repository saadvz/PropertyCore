import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder, REPO_ROOT } from "./files";

/**
 * saadvz/PropertyCore#178: one documented way to start. property-core-template/ is the entry for every
 * agent, Grok Bot and Muse first, and it offers Cleaner Core and Supply Core. The older per-flow
 * folders stay as the guides the agents read, but none of them offers a start of its own.
 */

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const json = <T>(rel: string) => JSON.parse(read(rel)) as T;
const ENTRY = "property-core-template";
const REPO = "https://github.com/saadvz/PropertyCore";
const TEMPLATE_LINK = "https://x.ai/bot/rfmREJxrfqNuTiOs2VqYQ";

/**
 * SHA-256 (base64) of each entry prompt with LF line endings. Change a prompt only on purpose.
 * Base64, so a hex digest never holds a run of digits the door-code scan mistakes for a code.
 */
const PROMPT_PINS: Record<string, string> = {
  [`${ENTRY}/SETUP_PROMPT.md`]: "Z8aV4bPoo8PSq6SEjSo+awz9NWuDS61EJFI6+jalgeE=",
  [`${ENTRY}/muse/SETUP_PROMPT.md`]: "DrYvPEjdIv2tSPwHMDd6WHA3WbHZPqc5HNtkHl+krIc=",
};

/** The prompt inside a SETUP_PROMPT.md's text block. */
function promptOf(rel: string): string {
  const block = /```text\n([\s\S]*?)\n```/.exec(read(rel));
  if (!block?.[1]) throw new Error(`no prompt block in ${rel}`);
  return block[1];
}

/** Every relative link in a markdown file, without its #anchor. Web, mail and same-page links are left out. */
function relativeLinks(rel: string): string[] {
  const text = read(rel).replace(/```[\s\S]*?```/g, "");
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!).filter((t) => !/^(https?:|mailto:|#)/.test(t)).map((t) => t.split("#")[0]!);
}

/** The old ways to start: each folder, its entry replacement, and whether it keeps a prompt file. */
const REDIRECTS = [
  { dir: "cleaner-template", entry: `${ENTRY}/SETUP_PROMPT.md`, prompt: true },
  { dir: "supply-template", entry: `${ENTRY}/SETUP_PROMPT.md`, prompt: true },
  { dir: "muse-template", entry: `${ENTRY}/muse/SETUP_PROMPT.md`, prompt: true },
  { dir: "claude-template", entry: `${ENTRY}/claude/SETUP_GUIDE.md`, prompt: false },
  { dir: "chatgpt-template", entry: `${ENTRY}/chatgpt/SETUP_GUIDE.md`, prompt: false },
] as const;

const HTML_GUIDES = ["grok", "muse", "claude", "chatgpt"].map((agent) => `docs/property-core-${agent}-setup.html`);

describe("the entry prompts", () => {
  it.each(Object.keys(PROMPT_PINS))("%s is pinned and offers Cleaner Core and Supply Core, never Tour Core", (rel) => {
    expect(createHash("sha256").update(read(rel)).digest("base64")).toBe(PROMPT_PINS[rel]);
    const prompt = promptOf(rel);
    expect(prompt).toContain(REPO);
    expect(prompt).toContain("Cleaner Core, Supply Core, or both");
    expect(prompt).toContain("get_state");
    expect(prompt).not.toMatch(/Tour Core|touring|tours/i);
    expect(prompt).toMatch(/Do not start anything on your computer\./);
    expect(prompt).toMatch(/Never ask me for the invite code in chat/);
    expect(prompt).toMatch(/card details, or door codes into chat/);
    expect(prompt).toMatch(/Start now\.$/);
  });

  it("send Grok to the Property Core bot profile and Muse to the Property Core skill", () => {
    expect(promptOf(`${ENTRY}/SETUP_PROMPT.md`)).toContain("Read property-core-template/bot-profile.md");
    expect(promptOf(`${ENTRY}/SETUP_PROMPT.md`)).toContain("Use your secure card. My cards stay in my Vault.");
    // The Alerts routine has a webhook address and key: the older prompt kept them out of chat too.
    expect(promptOf(`${ENTRY}/SETUP_PROMPT.md`)).toContain("tokens, webhook addresses, calendar links");
    const muse = promptOf(`${ENTRY}/muse/SETUP_PROMPT.md`);
    expect(muse).toContain("Save the folder property-core-template/muse/skills/property-core as a skill named Property Core");
    // The safety lines the older Muse prompt carried come along.
    expect(muse).toContain("never click Allow yourself");
    expect(muse).toContain("hand the browser to me, so I type it there myself");
    expect(muse).toContain("into chat or a card");
    expect(existsSync(join(REPO_ROOT, ENTRY, "muse/skills/property-core/SKILL.md"))).toBe(true);
  });
});

describe("the entry folder", () => {
  const readme = read(`${ENTRY}/README.md`);

  it("says it is the one way to start, Grok Bot and Muse first", () => {
    expect(readme.split("\n")[0]).toMatch(/^# Start here/);
    expect(readme).toContain("one way to start");
    const table = readme.slice(readme.indexOf("| Your agent"), readme.indexOf("The flows:"));
    const order = ["Grok Bot", "Muse", "Claude", "ChatGPT"].map((name) => table.indexOf(name));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(readme).toContain(TEMPLATE_LINK);
  });

  it("offers Cleaner Core and Supply Core, names Fixer Core as next, and keeps Tour Core parked", () => {
    for (const flow of ["Cleaner Core", "Supply Core", "Fixer Core"]) expect(readme).toContain(flow);
    expect(readme).toMatch(/Fixer Core\*\* \(repairs and upkeep\) comes next\. It isn't offered yet\./);
    expect(readme).toMatch(/## Tour Core is parked/);
  });

  it("links only to files that exist, as do the folders and pages that point to it", () => {
    const markdown = [
      ...filesUnder(join(REPO_ROOT, ENTRY)).filter((file) => file.endsWith(".md")).map((file) => file.slice(REPO_ROOT.length)),
      ...REDIRECTS.flatMap(({ dir, prompt }) => [`${dir}/README.md`, ...(prompt ? [`${dir}/SETUP_PROMPT.md`] : [])]),
      "README.md",
      "docs/client-matrix.md",
    ];
    for (const rel of markdown) {
      for (const link of relativeLinks(rel)) expect(existsSync(join(REPO_ROOT, dirname(rel), link)), `${rel} → ${link}`).toBe(true);
    }
    for (const rel of HTML_GUIDES) {
      const links = [...read(rel).matchAll(/href="([^"#:]+)(?:#[^"]*)?"/g)].map((m) => m[1]!);
      for (const link of links) expect(existsSync(join(REPO_ROOT, dirname(rel), link)), `${rel} → ${link}`).toBe(true);
    }
  });

  it("never asks the old Tour Core or Cleaner Core question, anywhere outside the dated plans", () => {
    // Checked-in files only, so local scratch files and CI logs don't count.
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
    const docs = tracked.filter((rel) => /\.(md|html|json)$/.test(rel) && !rel.includes("/superpowers/") && rel !== "package-lock.json");
    expect(docs.length).toBeGreaterThan(50);
    for (const rel of docs) expect(read(rel).replace(/\s+/g, " "), rel).not.toMatch(/Tour Core or Cleaner Core/);
    for (const file of [...filesUnder(join(REPO_ROOT, ENTRY)), ...HTML_GUIDES.map((rel) => join(REPO_ROOT, rel))]) {
      const text = readFileSync(file, "utf8").replace(/\s+/g, " ");
      expect(text, file).not.toMatch(/Tour Core or Cleaner Core/);
      expect(text, file).not.toContain("What do you want to set up?");
      expect(text, file).not.toMatch(/runs one service at a time|one at a time\. You can switch/);
    }
  });

  it("turns on Supply Core in the Grok bot, with its guide, routine, and Vault", () => {
    const m = json<{ repository: { bootstrap: Record<string, string> }; services: { service: string; parked?: string }[]; routines: { name: string; service: string }[]; integrations: { name: string; service?: string }[]; suggestedPrompts: string[] }>(`${ENTRY}/template.json`);
    expect(m.repository.bootstrap.supplies).toBe("SUPPLY_CORE_BOOTSTRAP.md");
    expect(m.services.filter((s) => !s.parked).map((s) => s.service)).toEqual(["cleaning", "supplies"]);
    expect(m.services.find((s) => s.service === "touring")?.parked).toBeTruthy();
    expect(m.routines.filter((r) => r.service === "supplies").map((r) => r.name)).toEqual(["Supply Core Check"]);
    expect(m.integrations).toContainEqual(expect.objectContaining({ name: "Grok shopping and Vault", service: "supplies" }));
    expect(m.suggestedPrompts.join(" ")).not.toMatch(/tour/i);
    const profile = read(`${ENTRY}/bot-profile.md`).replace(/\s+/g, " ");
    expect(profile).toContain("`SUPPLY_CORE_BOOTSTRAP.md`");
    expect(profile).toContain("Call `check_cart` before every Place Order.");
    expect(profile).toContain("Fixer Core isn't available yet");
  });

  it("tells every agent what to do when Supply Core can't run alone, and that the Cleaner Core connector is this one", () => {
    // set_flows refuses supplies without cleaning while SUPPLY_CORE is off (src/hosted/service.ts).
    for (const rel of [`${ENTRY}/bot-profile.md`, `${ENTRY}/muse/skills/property-core/SKILL.md`]) {
      expect(read(rel).replace(/\s+/g, " "), rel).toContain("If `set_flows` says Supply Core can't run on its own yet, tell the host Cleaner Core has to be on first, and offer both.");
    }
    for (const rel of ["docs/property-core-grok-setup.html", "docs/property-core-muse-setup.html"]) expect(read(rel), rel).toMatch(/Cleaner Core has to be on first, pick both\./);
    // The server's task wording still names a Cleaner Core connector; the host only has Property Core.
    for (const rel of [`${ENTRY}/bot-profile.md`, `${ENTRY}/muse/skills/property-core/SKILL.md`, `${ENTRY}/claude/plugin/skills/property-core/SKILL.md`, `${ENTRY}/chatgpt/SETUP_GUIDE.md`]) {
      expect(read(rel).replace(/\s+/g, " "), rel).toMatch(/names the Cleaner Core (connector|or Supply Core connection)/);
    }
  });

  it("keeps Claude and ChatGPT to Cleaner Core, and Muse to Cleaner Core and Supply Core", () => {
    for (const agent of ["claude", "chatgpt"]) {
      const m = json<{ flows: { offered: string[] } }>(`${ENTRY}/${agent}/template.json`);
      expect(m.flows.offered).toEqual(["cleaning"]);
      expect(read(`${ENTRY}/${agent}/SETUP_GUIDE.md`)).toMatch(/Supply Core needs an always-on agent/);
    }
    const muse = json<{ routines: { service: string }[] }>(`${ENTRY}/muse/template.json`);
    expect(muse.routines.map((r) => r.service).sort()).toEqual(["cleaning", "supplies", "touring"]);
  });

  it("keeps each Tour Core task for touring accounts, marked parked", () => {
    for (const agent of ["claude", "chatgpt", "muse"]) {
      const m = json<{ routines: { service: string; doc: string; parked?: boolean }[] }>(`${ENTRY}/${agent}/template.json`);
      const touring = m.routines.filter((r) => r.service === "touring");
      expect(touring).toHaveLength(1);
      expect(touring[0]!.parked).toBe(true);
      expect(read(join(ENTRY, agent, touring[0]!.doc)).slice(0, 300)).toContain("**Parked.**");
    }
  });
});

describe("the older setup folders", () => {
  it.each(REDIRECTS)("$dir points to the entry and offers no start of its own", ({ dir, entry, prompt }) => {
    const m = json<{ startHere: string }>(`${dir}/template.json`);
    expect(existsSync(join(REPO_ROOT, dir, m.startHere)), m.startHere).toBe(true);
    const top = read(`${dir}/README.md`).slice(0, 900);
    expect(top).toMatch(/\*\*To start, use \[`property-core-template\//);
    if (prompt) {
      const moved = read(`${dir}/SETUP_PROMPT.md`);
      expect(moved.split("\n")[0]).toBe("# This prompt moved");
      expect(moved).not.toContain("```");
      expect(relativeLinks(`${dir}/SETUP_PROMPT.md`)).toContain(`../${entry}`);
    }
  });

  it("marks the Tour Core Grok template parked", () => {
    expect(read("grok-template/README.md").slice(0, 600)).toMatch(/\*\*Tour Core is parked\.\*\* New hosts start from/);
  });

  it("start the README at the entry", () => {
    const readme = read("README.md");
    const connect = readme.slice(readme.indexOf("## Connect your agent"), readme.indexOf("## Safety gates"));
    expect(connect).toContain("[`property-core-template/`](property-core-template/README.md)");
    for (const prompt of Object.keys(PROMPT_PINS)) expect(connect).toContain(`(${prompt})`);
    expect(connect).not.toMatch(/\]\((cleaner|supply|muse)-template\/SETUP_PROMPT\.md\)/);
  });
});

describe("files the agents and the server read", () => {
  /** Template paths named by the server's code, the bootstraps, and the Grok skills. */
  function namedPaths(): string[] {
    const sources = [
      ...filesUnder(join(REPO_ROOT, "src")).filter((file) => file.endsWith(".ts")),
      ...["CLEANER_CORE_BOOTSTRAP.md", "SUPPLY_CORE_BOOTSTRAP.md", "GROK_BOOTSTRAP.md"].map((rel) => join(REPO_ROOT, rel)),
      ...filesUnder(join(REPO_ROOT, ".grok")),
      // The standing instructions published Grok team templates carry.
      ...["property-core-template", "cleaner-template", "supply-template"].map((dir) => join(REPO_ROOT, dir, "bot-profile.md")),
    ];
    const paths = sources.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/\b((?:[a-z]+-)+template\/[A-Za-z0-9_./-]*[A-Za-z0-9_/-])/g)].map((m) => m[1]!));
    return [...new Set(paths)].sort();
  }

  it("still exist, so bots set up from an older prompt or a published template keep working", () => {
    const paths = namedPaths();
    expect(paths).toEqual(expect.arrayContaining(["cleaner-template/template.json", "supply-template/template.json", "grok-template/template.json", "muse-template/skills/supply-core"]));
    for (const path of paths) expect(existsSync(join(REPO_ROOT, path)), path).toBe(true);
    for (const kept of ["cleaner-template/bot-profile.md", "supply-template/bot-profile.md", "grok-template/bot-profile.md", "claude-template/plugin/skills/cleaner-core/SKILL.md"]) {
      expect(existsSync(join(REPO_ROOT, kept)), kept).toBe(true);
    }
  });

  it("lists the Property Core skill as a Claude plugin, next to Cleaner Core's", () => {
    const market = json<{ plugins: { name: string; source: string }[] }>(".claude-plugin/marketplace.json");
    expect(market.plugins.map((p) => p.name)).toEqual(["property-core", "cleaner-core"]);
    for (const plugin of market.plugins) {
      const manifest = json<{ name: string }>(join(plugin.source, ".claude-plugin/plugin.json"));
      expect(manifest.name).toBe(plugin.name);
      expect(existsSync(join(REPO_ROOT, plugin.source, "skills", plugin.name, "SKILL.md"))).toBe(true);
    }
    expect(read(`${ENTRY}/claude/SETUP_GUIDE.md`)).toContain("/plugin install property-core@property-core");
  });
});

describe("the HTML setup guides", () => {
  it.each(HTML_GUIDES)("%s drops the touring pick", (rel) => {
    const page = read(rel);
    expect(page).not.toMatch(/data-pick="tour"|data-svc="tour"|svc-tour/);
    expect(page).not.toContain("Self-guided tours for a rental unit");
    expect(page.replace(/<[^>]+>/g, "")).toMatch(/Tour Core[^.]*is parked/);
  });

  it.each(["grok", "muse"])("the %s guide sets up Supply Core and pastes the entry prompt word for word", (agent) => {
    const page = read(`docs/property-core-${agent}-setup.html`);
    expect(page).toContain("Supply Core");
    expect(page).toContain("check_cart");
    const prompt = promptOf(agent === "grok" ? `${ENTRY}/SETUP_PROMPT.md` : `${ENTRY}/muse/SETUP_PROMPT.md`);
    const text = page.replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
    for (const line of prompt.split("\n")) expect(text).toContain(line);
  });

  it.each(["claude", "chatgpt"])("the %s guide is Cleaner Core only, and sends Supply Core to Grok Bot or Muse", (agent) => {
    const page = read(`docs/property-core-${agent}-setup.html`);
    expect(page).toContain("Cleaner Core");
    expect(page).toMatch(/Supply Core needs an always-on agent/);
    expect(page).not.toMatch(/data-pick=/);
  });
});
