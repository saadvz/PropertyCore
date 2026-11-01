import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RelaySink } from "../src/alerts/operatorEvents";
import { Installation } from "../src/install/installation";
import { TEXTING_WORKING } from "../src/install/stateView";
import { OPERATOR_MESSAGES, operateMessage } from "../src/install/status";
import { SHARED_STEPS } from "../src/playbooks/shared";
import { readSendblueEnv } from "../src/messaging/sendblue/runtime";
import { PropertyWorkspace } from "../src/setup/workspace";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { WORKER_INTERNAL_HEADER } from "../src/hosted/ipc";
import { createSetupServer, WORKER_KEY_HEADER } from "../src/web/server";

/**
 * One touring tenant's Tour Core, as the shared service runs it: loopback only, every request
 * carrying the key the service gave it. Only 555 numbers.
 */

const KEY = "k-test-worker-key-0123456789abcdef";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

async function worker(extra: NodeJS.ProcessEnv = {}, alerts?: { connected: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "tourcore-worker-"));
  const env: NodeJS.ProcessEnv = {
    TOURCORE_DEPLOYMENT_MODE: "TENANT_WORKER",
    TOURCORE_WORKER_KEY: KEY,
    TOURCORE_HOME: root,
    PUBLIC_BASE_URL: "https://shared.up.railway.app/t/tnt_aaaaaaaaaa",
    TOURCORE_TWILIO_ACCOUNT_SID: "ACworkertest",
    TOURCORE_TWILIO_AUTH_TOKEN: "worker-twilio-auth",
    TOURCORE_TWILIO_PHONE_NUMBER: "+15555550150",
    ...extra,
  };
  let inst!: Installation;
  const relay = alerts ? new RelaySink(() => undefined, () => alerts.connected) : undefined;
  inst = new Installation({
    root,
    runtime: new FileRuntimeStore(join(root, "runtime")),
    env: () => env,
    sendblueEnv: () => readSendblueEnv(inst.env()),
    ...(relay ? { notificationSink: () => relay } : {}),
  });
  const server = createSetupServer({ workspace: new PropertyWorkspace(root), installation: inst, log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  let rpc = 0;
  const http = (path: string, init: { method?: string; key?: string | null; body?: string; headers?: Record<string, string> } = {}) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const headers: Record<string, string> = { ...(init.headers ?? {}) };
      if (init.key !== null) headers[WORKER_KEY_HEADER] = init.key ?? KEY;
      const req = request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on("error", reject);
      if (init.body) req.write(init.body);
      req.end();
    });
  const mcp = (method: string, params: Record<string, unknown> = {}, key: string | null = KEY) =>
    http("/mcp", {
      method: "POST",
      key,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method, params }),
    });
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await mcp("tools/call", { name, arguments: args });
    return JSON.parse(res.text) as { result?: { content?: { text?: string }[]; structuredContent?: unknown }; error?: { message?: string } };
  };
  /** get_state's structured reply. */
  const state = async () => {
    const reply = await tool("get_state");
    const text = reply.result?.content?.[0]?.text ?? "{}";
    return JSON.parse(text) as { nextStep: { component?: string; tool?: string; say?: string }; texting: { summary: string }; summary: string };
  };
  return { http, mcp, tool, state };
}

