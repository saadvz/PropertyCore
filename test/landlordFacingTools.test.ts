import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { publicHealth } from "../src/install/checks";
import { secureSetupLink } from "../src/install/tools";
import { HOSTED_ADMIN_TOOLS } from "../src/install/hostedAdminTools";
import { Installation } from "../src/install/installation";
import { HOSTED_OWNER_TOOL, LANDLORD_CORE_TOOLS, OPS_TOOL_NAMES, QA_TOOL_NAMES } from "../src/mcp/scopes";
import { ConfirmationBook } from "../src/operator/confirmations";
import { callOperatorTool, OPERATOR_TOOLS, OPERATOR_TOOL_NAMES, type ToolContext } from "../src/operator/tools";
import { renderPlaybook } from "../src/playbooks/compose";
import { MCP_INSTRUCTIONS } from "../src/playbooks/instructions";
import { milestoneToolFor } from "../src/playbooks/milestoneTool";
import { SHARED_STEPS, type StepId } from "../src/playbooks/shared";
import { PropertyWorkspace } from "../src/setup";
import { FACT_QUESTIONS, FACT_TOPICS } from "../src/setup/factsSheet";
import { BUILDING_ACCESS_QUESTION, BUILDING_ENTRANCE_QUESTION, ENTRY_INSTRUCTIONS_QUESTION } from "../src/setup/setupActions";
import { VisitorDemoRegistry } from "../src/visitor";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { createSetupServer } from "../src/web/server";
import { repoFilesUnder } from "./files";

/**
 * Landlord-facing instructions may name only the 22 landlord tools, plus
 * reset_hosted_demo. <!-- connector: qa-skill --> exempts only its section:
 * through <!-- /connector --> when that closer is present, otherwise until
 * the next h1 or h2. A marker inside the opening frontmatter exempts nothing.
 * A <!-- connector: qa --> or <!-- connector: ops --> region, and an
 * ## QA connector or ## Ops connector section, may name that connector's
 * tools. A line that says "QA connector" or "ops connector", and an
 * allowed-tools grant line, drops only that connector's tool names.
 * <!-- historical-tools: reason --> exempts only its section, and only when
 * the reason is non-empty. No other section may name a Tour Core tool that
 * is not on the landlord, QA, or ops connector. A marker never blanks a file.
 * grok-template is scanned except SETUP_PROMPT.md. docs/ is scanned.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LANDLORD = new Set<string>([...LANDLORD_CORE_TOOLS, HOSTED_OWNER_TOOL]);
const ON_A_CONNECTOR = new Set<string>([...LANDLORD, ...QA_TOOL_NAMES, ...OPS_TOOL_NAMES]);
const FOREIGN = [...new Set(OPERATOR_TOOL_NAMES)].filter((name) => !LANDLORD.has(name)).sort((a, b) => b.length - a.length);
const REMOVED = [...new Set(OPERATOR_TOOL_NAMES)].filter((name) => !ON_A_CONNECTOR.has(name)).sort((a, b) => b.length - a.length);
const FOREIGN_RE = new RegExp(`\\b(${FOREIGN.join("|")})\\b`, "g");
const REMOVED_RE = new RegExp(`\\b(${REMOVED.join("|")})\\b`, "g");

const DOC_ROOTS = [".grok/skills", "grok-template", "GROK_BOOTSTRAP.md", "README.md", "docs"];
/** SETUP_PROMPT.md is pinned byte for byte in grokTemplate.test.ts, so it is not scanned here. */
const docFiles = () => DOC_ROOTS.flatMap((rel) => repoFilesUnder(rel, ["SETUP_PROMPT.md"]));

function withoutNames(line: string, names: readonly string[]): string {
  let out = line;
  for (const name of [...names].sort((a, b) => b.length - a.length)) out = out.replaceAll(name, "");
  return out;
}

function frontmatterEnd(text: string): number {
  if (!text.startsWith("---\n")) return 0;
  const close = text.indexOf("\n---", 4);
  return close < 0 ? 0 : close + "\n---".length;
}

const HISTORICAL_OPEN = /<!-- historical-tools:\s*\S[^>]*-->/;

/**
 * Drops marked sections. QA and ops regions need a closer. A qa-skill or
 * historical marker with a closer drops only that region; without one it
 * drops lines until the next h1 or h2. A marker in the opening frontmatter
 * does not start a section.
 */
