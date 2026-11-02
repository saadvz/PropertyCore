import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffNormalized } from "./diffConfig";
import { DUPLEX_VARIANTS, publishDuplex } from "./duplex";
import { normalizeStoredConfig } from "./normalize";
import { EvalSession } from "./session";
import { Installation } from "../install/installation";
import { hashSecret, OAuthGrantStore } from "../mcp/oauth/store";
import { OPERATOR_SCOPE } from "../mcp/oauth/provider";
import { connectorRefusal, HOSTED_OWNER_TOOL, LANDLORD_CORE_TOOLS, OPS_TOOL_NAMES, QA_TOOL_NAMES } from "../mcp/scopes";
import { mcpInstructions } from "../playbooks/instructions";
import { BASELINE_VERSION } from "../playbooks/baseline";
import { CHATGPT_VERSION } from "../playbooks/chatgpt";
import { CLAUDE_VERSION } from "../playbooks/claude";
import { GROK_VERSION } from "../playbooks/grok";
import { BASELINE_CLIENT_CAPABILITIES, type PlaybookId, type PlaybookMode } from "../playbooks/select";
import { PropertyWorkspace } from "../setup/workspace";
import { FileRuntimeStore } from "../storage/runtimeStore";
import { createSetupServer } from "../web/server";

const LANDLORD = "landlord-token-matrix-1234567890";
const OPS = "ops-token-matrix-1234567890";
const QA = "qa-token-matrix-1234567890";
const HOST = "https://demo.up.railway.app";
const OWNER = "matrix-owner-client";
const OWNER_TOKEN = "tca_matrix_owner_access_token_ok";

const FULL_CAPABILITIES = { elicitation: { form: {} }, sampling: {}, roots: { listChanged: true } };

export interface MatrixClient {
  key: string;
  label: string;
  name: string;
  capabilities: Record<string, unknown>;
  /** Written here, not taken from selectPlaybook, so the gate can fail. */
  expected: { id: PlaybookId; mode: PlaybookMode; version: string };
  /** A grok name with baseline capabilities. It must not gain a tool, a gate, or a playbook. */
  spoof?: boolean;
}

/** The four clients, plus a grok name that only declares baseline capabilities. */
export const MATRIX_CLIENTS: MatrixClient[] = [
  { key: "grok", label: "Grok", name: "Grok", capabilities: FULL_CAPABILITIES, expected: { id: "grok", mode: "full", version: GROK_VERSION } },
  { key: "chatgpt", label: "ChatGPT", name: "ChatGPT", capabilities: { elicitation: { form: {} } }, expected: { id: "chatgpt", mode: "tools", version: CHATGPT_VERSION } },
  { key: "claude", label: "Claude", name: "claude-ai", capabilities: FULL_CAPABILITIES, expected: { id: "claude", mode: "full", version: CLAUDE_VERSION } },
  { key: "unknown", label: "unknown", name: "example-client", capabilities: BASELINE_CLIENT_CAPABILITIES, expected: { id: "baseline", mode: "tools", version: BASELINE_VERSION } },
  { key: "spoofed-grok", label: "spoofed grok", name: "grok", capabilities: BASELINE_CLIENT_CAPABILITIES, spoof: true, expected: { id: "baseline", mode: "tools", version: BASELINE_VERSION } },
];

export interface ListedTool {
  name: string;
  annotations?: unknown;
}

export interface MatrixRow {
  key: string;
  label: string;
  spoof: boolean;
  expected: { id: PlaybookId; mode: PlaybookMode; version: string };
  playbook: { id: string; mode: string; version: string; text: string };
  instructions: string;
  landlordTools: ListedTool[];
  hostedTools: ListedTool[];
  qaTools: ListedTool[];
  opsTools: ListedTool[];
  foreignRefusal: string;
  publishConfirmed: boolean;
  removeConfirmed: boolean;
  dryTourPassed: boolean;
  safetyProofs: string[];
  configDiffs: number;
  canonical: unknown;
  gates: Record<string, boolean>;
}

