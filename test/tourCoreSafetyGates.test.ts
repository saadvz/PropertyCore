import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tenantFolder } from "../src/cleaner-core/hosted/registry";
import { publicHealth } from "../src/install/checks";
import { Installation } from "../src/install/installation";
import { readSendblueEnv } from "../src/messaging/sendblue/runtime";
import { PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { createSetupServer, WORKER_KEY_HEADER } from "../src/web/server";
import { closeHostedApps } from "./cleanerOauthHarness";
import { hillsideConfig, publishForVisitors } from "./liveApp";
import { multiTenantApp, type MultiTenantApp } from "./multiTenantHarness";

/**
 * docs/tour-core-safety-gates.md: Tour Core's gates, held by a touring tenant on the shared service.
 * Only 555 numbers; every touring text stays in the Scratch outbox.
 */

const LANE = "+15555550150";
const VISITOR = "+15555550177";
const KEY = "k-gates-worker-key-0123456789abcdef";
const SLOW = { timeout: 120_000 };
const cleanups: (() => void)[] = [];

let open: MultiTenantApp | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
  closeHostedApps();
  for (const clean of cleanups.splice(0)) clean();
});

/** A touring tenant whose published property answers visitors. */
async function publishedTouring() {
  const m = (open = await multiTenantApp({ env: { TOUR_CORE_TENANTS: "1", CLEANER_CORE_SCRATCH_TOOLS: "1" } }));
  const { tenant } = m.registry.create({ label: "Lane", twilioNumber: LANE });
  m.registry.setService(tenant.id, "touring");
  const ws = new PropertyWorkspace(join(tenantFolder(m.app.root, tenant.id), "tour-core"));
  // A Scratch host's property texts through the local test outbox, so its checks pass without Twilio.
  const { config } = ws.save({ ...hillsideConfig(), messagingProvider: "local" });
  ws.recordReadiness(config.property.id, await runReadinessCheck(config, { now: new Date(), installed: { provider: "local" } }));
  publishForVisitors(ws, config.property.id, new Date());
  await m.touring()!.start(m.registry.get(tenant.id)!);
  const token = await m.joinAt(tenant.id, "grok", "/mcp");
  const visitor = (text: string) => m.toolAt("/mcp", token, "send_test_text", { from: VISITOR, text });
  const outbox = async () => ((await m.toolAt("/mcp", token, "read_outbox")).structured?.texts ?? []) as { to: string; text: string }[];
  return { m, tenant, token, visitor, outbox };
}

describe("Tour Core's gates in a touring process", () => {
  it("passes the practice tour, whose safety checks deny early arrival, turn away an off-route door, and never grant twice", async () => {
    const root = mkdtempSync(join(tmpdir(), "tourcore-gates-"));
    const env: NodeJS.ProcessEnv = {
      TOURCORE_DEPLOYMENT_MODE: "TENANT_WORKER",
      TOURCORE_WORKER_KEY: KEY,
      PUBLIC_BASE_URL: "https://shared.up.railway.app/t/tnt_aaaaaaaaaa",
      TOURCORE_MESSAGING_PROVIDER: "local",
      TOURCORE_LOCAL_FROM_NUMBER: LANE,
    };
    let inst!: Installation;
    // The public address answers as this installation, the way the shared service forwards /t/<id>/healthz.
    const fetch = async () => ({ status: 200, json: async () => publicHealth(inst) });
    inst = new Installation({ root, runtime: new FileRuntimeStore(join(root, "runtime")), env: () => env, sendblueEnv: () => readSendblueEnv(inst.env()), fetch: fetch as never });
    const ws = new PropertyWorkspace(root);
    const { config } = ws.save(hillsideConfig());
    const server = createSetupServer({ workspace: ws, installation: inst, log: () => {} });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      server.close();
      rmSync(root, { recursive: true, force: true });
    });
    const port = (server.address() as AddressInfo).port;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_checks", arguments: { property: config.property.id } } });
    const reply = await new Promise<string>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${KEY}`, [WORKER_KEY_HEADER]: KEY } },
        (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve(text));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    expect(reply).toContain("The check passed, and the practice tour passed.");
  });

  it("puts a fair-housing question in front of the landlord with no draft, and gives the visitor the holding reply", SLOW, async () => {
    const { m, token, visitor, outbox } = await publishedTouring();
    for (const text of ["TOUR", "YES", "1", "1"]) await visitor(text);
    const before = (await outbox()).length;
    await visitor("Do you rent to families with kids?");
    const replies = (await outbox()).slice(before).map((line) => line.text);
    expect(replies.join("\n")).toContain("Good question for the property team");
    const inbox = await m.toolAt("/mcp", token, "get_inbox");
    const items = (inbox.structured?.items ?? []) as { summary?: string; kind?: string; proposeDraft?: boolean }[];
    expect(items.find((row) => /families/i.test(row.summary ?? ""))).toMatchObject({ kind: "flagged-question", proposeDraft: false });
  });

  it("lets STOP win over a booking text, across the service", SLOW, async () => {
    const { m, tenant, visitor, outbox } = await publishedTouring();
    await visitor("TOUR");
    await visitor("STOP");
    const after = (await outbox()).length;
    await visitor("TOUR");
    expect((await outbox()).length).toBe(after);
    expect(m.app.logs.join("\n")).toContain(`A text reached ${tenant.id} from a phone that opted out. Nothing was sent.`);
  });

  it("sends no second copy after a restart and a replayed queue", SLOW, async () => {
    const { m, tenant, outbox } = await publishedTouring();
    const touring = m.touring()!;
    touring.supervisor.stop(tenant.id);
    expect((await m.text(LANE, VISITOR, "TOUR", "SMgate1")).status).toBe(200);
    expect(touring.inbox.pending(tenant.id)).toHaveLength(1);
    await touring.start(m.registry.get(tenant.id)!);
    expect(touring.inbox.pending(tenant.id)).toEqual([]);
    const answered = (await outbox()).length;
    expect(answered).toBeGreaterThan(0);
    touring.supervisor.stop(tenant.id);
    await touring.start(m.registry.get(tenant.id)!);
    await m.text(LANE, VISITOR, "TOUR", "SMgate1");
    expect((await outbox()).length).toBe(answered);
  });
});