function withoutMarkedSections(text: string, includeConnectorSections: boolean): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const fmEnd = frontmatterEnd(normalized);
  const lines = normalized.split("\n");
  const kept: string[] = [];
  let skip: { until: "closer" | "heading"; closer: string } | undefined;
  let offset = 0;
  const closerAhead = (from: number, closer: string) => lines.slice(from + 1).some((later) => later.includes(closer));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const at = offset;
    offset += line.length + 1;
    if (skip?.until === "closer") {
      if (line.includes(skip.closer)) skip = undefined;
      continue;
    }
    if (skip?.until === "heading") {
      if (/^#{1,2} /.test(line)) skip = undefined;
      else continue;
    }
    const inFrontmatter = at < fmEnd;
    if (!inFrontmatter && includeConnectorSections && line.includes("<!-- connector: qa-skill -->")) {
      skip = closerAhead(i, "<!-- /connector -->")
        ? { until: "closer", closer: "<!-- /connector -->" }
        : { until: "heading", closer: "" };
      continue;
    }
    if (!inFrontmatter && HISTORICAL_OPEN.test(line)) {
      skip = closerAhead(i, "<!-- /historical-tools -->")
        ? { until: "closer", closer: "<!-- /historical-tools -->" }
        : { until: "heading", closer: "" };
      continue;
    }
    if (includeConnectorSections && line.includes("<!-- connector: qa -->") && closerAhead(i, "<!-- /connector -->")) {
      skip = { until: "closer", closer: "<!-- /connector -->" };
      continue;
    }
    if (includeConnectorSections && line.includes("<!-- connector: ops -->") && closerAhead(i, "<!-- /connector -->")) {
      skip = { until: "closer", closer: "<!-- /connector -->" };
      continue;
    }
    const heading = /^(#{1,6}) /.exec(line);
    if (includeConnectorSections && heading && heading[1]!.length === 2 && /^## (?:QA|Ops) connector\b/.test(line)) {
      skip = { until: "heading", closer: "" };
      continue;
    }
    let visible = line;
    if (includeConnectorSections && /^allowed-tools:/.test(line)) visible = withoutNames(visible, QA_TOOL_NAMES);
    if (includeConnectorSections && /QA connector/.test(line)) visible = withoutNames(visible, QA_TOOL_NAMES);
    if (includeConnectorSections && /ops connector/.test(line)) visible = withoutNames(visible, OPS_TOOL_NAMES);
    kept.push(visible);
  }
  return kept.join("\n");
}

/** Landlord-facing prose. QA, ops, and historical sections are removed before the scan. */
function landlordFacingText(text: string): string {
  return withoutMarkedSections(text, true);
}

function foreignTools(text: string): string[] {
  return [...new Set([...text.matchAll(FOREIGN_RE)].map((match) => match[1]!))];
}

