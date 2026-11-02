import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { loadConfig, type TourCoreConfig } from "../src/config/tourCoreConfig";
import { UNKNOWN_ANSWER } from "../src/core/TourCore";
import { zonedTimeToUtc } from "../src/core/timezone";
import { Installation } from "../src/install/installation";
import { LocalSecretStore } from "../src/install/secretStore";
import { setSendblueRuntime } from "../src/messaging/sendblue/runtime";
import { PropertyWorkspace, runReadinessCheck } from "../src/setup";
import { FileRuntimeStore } from "../src/storage/runtimeStore";
import { VisitorDemoRegistry } from "../src/visitor";
import { createSetupServer, type TourCoreServer } from "../src/web/server";
import { fakeSendblue, inbound, SECRET, sendblueEnv } from "./fakeSendblue";
import { fakeNetwork, ROUTINE_KEY, ROUTINE_URL } from "./installHarness";

/** Monday 28 Sep 2026 at the property (America/New_York). */
export const at = (hour: number, minute = 0) => zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour, minute }, "America/New_York").getTime();
export const PHONE = "+15550102000";
export const FALLBACK = UNKNOWN_ANSWER;
const TOKEN = "test-operator-token-abcdef";

/**
 * The demo property as a leasing agent would set it up: units 1A and 2B with
 * structured details, a building-wide parking fact and an in-unit laundry fact.
 */
export function hillsideConfig(): TourCoreConfig {
  const c = loadConfig();
  const rename = (name: string) => name.replace("Unit 101", "Unit 1A").replace("Unit 102", "Unit 2B");
  return {
    ...c,
    messagingMode: "live",
    property: { ...c.property, facts: ["Street parking only."] },
    doors: c.doors.map((d) => ({ ...d, name: rename(d.name) })),
    units: c.units.map((u) => ({ ...u, name: rename(u.name), facts: u.id === "apt_101" ? ["In-unit laundry."] : [] })),
  };
}

/**
 * A running Tour Core: a visitor texts through Sendblue (faked at the SDK),
 * Grok calls the tools over HTTP, and operator updates go to a Grok Routine
 * (faked at the network). Pass `root` (and the same clock, network and
 * Sendblue fake) to start a second process on the same records.
 */
export async function liveApp(
  options: { root?: string; clock?: { t: number }; net?: ReturnType<typeof fakeNetwork>; fake?: ReturnType<typeof fakeSendblue>; config?: TourCoreConfig; routine?: boolean; interpreter?: import("../src/intent").IntentInterpreter; cleanups: Array<() => void>; slotLockBarrier?: import("../src/core/TourCore").TourCoreDeps["slotLockBarrier"] },
) {
  const fresh = !options.root;
  const root = options.root ?? mkdtempSync(join(tmpdir(), "tourcore-live-"));
  const clock = options.clock ?? { t: at(7) };
  const net = options.net ?? fakeNetwork();
  const fake = options.fake ?? fakeSendblue();
  options.cleanups.push(setSendblueRuntime({ env: () => sendblueEnv(), client: () => fake.client }));
  const ws = new PropertyWorkspace(root);
  if (fresh) {
    const { config } = ws.save(options.config ?? hillsideConfig());
    ws.recordReadiness(config.property.id, await runReadinessCheck(config, { now: new Date(clock.t) }));
    publishForVisitors(ws, config.property.id, new Date(clock.t));
  }
  const runtime = new FileRuntimeStore(join(root, "runtime"));
  const installation = new Installation({ root, runtime, secrets: new LocalSecretStore(join(root, "install", "secrets.json"), () => clock.t), now: () => clock.t, fetch: net.fetch as never, outbox: { baseDelayMs: 1000 } });
  if (fresh && options.routine !== false) installation.secrets.set({ TOURCORE_GROK_ROUTINE_URL: ROUTINE_URL, TOURCORE_GROK_ROUTINE_KEY: ROUTINE_KEY });
  const visitors = new VisitorDemoRegistry();
  const server: TourCoreServer = createSetupServer({
    toolSurface: "all", workspace: ws, installation, visitors, now: () => new Date(clock.t), realNow: () => clock.t, operatorToken: () => TOKEN, log: () => {}, alertRetryMs: 3_600_000, ...(options.slotLockBarrier ? { slotLockBarrier: options.slotLockBarrier } : {}), ...(options.interpreter ? { interpreter: options.interpreter } : {}) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    server.close();
  };
  options.cleanups.push(close);
  if (fresh) options.cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  await server.tourCore.settled();

  let n = 0;
  /** One text from the visitor; returns every reply Tour Core sent back, in order. `handle` repeats a delivery. */
  const textFrom = async (phone: string, content: string, handle?: string, extra?: Record<string, unknown>) => {
    const before = fake.sent.length;
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/sendblue`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "sb-signing-secret": SECRET },
      body: JSON.stringify({ ...inbound(phone, content, handle ?? `in_${phone.slice(-4)}_${root.slice(-6)}_${++n}_${clock.t}`), ...extra }),
    });
    expect(res.status).toBe(200);
    await server.tourCore.settled();
    return fake.sent.slice(before).filter((s) => s.number === phone).map((s) => s.content);
  };
  const text = async (content: string, handle?: string, extra?: Record<string, unknown>) => textFrom(PHONE, content, handle, extra);
  let rpc = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const grok = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as { result: { isError: boolean; structuredContent: unknown; content: Array<{ text: string }> } };
    if (body.result.isError) throw new Error(body.result.content[0]!.text);
    return body.result.structuredContent;
  };
  const approve = async (name: string, args: Record<string, unknown>) => {
    const asked = await grok(name, args);
    expect(asked.status).toBe("needs-confirmation");
    const done = await grok(name, { ...args, confirmationCode: asked.confirmation.code });
    await server.tourCore.settled();
    return done;
  };
  /** The visitor fills out the identity form from the link Tour Core texted. */
  const fillForm = async (replies: string[]) => {
    const token = /\/verify\/([A-Za-z0-9_-]+)/.exec(replies.join("\n"))![1]!;
    const form = await fetch(`http://127.0.0.1:${port}/api/verify/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName: "Testy", lastName: "McTest", email: "testy@example.com", phone: PHONE }),
    });
    expect(((await form.json()) as { ok: boolean }).ok).toBe(true);
    await server.tourCore.settled();
    return fake.sent.filter((s) => s.number === PHONE).at(-1)!.content;
  };
  /** Keyword campaign opt-in. The YES replies include the enrollment confirmation and the normal welcome. */
  const optInSms = async () => {
    await text("TOUR");
    return text("YES");
  };
  /** TOUR → YES → Unit 1A → 2:00 PM → tour-record yes → identity form: a valid booking. */
  const book = async () => {
    await optInSms();
    await text("1");
    await text("1");
    await text("1");
    return fillForm(await text("YES"));
  };
  const routineEvents = () => net.routineCalls().map((c) => JSON.parse(c.body!) as { eventType: string; eventId: string } & Record<string, string>);
  const outbox = (type?: string) => installation.outbox.records().filter((r) => !type || r.event.eventType === type);
  return { root, clock, net, fake, installation, server, visitors, text, textFrom, optInSms, grok, approve, fillForm, book, routineEvents, outbox, close, ws };
}
export type LiveApp = Awaited<ReturnType<typeof liveApp>>;

/** A readiness-passed property can take new visitor texts only after it is published. No practice-tour folder. */
export function publishForVisitors(ws: PropertyWorkspace, propertyId: string, at: Date): void {
  ws.patchState(propertyId, { status: "PUBLISHED_FOR_DEMO", publishedAt: at.toISOString() });
}
