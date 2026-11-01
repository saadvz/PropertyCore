import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVICE_CHOICES, SERVICE_QUESTION } from "../src/hosted/serviceTools";

/** The Property Core Grok Bot template: one bot for both services, consistent with the service and free of secrets. */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "property-core-template");
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const json = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;

interface Manifest {
  name: string;
  profile: string;
  setupPrompt: string;
  readme: string;
  hostedPropertyCoreUrl: string;
  repository: { url: string; bootstrap: Record<string, string> };
  services: { service: string; name: string; choice: string; profile: string }[];
  skills: string[];
  integrations: { name: string; type: string; url?: string; doc?: string }[];
  routines: { name: string; service: string; doc: string }[];
}

const manifest = () => json(join(TEMPLATE, "template.json")) as unknown as Manifest;
const profile = () => read(join(TEMPLATE, manifest().profile));

describe("Property Core template", () => {
  it("names only files that exist", () => {
    const m = manifest();
    const paths = [
      m.profile,
      m.setupPrompt,
      m.readme,
      ...m.skills,
      ...m.services.map((s) => s.profile),
      ...m.routines.map((r) => r.doc),
      ...m.integrations.flatMap((i) => (i.doc ? [i.doc] : [])),
    ];
    for (const path of paths) expect(existsSync(join(TEMPLATE, path)), path).toBe(true);
    for (const guide of Object.values(m.repository.bootstrap)) expect(existsSync(join(ROOT, guide)), guide).toBe(true);
  });

  it("connects to the one shared address, the same service the single-service templates use", () => {
    const m = manifest();
    expect(m.hostedPropertyCoreUrl).toBe(json(join(ROOT, "grok-template/template.json")).hostedTourCoreUrl);
    expect(m.hostedPropertyCoreUrl).toBe(json(join(ROOT, "cleaner-template/template.json")).hostedCleanerCoreUrl);
    const mcp = m.integrations.filter((i) => i.type === "custom-mcp-server");
    expect(mcp.map((i) => i.url)).toEqual(["hostedPropertyCoreUrl/mcp"]);
    expect(profile()).toContain("never connect to\n  `/mcp/cleaner-core`");
  });

  it("asks the same question, with the same choices, as the service does", () => {
    const text = profile().replace(/\s+/g, " ");
    expect(text).toContain(`ask the host exactly "${SERVICE_QUESTION}"`);
    for (const choice of SERVICE_CHOICES) expect(text).toContain(`"${choice.label}"`);
    expect(manifest().services.map((s) => [s.service, s.choice])).toEqual(SERVICE_CHOICES.map((c) => [c.service, c.label]));
  });

  it("carries each service's routines, the same ones its own template defines", () => {
    const names = (file: string) => (json(join(ROOT, file)).routines as { name: string }[]).map((r) => r.name);
    const routines = manifest().routines;
    expect(routines.filter((r) => r.service === "touring").map((r) => r.name)).toEqual(names("grok-template/template.json"));
    expect(routines.filter((r) => r.service === "cleaning").map((r) => r.name)).toEqual(names("cleaner-template/template.json"));
  });

  it("holds no phone number, key, token, or door code", () => {
    for (const file of filesUnder(TEMPLATE)) {
      const text = read(file);
      expect(text, file).not.toMatch(/\+1\d{10}|\(\d{3}\)\s*\d{3}-\d{4}/);
      expect(text, file).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{12,}|AC[0-9a-f]{32}|sk-[A-Za-z0-9]{12,}/);
      expect(text, file).not.toMatch(/door code (?:is|:)\s*\d/i);
    }
  });
});

/** Every file under a folder, for the secrets scan. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]));
}

describe.each(["claude", "chatgpt", "muse"] as const)("Property Core for %s", (platform) => {
  const dir = join(TEMPLATE, platform);
  interface PlatformManifest {
    hostedPropertyCoreUrl: string;
    instructions: string;
    integrations: { type: string; url?: string }[];
    routines: { name: string; service: string; doc: string }[];
    [key: string]: unknown;
  }
  const m = () => json(join(dir, "template.json")) as unknown as PlatformManifest;
  const touringTask = () => read(join(dir, m().routines.find((r) => r.service === "touring")!.doc));

  it("names only files that exist", () => {
    const paths = [m().instructions, ...m().routines.map((r) => r.doc), ...["readme", "setupGuide", "setupPrompt", "plugin", "skill"].flatMap((k) => (typeof m()[k] === "string" ? [m()[k] as string] : []))];
    for (const path of paths) expect(existsSync(join(dir, path)), path).toBe(true);
  });

  it("connects once, at /mcp on the same service", () => {
    expect(m().hostedPropertyCoreUrl).toBe(manifest().hostedPropertyCoreUrl);
    expect(m().integrations.filter((i) => i.type === "custom-connector").map((i) => i.url)).toEqual(["hostedPropertyCoreUrl/mcp"]);
  });

  it("asks the service's question with its choices, and never connects /mcp/cleaner-core", () => {
    const text = read(join(dir, m().instructions)).replace(/\s+/g, " ");
    expect(text).toContain(`ask the host exactly "${SERVICE_QUESTION}"`);
    for (const choice of SERVICE_CHOICES) expect(text).toContain(`"${choice.label}"`);
    expect(text).toMatch(/[Nn]ever connect to `\/mcp\/cleaner-core`/);
  });

  it("has a touring task that reads its updates and asks about host texts", () => {
    const task = touringTask().replace(/\s+/g, " ");
    if (platform === "claude") {
      expect(task).toContain("API trigger");
      expect(task).toContain("Fire URL");
    } else {
      expect(task).toContain("get_updates");
      expect(task).toContain("get_inbox");
      expect(task).toContain("save_alert_routine with no arguments");
    }
    expect(task).toContain("Want tour updates texted to your phone too?");
  });

  it("holds no phone number, key, token, or door code", () => {
    for (const path of filesUnder(dir)) {
      const text = read(path);
      expect(text, path).not.toMatch(/\+1\d{10}|\(\d{3}\)\s*\d{3}-\d{4}/);
      expect(text, path).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{12,}|AC[0-9a-f]{32}|sk-[A-Za-z0-9]{12,}/);
    }
  });
});

describe("the Grok Property Core template", () => {
  it("records its published team template link", () => {
    expect(json(join(TEMPLATE, "template.json")).templateLink).toBe("https://x.ai/bot/rfmREJxrfqNuTiOs2VqYQ");
  });
});