/** Old Tour Core tool names, backticked or bare. A historical section is skipped. QA and ops sections are not. */
function removedTools(text: string): string[] {
  const visible = withoutMarkedSections(text, false);
  return [...new Set([...visible.matchAll(REMOVED_RE)].map((match) => match[1]!))];
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("landlord-facing tool names", () => {
  it("names a foreign tool in an unmarked paragraph", () => {
    expect(foreignTools("Call list_properties, then create_property_setup.")).toEqual(["list_properties", "create_property_setup"]);
    expect(foreignTools(landlordFacingText("<!-- connector: qa -->\nCall list_properties.\n<!-- /connector -->\nCall get_state."))).toEqual([]);
    expect(foreignTools(landlordFacingText("On the QA connector, call inject_local_sms."))).toEqual([]);
    expect(foreignTools(landlordFacingText("On the ops connector, call check_runtime_health."))).toEqual([]);
    expect(foreignTools(landlordFacingText("---\nname: x\n<!-- connector: qa-skill -->\n---\nCall list_properties."))).toEqual(["list_properties"]);
    const marked = ["Call list_properties.", "<!-- connector: qa-skill -->", "Call inject_local_sms.", "<!-- /connector -->", "Call create_property_setup."].join("\n");
    expect(foreignTools(landlordFacingText(marked))).toEqual(["list_properties", "create_property_setup"]);
    const untilHeading = ["<!-- connector: qa-skill -->", "Call inject_local_sms.", "## Later", "Call list_properties."].join("\n");
    expect(foreignTools(landlordFacingText(untilHeading))).toEqual(["list_properties"]);
  });

  it("still names a foreign tool outside the qa-skill section, and on a connector line that names another tool", () => {
    expect(foreignTools(landlordFacingText("See the note.\n<!-- connector: qa-skill -->\nCall inject_local_sms.\n## After\nCall list_properties."))).toEqual(["list_properties"]);
    expect(foreignTools(landlordFacingText("On the QA connector, call list_properties."))).toEqual(["list_properties"]);
    expect(foreignTools(landlordFacingText("On the ops connector, call create_property_setup."))).toEqual(["create_property_setup"]);
    expect(foreignTools(landlordFacingText("allowed-tools: inject_local_sms get_installation_status\nCall list_properties."))).toEqual(["list_properties"]);
  });

  it("scans grok-template except SETUP_PROMPT.md, and the template setup doc", () => {
    const files = docFiles();
    expect(files).toContain("docs/grok-template-setup.md");
    expect(files).toContain("grok-template/bot-profile.md");
    expect(files.some((file) => file.endsWith("SETUP_PROMPT.md"))).toBe(false);
  });

  it("keeps skills, the template, the bootstrap, and the README on landlord tools outside QA and ops sections", () => {
    const hits: string[] = [];
    for (const rel of docFiles()) {
      const found = foreignTools(landlordFacingText(read(rel)));
      for (const name of found) hits.push(`${rel}: ${name}`);
    }
    expect(hits).toEqual([]);
  });

  it("names a removed tool even inside a QA section", () => {
    expect(removedTools("<!-- connector: qa -->\nCall `publish_demo_property`.\n<!-- /connector -->")).toEqual(["publish_demo_property"]);
    expect(removedTools("Call `get_state`, then `inject_local_sms`. `keyword_confirm` is a setting.")).toEqual([]);
    const historical = ["<!-- historical-tools: The Phase 0 harness still calls this. -->", "Call publish_demo_property.", "<!-- /historical-tools -->", "Call create_property_setup."].join("\n");
    expect(removedTools(historical)).toEqual(["create_property_setup"]);
    expect(foreignTools(landlordFacingText(historical))).toEqual(["create_property_setup"]);
    expect(removedTools("<!-- historical-tools: -->\nCall publish_demo_property.")).toEqual(["publish_demo_property"]);
    const untilHeading = ["<!-- historical-tools: Old install inventory in this section. -->", "Call publish_demo_property.", "## Now", "Call create_property_setup."].join("\n");
    expect(removedTools(untilHeading)).toEqual(["create_property_setup"]);
  });

  it("keeps each skill's Call only line on that skill's connector tools", () => {
    const hits: string[] = [];
    for (const rel of repoFilesUnder(".grok/skills").filter((file) => file.endsWith("SKILL.md"))) {
      const scope = rel.includes("simulate-tour") ? new Set<string>(QA_TOOL_NAMES) : LANDLORD;
      const callOnly = read(rel).split("\n").filter((line) => line.startsWith("Call only")).join("\n");
      for (const match of callOnly.matchAll(/`([a-z][a-z0-9_]*)`/g)) {
        if (OPERATOR_TOOL_NAMES.includes(match[1]!) && !scope.has(match[1]!)) hits.push(`${rel}: ${match[1]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("keeps the client matrix on tools that are on a connector", () => {
    const hits: string[] = [];
    for (const rel of ["docs/client-matrix.md", "src/eval/clientMatrix.ts", "src/playbooks/select.ts"]) {
      for (const name of removedTools(read(rel))) hits.push(`${rel}: ${name}`);
    }
    expect(hits).toEqual([]);
  });

  it("keeps skills, the template, the bootstrap, and the README off tools that are not on any connector", () => {
    const hits: string[] = [];
    for (const rel of docFiles()) {
      const found = removedTools(read(rel));
      for (const name of found) hits.push(`${rel}: ${name}`);
    }
    expect(hits).toEqual([]);
  });

  it("keeps landlord tool descriptions and next-step copy on landlord tools", () => {
    const hits: string[] = [];
    for (const tool of [...OPERATOR_TOOLS, ...HOSTED_ADMIN_TOOLS]) {
      if (!LANDLORD.has(tool.name)) continue;
      for (const name of foreignTools(tool.description)) hits.push(`${tool.name} description: ${name}`);
    }
    for (const step of Object.keys(SHARED_STEPS) as StepId[]) {
      const tool = milestoneToolFor(step);
      if (!LANDLORD.has(tool)) hits.push(`milestone ${step}: ${tool}`);
    }
    const spoken = Object.values(SHARED_STEPS).flatMap((step) => [step.ask, step.done, step.ifItFails]).join("\n");
    for (const name of foreignTools(spoken)) hits.push(`shared step: ${name}`);
    for (const name of foreignTools(read("src/operator/milestones.ts"))) hits.push(`milestones: ${name}`);
    for (const name of foreignTools(MCP_INSTRUCTIONS)) hits.push(`MCP_INSTRUCTIONS: ${name}`);
    const clients = [
      undefined,
      { name: "Grok" },
      { name: "Grok", capabilities: { elicitation: { form: {} }, sampling: {}, roots: { listChanged: true } } },
      { name: "grok", capabilities: { tools: {} } },
      { name: "claude-ai", capabilities: { elicitation: { form: {} }, sampling: {}, roots: { listChanged: true } } },
      { name: "ChatGPT", capabilities: { elicitation: { form: {} } } },
      { name: "example-client", capabilities: { tools: {} } },
    ];
    for (const client of clients) {
      for (const step of Object.keys(SHARED_STEPS) as StepId[]) {
        for (const name of foreignTools(renderPlaybook(client, step).text)) hits.push(`playbook ${client?.name ?? "baseline"} ${step}: ${name}`);
      }
    }
    const note = /const RESTORE_NOTE = "([^"]+)"/.exec(read("src/backup/service.ts"))?.[1] ?? "";
    for (const name of foreignTools(note)) hits.push(`RESTORE_NOTE: ${name}`);
    expect(hits).toEqual([]);
  });
});

const TOKEN = "landlord-token-facing-1234567890";
const HOST = "https://demo.up.railway.app";
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

async function post(port: number, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    error?: { message: string };
    result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: Array<{ text: string }> };
  };
  if (json.error) throw new Error(json.error.message);
  if (json.result?.isError) throw new Error(json.result.content?.[0]?.text ?? "tool error");
  return json.result?.structuredContent ?? {};
}

async function hostedWalkPort(): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), "tourcore-landlord-walk-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = {
    TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0",
    RAILWAY_PUBLIC_DOMAIN: "demo.up.railway.app",
    TOURCORE_MCP_AUTH_MODE: "static",
    TOURCORE_OPERATOR_TOKEN: TOKEN,
    PUBLIC_BASE_URL: HOST,
  };
  const runtime = new FileRuntimeStore(join(root, "runtime"));
  let inst!: Installation;
  const fetchImpl = async (url: string) => {
    if (url.includes("/healthz")) return { status: 200, json: async () => publicHealth(inst) };
    return { status: 200, json: async () => ({}) };
  };
  inst = new Installation({ root, runtime, env: () => env, fetch: fetchImpl as never, now: () => Date.parse("2026-10-09T15:00:00.000Z") });
  inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
  inst.files.setPublicBaseUrl(HOST, "RAILWAY");
  inst.files.recordCheck("publicEndpointCheck", { ok: true, at: "2026-10-09T15:00:00.000Z", message: "Tour Core is reachable at its public address.", url: HOST });
  const server = createSetupServer({
    workspace: new PropertyWorkspace(root),
    installation: inst,
    mcpAuth: "static",
    operatorToken: () => TOKEN,
    log: () => {},
  });
  cleanups.push(() => server.close());
  return listen(server);
}

describe("hosted setup-property dry walk", () => {
  it("follows get_state through publish using only landlord tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-landlord-walk-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const env: NodeJS.ProcessEnv = {
      TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0",
      RAILWAY_PUBLIC_DOMAIN: "demo.up.railway.app",
      TOURCORE_MCP_AUTH_MODE: "static",
      TOURCORE_OPERATOR_TOKEN: TOKEN,
      PUBLIC_BASE_URL: HOST,
    };
    const runtime = new FileRuntimeStore(join(root, "runtime"));
    let inst!: Installation;
    const fetchImpl = async (url: string) => {
      if (url.includes("/healthz")) return { status: 200, json: async () => publicHealth(inst) };
      return { status: 200, json: async () => ({}) };
    };
    inst = new Installation({ root, runtime, env: () => env, fetch: fetchImpl as never, now: () => Date.parse("2026-10-09T15:00:00.000Z") });
    inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    inst.files.setPublicBaseUrl(HOST, "RAILWAY");
    inst.files.recordCheck("publicEndpointCheck", { ok: true, at: "2026-10-09T15:00:00.000Z", message: "Tour Core is reachable at its public address.", url: HOST });

    const server = createSetupServer({
      workspace: new PropertyWorkspace(root),
      installation: inst,
      mcpAuth: "static",
      operatorToken: () => TOKEN,
      log: () => {},
    });
    cleanups.push(() => server.close());
    const port = await listen(server);
    const used: string[] = [];
    const log: string[] = [];
    let propertyId: string | undefined;
    let publishCode: string | undefined;
    let sawProfileOnSaveUnits = false;
    let published = false;

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      expect(LANDLORD_CORE_TOOLS, name).toContain(name);
      used.push(name);
      const result = await post(port, { jsonrpc: "2.0", id: used.length, method: "tools/call", params: { name, arguments: args } });
      for (const nameHit of foreignTools(JSON.stringify(result))) log.push(`returned ${nameHit} from ${name}`);
      if (typeof result.propertyId === "string") propertyId = result.propertyId;
      const confirmation = result.confirmation as { code?: string } | undefined;
      if (name === "publish" && confirmation?.code) publishCode = confirmation.code;
      if (result.published === true) published = true;
      if (result.status === "blocked") throw new Error(`${name} blocked: ${String(result.message ?? result.reason)}\n${log.join("\n")}`);
      return result;
    };

    const answer = (tool: string, say: string): { name: string; args: Record<string, unknown> } => {
      const property = propertyId ? { property: propertyId } : {};
      if (tool === "set_up_texting") return { name: tool, args: { provider: "local" } };
      if (tool === "backup_records") return { name: tool, args: { action: "decline" } };
      if (tool === "save_hours") return { name: tool, args: { ...property, days: "weekdays", start: "9am", end: "5pm" } };
      if (tool === "save_settings") return { name: tool, args: { ...property, verification: "basic-form", skipAlerts: true } };
      if (tool === "run_checks") return { name: tool, args: property };
      if (tool === "publish") return { name: tool, args: { ...property, ...(publishCode ? { confirmationCode: publishCode } : {}) } };
      if (tool === "save_doors_and_routes") {
        return {
          name: tool,
          args: {
            ...property,
            doors: [{ name: "Front Door", kind: "entrance" }],
            routes: [
              { unit: "Unit A", doors: ["Front Door", "Unit A Door"] },
              { unit: "Unit B", doors: ["Front Door", "Unit B Door"] },
            ],
          },
        };
      }
      if (tool === "save_units") {
        if (/bedroom|bathroom|rent|available/i.test(say)) {
          sawProfileOnSaveUnits = true;
          return {
            name: tool,
            args: {
              ...property,
              details: "Unit A is 2 bed 1 bath for $2,200, available now. Unit B is 1 bed 1 bath for $1,950, available October 15.",
            },
          };
        }
        return { name: tool, args: { ...property, units: [{ name: "Unit A" }, { name: "Unit B" }] } };
      }
      if (tool === "save_property") {
        if (/street address|property address/i.test(say)) {
          return propertyId
            ? { name: tool, args: { ...property, street: "18 Maple Street" } }
            : { name: tool, args: { address: "18 Maple Street" } };
        }
        if (/what state/i.test(say)) return { name: tool, args: { ...property, state: "NJ" } };
        if (/what city/i.test(say)) return { name: tool, args: { ...property, city: "Teaneck" } };
        if (/zip/i.test(say)) return { name: tool, args: { ...property, postalCode: "07666" } };
        if (/did i get that right/i.test(say)) return { name: tool, args: { ...property, confirmAddress: true } };
        if (/single-family|apartment or condo/i.test(say)) return { name: tool, args: { ...property, propertyType: "MULTIFAMILY_HOME" } };
        if (/stuck visitors|touring hours/i.test(say)) return { name: tool, args: { ...property, skipVisitorHelp: true } };
        if (/time zone|switch to/i.test(say)) return { name: tool, args: { ...property, timezone: "no" } };
      }
      if (tool === "save_facts") {
        const topic = FACT_TOPICS.find((t) => FACT_QUESTIONS[t] === say);
        if (topic) return { name: tool, args: { ...property, topic, skip: true } };
      }
      throw new Error(`No landlord answer for ${tool}: ${say}`);
    };

    for (let step = 0; step < 40 && !published; step++) {
      const state = await call("get_state");
      const next = state.nextStep as { tool?: string; say?: string };
      const tool = String(next.tool ?? "");
      const say = String(next.say ?? "");
      log.push(`${tool}: ${say}`);
      expect(LANDLORD.has(tool), `${tool} from get_state`).toBe(true);
      if (tool === "get_inbox" || tool === "get_state") break;
      const turn = answer(tool, say);
      log.push(`call ${turn.name} ${JSON.stringify(turn.args)}`);
      const result = await call(turn.name, turn.args);
      log.push(`-> ${String(result.status ?? "")} ${String(result.message ?? "")}`);
      const repeated = log.filter((line) => line.startsWith(`${tool}: ${say}`)).length;
      if (repeated > 2) throw new Error(`Stuck on ${tool}: ${say}\n${log.join("\n")}`);
    }

    expect(published, log.join("\n")).toBe(true);
    expect(sawProfileOnSaveUnits, log.join("\n")).toBe(true);
    expect(log.some((line) => line.startsWith("returned ")), log.join("\n")).toBe(false);
    expect(used.every((name) => (LANDLORD_CORE_TOOLS as readonly string[]).includes(name))).toBe(true);
  }, 120_000);

  it("follows nextStep.tool on a fresh hosted condo through publish", async () => {
    const port = await hostedWalkPort();
    const used: string[] = [];
    const log: string[] = [];
    let propertyId: string | undefined;
    let publishCode: string | undefined;
    let published = false;
    let entranceTool = "";

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      expect(LANDLORD_CORE_TOOLS, name).toContain(name);
      used.push(name);
      const result = await post(port, { jsonrpc: "2.0", id: used.length, method: "tools/call", params: { name, arguments: args } });
      for (const nameHit of foreignTools(JSON.stringify(result))) log.push(`returned ${nameHit} from ${name}`);
      if (typeof result.propertyId === "string") propertyId = result.propertyId;
      const confirmation = result.confirmation as { code?: string } | undefined;
      if (name === "publish" && confirmation?.code) publishCode = confirmation.code;
      if (result.published === true) published = true;
      if (result.status === "blocked") throw new Error(`${name} blocked: ${String(result.message ?? result.reason)}\n${log.join("\n")}`);
      return result;
    };

    const answer = (tool: string, say: string): { name: string; args: Record<string, unknown> } => {
      const property = propertyId ? { property: propertyId } : {};
      if (say === BUILDING_ENTRANCE_QUESTION) {
        entranceTool = tool;
        if (tool !== "save_doors_and_routes") throw new Error(`entrance question named ${tool}`);
        return { name: tool, args: { ...property, doors: [{ name: "Lobby Door", kind: "entrance" }] } };
      }
      if (tool === "set_up_texting") return { name: tool, args: { provider: "local" } };
      if (tool === "backup_records") return { name: tool, args: { action: "decline" } };
      if (tool === "save_hours") return { name: tool, args: { ...property, days: "weekdays", start: "9am", end: "5pm" } };
      if (tool === "save_settings") return { name: tool, args: { ...property, verification: "basic-form", skipAlerts: true } };
      if (tool === "run_checks") return { name: tool, args: property };
      if (tool === "publish") return { name: tool, args: { ...property, ...(publishCode ? { confirmationCode: publishCode } : {}) } };
      if (tool === "save_units") {
        if (/unit number|units called/i.test(say)) return { name: tool, args: { ...property, units: [{ name: "4B" }] } };
        if (/bedroom|bathroom|rent|available/i.test(say)) {
          return { name: tool, args: { ...property, details: "4B is 2 bed 1 bath for $2,200, available now." } };
        }
      }
      if (tool === "save_property") {
        if (/street address|property address/i.test(say)) {
          return propertyId ? { name: tool, args: { ...property, street: "42 Cedar Lane" } } : { name: tool, args: { address: "42 Cedar Lane" } };
        }
        if (/what state/i.test(say)) return { name: tool, args: { ...property, state: "NJ" } };
        if (/what city/i.test(say)) return { name: tool, args: { ...property, city: "Hackensack" } };
        if (/zip/i.test(say)) return { name: tool, args: { ...property, postalCode: "07601" } };
        if (/did i get that right/i.test(say)) return { name: tool, args: { ...property, confirmAddress: true } };
        if (/single-family|apartment or condo/i.test(say)) return { name: tool, args: { ...property, propertyType: "APARTMENT_OR_CONDO" } };
        if (say === BUILDING_ACCESS_QUESTION) return { name: tool, args: { ...property, buildingAccess: "BUILDING_AND_UNIT" } };
        if (say === ENTRY_INSTRUCTIONS_QUESTION) return { name: tool, args: { ...property, skipEntryInstructions: true } };
        if (/stuck visitors|touring hours/i.test(say)) return { name: tool, args: { ...property, skipVisitorHelp: true } };
        if (/time zone|switch to/i.test(say)) return { name: tool, args: { ...property, timezone: "no" } };
      }
      if (tool === "save_facts") {
        const topic = FACT_TOPICS.find((t) => FACT_QUESTIONS[t] === say);
        if (topic) return { name: tool, args: { ...property, topic, skip: true } };
      }
      throw new Error(`No landlord answer for ${tool}: ${say}`);
    };

    for (let step = 0; step < 40 && !published; step++) {
      const state = await call("get_state");
      const next = state.nextStep as { tool?: string; say?: string };
      const tool = String(next.tool ?? "");
      const say = String(next.say ?? "");
      log.push(`${tool}: ${say}`);
      expect(LANDLORD.has(tool), `${tool} from get_state`).toBe(true);
      if (tool === "get_inbox" || tool === "get_state") break;
      const turn = answer(tool, say);
      log.push(`call ${turn.name} ${JSON.stringify(turn.args)}`);
      const result = await call(turn.name, turn.args);
      log.push(`-> ${String(result.status ?? "")} ${String(result.message ?? "")}`);
      const repeated = log.filter((line) => line.startsWith(`${tool}: ${say}`)).length;
      if (repeated > 2) throw new Error(`Stuck on ${tool}: ${say}\n${log.join("\n")}`);
    }

    expect(published, log.join("\n")).toBe(true);
    expect(entranceTool, log.join("\n")).toBe("save_doors_and_routes");
    expect(log.some((line) => line.startsWith(`save_property: ${BUILDING_ENTRANCE_QUESTION}`)), log.join("\n")).toBe(false);
    expect(log.some((line) => line.startsWith("returned ")), log.join("\n")).toBe(false);
  }, 120_000);
});

describe("landlord tool return strings", () => {
  it("would have failed on the old secure-setup sentence", () => {
    const oldLine = "When they're saved, call get_next_installation_step.";
    expect(foreignTools(oldLine)).toContain("get_next_installation_step");
  });

  it("keeps returned text from each landlord tool on the landlord list", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-landlord-returns-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const env: NodeJS.ProcessEnv = {
      TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0",
      RAILWAY_PUBLIC_DOMAIN: "demo.up.railway.app",
      PUBLIC_BASE_URL: HOST,
    };
    const runtime = new FileRuntimeStore(join(root, "runtime"));
    let inst!: Installation;
    const fetchImpl = async (url: string) => {
      if (url.includes("/healthz")) return { status: 200, json: async () => publicHealth(inst) };
      return { status: 200, json: async () => ({}) };
    };
    inst = new Installation({ root, runtime, env: () => env, fetch: fetchImpl as never, now: () => Date.parse("2026-10-09T15:00:00.000Z") });
    inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
    inst.files.setPublicBaseUrl(HOST, "RAILWAY");
    const localRoot = mkdtempSync(join(tmpdir(), "tourcore-landlord-returns-local-"));
    cleanups.push(() => rmSync(localRoot, { recursive: true, force: true }));
    const localEnv: NodeJS.ProcessEnv = { TOURCORE_DEPLOYMENT_MODE: "LOCAL_DEVELOPER" };
    const local = new Installation({
      root: localRoot,
      runtime: new FileRuntimeStore(join(localRoot, "runtime")),
      env: () => localEnv,
      now: () => Date.parse("2026-10-09T15:00:00.000Z"),
    });
    local.files.ensure({ deploymentMode: "LOCAL_DEVELOPER" });
    const visitors = new VisitorDemoRegistry();
    const ctx: ToolContext = {
      services: { workspace: new PropertyWorkspace(root), visitors, now: () => new Date(inst.now()) },
      confirmations: new ConfirmationBook(10 * 60_000, () => inst.now()),
      now: () => new Date(inst.now()),
      localUrl: () => "http://127.0.0.1:4321",
      installation: inst,
      resetMessaging: () => {},
    };
    const hits: string[] = [];
    const scan = (label: string, value: unknown) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      for (const name of foreignTools(text)) hits.push(`${label}: ${name}`);
    };
    scan("secureSetupLink hosted", secureSetupLink(inst, undefined, "visitor-messaging"));
    scan("secureSetupLink local", secureSetupLink(local, "http://127.0.0.1:4321", "operator-alerts"));
    const extras: Record<string, unknown[]> = {
      set_up_texting: [{ provider: "sendblue" }, { provider: "local" }, { provider: "twilio" }, { provider: "photon" }],
      save_settings: [{ connectAlerts: true }, { skipAlerts: true }],
      backup_records: [{ action: "decline" }, { action: "status" }, { action: "create" }],
      restore_records: [{ action: "upload" }, { action: "preview" }],
      save_property: [{ address: "42 Cedar Lane" }],
      get_inbox: [{}],
      export_records: [{ kind: "readable" }, { day: "today" }],
    };
    for (const name of [...LANDLORD_CORE_TOOLS, HOSTED_OWNER_TOOL]) {
      const calls = [{}, ...(extras[name] ?? [])];
      for (const args of calls) {
        const outcome = await callOperatorTool(ctx, name, args);
        scan(`${name} ${JSON.stringify(args)}`, outcome.ok ? outcome.result : outcome.error);
      }
    }
    expect(read("src/operator/dayToDay.ts")).toContain('replaceAll("answer_flagged_question", "resolve_issue")');
    const described = read("src/alerts/describeUpdate.ts");
    expect(described).toContain(
      "A decision is required. Use reply_to_time_request with approve, propose, or decline. For a move the landlord is directing, use schedule_tour.",
    );
    expect(described).not.toMatch(/approve_tour_time_request|propose_tour_time|decline_tour_time_request|reschedule_tour|answer_flagged_question/);
    expect(hits).toEqual([]);
  }, 60_000);

  it("scans a real tour.time_requested event and a flagged question from get_inbox", async () => {
    const { liveApp } = await import("./liveApp");
    const app = await liveApp({ cleanups });
    await app.book();
    await app.text("Is there a pool?");
    await app.text("Can I change it to 3:15?");
    const time = app.outbox("tour.time_requested").at(-1);
    const flagged = app.outbox("exception.created").at(-1);
    expect(time?.event.eventId).toBeTruthy();
    expect(flagged?.event.eventId).toBeTruthy();
    const timeInbox = await app.grok("get_inbox", { eventId: time!.event.eventId });
    const flagInbox = await app.grok("get_inbox", { eventId: flagged!.event.eventId });
    expect(String(timeInbox.instructions)).toMatch(
      /^A decision is required\. Use reply_to_time_request with approve, propose, or decline\. For a move the landlord is directing, use schedule_tour\./,
    );
    expect(JSON.stringify(flagInbox)).toContain("resolve_issue");
    const hits = [...foreignTools(JSON.stringify(timeInbox)), ...foreignTools(JSON.stringify(flagInbox))];
    const port = (app.server.address() as { port: number }).port;
    const token = "test-operator-token-abcdef";
    const profiles = [
      { name: "Grok", capabilities: { elicitation: { form: {} }, sampling: {}, roots: { listChanged: true } } },
      { name: "ChatGPT", capabilities: { elicitation: { form: {} } } },
      { name: "claude-ai", capabilities: { elicitation: { form: {} }, sampling: {}, roots: { listChanged: true } } },
      { name: "example-client", capabilities: { tools: {} } },
      { name: "grok", capabilities: { tools: {} } },
    ];
    let rpc = 0;
    for (const client of profiles) {
      const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++rpc,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: client.capabilities, clientInfo: { name: client.name, version: "1" } },
        }),
      });
      const session = init.headers.get("mcp-session-id") ?? "";
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Mcp-Session-Id": session },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name: "get_state", arguments: {} } }),
      });
      const body = (await res.json()) as { result?: { structuredContent?: { playbook?: { id?: string; text?: string } } } };
      const playbook = body.result?.structuredContent?.playbook;
      for (const name of foreignTools(JSON.stringify(body.result?.structuredContent ?? {}))) hits.push(`seeded get_state ${client.name}: ${name}`);
      if (client.name === "grok") {
        expect(playbook?.id).toBe("baseline");
        expect(playbook?.text ?? "").not.toContain("masked");
      }
    }
    expect(hits).toEqual([]);
  }, 120_000);
});