const SAFETY_LINES = ["Early arrival was denied", "turned away before any door was unlocked", "A repeated request didn't create a second access grant"];

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("matrix server did not bind a port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function post(port: number, path: string, body: unknown, token: string, session?: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = (text ? JSON.parse(text) : {}) as {
    error?: { message?: string };
    result?: {
      instructions?: string;
      tools?: ListedTool[];
      structuredContent?: { playbook?: { id?: string; mode?: string; version?: string; text?: string } };
    };
  };
  return { status: res.status, json, session: res.headers.get("mcp-session-id") ?? undefined };
}

function initializeBody(client: MatrixClient) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: client.capabilities,
      clientInfo: { name: client.name, version: "1.0.0" },
    },
  };
}

const listBody = { jsonrpc: "2.0", id: 2, method: "tools/list" };

async function listedTools(port: number, path: string, token: string, client: MatrixClient): Promise<{ tools: ListedTool[]; instructions?: string; session?: string }> {
  const init = await post(port, path, initializeBody(client), token);
  if (init.status !== 200 || !init.session) throw new Error(`${client.label} initialize ${path} failed (${init.status}) ${init.json.error?.message ?? ""}`);
  const listed = await post(port, path, listBody, token, init.session);
  if (listed.status !== 200) throw new Error(`${client.label} tools/list ${path} failed (${listed.status})`);
  return { tools: listed.json.result?.tools ?? [], instructions: init.json.result?.instructions, session: init.session };
}

function names(tools: ListedTool[]): string[] {
  return tools.map((tool) => tool.name);
}

function safetyProofsHold(passed: boolean, proofs: string[]): boolean {
  if (!passed) return false;
  if (proofs.some((line) => line.startsWith("\u2717"))) return false;
  const text = proofs.join("\n");
  return SAFETY_LINES.every((line) => text.includes(line));
}