describe("TENANT_WORKER mode", () => {
  it("answers nothing without the worker key", async () => {
    const w = await worker();
    expect((await w.http("/healthz", { key: null })).status).toBe(404);
    expect((await w.mcp("tools/list", {}, null)).status).toBe(404);
    expect((await w.http("/healthz", { key: "wrong-key" })).status).toBe(404);
  });

  it("keeps its internal routes from the key alone: they need the front's internal header too", async () => {
    const w = await worker();
    expect((await w.http("/internal/live")).status).toBe(404);
    expect((await w.http("/internal/live", { headers: { [WORKER_INTERNAL_HEADER]: KEY } })).status).toBe(200);
    expect((await w.http("/internal/stand-down", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
  });

  it("answers the health check to the key, with only what the public health check shows", async () => {
    const w = await worker();
    const health = await w.http("/healthz");
    expect(health.status).toBe(200);
    const body = JSON.parse(health.text) as Record<string, unknown>;
    expect(body.service).toBe("tour-core");
    for (const runtimeOnly of ["pid", "uptimeSeconds", "deploymentMode", "alertDelivery", "alertsWaiting"]) expect(body).not.toHaveProperty(runtimeOnly);
  });

  it("serves the landlord tools to the key, without the hosted-demo tools", async () => {
    const w = await worker();
    const listed = JSON.parse((await w.mcp("tools/list")).text) as { result: { tools: { name: string }[] } };
    const names = listed.result.tools.map((t) => t.name);
    expect(names).toContain("get_state");
    expect(names).toContain("pause_tours");
    expect(names).not.toContain("reset_hosted_demo");
  });

  it.each(["/", "/grok", "/install", "/connect", "/mcp/ops", "/mcp/qa", "/authorize", "/.well-known/oauth-authorization-server", "/api/install/session"])("hides %s even with the key", async (path) => {
    const w = await worker();
    expect((await w.http(path)).status).toBe(404);
  });

  it("skips the setup the shared service already did, and never asks for a texting provider", async () => {
    const w = await worker();
    const state = await w.state();
    expect(["PUBLIC_ENDPOINT", "VISITOR_MESSAGING", "GROK_OPERATOR", "RUNTIME"]).not.toContain(state.nextStep.component);
    expect(state.texting.summary).toBe(TEXTING_WORKING);
    expect(JSON.stringify(state)).not.toMatch(/Sendblue|Photon|Grok Routine|texting provider|tunnel|Railway|choose_messaging_provider/i);
  });

  it("keeps records on the service's volume, with portable backups offered", async () => {
    const w = await worker();
    const state = await w.state();
    expect(state.nextStep.component).toBe("STORAGE");
    expect(state.summary).toBe("Backups is next.");
  });

  it("counts a Scratch tenant's local test texts as its texting", async () => {
    const w = await worker({ TOURCORE_MESSAGING_PROVIDER: "local", TOURCORE_LOCAL_FROM_NUMBER: "+15555550150", TOURCORE_TWILIO_ACCOUNT_SID: "", TOURCORE_TWILIO_AUTH_TOKEN: "", TOURCORE_TWILIO_PHONE_NUMBER: "" });
    const state = await w.state();
    expect(["PUBLIC_ENDPOINT", "VISITOR_MESSAGING", "GROK_OPERATOR", "RUNTIME"]).not.toContain(state.nextStep.component);
  });

  it("starts a new property on live texting through the host's number, not practice only", async () => {
    const w = await worker({ TOURCORE_MESSAGING_PROVIDER: "twilio" });
    await w.tool("backup_records", { action: "decline" });
    const saved = JSON.stringify(await w.tool("save_property", { address: "1 Scratch Lane, Springfield, IL 62701" }));
    expect(saved).not.toMatch(/practice only/i);
    const state = (await w.state()) as unknown as { setup?: { texting?: string } };
    expect(state.setup?.texting).toBe("Connected");
    // The host can always ask for the number visitors text.
    expect((state as unknown as { texting: { number?: string } }).texting.number).toBe("+15555550150");
  });

  it("says the host's number isn't ready when the service gave it none", async () => {
    const w = await worker({ TOURCORE_TWILIO_PHONE_NUMBER: "" });
    const state = await w.state();
    expect(state.nextStep.component).toBe("VISITOR_MESSAGING");
    expect(state.nextStep.say).toBe(SHARED_STEPS.starting.ask);
    expect(JSON.stringify(state)).not.toMatch(/texting login|Sendblue|Photon/i);
  });

  it("refuses publish until the touring alert routine is connected", async () => {
    const off = await worker({}, { connected: false });
    const refused = JSON.stringify(await off.tool("publish", { property: "Hillside" }));
    expect(refused).toContain("Connect the touring alert routine first.");
    const on = await worker({}, { connected: true });
    expect(JSON.stringify(await on.tool("publish", { property: "Hillside" }))).not.toContain("Connect the touring alert routine first.");
  });
});

describe("the number visitors text", () => {
  it("is said once a published property takes real texts, and only then", () => {
    expect(operateMessage("connected", true, "+15555550150")).toBe(OPERATOR_MESSAGES.operate.replace("Visitor texting is live.", "Visitor texting is live. Visitors text +15555550150 to book a tour."));
    expect(operateMessage("connected", true)).toBe(OPERATOR_MESSAGES.operate);
    expect(operateMessage("practice", true, "+15555550150")).not.toContain("+15555550150");
  });
});