async function openHosted(): Promise<{ port: number; close: () => Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), "tourcore-matrix-hosted-"));
  const env: NodeJS.ProcessEnv = { TOURCORE_DEPLOYMENT_MODE: "HOSTED_RAILWAY_P0", RAILWAY_PUBLIC_DOMAIN: "demo.up.railway.app" };
  const runtime = new FileRuntimeStore(join(root, "runtime"));
  const inst = new Installation({ root, runtime, env: () => env });
  inst.files.ensure({ deploymentMode: "HOSTED_RAILWAY_P0" });
  inst.files.setPublicBaseUrl(HOST, "RAILWAY");
  inst.files.writeState({ ...inst.files.state(), hostedTenant: { clientId: OWNER, boundAt: "2026-09-01T00:00:00.000Z" } });
  const now = Date.now();
  new OAuthGrantStore(runtime).addGrant({
    clientId: OWNER,
    clientName: "Grok",
    issuer: HOST,
    resource: `${HOST}/mcp`,
    scopes: [OPERATOR_SCOPE],
    createdAt: now,
    expiresAt: now + 86_400_000,
    accessHash: hashSecret(OWNER_TOKEN),
    accessExpiresAt: now + 3_600_000,
  });
  const server = createSetupServer({ workspace: new PropertyWorkspace(root), installation: inst, mcpAuth: "oauth", log: () => {} });
  const port = await listen(server);
  return {
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function connectorPicture(client: MatrixClient): Promise<Pick<MatrixRow, "playbook" | "instructions" | "landlordTools" | "qaTools" | "opsTools" | "foreignRefusal">> {
  const root = mkdtempSync(join(tmpdir(), "tourcore-matrix-scope-"));
  const server = createSetupServer({
    workspace: new PropertyWorkspace(root),
    mcpAuth: "static",
    operatorToken: () => LANDLORD,
    opsToken: () => OPS,
    qaToken: () => QA,
    log: () => {},
  });
  try {
    const port = await listen(server);
    const landlord = await listedTools(port, "/mcp", LANDLORD, client);
    const state = await post(port, "/mcp", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_state", arguments: {} } }, LANDLORD, landlord.session);
    const playbook = state.json.result?.structuredContent?.playbook;
    if (!playbook?.id || !playbook.mode || !playbook.version || typeof playbook.text !== "string") {
      throw new Error(`${client.label} get_state did not return a playbook`);
    }
    const refused = await post(
      port,
      "/mcp",
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "inject_local_sms", arguments: { from: "+15555550100", text: "Hi" } } },
      LANDLORD,
      landlord.session,
    );
    const qa = await listedTools(port, "/mcp/qa", QA, client);
    const ops = await listedTools(port, "/mcp/ops", OPS, client);
    return {
      instructions: landlord.instructions ?? "",
      playbook: { id: playbook.id, mode: playbook.mode, version: playbook.version, text: playbook.text },
      landlordTools: landlord.tools,
      qaTools: qa.tools,
      opsTools: ops.tools,
      foreignRefusal: refused.json.error?.message ?? "",
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

async function duplexPicture(client: MatrixClient): Promise<Pick<MatrixRow, "publishConfirmed" | "removeConfirmed" | "dryTourPassed" | "safetyProofs" | "configDiffs" | "canonical">> {
  const normalized: unknown[] = [];
  const ids: string[] = [];
  let publishConfirmed = true;
  let removeConfirmed = false;
  let dryTourPassed = false;
  let safetyProofs: string[] = [];
  for (const variant of DUPLEX_VARIANTS) {
    const session = await EvalSession.open();
    try {
      await session.initialize({ name: client.name, capabilities: client.capabilities });
      const setup = await publishDuplex(session, variant);
      const publishAsks = session.confirmationAsks;
      if (publishAsks.length !== 1 || publishAsks[0]?.status !== "needs-confirmation") publishConfirmed = false;
      const saved = session.workspace.load(setup.propertyId);
      normalized.push(normalizeStoredConfig(saved.config));
      ids.push(variant.id);
      if (variant.id === "canonical") {
        const dry = await session.call("run_dry_tour", { property: setup.propertyId });
        dryTourPassed = dry.passed === true;
        safetyProofs = Array.isArray(dry.proofPoints) ? dry.proofPoints.map(String) : [];
        const asked = await session.call("remove_property", { property: setup.propertyId });
        removeConfirmed = asked.status === "needs-confirmation" && session.workspace.load(setup.propertyId).state.status === "PUBLISHED_FOR_DEMO";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${client.label} duplex ${variant.id}: ${message}`);
    } finally {
      await session.close();
    }
  }
  return {
    publishConfirmed,
    removeConfirmed,
    dryTourPassed,
    safetyProofs,
    configDiffs: diffNormalized(ids, normalized).differingFieldCount,
    canonical: normalized[0],
  };
}

/** The playbook gate: id, mode, and the hard-coded version on that MATRIX_CLIENTS row. */
export function playbookVersionMatches(
  playbook: { id: string; mode: string; version: string },
  expected: { id: string; mode: string; version: string },
): boolean {
  return playbook.id === expected.id && playbook.mode === expected.mode && playbook.version === expected.version;
}

function gatesFor(row: Omit<MatrixRow, "gates">): Record<string, boolean> {
  const landlordNames = names(row.landlordTools);
  const hostedNames = names(row.hostedTools);
  const samePlaybook = playbookVersionMatches(row.playbook, row.expected);
  return {
    "landlord tools": landlordNames.length === 22 && landlordNames.join() === [...LANDLORD_CORE_TOOLS].join() && !landlordNames.includes("reset_hosted_demo") && !landlordNames.includes("inject_local_sms"),
    "hosted owner tools": hostedNames.length === 23 && hostedNames.join() === [...LANDLORD_CORE_TOOLS, HOSTED_OWNER_TOOL].join(),
    "qa tools": names(row.qaTools).length === 15 && names(row.qaTools).join() === [...QA_TOOL_NAMES].join(),
    "ops tools": names(row.opsTools).length === 13 && names(row.opsTools).join() === [...OPS_TOOL_NAMES].join(),
    "foreign tool refused": row.foreignRefusal === connectorRefusal("landlord"),
    "publish confirmation": row.publishConfirmed,
    "remove confirmation": row.removeConfirmed,
    "dry-tour safety": safetyProofsHold(row.dryTourPassed, row.safetyProofs),
    instructions: row.instructions === mcpInstructions() && row.instructions.includes("A client name never changes a rule."),
    playbook: samePlaybook,
    "config diff": row.configDiffs === 0,
  };
}

/** Safety gates and the ten-duplex config diff, once per client, over the MCP connectors. */
export async function runClientMatrix(clients: MatrixClient[] = MATRIX_CLIENTS): Promise<MatrixRow[]> {
  const hosted = await openHosted();
  try {
    const rows: MatrixRow[] = [];
    for (const client of clients) {
      const connector = await connectorPicture(client);
      const hostedTools = (await listedTools(hosted.port, "/mcp", OWNER_TOKEN, client)).tools;
      const duplex = await duplexPicture(client);
      const partial = { ...connector, hostedTools, ...duplex, key: client.key, label: client.label, spoof: !!client.spoof, expected: client.expected };
      rows.push({ ...partial, gates: gatesFor(partial) });
    }
    return rows;
  } finally {
    await hosted.close();
  }
}

export function toolSignature(tools: ListedTool[]): string {
  return JSON.stringify(tools.map((tool) => ({ name: tool.name, annotations: tool.annotations ?? null })));
}

/** What the spoof gained over the unknown client. Empty when it gained nothing. */
export function spoofExtras(rows: MatrixRow[]): string[] {
  const spoof = rows.find((row) => row.spoof);
  const unknown = rows.find((row) => row.key === "unknown");
  if (!spoof || !unknown) return ["missing spoof or unknown row"];
  const extras: string[] = [];
  if (spoof.playbook.text !== unknown.playbook.text || spoof.playbook.id !== unknown.playbook.id || spoof.playbook.mode !== unknown.playbook.mode) extras.push("playbook");
  if (toolSignature(spoof.landlordTools) !== toolSignature(unknown.landlordTools)) extras.push("landlord tools");
  if (toolSignature(spoof.hostedTools) !== toolSignature(unknown.hostedTools)) extras.push("hosted tools");
  if (toolSignature(spoof.qaTools) !== toolSignature(unknown.qaTools)) extras.push("qa tools");
  if (toolSignature(spoof.opsTools) !== toolSignature(unknown.opsTools)) extras.push("ops tools");
  if (spoof.foreignRefusal !== unknown.foreignRefusal) extras.push("foreign-tool refusal");
  if (spoof.publishConfirmed !== unknown.publishConfirmed || spoof.removeConfirmed !== unknown.removeConfirmed) extras.push("confirmation");
  if (spoof.dryTourPassed !== unknown.dryTourPassed || spoof.safetyProofs.join("\n") !== unknown.safetyProofs.join("\n")) extras.push("dry-tour safety");
  if (spoof.instructions !== unknown.instructions) extras.push("instructions");
  if (diffNormalized(["unknown", "spoof"], [unknown.canonical, spoof.canonical]).differingFieldCount !== 0) extras.push("config");
  for (const [gate, ok] of Object.entries(spoof.gates)) {
    if (ok !== unknown.gates[gate]) extras.push(`gate ${gate}`);
  }
  return extras;
}

export function matrixTable(rows: MatrixRow[], extras: string[]): string {
  const header = "| Client | Playbook | Landlord | Hosted | QA | Ops | Safety gates | Config diffs | Extra vs baseline |";
  const rule = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const lines = rows.map((row) => {
    const passed = Object.values(row.gates).filter(Boolean).length;
    const total = Object.keys(row.gates).length;
    const extra = row.spoof ? (extras.length ? extras.join(", ") : "none") : "—";
    return `| ${row.label} | ${row.playbook.id}/${row.playbook.mode} | ${names(row.landlordTools).length} | ${names(row.hostedTools).length} | ${names(row.qaTools).length} | ${names(row.opsTools).length} | ${passed}/${total} | ${row.configDiffs} | ${extra} |`;
  });
  return [header, rule, ...lines].join("\n");
}

export function failingGates(rows: MatrixRow[]): string[] {
  return rows.flatMap((row) => Object.entries(row.gates).filter(([, ok]) => !ok).map(([gate]) => `${row.label}: ${gate}`));
}
